/** Domain types for the M1a append-only knowledge repository reader. */

export const REPOSITORY_FORMAT = 'local-git-4-llm/repository' as const
export const REPOSITORY_FORMAT_VERSION = 1 as const
export const TREE_FORMAT = 'local-git-4-llm/tree' as const
export const COMMIT_FORMAT = 'local-git-4-llm/commit' as const

/** A lossless JSON value stored explicitly as a knowledge record's value. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export type Sha256Id = `sha256:${string}`

export interface RepositoryManifest {
  readonly format: typeof REPOSITORY_FORMAT
  readonly formatVersion: typeof REPOSITORY_FORMAT_VERSION
  readonly repoId: string
  readonly workspaceId: string
  readonly storage: 'workspace'
  readonly journal: { readonly file: 'journal.jsonl'; readonly hash: 'sha256' }
  readonly createdAt: string
}

export interface TreeEntry {
  readonly key: string
  readonly value: JsonValue
  readonly valueHash: Sha256Id
}

export interface TreeObject {
  readonly format: typeof TREE_FORMAT
  readonly formatVersion: typeof REPOSITORY_FORMAT_VERSION
  readonly id: Sha256Id
  readonly entries: readonly TreeEntry[]
}

export interface CommitObject {
  readonly format: typeof COMMIT_FORMAT
  readonly formatVersion: typeof REPOSITORY_FORMAT_VERSION
  readonly id: Sha256Id
  readonly parent: Sha256Id | null
  readonly tree: Sha256Id
  readonly message: string
  readonly author: { readonly sessionId: string; readonly messageId?: string }
  readonly kind: 'normal'
  readonly createdAt: string
}

/** Public M1a commit projection. Persistence-only author identifiers stay private. */
export interface CommitSummary {
  readonly id: Sha256Id
  readonly parent: Sha256Id | null
  readonly tree: Sha256Id
  readonly message: string
  readonly kind: 'normal'
  readonly createdAt: string
}

export type IssueStatus = 'open' | 'assigned' | 'in_progress' | 'resolved' | 'closed'

export interface IssueRecord {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly status: IssueStatus
  readonly labels: readonly string[]
  readonly assignee?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface RepositoryStatus {
  readonly formatVersion: typeof REPOSITORY_FORMAT_VERSION
  readonly repoId: string
  readonly workspaceId: string
  readonly head: Sha256Id | null
  readonly journalEntries: number
  readonly commits: number
  readonly knowledgeKeys: number
  readonly issues: number
  readonly integrity: 'ok'
}

export interface RepositoryDiff {
  readonly from: Sha256Id | null
  readonly to: Sha256Id | null
  readonly changes: readonly {
    readonly key: string
    readonly kind: 'added' | 'deleted' | 'changed'
    readonly beforeHash?: Sha256Id
    readonly afterHash?: Sha256Id
  }[]
}

export interface KnowledgeRecord {
  readonly key: string
  readonly value: JsonValue
  readonly valueHash: Sha256Id
}
