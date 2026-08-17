import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open as openFile, unlink } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { assertNotAborted, canonicalJson, cloneJson, sha256 } from './canonical.js'
import {
  RepositoryReader,
  RepositoryReadError,
  type RepositoryFileObservation,
  type RepositoryMutationState,
} from './repository.js'
import {
  COMMIT_FORMAT,
  REPOSITORY_FORMAT_VERSION,
  TREE_FORMAT,
  type CommitObject,
  type CommitSummary,
  type IssueRecord,
  type JsonValue,
  type RepositoryActor,
  type RepositoryComment,
  type Sha256Id,
  type TreeObject,
} from './types.js'

const MAX_JOURNAL_BYTES = 2 * 1024 * 1024
const MAX_TREE_ENTRIES = 1_000
const MAX_VALUE_BYTES = 64 * 1024
const MAX_MUTATIONS = 250
const KNOWLEDGE_KEY = /^[a-z][a-z0-9_.-]{0,127}$/

export type RepositoryWriteErrorCode =
  | 'INVALID_MUTATION'
  | 'REPO_BUSY'
  | 'REPO_PATH_ESCAPE'
  | 'REPO_WRITE_CONFLICT'
  | 'REPO_WRITE_IO'
  | 'REPO_WRITE_VERIFY_FAILED'
  | 'REPO_TOO_LARGE'

/** Sanitized failure raised by an explicit M1b repository mutation. */
export class RepositoryWriteError extends Error {
  constructor(readonly code: RepositoryWriteErrorCode, message: string) {
    super(message)
    this.name = 'RepositoryWriteError'
  }
}

export interface KnowledgeSetMutation {
  readonly key: string
  readonly value: JsonValue
}

export interface RepositoryCommitRequest {
  readonly message: string
  readonly set?: readonly KnowledgeSetMutation[]
  readonly delete?: readonly string[]
  readonly author: {
    readonly sessionId: string
    readonly messageId?: string
  }
}

export interface RepositoryRollbackRequest {
  readonly target: string
  readonly message: string
  readonly author: RepositoryCommitRequest['author']
}

export interface RepositoryCommentRequest {
  readonly body: string
  readonly mentions?: readonly string[]
  readonly author?: RepositoryActor
  readonly issueId?: string
}

export interface RepositoryIssueOpenRequest {
  readonly title: string
  readonly body?: string
  readonly labels?: readonly string[]
  readonly author: RepositoryActor
}

export interface RepositoryCommitChange {
  readonly key: string
  readonly kind: 'added' | 'deleted' | 'changed'
  readonly beforeHash?: Sha256Id
  readonly afterHash?: Sha256Id
}

export interface RepositoryCommitResult {
  readonly committed: boolean
  readonly head: Sha256Id | null
  readonly commit: CommitSummary | null
  readonly changes: readonly RepositoryCommitChange[]
  readonly journalEntries: number
  readonly knowledgeKeys: number
}

export interface RepositoryRollbackResult extends RepositoryCommitResult {
  /** Immutable commit that remains available as the pre-rollback backup. */
  readonly backupHead: Sha256Id | null
  /** Audited snapshot selector restored by the new rollback commit. */
  readonly restoredFrom: Sha256Id | null
}

interface LockLease {
  readonly path: string
  readonly handle: Awaited<ReturnType<typeof openFile>>
  readonly observation: RepositoryFileObservation
}

interface JournalRecord {
  readonly formatVersion: typeof REPOSITORY_FORMAT_VERSION
  readonly seq: number
  readonly type: 'commit.created'
  readonly ts: string
  readonly prev: Sha256Id
  readonly payload: {
    readonly commit: CommitObject
    readonly tree: TreeObject
  }
  readonly checksum: Sha256Id
}

/**
 * Explicit, lock-serialized append-only writer. It never initializes, scans,
 * adopts, or repairs a repository. A failed in-process append is truncated
 * back only to the exact verified pre-write size while the writer still owns
 * the same journal identity; crash recovery remains a later milestone.
 */
export class RepositoryWriter {
  static async commit(
    workspacePath: string,
    workspaceId: string,
    request: RepositoryCommitRequest,
    signal?: AbortSignal,
  ): Promise<RepositoryCommitResult> {
    const mutation = normalizeRequest(request)
    return withLockedRepository(workspacePath, workspaceId, signal, async (reader, state) => {
      const before = new Map(state.values.map(record => [record.key, cloneJson(record.value)]))
      const after = new Map(before)

      for (const entry of mutation.set) after.set(entry.key, cloneJson(entry.value))
      for (const key of mutation.delete) after.delete(key)

      return writeSnapshot(reader, state, before, after, {
        kind: 'normal',
        message: mutation.message,
        author: mutation.author,
        allowEmpty: false,
      }, signal)
    })
  }

