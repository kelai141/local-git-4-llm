import { constants, type Stats } from 'node:fs'
import { lstat, open as openFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { assertNotAborted, canonicalJson, cloneJson, sha256 } from './canonical.js'
import {
  COMMIT_FORMAT,
  REPOSITORY_FORMAT,
  REPOSITORY_FORMAT_VERSION,
  TREE_FORMAT,
  type CommitObject,
  type CommitSummary,
  type IssueRecord,
  type IssueStatus,
  type JsonValue,
  type KnowledgeRecord,
  type RepositoryComment,
  type RepositoryActor,
  type RepositoryDiff,
  type RepositoryManifest,
  type RepositoryStatus,
  type Sha256Id,
  type TreeEntry,
  type TreeObject,
} from './types.js'

const REPOSITORY_DIR = '.dsh-repo'
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024
const MAX_JOURNAL_LINES = 10_000
const MAX_TREE_ENTRIES = 1_000
const MAX_VALUE_BYTES = 64 * 1024
const MAX_QUERY_RECORD_BYTES = 128 * 1024
const SHA256_ID = /^sha256:[a-f0-9]{64}$/
const KNOWLEDGE_KEY = /^[a-z][a-z0-9_.-]{0,127}$/
const ISSUE_ID = /^[A-Za-z0-9._-]{1,120}$/

export type RepositoryErrorCode =
  | 'REPO_PATH_ESCAPE'
  | 'REPO_NOT_INITIALIZED'
  | 'REPO_FORMAT_UNSUPPORTED'
  | 'REPO_MANIFEST_INVALID'
  | 'JOURNAL_INVALID_UTF8'
  | 'JOURNAL_NON_CANONICAL'
  | 'JOURNAL_TRUNCATED_TAIL'
  | 'JOURNAL_SEQ_GAP'
  | 'JOURNAL_PREV_MISMATCH'
  | 'JOURNAL_CHECKSUM_MISMATCH'
  | 'JOURNAL_EVENT_UNSUPPORTED'
  | 'COMMIT_HASH_MISMATCH'
  | 'COMMIT_PARENT_MISMATCH'
  | 'TREE_HASH_MISMATCH'
  | 'REPO_TOO_LARGE'
  | 'QUERY_LIMIT_EXCEEDED'

/** Sanitized reader failure. Callers return only code/message, never a stack or host path. */
export class RepositoryReadError extends Error {
  constructor(readonly code: RepositoryErrorCode, message: string) {
    super(message)
    this.name = 'RepositoryReadError'
  }
}

interface JournalRecord {
  readonly formatVersion: typeof REPOSITORY_FORMAT_VERSION
  readonly seq: number
  readonly type: string
  readonly ts: string
  readonly prev: Sha256Id | null
  readonly payload: JsonValue
  readonly checksum: Sha256Id
}

interface Snapshot {
  readonly journalEntries: number
  readonly tailChecksum: Sha256Id
  readonly head: Sha256Id | null
  readonly commits: ReadonlyMap<Sha256Id, CommitObject>
  readonly trees: ReadonlyMap<Sha256Id, TreeObject>
  readonly values: ReadonlyMap<string, JsonValue>
  readonly issues: ReadonlyMap<string, IssueRecord>
  readonly comments: ReadonlyMap<string, RepositoryComment>
}

export interface RepositoryFileObservation {
  readonly dev: number
  readonly ino: number
  readonly size: number
}

export interface RepositoryDirectoryObservation {
  readonly dev: number
  readonly ino: number
}

/**
 * Minimal verified state exposed to the M1b writer. It deliberately omits
 * persistence-only commit authors and filesystem paths.
 */
export interface RepositoryMutationState {
  readonly journalEntries: number
  readonly tailChecksum: Sha256Id
  readonly head: Sha256Id | null
  readonly values: readonly KnowledgeRecord[]
  readonly issues: readonly IssueRecord[]
  readonly comments: readonly RepositoryComment[]
  readonly journal: RepositoryFileObservation
}

export interface RepositoryCheckout {
  readonly selector: 'ROOT' | Sha256Id
  readonly commit: CommitSummary | null
  readonly records: readonly KnowledgeRecord[]
}

export interface RepositoryBoardSnapshot {
  readonly status: RepositoryStatus
  readonly log: readonly CommitSummary[]
  readonly checkout: RepositoryCheckout
  readonly issues: readonly IssueRecord[]
  readonly comments: readonly RepositoryComment[]
}

interface StrictTextRead {
  readonly source: string
  readonly observation: RepositoryFileObservation
}

/**
 * M1a read-only reader. It recognizes only an explicitly initialized
 * `.dsh-repo/manifest.json` and `journal.jsonl` under one registered workspace.
 * It never creates, locks, repairs, scans, or mutates filesystem state.
 */
export class RepositoryReader {
  private constructor(
    private readonly repositoryRoot: string,
    private readonly repositoryIdentity: RepositoryDirectoryObservation,
    readonly manifest: RepositoryManifest,
  ) {}

  static async open(workspacePath: string, expectedWorkspaceId: string, signal?: AbortSignal): Promise<RepositoryReader | undefined> {
    const workspaceRoot = await canonicalWorkspaceRoot(workspacePath, signal)
    const repositoryPath = inside(workspaceRoot, REPOSITORY_DIR)
    const repository = await lstatIfExists(repositoryPath)
    if (repository === undefined) return undefined
    if (repository.isSymbolicLink() || !repository.isDirectory()) {
      throw new RepositoryReadError('REPO_PATH_ESCAPE', 'Repository directory is not a real directory inside this workspace.')
    }
    const repositoryRoot = await canonicalRepositoryRoot(repositoryPath, workspaceRoot, signal)
    const repositoryIdentity = await observeRepositoryDirectory(repositoryRoot, signal)

    const manifestPath = inside(repositoryRoot, 'manifest.json')
    const manifestSource = (await readStrictFile(manifestPath, repositoryRoot, 'manifest.json', 64 * 1024, signal)).source
    const manifest = parseManifest(manifestSource, expectedWorkspaceId)
    await assertRepositoryDirectory(repositoryRoot, repositoryIdentity, signal)
    return new RepositoryReader(repositoryRoot, repositoryIdentity, manifest)
  }

  /** @internal Verified journal path for the repository writer only. */
  journalPathForMutation(): string {
    return inside(this.repositoryRoot, 'journal.jsonl')
  }

  /** @internal Verified lock path for the repository writer only. */
  lockPathForMutation(): string {
    return inside(this.repositoryRoot, 'write.lock')
  }

  /** @internal Reject a same-path repository directory replacement. */
  async assertMutationRoot(signal?: AbortSignal): Promise<void> {
    await assertRepositoryDirectory(this.repositoryRoot, this.repositoryIdentity, signal)
  }

  /** @internal Stable identity used to bind a lock to one repository object. */
  repositoryIdentityForMutation(): RepositoryDirectoryObservation {
    return { ...this.repositoryIdentity }
  }

  /**
   * Replay one exact journal observation for a writer that already owns the
   * repository lock. The returned value graph is detached from reader state.
   */
  async mutationState(signal?: AbortSignal): Promise<RepositoryMutationState> {
    const { snapshot, journal } = await this.snapshotRead(signal)
    return {
      journalEntries: snapshot.journalEntries,
      tailChecksum: snapshot.tailChecksum,
      head: snapshot.head,
      values: [...snapshot.values.entries()].map(([key, value]) => ({
        key,
        value: cloneJson(value),
        valueHash: hashId(value),
      })),
      issues: [...snapshot.issues.values()].map(cloneIssue),
      comments: [...snapshot.comments.values()].map(cloneComment),
      journal,
    }
  }

  async status(signal?: AbortSignal): Promise<RepositoryStatus> {
    const snapshot = await this.snapshot(signal)
    return this.statusFromSnapshot(snapshot)
  }

  async log(limit = 50, signal?: AbortSignal): Promise<readonly CommitSummary[]> {
    const snapshot = await this.snapshot(signal)
    return [...snapshot.commits.values()]
      .reverse()
      .slice(0, normalizeLimit(limit))
      .map(toCommitSummary)
  }

  /** Read one immutable tree snapshot without changing HEAD. */
  async checkout(selector = 'HEAD', signal?: AbortSignal): Promise<RepositoryCheckout> {
    const snapshot = await this.snapshot(signal)
    const commit = selectCommit(snapshot, selector)
    if (commit === null) return { selector: 'ROOT', commit: null, records: [] }
    const tree = requireTree(snapshot, commit.tree)
    return {
      selector: commit.id,
      commit: toCommitSummary(commit),
      records: tree.entries.map(({ key, value, valueHash }) => ({ key, value: cloneJson(value), valueHash })),
    }
  }

  /** Newest-first explicit administrator/agent discussion entries. */
  async comments(limit = 100, signal?: AbortSignal): Promise<readonly RepositoryComment[]> {
    const snapshot = await this.snapshot(signal)
    return [...snapshot.comments.values()]
      .reverse()
      .slice(0, normalizeLimit(limit))
      .map(cloneComment)
  }

  /** One replay-consistent projection for the repository management panel. */
  async board(selector = 'HEAD', limit = 100, signal?: AbortSignal): Promise<RepositoryBoardSnapshot> {
    const bounded = normalizeLimit(limit)
    const snapshot = await this.snapshot(signal)
    const commit = selectCommit(snapshot, selector)
    const checkout: RepositoryCheckout = commit === null
      ? { selector: 'ROOT', commit: null, records: [] }
      : {
          selector: commit.id,
          commit: toCommitSummary(commit),
          records: requireTree(snapshot, commit.tree).entries.map(({ key, value, valueHash }) => ({ key, value: cloneJson(value), valueHash })),
        }
    return {
      status: this.statusFromSnapshot(snapshot),
      log: [...snapshot.commits.values()].reverse().slice(0, bounded).map(toCommitSummary),
      checkout,
      issues: [...snapshot.issues.values()].slice(0, bounded).map(cloneIssue),
      comments: [...snapshot.comments.values()].reverse().slice(0, bounded).map(cloneComment),
    }
  }

  async diff(from: string | undefined, to: string | undefined, signal?: AbortSignal): Promise<RepositoryDiff> {
    const snapshot = await this.snapshot(signal)
    const toCommit = selectCommit(snapshot, to ?? 'HEAD')
    const fromCommit = from === undefined
      ? (toCommit?.parent === null || toCommit === null ? null : selectCommit(snapshot, toCommit.parent))
      : selectCommit(snapshot, from)
    const before = fromCommit === null ? new Map<string, JsonValue>() : treeValues(requireTree(snapshot, fromCommit.tree))
    const after = toCommit === null ? new Map<string, JsonValue>() : treeValues(requireTree(snapshot, toCommit.tree))
    const keys = [...new Set([...before.keys(), ...after.keys()])].sort()
    const changes: RepositoryDiff['changes'][number][] = []
    for (const key of keys) {
      const beforeValue = before.get(key)
      const afterValue = after.get(key)
      if (beforeValue === undefined && afterValue !== undefined) {
        changes.push({ key, kind: 'added', afterHash: hashId(afterValue) })
      } else if (beforeValue !== undefined && afterValue === undefined) {
        changes.push({ key, kind: 'deleted', beforeHash: hashId(beforeValue) })
      } else if (beforeValue !== undefined && afterValue !== undefined && canonicalJson(beforeValue) !== canonicalJson(afterValue)) {
        changes.push({ key, kind: 'changed', beforeHash: hashId(beforeValue), afterHash: hashId(afterValue) })
      }
    }
    return { from: fromCommit?.id ?? null, to: toCommit?.id ?? null, changes }
  }

  async pull(
    keys: readonly string[] | undefined,
    limit = 50,
    cursor: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ readonly records: readonly KnowledgeRecord[]; readonly truncated: boolean; readonly nextCursor?: string }> {
    const snapshot = await this.snapshot(signal)
    const safeLimit = normalizeLimit(limit)
    const candidates = keys === undefined
      ? [...snapshot.values.keys()].sort().filter(key => cursor === undefined || key > normalizeKnowledgeKey(cursor))
      : [...new Set(keys.map(normalizeKnowledgeKey))].sort()
    const selected = cursor === undefined || keys === undefined
      ? candidates
      : candidates.filter(key => key > normalizeKnowledgeKey(cursor))
    const records: KnowledgeRecord[] = []
    let bytes = 0
    for (const key of selected) {
      if (records.length >= safeLimit) break
      const value = snapshot.values.get(key)
      if (value === undefined) continue
      const record: KnowledgeRecord = { key, value: cloneJson(value), valueHash: hashId(value) }
      const nextBytes = Buffer.byteLength(canonicalJson(record), 'utf8')
      if (records.length > 0 && bytes + nextBytes > MAX_QUERY_RECORD_BYTES) break
      if (nextBytes > MAX_QUERY_RECORD_BYTES) {
        throw new RepositoryReadError('QUERY_LIMIT_EXCEEDED', `Knowledge record '${key}' exceeds the M1a output limit.`)
      }
      records.push(record)
      bytes += nextBytes
    }
    const lastKey = records.at(-1)?.key
    const remaining = lastKey !== undefined && selected.some(key => key > lastKey && snapshot.values.has(key))
    return {
      records,
      truncated: remaining,
      ...(remaining && lastKey !== undefined ? { nextCursor: lastKey } : {}),
    }
  }

  async listIssues(limit = 50, signal?: AbortSignal): Promise<readonly IssueRecord[]> {
    const snapshot = await this.snapshot(signal)
    return [...snapshot.issues.values()].sort((left, right) => left.id.localeCompare(right.id)).slice(0, normalizeLimit(limit)).map(cloneIssue)
  }

  async getIssue(id: string, signal?: AbortSignal): Promise<IssueRecord | undefined> {
    if (!ISSUE_ID.test(id)) throw new RepositoryReadError('REPO_MANIFEST_INVALID', 'Issue id has an invalid format.')
    const issue = (await this.snapshot(signal)).issues.get(id)
    return issue === undefined ? undefined : cloneIssue(issue)
  }

  private async snapshot(signal?: AbortSignal): Promise<Snapshot> {
    return (await this.snapshotRead(signal)).snapshot
  }

  private statusFromSnapshot(snapshot: Snapshot): RepositoryStatus {
    return {
      formatVersion: REPOSITORY_FORMAT_VERSION,
      repoId: this.manifest.repoId,
      workspaceId: this.manifest.workspaceId,
      head: snapshot.head,
      journalEntries: snapshot.journalEntries,
      commits: snapshot.commits.size,
      knowledgeKeys: snapshot.values.size,
      issues: snapshot.issues.size,
      integrity: 'ok',
    }
  }

  private async snapshotRead(signal?: AbortSignal): Promise<{
    readonly snapshot: Snapshot
    readonly journal: RepositoryFileObservation
  }> {
    await this.assertMutationRoot(signal)
    const journalPath = inside(this.repositoryRoot, 'journal.jsonl')
    const journal = await readStrictFile(journalPath, this.repositoryRoot, 'journal.jsonl', MAX_JOURNAL_BYTES, signal)
    await this.assertMutationRoot(signal)
    return { snapshot: replayJournal(journal.source, this.manifest), journal: journal.observation }
  }
}

function parseManifest(source: string, expectedWorkspaceId: string): RepositoryManifest {
  const value = parseCanonicalDocument(source, 'manifest.json', 'REPO_MANIFEST_INVALID')
  const manifest = requireRecord(value, 'REPO_MANIFEST_INVALID', 'Manifest must be an object.')
  assertExactKeys(manifest, ['format', 'formatVersion', 'repoId', 'workspaceId', 'storage', 'journal', 'createdAt'], 'REPO_MANIFEST_INVALID', 'Manifest has unsupported fields.')
  if (manifest.format !== REPOSITORY_FORMAT || manifest.formatVersion !== REPOSITORY_FORMAT_VERSION) {
    throw new RepositoryReadError('REPO_FORMAT_UNSUPPORTED', 'Repository format is not supported by M1a.')
  }
  const repoId = requireString(manifest.repoId, 'REPO_MANIFEST_INVALID', 'Manifest repoId must be a string.')
  if (!/^repo_[A-Za-z0-9_-]{8,120}$/.test(repoId)) {
    throw new RepositoryReadError('REPO_MANIFEST_INVALID', 'Manifest repoId has an invalid format.')
  }
  const workspaceId = requireString(manifest.workspaceId, 'REPO_MANIFEST_INVALID', 'Manifest workspaceId must be a string.')
  if (workspaceId !== expectedWorkspaceId) {
    throw new RepositoryReadError('REPO_PATH_ESCAPE', 'Repository manifest belongs to a different registered workspace.')
  }
  if (manifest.storage !== 'workspace') {
    throw new RepositoryReadError('REPO_FORMAT_UNSUPPORTED', 'M1a supports workspace-local repositories only.')
  }
  const journal = requireRecord(manifest.journal, 'REPO_MANIFEST_INVALID', 'Manifest journal must be an object.')
  assertExactKeys(journal, ['file', 'hash'], 'REPO_MANIFEST_INVALID', 'Manifest journal has unsupported fields.')
  if (journal.file !== 'journal.jsonl' || journal.hash !== 'sha256') {
    throw new RepositoryReadError('REPO_MANIFEST_INVALID', 'Manifest journal location or hash algorithm is invalid.')
  }
  return {
    format: REPOSITORY_FORMAT,
    formatVersion: REPOSITORY_FORMAT_VERSION,
    repoId,
    workspaceId,
    storage: 'workspace',
    journal: { file: 'journal.jsonl', hash: 'sha256' },
    createdAt: requireTimestamp(manifest.createdAt, 'REPO_MANIFEST_INVALID', 'Manifest createdAt must be ISO-8601 compatible.'),
  }
}

function replayJournal(source: string, manifest: RepositoryManifest): Snapshot {
  if (!source.endsWith('\n')) {
    throw new RepositoryReadError('JOURNAL_TRUNCATED_TAIL', 'Journal must end in one complete LF-terminated record.')
  }
  if (source.includes('\r')) {
    throw new RepositoryReadError('JOURNAL_NON_CANONICAL', 'Journal must use LF line endings and canonical JSON records.')
  }
  const lines = source.slice(0, -1).split('\n')
  if (lines.length === 0 || lines[0] === '') {
    throw new RepositoryReadError('JOURNAL_TRUNCATED_TAIL', 'Journal contains no complete initialization record.')
  }
  if (lines.length > MAX_JOURNAL_LINES) {
    throw new RepositoryReadError('REPO_TOO_LARGE', `Journal exceeds ${MAX_JOURNAL_LINES} M1a records.`)
  }

  const commits = new Map<Sha256Id, CommitObject>()
  const trees = new Map<Sha256Id, TreeObject>()
  const issues = new Map<string, IssueRecord>()
  const comments = new Map<string, RepositoryComment>()
  let values = new Map<string, JsonValue>()
  let head: Sha256Id | null = null
  let previousChecksum: Sha256Id | null = null

  for (const [index, line] of lines.entries()) {
    const position = index + 1
    if (line === '') throw new RepositoryReadError('JOURNAL_NON_CANONICAL', `Journal record ${position} is empty.`)
    const record = parseJournalRecord(line, position)
    if (record.seq !== position) throw new RepositoryReadError('JOURNAL_SEQ_GAP', `Journal record ${position} has an unexpected sequence.`)
    if (record.prev !== previousChecksum) throw new RepositoryReadError('JOURNAL_PREV_MISMATCH', `Journal record ${position} does not link to its predecessor.`)
    if (record.checksum !== hashId(unsignedRecord(record))) {
      throw new RepositoryReadError('JOURNAL_CHECKSUM_MISMATCH', `Journal record ${position} checksum does not match its payload.`)
    }
    if (position === 1 && record.type !== 'repo.initialized') {
      throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Journal must start with repository initialization.')
    }

    if (record.type === 'repo.initialized') {
      if (position !== 1) throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Repository initialization may only appear as the first record.')
      verifyInitialization(record.payload, manifest)
    } else if (record.type === 'commit.created') {
      if (position === 1) throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Journal must start with repository initialization.')
      const event = parseCommitEvent(record.payload)
      if (event.commit.parent !== head) throw new RepositoryReadError('COMMIT_PARENT_MISMATCH', 'Commit parent does not match the replayed HEAD.')
      if (event.commit.tree !== event.tree.id) throw new RepositoryReadError('TREE_HASH_MISMATCH', 'Commit tree reference does not match its embedded tree.')
      if (event.commit.kind === 'rollback') {
        if (event.commit.restores === null) {
          if (event.tree.entries.length !== 0) {
            throw new RepositoryReadError('TREE_HASH_MISMATCH', 'A ROOT rollback must restore the empty tree.')
          }
        } else {
          const restored = commits.get(event.commit.restores)
          if (restored === undefined || restored.tree !== event.tree.id) {
            throw new RepositoryReadError('COMMIT_HASH_MISMATCH', 'Rollback audit target does not match its restored tree.')
          }
        }
      }
      const reconstructed = makeTree(treeValues(event.tree))
      if (canonicalJson(reconstructed) !== canonicalJson(event.tree)) {
        throw new RepositoryReadError('TREE_HASH_MISMATCH', 'Commit tree cannot be reconstructed as a canonical snapshot.')
      }
      commits.set(event.commit.id, event.commit)
      trees.set(event.tree.id, event.tree)
      values = treeValues(event.tree)
      head = event.commit.id
    } else if (record.type === 'issue.opened') {
      const issue = parseIssueOpened(record.payload)
      if (issues.has(issue.id)) throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Journal opens the same issue twice.')
      issues.set(issue.id, issue)
    } else if (record.type === 'issue.status.changed') {
      const update = parseIssueStatusChange(record.payload)
      const issue = issues.get(update.id)
      if (issue === undefined) throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Journal changes an unknown issue.')
      issues.set(update.id, { ...issue, status: update.status, updatedAt: update.updatedAt })
    } else if (record.type === 'issue.comment.added') {
      const update = parseIssueComment(record.payload)
      const issue = issues.get(update.id)
      if (issue === undefined) throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Journal comments on an unknown issue.')
      issues.set(update.id, { ...issue, updatedAt: update.updatedAt })
    } else if (record.type === 'comment.created') {
      const comment = parseRepositoryComment(record.payload)
      if (comments.has(comment.id)) throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Journal creates the same repository comment twice.')
      if (comment.issueId !== undefined && !issues.has(comment.issueId)) {
        throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Repository comment targets an unknown issue.')
      }
      comments.set(comment.id, comment)
    } else if (record.type === 'comment.delivery.requested') {
      const request = parseCommentDeliveryRequest(record.payload)
      const comment = comments.get(request.commentId)
      if (comment === undefined) throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Journal queues delivery for an unknown repository comment.')
      const mentioned = new Set(comment.mentions)
      if (request.sessionIds.some(sessionId => !mentioned.has(sessionId))) {
        throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Repository comment delivery requests must target explicit mentions.')
      }
      comments.set(comment.id, {
        ...comment,
        deliveryRequestedTo: [...new Set([...comment.deliveryRequestedTo, ...request.sessionIds])],
      })
    } else if (record.type === 'comment.delivered') {
      const delivery = parseCommentDelivery(record.payload)
      const comment = comments.get(delivery.commentId)
      if (comment === undefined) throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Journal delivers an unknown repository comment.')
      const mentioned = new Set(comment.mentions)
      if (delivery.sessionIds.some(sessionId => !mentioned.has(sessionId))) {
        throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Repository comment delivery targets must be explicit mentions.')
      }
      const requested = new Set(comment.deliveryRequestedTo)
      if (delivery.sessionIds.some(sessionId => !requested.has(sessionId))) {
        throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Repository comment delivery must follow a durable delivery request.')
      }
      comments.set(comment.id, {
        ...comment,
        deliveredTo: [...new Set([...comment.deliveredTo, ...delivery.sessionIds])],
      })
    } else {
      throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', `Journal event '${record.type}' is not supported by M1a.`)
    }
    previousChecksum = record.checksum
  }

  if (previousChecksum === null) {
    throw new RepositoryReadError('JOURNAL_TRUNCATED_TAIL', 'Journal contains no complete initialization record.')
  }
  return { journalEntries: lines.length, tailChecksum: previousChecksum, head, commits, trees, values, issues, comments }
}

function parseJournalRecord(line: string, position: number): JournalRecord {
  const value = parseCanonicalLine(line, position)
  const record = requireRecord(value, 'JOURNAL_NON_CANONICAL', `Journal record ${position} must be an object.`)
  assertExactKeys(record, ['formatVersion', 'seq', 'type', 'ts', 'prev', 'payload', 'checksum'], 'JOURNAL_NON_CANONICAL', `Journal record ${position} has unsupported fields.`)
  const formatVersion = record.formatVersion
  if (formatVersion !== REPOSITORY_FORMAT_VERSION) {
    throw new RepositoryReadError('REPO_FORMAT_UNSUPPORTED', `Journal record ${position} uses an unsupported format.`)
  }
  if (typeof record.seq !== 'number' || !Number.isSafeInteger(record.seq) || record.seq < 1) {
    throw new RepositoryReadError('JOURNAL_SEQ_GAP', `Journal record ${position} has an invalid sequence.`)
  }
  const type = requireString(record.type, 'JOURNAL_NON_CANONICAL', `Journal record ${position} type must be a string.`)
  const prev = record.prev === null ? null : requireHash(record.prev, 'JOURNAL_NON_CANONICAL', `Journal record ${position} prev must be a SHA-256 id.`)
  const checksum = requireHash(record.checksum, 'JOURNAL_NON_CANONICAL', `Journal record ${position} checksum must be a SHA-256 id.`)
  return {
    formatVersion: REPOSITORY_FORMAT_VERSION,
    seq: record.seq,
    type,
    ts: requireTimestamp(record.ts, 'JOURNAL_NON_CANONICAL', `Journal record ${position} ts must be ISO-8601 compatible.`),
    prev,
    payload: cloneJson(record.payload as JsonValue),
    checksum,
  }
}

function verifyInitialization(payload: JsonValue, manifest: RepositoryManifest): void {
  const init = requireRecord(payload, 'JOURNAL_EVENT_UNSUPPORTED', 'Repository initialization payload must be an object.')
  assertExactKeys(init, ['repoId', 'workspaceId', 'manifestHash'], 'JOURNAL_EVENT_UNSUPPORTED', 'Repository initialization payload has unsupported fields.')
  if (init.repoId !== manifest.repoId || init.workspaceId !== manifest.workspaceId) {
    throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Repository initialization does not match the manifest identity.')
  }
  if (init.manifestHash !== hashId(manifest)) {
    throw new RepositoryReadError('JOURNAL_CHECKSUM_MISMATCH', 'Repository initialization does not match the manifest hash.')
  }
}

function parseCommitEvent(payload: JsonValue): { readonly commit: CommitObject; readonly tree: TreeObject } {
  const event = requireRecord(payload, 'JOURNAL_EVENT_UNSUPPORTED', 'Commit event payload must be an object.')
  assertExactKeys(event, ['commit', 'tree'], 'JOURNAL_EVENT_UNSUPPORTED', 'Commit event payload has unsupported fields.')
  const tree = parseTree(event.tree)
  const commit = parseCommit(event.commit)
  return { commit, tree }
}

function parseTree(value: unknown): TreeObject {
  const tree = requireRecord(value, 'TREE_HASH_MISMATCH', 'Commit tree must be an object.')
  assertExactKeys(tree, ['format', 'formatVersion', 'id', 'entries'], 'TREE_HASH_MISMATCH', 'Commit tree has unsupported fields.')
  if (tree.format !== TREE_FORMAT || tree.formatVersion !== REPOSITORY_FORMAT_VERSION || !Array.isArray(tree.entries)) {
    throw new RepositoryReadError('TREE_HASH_MISMATCH', 'Commit tree has an unsupported format.')
  }
  if (tree.entries.length > MAX_TREE_ENTRIES) throw new RepositoryReadError('REPO_TOO_LARGE', 'Commit tree has too many knowledge entries.')
  const entries = tree.entries.map((value, index) => parseTreeEntry(value, index + 1))
  const keys = entries.map(entry => entry.key)
  if (keys.some((key, index) => index > 0 && keys[index - 1] >= key)) {
    throw new RepositoryReadError('TREE_HASH_MISMATCH', 'Commit tree keys must be strictly sorted and unique.')
  }
  const id = requireHash(tree.id, 'TREE_HASH_MISMATCH', 'Commit tree id must be a SHA-256 id.')
  const result: TreeObject = { format: TREE_FORMAT, formatVersion: REPOSITORY_FORMAT_VERSION, id, entries }
  if (id !== hashId({ format: result.format, formatVersion: result.formatVersion, entries: result.entries })) {
    throw new RepositoryReadError('TREE_HASH_MISMATCH', 'Commit tree id does not match its canonical payload.')
  }
  return result
}

function parseTreeEntry(value: unknown, index: number): TreeEntry {
  const entry = requireRecord(value, 'TREE_HASH_MISMATCH', `Tree entry ${index} must be an object.`)
  assertExactKeys(entry, ['key', 'value', 'valueHash'], 'TREE_HASH_MISMATCH', `Tree entry ${index} has unsupported fields.`)
  const key = normalizeKnowledgeKey(requireString(entry.key, 'TREE_HASH_MISMATCH', `Tree entry ${index} key must be a string.`))
  const jsonValue = cloneJson(entry.value as JsonValue)
  const bytes = Buffer.byteLength(canonicalJson(jsonValue), 'utf8')
  if (bytes > MAX_VALUE_BYTES) throw new RepositoryReadError('REPO_TOO_LARGE', `Knowledge value '${key}' exceeds the M1a value limit.`)
  const valueHash = requireHash(entry.valueHash, 'TREE_HASH_MISMATCH', `Tree entry ${index} valueHash must be a SHA-256 id.`)
  if (valueHash !== hashId(jsonValue)) throw new RepositoryReadError('TREE_HASH_MISMATCH', `Knowledge value '${key}' hash does not match.`)
  return { key, value: jsonValue, valueHash }
}

function parseCommit(value: unknown): CommitObject {
  const commit = requireRecord(value, 'COMMIT_HASH_MISMATCH', 'Commit must be an object.')
  const kind = commit.kind
  if (kind === 'normal') {
    assertExactKeys(commit, ['format', 'formatVersion', 'id', 'parent', 'tree', 'message', 'author', 'kind', 'createdAt'], 'COMMIT_HASH_MISMATCH', 'Normal commit has unsupported fields.')
  } else if (kind === 'rollback') {
    assertExactKeys(commit, ['format', 'formatVersion', 'id', 'parent', 'tree', 'message', 'author', 'kind', 'restores', 'createdAt'], 'COMMIT_HASH_MISMATCH', 'Rollback commit has unsupported fields.')
  } else {
    throw new RepositoryReadError('COMMIT_HASH_MISMATCH', 'Commit has an unsupported kind.')
  }
  if (commit.format !== COMMIT_FORMAT || commit.formatVersion !== REPOSITORY_FORMAT_VERSION) {
    throw new RepositoryReadError('COMMIT_HASH_MISMATCH', 'Commit has an unsupported format.')
  }
  const author = requireRecord(commit.author, 'COMMIT_HASH_MISMATCH', 'Commit author must be an object.')
  assertAllowedKeys(author, ['sessionId', 'messageId'], 'COMMIT_HASH_MISMATCH', 'Commit author has unsupported fields.')
  const base = {
    format: COMMIT_FORMAT,
    formatVersion: REPOSITORY_FORMAT_VERSION,
    id: requireHash(commit.id, 'COMMIT_HASH_MISMATCH', 'Commit id must be a SHA-256 id.'),
    parent: commit.parent === null ? null : requireHash(commit.parent, 'COMMIT_HASH_MISMATCH', 'Commit parent must be a SHA-256 id.'),
    tree: requireHash(commit.tree, 'COMMIT_HASH_MISMATCH', 'Commit tree must be a SHA-256 id.'),
    message: requireBoundedString(commit.message, 1_000, 'COMMIT_HASH_MISMATCH', 'Commit message is invalid.'),
    author: {
      sessionId: requireBoundedString(author.sessionId, 256, 'COMMIT_HASH_MISMATCH', 'Commit author sessionId is invalid.'),
      ...(typeof author.messageId === 'string' ? { messageId: requireBoundedString(author.messageId, 256, 'COMMIT_HASH_MISMATCH', 'Commit author messageId is invalid.') } : {}),
    },
    createdAt: requireTimestamp(commit.createdAt, 'COMMIT_HASH_MISMATCH', 'Commit createdAt must be ISO-8601 compatible.'),
  }
  const parsed: CommitObject = kind === 'normal'
    ? { ...base, kind: 'normal' }
    : {
        ...base,
        kind: 'rollback',
        restores: commit.restores === null
          ? null
          : requireHash(commit.restores, 'COMMIT_HASH_MISMATCH', 'Rollback restores must be ROOT or a SHA-256 commit id.'),
      }
  const { id: _id, ...unsigned } = parsed
  if (parsed.id !== hashId(unsigned)) throw new RepositoryReadError('COMMIT_HASH_MISMATCH', 'Commit id does not match its canonical payload.')
  return parsed
}

function parseIssueOpened(payload: JsonValue): IssueRecord {
  const event = requireRecord(payload, 'JOURNAL_EVENT_UNSUPPORTED', 'Issue opened payload must be an object.')
  assertExactKeys(event, ['issue'], 'JOURNAL_EVENT_UNSUPPORTED', 'Issue opened payload has unsupported fields.')
  const issue = requireRecord(event.issue, 'JOURNAL_EVENT_UNSUPPORTED', 'Opened issue must be an object.')
  assertAllowedKeys(issue, ['id', 'title', 'body', 'status', 'labels', 'assignee', 'openedBy', 'createdAt', 'updatedAt'], 'JOURNAL_EVENT_UNSUPPORTED', 'Opened issue has unsupported fields.')
  const status = parseIssueStatus(issue.status)
  if (!Array.isArray(issue.labels) || issue.labels.length > 20 || !issue.labels.every(label => typeof label === 'string')) {
    throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Opened issue labels must be a bounded string array.')
  }
  const labels = issue.labels.map(label => requireBoundedString(label, 120, 'JOURNAL_EVENT_UNSUPPORTED', 'Opened issue label is invalid.'))
  if (new Set(labels).size !== labels.length) throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Opened issue labels must be unique.')
  let assignee: string | undefined
  if (Object.hasOwn(issue, 'assignee')) {
    assignee = requireBoundedString(issue.assignee, 256, 'JOURNAL_EVENT_UNSUPPORTED', 'Opened issue assignee is invalid.')
  }
  const openedBy = Object.hasOwn(issue, 'openedBy')
    ? parseRepositoryActor(issue.openedBy, 'Opened issue author is invalid.')
    : undefined
  return {
    id: requireIssueId(issue.id),
    title: requireBoundedString(issue.title, 1_000, 'JOURNAL_EVENT_UNSUPPORTED', 'Opened issue title is invalid.'),
    body: requireBoundedString(issue.body, 16_000, 'JOURNAL_EVENT_UNSUPPORTED', 'Opened issue body is invalid.'),
    status,
    labels,
    ...(assignee === undefined ? {} : { assignee }),
    ...(openedBy === undefined ? {} : { openedBy }),
    createdAt: requireTimestamp(issue.createdAt, 'JOURNAL_EVENT_UNSUPPORTED', 'Opened issue createdAt is invalid.'),
    updatedAt: requireTimestamp(issue.updatedAt, 'JOURNAL_EVENT_UNSUPPORTED', 'Opened issue updatedAt is invalid.'),
  }
}

function parseIssueStatusChange(payload: JsonValue): { readonly id: string; readonly status: IssueStatus; readonly updatedAt: string } {
  const event = requireRecord(payload, 'JOURNAL_EVENT_UNSUPPORTED', 'Issue status payload must be an object.')
  assertExactKeys(event, ['id', 'status', 'updatedAt'], 'JOURNAL_EVENT_UNSUPPORTED', 'Issue status payload has unsupported fields.')
  return {
    id: requireIssueId(event.id),
    status: parseIssueStatus(event.status),
    updatedAt: requireTimestamp(event.updatedAt, 'JOURNAL_EVENT_UNSUPPORTED', 'Issue status updatedAt is invalid.'),
  }
}

function parseIssueComment(payload: JsonValue): { readonly id: string; readonly updatedAt: string } {
  const event = requireRecord(payload, 'JOURNAL_EVENT_UNSUPPORTED', 'Issue comment payload must be an object.')
  assertAllowedKeys(event, ['id', 'body', 'author', 'updatedAt'], 'JOURNAL_EVENT_UNSUPPORTED', 'Issue comment payload has unsupported fields.')
  requireBoundedString(event.body, 16_000, 'JOURNAL_EVENT_UNSUPPORTED', 'Issue comment body is invalid.')
  if (Object.hasOwn(event, 'author')) {
    requireBoundedString(event.author, 256, 'JOURNAL_EVENT_UNSUPPORTED', 'Issue comment author is invalid.')
  }
  return {
    id: requireIssueId(event.id),
    updatedAt: requireTimestamp(event.updatedAt, 'JOURNAL_EVENT_UNSUPPORTED', 'Issue comment updatedAt is invalid.'),
  }
}

function parseRepositoryComment(payload: JsonValue): RepositoryComment {
  const event = requireRecord(payload, 'JOURNAL_EVENT_UNSUPPORTED', 'Repository comment payload must be an object.')
  assertExactKeys(event, ['comment'], 'JOURNAL_EVENT_UNSUPPORTED', 'Repository comment payload has unsupported fields.')
  const comment = requireRecord(event.comment, 'JOURNAL_EVENT_UNSUPPORTED', 'Repository comment must be an object.')
  assertAllowedKeys(comment, ['id', 'body', 'author', 'mentions', 'issueId', 'createdAt'], 'JOURNAL_EVENT_UNSUPPORTED', 'Repository comment has unsupported fields.')
  if (!Array.isArray(comment.mentions) || comment.mentions.length > 32) {
    throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Repository comment mentions must be a bounded array.')
  }
  const mentions = comment.mentions.map(value => requireBoundedString(value, 256, 'JOURNAL_EVENT_UNSUPPORTED', 'Repository comment mention is invalid.'))
  if (new Set(mentions).size !== mentions.length) {
    throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Repository comment mentions must be unique.')
  }
  return {
    id: requireIssueId(comment.id),
    body: requireBoundedString(comment.body, 16_000, 'JOURNAL_EVENT_UNSUPPORTED', 'Repository comment body is invalid.'),
    author: parseRepositoryActor(comment.author, 'Repository comment author is invalid.'),
    ...(Object.hasOwn(comment, 'issueId') ? { issueId: requireIssueId(comment.issueId) } : {}),
    mentions,
    deliveryRequestedTo: [],
    deliveredTo: [],
    createdAt: requireTimestamp(comment.createdAt, 'JOURNAL_EVENT_UNSUPPORTED', 'Repository comment createdAt is invalid.'),
  }
}

function parseCommentDelivery(payload: JsonValue): {
  readonly commentId: string
  readonly sessionIds: readonly string[]
} {
  const event = requireRecord(payload, 'JOURNAL_EVENT_UNSUPPORTED', 'Repository comment delivery payload must be an object.')
  assertExactKeys(event, ['commentId', 'sessionIds', 'deliveredAt'], 'JOURNAL_EVENT_UNSUPPORTED', 'Repository comment delivery has unsupported fields.')
  if (!Array.isArray(event.sessionIds) || event.sessionIds.length === 0 || event.sessionIds.length > 32) {
    throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Repository comment delivery targets must be a bounded non-empty array.')
  }
  const sessionIds = event.sessionIds.map(value => requireBoundedString(value, 256, 'JOURNAL_EVENT_UNSUPPORTED', 'Repository comment delivery target is invalid.'))
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Repository comment delivery targets must be unique.')
  }
  requireTimestamp(event.deliveredAt, 'JOURNAL_EVENT_UNSUPPORTED', 'Repository comment delivery timestamp is invalid.')
  return { commentId: requireIssueId(event.commentId), sessionIds }
}

