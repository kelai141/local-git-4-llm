# local-git-4-llm

`local-git-4-llm` is a DSH-native, workspace-scoped knowledge repository for
collaboration across conversations. It is designed around GitHub-like concepts:
append-only commits, issues, a repository board, audit history, backups, and
safe restore operations.

> **Current phase: M1b-init — explicit repository initialization.**
> The injected package owns a disposable host lifecycle, an additive
> `shell.overlay` status FAB, one explicit `repo_init` tool, and six read-only
> `repo_*` tools. It never initializes automatically, extracts session content,
> repairs data, overwrites an existing repository, or sends messages between
> sessions.

## Product direction

The complete design is maintained in
[`local-git-4-llm-方案与汇报.md`](./local-git-4-llm-方案与汇报.md).

| Milestone | Deliverable |
| --- | --- |
| M0 | Hybrid package scaffold, host/client injection, overlay mounting, build and unload checks |
| M1a | Checksum-validated journal reader, immutable commit/tree replay, bounded explicit `key/value` queries, and read-only issue projections |
| M1b-init | Explicit idempotent `repo_init` with same-workspace staging and reader verification |
| M1b | Explicit key/value and issue writes, backups, rollback, and existing-workspace adoption |
| M2 | Workspace-aware tool/prompt relay and deduplicated notifications to managed-workspace sessions |
| M3 | GitHub-inspired issue, commit, status, and recovery board using native DSH theme tokens |
| M4 | Concurrency, recovery, rollback and release hardening |

## M1 architecture

```text
src/
  core/canonical.ts      deterministic JSON and SHA-256 addressing
  core/repository.ts     strict read-only manifest/journal reader and replay
  core/initializer.ts    explicit, staged, non-overwriting repository initialization
  core/types.ts          repository, tree, commit, issue, and DTO types
  core/manifest.ts       immutable package facts
  relay/lifecycle.ts     host lifecycle owned by the Cordis fiber
  tools/initialize.ts    current-workspace explicit repo_init tool
  tools/read-only.ts     current-workspace repo_status/log/diff/pull/issue readers
  client/index.ts        additive shell.overlay FAB and status card
  index.ts               host entry point
```

The client surface uses `shell.overlay` with a fresh slot id and the official
Harness `FishLogo`. Its foreground, surface, border, and focus styles use only
`--dsw-alias-*` theme tokens, so its whale icon is dark in light mode and light
in dark mode. The visible panel and tool descriptions are localized in Chinese.
It never replaces DSH's root, conversation, or sidebar UI.

### M1a reader / M1b-init boundary

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

All tools derive the workspace solely from the calling session, not from a
model-supplied path. `repo_init` is the only M1b write: it creates a complete
canonical seed repository in a unique sibling staging directory, syncs the two
files, and publishes it without deleting or adopting an existing destination.
The result is verified through the M1a reader before success is returned. A
valid existing repository returns idempotently with `initialized: false`; an
invalid, foreign, symlinked, or junctioned destination is left untouched.

Available tools: `repo_init`, `repo_status`, `repo_log`, `repo_diff`,
`repo_pull`, `repo_issue_list`, and `repo_issue_get`.

## Development

The package uses peer dependencies from the running DSH installation. Install
only its local build tools, then use the injector pipeline:

```bash
npm install --legacy-peer-deps --ignore-scripts
# In a DSH session with dsh-super-injector:
dev_build_plugin {"dir":"D:/coding/local-git-4-llm"}
dev_inject_plugin {"dir":"D:/coding/local-git-4-llm"}
npm run typecheck
npm run test:repository
```

`scripts/build.sh` links the installed DSH runtime declarations into the
ignored local `node_modules/` directory before compiling host TypeScript. When
the injector reaches Bash through WSL on Windows, it uses `node.exe` to create
Windows junctions, so `dev_build_plugin` and native `npm run typecheck` share
the same declarations. Set `DSH_RUNTIME_NODE_MODULES` only when the runtime
cannot be found via `npm root -g`.

## Safety defaults agreed for later milestones

- Adoption remains explicit. M1b-init creates repository data only after an
  explicit `repo_init` call for the current registered workspace.
- Knowledge writes will receive explicit `key/value` changes in M1b rather
  than automatically extracting conversation history.
- Rollback will preserve backups and audit records. The active DSH policy is
  full access (`never`), so it will not add a separate approval prompt.
- M2 notifications will target every known session in the same managed
  workspace, with deduplication, concise summaries, and cooldown controls.

## License

[MIT](./LICENSE) © 2026 kelai141.
