import { createElement, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ClientContext, SessionListState, WorkspaceListState, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'

const PLUGIN_ID = '@dsh-external/local-git-4-llm'
const STYLE_ID = 'local-git-4-llm-style'
const API_ROOT = '/local-git-4-llm/api'
const WORKSPACE_STORAGE_KEY = 'local-git-4-llm:selected-workspace'

type TabId = 'code' | 'history' | 'issues' | 'discuss'
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type RollbackValue = CommitSummary | { id: 'ROOT'; message: string }

interface BoundRollbackTarget {
  readonly workspaceId: string
  readonly value: RollbackValue
}

interface PanelProps {
  useSessions: SnapshotSelectorHook<SessionListState>
  useWorkspaces: SnapshotSelectorHook<WorkspaceListState>
}

interface CommitSummary {
  id: string
  parent: string | null
  tree: string
  message: string
  kind: 'normal' | 'rollback'
  restores?: string | null
  createdAt: string
}

interface KnowledgeRecord {
  key: string
  value: JsonValue
  valueHash: string
}

interface RepositoryComment {
  id: string
  body: string
  author: 'admin' | { kind: 'agent'; sessionId: string }
  issueId?: string
  mentions: string[]
  deliveryRequestedTo?: string[]
  deliveredTo: string[]
  createdAt: string
}

interface BoardData {
  workspace: { id: string; title: string; sessionIds: string[] }
  initialized: boolean
  liveAgents: { id: string; status: 'idle' | 'running' }[]
  status?: {
    head: string | null
    journalEntries: number
    commits: number
    knowledgeKeys: number
    issues: number
    integrity: 'ok'
  }
  log?: CommitSummary[]
  checkout?: {
    selector: 'ROOT' | string
    commit: CommitSummary | null
    records: KnowledgeRecord[]
  }
  issues?: {
    id: string
    title: string
    body: string
    status: string
    labels: string[]
    assignee?: string
    openedBy?: 'admin' | { kind: 'agent'; sessionId: string }
    createdAt: string
    updatedAt: string
  }[]
  comments?: RepositoryComment[]
}

interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

class PanelApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
    this.name = 'PanelApiError'
  }
}

let capabilityCache: string | undefined

