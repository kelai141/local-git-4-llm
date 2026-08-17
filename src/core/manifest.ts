/** Shared runtime facts used by the host lifecycle and management panel. */
export const LOCAL_GIT_4_LLM_ID = '@dsh-external/local-git-4-llm'
export const LOCAL_GIT_4_LLM_VERSION = '0.5.0'

export interface RuntimeStatus {
  phase: 'M3-preview'
  startedAt: string
  capabilities: readonly string[]
}

export function createRuntimeStatus(): RuntimeStatus {
  return {
    phase: 'M3-preview',
    startedAt: new Date().toISOString(),
    capabilities: [
      'host-lifecycle',
      'checksum-journal-reader',
      'registered-workspace-read-tools',
      'explicit-workspace-initialization',
      'explicit-key-value-commits',
      'immutable-history-checkout',
      'append-only-audited-rollback',
      'admin-comments-and-live-agent-relay',
      'agent-comments-and-issue-discussion',
      'durable-comment-delivery-outbox',
      'github-style-repository-board',
      'manual-registered-workspace-selection',
      'no-automatic-workspace-writes',
    ],
  }
}
