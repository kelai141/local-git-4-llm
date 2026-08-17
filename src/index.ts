/**
 * Host entry for local-git-4-llm.
 *
 * M1a adds a checksum-validated, read-only repository reader. It never
 * initializes a repository automatically, reads conversation content, or
 * delivers cross-session messages; all writes remain deferred to M1b.
 */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { createRuntimeStatus } from './core/manifest.js'
import { installLifecycle } from './relay/lifecycle.js'
import { installRepositoryInitTool } from './tools/initialize.js'
import { installReadOnlyTools } from './tools/read-only.js'

export const name = '@dsh-external/local-git-4-llm'
export const inject = ['tools', 'workspaceRegistry'] as const

export function apply(ctx: Context): void {
  installLifecycle(ctx, createRuntimeStatus())
  installRepositoryInitTool(ctx)
  installReadOnlyTools(ctx)
}
