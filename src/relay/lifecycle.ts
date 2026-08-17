import type { Context } from 'cordis'
import type { RuntimeStatus } from '../core/manifest.js'
import { LOCAL_GIT_4_LLM_ID } from '../core/manifest.js'

/**
 * Own the host effect so injector reload/unload always disposes it cleanly.
 * The current preview owns explicit writes, the management API, and live
 * administrator/agent relays. It still never auto-initializes, scans a workspace,
 * or extracts conversation content.
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
  }, 'local-git-4-llm:m3-preview-host-lifecycle')
}
