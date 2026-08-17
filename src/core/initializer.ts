import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open as openFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { assertNotAborted, canonicalJson, sha256 } from './canonical.js'
import { RepositoryReader, RepositoryReadError } from './repository.js'
import {
  REPOSITORY_FORMAT,
  REPOSITORY_FORMAT_VERSION,
  type JsonValue,
  type RepositoryManifest,
  type Sha256Id,
} from './types.js'

const REPOSITORY_DIR = '.dsh-repo'
const STAGING_PREFIX = '.local-git-4-llm-init-'

export type RepositoryInitializationErrorCode =
  | 'REPO_EXISTS_INVALID'
  | 'REPO_EXISTS_FOREIGN'
  | 'REPO_PATH_ESCAPE'
  | 'REPO_INIT_CONFLICT'
  | 'REPO_INIT_IO'
  | 'REPO_INIT_VERIFY_FAILED'

/** Sanitized write failure used by the explicit M1b initialization tool. */
export class RepositoryInitializationError extends Error {
  constructor(readonly code: RepositoryInitializationErrorCode, message: string) {
    super(message)
    this.name = 'RepositoryInitializationError'
  }
}

export interface RepositoryInitializationResult {
  /** True only when this call published a new repository. */
  readonly initialized: boolean
  readonly repoId: string
  readonly workspaceId: string
  readonly createdAt: string
  readonly journalEntries: number
  readonly head: Sha256Id | null
}

/**
 * Creates a complete empty repository only when explicitly invoked by M1b.
 * It never adopts, overwrites, repairs, or searches workspace data. A fully
 * prepared private staging directory is renamed into place only after both
 * canonical files have been durably written.
 */