function parseCommentDeliveryRequest(payload: JsonValue): {
  readonly commentId: string
  readonly sessionIds: readonly string[]
} {
  const event = requireRecord(payload, 'JOURNAL_EVENT_UNSUPPORTED', 'Repository comment delivery request payload must be an object.')
  assertExactKeys(event, ['commentId', 'sessionIds', 'requestedAt'], 'JOURNAL_EVENT_UNSUPPORTED', 'Repository comment delivery request has unsupported fields.')
  if (!Array.isArray(event.sessionIds) || event.sessionIds.length === 0 || event.sessionIds.length > 32) {
    throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Repository comment delivery request targets must be a bounded non-empty array.')
  }
  const sessionIds = event.sessionIds.map(value => requireBoundedString(value, 256, 'JOURNAL_EVENT_UNSUPPORTED', 'Repository comment delivery request target is invalid.'))
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Repository comment delivery request targets must be unique.')
  }
  requireTimestamp(event.requestedAt, 'JOURNAL_EVENT_UNSUPPORTED', 'Repository comment delivery request timestamp is invalid.')
  return { commentId: requireIssueId(event.commentId), sessionIds }
}

function parseIssueStatus(value: unknown): IssueStatus {
  if (value === 'open' || value === 'assigned' || value === 'in_progress' || value === 'resolved' || value === 'closed') return value
  throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Issue status is invalid.')
}

