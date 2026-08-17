import assert from 'node:assert/strict'
import { appendFile, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RepositoryInitializer } from '../lib/core/initializer.js'
import { RepositoryReader } from '../lib/core/repository.js'
import { RepositoryWriteError, RepositoryWriter } from '../lib/core/writer.js'

async function temporaryRepository(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'local-git-4-llm-commit-'))
  const workspaceId = 'workspace_commit_fixture_001'
  const repositoryRoot = join(workspace, '.dsh-repo')
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await RepositoryInitializer.initialize(workspace, workspaceId)
  return { workspace, workspaceId, repositoryRoot, journal: join(repositoryRoot, 'journal.jsonl') }
}

const author = { sessionId: 'session_commit_fixture_001' }

test('commits full immutable snapshots with parent linkage, set, and delete', async (t) => {
  const fixture = await temporaryRepository(t)
  const first = await RepositoryWriter.commit(fixture.workspace, fixture.workspaceId, {
    message: '记录项目初始状态',
    set: [
      { key: 'project.owner', value: 'team-a' },
      { key: 'project.status', value: { ready: false, stage: 'm1b' } },
    ],
    author,
  })
  assert.equal(first.committed, true)
  assert.equal(first.commit.parent, null)
  assert.deepEqual(first.changes.map(change => [change.key, change.kind]), [
    ['project.owner', 'added'],
    ['project.status', 'added'],
  ])

  const second = await RepositoryWriter.commit(fixture.workspace, fixture.workspaceId, {
    message: '推进状态并移除负责人',
    set: [{ key: 'project.status', value: { ready: true, stage: 'm1b-commit' } }],
    delete: ['project.owner'],
    author,
  })
  assert.equal(second.committed, true)
  assert.equal(second.commit.parent, first.commit.id)
  assert.deepEqual(second.changes.map(change => [change.key, change.kind]), [
    ['project.owner', 'deleted'],
    ['project.status', 'changed'],
  ])

  const reader = await RepositoryReader.open(fixture.workspace, fixture.workspaceId)
  assert.ok(reader)
  assert.deepEqual(await reader.status(), {
    formatVersion: 1,
    repoId: reader.manifest.repoId,
    workspaceId: fixture.workspaceId,
    head: second.commit.id,
    journalEntries: 3,
    commits: 2,
    knowledgeKeys: 1,
    issues: 0,
    integrity: 'ok',
  })
  const log = await reader.log()
  assert.deepEqual(log.map(commit => commit.id), [second.commit.id, first.commit.id])
  assert.deepEqual((await reader.pull()).records.map(record => [record.key, record.value]), [
    ['project.status', { ready: true, stage: 'm1b-commit' }],
  ])
  assert.deepEqual((await reader.diff(first.commit.id, second.commit.id)).changes.map(change => [change.key, change.kind]), [
    ['project.owner', 'deleted'],
    ['project.status', 'changed'],
  ])
  await assert.rejects(stat(join(fixture.repositoryRoot, 'write.lock')), { code: 'ENOENT' })
})

test('returns a no-op without appending when the resulting snapshot is unchanged', async (t) => {
  const fixture = await temporaryRepository(t)
  const first = await RepositoryWriter.commit(fixture.workspace, fixture.workspaceId, {
    message: '写入稳定值',
    set: [{ key: 'project.stage', value: 'stable' }],
    author,
  })
  const before = await readFile(fixture.journal, 'utf8')
  const result = await RepositoryWriter.commit(fixture.workspace, fixture.workspaceId, {
    message: '重复同一值并删除不存在的 key',
    set: [{ key: 'project.stage', value: 'stable' }],
    delete: ['project.absent'],
    author,
  })
  assert.deepEqual(result, {
    committed: false,
    head: first.commit.id,
    commit: null,
    changes: [],
    journalEntries: 2,
    knowledgeKeys: 1,
  })
  assert.equal(await readFile(fixture.journal, 'utf8'), before)
  await assert.rejects(stat(join(fixture.repositoryRoot, 'write.lock')), { code: 'ENOENT' })
})

