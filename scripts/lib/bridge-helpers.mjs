import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { VALID_EFFORTS, VALID_MODES } from './agy-runner.mjs';
import { expandHomePath } from './io-utils.mjs';

const execFileAsync = promisify(execFile);
export { expandHomePath };
import {
  buildCard,
  buildOpsCard,
  chunkButtons,
  replyCard,
  sanitizeForFeishuMarkdown,
  sendCard,
} from './feishu-api.mjs';
import { computePluginCodeHash, listBackupSnapshots } from './self-ops.mjs';

export function normalizeTempMinutes(raw, fallback = 30) {
  const cleaned = String(raw || '').trim().replace(/m(?:in)?$/i, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(240, Math.round(n)));
}

export function stripMentions(text, mentions = []) {
  let out = String(text || '').replace(/@_user_\d+/g, '');
  if (Array.isArray(mentions) && mentions.length > 0) {
    for (const m of mentions) {
      const name = String(m?.name || '').trim();
      if (!name) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`@${escaped}(?=\\s|$)`, 'g'), '');
    }
  }
  return out
    .replace(/\s+/g, (m) => (m.includes('\n') ? m : ' '))
    .trim();
}

export function makeSessionKey(chatId, threadRootId = '') {
  const cid = String(chatId || '').trim();
  const tid = String(threadRootId || '').trim();
  if (cid && tid) return `${cid}#${tid}`;
  return cid;
}

export function parseSessionKey(sessionKey) {
  const raw = String(sessionKey || '').trim();
  const idx = raw.indexOf('#');
  if (idx < 0) {
    return { chatId: raw, threadRootId: '' };
  }
  return {
    chatId: raw.slice(0, idx),
    threadRootId: raw.slice(idx + 1),
  };
}

export function getOrCreateChatState(state, chatId, config) {
  if (!state.chats[chatId]) {
    const { chatId: parentChatId, threadRootId } = parseSessionKey(chatId);
    const parentState = threadRootId && parentChatId ? state.chats[parentChatId] : null;
    const baseMode = parentState?.mode && parentState.mode !== 'full'
      ? parentState.mode
      : (config.agy.defaultMode || 'accept-edits');
    state.chats[chatId] = {
      conversationId: '',
      cwd: parentState?.cwd || config.agy.defaultCwd || os.homedir(),
      mode: baseMode,
      model: parentState?.model !== undefined ? parentState.model : (config.agy.defaultModel || ''),
      effort: parentState?.effort !== undefined ? parentState.effort : (config.agy.defaultEffort || ''),
      recentConversations: [],
      pendingHandoff: null,
      pendingCommand: null,
      originDesktopSession: null,
      lastTurnArtifacts: null,
      topicClosed: false,
      fullExpiresAt: 0,
      fullRevertMode: baseMode,
      lastActiveAt: Date.now(),
    };
  } else {
    if (state.chats[chatId].fullExpiresAt === undefined) {
      state.chats[chatId].fullExpiresAt = 0;
    }
    if (!state.chats[chatId].fullRevertMode) {
      state.chats[chatId].fullRevertMode = config.agy.defaultMode || 'accept-edits';
    }
    if (state.chats[chatId].effort === undefined) {
      state.chats[chatId].effort = '';
    }
    if (state.chats[chatId].pendingHandoff === undefined) {
      state.chats[chatId].pendingHandoff = null;
    }
    if (state.chats[chatId].pendingCommand === undefined) {
      state.chats[chatId].pendingCommand = null;
    }
    if (state.chats[chatId].originDesktopSession === undefined) {
      state.chats[chatId].originDesktopSession = null;
    }
    if (state.chats[chatId].lastTurnArtifacts === undefined) {
      state.chats[chatId].lastTurnArtifacts = null;
    }
    if (state.chats[chatId].topicClosed === undefined) {
      state.chats[chatId].topicClosed = false;
    }
    state.chats[chatId].lastActiveAt = Date.now();
  }
  return state.chats[chatId];
}