const CSS = `
.lg4l-overlay{position:fixed;right:18px;bottom:18px;z-index:40;display:grid;justify-items:end;gap:10px;pointer-events:none;color:var(--dsw-alias-label-primary);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.lg4l-fab{display:grid;place-items:center;width:50px;height:50px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:15px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);cursor:pointer;pointer-events:auto;transition:transform .16s ease,background .16s ease}
.lg4l-fab:hover{background:var(--dsw-alias-bg-layer-2);transform:translateY(-1px)}.lg4l-fab:focus-visible,.lg4l-button:focus-visible,.lg4l-tab:focus-visible,.lg4l-icon-button:focus-visible,.lg4l-select:focus-visible,.lg4l-textarea:focus-visible{outline:3px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 38%,transparent);outline-offset:2px}
.lg4l-panel{position:relative;width:min(920px,calc(100vw - 36px));height:min(760px,calc(100vh - 104px));min-height:500px;box-sizing:border-box;pointer-events:auto;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto auto;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-base);box-shadow:0 24px 70px color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);overflow:hidden}
.lg4l-topbar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.lg4l-repo-id{min-width:0;display:flex;align-items:center;gap:10px}.lg4l-mark{display:grid;place-items:center;flex:0 0 auto;width:28px;height:28px}.lg4l-repo-copy{min-width:0}.lg4l-repo-line{display:flex;align-items:center;gap:7px;min-width:0;font-size:14px;font-weight:700}.lg4l-owner{color:var(--dsw-alias-label-secondary);font-weight:600}.lg4l-slash{color:var(--dsw-alias-label-secondary)}.lg4l-repo-select{min-width:120px;max-width:360px;height:26px;padding:0 24px 0 5px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;font-weight:700;text-overflow:ellipsis;cursor:pointer}.lg4l-repo-select:hover{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}.lg4l-repo-select:focus-visible{outline:3px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 38%,transparent);outline-offset:1px}.lg4l-badge{display:inline-flex;align-items:center;min-height:20px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:650}.lg4l-subline{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:10px}
.lg4l-top-actions{display:flex;align-items:center;gap:7px}.lg4l-icon-button{display:grid;place-items:center;width:32px;height:32px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:18px;cursor:pointer}.lg4l-icon-button:hover{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.lg4l-tabs{display:flex;align-items:end;gap:2px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);overflow-x:auto}.lg4l-tab{position:relative;display:flex;align-items:center;gap:7px;min-height:46px;padding:0 13px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:650;white-space:nowrap;cursor:pointer}.lg4l-tab:hover{color:var(--dsw-alias-label-primary)}.lg4l-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary)}.lg4l-tab[aria-selected="true"]:after{content:"";position:absolute;left:9px;right:9px;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary)}.lg4l-count{min-width:18px;padding:1px 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);text-align:center;font-size:10px}
.lg4l-content{min-height:0;overflow:auto;padding:16px;background:var(--dsw-alias-bg-base)}.lg4l-loading,.lg4l-empty{display:grid;place-items:center;align-content:center;gap:10px;min-height:260px;padding:30px;text-align:center;color:var(--dsw-alias-label-secondary)}.lg4l-empty strong{color:var(--dsw-alias-label-primary);font-size:16px}.lg4l-empty p{max-width:560px;margin:0;font-size:12px;line-height:1.6}.lg4l-spinner{width:24px;height:24px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:lg4l-spin .8s linear infinite}@keyframes lg4l-spin{to{transform:rotate(360deg)}}
.lg4l-error{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1));border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:1.5}.lg4l-error button{border:0;background:transparent;color:inherit;cursor:pointer}
.lg4l-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.lg4l-toolbar-left,.lg4l-toolbar-right{display:flex;align-items:center;gap:8px;min-width:0}.lg4l-select{min-width:180px;max-width:420px;height:34px;padding:0 30px 0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px}.lg4l-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;font-weight:650;cursor:pointer}.lg4l-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.lg4l-button:disabled{opacity:.48;cursor:not-allowed}.lg4l-button-primary{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 72%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary)}.lg4l-button-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,var(--dsw-alias-bg-layer-2))}.lg4l-button-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 62%,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-error-primary)}
.lg4l-grid{display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:14px;align-items:start}.lg4l-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}.lg4l-card-title{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:42px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11px;font-weight:700}.lg4l-card-title code{font-size:10px;color:var(--dsw-alias-label-secondary)}
.lg4l-file-list{display:grid}.lg4l-file-row{display:grid;grid-template-columns:minmax(180px,1fr) minmax(160px,1.3fr) auto;gap:12px;align-items:center;min-height:42px;padding:0 12px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}.lg4l-file-row:last-child{border-bottom:0}.lg4l-file-row:hover,.lg4l-file-row[data-selected="true"]{background:var(--dsw-alias-bg-layer-2)}.lg4l-file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-brand-primary);font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}.lg4l-file-preview{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:10px}.lg4l-file-hash{color:var(--dsw-alias-label-secondary);font:9px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
.lg4l-code-detail{margin-top:12px}.lg4l-code-detail pre{max-height:260px;margin:0;padding:14px;overflow:auto;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.lg4l-side-stack{display:grid;gap:10px}.lg4l-stat-list{display:grid;grid-template-columns:1fr auto;gap:9px 12px;padding:12px;font-size:10px}.lg4l-stat-list dt{color:var(--dsw-alias-label-secondary)}.lg4l-stat-list dd{margin:0;font-weight:700}.lg4l-integrity{color:var(--dsw-alias-state-success-primary)}
.lg4l-history{display:grid;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}.lg4l-commit{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}.lg4l-commit:last-child{border-bottom:0}.lg4l-commit-main{min-width:0}.lg4l-commit-message{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:700}.lg4l-rollback-badge{padding:2px 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:9px}.lg4l-commit-meta{display:flex;flex-wrap:wrap;gap:7px;margin-top:5px;color:var(--dsw-alias-label-secondary);font-size:9px}.lg4l-commit-meta code{font:inherit;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.lg4l-commit-actions{display:flex;align-items:center;gap:6px}
.lg4l-issue-list,.lg4l-comment-list{display:grid;gap:10px}.lg4l-issue{padding:13px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.lg4l-issue-title{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700}.lg4l-issue-body{margin-top:7px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1.55}.lg4l-labels{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.lg4l-label{padding:2px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:9px}
.lg4l-discuss-grid{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:14px}.lg4l-comment{display:grid;grid-template-columns:30px minmax(0,1fr);gap:9px}.lg4l-avatar{display:grid;place-items:center;width:28px;height:28px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l1));border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-size:11px;font-weight:800}.lg4l-comment-box{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}.lg4l-comment-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:9px}.lg4l-comment-body{padding:10px;font-size:11px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.lg4l-comment-delivery{padding:0 10px 9px;color:var(--dsw-alias-label-secondary);font-size:9px}.lg4l-compose{position:sticky;top:0;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.lg4l-compose h3{margin:0 0 5px;font-size:12px}.lg4l-compose p{margin:0 0 10px;color:var(--dsw-alias-label-secondary);font-size:9px;line-height:1.5}.lg4l-textarea{box-sizing:border-box;width:100%;min-height:120px;resize:vertical;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:11px/1.5 inherit}.lg4l-mentions{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.lg4l-mention{display:inline-flex;align-items:center;gap:5px;padding:5px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:9px;cursor:pointer}.lg4l-mention[data-selected="true"]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary)}.lg4l-live-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-secondary)}.lg4l-live-dot[data-live="true"]{background:var(--dsw-alias-state-success-primary)}.lg4l-compose-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}.lg4l-compose-note{color:var(--dsw-alias-label-secondary);font-size:9px}
.lg4l-toast{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-size:10px}.lg4l-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:9px}.lg4l-footer code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.lg4l-confirm-backdrop{position:absolute;inset:0;z-index:3;display:grid;place-items:center;padding:20px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 72%,transparent);backdrop-filter:blur(4px)}.lg4l-confirm{width:min(440px,100%);padding:17px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 50px color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent)}.lg4l-confirm h2{margin:0 0 8px;font-size:15px}.lg4l-confirm p{margin:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}.lg4l-confirm code{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.lg4l-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.lg4l-issue-meta{display:flex;flex-wrap:wrap;gap:8px;margin:5px 0 8px;color:var(--dsw-alias-label-secondary);font-size:9px}.lg4l-issue-meta code{min-width:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.lg4l-issue-comments{display:grid;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}.lg4l-issue-comment{display:grid;grid-template-columns:minmax(90px,150px) minmax(0,1fr);gap:8px;padding:7px 9px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);font-size:10px;line-height:1.45}.lg4l-issue-comment span{min-width:0;overflow-wrap:anywhere}.lg4l-scope-select{width:100%;max-width:none;margin-bottom:9px}.lg4l-repo-select:disabled{opacity:.62;cursor:not-allowed}.lg4l-comment-head strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:760px){.lg4l-overlay{right:max(8px,env(safe-area-inset-right));bottom:max(8px,env(safe-area-inset-bottom))}.lg4l-panel{width:calc(100vw - 16px);height:calc(100vh - 82px);height:calc(100dvh - 82px - env(safe-area-inset-bottom));min-height:0;border-radius:13px}.lg4l-content{padding:11px}.lg4l-grid,.lg4l-discuss-grid{grid-template-columns:1fr}.lg4l-side-stack{grid-template-columns:repeat(2,minmax(0,1fr))}.lg4l-compose{position:static}.lg4l-file-row{grid-template-columns:minmax(120px,1fr) minmax(100px,1fr)}.lg4l-file-hash{display:none}.lg4l-commit{grid-template-columns:1fr}.lg4l-commit-actions{justify-content:flex-start}.lg4l-repo-line{font-size:12px}.lg4l-badge{display:none}.lg4l-icon-button{width:40px;height:40px}.lg4l-button{min-height:40px}.lg4l-mention{min-height:32px;padding-inline:10px}.lg4l-issue-comment{grid-template-columns:1fr}}
@media(max-width:480px){.lg4l-owner,.lg4l-slash{display:none}.lg4l-repo-select{min-width:0;max-width:190px;font-size:12px}.lg4l-tab{padding:0 9px}.lg4l-toolbar{align-items:stretch;flex-direction:column}.lg4l-toolbar-left,.lg4l-toolbar-right{width:100%}.lg4l-select{min-width:0;width:100%}.lg4l-side-stack{grid-template-columns:1fr}.lg4l-footer span:first-child{display:none}}
`