function parseRepositoryActor(value: unknown, message: string): RepositoryActor {
  if (value === 'admin') return 'admin'
  const actor = requireRecord(value, 'JOURNAL_EVENT_UNSUPPORTED', message)
  assertExactKeys(actor, ['kind', 'sessionId'], 'JOURNAL_EVENT_UNSUPPORTED', message)
  if (actor.kind !== 'agent') throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', message)
  return {
    kind: 'agent',
    sessionId: requireBoundedString(actor.sessionId, 256, 'JOURNAL_EVENT_UNSUPPORTED', message),
  }
}

function makeTree(values: ReadonlyMap<string, JsonValue>): TreeObject {
  const entries = [...values.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, value]) => ({
    key,
    value: cloneJson(value),
    valueHash: hashId(value),
  }))
  return {
    format: TREE_FORMAT,
    formatVersion: REPOSITORY_FORMAT_VERSION,
    id: hashId({ format: TREE_FORMAT, formatVersion: REPOSITORY_FORMAT_VERSION, entries }),
    entries,
  }
}

function treeValues(tree: TreeObject): Map<string, JsonValue> {
  return new Map(tree.entries.map(entry => [entry.key, cloneJson(entry.value)]))
}

function selectCommit(snapshot: Snapshot, selector: string): CommitObject | null {
  if (selector === 'ROOT') return null
  if (selector === 'HEAD') return snapshot.head === null ? null : requireCommit(snapshot, snapshot.head)
  if (!SHA256_ID.test(selector)) throw new RepositoryReadError('COMMIT_HASH_MISMATCH', 'Commit selector must be HEAD, ROOT, or a full SHA-256 id.')
  return requireCommit(snapshot, selector as Sha256Id)
}

