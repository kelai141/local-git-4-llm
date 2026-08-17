/**
 * M0 browser entry.
 *
 * The shell overlay is intentionally additive: it proves that the package's
 * client half mounts without replacing any shipped DSH surface. Future M3
 * work replaces this status card with the repository board.
 */
import { createElement, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

const PLUGIN_ID = '@dsh-external/dsh-repo-suite'
const STYLE_ID = 'dsh-repo-suite-m0-style'

const CSS = `
.drs-overlay{position:fixed;right:20px;bottom:20px;z-index:30;display:grid;justify-items:end;gap:10px;pointer-events:none;color:var(--dsw-alias-label-primary)}
.drs-fab{width:46px;height:46px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);box-shadow:0 12px 30px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);font:700 20px/1 ui-monospace,SFMono-Regular,Consolas,monospace;cursor:pointer;pointer-events:auto}
.drs-fab:focus-visible{outline:3px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 42%,transparent);outline-offset:3px}
.drs-panel{width:min(380px,calc(100vw - 32px));box-sizing:border-box;pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-overlay);box-shadow:0 20px 50px color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);overflow:hidden}
.drs-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 16px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.drs-title{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:700}.drs-mark{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-size:13px}
.drs-close{border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:18px;line-height:1;cursor:pointer;padding:3px 6px}.drs-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.drs-body{display:grid;gap:13px;padding:15px 16px 17px}.drs-kicker{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}.drs-status{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-state-success-primary);font-size:12px;font-weight:650}.drs-dot{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 16%,transparent)}
.drs-roadmap{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.drs-roadmap div{min-height:54px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.drs-roadmap strong{display:block;font-size:11px}.drs-roadmap span{display:block;margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1.35}
.drs-footer{padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
@media(max-width:600px){.drs-overlay{right:12px;bottom:12px}.drs-panel{width:min(360px,calc(100vw - 24px))}}
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

function RepoFab() {
  const [open, setOpen] = useState(false)
  const toggle = () => setOpen((current) => !current)

  return createElement('div', { className: 'drs-overlay' },
    open ? createElement('aside', {
      className: 'drs-panel',
      'aria-label': 'Repository Suite status',
    },
    createElement('header', { className: 'drs-header' },
      createElement('div', { className: 'drs-title' },
        createElement('span', { className: 'drs-mark', 'aria-hidden': true }, '◆'),
        createElement('span', null, 'Repository Suite'),
      ),
      createElement('button', {
        className: 'drs-close',
        type: 'button',
        onClick: toggle,
        'aria-label': 'Close Repository Suite status',
      }, '×'),
    ),
    createElement('div', { className: 'drs-body' },
      createElement('div', { className: 'drs-status' },
        createElement('span', { className: 'drs-dot', 'aria-hidden': true }),
        createElement('span', null, 'M0 client overlay mounted'),
      ),
      createElement('p', { className: 'drs-kicker' },
        'GitHub-style knowledge-repository workspace. The M0 package validates the host/client lifecycle only; it does not yet read sessions or write repository data.',
      ),
      createElement('div', { className: 'drs-roadmap' },
        RoadmapCell('Journal', 'M1 append-only history'),
        RoadmapCell('Issues', 'M1 tracked knowledge work'),
        RoadmapCell('Relay', 'M2 cross-session sync'),
        RoadmapCell('Board', 'M3 GitHub-like dashboard'),
      ),
    ),
    createElement('footer', { className: 'drs-footer' }, 'dsh-repo-suite · 0.1.0 · MIT'),
    ) : null,
    createElement('button', {
      className: 'drs-fab',
      type: 'button',
      onClick: toggle,
      'aria-expanded': open,
      'aria-label': open ? 'Close Repository Suite' : 'Open Repository Suite',
      title: 'Repository Suite M0',
    }, '◆'),
  )
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-repo-suite:m0-styles')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-repo-suite-fab',
    order: 40,
    label: 'Repository Suite',
  }, RepoFab))
}
