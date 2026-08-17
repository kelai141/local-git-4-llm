import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalJson, sha256 } from '../lib/core/canonical.js'
import { RepositoryReader, RepositoryReadError } from '../lib/core/repository.js'

const AT = '2026-08-17T00:00:00.000Z'

function hashId(value) {
  return `sha256:${sha256(value)}`
}

function journalRecord(unsigned) {
  return { ...unsigned, checksum: hashId(unsigned) }
}

function makeTree(entries) {
  const normalized = entries.map(({ key, value }) => ({ key, value, valueHash: hashId(value) }))
  const body = { format: 'local-git-4-llm/tree', formatVersion: 1, entries: normalized }
  return { ...body, id: hashId(body) }
}

function makeCommit(tree) {
  const body = {
    format: 'local-git-4-llm/commit',
    formatVersion: 1,
    parent: null,
    tree: tree.id,
    message: 'Seed explicit knowledge',
    author: { sessionId: 'session_fixture' },
    kind: 'normal',
    createdAt: AT,
  }
  return { ...body, id: hashId(body) }
}

async function createFixture({ issue = false } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'local-git-4-llm-m1a-'))
  const workspaceId = 'workspace_fixture_001'
  const repoId = 'repo_fixture_001'
  const repositoryRoot = join(workspace, '.dsh-repo')
  await mkdir(repositoryRoot)
  const manifest = {
    format: 'local-git-4-llm/repository',
    formatVersion: 1,
    repoId,
    workspaceId,
    storage: 'workspace',
    journal: { file: 'journal.jsonl', hash: 'sha256' },
    createdAt: AT,
  }
  const initialized = journalRecord({
    formatVersion: 1,
    seq: 1,
    type: 'repo.initialized',
    ts: AT,
    prev: null,
    payload: { repoId, workspaceId, manifestHash: hashId(manifest) },
  })
  const tree = makeTree([
    { key: 'project.owner', value: 'team-a' },
    { key: 'project.status', value: { ready: true, stage: 'm1a' } },
  ])
  const commit = makeCommit(tree)
  const committed = journalRecord({
    formatVersion: 1,
    seq: 2,
    type: 'commit.created',
    ts: AT,
    prev: initialized.checksum,
    payload: { commit, tree },
  })
  const records = [initialized, committed]
  if (issue) {
    records.push(journalRecord({
      formatVersion: 1,
      seq: 3,
      type: 'issue.opened',
      ts: AT,
      prev: committed.checksum,
      payload: {
        issue: {
          id: 'issue-1',
          title: 'Fixture issue',
          body: 'Verify journal projection.',
          status: 'open',
          labels: ['m1a'],
          createdAt: AT,
          updatedAt: AT,
        },
      },
    }))
  }
  await writeFile(join(repositoryRoot, 'manifest.json'), `${canonicalJson(manifest)}\n`, 'utf8')
  await writeFile(join(repositoryRoot, 'journal.jsonl'), `${records.map(canonicalJson).join('\n')}\n`, 'utf8')
  return { workspace, workspaceId, repositoryRoot, commit, tree }
}

test('replays a canonical journal into status, log, diff, knowledge, and issues', async (t) => {
  const fixture = await createFixture({ issue: true })
  t.after(() => rm(fixture.workspace, { recursive: true, force: true }))
  const reader = await RepositoryReader.open(fixture.workspace, fixture.workspaceId)
  assert.ok(reader)

  const status = await reader.status()
  assert.equal(status.head, fixture.commit.id)
  assert.deepEqual({ journalEntries: status.journalEntries, commits: status.commits, knowledgeKeys: status.knowledgeKeys, issues: status.issues }, {
    journalEntries: 3,
    commits: 1,
    knowledgeKeys: 2,
    issues: 1,
  })
  const commits = await reader.log()
  assert.deepEqual(commits.map(commit => commit.id), [fixture.commit.id])
  assert.deepEqual(Object.keys(commits[0]).sort(), ['createdAt', 'id', 'kind', 'message', 'parent', 'tree'])
  assert.deepEqual((await reader.diff('ROOT', 'HEAD')).changes.map(change => [change.key, change.kind]), [
    ['project.owner', 'added'],
    ['project.status', 'added'],
  ])
  assert.deepEqual((await reader.pull(undefined, 50, undefined)).records.map(record => record.key), ['project.owner', 'project.status'])
  const firstExplicitPage = await reader.pull(['project.owner', 'project.status'], 1, undefined)
  assert.deepEqual(firstExplicitPage.records.map(record => record.key), ['project.owner'])
  assert.equal(firstExplicitPage.nextCursor, 'project.owner')
  const secondExplicitPage = await reader.pull(['project.owner', 'project.status'], 1, firstExplicitPage.nextCursor)
  assert.deepEqual(secondExplicitPage.records.map(record => record.key), ['project.status'])
  assert.equal(secondExplicitPage.truncated, false)
  assert.equal((await reader.getIssue('issue-1')).title, 'Fixture issue')
})