function requireCommit(snapshot: Snapshot, id: Sha256Id): CommitObject {
  const commit = snapshot.commits.get(id)
  if (commit === undefined) throw new RepositoryReadError('COMMIT_HASH_MISMATCH', 'Commit selector does not exist in this journal.')
  return commit
}

function requireTree(snapshot: Snapshot, id: Sha256Id): TreeObject {
  const tree = snapshot.trees.get(id)
  if (tree === undefined) throw new RepositoryReadError('TREE_HASH_MISMATCH', 'Commit tree does not exist in this journal.')
  return tree
}

function toCommitSummary(commit: CommitObject): CommitSummary {
  const { id, parent, tree, message, kind, createdAt } = commit
  return {
    id,
    parent,
    tree,
    message,
    kind,
    ...(commit.kind === 'rollback' ? { restores: commit.restores } : {}),
    createdAt,
  }
}

function cloneIssue(issue: IssueRecord): IssueRecord {
  return {
    id: issue.id,
    title: issue.title,
    body: issue.body,
    status: issue.status,
    labels: [...issue.labels],
    ...(issue.assignee === undefined ? {} : { assignee: issue.assignee }),
    ...(issue.openedBy === undefined ? {} : { openedBy: cloneActor(issue.openedBy) }),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  }
}

