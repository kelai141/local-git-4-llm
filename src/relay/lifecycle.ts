import type { Context } from 'cordis'
import type { RuntimeStatus } from '../core/manifest.js'
import { LOCAL_GIT_4_LLM_ID } from '../core/manifest.js'

/**
 * Own the host effect so injector reload/unload always disposes it cleanly.
 * M1b-init adds one explicit initialization tool. It still never auto-
 * initializes repositories, reads conversations, or delivers cross-session
 * messages.
 */
export function installLifecycle(ctx: Context, status: RuntimeStatus): void {
  ctx.effect(() => {
    ctx.logger?.info?.(
      `[${LOCAL_GIT_4_LLM_ID}] ${status.phase} host ready ` +
      `(${status.capabilities.join(', ')})`,
    )

    return () => {
      ctx.logger?.info?.(`[${LOCAL_GIT_4_LLM_ID}] ${status.phase} host disposed`)
    }
  }, 'local-git-4-llm:m1b-init-host-lifecycle')
}
