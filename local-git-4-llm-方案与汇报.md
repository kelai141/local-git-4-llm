# DSH 工作区知识仓库插件（local-git-4-llm）

## 方案设计与汇报文档（v1）

> 用途：本文件既是对需求的完整应答（方案），也是本阶段工作汇报（汇报）。
> 状态：`M1a IMPLEMENTED` — hybrid 包已构建、注入并完成 host/client 装配验证；M1a 的主题自适应 Harness 鲸鱼入口、只读 journal 重放引擎和首批 `repo_*` 工具均已验证。下一步为 M1b 的显式写入与采纳流程。

---

## 0. 汇报摘要（一页速览）

针对「AI 不同对话之间像 GitHub 一样协作」的需求，本方案设计**一套同名 hybrid 插件 + 一个提示词桥**的插件体系：

| 包名 | 形态 | 职责 |
|---|---|---|
| `@dsh-external/local-git-4-llm` | hybrid 插件 | 每工作区独立知识仓库引擎、会话同步 relay、原生 WebUI 看板及全部 `repo_*` 工具 |
| `local-git-4-llm/bridge` | agent preset 提示词段 | 告诉每个对话「本工作区有知识仓库，先 pull 再 commit」 |

**关键落点（全部已用 Inspect 验证）：**

- 悬浮球 → 官方 `shell.overlay` Slot（frame 级浮动层，`replaceRisk: none`）
- 工具注册 → host `ctx.tools.register`（JSON Schema，与 `vision_*` 同款）
- 轨迹可见 → 工具调用天然写入 `session.jsonl`（`ui-trajectory` 视图直接可见）；另有事件溯源 `journal.jsonl`（校验和行）保证可重放
- 每工作区独立管理器 → 数据存工作区内 `.dsh-repo/`，控制面注册表在 `~/.dsh/managers/<workspaceId>/`；**`workspaceId` 为唯一权威键**（解析优先级见 §4.9 pt5）
- **同步链路（§4.3）** → `/repo init` 命令建库 → 扫描到库自动注入工具（agent scope）与信息（prompt 桥每 step 求值）→ LLM 自主查询 → 变更经 `agent.send` **插话在线对话** / **预注入离线会话**（inbox 持久化，开始即同步）
- 跨会话引用 → Issue 携带 `sessionId + messageId`，可经 `sessionQuery` 回溯原文
- **现有工作区适配** → 按需采纳（`adopt.auto` 默认 false，建仓仅由显式 `/repo init` 或 `repo_adopt` 触发；M1a 的只读 `repo_*` 调用绝不建仓）；prompt 桥对**任意**会话下一 step 注入提示（已纳仓=仓库认知，未纳仓=一行可 adopt 提示，`adopt.promptHint` 默认 true）；不可写目录（如 System32）降级到 `~/.dsh/managers/<workspaceId>` 外部存储；数据定位用 workspaceId 而非 path 哈希（§4.9）
- 美术风格 → 全部用官方主题 token `--dsw-alias-*`（`bg-layer-1/label-primary/brand-primary/state-error-primary` 等，light/dark 自适应）

**里程碑进度：** M0 hybrid 骨架接入注入器（完成）→ M1a 纯引擎 + 只读工具（完成）→ M1b 写工具 + 现有工作区适配（下一步）→ M2 relay 同步 → M3 UI 看板 → M4 加固/演练/文档。每阶段都有可验证的轨迹验收点（见 §9）。

**首要设计决策：** 知识仓库 = **追加式事件溯源日志**（journal）+ **不可变 commit 链**；回滚 = **生成 revert commit**，永不删历史；自动备份 = **提交后 + 定时 + 回滚前**三时机，写后读回校验 hash。这保证「出问题可追溯」不是口号而是数据结构。

---

## 0.1 M0 实施记录（2026-08-17）

### 已交付

- 命名已统一：GitHub 仓库、插件包、运行时 ID、Slot/CSS ID、UI 标题、文档文件名和构建产物全部使用 `local-git-4-llm`；旧标识已退役。
- Git 根已初始化为 `local-git-4-llm`，远端为 `https://github.com/kelai141/local-git-4-llm.git`，根目录补齐 `MIT` 许可证、README、包元数据与锁文件。
- 已由 `dev_scaffold_plugin` 生成并收敛为单一 hybrid 包：`@dsh-external/local-git-4-llm@0.1.0`。
- 目录职责已落位：`src/core/manifest.ts`（不可变 M0 事实）、`src/relay/lifecycle.ts`（由 Cordis fiber 持有的 host 生命周期）、`src/client/index.ts`（`shell.overlay` 悬浮入口）和 host 入口 `src/index.ts`。
- M0 host **不**注册工具、定时器、提示词、文件写入、会话读取或 inbox 推送；它只记录并随 fiber 卸载的生命周期。这样不会提前污染任意工作区。
- M0 client 以独立 `id=local-git-4-llm-fab` 注册到 `shell.overlay`，使用已验证的 `--dsw-alias-*` token。FAB 打开后展示 GitHub 风格的 local-git-4-llm 状态卡与 M1–M3 路线，不替换 root、conversation 或 sidebar。

### 构建兼容性修正

本机的 `C:\Users\17765\dsh-harness` checkout 存在源码但没有 `node_modules`，原注入器样板“从 checkout 取 `tsc`”无法闭环。项目的 `scripts/build.sh` 已改为：本地 devDependencies 提供 TypeScript/tsdown，运行时 DSH 声明从 `npm root -g` 下的 `@deepseek-ai/dsh/node_modules` 链接到被忽略的本地 `node_modules/`。当注入器经 WSL Bash 启动时，脚本显式使用 `node.exe` 创建 Windows junction，因而 `dev_build_plugin` 和原生 Windows `npm run typecheck` 共用同一套声明。无需改动 DSH checkout，仍可由标准 `dev_build_plugin` 完成 host 编译、client bundle 与 `npm pack`。

本地依赖安装命令为：

```bash
npm install --legacy-peer-deps --ignore-scripts
```

`--legacy-peer-deps` 是必要的：DSH 的内部 peer 包不在公开 npm registry，不能由普通 `npm install` 自动解析；运行时链接仍由构建脚本完成。

### 验收结果

| 检查 | 结果 |
|---|---|
| `dev_build_plugin` | 通过：host `tsc`、client `tsdown`、`dsh-external-local-git-4-llm-0.1.0.tgz` 均生成 |
| `npm run typecheck` | 通过：Windows 原生 TypeScript 无报错 |
| `dev_inject_plugin` | 通过：host ✓，client ✓（`lib/client.js`） |
| 本包热重载 | 通过：清缓存 1 模块、重建 1 active fiber、client ✓ |
| 本包卸载→重注入 | 通过：entry、junction、client 模块表清理后重新 host/client ✓ |
| `dev_self_test` | 通过：注入器回归 **8/8 PASS** |
| 实际浏览器 Slot | 通过：隔离 headless DSH 页面检测到 `.local-git-4-llm-fab` 与 M0 stylesheet；点击后 `.local-git-4-llm-panel` 成功渲染 |

