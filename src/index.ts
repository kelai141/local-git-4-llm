/**
 * Host entry for local-git-4-llm.
 *
 * M0 deliberately contributes only an owned lifecycle. The append-only
 * journal, tools, relay and workspace storage start in later milestones;
 * keeping this package side-effect free beyond lifecycle logging makes the
 * first injection safe to validate and trivial to unload.
 */
import type { Context } from 'cordis'
import { createLocalGitM0Status } from './core/manifest.js'
import { installM0Lifecycle } from './relay/lifecycle.js'

export const name = '@dsh-external/local-git-4-llm'

export function apply(ctx: Context): void {
  installM0Lifecycle(ctx, createLocalGitM0Status())
}
