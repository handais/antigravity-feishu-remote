# Changelog / 更新日志

All notable changes to **Feishu Remote (飞书远程控制)** are documented in this file.

---

## [Unreleased]

### Added / 新增
- **Command Dashboards & Persistent Workflow Sessions (`agy-session-pool.mjs`, `command-boards.mjs`)**
  - Dedicated interactive dashboards for `/goal`, `/swarm` / `/teamwork`, `/schedule`, and `/plan` / `/grill-me`, plus `buildNewSessionCard` summary cards on `/new` and `menu_new`.
  - Persistent open-stdin `agy` session pool for long-running workflows and unsolicited background wakeups, plus per-chat timeout isolation and callback `threadRootId` self-routing across daemon restarts.
- **Security, Guardrails & CLI Hardening**
  - Added `--app-secret-stdin` (with TTY check) / `FEISHU_APP_SECRET` setup support, advisory file locks (`withFileLock`) around `updateState` / `updateConfig` (including `cli.mjs setup`) and `stop-notify` dedup state, sensitive file enforcement in `sendLocalMedia()` (blocking `~/.gemini/`, `~/.config/gcloud/`, `~/.git-credentials`, histories, `*.p8`/`*.kdbx`), external doc/task prompt-injection framing, `write_file`/`edit_file` path protection in `PreToolUse`, and `0600` daemon log permission enforcement.

### Changed / 优化
- Changed default `security.autoBindFirstUser` to `false` (fail-closed unless `--allow-open-id` or `--auto-bind true` is configured).
- Excluded README marketing media (`keynote-demo.gif`, banner SVGs) and local config/DB artifacts from `cli.mjs pack`, shrinking shareable plugin archives by ~97%.
- Batched SQLite metadata lookups in `mobile-handoff.mjs`, switched Feishu media downloads to temp-file streaming with collision-safe suffixes, made `turn_send_file` and slow card actions asynchronous (with error-card fallback) to avoid Feishu's 3-second callback timeout, skipped redundant `updateState` writes on non-expired slash commands, and pinned CI action commit SHAs.

### Fixed / 修复
- Deferred `DONE` reactions until background subagent/workflow sessions actually complete (`Typing` while active -> `🔄 后台协作新进展（进行中）` -> `✅ 后台协作新进展（已完成）` + swap `Typing` to `DONE`), preventing member status checks or dispatch completion from suppressing final notifications.
- Fixed `asyncTurn` vs `runTurn` collisions, orphaned detached `agy` exit cleanup, temp-`full` expiry persistent session release, desktop takeover state reset, slash-command newline preservation, `defaultReceiveId` group `oc_...` `open_id` assumptions, Windows `cmd.exe` parameter & OAuth URL `&` handling, `getBotOpenId()` fail-open group mentions, empty fenced-block chunking, and skills pagination/prefix filtering.

---

## [1.1.0] - 2026-11-27

### Added / 新增
- **高危命令飞书卡片审批 (`/guard on|off`) & 安全加固**
  - Added `PreToolUse` hook approval (`pre-tool-approval.mjs`) for high-risk shell commands via interactive Feishu cards with configurable timeout and fail-closed defaults.
  - Hardened security across MCP target allowlists, Fail-Closed operator checks when `allowedOpenIds` is empty, sensitive path/diff filtering, bridge child stop/restart guards, and symlink path deduplication.
- **新版分组控制面板 & 本地技能入口**
  - Redesigned the Control Panel into clear sections with dynamic `⭐ 常用操作` (top-4 recency-weighted frequent actions) and a dedicated `🛠️ 设置` sub-page (`guard_toggle`, desktop notify mode, scope check, `safe_restart`, rollback snapshots, and reset frequent actions).
  - Added `/` / `/skills` command & local Skills browser (`menu_commands`) with one-tap `/compact` and `/agy <raw>` passthrough.
- **跨话题 / 跨窗口「最近会话」聚合 (`collectFeishuSessions`)**
  - `/sessions [all|here]` now aggregates recent sessions across private chats and topic threads with source tags (`[本话题]` / `[本窗口]` / `[私聊]` / `[话题]`), remembers the active view scope, and syncs working directory (`cwd`) automatically on cross-chat `/use`.
- **守护进程日志本地时间戳**
  - Added local wall-clock timestamps (`YYYY-MM-DD HH:mm:ss.SSS±HH:MM`) to all `bridge-daemon` logs (`formatLocalTimestamp` / `installTimestampedConsole`) and unified `lark-event` stderr logging.
- **模块化重构 & 自动化单测**
  - Split card builders and action handlers into focused modules (`scripts/lib/actions/*.mjs`) and added 38 automated unit tests across `tests/*.test.mjs`.

### Changed / 优化
- Shortened Control Panel button labels for cleaner mobile layout:
  - `浏览目录` → `切换目录`
  - `系统与设置` → `设置`
  - `⚡ 临时全权30m` → `⚡ 30m全权` (active countdown displays `⚡ 全权剩XXm`)
  - `命令与技能` → `命令`
- Documentation improvements: clarified Windows paths and platform test status (`macOS` verified vs `Linux`/`Windows` CI smoke-tested), refined the AI quickstart SOP order, and acknowledged the LINUX DO community.

### Fixed / 修复
- Kept `withTimeout` timer ref'd on Node 22 and fixed Homebrew Cellar prefix matching on macOS (`resolveStableNodeBin`).
- Passed `pluginRoot` as `cwd` in preflight checks (`cli.mjs check`) so isolated import checks resolve dependencies reliably.

---

## [1.0.0] - 2026-11-25

### Added / 新增
- Initial public release of **Feishu Remote (飞书远程控制)** for Antigravity:
  - WebSocket long-connection bridge (`bridge-daemon.mjs`, no public IP or webhook required).
  - CardKit 2.0 typewriter streaming with automatic `patchCard` fallback, smart chunking, and per-chat FIFO queuing.
  - Topic group concurrency (`chatId#threadRootId`), inbound/outbound media, quoted reply context, and automatic Feishu Docx/Wiki link reading.
  - Built-in MCP server (`feishu-remote-tools`) for proactive messages/cards/files, Docx read/write, Task Center v2 OAuth, and mobile-to-desktop session sync.
  - Desktop `Stop` notification hook (`stop-notify.mjs`) with 3-mode away detection and dual-track topic/P2P takeover.
  - Cross-platform support (macOS `launchd`, Linux `systemd --user`, native Windows) and GitHub Actions CI across `ubuntu-latest`, `windows-latest`, and `macos-latest`.