> M0 的可见 UI 与当前正在使用的浏览器页是否即时刷新无关：运行时新注册的 client module 在新页面加载时已实测 mount 成功。M0 不将截图或浏览器测试资料纳入仓库。

### 后续已知验证点

- M1a 已定义 manifest、canonical journal、inline tree 与 immutable commit 的精确 JSON schema；读取仅处理显式 `key/value`，不会自动提取历史会话内容。
- M2 之前需对实际 `Agent` 类型的 send/inbox 投递契约做源码级验证。当前公共服务目录仅直接保证 live-agent 查询和 inbox 事件观察，不能把文中 `agent.send` 写死为已证实事实。

---

## 0.2 M1a 实施记录（2026-08-17）

### 已交付

- 包版本提升至 `@dsh-external/local-git-4-llm@0.2.0`，M1a host 注册 `repo_status`、`repo_log`、`repo_diff`、`repo_pull`、`repo_issue_list` 与 `repo_issue_get`。
- 工具只从 `exec.agent?.session.header.cwd` 推导当前会话工作区，再经 `workspaceRegistry.resolveByPath()` 取得 canonical workspace；不接受模型传入的路径，也不扫描所有工作区。
- 只识别工作区内显式存在的 `.dsh-repo/manifest.json` 与 `journal.jsonl`。manifest 固化 `workspaceId`，与当前注册工作区不匹配时 fail closed。
- journal 强制 UTF-8、单个 LF 结尾、逐行 canonical JSON、连续 `seq`、`prev` checksum 链和 `sha256:` checksum；commit/tree 内联于 journal，因此重放不信任任何派生 refs 或 objects 文件。
- key 为受限逻辑标识，value 为 lossless JSON；tree 与 commit 都以 canonical JSON 计算不可变 SHA-256 ID。`repo_pull` 有记录数与总字节上限、cursor，`repo_diff` 默认只返回 value hash。
- `repo_log` 只投影 commit id、parent、tree、message、kind 与时间；journal 内部的 author session/message 标识不出现在模型工具结果中。
- M1a 只读取和报告健康状态：不自动初始化、不采用工作区、不建立 lock、不截断尾行、不自愈、不写 backup；这些写入能力全部保留给 M1b/M4。
- 悬浮入口复用官方 `FishLogo`；其前景/表面/hover/focus 仅使用 `--dsw-alias-*` token，浅色主题呈深色鲸鱼、深色主题呈浅色鲸鱼。

### 验收结果

| 检查 | 结果 |
|---|---|
| `dev_build_plugin` | 通过：host `tsc`、client `tsdown`、`dsh-external-local-git-4-llm-0.2.0.tgz` 均生成 |
| `npm run typecheck` | 通过：Windows 原生 TypeScript 无报错 |
| `npm run test:m1a` | 通过：8/8，覆盖重放、key/value、issue projection、无仓不落盘、取消信号、首条初始化约束、workspaceId 与 junction 边界、checksum/截断尾/重复 key 检测 |
| 本包热重载 | 通过：host/client active；6 个 `repo_*` 工具已出现在 live Tool registry |
| live `repo_status` smoke | 通过：当前未初始化工作区返回结构化 `REPO_NOT_INITIALIZED`，未创建任何仓库文件 |
| 实际浏览器 Slot | 通过：隔离 headless 页面检测到官方鲸鱼 SVG、主题 token CSS 和 M1a 面板 |

---

## 1. 背景与目标

### 1.1 需求原文拆解

| 编号 | 需求 | 对应设计 |
|---|---|---|
| R1 | 不同对话之间像 GitHub 一样**互相标记 issue** | §4.1：issue 全生命周期工具 + 跨会话 @ 引用 + 看板列流 |
| R2 | 提交 **commit** | §4.2：Git 风格 commit 链（parent/tree hash/message/author session） |
| R3 | **同步对仓库的认识** | §4.3：`/repo init` 建库 → 扫描自动注入（工具 agent-scope + prompt 桥）→ pull/merge（key 级三方合并）→ 变更插话/预注入（`agent.send` inbox）；冲突自动转 issue |
| R4 | 支持**自动备份** | §4.4：三时机备份 + zstd 压缩 + hash 校验 + 保留策略 |
| R5 | 原生 WebUI **悬浮球**，打开即**跟踪看板**，完全遵循 DSW 美术风格 | §4.5：`shell.overlay` + `--dsw-alias-*` tokens |
| R6 | 看板可**分析跟踪仓库情况、执行回滚** | §4.5/§4.6：状态分析端点 + 回滚向导（先备份→diff 预览→revert commit） |
| R7 | 插件行为在 **DSH 轨迹日志可见**，且有 **tool 注册** | §4.7：全部操作注册为工具 + journal + 工具卡片 + telemetry |
| R8 | **每个工作区都有自己的完整管理器**，出问题**可追溯** | §4.8：Manager 实例隔离 + 事件溯源 + 审计 + 自愈 |

### 1.2 目标

- 一套**原生**插件（非外部脚本）：host 逻辑 + 浏览器 UI 都在 DSH Cordis 体系内，注入器一键装配。
- 零破坏：只做**加法**（新 Slot 注册、新工具、新目录），不 replace 官方 UI。
- 可观测：任何管理动作 = 一条工具调用（轨迹）+ 一行 journal + 一条审计，三处互链。
- 可恢复：任意时刻可从最近备份/任意 commit 恢复到一致状态，且恢复动作本身留痕。

---

## 2. 环境勘察结论（本机地面事实，2026-08-16 实测）