  /**
   * Restore an immutable historical tree by appending a new audited commit.
   * Existing journal data is never truncated; the previous HEAD is the backup.
   */
  static async rollback(
    workspacePath: string,
    workspaceId: string,
    request: RepositoryRollbackRequest,
    signal?: AbortSignal,
  ): Promise<RepositoryRollbackResult> {
    const normalized = normalizeRollbackRequest(request)
    return withLockedRepository(workspacePath, workspaceId, signal, async (reader, state) => {
      const checkout = await reader.checkout(normalized.target, signal)
      const before = new Map(state.values.map(record => [record.key, cloneJson(record.value)]))
      const after = new Map(checkout.records.map(record => [record.key, cloneJson(record.value)]))
      const restoredFrom = checkout.commit?.id ?? null
      const result = await writeSnapshot(reader, state, before, after, {
        kind: 'rollback',
        restores: restoredFrom,
        message: normalized.message,
        author: normalized.author,
        allowEmpty: restoredFrom !== state.head,
      }, signal)
      return { ...result, backupHead: state.head, restoredFrom }
    })
  }

  /** Open one explicit issue without extracting or scanning session data. */
  static async openIssue(
    workspacePath: string,
    workspaceId: string,
    request: RepositoryIssueOpenRequest,
    signal?: AbortSignal,
  ): Promise<IssueRecord> {
    const normalized = normalizeIssueOpenRequest(request)
    return withLockedRepository(workspacePath, workspaceId, signal, async (reader, state) => {
      const createdAt = new Date().toISOString()
      const issue: IssueRecord = {
        id: `issue_${randomUUID()}`,
        title: normalized.title,
        body: normalized.body,
        status: 'open',
        labels: normalized.labels,
        openedBy: normalized.author,
        createdAt,
        updatedAt: createdAt,
      }
      const record = makeAuxiliaryRecord(state, 'issue.opened', {
        issue: cloneJson(cloneIssueRecord(issue) as unknown as JsonValue),
      }, createdAt)
      const line = checkedJournalLine(state, record)
      await appendAndVerify(reader, state, line, verified => {
        const persisted = verified.issues.find(value => value.id === issue.id)
        return verified.head === state.head
          && verified.values.length === state.values.length
          && verified.comments.length === state.comments.length
          && verified.issues.length === state.issues.length + 1
          && persisted !== undefined
          && canonicalJson(persisted) === canonicalJson(issue)
      }, signal)
      return cloneIssueRecord(issue)
    })
  }

  /** Persist one explicit administrator/agent comment before live delivery. */
  static async comment(
    workspacePath: string,
    workspaceId: string,
    request: RepositoryCommentRequest,
    signal?: AbortSignal,
  ): Promise<RepositoryComment> {
    const normalized = normalizeCommentRequest(request)
    return withLockedRepository(workspacePath, workspaceId, signal, async (reader, state) => {
      const createdAt = new Date().toISOString()
      const comment: RepositoryComment = {
        id: `comment_${randomUUID()}`,
        body: normalized.body,
        author: normalized.author,
        ...(normalized.issueId === undefined ? {} : { issueId: normalized.issueId }),
        mentions: normalized.mentions,
        deliveryRequestedTo: [],
        deliveredTo: [],
        createdAt,
      }
      if (comment.issueId !== undefined && !state.issues.some(issue => issue.id === comment.issueId)) {
        throw new RepositoryWriteError('INVALID_MUTATION', 'Repository comment issue does not exist.')
      }
      const record = makeAuxiliaryRecord(state, 'comment.created', {
        comment: {
          id: comment.id,
          body: comment.body,
          author: comment.author,
          mentions: [...comment.mentions],
          ...(comment.issueId === undefined ? {} : { issueId: comment.issueId }),
          createdAt,
        },
      }, createdAt)
      const line = checkedJournalLine(state, record)
      await appendAndVerify(reader, state, line, verified => {
        const persisted = verified.comments.find(value => value.id === comment.id)
        return verified.head === state.head
          && verified.values.length === state.values.length
          && verified.issues.length === state.issues.length
          && verified.comments.length === state.comments.length + 1
          && persisted !== undefined
          && canonicalJson(persisted) === canonicalJson(comment)
      }, signal)
      return comment
    })
  }

