import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import { FileBackupError, FileBackupRepository, type FileBackupScope } from '../core/backup.js'
import { sha256 } from '../core/canonical.js'
import { RepositoryInitializer, RepositoryInitializationError } from '../core/initializer.js'
import { RepositoryReader, RepositoryReadError } from '../core/repository.js'
import { RepositoryWriteError, RepositoryWriter } from '../core/writer.js'
import { recordRepositorySelection } from '../core/workspace-selection.js'
import type { FileBackupScheduler } from '../relay/backups.js'
import { persistAndRelayComment } from '../relay/comments.js'

export const ADMIN_API_ROOT = '/local-git-4-llm/api'
const MAX_BODY_BYTES = 64 * 1024
const MAX_BACKUP_ROOT_TOKENS = 10_000

interface BackupRootToken {
  readonly workspaceId: string
  readonly path: string
  readonly kind: 'file' | 'directory'
}

class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'AdminApiError'
  }
}

/**
 * Same-origin management API for the additive browser panel. It accepts only
 * stable Workspace ids, never filesystem paths. A per-run capability is read
 * through a no-CORS endpoint before every privileged request.
 */
export function installAdminApi(ctx: Context, backupScheduler: FileBackupScheduler): void {
  const capability = randomUUID()
  const backupRootTokens = new Map<string, BackupRootToken>()
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ADMIN_API_ROOT,
    handler: async (req, res) => {
      try {
        await routeAdminRequest(ctx, backupScheduler, capability, backupRootTokens, req, res)
      } catch (error) {
        sendApiFailure(res, error)
      }
    },
  }), 'local-git-4-llm:admin-api')
}

