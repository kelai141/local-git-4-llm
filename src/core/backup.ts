import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import {
  lstat,
  mkdir,
  open as openFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertNotAborted, canonicalJson, cloneJson, sha256 } from './canonical.js'
import { RepositoryReader, RepositoryReadError, type RepositoryFileObservation } from './repository.js'
import { REPOSITORY_FORMAT_VERSION, type JsonValue, type Sha256Id } from './types.js'

export const FILE_BACKUP_FORMAT_VERSION = 1 as const
export const FILE_BACKUP_CONFIG_FORMAT = 'local-git-4-llm/file-backup-config' as const
export const FILE_BACKUP_MANIFEST_FORMAT = 'local-git-4-llm/file-backup-manifest' as const
export const FILE_BACKUP_SNAPSHOT_FORMAT = 'local-git-4-llm/file-backup-snapshot' as const

const REPOSITORY_DIR = '.dsh-repo'
const BACKUP_DIR = 'backup'
const MAX_BACKUP_JOURNAL_BYTES = 2 * 1024 * 1024
const MAX_BACKUP_JOURNAL_LINES = 10_000
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024
const MAX_OBJECT_STORE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_FILES = 10_000
const MAX_SNAPSHOTS = 100
const MAX_DEPTH = 32
const MAX_PATH_BYTES = 1_024
const MAX_ROOTS = 16
const MIN_INTERVAL_MINUTES = 5
const MAX_INTERVAL_MINUTES = 1_440
const DEFAULT_INTERVAL_MINUTES = 15
const MAX_PREVIEW_BYTES = 64 * 1024
const MAX_OBJECT_JSON_BYTES = 4 * 1024 * 1024
const MAX_DIFF_MATRIX_CELLS = 1_000_000
const MAX_DIFF_OUTPUT_LINES = 2_000
const DIFF_CONTEXT_LINES = 3
const SHA256_ID = /^sha256:[a-f0-9]{64}$/u
const EXPORT_ID = /^export_[A-Za-z0-9_-]{8,120}$/u

const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.dsh-repo',
  '.aws',
  '.azure',
  '.docker',
  '.git',
  '.gnupg',
  '.hg',
  '.kube',
  '.ssh',
  '.svn',
  '.cache',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'temp',
  'tmp',
  'venv',
])

const EXCLUDED_FILE_NAMES = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
])

export type FileBackupErrorCode =
  | 'BACKUP_NOT_CONFIGURED'
  | 'BACKUP_DISABLED'
  | 'BACKUP_INVALID_CONFIG'
  | 'BACKUP_BUSY'
  | 'BACKUP_PATH_ESCAPE'
  | 'BACKUP_SOURCE_UNSAFE'
  | 'BACKUP_LIMIT_EXCEEDED'
  | 'BACKUP_CORRUPT'
  | 'BACKUP_CONFLICT'
  | 'BACKUP_IO'
  | 'BACKUP_SNAPSHOT_NOT_FOUND'
  | 'BACKUP_FILE_NOT_FOUND'

/** Sanitized physical-file backup failure. Host paths never appear in messages. */
export class FileBackupError extends Error {
  constructor(readonly code: FileBackupErrorCode, message: string) {
    super(message)
    this.name = 'FileBackupError'
  }
}

export type FileBackupScope =
  | { readonly kind: 'selected'; readonly roots: readonly string[] }
  | { readonly kind: 'workspace' }

export interface FileBackupEnableRequest {
  readonly scope: FileBackupScope
  readonly intervalMinutes?: number
  /** Explicit acknowledgement that selected source files may contain secrets. */
  readonly confirmSensitiveRisk: true
}

export interface FileBackupRootCandidate {
  readonly path: string
  readonly kind: 'file' | 'directory'
}

export interface FileBackupConfig {
  readonly format: typeof FILE_BACKUP_CONFIG_FORMAT
  readonly formatVersion: typeof FILE_BACKUP_FORMAT_VERSION
  readonly repoId: string
  readonly workspaceId: string
  readonly scope: FileBackupScope
  readonly schedule: { readonly kind: 'interval'; readonly minutes: number }
  readonly exclusions: { readonly policy: 'safe-defaults-v1' }
  readonly limits: {
    readonly maxFileBytes: number
    readonly maxFiles: number
    readonly maxSnapshotBytes: number
    readonly maxSnapshots: number
  }
  readonly createdAt: string
  readonly updatedAt: string
}

export interface FileBackupEntry {
  readonly path: string
  readonly size: number
  readonly mode: number
  readonly mtimeMs: number
  readonly blob: Sha256Id
}

export interface FileBackupManifest {
  readonly format: typeof FILE_BACKUP_MANIFEST_FORMAT
  readonly formatVersion: typeof FILE_BACKUP_FORMAT_VERSION
  readonly entries: readonly FileBackupEntry[]
}

export type FileBackupReason = 'initial' | 'scheduled' | 'manual' | 'pre-restore'

export interface FileBackupSnapshot {
  readonly format: typeof FILE_BACKUP_SNAPSHOT_FORMAT
  readonly formatVersion: typeof FILE_BACKUP_FORMAT_VERSION
  readonly repoId: string
  readonly workspaceId: string
  readonly parent: Sha256Id | null
  readonly config: Sha256Id
  readonly manifest: Sha256Id
  readonly reason: FileBackupReason
  readonly capturedAt: string
  readonly repositoryHead: Sha256Id | null
  readonly fileCount: number
  readonly totalBytes: number
  readonly ignoredFiles: number
}

export interface FileBackupSnapshotSummary {
  readonly id: Sha256Id
  readonly parent: Sha256Id | null
  readonly reason: FileBackupReason
  readonly capturedAt: string
  readonly repositoryHead: Sha256Id | null
  readonly fileCount: number
  readonly totalBytes: number
  readonly ignoredFiles: number
}

export interface FileBackupStatus {
  readonly configured: boolean
  readonly enabled: boolean
  readonly integrity: 'ok'
  readonly journalEntries: number
  readonly config?: {
    readonly id: Sha256Id
    readonly scope: FileBackupScope
    readonly intervalMinutes: number
    readonly exclusions: 'safe-defaults-v1'
  }
  readonly snapshots: number
  readonly latest?: FileBackupSnapshotSummary
  readonly nextCaptureAt?: string
}

export interface FileBackupCaptureResult {
  readonly created: boolean
  readonly snapshot: FileBackupSnapshotSummary | null
  readonly status: FileBackupStatus
}

export interface FileBackupCheckout {
  readonly snapshot: FileBackupSnapshotSummary
  readonly records: readonly FileBackupEntry[]
  readonly nextCursor?: string
  readonly truncated: boolean
}

export interface FileBackupPreview {
  readonly snapshotId: Sha256Id
  readonly path: string
  readonly size: number
  readonly blob: Sha256Id
  readonly encoding: 'utf8' | 'binary' | 'too-large'
  readonly content?: string
}

export interface FileBackupExportResult {
  readonly exportId: string
  readonly snapshotId: Sha256Id
  readonly relativePath: string
  readonly fileCount: number
  readonly totalBytes: number
}

export type FileBackupChangeKind = 'added' | 'modified' | 'deleted'

export interface FileBackupChange {
  readonly path: string
  readonly kind: FileBackupChangeKind
  readonly before?: FileBackupEntry
  readonly after?: FileBackupEntry
}

export interface FileBackupComparison {
  readonly base: FileBackupSnapshotSummary | null
  readonly head: FileBackupSnapshotSummary | null
  readonly changes: readonly FileBackupChange[]
  readonly counts: { readonly added: number; readonly modified: number; readonly deleted: number }
  readonly truncated: boolean
  readonly nextCursor?: string
}

export interface FileBackupDiffLine {
  readonly kind: 'context' | 'added' | 'deleted' | 'separator'
  readonly beforeLine?: number
  readonly afterLine?: number
  readonly content?: string
  readonly lineBreak?: boolean
}

export interface FileBackupFileDiff {
  readonly baseSnapshotId: Sha256Id | null
  readonly headSnapshotId: Sha256Id | null
  readonly path: string
  readonly kind: FileBackupChangeKind
  readonly before?: Pick<FileBackupEntry, 'size' | 'mode' | 'blob'>
  readonly after?: Pick<FileBackupEntry, 'size' | 'mode' | 'blob'>
  readonly display: 'text' | 'binary' | 'too-large' | 'metadata-only'
  readonly lines: readonly FileBackupDiffLine[]
  readonly truncated: boolean
}

/** @internal Deterministic boundary observation for repository tests only. */
export interface FileBackupTestHooks {
  readonly checkpoint?: (
    name: 'capture-lock-acquired' | 'object-created' | 'export-before-publish' | 'export-published',
  ) => void | Promise<void>
}

interface BackupContext {
  readonly workspaceRoot: string
  readonly repositoryRoot: string
  readonly backupRoot: string
  readonly workspaceId: string
  readonly repoId: string
  readonly repositoryHead: Sha256Id | null
  readonly reader: RepositoryReader
  readonly repositoryIdentity: DirectoryObservation
}

interface DirectoryObservation {
  readonly dev: number
  readonly ino: number
}

interface BackupJournalRecord {
  readonly formatVersion: typeof FILE_BACKUP_FORMAT_VERSION
  readonly seq: number
  readonly type: string
  readonly ts: string
  readonly prev: Sha256Id | null
  readonly payload: JsonValue
  readonly checksum: Sha256Id
}

interface BackupState {
  readonly journalEntries: number
  readonly tailChecksum: Sha256Id
  readonly journal: RepositoryFileObservation
  readonly backupIdentity: DirectoryObservation
  readonly enabled: boolean
  readonly configId?: Sha256Id
  readonly config?: FileBackupConfig
  readonly snapshots: readonly { readonly id: Sha256Id; readonly snapshot: FileBackupSnapshot }[]
}

interface SourceObservation {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly mode: number
}

interface CaptureDraft {
  readonly manifest: FileBackupManifest
  readonly ignoredFiles: number
  readonly totalBytes: number
}

interface BackupLockLease {
  readonly path: string
  readonly handle: Awaited<ReturnType<typeof openFile>>
  readonly observation: RepositoryFileObservation
}

/**
 * Explicitly enabled, workspace-local physical-file backup repository.
 * Logical key/value history stays in the original journal; physical backup
 * uses an independent checksum journal and immutable content-addressed objects.
 */
export class FileBackupRepository {
  /** Lightweight scheduler bootstrap check; never opens the main journal or scans source files. */
  static async hasBackupMarker(workspacePath: string, signal?: AbortSignal): Promise<boolean> {
    assertNotAborted(signal)
    let workspaceRoot: string
    try {
      workspaceRoot = await realpath(workspacePath)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      throw error
    }
    const repositoryPath = inside(workspaceRoot, REPOSITORY_DIR)
    const backupPath = inside(repositoryPath, BACKUP_DIR)
    const journalPath = inside(backupPath, 'journal.jsonl')
    try {
      const repository = await lstat(repositoryPath)
      if (repository.isSymbolicLink() || !repository.isDirectory()) return true
      const backup = await lstat(backupPath)
      if (backup.isSymbolicLink() || !backup.isDirectory()) return true
      await lstat(journalPath)
      return true
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      throw error
    }
  }

  static async status(workspacePath: string, workspaceId: string, signal?: AbortSignal): Promise<FileBackupStatus> {
    const context = await resolveBackupContext(workspacePath, workspaceId, signal)
    if (!await backupRootExists(context, signal)) return emptyStatus()
    const state = await readBackupState(context, signal)
    const latest = state.snapshots.at(-1)
    if (latest !== undefined) {
      assertSnapshotManifest(latest.snapshot, await readManifest(context, latest.snapshot.manifest, signal))
    }
    return statusView(state)
  }