  /** Queue exact explicit mention targets durably before attempting any live relay. */
  static async markCommentDeliveryRequested(
    workspacePath: string,
    workspaceId: string,
    commentId: string,
    sessionIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<RepositoryComment> {
    const normalizedId = normalizeCommentId(commentId)
    const normalizedSessions = normalizeMentionIds(sessionIds, true)
    return withLockedRepository(workspacePath, workspaceId, signal, async (reader, state) => {
      const current = state.comments.find(comment => comment.id === normalizedId)
      if (current === undefined) throw new RepositoryWriteError('INVALID_MUTATION', 'Repository comment does not exist.')
      const mentioned = new Set(current.mentions)
      if (normalizedSessions.some(sessionId => !mentioned.has(sessionId))) {
        throw new RepositoryWriteError('INVALID_MUTATION', 'Only explicitly mentioned agents can be queued for delivery.')
      }
      const requested = new Set(current.deliveryRequestedTo)
      const pending = normalizedSessions.filter(sessionId => !requested.has(sessionId))
      if (pending.length === 0) return cloneRepositoryComment(current)
      const requestedAt = new Date().toISOString()
      const record = makeAuxiliaryRecord(state, 'comment.delivery.requested', {
        commentId: normalizedId,
        sessionIds: pending,
        requestedAt,
      }, requestedAt)
      const expected = { ...current, deliveryRequestedTo: [...current.deliveryRequestedTo, ...pending] }
      const line = checkedJournalLine(state, record)
      await appendAndVerify(reader, state, line, verified => {
        const persisted = verified.comments.find(comment => comment.id === normalizedId)
        return verified.head === state.head
          && verified.values.length === state.values.length
          && verified.issues.length === state.issues.length
          && verified.comments.length === state.comments.length
          && persisted !== undefined
          && canonicalJson(persisted) === canonicalJson(expected)
      }, signal)
      return cloneRepositoryComment(expected)
    })
  }

  /** Record successful live inbox acceptance for one comment's mention targets. */
  static async markCommentDelivered(
    workspacePath: string,
    workspaceId: string,
    commentId: string,
    sessionIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<RepositoryComment> {
    const normalizedId = normalizeCommentId(commentId)
    const normalizedSessions = normalizeMentionIds(sessionIds, true)
    return withLockedRepository(workspacePath, workspaceId, signal, async (reader, state) => {
      const current = state.comments.find(comment => comment.id === normalizedId)
      if (current === undefined) throw new RepositoryWriteError('INVALID_MUTATION', 'Repository comment does not exist.')
      const mentioned = new Set(current.mentions)
      if (normalizedSessions.some(sessionId => !mentioned.has(sessionId))) {
        throw new RepositoryWriteError('INVALID_MUTATION', 'Only explicitly mentioned agents can be marked delivered.')
      }
      const requested = new Set(current.deliveryRequestedTo)
      if (normalizedSessions.some(sessionId => !requested.has(sessionId))) {
        throw new RepositoryWriteError('INVALID_MUTATION', 'Comment delivery must be queued durably before it can be marked delivered.')
      }
      const delivered = new Set(current.deliveredTo)
      const pending = normalizedSessions.filter(sessionId => !delivered.has(sessionId))
      if (pending.length === 0) return cloneRepositoryComment(current)
      const deliveredAt = new Date().toISOString()
      const record = makeAuxiliaryRecord(state, 'comment.delivered', {
        commentId: normalizedId,
        sessionIds: pending,
        deliveredAt,
      }, deliveredAt)
      const expected = { ...current, deliveredTo: [...current.deliveredTo, ...pending] }
      const line = checkedJournalLine(state, record)
      await appendAndVerify(reader, state, line, verified => {
        const persisted = verified.comments.find(comment => comment.id === normalizedId)
        return verified.head === state.head
          && verified.values.length === state.values.length
          && verified.issues.length === state.issues.length
          && verified.comments.length === state.comments.length
          && persisted !== undefined
          && canonicalJson(persisted) === canonicalJson(expected)
      }, signal)
      return cloneRepositoryComment(expected)
    })
  }
}

async function withLockedRepository<T>(
  workspacePath: string,
  workspaceId: string,
  signal: AbortSignal | undefined,
  operation: (reader: RepositoryReader, state: RepositoryMutationState) => Promise<T>,
): Promise<T> {
  assertNotAborted(signal)
  const initialReader = await RepositoryReader.open(workspacePath, workspaceId, signal)
  if (initialReader === undefined) {
    throw new RepositoryReadError('REPO_NOT_INITIALIZED', 'No explicit repository exists for the current workspace.')
  }

  let lease: LockLease | undefined
  try {
    lease = await acquireLock(initialReader.lockPathForMutation(), signal)
    await initialReader.assertMutationRoot(signal)
    const reader = await RepositoryReader.open(workspacePath, workspaceId, signal)
    if (reader === undefined
      || reader.manifest.repoId !== initialReader.manifest.repoId
      || !sameFilesystemObject(reader.repositoryIdentityForMutation(), initialReader.repositoryIdentityForMutation())) {
      throw new RepositoryWriteError('REPO_WRITE_CONFLICT', 'Repository identity changed while the write lock was being acquired.')
    }
    const state = await reader.mutationState(signal)
    return await operation(reader, state)
  } catch (error) {
    if (error instanceof RepositoryWriteError || error instanceof RepositoryReadError || isAbortError(error)) throw error
    throw new RepositoryWriteError('REPO_WRITE_IO', 'Repository mutation could not complete safely.')
  } finally {
    if (lease !== undefined) await releaseLock(lease)
  }
}

async function writeSnapshot(
  reader: RepositoryReader,
  state: RepositoryMutationState,
  before: ReadonlyMap<string, JsonValue>,
  after: ReadonlyMap<string, JsonValue>,
  intent: {
    readonly kind: 'normal' | 'rollback'
    readonly restores?: Sha256Id | null
    readonly message: string
    readonly author: RepositoryCommitRequest['author']
    readonly allowEmpty: boolean
  },
  signal?: AbortSignal,
): Promise<RepositoryCommitResult> {
  if (after.size > MAX_TREE_ENTRIES) {
    throw new RepositoryWriteError('REPO_TOO_LARGE', `Commit would exceed ${MAX_TREE_ENTRIES} knowledge entries.`)
  }
  const changes = diffValues(before, after)
  if (changes.length === 0 && !intent.allowEmpty) {
    return {
      committed: false,
      head: state.head,
      commit: null,
      changes: [],
      journalEntries: state.journalEntries,
      knowledgeKeys: state.values.length,
    }
  }

  const createdAt = new Date().toISOString()
  const tree = makeTree(after)
  const commit = makeCommit(state.head, tree.id, intent, createdAt)
  const record = makeJournalRecord(state, commit, tree, createdAt)
  const line = checkedJournalLine(state, record)

  await appendAndVerify(reader, state, line, verified => verified.head === commit.id
    && verified.values.length === after.size
    && verified.issues.length === state.issues.length
    && verified.comments.length === state.comments.length, signal)
  return {
    committed: true,
    head: commit.id,
    commit: toCommitSummary(commit),
    changes,
    journalEntries: state.journalEntries + 1,
    knowledgeKeys: after.size,
  }
}

function normalizeRequest(request: RepositoryCommitRequest): Required<Omit<RepositoryCommitRequest, 'author'>> & {
  readonly author: RepositoryCommitRequest['author']
} {
  if (typeof request !== 'object' || request === null) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Commit request must be an object.')
  }
  if (typeof request.message !== 'string' || request.message.trim() === '' || request.message.length > 1_000) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Commit message must contain 1–1000 characters.')
  }
  if (!Array.isArray(request.set) && request.set !== undefined) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'set must be an array of key/value entries.')
  }
  if (!Array.isArray(request.delete) && request.delete !== undefined) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'delete must be an array of logical keys.')
  }
  const sets = request.set ?? []
  const deletes = request.delete ?? []
  if (sets.length + deletes.length === 0 || sets.length + deletes.length > MAX_MUTATIONS) {
    throw new RepositoryWriteError('INVALID_MUTATION', `A commit must contain 1–${MAX_MUTATIONS} mutations.`)
  }

  const seenSet = new Set<string>()
  const normalizedSet: KnowledgeSetMutation[] = []
  for (const entry of sets) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new RepositoryWriteError('INVALID_MUTATION', 'Each set mutation must be a key/value object.')
    }
    const keys = Object.keys(entry).sort()
    if (keys.length !== 2 || keys[0] !== 'key' || keys[1] !== 'value') {
      throw new RepositoryWriteError('INVALID_MUTATION', 'Each set mutation accepts only key and value.')
    }
    const key = normalizeKey(entry.key)
    if (seenSet.has(key)) throw new RepositoryWriteError('INVALID_MUTATION', `Logical key '${key}' is set more than once.`)
    let value: JsonValue
    try {
      value = cloneJson(entry.value)
    } catch {
      throw new RepositoryWriteError('INVALID_MUTATION', `Knowledge value '${key}' is not lossless JSON.`)
    }
    if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_VALUE_BYTES) {
      throw new RepositoryWriteError('REPO_TOO_LARGE', `Knowledge value '${key}' exceeds the value size limit.`)
    }
    seenSet.add(key)
    normalizedSet.push({ key, value })
  }

  const seenDelete = new Set<string>()
  const normalizedDelete = deletes.map((value) => {
    const key = normalizeKey(value)
    if (seenDelete.has(key)) throw new RepositoryWriteError('INVALID_MUTATION', `Logical key '${key}' is deleted more than once.`)
    if (seenSet.has(key)) throw new RepositoryWriteError('INVALID_MUTATION', `Logical key '${key}' cannot be set and deleted in one commit.`)
    seenDelete.add(key)
    return key
  })

  const author = request.author
  if (typeof author !== 'object' || author === null
    || typeof author.sessionId !== 'string' || author.sessionId.trim() === '' || author.sessionId.length > 256
    || (author.messageId !== undefined && (typeof author.messageId !== 'string' || author.messageId.trim() === '' || author.messageId.length > 256))) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Commit author identity is invalid.')
  }

  return {
    message: request.message,
    set: normalizedSet,
    delete: normalizedDelete,
    author: {
      sessionId: author.sessionId,
      ...(author.messageId === undefined ? {} : { messageId: author.messageId }),
    },
  }
}