function cloneComment(comment: RepositoryComment): RepositoryComment {
  return {
    id: comment.id,
    body: comment.body,
    author: cloneActor(comment.author),
    ...(comment.issueId === undefined ? {} : { issueId: comment.issueId }),
    mentions: [...comment.mentions],
    deliveryRequestedTo: [...comment.deliveryRequestedTo],
    deliveredTo: [...comment.deliveredTo],
    createdAt: comment.createdAt,
  }
}

function cloneActor(actor: RepositoryActor): RepositoryActor {
  return actor === 'admin' ? 'admin' : { kind: 'agent', sessionId: actor.sessionId }
}

function unsignedRecord(record: JournalRecord): Omit<JournalRecord, 'checksum'> {
  const { checksum: _checksum, ...unsigned } = record
  return unsigned
}

function hashId(value: unknown): Sha256Id {
  return `sha256:${sha256(value)}` as Sha256Id
}

async function canonicalWorkspaceRoot(workspacePath: string, signal?: AbortSignal): Promise<string> {
  assertNotAborted(signal)
  const canonical = await realpath(workspacePath)
  const info = await stat(canonical)
  if (!info.isDirectory()) throw new RepositoryReadError('REPO_PATH_ESCAPE', 'Registered workspace path is not an accessible directory.')
  assertNotAborted(signal)
  return canonical
}

