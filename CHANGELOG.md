# Changelog / 更新日志

All notable changes to **Feishu Remote (飞书远程控制)** are documented in this file.

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