  /** Enumerate one safe directory level for the human management panel. */
  static async listRootCandidates(
    workspacePath: string,
    workspaceId: string,
    parent = '',
    signal?: AbortSignal,
  ): Promise<readonly FileBackupRootCandidate[]> {
    const context = await resolveBackupContext(workspacePath, workspaceId, signal)
    const normalizedParent = parent === '' ? '' : normalizeRelativePath(parent)
    const parentPath = normalizedParent === ''
      ? context.workspaceRoot
      : inside(context.workspaceRoot, ...normalizedParent.split('/'))
    if (normalizedParent !== '') {
      assertAllowedRoot(normalizedParent)
      let parentItem: Stats
      let canonicalParent: string
      try {
        parentItem = await lstat(parentPath)
        canonicalParent = await realpath(parentPath)
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          throw new FileBackupError('BACKUP_CONFLICT', '面板目录已被移动或删除，请刷新后重试。')
        }
        throw error
      }
      if (parentItem.isSymbolicLink() || !parentItem.isDirectory()
        || !isContainedBy(context.workspaceRoot, canonicalParent)) {
        throw new FileBackupError('BACKUP_SOURCE_UNSAFE', '面板目录选择器拒绝不安全的父目录。')
      }
    }
    const names = await readdir(parentPath)
    names.sort(compareCodePoint)
    const candidates: FileBackupRootCandidate[] = []
    for (const name of names) {
      assertNotAborted(signal)
      if (isExcludedDirectory(name) || isExcludedFile(name)) continue
      const relativePath = normalizedParent === '' ? name : `${normalizedParent}/${name}`
      const path = inside(context.workspaceRoot, ...relativePath.split('/'))
      let item: Stats
      let canonical: string
      try {
        item = await lstat(path)
        canonical = await realpath(path)
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue
        throw error
      }
      if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) continue
      if (!isContainedBy(context.workspaceRoot, canonical)) continue
      candidates.push({ path: normalizeRelativePath(relativePath), kind: item.isDirectory() ? 'directory' : 'file' })
      if (candidates.length >= 250) break
    }
    return candidates
  }

  static async describeRootCandidate(
    workspacePath: string,
    workspaceId: string,
    root: string,
    signal?: AbortSignal,
  ): Promise<FileBackupRootCandidate> {
    const context = await resolveBackupContext(workspacePath, workspaceId, signal)
    const normalized = normalizeRelativePath(root)
    assertAllowedRoot(normalized)
    const path = inside(context.workspaceRoot, ...normalized.split('/'))
    let item: Stats
    let canonical: string
    try {
      item = await lstat(path)
      canonical = await realpath(path)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        throw new FileBackupError('BACKUP_CONFLICT', '面板备份根已被移动或删除，请刷新后重试。')
      }
      throw error
    }
    if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())
      || !isContainedBy(context.workspaceRoot, canonical)) {
      throw new FileBackupError('BACKUP_SOURCE_UNSAFE', '面板备份根已失效或不安全。')
    }
    return { path: normalized, kind: item.isDirectory() ? 'directory' : 'file' }
  }

  static async enable(
    workspacePath: string,
    workspaceId: string,
    request: FileBackupEnableRequest,
    signal?: AbortSignal,
  ): Promise<FileBackupStatus> {
    const context = await resolveBackupContext(workspacePath, workspaceId, signal)
    const normalized = normalizeEnableRequest(request)
    await ensureBackupRoot(context, signal)
    return withBackupLock(context, signal, async (locked, state) => {
      if (state.enabled && state.config !== undefined
        && state.config.schedule.minutes === normalized.intervalMinutes
        && sameBackupScope(state.config.scope, normalized.scope)) {
        return statusView(state)
      }
      const now = new Date().toISOString()
      const createdAt = state.config?.createdAt ?? now
      const config: FileBackupConfig = {
        format: FILE_BACKUP_CONFIG_FORMAT,
        formatVersion: FILE_BACKUP_FORMAT_VERSION,
        repoId: locked.repoId,
        workspaceId: locked.workspaceId,
        scope: normalized.scope,
        schedule: { kind: 'interval', minutes: normalized.intervalMinutes },
        exclusions: { policy: 'safe-defaults-v1' },
        limits: {
          maxFileBytes: MAX_FILE_BYTES,
          maxFiles: MAX_FILES,
          maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
          maxSnapshots: MAX_SNAPSHOTS,
        },
        createdAt,
        updatedAt: now,
      }
      const configId = await writeJsonObject(locked, config, signal)
      if (state.enabled && state.configId === configId) return statusView(state)
      const next = await appendBackupEvent(locked, state, 'backup.configured', { config: configId }, signal)
      return statusView(next)
    })
  }

  static async disable(
    workspacePath: string,
    workspaceId: string,
    reason = 'user',
    signal?: AbortSignal,
  ): Promise<FileBackupStatus> {
    const context = await resolveBackupContext(workspacePath, workspaceId, signal)
    if (!await backupRootExists(context, signal)) return emptyStatus()
    return withBackupLock(context, signal, async (locked, state) => {
      if (!state.enabled) return statusView(state)
      const next = await appendBackupEvent(locked, state, 'backup.disabled', { reason: normalizeReason(reason) }, signal)
      return statusView(next)
    })
  }

  static async capture(
    workspacePath: string,
    workspaceId: string,
    reason: FileBackupReason = 'manual',
    signal?: AbortSignal,
    testHooks?: FileBackupTestHooks,
  ): Promise<FileBackupCaptureResult> {
    const context = await resolveBackupContext(workspacePath, workspaceId, signal)
    if (!await backupRootExists(context, signal)) {
      throw new FileBackupError('BACKUP_NOT_CONFIGURED', '此仓库尚未配置文件备份。')
    }
    let captureLease: BackupLockLease | undefined
    try {
      captureLease = await acquireBackupLock(inside(context.backupRoot, 'capture.lock'), signal)
      await testHooks?.checkpoint?.('capture-lock-acquired')
      assertNotAborted(signal)
      const before = await readBackupState(context, signal)
      if (!before.enabled || before.config === undefined || before.configId === undefined) {
        throw new FileBackupError('BACKUP_DISABLED', '此仓库的文件自动备份尚未启用。')
      }
      if (before.snapshots.length >= MAX_SNAPSHOTS) {
        throw new FileBackupError('BACKUP_LIMIT_EXCEEDED', `文件快照已达到 ${MAX_SNAPSHOTS} 个上限；v1 不会自动删除历史。`)
      }
      const storedBefore = await measureObjectStore(context, signal)
      if (storedBefore + MAX_SNAPSHOT_BYTES > MAX_OBJECT_STORE_BYTES) {
        throw new FileBackupError('BACKUP_LIMIT_EXCEEDED', '文件备份对象库接近 2 GiB 上限；v1 不会自动删除历史。')
      }
      const configId = before.configId
      const draft = await captureSource(context, before.config, signal, testHooks)
      const storedAfter = await measureObjectStore(context)
      if (storedAfter > MAX_OBJECT_STORE_BYTES) {
        throw new FileBackupError('BACKUP_LIMIT_EXCEEDED', '文件备份对象库超过 2 GiB 上限，本次快照未发布。')
      }
      return await withBackupLock(context, signal, async (locked, state) => {
        if (!state.enabled || state.config === undefined || state.configId !== configId) {
          throw new FileBackupError('BACKUP_CONFLICT', '备份配置在扫描期间发生变化，本次快照未发布。')
        }
        if (state.snapshots.length >= MAX_SNAPSHOTS) {
          throw new FileBackupError('BACKUP_LIMIT_EXCEEDED', `文件快照已达到 ${MAX_SNAPSHOTS} 个上限；v1 不会自动删除历史。`)
        }
        const latest = state.snapshots.at(-1)
        if (latest !== undefined) {
          const latestManifest = await readManifest(locked, latest.snapshot.manifest, signal)
          assertSnapshotManifest(latest.snapshot, latestManifest)
          if (sameBackupContent(latestManifest, draft.manifest)) {
            return { created: false, snapshot: snapshotSummary(latest.id, latest.snapshot), status: statusView(state) }
          }
        } else if (draft.manifest.entries.length === 0) {
          return { created: false, snapshot: null, status: statusView(state) }
        }
        const manifestId = await writeJsonObject(locked, draft.manifest, signal)
        const capturedAt = new Date().toISOString()
        const snapshot: FileBackupSnapshot = {
          format: FILE_BACKUP_SNAPSHOT_FORMAT,
          formatVersion: FILE_BACKUP_FORMAT_VERSION,
          repoId: locked.repoId,
          workspaceId: locked.workspaceId,
          parent: latest?.id ?? null,
          config: configId,
          manifest: manifestId,
          reason,
          capturedAt,
          repositoryHead: locked.repositoryHead,
          fileCount: draft.manifest.entries.length,
          totalBytes: draft.totalBytes,
          ignoredFiles: draft.ignoredFiles,
        }
        const snapshotId = await writeJsonObject(locked, snapshot, signal)
        const next = await appendBackupEvent(locked, state, 'backup.snapshot.created', { snapshot: snapshotId }, signal)
        return { created: true, snapshot: snapshotSummary(snapshotId, snapshot), status: statusView(next) }
      })
    } finally {
      if (captureLease !== undefined) await releaseBackupLock(captureLease)
    }
  }

  static async checkout(
    workspacePath: string,
    workspaceId: string,
    selector: string = 'LATEST',
    limit = 100,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<FileBackupCheckout> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
      throw new FileBackupError('BACKUP_INVALID_CONFIG', '文件列表 limit 必须在 1–250 之间。')
    }
    const context = await resolveBackupContext(workspacePath, workspaceId, signal)
    if (!await backupRootExists(context, signal)) {
      throw new FileBackupError('BACKUP_NOT_CONFIGURED', '此仓库尚未配置文件备份。')
    }
    const state = await readBackupState(context, signal)
    const selected = selectSnapshot(state, selector)
    const manifest = await readManifest(context, selected.snapshot.manifest, signal)
    assertSnapshotManifest(selected.snapshot, manifest)
    let start = 0
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || cursor.length > MAX_PATH_BYTES) {
        throw new FileBackupError('BACKUP_INVALID_CONFIG', '文件列表 cursor 无效。')
      }
      while (start < manifest.entries.length && manifest.entries[start]!.path <= cursor) start += 1
    }
    const records = manifest.entries.slice(start, start + limit)
    const truncated = start + records.length < manifest.entries.length
    return {
      snapshot: snapshotSummary(selected.id, selected.snapshot),
      records,
      ...(truncated && records.length > 0 ? { nextCursor: records.at(-1)!.path } : {}),
      truncated,
    }
  }

  static async history(
    workspacePath: string,
    workspaceId: string,
    limit = 100,
    signal?: AbortSignal,
  ): Promise<readonly FileBackupSnapshotSummary[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SNAPSHOTS) {
      throw new FileBackupError('BACKUP_INVALID_CONFIG', `文件快照历史 limit 必须在 1–${MAX_SNAPSHOTS} 之间。`)
    }
    const context = await resolveBackupContext(workspacePath, workspaceId, signal)
    if (!await backupRootExists(context, signal)) return []
    const state = await readBackupState(context, signal)
    const visible: FileBackupSnapshotSummary[] = []
    let previous: FileBackupManifest = emptyBackupManifest()
    for (const item of state.snapshots) {
      const manifest = await readManifest(context, item.snapshot.manifest, signal)
      assertSnapshotManifest(item.snapshot, manifest)
      if (!sameBackupContent(previous, manifest)) visible.push(snapshotSummary(item.id, item.snapshot))
      previous = manifest
    }
    return visible.slice(-limit).reverse()
  }

  static async compare(
    workspacePath: string,
    workspaceId: string,
    baseSelector: string,
    headSelector: string,
    limit = 250,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<FileBackupComparison> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
      throw new FileBackupError('BACKUP_INVALID_CONFIG', '文件差异 limit 必须在 1–250 之间。')
    }
    const context = await resolveBackupContext(workspacePath, workspaceId, signal)
    if (!await backupRootExists(context, signal)) {
      throw new FileBackupError('BACKUP_NOT_CONFIGURED', '此仓库尚未配置文件备份。')
    }
    const state = await readBackupState(context, signal)
    const base = selectOptionalSnapshot(state, baseSelector)
    const head = selectOptionalSnapshot(state, headSelector)
    const baseManifest = base === null ? emptyBackupManifest() : await readManifest(context, base.snapshot.manifest, signal)
    const headManifest = head === null ? emptyBackupManifest() : await readManifest(context, head.snapshot.manifest, signal)
    if (base !== null) assertSnapshotManifest(base.snapshot, baseManifest)
    if (head !== null) assertSnapshotManifest(head.snapshot, headManifest)
    const allChanges = compareBackupManifests(baseManifest, headManifest)
    const counts = { added: 0, modified: 0, deleted: 0 }
    for (const change of allChanges) counts[change.kind] += 1
    const normalizedCursor = cursor === undefined ? undefined : normalizeRelativePath(cursor)
    const available = normalizedCursor === undefined
      ? allChanges
      : allChanges.filter(change => change.path > normalizedCursor)
    const changes = available.slice(0, limit)
    const truncated = changes.length < available.length
    return {
      base: base === null ? null : snapshotSummary(base.id, base.snapshot),
      head: head === null ? null : snapshotSummary(head.id, head.snapshot),
      changes,
      counts,
      truncated,
      ...(truncated && changes.length > 0 ? { nextCursor: changes.at(-1)!.path } : {}),
    }
  }

  static async fileDiff(
    workspacePath: string,
    workspaceId: string,
    baseSelector: string,
    headSelector: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<FileBackupFileDiff> {
    const context = await resolveBackupContext(workspacePath, workspaceId, signal)
    if (!await backupRootExists(context, signal)) {
      throw new FileBackupError('BACKUP_NOT_CONFIGURED', '此仓库尚未配置文件备份。')
    }
    const state = await readBackupState(context, signal)
    const base = selectOptionalSnapshot(state, baseSelector)
    const head = selectOptionalSnapshot(state, headSelector)
    const baseManifest = base === null ? emptyBackupManifest() : await readManifest(context, base.snapshot.manifest, signal)
    const headManifest = head === null ? emptyBackupManifest() : await readManifest(context, head.snapshot.manifest, signal)
    if (base !== null) assertSnapshotManifest(base.snapshot, baseManifest)
    if (head !== null) assertSnapshotManifest(head.snapshot, headManifest)
    const normalizedPath = normalizeRelativePath(path)
    const before = baseManifest.entries.find(entry => entry.path === normalizedPath)
    const after = headManifest.entries.find(entry => entry.path === normalizedPath)
    const kind = backupChangeKind(before, after)
    if (kind === undefined) throw new FileBackupError('BACKUP_FILE_NOT_FOUND', '两个版本之间没有此文件的内容或权限变化。')
    const resultBase = {
      baseSnapshotId: base?.id ?? null,
      headSnapshotId: head?.id ?? null,
      path: normalizedPath,
      kind,
      ...(before === undefined ? {} : { before: entryMetadata(before) }),
      ...(after === undefined ? {} : { after: entryMetadata(after) }),
    }
    if (before?.blob === after?.blob) {
      return { ...resultBase, display: 'metadata-only', lines: [], truncated: false }
    }
    if ((before?.size ?? 0) > MAX_PREVIEW_BYTES || (after?.size ?? 0) > MAX_PREVIEW_BYTES) {
      return { ...resultBase, display: 'too-large', lines: [], truncated: false }
    }
    const beforeText = before === undefined ? '' : await readDiffText(context, before, signal)
    const afterText = after === undefined ? '' : await readDiffText(context, after, signal)
    if (beforeText === undefined || afterText === undefined) {
      return { ...resultBase, display: 'binary', lines: [], truncated: false }
    }
    const rendered = renderTextDiff(beforeText, afterText)
    return { ...resultBase, display: 'text', lines: rendered.lines, truncated: rendered.truncated }
  }

  static async preview(
    workspacePath: string,
    workspaceId: string,
    snapshotSelector: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<FileBackupPreview> {
    const context = await resolveBackupContext(workspacePath, workspaceId, signal)
    if (!await backupRootExists(context, signal)) {
      throw new FileBackupError('BACKUP_NOT_CONFIGURED', '此仓库尚未配置文件备份。')
    }
    const state = await readBackupState(context, signal)
    const selected = selectSnapshot(state, snapshotSelector)
    const manifest = await readManifest(context, selected.snapshot.manifest, signal)
    assertSnapshotManifest(selected.snapshot, manifest)
    const normalizedPath = normalizeRelativePath(path)
    const entry = manifest.entries.find(item => item.path === normalizedPath)
    if (entry === undefined) throw new FileBackupError('BACKUP_FILE_NOT_FOUND', '所选快照中不存在该文件。')
    if (entry.size > MAX_PREVIEW_BYTES) {
      return {
        snapshotId: selected.id,
        path: entry.path,
        size: entry.size,
        blob: entry.blob,
        encoding: 'too-large',
      }
    }
    const bytes = await readObjectBytes(context, entry.blob, MAX_FILE_BYTES, signal)
    if (bytes.includes(0)) {
      return { snapshotId: selected.id, path: entry.path, size: entry.size, blob: entry.blob, encoding: 'binary' }
    }
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return { snapshotId: selected.id, path: entry.path, size: entry.size, blob: entry.blob, encoding: 'utf8', content }
    } catch {
      return { snapshotId: selected.id, path: entry.path, size: entry.size, blob: entry.blob, encoding: 'binary' }
    }
  }

  static async exportSnapshot(
    workspacePath: string,
    workspaceId: string,
    snapshotSelector: string,
    signal?: AbortSignal,
    testHooks?: FileBackupTestHooks,
  ): Promise<FileBackupExportResult> {
    const context = await resolveBackupContext(workspacePath, workspaceId, signal)
    if (!await backupRootExists(context, signal)) {
      throw new FileBackupError('BACKUP_NOT_CONFIGURED', '此仓库尚未配置文件备份。')
    }
    const before = await readBackupState(context, signal)
    const selected = selectSnapshot(before, snapshotSelector)
    const manifest = await readManifest(context, selected.snapshot.manifest, signal)
    assertSnapshotManifest(selected.snapshot, manifest)
    const exportId = `export_${randomUUID()}`
    const stagingRoot = inside(context.backupRoot, '.staging', exportId)
    const destination = inside(context.backupRoot, 'exports', exportId)
    let staged = false
    let published = false
    try {
      await mkdir(stagingRoot, { mode: 0o700 })
      staged = true
      const canonicalStaging = await realpath(stagingRoot)
      if (!isContainedBy(context.backupRoot, canonicalStaging)) {
        throw new FileBackupError('BACKUP_PATH_ESCAPE', '恢复导出目录逃逸了备份边界。')
      }
      for (const entry of manifest.entries) {
        assertNotAborted(signal)
        const output = inside(canonicalStaging, ...entry.path.split('/'))
        await mkdir(dirname(output), { recursive: true, mode: 0o700 })
        await assertPrivateExportParent(canonicalStaging, dirname(output))
        const bytes = await readObjectBytes(context, entry.blob, MAX_FILE_BYTES, signal)
        await writeNewFile(output, bytes, entry.mode, signal)
      }
      await syncDirectory(canonicalStaging, signal)
      await withBackupLock(context, signal, async (locked, state) => {
        const stillPresent = state.snapshots.some(item => item.id === selected.id)
        if (!stillPresent) throw new FileBackupError('BACKUP_CONFLICT', '所选文件快照在导出期间失去可达性。')
        await testHooks?.checkpoint?.('export-before-publish')
        assertNotAborted(signal)
        try {
          await rename(canonicalStaging, destination)
          published = true
        } catch (error) {
          if (!await movePublishedDespiteError(canonicalStaging, destination, inside(context.backupRoot, 'exports'))) {
            throw error
          }
          published = true
        }
        await testHooks?.checkpoint?.('export-published')
        const destinationStats = await lstat(destination)
        if (destinationStats.isSymbolicLink() || !destinationStats.isDirectory()) {
          throw new FileBackupError('BACKUP_PATH_ESCAPE', '恢复导出目录发布后身份无效。')
        }
        observeDirectory(destinationStats)
        const nextState = await appendBackupEvent(locked, state, 'backup.restore.exported', {
          snapshot: selected.id,
          exportId,
        })
        if (nextState.journalEntries !== state.journalEntries + 1) {
          throw new FileBackupError('BACKUP_CONFLICT', '恢复导出审计未能追加。')
        }
      })
      return {
        exportId,
        snapshotId: selected.id,
        relativePath: `${REPOSITORY_DIR}/${BACKUP_DIR}/exports/${exportId}`,
        fileCount: selected.snapshot.fileCount,
        totalBytes: selected.snapshot.totalBytes,
      }
    } catch (error) {
      if (published) {
        // A user-visible recovery copy is never deleted merely because the
        // trailing audit verification failed. Preserve bytes and report the
        // uncertain audit state explicitly instead of creating data loss or a
        // journal/export contradiction.
        throw new FileBackupError(
          'BACKUP_CONFLICT',
          `恢复副本已保留在 ${REPOSITORY_DIR}/${BACKUP_DIR}/exports/${exportId}，但导出审计状态未能确认。`,
        )
      }
      throw error
    } finally {
      if (staged && !published) {
        try {
          await rm(stagingRoot, { recursive: true, force: true })
        } catch {
          // Staging cleanup never changes a published snapshot.
        }
      }
    }
  }
}