| 项 | 事实 |
|---|---|
| DSH_HOME | `C:\Users\17765\.dsh` |
| 会话/工作区目录 | `~/.dsh/sessions/<工作区编码>/<sessionId>/session.jsonl.zstd`（`--D-dsh-deafult--` 即目录 D:\dsh-deafult） |
| 插件装配 | 注入器通道：`~/.dsh/profiles/web/`；混合插件样板 = `@dsh-external/dsh-vision-toolkit`（host `lib/` + client `src/client/index.tsx` + `cordis.patch.yml` insert + package.json `dsh.bundle.patch`/`dsh.client.inject`） |
| 悬浮球挂点 | `shell.overlay`（list，root scope，`replaceRisk: none`，frame 级浮动层）✓ |
| 会话内入口 | `conversation.session.header.actions` / `conversation.session.header.utilities`（list slots）、`conversation.input.dock`、`settings.section`、`tool.call.toolview`（keyed 工具卡片）✓ |
| 工具注册 | host `ctx.tools.register({ name, description, schema, execute, presentCall })`，`tools/change` 事件广播 ✓（vision-toolkit `lib/tools.js` 实证） |
| 浏览器 RPC | host `ctx.inject(['webServer'], …)` → `webServer.register({ kind: 'exact'\|'prefix', path, handler })` 同源 JSON 端点（vision-toolkit `/_dsh/vision-toolkit/settings` 实证）✓ |
| 轨迹日志 | 所有工具调用由 agent 循环写入会话 JSONL，`ui-trajectory` 提供视图；另有 `session/event`（post-commit feed）、`sessionPersistence.append`、`sessionTelemetry.emit`（受 sharing 开关约束）✓ |
| 跨工作区注册 | `workspaceRegistry`（list/resolveByPath）；`storageDomain`（域存储，`domain/changed` 事件）✓ |
| 跨会话检索 | `sessionQuery`（searchEvents/traceSession/readEvent）+ `sessionReferenceResolver`（prepare 不可变消息上下文）✓ |
| 主题 token | `--dsw-alias-bg-base/layer-1/layer-2/overlay`、`--dsw-alias-border-l1/l2`、`--dsw-alias-brand-primary`、`--dsw-alias-label-primary/secondary`、`--dsw-alias-state-error-primary/success-primary/warn-primary`、`--dsw-specific-sidebar-fill`（需 light/dark 双值）✓ |
| 注入器能力 | `dev_scaffold_plugin`（toolkit/daemon-loop/ui-panel/hybrid 四形态）→ `dev_build_plugin` → `dev_inject_plugin`；热重载/自重载/卸载即净；`dev_self_test` 回归 ✓ |
| 现有可借鉴生态 | `dsh-vision-toolkit`（客户端 Slot + 工具 + 设置页全样板）、`dsh-super-injector`（注入器自身）、`dsh-router-standard`（agent preset + probe 测试模式）、官方 `ui-trajectory` |

---

## 3. 总体架构

### 3.1 概念模型：每工作区一个知识仓库

```
┌─────────────────────────── 工作区（如 D:\dsh-deafult）───────────────────────────┐
│                                                                                 │
│  .dsh-repo/                     ←── 仓库本体（随工作区即插即走）                  │
│    HEAD                         当前分支指针（sha256）                            │
│    refs/heads/main              main 分支 → 最新 commit hash                       │
│    journal.jsonl              ★ 事件溯源日志：每一行一条操作（校验和）——真相源   │
│    tree/                        当前快照（key → 内容，哈希寻址对象存储）            │
│    issues/                      issue 存储（含跨会话引用）                         │
│    backups/                     snapshot-<ts>-<hash>.json.zst + manifest           │
│    audit.log                    人类可读审计（每操作一行，链到 journal 行号）      │
│    README.md                    仓库入口说明（写给 AI 读的）                       │
│    locks/                       .manager.lock（写锁）                              │
│                                                                                 │
│  ~/.dsh/managers/<workspaceId>/  ←── 控制面注册表（含 settings、孤儿恢复）      │
│    registry.json / settings.json                                                 │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**核心不变量：**

1. **journal 是唯一真相源**：任何变更先写 journal（校验和行，临时文件 + rename 防撕裂），再派生 tree/refs/audit。启动时重放 journal 重建内存态并校验 tree hash。
2. **commit 不可变**：`commit = { id, parent, tree, author {sessionId, messageId, title}, message, ts, backupRef?, kind }`；id = sha256(serialize)。
3. **回滚即新 commit**：`kind: 'revert'`，携带 `reverts` 指针与前/后 tree 摘要，绝无删除操作。
4. **一把写锁**：进程内互斥 + `.manager.lock` 文件锁（跨进程安全），journal 行内含操作序号，冲突可自动检测。
5. **每条操作三处可溯**：工具调用（会话轨迹）⇄ journal 行 ⇄ audit.log，互链字段为 `toolCallId`/`sessionId`/`seq`。

### 3.2 单包 vs 多包（评审 P6 修订：先单包，三包为演进选项）

**决策：M0 先做单 hybrid 包 `local-git-4-llm`**，内部按模块目录组织（`src/core/`、`src/relay/`、`src/client/`），一次 scaffold、一次构建、一次注入，跑通端到端。对单用户本地工具，UI 与引擎解耦的收益（独立热重载）有限，而三份 scaffold/构建/peerDeps 矩阵明显增加工时。

**三包一桥作为演进选项**（出现实际需求再拆：UI 更新频繁需与引擎独立热重载、或需单独禁用 relay）：

| 演进包 | peerDeps 关键依赖 | 说明 |
|---|---|---|
| `local-git-4-llm/core` | `dsh-tools`、`dsh-storage-domain`、`dsh-settings`、`dsh-session-title`、`dsh-session-query`、`dsh-host-webserver`、cordis | hybrid 包内纯 host 模块；不依赖 client |
| `local-git-4-llm/relay` | core + `dsh-agent`、`dsh-system-prompt`、`dsh-commands`、`@deepseek-ai/cordis-plugin-timer`（`ctx.interval(cb, delay)` mixin）、`dsh-settings` | hybrid 包内 host relay：`/repo` 命令、agent-scope 工具注入、`agent.send` 推送器、`ctx.inject(['webServer'])` 模式 |
| `local-git-4-llm/ui` | `dsh-client-runtime`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-tool`、`dsh-client-locale`、react | hybrid 包内 client 模块：`dsh.client.inject` 列表如 vision-toolkit |
| `repo-bridge` | 无 | agent preset：一段提示词 + 可选 skill，让会话知道何时 pull/commit |

### 3.3 每工作区独立管理器（R8）

- **Manager 生命周期**：`workspaceRegistry.list()` 启动时枚举 → 每个工作区懒加载一个 `RepoManager` 实例（`repoManagers: Map<WorkspaceId, RepoManager>`），状态 = journal 重放结果。
- **隔离**：各 Manager 有自己的 journal/tree/issues/backups/audit/锁；互不串写。
- **Registry 归属**：核心注册表挂在 host 组合（共享、跨会话）——由 `local-git-4-llm/core` 以 Session 级模块提供 `repo` 服务；`repoManagers` 表本身即「每个工作区都有自己的管理器」的运行时体现。
- **孤儿恢复**：工作区被删除/迁移后，`~/.dsh/managers/<workspaceId>/` 保留控制面记录，可重新挂接或归档。
- **自愈**（启动 + 手动 `repo_selfheal`）：journal 尾部损坏 → 截断到最后一个校验和通过的行，记 `repair` 事件并开一条 issue 告警；备份 hash 不匹配 → 标记 `degraded` 并尝试上一个备份。

