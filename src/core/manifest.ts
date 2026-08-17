/** Shared, immutable M0 facts used by the host lifecycle and future UI RPC. */
export const REPO_SUITE_ID = '@dsh-external/dsh-repo-suite'
export const REPO_SUITE_VERSION = '0.1.0'

export interface M0Status {
  phase: 'M0'
  startedAt: string
  capabilities: readonly string[]
}

export function createM0Status(): M0Status {
  return {
    phase: 'M0',
    startedAt: new Date().toISOString(),
    capabilities: ['host-lifecycle', 'shell-overlay'],
  }
}
