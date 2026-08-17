# local-git-4-llm

`local-git-4-llm` is a DSH-native, workspace-scoped knowledge repository for
collaboration across conversations. It is designed around GitHub-like concepts:
append-only commits, issues, a repository board, audit history, backups, and
safe restore operations.

> **Current phase: M0 — package and UI mounting validation.**
> The injected package currently owns a disposable host lifecycle and an
> additive `shell.overlay` status FAB. It does **not** read session content,
> create `.dsh-repo/` directories, register repository tools, or push messages
> between sessions yet.

## Product direction

The complete design is maintained in
[`local-git-4-llm-方案与汇报.md`](./local-git-4-llm-方案与汇报.md).

| Milestone | Deliverable |
| --- | --- |
| M0 | Hybrid package scaffold, host/client injection, overlay mounting, build and unload checks |
| M1 | Append-only journal, immutable commits, explicit `key/value` knowledge records, issues and backups |
| M2 | Workspace-aware tool/prompt relay and deduplicated notifications to managed-workspace sessions |
| M3 | GitHub-inspired issue, commit, status, and recovery board using native DSH theme tokens |
| M4 | Concurrency, recovery, rollback and release hardening |

## M0 architecture

```text
src/
  core/manifest.ts       immutable package facts
  relay/lifecycle.ts     host lifecycle owned by the Cordis fiber
  client/index.ts        additive shell.overlay FAB and status card
  index.ts               host entry point
```

The client surface uses `shell.overlay` with a fresh slot id and the official
`--dsw-alias-*` theme tokens. It never replaces DSH's root, conversation, or
sidebar UI.

## Development

The package uses peer dependencies from the running DSH installation. Install
only its local build tools, then use the injector pipeline:

```bash
npm install --legacy-peer-deps --ignore-scripts
# In a DSH session with dsh-super-injector:
dev_build_plugin {"dir":"D:/coding/local-git-4-llm"}
dev_inject_plugin {"dir":"D:/coding/local-git-4-llm"}
```

`scripts/build.sh` links the installed DSH runtime declarations into the
ignored local `node_modules/` directory before compiling host TypeScript. When
the injector reaches Bash through WSL on Windows, it uses `node.exe` to create
Windows junctions, so `dev_build_plugin` and native `npm run typecheck` share
the same declarations. Set `DSH_RUNTIME_NODE_MODULES` only when the runtime
cannot be found via `npm root -g`.

## Safety defaults agreed for later milestones

- Adoption remains explicit; M0 creates no workspace repository data.
- Knowledge commits will receive explicit `key/value` changes rather than
  automatically extracting conversation history.
- Rollback will preserve backups and audit records. The active DSH policy is
  full access (`never`), so it will not add a separate approval prompt.
- M2 notifications will target every known session in the same managed
  workspace, with deduplication, concise summaries, and cooldown controls.

## License

[MIT](./LICENSE) © 2026 kelai141.
