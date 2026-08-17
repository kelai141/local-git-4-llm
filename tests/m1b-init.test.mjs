import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalJson } from '../lib/core/canonical.js'
import { RepositoryInitializationError, RepositoryInitializer } from '../lib/core/initializer.js'
import { RepositoryReader } from '../lib/core/repository.js'

async function temporaryWorkspace(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'local-git-4-llm-m1b-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  return { workspace, workspaceId: 'workspace_m1b_fixture_001', repositoryRoot: join(workspace, '.dsh-repo') }
}

test('explicit initialization publishes a complete M1a-readable empty repository', async (t) => {
  const fixture = await temporaryWorkspace(t)
  const result = await RepositoryInitializer.initialize(fixture.workspace, fixture.workspaceId)
  assert.equal(result.initialized, true)
  assert.equal(result.workspaceId, fixture.workspaceId)
  assert.match(result.repoId, /^repo_[A-Za-z0-9_-]{8,120}$/)
  assert.deepEqual({ journalEntries: result.journalEntries, head: result.head }, { journalEntries: 1, head: null })

  const manifestSource = await readFile(join(fixture.repositoryRoot, 'manifest.json'), 'utf8')
  const journalSource = await readFile(join(fixture.repositoryRoot, 'journal.jsonl'), 'utf8')
  assert.equal(manifestSource, `${canonicalJson(JSON.parse(manifestSource))}\n`)
  assert.equal(journalSource, `${canonicalJson(JSON.parse(journalSource))}\n`)

  const reader = await RepositoryReader.open(fixture.workspace, fixture.workspaceId)
  assert.ok(reader)
  assert.deepEqual(await reader.status(), {
    formatVersion: 1,
    repoId: result.repoId,
    workspaceId: fixture.workspaceId,
    head: null,
    journalEntries: 1,
    commits: 0,
    knowledgeKeys: 0,
    issues: 0,
    integrity: 'ok',
  })
  assert.deepEqual((await readdir(fixture.workspace)).filter(name => name.startsWith('.local-git-4-llm-init-')), [])
})

test('a valid current-workspace repository is idempotent and unchanged', async (t) => {
  const fixture = await temporaryWorkspace(t)
  const first = await RepositoryInitializer.initialize(fixture.workspace, fixture.workspaceId)
  const before = {
    manifest: await readFile(join(fixture.repositoryRoot, 'manifest.json'), 'utf8'),
    journal: await readFile(join(fixture.repositoryRoot, 'journal.jsonl'), 'utf8'),
  }
  const second = await RepositoryInitializer.initialize(fixture.workspace, fixture.workspaceId)
  const after = {
    manifest: await readFile(join(fixture.repositoryRoot, 'manifest.json'), 'utf8'),
    journal: await readFile(join(fixture.repositoryRoot, 'journal.jsonl'), 'utf8'),
  }
  assert.equal(second.initialized, false)
  assert.deepEqual(second, { ...first, initialized: false })
  assert.deepEqual(after, before)
})

test('does not overwrite a pre-existing invalid repository directory', async (t) => {
  const fixture = await temporaryWorkspace(t)
  await mkdir(fixture.repositoryRoot)
  const marker = join(fixture.repositoryRoot, 'preserve.txt')
  await writeFile(marker, 'do not replace', 'utf8')
  await assert.rejects(
    RepositoryInitializer.initialize(fixture.workspace, fixture.workspaceId),
    error => error instanceof RepositoryInitializationError && error.code === 'REPO_EXISTS_INVALID',
  )
  assert.equal(await readFile(marker, 'utf8'), 'do not replace')
  await assert.rejects(stat(join(fixture.repositoryRoot, 'manifest.json')), { code: 'ENOENT' })
})

test('does not replace a pre-existing repository file', async (t) => {
  const fixture = await temporaryWorkspace(t)
  await writeFile(fixture.repositoryRoot, 'preserve this file', 'utf8')
  await assert.rejects(
    RepositoryInitializer.initialize(fixture.workspace, fixture.workspaceId),
    error => error instanceof RepositoryInitializationError && error.code === 'REPO_PATH_ESCAPE',
  )
  assert.equal(await readFile(fixture.repositoryRoot, 'utf8'), 'preserve this file')
})

test('rejects a repository junction outside the registered workspace without writing outside it', async (t) => {
  const fixture = await temporaryWorkspace(t)
  const outside = await mkdtemp(join(tmpdir(), 'local-git-4-llm-m1b-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await symlink(outside, fixture.repositoryRoot, 'junction')
  await assert.rejects(
    RepositoryInitializer.initialize(fixture.workspace, fixture.workspaceId),
    error => error instanceof RepositoryInitializationError && error.code === 'REPO_PATH_ESCAPE',
  )
  assert.deepEqual(await readdir(outside), [])
})

test('honors an abort before any staging or repository write', async (t) => {
  const fixture = await temporaryWorkspace(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    RepositoryInitializer.initialize(fixture.workspace, fixture.workspaceId, controller.signal),
    error => error instanceof Error && error.name === 'AbortError',
  )
  await assert.rejects(stat(fixture.repositoryRoot), { code: 'ENOENT' })
  assert.deepEqual(await readdir(fixture.workspace), [])
})
