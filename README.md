# 飞书远程控制 (Feishu Remote) — Antigravity 插件

通过飞书 **WebSocket 长连接**，让你在手机（安卓 / iOS）飞书里直接向本机 Antigravity 发任务、实时看流式卡片进度、继续多轮上下文，并支持本地目录切换、模型/权限模式切换、MCP 主动推送和任务完成通知。

> **免公网 IP / 免内网穿透 / 分享不泄密**
> 个人 `App Secret` 和授权用户白名单统一保存在本机 `~/.config/antigravity-feishu/config.json`（`0600` 权限），插件目录内不含任何个人密钥，打包即可分享给朋友。

---

## 🤖 交给 AI 一键自动部署（Agent Quickstart）

如果你正在使用 **Antigravity / Claude Code / OpenClaw** 等具备终端能力的 AI 助手，**不需要自己手动敲命令**，直接把仓库链接交给它即可完成本地部署。

### 1. 给用户：复制这句话发给你的 AI 助手

```text
请帮我按这个仓库的 README 自动部署飞书远程控制插件：
https://github.com/handais/antigravity-feishu-remote
安装到 ~/.gemini/config/plugins/feishu-remote。如果当前环境支持浏览器操作，也请直接打开飞书开放平台（https://open.feishu.cn/app）帮我完成应用创建、权限导入、长连接事件/回调配置与版本发布，只在需要我扫码登录、二次确认或最后在飞书发“你好”配对时提醒我。
```

### 2. 给 AI 助手（Antigravity / Coding Agent）的部署 SOP

> [!IMPORTANT]
> 请严格按以下步骤依次执行并校验输出；每步失败立即停止并报告原因，不要跳过检查。

#### Step 1 — 前置环境检查
1. 检查系统平台（支持 **macOS `launchd`**、**Linux `systemd --user`**；Windows 请提示用户使用 **WSL2**，或仅可前台运行 `node scripts/bridge-daemon.mjs`）。
2. 检查 Node 版本与 `agy` CLI：
   ```bash
   node -v && which agy
   ```
   - 要求 **`Node.js >= 22.5.0`**（`/desktop` 只读索引与 `Stop` Hook 子代理过滤依赖内置 `node:sqlite`）。若版本过低，请先协助用户升级 Node 或提示安装。
   - 若找不到 `agy`，提醒用户先安装并完成 `agy` 登录验证。

#### Step 2 — 下载插件并安装依赖与体检
1. 若 `~/.gemini/config/plugins/feishu-remote` 尚不存在，克隆仓库并安装生产依赖：
   ```bash
   mkdir -p ~/.gemini/config/plugins
   git clone https://github.com/handais/antigravity-feishu-remote.git ~/.gemini/config/plugins/feishu-remote
   cd ~/.gemini/config/plugins/feishu-remote && npm install --omit=dev
   ```
   *(若已通过 zip 解压到此目录，进入目录执行 `npm install --omit=dev` 即可。)*
2. 运行代码体检与隔离冒烟测试，确认本地环境完全兼容：
   ```bash
   node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs check
   node ~/.gemini/config/plugins/feishu-remote/scripts/smoke-test.mjs
   ```
   - 期望：`cli.mjs check` 输出 `"ok": true` 且 `"errors": []`；`smoke-test.mjs` 输出 `ALL SMOKE TESTS PASSED`。

#### Step 3 — 飞书开放平台配置（支持 Antigravity IDE 浏览器半自动代办）

