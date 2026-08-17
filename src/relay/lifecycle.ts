import type { Context } from 'cordis'
import type { M0Status } from '../core/manifest.js'
import { REPO_SUITE_ID } from '../core/manifest.js'

/**
 * Own the M0 host effect so injector reload/unload always disposes it cleanly.
 * No timers, file writes, tools, prompts, or cross-session delivery occur at
 * this milestone.
 */
export function installM0Lifecycle(ctx: Context, status: M0Status): void {
  ctx.effect(() => {
    ctx.logger?.info?.(
      `[${REPO_SUITE_ID}] ${status.phase} host ready ` +
      `(${status.capabilities.join(', ')})`,
    )

    return () => {
      ctx.logger?.info?.(`[${REPO_SUITE_ID}] ${status.phase} host disposed`)
    }
  }, 'dsh-repo-suite:m0-host-lifecycle')
}