function installStyles(): () => void {
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null && !(existing instanceof HTMLStyleElement)) existing.remove()
  const style = existing instanceof HTMLStyleElement ? existing : document.createElement('style')
  const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  style.id = STYLE_ID
  style.dataset.plugin = PLUGIN_ID
  style.dataset.owner = owner
  style.textContent = CSS
  if (!style.isConnected) document.head.appendChild(style)
  return () => {
    if (style.dataset.owner === owner) style.remove()
  }
}

async function readCapability(signal?: AbortSignal, force = false): Promise<string> {
  if (!force && capabilityCache !== undefined) return capabilityCache
  const response = await fetch(`${API_ROOT}/capability`, { signal, cache: 'no-store', credentials: 'same-origin' })
  const envelope = await readEnvelope<never>(response)
  if (!response.ok || envelope.ok !== true || typeof envelope.capability !== 'string') {
    throw new PanelApiError(envelope.error?.code ?? 'CAPABILITY_FAILED', envelope.error?.message ?? '无法连接本地仓库管理服务。', response.status)
  }
  capabilityCache = envelope.capability
  return envelope.capability
}

async function apiRequest<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {},
  retryCapability = true,
): Promise<T> {
  const capability = await readCapability(options.signal)
  const response = await fetch(`${API_ROOT}${path}`, {
    method: options.method ?? 'GET',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      'x-local-git-4-llm-capability': capability,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    signal: options.signal,
    cache: 'no-store',
    credentials: 'same-origin',
  })
  const envelope = await readEnvelope<T>(response)
  if (!response.ok || envelope.ok !== true || envelope.data === undefined) {
    const error = new PanelApiError(envelope.error?.code ?? 'ADMIN_API_FAILED', envelope.error?.message ?? '管理请求失败。', response.status)
    if (retryCapability && response.status === 403 && error.code === 'CAPABILITY_REQUIRED') {
      capabilityCache = undefined
      await readCapability(options.signal, true)
      return apiRequest(path, options, false)
    }
    throw error
  }
  return envelope.data
}

async function readEnvelope<T>(response: Response): Promise<ApiEnvelope<T> & { capability?: string }> {
  const source = await response.text()
  try {
    const value = JSON.parse(source) as ApiEnvelope<T> & { capability?: string }
    if (typeof value !== 'object' || value === null) throw new Error('not an object')
    return value
  } catch {
    throw new PanelApiError(
      'ADMIN_API_UNAVAILABLE',
      response.ok ? '管理服务返回了无法识别的数据。' : `管理服务暂不可用（HTTP ${response.status}）。`,
      response.status,
    )
  }
}

