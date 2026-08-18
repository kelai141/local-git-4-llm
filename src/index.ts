/**
 * Host entry for explicit repository writes, immutable history/rollback, the
 * same-origin management API, explicit administrator/agent relay delivery,
 * and human-enabled scheduled file snapshots. Installation alone never scans
 * source files, and conversation content is never extracted automatically.
 */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { installAdminApi } from './api/admin.js'
import { installSetRepoCommand } from './commands/setrepo.js'
import { createRuntimeStatus } from './core/manifest.js'
import { installFileBackupScheduler } from './relay/backups.js'
import { installLifecycle } from './relay/lifecycle.js'
import { installRepositoryCommitTool } from './tools/commit.js'
import { installDiscussionTools } from './tools/discussion.js'
import { installRepositoryInitTool } from './tools/initialize.js'
import { installReadOnlyTools } from './tools/read-only.js'
import { installRepositoryRollbackTool } from './tools/rollback.js'

export const name = '@dsh-external/local-git-4-llm'
export const inject = ['tools', 'workspaceRegistry', 'webServer', 'agents', 'commands', 'timer'] as const

export function apply(ctx: Context): void {
  installLifecycle(ctx, createRuntimeStatus())
  const backupScheduler = installFileBackupScheduler(ctx)
  installAdminApi(ctx, backupScheduler)
  installSetRepoCommand(ctx, backupScheduler)
  installRepositoryInitTool(ctx)
  installRepositoryCommitTool(ctx)
  installDiscussionTools(ctx)
  installRepositoryRollbackTool(ctx)
  installReadOnlyTools(ctx)
}
