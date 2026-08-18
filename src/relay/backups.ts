import type { Context } from 'cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  FileBackupError,
  FileBackupRepository,
  type FileBackupCaptureResult,
  type FileBackupReason,
} from '../core/backup.js'

const RECONCILE_INTERVAL_MS = 60_000
const INITIAL_RECONCILE_DELAY_MS = 5_000

export interface FileBackupRuntimeStatus {
  readonly running: boolean
  readonly lastError?: string
  readonly lastErrorAt?: string
}

/** Owns enabled-workspace polling and coalesces automatic captures. */
export class FileBackupScheduler {
  private readonly inFlight = new Map<string, Promise<FileBackupCaptureResult>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly failures = new Map<string, { readonly message: string; readonly at: string }>()
  private readonly configuredWorkspaceIds = new Set<string>()
  private bootstrapped = false
  private stopped = false

  constructor(private readonly ctx: Context) {}

  install(): void {
    this.ctx.effect(() => {
      const disposeInitial = this.ctx.timeout(() => { void this.reconcile() }, INITIAL_RECONCILE_DELAY_MS)
      const disposeInterval = this.ctx.interval(() => { void this.reconcile() }, RECONCILE_INTERVAL_MS)
      return async () => {
        this.stopped = true
        disposeInitial()
        disposeInterval()
        for (const controller of this.controllers.values()) controller.abort(new DOMException('backup scheduler disposed', 'AbortError'))
        await Promise.allSettled(this.inFlight.values())
        this.controllers.clear()
        this.inFlight.clear()
      }
    }, 'local-git-4-llm:file-backup-scheduler')
  }

  getRuntimeStatus(workspaceId: string): FileBackupRuntimeStatus {
    const failure = this.failures.get(workspaceId)
    return {
      running: this.inFlight.has(workspaceId),
      ...(failure === undefined ? {} : { lastError: failure.message, lastErrorAt: failure.at }),
    }
  }

  clearFailure(workspaceId: string): void {
    this.failures.delete(workspaceId)
  }

  trackConfigured(workspaceId: string): void {
    this.configuredWorkspaceIds.add(workspaceId)
  }

  untrackDisabled(workspaceId: string): void {
    this.configuredWorkspaceIds.delete(workspaceId)
  }

  async captureNow(
    workspace: Workspace,
    reason: FileBackupReason,
    signal?: AbortSignal,
  ): Promise<FileBackupCaptureResult> {
    const workspaceId = String(workspace.id)
    const existing = this.inFlight.get(workspaceId)
    if (existing !== undefined) {
      throw new FileBackupError('BACKUP_BUSY', '此仓库已有正在执行的文件备份。')
    }
    const operation = FileBackupRepository.capture(workspace.path, workspaceId, reason, signal)
      .then((result) => {
        this.failures.delete(workspaceId)
        return result
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          this.failures.set(workspaceId, {
            message: sanitizeFailure(error),
            at: new Date().toISOString(),
          })
        }
        throw error
      })
      .finally(() => {
        if (this.inFlight.get(workspaceId) === operation) this.inFlight.delete(workspaceId)
      })
    this.inFlight.set(workspaceId, operation)
    return operation
  }

  private async reconcile(): Promise<void> {
    if (this.stopped) return
    if (!this.bootstrapped) {
      this.bootstrapped = true
      for (const workspace of this.ctx.workspaceRegistry.list()) {
        try {
          if (await FileBackupRepository.hasBackupMarker(workspace.path)) {
            this.configuredWorkspaceIds.add(String(workspace.id))
          }
        } catch (error) {
          this.failures.set(String(workspace.id), { message: sanitizeFailure(error), at: new Date().toISOString() })
        }
      }
    }
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      if (this.stopped) return
      const workspaceId = String(workspace.id)
      if (!this.configuredWorkspaceIds.has(workspaceId)) continue
      if (this.inFlight.has(workspaceId)) continue
      try {
        const status = await FileBackupRepository.status(workspace.path, workspaceId)
        if (!status.enabled || status.config === undefined) {
          this.configuredWorkspaceIds.delete(workspaceId)
          continue
        }
        const dueAt = status.latest === undefined
          ? 0
          : Date.parse(status.latest.capturedAt) + status.config.intervalMinutes * 60_000
        if (Date.now() < dueAt) continue
        const controller = new AbortController()
        this.controllers.set(workspaceId, controller)
        void this.captureNow(workspace, 'scheduled', controller.signal)
          .catch(() => undefined)
          .finally(() => {
            if (this.controllers.get(workspaceId) === controller) this.controllers.delete(workspaceId)
          })
      } catch (error) {
        if (error instanceof FileBackupError || !isExpectedUninitialized(error)) {
          this.failures.set(workspaceId, { message: sanitizeFailure(error), at: new Date().toISOString() })
        }
      }
    }
  }
}

export function installFileBackupScheduler(ctx: Context): FileBackupScheduler {
  const scheduler = new FileBackupScheduler(ctx)
  scheduler.install()
  return scheduler
}

function sanitizeFailure(error: unknown): string {
  if (error instanceof FileBackupError) return error.message
  if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'REPO_NOT_INITIALIZED') {
    return '仓库尚未初始化。'
  }
  return '自动文件备份未能安全完成。'
}

function isExpectedUninitialized(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'REPO_NOT_INITIALIZED'
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}