- **路径 A（推荐，当前 Agent 具备浏览器操作工具 / Antigravity IDE `/browser`）**：
  1. 打开 `https://open.feishu.cn/app`；如果未登录，先**暂停并提示用户扫码登录飞书开放平台**，待用户确认登录后再继续后续点击。
  2. 新建一个企业自建应用（或进入用户指定的已有应用），开启 **应用能力 → 机器人（Bot）**。
  3. 进入 **权限管理 → 批量导入/导出权限**，粘贴下方 **[二、飞书开放平台 3 分钟配置清单](#二飞书开放平台-3-分钟配置清单)** 中的 JSON 一键开通权限（若用户计划建个人话题群免 `@` 使用，顺带确认开通 `im:message.group_msg`）。
  4. 进入 **凭证与基础信息** 获取 `App ID` 与 `App Secret`（若点击查看需要验证码/人工复制，请让用户粘贴或仅在本机运行 `cli.mjs setup`，**绝不在对话回复里明文回显 `App Secret`**）。
  5. **先跑 Step 4 启动本地守护进程再保存长连接**：因为飞书后台开启「使用长连接接收事件/回调」时可能会校验当前应用是否已有在线长连接，建议先完成 Step 4 的 `cli.mjs setup` 与 `cli.mjs start`，确保长连接已连上。
  6. 回到网页 **事件与回调**：将「事件配置」和「回调配置」的订阅方式均设为 **使用长连接接收**，添加事件 `im.message.receive_v1`、`application.bot.menu_v6` 与回调 `card.action.trigger`。
  7. （可选）进入 **机器人自定义菜单** 配置 `menu_panel` / `menu_quick` / `menu_dirs` / `menu_new` / `menu_stop`（响应动作选「推送事件」）。
  8. 进入 **版本管理与发布** → 创建版本（可用范围保持仅自己或指定成员）并提交发布（遇到需人工确认/审核提示时由用户确认）。

- **路径 B（纯命令行环境、无浏览器工具）**：
  - 引导用户按下方 **[二、飞书开放平台 3 分钟配置清单](#二飞书开放平台-3-分钟配置清单)** 操作并发布，向用户索取且**仅索取**两项信息：**`App ID`** 与 **`App Secret`**，再执行 Step 4。

#### Step 4 — 写入配置、启动守护进程与验收
拿到 `App ID` 和 `App Secret` 后执行：
```bash
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs setup \
  --app-id "<APP_ID>" \
  --app-secret "<APP_SECRET>" \
  --cwd "$HOME" \
  --mode accept-edits \
  --notify-mode away

node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs start
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs status
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs scopes
```
- 验收标准：
  - `cli.mjs status` 中 `configured: true` 且 `daemon.running: true`；
  - `cli.mjs scopes` 确认基础 `im:message`、`im:resource`、`cardkit:*` 等权限处于 `granted` 状态（若有 `pending`，提醒用户在飞书后台发布版本）。

#### Step 5 — 首轮配对验活
1. 提示用户在手机/电脑飞书里找到该机器人，**私聊发送一句 `你好`**，触发自动白名单绑定与欢迎卡片。
2. 绑定完成后，可选执行 `node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs test-send --panel` 验证控制面板卡片可正常送达。

#### AI 必守红线与排错速查
- **凭证隔离红线**：严禁将 `appSecret`、`open_id` 写入 `~/.gemini/config/plugins/feishu-remote/` 仓库目录内，也严禁在回复或日志中明文回显 `appSecret`（所有凭证与状态统一由 `cli.mjs setup` 保存在 `~/.config/antigravity-feishu/`，权限 `0600`）。
- **子进程重启禁令**：如果当前任务本身是由飞书桥接拉起的子会话（`FEISHU_REMOTE_BRIDGE_CHILD=1`），禁止自行运行 `cli.mjs restart` 杀掉父守护进程；应提示用户在飞书发 `/reload` 安全重启。
- **常见快速调整**：
  - 话题群免 `@` 触发：确保飞书后台已开通并发布 `im:message.group_msg`，再执行 `cli.mjs setup --group-policy all`（白名单依然仅放行授权 `open_id`）。
  - 调整全局并行任务上限（默认 `4`）：`cli.mjs setup --max-concurrent 2`（16 GB 内存日常推荐 2–4）。
  - 详细维护与排错规则另见仓库内的 `skills/feishu-remote/SKILL.md` 与 `rules/AGENTS.md`。

---

## 一、功能一览

1. **飞书长连接桥接守护进程（Daemon）**：
   - 开机后台常驻（macOS `launchd` / Linux `systemd --user`）。
   - **CardKit 2.0 打字机流式更新**（失败自动降级 `patchCard`），工具步骤原地刷新状态与耗时，页脚展示耗时 / 工具次数 / Token 用量；超长结果自动智能分片且不截断代码块。
   - **消息表情状态反馈**：任务完成后自动在原消息贴上 `DONE` 表情。
   - **任务自动排队 & 失败重试**：上一条任务尚未完成时，后续发送的消息自动排队接力执行（支持一键中止当前立刻执行或取消排队）；中止/异常卡片自带 `🔄 重试` 按钮。
   - **引用回复 & 云文档上下文**：在飞书长按「回复」历史消息、卡片或截图时自动带入上下文；在消息里直接贴 `feishu.cn/docx/...` 或 `/wiki/...` 链接会自动拉取正文给 Antigravity。
   - 每个飞书会话独立记忆工作目录、权限模式（含**临时全权限到期自动降权**）、模型与最近 10 条历史会话。
   - **单群多话题并行（话题群模式）**：在飞书「话题群」中按 `chatId#threadRootId` 自动隔离会话，群内每开一个话题即一个独立并行会话（默认全局最多同时执行 4 个并发任务，可通过 `--max-concurrent` 调整），消息、流式卡片、分片与文件回传全部锁回原话题楼。
   - **安全白名单**：默认首次私聊发消息的账号自动绑定为唯一主人（`autoBindFirstUser`），其他陌生私聊直接拦截并提示其 `open_id`。
2. **飞书常用指令与快捷方式**：
   - **多页可视化控制面板 + 卡片交互按钮**：可在飞书开放平台开启「机器人自定义菜单」与 `card.action.trigger` 长连接回调，不用记命令直接点按钮操作；支持在主控制面板、目录浏览、快捷任务、最近会话和模型切换之间**原地翻页切换**（子页面均带 `⬅️ 返回面板`）。消息回复卡片内也自带「🆕 新对话」「⚙️ 控制面板」「⚡ 快捷任务」「🗂️ 最近会话」及执行中的「🛑 立即中止」按钮。
   - `/panel`（或 `/menu`）：打开带快捷按钮的控制面板（一键切换快捷目录/模式/模型、**⚡ 临时全权30m**、**🌿 Git**、**🔐 权限**、目录浏览器、快捷任务、收藏目录、开新对话、**♻️ 安全重启** / **⏪ 快照回滚**）
   - `/git`：零延迟查看当前工作目录 Git 分支、工作区改动及最近 5 条提交（不经大模型）
   - `/scopes`（或 `/perms`）：自检飞书应用各项能力权限授权状态，有待审权限时支持一键向管理员重发审批申请
   - `/queue`：查看和管理当前对话的排队任务列表（支持单条取消或清空）
   - `/doc`：读取或生成飞书云文档（`/doc <链接|ID>`、`/doc create 标题 | Markdown`、`/doc write 链接 | Markdown`）
   - `/ops`（或 `/backups`）：打开**运维与自迭代面板**（查看运行版本 vs 磁盘版本、触发代码体检、保存快照、安全重启、二次确认回滚历史快照）
   - `/reload`：执行语法 + ESM 导入双阶段预检，通过后安全重启守护进程并推送上线确认卡片
   - `/check`：仅执行插件脚本代码体检（`node --check` + 导入导出检查），不重启
   - `/snapshot` / `/rollback [快照ID]`：手动保存当前可用快照，或回滚到上一版快照（带确认按钮）
   - `/dirs`：打开交互式**目录浏览卡片**（支持进入子目录、返回上一级、`🏠 ~`、一键 `📌 收藏/取消收藏此目录`）
   - `/quick`：打开**一键快捷任务卡片**，点击按钮直接触发预设 Prompt；支持点击 `🗑️ 管理/删除` 按钮图形化管理，或用 `/quick add 名称 | 提示词`、`/quick del <序号>`、`/quick reset` 自定义或恢复默认
   - `/help`：查看全部命令
   - `/status`：查看当前工作目录、模式（含临时全权倒计时）、模型、队列条数、会话 ID 与运行状态
   - `/new`：开启新对话（清空当前上下文绑定）
   - `/sessions` / `/use <序号|ID>`：查看并切回最近飞书会话（顶部支持一键切换到 **`💻 电脑对话`**）
   - `/desktop [关键词]`（别名 `/pc`）：只读扫描与全文检索本机 CLI / 桌面端历史对话，预览最近上下文并支持**双轨接管**（CLI 对话 `--conversation` 原生直连；桌面端独立会话自动挂载只读上下文接力，可选 `✅ 接管并切目录` 或 `👀 接管并总结进展`）
   - `/cd <路径或关键词>`（或 `/cwd`）：切换执行目录；支持模糊关键词匹配常用目录并弹出候选按钮
   - `/send <文件路径>`（或 `/sendfile <路径>`）：把本机图片或文件直接发回飞书（加 `--file` 强制按文件发送）
   - `/pin`：收藏 / 取消收藏当前目录到控制面板快捷目录
   - `/mode [accept-edits|plan|auto|full|default|full 30m]`：查看或切换执行权限模式（支持 `/mode full 30m` 临时全权限并在到期后自动切回安全模式）
   - `/timeout [分钟|0]`：查看或设置单轮任务超时时间（默认 60 分钟；`/timeout 0` 不限时，CardKit 超过 10 分钟流式窗口会自动无缝切为全卡刷新）
   - `/effort [low|medium|high|xhigh|max|default]`：查看或切换推理强度（控制面板也可直接点 `🎛️ 强度`）
   - `/notify [on|away [分钟]|off]`（别名 `/mute` / `/unmute`）：切换桌面端完成提醒（始终 / 仅离开电脑时通过键鼠空闲检测提醒 / 关闭）
   - `/model [模型名|default]` / `/models`：查看可用模型或切换模型（支持点击按钮切换）
   - `/stop`（或 `/cancel`）：立即中止当前正在执行的任务
   - **多模态收发**：手机直接发送图片/截图、文件（PDF/代码/文档）、语音或图文混排，自动下载至 `~/.config/antigravity-feishu/inbox/`（7 天自动清理）并由 Antigravity 原生读取分析。
   - **基础存储与性能治理**：`mcp-server.mjs` 按需懒加载飞书 SDK；守护进程默认 `warn` 级静音，启动及每 24 小时自动原地截断超 5 MB 的日志文件，并限制 `inbox/` 附件 7 天过期与 200 MB 总上限。
3. **MCP 主动推送与文档工具（`feishu-remote-tools`）**：
   - `feishu_send_message` / `feishu_send_card` / `feishu_send_file`：让桌面端 Antigravity 主动向你手机发汇报或回传本地图片/文件。
   - `feishu_read_doc` / `feishu_write_doc`：读取飞书云文档/Wiki，或将 Markdown 分析报告直接新建/追加写入飞书云文档。
   - `feishu_bridge_status` / `feishu_manage_bridge`：直接查询或启停桥接后台服务。
4. **任务完成提醒 & 电脑→手机接力 Hook（`Stop`）**：
   - 当你在电脑端发起的任务执行结束时，自动给绑定的飞书账号发送完成卡片（带 **`📱 接管此对话`** 与 **`📂 切到此目录`** 按钮，点一下即可在手机飞书无缝续聊电脑端上下文；由飞书桥接拉起的子任务会自动跳过）。

---

## 二、飞书开放平台 3 分钟配置清单

1. 登录 [飞书开放平台](https://open.feishu.cn/app) → 进入你的 **企业自建应用**。
2. **添加应用能力**：开启 **机器人（Bot）**。
   - **权限管理**（也支持在飞书开放平台「权限管理 → 批量导入/导出权限」直接粘贴下方 JSON 一键导入）：
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
      "docx:document:readonly",
      "docx:document:write_only",
      "docx:document.block:convert",
      "wiki:node:read"
    ]
  }
}
```
   - 权限详细说明：
   - **基础必需**：
     - `im:message`（获取与发送单聊、群组消息）
     - `im:message:send_as_bot`（以应用身份发消息）
     - `im:message.p2p_msg:readonly`（读取用户发给机器人的单聊消息）
     - `im:resource`（获取与上传图片或文件资源 — 手机端发图片/文件/语音及 `/send` 回传必需）
   - **增强交互 & 云文档（强烈推荐）**：
     - `cardkit:card:write` / `cardkit:card:read`（CardKit 2.0 打字机流式更新）
     - `im:message.reactions:write_only` / `im:message.reactions:read`（消息表情状态反馈）
     - `im:message:readonly`（读取引用回复的历史消息与卡片内容）
     - `docx:document:readonly` / `docx:document:write_only` / `docx:document.block:convert` / `wiki:node:read`（飞书云文档与 Wiki 读取/写入）
     - `im:message.group_at_msg:readonly`（可选，如需在群里 `@机器人` 使用）
     - `im:message.group_msg`（可选，仅在配合 `--group-policy all` 实现单人话题群免 `@` 直接打字触发时需要）
4. **事件与回调**：
   - **事件配置**：订阅方式选择 **「使用长连接接收事件」**，添加事件 **`im.message.receive_v1`**（接收消息 v2.0）和 **`application.bot.menu_v6`**（机器人自定义菜单事件，用于响应底部菜单点击）。
   - **回调配置**：订阅方式选择 **「使用长连接接收回调」**，添加回调 **`card.action.trigger`**（用于响应控制面板、目录浏览、快捷任务、队列、权限、Git、重试等卡片按钮点击）。
5. **机器人自定义菜单（推荐，不用打字直接点）**：
   - 在 **应用能力 → 机器人 → 机器人自定义菜单** 中开启（推荐「悬浮菜单」或底部菜单）。
   - 每个菜单项推荐把「响应动作」设为 **「推送事件」**，Event Key 可设为：
     - `menu_panel`（打开控制面板）
     - `menu_quick`（打开一键快捷任务）
     - `menu_dirs`（打开目录浏览）
     - `menu_new`（开启新对话）
     - `menu_stop`（中止当前任务）
     - （也支持 `menu_effort`、`menu_git`、`menu_scopes`、`menu_queue`、`menu_mode_temp_full`、`menu_ops`、`menu_reload`、`menu_sessions`、`menu_models`、`menu_mode_full`、`menu_help`）
   - 若偏好「发送消息」模式，也可以把动作设为发送 `/panel`、`/quick`、`/dirs`、`/new`、`/stop`。
6. **版本管理与发布**：创建版本并发布（如果只给自己用，可发布为仅自己/指定测试人员可见）。
7. 在 **凭证与基础信息** 页面复制 **`App ID`** 和 **`App Secret`**。

---

## 三、本机安装与启动

> **环境要求**：`Node.js 22.5+`（`/desktop` 只读索引扫描依赖内置 `node:sqlite`）及已登录的 `agy` CLI。守护进程托管支持 **macOS (`launchd`)** 与 **Linux (`systemd --user`)**；Windows 建议在 WSL2 中安装运行，或通过前台方式运行 `node scripts/bridge-daemon.mjs`。

### 1. 克隆并安装依赖
```bash
git clone https://github.com/handais/antigravity-feishu-remote.git ~/.gemini/config/plugins/feishu-remote
cd ~/.gemini/config/plugins/feishu-remote && npm install --omit=dev
```

### 2. 写入配置
```bash
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs setup \
  --app-id "你的_APP_ID" \
  --app-secret "你的_APP_SECRET" \
  --cwd "$HOME" \
  --mode accept-edits