function emptyStatus(): FileBackupStatus {
  return { configured: false, enabled: false, integrity: 'ok', journalEntries: 0, snapshots: 0 }
}

function statusView(state: BackupState): FileBackupStatus {
  const latest = state.snapshots.at(-1)
  const interval = state.config?.schedule.minutes
  const nextCaptureAt = latest === undefined || interval === undefined || !state.enabled
    ? undefined
    : new Date(Date.parse(latest.snapshot.capturedAt) + interval * 60_000).toISOString()
  return {
    configured: true,
    enabled: state.enabled,
    integrity: 'ok',
    journalEntries: state.journalEntries,
    ...(state.config === undefined || state.configId === undefined ? {} : {
      config: {
        id: state.configId,
        scope: cloneBackupScope(state.config.scope),
        intervalMinutes: state.config.schedule.minutes,
        exclusions: state.config.exclusions.policy,
      },
    }),
    snapshots: state.snapshots.length,
    ...(latest === undefined ? {} : { latest: snapshotSummary(latest.id, latest.snapshot) }),
    ...(nextCaptureAt === undefined ? {} : { nextCaptureAt }),
  }
}

function snapshotSummary(id: Sha256Id, snapshot: FileBackupSnapshot): FileBackupSnapshotSummary {
  return {
    id,
    parent: snapshot.parent,
    reason: snapshot.reason,
    capturedAt: snapshot.capturedAt,
    repositoryHead: snapshot.repositoryHead,
    fileCount: snapshot.fileCount,
    totalBytes: snapshot.totalBytes,
    ignoredFiles: snapshot.ignoredFiles,
  }
}

function cloneBackupScope(scope: FileBackupScope): FileBackupScope {
  return scope.kind === 'workspace' ? { kind: 'workspace' } : { kind: 'selected', roots: [...scope.roots] }
}

function sameBackupScope(left: FileBackupScope, right: FileBackupScope): boolean {
  return left.kind === 'workspace' && right.kind === 'workspace'
    || left.kind === 'selected' && right.kind === 'selected'
      && left.roots.length === right.roots.length
      && left.roots.every((root, index) => root === right.roots[index])
}

function normalizeEnableRequest(request: FileBackupEnableRequest): {
  readonly scope: FileBackupScope
  readonly intervalMinutes: number
} {
  if (typeof request !== 'object' || request === null || request.confirmSensitiveRisk !== true) {
    throw new FileBackupError('BACKUP_INVALID_CONFIG', '启用文件备份前必须明确确认文件可能包含敏感信息。')
  }
  const intervalMinutes = request.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES
  if (!Number.isSafeInteger(intervalMinutes)
    || intervalMinutes < MIN_INTERVAL_MINUTES
    || intervalMinutes > MAX_INTERVAL_MINUTES) {
    throw new FileBackupError(
      'BACKUP_INVALID_CONFIG',
      `自动备份间隔必须是 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 分钟的整数。`,
    )
  }
  const scope = request.scope
  if (typeof scope !== 'object' || scope === null) {
    throw new FileBackupError('BACKUP_INVALID_CONFIG', '文件备份范围无效。')
  }
  if (scope.kind === 'workspace') {
    throw new FileBackupError(
      'BACKUP_INVALID_CONFIG',
      'v1 不允许扫描整个工作区；请在面板中明确选择 1–16 个相对文件或目录根。',
    )
  }
  if (scope.kind !== 'selected' || !Array.isArray(scope.roots)
    || scope.roots.length < 1 || scope.roots.length > MAX_ROOTS) {
    throw new FileBackupError('BACKUP_INVALID_CONFIG', `请选择 1–${MAX_ROOTS} 个相对文件或目录根。`)
  }
  const roots = [...new Set(scope.roots.map(normalizeRelativePath))].sort(compareCodePoint)
  if (roots.length !== scope.roots.length) {
    throw new FileBackupError('BACKUP_INVALID_CONFIG', '文件备份根不能重复。')
  }
  for (const root of roots) assertAllowedRoot(root)
  for (let index = 0; index < roots.length; index += 1) {
    for (let other = index + 1; other < roots.length; other += 1) {
      if (roots[other]!.startsWith(`${roots[index]!}/`)) {
        throw new FileBackupError('BACKUP_INVALID_CONFIG', `文件备份根“${roots[index]}”与“${roots[other]}”重叠。`)
      }
    }
  }
  return { scope: { kind: 'selected', roots }, intervalMinutes }
}

function assertAllowedRoot(root: string): void {
  const segments = root.split('/')
  if (segments.some((segment, index) => isExcludedDirectory(segment)
    || index === segments.length - 1 && isExcludedFile(segment))) {
    throw new FileBackupError('BACKUP_INVALID_CONFIG', `安全排除策略不允许备份“${root}”。`)
  }
}

function normalizeReason(value: string): string {
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > 200) return 'user'
  return normalized
}

function normalizeRelativePath(value: string): string {
  if (typeof value !== 'string') throw new FileBackupError('BACKUP_INVALID_CONFIG', '文件相对路径必须是字符串。')
  const input = value.trim().replaceAll('\\', '/')
  if (input === '' || input === '.' || input.includes('\0') || isAbsolute(input)
    || /^[A-Za-z]:/u.test(input) || input.startsWith('//') || input.startsWith('/')) {
    throw new FileBackupError('BACKUP_INVALID_CONFIG', '文件备份只接受工作区内的规范相对路径。')
  }
  const segments = input.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new FileBackupError('BACKUP_INVALID_CONFIG', '文件备份相对路径不能包含空段、`.` 或 `..`。')
  }
  const normalized = segments.join('/')
  if (segments.length > MAX_DEPTH || Buffer.byteLength(normalized, 'utf8') > MAX_PATH_BYTES) {
    throw new FileBackupError('BACKUP_LIMIT_EXCEEDED', '文件备份相对路径超过深度或长度限制。')
  }
  return normalized
}

function isExcludedDirectory(name: string): boolean {
  return EXCLUDED_DIRECTORY_NAMES.has(name.toLowerCase())
}

function isExcludedFile(name: string): boolean {
  const lower = name.toLowerCase()
  return EXCLUDED_FILE_NAMES.has(lower)
    || lower.startsWith('.env.')
    || /^(?:credential|credentials|secret|secrets|service-account)(?:\..+)?$/u.test(lower)
    || lower.endsWith('.key')
    || lower.endsWith('.pem')
    || lower.endsWith('.p12')
    || lower.endsWith('.pfx')
}

