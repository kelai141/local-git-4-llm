import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import { FileBackupError, FileBackupRepository, type FileBackupScope, type FileBackupStatus } from '../core/backup.js'
import {
  WorkspaceSelectionError,
  currentRepositorySelection,
  recordRepositorySelection,
  resolveRepositoryWorkspace,
} from '../core/workspace-selection.js'
import type { FileBackupScheduler } from '../relay/backups.js'

const USAGE = [
  '/setrepo',
  '/setrepo <序号|workspaceId|精确标题>',
  '/setrepo current | reset',
  '/setrepo backup status | now | off',
  '/setrepo backup on <相对路径1,相对路径2> --confirm [--interval=15]',
].join('\n')

/** Register the human-only repository selector and physical backup command. */
export function installSetRepoCommand(ctx: Context, scheduler: FileBackupScheduler): void {
  ctx.effect(() => ctx.commands.register({
    name: 'setrepo',
    description: '选择当前会话使用的本地仓库，并配置显式启用的工作区文件自动备份',
    input: { hint: '[<仓库>|current|reset|backup ...]' },
    recordInput: false,
    handler: (invocation: CommandInvocation) => executeSetRepo(ctx, scheduler, invocation),
  }), 'local-git-4-llm:setrepo-command')
}

export async function executeSetRepo(
  ctx: Context,
  scheduler: FileBackupScheduler,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const input = invocation.rawInput.trim()
  try {
    invocation.signal.throwIfAborted()
    if (input === '') return await renderOverview(ctx, scheduler, invocation.agent, invocation.signal)
    if (input === 'reset') {
      const fallback = await resolveCallerCwdWorkspace(ctx, invocation.agent, invocation.signal)
      recordRepositorySelection(invocation.agent, null, String(invocation.commandId))
      return success(`已恢复使用当前会话工作区：${fallback.title}（${String(fallback.id)}）。`)
    }
    if (input === 'current') {
      const workspace = await resolveCallerCwdWorkspace(ctx, invocation.agent, invocation.signal)
      recordRepositorySelection(invocation.agent, String(workspace.id), String(invocation.commandId))
      return success(`已激活当前会话仓库：${workspace.title}（${String(workspace.id)}）。`)
    }
    if (input === 'backup' || input.startsWith('backup ')) {
      return await executeBackupCommand(ctx, scheduler, invocation, input.slice('backup'.length).trim())
    }
    const workspace = await resolveNamedWorkspace(ctx, input, invocation.signal)
    recordRepositorySelection(invocation.agent, String(workspace.id), String(invocation.commandId))
    const status = await safeBackupStatus(workspace, invocation.signal)
    return success([
      `已激活仓库：${workspace.title}（${String(workspace.id)}）。`,
      renderBackupStatus(status, scheduler.getRuntimeStatus(String(workspace.id))),
      '后续 repo_* 工具会使用此选择；/setrepo reset 可恢复到会话 cwd。',
    ].join('\n'))
  } catch (error) {
    if (isAbortError(error)) throw error
    return expectedFailure(error)
  }
}

