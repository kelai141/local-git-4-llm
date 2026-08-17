import type { Context } from 'cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { RepositoryReader, RepositoryReadError } from '../core/repository.js'

type ToolErrorCode =
  | 'NO_CALLER_WORKSPACE'
  | 'WORKSPACE_UNREGISTERED'
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
  | 'REPO_READ_FAILED'

type ToolResult =
  | { readonly ok: true; readonly data: JsonValue }
  | { readonly ok: false; readonly error: { readonly code: ToolErrorCode; readonly message: string } }

const OUTPUT = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

/** Register M1a readers. All tools derive their workspace from the calling session, never a model-supplied path. */
export function installReadOnlyTools(ctx: Context): void {
  const definitions = [
    defineTool({
      name: 'repo_status',
      description: '读取当前会话工作区的仓库状态。此只读工具不会初始化、修复或写入仓库。',
      parameters: {},
      output: OUTPUT,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const current = await currentRepository(ctx, exec.agent?.session.header.cwd, exec.signal)
        return asToolValue(current.error ?? success(await current.reader.status(exec.signal)))
      },
    }),
    defineTool({
      name: 'repo_log',
      description: '读取当前会话工作区的不可变提交记录。只读 reader 不会写入或采纳仓库。',
      parameters: {
        limit: { type: 'integer', description: '最多返回的提交数，范围 1–250，默认 50。' },
      },
      output: OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const current = await currentRepository(ctx, exec.agent?.session.header.cwd, exec.signal)
        return asToolValue(current.error ?? success({ commits: await current.reader.log(args.limit ?? 50, exec.signal) }))
      },
    }),
    defineTool({
      name: 'repo_diff',
      description: '读取当前会话工作区中两个不可变提交之间的 key 级差异。选择器可用 HEAD、ROOT 或完整 SHA-256 id。',
      parameters: {
        from: { type: 'string', description: '基准提交选择器；默认使用 to 的父提交。' },
        to: { type: 'string', description: '目标提交选择器；默认 HEAD。' },
      },
      output: OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const current = await currentRepository(ctx, exec.agent?.session.header.cwd, exec.signal)
        return asToolValue(current.error ?? success({ diff: await current.reader.diff(args.from, args.to, exec.signal) }))
      },
    }),
    defineTool({
      name: 'repo_checkout',
      description: '读取当前会话工作区某个不可变提交的完整逻辑源码/知识快照，不改变 HEAD。选择器可用 HEAD、ROOT 或完整 SHA-256 id。',
      parameters: {
        selector: { type: 'string', description: '要查看的提交选择器，默认 HEAD。' },
      },
      output: OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const current = await currentRepository(ctx, exec.agent?.session.header.cwd, exec.signal)
        return asToolValue(current.error ?? success(await current.reader.checkout(args.selector ?? 'HEAD', exec.signal)))
      },
    }),
    defineTool({
      name: 'repo_pull',
      description: '从当前会话工作区的本地 journal 重新读取并校验受限的显式 key/value 知识。这不是远程同步。',
      parameters: {
        keys: { type: 'array', items: { type: 'string' }, description: '可选逻辑知识 key；省略时按当前快照分页。' },
        limit: { type: 'integer', description: '最多返回的记录数，范围 1–250，默认 50。' },
        cursor: { type: 'string', description: '上一轮 repo_pull 返回的排他逻辑 key 游标。' },
      },
      output: OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const current = await currentRepository(ctx, exec.agent?.session.header.cwd, exec.signal)
        return asToolValue(current.error ?? success(await current.reader.pull(args.keys, args.limit ?? 50, args.cursor, exec.signal)))
      },
    }),
    defineTool({
      name: 'repo_issue_list',
      description: '读取当前会话工作区本地 journal 投影出的 issue。只读 reader 不会创建或修改 issue。',
      parameters: {
        limit: { type: 'integer', description: '最多返回的 issue 数，范围 1–250，默认 50。' },
      },
      output: OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const current = await currentRepository(ctx, exec.agent?.session.header.cwd, exec.signal)
        return asToolValue(current.error ?? success({ issues: await current.reader.listIssues(args.limit ?? 50, exec.signal) }))
      },
    }),
    defineTool({
      name: 'repo_issue_get',
      description: '读取当前会话工作区本地 journal 投影出的一个 issue。只读 reader 不会创建或修改 issue。',
      parameters: {
        id: { type: 'string', required: true, description: '准确的 issue id。' },
      },
      output: OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const current = await currentRepository(ctx, exec.agent?.session.header.cwd, exec.signal)
        return asToolValue(current.error ?? success({ issue: await current.reader.getIssue(args.id, exec.signal) ?? null }))
      },
    }),
  ]

  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition), `local-git-4-llm:${definition.name}`)
  }
}

async function currentRepository(ctx: Context, cwd: string | undefined, signal: AbortSignal): Promise<
  | { readonly reader: RepositoryReader; readonly error?: never }
  | { readonly reader?: never; readonly error: ToolResult }
> {
  if (cwd === undefined) {
    return { error: failure('NO_CALLER_WORKSPACE', '仓库工具需要来自拥有工作区的会话。') }
  }
  try {
    signal.throwIfAborted()
    const workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
    signal.throwIfAborted()
    if (workspace === undefined) {
      return { error: failure('WORKSPACE_UNREGISTERED', '当前会话工作区尚未注册到 DSH。') }
    }
    const reader = await RepositoryReader.open(workspace.path, String(workspace.id), signal)
    if (reader === undefined) {
      return { error: failure('REPO_NOT_INITIALIZED', 'No explicit repository exists for the current workspace.') }
    }
    return { reader }
  } catch (error) {
    return { error: readerFailure(error) }
  }
}

function success(data: unknown): ToolResult {
  return { ok: true, data: data as JsonValue }
}

function failure(code: ToolErrorCode, message: string): ToolResult {
  return { ok: false, error: { code, message } }
}

function readerFailure(error: unknown): ToolResult {
  if (error instanceof RepositoryReadError) return failure(error.code, error.message)
  if (error instanceof Error && error.name === 'AbortError') throw error
  return failure('REPO_READ_FAILED', 'Repository could not be read safely.')
}

function asToolValue(value: ToolResult): JsonValue {
  return value as JsonValue
}