async function resolveBackupContext(
  workspacePath: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<BackupContext> {
  assertNotAborted(signal)
  const reader = await RepositoryReader.open(workspacePath, workspaceId, signal)
  if (reader === undefined) {
    throw new RepositoryReadError('REPO_NOT_INITIALIZED', '文件备份要求工作区先显式初始化 local-git-4-llm 仓库。')
  }
  const statusView = await reader.status(signal)
  const workspaceRoot = await realpath(workspacePath)
  const repositoryPath = inside(workspaceRoot, REPOSITORY_DIR)
  const repositoryBefore = await lstat(repositoryPath)
  if (repositoryBefore.isSymbolicLink() || !repositoryBefore.isDirectory() || repositoryBefore.ino === 0) {
    throw new FileBackupError('BACKUP_PATH_ESCAPE', '仓库目录必须是工作区内的普通目录。')
  }
  const repositoryRoot = await realpath(repositoryPath)
  if (!isContainedBy(workspaceRoot, repositoryRoot)) {
    throw new FileBackupError('BACKUP_PATH_ESCAPE', '仓库目录逃逸了注册工作区边界。')
  }
  const repositoryAfter = await stat(repositoryRoot)
  if (!sameFilesystemObject(repositoryBefore, repositoryAfter)) {
    throw new FileBackupError('BACKUP_CONFLICT', '仓库目录在文件备份解析期间发生替换。')
  }
  await reader.assertMutationRoot(signal)
  return {
    workspaceRoot,
    repositoryRoot,
    backupRoot: inside(repositoryRoot, BACKUP_DIR),
    workspaceId,
    repoId: statusView.repoId,
    repositoryHead: statusView.head,
    reader,
    repositoryIdentity: observeDirectory(repositoryAfter),
  }
}

async function backupRootExists(context: BackupContext, signal?: AbortSignal): Promise<boolean> {
  assertNotAborted(signal)
  try {
    await assertBackupRoot(context, signal)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

async function ensureBackupRoot(context: BackupContext, signal?: AbortSignal): Promise<void> {
  if (await backupRootExists(context, signal)) return
  assertNotAborted(signal)
  const stagingPath = inside(context.repositoryRoot, `.backup-init-${randomUUID()}`)
  let staged = false
  try {
    await mkdir(stagingPath, { mode: 0o700 })
    staged = true
    const stagingRoot = await realpath(stagingPath)
    if (!isContainedBy(context.repositoryRoot, stagingRoot)) {
      throw new FileBackupError('BACKUP_PATH_ESCAPE', '备份初始化目录逃逸了仓库边界。')
    }
    await mkdir(inside(stagingRoot, 'objects', 'sha256'), { recursive: true, mode: 0o700 })
    await mkdir(inside(stagingRoot, '.staging'), { mode: 0o700 })
    await mkdir(inside(stagingRoot, 'exports'), { mode: 0o700 })
    const initializedAt = new Date().toISOString()
    const initialized = makeBackupRecord(1, null, 'backup.initialized', initializedAt, {
      repoId: context.repoId,
      workspaceId: context.workspaceId,
      backupFormatVersion: FILE_BACKUP_FORMAT_VERSION,
    })
    await writeNewFile(
      inside(stagingRoot, 'journal.jsonl'),
      Buffer.from(`${canonicalJson(initialized)}\n`, 'utf8'),
      0o600,
      signal,
    )
    await syncDirectory(inside(stagingRoot, 'objects', 'sha256'), signal)
    await syncDirectory(inside(stagingRoot, 'objects'), signal)
    await syncDirectory(inside(stagingRoot, '.staging'), signal)
    await syncDirectory(inside(stagingRoot, 'exports'), signal)
    await syncDirectory(stagingRoot, signal)
    let published = false
    assertNotAborted(signal)
    try {
      await rename(stagingRoot, context.backupRoot)
      staged = false
      published = true
    } catch (error) {
      if (errorCode(error) !== 'EEXIST' && errorCode(error) !== 'ENOTEMPTY') {
        if (!await movePublishedDespiteError(stagingRoot, context.backupRoot, context.repositoryRoot)) throw error
        staged = false
        published = true
      }
    }
    if (published) await syncDirectory(context.repositoryRoot)
    await assertBackupRoot(context, published ? undefined : signal)
  } catch (error) {
    if (error instanceof FileBackupError || error instanceof RepositoryReadError || isAbortError(error)) throw error
    throw new FileBackupError('BACKUP_IO', '文件备份目录未能安全初始化。')
  } finally {
    if (staged) {
      try {
        await rm(stagingPath, { recursive: true, force: true })
      } catch {
        // A private staging directory never makes a backup reachable.
      }
    }
  }
}

async function assertBackupRoot(context: BackupContext, signal?: AbortSignal): Promise<DirectoryObservation> {
  assertNotAborted(signal)
  await context.reader.assertMutationRoot(signal)
  const currentRepository = await stat(context.repositoryRoot)
  if (!sameFilesystemObject(currentRepository, context.repositoryIdentity)) {
    throw new FileBackupError('BACKUP_CONFLICT', '仓库目录身份发生变化。')
  }
  const before = await lstat(context.backupRoot)
  if (before.isSymbolicLink() || !before.isDirectory() || before.ino === 0) {
    throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份根必须是仓库内的普通目录。')
  }
  const canonical = await realpath(context.backupRoot)
  if (!isContainedBy(context.repositoryRoot, canonical)) {
    throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份根逃逸了仓库边界。')
  }
  const after = await stat(canonical)
  if (!sameFilesystemObject(before, after)) {
    throw new FileBackupError('BACKUP_CONFLICT', '文件备份根在校验期间发生替换。')
  }
  for (const parts of [['objects'], ['objects', 'sha256'], ['.staging'], ['exports']] as const) {
    const path = inside(context.backupRoot, ...parts)
    const item = await lstat(path)
    if (item.isSymbolicLink() || !item.isDirectory() || item.ino === 0) {
      throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份内部目录身份无效。')
    }
    const resolvedPath = await realpath(path)
    if (!isContainedBy(context.backupRoot, resolvedPath)) {
      throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份内部目录逃逸了备份边界。')
    }
  }
  return observeDirectory(after)
}

async function readBackupState(context: BackupContext, signal?: AbortSignal): Promise<BackupState> {
  const backupIdentity = await assertBackupRoot(context, signal)
  const journalPath = inside(context.backupRoot, 'journal.jsonl')
  const source = await readStrictTextFile(journalPath, MAX_BACKUP_JOURNAL_BYTES, '文件备份日志', signal)
  if (!source.source.endsWith('\n')) {
    throw new FileBackupError('BACKUP_CORRUPT', '文件备份日志缺少完整 LF 结尾。')
  }
  const lines = source.source.slice(0, -1).split('\n')
  if (lines.length < 1 || lines.length > MAX_BACKUP_JOURNAL_LINES || lines.some(line => line === '')) {
    throw new FileBackupError('BACKUP_CORRUPT', '文件备份日志行数或空行无效。')
  }
  let tail: Sha256Id | null = null
  let enabled = false
  let configId: Sha256Id | undefined
  let config: FileBackupConfig | undefined
  const snapshots: { id: Sha256Id; snapshot: FileBackupSnapshot }[] = []
  const snapshotIds = new Set<Sha256Id>()

  for (let index = 0; index < lines.length; index += 1) {
    assertNotAborted(signal)
    const record = parseBackupRecord(lines[index]!, index + 1)
    if (record.seq !== index + 1) {
      throw new FileBackupError('BACKUP_CORRUPT', `文件备份日志在第 ${index + 1} 条出现序号间断。`)
    }
    if (record.prev !== tail) {
      throw new FileBackupError('BACKUP_CORRUPT', `文件备份日志在第 ${index + 1} 条出现校验链断裂。`)
    }
    const { checksum: _checksum, ...body } = record
    if (hashJsonId(body) !== record.checksum) {
      throw new FileBackupError('BACKUP_CORRUPT', `文件备份日志第 ${index + 1} 条校验失败。`)
    }
    tail = record.checksum

    if (index === 0) {
      if (record.type !== 'backup.initialized') {
        throw new FileBackupError('BACKUP_CORRUPT', '文件备份日志首条必须是 backup.initialized。')
      }
      parseBackupInitialized(record.payload, context)
      continue
    }

    switch (record.type) {
      case 'backup.configured': {
        const payload = requireRecord(record.payload, '文件备份配置事件必须是对象。')
        assertExactKeys(payload, ['config'], '文件备份配置事件包含不支持的字段。')
        const nextConfigId = requireHash(payload.config, '文件备份配置对象 id 无效。')
        const nextConfig = await readConfig(context, nextConfigId, signal)
        configId = nextConfigId
        config = nextConfig
        enabled = true
        break
      }
      case 'backup.disabled': {
        const payload = requireRecord(record.payload, '文件备份禁用事件必须是对象。')
        assertExactKeys(payload, ['reason'], '文件备份禁用事件包含不支持的字段。')
        requireBoundedString(payload.reason, 1, 200, '文件备份禁用原因无效。')
        enabled = false
        break
      }
      case 'backup.snapshot.created': {
        if (!enabled) throw new FileBackupError('BACKUP_CORRUPT', '文件备份关闭期间不能发布文件快照。')
        const payload = requireRecord(record.payload, '文件快照事件必须是对象。')
        assertExactKeys(payload, ['snapshot'], '文件快照事件包含不支持的字段。')
        const snapshotId = requireHash(payload.snapshot, '文件快照对象 id 无效。')
        if (snapshotIds.has(snapshotId)) throw new FileBackupError('BACKUP_CORRUPT', '文件快照事件重复引用同一对象。')
        const snapshot = await readSnapshot(context, snapshotId, signal)
        const expectedParent = snapshots.at(-1)?.id ?? null
        if (snapshot.parent !== expectedParent) {
          throw new FileBackupError('BACKUP_CORRUPT', '文件快照父链与日志顺序不一致。')
        }
        if (configId === undefined || snapshot.config !== configId) {
          throw new FileBackupError('BACKUP_CORRUPT', '文件快照没有绑定当时启用的配置。')
        }
        snapshots.push({ id: snapshotId, snapshot })
        snapshotIds.add(snapshotId)
        break
      }
      case 'backup.restore.exported': {
        const payload = requireRecord(record.payload, '恢复导出事件必须是对象。')
        assertExactKeys(payload, ['exportId', 'snapshot'], '恢复导出事件包含不支持的字段。')
        const snapshotId = requireHash(payload.snapshot, '恢复导出的文件快照 id 无效。')
        if (!snapshotIds.has(snapshotId)) throw new FileBackupError('BACKUP_CORRUPT', '恢复导出引用了未知文件快照。')
        const exportId = requireBoundedString(payload.exportId, 1, 128, '恢复导出 id 无效。')
        if (!EXPORT_ID.test(exportId)) throw new FileBackupError('BACKUP_CORRUPT', '恢复导出 id 格式无效。')
        break
      }
      default:
        throw new FileBackupError('BACKUP_CORRUPT', `文件备份日志包含不支持的事件“${record.type}”。`)
    }
  }

  if (tail === null) throw new FileBackupError('BACKUP_CORRUPT', '文件备份日志为空。')
  return {
    journalEntries: lines.length,
    tailChecksum: tail,
    journal: source.observation,
    backupIdentity,
    enabled,
    ...(configId === undefined || config === undefined ? {} : { configId, config }),
    snapshots,
  }
}

function parseBackupRecord(line: string, position: number): BackupJournalRecord {
  const value = parseCanonicalJson(line, `文件备份日志第 ${position} 条`)
  const record = requireRecord(value, `文件备份日志第 ${position} 条必须是对象。`)
  assertExactKeys(
    record,
    ['checksum', 'formatVersion', 'payload', 'prev', 'seq', 'ts', 'type'],
    `文件备份日志第 ${position} 条包含不支持的字段。`,
  )
  if (record.formatVersion !== FILE_BACKUP_FORMAT_VERSION) {
    throw new FileBackupError('BACKUP_CORRUPT', `文件备份日志第 ${position} 条格式版本不受支持。`)
  }
  if (!Number.isSafeInteger(record.seq) || (record.seq as number) < 1) {
    throw new FileBackupError('BACKUP_CORRUPT', `文件备份日志第 ${position} 条序号无效。`)
  }
  const prev = record.prev === null ? null : requireHash(record.prev, `文件备份日志第 ${position} 条 prev 无效。`)
  return {
    formatVersion: FILE_BACKUP_FORMAT_VERSION,
    seq: record.seq as number,
    type: requireBoundedString(record.type, 1, 120, `文件备份日志第 ${position} 条类型无效。`),
    ts: requireTimestamp(record.ts, `文件备份日志第 ${position} 条时间无效。`),
    prev,
    payload: cloneJson(record.payload as JsonValue),
    checksum: requireHash(record.checksum, `文件备份日志第 ${position} 条 checksum 无效。`),
  }
}

function parseBackupInitialized(payloadValue: JsonValue, context: BackupContext): void {
  const payload = requireRecord(payloadValue, '文件备份初始化事件必须是对象。')
  assertExactKeys(
    payload,
    ['backupFormatVersion', 'repoId', 'workspaceId'],
    '文件备份初始化事件包含不支持的字段。',
  )
  if (payload.backupFormatVersion !== FILE_BACKUP_FORMAT_VERSION
    || payload.repoId !== context.repoId
    || payload.workspaceId !== context.workspaceId) {
    throw new FileBackupError('BACKUP_CORRUPT', '文件备份日志与当前仓库身份不匹配。')
  }
}

async function readConfig(context: BackupContext, id: Sha256Id, signal?: AbortSignal): Promise<FileBackupConfig> {
  const value = await readJsonObject(context, id, signal)
  const config = requireRecord(value, '文件备份配置对象必须是对象。')
  assertExactKeys(
    config,
    ['createdAt', 'exclusions', 'format', 'formatVersion', 'limits', 'repoId', 'schedule', 'scope', 'updatedAt', 'workspaceId'],
    '文件备份配置对象包含不支持的字段。',
  )
  if (config.format !== FILE_BACKUP_CONFIG_FORMAT || config.formatVersion !== FILE_BACKUP_FORMAT_VERSION) {
    throw new FileBackupError('BACKUP_CORRUPT', '文件备份配置格式不受支持。')
  }
  if (config.repoId !== context.repoId || config.workspaceId !== context.workspaceId) {
    throw new FileBackupError('BACKUP_CORRUPT', '文件备份配置属于另一仓库或工作区。')
  }
  const scopeValue = requireRecord(config.scope, '文件备份配置 scope 无效。')
  let scope: FileBackupScope
  if (scopeValue.kind === 'workspace') {
    assertExactKeys(scopeValue, ['kind'], '全工作区备份 scope 包含不支持的字段。')
    scope = { kind: 'workspace' }
  } else {
    assertExactKeys(scopeValue, ['kind', 'roots'], '选定路径备份 scope 包含不支持的字段。')
    if (scopeValue.kind !== 'selected' || !Array.isArray(scopeValue.roots)) {
      throw new FileBackupError('BACKUP_CORRUPT', '文件备份配置 scope 无效。')
    }
    const roots = scopeValue.roots.map(item => requireBoundedString(item, 1, MAX_PATH_BYTES, '文件备份根无效。'))
    const normalized = normalizeEnableRequest({ scope: { kind: 'selected', roots }, intervalMinutes: DEFAULT_INTERVAL_MINUTES, confirmSensitiveRisk: true })
    scope = normalized.scope
  }
  const schedule = requireRecord(config.schedule, '文件备份配置 schedule 无效。')
  assertExactKeys(schedule, ['kind', 'minutes'], '文件备份配置 schedule 包含不支持的字段。')
  if (schedule.kind !== 'interval' || !Number.isSafeInteger(schedule.minutes)
    || (schedule.minutes as number) < MIN_INTERVAL_MINUTES || (schedule.minutes as number) > MAX_INTERVAL_MINUTES) {
    throw new FileBackupError('BACKUP_CORRUPT', '文件备份配置间隔无效。')
  }
  const exclusions = requireRecord(config.exclusions, '文件备份配置 exclusions 无效。')
  assertExactKeys(exclusions, ['policy'], '文件备份配置 exclusions 包含不支持的字段。')
  if (exclusions.policy !== 'safe-defaults-v1') throw new FileBackupError('BACKUP_CORRUPT', '文件备份排除策略不受支持。')
  const limits = requireRecord(config.limits, '文件备份配置 limits 无效。')
  assertExactKeys(
    limits,
    ['maxFileBytes', 'maxFiles', 'maxSnapshotBytes', 'maxSnapshots'],
    '文件备份配置 limits 包含不支持的字段。',
  )
  if (limits.maxFileBytes !== MAX_FILE_BYTES || limits.maxFiles !== MAX_FILES
    || limits.maxSnapshotBytes !== MAX_SNAPSHOT_BYTES || limits.maxSnapshots !== MAX_SNAPSHOTS) {
    throw new FileBackupError('BACKUP_CORRUPT', '文件备份配置试图改变实现固定的安全上限。')
  }
  const createdAt = requireTimestamp(config.createdAt, '文件备份配置 createdAt 无效。')
  const updatedAt = requireTimestamp(config.updatedAt, '文件备份配置 updatedAt 无效。')
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new FileBackupError('BACKUP_CORRUPT', '文件备份配置更新时间早于创建时间。')
  }
  return {
    format: FILE_BACKUP_CONFIG_FORMAT,
    formatVersion: FILE_BACKUP_FORMAT_VERSION,
    repoId: context.repoId,
    workspaceId: context.workspaceId,
    scope,
    schedule: { kind: 'interval', minutes: schedule.minutes as number },
    exclusions: { policy: 'safe-defaults-v1' },
    limits: {
      maxFileBytes: MAX_FILE_BYTES,
      maxFiles: MAX_FILES,
      maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
      maxSnapshots: MAX_SNAPSHOTS,
    },
    createdAt,
    updatedAt,
  }
}

async function readSnapshot(context: BackupContext, id: Sha256Id, signal?: AbortSignal): Promise<FileBackupSnapshot> {
  const value = await readJsonObject(context, id, signal)
  const snapshot = requireRecord(value, '文件快照对象必须是对象。')
  assertExactKeys(
    snapshot,
    ['capturedAt', 'config', 'fileCount', 'format', 'formatVersion', 'ignoredFiles', 'manifest', 'parent', 'reason', 'repoId', 'repositoryHead', 'totalBytes', 'workspaceId'],
    '文件快照对象包含不支持的字段。',
  )
  if (snapshot.format !== FILE_BACKUP_SNAPSHOT_FORMAT || snapshot.formatVersion !== FILE_BACKUP_FORMAT_VERSION) {
    throw new FileBackupError('BACKUP_CORRUPT', '文件快照格式不受支持。')
  }
  if (snapshot.repoId !== context.repoId || snapshot.workspaceId !== context.workspaceId) {
    throw new FileBackupError('BACKUP_CORRUPT', '文件快照属于另一仓库或工作区。')
  }
  const parent = snapshot.parent === null ? null : requireHash(snapshot.parent, '文件快照 parent 无效。')
  const repositoryHead = snapshot.repositoryHead === null ? null : requireHash(snapshot.repositoryHead, '文件快照 repositoryHead 无效。')
  const reason = snapshot.reason
  if (reason !== 'initial' && reason !== 'scheduled' && reason !== 'manual' && reason !== 'pre-restore') {
    throw new FileBackupError('BACKUP_CORRUPT', '文件快照 reason 无效。')
  }
  const fileCount = requireSafeInteger(snapshot.fileCount, 0, MAX_FILES, '文件快照文件数无效。')
  const totalBytes = requireSafeInteger(snapshot.totalBytes, 0, MAX_SNAPSHOT_BYTES, '文件快照总字节数无效。')
  const ignoredFiles = requireSafeInteger(snapshot.ignoredFiles, 0, Number.MAX_SAFE_INTEGER, '文件快照忽略数无效。')
  return {
    format: FILE_BACKUP_SNAPSHOT_FORMAT,
    formatVersion: FILE_BACKUP_FORMAT_VERSION,
    repoId: context.repoId,
    workspaceId: context.workspaceId,
    parent,
    config: requireHash(snapshot.config, '文件快照 config 无效。'),
    manifest: requireHash(snapshot.manifest, '文件快照 manifest 无效。'),
    reason,
    capturedAt: requireTimestamp(snapshot.capturedAt, '文件快照 capturedAt 无效。'),
    repositoryHead,
    fileCount,
    totalBytes,
    ignoredFiles,
  }
}

async function readManifest(context: BackupContext, id: Sha256Id, signal?: AbortSignal): Promise<FileBackupManifest> {
  const value = await readJsonObject(context, id, signal)
  const manifest = requireRecord(value, '文件备份清单对象必须是对象。')
  assertExactKeys(manifest, ['entries', 'format', 'formatVersion'], '文件备份清单包含不支持的字段。')
  if (manifest.format !== FILE_BACKUP_MANIFEST_FORMAT || manifest.formatVersion !== FILE_BACKUP_FORMAT_VERSION
    || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_FILES) {
    throw new FileBackupError('BACKUP_CORRUPT', '文件备份清单格式无效。')
  }
  const entries: FileBackupEntry[] = []
  let previous: string | undefined
  let total = 0
  for (const item of manifest.entries) {
    const entry = requireRecord(item, '文件备份清单条目必须是对象。')
    assertExactKeys(entry, ['blob', 'mode', 'mtimeMs', 'path', 'size'], '文件备份清单条目包含不支持的字段。')
    const path = normalizeRelativePath(requireBoundedString(entry.path, 1, MAX_PATH_BYTES, '文件备份清单路径无效。'))
    if (previous !== undefined && compareCodePoint(previous, path) >= 0) {
      throw new FileBackupError('BACKUP_CORRUPT', '文件备份清单路径必须严格排序且不得重复。')
    }
    previous = path
    const size = requireSafeInteger(entry.size, 0, MAX_FILE_BYTES, '文件备份清单文件大小无效。')
    total += size
    if (total > MAX_SNAPSHOT_BYTES) throw new FileBackupError('BACKUP_CORRUPT', '文件备份清单超过快照总量限制。')
    entries.push({
      path,
      size,
      mode: requireSafeInteger(entry.mode, 0, 0o777, '文件备份清单 mode 无效。'),
      mtimeMs: requireFiniteNumber(entry.mtimeMs, '文件备份清单 mtimeMs 无效。'),
      blob: requireHash(entry.blob, '文件备份清单 blob 无效。'),
    })
  }
  return { format: FILE_BACKUP_MANIFEST_FORMAT, formatVersion: FILE_BACKUP_FORMAT_VERSION, entries }
}

function assertSnapshotManifest(snapshot: FileBackupSnapshot, manifest: FileBackupManifest): void {
  const manifestBytes = manifest.entries.reduce((sum, entry) => sum + entry.size, 0)
  if (manifest.entries.length !== snapshot.fileCount || manifestBytes !== snapshot.totalBytes) {
    throw new FileBackupError('BACKUP_CORRUPT', '文件快照统计与内容清单不一致。')
  }
}

async function captureSource(
  context: BackupContext,
  config: FileBackupConfig,
  signal?: AbortSignal,
  testHooks?: FileBackupTestHooks,
): Promise<CaptureDraft> {
  assertNotAborted(signal)
  await context.reader.assertMutationRoot(signal)
  const first = new Map<string, SourceObservation>()
  const entries: FileBackupEntry[] = []
  let ignoredFiles = 0
  let totalBytes = 0

  const visit = async (absolutePath: string, relativePath: string, depth: number, explicitRoot: boolean): Promise<void> => {
    assertNotAborted(signal)
    if (depth > MAX_DEPTH) throw new FileBackupError('BACKUP_LIMIT_EXCEEDED', '文件目录深度超过安全上限。')
    const before = await lstat(absolutePath)
    if (before.isSymbolicLink()) {
      throw new FileBackupError('BACKUP_SOURCE_UNSAFE', `文件备份拒绝符号链接或 junction：“${relativePath}”。`)
    }
    const canonical = await realpath(absolutePath)
    if (!isContainedBy(context.workspaceRoot, canonical)) {
      throw new FileBackupError('BACKUP_PATH_ESCAPE', `文件备份源逃逸了工作区：“${relativePath}”。`)
    }
    if (before.isDirectory()) {
      if (!explicitRoot && isExcludedDirectory(lastSegment(relativePath))) return
      const children = await readdir(canonical)
      children.sort(compareCodePoint)
      for (const child of children) {
        const parentBeforeChild = await lstat(canonical)
        if (parentBeforeChild.isSymbolicLink() || !parentBeforeChild.isDirectory()
          || !sameFilesystemObject(before, parentBeforeChild)) {
          throw new FileBackupError('BACKUP_CONFLICT', `文件备份目录在枚举期间发生替换：“${relativePath || '/'}”。`)
        }
        const childRelative = relativePath === '' ? child : `${relativePath}/${child}`
        if (isExcludedDirectory(child)) {
          ignoredFiles += 1
          continue
        }
        const childPath = inside(canonical, child)
        const childBefore = await lstat(childPath)
        if (childBefore.isFile() && isExcludedFile(child)) {
          ignoredFiles += 1
          continue
        }
        await visit(childPath, childRelative, depth + 1, false)
      }
      const after = await lstat(absolutePath)
      if (!sameFilesystemObject(before, after)) {
        throw new FileBackupError('BACKUP_CONFLICT', `文件备份目录在扫描期间发生替换：“${relativePath || '/'}”。`)
      }
      return
    }
    if (!before.isFile()) {
      throw new FileBackupError('BACKUP_SOURCE_UNSAFE', `文件备份拒绝特殊文件：“${relativePath}”。`)
    }
    if (isExcludedFile(lastSegment(relativePath))) {
      if (explicitRoot) throw new FileBackupError('BACKUP_INVALID_CONFIG', `安全排除策略不允许备份“${relativePath}”。`)
      ignoredFiles += 1
      return
    }
    const normalizedPath = normalizeRelativePath(relativePath)
    if (entries.length >= MAX_FILES) {
      throw new FileBackupError('BACKUP_LIMIT_EXCEEDED', `单个文件快照不能超过 ${MAX_FILES} 个文件。`)
    }
    if (before.size > MAX_FILE_BYTES) {
      throw new FileBackupError('BACKUP_LIMIT_EXCEEDED', `文件“${normalizedPath}”超过单文件 64 MiB 上限。`)
    }
    totalBytes += before.size
    if (totalBytes > MAX_SNAPSHOT_BYTES) {
      throw new FileBackupError('BACKUP_LIMIT_EXCEEDED', '单个文件快照超过 512 MiB 总量上限。')
    }
    const captured = await captureFile(context, canonical, normalizedPath, before, signal, testHooks)
    first.set(normalizedPath, captured.observation)
    entries.push(captured.entry)
  }

  if (config.scope.kind === 'workspace') {
    const roots = await readdir(context.workspaceRoot)
    roots.sort(compareCodePoint)
    for (const name of roots) {
      if (isExcludedDirectory(name)) {
        ignoredFiles += 1
        continue
      }
      const absolutePath = inside(context.workspaceRoot, name)
      const source = await lstat(absolutePath)
      if (source.isFile() && isExcludedFile(name)) {
        ignoredFiles += 1
        continue
      }
      await visit(absolutePath, name, 1, false)
    }
  } else {
    for (const root of config.scope.roots) {
      const absolutePath = inside(context.workspaceRoot, ...root.split('/'))
      await visit(absolutePath, root, root.split('/').length, true)
    }
  }

  entries.sort((left, right) => compareCodePoint(left.path, right.path))
  const second = await observeSource(context, config, signal)
  if (first.size !== second.observations.size) {
    throw new FileBackupError('BACKUP_CONFLICT', '工作区文件集合在两轮扫描之间发生变化，本次快照未发布。')
  }
  for (const [path, observation] of first) {
    const current = second.observations.get(path)
    if (current === undefined || !sameSourceObservation(observation, current)) {
      throw new FileBackupError('BACKUP_CONFLICT', `文件“${path}”在两轮扫描之间发生变化，本次快照未发布。`)
    }
  }
  ignoredFiles = Math.max(ignoredFiles, second.ignoredFiles)
  const manifest: FileBackupManifest = {
    format: FILE_BACKUP_MANIFEST_FORMAT,
    formatVersion: FILE_BACKUP_FORMAT_VERSION,
    entries,
  }
  return { manifest, ignoredFiles, totalBytes }
}

function sameBackupContent(left: FileBackupManifest, right: FileBackupManifest): boolean {
  if (left.entries.length !== right.entries.length) return false
  return left.entries.every((entry, index) => {
    const other = right.entries[index]
    return other !== undefined
      && entry.path === other.path
      && entry.size === other.size
      && entry.mode === other.mode
      && entry.blob === other.blob
  })
}

function emptyBackupManifest(): FileBackupManifest {
  return { format: FILE_BACKUP_MANIFEST_FORMAT, formatVersion: FILE_BACKUP_FORMAT_VERSION, entries: [] }
}

function selectOptionalSnapshot(
  state: BackupState,
  selector: string,
): { readonly id: Sha256Id; readonly snapshot: FileBackupSnapshot } | null {
  return selector === 'ROOT' ? null : selectSnapshot(state, selector)
}

function compareBackupManifests(base: FileBackupManifest, head: FileBackupManifest): FileBackupChange[] {
  const before = new Map(base.entries.map(entry => [entry.path, entry]))
  const after = new Map(head.entries.map(entry => [entry.path, entry]))
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(compareCodePoint)
  const changes: FileBackupChange[] = []
  for (const path of paths) {
    const beforeEntry = before.get(path)
    const afterEntry = after.get(path)
    const kind = backupChangeKind(beforeEntry, afterEntry)
    if (kind === undefined) continue
    changes.push({
      path,
      kind,
      ...(beforeEntry === undefined ? {} : { before: beforeEntry }),
      ...(afterEntry === undefined ? {} : { after: afterEntry }),
    })
  }
  return changes
}

function backupChangeKind(before: FileBackupEntry | undefined, after: FileBackupEntry | undefined): FileBackupChangeKind | undefined {
  if (before === undefined) return after === undefined ? undefined : 'added'
  if (after === undefined) return 'deleted'
  return before.blob === after.blob && before.size === after.size && before.mode === after.mode ? undefined : 'modified'
}

function entryMetadata(entry: FileBackupEntry): Pick<FileBackupEntry, 'size' | 'mode' | 'blob'> {
  return { size: entry.size, mode: entry.mode, blob: entry.blob }
}

async function readDiffText(
  context: BackupContext,
  entry: FileBackupEntry,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const bytes = await readObjectBytes(context, entry.blob, MAX_PREVIEW_BYTES, signal)
  if (bytes.includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

interface TextToken {
  readonly value: string
  readonly content: string
  readonly lineBreak: boolean
}

function textTokens(source: string): TextToken[] {
  if (source === '') return []
  const hasFinalLineBreak = source.endsWith('\n')
  const lines = source.split('\n')
  if (hasFinalLineBreak) lines.pop()
  return lines.map((content, index) => {
    const lineBreak = index < lines.length - 1 || hasFinalLineBreak
    return { value: lineBreak ? `${content}\n` : content, content, lineBreak }
  })
}

function renderTextDiff(beforeSource: string, afterSource: string): {
  readonly lines: readonly FileBackupDiffLine[]
  readonly truncated: boolean
} {
  const before = textTokens(beforeSource)
  const after = textTokens(afterSource)
  const operations = before.length * after.length <= MAX_DIFF_MATRIX_CELLS
    ? lcsDiff(before, after)
    : boundedDiff(before, after)
  const changeIndexes = operations.flatMap((line, index) => line.kind === 'context' ? [] : [index])
  if (changeIndexes.length === 0) return { lines: [], truncated: false }
  const ranges: { start: number; end: number }[] = []
  for (const index of changeIndexes) {
    const start = Math.max(0, index - DIFF_CONTEXT_LINES)
    const end = Math.min(operations.length, index + DIFF_CONTEXT_LINES + 1)
    const previous = ranges.at(-1)
    if (previous !== undefined && start <= previous.end) previous.end = Math.max(previous.end, end)
    else ranges.push({ start, end })
  }
  const compact: FileBackupDiffLine[] = []
  for (let index = 0; index < ranges.length; index += 1) {
    if (index > 0) compact.push({ kind: 'separator' })
    compact.push(...operations.slice(ranges[index]!.start, ranges[index]!.end))
  }
  if (compact.length <= MAX_DIFF_OUTPUT_LINES) return { lines: compact, truncated: false }
  return {
    lines: [...compact.slice(0, MAX_DIFF_OUTPUT_LINES - 1), { kind: 'separator' }],
    truncated: true,
  }
}

function lcsDiff(before: readonly TextToken[], after: readonly TextToken[]): FileBackupDiffLine[] {
  const matrix = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1))
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      matrix[left]![right] = before[left]!.value === after[right]!.value
        ? matrix[left + 1]![right + 1]! + 1
        : Math.max(matrix[left + 1]![right]!, matrix[left]![right + 1]!)
    }
  }
  const result: FileBackupDiffLine[] = []
  let left = 0
  let right = 0
  let beforeLine = 1
  let afterLine = 1
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left]!.value === after[right]!.value) {
      result.push(diffLine('context', before[left]!, beforeLine, afterLine))
      left += 1
      right += 1
      beforeLine += 1
      afterLine += 1
    } else if (right < after.length && (left >= before.length || matrix[left]![right + 1]! > matrix[left + 1]![right]!)) {
      result.push(diffLine('added', after[right]!, undefined, afterLine))
      right += 1
      afterLine += 1
    } else {
      result.push(diffLine('deleted', before[left]!, beforeLine, undefined))
      left += 1
      beforeLine += 1
    }
  }
  return result
}