export class RepositoryInitializer {
  static async initialize(workspacePath: string, workspaceId: string, signal?: AbortSignal): Promise<RepositoryInitializationResult> {
    const workspaceRoot = await canonicalWorkspaceRoot(workspacePath, signal)
    const repositoryPath = inside(workspaceRoot, REPOSITORY_DIR)

    const existing = await existingRepository(workspaceRoot, workspacePath, workspaceId, repositoryPath, signal)
    if (existing !== undefined) return existing

    const stagingPath = inside(workspaceRoot, `${STAGING_PREFIX}${randomUUID()}`)
    let staged = false
    let published = false
    try {
      await mkdir(stagingPath, { mode: 0o700 })
      staged = true
      const stagingRoot = await canonicalNewDirectory(stagingPath, workspaceRoot, signal)

      const createdAt = new Date().toISOString()
      const repoId = `repo_${randomUUID()}`
      const manifest: RepositoryManifest = {
        format: REPOSITORY_FORMAT,
        formatVersion: REPOSITORY_FORMAT_VERSION,
        repoId,
        workspaceId,
        storage: 'workspace',
        journal: { file: 'journal.jsonl', hash: 'sha256' },
        createdAt,
      }
      const initialized = journalRecord({
        formatVersion: REPOSITORY_FORMAT_VERSION,
        seq: 1,
        type: 'repo.initialized',
        ts: createdAt,
        prev: null,
        payload: { repoId, workspaceId, manifestHash: hashId(manifest) },
      })

      await writeNewCanonicalFile(inside(stagingRoot, 'journal.jsonl'), stagingRoot, `${canonicalJson(initialized)}\n`, signal)
      await writeNewCanonicalFile(inside(stagingRoot, 'manifest.json'), stagingRoot, `${canonicalJson(manifest)}\n`, signal)
      await syncDirectory(stagingRoot, signal)
      const stagingIdentity = await lstat(stagingRoot)
      if (stagingIdentity.isSymbolicLink() || !stagingIdentity.isDirectory() || stagingIdentity.ino === 0) {
        throw new RepositoryInitializationError('REPO_PATH_ESCAPE', 'Initialization staging directory lost its verified identity.')
      }

      // A second non-mutating check keeps initialization idempotent if another
      // explicit caller won the race while this staging directory was prepared.
      const destination = await lstatIfExists(repositoryPath)
      if (destination !== undefined) {
        const repository = await existingRepository(workspaceRoot, workspacePath, workspaceId, repositoryPath, signal)
        if (repository !== undefined) return repository
        throw new RepositoryInitializationError('REPO_INIT_CONFLICT', 'Repository destination changed while initialization was preparing.')
      }

      assertNotAborted(signal)
      try {
        await rename(stagingRoot, repositoryPath)
      } catch (error) {
        try {
          const afterRace = await existingRepository(workspaceRoot, workspacePath, workspaceId, repositoryPath, signal)
          if (afterRace !== undefined) return afterRace
        } catch {
          // A destination appeared but is invalid/foreign, or the platform
          // refused the rename. Never remove or replace it to retry.
        }
        throw new RepositoryInitializationError('REPO_INIT_CONFLICT', 'Repository destination changed or could not be claimed safely.')
      }
      published = true
      try {
        const publishedDirectory = await lstat(repositoryPath)
        if (publishedDirectory.isSymbolicLink() || !publishedDirectory.isDirectory() || !sameFilesystemObject(stagingIdentity, publishedDirectory)) {
          throw new RepositoryInitializationError('REPO_INIT_CONFLICT', 'Repository destination changed immediately after publication and was left untouched.')
        }
      } catch (error) {
        if (error instanceof RepositoryInitializationError) throw error
        throw new RepositoryInitializationError('REPO_INIT_CONFLICT', 'Repository destination changed immediately after publication and was left untouched.')
      }

      // Replay through the public reader before returning success. This ensures
      // no writer-only shortcut can create a repository the reader rejects.
      try {
        // The rename is the transaction's publication point. A cancellation
        // observed after it must not be reported as “nothing happened”; finish
        // verification and return the published identity instead.
        const reader = await RepositoryReader.open(workspacePath, workspaceId)
        if (reader === undefined) {
          throw new Error('published repository is absent')
        }
        const status = await reader.status()
        if (status.repoId !== repoId || status.workspaceId !== workspaceId) {
          throw new RepositoryInitializationError('REPO_INIT_CONFLICT', 'Repository destination changed after publication and was left untouched.')
        }
        if (status.journalEntries !== 1 || status.head !== null) {
          throw new RepositoryInitializationError('REPO_INIT_VERIFY_FAILED', 'Repository was published but could not be verified; it was left untouched.')
        }
        return {
          initialized: true,
          repoId: status.repoId,
          workspaceId: status.workspaceId,
          createdAt,
          journalEntries: status.journalEntries,
          head: status.head,
        }
      } catch (error) {
        if (error instanceof RepositoryInitializationError) throw error
        if (error instanceof RepositoryReadError && error.code === 'REPO_PATH_ESCAPE') {
          throw new RepositoryInitializationError('REPO_INIT_CONFLICT', 'Repository destination changed after publication and was left untouched.')
        }
        throw new RepositoryInitializationError('REPO_INIT_VERIFY_FAILED', 'Repository was published but could not be verified; it was left untouched.')
      }
    } catch (error) {
      if (error instanceof RepositoryInitializationError || error instanceof RepositoryReadError) throw error
      if (isAbortError(error)) throw error
      throw new RepositoryInitializationError('REPO_INIT_IO', 'Repository initialization could not complete safely.')
    } finally {
      if (staged && !published) await removeStagingDirectory(stagingPath, workspaceRoot)
    }
  }
}

async function existingRepository(
  workspaceRoot: string,
  workspacePath: string,
  workspaceId: string,
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<RepositoryInitializationResult | undefined> {
  const entry = await lstatIfExists(repositoryPath)
  if (entry === undefined) return undefined
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new RepositoryInitializationError('REPO_PATH_ESCAPE', 'Existing repository location is not a real directory inside this workspace.')
  }
  const canonical = await realpath(repositoryPath)
  if (!isContainedBy(workspaceRoot, canonical)) {
    throw new RepositoryInitializationError('REPO_PATH_ESCAPE', 'Existing repository resolves outside the registered workspace.')
  }
  try {
    const reader = await RepositoryReader.open(workspacePath, workspaceId, signal)
    if (reader === undefined) return undefined
    const status = await reader.status(signal)
    return {
      initialized: false,
      repoId: status.repoId,
      workspaceId: status.workspaceId,
      createdAt: reader.manifest.createdAt,
      journalEntries: status.journalEntries,
      head: status.head,
    }
  } catch (error) {
    if (error instanceof RepositoryReadError && error.code === 'REPO_PATH_ESCAPE') {
      throw new RepositoryInitializationError('REPO_EXISTS_FOREIGN', 'Existing repository belongs to another workspace or resolves outside this workspace.')
    }
    if (isAbortError(error)) throw error
    throw new RepositoryInitializationError('REPO_EXISTS_INVALID', 'A repository location already exists but is invalid; initialization will not modify it.')
  }
}