test('rolls back by appending an audited commit while retaining the previous HEAD as backup', async (t) => {
  const fixture = await temporaryRepository(t)
  const first = await RepositoryWriter.commit(fixture.workspace, fixture.workspaceId, {
    message: '可回退版本一',
    set: [
      { key: 'source.app', value: 'version one' },
      { key: 'source.config', value: { mode: 'safe' } },
    ],
    author,
  })
  const second = await RepositoryWriter.commit(fixture.workspace, fixture.workspaceId, {
    message: '可回退版本二',
    set: [{ key: 'source.app', value: 'version two' }],
    delete: ['source.config'],
    author,
  })

  const rollback = await RepositoryWriter.rollback(fixture.workspace, fixture.workspaceId, {
    target: first.commit.id,
    message: '管理员回退到版本一',
    author,
  })
  assert.equal(rollback.committed, true)
  assert.equal(rollback.backupHead, second.commit.id)
  assert.equal(rollback.restoredFrom, first.commit.id)
  assert.equal(rollback.commit.kind, 'rollback')
  assert.equal(rollback.commit.parent, second.commit.id)
  assert.equal(rollback.commit.restores, first.commit.id)

  const reader = await RepositoryReader.open(fixture.workspace, fixture.workspaceId)
  assert.ok(reader)
  assert.deepEqual((await reader.checkout('HEAD')).records.map(record => [record.key, record.value]), [
    ['source.app', 'version one'],
    ['source.config', { mode: 'safe' }],
  ])
  const log = await reader.log()
  assert.deepEqual(log.map(commit => [commit.kind, commit.id, commit.restores ?? null]), [
    ['rollback', rollback.commit.id, first.commit.id],
    ['normal', second.commit.id, null],
    ['normal', first.commit.id, null],
  ])

  const rootRollback = await RepositoryWriter.rollback(fixture.workspace, fixture.workspaceId, {
    target: 'ROOT',
    message: '管理员回退到空仓库',
    author,
  })
  assert.equal(rootRollback.commit.kind, 'rollback')
  assert.equal(rootRollback.restoredFrom, null)
  assert.deepEqual((await reader.checkout('HEAD')).records, [])

  const beforeNoop = await readFile(fixture.journal, 'utf8')
  const noop = await RepositoryWriter.rollback(fixture.workspace, fixture.workspaceId, {
    target: 'HEAD',
    message: '当前版本无需回退',
    author,
  })
  assert.equal(noop.committed, false)
  assert.equal(await readFile(fixture.journal, 'utf8'), beforeNoop)
})

