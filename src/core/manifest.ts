/** Shared, immutable M0 facts used by the host lifecycle and future UI RPC. */
export const LOCAL_GIT_4_LLM_ID = '@dsh-external/local-git-4-llm'
export const LOCAL_GIT_4_LLM_VERSION = '0.1.0'

export interface LocalGitM0Status {
  phase: 'M0'
  startedAt: string
  capabilities: readonly string[]
}

export function createLocalGitM0Status(): LocalGitM0Status {
  return {
    phase: 'M0',
    startedAt: new Date().toISOString(),
    capabilities: ['host-lifecycle', 'shell-overlay'],
  }
}