function normalizeRollbackRequest(request: RepositoryRollbackRequest): RepositoryRollbackRequest {
  if (typeof request !== 'object' || request === null) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Rollback request must be an object.')
  }
  if (typeof request.target !== 'string' || request.target.trim() === '' || request.target.length > 128) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Rollback target must be ROOT, HEAD, or a full SHA-256 commit id.')
  }
  if (typeof request.message !== 'string' || request.message.trim() === '' || request.message.length > 1_000) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Rollback message must contain 1–1000 characters.')
  }
  const author = request.author
  if (typeof author !== 'object' || author === null
    || typeof author.sessionId !== 'string' || author.sessionId.trim() === '' || author.sessionId.length > 256
    || (author.messageId !== undefined && (typeof author.messageId !== 'string' || author.messageId.trim() === '' || author.messageId.length > 256))) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Rollback author identity is invalid.')
  }
  return {
    target: request.target,
    message: request.message,
    author: {
      sessionId: author.sessionId,
      ...(author.messageId === undefined ? {} : { messageId: author.messageId }),
    },
  }
}

function normalizeCommentRequest(request: RepositoryCommentRequest): {
  readonly body: string
  readonly mentions: readonly string[]
  readonly author: RepositoryActor
  readonly issueId?: string
} {
  if (typeof request !== 'object' || request === null) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Repository comment request must be an object.')
  }
  if (typeof request.body !== 'string' || request.body.trim() === '' || request.body.length > 16_000) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Repository comment body must contain 1–16000 characters.')
  }
  return {
    body: request.body,
    mentions: normalizeMentionIds(request.mentions ?? [], false),
    author: normalizeRepositoryActor(request.author ?? 'admin'),
    ...(request.issueId === undefined ? {} : { issueId: normalizeIssueId(request.issueId) }),
  }
}

