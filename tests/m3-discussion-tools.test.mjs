import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RepositoryInitializer } from '../lib/core/initializer.js'
import { RepositoryReader } from '../lib/core/repository.js'
import { installDiscussionTools } from '../lib/tools/discussion.js'

test('agent tools create issues and relay scoped comments only inside the resolved workspace', async (t) => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), 'local-git-4-llm-discussion-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))
  const workspace = {
    id: 'workspace-discussion-test',
    title: '智能体讨论测试',
    path: workspacePath,
    sessionIds: ['session-author', 'session-reviewer'],
  }
  await RepositoryInitializer.initialize(workspacePath, workspace.id)

  const relays = []
  const definitions = new Map()
  const ctx = {
    effect(factory) {
      factory()
    },
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    workspaceRegistry: {
      async resolveByPath(value) {
        return value === workspacePath ? workspace : undefined
      },
    },
    agents: {
      get(id) {
        if (String(id) !== 'session-reviewer') return undefined
        return {
          status: 'idle',
          async steer(message) {
            relays.push(message)
          },
        }
      },
    },
  }
  installDiscussionTools(ctx)
  assert.deepEqual([...definitions.keys()].sort(), [
    'repo_collaborators',
    'repo_comment',
    'repo_issue_comment',
    'repo_issue_open',
  ])

  const signal = new AbortController().signal
  const exec = {
    signal,
    agent: {
      id: 'session-author',
      session: { header: { cwd: workspacePath } },
    },
  }

  const collaborators = await definitions.get('repo_collaborators').execute({}, exec)
  assert.equal(collaborators.ok, true)
  assert.deepEqual(collaborators.data.collaborators, [
    { sessionId: 'session-author', status: 'offline' },
    { sessionId: 'session-reviewer', status: 'idle' },
  ])

  const opened = await definitions.get('repo_issue_open').execute({
    title: '复核实时评论链',
    body: '由一个智能体提出、另一个智能体在议题下回复。',
    labels: ['coordination'],
  }, exec)
  assert.equal(opened.ok, true)
  assert.deepEqual(opened.data.openedBy, { kind: 'agent', sessionId: 'session-author' })

  const commented = await definitions.get('repo_issue_comment').execute({
    issueId: opened.data.id,
    body: '请复核这个议题的投递和审计。',
    mentions: ['session-reviewer'],
  }, exec)
  assert.equal(commented.ok, true)
  assert.deepEqual(commented.data.delivered, ['session-reviewer'])
  assert.equal(relays.length, 1)
  const relay = JSON.parse(relays[0].content[0].text.split('\n').at(-1))
  assert.equal(relay.kind, 'local-git-4-llm.issue-comment')
  assert.equal(relay.issueId, opened.data.id)
  assert.deepEqual(relay.author, { kind: 'agent', sessionId: 'session-author' })

  const rejected = await definitions.get('repo_comment').execute({
    body: '不能跨工作区投递。',
    mentions: ['session-foreign'],
  }, exec)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'INVALID_MUTATION')

  const spoofedAuthor = await definitions.get('repo_comment').execute({ body: '不能借用工作区路径伪造作者。' }, {
    signal,
    agent: { id: 'session-foreign', session: { header: { cwd: workspacePath } } },
  })
  assert.equal(spoofedAuthor.ok, false)
  assert.equal(spoofedAuthor.error.code, 'CALLER_OUTSIDE_WORKSPACE')

  const reader = await RepositoryReader.open(workspacePath, workspace.id)
  assert.ok(reader)
  assert.equal((await reader.listIssues())[0].id, opened.data.id)
  const comments = await reader.comments()
  assert.equal(comments.length, 1)
  assert.equal(comments[0].issueId, opened.data.id)
  assert.deepEqual(comments[0].author, { kind: 'agent', sessionId: 'session-author' })
  assert.deepEqual(comments[0].deliveredTo, ['session-reviewer'])
})
