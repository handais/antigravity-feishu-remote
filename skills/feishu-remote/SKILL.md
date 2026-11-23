---
name: feishu-remote
description: Configure, run, manage, troubleshoot, and package the Feishu Remote Control bridge, MCP server, and completion hook for Antigravity. Use when the user asks to set up Feishu bot remote control, check/restart the bridge daemon, send Feishu test notifications, or package the plugin to share with friends.
---

# Feishu Remote Control Guide

This plugin connects Feishu (WebSocket long connection, no public IP or webhook required) to the local `agy` CLI so users can steer Antigravity from Android/iOS Feishu.

All user secrets and runtime state live strictly outside the plugin folder at `~/.config/antigravity-feishu/` (`0600` permissions), keeping the plugin folder clean and safe to share.

## 1. First-Time Dependency Check

Before running any script, make sure Node.js dependencies are installed inside the plugin root (`~/.gemini/config/plugins/feishu-remote/`):

```bash
cd ~/.gemini/config/plugins/feishu-remote
[ -d node_modules/@larksuiteoapi/node-sdk ] || npm install --omit=dev
```

## 2. Feishu Open Platform Checklist (Share with User When Needed)

1. Open [Feishu Open Platform](https://open.feishu.cn/app) and select/create an **Enterprise Self-built App** (企业自建应用).
2. Under **应用能力 → 机器人 (Bot)**, enable Bot capability.
3. Under **权限管理 (Permissions)**, enable:
   - Core: `im:message`, `im:message:send_as_bot`, `im:message.p2p_msg:readonly`, `im:resource` (required for inbound/outbound images & files), and optionally `im:message.group_at_msg:readonly`.
   - Enhanced UX & Cloud Docs (recommended): `cardkit:card:write`, `cardkit:card:read`, `im:message.reactions:write_only`, `im:message:readonly`, `docx:document:readonly`, `docx:document:write_only`, `docx:document.block:convert`, `wiki:node:read`.
4. Under **事件与回调 (Events & Callbacks)**:
   - **事件配置**: Choose **使用长连接接收事件 (WebSocket Long Connection)** and subscribe to **`im.message.receive_v1`** and **`application.bot.menu_v6`** (for Bot Custom Menu click events).
   - **回调配置**: Choose **使用长连接接收回调** and subscribe to **`card.action.trigger`** (for interactive Control Panel, Directory Browser (`/dirs`), Quick Prompt Tasks (`/quick`), Git (`/git`), Scopes (`/scopes`), Queue (`/queue`), Retry, Session, Model, and Abort buttons).
5. Under **应用能力 → 机器人 → 机器人自定义菜单 (Optional, Recommended)**:
   - Enable **机器人自定义菜单** (prefer **悬浮菜单**) with shortcut buttons pushing event keys `menu_panel`, `menu_quick`, `menu_dirs`, `menu_new`, `menu_stop` (also supports `menu_git`, `menu_scopes`, `menu_queue`, `menu_mode_temp_full`, `menu_ops`, `menu_reload`, `menu_sessions`, `menu_models`, `menu_mode_full`, `menu_help`) or sending `/panel`, `/quick`, `/dirs`, `/new`, `/stop`.
6. Under **版本管理与发布**, create and publish a version (or enable in test/dev scope).

## 3. Setup & Manage Daemon (`scripts/cli.mjs`)

Run commands with `node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs`:

- **Configure credentials & defaults**:
  ```bash
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs setup \
    --app-id "<APP_ID>" \
    --app-secret "<APP_SECRET>" \
    --cwd "$HOME" \
    --mode accept-edits
  ```
  Optional flags:
  - `--domain feishu|lark` (default `feishu`)
  - `--model <model-id>`
  - `--effort <low|medium|high|xhigh|max|default>` (default `default`)
  - `--timeout <seconds>` (default `3600`; `0` for unlimited)
  - `--proxy <http://127.0.0.1:7897>` (proxy for spawned `agy` subprocesses; auto-detected if omitted)
  - `--feishu-proxy <url>` (usually leave empty so Feishu connects directly)
  - `--allow-open-id <ou_xxx>` (repeatable; if omitted, first private-chat sender is auto-bound)
  - `--group-policy mention|off|all` (default `mention`)
  - `--stop-hook true|false` (default `true`; desktop completion cards include a `📱 接管此对话` handoff button)
  - `--add-quick "按钮名称|提示词"` (repeatable; adds custom one-tap quick task buttons)
  - `--reset-quick` (resets quick tasks back to built-in defaults)
  - Note: in `accept-edits` mode, remote tasks can read/edit files but shell/MCP calls may be denied; tap `⚡ 临时全权30m` (or send `/mode full 30m`, auto-reverts after expiry) or `⚡ 常驻全权` in the Control Panel when remote shell/MCP execution is needed.
- **Start / Stop / Restart background daemon** (`launchd` on macOS, `systemd --user` on Linux):
  ```bash
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs start
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs status
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs logs --lines 50
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs check
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs safe-restart
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs backups
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs rollback
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs scopes
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs read-doc "<URL_OR_TOKEN>"
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs write-doc --title "Report" --file ./report.md
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs desktop --limit 5
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs restart
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs stop
  ```
  - `check`: runs two-stage preflight (`node --check` + isolated ESM import/export check).
  - `safe-restart`: runs `check` first and aborts without restarting if any error is found.
  - `backups` / `snapshot` / `rollback`: manages deduplicated known-good code snapshots under `~/.config/antigravity-feishu/backups/` (max 5). In Feishu, users can also tap `♻️ 安全重启` or `⏪ 快照回滚` (or send `/ops`, `/reload`, `/check`, `/snapshot`, `/rollback`).
  - `scopes` / `read-doc` / `write-doc`: inspect Feishu Open Platform scopes and read/write Feishu Docx/Wiki documents from CLI (MCP tools `feishu_read_doc` and `feishu_write_doc` are also exposed via `mcp-server.mjs`).
  - `desktop`: read-only scan/FTS5 search of local CLI & Desktop App conversations (`--query`, `--filter`, `--limit`).
  - `node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs send-file <path> [--as-file]`: upload and send a local image or file back to Feishu (requires `im:resource` scope).
  - Inside Feishu chat: supports CardKit 2.0 typewriter streaming (auto-fallback to `patchCard`), message completion reaction (`DONE`), per-chat FIFO task queuing (`/queue`), quoted message context fetching, auto-reading shared `feishu.cn/docx/...` & `/wiki/...` URLs, `/doc`, `/git`, `/scopes`, `/effort`, `/timeout`, `/sessions` + `/desktop` (`/pc`) proactive local conversation scanning & dual-track takeover, temporary full mode (`/mode full 30m`), desktop Stop-card `📱 接管此对话` handoff, retry buttons on failed/aborted cards, inbound/outbound media (`/send`), fuzzy `/cd <keyword>`, and graphical `/quick` management.
- **Send a test card** (after first user has bound or `--receive-id` is given):
  ```bash
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs test-send
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs test-send --panel
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs test-send --quick
  node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs test-send --dirs
  ```

## 4. Packaging & Sharing with Friends

Generate a clean `.zip` containing zero `node_modules` and zero personal credentials/state:

```bash
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs pack --out ~/Desktop/feishu-remote-plugin.zip
```

Friend installation steps:
1. Unzip into `~/.gemini/config/plugins/feishu-remote/`
2. Run `cd ~/.gemini/config/plugins/feishu-remote && npm install --omit=dev`
3. Run `node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs setup --app-id ... --app-secret ...`
4. Run `node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs start`
5. Message their Feishu bot once in private chat to auto-bind their `open_id`.

## 5. Troubleshooting Quick Notes

- **Proxy isolation**: Feishu WS/REST calls strip `http_proxy` / `https_proxy` / `all_proxy` by default so local `socks5://` proxies do not break Feishu WebSocket connections, while spawned `agy` subprocesses receive `config.agy.proxy`.
- **Stop hook noise**: `stop-notify.mjs` automatically skips child sessions spawned by the bridge (`FEISHU_REMOTE_BRIDGE_CHILD=1`) to prevent loops.
