import { createElement, useEffect, useMemo, useRef, useState, type ChangeEvent, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { ClientContext, SessionListState, WorkspaceListState, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'

const PLUGIN_ID = '@dsh-external/local-git-4-llm'
const STYLE_ID = 'local-git-4-llm-style'
const API_ROOT = '/local-git-4-llm/api'
const WORKSPACE_STORAGE_KEY = 'local-git-4-llm:selected-workspace'

type TabId = 'code' | 'backup' | 'history' | 'issues' | 'discuss'
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

interface FileBackupSnapshotSummary {
  id: string
  parent: string | null
  reason: 'initial' | 'scheduled' | 'manual' | 'pre-restore'
  capturedAt: string
  repositoryHead: string | null
  fileCount: number
  totalBytes: number
  ignoredFiles: number
}

interface FileBackupEntry {
  path: string
  size: number
  mode: number
  mtimeMs: number
  blob: string
}

interface FileBackupView {
  configured: boolean
  enabled: boolean
  integrity: 'ok' | 'error'
  journalEntries: number
  snapshots: number
  config?: {
    id: string
    scope: { kind: 'workspace' } | { kind: 'selected'; roots: string[] }
    intervalMinutes: number
    exclusions: 'safe-defaults-v1'
  }
  latest?: FileBackupSnapshotSummary
  nextCaptureAt?: string
  runtime: {
    running: boolean
    lastError?: string
    lastErrorAt?: string
  }
}

interface FileBackupCheckout {
  snapshot: FileBackupSnapshotSummary
  records: FileBackupEntry[]
  nextCursor?: string
  truncated: boolean
}

interface FileBackupPreview {
  snapshotId: string
  path: string
  size: number
  blob: string
  encoding: 'utf8' | 'binary' | 'too-large'
  content?: string
}

interface FileBackupChange {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  before?: FileBackupEntry
  after?: FileBackupEntry
}

interface FileBackupComparison {
  base: FileBackupSnapshotSummary | null
  head: FileBackupSnapshotSummary | null
  changes: FileBackupChange[]
  counts: { added: number; modified: number; deleted: number }
  truncated: boolean
  nextCursor?: string
}

interface FileBackupDiffLine {
  kind: 'context' | 'added' | 'deleted' | 'separator'
  beforeLine?: number
  afterLine?: number
  content?: string
  lineBreak?: boolean
}

interface FileBackupFileDiff {
  baseSnapshotId: string | null
  headSnapshotId: string | null
  path: string
  kind: 'added' | 'modified' | 'deleted'
  before?: Pick<FileBackupEntry, 'size' | 'mode' | 'blob'>
  after?: Pick<FileBackupEntry, 'size' | 'mode' | 'blob'>
  display: 'text' | 'binary' | 'too-large' | 'metadata-only'
  lines: FileBackupDiffLine[]
  truncated: boolean
}

interface FileBackupRootCandidate {
  id: string
  label: string
  kind: 'file' | 'directory'
  selected: boolean
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
  backup: FileBackupView
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
.lg4l-repo-id{min-width:0;display:flex;align-items:center;gap:10px}.lg4l-mark{display:grid;place-items:center;flex:0 0 auto;width:28px;height:28px}.lg4l-repo-copy{min-width:0}.lg4l-repo-line{display:flex;align-items:center;gap:7px;min-width:0;font-size:14px;font-weight:700}.lg4l-owner{color:var(--dsw-alias-label-secondary);font-weight:600}.lg4l-slash{color:var(--dsw-alias-label-secondary)}.lg4l-repo-picker{position:relative;min-width:120px;max-width:360px}.lg4l-repo-select{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:28px;padding:0 7px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;font-weight:700;cursor:pointer}.lg4l-repo-select-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lg4l-repo-chevron{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:10px}.lg4l-repo-select:hover,.lg4l-repo-select[aria-expanded="true"]{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}.lg4l-repo-select:focus-visible{outline:3px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 38%,transparent);outline-offset:1px}.lg4l-repo-menu{position:absolute;z-index:8;top:calc(100% + 5px);left:0;display:grid;width:max-content;min-width:100%;max-width:min(360px,75vw);max-height:260px;padding:5px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay);box-shadow:0 14px 36px color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent)}.lg4l-repo-option{display:grid;grid-template-columns:16px minmax(0,1fr);gap:6px;width:100%;padding:8px 9px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}.lg4l-repo-option:hover,.lg4l-repo-option:focus-visible{outline:0;background:var(--dsw-alias-bg-layer-2)}.lg4l-repo-option[data-selected="true"]{color:var(--dsw-alias-brand-primary);font-weight:700}.lg4l-badge{display:inline-flex;align-items:center;min-height:20px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:650}.lg4l-subline{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:10px}
.lg4l-top-actions{display:flex;align-items:center;gap:7px}.lg4l-icon-button{display:grid;place-items:center;width:32px;height:32px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:18px;cursor:pointer}.lg4l-icon-button:hover{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.lg4l-tabs{display:flex;align-items:end;gap:2px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);overflow-x:auto}.lg4l-tab{position:relative;display:flex;align-items:center;gap:7px;min-height:46px;padding:0 13px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:650;white-space:nowrap;cursor:pointer}.lg4l-tab:hover{color:var(--dsw-alias-label-primary)}.lg4l-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary)}.lg4l-tab[aria-selected="true"]:after{content:"";position:absolute;left:9px;right:9px;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary)}.lg4l-count{min-width:18px;padding:1px 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);text-align:center;font-size:10px}
.lg4l-content{min-height:0;overflow:auto;padding:16px;background:var(--dsw-alias-bg-base)}.lg4l-loading,.lg4l-empty{display:grid;place-items:center;align-content:center;gap:10px;min-height:260px;padding:30px;text-align:center;color:var(--dsw-alias-label-secondary)}.lg4l-empty strong{color:var(--dsw-alias-label-primary);font-size:16px}.lg4l-empty p{max-width:560px;margin:0;font-size:12px;line-height:1.6}.lg4l-spinner{width:24px;height:24px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:lg4l-spin .8s linear infinite}@keyframes lg4l-spin{to{transform:rotate(360deg)}}
.lg4l-error{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1));border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:1.5}.lg4l-error button{border:0;background:transparent;color:inherit;cursor:pointer}
.lg4l-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.lg4l-toolbar-left,.lg4l-toolbar-right{display:flex;align-items:center;gap:8px;min-width:0}.lg4l-select{min-width:180px;max-width:420px;height:34px;padding:0 30px 0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px}.lg4l-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;font-weight:650;cursor:pointer}.lg4l-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.lg4l-button:disabled{opacity:.48;cursor:not-allowed}.lg4l-button-primary{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 72%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary)}.lg4l-button-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,var(--dsw-alias-bg-layer-2))}.lg4l-button-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 62%,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-error-primary)}
.lg4l-grid{display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:14px;align-items:start}.lg4l-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}.lg4l-card-title{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:42px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11px;font-weight:700}.lg4l-card-title code{font-size:10px;color:var(--dsw-alias-label-secondary)}
.lg4l-file-list{display:grid}.lg4l-file-row{display:grid;grid-template-columns:minmax(180px,1fr) minmax(160px,1.3fr) auto;gap:12px;align-items:center;min-height:42px;padding:0 12px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}.lg4l-file-row:last-child{border-bottom:0}.lg4l-file-row:hover,.lg4l-file-row[data-selected="true"]{background:var(--dsw-alias-bg-layer-2)}.lg4l-file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-brand-primary);font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}.lg4l-file-preview{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:10px}.lg4l-file-hash{color:var(--dsw-alias-label-secondary);font:9px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
.lg4l-code-detail{margin-top:12px}.lg4l-code-detail pre{max-height:260px;margin:0;padding:14px;overflow:auto;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.lg4l-side-stack{display:grid;gap:10px}.lg4l-stat-list{display:grid;grid-template-columns:1fr auto;gap:9px 12px;padding:12px;font-size:10px}.lg4l-stat-list dt{color:var(--dsw-alias-label-secondary)}.lg4l-stat-list dd{margin:0;font-weight:700}.lg4l-integrity{color:var(--dsw-alias-state-success-primary)}
.lg4l-history{display:grid;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}.lg4l-commit{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}.lg4l-commit:last-child{border-bottom:0}.lg4l-commit-main{min-width:0}.lg4l-commit-message{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:700}.lg4l-rollback-badge{padding:2px 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:9px}.lg4l-commit-meta{display:flex;flex-wrap:wrap;gap:7px;margin-top:5px;color:var(--dsw-alias-label-secondary);font-size:9px}.lg4l-commit-meta code{font:inherit;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.lg4l-commit-actions{display:flex;align-items:center;gap:6px}
.lg4l-review{display:grid;gap:12px}.lg4l-compare-bar{display:grid;grid-template-columns:minmax(170px,1fr) auto minmax(170px,1fr) auto;gap:9px;align-items:center;padding:11px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.lg4l-compare-arrow{color:var(--dsw-alias-label-secondary);font-weight:800}.lg4l-version-picker{position:relative;min-width:0}.lg4l-version-picker>summary{display:grid;gap:2px;min-height:40px;box-sizing:border-box;padding:6px 28px 6px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);cursor:pointer;list-style:none}.lg4l-version-picker>summary::-webkit-details-marker{display:none}.lg4l-version-picker>summary:after{content:"▾";position:absolute;right:9px;top:14px;color:var(--dsw-alias-label-secondary);font-size:9px}.lg4l-version-picker[open]>summary:after{content:"▴"}.lg4l-version-picker>summary span{color:var(--dsw-alias-label-secondary);font-size:9px}.lg4l-version-picker>summary strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.lg4l-version-menu{position:absolute;z-index:7;top:calc(100% + 5px);left:0;width:max-content;min-width:100%;max-width:min(420px,72vw);max-height:260px;padding:5px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay);box-shadow:0 14px 36px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}.lg4l-version-menu button{display:grid;grid-template-columns:16px minmax(0,1fr);gap:5px;width:100%;padding:8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:10px;text-align:left;cursor:pointer}.lg4l-version-menu button:hover,.lg4l-version-menu button:focus-visible{outline:0;background:var(--dsw-alias-bg-layer-2)}.lg4l-version-menu button[aria-selected="true"]{color:var(--dsw-alias-brand-primary);font-weight:700}.lg4l-diff-counts{display:flex;gap:5px;font:10px/1 ui-monospace,SFMono-Regular,Consolas,monospace}.lg4l-diff-counts span{padding:5px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}.lg4l-diff-counts [data-kind="added"]{color:var(--dsw-alias-state-success-primary)}.lg4l-diff-counts [data-kind="modified"]{color:var(--dsw-alias-state-warn-primary)}.lg4l-diff-counts [data-kind="deleted"]{color:var(--dsw-alias-state-error-primary)}.lg4l-review-grid{display:grid;grid-template-columns:270px minmax(0,1fr);min-height:380px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}.lg4l-changed-files{min-width:0;max-height:540px;overflow:auto;border-right:1px solid var(--dsw-alias-border-l2)}.lg4l-changed-files-head{position:sticky;z-index:3;top:0;display:flex;align-items:center;justify-content:space-between;gap:7px;min-height:40px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:10px}.lg4l-changed-files-head strong{color:var(--dsw-alias-label-primary)}.lg4l-file-filter{position:sticky;z-index:3;top:40px;display:grid;grid-template-columns:18px minmax(0,1fr);align-items:center;gap:4px;margin:8px;padding:0 8px;min-height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary)}.lg4l-file-filter:focus-within{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}.lg4l-file-filter input{min-width:0;width:100%;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:10px/1.4 inherit;appearance:none}.lg4l-file-filter input::placeholder{color:var(--dsw-alias-label-secondary)}.lg4l-file-filter input::-webkit-search-cancel-button{-webkit-appearance:none}.lg4l-filter-empty{padding:20px 12px;color:var(--dsw-alias-label-secondary);font-size:10px;text-align:center}.lg4l-changed-file{display:grid;grid-template-columns:20px minmax(0,1fr);align-items:center;gap:7px;width:100%;min-height:42px;padding:7px 10px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}.lg4l-changed-file:hover,.lg4l-changed-file[data-selected="true"]{background:var(--dsw-alias-bg-layer-2)}.lg4l-changed-file[data-selected="true"]{box-shadow:inset 2px 0 var(--dsw-alias-brand-primary)}.lg4l-change-kind{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:5px;font:800 9px/1 ui-monospace,SFMono-Regular,Consolas,monospace}.lg4l-change-kind[data-kind="added"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}.lg4l-change-kind[data-kind="modified"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-primary)}.lg4l-change-kind[data-kind="deleted"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}.lg4l-changed-path{display:flex;min-width:0;overflow:hidden;white-space:nowrap;font:10px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}.lg4l-changed-directory{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}.lg4l-changed-name{flex:0 0 auto;color:var(--dsw-alias-label-primary)}.lg4l-diff-panel{min-width:0;max-height:540px;overflow:auto;background:var(--dsw-alias-bg-base)}.lg4l-diff-head{position:sticky;z-index:2;top:0;display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:44px;padding:0 11px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:10px}.lg4l-diff-head>div{display:flex;align-items:center;gap:7px;min-width:0}.lg4l-diff-head strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.lg4l-diff-head>span{color:var(--dsw-alias-label-secondary);white-space:nowrap}.lg4l-diff-table{display:grid;min-width:max-content;background:var(--dsw-alias-bg-base);font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.lg4l-diff-line{display:grid;grid-template-columns:44px 44px 22px minmax(420px,1fr);min-height:22px}.lg4l-diff-line[data-kind="added"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,var(--dsw-alias-bg-base))}.lg4l-diff-line[data-kind="deleted"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,var(--dsw-alias-bg-base))}.lg4l-line-number{padding:2px 7px;border-right:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);text-align:right;user-select:none}.lg4l-line-mark{padding:2px 6px;color:var(--dsw-alias-label-secondary);text-align:center;user-select:none}.lg4l-diff-line[data-kind="added"] .lg4l-line-mark{color:var(--dsw-alias-state-success-primary)}.lg4l-diff-line[data-kind="deleted"] .lg4l-line-mark{color:var(--dsw-alias-state-error-primary)}.lg4l-diff-line code{padding:2px 9px;color:var(--dsw-alias-label-primary);white-space:pre}.lg4l-no-lf{color:var(--dsw-alias-state-warn-primary)}.lg4l-diff-separator{padding:4px 111px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-brand-primary);font:10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}.lg4l-diff-truncated{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-state-warn-primary);font-size:10px}.lg4l-review-empty{min-height:190px}.lg4l-diff-notice{min-height:300px}.lg4l-logical-history{margin-top:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}.lg4l-logical-history>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:42px;padding:0 12px;cursor:pointer;list-style:none;font-size:10px}.lg4l-logical-history>summary::-webkit-details-marker{display:none}.lg4l-logical-history>summary span{color:var(--dsw-alias-label-secondary);font-size:9px}.lg4l-logical-history .lg4l-history{border:0;border-top:1px solid var(--dsw-alias-border-l1);border-radius:0}
.lg4l-issue-list,.lg4l-comment-list{display:grid;gap:10px}.lg4l-issue{padding:13px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.lg4l-issue-title{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700}.lg4l-issue-body{margin-top:7px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1.55}.lg4l-labels{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.lg4l-label{padding:2px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:9px}
.lg4l-discuss-grid{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:14px}.lg4l-comment{display:grid;grid-template-columns:30px minmax(0,1fr);gap:9px}.lg4l-avatar{display:grid;place-items:center;width:28px;height:28px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l1));border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-size:11px;font-weight:800}.lg4l-comment-box{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}.lg4l-comment-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:9px}.lg4l-comment-body{padding:10px;font-size:11px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.lg4l-comment-delivery{padding:0 10px 9px;color:var(--dsw-alias-label-secondary);font-size:9px}.lg4l-compose{position:sticky;top:0;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.lg4l-compose h3{margin:0 0 5px;font-size:12px}.lg4l-compose p{margin:0 0 10px;color:var(--dsw-alias-label-secondary);font-size:9px;line-height:1.5}.lg4l-textarea{box-sizing:border-box;width:100%;min-height:120px;resize:vertical;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:11px/1.5 inherit}.lg4l-mentions{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.lg4l-mention{display:inline-flex;align-items:center;gap:5px;padding:5px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:9px;cursor:pointer}.lg4l-mention[data-selected="true"]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary)}.lg4l-live-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-secondary)}.lg4l-live-dot[data-live="true"]{background:var(--dsw-alias-state-success-primary)}.lg4l-compose-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}.lg4l-compose-note{color:var(--dsw-alias-label-secondary);font-size:9px}
.lg4l-toast{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-size:10px}.lg4l-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:9px}.lg4l-footer code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.lg4l-confirm-backdrop{position:absolute;inset:0;z-index:3;display:grid;place-items:center;padding:20px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 72%,transparent);backdrop-filter:blur(4px)}.lg4l-confirm{width:min(440px,100%);padding:17px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 50px color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent)}.lg4l-confirm h2{margin:0 0 8px;font-size:15px}.lg4l-confirm p{margin:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}.lg4l-confirm code{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.lg4l-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.lg4l-issue-meta{display:flex;flex-wrap:wrap;gap:8px;margin:5px 0 8px;color:var(--dsw-alias-label-secondary);font-size:9px}.lg4l-issue-meta code{min-width:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.lg4l-issue-comments{display:grid;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}.lg4l-issue-comment{display:grid;grid-template-columns:minmax(90px,150px) minmax(0,1fr);gap:8px;padding:7px 9px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);font-size:10px;line-height:1.45}.lg4l-issue-comment span{min-width:0;overflow-wrap:anywhere}.lg4l-scope-select{width:100%;max-width:none;margin-bottom:9px}.lg4l-repo-select:disabled{opacity:.62;cursor:not-allowed}.lg4l-comment-head strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lg4l-backup-layout{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:14px;align-items:start}.lg4l-backup-form{display:grid;gap:11px;padding:14px}.lg4l-field{display:grid;gap:5px;color:var(--dsw-alias-label-secondary);font-size:10px}.lg4l-input{box-sizing:border-box;width:100%;min-height:36px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:11px/1.4 inherit}.lg4l-input[type="number"]{max-width:160px}.lg4l-roots{min-height:86px;resize:vertical}.lg4l-check{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1.5}.lg4l-check input{margin-top:2px;accent-color:var(--dsw-alias-brand-primary)}.lg4l-warning{padding:10px 11px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 42%,var(--dsw-alias-border-l1));border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1.55}.lg4l-root-list{display:grid;gap:5px;max-height:260px;padding:6px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}.lg4l-root-row{display:flex;align-items:center;gap:5px;min-width:0}.lg4l-root-choice{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lg4l-root-expand{flex:0 0 auto;padding:4px 6px;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:9px;cursor:pointer}.lg4l-root-expand:disabled{color:var(--dsw-alias-label-secondary);cursor:not-allowed}.lg4l-backup-actions{display:flex;flex-wrap:wrap;gap:8px}.lg4l-backup-files{max-height:330px;overflow:auto}.lg4l-backup-preview{margin-top:10px}.lg4l-backup-preview pre{max-height:300px;margin:0;padding:13px;overflow:auto;background:var(--dsw-alias-bg-layer-2);font:10px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.lg4l-status-dot{display:inline-block;width:7px;height:7px;margin-right:6px;border-radius:50%;background:var(--dsw-alias-label-secondary)}.lg4l-status-dot[data-active="true"]{background:var(--dsw-alias-state-success-primary)}
@media(max-width:760px){.lg4l-overlay{right:max(8px,env(safe-area-inset-right));bottom:max(8px,env(safe-area-inset-bottom))}.lg4l-panel{width:calc(100vw - 16px);height:calc(100vh - 82px);height:calc(100dvh - 82px - env(safe-area-inset-bottom));min-height:0;border-radius:13px}.lg4l-content{padding:11px}.lg4l-grid,.lg4l-discuss-grid,.lg4l-backup-layout{grid-template-columns:1fr}.lg4l-side-stack{grid-template-columns:repeat(2,minmax(0,1fr))}.lg4l-compose{position:static}.lg4l-file-row{grid-template-columns:minmax(120px,1fr) minmax(100px,1fr)}.lg4l-file-hash{display:none}.lg4l-commit{grid-template-columns:1fr}.lg4l-commit-actions{justify-content:flex-start}.lg4l-repo-line{font-size:12px}.lg4l-badge{display:none}.lg4l-icon-button{width:40px;height:40px}.lg4l-button{min-height:40px}.lg4l-mention{min-height:32px;padding-inline:10px}.lg4l-issue-comment{grid-template-columns:1fr}.lg4l-compare-bar{grid-template-columns:1fr auto 1fr}.lg4l-diff-counts{grid-column:1/-1;justify-content:flex-end}.lg4l-review-grid{grid-template-columns:1fr}.lg4l-changed-files{max-height:180px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2)}.lg4l-diff-panel{max-height:480px}.lg4l-diff-head{align-items:flex-start;flex-direction:column;padding-block:8px}}
@media(max-width:480px){.lg4l-owner,.lg4l-slash{display:none}.lg4l-repo-picker{min-width:0;max-width:190px}.lg4l-repo-select{font-size:12px}.lg4l-tab{padding:0 9px}.lg4l-toolbar{align-items:stretch;flex-direction:column}.lg4l-toolbar-left,.lg4l-toolbar-right{width:100%}.lg4l-select{min-width:0;width:100%}.lg4l-side-stack{grid-template-columns:1fr}.lg4l-footer span:first-child{display:none}.lg4l-compare-bar{grid-template-columns:1fr}.lg4l-compare-arrow{transform:rotate(90deg);text-align:center}.lg4l-diff-counts{grid-column:auto;justify-content:flex-start}.lg4l-version-menu{max-width:calc(100vw - 54px)}.lg4l-diff-line{grid-template-columns:34px 34px 20px minmax(280px,1fr)}}
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
  const backupHistoryRequestIdRef = useRef(0)
  const backupCheckoutRequestIdRef = useRef(0)
  const backupCandidatesRequestIdRef = useRef(0)
  const backupPreviewRequestIdRef = useRef(0)
  const backupCompareRequestIdRef = useRef(0)
  const backupDiffRequestIdRef = useRef(0)
  const mutationIdRef = useRef(0)
  const activationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const selectedWorkspaceIntentRef = useRef<string | null>(selectedWorkspaceId)
  const panelWasOpenRef = useRef(false)
  workspaceIdRef.current = workspaceId

  const [open, setOpen] = useState(false)
  const [repositoryMenuOpen, setRepositoryMenuOpen] = useState(false)
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
  const [action, setAction] = useState<'initialize' | 'comment' | 'rollback' | 'backup-enable' | 'backup-disable' | 'backup-capture' | 'backup-export' | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [rollbackTarget, setRollbackTarget] = useState<BoundRollbackTarget | null>(null)
  const [backupCandidates, setBackupCandidates] = useState<FileBackupRootCandidate[]>([])
  const [backupRootIds, setBackupRootIds] = useState<string[]>([])
  const [backupExpandedRootIds, setBackupExpandedRootIds] = useState<string[]>([])
  const [backupCandidateLoadingId, setBackupCandidateLoadingId] = useState<string | null>(null)
  const [backupInterval, setBackupInterval] = useState(15)
  const [backupConfirmed, setBackupConfirmed] = useState(false)
  const [backupHistory, setBackupHistory] = useState<FileBackupSnapshotSummary[]>([])
  const [backupSnapshotId, setBackupSnapshotId] = useState<string | null>(null)
  const [backupCheckout, setBackupCheckout] = useState<FileBackupCheckout | null>(null)
  const [backupSelectedPath, setBackupSelectedPath] = useState<string | null>(null)
  const [backupPreview, setBackupPreview] = useState<FileBackupPreview | null>(null)
  const [backupLoading, setBackupLoading] = useState(false)
  const [compareBaseId, setCompareBaseId] = useState<string | null>(null)
  const [compareHeadId, setCompareHeadId] = useState<string | null>(null)
  const [backupComparison, setBackupComparison] = useState<FileBackupComparison | null>(null)
  const [compareSelectedPath, setCompareSelectedPath] = useState<string | null>(null)
  const [backupFileDiff, setBackupFileDiff] = useState<FileBackupFileDiff | null>(null)
  const [compareFilter, setCompareFilter] = useState('')
  const [comparisonLoading, setComparisonLoading] = useState(false)
  const [fileDiffLoading, setFileDiffLoading] = useState(false)
  const [comparisonPaging, setComparisonPaging] = useState(false)

  useEffect(() => {
    if (selectedWorkspaceId !== null && workspaces.length > 0 && !workspaces.some(workspace => String(workspace.workspaceId) === selectedWorkspaceId)) {
      setSelectedWorkspaceId(null)
      selectedWorkspaceIntentRef.current = null
      storeWorkspaceId(null)
    }
  }, [workspaces, selectedWorkspaceId])

  useEffect(() => {
    setSelector('HEAD')
    setRepositoryMenuOpen(false)
    setBoard(null)
    setSelectedKey(null)
    setMentions([])
    setCommentBody('')
    setCommentIssueId(null)
    setRollbackTarget(null)
    setBackupCandidates([])
    setBackupRootIds([])
    setBackupExpandedRootIds([])
    setBackupCandidateLoadingId(null)
    setBackupInterval(15)
    setBackupConfirmed(false)
    setBackupHistory([])
    setBackupSnapshotId(null)
    setBackupCheckout(null)
    setBackupSelectedPath(null)
    setBackupPreview(null)
    setBackupLoading(false)
    setCompareBaseId(null)
    setCompareHeadId(null)
    setBackupComparison(null)
    setCompareSelectedPath(null)
    setBackupFileDiff(null)
    setCompareFilter('')
    setComparisonLoading(false)
    setFileDiffLoading(false)
    setComparisonPaging(false)
    setTab('code')
    setToast(null)
    setError(null)
  }, [workspaceId])

  useEffect(() => {
    const config = board?.backup.config
    if (config === undefined) return
    setBackupInterval(config.intervalMinutes)
    setBackupConfirmed(false)
  }, [workspaceId, board?.backup.config?.id])

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
    if (!open || tab !== 'backup' || workspaceId === undefined || !board?.initialized) {
      setBackupCandidates([])
      setBackupRootIds([])
      setBackupExpandedRootIds([])
      setBackupCandidateLoadingId(null)
      return
    }
    const controller = new AbortController()
    const requestId = ++backupCandidatesRequestIdRef.current
    const requestWorkspaceId = workspaceId
    apiRequest<{ candidates: FileBackupRootCandidate[] }>(`/backup/candidates?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal })
      .then((value) => {
        if (requestId !== backupCandidatesRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
        setBackupCandidates(value.candidates)
        setBackupRootIds(current => {
          const valid = current.filter(id => value.candidates.some(candidate => candidate.id === id))
          return valid.length > 0 ? valid : value.candidates.filter(candidate => candidate.selected).map(candidate => candidate.id)
        })
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (requestId !== backupCandidatesRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
        setError(reason instanceof Error ? reason.message : '无法列出可备份的工作区条目。')
      })
    return () => controller.abort()
  }, [open, tab, workspaceId, board?.initialized, board?.backup.config?.id])

  useEffect(() => {
    if (!open || (tab !== 'backup' && tab !== 'history') || workspaceId === undefined || (board?.backup.snapshots ?? 0) === 0) {
      setBackupHistory([])
      setBackupSnapshotId(null)
      setBackupCheckout(null)
      setBackupSelectedPath(null)
      setBackupPreview(null)
      setCompareHeadId(null)
      setCompareBaseId(null)
      setBackupComparison(null)
      setCompareSelectedPath(null)
      setBackupFileDiff(null)
      return
    }
    const controller = new AbortController()
    const requestId = ++backupHistoryRequestIdRef.current
    const requestWorkspaceId = workspaceId
    setBackupLoading(true)
    apiRequest<{ snapshots: FileBackupSnapshotSummary[] }>(`/backup/history?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal })
      .then((value) => {
        if (requestId !== backupHistoryRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
        setBackupHistory(value.snapshots)
        setBackupSnapshotId(current => current !== null && value.snapshots.some(snapshot => snapshot.id === current)
          ? current : value.snapshots[0]?.id ?? null)
        setCompareHeadId(current => current !== null && value.snapshots.some(snapshot => snapshot.id === current)
          ? current : value.snapshots[0]?.id ?? null)
        setCompareBaseId(current => current !== null && (current === 'ROOT' || value.snapshots.some(snapshot => snapshot.id === current))
          ? current : value.snapshots[1]?.id ?? 'ROOT')
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (requestId !== backupHistoryRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
        setError(reason instanceof Error ? reason.message : '无法读取文件备份历史。')
      })
      .finally(() => {
        if (!controller.signal.aborted && requestId === backupHistoryRequestIdRef.current) setBackupLoading(false)
      })
    return () => controller.abort()
  }, [open, tab, workspaceId, board?.backup.snapshots, refreshTick])

  useEffect(() => {
    if (compareHeadId === null || backupHistory.length === 0) return
    if (compareBaseId !== null && compareBaseId !== compareHeadId) return
    const headIndex = backupHistory.findIndex(snapshot => snapshot.id === compareHeadId)
    setCompareBaseId(headIndex >= 0 ? backupHistory[headIndex + 1]?.id ?? 'ROOT' : 'ROOT')
  }, [backupHistory, compareBaseId, compareHeadId])

  useEffect(() => {
    if (!open || tab !== 'backup' || workspaceId === undefined || backupSnapshotId === null) return
    const controller = new AbortController()
    const requestId = ++backupCheckoutRequestIdRef.current
    const requestWorkspaceId = workspaceId
    setBackupLoading(true)
    apiRequest<FileBackupCheckout>(`/backup/snapshot?workspaceId=${encodeURIComponent(workspaceId)}&snapshot=${encodeURIComponent(backupSnapshotId)}&limit=250`, { signal: controller.signal })
      .then((value) => {
        if (requestId !== backupCheckoutRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
        setBackupCheckout(value)
        setBackupSelectedPath(current => current !== null && value.records.some(record => record.path === current)
          ? current : value.records[0]?.path ?? null)
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (requestId !== backupCheckoutRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
        setError(reason instanceof Error ? reason.message : '无法读取文件快照。')
      })
      .finally(() => {
        if (!controller.signal.aborted && requestId === backupCheckoutRequestIdRef.current) setBackupLoading(false)
      })
    return () => controller.abort()
  }, [open, tab, workspaceId, backupSnapshotId, refreshTick])

  useEffect(() => {
    if (!open || tab !== 'backup' || workspaceId === undefined || backupSnapshotId === null || backupSelectedPath === null) {
      setBackupPreview(null)
      return
    }
    const controller = new AbortController()
    const requestId = ++backupPreviewRequestIdRef.current
    const requestWorkspaceId = workspaceId
    apiRequest<FileBackupPreview>(`/backup/preview?workspaceId=${encodeURIComponent(workspaceId)}&snapshot=${encodeURIComponent(backupSnapshotId)}&path=${encodeURIComponent(backupSelectedPath)}`, { signal: controller.signal })
      .then((value) => {
        if (requestId !== backupPreviewRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
        setBackupPreview(value)
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (requestId !== backupPreviewRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
        setBackupPreview(null)
        setError(reason instanceof Error ? reason.message : '无法读取文件预览。')
      })
    return () => controller.abort()
  }, [open, tab, workspaceId, backupSnapshotId, backupSelectedPath])

  useEffect(() => {
    if (!open || tab !== 'history' || workspaceId === undefined || compareBaseId === null || compareHeadId === null) {
      backupCompareRequestIdRef.current += 1
      setBackupComparison(null)
      setCompareSelectedPath(null)
      setBackupFileDiff(null)
      setComparisonLoading(false)
      setComparisonPaging(false)
      return
    }
    const controller = new AbortController()
    const requestId = ++backupCompareRequestIdRef.current
    const requestWorkspaceId = workspaceId
    setBackupComparison(null)
    setCompareSelectedPath(null)
    setBackupFileDiff(null)
    setComparisonLoading(true)
    apiRequest<FileBackupComparison>(
      `/backup/compare?workspaceId=${encodeURIComponent(workspaceId)}&base=${encodeURIComponent(compareBaseId)}&head=${encodeURIComponent(compareHeadId)}&limit=250`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (requestId !== backupCompareRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
        setBackupComparison(value)
        setCompareSelectedPath(current => current !== null && value.changes.some(change => change.path === current)
          ? current : value.changes[0]?.path ?? null)
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (requestId !== backupCompareRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
        setBackupComparison(null)
        setCompareSelectedPath(null)
        setError(reason instanceof Error ? reason.message : '无法比较两个文件备份版本。')
      })
      .finally(() => {
        if (!controller.signal.aborted && requestId === backupCompareRequestIdRef.current) setComparisonLoading(false)
      })
    return () => controller.abort()
  }, [open, tab, workspaceId, compareBaseId, compareHeadId, refreshTick])

  useEffect(() => {
    if (!open || tab !== 'history' || workspaceId === undefined || compareBaseId === null
      || compareHeadId === null || compareSelectedPath === null) {
      backupDiffRequestIdRef.current += 1
      setBackupFileDiff(null)
      setFileDiffLoading(false)
      return
    }
    const controller = new AbortController()
    const requestId = ++backupDiffRequestIdRef.current
    const requestWorkspaceId = workspaceId
    setBackupFileDiff(null)
    setFileDiffLoading(true)
    apiRequest<FileBackupFileDiff>(
      `/backup/diff?workspaceId=${encodeURIComponent(workspaceId)}&base=${encodeURIComponent(compareBaseId)}&head=${encodeURIComponent(compareHeadId)}&path=${encodeURIComponent(compareSelectedPath)}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (requestId !== backupDiffRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
        setBackupFileDiff(value)
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (requestId !== backupDiffRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
        setBackupFileDiff(null)
        setError(reason instanceof Error ? reason.message : '无法读取文件差异。')
      })
      .finally(() => {
        if (!controller.signal.aborted && requestId === backupDiffRequestIdRef.current) setFileDiffLoading(false)
      })
    return () => controller.abort()
  }, [open, tab, workspaceId, compareBaseId, compareHeadId, compareSelectedPath])

  useEffect(() => {
    if (!open || tab !== 'history' || backupComparison === null) return
    const filter = compareFilter.trim().toLocaleLowerCase()
    const visible = filter === ''
      ? backupComparison.changes
      : backupComparison.changes.filter(change => change.path.toLocaleLowerCase().includes(filter))
    setCompareSelectedPath(current => current !== null && visible.some(change => change.path === current)
      ? current : visible[0]?.path ?? null)
  }, [open, tab, backupComparison, compareFilter])

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
    setRepositoryMenuOpen(false)
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
    selectedWorkspaceIntentRef.current = value
    storeWorkspaceId(value)
    const title = workspaces.find(workspace => String(workspace.workspaceId) === value)?.title ?? '所选仓库'
    if (currentSessionId === undefined || currentSessionId === null) {
      setToast(`看板已切换到“${title}”；当前没有可激活的在线会话。`)
      return
    }
    const sessionId = String(currentSessionId)
    setToast(`正在将“${title}”设为当前会话仓库…`)
    const activation = activationQueueRef.current
      .catch(() => undefined)
      .then(() => apiRequest('/activate', { method: 'POST', body: { workspaceId: value, sessionId } }))
    activationQueueRef.current = activation.then(() => undefined, () => undefined)
    void activation
      .then(() => {
        if (selectedWorkspaceIntentRef.current === value) setToast(`已切换并激活“${title}”；后续 repo_* 工具将使用此仓库。`)
      })
      .catch((reason: unknown) => {
        if (selectedWorkspaceIntentRef.current === value) setError(reason instanceof Error ? reason.message : '面板仓库激活失败。')
      })
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

  const loadBackupChildren = async (candidate: FileBackupRootCandidate) => {
    if (workspaceId === undefined || candidate.kind !== 'directory' || backupCandidateLoadingId !== null) return
    const requestWorkspaceId = workspaceId
    setBackupCandidateLoadingId(candidate.id)
    setError(null)
    try {
      const value = await apiRequest<{ candidates: FileBackupRootCandidate[] }>(`/backup/candidates?workspaceId=${encodeURIComponent(requestWorkspaceId)}&parentId=${encodeURIComponent(candidate.id)}`)
      if (workspaceIdRef.current !== requestWorkspaceId) return
      setBackupCandidates(current => {
        const merged = new Map(current.map(item => [item.id, item]))
        for (const item of value.candidates) merged.set(item.id, item)
        return [...merged.values()].sort((left, right) => left.label.localeCompare(right.label))
      })
      setBackupRootIds(current => [...new Set([
        ...current,
        ...value.candidates.filter(item => item.selected).map(item => item.id),
      ])])
      setBackupExpandedRootIds(current => current.includes(candidate.id) ? current : [...current, candidate.id])
    } catch (reason) {
      if (workspaceIdRef.current !== requestWorkspaceId) return
      setError(reason instanceof Error ? reason.message : '无法展开备份目录。')
    } finally {
      if (workspaceIdRef.current === requestWorkspaceId) setBackupCandidateLoadingId(null)
    }
  }

  const enableBackup = async () => {
    if (workspaceId === undefined || !backupConfirmed) return
    if (backupRootIds.length === 0) {
      setError('请至少勾选一个面板列出的工作区文件或目录。')
      return
    }
    const requestWorkspaceId = workspaceId
    const mutationId = ++mutationIdRef.current
    setAction('backup-enable')
    setError(null)
    try {
      const result = await apiRequest<{ created: boolean; snapshot: FileBackupSnapshotSummary | null; status: FileBackupView }>('/backup/enable', {
        method: 'POST',
        body: {
          workspaceId: requestWorkspaceId,
          rootIds: backupRootIds,
          intervalMinutes: backupInterval,
          confirmSensitiveRisk: true,
        },
      })
      if (workspaceIdRef.current !== requestWorkspaceId || mutationIdRef.current !== mutationId) return
      setBackupConfirmed(false)
      setToast(result.created
        ? `文件自动备份已启用，并创建初始快照 ${shortId(result.snapshot?.id)}。`
        : '文件自动备份已启用；当前内容与已有快照一致。')
      refresh()
    } catch (reason) {
      if (workspaceIdRef.current !== requestWorkspaceId || mutationIdRef.current !== mutationId) return
      setError(reason instanceof Error ? reason.message : '文件自动备份启用失败。')
      refresh()
    } finally {
      if (mutationIdRef.current === mutationId) setAction(null)
    }
  }

  const disableBackup = async () => {
    if (workspaceId === undefined) return
    const requestWorkspaceId = workspaceId
    const mutationId = ++mutationIdRef.current
    setAction('backup-disable')
    setError(null)
    try {
      await apiRequest('/backup/disable', { method: 'POST', body: { workspaceId: requestWorkspaceId } })
      if (workspaceIdRef.current !== requestWorkspaceId || mutationIdRef.current !== mutationId) return
      setToast('已关闭自动扫描；已有文件快照和恢复导出仍然保留。')
      refresh()
    } catch (reason) {
      if (workspaceIdRef.current !== requestWorkspaceId || mutationIdRef.current !== mutationId) return
      setError(reason instanceof Error ? reason.message : '关闭文件自动备份失败。')
    } finally {
      if (mutationIdRef.current === mutationId) setAction(null)
    }
  }

  const captureBackup = async () => {
    if (workspaceId === undefined) return
    const requestWorkspaceId = workspaceId
    const mutationId = ++mutationIdRef.current
    setAction('backup-capture')
    setError(null)
    try {
      const result = await apiRequest<{ created: boolean; snapshot: FileBackupSnapshotSummary | null }>('/backup/capture', {
        method: 'POST',
        body: { workspaceId: requestWorkspaceId },
      })
      if (workspaceIdRef.current !== requestWorkspaceId || mutationIdRef.current !== mutationId) return
      setToast(result.created
        ? `已创建文件快照 ${shortId(result.snapshot?.id)}，共 ${result.snapshot?.fileCount ?? 0} 个文件。`
        : '文件内容没有变化，未追加重复快照。')
      refresh()
    } catch (reason) {
      if (workspaceIdRef.current !== requestWorkspaceId || mutationIdRef.current !== mutationId) return
      setError(reason instanceof Error ? reason.message : '立即文件备份失败。')
    } finally {
      if (mutationIdRef.current === mutationId) setAction(null)
    }
  }

  const exportBackup = async () => {
    if (workspaceId === undefined || backupSnapshotId === null) return
    const requestWorkspaceId = workspaceId
    const requestSnapshotId = backupSnapshotId
    const mutationId = ++mutationIdRef.current
    setAction('backup-export')
    setError(null)
    try {
      const result = await apiRequest<{ relativePath: string }>('/backup/export', {
        method: 'POST',
        body: { workspaceId: requestWorkspaceId, snapshot: requestSnapshotId },
      })
      if (workspaceIdRef.current !== requestWorkspaceId || mutationIdRef.current !== mutationId) return
      setToast(`历史文件已安全导出到 ${result.relativePath}；当前工作区文件未被覆盖。`)
      refresh()
    } catch (reason) {
      if (workspaceIdRef.current !== requestWorkspaceId || mutationIdRef.current !== mutationId) return
      setError(reason instanceof Error ? reason.message : '恢复导出失败。')
    } finally {
      if (mutationIdRef.current === mutationId) setAction(null)
    }
  }

  const loadMoreBackupFiles = async () => {
    if (workspaceId === undefined || backupSnapshotId === null || backupCheckout?.nextCursor === undefined) return
    const requestWorkspaceId = workspaceId
    const requestSnapshotId = backupSnapshotId
    const requestCursor = backupCheckout.nextCursor
    const requestId = ++backupCheckoutRequestIdRef.current
    setBackupLoading(true)
    setError(null)
    try {
      const page = await apiRequest<FileBackupCheckout>(`/backup/snapshot?workspaceId=${encodeURIComponent(requestWorkspaceId)}&snapshot=${encodeURIComponent(requestSnapshotId)}&limit=250&cursor=${encodeURIComponent(requestCursor)}`)
      if (requestId !== backupCheckoutRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
      setBackupCheckout(current => current === null || current.snapshot.id !== page.snapshot.id
        ? page
        : {
            snapshot: page.snapshot,
            records: [...current.records, ...page.records],
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
            truncated: page.truncated,
          })
    } catch (reason) {
      if (requestId !== backupCheckoutRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
      setError(reason instanceof Error ? reason.message : '无法继续加载文件快照。')
    } finally {
      if (requestId === backupCheckoutRequestIdRef.current) setBackupLoading(false)
    }
  }

  const loadMoreComparison = async () => {
    if (workspaceId === undefined || compareBaseId === null || compareHeadId === null
      || backupComparison?.nextCursor === undefined) return
    const requestWorkspaceId = workspaceId
    const requestBaseId = compareBaseId
    const requestHeadId = compareHeadId
    const requestCursor = backupComparison.nextCursor
    const requestId = ++backupCompareRequestIdRef.current
    setComparisonPaging(true)
    setError(null)
    try {
      const page = await apiRequest<FileBackupComparison>(
        `/backup/compare?workspaceId=${encodeURIComponent(requestWorkspaceId)}&base=${encodeURIComponent(requestBaseId)}&head=${encodeURIComponent(requestHeadId)}&limit=250&cursor=${encodeURIComponent(requestCursor)}`,
      )
      if (requestId !== backupCompareRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
      setBackupComparison(current => current === null
        || (current.base?.id ?? 'ROOT') !== (page.base?.id ?? 'ROOT')
        || (current.head?.id ?? 'ROOT') !== (page.head?.id ?? 'ROOT')
        ? page
        : {
            ...page,
            changes: [...current.changes, ...page.changes],
          })
    } catch (reason) {
      if (requestId !== backupCompareRequestIdRef.current || workspaceIdRef.current !== requestWorkspaceId) return
      setError(reason instanceof Error ? reason.message : '无法继续加载变化文件。')
    } finally {
      if (requestId === backupCompareRequestIdRef.current) setComparisonPaging(false)
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
    renderTopbar(
      workspaces,
      activeWorkspace,
      board,
      action !== null,
      repositoryMenuOpen,
      setRepositoryMenuOpen,
      selectWorkspace,
      () => { setRepositoryMenuOpen(false); setOpen(false) },
      refresh,
    ),
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
              : tab === 'backup'
                ? renderBackup(
                    board,
                    backupCandidates,
                    backupRootIds,
                    setBackupRootIds,
                    backupExpandedRootIds,
                    backupCandidateLoadingId,
                    loadBackupChildren,
                    backupInterval,
                    setBackupInterval,
                    backupConfirmed,
                    setBackupConfirmed,
                    backupHistory,
                    backupSnapshotId,
                    setBackupSnapshotId,
                    backupCheckout,
                    backupSelectedPath,
                    setBackupSelectedPath,
                    backupPreview,
                    backupLoading,
                    action,
                    enableBackup,
                    disableBackup,
                    captureBackup,
                    exportBackup,
                    loadMoreBackupFiles,
                  )
                : tab === 'code'
                  ? renderCode(board, selector, setSelector, selectedKey, setSelectedKey, selectedRecord, loading)
                : tab === 'history'
                  ? renderHistory(
                      board,
                      backupHistory,
                      compareBaseId,
                      setCompareBaseId,
                      compareHeadId,
                      setCompareHeadId,
                      backupComparison,
                      compareFilter,
                      setCompareFilter,
                      compareSelectedPath,
                      (value) => { setCompareSelectedPath(value); setBackupFileDiff(null) },
                      backupFileDiff,
                      comparisonLoading,
                      fileDiffLoading,
                      comparisonPaging,
                      loadMoreComparison,
                      setSelector,
                      setTab,
                      requestRollback,
                      mutationsDisabled,
                    )
                  : tab === 'issues'
                    ? renderIssues(board, sessionsById)
                    : renderDiscuss(board, activeWorkspace, sessionsById, liveAgents, mentions, setMentions, commentBody, setCommentBody, commentIssueId, setCommentIssueId, action === 'comment', sendComment, mutationsDisabled),
    ),
    toast === null ? null : createElement('div', { className: 'lg4l-toast', role: 'status' }, toast),
    createElement('footer', { className: 'lg4l-footer' },
      createElement('span', null, '手动选择仓库 · 显式知识提交 · 可选文件自动备份'),
      createElement('code', null, 'local-git-4-llm · 0.6.1-preview'),
    ),
    rollbackTarget === null ? null : renderRollbackConfirm(rollbackTarget.value, action === 'rollback', () => setRollbackTarget(null), confirmRollback),
    ) : null,
    createElement('button', {
      className: 'lg4l-fab',
      type: 'button',
      onClick: () => {
        setRepositoryMenuOpen(false)
        setOpen(value => !value)
      },
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
  menuOpen: boolean,
  setMenuOpen: (value: boolean) => void,
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
          createElement('div', {
            className: 'lg4l-repo-picker',
            onBlur: (event: ReactFocusEvent<HTMLDivElement>) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false)
            },
          },
            createElement('button', {
              className: 'lg4l-repo-select',
              type: 'button',
              disabled: workspaces.length === 0 || selectionDisabled,
              'aria-label': '选择要查看并为当前会话激活的本地仓库',
              'aria-expanded': menuOpen,
              'aria-haspopup': 'listbox',
              'aria-controls': 'lg4l-repo-menu',
              title: '手动选择要浏览和为当前会话激活的仓库',
              onClick: () => setMenuOpen(!menuOpen),
            },
            createElement('span', { className: 'lg4l-repo-select-label' }, workspace?.title || (workspaces.length > 0 ? '请选择仓库' : '未选择工作区')),
            createElement('span', { className: 'lg4l-repo-chevron', 'aria-hidden': true }, menuOpen ? '▴' : '▾'),
            ),
            !menuOpen ? null : createElement('div', { className: 'lg4l-repo-menu', id: 'lg4l-repo-menu', role: 'listbox', 'aria-label': '已注册仓库' },
              ...workspaces.map(item => {
                const id = String(item.workspaceId)
                const selected = workspace !== undefined && String(workspace.workspaceId) === id
                return createElement('button', {
                  key: id,
                  className: 'lg4l-repo-option',
                  type: 'button',
                  role: 'option',
                  'aria-selected': selected,
                  'data-selected': selected,
                  onClick: () => selectWorkspace(id),
                },
                createElement('span', { 'aria-hidden': true }, selected ? '✓' : ''),
                createElement('span', null, item.title || '未命名工作区'),
                )
              }),
            ),
          ),
          createElement('span', { className: 'lg4l-badge' }, board?.initialized ? '已初始化' : '本地'),
        ),
        createElement('div', { className: 'lg4l-subline' }, board?.initialized
          ? `手动选择 · HEAD ${shortId(board.status?.head)} · 文件备份 ${board.backup.enabled ? board.backup.runtime.running ? '扫描中' : '已启用' : '未启用'}`
          : '手动选择并浏览本地不可变知识仓库'),
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
    { id: 'code', label: '逻辑知识', count: board?.status?.knowledgeKeys },
    { id: 'backup', label: '文件备份', count: board?.backup.snapshots },
    { id: 'history', label: '提交历史', count: (board?.backup.snapshots ?? 0) > 0 ? board?.backup.snapshots : board?.status?.commits },
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

function renderBackup(
  board: BoardData,
  candidates: readonly FileBackupRootCandidate[],
  selectedRootIds: readonly string[],
  setSelectedRootIds: (value: string[]) => void,
  expandedRootIds: readonly string[],
  candidateLoadingId: string | null,
  loadChildren: (candidate: FileBackupRootCandidate) => void,
  interval: number,
  setInterval: (value: number) => void,
  confirmed: boolean,
  setConfirmed: (value: boolean) => void,
  history: readonly FileBackupSnapshotSummary[],
  snapshotId: string | null,
  setSnapshotId: (value: string) => void,
  checkout: FileBackupCheckout | null,
  selectedPath: string | null,
  setSelectedPath: (value: string) => void,
  preview: FileBackupPreview | null,
  loading: boolean,
  action: 'initialize' | 'comment' | 'rollback' | 'backup-enable' | 'backup-disable' | 'backup-capture' | 'backup-export' | null,
  enable: () => void,
  disable: () => void,
  capture: () => void,
  exportSnapshot: () => void,
  loadMore: () => void,
) {
  const backup = board.backup
  const busy = action !== null || loading
  const setup = createElement('section', { className: 'lg4l-card' },
    createElement('div', { className: 'lg4l-card-title' },
      createElement('span', null, backup.configured ? '备份范围与计划' : '开启文件自动备份'),
      createElement('code', null, '显式启用'),
    ),
    createElement('div', { className: 'lg4l-backup-form' },
      createElement('div', { className: 'lg4l-field' },
        createElement('span', null, '选择工作区文件或目录（1–16 个；可展开目录）'),
        candidates.length === 0
          ? createElement('div', { className: 'lg4l-empty', style: { minHeight: 80 } }, createElement('p', null, '没有可安全选择的工作区条目。'))
          : createElement('div', { className: 'lg4l-root-list', role: 'group', 'aria-label': '选择文件备份根' },
              ...candidates.map(candidate => {
                const selected = selectedRootIds.includes(candidate.id)
                const expanded = expandedRootIds.includes(candidate.id)
                const depth = candidate.label.split('/').length - 1
                return createElement('div', { key: candidate.id, className: 'lg4l-root-row', style: { paddingLeft: Math.min(depth, 8) * 12 } },
                  createElement('button', {
                    className: 'lg4l-mention lg4l-root-choice',
                    type: 'button',
                    disabled: busy || !selected && selectedRootIds.length >= 16,
                    'aria-pressed': selected,
                    'data-selected': selected,
                    onClick: () => {
                      if (selected) {
                        setSelectedRootIds(selectedRootIds.filter(id => id !== candidate.id))
                        return
                      }
                      const conflicts = new Set(candidates
                        .filter(other => rootsOverlap(candidate.label, other.label))
                        .map(other => other.id))
                      setSelectedRootIds([
                        ...selectedRootIds.filter(id => !conflicts.has(id)),
                        candidate.id,
                      ])
                    },
                  }, selected ? '✓ ' : '', candidate.kind === 'directory' ? '目录 ' : '文件 ', candidate.label),
                  candidate.kind !== 'directory' ? null : createElement('button', {
                    className: 'lg4l-root-expand',
                    type: 'button',
                    disabled: busy || candidateLoadingId !== null || expanded,
                    onClick: () => loadChildren(candidate),
                    'aria-label': `展开目录 ${candidate.label}`,
                  }, candidateLoadingId === candidate.id ? '加载中…' : expanded ? '已展开' : '展开'),
                )
              }),
            ),
      ),
      createElement('label', { className: 'lg4l-field' },
        createElement('span', null, '自动备份间隔（分钟，5–1440）'),
        createElement('input', {
          className: 'lg4l-input',
          type: 'number',
          min: 5,
          max: 1440,
          step: 1,
          value: interval,
          disabled: busy,
          onChange: (event: ChangeEvent<HTMLInputElement>) => setInterval(Number(event.currentTarget.value)),
        }),
      ),
      createElement('div', { className: 'lg4l-warning' },
        '备份保存在本工作区的 .dsh-repo/backup，内容未加密且不会上传。首版不允许整仓扫描；你必须明确列出相对文件或目录。系统仍会固定排除 .dsh-repo、.git、node_modules、构建缓存及常见密钥文件，也不会自动读取聊天内容。',
      ),
      createElement('label', { className: 'lg4l-check' },
        createElement('input', {
          type: 'checkbox',
          checked: confirmed,
          disabled: busy,
          onChange: (event: ChangeEvent<HTMLInputElement>) => setConfirmed(event.currentTarget.checked),
        }),
        createElement('span', null, '我确认所选文件可能包含敏感信息，并同意将其以本机未加密、内容寻址的形式保存。'),
      ),
      createElement('button', {
        className: 'lg4l-button lg4l-button-primary',
        type: 'button',
        disabled: busy || !confirmed || interval < 5 || interval > 1440 || selectedRootIds.length === 0,
        onClick: enable,
      }, action === 'backup-enable' ? '正在扫描并建立快照…' : backup.configured ? '保存配置并立即扫描' : '启用并创建初始快照'),
    ),
  )

  if (!backup.configured || backup.integrity === 'error') {
    return createElement('div', { className: 'lg4l-backup-layout' },
      setup,
      createElement('aside', { className: 'lg4l-side-stack' },
        createElement('section', { className: 'lg4l-card' },
          createElement('div', { className: 'lg4l-card-title' }, '安全边界'),
          createElement('dl', { className: 'lg4l-stat-list' },
            ...stat('默认状态', '完全关闭'),
            ...stat('对象校验', 'SHA-256'),
            ...stat('单文件上限', '64 MiB'),
            ...stat('单快照上限', '512 MiB'),
            ...stat('恢复方式', '安全导出副本'),
          ),
        ),
        backup.runtime.lastError === undefined ? null : createElement('section', { className: 'lg4l-card' },
          createElement('div', { className: 'lg4l-card-title' }, '最近错误'),
          createElement('div', { className: 'lg4l-warning' }, backup.runtime.lastError),
        ),
      ),
    )
  }

  const records = checkout?.records ?? []
  return createElement('div', { className: 'lg4l-backup-layout' },
    createElement('div', null,
      createElement('div', { className: 'lg4l-toolbar' },
        createElement('div', { className: 'lg4l-toolbar-left' },
          createElement('label', null,
            createElement('span', { style: visuallyHidden }, '选择文件快照'),
            createElement('select', {
              className: 'lg4l-select',
              value: snapshotId ?? '',
              disabled: history.length === 0 || busy,
              onChange: (event: ChangeEvent<HTMLSelectElement>) => setSnapshotId(event.currentTarget.value),
            },
            history.length === 0 ? createElement('option', { value: '' }, '尚无文件快照') : null,
            ...history.map(snapshot => createElement('option', { key: snapshot.id, value: snapshot.id },
              `${formatDate(snapshot.capturedAt)} · ${backupReasonLabel(snapshot.reason)} · ${snapshot.fileCount} 个文件`,
            )),
            ),
          ),
        ),
        createElement('div', { className: 'lg4l-toolbar-right' },
          createElement('button', { className: 'lg4l-button', type: 'button', disabled: busy || !backup.enabled, onClick: capture }, action === 'backup-capture' ? '备份中…' : '立即备份'),
          createElement('button', { className: 'lg4l-button', type: 'button', disabled: busy || snapshotId === null, onClick: exportSnapshot }, action === 'backup-export' ? '导出中…' : '导出恢复副本'),
        ),
      ),
      createElement('section', { className: 'lg4l-card' },
        createElement('div', { className: 'lg4l-card-title' },
          createElement('span', null, checkout === null ? '文件快照' : `${formatDate(checkout.snapshot.capturedAt)} 的文件`),
          createElement('code', null, shortId(checkout?.snapshot.id)),
        ),
        loading && checkout === null
          ? createElement('div', { className: 'lg4l-loading', style: { minHeight: 150 } }, createElement('span', { className: 'lg4l-spinner' }), '正在验证文件快照…')
          : records.length === 0
            ? createElement('div', { className: 'lg4l-empty', style: { minHeight: 150 } }, createElement('strong', null, '此快照没有可显示文件'))
            : createElement('div', { className: 'lg4l-file-list lg4l-backup-files' },
                ...records.map(record => createElement('button', {
                  key: record.path,
                  type: 'button',
                  className: 'lg4l-file-row',
                  'data-selected': selectedPath === record.path,
                  onClick: () => setSelectedPath(record.path),
                },
                createElement('span', { className: 'lg4l-file-name' }, record.path),
                createElement('span', { className: 'lg4l-file-preview' }, `${formatBytes(record.size)} · ${formatDate(new Date(record.mtimeMs).toISOString())}`),
                createElement('span', { className: 'lg4l-file-hash' }, shortId(record.blob)),
                )),
              ),
      ),
      preview === null ? null : createElement('section', { className: 'lg4l-card lg4l-backup-preview' },
        createElement('div', { className: 'lg4l-card-title' },
          createElement('span', null, preview.path),
          createElement('code', null, `${formatBytes(preview.size)} · ${shortId(preview.blob)}`),
        ),
        preview.encoding === 'utf8'
          ? createElement('pre', null, preview.content)
          : createElement('div', { className: 'lg4l-empty', style: { minHeight: 100 } },
              createElement('strong', null, preview.encoding === 'binary' ? '二进制文件' : '文件过大'),
              createElement('p', null, preview.encoding === 'binary' ? '内容已完整备份并通过哈希校验，但面板不直接渲染二进制字节。' : '超过 64 KiB 的文件不在面板中预览，可通过恢复导出取得完整内容。'),
            ),
      ),
      checkout?.truncated ? createElement('div', { className: 'lg4l-backup-actions', style: { marginTop: 10 } },
        createElement('button', { className: 'lg4l-button', type: 'button', disabled: loading, onClick: loadMore }, loading ? '加载中…' : `继续加载（已显示 ${records.length} 个）`),
      ) : null,
    ),
    createElement('aside', { className: 'lg4l-side-stack' },
      createElement('section', { className: 'lg4l-card' },
        createElement('div', { className: 'lg4l-card-title' }, '自动备份状态'),
        createElement('dl', { className: 'lg4l-stat-list' },
          createElement('dt', null, '状态'), createElement('dd', null,
            createElement('span', { className: 'lg4l-status-dot', 'data-active': backup.enabled, 'aria-hidden': true }),
            backup.runtime.running ? '正在扫描' : backup.enabled ? '已启用' : '已关闭',
          ),
          ...stat('快照', backup.snapshots),
          ...stat('范围', backup.config?.scope.kind === 'workspace' ? '整个工作区' : `${backup.config?.scope.roots.length ?? 0} 个根`),
          ...stat('间隔', `${backup.config?.intervalMinutes ?? '—'} 分钟`),
          ...stat('下次扫描', backup.nextCaptureAt ? formatDate(backup.nextCaptureAt) : '等待初始快照'),
          ...stat('最新快照', shortId(backup.latest?.id)),
          ...stat('最新大小', backup.latest ? formatBytes(backup.latest.totalBytes) : '—'),
          ...stat('安全排除', backup.latest?.ignoredFiles ?? 0),
        ),
        createElement('div', { className: 'lg4l-backup-actions', style: { padding: '0 12px 12px' } },
          backup.enabled ? createElement('button', { className: 'lg4l-button lg4l-button-danger', type: 'button', disabled: busy, onClick: disable }, action === 'backup-disable' ? '关闭中…' : '关闭自动备份') : null,
        ),
      ),
      backup.runtime.lastError === undefined ? null : createElement('section', { className: 'lg4l-card' },
        createElement('div', { className: 'lg4l-card-title' }, '最近自动备份错误'),
        createElement('div', { className: 'lg4l-warning' }, backup.runtime.lastError),
      ),
      setup,
    ),
  )
}

function renderHistory(
  board: BoardData,
  snapshots: readonly FileBackupSnapshotSummary[],
  baseId: string | null,
  setBaseId: (value: string) => void,
  headId: string | null,
  setHeadId: (value: string) => void,
  comparison: FileBackupComparison | null,
  filter: string,
  setFilter: (value: string) => void,
  selectedPath: string | null,
  setSelectedPath: (value: string) => void,
  fileDiff: FileBackupFileDiff | null,
  comparisonLoading: boolean,
  fileDiffLoading: boolean,
  comparisonPaging: boolean,
  loadMoreComparison: () => void,
  setSelector: (value: string) => void,
  setTab: (value: TabId) => void,
  requestRollback: (value: RollbackValue) => void,
  mutationsDisabled: boolean,
) {
  const commits = board.log ?? []
  const normalizedFilter = filter.trim().toLocaleLowerCase()
  const visibleChanges = comparison === null || normalizedFilter === ''
    ? comparison?.changes ?? []
    : comparison.changes.filter(change => change.path.toLocaleLowerCase().includes(normalizedFilter))
  const totalChanges = comparison === null
    ? 0
    : comparison.counts.added + comparison.counts.modified + comparison.counts.deleted
  return createElement('div', null,
    createElement('div', { className: 'lg4l-toolbar' },
      createElement('div', { className: 'lg4l-toolbar-left' }, createElement('strong', null, '文件版本审阅')),
      createElement('div', { className: 'lg4l-toolbar-right' },
        createElement('span', { className: 'lg4l-badge' }, '只显示变化文件 · 内容寻址增量存储'),
      ),
    ),
    snapshots.length === 0
      ? createElement('div', { className: 'lg4l-empty lg4l-review-empty' },
          createElement('strong', null, '还没有可比较的文件版本'),
          createElement('p', null, '启用文件备份并产生第一份有效快照后，这里会默认比较 ROOT 与最新版本。内容完全相同的定时检查不会创建空版本。'),
        )
      : createElement('section', { className: 'lg4l-review', 'aria-busy': comparisonLoading },
          createElement('div', { className: 'lg4l-compare-bar' },
            renderVersionPicker('基准版本', baseId, [
              { id: 'ROOT', label: 'ROOT · 空文件集' },
              ...snapshots.filter(snapshot => snapshot.id !== headId).map(snapshot => ({ id: snapshot.id, label: snapshotLabel(snapshot) })),
            ], setBaseId),
            createElement('span', { className: 'lg4l-compare-arrow', 'aria-hidden': true }, '→'),
            renderVersionPicker('目标版本', headId, snapshots.map(snapshot => ({ id: snapshot.id, label: snapshotLabel(snapshot) })), setHeadId),
            comparison === null ? null : createElement('div', { className: 'lg4l-diff-counts' },
              createElement('span', { 'data-kind': 'added' }, `+${comparison.counts.added}`),
              createElement('span', { 'data-kind': 'modified' }, `~${comparison.counts.modified}`),
              createElement('span', { 'data-kind': 'deleted' }, `−${comparison.counts.deleted}`),
            ),
          ),
          comparison === null
            ? renderLoading()
            : comparison.changes.length === 0
              ? createElement('div', { className: 'lg4l-empty lg4l-review-empty' },
                  createElement('strong', null, '这两个版本没有文件差异'),
                  createElement('p', null, '新版本已采用语义去重：只有 mtime 等元数据变化时不会发布快照，也不会占用一条历史记录。'),
                )
              : createElement('div', { className: 'lg4l-review-grid' },
                  createElement('aside', { className: 'lg4l-changed-files', 'aria-label': '变化文件' },
                    createElement('div', { className: 'lg4l-changed-files-head' },
                      createElement('strong', null, normalizedFilter === '' ? `${totalChanges} 个变化文件` : `${visibleChanges.length} / ${totalChanges} 个文件`),
                      comparison.truncated ? createElement('button', {
                        className: 'lg4l-root-expand',
                        type: 'button',
                        disabled: comparisonPaging,
                        onClick: loadMoreComparison,
                      }, comparisonPaging ? '加载中…' : '加载更多') : null,
                    ),
                    createElement('label', { className: 'lg4l-file-filter' },
                      createElement('span', { 'aria-hidden': true }, '⌕'),
                      createElement('input', {
                        type: 'search',
                        value: filter,
                        placeholder: '筛选变化文件…',
                        'aria-label': '筛选变化文件',
                        onChange: (event: ChangeEvent<HTMLInputElement>) => setFilter(event.currentTarget.value),
                      }),
                    ),
                    visibleChanges.length === 0
                      ? createElement('div', { className: 'lg4l-filter-empty' }, '当前筛选没有匹配文件。')
                      : null,
                    ...visibleChanges.map(change => createElement('button', {
                      className: 'lg4l-changed-file',
                      type: 'button',
                      key: change.path,
                      'data-selected': selectedPath === change.path,
                      'aria-pressed': selectedPath === change.path,
                      title: change.path,
                      onClick: () => setSelectedPath(change.path),
                    },
                    createElement('span', { className: 'lg4l-change-kind', 'data-kind': change.kind }, changeKindMark(change.kind)),
                    renderChangedPath(change.path),
                    )),
                  ),
                  createElement('section', { className: 'lg4l-diff-panel', 'aria-live': 'polite' },
                    fileDiffLoading ? renderLoading() : renderFileDiff(fileDiff),
                  ),
                ),
        ),
    createElement('details', { className: 'lg4l-logical-history' },
      createElement('summary', null,
        createElement('strong', null, `逻辑知识提交（${commits.length}）`),
        createElement('span', null, '回退会追加新提交，不截断历史'),
      ),
      createElement('section', { className: 'lg4l-history' },
        commits.length === 0 ? createElement('div', { className: 'lg4l-empty', style: { minHeight: 140 } }, createElement('strong', null, '还没有逻辑提交')) : null,
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
    ),
  )
}

function renderVersionPicker(
  label: string,
  value: string | null,
  options: readonly { id: string; label: string }[],
  onChange: (value: string) => void,
) {
  const selected = options.find(option => option.id === value)
  return createElement('details', { className: 'lg4l-version-picker' },
    createElement('summary', null,
      createElement('span', null, label),
      createElement('strong', null, selected?.label ?? '选择版本'),
    ),
    createElement('div', { className: 'lg4l-version-menu', role: 'listbox', 'aria-label': label },
      ...options.map(option => createElement('button', {
        type: 'button',
        role: 'option',
        key: option.id,
        'aria-selected': option.id === value,
        onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
          const details = event.currentTarget.closest('details')
          const summary = details?.querySelector<HTMLElement>('summary')
          details?.removeAttribute('open')
          onChange(option.id)
          summary?.focus()
        },
      },
      createElement('span', null, option.id === value ? '✓' : ''),
      createElement('span', null, option.label),
      )),
    ),
  )
}

function renderChangedPath(path: string) {
  const separator = path.lastIndexOf('/')
  const directory = separator < 0 ? '' : path.slice(0, separator + 1)
  const name = separator < 0 ? path : path.slice(separator + 1)
  return createElement('span', { className: 'lg4l-changed-path' },
    directory === '' ? null : createElement('span', { className: 'lg4l-changed-directory' }, directory),
    createElement('strong', { className: 'lg4l-changed-name' }, name),
  )
}

function renderFileDiff(diff: FileBackupFileDiff | null) {
  if (diff === null) return createElement('div', { className: 'lg4l-empty lg4l-review-empty' }, createElement('strong', null, '选择一个变化文件'))
  return createElement('div', null,
    createElement('header', { className: 'lg4l-diff-head' },
      createElement('div', null,
        createElement('span', { className: 'lg4l-change-kind', 'data-kind': diff.kind }, changeKindMark(diff.kind)),
        createElement('strong', null, diff.path),
      ),
      createElement('span', null, fileDiffSummary(diff)),
    ),
    diff.display === 'binary'
      ? renderDiffNotice('二进制文件已变化', '为了安全和可读性，此处不渲染二进制内容；仍可从对应快照导出恢复副本。')
      : diff.display === 'too-large'
        ? renderDiffNotice('文本文件超过 64 KiB 预览上限', '版本已正常备份并去重，但面板不加载大文件正文。')
        : diff.display === 'metadata-only'
          ? renderDiffNotice('文件内容未变化', '仅文件权限模式发生变化，因此没有正文行差异。')
          : createElement('div', { className: 'lg4l-diff-table' },
              ...diff.lines.map((line, index) => line.kind === 'separator'
                ? createElement('div', { className: 'lg4l-diff-separator', key: `separator-${index}` }, '@@ … @@')
                : createElement('div', { className: 'lg4l-diff-line', 'data-kind': line.kind, key: `${index}-${line.beforeLine ?? ''}-${line.afterLine ?? ''}` },
                    createElement('span', { className: 'lg4l-line-number' }, line.beforeLine ?? ''),
                    createElement('span', { className: 'lg4l-line-number' }, line.afterLine ?? ''),
                    createElement('span', { className: 'lg4l-line-mark' }, line.kind === 'added' ? '+' : line.kind === 'deleted' ? '−' : ' '),
                    createElement('code', null, line.content ?? '', line.lineBreak === false ? createElement('span', { className: 'lg4l-no-lf' }, '  ⟵ 无行尾 LF') : null),
                  )),
              diff.truncated ? createElement('div', { className: 'lg4l-diff-truncated' }, '差异过长，仅显示前 2,000 行。') : null,
            ),
  )
}

function renderDiffNotice(title: string, body: string) {
  return createElement('div', { className: 'lg4l-empty lg4l-diff-notice' }, createElement('strong', null, title), createElement('p', null, body))
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

function backupReasonLabel(reason: FileBackupSnapshotSummary['reason']): string {
  switch (reason) {
    case 'initial': return '初始'
    case 'scheduled': return '自动'
    case 'manual': return '手动'
    case 'pre-restore': return '恢复前保护'
  }
}

function snapshotLabel(snapshot: FileBackupSnapshotSummary): string {
  return `${formatDate(snapshot.capturedAt)} · ${backupReasonLabel(snapshot.reason)} · ${shortId(snapshot.id)}`
}

function changeKindMark(kind: FileBackupChange['kind']): string {
  switch (kind) {
    case 'added': return 'A'
    case 'modified': return 'M'
    case 'deleted': return 'D'
  }
}

function fileDiffSummary(diff: FileBackupFileDiff): string {
  const before = diff.before === undefined ? '∅' : `${formatBytes(diff.before.size)} · ${diff.before.mode.toString(8).padStart(3, '0')}`
  const after = diff.after === undefined ? '∅' : `${formatBytes(diff.after.size)} · ${diff.after.mode.toString(8).padStart(3, '0')}`
  return `${before} → ${after}`
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GiB`
}

function rootsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
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