---

## 4. 功能设计（按需求逐项）

### 4.1 R1 — GitHub 式 issue（跨对话互相标记）

**Issue 模型：**

```
issue = {
  id, title, body,
  status: 'open' | 'assigned' | 'in_progress' | 'resolved' | 'closed',
  labels: string[],
  author: { sessionId, messageId, title },
  assignee?: { sessionId, title },          // @ 谁
  refs: [{ sessionId, messageId }],         // 引用哪些对话里的原文（可追溯）
  timeline: [{ ts, type, by, text }],       // comment / state_change / mention
  createdAt, updatedAt,
}
```

**工具：**（全部注册到 `tools`，即 R7）

| 工具 | 动作 |
|---|---|
| `repo_issue_open` | 开 issue；`refs` 可引用其他会话（`sessionId+messageId`），`assignee` 可 @ 指定会话 |
| `repo_issue_comment` | 评论（timeline 追加；若含 `@sessionId` → 触发 relay 通知） |
| `repo_issue_transition` | 改状态（open→assigned→in_progress→resolved→closed）+ 原因 |
| `repo_issue_list` | 按状态/label/assignee/关键词筛选（看板数据源） |
| `repo_issue_get` | 单条详情 + timeline + 回溯链接 |

**GitHub 语义对位**：issue = GitHub Issue；refs/assignee = Mentions & Assignees；timeline = Activity；status 列流 = Kanban 列（§4.5）。
**通知**：relay 监听自身 journal（或 `domain/changed`），当目标会话在线时在悬浮球徽标 + 其会话 header 工具位提示「新增提及」；离线则仅在仓库内留痕，会话 `repo_pull` 时带回（P2 可选：向在线 agent inbox 注入轻量提示，需 `agents`/inbox API，默认关闭）。

### 4.2 R2 — commit / 分支 / 历史

**工具：**

| 工具 | 动作 |
|---|---|
| `repo_commit` | 提交当前会话的认知变更：输入 `message` + 变更的 knowledge keys（或自动 diff 会话内产生的知识文件）；产出 commit hash |
| `repo_status` | 当前 HEAD、工作区分支、未提交变更、与远端（备份基线）差异概览 |
| `repo_log` | commit 历史（author session、message、时间、tree 摘要、`--oneline`/`--graph` 视角） |
| `repo_diff` | 两个 commit/版本之间的 key 级差异（供看板与回滚预览复用） |
| `repo_branch` |（P1）按会话建 topic 分支，`repo_merge` 合并回 main —— v1 先单 main + 自动 merge |

**v1 简化的提交语义**：所有会话提交到 `main`，采用**乐观锁 + 自动三方合并**：若提交时 `HEAD` 已被推进（`parent` 不符），引擎先按 key 做三方合并（base=共同祖先，ours=本地，theirs=最新），无冲突自动生成 merge commit；有冲突 → 冲突部分标记为 issue（指派给双方会话），不阻塞其他 key 提交。这与 GitHub 的「冲突提 PR」在语义上对齐，只是自动化了。

### 4.3 R3 — 对仓库认识的同步（主动推送链路，2026-08-16 修订）

**设计目标对齐用户想法**：`/指令` 建库 → 扫描到库自动注入工具与信息 → LLM 自主查询 → PR/commit 自动插话正在进行的对话 → 未开始的对话先预注入、开始即同步。全链路机制已实测（`commands.register`、`tools.register` agent-scope、`agent.send` inbox、`systemPrompt.section` 函数求值）。

1. **建库：`/repo init` 命令（人工首选入口）**
   - `commands.register({ name: 'repo', description, handler })`：handler 直接对接收 agent 执行（**不走模型**）——从 `invocation.agent.session` 的 cwd 解析工作区 → 可写性探测 → 写 `.dsh-repo/manifest.json` → 初始 commit `repo:init` → 写 README 桥文件 → 返回 CommandResult。
- 结果卡片经 `conversation.chat.commandview`（key=`repo`，官方 slot 空位）渲染；`/repo status`、`/repo log`、`/repo rollback <commit>` 走同一注册器（回滚 handler 内部复用备份与 revert 流程）。
   - 等价入口并存：`repo_adopt` 工具（AI 自主建库）、看板 UI「纳入管理」。三者共享同一 adopt 内核，幂等。

2. **扫描自动注入（工具 + 信息，建库后自动生效）**
   - relay 监听 `session/created`（+`agent/session-start`）→ 解析会话所属工作区状态（workspaceId 权威定位，§4.9 pt5）。
   - **工具按 agent scope 注入**：`tools.register` 支持「全局或调用方 agent 作用域注册，scoped tools shadow 全局」（官方 d.ts 实证）——已纳仓工作区的会话 → 自动获得完整 `repo_*` 工具集；未纳仓 → 仅 `repo_adopt`/`repo_status` 两个引导工具；忽略名单 → 无。agent ctx 注册随 dispose 自动回收。
   - **信息注入**：`systemPrompt.section` 函数型 text **每次装配 step 时求值**（官方实证）：已纳仓 → 一行仓库认知 + 未读更新摘要（新 PR/commit/issue 提及计数）；未纳仓 → 一行「可 `/repo init` 或 `repo_adopt`」提示（不建仓，§4.9 pt3 两档提示的机制来源）。

3. **LLM 自主查询**：只读工具群 `repo_pull`（最新 tree + 未读 issue + 提及）、`repo_status`、`repo_log`、`repo_diff`、`repo_issue_list/get` 随时可查，无需等推送。

4. **变更自动推送（插话输入，核心新增）**
   - **触发器**：`tools/result` 观察 `repo_commit`/`repo_issue_*`/merge 结果（冻结结果，标脏）；journal 写入后 `domain/changed` 二次确认。
   - **推送器（relay 内）**：变更 → 结构化轻量推送消息（`{ kind: 'pr'|'commit'|'issue'|'mention', summary ≤200 字, authorSession, keys, opId, link }`）→ 计算目标会话（@mention 直发 + 按需广播）。
   - **投递（官方 API `agent.send`）**：`agents.get(sessionId)` → `agent.send(message, target: InboxTarget, wakeup: boolean)`：
     - **在线会话**（已加载，idle/running）：`send(push, target, true)` → 唤醒 driver → 当前 turn 收敛后由下一 step **claim** → 效果即「插话正在进行的对话」；
     - **离线/未加载会话**：推送先持久化到 journal 的 pending-push 队列；`session/created` 时 drain → `send(push, target, false)` 停入**持久 inbox**（`agent/inbox/spliced` 事件直接落会话日志）→ 用户下次输入打开 turn 即 claim → 即「对话没开始，先注入；下一次对话开始立刻同步」。
   - **防打扰**：同变更对同会话去重；摘要化（`notify.pushMaxChars`）；@mention 直发 + 广播按 `notify.pushCooldownMinutes` 降频；`notify.injectInbox` 可整体关闭。
   - **可观测**：每次推送 = journal `push` 事件（目标 sessionId、消息 id、投递路径）+ inbox splice 本身在目标会话轨迹可见（`agent/inbox/inserted`/`claimed` 可观察投递状态）。

