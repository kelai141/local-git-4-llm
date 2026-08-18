import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'

export const REPOSITORY_SELECTION_EVENT = 'local-git-4-llm/repository-selected' as const

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    [REPOSITORY_SELECTION_EVENT]: {
      readonly formatVersion: 1
      readonly workspaceId: string | null
      readonly commandId: string
    }
  }
}

export type WorkspaceSelectionErrorCode =
  | 'NO_CALLER_WORKSPACE'
  | 'WORKSPACE_UNREGISTERED'
  | 'SELECTED_WORKSPACE_UNAVAILABLE'
  | 'SELECTED_WORKSPACE_INVALID'

export class WorkspaceSelectionError extends Error {
  constructor(readonly code: WorkspaceSelectionErrorCode, message: string) {
    super(message)
    this.name = 'WorkspaceSelectionError'
  }
}

export interface ResolvedRepositoryWorkspace {
  readonly workspace: Workspace
  readonly source: 'session-cwd' | 'setrepo'
}

/** Persist one human slash-command selection in the receiving session log. */
export function recordRepositorySelection(agent: Agent, workspaceId: string | null, commandId: string): void {
  agent.session.append(REPOSITORY_SELECTION_EVENT, {
    formatVersion: 1,
    workspaceId,
    commandId,
  })
}

/** Return the last durable /setrepo selection; undefined means no selection event. */
export function currentRepositorySelection(agent: Agent): string | null | undefined {
  const events = agent.session.events
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== REPOSITORY_SELECTION_EVENT) continue
    return parseSelectionEvent(event)
  }
  return undefined
}

/**
 * Resolve every model-side repository operation through one shared policy.
 * A human /setrepo event may authorize a registered workspace; otherwise the
 * caller cwd is resolved only through workspaceRegistry.resolveByPath().
 */
export async function resolveRepositoryWorkspace(
  ctx: Context,
  agent: Agent | undefined,
  signal?: AbortSignal,
): Promise<ResolvedRepositoryWorkspace> {
  if (agent === undefined) {
    throw new WorkspaceSelectionError('NO_CALLER_WORKSPACE', '仓库操作需要来自拥有工作区的智能体会话。')
  }
  signal?.throwIfAborted()
  const selected = currentRepositorySelection(agent)
  if (selected !== undefined && selected !== null) {
    const workspace = ctx.workspaceRegistry.get(WorkspaceId(selected))
    if (workspace === undefined) {
      throw new WorkspaceSelectionError('SELECTED_WORKSPACE_UNAVAILABLE', '通过 /setrepo 激活的仓库已取消注册，请重新选择。')
    }
    const resolved = await ctx.workspaceRegistry.resolveByPath(workspace.path)
    signal?.throwIfAborted()
    if (resolved === undefined || String(resolved.id) !== selected) {
      throw new WorkspaceSelectionError('SELECTED_WORKSPACE_INVALID', '通过 /setrepo 激活的仓库路径不再匹配注册身份。')
    }
    return { workspace: resolved, source: 'setrepo' }
  }

  const cwd = agent.session.header.cwd
  if (cwd === undefined) {
    throw new WorkspaceSelectionError('NO_CALLER_WORKSPACE', '当前会话没有可解析的工作区；请先进入工作区或使用 /setrepo。')
  }
  const workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
  signal?.throwIfAborted()
  if (workspace === undefined) {
    throw new WorkspaceSelectionError('WORKSPACE_UNREGISTERED', '当前会话工作区尚未注册到 DSH。')
  }
  return { workspace, source: 'session-cwd' }
}

function parseSelectionEvent(event: SessionEvent): string | null {
  const data = event.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new WorkspaceSelectionError('SELECTED_WORKSPACE_INVALID', '持久化的 /setrepo 选择事件无效。')
  }
  const record = data as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== 3 || keys[0] !== 'commandId' || keys[1] !== 'formatVersion' || keys[2] !== 'workspaceId'
    || record.formatVersion !== 1
    || typeof record.commandId !== 'string' || record.commandId.length < 1 || record.commandId.length > 256
    || (record.workspaceId !== null && (typeof record.workspaceId !== 'string'
      || record.workspaceId.length < 1 || record.workspaceId.length > 128))) {
    throw new WorkspaceSelectionError('SELECTED_WORKSPACE_INVALID', '持久化的 /setrepo 选择事件无效。')
  }
  return record.workspaceId as string | null
}