export function resolveDefaultTopicChatId(state, config, currentChatId = '', isTopicThread = false) {
  if (isTopicThread && currentChatId) {
    return String(currentChatId).trim();
  }
  const configured = String(config?.notifications?.defaultTopicChatId || '').trim();
  if (configured) {
    return configured;
  }
  const remembered = String(state?.lastTopicChatId || '').trim();
  if (remembered) {
    return remembered;
  }
  let bestChatId = '';
  let bestActiveAt = -1;
  for (const [key, info] of Object.entries(state?.chats || {})) {
    if (!key.includes('#')) continue;
    const { chatId } = parseSessionKey(key);
    if (!chatId) continue;
    const activeAt = Number(info?.lastActiveAt || 0);
    if (activeAt > bestActiveAt) {
      bestActiveAt = activeAt;
      bestChatId = chatId;
    }
  }
  return bestChatId;
}

export function findBoundTopicForConversation(state, conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return null;

  let best = null;
  let bestActiveAt = -1;
  for (const [key, info] of Object.entries(state?.chats || {})) {
    if (!key.includes('#') || !info || info.topicClosed) continue;
    const { chatId, threadRootId } = parseSessionKey(key);
    if (!chatId || !threadRootId) continue;

    let matchType = '';
    if (info.conversationId === id) {
      matchType = 'cli';
    } else if (info.originDesktopSession?.id === id || info.pendingHandoff?.id === id) {
      matchType = 'desktop';
    }
    if (!matchType) continue;

    const activeAt = Number(info.lastActiveAt || 0);
    if (!best || activeAt > bestActiveAt) {
      bestActiveAt = activeAt;
      best = {
        sessionKey: key,
        chatId,
        threadRootId,
        chatState: info,
        matchType,
      };
    }
  }
  return best;
}

export function enforceTempFullExpiry(state, chatState) {
  const expiresAt = Number(chatState?.fullExpiresAt || 0);
  if (chatState?.mode === 'full' && expiresAt > 0 && Date.now() >= expiresAt) {
    const revertTo = chatState.fullRevertMode && chatState.fullRevertMode !== 'full'
      ? chatState.fullRevertMode
      : 'accept-edits';
    chatState.mode = revertTo;
    chatState.fullExpiresAt = 0;
    return { expired: true, previousMode: 'full', revertedTo: revertTo };
  }
  return { expired: false, previousMode: chatState?.mode || '', revertedTo: chatState?.mode || '' };
}

export function recordRecentConversation(chatState, conversationId, prompt, meta = {}) {
  if (!conversationId) return;
  const list = Array.isArray(chatState.recentConversations) ? chatState.recentConversations : [];
  const existing = list.find((item) => item.id === conversationId);
  const summary = String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  const filtered = list.filter((item) => item.id !== conversationId);
  const entry = {
    id: conversationId,
    summary,
    updatedAt: new Date().toISOString(),
  };
  const resolvedCwd = meta.cwd || existing?.cwd || chatState?.cwd || '';
  const originDesktopId = meta.originDesktopId !== undefined
    ? meta.originDesktopId
    : (existing?.originDesktopId || '');
  const originDesktopTitle = meta.originDesktopTitle !== undefined
    ? meta.originDesktopTitle
    : (existing?.originDesktopTitle || '');
  if (resolvedCwd) entry.cwd = resolvedCwd;
  if (originDesktopId) entry.originDesktopId = originDesktopId;
  if (originDesktopTitle) entry.originDesktopTitle = originDesktopTitle;
  filtered.unshift(entry);
  chatState.recentConversations = filtered.slice(0, 10);
}

export function formatUptime(ms) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

export function formatTimeoutLabel(sec) {
  const n = Number(sec);
  if (!n || n <= 0) return '不限时';
  const s = Math.floor(n);
  if (s >= 60) {
    return `${Math.round(s / 60)} 分钟（${s}s）`;
  }
  return `${s} 秒`;
}