async function executeBackupCommand(
  ctx: Context,
  scheduler: FileBackupScheduler,
  invocation: CommandInvocation,
  input: string,
): Promise<CommandResult> {
  const resolved = await resolveRepositoryWorkspace(ctx, invocation.agent, invocation.signal)
  const workspace = resolved.workspace
  const workspaceId = String(workspace.id)
  if (input === '' || input === 'status') {
    const status = await FileBackupRepository.status(workspace.path, workspaceId, invocation.signal)
    return success(renderBackupStatus(status, scheduler.getRuntimeStatus(workspaceId)))
  }
  if (input === 'off') {
    const status = await FileBackupRepository.disable(workspace.path, workspaceId, 'user /setrepo backup off', invocation.signal)
    scheduler.untrackDisabled(workspaceId)
    scheduler.clearFailure(workspaceId)
    return success(`已关闭“${workspace.title}”的文件自动备份。\n${renderBackupStatus(status, scheduler.getRuntimeStatus(workspaceId))}`)
  }
  if (input === 'now') {
    const result = await scheduler.captureNow(workspace, 'manual', invocation.signal)
    return success(result.created
      ? `文件快照已创建：${shortId(result.snapshot?.id)}，${result.snapshot?.fileCount ?? 0} 个文件，${formatBytes(result.snapshot?.totalBytes ?? 0)}。`
      : `文件内容没有变化，未追加重复快照。当前快照：${shortId(result.snapshot?.id)}。`)
  }
  if (input === 'on' || input.startsWith('on ')) {
    const parsed = parseBackupOn(input.slice(2).trim())
    const enabled = await FileBackupRepository.enable(workspace.path, workspaceId, {
      scope: parsed.scope,
      intervalMinutes: parsed.intervalMinutes,
      confirmSensitiveRisk: true,
    }, invocation.signal)
    scheduler.trackConfigured(workspaceId)
    scheduler.clearFailure(workspaceId)
    try {
      const capture = await scheduler.captureNow(workspace, 'initial', invocation.signal)
      return success([
        `已为“${workspace.title}”启用文件自动备份。`,
        renderBackupStatus(capture.status, scheduler.getRuntimeStatus(workspaceId)),
        capture.created
          ? `初始快照：${shortId(capture.snapshot?.id)}，${capture.snapshot?.fileCount ?? 0} 个文件，${formatBytes(capture.snapshot?.totalBytes ?? 0)}。`
          : '初始扫描与最新快照一致，未追加重复快照。',
      ].join('\n'))
    } catch (error) {
      if (isAbortError(error)) throw error
      return {
        kind: 'error',
        text: `自动备份配置已持久化，但初始文件快照失败：${renderError(error)}\n${renderBackupStatus(enabled, scheduler.getRuntimeStatus(workspaceId))}`,
      }
    }
  }
  return { kind: 'error', text: `无法识别 backup 子命令。\n${USAGE}` }
}

function parseBackupOn(input: string): { readonly scope: FileBackupScope; readonly intervalMinutes?: number } {
  const tokens = input.split(/\s+/u).filter(Boolean)
  const confirmIndex = tokens.indexOf('--confirm')
  if (confirmIndex < 0) {
    throw new FileBackupError(
      'BACKUP_INVALID_CONFIG',
      `启用前必须添加 --confirm，确认备份内容以未加密形式保存在本机 .dsh-repo。\n${USAGE}`,
    )
  }
  tokens.splice(confirmIndex, 1)
  let intervalMinutes: number | undefined
  const intervalToken = tokens.find(token => token.startsWith('--interval='))
  if (intervalToken !== undefined) {
    tokens.splice(tokens.indexOf(intervalToken), 1)
    const value = Number(intervalToken.slice('--interval='.length))
    if (!Number.isSafeInteger(value)) throw new FileBackupError('BACKUP_INVALID_CONFIG', '自动备份 interval 必须是整数分钟。')
    intervalMinutes = value
  }
  if (tokens.some(token => token.startsWith('--'))) {
    throw new FileBackupError('BACKUP_INVALID_CONFIG', `启用文件备份包含不支持的选项。\n${USAGE}`)
  }
  if (tokens.length !== 1 || tokens[0] === undefined || tokens[0] === '') {
    throw new FileBackupError('BACKUP_INVALID_CONFIG', `请选择逗号分隔的相对路径，或使用 --all。\n${USAGE}`)
  }
  const roots = tokens[0].split(',').map(value => value.trim()).filter(Boolean)
  return { scope: { kind: 'selected', roots }, intervalMinutes }
}

async function renderOverview(
  ctx: Context,
  scheduler: FileBackupScheduler,
  agent: Agent,
  signal: AbortSignal,
): Promise<CommandResult> {
  const workspaces = ctx.workspaceRegistry.list()
  let activeLine = '当前没有可解析的激活仓库。'
  try {
    const active = await resolveRepositoryWorkspace(ctx, agent, signal)
    const status = await safeBackupStatus(active.workspace, signal)
    activeLine = [
      `当前激活：${active.workspace.title}（${String(active.workspace.id)}，来源：${active.source === 'setrepo' ? '/setrepo' : '会话工作区'}）`,
      renderBackupStatus(status, scheduler.getRuntimeStatus(String(active.workspace.id))),
    ].join('\n')
  } catch (error) {
    if (isAbortError(error)) throw error
    activeLine = renderError(error)
  }
  const selected = currentRepositorySelection(agent)
  const candidates = workspaces.length === 0
    ? ['没有已注册工作区。']
    : workspaces.map((workspace, index) => {
      const marker = selected === String(workspace.id) ? ' *' : ''
      return `${index + 1}. ${workspace.title} · ${String(workspace.id)}${marker}`
    })
  return success([activeLine, '', '可选仓库：', ...candidates, '', USAGE].join('\n'))
}

