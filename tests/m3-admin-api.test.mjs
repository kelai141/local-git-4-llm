import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { installAdminApi } from '../lib/api/admin.js'
import { FileBackupRepository } from '../lib/core/backup.js'
import { RepositoryReader } from '../lib/core/repository.js'
import { RepositoryWriter } from '../lib/core/writer.js'

test('management API resolves registered workspaces and drives board, rollback, and live mentions', async (t) => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), 'local-git-4-llm-admin-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))

  const workspace = {
    id: 'workspace-admin-test',
    title: 'API 隔离测试工作区',
    path: workspacePath,
    sessionIds: ['session-live', 'session-offline'],
  }
  await writeFile(path.join(workspacePath, 'README.md'), '# admin backup\n', 'utf8')
  await mkdir(path.join(workspacePath, 'src', 'nested'), { recursive: true })
  await writeFile(path.join(workspacePath, 'src', 'nested', 'data.txt'), 'nested backup\n', 'utf8')
  const relays = []
  const sessionEvents = []
  let createAuditLock = false
  const liveAgent = {
    status: 'idle',
    session: {
      events: sessionEvents,
      append(type, data) { sessionEvents.push({ type, data }) },
    },
    async steer(message) {
      relays.push(message)
      if (createAuditLock) {
        await writeFile(path.join(workspacePath, '.dsh-repo', 'write.lock'), 'simulated audit interruption\n', { flag: 'wx' })
      }
    },
  }
  let route
  const ctx = {
    effect(factory) {
      return factory()
    },
    webServer: {
      register(value) {
        route = value
        return () => {}
      },
    },
    workspaceRegistry: {
      get(id) {
        return String(id) === workspace.id ? workspace : undefined
      },
    },
    agents: {
      get(id) {
        return String(id) === 'session-live' ? liveAgent : undefined
      },
    },
  }

  const backupScheduler = {
    getRuntimeStatus() { return { running: false } },
    clearFailure() {},
    trackConfigured() {},
    untrackDisabled() {},
    async captureNow(target, reason, signal) {
      return FileBackupRepository.capture(target.path, String(target.id), reason, signal)
    },
  }
  installAdminApi(ctx, backupScheduler)
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/local-git-4-llm/api')

  const server = createServer(route.handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const address = server.address()
  assert(address && typeof address === 'object')
  const root = `http://127.0.0.1:${address.port}/local-git-4-llm/api`

  const capabilityResponse = await fetch(`${root}/capability`)
  assert.equal(capabilityResponse.status, 200)
  const capabilityBody = await capabilityResponse.json()
  assert.equal(capabilityBody.ok, true)
  assert.equal(typeof capabilityBody.capability, 'string')
  const headers = { 'x-local-git-4-llm-capability': capabilityBody.capability }

  const rejectedCrossSite = await fetch(`${root}/capability`, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(rejectedCrossSite.status, 403)
  assert.equal((await rejectedCrossSite.json()).error.code, 'CROSS_SITE_REQUEST')

  const rejectedSameSite = await fetch(`${root}/capability`, { headers: { 'sec-fetch-site': 'same-site' } })
  assert.equal(rejectedSameSite.status, 403)
  assert.equal((await rejectedSameSite.json()).error.code, 'CROSS_SITE_REQUEST')

  const rejectedOrigin = await fetch(`${root}/capability`, { headers: { origin: 'https://example.invalid' } })
  assert.equal(rejectedOrigin.status, 403)
  assert.equal((await rejectedOrigin.json()).error.code, 'CROSS_SITE_REQUEST')

  const missingCapability = await fetch(`${root}/state?workspaceId=${workspace.id}`)
  assert.equal(missingCapability.status, 403)
  assert.equal((await missingCapability.json()).error.code, 'CAPABILITY_REQUIRED')

  const initialState = await apiJson(`${root}/state?workspaceId=${workspace.id}&selector=HEAD`, { headers })
  assert.equal(initialState.initialized, false)
  assert.deepEqual(initialState.workspace, {
    id: workspace.id,
    title: workspace.title,
    sessionIds: workspace.sessionIds,
  })
  assert.deepEqual(initialState.liveAgents, [{ id: 'session-live', status: 'idle' }])
  assert.deepEqual(initialState.backup, {
    configured: false,
    enabled: false,
    integrity: 'ok',
    journalEntries: 0,
    snapshots: 0,
    runtime: { running: false },
  })
  assert.equal('path' in initialState.workspace, false)

  const activation = await apiJson(`${root}/activate`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id, sessionId: 'session-live' }),
  })
  assert.equal(activation.workspaceId, workspace.id)
  assert.deepEqual(sessionEvents.at(-1)?.data.workspaceId, workspace.id)

  await apiJson(`${root}/initialize`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id }),
  })

  const backupCandidates = await apiJson(`${root}/backup/candidates?workspaceId=${workspace.id}`, { headers })
  const readmeCandidate = backupCandidates.candidates.find(candidate => candidate.label === 'README.md')
  const srcCandidate = backupCandidates.candidates.find(candidate => candidate.label === 'src')
  assert(readmeCandidate)
  assert(srcCandidate)
  assert.match(readmeCandidate.id, /^root_[a-f0-9]{64}$/u)
  const srcChildren = await apiJson(`${root}/backup/candidates?workspaceId=${workspace.id}&parentId=${encodeURIComponent(srcCandidate.id)}`, { headers })
  const nestedCandidate = srcChildren.candidates.find(candidate => candidate.label === 'src/nested')
  assert(nestedCandidate)
  const nestedChildren = await apiJson(`${root}/backup/candidates?workspaceId=${workspace.id}&parentId=${encodeURIComponent(nestedCandidate.id)}`, { headers })
  assert.equal(nestedChildren.candidates[0].label, 'src/nested/data.txt')
  const rejectedPathBody = await fetch(`${root}/backup/enable`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId: workspace.id,
      scope: { kind: 'selected', roots: ['README.md'] },
      confirmSensitiveRisk: true,
    }),
  })
  assert.equal(rejectedPathBody.status, 400)
  assert.equal((await rejectedPathBody.json()).error.code, 'INVALID_REQUEST')
  const enabledBackup = await apiJson(`${root}/backup/enable`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId: workspace.id,
      rootIds: [nestedCandidate.id],
      intervalMinutes: 5,
      confirmSensitiveRisk: true,
    }),
  })
  assert.equal(enabledBackup.created, true)
  assert.equal(enabledBackup.snapshot.fileCount, 1)
  const configuredCandidates = await apiJson(`${root}/backup/candidates?workspaceId=${workspace.id}`, { headers })
  assert.equal(configuredCandidates.candidates.find(candidate => candidate.label === 'src/nested')?.selected, true)
  const backupHistory = await apiJson(`${root}/backup/history?workspaceId=${workspace.id}`, { headers })
  assert.equal(backupHistory.snapshots.length, 1)
  const backupSnapshot = await apiJson(`${root}/backup/snapshot?workspaceId=${workspace.id}&snapshot=LATEST&limit=100`, { headers })
  assert.deepEqual(backupSnapshot.records.map(record => record.path), ['src/nested/data.txt'])
  const backupPreview = await apiJson(`${root}/backup/preview?workspaceId=${workspace.id}&snapshot=LATEST&path=${encodeURIComponent('src/nested/data.txt')}`, { headers })
  assert.equal(backupPreview.encoding, 'utf8')
  assert.equal(backupPreview.content, 'nested backup\n')
  const backupExport = await apiJson(`${root}/backup/export`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id, snapshot: enabledBackup.snapshot.id }),
  })
  assert.match(backupExport.relativePath, /^\.dsh-repo\/backup\/exports\/export_/u)

  const first = await RepositoryWriter.commit(workspacePath, workspace.id, {
    message: '第一版',
    set: [{ key: 'source.answer', value: { value: 1 } }],
    delete: [],
    author: { sessionId: 'test' },
  })
  const second = await RepositoryWriter.commit(workspacePath, workspace.id, {
    message: '第二版',
    set: [{ key: 'source.answer', value: { value: 2 } }],
    delete: [],
    author: { sessionId: 'test' },
  })
  assert.notEqual(first.commit.id, second.commit.id)

  const historical = await apiJson(`${root}/state?workspaceId=${workspace.id}&selector=${encodeURIComponent(first.commit.id)}`, { headers })
  assert.equal(historical.initialized, true)
  assert.equal(historical.checkout.commit.id, first.commit.id)
  assert.deepEqual(historical.checkout.records, [{
    key: 'source.answer',
    value: { value: 1 },
    valueHash: historical.checkout.records[0].valueHash,
  }])
  assert.equal(historical.status.head, second.commit.id)

  const invalidMention = await fetch(`${root}/comment`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id, body: '不能越过工作区', mentions: ['session-foreign'] }),
  })
  assert.equal(invalidMention.status, 400)
  assert.equal((await invalidMention.json()).error.code, 'MENTION_OUTSIDE_WORKSPACE')

  const commentResult = await apiJson(`${root}/comment`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId: workspace.id,
      body: '请实时考虑这个管理员决策。',
      mentions: ['session-live', 'session-offline'],
    }),
  })
  assert.deepEqual(commentResult.delivered, ['session-live'])
  assert.deepEqual(commentResult.pending, ['session-offline'])
  assert.equal(commentResult.deliveryAudit, 'complete')
  assert.deepEqual(commentResult.comment.deliveryRequestedTo, ['session-live', 'session-offline'])
  assert.deepEqual(commentResult.comment.deliveredTo, ['session-live'])
  assert.equal(relays.length, 1)
  assert.equal(relays[0].source.kind, 'plugin')
  assert.equal(relays[0].source.plugin, '@dsh-external/local-git-4-llm')
  assert.equal(relays[0].source.form, 'relay')
  assert.match(relays[0].content[0].text, /请实时考虑这个管理员决策/)
  assert.doesNotMatch(relays[0].content[0].text, /<local-git-4-llm-admin-comment/)
  const repositoryRelay = JSON.parse(relays[0].content[0].text.split('\n').at(-1))
  assert.equal(repositoryRelay.kind, 'local-git-4-llm.repository-comment')
  assert.equal(repositoryRelay.author, 'admin')

  const issue = await RepositoryWriter.openIssue(workspacePath, workspace.id, {
    title: '多智能体 API 复核',
    body: '管理员与智能体应能在同一议题下交流。',
    labels: ['coordination'],
    author: { kind: 'agent', sessionId: 'session-live' },
  })
  const scopedComment = await apiJson(`${root}/comment`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId: workspace.id,
      issueId: issue.id,
      body: '请在这个 Issue 下继续复核。',
      mentions: ['session-live'],
    }),
  })
  assert.equal(scopedComment.comment.issueId, issue.id)
  assert.equal(scopedComment.comment.author, 'admin')
  const issueRelay = JSON.parse(relays[1].content[0].text.split('\n').at(-1))
  assert.equal(issueRelay.kind, 'local-git-4-llm.issue-comment')
  assert.equal(issueRelay.issueId, issue.id)

  createAuditLock = true
  const auditPending = await apiJson(`${root}/comment`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId: workspace.id,
      body: '这条 relay 成功后模拟审计追加中断。',
      mentions: ['session-live'],
    }),
  })
  createAuditLock = false
  assert.deepEqual(auditPending.delivered, ['session-live'])
  assert.equal(auditPending.deliveryAudit, 'pending')
  assert.deepEqual(auditPending.comment.deliveryRequestedTo, ['session-live'])
  assert.deepEqual(auditPending.comment.deliveredTo, [])
  await rm(path.join(workspacePath, '.dsh-repo', 'write.lock'), { force: true })

  const pendingState = await apiJson(`${root}/state?workspaceId=${workspace.id}&selector=HEAD`, { headers })
  assert.deepEqual(pendingState.comments[0].deliveryRequestedTo, ['session-live'])
  assert.deepEqual(pendingState.comments[0].deliveredTo, [])

  const rollback = await apiJson(`${root}/rollback`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id, target: first.commit.id, message: '面板回退测试' }),
  })
  assert.equal(rollback.commit.kind, 'rollback')
  assert.equal(rollback.commit.restores, first.commit.id)
  assert.equal(rollback.commit.parent, second.commit.id)

  const noopRollback = await fetch(`${root}/rollback`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id, target: 'HEAD' }),
  })
  assert.equal(noopRollback.status, 409)
  assert.equal((await noopRollback.json()).error.code, 'ROLLBACK_NOOP')

  const finalState = await apiJson(`${root}/state?workspaceId=${workspace.id}&selector=HEAD`, { headers })
  assert.equal(finalState.checkout.commit.id, rollback.commit.id)
  assert.deepEqual(finalState.checkout.records[0].value, { value: 1 })
  assert.equal(finalState.comments.length, 3)
  assert.deepEqual(finalState.comments.find(comment => comment.id === commentResult.comment.id)?.deliveredTo, ['session-live'])
  assert.equal(finalState.issues[0].id, issue.id)
  assert.deepEqual(finalState.issues[0].openedBy, { kind: 'agent', sessionId: 'session-live' })
  assert.equal(finalState.backup.enabled, true)
  assert.equal(finalState.backup.snapshots, 1)

  const reader = await RepositoryReader.open(workspacePath, workspace.id)
  assert(reader)
  const log = await reader.log(10)
  assert.equal(log[0].id, rollback.commit.id)
  assert(log.some(commit => commit.id === second.commit.id), 'the previous HEAD remains as an immutable backup')
})

async function apiJson(url, init) {
  const response = await fetch(url, init)
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.ok, true)
  return body.data
}