```
> 国内代理说明：本插件默认会隔离代理环境——飞书长连接与 REST API **直连**（避免本地 `socks5://` 环境变量导致断连），同时自动检测本机 HTTP 代理并仅注入给底层 `agy` 子进程。如需手动指定，可传 `--proxy http://127.0.0.1:7897`。

### 3. 启动守护进程
```bash
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs start
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs status
```

### 4. 在手机飞书里配对
打开手机飞书，搜你的机器人名字，在**私聊**里给它发一句 `你好`（或 `/help`）。  
机器人会自动绑定你的飞书 `open_id` 为白名单主人并回复欢迎卡片，随后即可直接发任务使用！

### 5. 常用运维命令
```bash
# 查看状态
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs status

# 查看最近 50 行日志
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs logs --lines 50

# 发送测试卡片 / 直接推送控制面板 / 发送本机文件回飞书
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs test-send
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs test-send --panel
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs test-send --quick
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs test-send --dirs
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs send-file ~/Desktop/screenshot.png

# 添加 / 重置自定义快捷任务按钮
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs setup --add-quick "🔍 查日志|请检查最近错误日志并定位原因"
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs setup --reset-quick

# 代码体检 / 安全重启 / 快照与回滚
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs check
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs safe-restart
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs backups
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs snapshot
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs rollback

# 飞书应用权限自检 & 云文档读写 & 电脑端会话扫描
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs scopes
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs read-doc "https://xxx.feishu.cn/docx/..."
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs write-doc --title "分析报告" --file ./report.md
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs desktop --limit 5
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs desktop --query "关键词" --limit 5

# 重启 / 停止
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs restart
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs stop
```

---

## 四、如何打包分享给朋友？

直接运行打包命令（会自动排除 `node_modules` 和任何个人敏感配置）：

```bash
node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs pack --out ~/Desktop/feishu-remote-plugin.zip
```

### 朋友收到 zip 后的安装步骤（4 步）
1. 确保朋友电脑上已安装 `Node.js`（22.5+）和 `agy` CLI（并已登录）。
2. 把 zip 解压到他自己电脑的 `~/.gemini/config/plugins/feishu-remote/`。
3. 安装依赖并写入他自己的飞书应用凭证：
   ```bash
   cd ~/.gemini/config/plugins/feishu-remote && npm install --omit=dev
   node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs setup --app-id "他的AppID" --app-secret "他的AppSecret"
   node ~/.gemini/config/plugins/feishu-remote/scripts/cli.mjs start
   ```
4. 他自己在手机飞书私聊自己的机器人发一条消息，即可自动绑定并开始使用。
