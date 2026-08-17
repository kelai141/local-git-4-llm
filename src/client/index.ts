/**
 * M1b-init browser entry.
 *
 * The shell overlay is intentionally additive: it proves that the package's
 * client half mounts without replacing any shipped DSH surface. The M1b-init
 * card reports the explicit-initialization boundary; M3 will replace it with a
 * repository board.
 */
import { createElement, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'

const PLUGIN_ID = '@dsh-external/local-git-4-llm'
const STYLE_ID = 'local-git-4-llm-style'

const CSS = `
.local-git-4-llm-overlay{position:fixed;right:20px;bottom:20px;z-index:30;display:grid;justify-items:end;gap:10px;pointer-events:none;color:var(--dsw-alias-label-primary)}
.local-git-4-llm-fab{display:grid;place-items:center;width:48px;height:48px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 12px 30px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);cursor:pointer;pointer-events:auto}
.local-git-4-llm-fab:hover{background:var(--dsw-alias-bg-layer-2)}
.local-git-4-llm-fab:focus-visible{outline:3px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 42%,transparent);outline-offset:3px}
.local-git-4-llm-panel{width:min(380px,calc(100vw - 32px));box-sizing:border-box;pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-overlay);box-shadow:0 20px 50px color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);overflow:hidden}
.local-git-4-llm-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 16px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.local-git-4-llm-title{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:700}.local-git-4-llm-mark{display:grid;place-items:center;width:24px;height:24px;color:var(--dsw-alias-label-primary)}
.local-git-4-llm-close{border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:18px;line-height:1;cursor:pointer;padding:3px 6px}.local-git-4-llm-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.local-git-4-llm-body{display:grid;gap:13px;padding:15px 16px 17px}.local-git-4-llm-kicker{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}.local-git-4-llm-status{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-state-success-primary);font-size:12px;font-weight:650}.local-git-4-llm-dot{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 16%,transparent)}
.local-git-4-llm-roadmap{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.local-git-4-llm-roadmap div{min-height:54px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.local-git-4-llm-roadmap strong{display:block;font-size:11px}.local-git-4-llm-roadmap span{display:block;margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1.35}
.local-git-4-llm-footer{padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
@media(max-width:600px){.local-git-4-llm-overlay{right:12px;bottom:12px}.local-git-4-llm-panel{width:min(360px,calc(100vw - 24px))}}
`

function installStyles(): () => void {
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return () => {}

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = PLUGIN_ID
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}

function RoadmapCell(title: string, detail: string) {
  return createElement('div', null,
    createElement('strong', null, title),
    createElement('span', null, detail),
  )
}

function LocalGitFab() {
  const [open, setOpen] = useState(false)
  const toggle = () => setOpen((current) => !current)

  return createElement('div', { className: 'local-git-4-llm-overlay' },
    open ? createElement('aside', {
      className: 'local-git-4-llm-panel',
      'aria-label': 'local-git-4-llm 状态面板',
    },
    createElement('header', { className: 'local-git-4-llm-header' },
      createElement('div', { className: 'local-git-4-llm-title' },
        createElement('span', { className: 'local-git-4-llm-mark' },
          createElement(FishLogo, { size: 24 }),
        ),
        createElement('span', null, 'local-git-4-llm'),
      ),
      createElement('button', {
        className: 'local-git-4-llm-close',
        type: 'button',
        onClick: toggle,
        'aria-label': '关闭 local-git-4-llm 状态面板',
      }, '×'),
    ),
    createElement('div', { className: 'local-git-4-llm-body' },
      createElement('div', { className: 'local-git-4-llm-status' },
        createElement('span', { className: 'local-git-4-llm-dot', 'aria-hidden': true }),
        createElement('span', null, 'M1b 初始化能力已就绪'),
      ),
      createElement('p', { className: 'local-git-4-llm-kicker' },
        '当前会话可读取已初始化的工作区日志；现在可通过 repo_init 显式创建仓库。不会自动建仓、提取会话内容或跨会话推送。',
      ),
      createElement('div', { className: 'local-git-4-llm-roadmap' },
        RoadmapCell('读取', '校验和日志与只读工具'),
        RoadmapCell('初始化', 'M1b 显式 repo_init'),
        RoadmapCell('同步', 'M2 跨会话协作'),
        RoadmapCell('看板', 'M3 GitHub 风格面板'),
      ),
    ),
    createElement('footer', { className: 'local-git-4-llm-footer' }, 'local-git-4-llm · 0.3.0 · MIT'),
    ) : null,
    createElement('button', {
      className: 'local-git-4-llm-fab',
      type: 'button',
      onClick: toggle,
      'aria-expanded': open,
      'aria-label': open ? '关闭 local-git-4-llm' : '打开 local-git-4-llm',
      title: 'local-git-4-llm M1b',
    }, createElement(FishLogo, { size: 27 })),
  )
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'local-git-4-llm:m1b-init-styles')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'local-git-4-llm-fab',
    order: 40,
    label: 'local-git-4-llm',
  }, LocalGitFab))
}