async function canonicalWorkspaceRoot(workspacePath: string, signal?: AbortSignal): Promise<string> {
  assertNotAborted(signal)
  const canonical = await realpath(workspacePath)
  const entry = await stat(canonical)
  if (!entry.isDirectory()) throw new RepositoryInitializationError('REPO_PATH_ESCAPE', 'Registered workspace path is not an accessible directory.')
  assertNotAborted(signal)
  return canonical
}

async function canonicalNewDirectory(path: string, workspaceRoot: string, signal?: AbortSignal): Promise<string> {
  assertNotAborted(signal)
  const canonical = await realpath(path)
  const entry = await lstat(canonical)
  if (entry.isSymbolicLink() || !entry.isDirectory() || !isContainedBy(workspaceRoot, canonical)) {
    throw new RepositoryInitializationError('REPO_PATH_ESCAPE', 'Initialization staging directory escaped the registered workspace.')
  }
  assertNotAborted(signal)
  return canonical
}

async function writeNewCanonicalFile(path: string, parentRoot: string, contents: string, signal?: AbortSignal): Promise<void> {
  const parent = await realpath(resolve(path, '..'))
  if (!isContainedBy(parentRoot, parent)) {
    throw new RepositoryInitializationError('REPO_PATH_ESCAPE', 'Initialization file parent escaped the staging directory.')
  }
  assertNotAborted(signal)
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  try {
    // O_EXCL prevents a final-component replacement on every supported
    // platform. O_NOFOLLOW adds defense in depth on POSIX; Windows may reject
    // it, so Windows relies on exclusive create plus identity verification.
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    handle = await openFile(path, flags, 0o600)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino === 0) {
      throw new RepositoryInitializationError('REPO_PATH_ESCAPE', 'Initialization file could not be bound to a regular file identity.')
    }
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    const current = await lstat(path)
    if (current.isSymbolicLink() || !current.isFile() || !sameFilesystemObject(opened, current)) {
      throw new RepositoryInitializationError('REPO_PATH_ESCAPE', 'Initialization file changed while it was being written.')
    }
    assertNotAborted(signal)
  } catch (error) {
    if (errorCode(error) === 'ELOOP') {
      throw new RepositoryInitializationError('REPO_PATH_ESCAPE', 'Initialization file must not be a symbolic link.')
    }
    throw error
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // Keep the primary write/boundary error, if any.
      }
    }
  }
}

async function syncDirectory(path: string, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal)
  // Windows does not permit opening directories through Node's fs promises in
  // the same way as POSIX. File handles were already synced; directory sync is
  // therefore best-effort and intentionally does not weaken the write result.
  if (process.platform === 'win32') return
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  try {
    handle = await openFile(path, constants.O_RDONLY | constants.O_DIRECTORY)
    await handle.sync()
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // Directory sync is best-effort on platforms that support it.
      }
    }
  }
}

async function removeStagingDirectory(path: string, workspaceRoot: string): Promise<void> {
  try {
    const entry = await lstatIfExists(path)
    if (entry === undefined || entry.isSymbolicLink() || !entry.isDirectory()) return
    const canonical = await realpath(path)
    if (!isContainedBy(workspaceRoot, canonical) || !canonical.split(/[\\/]/).at(-1)?.startsWith(STAGING_PREFIX)) return
    await rm(canonical, { recursive: true, force: true })
  } catch {
    // Preserve an unexpected staging path rather than attempting aggressive cleanup.
  }
}

function journalRecord(unsigned: {
  readonly formatVersion: typeof REPOSITORY_FORMAT_VERSION
  readonly seq: number
  readonly type: 'repo.initialized'
  readonly ts: string
  readonly prev: null
  readonly payload: JsonValue
}): JsonValue {
  return { ...unsigned, checksum: hashId(unsigned) }
}

function hashId(value: unknown): Sha256Id {
  return `sha256:${sha256(value)}` as Sha256Id
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

function inside(root: string, ...parts: readonly string[]): string {
  const canonicalRoot = resolve(root)
  const target = join(canonicalRoot, ...parts)
  if (!isContainedBy(canonicalRoot, target)) {
    throw new RepositoryInitializationError('REPO_PATH_ESCAPE', 'Repository path escapes the registered workspace boundary.')
  }
  return target
}

function isContainedBy(root: string, target: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(target))
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function sameFilesystemObject(left: Stats, right: Stats): boolean {
  return left.ino !== 0 && right.ino !== 0 && left.dev === right.dev && left.ino === right.ino
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code as string | undefined
    : undefined
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}
