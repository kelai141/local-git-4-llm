/** Shared runtime facts used by the host lifecycle and management panel. */
export const LOCAL_GIT_4_LLM_ID = '@dsh-external/local-git-4-llm'
export const LOCAL_GIT_4_LLM_VERSION = '0.6.1'

export interface RuntimeStatus {
  phase: 'M4-backup-preview'
  startedAt: string
  capabilities: readonly string[]
}

export function createRuntimeStatus(): RuntimeStatus {
  return {
    phase: 'M4-backup-preview',
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
      'setrepo-and-panel-workspace-activation',
      'explicit-file-backup-opt-in',
      'content-addressed-file-snapshots',
      'semantic-no-op-snapshot-suppression',
      'snapshot-file-comparison-and-text-diff',
      'github-files-changed-review',
      'scheduled-enabled-only-file-backup',
      'cancellation-safe-backup-boundaries',
      'safe-export-only-restore',
      'no-source-scan-before-human-opt-in',
    ],
  }
}