function LocalGitFab(props: PanelProps) {
  const currentSessionId = props.useSessions(state => state.current)
  const sessionsById = props.useSessions(state => state.byId)
  const workspaces = props.useWorkspaces(state => state.items)
  const recentWorkspaceId = props.useWorkspaces(state => state.recentWorkspaceId)

  const inferredWorkspace = useMemo(() => findActiveWorkspace(
    workspaces,
    currentSessionId === undefined ? undefined : String(currentSessionId),
    recentWorkspaceId === undefined ? undefined : String(recentWorkspaceId),
  ), [workspaces, currentSessionId, recentWorkspaceId])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(readStoredWorkspaceId)
  const activeWorkspace = useMemo(() => {
    if (selectedWorkspaceId !== null) {
      const selected = workspaces.find(workspace => String(workspace.workspaceId) === selectedWorkspaceId)
      if (selected !== undefined) return selected
    }
    return inferredWorkspace
  }, [workspaces, selectedWorkspaceId, inferredWorkspace])
  const workspaceId = activeWorkspace === undefined ? undefined : String(activeWorkspace.workspaceId)
  const workspaceIdRef = useRef(workspaceId)
  const stateRequestIdRef = useRef(0)
  const mutationIdRef = useRef(0)
  const panelWasOpenRef = useRef(false)
  workspaceIdRef.current = workspaceId

  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<TabId>('code')
  const [selector, setSelector] = useState('HEAD')
  const [board, setBoard] = useState<BoardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [commentBody, setCommentBody] = useState('')
  const [commentIssueId, setCommentIssueId] = useState<string | null>(null)
  const [mentions, setMentions] = useState<string[]>([])
  const [action, setAction] = useState<'initialize' | 'comment' | 'rollback' | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [rollbackTarget, setRollbackTarget] = useState<BoundRollbackTarget | null>(null)

  useEffect(() => {
    if (selectedWorkspaceId !== null && workspaces.length > 0 && !workspaces.some(workspace => String(workspace.workspaceId) === selectedWorkspaceId)) {
      setSelectedWorkspaceId(null)
      storeWorkspaceId(null)
    }
  }, [workspaces, selectedWorkspaceId])

  useEffect(() => {
    setSelector('HEAD')
    setBoard(null)
    setSelectedKey(null)
    setMentions([])
    setCommentBody('')
    setCommentIssueId(null)
    setRollbackTarget(null)
    setTab('code')
    setToast(null)
    setError(null)
  }, [workspaceId])

  useEffect(() => {
    if (!open || workspaceId === undefined) return
    const controller = new AbortController()
    const requestId = ++stateRequestIdRef.current
    const requestWorkspaceId = workspaceId
    // Never carry a historical selector from the previous workspace into a new repository request.
    const requestSelector = board?.workspace.id === workspaceId ? selector : 'HEAD'
    setLoading(true)
    setError(null)
    apiRequest<BoardData>(`/state?workspaceId=${encodeURIComponent(workspaceId)}&selector=${encodeURIComponent(requestSelector)}`, { signal: controller.signal })
      .then((value) => {
        if (requestId !== stateRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
        setBoard(value)
        const records = value.checkout?.records ?? []
        setSelectedKey(current => current !== null && records.some(record => record.key === current) ? current : records[0]?.key ?? null)
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (requestId !== stateRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
        setError(reason instanceof Error ? reason.message : '无法读取仓库状态。')
      })
      .finally(() => {
        if (!controller.signal.aborted && requestId === stateRequestIdRef.current && workspaceIdRef.current === requestWorkspaceId) setLoading(false)
      })
    return () => {
      controller.abort()
      if (requestId === stateRequestIdRef.current) stateRequestIdRef.current += 1
    }
  }, [open, workspaceId, selector, refreshTick])

  useEffect(() => {
    if (!open || workspaceId === undefined) return
    const timer = window.setInterval(() => setRefreshTick(value => value + 1), 10_000)
    return () => window.clearInterval(timer)
  }, [open, workspaceId])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && rollbackTarget !== null) {
        const dialog = document.querySelector<HTMLElement>('.lg4l-confirm')
        const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])') ?? [])
        if (focusable.length > 0) {
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        return
      }
      if (event.key !== 'Escape') return
      if (rollbackTarget !== null) {
        if (action !== 'rollback') setRollbackTarget(null)
      } else {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, rollbackTarget, action])

  useEffect(() => {
    if (open) {
      panelWasOpenRef.current = true
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.lg4l-panel')?.focus())
    } else if (panelWasOpenRef.current) {
      panelWasOpenRef.current = false
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.lg4l-fab')?.focus())
    }
  }, [open])

  const refresh = () => setRefreshTick(value => value + 1)
  const selectWorkspace = (value: string) => {
    if (action !== null) return
    setSelector('HEAD')
    setBoard(null)
    setSelectedKey(null)
    setMentions([])
    setCommentBody('')
    setCommentIssueId(null)
    setRollbackTarget(null)
    setError(null)
    setTab('code')
    setSelectedWorkspaceId(value)
    storeWorkspaceId(value)
    setToast(`已切换到“${workspaces.find(workspace => String(workspace.workspaceId) === value)?.title ?? '所选仓库'}”。`)
  }
  const liveAgents = new Set((board?.liveAgents ?? []).map(agent => agent.id))
  const selectedRecord = board?.checkout?.records.find(record => record.key === selectedKey)
  const mutationsDisabled = loading || error !== null || action !== null
  const requestRollback = (value: RollbackValue) => {
    if (workspaceId === undefined || mutationsDisabled) return
    setRollbackTarget({ workspaceId, value })
  }

  const initialize = async () => {
    if (workspaceId === undefined) return
    const requestWorkspaceId = workspaceId
    const mutationId = ++mutationIdRef.current
    setAction('initialize')
    setError(null)
    try {
      await apiRequest('/initialize', { method: 'POST', body: { workspaceId: requestWorkspaceId } })
      if (workspaceIdRef.current !== requestWorkspaceId || mutationIdRef.current !== mutationId) return
      setToast('本地仓库已显式初始化。')
      refresh()
    } catch (reason) {
      if (workspaceIdRef.current !== requestWorkspaceId || mutationIdRef.current !== mutationId) return
      setError(reason instanceof Error ? reason.message : '初始化失败。')
    } finally {
      if (mutationIdRef.current === mutationId) setAction(null)
    }
  }

  const sendComment = async () => {
    if (workspaceId === undefined || commentBody.trim() === '') return
    const requestWorkspaceId = workspaceId
    const requestBody = commentBody
    const requestMentions = [...mentions]
    const requestIssueId = commentIssueId
    const mutationId = ++mutationIdRef.current
    setAction('comment')
    setError(null)
    try {
      const result = await apiRequest<{ delivered: string[]; pending: string[]; deliveryAudit: 'complete' | 'pending' }>('/comment', {
        method: 'POST',
        body: {
          workspaceId: requestWorkspaceId,
          body: requestBody,
          mentions: requestMentions,
          ...(requestIssueId === null ? {} : { issueId: requestIssueId }),
        },
      })
      if (workspaceIdRef.current !== requestWorkspaceId || mutationIdRef.current !== mutationId) return
      setCommentBody(current => current === requestBody ? '' : current)
      setMentions([])
      setCommentIssueId(current => current === requestIssueId ? null : current)
      setToast(result.deliveryAudit === 'pending'
        ? result.delivered.length > 0
          ? `评论已保存；已实时注入 ${result.delivered.length} 个智能体，但投递日志审计仍待确认。`
          : '评论已保存；投递队列尚未完成，被 @ 的目标保持待处理状态。'
        : result.delivered.length > 0
        ? `评论已保存，并实时注入 ${result.delivered.length} 个智能体${result.pending.length > 0 ? `；${result.pending.length} 个暂离线` : ''}。`
        : result.pending.length > 0 ? '评论已保存；被 @ 的智能体当前离线，投递状态保留为待处理。' : '管理员评论已保存。')
      refresh()
    } catch (reason) {
      if (workspaceIdRef.current !== requestWorkspaceId || mutationIdRef.current !== mutationId) return
      setError(reason instanceof Error ? reason.message : '评论发送失败。')
    } finally {
      if (mutationIdRef.current === mutationId) setAction(null)
    }
  }

  const confirmRollback = async () => {
    if (workspaceId === undefined || rollbackTarget === null) return
    if (rollbackTarget.workspaceId !== workspaceId) {
      setRollbackTarget(null)
      setError('所选仓库已经变化，请重新选择回退目标。')
      return
    }
    if (loading || error !== null) {
      setError('仓库状态尚未刷新完成，请刷新后再回退。')
      return
    }
    const requestWorkspaceId = rollbackTarget.workspaceId
    const target = rollbackTarget.value
    const mutationId = ++mutationIdRef.current
    setAction('rollback')
    setError(null)
    try {
      await apiRequest('/rollback', {
        method: 'POST',
        body: { workspaceId: requestWorkspaceId, target: target.id, message: `管理员从管理面板回退到 ${target.id}` },
      })
      if (workspaceIdRef.current !== requestWorkspaceId || mutationIdRef.current !== mutationId) return
      setRollbackTarget(null)
      setSelector('HEAD')
      setTab('history')
      setToast('回退已作为新提交追加；原 HEAD 已作为不可变备份保留。')
      refresh()
    } catch (reason) {
      if (workspaceIdRef.current !== requestWorkspaceId || mutationIdRef.current !== mutationId) return
      setError(reason instanceof Error ? reason.message : '回退失败。')
    } finally {
      if (mutationIdRef.current === mutationId) setAction(null)
    }
  }

  return createElement('div', { className: 'lg4l-overlay' },
    open ? createElement('aside', {
      className: 'lg4l-panel',
      role: 'dialog',
      tabIndex: -1,
      'aria-label': 'local-git-4-llm 仓库管理面板',
    },
    renderTopbar(workspaces, activeWorkspace, board, action !== null, selectWorkspace, () => setOpen(false), refresh),
    renderTabs(tab, setTab, board),
    createElement('main', { className: 'lg4l-content', role: 'tabpanel', id: `lg4l-panel-${tab}`, 'aria-labelledby': `lg4l-tab-${tab}`, tabIndex: 0 },
      error === null ? null : createElement('div', { className: 'lg4l-error', role: 'alert' },
        createElement('span', null, error),
        createElement('button', { type: 'button', onClick: () => setError(null), 'aria-label': '关闭错误提示' }, '×'),
      ),
      activeWorkspace === undefined
        ? renderNoWorkspace()
        : loading && board === null
          ? renderLoading()
          : board !== null && !board.initialized
            ? renderUninitialized(action === 'initialize', initialize)
            : board === null
              ? renderLoading()
              : tab === 'code'
                ? renderCode(board, selector, setSelector, selectedKey, setSelectedKey, selectedRecord, loading)
                : tab === 'history'
                  ? renderHistory(board, setSelector, setTab, requestRollback, mutationsDisabled)
                  : tab === 'issues'
                    ? renderIssues(board, sessionsById)
                    : renderDiscuss(board, activeWorkspace, sessionsById, liveAgents, mentions, setMentions, commentBody, setCommentBody, commentIssueId, setCommentIssueId, action === 'comment', sendComment, mutationsDisabled),
    ),
    toast === null ? null : createElement('div', { className: 'lg4l-toast', role: 'status' }, toast),
    createElement('footer', { className: 'lg4l-footer' },
      createElement('span', null, '手动选择仓库 · 显式提交 · 不自动同步'),
      createElement('code', null, 'local-git-4-llm · 0.5.0'),
    ),
    rollbackTarget === null ? null : renderRollbackConfirm(rollbackTarget.value, action === 'rollback', () => setRollbackTarget(null), confirmRollback),
    ) : null,
    createElement('button', {
      className: 'lg4l-fab',
      type: 'button',
      onClick: () => setOpen(value => !value),
      'aria-expanded': open,
      'aria-label': open ? '关闭 local-git-4-llm 仓库面板' : '打开 local-git-4-llm 仓库面板',
      title: '打开本地知识仓库',
    }, createElement(FishLogo, { size: 28 })),
  )
}