5. **不替会话做知识决策**：推送只是「通知 + 摘要」，任何知识写入仍由一次明确的 `repo_*` 工具调用完成（= 轨迹可见、可审计）。

### 4.4 R4 — 自动备份

**三时机 + 一策略：**

| 时机 | 触发 | 内容 |
|---|---|---|
| commit 后 | `repo_commit` 成功钩子（core 内部） | 快照 tree + refs → `backups/snapshot-<ts>-<hash>.json.zst`，commit 记录 `backupRef` |
| 定时 | relay 用 `ctx.interval(cb, delay)` mixin（`@deepseek-ai/cordis-plugin-timer`，默认 30min，可配） | 全量快照 + journal 增量（journal 本身就是增量，故全量 + 尾行号） |
| 回滚前 | `repo_rollback` 第一步（硬前提） | 强制新鲜备份，才允许继续 |

**校验与保留**：写后读回解压比对 hash（`verify` 字段 + 启动复核）；保留最近 N=30 + 每周锚点（可配），清理时写审计。备份目录位于工作区 `.dsh-repo/backups/`，随仓库即插即走。P2：备份远端镜像（可选 WebDAV/Git 远程），本方案 v1 全部本地。
**截断硬前提（评审 P5）**：journal 截断前必须成功完成 ≥1 次**通过校验的全量备份**，否则拒绝截断并记 `repair` 事件（与 M1 验收「备份损坏注入→自愈」联动）；截断后旧的 journal 段仅存于备份，回滚/追溯仍可从备份 + commit 链复原。

**备份工具**：`repo_backup`（手动触发）、`repo_backups`（列表 + 校验状态 + 一键 verify）。

### 4.5 R5/R6 — 悬浮球 + 跟踪看板（Client）

**挂点：**

| UI 元素 | Slot | 说明 |
|---|---|---|
| 悬浮球 | `shell.overlay`（id=`repo-fab`，order 高） | 固定右下角圆形按钮：仓库色 brand token、未处理 issue 徽标、点按开合看板；拖拽位置记忆（localStorage） |
| 看板抽屉 | `shell.overlay` 同一入口（React state 控制显隐，Airbnb 式浮层） | 右侧抽屉（shadow + overlay token），约 720px |
| 各工具卡片 | `tool.call.toolview`（key=`repo_*`） | commit/issue/rollback 命令的专属可视化卡片（hash 徽标、作者会话、diff 摘要、一键 rollback 按钮） |
| 设置页 | `settings.section`（id=`repo-suite`） | 管理目录、备份间隔、保留数、通知策略 |
| 会话快捷入口 | `conversation.session.header.actions`/`utilities`（P2） | 仓库状态指示灯/快速打开看板 |

**看板四个页签（严格 DSW 风格）：**

1. **看板（Issues）**：Kanban 列 `open → assigned → in_progress → resolved → closed`，卡片 = 标题/状态色条/label/@会话/时间；点卡片 → 详情抽屉（timeline + 原文回溯跳转——用 `sessionQuery` 拿到原文，UI 上跳转对应会话）。
2. **提交（Commits）**：历史列表（commit hash、author 会话、message、时间），选中 → `repo_diff` 预览（key 级 + 行级 diff 高亮）、「复制 hash」「打开来源会话」、危险区「回滚到此」。
3. **状态（Status & Analysis）**：HEAD / 分支 / 未同步变更 / 陈旧 knowledge 列表 / 各会话贡献统计（issue、commit、触及 key）/ 风险标志（未决提及、备份失败、journal 修复记录）；「运行分析」按钮 → host `/repo/api` analysis 端点，可选 LLM 摘要（`ctx.llm`，P2）。
4. **恢复（Backups & Rollback）**：备份列表（时间/大小/校验状态/verify 按钮）+ 回滚向导：选 commit → 预览 diff → 「开始回滚」（host 强制先备份）→ 显示 revert commit 结果。

**美术风格协议（R5 合规）**：一律 `var(--dsw-alias-*)` token + `@media (prefers-color-scheme)` 覆盖为 light/dark 双值（Theme provider 明确要求）；字体/圆角/间距对齐 vision-toolkit 的既有写法（`dvt-*` 样式即范例）；不引入外部 UI 库（`dsh-client-ui-primitives` 的 Button/Input 够用）。

**RPC**：host 注册 `/_dsh/repo/api` 同源 JSON 端点（GET=快照，POST=action），复用 vision-toolkit 模式（`fetch(..., { credentials: 'same-origin' })`）；看板变化采用「操作后刷新 + 8s 轻轮询」，P2 再评估 SSE。

### 4.6 R6 — 回滚语义

```
repo_rollback --to <commitId> [--scope key1,key2] [--yes]
  1. 校验目标 commit 存在且可回溯（沿 parent 链）
  2. ★ 强制先备份当前状态（时间戳快照 + 校验）
  3. 计算 target.tree ⊖ head.tree 的 diff 预览（dry-run，返回给调用方/AI 展示）
4. 执行策略：保留备份与审计记录；当前 DSH 全权限策略为 `never`，不额外插入审批提示。
  5. 执行：将目标 tree 写为当前 tree → 新 commit { kind:'revert', reverts:<commitId> }
  6. journal + audit + 工具结果三处留痕；UI 看板「恢复」页展示前后对比
```

关键点：**回滚不删任何历史**；任何时候可由 revert commit 再回滚回来（双向往返安全）；`--scope` 支持只回滚部分 key（细粒度）。

### 4.7 R7 — 轨迹可见 + 工具注册（观察性设计）

