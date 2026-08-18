import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { FileBackupError, FileBackupRepository } from '../lib/core/backup.js'
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

  await writeFile(join(current.workspace, 'src', 'index.ts'), 'export const value = 2\n', 'utf8')
  const second = await FileBackupRepository.capture(current.workspace, current.workspaceId, 'manual')
  assert.equal(second.created, true)
  assert.equal(second.snapshot?.parent, first.snapshot?.id)
  const history = await FileBackupRepository.history(current.workspace, current.workspaceId)
  assert.deepEqual(history.map(item => item.id), [second.snapshot?.id, first.snapshot?.id])

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
  await dispose()
})

async function waitFor(predicate) {
  const timeout = Date.now() + 5_000
  while (Date.now() < timeout) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('condition did not become true before timeout')
}
