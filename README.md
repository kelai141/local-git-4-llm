# local-git-4-llm

`local-git-4-llm` is a DSH-native, workspace-scoped repository for durable
LLM collaboration and explicitly enabled local file backup. It combines an
append-only logical knowledge history with immutable, content-addressed
physical file snapshots—without silently scanning a workspace merely because
the plugin is installed.

> **Current phase: 0.6.0 / M4 backup preview.**
> The hybrid package provides `/setrepo`, repository activation from the
> Chinese management panel, explicit initialization and key/value commits,
> immutable checkout and audited rollback, Issues/comments/agent relay, plus
> opt-in scheduled file snapshots with history browsing, preview, and
> export-only recovery.

## What the panel can do

The additive `shell.overlay` panel covers the complete normal workflow:

- select a registered repository and activate it for the current live session;
- initialize its logical `.dsh-repo` repository explicitly;
- browse logical keys, commit history, Issues, and discussion;
- roll back logical history by appending an audited restore commit;
- choose 1–16 safe files/directories through an expandable workspace picker;
- choose a 5–1440 minute schedule, acknowledge the local plaintext risk, and
  enable/disable automatic backup;
- create a snapshot immediately;
- browse every snapshot and page through its file list;
- preview bounded UTF-8 text while treating binary/large files safely;
- export any historical snapshot to a new recovery directory without
  overwriting the current workspace.

`/setrepo` is a keyboard-friendly companion, not a requirement for using the
feature.

## `/setrepo`

The human command is registered as `setrepo` (entered with the DSH `/` prefix):

```text
/setrepo
/setrepo <序号|workspaceId|精确标题>
/setrepo current
/setrepo reset
/setrepo backup status
/setrepo backup now
/setrepo backup off
/setrepo backup on <相对路径1,相对路径2> --confirm [--interval=15]
```

Selection is recorded as a durable session event. All `repo_*` tools first use
that explicit selection, revalidate it through `workspaceRegistry`, and
otherwise fall back to the calling session's registered `cwd`. The command uses
`recordInput: false`; the authoritative selection/configuration event is stored
separately. Selection chooses a target; it is not workspace membership. Agent
Issue/comment tools still require the calling session to belong to the selected
workspace, preventing a foreign session from being recorded as a member author.

## Two independent histories

Logical LLM knowledge and physical files deliberately do not share one journal:

```text
<registered workspace>/
  .dsh-repo/
    manifest.json                 logical repository identity
    journal.jsonl                 logical commits/issues/comments/audit
    backup/
      journal.jsonl               file-backup config/snapshot/export audit
      objects/sha256/ab/cdef...   raw blobs and canonical JSON objects
      .staging/                    private unpublished work
      exports/export_<uuid>/      recovery copies; never source overwrite
```

Both histories are append-only and checksum-verified. Backup blobs, manifests,
configs, and snapshots use SHA-256 content IDs, so unchanged content is reused.
If a new scan produces the same manifest as the latest snapshot, no duplicate
snapshot event is appended.

## File backup behavior

File backup is **off by default**. Opening the backup tab may list safe entry
names, and directories expand only after a human action; file contents are not read until
the user confirms and enables backup. The scheduler tracks only repositories
with a backup marker; it does not replay every registered repository once per
minute.

The first preview intentionally does not offer “scan the entire workspace.” A
human must choose bounded roots. The panel sends opaque root IDs—not arbitrary
source paths—to the management API. `/setrepo backup on` accepts bounded
workspace-relative roots because it is itself a direct human command.

Fixed exclusions include repository metadata and common generated or sensitive
locations such as:

- `.dsh-repo`, `.git`, `.hg`, `.svn`;
- `node_modules`, `dist`, `build`, `coverage`, caches and virtual environments;
- `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`;
- `.env`/`.env.*`, package registry credentials, common SSH key names,
  credential/secret filenames, and key/certificate extensions.