1. **工具注册**：全部 `repo_*` 通过 `ctx.tools.register`（JSON Schema + `presentCall`，同 vision-toolkit），`tools/change` 自动广播 → 模型可用、UI 可显。
2. **会话轨迹**：每次调用即成为会话 JSONL 中的一条 tool-call（`ui-trajectory` 视图原生可见），客户端再挂 `tool.call.toolview` 卡片把结果渲染为富信息。
3. **仓库轨迹**：每次操作追加 `journal.jsonl` 一行（`{ op, seq, ts, sessionId, toolCallId?, payload, checksum }`）→ 仓库自身可重放、可审计。
4. **审计轨迹**：`audit.log` 人类可读行，含 `sessionId | tool | seq | outcome`。
5. **系统事件**：relay 监听 `tools/result`（观察冻结结果）做状态标脏；**执行前侧**（评审 P7）选配监听 `tools/pre-execute`（回滚前加锁、冲突预检等前置校验——`tools/result` 是冻结后的结果，改不了执行前状态）；可选 `sessionTelemetry.emit`（尊重 `sharing` 开关）上报聚合指标。
6. **交叉链接**：工具结果 JSON 内统一带 `opId`（= journal seq），卡片/日志/审计三方对得上。

### 4.8 R8 — 完整性与可追溯（安全网）

- 任何操作 = 一次工具调用（轨迹）+ 一行 journal + 一行 audit。
- 崩溃恢复：journal 校验和 + 写时 rename → 至多丢最后一条未确认操作，自愈截断并留痕。
- 冲突记录：自动 merge 或冲突 issue 均在 journal 留 `conflict` 事件。
- 每工作区隔离 + 注册表可枚举：`repo_manager_list` 工具列出所有工作区管理器及健康状态（供故障排查）。
- 删除面：`repo_*` 不支持删除 commit/issue/备份（只支持关闭状态、回滚 add）；如需物理清理，走人工 `repo_purge`（需最高批准 + 审计）。

### 4.9 现有工作区适配（Adoption & Migration）——R8 落地的前置条件

**问题**：插件注入时机器上已存在大量工作区（如 `D:\dsh-deafult`、`D:\coding-dsh-mobile` 各有数十个历史会话，甚至有 `C:\Windows\System32` 这类系统目录）。不能自动在所有工作区建 `.dsh-repo`（污染用户目录；系统目录不可写；纯浪费 IO），不能要求已有会话重启，也不能用 path 哈希当唯一键（路径会改名/迁移）。

**适配策略：**

1. **按需采纳（Lazy Adoption，评审 P2 解耦后）**：Manager 全部懒加载。**「建仓触发」与「提示」彻底解耦**——`session/created` 只触发**预检 + 提示注入**（见 pt3），**绝不自动建仓**；建仓动作仅由显式入口发起：①**`/repo init` 命令**（人工首选，§4.3 pt1）；②`repo_adopt` 工具。任何只读 `repo_*` 调用都只报告未初始化，绝不转为 adopt 流程。初始化幂等：探测可写性 → 写 `.dsh-repo/manifest.json`（`schemaVersion`、`pluginVersion`、`workspaceId`）→ 初始 commit `repo:init`（payload 仅工作区元数据：会话数、最早/最近活动、目录名，**不含任何会话内容**）→ 写 `README.md` 桥文件。若发现已存在他人/旧版仓库 → 冻结为只读并提示人工确认，绝不覆盖。
2. **不可写/系统目录降级**：初始化前先做可写性探测；不可写（如 System32）→ 管理器数据落 `~/.dsh/managers/<workspaceId>/external/`（外部存储模式，manifest 记 `storage: external`，UI 徽标提示），可写性恢复后可由 `repo_adopt` 迁回工作区（搬移 + 审计留痕）。
3. **既有会话零重启适配（P2 修订）**：relay 的 prompt 桥是宿主级 `systemPrompt.section`，**每次组装 step 时求值** → 已运行的会话下一次 step 即收到提示，无需重启/重开。提示分两档（均由 `adopt.promptHint` 控制，默认 true）：
   - 已纳仓工作区 → 一行仓库认知（仓库地址、未读 issue 数、如何 pull/commit）；
   - 未纳仓且未忽略 → 一行纯提示「本工作区未纳入知识仓库，如需可 `/repo init` 或 `repo_adopt`」——**不建仓、不污染**，但打破死锁：会话下一 step 就知道仓库存在，可按需触发 adopt。
   `repo_*` 调用天然落入既有会话的 `session.jsonl`，轨迹视图即刻可见。
4. **历史回填（P2，默认关）**：`repo_import_history` 工具——zstd 流式扫描工作区全部历史 `session.jsonl` → 每会话聚合摘要（标题、工具使用统计、关键产物路径）→ dry-run 预览 →（可选 LLM）逐会话生成知识摘要 commit（作者 = 源会话 id，可追溯）。默认关闭（token 成本），v1 只做元数据初始 commit，历史内容不进 tree。
5. **路径变更/迁移（P1 键体系统一）**：**`workspaceId` 是数据定位的唯一权威键**（来源 = `workspaceRegistry` 中的稳定 id）。解析优先级固定为：**① registry 的 `workspaceId` → ② 已建成仓库 `manifest.json` 记录的 `workspaceId` → ③ 注册表外路径回退用 session cwd 的路径编码**（与 `~/.dsh/sessions/<编码>/` 同构，仅用于兜底定位，且一旦 adopt 即在 manifest 固化 workspaceId）。目录命名统一为 `<workspaceId>`（如 `~/.dsh/managers/<workspaceId>/`），path 仅作展示与 `resolveByPath` 查询（避免改名哈希漂移）；工作区删除 → 注册表留 detached 记录，数据保留，可重新挂接或归档（审计留痕）。
6. **性能**：启动不全量重放——journal 定期写 checkpoint（重放从 checkpoint 起）；大工作区首次纳入只记账不深挖。

---

## 5. 工具清单（完整注册表，均带轨迹/审计）

| 工具 | 入参（摘要） | 权限/审批 | 备注 |
|---|---|---|---|
| `repo_commit` | message, keys[]?, branch? | 无 | 自动三方合并 |
| `repo_status` | — | 无 | 只读 |
| `repo_log` | limit?, branch?, oneline? | 无 | 只读 |
| `repo_diff` | from?, to? | 无 | 只读，供预览 |
| `repo_pull` | — | 无 | 同步 + 未读 issue |
| `repo_sync` | message? | 无 | pull+commit+merge 复合 |
| `repo_issue_open` | title, body, labels?, refs?, assignee? | 无 | 跨会话引用 |
| `repo_issue_comment` | issueId, text | 无 | @ 触发通知 |
| `repo_issue_transition` | issueId, status, reason? | 无 | 状态流 |
| `repo_issue_list` | status?, label?, assignee?, q? | 无 | 看板数据源 |
| `repo_issue_get` | issueId | 无 | 详情+回溯 |
| `repo_backup` | label? | 无 | 手动快照 |
| `repo_backups` | — | 无 | 列表+校验态 |
| `repo_rollback` | to, scope?, yes? | 无额外审批（全权限策略） | 先备份 → 预览 → revert commit |
| `repo_analyze` | scope? | 无 | 状态/贡献/风险分析 |
| `repo_selfheal` | — | 无（只读修复 journal） | 自愈 |
| `repo_manager_list` | — | 无 | 各工作区管理器健康 |
| `repo_adopt` | workspaceId?, mode? | 无 | 纳入管理 / 迁移存储位置（external→workspace） |
| `repo_ignore` | workspaceId | 无 | 加入忽略名单，不再自动初始化 |
| `repo_import_history` | dryRun?, llm? | 无（P2） | 历史会话摘要回填为知识 commit |
| `repo_purge` | target | **最高批准** | 物理清理（谨慎） |