function boundedDiff(before: readonly TextToken[], after: readonly TextToken[]): FileBackupDiffLine[] {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix]!.value === after[prefix]!.value) prefix += 1
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - suffix - 1]!.value === after[after.length - suffix - 1]!.value) suffix += 1
  const result: FileBackupDiffLine[] = []
  for (let index = 0; index < prefix; index += 1) result.push(diffLine('context', before[index]!, index + 1, index + 1))
  for (let index = prefix; index < before.length - suffix; index += 1) {
    result.push(diffLine('deleted', before[index]!, index + 1, undefined))
  }
  for (let index = prefix; index < after.length - suffix; index += 1) {
    result.push(diffLine('added', after[index]!, undefined, index + 1))
  }
  for (let offset = suffix; offset > 0; offset -= 1) {
    const beforeIndex = before.length - offset
    const afterIndex = after.length - offset
    result.push(diffLine('context', before[beforeIndex]!, beforeIndex + 1, afterIndex + 1))
  }
  return result
}

function diffLine(
  kind: 'context' | 'added' | 'deleted',
  token: TextToken,
  beforeLine: number | undefined,
  afterLine: number | undefined,
): FileBackupDiffLine {
  return {
    kind,
    ...(beforeLine === undefined ? {} : { beforeLine }),
    ...(afterLine === undefined ? {} : { afterLine }),
    content: token.content,
    lineBreak: token.lineBreak,
  }
}