export function parseTimeoutArg(rawArg) {
  const raw = String(rawArg || '').trim().toLowerCase();
  if (!raw) return null;
  if (['0', '0s', '0m', '0h', 'off', 'none', 'unlimited', '无限', '不限时'].includes(raw)) {
    return 0;
  }
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|小时|m|min|mins|minute|minutes|分钟|s|sec|secs|秒)?$/);
  if (!m) return null;
  const val = Number(m[1]);
  const unit = m[2] || 'm';
  if (!Number.isFinite(val) || val < 0) return null;
  if (val === 0) return 0;

  let rawSec;
  if (unit.startsWith('h') || unit === '小时') {
    rawSec = Math.round(val * 3600);
  } else if (unit.startsWith('s') || unit === '秒') {
    rawSec = Math.round(val);
  } else {
    rawSec = Math.round(val * 60);
  }
  return Math.max(30, Math.min(86400, rawSec));
}

export function collectGitInfo(cwd) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return {
      isRepo: false,
      branch: '',
      statusLines: [],
      commits: [],
      error: String(err?.stderr || err?.message || '当前目录不是 Git 仓库').trim(),
    };
  }

  let statusRaw = '';
  let logRaw = '';
  try {
    statusRaw = execFileSync('git', ['status', '--short', '--branch'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return {
      isRepo: true,
      branch: '',
      statusLines: [],
      commits: [],
      error: String(err?.stderr || err?.message || 'git status 失败').trim(),
    };
  }
  try {
    logRaw = execFileSync('git', ['log', '-n', '5', '--oneline'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    logRaw = '';
  }

  const lines = statusRaw.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const branchHeader = lines[0]?.startsWith('## ') ? lines[0].slice(3).trim() : '';
  const statusLines = lines[0]?.startsWith('## ') ? lines.slice(1) : lines;
  const commits = logRaw.split('\n').map((l) => l.trim()).filter(Boolean);

  return {
    isRepo: true,
    branch: branchHeader,
    statusLines,
    commits,
    error: '',
  };
}

/**
 * Collect git diff (or file metadata for non-git workspaces) for files touched in a turn.
 */
export function collectTurnDiff(cwd, files = [], { maxChars = 4200 } = {}) {
  const baseCwd = cwd || process.cwd();
  const normalizedFiles = [...new Set((Array.isArray(files) ? files : []).filter(Boolean))];
  const existingFiles = [];
  for (const f of normalizedFiles) {
    try {
      const abs = path.isAbsolute(f) ? f : path.resolve(baseCwd, f);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const st = fs.statSync(abs);
        existingFiles.push({
          path: abs,
          name: path.basename(abs),
          sizeBytes: st.size,
          mtimeIso: st.mtime.toISOString(),
        });
      }
    } catch {
      // Ignore inaccessible file
    }
  }

  let isRepo = false;
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: baseCwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    isRepo = true;
  } catch {
    isRepo = false;
  }

  if (!isRepo) {
    return {
      isRepo: false,
      stat: '',
      diff: '',
      truncated: false,
      untrackedFiles: [],
      existingFiles,
    };
  }

  const relTargets = [];
  for (const f of normalizedFiles) {
    const abs = path.isAbsolute(f) ? f : path.resolve(baseCwd, f);
    const rel = path.relative(baseCwd, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      relTargets.push(rel);
    }
  }
  const pathArgs = relTargets.length > 0 ? ['--', ...relTargets] : [];

  let stat = '';
  let diff = '';
  let untrackedFiles = [];
  try {
    stat = execFileSync('git', ['diff', '--stat', ...pathArgs], {
      cwd: baseCwd,
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    stat = '';
  }
  try {
    diff = execFileSync('git', ['diff', '--no-color', ...pathArgs], {
      cwd: baseCwd,
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    diff = '';
  }
  try {
    const statusOut = execFileSync('git', ['status', '--porcelain', ...pathArgs], {
      cwd: baseCwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    untrackedFiles = statusOut
      .split(/\r?\n/)
      .filter((line) => line.startsWith('?? '))
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    untrackedFiles = [];
  }

  const limit = Math.max(400, Number(maxChars) || 4200);
  const truncated = diff.length > limit;
  if (truncated) {
    diff = `${diff.slice(0, limit)}\n...(diff 较长已截断，完整内容请回电脑查看)`;
  }

  return {
    isRepo: true,
    stat,
    diff,
    truncated,
    untrackedFiles,
    existingFiles,
  };
}

/**
 * Asynchronous git branch/status/log inspection for interactive daemon handlers.
 */
export async function collectGitInfoAsync(cwd) {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
    });
  } catch (err) {
    return {
      isRepo: false,
      branch: '',
      statusLines: [],
      commits: [],
      error: String(err?.stderr || err?.message || '当前目录不是 Git 仓库').trim(),
    };
  }

  let statusRaw = '';
  try {
    const res = await execFileAsync('git', ['status', '--short', '--branch'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
    });
    statusRaw = res.stdout || '';
  } catch (err) {
    return {
      isRepo: true,
      branch: '',
      statusLines: [],
      commits: [],
      error: String(err?.stderr || err?.message || 'git status 失败').trim(),
    };
  }

  let logRaw = '';
  try {
    const res = await execFileAsync('git', ['log', '-n', '5', '--oneline'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
    });
    logRaw = res.stdout || '';
  } catch {
    logRaw = '';
  }

  const lines = statusRaw.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const branchHeader = lines[0]?.startsWith('## ') ? lines[0].slice(3).trim() : '';
  const statusLines = lines[0]?.startsWith('## ') ? lines.slice(1) : lines;
  const commits = logRaw.split('\n').map((l) => l.trim()).filter(Boolean);

  return {
    isRepo: true,
    branch: branchHeader,
    statusLines,
    commits,
    error: '',
  };
}

/**
 * Asynchronous git diff collector for interactive card handlers.
 */
export async function collectTurnDiffAsync(cwd, files = [], { maxChars = 4200 } = {}) {
  const baseCwd = cwd || process.cwd();
  const normalizedFiles = [...new Set((Array.isArray(files) ? files : []).filter(Boolean))];
  const existingFiles = [];
  for (const f of normalizedFiles) {
    try {
      const abs = path.isAbsolute(f) ? f : path.resolve(baseCwd, f);
      const st = await fs.promises.stat(abs);
      if (st.isFile()) {
        existingFiles.push({
          path: abs,
          name: path.basename(abs),
          sizeBytes: st.size,
          mtimeIso: st.mtime.toISOString(),
        });
      }
    } catch {
      // Ignore inaccessible file
    }
  }

  let isRepo = false;
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: baseCwd,
      encoding: 'utf8',
      timeout: 3000,
    });
    isRepo = true;
  } catch {
    isRepo = false;
  }

  if (!isRepo) {
    return {
      isRepo: false,
      stat: '',
      diff: '',
      truncated: false,
      untrackedFiles: [],
      existingFiles,
    };
  }

  const relTargets = [];
  for (const f of normalizedFiles) {
    const abs = path.isAbsolute(f) ? f : path.resolve(baseCwd, f);
    const rel = path.relative(baseCwd, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      relTargets.push(rel);
    }
  }
  const pathArgs = relTargets.length > 0 ? ['--', ...relTargets] : [];

  const [statRes, diffRes, statusRes] = await Promise.all([
    execFileAsync('git', ['diff', '--stat', ...pathArgs], { cwd: baseCwd, encoding: 'utf8', timeout: 4000 }).catch(() => ({ stdout: '' })),
    execFileAsync('git', ['diff', '--no-color', ...pathArgs], { cwd: baseCwd, encoding: 'utf8', timeout: 4000 }).catch(() => ({ stdout: '' })),
    execFileAsync('git', ['status', '--porcelain', ...pathArgs], { cwd: baseCwd, encoding: 'utf8', timeout: 3000 }).catch(() => ({ stdout: '' })),
  ]);

  const stat = (statRes.stdout || '').trim();
  let diff = (diffRes.stdout || '').trim();
  const untrackedFiles = (statusRes.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  const limit = Math.max(400, Number(maxChars) || 4200);
  const truncated = diff.length > limit;
  if (truncated) {
    diff = `${diff.slice(0, limit)}\n...(diff 较长已截断，完整内容请回电脑查看)`;
  }

  return {
    isRepo: true,
    stat,
    diff,
    truncated,
    untrackedFiles,
    existingFiles,
  };
}

export function formatHelpMarkdown() {
  return [
    '直接发送任务描述（支持截图/文件/语音、引用历史消息回复、直接贴飞书文档/知识库链接）即可在 Mac 本机执行。',
    '',
    '**常用控制指令：**',
    '- `/panel`（或 `/menu`）：打开控制面板（支持一键切换目录/模式/模型/强度、临时全权、Git、权限自检）',
    '- `/git`：秒查当前目录 Git 分支、变更文件与最近 5 条提交',
    '- `/scopes`（或 `/perms`）：自检飞书应用授权状态，支持一键向管理员重发待审权限申请',
    '- `/queue`：查看或取消正在排队等待的任务',
    '- `/doc <链接|ID>` / `/doc create 标题 | Markdown` / `/doc write 链接 | Markdown`：读取或生成飞书云文档',
    '- `/tasks`（或 `/todo`）：查看、新建、勾选完成或一键执行飞书任务中心待办（需先运行 `cli.mjs auth` 授权）',
    '- `/ops`（或 `/backups`）：打开运维与自迭代面板（安全重启 / 代码体检 / 快照回滚）',
    '- `/reload` / `/check` / `/snapshot` / `/rollback [ID]`：代码检查、快照、安全重启与回滚',
    '- `/dirs` / `/cd <路径或关键词>` / `/pin`：浏览、模糊匹配或收藏工作目录',
    '- `/` 或 `/skills`（悬浮菜单 `menu_commands`）：查看 `agy` 内置命令与本机已安装 Skills 清单（支持点选一键预选命令前缀、一键 `/compact`、`/agy <原始命令>` 强制透传）',
    '- `/status` / `/new` / `/sessions` / `/use <序号|ID>` / `/help`',
    '- `/desktop [关键词]`（别名 `/pc`）：扫描或全文搜索电脑端历史对话并预览接管',
    '- `/topic [set|clear]` / `/unlink`：查看/设置默认接管话题群，或结束当前话题楼与电脑端的自动回流追踪',
    '- `/handoff [cli|desktop]`（别名 `/back`）：生成回电脑端继续的命令与交接提示词（自动复制剪贴板）',
    '- `/guard [on|off]`（别名 `/approval`）：查看或开关高危命令（如 `rm -rf`、`git push --force`）飞书确认审批',
    '- `/send <文件路径>`（可加 `--file`）：上传并回传本机图片或文件到飞书',
    `- \`/mode [模式|full 30m]\`：切换权限模式（\`${VALID_MODES.join('` / `')}\`，支持 \`/mode full 30m\` 临时授权自动降权）`,
    '- `/timeout [分钟|0]`：查看或设置单轮任务超时时间（如 `/timeout 60`，`/timeout 0` 表示不限时）',
    `- \`/effort [强度|default]\`：切换推理强度（\`${VALID_EFFORTS.join('` / `')}\` / \`default\`）`,
    '- `/model [模型名|default]` / `/models`：查看或切换模型',
    '- `/notify [on|away|off]`（别名 `/mute`）：切换电脑端完成提醒（始终 / 仅离开电脑 / 关闭）',
    '- `/stop`（或 `/cancel`）：中止当前正在执行的任务',
  ].join('\n');
}

/**
 * Collect Feishu session history for the current chat/thread or aggregated across all Feishu windows.
 */
export function collectFeishuSessions(state, currentSessionKey = '', { scope = 'all', limit = 10 } = {}) {
  const normalizedScope = scope === 'current' ? 'current' : 'all';
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const { chatId: curChatId, threadRootId: curThreadRootId } = parseSessionKey(currentSessionKey);
  const p2pChatIds = new Set(Object.values(state?.lastP2pChatByOpenId || {}).filter(Boolean));

  const classifySource = (chatKey) => {
    if (chatKey === currentSessionKey) {
      return { sourceKind: 'current', sourceLabel: curThreadRootId ? '本话题' : '本窗口' };
    }
    if (chatKey.includes('#')) {
      const { chatId: keyChatId } = parseSessionKey(chatKey);
      if (curChatId && keyChatId === curChatId) {
        return { sourceKind: 'same_group_topic', sourceLabel: '同群话题' };
      }
      return { sourceKind: 'other_topic', sourceLabel: '话题' };
    }
    if (p2pChatIds.has(chatKey) || chatKey.startsWith('ou_')) {
      return { sourceKind: 'p2p', sourceLabel: '私聊' };
    }
    return { sourceKind: 'other_chat', sourceLabel: '其他群' };
  };

  if (normalizedScope === 'current') {
    const curState = state?.chats?.[currentSessionKey];
    const recent = Array.isArray(curState?.recentConversations) ? curState.recentConversations : [];
    const src = classifySource(currentSessionKey);
    return recent
      .filter((item) => item?.id)
      .slice(0, normalizedLimit)
      .map((item) => ({
        id: String(item.id),
        summary: String(item.summary || ''),
        updatedAt: String(item.updatedAt || ''),
        updatedAtMs: Date.parse(item.updatedAt || '') || 0,
        cwd: String(item.cwd || curState?.cwd || ''),
        chatKey: currentSessionKey,
        ...src,
      }));
  }

  const byId = new Map();
  for (const [chatKey, info] of Object.entries(state?.chats || {})) {
    if (!info || typeof info !== 'object') continue;
    const src = classifySource(chatKey);
    const recent = Array.isArray(info.recentConversations) ? info.recentConversations : [];
    for (const item of recent) {
      const id = String(item?.id || '').trim();
      if (!id) continue;
      const updatedAt = String(item.updatedAt || '');
      const updatedAtMs = Date.parse(updatedAt) || 0;
      const summary = String(item.summary || '');
      const cwd = String(item.cwd || info.cwd || '');
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, {
          id,
          summary,
          updatedAt,
          updatedAtMs,
          cwd,
          chatKey,
          ...src,
        });
        continue;
      }

      const isNewer = updatedAtMs > prev.updatedAtMs;
      let chosenSource = isNewer ? { chatKey, ...src } : { chatKey: prev.chatKey, sourceKind: prev.sourceKind, sourceLabel: prev.sourceLabel };
      if (src.sourceKind === 'current') {
        chosenSource = { chatKey, ...src };
      } else if (prev.sourceKind === 'current') {
        chosenSource = { chatKey: prev.chatKey, sourceKind: prev.sourceKind, sourceLabel: prev.sourceLabel };
      }

      byId.set(id, {
        id,
        summary: isNewer ? (summary || prev.summary) : (prev.summary || summary),
        updatedAt: isNewer ? (updatedAt || prev.updatedAt) : (prev.updatedAt || updatedAt),
        updatedAtMs: Math.max(updatedAtMs, prev.updatedAtMs),
        cwd: isNewer ? (cwd || prev.cwd) : (prev.cwd || cwd),
        ...chosenSource,
      });
    }

    const activeId = String(info.conversationId || '').trim();
    if (activeId && !byId.has(activeId)) {
      const activeMs = Number(info.lastActiveAt || 0);
      byId.set(activeId, {
        id: activeId,
        summary: '',
        updatedAt: activeMs ? new Date(activeMs).toISOString() : '',
        updatedAtMs: activeMs,
        cwd: String(info.cwd || ''),
        chatKey,
        ...src,
      });
    }
  }

  return [...byId.values()]
    .sort((a, b) => (
      (b.updatedAtMs - a.updatedAtMs) ||
      ((b.sourceKind === 'current' ? 1 : 0) - (a.sourceKind === 'current' ? 1 : 0))
    ))
    .slice(0, normalizedLimit);
}