function renderTopbar(
  workspaces: readonly WorkspaceView[],
  workspace: WorkspaceView | undefined,
  board: BoardData | null,
  selectionDisabled: boolean,
  selectWorkspace: (workspaceId: string) => void,
  close: () => void,
  refresh: () => void,
) {
  return createElement('header', { className: 'lg4l-topbar' },
    createElement('div', { className: 'lg4l-repo-id' },
      createElement('span', { className: 'lg4l-mark' }, createElement(FishLogo, { size: 27 })),
      createElement('div', { className: 'lg4l-repo-copy' },
        createElement('div', { className: 'lg4l-repo-line' },
          createElement('span', { className: 'lg4l-owner' }, '仓库'),
          createElement('span', { className: 'lg4l-slash' }, '/'),
          createElement('select', {
            className: 'lg4l-repo-select',
            value: workspace === undefined ? '' : String(workspace.workspaceId),
            onChange: (event: ChangeEvent<HTMLSelectElement>) => selectWorkspace(event.currentTarget.value),
            disabled: workspaces.length === 0 || selectionDisabled,
            'aria-label': '选择要查看的本地仓库',
            title: '手动选择要浏览和管理的仓库',
          },
          workspace === undefined ? createElement('option', { value: '', disabled: workspaces.length > 0 }, workspaces.length > 0 ? '请选择仓库' : '未选择工作区') : null,
          ...workspaces.map(item => createElement('option', { key: String(item.workspaceId), value: String(item.workspaceId) }, item.title || '未命名工作区')),
          ),
          createElement('span', { className: 'lg4l-badge' }, board?.initialized ? '已初始化' : '本地'),
        ),
        createElement('div', { className: 'lg4l-subline' }, board?.initialized ? `手动选择 · HEAD ${shortId(board.status?.head)} · 完整性 ${board.status?.integrity ?? '未知'}` : '手动选择并浏览本地不可变知识仓库'),
      ),
    ),
    createElement('div', { className: 'lg4l-top-actions' },
      createElement('button', { className: 'lg4l-icon-button', type: 'button', onClick: refresh, title: '刷新', 'aria-label': '刷新仓库' }, '↻'),
      createElement('button', { className: 'lg4l-icon-button', type: 'button', onClick: close, title: '关闭', 'aria-label': '关闭仓库面板' }, '×'),
    ),
  )
}

function renderTabs(tab: TabId, setTab: (tab: TabId) => void, board: BoardData | null) {
  const tabs: { id: TabId; label: string; count?: number }[] = [
    { id: 'code', label: '代码', count: board?.status?.knowledgeKeys },
    { id: 'history', label: '提交历史', count: board?.status?.commits },
    { id: 'issues', label: '议题', count: board?.status?.issues },
    { id: 'discuss', label: '评论与 @', count: board?.comments?.length },
  ]
  return createElement('nav', { className: 'lg4l-tabs', role: 'tablist', 'aria-label': '仓库页面' },
    ...tabs.map(item => createElement('button', {
      key: item.id,
      id: `lg4l-tab-${item.id}`,
      className: 'lg4l-tab',
      type: 'button',
      role: 'tab',
      'aria-selected': tab === item.id,
      'aria-controls': `lg4l-panel-${item.id}`,
      tabIndex: tab === item.id ? 0 : -1,
      onClick: () => setTab(item.id),
      onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => moveTabFocus(event, item.id, tabs.map(value => value.id), setTab),
    }, item.label, item.count === undefined ? null : createElement('span', { className: 'lg4l-count' }, String(item.count)))),
  )
}

function moveTabFocus(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  current: TabId,
  tabs: readonly TabId[],
  setTab: (tab: TabId) => void,
): void {
  const index = tabs.indexOf(current)
  const target = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length]
    : event.key === 'ArrowLeft' ? tabs[(index - 1 + tabs.length) % tabs.length]
      : event.key === 'Home' ? tabs[0]
        : event.key === 'End' ? tabs.at(-1) : undefined
  if (target === undefined) return
  event.preventDefault()
  setTab(target)
  window.requestAnimationFrame(() => document.getElementById(`lg4l-tab-${target}`)?.focus())
}