async function captureFile(
  context: BackupContext,
  canonicalPath: string,
  relativePath: string,
  pathStats: Stats,
  signal?: AbortSignal,
  testHooks?: FileBackupTestHooks,
): Promise<{ readonly entry: FileBackupEntry; readonly observation: SourceObservation }> {
  assertNotAborted(signal)
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  try {
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    const immediate = await lstat(canonicalPath)
    const immediateRealpath = await realpath(canonicalPath)
    if (immediate.isSymbolicLink() || !immediate.isFile()
      || !sameSourceObservation(observeSourceFile(pathStats), observeSourceFile(immediate))
      || !isContainedBy(context.workspaceRoot, immediateRealpath)
      || resolve(immediateRealpath) !== resolve(canonicalPath)) {
      throw new FileBackupError('BACKUP_CONFLICT', `文件“${relativePath}”在打开前发生替换。`)
    }
    handle = await openFile(canonicalPath, flags)
    const opened = await handle.stat()
    if (!opened.isFile() || !sameSourceIdentity(pathStats, opened)) {
      throw new FileBackupError('BACKUP_CONFLICT', `文件“${relativePath}”在打开前发生替换。`)
    }
    if (opened.size > MAX_FILE_BYTES) {
      throw new FileBackupError('BACKUP_LIMIT_EXCEEDED', `文件“${relativePath}”超过单文件 64 MiB 上限。`)
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength !== opened.size) {
      throw new FileBackupError('BACKUP_CONFLICT', `文件“${relativePath}”读取长度发生变化。`)
    }
    const afterHandle = await handle.stat()
    const afterPath = await lstat(canonicalPath)
    if (!sameSourceObservation(observeSourceFile(opened), observeSourceFile(afterHandle))
      || !sameSourceObservation(observeSourceFile(opened), observeSourceFile(afterPath))) {
      throw new FileBackupError('BACKUP_CONFLICT', `文件“${relativePath}”在读取期间发生变化。`)
    }
    const resolvedAfter = await realpath(canonicalPath)
    if (!isContainedBy(context.workspaceRoot, resolvedAfter) || resolve(resolvedAfter) !== resolve(canonicalPath)) {
      throw new FileBackupError('BACKUP_PATH_ESCAPE', `文件“${relativePath}”在读取期间逃逸了工作区。`)
    }
    const blob = await writeRawObject(context, bytes, signal, testHooks)
    const observation = observeSourceFile(opened)
    return {
      entry: {
        path: relativePath,
        size: opened.size,
        mode: opened.mode & 0o777,
        mtimeMs: opened.mtimeMs,
        blob,
      },
      observation,
    }
  } catch (error) {
    if (errorCode(error) === 'ELOOP') {
      throw new FileBackupError('BACKUP_SOURCE_UNSAFE', `文件备份拒绝符号链接：“${relativePath}”。`)
    }
    throw error
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The captured bytes and verified identity determine success.
      }
    }
  }
}