export function buildSessionsCard(chatState, { state = null, sessionKey = '', scope = 'all' } = {}) {
  const normalizedScope = scope === 'current' ? 'current' : 'all';
  const isTopic = Boolean(parseSessionKey(sessionKey).threadRootId);
  const currentTabLabel = isTopic ? '🧵 本话题' : '💬 本窗口';
  const list = state && sessionKey
    ? collectFeishuSessions(state, sessionKey, { scope: normalizedScope, limit: 10 })
    : (Array.isArray(chatState?.recentConversations) ? chatState.recentConversations.slice(0, 10) : []);

  const tabRow = [
    {
      label: '📱 全部飞书',
      type: normalizedScope === 'all' ? 'primary' : 'default',
      value: { cmd: 'sessions', scope: 'all', inplace: true },
    },
    {
      label: currentTabLabel,
      type: normalizedScope === 'current' ? 'primary' : 'default',
      value: { cmd: 'sessions', scope: 'current', inplace: true },
    },
    {
      label: '💻 电脑对话',
      value: { cmd: 'desktop_list', filter: 'all', inplace: true },
    },
  ];

  if (list.length === 0) {
    const hasAnyGlobal = normalizedScope === 'current' &&
      state &&
      collectFeishuSessions(state, sessionKey, { scope: 'all', limit: 1 }).length > 0;

    if (hasAnyGlobal) {
      return buildCard({
        title: isTopic ? '🗂️ 最近会话 · 本话题' : '🗂️ 最近会话 · 本窗口',
        template: 'grey',
        markdown: isTopic
          ? '当前话题楼还没有飞书历史会话记录，可点击 **📱 全部飞书** 查看其他话题/私聊会话，或点 **💻 电脑对话** 扫描本机历史对话。'
          : '当前窗口还没有飞书历史会话记录，可点击 **📱 全部飞书** 查看其他话题/私聊会话，或点 **💻 电脑对话** 扫描本机历史对话。',
        buttonRows: [
          tabRow,
          [
            { label: '🆕 新对话', value: { cmd: 'new', inplace: true } },
            { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
          ],
        ],
      });
    }

    return buildCard({
      title: '🗂️ 最近会话',
      template: 'grey',
      markdown: '当前聊天还没有飞书历史会话记录，可点击下方按钮扫描电脑端历史对话。',
      buttonRows: [
        tabRow,
        [{ label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } }],
      ],
    });
  }

  const lines = list.map((item, idx) => {
    const sourceTag = normalizedScope === 'all' && item.sourceLabel ? ` [${item.sourceLabel}]` : '';
    const currentMark = item.id === chatState?.conversationId ? ' ✅(当前)' : '';
    const summaryText = sanitizeForFeishuMarkdown(item.summary || '(无摘要)');
    return `${idx + 1}. \`${item.id.slice(0, 8)}\`${sourceTag}${currentMark} — ${summaryText}`;
  });
  lines.push(
    '',
    normalizedScope === 'all'
      ? '点击下方按钮直接切换（或发送 `/use 序号`），点 **💻 电脑对话** 可扫描并接管本机 CLI / 桌面端会话。'
      : '点击下方按钮直接切换（或发送 `/use 序号`），点 **📱 全部飞书** 可查看跨话题/私聊会话。',
  );

  const buttons = list.slice(0, 6).map((item, idx) => {
    const labelText = (item.summary || item.id.slice(0, 8)).slice(0, 10);
    return {
      label: `${idx + 1}. ${labelText}`,
      type: item.id === chatState?.conversationId ? 'primary' : 'default',
      value: { cmd: 'use', arg: item.id, scope: normalizedScope, inplace: true },
    };
  });

  const title = normalizedScope === 'all'
    ? '🗂️ 最近会话 · 全部飞书（最多 10 条）'
    : isTopic
      ? '🗂️ 最近会话 · 本话题（最多 10 条）'
      : '🗂️ 最近会话 · 本窗口（最多 10 条）';

  return buildCard({
    title,
    template: 'blue',
    markdown: lines.join('\n'),
    buttonRows: [
      tabRow,
      ...chunkButtons(buttons, 3),
      [
        { label: '🆕 新对话', value: { cmd: 'new', inplace: true } },
        { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
      ],
    ],
  });
}

export function parseModelLine(line) {
  const parts = String(line || '').split(/\t+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { id: parts[0], label: parts[1] };
  }
  const tokens = String(line || '').trim().split(/\s+/);
  return { id: tokens[0] || '', label: String(line || '').trim() };
}

export function buildModelsCard(modelLines, currentModel = '') {
  const parsed = modelLines.map(parseModelLine).filter((m) => m.id);
  const preferredOrder = [
    'gemini-pro-orchestrator-neon',
    'gemini-pro-orchestrator',
    'gemini-pro-orchestrator-argon',
    'gemini-4-neon-high',
    'gemini-4-carbon-high',
    'gemini-3.8-flash-high',
  ];
  const picked = [];
  for (const id of preferredOrder) {
    const found = parsed.find((m) => m.id === id);
    if (found) picked.push(found);
  }
  for (const item of parsed) {
    if (picked.length >= 6) break;
    if (!picked.some((p) => p.id === item.id)) {
      picked.push(item);
    }
  }

  const buttons = [
    {
      label: 'default (CLI 默认)',
      type: !currentModel ? 'primary' : 'default',
      value: { cmd: 'model', arg: 'default', inplace: true },
    },
    ...picked.map((m) => ({
      label: m.label.length > 18 ? `${m.label.slice(0, 16)}…` : m.label,
      type: currentModel === m.id ? 'primary' : 'default',
      value: { cmd: 'model', arg: m.id, inplace: true },
    })),
  ];

  const markdown = parsed.length > 0
    ? [
        `当前模型：\`${currentModel || 'default (随 CLI 配置)'}\``,
        '',
        ...parsed.map((m) => `- \`${m.id}\` (${m.label})`),
      ].join('\n')
    : '未查询到可用模型。';

  return buildCard({
    title: '🧠 本机可用模型',
    template: 'blue',
    markdown,
    buttonRows: [
      ...chunkButtons(buttons, 2),
      [{ label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } }],
    ],
  });
}