These exclusions reduce accidents; they are not a universal secret detector.
Snapshots are local and unencrypted, so the panel/command requires explicit
risk confirmation. Nothing is uploaded remotely.

### Consistency and limits

The Node-only implementation performs deterministic sorted traversal,
realpath containment checks, rejects symlinks/junctions/special files, verifies
opened file identity, and compares a second source observation before
publishing. This is best-effort **per-file validation on a cooperative local
filesystem**, not a VSS/ZFS snapshot, a global atomic snapshot, or protection
against a malicious process racing filesystem replacements.

Current fail-closed limits:

- 64 MiB per file;
- 512 MiB and 10,000 files per snapshot;
- 100 published snapshots;
- 2 GiB object-store budget with a conservative one-snapshot reserve;
- 16 explicit roots and depth 32;
- no automatic pruning or guessed stale-lock deletion.

## Restore model

Logical rollback appends a new restore commit and preserves the previous HEAD.
Physical restore v1 is safer and simpler: it materializes a new directory under
`.dsh-repo/backup/exports/`. It never writes over source files. Once an export
is published, a later audit-verification failure does not delete those
user-visible recovery bytes; the operation reports the uncertain audit state.

## Architecture

```text
src/
  core/canonical.ts            deterministic JSON and SHA-256 addressing
  core/repository.ts           strict logical manifest/journal reader
  core/initializer.ts          explicit staged repository initialization
  core/writer.ts               logical commits/issues/comments/rollback
  core/backup.ts               physical snapshot objects, journal, export
  core/workspace-selection.ts  durable /setrepo and shared resolver
  commands/setrepo.ts          human repository/backup command
  relay/backups.ts             enabled-only reconciliation scheduler
  relay/comments.ts            persist-first comment relay/outbox
  api/admin.ts                 capability-gated panel API; stable IDs/tokens
  tools/*.ts                   repo_* model tools
  client/index.ts              Chinese GitHub-inspired management panel
```

The panel uses a fresh additive `shell.overlay` slot ID. Colors use official
DSH theme aliases, and the layout remains usable on narrow screens. It does not
replace DSH root, conversation, or sidebar surfaces.

## Model tools

Available tools:

`repo_init`, `repo_commit`, `repo_checkout`, `repo_rollback`, `repo_status`,
`repo_log`, `repo_diff`, `repo_pull`, `repo_issue_list`, `repo_issue_get`,
`repo_collaborators`, `repo_comment`, `repo_issue_open`, and
`repo_issue_comment`.

The model cannot enable physical file backup or supply source paths through
these tools. Backup activation remains a direct human panel/command action.
Conversation content is never automatically extracted into either history.

## Development

The package uses peer dependencies from the running DSH installation:

```bash
npm install --legacy-peer-deps --ignore-scripts
npm run typecheck
npm run test:repository

# In a DSH session with dsh-super-injector:
dev_build_plugin {"dir":"D:/coding/local-git-4-llm"}
dev_reload_package {"packageName":"local-git-4-llm"}
```

`scripts/build.sh` links runtime declarations, compiles the Host, and the
injector also runs the client `tsdown` build. WSL may print a harmless
localhost/NAT diagnostic on Windows before a successful host compilation.

## Safety summary

- Installation/reload does not initialize a repository or scan source files.
- Repository initialization, logical mutation, backup activation, snapshot
  export, and rollback are explicit and auditable.
- The management API resolves stable workspace/session IDs and opaque backup
  root tokens; it never accepts an absolute workspace path.
- Writer and capture locks fail closed. Stale locks are preserved for manual
  diagnosis rather than guessed away.
- No remote upload, automatic pruning, in-place physical restore, corruption
  repair, or conversation harvesting is performed.

The longer design/progress record is in
[`local-git-4-llm-方案与汇报.md`](./local-git-4-llm-方案与汇报.md).

## License

[MIT](./LICENSE) © 2026 kelai141.