function normalizeIssueOpenRequest(request: RepositoryIssueOpenRequest): {
  readonly title: string
  readonly body: string
  readonly labels: readonly string[]
  readonly author: RepositoryActor
} {
  if (typeof request !== 'object' || request === null) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Issue request must be an object.')
  }
  if (typeof request.title !== 'string' || request.title.trim() === '' || request.title.length > 1_000) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Issue title must contain 1–1000 characters.')
  }
  if (request.body !== undefined && (typeof request.body !== 'string' || request.body.length > 16_000)) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Issue body must contain at most 16000 characters.')
  }
  if (request.labels !== undefined && (!Array.isArray(request.labels) || request.labels.length > 20)) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Issue labels must be a bounded array.')
  }
  const labels = (request.labels ?? []).map((label) => {
    if (typeof label !== 'string' || label.trim() === '' || label.length > 120) {
      throw new RepositoryWriteError('INVALID_MUTATION', 'Issue label is invalid.')
    }
    return label
  })
  if (new Set(labels).size !== labels.length) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Issue labels must be unique.')
  }
  return {
    title: request.title,
    body: request.body ?? '',
    labels,
    author: normalizeRepositoryActor(request.author),
  }
}

function normalizeRepositoryActor(value: RepositoryActor): RepositoryActor {
  if (value === 'admin') return 'admin'
  if (typeof value !== 'object' || value === null || value.kind !== 'agent'
    || typeof value.sessionId !== 'string' || value.sessionId.trim() === '' || value.sessionId.length > 256) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Repository discussion author is invalid.')
  }
  return { kind: 'agent', sessionId: value.sessionId }
}