async function routeAdminRequest(
  ctx: Context,
  backupScheduler: FileBackupScheduler,
  capability: string,
  backupRootTokens: Map<string, BackupRootToken>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? ADMIN_API_ROOT, 'http://local.invalid')
  const suffix = url.pathname.slice(ADMIN_API_ROOT.length)

  if (req.method === 'GET' && suffix === '/capability') {
    requireSameOrigin(req)
    sendJson(res, 200, { ok: true, capability })
    return
  }

  requireCapability(req, capability)
  if (req.method === 'GET' && suffix === '/state') {
    const workspace = requireWorkspace(ctx, url.searchParams.get('workspaceId'))
    const selector = url.searchParams.get('selector') ?? 'HEAD'
    const reader = await RepositoryReader.open(workspace.path, String(workspace.id))
    const sessionIds = workspace.sessionIds.map(String)
    const liveAgents = sessionIds.flatMap((sessionId) => {
      const agent = ctx.agents.get(SessionId(sessionId))
      return agent === undefined ? [] : [{ id: sessionId, status: agent.status }]
    })
    if (reader === undefined) {
      sendJson(res, 200, {
        ok: true,
        data: {
          workspace: workspaceView(workspace),
          initialized: false,
          liveAgents,
          backup: emptyBackupView(backupScheduler.getRuntimeStatus(String(workspace.id))),
        },
      })
      return
    }
    const board = await reader.board(selector, 100)
    const backup = await backupView(workspace, backupScheduler)
    sendJson(res, 200, {
      ok: true,
      data: {
        workspace: workspaceView(workspace),
        initialized: true,
        liveAgents,
        backup,
        ...board,
      },
    })
    return
  }

  if (req.method === 'GET' && suffix === '/backup/candidates') {
    const workspace = requireWorkspace(ctx, url.searchParams.get('workspaceId'))
    const workspaceId = String(workspace.id)
    const parentId = url.searchParams.get('parentId')
    const parent = parentId === null ? undefined : backupRootTokens.get(parentId)
    if (parentId !== null && (parent === undefined || parent.workspaceId !== workspaceId || parent.kind !== 'directory')) {
      throw new AdminApiError(400, 'INVALID_REQUEST', '目录选择令牌已失效，请刷新面板后重试。')
    }
    const candidates = [...await FileBackupRepository.listRootCandidates(workspace.path, workspaceId, parent?.path ?? '')]
    const selected = await configuredBackupRoots(workspace)
    if (parent === undefined) {
      for (const root of selected) {
        if (candidates.some(candidate => candidate.path === root)) continue
        try {
          candidates.push(await FileBackupRepository.describeRootCandidate(workspace.path, workspaceId, root))
        } catch (error) {
          if (!(error instanceof FileBackupError)) throw error
        }
      }
      candidates.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    }
    const views = candidates.map((candidate) => {
      const id = backupRootId(capability, workspaceId, candidate.path)
      rememberBackupRootToken(backupRootTokens, id, { workspaceId, path: candidate.path, kind: candidate.kind })
      return {
        id,
        label: candidate.path,
        kind: candidate.kind,
        selected: selected.includes(candidate.path),
      }
    })
    sendJson(res, 200, {
      ok: true,
      data: {
        candidates: views,
        parentId,
      },
    })
    return
  }

  if (req.method === 'GET' && suffix === '/backup/history') {
    const workspace = requireWorkspace(ctx, url.searchParams.get('workspaceId'))
    const snapshots = await FileBackupRepository.history(workspace.path, String(workspace.id), 100)
    sendJson(res, 200, { ok: true, data: { snapshots } })
    return
  }

  if (req.method === 'GET' && suffix === '/backup/snapshot') {
    const workspace = requireWorkspace(ctx, url.searchParams.get('workspaceId'))
    const selector = url.searchParams.get('snapshot') ?? 'LATEST'
    const limitValue = Number(url.searchParams.get('limit') ?? 100)
    const cursor = url.searchParams.get('cursor') ?? undefined
    const checkout = await FileBackupRepository.checkout(
      workspace.path,
      String(workspace.id),
      selector,
      limitValue,
      cursor,
    )
    sendJson(res, 200, { ok: true, data: checkout })
    return
  }

  if (req.method === 'GET' && suffix === '/backup/preview') {
    const workspace = requireWorkspace(ctx, url.searchParams.get('workspaceId'))
    const snapshot = url.searchParams.get('snapshot') ?? 'LATEST'
    const path = url.searchParams.get('path')
    if (path === null) throw new AdminApiError(400, 'INVALID_REQUEST', '文件预览路径缺失。')
    const preview = await FileBackupRepository.preview(workspace.path, String(workspace.id), snapshot, path)
    sendJson(res, 200, { ok: true, data: preview })
    return
  }

  if (req.method === 'POST' && suffix === '/initialize') {
    const body = requireRecord(await readJson(req), 'INVALID_REQUEST', '初始化请求必须是 JSON 对象。')
    assertExactKeys(body, ['workspaceId'])
    const workspace = requireWorkspace(ctx, body.workspaceId)
    const result = await RepositoryInitializer.initialize(workspace.path, String(workspace.id))
    sendJson(res, 200, { ok: true, data: result })
    return
  }

  if (req.method === 'POST' && suffix === '/activate') {
    const body = requireRecord(await readJson(req), 'INVALID_REQUEST', '仓库激活请求必须是 JSON 对象。')
    assertExactKeys(body, ['sessionId', 'workspaceId'])
    const workspace = requireWorkspace(ctx, body.workspaceId)
    if (typeof body.sessionId !== 'string' || body.sessionId === '' || body.sessionId.length > 128) {
      throw new AdminApiError(400, 'INVALID_REQUEST', '当前会话 ID 无效。')
    }
    const agent = ctx.agents.get(SessionId(body.sessionId))
    if (agent === undefined) throw new AdminApiError(409, 'SESSION_NOT_LIVE', '当前会话不在线，无法从面板激活仓库。')
    recordRepositorySelection(agent, String(workspace.id), `panel-${randomUUID()}`)
    sendJson(res, 200, { ok: true, data: { workspaceId: String(workspace.id), sessionId: body.sessionId } })
    return
  }

  if (req.method === 'POST' && suffix === '/rollback') {
    const body = requireRecord(await readJson(req), 'INVALID_REQUEST', '回退请求必须是 JSON 对象。')
    assertAllowedKeys(body, ['workspaceId', 'target', 'message'])
    const workspace = requireWorkspace(ctx, body.workspaceId)
    if (typeof body.target !== 'string') throw new AdminApiError(400, 'INVALID_REQUEST', '回退目标无效。')
    if (body.message !== undefined && typeof body.message !== 'string') throw new AdminApiError(400, 'INVALID_REQUEST', '回退说明无效。')
    const result = await RepositoryWriter.rollback(workspace.path, String(workspace.id), {
      target: body.target,
      message: body.message ?? `管理员从管理面板回退到 ${body.target}`,
      author: { sessionId: 'admin-ui' },
    })
    if (!result.committed) throw new AdminApiError(409, 'ROLLBACK_NOOP', '当前 HEAD 已经是所选快照，没有追加回退提交。')
    sendJson(res, 200, { ok: true, data: result })
    return
  }

  if (req.method === 'POST' && suffix === '/comment') {
    const body = requireRecord(await readJson(req), 'INVALID_REQUEST', '评论请求必须是 JSON 对象。')
    assertAllowedKeys(body, ['workspaceId', 'body', 'mentions', 'issueId'])
    const workspace = requireWorkspace(ctx, body.workspaceId)
    if (typeof body.body !== 'string') throw new AdminApiError(400, 'INVALID_REQUEST', '评论正文无效。')
    if (body.issueId !== undefined && typeof body.issueId !== 'string') throw new AdminApiError(400, 'INVALID_REQUEST', '评论议题无效。')
    const mentions = normalizeMentions(body.mentions)
    const workspaceSessions = new Set(workspace.sessionIds.map(String))
    if (mentions.some(sessionId => !workspaceSessions.has(sessionId))) {
      throw new AdminApiError(400, 'MENTION_OUTSIDE_WORKSPACE', '只能 @ 当前工作区中的智能体会话。')
    }

    const result = await persistAndRelayComment(ctx, workspace, {
      body: body.body,
      mentions,
      author: 'admin',
      ...(body.issueId === undefined ? {} : { issueId: body.issueId }),
    })
    sendJson(res, 200, { ok: true, data: result })
    return
  }

  if (req.method === 'POST' && suffix === '/backup/enable') {
    const body = requireRecord(await readJson(req), 'INVALID_REQUEST', '文件备份启用请求必须是 JSON 对象。')
    assertAllowedKeys(body, ['confirmSensitiveRisk', 'intervalMinutes', 'rootIds', 'workspaceId'])
    if (!Object.hasOwn(body, 'workspaceId') || !Object.hasOwn(body, 'rootIds') || !Object.hasOwn(body, 'confirmSensitiveRisk')) {
      throw new AdminApiError(400, 'INVALID_REQUEST', '文件备份启用请求缺少必需字段。')
    }
    const workspace = requireWorkspace(ctx, body.workspaceId)
    if (body.confirmSensitiveRisk !== true) {
      throw new AdminApiError(400, 'BACKUP_CONFIRM_REQUIRED', '启用前必须确认备份可能包含敏感信息。')
    }
    if (body.intervalMinutes !== undefined && typeof body.intervalMinutes !== 'number') {
      throw new AdminApiError(400, 'INVALID_REQUEST', '自动备份间隔无效。')
    }
    const scope = await resolveBackupScope(backupRootTokens, workspace, body.rootIds)
    const status = await FileBackupRepository.enable(workspace.path, String(workspace.id), {
      scope,
      intervalMinutes: body.intervalMinutes,
      confirmSensitiveRisk: true,
    })
    backupScheduler.trackConfigured(String(workspace.id))
    backupScheduler.clearFailure(String(workspace.id))
    let capture
    try {
      capture = await backupScheduler.captureNow(workspace, 'initial')
    } catch (error) {
      if (error instanceof FileBackupError) {
        sendJson(res, 422, {
          ok: false,
          error: { code: error.code, message: `备份配置已保存，但初始快照失败：${error.message}` },
          data: { status },
        })
        return
      }
      throw error
    }
    sendJson(res, 200, { ok: true, data: capture })
    return
  }

  if (req.method === 'POST' && suffix === '/backup/disable') {
    const body = requireRecord(await readJson(req), 'INVALID_REQUEST', '文件备份禁用请求必须是 JSON 对象。')
    assertExactKeys(body, ['workspaceId'])
    const workspace = requireWorkspace(ctx, body.workspaceId)
    const status = await FileBackupRepository.disable(workspace.path, String(workspace.id), 'admin-ui')
    backupScheduler.untrackDisabled(String(workspace.id))
    backupScheduler.clearFailure(String(workspace.id))
    sendJson(res, 200, { ok: true, data: status })
    return
  }

  if (req.method === 'POST' && suffix === '/backup/capture') {
    const body = requireRecord(await readJson(req), 'INVALID_REQUEST', '文件快照请求必须是 JSON 对象。')
    assertExactKeys(body, ['workspaceId'])
    const workspace = requireWorkspace(ctx, body.workspaceId)
    const result = await backupScheduler.captureNow(workspace, 'manual')
    sendJson(res, 200, { ok: true, data: result })
    return
  }

  if (req.method === 'POST' && suffix === '/backup/export') {
    const body = requireRecord(await readJson(req), 'INVALID_REQUEST', '恢复导出请求必须是 JSON 对象。')
    assertExactKeys(body, ['snapshot', 'workspaceId'])
    const workspace = requireWorkspace(ctx, body.workspaceId)
    if (typeof body.snapshot !== 'string') throw new AdminApiError(400, 'INVALID_REQUEST', '文件快照 id 无效。')
    const result = await FileBackupRepository.exportSnapshot(workspace.path, String(workspace.id), body.snapshot)
    sendJson(res, 200, { ok: true, data: result })
    return
  }

  throw new AdminApiError(404, 'API_NOT_FOUND', '管理接口不存在。')
}