**人工命令（非工具，`commands.register`，走 `conversation.chat.commandview` 卡片）**：`/repo init`（建库，§4.3 pt1）、`/repo status`、`/repo log`、`/repo rollback <commit>`（复用备份与 revert 流程）。命令 handler 直接对 agent 执行，不进模型上下文，但 `command/run` 事件落会话日志（轨迹可见）。

---

## 6. 客户端 UI 清单

| 组件 | Slot/路由 | 关键交互 |
|---|---|---|
| `RepoFab` | `shell.overlay` | 悬浮球、徽标、点击开合抽屉 |
| `RepoBoard` | shell.overlay 抽屉 | 四页签（看板/提交/状态/恢复） |
| `IssueKanban` / `IssueDetail` | 抽屉内 | 列流 + 时间线 + 原文跳转 |
| `CommitLog` / `DiffView` | 抽屉内 | 历史 + key/行级 diff |
| `RepoAnalysis` | 抽屉内 | 统计卡片 + 风险标志 + 分析按钮 |
| `BackupTable` / `RollbackWizard` | 抽屉内 | 校验 + 回滚向导（预览→确认→结果） |
| `repo_*` 工具卡片 | `tool.call.toolview` | hash 徽标 / 作者 / 一键回滚 |
| `RepoCommandCard` | `conversation.chat.commandview`（key=`repo`） | `/repo init/status/log/rollback` 命令结果卡片（含建库摘要、commit 链） |
| `RepoSettingsPage` | `settings.section` | 配置项（见 §7） |
| 语言包 | `locale` | en + zh 双字典 |

---

## 7. 设置与配置

`settings.register('repo', schema)`（host，JSON 文件后端），界面 = 设置页：

- `manager.dataDir`（默认工作区 `.dsh-repo`）
- `backup.intervalMinutes`（默认 30）、`backup.retention`（默认 30）、`backup.weeklyAnchors`（默认 true）
- `rollback.requireApproval`（默认 true）
- `notify.mentionInApp`（默认 true——悬浮球徽标 + 看板提示）、`notify.injectInbox`（默认 **true**——PR/commit/issue 变更自动插话在线对话、预注入离线会话；用户明确需求，原 P2 提升为核心）、`notify.pushCooldownMinutes`（默认 10——广播降频）、`notify.pushMaxChars`（默认 200——推送摘要长度）
- `sync.promptBridge`（默认 true——是否注入会话启动提示段）
- `analysis.llmSummary`（默认 false，P2）
- `adopt.auto`（默认 **false**——启动时是否预扫描并自动初始化所有非忽略工作区；**与提示解耦**，默认只由显式 `/repo init` 或 `repo_adopt` 建仓）
- `adopt.promptHint`（默认 **true**——任意会话下一 step 均收到仓库提示；未纳仓工作区收到「可 /repo init 或 repo_adopt」一行提示，不建仓）
- `adopt.ignoredWorkspaces`（忽略名单，`repo_ignore` 写入；忽略后连提示也不发）

---

## 8. 安全与权限

- 路径安全：管理器只写工作区内 `.dsh-repo/`；所有输入路径经 `fs.resolve` 校验必须落在工作区根内。
- 执行策略：`repo_rollback` 和 `repo_purge` 均保留备份/审计；当前全权限策略为 `never`，不请求额外审批。
- 沙箱：对工作区文件的一切写入遵循现有 fs 沙箱策略；不越权访问其他工作区。
- 锁：`.manager.lock`（`fs.open(wx)` 语义 + 陈旧锁超时回收），防多进程双写。
- 备份隐私：备份含知识内容，默认仅本地；提示文档说明可配加密（P2）。

---

## 9. 里程碑与验收（每阶段含轨迹验收点）

| 阶段 | 内容 | 验收（含轨迹验证） |
|---|---|---|
| **M0 骨架装配** | 单 hybrid 包 `local-git-4-llm` scaffold（core/relay/client 模块目录），走通 注入器链（build→inject），空跑自检；**首日实测 `shell.overlay` 及 `conversation.*` slots 存在性**（评审未核验项） | `dev_plugin_status` 出现插件；`dev_self_test` PASS；空包热重载/卸载即净；slot 实测记录写入文档 |
| **M1a 纯读取引擎** | manifest + canonical `journal.jsonl` + inline tree/commit replay + **只读工具**（status/log/diff/pull/issue_list/issue_get）；不建立 refs/audit/锁/自愈 | fixture 重放、checksum 链、workspaceId 边界、截断尾与重复 JSON key 检测；`session.jsonl` 可见 `repo_*` 调用（轨迹✓） |
| **M1b 写工具 + 存量适配** | 写工具（commit/issue 写操作/backup/rollback/analyze）+ **现有工作区适配**（懒加载采纳、可写性探测、外部存储降级、忽略名单、workspaceId 定位） | 重复 init 幂等；不可写目录降级到 `~/.dsh/managers/<workspaceId>/external/`；adopt 触发/提示解耦验证（未纳仓会话收到提示但不建仓）；回滚先备份并生成 revert commit（轨迹✓） |
| **M2 relay 同步** | `/repo` 命令注册、会话启动预检+提示注入、agent-scope 工具注入、变更**插话/预注入推送**（`agent.send` inbox）、自动备份 `ctx.interval`、冲突→issue、`tools/result` 标脏 + `tools/pre-execute` 前置校验 | 新开会话 prompt 含仓库桥提示（纳仓/未纳仓两档）；已纳仓会话自动获得完整 `repo_*` 工具集（未纳仓仅引导工具）；A 会话 commit → B 在线会话收到插话（inbox splice 落 B 轨迹）、B 离线会话下次打开即见预注入；定时备份生成且 hash 校验过；并发冲突 → 自动 merge/issue 且 journal 有 `conflict` 事件 |
| **M3 UI 看板** | 悬浮球 + 四页签 + 工具卡片 + 设置页 | 悬浮球出现于原生 WebUI（README 截图留档）；看板数据与 `repo_issue_list`/`repo_log` 一致；回滚向导完成备份和 revert（轨迹✓） |
| **M4 加固发布** | 崩溃/并发/回滚幂等演练、文档、`dev_release_plugin` 出 tgz | `dev_self_test` 风格回归全绿；回滚→再回滚等价（**HEAD 指针不同但 tree hash 相同**，评审 P4）；README + 本方案更新为验收报告 |

