/**
 * Host entry for explicit repository writes, immutable history/rollback, the
 * same-origin management API, and explicit administrator/agent relay delivery. No feature
 * automatically scans a workspace or extracts conversation content.
 */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { installAdminApi } from './api/admin.js'
import { createRuntimeStatus } from './core/manifest.js'
import { installLifecycle } from './relay/lifecycle.js'
import { installRepositoryCommitTool } from './tools/commit.js'
import { installDiscussionTools } from './tools/discussion.js'
import { installRepositoryInitTool } from './tools/initialize.js'
import { installReadOnlyTools } from './tools/read-only.js'
import { installRepositoryRollbackTool } from './tools/rollback.js'

export const name = '@dsh-external/local-git-4-llm'
export const inject = ['tools', 'workspaceRegistry', 'webServer', 'agents'] as const

export function apply(ctx: Context): void {
  installLifecycle(ctx, createRuntimeStatus())
  installAdminApi(ctx)
  installRepositoryInitTool(ctx)
  installRepositoryCommitTool(ctx)
  installDiscussionTools(ctx)
  installRepositoryRollbackTool(ctx)
  installReadOnlyTools(ctx)
}
