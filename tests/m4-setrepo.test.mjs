import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { installSetRepoCommand } from '../lib/commands/setrepo.js'
import { FileBackupRepository } from '../lib/core/backup.js'
import { RepositoryInitializer } from '../lib/core/initializer.js'
import { currentRepositorySelection, resolveRepositoryWorkspace } from '../lib/core/workspace-selection.js'

test('/setrepo durably selects a registered repository and controls automatic file backup', async (t) => {
  const firstPath = await mkdtemp(join(tmpdir(), 'local-git-4-llm-setrepo-a-'))
  const secondPath = await mkdtemp(join(tmpdir(), 'local-git-4-llm-setrepo-b-'))
  t.after(() => Promise.all([
    rm(firstPath, { recursive: true, force: true }),
    rm(secondPath, { recursive: true, force: true }),
  ]))
  await mkdir(join(firstPath, 'src'))
  await mkdir(join(secondPath, 'src'))
  await writeFile(join(firstPath, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  await writeFile(join(secondPath, 'src', 'b.ts'), 'export const b = 2\n', 'utf8')
  const first = { id: 'workspace-setrepo-a', title: '仓库 A', path: firstPath, sessionIds: ['agent-setrepo'] }
  const second = { id: 'workspace-setrepo-b', title: '仓库 B', path: secondPath, sessionIds: [] }
  await RepositoryInitializer.initialize(first.path, first.id)
  await RepositoryInitializer.initialize(second.path, second.id)

  const events = []
  const agent = {
    id: 'agent-setrepo',
    session: {
      header: { cwd: first.path },
      events,
      append(type, data) {
        events.push({ type, data, seq: events.length + 1, ts: Date.now() })
      },
    },
  }
  const workspaces = [first, second]
  let definition
  const ctx = {
    effect(factory) { return factory() },
    commands: {
      register(value) {
        definition = value
        return () => {}
      },
    },
    workspaceRegistry: {
      list() { return workspaces },
      get(id) { return workspaces.find(workspace => workspace.id === String(id)) },
      async resolveByPath(path) {
        const canonical = await realpath(path)
        for (const workspace of workspaces) {
          if (await realpath(workspace.path) === canonical) return workspace
        }
        return undefined
      },
    },
  }
  const scheduler = {
    getRuntimeStatus() { return { running: false } },
    clearFailure() {},
    trackConfigured() {},
    untrackDisabled() {},
    async captureNow(workspace, reason, signal) {
      return FileBackupRepository.capture(workspace.path, String(workspace.id), reason, signal)
    },
  }
  installSetRepoCommand(ctx, scheduler)
  assert.equal(definition.name, 'setrepo')
  assert.equal(definition.recordInput, false)

  const selected = await definition.handler(invocation(agent, ' 2 ', 'command-select'))
  assert.equal(selected.kind, 'success')
  assert.match(selected.text, /仓库 B/u)
  assert.equal(currentRepositorySelection(agent), second.id)
  const active = await resolveRepositoryWorkspace(ctx, agent)
  assert.equal(active.workspace.id, second.id)
  assert.equal(active.source, 'setrepo')

  const enabled = await definition.handler(invocation(agent, ' backup on src --confirm --interval=5 ', 'command-enable'))
  assert.equal(enabled.kind, 'success')
  assert.match(enabled.text, /初始快照/u)
  const backup = await FileBackupRepository.status(second.path, second.id)
  assert.equal(backup.enabled, true)
  assert.equal(backup.snapshots, 1)
  assert.deepEqual(backup.config.scope, { kind: 'selected', roots: ['src'] })

  const disabled = await definition.handler(invocation(agent, ' backup off ', 'command-disable'))
  assert.equal(disabled.kind, 'success')
  assert.equal((await FileBackupRepository.status(second.path, second.id)).enabled, false)

  const originalCwd = agent.session.header.cwd
  delete agent.session.header.cwd
  const rejectedReset = await definition.handler(invocation(agent, ' reset ', 'command-reset-rejected'))
  assert.equal(rejectedReset.kind, 'error')
  assert.equal(currentRepositorySelection(agent), second.id)
  agent.session.header.cwd = originalCwd

  const reset = await definition.handler(invocation(agent, ' reset ', 'command-reset'))
  assert.equal(reset.kind, 'success')
  assert.equal(currentRepositorySelection(agent), null)
  assert.equal((await resolveRepositoryWorkspace(ctx, agent)).workspace.id, first.id)
})

function invocation(agent, rawInput, commandId) {
  return { agent, rawInput, commandId, signal: new AbortController().signal }
}
