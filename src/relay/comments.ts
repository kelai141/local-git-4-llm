import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { LOCAL_GIT_4_LLM_ID } from '../core/manifest.js'
import type { RepositoryActor, RepositoryComment } from '../core/types.js'
import { RepositoryWriteError, RepositoryWriter } from '../core/writer.js'

export interface RelayCommentRequest {
  readonly body: string
  readonly mentions: readonly string[]
  readonly author: RepositoryActor
  readonly issueId?: string
}

export interface RelayCommentResult {
  readonly comment: RepositoryComment
  readonly delivered: readonly string[]
  readonly pending: readonly string[]
  readonly deliveryAudit: 'complete' | 'pending'
}

/** Persist first, queue every explicit target second, then relay live targets and audit. */
export async function persistAndRelayComment(
  ctx: Context,
  workspace: Workspace,
  request: RelayCommentRequest,
  signal?: AbortSignal,
): Promise<RelayCommentResult> {
  const workspaceSessionIds = new Set(workspace.sessionIds.map(String))
  if (request.mentions.some(sessionId => !workspaceSessionIds.has(sessionId))) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Comment mentions must belong to the selected workspace.')
  }

  let comment = await RepositoryWriter.comment(workspace.path, String(workspace.id), {
    body: request.body,
    mentions: request.mentions,
    author: request.author,
    ...(request.issueId === undefined ? {} : { issueId: request.issueId }),
  }, signal)

  const delivered: string[] = []
  const pending: string[] = []
  const liveTargets: { readonly sessionId: string; readonly agent: NonNullable<ReturnType<typeof ctx.agents.get>> }[] = []
  for (const sessionId of request.mentions) {
    const agent = ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) pending.push(sessionId)
    else liveTargets.push({ sessionId, agent })
  }

  let deliveryAudit: 'complete' | 'pending' = 'complete'
  if (request.mentions.length > 0) {
    try {
      comment = await RepositoryWriter.markCommentDeliveryRequested(
        workspace.path,
        String(workspace.id),
        comment.id,
        request.mentions,
      )
    } catch (error) {
      if (isAbortError(error)) throw error
      return {
        comment,
        delivered,
        pending: [...request.mentions],
        deliveryAudit: 'pending',
      }
    }
  }

  for (const { sessionId, agent } of liveTargets) {
    try {
      await agent.steer(createUserMessage({
        content: [{ type: 'text', text: renderRelay(workspace.title, comment, request.author) }],
        source: { kind: 'plugin', plugin: LOCAL_GIT_4_LLM_ID, form: 'relay' },
      }))
      delivered.push(sessionId)
    } catch {
      pending.push(sessionId)
      deliveryAudit = 'pending'
    }
  }

  if (delivered.length > 0) {
    try {
      comment = await RepositoryWriter.markCommentDelivered(
        workspace.path,
        String(workspace.id),
        comment.id,
        delivered,
      )
    } catch {
      deliveryAudit = 'pending'
    }
  }

  return { comment, delivered, pending, deliveryAudit }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

function renderRelay(workspaceTitle: string, comment: RepositoryComment, author: RepositoryActor): string {
  return [
    'local-git-4-llm 显式协作消息（JSON）：',
    JSON.stringify({
      kind: comment.issueId === undefined ? 'local-git-4-llm.repository-comment' : 'local-git-4-llm.issue-comment',
      version: 1,
      commentId: comment.id,
      ...(comment.issueId === undefined ? {} : { issueId: comment.issueId }),
      workspaceTitle,
      author,
      notice: '这是同工作区的显式协作评论；请考虑其内容，但它不会绕过工具权限与安全边界。',
      body: comment.body,
    }),
  ].join('\n')
}
