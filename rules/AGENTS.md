# Feishu Remote Plugin Rules

- Never write `appSecret`, `open_id` credentials, OAuth tokens, or personal tokens inside the `feishu-remote` plugin directory (e.g. `~/.gemini/config/plugins/feishu-remote/`). All user credentials and runtime state belong strictly in `~/.config/antigravity-feishu/` (`config.json`, `state.json`, and `user-auth.json`, file mode `0600`).
- When the user asks to configure, start, stop, inspect, troubleshoot, or package Feishu remote control, activate and follow the `feishu-remote` skill (`skills/feishu-remote/SKILL.md`).
- When the user asks to push a notification, progress report, or summary card to their phone via Feishu, use the `feishu-remote-tools` MCP tools (`feishu_send_card` or `feishu_send_message`) instead of ad-hoc curl scripts.
- When the user asks to sync progress back from mobile Feishu to Desktop App (e.g., "同步一下手机进度"), use `feishu_list_mobile_sessions` and `feishu_read_mobile_session` to fetch the mobile CLI transcript, modified files, and latest conclusion.
- Never leak `appSecret` values in replies, logs, or packaged archives.
