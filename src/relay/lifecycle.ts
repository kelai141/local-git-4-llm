import type { Context } from 'cordis'
import type { LocalGitM0Status } from '../core/manifest.js'
import { LOCAL_GIT_4_LLM_ID } from '../core/manifest.js'

/**
 * Own the M0 host effect so injector reload/unload always disposes it cleanly.
 * No timers, file writes, tools, prompts, or cross-session delivery occur at
 * this milestone.
 */
export function installM0Lifecycle(ctx: Context, status: LocalGitM0Status): void {
  ctx.effect(() => {
    ctx.logger?.info?.(
      `[${LOCAL_GIT_4_LLM_ID}] ${status.phase} host ready ` +
      `(${status.capabilities.join(', ')})`,
    )

    return () => {
      ctx.logger?.info?.(`[${LOCAL_GIT_4_LLM_ID}] ${status.phase} host disposed`)
    }
  }, 'local-git-4-llm:m0-host-lifecycle')
}
