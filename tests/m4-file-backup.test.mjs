import assert from 'node:assert/strict'
import { appendFile, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { FileBackupError, FileBackupRepository } from '../lib/core/backup.js'
import { canonicalJson, sha256 } from '../lib/core/canonical.js'
import { RepositoryInitializer } from '../lib/core/initializer.js'
import { FileBackupScheduler } from '../lib/relay/backups.js'

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'local-git-4-llm-backup-'))
  const workspaceId = `workspace-backup-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await mkdir(join(workspace, 'src', 'nested'), { recursive: true })
  await mkdir(join(workspace, 'node_modules', 'ignored'), { recursive: true })
  await writeFile(join(workspace, 'README.md'), '# backup fixture\n', 'utf8')
  await writeFile(join(workspace, 'src', 'index.ts'), 'export const value = 1\n', 'utf8')
  await writeFile(join(workspace, 'src', 'nested', 'data.bin'), Buffer.from([0, 1, 2, 3, 255]))
  await writeFile(join(workspace, 'src', '.env'), 'SECRET=not-backed-up\n', 'utf8')
  await writeFile(join(workspace, 'node_modules', 'ignored', 'package.js'), 'ignored\n', 'utf8')
  await RepositoryInitializer.initialize(workspace, workspaceId)
  return { workspace, workspaceId }
}

test('explicitly enables immutable file snapshots, deduplicates, previews, and safely exports', async (t) => {
  const current = await fixture()
  t.after(() => rm(current.workspace, { recursive: true, force: true }))

  const before = await FileBackupRepository.status(current.workspace, current.workspaceId)
  assert.deepEqual(before, {
    configured: false,
    enabled: false,
    integrity: 'ok',
    journalEntries: 0,
    snapshots: 0,
  })
  await assert.rejects(readFile(join(current.workspace, '.dsh-repo', 'backup', 'journal.jsonl')), { code: 'ENOENT' })

  const enabled = await FileBackupRepository.enable(current.workspace, current.workspaceId, {
    scope: { kind: 'selected', roots: ['src', 'README.md'] },
    intervalMinutes: 5,
    confirmSensitiveRisk: true,
  })
  assert.equal(enabled.enabled, true)
  assert.deepEqual(enabled.config?.scope, { kind: 'selected', roots: ['README.md', 'src'] })
  assert.equal(enabled.snapshots, 0)

  const first = await FileBackupRepository.capture(current.workspace, current.workspaceId, 'initial')
  assert.equal(first.created, true)
  assert.equal(first.snapshot?.fileCount, 3)
  assert.equal(first.snapshot?.ignoredFiles, 1)
  const checkout = await FileBackupRepository.checkout(current.workspace, current.workspaceId, 'LATEST', 100)
  assert.deepEqual(checkout.records.map(record => record.path), [
    'README.md',
    'src/index.ts',
    'src/nested/data.bin',
  ])
  assert.equal(checkout.truncated, false)

  const text = await FileBackupRepository.preview(current.workspace, current.workspaceId, 'LATEST', 'src/index.ts')
  assert.equal(text.encoding, 'utf8')
  assert.equal(text.content, 'export const value = 1\n')
  const binary = await FileBackupRepository.preview(current.workspace, current.workspaceId, 'LATEST', 'src/nested/data.bin')
  assert.equal(binary.encoding, 'binary')

  const unchanged = await FileBackupRepository.capture(current.workspace, current.workspaceId, 'manual')
  assert.equal(unchanged.created, false)
  assert.equal(unchanged.status.snapshots, 1)

  const journalPath = join(current.workspace, '.dsh-repo', 'backup', 'journal.jsonl')
  const objectsPath = join(current.workspace, '.dsh-repo', 'backup', 'objects', 'sha256')
  const journalBeforeTouch = await readFile(journalPath)
  const objectsBeforeTouch = await listFiles(objectsPath)
  const touchedAt = new Date(Date.now() + 60_000)
  await utimes(join(current.workspace, 'src', 'index.ts'), touchedAt, touchedAt)
  const metadataOnly = await FileBackupRepository.capture(current.workspace, current.workspaceId, 'manual')
  assert.equal(metadataOnly.created, false)
  assert.deepEqual(await readFile(journalPath), journalBeforeTouch)
  assert.deepEqual(await listFiles(objectsPath), objectsBeforeTouch)

  await writeFile(join(current.workspace, 'src', 'index.ts'), 'export const value = 2\n', 'utf8')
  const second = await FileBackupRepository.capture(current.workspace, current.workspaceId, 'manual')
  assert.equal(second.created, true)
  assert.equal(second.snapshot?.parent, first.snapshot?.id)
  const history = await FileBackupRepository.history(current.workspace, current.workspaceId)
  assert.deepEqual(history.map(item => item.id), [second.snapshot?.id, first.snapshot?.id])
  const comparison = await FileBackupRepository.compare(
    current.workspace,
    current.workspaceId,
    first.snapshot.id,
    second.snapshot.id,
  )
  assert.deepEqual(comparison.counts, { added: 0, modified: 1, deleted: 0 })
  assert.deepEqual(comparison.changes.map(change => [change.kind, change.path]), [['modified', 'src/index.ts']])
  const diff = await FileBackupRepository.fileDiff(
    current.workspace,
    current.workspaceId,
    first.snapshot.id,
    second.snapshot.id,
    'src/index.ts',
  )
  assert.equal(diff.display, 'text')
  assert(diff.lines.some(line => line.kind === 'deleted' && line.content === 'export const value = 1'))
  assert(diff.lines.some(line => line.kind === 'added' && line.content === 'export const value = 2'))
  assert.deepEqual(
    diff.lines.filter(line => line.kind === 'deleted' || line.kind === 'added').map(line => line.kind),
    ['deleted', 'added'],
  )
  const rootComparison = await FileBackupRepository.compare(current.workspace, current.workspaceId, 'ROOT', first.snapshot.id)
  assert.deepEqual(rootComparison.counts, { added: 3, modified: 0, deleted: 0 })
  const equalComparison = await FileBackupRepository.compare(current.workspace, current.workspaceId, second.snapshot.id, second.snapshot.id)
  assert.deepEqual(equalComparison.changes, [])

  const exported = await FileBackupRepository.exportSnapshot(current.workspace, current.workspaceId, first.snapshot.id)
  assert.match(exported.relativePath, /^\.dsh-repo\/backup\/exports\/export_/u)
  assert.equal(
    await readFile(join(current.workspace, ...exported.relativePath.split('/'), 'src', 'index.ts'), 'utf8'),
    'export const value = 1\n',
  )
  assert.equal(await readFile(join(current.workspace, 'src', 'index.ts'), 'utf8'), 'export const value = 2\n')

  const disabled = await FileBackupRepository.disable(current.workspace, current.workspaceId)
  assert.equal(disabled.enabled, false)
  await assert.rejects(
    FileBackupRepository.capture(current.workspace, current.workspaceId, 'manual'),
    error => error instanceof FileBackupError && error.code === 'BACKUP_DISABLED',
  )
})

test('requires explicit roots and rejects whole-workspace or unsafe configuration', async (t) => {
  const current = await fixture()
  t.after(() => rm(current.workspace, { recursive: true, force: true }))

  for (const scope of [
    { kind: 'selected', roots: ['.'] },
    { kind: 'selected', roots: ['../escape'] },
    { kind: 'selected', roots: ['.dsh-repo'] },
    { kind: 'selected', roots: ['src', 'src/nested'] },
  ]) {
    await assert.rejects(
      FileBackupRepository.enable(current.workspace, current.workspaceId, {
        scope,
        intervalMinutes: 5,
        confirmSensitiveRisk: true,
      }),
      error => error instanceof FileBackupError && (error.code === 'BACKUP_INVALID_CONFIG' || error.code === 'BACKUP_LIMIT_EXCEEDED'),
    )
  }
  await assert.rejects(
    FileBackupRepository.enable(current.workspace, current.workspaceId, {
      scope: { kind: 'workspace' },
      intervalMinutes: 5,
      confirmSensitiveRisk: true,
    }),
    error => error instanceof FileBackupError && error.code === 'BACKUP_INVALID_CONFIG',
  )

  await FileBackupRepository.enable(current.workspace, current.workspaceId, {
    scope: { kind: 'selected', roots: ['README.md', 'src'] },
    intervalMinutes: 5,
    confirmSensitiveRisk: true,
  })
  const captured = await FileBackupRepository.capture(current.workspace, current.workspaceId, 'initial')
  assert.equal(captured.created, true)
  const checkout = await FileBackupRepository.checkout(current.workspace, current.workspaceId)
  assert.deepEqual(checkout.records.map(record => record.path), [
    'README.md',
    'src/index.ts',
    'src/nested/data.bin',
  ])
})

test('compares added, deleted, binary, and large files without returning unchanged entries', async (t) => {
  const current = await fixture()
  t.after(() => rm(current.workspace, { recursive: true, force: true }))
  await writeFile(join(current.workspace, 'src', 'large.txt'), Buffer.alloc(70 * 1024, 0x61))
  await FileBackupRepository.enable(current.workspace, current.workspaceId, {
    scope: { kind: 'selected', roots: ['README.md', 'src'] },
    intervalMinutes: 5,
    confirmSensitiveRisk: true,
  })
  const first = await FileBackupRepository.capture(current.workspace, current.workspaceId, 'initial')
  await unlink(join(current.workspace, 'src', 'index.ts'))
  await writeFile(join(current.workspace, 'src', 'added.txt'), 'new file\n', 'utf8')
  await writeFile(join(current.workspace, 'src', 'nested', 'data.bin'), Buffer.from([9, 8, 7, 0, 6]))
  await writeFile(join(current.workspace, 'src', 'large.txt'), Buffer.alloc(70 * 1024, 0x62))
  const second = await FileBackupRepository.capture(current.workspace, current.workspaceId, 'manual')
  const comparison = await FileBackupRepository.compare(
    current.workspace,
    current.workspaceId,
    first.snapshot.id,
    second.snapshot.id,
  )
  assert.deepEqual(comparison.counts, { added: 1, modified: 2, deleted: 1 })
  assert.deepEqual(comparison.changes.map(change => change.path), [
    'src/added.txt',
    'src/index.ts',
    'src/large.txt',
    'src/nested/data.bin',
  ])
  const firstPage = await FileBackupRepository.compare(
    current.workspace,
    current.workspaceId,
    first.snapshot.id,
    second.snapshot.id,
    1,
  )
  assert.equal(firstPage.truncated, true)
  assert.equal(firstPage.nextCursor, 'src/added.txt')
  const secondPage = await FileBackupRepository.compare(
    current.workspace,
    current.workspaceId,
    first.snapshot.id,
    second.snapshot.id,
    10,
    firstPage.nextCursor,
  )
  assert.deepEqual(secondPage.changes.map(change => change.path), ['src/index.ts', 'src/large.txt', 'src/nested/data.bin'])
  assert.equal((await FileBackupRepository.fileDiff(
    current.workspace,
    current.workspaceId,
    first.snapshot.id,
    second.snapshot.id,
    'src/nested/data.bin',
  )).display, 'binary')
  assert.equal((await FileBackupRepository.fileDiff(
    current.workspace,
    current.workspaceId,
    first.snapshot.id,
    second.snapshot.id,
    'src/large.txt',
  )).display, 'too-large')
  assert.equal((await FileBackupRepository.fileDiff(
    current.workspace,
    current.workspaceId,
    first.snapshot.id,
    second.snapshot.id,
    'src/index.ts',
  )).kind, 'deleted')
})

test('reports missing final line breaks in text differences', async (t) => {
  const current = await fixture()
  t.after(() => rm(current.workspace, { recursive: true, force: true }))
  await writeFile(join(current.workspace, 'src', 'no-final-lf.txt'), 'before', 'utf8')
  await FileBackupRepository.enable(current.workspace, current.workspaceId, {
    scope: { kind: 'selected', roots: ['src'] },
    intervalMinutes: 5,
    confirmSensitiveRisk: true,
  })
  const first = await FileBackupRepository.capture(current.workspace, current.workspaceId, 'initial')
  await writeFile(join(current.workspace, 'src', 'no-final-lf.txt'), 'after', 'utf8')
  const second = await FileBackupRepository.capture(current.workspace, current.workspaceId, 'manual')
  const diff = await FileBackupRepository.fileDiff(
    current.workspace,
    current.workspaceId,
    first.snapshot.id,
    second.snapshot.id,
    'src/no-final-lf.txt',
  )
  assert.equal(diff.display, 'text')
  assert(diff.lines.some(line => line.kind === 'deleted' && line.content === 'before' && line.lineBreak === false))
  assert(diff.lines.some(line => line.kind === 'added' && line.content === 'after' && line.lineBreak === false))
})

test('fails closed on source junctions and unrecovered backup locks', async (t) => {
  const current = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'local-git-4-llm-backup-outside-'))
  t.after(() => Promise.all([
    rm(current.workspace, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]))
  await writeFile(join(outside, 'outside.txt'), 'outside\n', 'utf8')
  await FileBackupRepository.enable(current.workspace, current.workspaceId, {
    scope: { kind: 'selected', roots: ['src'] },
    intervalMinutes: 5,
    confirmSensitiveRisk: true,
  })

  const junction = join(current.workspace, 'src', 'outside-link')
  await symlink(outside, junction, 'junction')
  await assert.rejects(
    FileBackupRepository.capture(current.workspace, current.workspaceId, 'manual'),
    error => error instanceof FileBackupError && error.code === 'BACKUP_SOURCE_UNSAFE',
  )
  await unlink(junction)

  const lockPath = join(current.workspace, '.dsh-repo', 'backup', 'write.lock')
  await writeFile(lockPath, 'unrecovered\n', 'utf8')
  await assert.rejects(
    FileBackupRepository.capture(current.workspace, current.workspaceId, 'manual'),
    error => error instanceof FileBackupError && error.code === 'BACKUP_BUSY',
  )
  assert.equal(await readFile(lockPath, 'utf8'), 'unrecovered\n')
})

test('detects corruption in a reachable content-addressed object', async (t) => {
  const current = await fixture()
  t.after(() => rm(current.workspace, { recursive: true, force: true }))
  await FileBackupRepository.enable(current.workspace, current.workspaceId, {
    scope: { kind: 'selected', roots: ['src'] },
    intervalMinutes: 5,
    confirmSensitiveRisk: true,
  })
  const captured = await FileBackupRepository.capture(current.workspace, current.workspaceId, 'initial')
  const checkout = await FileBackupRepository.checkout(current.workspace, current.workspaceId, captured.snapshot.id)
  const blob = checkout.records[0].blob.slice(7)
  const objectPath = join(current.workspace, '.dsh-repo', 'backup', 'objects', 'sha256', blob.slice(0, 2), blob.slice(2))
  await writeFile(objectPath, 'corrupt', 'utf8')
  await assert.rejects(
    FileBackupRepository.preview(current.workspace, current.workspaceId, captured.snapshot.id, checkout.records[0].path),
    error => error instanceof FileBackupError && error.code === 'BACKUP_CORRUPT',
  )
})

test('pre-aborted and stale capture locks fail without mutating backup state', async (t) => {
  const current = await fixture()
  t.after(() => rm(current.workspace, { recursive: true, force: true }))
  await FileBackupRepository.enable(current.workspace, current.workspaceId, {
    scope: { kind: 'selected', roots: ['src'] },
    intervalMinutes: 5,
    confirmSensitiveRisk: true,
  })
  const journalPath = join(current.workspace, '.dsh-repo', 'backup', 'journal.jsonl')
  const objectRoot = join(current.workspace, '.dsh-repo', 'backup', 'objects', 'sha256')
  const journalBefore = await readFile(journalPath)
  const objectsBefore = await listFiles(objectRoot)
  const controller = new AbortController()
  controller.abort(new DOMException('test cancellation', 'AbortError'))
  await assert.rejects(
    FileBackupRepository.capture(current.workspace, current.workspaceId, 'manual', controller.signal),
    error => error?.name === 'AbortError',
  )
  assert.deepEqual(await readFile(journalPath), journalBefore)
  assert.deepEqual(await listFiles(objectRoot), objectsBefore)

  const lockPath = join(current.workspace, '.dsh-repo', 'backup', 'capture.lock')
  await writeFile(lockPath, 'unrecovered capture\n', 'utf8')
  await assert.rejects(
    FileBackupRepository.capture(current.workspace, current.workspaceId, 'manual'),
    error => error instanceof FileBackupError && error.code === 'BACKUP_BUSY',
  )
  assert.equal(await readFile(lockPath, 'utf8'), 'unrecovered capture\n')
  assert.deepEqual(await readFile(journalPath), journalBefore)
})

test('cancellation after object creation removes the incomplete content-addressed file', async (t) => {
  const current = await fixture()
  t.after(() => rm(current.workspace, { recursive: true, force: true }))
  await FileBackupRepository.enable(current.workspace, current.workspaceId, {
    scope: { kind: 'selected', roots: ['src'] },
    intervalMinutes: 5,
    confirmSensitiveRisk: true,
  })
  const backupRoot = join(current.workspace, '.dsh-repo', 'backup')
  const journalPath = join(backupRoot, 'journal.jsonl')
  const objectRoot = join(backupRoot, 'objects', 'sha256')
  const journalBefore = await readFile(journalPath)
  const objectsBefore = await listFiles(objectRoot)
  const controller = new AbortController()
  await assert.rejects(
    FileBackupRepository.capture(current.workspace, current.workspaceId, 'manual', controller.signal, {
      checkpoint(name) {
        if (name === 'object-created') controller.abort(new DOMException('cancel incomplete object', 'AbortError'))
      },
    }),
    error => error?.name === 'AbortError',
  )
  assert.deepEqual(await readFile(journalPath), journalBefore)
  assert.deepEqual(await listFiles(objectRoot), objectsBefore)
  assert.equal((await FileBackupRepository.status(current.workspace, current.workspaceId)).snapshots, 0)
  assert.equal((await FileBackupRepository.capture(current.workspace, current.workspaceId, 'manual')).created, true)
})

test('capture.lock serializes concurrent core captures across the shared repository', async (t) => {
  const current = await fixture()
  t.after(() => rm(current.workspace, { recursive: true, force: true }))
  await FileBackupRepository.enable(current.workspace, current.workspaceId, {
    scope: { kind: 'selected', roots: ['src'] },
    intervalMinutes: 5,
    confirmSensitiveRisk: true,
  })
  const entered = deferred()
  const release = deferred()
  const first = FileBackupRepository.capture(current.workspace, current.workspaceId, 'manual', undefined, {
    async checkpoint(name) {
      if (name !== 'capture-lock-acquired') return
      entered.resolve()
      await release.promise
    },
  })
  await entered.promise
  await assert.rejects(
    FileBackupRepository.capture(current.workspace, current.workspaceId, 'manual'),
    error => error instanceof FileBackupError && error.code === 'BACKUP_BUSY',
  )
  release.resolve()
  assert.equal((await first).created, true)
  assert.equal((await FileBackupRepository.status(current.workspace, current.workspaceId)).snapshots, 1)
  assert.equal(await pathExists(join(current.workspace, '.dsh-repo', 'backup', 'capture.lock')), false)
})

test('rejects a checksum-valid snapshot event appended while backup is disabled', async (t) => {
  const current = await fixture()
  t.after(() => rm(current.workspace, { recursive: true, force: true }))
  await FileBackupRepository.enable(current.workspace, current.workspaceId, {
    scope: { kind: 'selected', roots: ['src'] },
    intervalMinutes: 5,
    confirmSensitiveRisk: true,
  })
  const captured = await FileBackupRepository.capture(current.workspace, current.workspaceId, 'initial')
  await FileBackupRepository.disable(current.workspace, current.workspaceId)
  const journalPath = join(current.workspace, '.dsh-repo', 'backup', 'journal.jsonl')
  const records = (await readFile(journalPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  const last = records.at(-1)
  const body = {
    formatVersion: 1,
    seq: last.seq + 1,
    type: 'backup.snapshot.created',
    ts: new Date().toISOString(),
    prev: last.checksum,
    payload: { snapshot: captured.snapshot.id },
  }
  await appendFile(journalPath, `${canonicalJson({ ...body, checksum: `sha256:${sha256(body)}` })}\n`, 'utf8')
  await assert.rejects(
    FileBackupRepository.status(current.workspace, current.workspaceId),
    error => error instanceof FileBackupError && error.code === 'BACKUP_CORRUPT'
      && /关闭期间/u.test(error.message),
  )
})

test('failed pre-publication export preserves its lock and removes private staging', async (t) => {
  const current = await fixture()
  t.after(() => rm(current.workspace, { recursive: true, force: true }))
  await FileBackupRepository.enable(current.workspace, current.workspaceId, {
    scope: { kind: 'selected', roots: ['src'] },
    intervalMinutes: 5,
    confirmSensitiveRisk: true,
  })
  await FileBackupRepository.capture(current.workspace, current.workspaceId, 'initial')
  const backupRoot = join(current.workspace, '.dsh-repo', 'backup')
  const lockPath = join(backupRoot, 'write.lock')
  await writeFile(lockPath, 'unrecovered export\n', 'utf8')
  await assert.rejects(
    FileBackupRepository.exportSnapshot(current.workspace, current.workspaceId, 'LATEST'),
    error => error instanceof FileBackupError && error.code === 'BACKUP_BUSY',
  )
  assert.equal(await readFile(lockPath, 'utf8'), 'unrecovered export\n')
  assert.deepEqual(await readdir(join(backupRoot, '.staging')), [])
  assert.deepEqual(await readdir(join(backupRoot, 'exports')), [])
})

test('export cancellation is honored before publish and ignored after its irreversible boundary', async (t) => {
  const current = await fixture()
  t.after(() => rm(current.workspace, { recursive: true, force: true }))
  await FileBackupRepository.enable(current.workspace, current.workspaceId, {
    scope: { kind: 'selected', roots: ['src'] },
    intervalMinutes: 5,
    confirmSensitiveRisk: true,
  })
  await FileBackupRepository.capture(current.workspace, current.workspaceId, 'initial')
  const backupRoot = join(current.workspace, '.dsh-repo', 'backup')
  const journalPath = join(backupRoot, 'journal.jsonl')
  const journalBefore = await readFile(journalPath)
  const beforePublish = new AbortController()
  await assert.rejects(
    FileBackupRepository.exportSnapshot(current.workspace, current.workspaceId, 'LATEST', beforePublish.signal, {
      checkpoint(name) {
        if (name === 'export-before-publish') beforePublish.abort(new DOMException('cancel before publish', 'AbortError'))
      },
    }),
    error => error?.name === 'AbortError',
  )
  assert.deepEqual(await readFile(journalPath), journalBefore)
  assert.deepEqual(await readdir(join(backupRoot, '.staging')), [])
  assert.deepEqual(await readdir(join(backupRoot, 'exports')), [])

  const afterPublish = new AbortController()
  const exported = await FileBackupRepository.exportSnapshot(
    current.workspace,
    current.workspaceId,
    'LATEST',
    afterPublish.signal,
    {
      checkpoint(name) {
        if (name === 'export-published') afterPublish.abort(new DOMException('cancel after publish', 'AbortError'))
      },
    },
  )
  assert.equal(afterPublish.signal.aborted, true)
  assert.equal(await pathExists(join(backupRoot, 'exports', exported.exportId)), true)
  assert.deepEqual(await readdir(join(backupRoot, '.staging')), [])
  const records = (await readFile(journalPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  assert.equal(records.filter(record => record.type === 'backup.restore.exported').length, 1)
  assert.equal(records.at(-1).payload.exportId, exported.exportId)
})

test('scheduler scans only an explicitly enabled workspace and creates its due initial snapshot', async (t) => {
  const enabledWorkspace = await fixture()
  const disabledWorkspace = await fixture()
  t.after(() => Promise.all([
    rm(enabledWorkspace.workspace, { recursive: true, force: true }),
    rm(disabledWorkspace.workspace, { recursive: true, force: true }),
  ]))
  await FileBackupRepository.enable(enabledWorkspace.workspace, enabledWorkspace.workspaceId, {
    scope: { kind: 'selected', roots: ['src'] },
    intervalMinutes: 5,
    confirmSensitiveRisk: true,
  })
  let initialCallback
  let intervalCallback
  let dispose
  const ctx = {
    effect(factory) {
      dispose = factory()
      return dispose
    },
    timeout(callback) {
      initialCallback = callback
      return () => {}
    },
    interval(callback) {
      intervalCallback = callback
      return () => {}
    },
    workspaceRegistry: {
      list() {
        return [
          { id: enabledWorkspace.workspaceId, path: enabledWorkspace.workspace },
          { id: disabledWorkspace.workspaceId, path: disabledWorkspace.workspace },
        ]
      },
    },
  }
  const scheduler = new FileBackupScheduler(ctx)
  scheduler.install()
  assert.equal(typeof initialCallback, 'function')
  assert.equal(typeof intervalCallback, 'function')
  initialCallback()
  await waitFor(async () => (await FileBackupRepository.status(enabledWorkspace.workspace, enabledWorkspace.workspaceId)).snapshots === 1
    && scheduler.getRuntimeStatus(enabledWorkspace.workspaceId).running === false)
  assert.equal((await FileBackupRepository.status(disabledWorkspace.workspace, disabledWorkspace.workspaceId)).configured, false)
  assert.deepEqual(scheduler.getRuntimeStatus(enabledWorkspace.workspaceId), { running: false })

  await writeFile(join(enabledWorkspace.workspace, 'src', 'index.ts'), 'export const value = 3\n', 'utf8')
  const manual = scheduler.captureNow(
    { id: enabledWorkspace.workspaceId, path: enabledWorkspace.workspace },
    'manual',
  )
  await assert.rejects(
    scheduler.captureNow({ id: enabledWorkspace.workspaceId, path: enabledWorkspace.workspace }, 'manual'),
    error => error instanceof FileBackupError && error.code === 'BACKUP_BUSY',
  )
  assert.equal((await manual).created, true)
  await dispose()
})

test('scheduler dispose aborts and awaits every manual capture it owns', async (t) => {
  const current = await fixture()
  t.after(() => rm(current.workspace, { recursive: true, force: true }))
  let dispose
  const workspace = { id: current.workspaceId, path: current.workspace }
  const started = deferred()
  let capturedSignal
  const captureRunner = (_path, _workspaceId, _reason, signal) => {
    capturedSignal = signal
    started.resolve()
    return new Promise((_resolve, reject) => {
      const fail = () => reject(signal.reason)
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    })
  }
  const ctx = {
    effect(factory) { dispose = factory(); return dispose },
    timeout() { return () => {} },
    interval() { return () => {} },
    workspaceRegistry: { list() { return [workspace] } },
  }
  const scheduler = new FileBackupScheduler(ctx, captureRunner)
  scheduler.install()
  const pending = scheduler.captureNow(workspace, 'manual')
  const outcome = pending.then(
    value => ({ kind: 'fulfilled', value }),
    error => ({ kind: 'rejected', error }),
  )
  await started.promise
  const disposing = dispose()
  assert.equal(capturedSignal.aborted, true)
  await disposing
  const settled = await outcome
  assert.equal(settled.kind, 'rejected')
  assert.equal(settled.error?.name, 'AbortError')
  assert.deepEqual(scheduler.getRuntimeStatus(current.workspaceId), { running: false })
  await assert.rejects(scheduler.captureNow(workspace, 'manual'), error => error?.name === 'AbortError')
})

async function waitFor(predicate) {
  const timeout = Date.now() + 5_000
  while (Date.now() < timeout) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('condition did not become true before timeout')
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function listFiles(root, prefix = '') {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) result.push(...await listFiles(join(root, entry.name), relative))
    else result.push(relative)
  }
  return result.sort()
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}