async function observeSource(
  context: BackupContext,
  config: FileBackupConfig,
  signal?: AbortSignal,
): Promise<{ readonly observations: ReadonlyMap<string, SourceObservation>; readonly ignoredFiles: number }> {
  const observations = new Map<string, SourceObservation>()
  let ignoredFiles = 0
  const visit = async (absolutePath: string, relativePath: string, depth: number, explicitRoot: boolean): Promise<void> => {
    assertNotAborted(signal)
    if (depth > MAX_DEPTH) throw new FileBackupError('BACKUP_LIMIT_EXCEEDED', '文件目录深度超过安全上限。')
    const item = await lstat(absolutePath)
    if (item.isSymbolicLink()) throw new FileBackupError('BACKUP_SOURCE_UNSAFE', `文件备份拒绝符号链接或 junction：“${relativePath}”。`)
    const canonical = await realpath(absolutePath)
    if (!isContainedBy(context.workspaceRoot, canonical)) {
      throw new FileBackupError('BACKUP_PATH_ESCAPE', `文件备份源逃逸了工作区：“${relativePath}”。`)
    }
    if (item.isDirectory()) {
      if (!explicitRoot && isExcludedDirectory(lastSegment(relativePath))) return
      const children = await readdir(canonical)
      children.sort(compareCodePoint)
      for (const child of children) {
        const parentBeforeChild = await lstat(canonical)
        if (parentBeforeChild.isSymbolicLink() || !parentBeforeChild.isDirectory()
          || !sameFilesystemObject(item, parentBeforeChild)) {
          throw new FileBackupError('BACKUP_CONFLICT', `文件备份目录在复核期间发生替换：“${relativePath || '/'}”。`)
        }
        if (isExcludedDirectory(child)) {
          ignoredFiles += 1
          continue
        }
        const childPath = inside(canonical, child)
        const childItem = await lstat(childPath)
        if (childItem.isFile() && isExcludedFile(child)) {
          ignoredFiles += 1
          continue
        }
        await visit(childPath, relativePath === '' ? child : `${relativePath}/${child}`, depth + 1, false)
      }
      return
    }
    if (!item.isFile()) throw new FileBackupError('BACKUP_SOURCE_UNSAFE', `文件备份拒绝特殊文件：“${relativePath}”。`)
    if (isExcludedFile(lastSegment(relativePath))) {
      if (explicitRoot) throw new FileBackupError('BACKUP_INVALID_CONFIG', `安全排除策略不允许备份“${relativePath}”。`)
      ignoredFiles += 1
      return
    }
    const normalizedPath = normalizeRelativePath(relativePath)
    if (observations.size >= MAX_FILES) throw new FileBackupError('BACKUP_LIMIT_EXCEEDED', `单个文件快照不能超过 ${MAX_FILES} 个文件。`)
    observations.set(normalizedPath, observeSourceFile(item))
  }
  if (config.scope.kind === 'workspace') {
    const roots = await readdir(context.workspaceRoot)
    roots.sort(compareCodePoint)
    for (const name of roots) {
      if (isExcludedDirectory(name)) {
        ignoredFiles += 1
        continue
      }
      const sourcePath = inside(context.workspaceRoot, name)
      const item = await lstat(sourcePath)
      if (item.isFile() && isExcludedFile(name)) {
        ignoredFiles += 1
        continue
      }
      await visit(sourcePath, name, 1, false)
    }
  } else {
    for (const root of config.scope.roots) {
      await visit(inside(context.workspaceRoot, ...root.split('/')), root, root.split('/').length, true)
    }
  }
  return { observations, ignoredFiles }
}

function observeSourceFile(value: Stats): SourceObservation {
  if (value.ino === 0) throw new FileBackupError('BACKUP_SOURCE_UNSAFE', '文件系统无法提供稳定文件身份，拒绝创建不可靠快照。')
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeMs: value.mtimeMs,
    mode: value.mode & 0o777,
  }
}

function sameSourceIdentity(left: Stats, right: Stats): boolean {
  return left.ino !== 0 && right.ino !== 0 && left.dev === right.dev && left.ino === right.ino
}

function sameSourceObservation(left: SourceObservation, right: SourceObservation): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.mode === right.mode
}

function lastSegment(path: string): string {
  return path.split('/').at(-1) ?? path
}

async function movePublishedDespiteError(stagingPath: string, destination: string, parent: string): Promise<boolean> {
  try {
    await lstat(stagingPath)
    return false
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return false
  }
  try {
    const item = await lstat(destination)
    if (item.isSymbolicLink() || !item.isDirectory() || item.ino === 0) return false
    const canonical = await realpath(destination)
    return isContainedBy(parent, canonical) && resolve(canonical) === resolve(destination)
  } catch {
    return false
  }
}

async function assertPrivateExportParent(stagingRoot: string, parentPath: string): Promise<void> {
  const pathFromRoot = relative(stagingRoot, parentPath)
  const segments = pathFromRoot === '' ? [] : pathFromRoot.split(/[\\/]/u)
  let current = stagingRoot
  for (const segment of segments) {
    current = inside(current, segment)
    const item = await lstat(current)
    if (item.isSymbolicLink() || !item.isDirectory() || item.ino === 0) {
      throw new FileBackupError('BACKUP_PATH_ESCAPE', '恢复导出父目录身份无效。')
    }
    const canonical = await realpath(current)
    if (!isContainedBy(stagingRoot, canonical) || resolve(canonical) !== resolve(current)) {
      throw new FileBackupError('BACKUP_PATH_ESCAPE', '恢复导出父目录逃逸了私有 staging。')
    }
  }
}

async function writeJsonObject(context: BackupContext, value: unknown, signal?: AbortSignal): Promise<Sha256Id> {
  const bytes = Buffer.from(canonicalJson(value), 'utf8')
  if (bytes.byteLength > MAX_OBJECT_JSON_BYTES) {
    throw new FileBackupError('BACKUP_LIMIT_EXCEEDED', '文件备份元数据对象超过 4 MiB 上限。')
  }
  return writeRawObject(context, bytes, signal)
}

async function writeRawObject(
  context: BackupContext,
  bytes: Buffer,
  signal?: AbortSignal,
  testHooks?: FileBackupTestHooks,
): Promise<Sha256Id> {
  assertNotAborted(signal)
  const id = hashRawId(bytes)
  const path = await objectPath(context, id, true, signal)
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  let created: Stats | undefined
  let objectComplete = false
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    handle = await openFile(path, flags, 0o600)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino === 0) {
      throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份对象无法绑定普通文件身份。')
    }
    created = opened
    await testHooks?.checkpoint?.('object-created')
    assertNotAborted(signal)
    await handle.writeFile(bytes)
    await handle.sync()
    const written = await handle.stat()
    if (!sameFilesystemObject(opened, written) || written.size !== bytes.byteLength) {
      throw new FileBackupError('BACKUP_CONFLICT', '文件备份对象写入期间发生冲突。')
    }
    await handle.close()
    handle = undefined
    objectComplete = true
    // A fully written, file-synced content-addressed object is the irreversible
    // boundary. Finish directory durability without the caller signal so an
    // abort cannot turn a valid persisted object into an ambiguous outcome.
    await syncDirectory(dirname(path))
    return id
  } catch (error) {
    if (created !== undefined && !objectComplete) {
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch {
          // Continue with identity-checked cleanup of the incomplete object.
        }
        handle = undefined
      }
      try {
        const current = await lstat(path)
        if (!current.isSymbolicLink() && current.isFile() && sameFilesystemObject(created, current)) {
          await unlink(path)
          try {
            await syncDirectory(dirname(path))
          } catch {
            // Cleanup durability does not replace the primary write failure.
          }
        }
      } catch (cleanupError) {
        if (errorCode(cleanupError) !== 'ENOENT') {
          // An unexpected replacement remains untouched and will fail closed
          // if it is ever reached through a published manifest.
        }
      }
    }
    if (errorCode(error) === 'EEXIST') {
      const existing = await readObjectBytes(context, id, Math.max(bytes.byteLength, MAX_OBJECT_JSON_BYTES), signal)
      if (!existing.equals(bytes)) {
        throw new FileBackupError('BACKUP_CORRUPT', '内容寻址对象已存在但字节不一致。')
      }
      return id
    }
    if (errorCode(error) === 'ELOOP') throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份对象路径不能是符号链接。')
    if (error instanceof FileBackupError || isAbortError(error)) throw error
    throw new FileBackupError('BACKUP_IO', '文件备份对象未能安全写入。')
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The primary object error wins.
      }
    }
  }
}

async function readJsonObject(context: BackupContext, id: Sha256Id, signal?: AbortSignal): Promise<JsonValue> {
  const bytes = await readObjectBytes(context, id, MAX_OBJECT_JSON_BYTES, signal)
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new FileBackupError('BACKUP_CORRUPT', '文件备份 JSON 对象不是有效 UTF-8。')
  }
  return parseCanonicalJson(source, '文件备份 JSON 对象')
}

async function readObjectBytes(
  context: BackupContext,
  id: Sha256Id,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  assertNotAborted(signal)
  let path: string
  try {
    path = await objectPath(context, id, false, signal)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new FileBackupError('BACKUP_CORRUPT', '文件备份对象缺失。')
    throw error
  }
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  try {
    const before = await lstat(path)
    if (before.isSymbolicLink() || !before.isFile() || before.ino === 0 || before.size > maxBytes) {
      throw new FileBackupError('BACKUP_CORRUPT', '文件备份对象身份或大小无效。')
    }
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    handle = await openFile(path, flags)
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFilesystemObject(before, opened)) {
      throw new FileBackupError('BACKUP_CONFLICT', '文件备份对象在读取前发生替换。')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (!sameFilesystemObject(opened, after) || bytes.byteLength !== after.size || hashRawId(bytes) !== id) {
      throw new FileBackupError('BACKUP_CORRUPT', '文件备份对象内容校验失败。')
    }
    return bytes
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new FileBackupError('BACKUP_CORRUPT', '文件备份对象缺失。')
    if (errorCode(error) === 'ELOOP') throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份对象不能是符号链接。')
    throw error
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The primary object read outcome is authoritative.
      }
    }
  }
}

async function objectPath(
  context: BackupContext,
  id: Sha256Id,
  createShard: boolean,
  signal?: AbortSignal,
): Promise<string> {
  if (!SHA256_ID.test(id)) throw new FileBackupError('BACKUP_CORRUPT', '文件备份对象 id 无效。')
  await assertBackupRoot(context, signal)
  const hex = id.slice(7)
  const objectRoot = inside(context.backupRoot, 'objects', 'sha256')
  const shard = inside(objectRoot, hex.slice(0, 2))
  if (createShard) {
    try {
      await mkdir(shard, { mode: 0o700 })
      await syncDirectory(objectRoot, signal)
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
  }
  const shardStats = await lstat(shard)
  if (shardStats.isSymbolicLink() || !shardStats.isDirectory() || shardStats.ino === 0) {
    throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份对象分片目录身份无效。')
  }
  const shardRoot = await realpath(shard)
  if (!isContainedBy(objectRoot, shardRoot)) {
    throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份对象分片逃逸了对象库。')
  }
  return inside(shardRoot, hex.slice(2))
}

async function measureObjectStore(context: BackupContext, signal?: AbortSignal): Promise<number> {
  await assertBackupRoot(context, signal)
  const objectRoot = inside(context.backupRoot, 'objects', 'sha256')
  const shards = await readdir(objectRoot)
  let total = 0
  for (const shardName of shards) {
    assertNotAborted(signal)
    if (!/^[a-f0-9]{2}$/u.test(shardName)) {
      throw new FileBackupError('BACKUP_CORRUPT', '文件备份对象库包含无效分片。')
    }
    const shardPath = inside(objectRoot, shardName)
    const shard = await lstat(shardPath)
    if (shard.isSymbolicLink() || !shard.isDirectory()) {
      throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份对象分片身份无效。')
    }
    for (const objectName of await readdir(shardPath)) {
      assertNotAborted(signal)
      if (!/^[a-f0-9]{62}$/u.test(objectName)) {
        throw new FileBackupError('BACKUP_CORRUPT', '文件备份对象库包含无效对象名称。')
      }
      const object = await lstat(inside(shardPath, objectName))
      if (object.isSymbolicLink() || !object.isFile() || object.ino === 0) {
        throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份对象库包含无效对象身份。')
      }
      total += object.size
      if (total > MAX_OBJECT_STORE_BYTES) return total
    }
  }
  return total
}

async function withBackupLock<T>(
  context: BackupContext,
  signal: AbortSignal | undefined,
  operation: (context: BackupContext, state: BackupState) => Promise<T>,
): Promise<T> {
  assertNotAborted(signal)
  const initialBackupIdentity = await assertBackupRoot(context, signal)
  let lease: BackupLockLease | undefined
  try {
    lease = await acquireBackupLock(inside(context.backupRoot, 'write.lock'), signal)
    const locked = await resolveBackupContext(context.workspaceRoot, context.workspaceId, signal)
    const lockedBackupIdentity = await assertBackupRoot(locked, signal)
    if (locked.repoId !== context.repoId
      || !sameFilesystemObject(locked.repositoryIdentity, context.repositoryIdentity)
      || !sameFilesystemObject(lockedBackupIdentity, initialBackupIdentity)) {
      throw new FileBackupError('BACKUP_CONFLICT', '仓库或文件备份目录在获取写锁期间发生替换。')
    }
    const state = await readBackupState(locked, signal)
    return await operation(locked, state)
  } catch (error) {
    if (error instanceof FileBackupError || error instanceof RepositoryReadError || isAbortError(error)) throw error
    throw new FileBackupError('BACKUP_IO', '文件备份写操作未能安全完成。')
  } finally {
    if (lease !== undefined) await releaseBackupLock(lease)
  }
}

async function acquireBackupLock(path: string, signal?: AbortSignal): Promise<BackupLockLease> {
  assertNotAborted(signal)
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  let owned: Pick<Stats, 'dev' | 'ino'> | undefined
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    handle = await openFile(path, flags, 0o600)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino === 0) {
      throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份写锁无法绑定普通文件身份。')
    }
    owned = opened
    await handle.writeFile(`${canonicalJson({
      formatVersion: FILE_BACKUP_FORMAT_VERSION,
      owner: `backup_${randomUUID()}`,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    })}\n`, 'utf8')
    await handle.sync()
    const current = await lstat(path)
    if (current.isSymbolicLink() || !current.isFile() || !sameFilesystemObject(opened, current)) {
      throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份写锁在获取期间发生替换。')
    }
    assertNotAborted(signal)
    return {
      path,
      handle,
      observation: { dev: current.dev, ino: current.ino, size: current.size },
    }
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // Preserve the primary lock error.
      }
    }
    if (owned !== undefined) {
      try {
        const current = await lstat(path)
        if (!current.isSymbolicLink() && current.isFile() && sameFilesystemObject(current, owned)) await unlink(path)
      } catch {
        // An unexpected replacement remains untouched.
      }
    }
    if (errorCode(error) === 'EEXIST') {
      throw new FileBackupError('BACKUP_BUSY', '文件备份已有活动或未恢复的写锁。')
    }
    if (errorCode(error) === 'ELOOP') throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份写锁不能是符号链接。')
    throw error
  }
}