function renderCode(
  board: BoardData,
  selector: string,
  setSelector: (value: string) => void,
  selectedKey: string | null,
  setSelectedKey: (value: string) => void,
  selectedRecord: KnowledgeRecord | undefined,
  loading: boolean,
) {
  const records = board.checkout?.records ?? []
  const commits = board.log ?? []
  const selectedOutsideLog = selector !== 'HEAD' && selector !== 'ROOT'
    && !commits.some(commit => commit.id === selector)
    ? board.checkout?.commit ?? undefined : undefined
  return createElement('div', null,
    createElement('div', { className: 'lg4l-toolbar' },
      createElement('div', { className: 'lg4l-toolbar-left' },
        createElement('label', null,
          createElement('span', { style: visuallyHidden }, '选择历史版本'),
          createElement('select', { className: 'lg4l-select', value: selector, disabled: loading, onChange: (event: ChangeEvent<HTMLSelectElement>) => setSelector(event.currentTarget.value) },
            createElement('option', { value: 'HEAD' }, `HEAD · ${commits[0]?.message ?? '空仓库'}`),
            selectedOutsideLog === undefined ? null : createElement('option', { value: selectedOutsideLog.id }, `${shortId(selectedOutsideLog.id)} · ${selectedOutsideLog.message}（历史）`),
            ...commits.filter(commit => commit.id !== board.status?.head).map(commit => createElement('option', { key: commit.id, value: commit.id }, `${shortId(commit.id)} · ${commit.message}`)),
            createElement('option', { value: 'ROOT' }, 'ROOT · 空仓库'),
          ),
        ),
      ),
      createElement('div', { className: 'lg4l-toolbar-right' },
        createElement('span', { className: 'lg4l-badge' }, `${records.length} 个逻辑条目`),
      ),
    ),
    createElement('div', { className: 'lg4l-grid' },
      createElement('section', null,
        createElement('div', { className: 'lg4l-card' },
          createElement('div', { className: 'lg4l-card-title' },
            createElement('span', null, board.checkout?.commit?.message ?? 'ROOT 空快照'),
            createElement('code', null, board.checkout?.selector === 'ROOT' ? 'ROOT' : shortId(board.checkout?.selector)),
          ),
          records.length === 0
            ? createElement('div', { className: 'lg4l-empty', style: { minHeight: 160 } }, createElement('strong', null, '此版本没有逻辑源码条目'), createElement('p', null, '通过 repo_commit 显式提交 key/value 后，完整快照会像仓库文件一样显示在这里。'))
            : createElement('div', { className: 'lg4l-file-list' },
                ...records.map(record => createElement('button', {
                  key: record.key,
                  type: 'button',
                  className: 'lg4l-file-row',
                  'data-selected': selectedKey === record.key,
                  onClick: () => setSelectedKey(record.key),
                },
                createElement('span', { className: 'lg4l-file-name' }, record.key),
                createElement('span', { className: 'lg4l-file-preview' }, valuePreview(record.value)),
                createElement('span', { className: 'lg4l-file-hash' }, shortId(record.valueHash)),
                )),
              ),
        ),
        selectedRecord === undefined ? null : createElement('div', { className: 'lg4l-card lg4l-code-detail' },
          createElement('div', { className: 'lg4l-card-title' }, createElement('span', null, selectedRecord.key), createElement('code', null, shortId(selectedRecord.valueHash))),
          createElement('pre', null, JSON.stringify(selectedRecord.value, null, 2)),
        ),
      ),
      createElement('aside', { className: 'lg4l-side-stack' },
        createElement('section', { className: 'lg4l-card' },
          createElement('div', { className: 'lg4l-card-title' }, '仓库概览'),
          createElement('dl', { className: 'lg4l-stat-list' },
            ...stat('提交', board.status?.commits ?? 0),
            ...stat('逻辑条目', board.status?.knowledgeKeys ?? 0),
            ...stat('日志记录', board.status?.journalEntries ?? 0),
            ...stat('议题', board.status?.issues ?? 0),
            createElement('dt', null, '完整性'), createElement('dd', { className: 'lg4l-integrity' }, board.status?.integrity === 'ok' ? '通过' : '未知'),
          ),
        ),
        createElement('section', { className: 'lg4l-card' },
          createElement('div', { className: 'lg4l-card-title' }, '当前版本'),
          createElement('dl', { className: 'lg4l-stat-list' },
            ...stat('选择器', board.checkout?.selector === 'ROOT' ? 'ROOT' : shortId(board.checkout?.selector)),
            ...stat('类型', board.checkout?.commit?.kind === 'rollback' ? '回退提交' : board.checkout?.commit ? '普通提交' : '根快照'),
            ...stat('时间', board.checkout?.commit ? formatDate(board.checkout.commit.createdAt) : '—'),
          ),
        ),
      ),
    ),
  )
}

function renderHistory(
  board: BoardData,
  setSelector: (value: string) => void,
  setTab: (value: TabId) => void,
  requestRollback: (value: RollbackValue) => void,
  mutationsDisabled: boolean,
) {
  const commits = board.log ?? []
  return createElement('div', null,
    createElement('div', { className: 'lg4l-toolbar' },
      createElement('div', { className: 'lg4l-toolbar-left' }, createElement('strong', null, '不可变提交记录')),
      createElement('div', { className: 'lg4l-toolbar-right' }, createElement('span', { className: 'lg4l-badge' }, '回退会追加新提交，不截断历史')),
    ),
    createElement('section', { className: 'lg4l-history' },
      commits.length === 0 ? createElement('div', { className: 'lg4l-empty', style: { minHeight: 180 } }, createElement('strong', null, '还没有提交')) : null,
      ...commits.map((commit, index) => createElement('article', { className: 'lg4l-commit', key: commit.id },
        createElement('div', { className: 'lg4l-commit-main' },
          createElement('div', { className: 'lg4l-commit-message' },
            createElement('span', null, commit.message),
            commit.kind === 'rollback' ? createElement('span', { className: 'lg4l-rollback-badge' }, '回退') : null,
          ),
          createElement('div', { className: 'lg4l-commit-meta' },
            createElement('code', null, shortId(commit.id)),
            createElement('span', null, formatDate(commit.createdAt)),
            commit.kind === 'rollback' ? createElement('span', null, `恢复 ${shortId(commit.restores)}`) : null,
            index === 0 ? createElement('span', { className: 'lg4l-integrity' }, 'HEAD') : null,
          ),
        ),
        createElement('div', { className: 'lg4l-commit-actions' },
          createElement('button', { className: 'lg4l-button', type: 'button', onClick: () => { setSelector(commit.id); setTab('code') } }, '查看'),
          createElement('button', { className: 'lg4l-button lg4l-button-danger', type: 'button', disabled: index === 0 || mutationsDisabled, onClick: () => requestRollback(commit) }, index === 0 ? '当前版本' : '回退到此处'),
        ),
      )),
      createElement('article', { className: 'lg4l-commit' },
        createElement('div', { className: 'lg4l-commit-main' },
          createElement('div', { className: 'lg4l-commit-message' }, 'ROOT · 空仓库'),
          createElement('div', { className: 'lg4l-commit-meta' }, createElement('span', null, '仓库初始化前的逻辑根快照')),
        ),
        createElement('div', { className: 'lg4l-commit-actions' },
          createElement('button', { className: 'lg4l-button', type: 'button', onClick: () => { setSelector('ROOT'); setTab('code') } }, '查看'),
          createElement('button', { className: 'lg4l-button lg4l-button-danger', type: 'button', disabled: board.status?.head === null || mutationsDisabled, onClick: () => requestRollback({ id: 'ROOT', message: '空仓库根快照' }) }, board.status?.head === null ? '当前版本' : '回退到 ROOT'),
        ),
      ),
    ),
  )
}