function requireCapability(req: IncomingMessage, capability: string): void {
  requireSameOrigin(req)
  if (req.headers['x-local-git-4-llm-capability'] !== capability) {
    throw new AdminApiError(403, 'CAPABILITY_REQUIRED', '管理能力已失效，请刷新面板后重试。')
  }
}

function requireSameOrigin(req: IncomingMessage): void {
  const fetchSite = firstHeader(req.headers['sec-fetch-site'])
  if (fetchSite !== undefined && fetchSite !== 'same-origin') {
    throw new AdminApiError(403, 'CROSS_SITE_REQUEST', '跨站请求不能访问管理接口。')
  }
  const origin = firstHeader(req.headers.origin)
  if (origin === undefined) return
  const host = firstHeader(req.headers.host)
  try {
    const parsed = new URL(origin)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || host === undefined || parsed.host !== host) {
      throw new Error('origin mismatch')
    }
  } catch {
    throw new AdminApiError(403, 'CROSS_SITE_REQUEST', '请求来源与管理面板不一致。')
  }
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0]
}

function requireWorkspace(ctx: Context, value: unknown): Workspace {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    throw new AdminApiError(400, 'INVALID_WORKSPACE', '工作区 id 无效。')
  }
  const workspace = ctx.workspaceRegistry.get(WorkspaceId(value))
  if (workspace === undefined) throw new AdminApiError(404, 'WORKSPACE_NOT_FOUND', '工作区不存在或已取消注册。')
  return workspace
}