export function buildCurrentOpsCard({
  bootCodeHash = '',
  checkResult = null,
  isRunning = false,
  confirmSnapshot = null,
} = {}) {
  return buildOpsCard({
    snapshots: listBackupSnapshots(),
    currentHash: computePluginCodeHash(),
    runningHash: bootCodeHash,
    checkResult,
    isRunning,
    confirmSnapshot,
  });
}

export function toastCardResponse(type, content, card = null) {
  const resp = {
    toast: {
      type,
      content,
    },
  };
  if (card) {
    resp.card = {
      type: 'raw',
      data: card,
    };
  }
  return resp;
}

export function sendCardToTarget(
  client,
  { chatId, openId, card, replyToMessageId = '', replyInThread = false },
) {
  if (replyInThread && replyToMessageId) {
    return replyCard(client, { messageId: replyToMessageId, card, replyInThread: true });
  }
  const receiveId = chatId || openId;
  const receiveIdType = chatId ? 'chat_id' : 'open_id';
  if (!receiveId) return Promise.resolve('');
  return sendCard(client, { receiveId, receiveIdType, card });
}

export async function replySimpleCard(
  client,
  messageId,
  { title, template = 'blue', markdown, footer = '', buttonRows = [], replyInThread = false },
) {
  return replyCard(client, {
    messageId,
    card: buildCard({
      title,
      template,
      markdown: sanitizeForFeishuMarkdown(markdown),
      footer,
      buttonRows,
    }),
    replyInThread,
  });
}
