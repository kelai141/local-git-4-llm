# local-git-4-llm

`local-git-4-llm` is a DSH-native, workspace-scoped knowledge repository for
collaboration across conversations. It is designed around GitHub-like concepts:
append-only commits, issues, a repository board, audit history, backups, and
safe restore operations.

> **Current phase: 0.5.0 / M3 preview.**
> The injected hybrid package now provides explicit initialization and
> key/value commits, immutable historical checkout, append-only audited
> rollback, administrator/agent comments, agent-authored Issues, live
> `@智能体` relay with a durable delivery outbox, and a Chinese GitHub-inspired
> repository board with manual repository selection in `shell.overlay`. It
> still never initializes automatically, scans source files, extracts session content,
> repairs unknown corruption, or accepts a model/UI supplied filesystem path.

## Product direction

The complete design is maintained in
[`local-git-4-llm-方案与汇报.md`](./local-git-4-llm-方案与汇报.md).

| Milestone | Deliverable |
| --- | --- |
| M0 | Hybrid package scaffold, host/client injection, overlay mounting, build and unload checks |
| M1a | Checksum-validated journal reader, immutable commit/tree replay, bounded explicit `key/value` queries, and read-only issue projections |
| M1b-init | Explicit idempotent `repo_init` with same-workspace staging and reader verification |
| M1b | Explicit bounded key/value writes, complete immutable tree snapshots, writer locking, historical checkout, append-only rollback, and agent-authored issue opening (implemented); adoption remains |
| M2 | Persisted admin/agent comments, issue-scoped discussion, durable delivery requests, and immediate relay to explicitly mentioned live agents (preview); offline retry remains |
| M3 | Chinese GitHub-inspired code/history/issues/discussion board with theme tokens, manual repository selection, and rollback controls (preview) |
| M4 | Concurrency, recovery, rollback and release hardening |

## Current architecture

```text
src/
  core/canonical.ts      deterministic JSON and SHA-256 addressing
  core/repository.ts     strict read-only manifest/journal reader and replay
  core/initializer.ts    explicit, staged, non-overwriting repository initialization
  core/writer.ts         exclusive writer lock, commit/issue/comment append, verification, rollback
  core/types.ts          repository, tree, commit, issue, and DTO types
  core/manifest.ts       immutable package facts
  api/admin.ts           capability-gated same-origin board API; workspace ids only
  relay/comments.ts      persist-first admin/agent comment outbox and live relay
  relay/lifecycle.ts     host lifecycle owned by the Cordis fiber
  tools/initialize.ts    current-workspace explicit repo_init tool
  tools/commit.ts        explicit bounded key/value repo_commit tool
  tools/rollback.ts      append-only audited repo_rollback tool
  tools/read-only.ts     current-workspace repo_status/log/diff/pull/issue readers
  tools/discussion.ts    repo_collaborators/comment/issue_open/issue_comment tools
  client/index.ts        additive GitHub-inspired repository management board
  index.ts               host entry point
```

The client surface uses `shell.overlay` with a fresh slot id and the official
Harness `FishLogo`. Its foreground, surfaces, borders, state colors, and focus
styles use DSH theme aliases, so the board follows light/dark theme changes.
The responsive panel exposes Chinese tabs for logical code snapshots, commit
history, issues, and administrator/agent comments. A repository selector lists
registered workspaces and remembers the user's explicit choice; changing it
does not synchronize or copy repository contents. It never replaces DSH's root,
conversation, or sidebar UI.

### Repository boundary

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

All model tools derive the workspace solely from the calling session. The
management API accepts only a stable `workspaceId` and resolves it through
`workspaceRegistry`; it never accepts a path. `repo_init` creates a complete
canonical seed repository in a unique sibling staging directory, syncs the two
files, and publishes it without deleting or adopting an existing destination.
A valid existing repository returns idempotently; an invalid, foreign,
symlinked, or junctioned destination is left untouched.

`repo_commit` applies at most 250 explicit `set`/`delete` mutations to bounded
logical keys, writes a complete sorted tree snapshot, content-addresses the
tree and commit, and appends one canonical journal record under an exclusive
`write.lock`. The writer replays and verifies the result after fsync. It does
not scan the workspace or read conversation messages. `repo_checkout` reads an
immutable snapshot by `HEAD`, `ROOT`, or full SHA-256 id.

Rollback is deliberately not a history rewrite. `repo_rollback` and the board
button append a `kind: rollback` commit whose `restores` field names the target
snapshot. The prior HEAD and its full tree remain in the journal as the backup,
so rollback itself is reversible and auditable. The UI requires an explicit
confirmation but does not insert an additional DSH approval prompt.

Administrator and agent comments are persisted as checksum-linked journal
events. They may target the repository timeline or one existing Issue. Agents
explicitly create Issues with `repo_issue_open`, discover valid mention targets
with `repo_collaborators`, and discuss through `repo_comment` or
`repo_issue_comment`; no conversation text is harvested automatically. The
board may use the same explicit `@` mechanism. Before any live relay, every
explicit mention target is recorded in `comment.delivery.requested`;
successful delivery is then audited with `comment.delivered`. Targets receive a `form: relay` user
message through `agent.steer`, so the context enters the closest next step
while normal tool permissions remain in force. Offline or failed targets remain
visibly unconfirmed; automatic retry after resume is not implemented yet.

Available tools: `repo_init`, `repo_commit`, `repo_checkout`, `repo_rollback`,
`repo_status`, `repo_log`, `repo_diff`, `repo_pull`, `repo_issue_list`,
`repo_issue_get`, `repo_collaborators`, `repo_comment`, `repo_issue_open`, and
`repo_issue_comment`.

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

## Safety defaults

- Adoption remains explicit. M1b-init creates repository data only after an
  explicit `repo_init` call for the current registered workspace.
- Knowledge writes receive only explicit `key/value` changes; automatic source
  scanning and conversation extraction remain out of scope.
- Rollback preserves the old HEAD as its immutable backup and records the
  restored commit id in the new audit commit.
- The board API uses a per-run same-origin capability and JSON-only writes.
  Comment mentions and rollback targets are resolved inside one registered
  workspace.
- Agent discussion tools bind the recorded author to the calling session and
  reject calls when that session is not a member of the workspace resolved by
  `workspaceRegistry.resolveByPath()`.
- The panel changes repositories only after manual selection (with a current or
  remembered repository used solely as the initial default); it does not add an
  automatic repository synchronization path.
- Writer locks fail closed. A stale lock is not guessed away automatically;
  crash recovery and lock self-heal remain M4 work.
- Offline mention retry/reconciliation, deduplication, and cooldown controls
  remain the next M2 increment.

## License

[MIT](./LICENSE) © 2026 kelai141.