function workspaceView(workspace: Workspace): {
  readonly id: string
  readonly title: string
  readonly sessionIds: readonly string[]
} {
  return { id: String(workspace.id), title: workspace.title, sessionIds: workspace.sessionIds.map(String) }
}

function normalizeMentions(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 32) throw new AdminApiError(400, 'INVALID_MENTIONS', '@智能体列表无效。')
  const mentions = value.map((item) => {
    if (typeof item !== 'string' || item.trim() === '' || item.length > 256) {
      throw new AdminApiError(400, 'INVALID_MENTIONS', '@智能体 id 无效。')
    }
    return item
  })
  if (new Set(mentions).size !== mentions.length) throw new AdminApiError(400, 'INVALID_MENTIONS', '@智能体不能重复。')
  return mentions
}

async function resolveBackupScope(
  tokens: ReadonlyMap<string, BackupRootToken>,
  workspace: Workspace,
  value: unknown,
): Promise<FileBackupScope> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16
    || value.some(item => typeof item !== 'string' || item.length > 96)) {
    throw new AdminApiError(400, 'INVALID_REQUEST', '请选择 1–16 个面板提供的备份根。')
  }
  const rootIds = value as string[]
  if (new Set(rootIds).size !== rootIds.length) throw new AdminApiError(400, 'INVALID_REQUEST', '备份根不能重复。')
  const workspaceId = String(workspace.id)
  const roots: string[] = []
  for (const id of rootIds) {
    const token = tokens.get(id)
    if (token === undefined || token.workspaceId !== workspaceId) {
      throw new AdminApiError(400, 'INVALID_REQUEST', '备份根令牌已失效，请刷新面板后重试。')
    }
    const current = await FileBackupRepository.describeRootCandidate(workspace.path, workspaceId, token.path)
    if (current.kind !== token.kind) throw new AdminApiError(409, 'BACKUP_ROOT_CHANGED', '备份根类型发生变化，请刷新面板后重试。')
    roots.push(current.path)
  }
  return { kind: 'selected', roots }
}