async function canonicalRepositoryRoot(repositoryPath: string, workspaceRoot: string, signal?: AbortSignal): Promise<string> {
  assertNotAborted(signal)
  const canonical = await realpath(repositoryPath)
  if (!isContainedBy(workspaceRoot, canonical)) {
    throw new RepositoryReadError('REPO_PATH_ESCAPE', 'Repository directory resolves outside the registered workspace.')
  }
  const info = await lstat(canonical)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new RepositoryReadError('REPO_PATH_ESCAPE', 'Repository directory is not a real directory inside this workspace.')
  }
  assertNotAborted(signal)
  return canonical
}

async function observeRepositoryDirectory(path: string, signal?: AbortSignal): Promise<RepositoryDirectoryObservation> {
  assertNotAborted(signal)
  const current = await lstat(path)
  if (current.isSymbolicLink() || !current.isDirectory() || current.ino === 0) {
    throw new RepositoryReadError('REPO_PATH_ESCAPE', 'Repository directory does not have a stable local filesystem identity.')
  }
  return { dev: current.dev, ino: current.ino }
}

async function assertRepositoryDirectory(
  path: string,
  expected: RepositoryDirectoryObservation,
  signal?: AbortSignal,
): Promise<void> {
  const current = await observeRepositoryDirectory(path, signal)
  if (!sameFilesystemObject(current, expected)) {
    throw new RepositoryReadError('REPO_PATH_ESCAPE', 'Repository directory changed while it was being accessed.')
  }
}

