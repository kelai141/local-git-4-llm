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
      description: 'Read the current session workspace repository status. This M1a tool never initializes, repairs, or writes a repository.',
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
      description: 'Read immutable commits for the current session workspace. The M1a reader never writes or adopts a repository.',
      parameters: {
        limit: { type: 'integer', description: 'Maximum commits to return, from 1 through 250. Defaults to 50.' },
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
      description: 'Read a key-level diff between immutable commits in the current session workspace. Selectors are HEAD, ROOT, or a full SHA-256 id.',
      parameters: {
        from: { type: 'string', description: 'Base commit selector. Defaults to the parent of to.' },
        to: { type: 'string', description: 'Target commit selector. Defaults to HEAD.' },
      },
      output: OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const current = await currentRepository(ctx, exec.agent?.session.header.cwd, exec.signal)
        return asToolValue(current.error ?? success({ diff: await current.reader.diff(args.from, args.to, exec.signal) }))
      },
    }),
    defineTool({
      name: 'repo_pull',
      description: 'Re-read and validate bounded explicit key/value knowledge from the local journal of the current session workspace. This is not remote synchronization.',
      parameters: {
        keys: { type: 'array', items: { type: 'string' }, description: 'Optional logical knowledge keys. Omit to page through the current snapshot.' },
        limit: { type: 'integer', description: 'Maximum records to return, from 1 through 250. Defaults to 50.' },
        cursor: { type: 'string', description: 'Exclusive logical-key cursor returned by an earlier repo_pull call.' },
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
      description: 'Read issue projections from the local journal of the current session workspace. M1a never creates or modifies issues.',
      parameters: {
        limit: { type: 'integer', description: 'Maximum issues to return, from 1 through 250. Defaults to 50.' },
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
      description: 'Read one issue projection from the local journal of the current session workspace. M1a never creates or modifies issues.',
      parameters: {
        id: { type: 'string', required: true, description: 'Exact issue id.' },
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
    return { error: failure('NO_CALLER_WORKSPACE', 'This repository tool requires a calling session workspace.') }
  }
  try {
    signal.throwIfAborted()
    const workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
    signal.throwIfAborted()
    if (workspace === undefined) {
      return { error: failure('WORKSPACE_UNREGISTERED', 'The calling session workspace is not registered in DSH.') }
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
