/** Shared, immutable M1a facts used by the host lifecycle and future UI RPC. */
export const LOCAL_GIT_4_LLM_ID = '@dsh-external/local-git-4-llm'
export const LOCAL_GIT_4_LLM_VERSION = '0.2.0'

export interface RuntimeStatus {
  phase: 'M1a'
  startedAt: string
  capabilities: readonly string[]
}

export function createRuntimeStatus(): RuntimeStatus {
  return {
    phase: 'M1a',
    startedAt: new Date().toISOString(),
    capabilities: [
      'host-lifecycle',
      'checksum-journal-reader',
      'registered-workspace-read-tools',
      'no-automatic-workspace-writes',
    ],
  }
}