---

## 10. 测试与故障演练

- **单元**：tree hash、journal 校验和、三方合并矩阵（无冲突/一方/双方/删除冲突）。
- **集成（probe 脚本，仿 `dsh-router-standard/probe`）**：双会话并发 commit 压力、kill 中途断电恢复、备份损坏注入→自愈、回滚幂等。
- **注入器回归**：每次发布前 `dev_self_test`（注入→重载→自重载节流→预检拦截→卸载即净）。
- **轨迹断言**：测试自动断言 `session.jsonl` 存在对应 `repo_*` tool-call 事件，且 `toolCallId` 与 journal `opId` 可链。

---

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 悬浮球与官方 UI 版本演进冲突 | 只用 `shell.overlay`（replaceRisk:none）+ token 变量；不 replace 官方 seats |
| 插话/预注入打扰用户与 AI | 摘要化（`pushMaxChars`）+ 同变更去重 + 广播降频（`pushCooldownMinutes`）+ `notify.injectInbox` 可整体关闭；仅通知不代写知识 |
| 污染/不可写工作区（如 System32） | 按需采纳（建仓=显式 adopt）+ 忽略名单 + 可写性探测 + 外部存储降级；`adopt.auto` 默认 false、`adopt.promptHint` 默认 true |
| 多进程双写仓库 | `.manager.lock` + 陈旧锁超时 + journal 唯一序号 |
| 回滚误伤工作区文件 | v1 只回滚知识树；对工作区文件的投影默认关闭并需显式配置 + 审批 |
| prompt 注入膨胀 | 桥提示 ≤2 行 + 内容按需 `repo_pull` |
| journal 无限增长 | 定时快照 + 截断策略（截断后旧的仅存备份），保留策略可配 |
| DSH 升级破坏注入器 | 沿用 `dsh.bundle.patch`/`dsh.client.inject` 官方机制，版本区间约束在 peerDeps；`dev_self_test` 兜底 |
| LLM 摘要端点成本 | 默认关，按需开；聚合指标先离线计算 |

---

## 12. 实施路径（确认后第一步行动）

```
M0：dev_scaffold_plugin（hybrid，单包 local-git-4-llm，内部 core/relay/client 模块目录）
    → dev_build_plugin → dev_inject_plugin → dev_self_test 回归
    → 首日实测 shell.overlay / conversation.* slots（评审未核验项）
M1a：纯读取引擎（manifest + canonical journal + inline tree/commit replay）+ 只读工具（status/log/diff/pull/issue_list/get）✓
M1b：写工具（commit/issue 写/backup/rollback/analyze）+ 现有工作区适配（adopt/ignore/降级/定位）
    → 双会话实测 → 轨迹断言
M2：relay 守护（ctx.interval 定时备份、启动预检+提示注入、冲突检测、pre-execute/result 钩子、通知）
M3：UI（悬浮球/看板/卡片/设置）
M4：加固 + 演练 + release
```

> 命名决策：GitHub 仓库、hybrid 包、运行时 ID、UI、文档与构建产物统一使用 `local-git-4-llm`；内部模块以 `local-git-4-llm/core`、`local-git-4-llm/relay`、`local-git-4-llm/ui` 表示。工具名保留功能性 `repo_*` 命名空间。

---

## 附录 A — API 挂点速查（Inspect 实测，2026-08-16）

- **Client Slots**：`shell.overlay`（list/root）★悬浮球；`tool.call.toolview`（keyed/session）★卡片；`conversation.chat.commandview`（keyed，key=`repo`）★ `/repo` 命令卡片；`settings.section`（list/root）；`conversation.session.header.actions` & `.utilities`（list/session）；`conversation.input.dock`（list/session）；`conversation.view`（list/session，可加看板为第五视图，P2）
- **Host Services**：`tools`（register——**支持全局或调用方 agent 作用域注册，scoped shadow 全局** / restrict / execute / `tools/change`）、`commands`（register({name, description, handler})，`/repo` 命令）、`agents`（get(id) → Agent；`agent.send(message, target, wakeup)` **插话/预注入 API**）、`storageDomain`（open/get/`domain/changed`）、`workspaceRegistry`（list/resolveByPath/create）、`sessionQuery`（searchEvents/traceSession/readEvent）、`sessionReferenceResolver`（prepare）、`sessionTitle`（get）、`sessionPersistence`（append——连续 seq、append-only，**repo 数据走自身 journal，不滥用此通道**）、`sessionTelemetry`（emit，受 sharing 约束）、`webServer`（register({kind:'exact'\|'prefix', path, handler}) 路由，须经 `ctx.inject(['webServer'])` + `ctx.effect`）、`settings`（register/update）、`agentLoop`（createAgent/resume）、`systemPrompt`（section——text 可为函数型，每次装配求值）、`timer`（mixin：`ctx.interval(cb, delay)`/`ctx.timeout`，包名 `@deepseek-ai/cordis-plugin-timer`；`ctx.timer.*` 已弃用）、`approval`（request）
- **Host Events**：`session/created`、`session/event`（post-commit feed）、`tools/pre-execute`（执行前校验，选配）、`tools/result`（观察冻结结果）、`tools/change`、`settings/updated`、`domain/changed`、`agent/session-start`（Scoped<Agent>）、`agent/inbox/inserted` & `agent/inbox/claimed`（推送投递状态观察；inbox 变更以 `agent/inbox/spliced` 持久化于会话日志）
- **Client Services**：`slots`（inject/register）、`locale`、`theme`（overrideTokens 可选）、`sessions`（open/fork）、`workspaces`
- **Theme tokens**：`--dsw-alias-bg-base/layer-1/layer-2/overlay`、`--dsw-alias-border-l1/l2`、`--dsw-alias-brand-primary`、`--dsw-alias-label-primary/secondary`、`--dsw-alias-state-error-primary/success-primary/warn-primary`、`--dsw-specific-sidebar-fill`（均需 light+dark 双值）

---
*生成：DeepSeek Harness 代理 · 2026-08-16 · 环境实测依据（Inspect + 本地勘察）*