async function releaseBackupLock(lease: BackupLockLease): Promise<void> {
  try {
    await lease.handle.close()
  } catch {
    // Continue with identity-checked cleanup.
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
    }
  }
}

async function appendBackupEvent(
  context: BackupContext,
  state: BackupState,
  type: 'backup.configured' | 'backup.disabled' | 'backup.snapshot.created' | 'backup.restore.exported',
  payload: JsonValue,
  signal?: AbortSignal,
): Promise<BackupState> {
  const ts = new Date().toISOString()
  const record = makeBackupRecord(state.journalEntries + 1, state.tailChecksum, type, ts, payload)
  const line = `${canonicalJson(record)}\n`
  const lineBytes = Buffer.from(line, 'utf8')
  if (state.journal.size + lineBytes.byteLength > MAX_BACKUP_JOURNAL_BYTES) {
    throw new FileBackupError('BACKUP_LIMIT_EXCEEDED', '文件备份日志达到 2 MiB 上限。')
  }
  if (state.journalEntries + 1 > MAX_BACKUP_JOURNAL_LINES) {
    throw new FileBackupError('BACKUP_LIMIT_EXCEEDED', '文件备份日志达到 10,000 条上限。')
  }
  return appendBackupLine(context, state, line, lineBytes, record.checksum, signal)
}

function makeBackupRecord(
  seq: number,
  prev: Sha256Id | null,
  type: string,
  ts: string,
  payload: JsonValue,
): BackupJournalRecord {
  const body = {
    formatVersion: FILE_BACKUP_FORMAT_VERSION,
    seq,
    type,
    ts,
    prev,
    payload,
  }
  return { ...body, checksum: hashJsonId(body) }
}

async function appendBackupLine(
  context: BackupContext,
  state: BackupState,
  line: string,
  lineBytes: Buffer,
  expectedChecksum: Sha256Id,
  signal?: AbortSignal,
): Promise<BackupState> {
  const path = inside(context.backupRoot, 'journal.jsonl')
  assertNotAborted(signal)
  await assertBackupRoot(context, signal)
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  let appendStarted = false
  const expectedSize = state.journal.size + lineBytes.byteLength
  try {
    const flags = constants.O_RDWR | constants.O_APPEND
      | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    handle = await openFile(path, flags)
    const opened = await handle.stat()
    const current = await lstat(path)
    if (!opened.isFile() || current.isSymbolicLink() || !current.isFile()
      || !sameObservation(opened, state.journal) || !sameObservation(current, state.journal)) {
      throw new FileBackupError('BACKUP_CONFLICT', '文件备份日志在追加前发生变化。')
    }
    await assertBackupRoot(context, signal)
    assertNotAborted(signal)
    appendStarted = true
    await handle.writeFile(line, 'utf8')
    await handle.sync()
    const written = await handle.stat()
    if (!sameFilesystemObject(opened, written) || written.size !== expectedSize) {
      throw new FileBackupError('BACKUP_CONFLICT', '文件备份日志在追加期间发生冲突。')
    }
    try {
      const verified = await readBackupState(context)
      if (verified.journalEntries !== state.journalEntries + 1
        || verified.journal.size !== expectedSize
        || verified.tailChecksum !== expectedChecksum
        || !sameObservation(written, verified.journal)) {
        throw new Error('backup journal post-append mismatch')
      }
      return verified
    } catch {
      const restored = await restoreBackupJournalSize(handle, opened, state.journal.size, expectedSize, lineBytes)
      if (!restored) {
        throw new FileBackupError('BACKUP_CONFLICT', '文件备份日志校验失败且出现外部冲突，未猜测修复。')
      }
      throw new FileBackupError('BACKUP_CORRUPT', '文件备份日志追加未通过 replay，已回退到原始长度。')
    }
  } catch (error) {
    if (appendStarted && handle !== undefined
      && !(error instanceof FileBackupError && error.code === 'BACKUP_CORRUPT')) {
      await restoreBackupJournalSize(handle, state.journal, state.journal.size, expectedSize, lineBytes)
    }
    if (errorCode(error) === 'ELOOP') throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份日志不能是符号链接。')
    throw error
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // Synced journal state remains authoritative.
      }
    }
  }
}

async function restoreBackupJournalSize(
  handle: Awaited<ReturnType<typeof openFile>>,
  expectedIdentity: Pick<Stats, 'dev' | 'ino'>,
  originalSize: number,
  expectedSize: number,
  attemptedBytes: Buffer,
): Promise<boolean> {
  try {
    const current = await handle.stat()
    if (!sameFilesystemObject(current, expectedIdentity)
      || current.size > expectedSize || current.size < originalSize) return false
    if (current.size > originalSize) {
      const suffixLength = current.size - originalSize
      if (suffixLength > attemptedBytes.byteLength) return false
      const suffix = Buffer.alloc(suffixLength)
      const read = await handle.read(suffix, 0, suffixLength, originalSize)
      if (read.bytesRead !== suffixLength || !suffix.equals(attemptedBytes.subarray(0, suffixLength))) return false
    }
    await handle.truncate(originalSize)
    await handle.sync()
    const restored = await handle.stat()
    return sameFilesystemObject(restored, expectedIdentity) && restored.size === originalSize
  } catch {
    return false
  }
}

function selectSnapshot(
  state: BackupState,
  selector: string,
): { readonly id: Sha256Id; readonly snapshot: FileBackupSnapshot } {
  if (state.snapshots.length === 0) {
    throw new FileBackupError('BACKUP_SNAPSHOT_NOT_FOUND', '此仓库还没有文件快照。')
  }
  if (selector === 'LATEST' || selector === 'HEAD') return state.snapshots.at(-1)!
  if (!SHA256_ID.test(selector)) {
    throw new FileBackupError('BACKUP_SNAPSHOT_NOT_FOUND', '文件快照选择器必须是 LATEST 或完整 SHA-256 id。')
  }
  const selected = state.snapshots.find(item => item.id === selector)
  if (selected === undefined) throw new FileBackupError('BACKUP_SNAPSHOT_NOT_FOUND', '文件快照不存在于当前仓库历史。')
  return selected
}

async function readStrictTextFile(
  path: string,
  maxBytes: number,
  label: string,
  signal?: AbortSignal,
): Promise<{ readonly source: string; readonly observation: RepositoryFileObservation }> {
  assertNotAborted(signal)
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  try {
    const before = await lstat(path)
    if (before.isSymbolicLink() || !before.isFile() || before.ino === 0 || before.size > maxBytes) {
      throw new FileBackupError('BACKUP_CORRUPT', `${label}身份或大小无效。`)
    }
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    handle = await openFile(path, flags)
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFilesystemObject(before, opened)) {
      throw new FileBackupError('BACKUP_CONFLICT', `${label}在读取前发生替换。`)
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (!sameFilesystemObject(opened, after) || bytes.byteLength !== after.size || after.size > maxBytes) {
      throw new FileBackupError('BACKUP_CONFLICT', `${label}在读取期间发生变化。`)
    }
    try {
      return {
        source: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        observation: { dev: opened.dev, ino: opened.ino, size: opened.size },
      }
    } catch {
      throw new FileBackupError('BACKUP_CORRUPT', `${label}不是有效 UTF-8。`)
    }
  } catch (error) {
    if (errorCode(error) === 'ELOOP') throw new FileBackupError('BACKUP_PATH_ESCAPE', `${label}不能是符号链接。`)
    throw error
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The primary read outcome wins.
      }
    }
  }
}

async function writeNewFile(
  path: string,
  bytes: Buffer,
  mode: number,
  signal?: AbortSignal,
): Promise<void> {
  assertNotAborted(signal)
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    handle = await openFile(path, flags, mode & 0o777)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino === 0) throw new FileBackupError('BACKUP_PATH_ESCAPE', '新文件无法绑定普通文件身份。')
    assertNotAborted(signal)
    await handle.writeFile(bytes)
    await handle.sync()
    const written = await handle.stat()
    if (!sameFilesystemObject(opened, written) || written.size !== bytes.byteLength) {
      throw new FileBackupError('BACKUP_CONFLICT', '新文件写入期间发生冲突。')
    }
  } catch (error) {
    if (errorCode(error) === 'ELOOP') throw new FileBackupError('BACKUP_PATH_ESCAPE', '新文件路径不能是符号链接。')
    throw error
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // Synced file bytes are authoritative.
      }
    }
  }
}

async function syncDirectory(path: string, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal)
  // Node cannot open/sync directory handles on Windows. Every newly written
  // file is already fsynced; match the repository initializer's portability
  // boundary and keep directory sync best-effort on POSIX only.
  if (process.platform === 'win32') return
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  try {
    handle = await openFile(path, constants.O_RDONLY | constants.O_DIRECTORY)
    const opened = await handle.stat()
    if (!opened.isDirectory() || opened.ino === 0) throw new FileBackupError('BACKUP_PATH_ESCAPE', '待同步路径不是稳定目录。')
    await handle.sync()
  } finally {
    if (handle !== undefined) await handle.close()
  }
}

function parseCanonicalJson(source: string, label: string): JsonValue {
  if (source.includes('\r')) throw new FileBackupError('BACKUP_CORRUPT', `${label}必须使用 LF。`)
  let parsed: unknown
  try {
    parsed = JSON.parse(source) as unknown
  } catch {
    throw new FileBackupError('BACKUP_CORRUPT', `${label}不是有效 JSON。`)
  }
  let canonical: string
  try {
    canonical = canonicalJson(parsed)
  } catch {
    throw new FileBackupError('BACKUP_CORRUPT', `${label}包含非无损 JSON 值。`)
  }
  if (canonical !== source) throw new FileBackupError('BACKUP_CORRUPT', `${label}不是 canonical JSON。`)
  return cloneJson(parsed as JsonValue)
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new FileBackupError('BACKUP_CORRUPT', message)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], message: string): void {
  const keys = Object.keys(value).sort(compareCodePoint)
  const wanted = [...expected].sort(compareCodePoint)
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new FileBackupError('BACKUP_CORRUPT', message)
  }
}

function requireHash(value: unknown, message: string): Sha256Id {
  if (typeof value !== 'string' || !SHA256_ID.test(value)) throw new FileBackupError('BACKUP_CORRUPT', message)
  return value as Sha256Id
}

function requireTimestamp(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40 || Number.isNaN(Date.parse(value))) {
    throw new FileBackupError('BACKUP_CORRUPT', message)
  }
  return value
}

function requireBoundedString(value: unknown, min: number, max: number, message: string): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new FileBackupError('BACKUP_CORRUPT', message)
  return value
}

function requireSafeInteger(value: unknown, min: number, max: number, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new FileBackupError('BACKUP_CORRUPT', message)
  }
  return value as number
}

function requireFiniteNumber(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new FileBackupError('BACKUP_CORRUPT', message)
  return value
}

function hashJsonId(value: unknown): Sha256Id {
  return `sha256:${sha256(value)}`
}

function hashRawId(bytes: Buffer): Sha256Id {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function observeDirectory(value: Pick<Stats, 'dev' | 'ino'>): DirectoryObservation {
  if (value.ino === 0) throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件系统无法提供稳定目录身份。')
  return { dev: value.dev, ino: value.ino }
}

function sameFilesystemObject(
  left: Pick<Stats, 'dev' | 'ino'> | DirectoryObservation,
  right: Pick<Stats, 'dev' | 'ino'> | DirectoryObservation,
): boolean {
  return left.ino !== 0 && right.ino !== 0 && left.dev === right.dev && left.ino === right.ino
}

function sameObservation(
  left: Pick<Stats, 'dev' | 'ino' | 'size'>,
  right: Pick<Stats, 'dev' | 'ino' | 'size'>,
): boolean {
  return sameFilesystemObject(left, right) && left.size === right.size
}

function inside(root: string, ...parts: readonly string[]): string {
  const canonicalRoot = resolve(root)
  const target = resolve(canonicalRoot, ...parts)
  if (!isContainedBy(canonicalRoot, target)) {
    throw new FileBackupError('BACKUP_PATH_ESCAPE', '文件备份路径逃逸了受控目录。')
  }
  return target
}

function isContainedBy(root: string, target: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(target))
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code as string | undefined
    : undefined
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}