function normalizeMentionIds(values: readonly string[], requireNonEmpty: boolean): string[] {
  if (!Array.isArray(values) || values.length > 32 || (requireNonEmpty && values.length === 0)) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Comment mentions must be a bounded array of agent ids.')
  }
  const normalized = values.map((value) => {
    if (typeof value !== 'string' || value.trim() === '' || value.length > 256) {
      throw new RepositoryWriteError('INVALID_MUTATION', 'Comment mention agent id is invalid.')
    }
    return value
  })
  if (new Set(normalized).size !== normalized.length) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Comment mention agent ids must be unique.')
  }
  return normalized
}

function normalizeCommentId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(value)) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Repository comment id is invalid.')
  }
  return value
}

function normalizeIssueId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(value)) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Repository issue id is invalid.')
  }
  return value
}

async function acquireLock(path: string, signal?: AbortSignal): Promise<LockLease> {
  assertNotAborted(signal)
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  let ownedIdentity: Pick<Stats, 'dev' | 'ino'> | undefined
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    handle = await openFile(path, flags, 0o600)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino === 0) {
      throw new RepositoryWriteError('REPO_PATH_ESCAPE', 'Repository write lock could not be bound to a regular file identity.')
    }
    ownedIdentity = opened
    const lock = {
      formatVersion: REPOSITORY_FORMAT_VERSION,
      owner: `writer_${randomUUID()}`,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }
    await handle.writeFile(`${canonicalJson(lock)}\n`, 'utf8')
    await handle.sync()
    const current = await lstat(path)
    if (current.isSymbolicLink() || !current.isFile() || !sameFilesystemObject(opened, current)) {
      throw new RepositoryWriteError('REPO_PATH_ESCAPE', 'Repository write lock changed during acquisition.')
    }
    assertNotAborted(signal)
    return {
      path,
      handle,
      observation: { dev: opened.dev, ino: opened.ino, size: current.size },
    }
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // Preserve the primary lock error.
      }
    }
    if (ownedIdentity !== undefined) {
      try {
        const current = await lstat(path)
        if (!current.isSymbolicLink() && current.isFile() && sameFilesystemObject(current, ownedIdentity)) {
          await unlink(path)
        }
      } catch {
        // An unexpected replacement stays untouched; the primary error wins.
      }
    }
    if (errorCode(error) === 'EEXIST') {
      throw new RepositoryWriteError('REPO_BUSY', 'Repository already has an active or unrecovered writer lock.')
    }
    if (errorCode(error) === 'ELOOP') {
      throw new RepositoryWriteError('REPO_PATH_ESCAPE', 'Repository write lock must not be a symbolic link.')
    }
    throw error
  }
}

async function releaseLock(lease: LockLease): Promise<void> {
  try {
    await lease.handle.close()
  } catch {
    // Continue with identity-checked cleanup; a completed commit remains valid.
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const current = await lstat(lease.path)
      if (current.isSymbolicLink() || !current.isFile() || !sameObservation(current, lease.observation)) return
      await unlink(lease.path)
      return
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      if (attempt < 2) await delay(10 * (attempt + 1))
      // Fail closed after bounded retries by leaving an unexpected lock path
      // untouched. A synced commit must not be misreported as failed.
    }
  }
}