test('rejects a same-path repository replacement even when it copies the same repoId', async (t) => {
  const fixture = await createFixture()
  t.after(() => rm(fixture.workspace, { recursive: true, force: true }))
  const reader = await RepositoryReader.open(fixture.workspace, fixture.workspaceId)
  assert.ok(reader)
  const displaced = `${fixture.repositoryRoot}-displaced`
  await rename(fixture.repositoryRoot, displaced)
  await cp(displaced, fixture.repositoryRoot, { recursive: true })
  await assert.rejects(
    reader.status(),
    error => error instanceof RepositoryReadError && error.code === 'REPO_PATH_ESCAPE',
  )
})

test('rejects malformed optional issue fields instead of silently normalizing them', async (t) => {
  const fixture = await createFixture({ issue: true })
  t.after(() => rm(fixture.workspace, { recursive: true, force: true }))
  const journalPath = join(fixture.repositoryRoot, 'journal.jsonl')
  const records = (await readFile(journalPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  records[2].payload.issue.assignee = 42
  const { checksum: _checksum, ...unsigned } = records[2]
  records[2].checksum = hashId(unsigned)
  await writeFile(journalPath, `${records.map(canonicalJson).join('\n')}\n`, 'utf8')
  const reader = await RepositoryReader.open(fixture.workspace, fixture.workspaceId)
  assert.ok(reader)
  await assert.rejects(
    reader.status(),
    error => error instanceof RepositoryReadError && error.code === 'JOURNAL_EVENT_UNSUPPORTED',
  )
})

test('rejects duplicate issue labels during replay', async (t) => {
  const fixture = await createFixture({ issue: true })
  t.after(() => rm(fixture.workspace, { recursive: true, force: true }))
  const journalPath = join(fixture.repositoryRoot, 'journal.jsonl')
  const records = (await readFile(journalPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  records[2].payload.issue.labels = ['duplicate', 'duplicate']
  const { checksum: _checksum, ...unsigned } = records[2]
  records[2].checksum = hashId(unsigned)
  await writeFile(journalPath, `${records.map(canonicalJson).join('\n')}\n`, 'utf8')
  const reader = await RepositoryReader.open(fixture.workspace, fixture.workspaceId)
  assert.ok(reader)
  await assert.rejects(
    reader.status(),
    error => error instanceof RepositoryReadError && error.code === 'JOURNAL_EVENT_UNSUPPORTED',
  )
})

test('requires a durable delivery request before a delivered audit event', async (t) => {
  const fixture = await createFixture()
  t.after(() => rm(fixture.workspace, { recursive: true, force: true }))
  const journalPath = join(fixture.repositoryRoot, 'journal.jsonl')
  const records = (await readFile(journalPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  const created = journalRecord({
    formatVersion: 1,
    seq: 3,
    type: 'comment.created',
    ts: AT,
    prev: records[1].checksum,
    payload: {
      comment: {
        id: 'comment-order-test',
        body: 'Delivery must be queued first.',
        author: 'admin',
        mentions: ['session-a'],
        createdAt: AT,
      },
    },
  })
  const delivered = journalRecord({
    formatVersion: 1,
    seq: 4,
    type: 'comment.delivered',
    ts: AT,
    prev: created.checksum,
    payload: { commentId: 'comment-order-test', sessionIds: ['session-a'], deliveredAt: AT },
  })
  records.push(created, delivered)
  await writeFile(journalPath, `${records.map(canonicalJson).join('\n')}\n`, 'utf8')
  const reader = await RepositoryReader.open(fixture.workspace, fixture.workspaceId)
  assert.ok(reader)
  await assert.rejects(
    reader.status(),
    error => error instanceof RepositoryReadError && error.code === 'JOURNAL_EVENT_UNSUPPORTED',
  )
})

test('validates an issue comment author when the field is present', async (t) => {
  const fixture = await createFixture({ issue: true })
  t.after(() => rm(fixture.workspace, { recursive: true, force: true }))
  const journalPath = join(fixture.repositoryRoot, 'journal.jsonl')
  const records = (await readFile(journalPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  records.push(journalRecord({
    formatVersion: 1,
    seq: 4,
    type: 'issue.comment.added',
    ts: AT,
    prev: records[2].checksum,
    payload: { id: 'issue-1', body: 'Malformed author', author: { unexpected: true }, updatedAt: AT },
  }))
  await writeFile(journalPath, `${records.map(canonicalJson).join('\n')}\n`, 'utf8')
  const reader = await RepositoryReader.open(fixture.workspace, fixture.workspaceId)
  assert.ok(reader)
  await assert.rejects(
    reader.status(),
    error => error instanceof RepositoryReadError && error.code === 'JOURNAL_EVENT_UNSUPPORTED',
  )
})

test('does not create a repository for an uninitialized workspace', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'local-git-4-llm-empty-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  assert.equal(await RepositoryReader.open(workspace, 'workspace_fixture_001'), undefined)
  await assert.rejects(stat(join(workspace, '.dsh-repo')), { code: 'ENOENT' })
})

test('honors an already-aborted read without touching the workspace', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'local-git-4-llm-abort-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    RepositoryReader.open(workspace, 'workspace_fixture_001', controller.signal),
    error => error instanceof Error && error.name === 'AbortError',
  )
  await assert.rejects(stat(join(workspace, '.dsh-repo')), { code: 'ENOENT' })
})

test('requires repository initialization as the first journal record', async (t) => {
  const fixture = await createFixture()
  t.after(() => rm(fixture.workspace, { recursive: true, force: true }))
  const first = journalRecord({
    formatVersion: 1,
    seq: 1,
    type: 'issue.opened',
    ts: AT,
    prev: null,
    payload: {
      issue: {
        id: 'issue-before-init',
        title: 'Invalid journal ordering',
        body: 'Initialization must be first.',
        status: 'open',
        labels: [],
        createdAt: AT,
        updatedAt: AT,
      },
    },
  })
  await writeFile(join(fixture.repositoryRoot, 'journal.jsonl'), `${canonicalJson(first)}\n`, 'utf8')
  const reader = await RepositoryReader.open(fixture.workspace, fixture.workspaceId)
  await assert.rejects(
    reader.status(),
    error => error instanceof RepositoryReadError && error.code === 'JOURNAL_EVENT_UNSUPPORTED',
  )
})

test('rejects a manifest bound to another DSH workspace', async (t) => {
  const fixture = await createFixture()
  t.after(() => rm(fixture.workspace, { recursive: true, force: true }))
  await assert.rejects(
    RepositoryReader.open(fixture.workspace, 'workspace_different'),
    error => error instanceof RepositoryReadError && error.code === 'REPO_PATH_ESCAPE',
  )
})

test('rejects a repository junction that resolves outside the registered workspace', async (t) => {
  const fixture = await createFixture()
  const outside = await mkdtemp(join(tmpdir(), 'local-git-4-llm-outside-'))
  t.after(async () => {
    await rm(fixture.workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
  await rm(fixture.repositoryRoot, { recursive: true, force: true })
  await symlink(outside, fixture.repositoryRoot, 'junction')
  await assert.rejects(
    RepositoryReader.open(fixture.workspace, fixture.workspaceId),
    error => error instanceof RepositoryReadError && error.code === 'REPO_PATH_ESCAPE',
  )
})

test('detects journal checksum corruption and a truncated tail without repairing either', async (t) => {
  const fixture = await createFixture()
  t.after(() => rm(fixture.workspace, { recursive: true, force: true }))
  const journal = join(fixture.repositoryRoot, 'journal.jsonl')
  const original = await (await import('node:fs/promises')).readFile(journal, 'utf8')
  await writeFile(journal, original.replace('repo_fixture_001', 'repo_fixture_002'), 'utf8')
  const reader = await RepositoryReader.open(fixture.workspace, fixture.workspaceId)
  await assert.rejects(
    reader.status(),
    error => error instanceof RepositoryReadError && error.code === 'JOURNAL_CHECKSUM_MISMATCH',
  )

  await writeFile(journal, original.slice(0, -1), 'utf8')
  await assert.rejects(
    reader.status(),
    error => error instanceof RepositoryReadError && error.code === 'JOURNAL_TRUNCATED_TAIL',
  )
})

test('rejects non-canonical journal records, including duplicate JSON keys', async (t) => {
  const fixture = await createFixture()
  t.after(() => rm(fixture.workspace, { recursive: true, force: true }))
  const journal = join(fixture.repositoryRoot, 'journal.jsonl')
  const original = await (await import('node:fs/promises')).readFile(journal, 'utf8')
  await writeFile(journal, `${original}{"formatVersion":1,"formatVersion":1}\n`, 'utf8')
  const reader = await RepositoryReader.open(fixture.workspace, fixture.workspaceId)
  await assert.rejects(
    reader.status(),
    error => error instanceof RepositoryReadError && error.code === 'JOURNAL_NON_CANONICAL',
  )
})