function renderIssues(board: BoardData, sessionsById: SessionListState['byId']) {
  const issues = board.issues ?? []
  if (issues.length === 0) return createElement('div', { className: 'lg4l-empty' }, createElement('strong', null, '当前没有议题'), createElement('p', null, '智能体可通过 repo_issue_open 创建议题，再用 repo_issue_comment 与同工作区智能体显式讨论。'))
  return createElement('section', { className: 'lg4l-issue-list' },
    ...issues.map((issue) => {
      const comments = (board.comments ?? []).filter(comment => comment.issueId === issue.id)
      return createElement('article', { className: 'lg4l-issue', key: issue.id },
        createElement('div', { className: 'lg4l-issue-title' },
          createElement('span', { className: issue.status === 'closed' ? '' : 'lg4l-integrity' }, issue.status === 'closed' ? '●' : '◉'),
          createElement('span', null, issue.title),
          createElement('span', { className: 'lg4l-badge' }, issue.status),
        ),
        createElement('div', { className: 'lg4l-issue-meta' },
          createElement('code', null, issue.id),
          createElement('span', null, `由 ${actorLabel(issue.openedBy ?? 'admin', sessionsById)} 提出`),
          createElement('span', null, `${comments.length} 条讨论`),
        ),
        issue.body === '' ? null : createElement('div', { className: 'lg4l-issue-body' }, issue.body),
        createElement('div', { className: 'lg4l-labels' }, ...issue.labels.map(label => createElement('span', { className: 'lg4l-label', key: label }, label))),
        comments.length === 0 ? null : createElement('div', { className: 'lg4l-issue-comments' },
          ...comments.slice(0, 4).map(comment => createElement('div', { className: 'lg4l-issue-comment', key: comment.id },
            createElement('strong', null, actorLabel(comment.author, sessionsById)),
            createElement('span', null, comment.body),
          )),
          comments.length > 4 ? createElement('span', { className: 'lg4l-compose-note' }, `另有 ${comments.length - 4} 条讨论，请在“评论与 @”查看。`) : null,
        ),
      )
    }),
  )
}

function renderDiscuss(
  board: BoardData,
  workspace: WorkspaceView,
  sessionsById: SessionListState['byId'],
  liveAgents: Set<string>,
  mentions: string[],
  setMentions: (value: string[]) => void,
  commentBody: string,
  setCommentBody: (value: string) => void,
  commentIssueId: string | null,
  setCommentIssueId: (value: string | null) => void,
  sending: boolean,
  sendComment: () => void,
  composerDisabled: boolean,
) {
  const comments = board.comments ?? []
  const sessionIds = workspace.sessionIds.map(String)
  return createElement('div', { className: 'lg4l-discuss-grid' },
    createElement('section', { className: 'lg4l-comment-list' },
      comments.length === 0 ? createElement('div', { className: 'lg4l-empty', style: { minHeight: 180 } }, createElement('strong', null, '还没有协作评论'), createElement('p', null, '管理员与智能体的显式评论都会写入校验和日志；@ 在线智能体时会实时进入其下一步上下文。')) : null,
      ...comments.map(comment => createElement('article', { className: 'lg4l-comment', key: comment.id },
        createElement('div', { className: 'lg4l-avatar', 'aria-hidden': true }, actorAvatar(comment.author)),
        createElement('div', { className: 'lg4l-comment-box' },
          createElement('div', { className: 'lg4l-comment-head' },
            createElement('strong', null, actorLabel(comment.author, sessionsById)),
            comment.issueId === undefined ? createElement('span', { className: 'lg4l-label' }, '仓库') : createElement('span', { className: 'lg4l-label', title: comment.issueId }, `Issue ${shortId(comment.issueId)}`),
            createElement('span', null, formatDate(comment.createdAt)),
          ),
          createElement('div', { className: 'lg4l-comment-body' }, comment.body),
          createElement('div', { className: 'lg4l-comment-delivery' }, renderDeliveryStatus(comment)),
        ),
      )),
    ),
    createElement('aside', { className: 'lg4l-compose' },
      createElement('h3', null, '以 admin 身份评论'),
      createElement('p', null, '可写入仓库时间线或指定 Issue。智能体也可用 repo_comment / repo_issue_comment 参与；所有消息都必须显式提交。'),
      createElement('label', null,
        createElement('span', { style: visuallyHidden }, '评论范围'),
        createElement('select', {
          className: 'lg4l-select lg4l-scope-select',
          value: commentIssueId ?? '',
          disabled: composerDisabled,
          onChange: (event: ChangeEvent<HTMLSelectElement>) => setCommentIssueId(event.currentTarget.value === '' ? null : event.currentTarget.value),
          'aria-label': '选择评论范围',
        },
        createElement('option', { value: '' }, '仓库评论'),
        ...(board.issues ?? []).map(issue => createElement('option', { key: issue.id, value: issue.id }, `Issue · ${issue.title}`)),
        ),
      ),
      createElement('label', null,
        createElement('span', { style: visuallyHidden }, commentIssueId === null ? '管理员仓库评论' : '管理员议题评论'),
        createElement('textarea', {
          className: 'lg4l-textarea',
          value: commentBody,
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setCommentBody(event.currentTarget.value),
          placeholder: '输入评论、决策或需要智能体注意的实时信息…',
          maxLength: 16000,
          disabled: composerDisabled,
        }),
      ),
      createElement('div', { className: 'lg4l-mentions', 'aria-label': '选择要提及的智能体' },
        sessionIds.length === 0 ? createElement('span', { className: 'lg4l-compose-note' }, '当前工作区还没有可 @ 的会话。') : null,
        ...sessionIds.map(sessionId => {
          const selected = mentions.includes(sessionId)
          const summary = sessionsById[sessionId as keyof typeof sessionsById]
          return createElement('button', {
            key: sessionId,
            className: 'lg4l-mention',
            type: 'button',
            'data-selected': selected,
            'aria-pressed': selected,
            disabled: composerDisabled,
            onClick: () => setMentions(selected ? mentions.filter(id => id !== sessionId) : [...mentions, sessionId]),
            title: sessionId,
          },
          createElement('span', { className: 'lg4l-live-dot', 'data-live': liveAgents.has(sessionId), 'aria-hidden': true }),
          `@${summary?.displayTitle ?? shortSession(sessionId)}`,
          )
        }),
      ),
      createElement('div', { className: 'lg4l-compose-actions' },
        createElement('span', { className: 'lg4l-compose-note' }, `${commentBody.length}/16000`),
        createElement('button', { className: 'lg4l-button lg4l-button-primary', type: 'button', disabled: composerDisabled || sending || commentBody.trim() === '', onClick: sendComment }, sending ? '发送中…' : '发表评论'),
      ),
    ),
  )
}

