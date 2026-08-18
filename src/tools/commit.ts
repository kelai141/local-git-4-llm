import type { Context } from 'cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { RepositoryReadError } from '../core/repository.js'
import { RepositoryWriteError, RepositoryWriter } from '../core/writer.js'
import { WorkspaceSelectionError, resolveRepositoryWorkspace } from '../core/workspace-selection.js'

type ToolErrorCode =
  | 'NO_CALLER_WORKSPACE'
  | 'WORKSPACE_UNREGISTERED'
  | 'SELECTED_WORKSPACE_UNAVAILABLE'
  | 'SELECTED_WORKSPACE_INVALID'
  | 'REPO_NOT_INITIALIZED'
  | 'REPO_PATH_ESCAPE'
  | 'REPO_FORMAT_UNSUPPORTED'
  | 'REPO_MANIFEST_INVALID'
  | 'JOURNAL_INVALID_UTF8'
  | 'JOURNAL_NON_CANONICAL'
  | 'JOURNAL_TRUNCATED_TAIL'
  | 'JOURNAL_SEQ_GAP'
  | 'JOURNAL_PREV_MISMATCH'
  | 'JOURNAL_CHECKSUM_MISMATCH'
  | 'JOURNAL_EVENT_UNSUPPORTED'
  | 'COMMIT_HASH_MISMATCH'
  | 'COMMIT_PARENT_MISMATCH'
  | 'TREE_HASH_MISMATCH'
  | 'REPO_TOO_LARGE'
  | 'QUERY_LIMIT_EXCEEDED'
  | 'INVALID_MUTATION'
  | 'REPO_BUSY'
  | 'REPO_WRITE_CONFLICT'
  | 'REPO_WRITE_IO'
  | 'REPO_WRITE_VERIFY_FAILED'
  | 'REPO_WRITE_FAILED'

type ToolResult =
  | { readonly ok: true; readonly data: JsonValue }
  | { readonly ok: false; readonly error: { readonly code: ToolErrorCode; readonly message: string } }

const OUTPUT = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

/** Register the explicit bounded key/value commit mutation. */
export function installRepositoryCommitTool(ctx: Context): void {
  const definition = defineTool({
    name: 'repo_commit',
    description: '向 /setrepo 激活仓库或当前会话仓库显式提交受限 key/value 变更。每次提交都写入完整不可变快照；不会扫描工作区或读取会话内容。',
    parameters: {
      message: { type: 'string', required: true, description: '提交说明，1–1000 个字符。' },
      set: {
        type: 'array',
        description: '要新增或替换的逻辑知识；value 必须是无损 JSON。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', required: true, description: '逻辑 key，格式 [a-z][a-z0-9_.-]{0,127}。' },
            value: { type: 'json', required: true, description: '显式提交的 JSON 值。' },
          },
        },
      },
      delete: {
        type: 'array',
        description: '要从新快照删除的逻辑 key。',
        items: { type: 'string' },
      },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        return asToolValue(failure('NO_CALLER_WORKSPACE', '提交需要来自拥有工作区的会话。'))
      }
      try {
        const { workspace } = await resolveRepositoryWorkspace(ctx, agent, exec.signal)
        const result = await RepositoryWriter.commit(workspace.path, String(workspace.id), {
          message: args.message,
          set: args.set,
          delete: args.delete,
          author: { sessionId: String(agent.id) },
        }, exec.signal)
        return asToolValue(success(result))
      } catch (error) {
        return asToolValue(writeFailure(error))
      }
    },
  })
  ctx.effect(() => ctx.tools.register(definition), 'local-git-4-llm:repo_commit')
}

function success(data: unknown): ToolResult {
  return { ok: true, data: data as JsonValue }
}

function failure(code: ToolErrorCode, message: string): ToolResult {
  return { ok: false, error: { code, message } }
}

function writeFailure(error: unknown): ToolResult {
  if (error instanceof WorkspaceSelectionError) return failure(error.code, error.message)
  if (error instanceof RepositoryWriteError || error instanceof RepositoryReadError) return failure(error.code, error.message)
  if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError') throw error
  return failure('REPO_WRITE_FAILED', '仓库提交未能安全完成。')
}

function asToolValue(value: ToolResult): JsonValue {
  return value as JsonValue
}
