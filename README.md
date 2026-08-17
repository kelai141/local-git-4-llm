# local-git-4-llm

`local-git-4-llm` is a DSH-native, workspace-scoped knowledge repository for
collaboration across conversations. It is designed around GitHub-like concepts:
append-only commits, issues, a repository board, audit history, backups, and
safe restore operations.

> **Current phase: M1a — read-only journal engine and tools.**
> The injected package owns a disposable host lifecycle, an additive
> `shell.overlay` status FAB, and six read-only `repo_*` tools. It never creates
> `.dsh-repo/`, extracts session content, repairs data, or sends messages
> between sessions.

## Product direction

The complete design is maintained in
[`local-git-4-llm-方案与汇报.md`](./local-git-4-llm-方案与汇报.md).

| Milestone | Deliverable |
| --- | --- |
| M0 | Hybrid package scaffold, host/client injection, overlay mounting, build and unload checks |
| M1a | Checksum-validated journal reader, immutable commit/tree replay, bounded explicit `key/value` queries, and read-only issue projections |
| M1b | Explicit repository initialization, key/value and issue writes, backups, rollback, and existing-workspace adoption |
| M2 | Workspace-aware tool/prompt relay and deduplicated notifications to managed-workspace sessions |
| M3 | GitHub-inspired issue, commit, status, and recovery board using native DSH theme tokens |
| M4 | Concurrency, recovery, rollback and release hardening |

## M1a architecture

```text
src/
  core/canonical.ts      deterministic JSON and SHA-256 addressing
  core/repository.ts     strict read-only manifest/journal reader and replay
  core/types.ts          repository, tree, commit, issue, and DTO types
  core/manifest.ts       immutable package facts
  relay/lifecycle.ts     host lifecycle owned by the Cordis fiber
  tools/read-only.ts     current-workspace repo_status/log/diff/pull/issue readers
  client/index.ts        additive shell.overlay FAB and status card
  index.ts               host entry point
```

The client surface uses `shell.overlay` with a fresh slot id and the official
Harness `FishLogo`. Its foreground, surface, border, and focus styles use only
`--dsw-alias-*` theme tokens, so its whale icon is dark in light mode and light
in dark mode. It never replaces DSH's root, conversation, or sidebar UI.

### M1a repository boundary

M1a reads only an already-existing repository at the calling session's
registered workspace:

```text
<registered workspace>/
  .dsh-repo/
    manifest.json      canonical repository identity, including workspaceId
    journal.jsonl      LF-delimited canonical JSON event log
```

`manifest.json` must bind to the current DSH `workspaceId`. The reader rejects
symlinks/junctions (and verifies the opened file identity before reading),
non-canonical JSON, bad UTF-8, broken sequence/previous-checksum links,
unsupported events, invalid commit/tree hashes, oversized journals, and
truncated tails. It reports the problem as structured tool data; it never
attempts to repair or truncate data in M1a. `repo_log` exposes a public commit
summary only, never the persistence-level author session/message identifiers.

Available tools derive the workspace solely from the calling session, not from
a model-supplied path: `repo_status`, `repo_log`, `repo_diff`, `repo_pull`,
`repo_issue_list`, and `repo_issue_get`.

## Development

The package uses peer dependencies from the running DSH installation. Install
only its local build tools, then use the injector pipeline:

```bash
npm install --legacy-peer-deps --ignore-scripts
# In a DSH session with dsh-super-injector:
dev_build_plugin {"dir":"D:/coding/local-git-4-llm"}
dev_inject_plugin {"dir":"D:/coding/local-git-4-llm"}
npm run typecheck
npm run test:m1a
```

`scripts/build.sh` links the installed DSH runtime declarations into the
ignored local `node_modules/` directory before compiling host TypeScript. When
the injector reaches Bash through WSL on Windows, it uses `node.exe` to create
Windows junctions, so `dev_build_plugin` and native `npm run typecheck` share
the same declarations. Set `DSH_RUNTIME_NODE_MODULES` only when the runtime
cannot be found via `npm root -g`.

## Safety defaults agreed for later milestones

- Adoption remains explicit; M1a creates no workspace repository data.
- Knowledge writes will receive explicit `key/value` changes in M1b rather
  than automatically extracting conversation history.
- Rollback will preserve backups and audit records. The active DSH policy is
  full access (`never`), so it will not add a separate approval prompt.
- M2 notifications will target every known session in the same managed
  workspace, with deduplication, concise summaries, and cooldown controls.

## License

[MIT](./LICENSE) © 2026 kelai141.
