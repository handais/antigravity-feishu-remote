# Feishu Remote — Antigravity Plugin

[![CI](https://github.com/handais/antigravity-feishu-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/handais/antigravity-feishu-remote/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/handais/antigravity-feishu-remote)](https://github.com/handais/antigravity-feishu-remote/releases)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5.0-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**English** | [简体中文 (README.md)](./README.md)

Control your local **Antigravity** CLI / IDE directly from **Feishu** or **Lark** (mobile or desktop) over a **WebSocket long connection**—no public IP, reverse proxy, or webhook server required. Includes **CardKit 2.0** typewriter streaming, multi-turn session management, Topic Group parallel threads, Desktop-to-Phone handoff, MCP proactive messaging & cloud doc tools, and a `Stop` completion notification hook.

---

## Security & Privacy Model

- **Strict Secret Isolation**: Personal `appId`, `appSecret`, `allowedOpenIds`, and runtime state are stored exclusively outside the plugin directory at `~/.config/antigravity-feishu/` (`0700` directory mode, `0600` file mode). The plugin repository and packaged `.zip` never contain credentials or personal identifiers.
- **Owner Allowlist**: By default, `autoBindFirstUser` locks the bot to the very first private-chat sender's `open_id` (or you can pre-bind via `--allow-open-id`). Unauthorized users are blocked immediately.
- **Secret Masking**: `cli.mjs status`, `cli.mjs setup`, and the `feishu_bridge_status` MCP tool always mask `appSecret` before output.
- **Scoped Permissions & Auto-Revert**: Supports `accept-edits`, `plan`, `auto`, `default`, and `full` execution modes, plus temporary full-permission grants (`/mode full 30m`) that automatically revert to a safe mode upon expiry.
- **Loop Prevention**: Child sessions spawned by the bridge receive `FEISHU_REMOTE_BRIDGE_CHILD=1`, so the `Stop` hook automatically skips them to prevent notification loops.
- **Proxy Isolation**: Strips local `http_proxy` / `https_proxy` / `all_proxy` env vars for Feishu WebSocket/REST traffic (to avoid `socks5://` breakage) while passing `config.agy.proxy` only to spawned `agy` subprocesses.

---

## Installation

### Prerequisites

- **Node.js `>= 22.5.0`** (required for built-in `node:sqlite` used by `/desktop` session indexing)
- **Antigravity CLI (`agy`)** installed and authenticated
- **OS Support**: macOS (`launchd`), Linux (`systemd --user`), native Windows (detached PID daemon + `GetLastInputInfo` idle probe), and WSL2

### Option A — Install via Antigravity CLI (Recommended)

```bash
agy plugin install https://github.com/handais/antigravity-feishu-remote
```

Then install runtime Node dependencies inside the installed plugin folder (default `~/.gemini/config/plugins/feishu-remote/`, or your workspace `.agents/plugins/` folder):

```bash
cd ~/.gemini/config/plugins/feishu-remote && npm install --omit=dev
```

### Option B — Manual Git Clone

```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/handais/antigravity-feishu-remote.git ~/.gemini/config/plugins/feishu-remote
cd ~/.gemini/config/plugins/feishu-remote && npm install --omit=dev
```

### Option C — Agent Quickstart

Paste this prompt into Antigravity (or another coding agent with terminal/browser access):

```text
Please install and set up the Feishu Remote plugin from:
https://github.com/handais/antigravity-feishu-remote
Follow README_EN.md: install into ~/.gemini/config/plugins/feishu-remote, run npm install --omit=dev, run scripts/cli.mjs check and scripts/smoke-test.mjs, then help me configure the Feishu/Lark bot credentials via scripts/cli.mjs setup and start the daemon. Never write appSecret inside the plugin directory or echo it in replies.
```

---

## Feishu / Lark Open Platform Setup Checklist

1. Open [Feishu Open Platform](https://open.feishu.cn/app) (or [Lark Developer Console](https://open.larksuite.com/app) if using `--domain lark`) and create an **Enterprise Self-built App**.
2. Enable **Bot** under **App Capabilities**.
3. Under **Permissions**, batch-import the following tenant scopes JSON:
   ```json
   {
     "scopes": {
       "tenant": [
         "im:message",
         "im:message:send_as_bot",
         "im:message.p2p_msg:readonly",
         "im:message.group_at_msg:readonly",
         "im:message:readonly",
         "im:resource",
         "im:message.reactions:write_only",
         "im:message.reactions:read",
         "cardkit:card:write",
         "cardkit:card:read",
         "docx:document",
         "docs:permission.member:create",
         "docx:document:readonly",
         "docx:document:write_only",
         "docx:document.block:convert",
         "wiki:node:read"
       ]
     }
   }
   ```
   *(Optional: add `im:message.group_msg` if you plan to use `--group-policy all` in a private topic group without `@mention`.)*
4. Configure credentials locally and start the daemon first (so Feishu sees an active WebSocket client when enabling long connection):
   ```bash
   node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs setup \
     --app-id "<APP_ID>" \
     --app-secret "<APP_SECRET>" \
     --domain feishu \
     --cwd "$HOME" \
     --mode accept-edits \
     --notify-mode away

   node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs start
   node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs status
   ```
   *(Use `--domain lark` for international Lark workspaces.)*
5. Under **Events & Callbacks**:
   - **Events**: Select **Receive events via persistent connection (WebSocket)** and subscribe to `im.message.receive_v1` and `application.bot.menu_v6`.
   - **Callbacks**: Select **Receive callbacks via persistent connection (WebSocket)** and subscribe to `card.action.trigger`.
6. *(Optional)* Under **Bot Custom Menu**, add menu buttons pushing event keys `menu_panel`, `menu_commands`, `menu_new`, `menu_stop` (also supports `menu_skills`, `menu_dirs`, `menu_effort`, `menu_git`, `menu_scopes`, `menu_queue`, `menu_mode_temp_full`, `menu_ops`, `menu_reload`, `menu_sessions`, `menu_models`, `menu_mode_full`, `menu_help`).
7. Under **Version Management & Release**, create and publish a version (can be scoped to yourself or test users).
8. Message your bot once in private chat (e.g. `hi` or `/help`) to auto-bind your `open_id` and receive the welcome card.

---

## CLI Reference (`scripts/cli.mjs`)

| Command | Description |
| :--- | :--- |
| `setup` | Save Feishu/Lark credentials, proxy, default cwd/mode/model/effort, and notify mode to `~/.config/antigravity-feishu/config.json` |
| `start` / `stop` / `restart` | Manage background daemon (`launchd` / `systemd --user` / Windows PID) |
| `check` | Two-stage syntax (`node --check`) and ESM import/export verification |
| `safe-restart` | Run `check`, save a snapshot, and restart only if validation passes |
| `snapshot` / `backups` / `rollback` | Manage deduplicated code snapshots in `~/.config/antigravity-feishu/backups/` (max 5) |
| `status` / `logs [--lines N]` | Inspect daemon status, masked config, and stdout/stderr logs |
| `test-send [--panel\|--dirs]` | Send a test or interactive control card to the bound user |
| `send-file <path> [--as-file]` | Upload and send a local image or file to Feishu/Lark |
| `scopes` | Query Feishu Open Platform scope grant status |
| `read-doc` / `write-doc` | Read (including comments) or create/append Feishu Docx/Wiki documents |
| `desktop [--query kw]` | Read-only scan & FTS5 search of local CLI and Desktop conversations |
| `pack [--out path.zip]` | Build a clean shareable `.zip` (excludes `node_modules`, `.git`, logs/envs/zips, and all user credentials) |

Run verification locally at any time:

```bash
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs check
node ~/.gemini/config/plugins/feishu-remote/scripts/smoke-test.mjs
```

---

## Feishu Chat Commands

- **Control & Navigation**: `/panel` (interactive control panel), `/dirs [-a]` (browse/pin directories, toggle hidden dot-directories), `/cd <path|keyword>`, `/pin`, `/` or `/skills` (built-in `agy` commands & local skills), `/status`, `/help`
- **Execution Controls**: `/mode [accept-edits|plan|auto|full|default|full 30m]`, `/model [id|default]`, `/effort [low|medium|high|xhigh|max|default]`, `/timeout [minutes|0]`, `/queue`, `/stop`
- **Sessions & Handoff**: `/new`, `/sessions`, `/use <index|id>`, `/desktop [keyword]` (`/pc` — preview & take over local CLI/Desktop sessions)
- **Files, Docs & Ops**: `/send <path> [--file]`, `/doc ...`, `/tasks` (`/todo` — list, create, complete, or run Feishu Task v2 tasks via User OAuth), `/git`, `/scopes`, `/notify [on|away [min]|off]`, `/ops`, `/check`, `/reload`, `/snapshot`, `/rollback`

---

## Bundled Plugin Components

- **MCP Server (`mcp_config.json` -> `feishu-remote-tools`)**:
  - `feishu_send_message` — send text to Feishu/Lark
  - `feishu_send_card` — send interactive markdown cards
  - `feishu_send_file` — upload and send local images/files
  - `feishu_read_doc` / `feishu_write_doc` — read (including inline/whole comments) or create/append Docx & Wiki pages
  - `feishu_list_tasks` / `feishu_create_task` / `feishu_complete_task` — list, create, and complete Feishu Task v2 tasks via User OAuth (`cli.mjs auth`)
  - `feishu_bridge_status` / `feishu_manage_bridge` — inspect masked config and start/stop/restart/read daemon logs
- **Lifecycle Hook (`hooks.json` -> `feishu-stop-notify`)**:
  - Fires on `Stop` when local desktop/CLI Antigravity sessions finish, sending a completion card with **Take Over Session** and **Switch Directory** buttons (respecting `on` / `away` / `off` notify modes and skipping child sessions).
- **Skill (`skills/feishu-remote/SKILL.md`)** & **Rules (`rules/AGENTS.md`)**:
  - Guides Antigravity on setup, troubleshooting, packaging, and strict credential isolation.

---

## Packaging & Sharing

```bash
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs pack --out ~/Desktop/feishu-remote-plugin.zip
```

The generated archive excludes `node_modules`, `.git`, and `~/.config/antigravity-feishu/`, so it contains zero personal credentials.

## License

[MIT](./LICENSE)