async function appendAndVerify(
  reader: RepositoryReader,
  state: RepositoryMutationState,
  line: string,
  verify: (state: RepositoryMutationState) => boolean,
  signal?: AbortSignal,
): Promise<void> {
  const path = reader.journalPathForMutation()
  assertNotAborted(signal)
  await reader.assertMutationRoot(signal)
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  let appendStarted = false
  const lineBytes = Buffer.from(line, 'utf8')
  const expectedSize = state.journal.size + lineBytes.byteLength
  try {
    const flags = constants.O_RDWR | constants.O_APPEND
      | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    handle = await openFile(path, flags)
    const opened = await handle.stat()
    const current = await lstat(path)
    if (!opened.isFile() || current.isSymbolicLink() || !current.isFile()
      || !sameObservation(opened, state.journal) || !sameObservation(current, state.journal)) {
      throw new RepositoryWriteError('REPO_WRITE_CONFLICT', 'Repository journal changed before the commit could be appended.')
    }
    await reader.assertMutationRoot(signal)

    // Cancellation observed after this point cannot honestly be reported as a
    // pre-write abort, so the complete append and verification run uncancelled.
    assertNotAborted(signal)
    appendStarted = true
    await handle.writeFile(line, 'utf8')
    await handle.sync()
    const written = await handle.stat()
    if (!sameFilesystemObject(opened, written) || written.size !== expectedSize) {
      throw new RepositoryWriteError('REPO_WRITE_CONFLICT', 'Repository journal size or identity changed during append.')
    }
    await reader.assertMutationRoot()

    try {
      const verified = await reader.mutationState()
      if (verified.journalEntries !== state.journalEntries + 1
        || verified.journal.size !== expectedSize
        || !sameObservation(written, verified.journal)
        || !verify(verified)) {
        throw new Error('post-append repository state mismatch')
      }
    } catch {
      const restored = await restoreOriginalSize(handle, opened, state.journal.size, expectedSize, lineBytes)
      if (!restored) {
        throw new RepositoryWriteError('REPO_WRITE_CONFLICT', 'Commit verification failed after an externally conflicting journal change; the journal was left untouched.')
      }
      throw new RepositoryWriteError('REPO_WRITE_VERIFY_FAILED', 'Commit append was rejected by repository replay and rolled back to the verified pre-write size.')
    }
  } catch (error) {
    if (appendStarted && handle !== undefined && !(error instanceof RepositoryWriteError && error.code === 'REPO_WRITE_VERIFY_FAILED')) {
      await restoreOriginalSize(handle, state.journal, state.journal.size, expectedSize, lineBytes)
    }
    if (errorCode(error) === 'ELOOP') {
      throw new RepositoryWriteError('REPO_PATH_ESCAPE', 'Repository journal must not be a symbolic link.')
    }
    throw error
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The synced journal observation is authoritative.
      }
    }
  }
}

async function restoreOriginalSize(
  handle: Awaited<ReturnType<typeof openFile>>,
  expectedIdentity: RepositoryFileObservation | Stats,
  originalSize: number,
  expectedSize: number,
  attemptedBytes: Buffer,
): Promise<boolean> {
  try {
    const current = await handle.stat()
    if (!sameFilesystemObject(current, expectedIdentity) || current.size > expectedSize || current.size < originalSize) return false
    if (current.size !== originalSize) {
      const suffixLength = current.size - originalSize
      if (suffixLength > attemptedBytes.byteLength) return false
      const suffix = Buffer.allocUnsafe(suffixLength)
      const read = await handle.read(suffix, 0, suffixLength, originalSize)
      if (read.bytesRead !== suffixLength || !suffix.equals(attemptedBytes.subarray(0, suffixLength))) return false
      await handle.truncate(originalSize)
      await handle.sync()
    }
    const restored = await handle.stat()
    return sameFilesystemObject(restored, expectedIdentity) && restored.size === originalSize
  } catch {
    return false
  }
}

function makeTree(values: ReadonlyMap<string, JsonValue>): TreeObject {
  const entries = [...values.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => ({ key, value: cloneJson(value), valueHash: hashId(value) }))
  const body = { format: TREE_FORMAT, formatVersion: REPOSITORY_FORMAT_VERSION, entries }
  return { ...body, id: hashId(body) }
}

function makeCommit(
  parent: Sha256Id | null,
  tree: Sha256Id,
  intent: {
    readonly kind: 'normal' | 'rollback'
    readonly restores?: Sha256Id | null
    readonly message: string
    readonly author: RepositoryCommitRequest['author']
  },
  createdAt: string,
): CommitObject {
  const base = {
    format: COMMIT_FORMAT,
    formatVersion: REPOSITORY_FORMAT_VERSION,
    parent,
    tree,
    message: intent.message,
    author: intent.author,
    createdAt,
  }
  const body = intent.kind === 'normal'
    ? { ...base, kind: 'normal' as const }
    : { ...base, kind: 'rollback' as const, restores: intent.restores ?? null }
  return { ...body, id: hashId(body) }
}