function renderRollbackConfirm(target: CommitSummary | { id: 'ROOT'; message: string }, busy: boolean, cancel: () => void, confirm: () => void) {
  return createElement('div', { className: 'lg4l-confirm-backdrop' },
    createElement('section', { className: 'lg4l-confirm', role: 'alertdialog', 'aria-modal': true, 'aria-labelledby': 'lg4l-confirm-title', 'aria-describedby': 'lg4l-confirm-description' },
      createElement('h2', { id: 'lg4l-confirm-title' }, '确认回退此工作区？'),
      createElement('p', { id: 'lg4l-confirm-description' }, '将恢复到 ', createElement('code', null, target.id === 'ROOT' ? 'ROOT' : shortId(target.id)), '：', target.message, '。系统会追加一个带审计信息的新 rollback commit；当前 HEAD 不会删除，会继续作为完整备份保留。'),
      createElement('div', { className: 'lg4l-confirm-actions' },
        createElement('button', { className: 'lg4l-button', type: 'button', disabled: busy, onClick: cancel, autoFocus: true }, '取消'),
        createElement('button', { className: 'lg4l-button lg4l-button-danger', type: 'button', disabled: busy, onClick: confirm }, busy ? '正在回退…' : '确认追加回退提交'),
      ),
    ),
  )
}

function renderLoading() {
  return createElement('div', { className: 'lg4l-loading' }, createElement('span', { className: 'lg4l-spinner', 'aria-hidden': true }), createElement('span', null, '正在校验并读取本地仓库…'))
}

function renderNoWorkspace() {
  return createElement('div', { className: 'lg4l-empty' }, createElement('strong', null, '请选择要查看的仓库'), createElement('p', null, '请从面板顶部手动选择一个已注册工作区；管理接口只接收稳定 workspaceId，不接受任意文件系统路径。'))
}

function renderUninitialized(busy: boolean, initialize: () => void) {
  return createElement('div', { className: 'lg4l-empty' },
    createElement(FishLogo, { size: 42 }),
    createElement('strong', null, '此工作区尚未初始化本地仓库'),
    createElement('p', null, '初始化只会创建受控的 .dsh-repo 清单和校验和日志；不会扫描源码、读取会话内容或覆盖既有目录。'),
    createElement('button', { className: 'lg4l-button lg4l-button-primary', type: 'button', disabled: busy, onClick: initialize }, busy ? '正在初始化…' : '显式初始化仓库'),
  )
}

function findActiveWorkspace(items: readonly WorkspaceView[], currentSessionId: string | undefined, recentWorkspaceId: string | undefined): WorkspaceView | undefined {
  if (currentSessionId !== undefined) {
    const bySession = items.find(workspace => workspace.sessionIds.some(id => String(id) === currentSessionId))
    if (bySession !== undefined) return bySession
  }
  if (recentWorkspaceId !== undefined) {
    const recent = items.find(workspace => String(workspace.workspaceId) === recentWorkspaceId)
    if (recent !== undefined) return recent
  }
  return undefined
}

function readStoredWorkspaceId(): string | null {
  try {
    const value = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
    return value !== null && value.length > 0 && value.length <= 128 ? value : null
  } catch {
    return null
  }
}

function storeWorkspaceId(value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(WORKSPACE_STORAGE_KEY)
    else window.localStorage.setItem(WORKSPACE_STORAGE_KEY, value)
  } catch {
    // Selection remains valid for the current panel even if storage is blocked.
  }
}

const visuallyHidden = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' } as const

function stat(label: string, value: string | number) {
  return [createElement('dt', { key: `${label}-dt` }, label), createElement('dd', { key: `${label}-dd` }, String(value))]
}

function shortId(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return value.startsWith('sha256:') ? value.slice(7, 15) : value.slice(0, 10)
}

function shortSession(value: string): string {
  return value.length > 16 ? `${value.slice(0, 13)}…` : value
}

function actorLabel(
  actor: RepositoryComment['author'],
  sessionsById: SessionListState['byId'],
): string {
  if (actor === 'admin') return 'admin'
  const summary = sessionsById[actor.sessionId as keyof typeof sessionsById]
  return summary?.displayTitle ?? `智能体 ${shortSession(actor.sessionId)}`
}

function actorAvatar(actor: RepositoryComment['author']): string {
  return actor === 'admin' ? 'A' : 'LLM'
}

function valuePreview(value: JsonValue): string {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value)
  return rendered.length > 90 ? `${rendered.slice(0, 87)}…` : rendered
}

function renderDeliveryStatus(comment: RepositoryComment): string {
  if (comment.mentions.length === 0) return '未 @ 智能体'
  const delivered = new Set(comment.deliveredTo)
  const requested = new Set(comment.deliveryRequestedTo ?? [])
  const auditPending = [...requested].filter(sessionId => !delivered.has(sessionId)).length
  const notRequested = comment.mentions.filter(sessionId => !requested.has(sessionId)).length
  return `@ ${comment.mentions.length} 个 · 已投递并审计 ${comment.deliveredTo.length} 个${auditPending > 0 ? ` · 待投递或审计 ${auditPending} 个` : ''}${notRequested > 0 ? ` · 未进入投递队列 ${notRequested} 个` : ''}`
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'local-git-4-llm:repository-board-styles')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'local-git-4-llm-fab',
    order: 40,
    label: 'local-git-4-llm 仓库',
  }, LocalGitFab))
}