/**
 * Read only an object whose resolved path and opened file identity both remain
 * beneath the canonical repository root. The handle is verified before any
 * content is read, closing the lstat/open replacement window for symlinks and
 * junctions that a mutable workspace could otherwise introduce.
 */
async function readStrictFile(
  path: string,
  repositoryRoot: string,
  label: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<StrictTextRead> {
  const entry = await lstatIfExists(path)
  if (entry === undefined) {
    if (label === 'manifest.json') throw new RepositoryReadError('REPO_NOT_INITIALIZED', 'No explicit repository manifest exists for this workspace.')
    throw new RepositoryReadError('JOURNAL_TRUNCATED_TAIL', 'Repository journal is missing.')
  }
  if (entry.isSymbolicLink() || !entry.isFile()) throw new RepositoryReadError('REPO_PATH_ESCAPE', `${label} must be a regular file inside the repository.`)
  if (entry.size > maxBytes) throw new RepositoryReadError('REPO_TOO_LARGE', `${label} exceeds the M1a read limit.`)
  const resolvedPath = await realpath(path)
  if (!isContainedBy(repositoryRoot, resolvedPath)) {
    throw new RepositoryReadError('REPO_PATH_ESCAPE', `${label} resolves outside the repository.`)
  }
  assertNotAborted(signal)
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  try {
    handle = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFilesystemObject(entry, opened)) {
      throw new RepositoryReadError('REPO_PATH_ESCAPE', `${label} changed while its repository boundary was being verified.`)
    }
    if (opened.size > maxBytes) throw new RepositoryReadError('REPO_TOO_LARGE', `${label} exceeds the M1a read limit.`)
    assertNotAborted(signal)
    const bytes = await handle.readFile()
    assertNotAborted(signal)
    if (bytes.byteLength > maxBytes) throw new RepositoryReadError('REPO_TOO_LARGE', `${label} exceeds the M1a read limit.`)
    try {
      return {
        source: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        observation: { dev: opened.dev, ino: opened.ino, size: opened.size },
      }
    } catch {
      throw new RepositoryReadError('JOURNAL_INVALID_UTF8', `${label} is not valid UTF-8.`)
    }
  } catch (error) {
    if (errorCode(error) === 'ELOOP') {
      throw new RepositoryReadError('REPO_PATH_ESCAPE', `${label} must not be a symbolic link.`)
    }
    throw error
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The primary parse/boundary error, if any, is more actionable.
      }
    }
  }
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

