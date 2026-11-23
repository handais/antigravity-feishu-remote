import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { VALID_EFFORTS, VALID_MODES } from './agy-runner.mjs';
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

export function stripMentions(text) {
  return String(text || '')
    .replace(/@_user_\d+/g, '')
    .replace(/\s+/g, (m) => (m.includes('\n') ? m : ' '))
    .trim();
}

export function getOrCreateChatState(state, chatId, config) {
  if (!state.chats[chatId]) {
    state.chats[chatId] = {
      conversationId: '',
      cwd: config.agy.defaultCwd || os.homedir(),
      mode: config.agy.defaultMode || 'accept-edits',
      model: config.agy.defaultModel || '',
      effort: config.agy.defaultEffort || '',
      recentConversations: [],
      pendingHandoff: null,
      fullExpiresAt: 0,
      fullRevertMode: config.agy.defaultMode || 'accept-edits',
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
  }
  return state.chats[chatId];
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

export function recordRecentConversation(chatState, conversationId, prompt) {
  if (!conversationId) return;
  const list = Array.isArray(chatState.recentConversations) ? chatState.recentConversations : [];
  const summary = String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  const filtered = list.filter((item) => item.id !== conversationId);
  filtered.unshift({
    id: conversationId,
    summary,
    updatedAt: new Date().toISOString(),
  });
  chatState.recentConversations = filtered.slice(0, 10);
}

export function expandHomePath(inputPath, baseCwd) {
  const trimmed = String(inputPath || '').trim();
  if (!trimmed) return baseCwd;
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(baseCwd || os.homedir(), trimmed);
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
    '- `/ops`（或 `/backups`）：打开运维与自迭代面板（安全重启 / 代码体检 / 快照回滚）',
    '- `/reload` / `/check` / `/snapshot` / `/rollback [ID]`：代码检查、快照、安全重启与回滚',
    '- `/dirs` / `/cd <路径或关键词>` / `/pin`：浏览、模糊匹配或收藏工作目录',
    '- `/quick`：打开一键快捷任务卡片（支持按钮管理、`/quick add`、`/quick del`、`/quick reset`）',
    '- `/status` / `/new` / `/sessions` / `/use <序号|ID>` / `/help`',
    '- `/desktop [关键词]`（别名 `/pc`）：扫描或全文搜索电脑端历史对话并预览接管',
    '- `/send <文件路径>`（可加 `--file`）：上传并回传本机图片或文件到飞书',
    `- \`/mode [模式|full 30m]\`：切换权限模式（\`${VALID_MODES.join('` / `')}\`，支持 \`/mode full 30m\` 临时授权自动降权）`,
    '- `/timeout [分钟|0]`：查看或设置单轮任务超时时间（如 `/timeout 60`，`/timeout 0` 表示不限时）',
    `- \`/effort [强度|default]\`：切换推理强度（\`${VALID_EFFORTS.join('` / `')}\` / \`default\`）`,
    '- `/model [模型名|default]` / `/models`：查看或切换模型',
    '- `/stop`（或 `/cancel`）：中止当前正在执行的任务',
  ].join('\n');
}

export function buildSessionsCard(chatState) {
  const list = chatState.recentConversations || [];
  if (list.length === 0) {
    return buildCard({
      title: '🗂️ 最近会话',
      template: 'grey',
      markdown: '当前聊天还没有飞书历史会话记录，可点击下方按钮扫描电脑端历史对话。',
      buttonRows: [[
        { label: '💻 电脑对话', type: 'primary', value: { cmd: 'desktop_list', filter: 'all', inplace: true } },
        { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
      ]],
    });
  }
  const lines = list.map((item, idx) => {
    const currentMark = item.id === chatState.conversationId ? ' ✅(当前)' : '';
    return `${idx + 1}. \`${item.id.slice(0, 8)}\`${currentMark} — ${item.summary || '(无摘要)'}`;
  });
  lines.push('', '点击下方按钮直接切换，或点 **💻 电脑对话** 扫描并接管本机 CLI / 桌面端会话。');

  const buttons = list.slice(0, 5).map((item, idx) => {
    const labelText = (item.summary || item.id.slice(0, 8)).slice(0, 10);
    return {
      label: `${idx + 1}. ${labelText}`,
      type: item.id === chatState.conversationId ? 'primary' : 'default',
      value: { cmd: 'use', arg: item.id, inplace: true },
    };
  });

  return buildCard({
    title: '🗂️ 最近会话（最多 10 条）',
    template: 'blue',
    markdown: lines.join('\n'),
    buttonRows: [
      [
        { label: '📱 飞书会话', type: 'primary', value: { cmd: 'sessions', inplace: true } },
        { label: '💻 电脑对话', value: { cmd: 'desktop_list', filter: 'all', inplace: true } },
      ],
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

export function sendCardToTarget(client, { chatId, openId, card }) {
  const receiveId = chatId || openId;
  const receiveIdType = chatId ? 'chat_id' : 'open_id';
  if (!receiveId) return Promise.resolve('');
  return sendCard(client, { receiveId, receiveIdType, card });
}

export async function replySimpleCard(
  client,
  messageId,
  { title, template = 'blue', markdown, footer = '', buttonRows = [] },
) {
  await replyCard(client, {
    messageId,
    card: buildCard({
      title,
      template,
      markdown: sanitizeForFeishuMarkdown(markdown),
      footer,
      buttonRows,
    }),
  });
}
