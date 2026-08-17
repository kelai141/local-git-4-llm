/**
 * Host entry for dsh-repo-suite.
 *
 * M0 deliberately contributes only an owned lifecycle. The append-only
 * journal, tools, relay and workspace storage start in later milestones;
 * keeping this package side-effect free beyond lifecycle logging makes the
 * first injection safe to validate and trivial to unload.
 */
import type { Context } from 'cordis'
import { createM0Status } from './core/manifest.js'
import { installM0Lifecycle } from './relay/lifecycle.js'

export const name = '@dsh-external/dsh-repo-suite'

export function apply(ctx: Context): void {
  installM0Lifecycle(ctx, createM0Status())
}