function parseCanonicalLine(line: string, position: number): JsonValue {
  return parseCanonicalDocument(line, `journal record ${position}`, 'JOURNAL_NON_CANONICAL')
}

function parseCanonicalDocument(source: string, label: string, code: RepositoryErrorCode): JsonValue {
  if (source.includes('\r')) throw new RepositoryReadError(code, `${label} must use LF line endings.`)
  const body = source.endsWith('\n') ? source.slice(0, -1) : source
  if (body.endsWith('\n')) throw new RepositoryReadError(code, `${label} has unexpected blank trailing content.`)
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    throw new RepositoryReadError(code, `${label} is not valid JSON.`)
  }
  let canonical: string
  try {
    canonical = canonicalJson(parsed)
  } catch {
    throw new RepositoryReadError(code, `${label} contains a value outside lossless JSON.`)
  }
  if (canonical !== body) throw new RepositoryReadError(code, `${label} is not canonical JSON.`)
  return cloneJson(parsed as JsonValue)
}

function inside(root: string, ...parts: readonly string[]): string {
  const canonicalRoot = resolve(root)
  const target = resolve(canonicalRoot, ...parts)
  const pathFromRoot = relative(canonicalRoot, target)
  if (pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))) return target
  throw new RepositoryReadError('REPO_PATH_ESCAPE', 'Repository path escapes the registered workspace boundary.')
}

function isContainedBy(root: string, target: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(target))
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function sameFilesystemObject(before: Pick<Stats, 'dev' | 'ino'>, opened: Pick<Stats, 'dev' | 'ino'>): boolean {
  // Node reports a stable NTFS file index as `ino`. If a filesystem cannot
  // provide one, M1a cannot safely distinguish a replacement and fails closed.
  if (before.ino === 0 || opened.ino === 0) return false
  return before.dev === opened.dev && before.ino === opened.ino
}

function requireRecord(value: unknown, code: RepositoryErrorCode, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RepositoryReadError(code, message)
  return value as Record<string, unknown>
}

function requireString(value: unknown, code: RepositoryErrorCode, message: string): string {
  if (typeof value !== 'string') throw new RepositoryReadError(code, message)
  return value
}

function requireBoundedString(value: unknown, max: number, code: RepositoryErrorCode, message: string): string {
  const string = requireString(value, code, message)
  if (string.trim() === '' || string.length > max) throw new RepositoryReadError(code, message)
  return string
}

function requireHash(value: unknown, code: RepositoryErrorCode, message: string): Sha256Id {
  if (typeof value !== 'string' || !SHA256_ID.test(value)) throw new RepositoryReadError(code, message)
  return value as Sha256Id
}

function requireTimestamp(value: unknown, code: RepositoryErrorCode, message: string): string {
  const timestamp = requireString(value, code, message)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new RepositoryReadError(code, message)
  }
  return timestamp
}

function requireIssueId(value: unknown): string {
  const id = requireString(value, 'JOURNAL_EVENT_UNSUPPORTED', 'Issue id must be a string.')
  if (!ISSUE_ID.test(id)) throw new RepositoryReadError('JOURNAL_EVENT_UNSUPPORTED', 'Issue id has an invalid format.')
  return id
}

function normalizeKnowledgeKey(value: string): string {
  if (!KNOWLEDGE_KEY.test(value)) throw new RepositoryReadError('QUERY_LIMIT_EXCEEDED', 'Knowledge keys must use the M1a logical-key format.')
  return value
}

function normalizeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 250) {
    throw new RepositoryReadError('QUERY_LIMIT_EXCEEDED', 'limit must be an integer between 1 and 250.')
  }
  return value
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], code: RepositoryErrorCode, message: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new RepositoryReadError(code, message)
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], code: RepositoryErrorCode, message: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new RepositoryReadError(code, message)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code as string | undefined
    : undefined
}