test('persists admin comments and audits delivery only to explicit mention targets', async (t) => {
  const fixture = await temporaryRepository(t)
  const comment = await RepositoryWriter.comment(fixture.workspace, fixture.workspaceId, {
    body: '请 @session-agent-a 核对回退结果。',
    mentions: ['session-agent-a', 'session-agent-b'],
  })
  assert.equal(comment.author, 'admin')
  assert.deepEqual(comment.deliveryRequestedTo, [])
  assert.deepEqual(comment.deliveredTo, [])

  await assert.rejects(
    RepositoryWriter.markCommentDelivered(
      fixture.workspace,
      fixture.workspaceId,
      comment.id,
      ['session-agent-b'],
    ),
    error => error instanceof RepositoryWriteError && error.code === 'INVALID_MUTATION',
  )

  const requested = await RepositoryWriter.markCommentDeliveryRequested(
    fixture.workspace,
    fixture.workspaceId,
    comment.id,
    ['session-agent-a'],
  )
  assert.deepEqual(requested.deliveryRequestedTo, ['session-agent-a'])

  const delivered = await RepositoryWriter.markCommentDelivered(
    fixture.workspace,
    fixture.workspaceId,
    comment.id,
    ['session-agent-a'],
  )
  assert.deepEqual(delivered.deliveryRequestedTo, ['session-agent-a'])
  assert.deepEqual(delivered.deliveredTo, ['session-agent-a'])

  const reader = await RepositoryReader.open(fixture.workspace, fixture.workspaceId)
  assert.ok(reader)
  assert.deepEqual(await reader.comments(), [delivered])
  assert.equal((await reader.status()).head, null)

  const beforeNoop = await readFile(fixture.journal, 'utf8')
  const same = await RepositoryWriter.markCommentDelivered(
    fixture.workspace,
    fixture.workspaceId,
    comment.id,
    ['session-agent-a'],
  )
  assert.deepEqual(same, delivered)
  assert.equal(await readFile(fixture.journal, 'utf8'), beforeNoop)

  await assert.rejects(
    RepositoryWriter.markCommentDeliveryRequested(
      fixture.workspace,
      fixture.workspaceId,
      comment.id,
      ['session-not-mentioned'],
    ),
    error => error instanceof RepositoryWriteError && error.code === 'INVALID_MUTATION',
  )

  await assert.rejects(
    RepositoryWriter.markCommentDelivered(
      fixture.workspace,
      fixture.workspaceId,
      comment.id,
      ['session-not-mentioned'],
    ),
    error => error instanceof RepositoryWriteError && error.code === 'INVALID_MUTATION',
  )

  const commit = await RepositoryWriter.commit(fixture.workspace, fixture.workspaceId, {
    message: '评论事件不改变提交父链',
    set: [{ key: 'project.comment-test', value: true }],
    author,
  })
  assert.equal(commit.commit.parent, null)
  assert.deepEqual(await reader.comments(), [delivered])
})

test('persists agent-authored issues and scoped discussion without changing HEAD', async (t) => {
  const fixture = await temporaryRepository(t)
  const actor = { kind: 'agent', sessionId: 'session-agent-a' }
  const issue = await RepositoryWriter.openIssue(fixture.workspace, fixture.workspaceId, {
    title: '协调 M3 验证',
    body: '请在此议题下记录多智能体核验结论。',
    labels: ['coordination', 'm3'],
    author: actor,
  })
  assert.match(issue.id, /^issue_/)
  assert.deepEqual(issue.openedBy, actor)
  assert.equal(issue.status, 'open')

  const comment = await RepositoryWriter.comment(fixture.workspace, fixture.workspaceId, {
    body: '已完成 writer 校验，请 @session-agent-b 复核 API。',
    mentions: ['session-agent-b'],
    author: actor,
    issueId: issue.id,
  })
  assert.deepEqual(comment.author, actor)
  assert.equal(comment.issueId, issue.id)

  const reader = await RepositoryReader.open(fixture.workspace, fixture.workspaceId)
  assert.ok(reader)
  assert.equal((await reader.status()).head, null)
  assert.deepEqual(await reader.getIssue(issue.id), issue)
  assert.deepEqual(await reader.comments(), [comment])

  const beforeInvalid = await readFile(fixture.journal, 'utf8')
  await assert.rejects(
    RepositoryWriter.comment(fixture.workspace, fixture.workspaceId, {
      body: '不能写入不存在的议题。',
      author: actor,
      issueId: 'issue_missing',
    }),
    error => error instanceof RepositoryWriteError && error.code === 'INVALID_MUTATION',
  )
  assert.equal(await readFile(fixture.journal, 'utf8'), beforeInvalid)
})

test('rejects ambiguous or oversized mutations before touching the journal', async (t) => {
  const fixture = await temporaryRepository(t)
  const before = await readFile(fixture.journal, 'utf8')
  await assert.rejects(
    RepositoryWriter.commit(fixture.workspace, fixture.workspaceId, {
      message: '同一 key 同时 set/delete',
      set: [{ key: 'project.stage', value: 'm1b' }],
      delete: ['project.stage'],
      author,
    }),
    error => error instanceof RepositoryWriteError && error.code === 'INVALID_MUTATION',
  )
  await assert.rejects(
    RepositoryWriter.commit(fixture.workspace, fixture.workspaceId, {
      message: '超出单值限制',
      set: [{ key: 'project.large', value: 'x'.repeat(70 * 1024) }],
      author,
    }),
    error => error instanceof RepositoryWriteError && error.code === 'REPO_TOO_LARGE',
  )
  assert.equal(await readFile(fixture.journal, 'utf8'), before)
  await assert.rejects(stat(join(fixture.repositoryRoot, 'write.lock')), { code: 'ENOENT' })
})