function makeJournalRecord(
  state: RepositoryMutationState,
  commit: CommitObject,
  tree: TreeObject,
  createdAt: string,
): JournalRecord {
  const unsigned = {
    formatVersion: REPOSITORY_FORMAT_VERSION,
    seq: state.journalEntries + 1,
    type: 'commit.created' as const,
    ts: createdAt,
    prev: state.tailChecksum,
    payload: { commit, tree },
  }
  return { ...unsigned, checksum: hashId(unsigned) }
}

function makeAuxiliaryRecord(
  state: RepositoryMutationState,
  type: 'issue.opened' | 'comment.created' | 'comment.delivery.requested' | 'comment.delivered',
  payload: JsonValue,
  createdAt: string,
): {
  readonly formatVersion: typeof REPOSITORY_FORMAT_VERSION
  readonly seq: number
  readonly type: 'issue.opened' | 'comment.created' | 'comment.delivery.requested' | 'comment.delivered'
  readonly ts: string
  readonly prev: Sha256Id
  readonly payload: JsonValue
  readonly checksum: Sha256Id
} {
  const unsigned = {
    formatVersion: REPOSITORY_FORMAT_VERSION,
    seq: state.journalEntries + 1,
    type,
    ts: createdAt,
    prev: state.tailChecksum,
    payload,
  }
  return { ...unsigned, checksum: hashId(unsigned) }
}

function checkedJournalLine(state: RepositoryMutationState, record: unknown): string {
  const line = `${canonicalJson(record)}\n`
  if (state.journal.size + Buffer.byteLength(line, 'utf8') > MAX_JOURNAL_BYTES) {
    throw new RepositoryWriteError('REPO_TOO_LARGE', 'Mutation would exceed the current journal size limit.')
  }
  return line
}

function diffValues(before: ReadonlyMap<string, JsonValue>, after: ReadonlyMap<string, JsonValue>): RepositoryCommitChange[] {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort()
  const changes: RepositoryCommitChange[] = []
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
  return changes
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

function cloneRepositoryComment(comment: RepositoryComment): RepositoryComment {
  return {
    id: comment.id,
    body: comment.body,
    author: cloneRepositoryActor(comment.author),
    ...(comment.issueId === undefined ? {} : { issueId: comment.issueId }),
    mentions: [...comment.mentions],
    deliveryRequestedTo: [...comment.deliveryRequestedTo],
    deliveredTo: [...comment.deliveredTo],
    createdAt: comment.createdAt,
  }
}

function cloneIssueRecord(issue: IssueRecord): IssueRecord {
  return {
    id: issue.id,
    title: issue.title,
    body: issue.body,
    status: issue.status,
    labels: [...issue.labels],
    ...(issue.assignee === undefined ? {} : { assignee: issue.assignee }),
    ...(issue.openedBy === undefined ? {} : { openedBy: cloneRepositoryActor(issue.openedBy) }),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  }
}

function cloneRepositoryActor(actor: RepositoryActor): RepositoryActor {
  return actor === 'admin' ? 'admin' : { kind: 'agent', sessionId: actor.sessionId }
}

function normalizeKey(value: unknown): string {
  if (typeof value !== 'string' || !KNOWLEDGE_KEY.test(value)) {
    throw new RepositoryWriteError('INVALID_MUTATION', 'Knowledge keys must match [a-z][a-z0-9_.-]{0,127}.')
  }
  return value
}

function hashId(value: unknown): Sha256Id {
  return `sha256:${sha256(value)}` as Sha256Id
}

function sameFilesystemObject(left: Pick<Stats, 'dev' | 'ino'>, right: Pick<Stats, 'dev' | 'ino'> | RepositoryFileObservation): boolean {
  return left.ino !== 0 && right.ino !== 0 && left.dev === right.dev && left.ino === right.ino
}

function sameObservation(left: Pick<Stats, 'dev' | 'ino' | 'size'> | RepositoryFileObservation, right: RepositoryFileObservation): boolean {
  return sameFilesystemObject(left, right) && left.size === right.size
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code as string | undefined
    : undefined
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}