async function configuredBackupRoots(workspace: Workspace): Promise<readonly string[]> {
  try {
    const status = await FileBackupRepository.status(workspace.path, String(workspace.id))
    return status.config?.scope.kind === 'selected' ? status.config.scope.roots : []
  } catch (error) {
    if (error instanceof FileBackupError) return []
    throw error
  }
}

function backupRootId(capability: string, workspaceId: string, path: string): string {
  return `root_${sha256({ capability, workspaceId, path })}`
}

function rememberBackupRootToken(tokens: Map<string, BackupRootToken>, id: string, token: BackupRootToken): void {
  tokens.delete(id)
  tokens.set(id, token)
  while (tokens.size > MAX_BACKUP_ROOT_TOKENS) {
    const oldest = tokens.keys().next().value as string | undefined
    if (oldest === undefined) break
    tokens.delete(oldest)
  }
}

async function backupView(workspace: Workspace, scheduler: FileBackupScheduler): Promise<unknown> {
  const workspaceId = String(workspace.id)
  try {
    const status = await FileBackupRepository.status(workspace.path, workspaceId)
    return { ...status, runtime: scheduler.getRuntimeStatus(workspaceId) }
  } catch (error) {
    if (error instanceof FileBackupError) {
      return {
        configured: true,
        enabled: false,
        integrity: 'error',
        journalEntries: 0,
        snapshots: 0,
        runtime: { ...scheduler.getRuntimeStatus(workspaceId), lastError: error.message },
      }
    }
    throw error
  }
}

function emptyBackupView(runtime: ReturnType<FileBackupScheduler['getRuntimeStatus']>): unknown {
  return { configured: false, enabled: false, integrity: 'ok', journalEntries: 0, snapshots: 0, runtime }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new AdminApiError(415, 'JSON_REQUIRED', '管理写请求必须使用 application/json。')
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new AdminApiError(413, 'REQUEST_TOO_LARGE', '管理请求正文过大。')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_BODY_BYTES) throw new AdminApiError(413, 'REQUEST_TOO_LARGE', '管理请求正文过大。')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new AdminApiError(400, 'INVALID_JSON', '管理请求不是有效 JSON。')
  }
}

function requireRecord(value: unknown, code: string, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AdminApiError(400, code, message)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new AdminApiError(400, 'INVALID_REQUEST', '管理请求包含缺失或不支持的字段。')
  }
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new AdminApiError(400, 'INVALID_REQUEST', '管理请求包含不支持的字段。')
  }
}

function sendApiFailure(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  if (error instanceof AdminApiError) {
    sendJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof RepositoryInitializationError || error instanceof RepositoryReadError
    || error instanceof RepositoryWriteError || error instanceof FileBackupError) {
    const status = error.code === 'REPO_BUSY' || error.code.includes('CONFLICT') ? 409
      : error.code === 'REPO_NOT_INITIALIZED' || error.code === 'BACKUP_NOT_CONFIGURED'
        || error.code === 'BACKUP_SNAPSHOT_NOT_FOUND' || error.code === 'BACKUP_FILE_NOT_FOUND' ? 404
        : error.code === 'INVALID_MUTATION' || error.code === 'BACKUP_INVALID_CONFIG' ? 400
          : 422
    sendJson(res, status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  sendJson(res, 500, { ok: false, error: { code: 'ADMIN_API_FAILED', message: '管理请求未能安全完成。' } })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', payload.byteLength)
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(payload)
}
