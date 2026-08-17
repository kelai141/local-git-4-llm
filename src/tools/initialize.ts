import type { Context } from 'cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { RepositoryInitializationError, RepositoryInitializer } from '../core/initializer.js'
import { RepositoryReadError } from '../core/repository.js'

type ToolErrorCode =
  | 'NO_CALLER_WORKSPACE'
  | 'WORKSPACE_UNREGISTERED'
  | 'REPO_EXISTS_INVALID'
  | 'REPO_EXISTS_FOREIGN'
  | 'REPO_PATH_ESCAPE'
  | 'REPO_INIT_CONFLICT'
  | 'REPO_INIT_IO'
  | 'REPO_INIT_VERIFY_FAILED'
  | 'REPO_NOT_INITIALIZED'
  | 'REPO_FORMAT_UNSUPPORTED'
  | 'REPO_MANIFEST_INVALID'
  | 'REPO_READ_FAILED'

type ToolResult =
  | { readonly ok: true; readonly data: JsonValue }
  | { readonly ok: false; readonly error: { readonly code: ToolErrorCode; readonly message: string } }

const OUTPUT = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

/** Register the one explicit M1b write: initialize the calling workspace. */
export function installRepositoryInitTool(ctx: Context): void {
  const definition = defineTool({
    name: 'repo_init',
    description: '显式初始化当前会话已注册工作区中的 local-git-4-llm 仓库。不会接受路径、扫描工作区、覆盖既有仓库或提取会话内容。',
    parameters: {},
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) return asToolValue(failure('NO_CALLER_WORKSPACE', '初始化需要来自拥有工作区的会话。'))
      try {
        exec.signal.throwIfAborted()
        const workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
        exec.signal.throwIfAborted()
        if (workspace === undefined) {
          return asToolValue(failure('WORKSPACE_UNREGISTERED', '当前会话工作区尚未注册到 DSH。'))
        }
        const result = await RepositoryInitializer.initialize(workspace.path, String(workspace.id), exec.signal)
        return asToolValue(success(result))
      } catch (error) {
        return asToolValue(initializationFailure(error))
      }
    },
  })
  ctx.effect(() => ctx.tools.register(definition), 'local-git-4-llm:repo_init')
}

function success(data: unknown): ToolResult {
  return { ok: true, data: data as JsonValue }
}

function failure(code: ToolErrorCode, message: string): ToolResult {
  return { ok: false, error: { code, message } }
}

function initializationFailure(error: unknown): ToolResult {
  if (error instanceof RepositoryInitializationError) return failure(error.code, error.message)
  if (error instanceof RepositoryReadError) {
    const code = error.code === 'REPO_PATH_ESCAPE' || error.code === 'REPO_NOT_INITIALIZED'
      || error.code === 'REPO_FORMAT_UNSUPPORTED' || error.code === 'REPO_MANIFEST_INVALID'
      ? error.code
      : 'REPO_READ_FAILED'
    return failure(code, error.message)
  }
  if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError') throw error
  return failure('REPO_INIT_IO', '仓库初始化未能安全完成。')
}

function asToolValue(value: ToolResult): JsonValue {
  return value as JsonValue
}
