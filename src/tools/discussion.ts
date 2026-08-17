import type { Context } from 'cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { RepositoryReadError } from '../core/repository.js'
import { RepositoryWriteError, RepositoryWriter } from '../core/writer.js'
import { persistAndRelayComment } from '../relay/comments.js'

type DiscussionToolErrorCode =
  | 'NO_CALLER_WORKSPACE'
  | 'WORKSPACE_UNREGISTERED'
  | 'CALLER_OUTSIDE_WORKSPACE'
  | 'REPO_NOT_INITIALIZED'
  | 'INVALID_MUTATION'
  | 'REPO_BUSY'
  | 'REPO_PATH_ESCAPE'
  | 'REPO_WRITE_CONFLICT'
  | 'REPO_WRITE_IO'
  | 'REPO_WRITE_VERIFY_FAILED'
  | 'REPO_TOO_LARGE'
  | 'DISCUSSION_FAILED'

type ToolResult =
  | { readonly ok: true; readonly data: JsonValue }
  | { readonly ok: false; readonly error: { readonly code: DiscussionToolErrorCode; readonly message: string } }

interface CallerAgent {
  readonly id: unknown
  readonly session: { readonly header: { readonly cwd?: string } }
}

const OUTPUT = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

/** Explicit agent-to-agent repository and issue discussion tools. */
export function installDiscussionTools(ctx: Context): void {
  const collaborators = defineTool({
    name: 'repo_collaborators',
    description: '列出当前注册工作区中可显式 @ 的智能体会话及其实时在线状态；不会广播、同步或发送消息。',
    parameters: {},
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const resolved = await resolveCallerWorkspace(ctx, exec.agent, exec.signal)
      if ('error' in resolved) return asToolValue(resolved.error)
      return asToolValue(success({
        workspaceId: String(resolved.workspace.id),
        collaborators: resolved.workspace.sessionIds.map((id) => {
          const sessionId = String(id)
          const live = ctx.agents.get(id)
          return { sessionId, status: live?.status ?? 'offline' }
        }),
      }))
    },
  })

  const repositoryComment = defineTool({
    name: 'repo_comment',
    description: '向当前 local-git-4-llm 仓库显式发表评论。可 @ 同工作区智能体；评论先写入校验和日志与投递队列，再实时注入在线目标。不会自动提取会话。',
    parameters: {
      body: { type: 'string', required: true, description: '评论正文，1–16000 个字符。' },
      mentions: { type: 'array', description: '显式 @ 的同工作区 session id。', items: { type: 'string' } },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return executeComment(ctx, exec.agent, exec.signal, args.body, args.mentions ?? [], undefined)
    },
  })

  const issueOpen = defineTool({
    name: 'repo_issue_open',
    description: '在当前 local-git-4-llm 仓库显式创建一个 Issue，记录提出它的智能体。创建后可用 repo_issue_comment 与其他智能体继续讨论。',
    parameters: {
      title: { type: 'string', required: true, description: 'Issue 标题，1–1000 个字符。' },
      body: { type: 'string', description: 'Issue 正文，最多 16000 个字符。' },
      labels: { type: 'array', description: '最多 20 个标签。', items: { type: 'string' } },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const resolved = await resolveCallerWorkspace(ctx, exec.agent, exec.signal)
      if ('error' in resolved) return asToolValue(resolved.error)
      try {
        const issue = await RepositoryWriter.openIssue(resolved.workspace.path, String(resolved.workspace.id), {
          title: args.title,
          body: args.body,
          labels: args.labels,
          author: { kind: 'agent', sessionId: String(resolved.agent.id) },
        }, exec.signal)
        return asToolValue(success(issue))
      } catch (error) {
        return asToolValue(discussionFailure(error))
      }
    },
  })

  const issueComment = defineTool({
    name: 'repo_issue_comment',
    description: '在当前仓库指定 Issue 下显式发表评论，并可 @ 同工作区智能体实时协作；作者、议题范围、投递请求和成功审计都会持久化。',
    parameters: {
      issueId: { type: 'string', required: true, description: '已有 Issue id。' },
      body: { type: 'string', required: true, description: '评论正文，1–16000 个字符。' },
      mentions: { type: 'array', description: '显式 @ 的同工作区 session id。', items: { type: 'string' } },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return executeComment(ctx, exec.agent, exec.signal, args.body, args.mentions ?? [], args.issueId)
    },
  })

  ctx.effect(() => ctx.tools.register(collaborators), 'local-git-4-llm:repo_collaborators')
  ctx.effect(() => ctx.tools.register(repositoryComment), 'local-git-4-llm:repo_comment')
  ctx.effect(() => ctx.tools.register(issueOpen), 'local-git-4-llm:repo_issue_open')
  ctx.effect(() => ctx.tools.register(issueComment), 'local-git-4-llm:repo_issue_comment')
}

async function executeComment(
  ctx: Context,
  agent: CallerAgent | undefined,
  signal: AbortSignal,
  body: string,
  mentions: readonly string[],
  issueId: string | undefined,
): Promise<JsonValue> {
  const resolved = await resolveCallerWorkspace(ctx, agent, signal)
  if ('error' in resolved) return asToolValue(resolved.error)
  try {
    const result = await persistAndRelayComment(ctx, resolved.workspace, {
      body,
      mentions,
      author: { kind: 'agent', sessionId: String(resolved.agent.id) },
      ...(issueId === undefined ? {} : { issueId }),
    }, signal)
    return asToolValue(success(result))
  } catch (error) {
    return asToolValue(discussionFailure(error))
  }
}

async function resolveCallerWorkspace(
  ctx: Context,
  agent: CallerAgent | undefined,
  signal: AbortSignal,
): Promise<
  | { readonly agent: CallerAgent; readonly workspace: NonNullable<Awaited<ReturnType<typeof ctx.workspaceRegistry.resolveByPath>>> }
  | { readonly error: ToolResult }
> {
  const cwd = agent?.session.header.cwd
  if (agent === undefined || cwd === undefined) return { error: failure('NO_CALLER_WORKSPACE', '讨论工具需要来自拥有工作区的会话。') }
  try {
    signal.throwIfAborted()
    const workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
    signal.throwIfAborted()
    if (workspace === undefined) return { error: failure('WORKSPACE_UNREGISTERED', '当前会话工作区尚未注册到 DSH。') }
    if (!workspace.sessionIds.some(sessionId => String(sessionId) === String(agent.id))) {
      return { error: failure('CALLER_OUTSIDE_WORKSPACE', '当前智能体会话不属于解析出的工作区，拒绝记录或发送讨论。') }
    }
    return { agent, workspace }
  } catch (error) {
    if (isAbortError(error)) throw error
    return { error: failure('DISCUSSION_FAILED', '无法安全解析当前会话工作区。') }
  }
}

function success(data: unknown): ToolResult {
  return { ok: true, data: data as JsonValue }
}

function failure(code: DiscussionToolErrorCode, message: string): ToolResult {
  return { ok: false, error: { code, message } }
}

function discussionFailure(error: unknown): ToolResult {
  if (error instanceof RepositoryWriteError || error instanceof RepositoryReadError) {
    return failure(error.code as DiscussionToolErrorCode, error.message)
  }
  if (isAbortError(error)) throw error
  return failure('DISCUSSION_FAILED', '仓库讨论操作未能安全完成。')
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

function asToolValue(value: ToolResult): JsonValue {
  return value as JsonValue
}
