import type { Context } from 'cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { RepositoryReadError } from '../core/repository.js'
import { RepositoryWriteError, RepositoryWriter } from '../core/writer.js'
import { WorkspaceSelectionError, resolveRepositoryWorkspace } from '../core/workspace-selection.js'

type ToolResult =
  | { readonly ok: true; readonly data: JsonValue }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

const OUTPUT = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

/** Append an audited rollback commit; prior HEAD remains the immutable backup. */
export function installRepositoryRollbackTool(ctx: Context): void {
  const definition = defineTool({
    name: 'repo_rollback',
    description: '将 /setrepo 激活仓库或当前会话仓库回退到一个不可变提交快照。回退通过追加新 commit 完成，旧 HEAD 作为完整备份永久保留；不会截断历史。',
    parameters: {
      target: { type: 'string', required: true, description: '目标选择器：ROOT、HEAD 或完整 SHA-256 commit id。' },
      message: { type: 'string', description: '可选回退说明；默认根据目标生成。' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        return asToolValue(failure('NO_CALLER_WORKSPACE', '回退需要来自拥有工作区的会话。'))
      }
      try {
        const { workspace } = await resolveRepositoryWorkspace(ctx, agent, exec.signal)
        const result = await RepositoryWriter.rollback(workspace.path, String(workspace.id), {
          target: args.target,
          message: args.message ?? `回退到 ${args.target}`,
          author: { sessionId: String(agent.id) },
        }, exec.signal)
        return asToolValue(success(result))
      } catch (error) {
        return asToolValue(writeFailure(error))
      }
    },
  })
  ctx.effect(() => ctx.tools.register(definition), 'local-git-4-llm:repo_rollback')
}

function success(data: unknown): ToolResult {
  return { ok: true, data: data as JsonValue }
}

function failure(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message } }
}

function writeFailure(error: unknown): ToolResult {
  if (error instanceof WorkspaceSelectionError) return failure(error.code, error.message)
  if (error instanceof RepositoryWriteError || error instanceof RepositoryReadError) return failure(error.code, error.message)
  if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError') throw error
  return failure('REPO_WRITE_FAILED', '仓库回退未能安全完成。')
}

function asToolValue(value: ToolResult): JsonValue {
  return value as JsonValue
}