test('fails closed on an existing writer lock without removing it', async (t) => {
  const fixture = await temporaryRepository(t)
  const lock = join(fixture.repositoryRoot, 'write.lock')
  await writeFile(lock, 'preserve competing writer lock\n', 'utf8')
  const before = await readFile(fixture.journal, 'utf8')
  await assert.rejects(
    RepositoryWriter.commit(fixture.workspace, fixture.workspaceId, {
      message: '不应越过并发锁',
      set: [{ key: 'project.stage', value: 'blocked' }],
      author,
    }),
    error => error instanceof RepositoryWriteError && error.code === 'REPO_BUSY',
  )
  assert.equal(await readFile(fixture.journal, 'utf8'), before)
  assert.equal(await readFile(lock, 'utf8'), 'preserve competing writer lock\n')
})

test('refuses a corrupt repository and cleans up its own lock', async (t) => {
  const fixture = await temporaryRepository(t)
  const original = await readFile(fixture.journal, 'utf8')
  await writeFile(fixture.journal, original.replace('repo_', 'broken_'), 'utf8')
  await assert.rejects(
    RepositoryWriter.commit(fixture.workspace, fixture.workspaceId, {
      message: '不得修复损坏日志',
      set: [{ key: 'project.stage', value: 'unsafe' }],
      author,
    }),
  )
  await assert.rejects(stat(join(fixture.repositoryRoot, 'write.lock')), { code: 'ENOENT' })
})

test('honors cancellation before acquiring a writer lock', async (t) => {
  const fixture = await temporaryRepository(t)
  const before = await readFile(fixture.journal, 'utf8')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    RepositoryWriter.commit(fixture.workspace, fixture.workspaceId, {
      message: '取消的提交',
      set: [{ key: 'project.stage', value: 'canceled' }],
      author,
    }, controller.signal),
    error => error instanceof Error && error.name === 'AbortError',
  )
  assert.equal(await readFile(fixture.journal, 'utf8'), before)
  await assert.rejects(stat(join(fixture.repositoryRoot, 'write.lock')), { code: 'ENOENT' })
})

test('never truncates non-matching bytes appended by another same-inode writer during failed recovery', async (t) => {
  const fixture = await temporaryRepository(t)
  const before = await readFile(fixture.journal, 'utf8')
  const probe = await open(fixture.journal, 'r')
  const prototype = Object.getPrototypeOf(probe)
  await probe.close()
  const originalWriteFile = prototype.writeFile
  prototype.writeFile = async function injectedPartialWrite(data, options) {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
    if (text.includes('"type":"commit.created"')) {
      await originalWriteFile.call(this, text.slice(0, 64), options)
      await appendFile(fixture.journal, 'foreign-writer-bytes', 'utf8')
      throw new Error('simulated partial append failure')
    }
    return originalWriteFile.call(this, data, options)
  }
  try {
    await assert.rejects(
      RepositoryWriter.commit(fixture.workspace, fixture.workspaceId, {
        message: '故障注入提交',
        set: [{ key: 'project.partial', value: true }],
        author,
      }),
      error => error instanceof RepositoryWriteError && error.code === 'REPO_WRITE_IO',
    )
  } finally {
    prototype.writeFile = originalWriteFile
  }
  const after = await readFile(fixture.journal, 'utf8')
  assert.equal(after.startsWith(before), true)
  assert.match(after, /foreign-writer-bytes$/)
  assert(after.length > before.length, 'foreign suffix must remain untouched')
  await assert.rejects(stat(join(fixture.repositoryRoot, 'write.lock')), { code: 'ENOENT' })
})