async function resolveNamedWorkspace(ctx: Context, input: string, signal: AbortSignal): Promise<Workspace> {
  signal.throwIfAborted()
  const workspaces = ctx.workspaceRegistry.list()
  let workspace: Workspace | undefined
  if (/^[1-9][0-9]*$/u.test(input)) workspace = workspaces[Number(input) - 1]
  workspace ??= ctx.workspaceRegistry.get(WorkspaceId(input))
  if (workspace === undefined) {
    const matches = workspaces.filter(candidate => candidate.title === input)
    if (matches.length > 1) {
      throw new WorkspaceSelectionError('SELECTED_WORKSPACE_INVALID', '多个注册工作区使用相同标题，请改用序号或 workspaceId。')
    }
    workspace = matches[0]
  }
  if (workspace === undefined) {
    throw new WorkspaceSelectionError('SELECTED_WORKSPACE_UNAVAILABLE', '未找到该注册仓库；运行 /setrepo 查看候选列表。')
  }
  const resolved = await ctx.workspaceRegistry.resolveByPath(workspace.path)
  signal.throwIfAborted()
  if (resolved === undefined || String(resolved.id) !== String(workspace.id)) {
    throw new WorkspaceSelectionError('SELECTED_WORKSPACE_INVALID', '所选仓库路径不再匹配注册身份。')
  }
  return resolved
}

async function resolveCallerCwdWorkspace(ctx: Context, agent: Agent, signal: AbortSignal): Promise<Workspace> {
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new WorkspaceSelectionError('NO_CALLER_WORKSPACE', '当前会话没有工作区 cwd。')
  const workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
  signal.throwIfAborted()
  if (workspace === undefined) throw new WorkspaceSelectionError('WORKSPACE_UNREGISTERED', '当前会话工作区尚未注册到 DSH。')
  return workspace
}

async function safeBackupStatus(workspace: Workspace, signal: AbortSignal): Promise<FileBackupStatus> {
  try {
    return await FileBackupRepository.status(workspace.path, String(workspace.id), signal)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'REPO_NOT_INITIALIZED') {
      return { configured: false, enabled: false, integrity: 'ok', journalEntries: 0, snapshots: 0 }
    }
    throw error
  }
}

function renderBackupStatus(
  status: FileBackupStatus,
  runtime: { readonly running: boolean; readonly lastError?: string; readonly lastErrorAt?: string },
): string {
  if (!status.configured) return '文件备份：未配置（仓库需先初始化）。'
  const scope = status.config?.scope.kind === 'workspace'
    ? '整个工作区（安全排除策略）'
    : status.config?.scope.kind === 'selected' ? status.config.scope.roots.join(', ') : '未设置'
  return [
    `文件备份：${status.enabled ? runtime.running ? '正在扫描' : '已启用' : '已关闭'}`,
    `范围：${scope}`,
    `间隔：${status.config?.intervalMinutes ?? '—'} 分钟；快照：${status.snapshots}；最新：${shortId(status.latest?.id)}`,
    runtime.lastError === undefined ? undefined : `最近错误：${runtime.lastError}${runtime.lastErrorAt === undefined ? '' : `（${runtime.lastErrorAt}）`}`,
  ].filter((line): line is string => line !== undefined).join('\n')
}

function expectedFailure(error: unknown): CommandResult {
  if (error instanceof FileBackupError || error instanceof WorkspaceSelectionError) {
    return { kind: 'error', text: `${error.message}\n\n${USAGE}` }
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = String((error as { code?: unknown }).code)
    if (code.startsWith('REPO_')) return { kind: 'error', text: renderError(error) }
  }
  return { kind: 'error', text: '仓库激活或文件备份操作未能安全完成。' }
}

function renderError(error: unknown): string {
  if (error instanceof Error) return error.message
  return '未知文件备份错误。'
}

function success(text: string): CommandResult {
  return { kind: 'success', text }
}

function shortId(value: string | null | undefined): string {
  if (value === undefined || value === null) return '—'
  return value.startsWith('sha256:') ? value.slice(7, 15) : value.slice(0, 12)
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}
