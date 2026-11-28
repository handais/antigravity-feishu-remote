import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getPluginRoot,
  resolveRiskyApprovalEnabled,
  resolveStopNotifyMode,
} from './config.mjs';

export function sanitizeForFeishuMarkdown(text) {
  if (!text) return '';
  return String(text)
    .replace(/\0/g, '')
    .replace(/\[([^\]]+)\]\(file:\/\/[^)]+\)/g, '`$1`');
}

function stampElementThreadRoot(el, threadRootId) {
  if (!el || typeof el !== 'object') return el;
  if (el.tag === 'button' && Array.isArray(el.behaviors)) {
    return {
      ...el,
      behaviors: el.behaviors.map((b) => {
        if (b?.type === 'callback' && b.value && typeof b.value === 'object' && !Array.isArray(b.value) && !b.value.threadRootId) {
          return { ...b, value: { ...b.value, threadRootId } };
        }
        return b;
      }),
    };
  }
  if (el.tag === 'column_set' && Array.isArray(el.columns)) {
    return {
      ...el,
      columns: el.columns.map((col) => (
        col && Array.isArray(col.elements)
          ? { ...col, elements: col.elements.map((child) => stampElementThreadRoot(child, threadRootId)) }
          : col
      )),
    };
  }
  if (Array.isArray(el.elements)) {
    return {
      ...el,
      elements: el.elements.map((child) => stampElementThreadRoot(child, threadRootId)),
    };
  }
  return el;
}

/**
 * Stamp `threadRootId` into all callback button payloads on a Feishu card without mutating the input.
 */
export function stampCardThreadRoot(card, threadRootId) {
  const cleanRoot = String(threadRootId || '').trim();
  if (!cleanRoot || !card || typeof card !== 'object') {
    return card;
  }
  const body = card.body;
  if (!body || !Array.isArray(body.elements)) {
    return card;
  }
  return {
    ...card,
    body: {
      ...body,
      elements: body.elements.map((el) => stampElementThreadRoot(el, cleanRoot)),
    },
  };
}

function updateFenceState(line, activeFence) {
  const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!match) return activeFence;
  const marker = match[1];
  const char = marker[0];
  if (!activeFence) {
    return { char, len: marker.length, header: line.trimEnd() };
  }
  if (activeFence.char === char && marker.length >= activeFence.len && match[2].trim() === '') {
    return null;
  }
  return activeFence;
}

function takePrefixWithinBudget(str, maxChars, maxBytes) {
  let end = Math.min(str.length, Math.max(1, maxChars));
  // Shrink proportionally if UTF-8 byte length exceeds maxBytes
  while (end > 1 && Buffer.byteLength(str.slice(0, end), 'utf8') > maxBytes) {
    const curBytes = Buffer.byteLength(str.slice(0, end), 'utf8');
    const ratio = maxBytes / curBytes;
    const nextEnd = Math.floor(end * ratio * 0.95);
    end = Math.max(1, Math.min(end - 1, nextEnd));
  }
  // Avoid splitting surrogate pairs in half
  if (end < str.length) {
    const code = str.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff && end > 1) {
      end -= 1;
    }
  }
  return {
    head: str.slice(0, end),
    rest: str.slice(end),
  };
}

/**
 * Split Markdown into Feishu interactive card chunks respecting both character count and UTF-8 byte limits
 * while keeping fenced code blocks balanced across every chunk.
 */
export function splitMarkdownChunks(text, maxLen = 7000, { maxUtf8Bytes = 22_000 } = {}) {
  const normalized = String(text || '').trim();
  if (!normalized) return [''];
  const byteLimit = Math.max(800, Number(maxUtf8Bytes) || 22_000);
  if (normalized.length <= maxLen && Buffer.byteLength(normalized, 'utf8') <= byteLimit) {
    return [normalized];
  }

  const lines = normalized.split('\n');
  const chunks = [];
  let currentLines = [];
  let currentLen = 0;
  let currentBytes = 0;
  let activeFence = null;

  const resetCurrentFromFence = () => {
    currentLines = activeFence ? [activeFence.header] : [];
    currentLen = currentLines.reduce((sum, l) => sum + l.length + 1, 0);
    currentBytes = currentLines.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf8') + 1, 0);
  };

  const flushChunk = () => {
    if (currentLines.length === 0) return;
    if (activeFence) {
      currentLines.push(activeFence.char.repeat(activeFence.len));
    }
    chunks.push(currentLines.join('\n').trimEnd());
    resetCurrentFromFence();
  };

  const appendLine = (line) => {
    const fenceReserveChars = activeFence ? activeFence.len + 2 : 0;
    const fenceReserveBytes = activeFence ? activeFence.len + 4 : 0;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const hasChunkContent = currentLines.length > (activeFence ? 1 : 0);
    if (
      hasChunkContent &&
      (currentLen + line.length + 1 + fenceReserveChars > maxLen ||
        currentBytes + lineBytes + 1 + fenceReserveBytes > byteLimit)
    ) {
      flushChunk();
    }
    currentLines.push(line);
    currentLen += line.length + 1;
    currentBytes += lineBytes + 1;
  };

  for (const rawLine of lines) {
    let line = rawLine;
    const headerChars = activeFence ? activeFence.header.length + activeFence.len + 4 : 0;
    const headerBytes = activeFence ? Buffer.byteLength(activeFence.header, 'utf8') + activeFence.len + 8 : 0;
    const singleCharsBudget = Math.max(80, maxLen - 40 - headerChars);
    const singleBytesBudget = Math.max(200, byteLimit - 128 - headerBytes);

    while (line.length > singleCharsBudget || Buffer.byteLength(line, 'utf8') > singleBytesBudget) {
      if (currentLines.length > (activeFence ? 1 : 0)) {
        flushChunk();
      }
      const { head, rest } = takePrefixWithinBudget(line, singleCharsBudget, singleBytesBudget);
      currentLines.push(head);
      currentLen += head.length + 1;
      currentBytes += Buffer.byteLength(head, 'utf8') + 1;
      flushChunk();
      line = rest;
    }

    appendLine(line);
    activeFence = updateFenceState(line, activeFence);
  }

  if (currentLines.length > 0) {
    if (activeFence) {
      currentLines.push(activeFence.char.repeat(activeFence.len));
    }
    const joined = currentLines.join('\n').trimEnd();
    if (joined) {
      chunks.push(joined);
    }
  }

  return chunks.length > 0 ? chunks : [''];
}

function buildButtonRowElement(row) {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'small',
    columns: row.map((btn) => ({
      tag: 'column',
      width: 'auto',
      elements: [
        {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: btn.label,
          },
          type: btn.type || 'default',
          size: 'small',
          behaviors: [
            {
              type: 'callback',
              value: btn.value || {},
            },
          ],
        },
      ],
    })),
  };
}

export function buildCard({ title, template = 'blue', markdown = '', footer = '', buttonRows = [] }) {
  const elements = [
    {
      tag: 'markdown',
      content: markdown || ' ',
    },
  ];

  for (const row of buttonRows) {
    if (!Array.isArray(row) || row.length === 0) continue;
    elements.push(buildButtonRowElement(row));
  }

  if (footer) {
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>${footer}</font>`,
      text_size: 'notation',
    });
  }

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    body: {
      elements,
    },
  };
}

export function buildSectionedCard({ title, template = 'blue', markdown = '', sections = [], footer = '' }) {
  const elements = [
    {
      tag: 'markdown',
      content: markdown || ' ',
    },
  ];

  for (const section of sections) {
    const validRows = Array.isArray(section?.rows)
      ? section.rows.filter((r) => Array.isArray(r) && r.length > 0)
      : [];
    if (validRows.length === 0) continue;

    if (section.divider !== false) {
      elements.push({ tag: 'hr' });
    }
    if (section.title) {
      elements.push({
        tag: 'markdown',
        content: `<font color='grey'>**${section.title}**</font>`,
        text_size: 'notation',
      });
    }
    for (const row of validRows) {
      elements.push(buildButtonRowElement(row));
    }
  }

  if (footer) {
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>${footer}</font>`,
      text_size: 'notation',
    });
  }

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    body: {
      elements,
    },
  };
}

function isDirectoryEntry(parentDir, entry) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(parentDir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

export function canonicalizeDirPath(dirPath) {
  if (!dirPath) return '';
  const resolved = path.resolve(String(dirPath));
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function discoverQuickDirs(config, currentCwd = '') {
  const candidates = [
    ...(Array.isArray(config?.agy?.favoriteDirs) ? config.agy.favoriteDirs : []),
    currentCwd,
    config?.agy?.defaultCwd,
    os.homedir(),
  ];

  const parentDirs = [
    path.join(os.homedir(), 'Desktop', 'proj'),
    path.join(os.homedir(), 'Projects'),
    path.join(os.homedir(), 'projects'),
  ];
  for (const parent of parentDirs) {
    try {
      if (fs.existsSync(parent) && fs.statSync(parent).isDirectory()) {
        const entries = fs.readdirSync(parent, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.name.startsWith('.') && isDirectoryEntry(parent, entry)) {
            candidates.push(path.join(parent, entry.name));
          }
        }
      }
    } catch {
      // Ignore unreadable parent dirs
    }
  }

  const seen = new Set();
  const result = [];
  for (const raw of candidates) {
    if (!raw) continue;
    const resolved = path.resolve(raw);
    const canonical = canonicalizeDirPath(resolved);
    if (seen.has(canonical)) continue;
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        seen.add(canonical);
        result.push(resolved);
        if (result.length >= 5) break;
      }
    } catch {
      // Ignore inaccessible dirs
    }
  }
  return result;
}

function formatShortDirName(dirPath, homeDir = os.homedir()) {
  const home = path.resolve(homeDir);
  const resolved = path.resolve(dirPath);
  const labelName = resolved === home ? '~' : path.basename(resolved) || resolved;
  return labelName.length > 14 ? `${labelName.slice(0, 12)}…` : labelName;
}

function formatQuickDirLabels(dirPaths, homeDir = os.homedir()) {
  const baseLabels = dirPaths.map((d) => formatShortDirName(d, homeDir));
  const counts = new Map();
  for (const label of baseLabels) {
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return dirPaths.map((dirPath, idx) => {
    const base = baseLabels[idx];
    if ((counts.get(base) || 0) <= 1) return base;
    const parentName = path.basename(path.dirname(path.resolve(dirPath)));
    const leafName = path.basename(path.resolve(dirPath));
    const combined = parentName ? `${parentName}/${leafName}` : base;
    return combined.length > 14 ? `…${combined.slice(-13)}` : combined;
  });
}

export function chunkButtons(buttons, perRow = 3) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow));
  }
  return rows;
}

const TRACKED_DIRECT_PANEL_CMDS = new Set([
  'new',
  'sessions',
  'desktop_list',
  'handoff',
  'tasks',
  'dirs',
  'git',
  'models',
  'effort_menu',
  'mode_temp_full',
  'safe_restart',
  'notify_menu',
  'timeout_menu',
  'guard_toggle',
  'scopes',
  'ops',
  'skills_menu',
]);

const TRACKED_MODE_ARGS = new Set(['auto', 'plan', 'full']);

/**
 * Map a card action command+arg pair to its canonical frequent-action key, or '' if excluded.
 */
export function resolvePanelActionKey(cmd, arg = '') {
  const c = String(cmd || '').trim().toLowerCase();
  const a = String(arg || '').trim().toLowerCase();
  if (!c) return '';
  if (c === 'backups') return 'ops';
  if (TRACKED_DIRECT_PANEL_CMDS.has(c)) return c;
  if (c === 'mode' && TRACKED_MODE_ARGS.has(a)) return `mode:${a}`;
  return '';
}

/**
 * Compute recency-weighted frequency score for ranking frequent panel actions.
 */
export function computePanelActionScore(entry, now = Date.now()) {
  const count = Math.max(0, Number(entry?.count) || 0);
  if (count <= 0) return 0;
  const lastUsedAt = Number(entry?.lastUsedAt || 0);
  const ageDays = lastUsedAt > 0 ? Math.max(0, (now - lastUsedAt) / 86_400_000) : 365;
  const decay = Math.pow(0.5, ageDays / 14);
  return count * (0.35 + 0.65 * decay);
}

/**
 * Record one usage hit for a stable reusable panel action in state.panelActionUsage.
 */
export function recordPanelActionUsage(state, cmd, arg = '', now = Date.now()) {
  const key = resolvePanelActionKey(cmd, arg);
  if (!key || !state || typeof state !== 'object') return false;
  if (!state.panelActionUsage || typeof state.panelActionUsage !== 'object' || Array.isArray(state.panelActionUsage)) {
    state.panelActionUsage = {};
  }
  const prev = state.panelActionUsage[key];
  const prevCount = Math.max(0, Number(prev?.count) || 0);
  const ts = Number(now) || Date.now();
  state.panelActionUsage[key] = {
    count: prevCount + 1,
    lastUsedAt: ts,
  };
  const entries = Object.entries(state.panelActionUsage);
  if (entries.length > 30) {
    entries.sort(([, a], [, b]) => computePanelActionScore(b, ts) - computePanelActionScore(a, ts));
    state.panelActionUsage = Object.fromEntries(entries.slice(0, 30));
  }
  return true;
}

/**
 * Build up to `maxItems` dynamic shortcut buttons from recorded panel usage.
 */
export function buildFrequentPanelButtons({
  panelActionUsage,
  mode = 'auto',
  isTempFull = false,
  remainingMin = 0,
  guardEnabled = true,
  maxItems = 4,
  now = Date.now(),
} = {}) {
  if (!panelActionUsage || typeof panelActionUsage !== 'object') return [];
  const limit = Math.max(0, Math.min(5, Number(maxItems) || 4));
  if (limit === 0) return [];

  const catalog = {
    new: { label: '🆕 新对话', value: { cmd: 'new', inplace: true } },
    sessions: { label: '🗂️ 最近会话', value: { cmd: 'sessions', inplace: true } },
    desktop_list: { label: '💻 电脑对话', value: { cmd: 'desktop_list', filter: 'all', inplace: true } },
    handoff: { label: '💻 交回电脑', value: { cmd: 'handoff', inplace: true } },
    tasks: { label: '✅ 飞书待办', value: { cmd: 'tasks', filter: 'open', inplace: true } },
    dirs: { label: '📁 切换目录', value: { cmd: 'dirs', inplace: true } },
    git: { label: '🌿 Git', value: { cmd: 'git', inplace: true } },
    models: { label: '🧠 模型', value: { cmd: 'models', inplace: true } },
    effort_menu: { label: '🎛️ 强度', value: { cmd: 'effort_menu', inplace: true } },
    skills_menu: { label: '🧩 命令', value: { cmd: 'skills_menu', inplace: true } },
    mode_temp_full: {
      label: isTempFull ? `⚡ 全权剩${remainingMin}m` : '⚡ 30m全权',
      type: isTempFull ? 'primary' : 'default',
      value: { cmd: 'mode_temp_full', arg: '30', inplace: true },
    },
    'mode:auto': {
      label: '🤖 自动',
      type: mode === 'auto' ? 'primary' : 'default',
      value: { cmd: 'mode', arg: 'auto', inplace: true },
    },
    'mode:plan': {
      label: '📖 只读',
      type: mode === 'plan' ? 'primary' : 'default',
      value: { cmd: 'mode', arg: 'plan', inplace: true },
    },
    'mode:full': {
      label: '⚡ 常驻全权',
      type: mode === 'full' && !isTempFull ? 'primary' : 'default',
      value: { cmd: 'mode', arg: 'full', inplace: true },
    },
    safe_restart: { label: '♻️ 安全重启', value: { cmd: 'safe_restart', inplace: true } },
    notify_menu: { label: '🔔 桌面提醒', value: { cmd: 'notify_menu', inplace: true } },
    timeout_menu: { label: '⏱️ 单轮超时', value: { cmd: 'timeout_menu', inplace: true } },
    guard_toggle: {
      label: guardEnabled ? '🛡️ 高危审批:开' : '⚪ 高危审批:关',
      value: { cmd: 'guard_toggle', inplace: true },
    },
    scopes: { label: '🔐 应用权限', value: { cmd: 'scopes', inplace: true } },
    ops: { label: '⏪ 快照回滚', value: { cmd: 'ops', inplace: true } },
  };

  return Object.entries(panelActionUsage)
    .filter(([key, meta]) => Boolean(catalog[key]) && Number(meta?.count || 0) > 0)
    .map(([key, meta]) => ({
      key,
      score: computePanelActionScore(meta, now),
      lastUsedAt: Number(meta?.lastUsedAt || 0),
      count: Number(meta?.count || 0),
    }))
    .sort((a, b) => {
      if (Math.abs(b.score - a.score) > 1e-6) return b.score - a.score;
      if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
      return b.count - a.count;
    })
    .slice(0, limit)
    .map((item) => catalog[item.key]);
}

export const PENDING_COMMAND_TTL_MS = 30 * 60 * 1000;

export const AGY_PRESET_COMMANDS = [
  { prefix: '/plan', icon: '🧭' },
  { prefix: '/grill-me', icon: '🎤' },
  { prefix: '/boost', icon: '🚀' },
  { prefix: '/goal', icon: '🎯' },
  { prefix: '/schedule', icon: '⏰' },
  { prefix: '/browser', icon: '🌐' },
  { prefix: '/learn', icon: '📝' },
  { prefix: '/teamwork', icon: '🤝' },
  { prefix: '/swarm', icon: '🐝' },
];

/**
 * Validate a slash command or skill prefix before arming or rendering it.
 */
export function isValidCommandPrefix(raw) {
  const s = String(raw || '').trim();
  if (!s || s.includes('..')) return false;
  return /^\/[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(s);
}

/**
 * Return the active non-expired pending command prefix for a chat state, or null.
 */
export function getActivePendingCommand(chatState, now = Date.now()) {
  const pending = chatState?.pendingCommand;
  if (!pending || typeof pending !== 'object') return null;
  const prefix = String(pending.prefix || '').trim();
  if (!isValidCommandPrefix(prefix)) return null;
  const armedAt = Number(pending.armedAt || 0);
  if (armedAt > 0 && now - armedAt > PENDING_COMMAND_TTL_MS) {
    return null;
  }
  const template = typeof pending.template === 'string' ? pending.template.trim().slice(0, 48) : '';
  return {
    prefix,
    kind: pending.kind === 'skill' ? 'skill' : 'builtin',
    armedAt,
    ...(template ? { template } : {}),
  };
}

/**
 * Consume a chat's armed one-shot command prefix for an incoming user message.
 */
export function consumePendingCommand(chatState, rawText, { hasAttachments = false, now = Date.now() } = {}) {
  const original = chatState?.pendingCommand;
  if (!original) {
    return { applied: false, expired: false, superseded: false, stateChanged: false, prefix: '' };
  }
  const active = getActivePendingCommand(chatState, now);
  chatState.pendingCommand = null;
  if (!active) {
    return { applied: false, expired: true, superseded: false, stateChanged: true, prefix: '' };
  }
  const trimmed = String(rawText || '').trim();
  if (trimmed.startsWith('/')) {
    return { applied: false, expired: false, superseded: true, stateChanged: true, prefix: '' };
  }
  if (!trimmed && !hasAttachments) {
    chatState.pendingCommand = original;
    return { applied: false, expired: false, superseded: false, stateChanged: false, prefix: '' };
  }
  const composedPrefix = active.template ? `${active.prefix} ${active.template}` : active.prefix;
  return { applied: true, expired: false, superseded: false, stateChanged: true, prefix: composedPrefix };
}

export function buildControlPanelCard({
  chatState,
  config,
  isRunning = false,
  uptimeText = '',
  queueLength = 0,
  threadRootId = '',
  activeParallelCount = 0,
  maxConcurrentRuns = 4,
  panelActionUsage = null,
}) {
  const cwd = chatState?.cwd || config?.agy?.defaultCwd || os.homedir();
  const mode = chatState?.mode || config?.agy?.defaultMode || 'auto';
  const model = chatState?.model || config?.agy?.defaultModel || '';
  const effort = chatState?.effort || config?.agy?.defaultEffort || '';
  const convId = chatState?.conversationId || '';
  const rawExpiresAt = Number(chatState?.fullExpiresAt || 0);
  const isTempFull = mode === 'full' && rawExpiresAt > Date.now();
  const remainingMin = isTempFull ? Math.max(1, Math.ceil((rawExpiresAt - Date.now()) / 60000)) : 0;
  const revertMode = chatState?.fullRevertMode || 'auto';
  const quickDirs = discoverQuickDirs(config, cwd);
  const canonicalCwd = canonicalizeDirPath(cwd);
  const favoriteSet = new Set(
    (Array.isArray(config?.agy?.favoriteDirs) ? config.agy.favoriteDirs : [])
      .map((d) => canonicalizeDirPath(d))
      .filter(Boolean),
  );
  const isPinned = favoriteSet.has(canonicalCwd);

  const modeDisplay = isTempFull
    ? `\`full\`（⏱️ 临时全权，约 ${remainingMin} 分钟后自动切回 \`${revertMode}\`）`
    : `\`${mode}\``;
  const queueSuffix = queueLength > 0 ? `（排队 ${queueLength} 条）` : '';
  const parallelSuffix = activeParallelCount > 1 ? ` · 全局并行 ${activeParallelCount}/${maxConcurrentRuns}` : '';
  const pendingHandoff = chatState.pendingHandoff;
  const activePendingCmd = getActivePendingCommand(chatState);
  const notifyMode = resolveStopNotifyMode(config);
  const awayMin = Math.max(1, Math.round(Number(config?.notifications?.awayIdleSeconds || 120) / 60));
  const notifyLabel = notifyMode === 'on'
    ? '🔔 始终提醒'
    : notifyMode === 'away'
      ? `🧠 仅离开电脑时（空闲 ≥ ${awayMin}m）`
      : '🔕 已关闭';
  const originDesktop = chatState?.originDesktopSession;
  const originSuffix = originDesktop?.id
    ? ` · 关联桌面 \`${originDesktop.id.slice(0, 8)}\``
    : '';

  const lines = [
    threadRootId ? `- **所属话题**：\`${threadRootId.slice(0, 12)}\`（独立并行会话）` : '',
    `- **工作目录**：\`${cwd}\``,
    `- **执行模式**：${modeDisplay}`,
    `- **当前模型**：\`${model || 'default (随 CLI 配置)'}\``,
    `- **推理强度**：\`${effort || 'default (随 CLI 配置)'}\``,
    `- **电脑端提醒**：${notifyLabel}`,
    `- **当前会话**：\`${convId ? convId.slice(0, 8) : '(未开始，下条消息新建)'}\`${originSuffix}`,
    pendingHandoff
      ? `- **待注入上下文**：已挂接电脑端「${(pendingHandoff.title || '').slice(0, 24)}」（下条消息自动注入）`
      : '',
    activePendingCmd
      ? `- **已预选命令**：\`${activePendingCmd.prefix}\`（下条消息自动拼接）`
      : '',
    `- **运行状态**：${isRunning ? `⏳ 正在执行任务${queueSuffix}${parallelSuffix}` : `🟢 空闲${queueSuffix}${parallelSuffix}`}`,
  ].filter(Boolean);
  if (uptimeText) {
    lines.push(`- **守护进程在线**：\`${uptimeText}\``);
  }

  const activeRow = [];
  if (isRunning) {
    activeRow.push({ label: '🛑 立即中止', type: 'danger', value: { cmd: 'stop', inplace: true } });
  }
  if (queueLength > 0) {
    activeRow.push({ label: `📋 队列(${queueLength})`, value: { cmd: 'queue_list', inplace: true } });
  }
  if (activePendingCmd) {
    const shortPrefix = activePendingCmd.prefix.length > 10
      ? `${activePendingCmd.prefix.slice(0, 8)}…`
      : activePendingCmd.prefix;
    activeRow.push({ label: `❌ 取消 ${shortPrefix}`, type: 'danger', value: { cmd: 'clear_pending_cmd', inplace: true } });
  }

  const sessionRow = [
    { label: '🆕 新对话', value: { cmd: 'new', inplace: true } },
    { label: '🗂️ 最近会话', value: { cmd: 'sessions', inplace: true } },
    { label: '💻 电脑对话', value: { cmd: 'desktop_list', filter: 'all', inplace: true } },
    { label: '💻 交回电脑', value: { cmd: 'handoff', inplace: true } },
  ];

  const taskRow = [
    { label: '✅ 飞书待办', value: { cmd: 'tasks', filter: 'open', inplace: true } },
    { label: '📁 切换目录', value: { cmd: 'dirs', inplace: true } },
    { label: '🌿 Git', value: { cmd: 'git', inplace: true } },
  ];

  const home = path.resolve(os.homedir());
  const topQuickDirs = quickDirs.slice(0, 3);
  const quickLabels = formatQuickDirLabels(topQuickDirs, home);
  const quickDirRow = [
    ...topQuickDirs.map((dirPath, idx) => ({
      label: `📂 ${quickLabels[idx]}`,
      type: canonicalizeDirPath(dirPath) === canonicalCwd ? 'primary' : 'default',
      value: { cmd: 'cd', arg: dirPath, inplace: true },
    })),
    {
      label: isPinned ? '📌 取消收藏' : '📌 收藏目录',
      value: { cmd: 'pin', inplace: true },
    },
  ];

  const modeRow = [
    {
      label: '🤖 自动',
      type: mode === 'auto' ? 'primary' : 'default',
      value: { cmd: 'mode', arg: 'auto', inplace: true },
    },
    {
      label: '📖 只读',
      type: mode === 'plan' ? 'primary' : 'default',
      value: { cmd: 'mode', arg: 'plan', inplace: true },
    },
    {
      label: isTempFull ? `⚡ 全权剩${remainingMin}m` : '⚡ 30m全权',
      type: isTempFull ? 'primary' : 'default',
      value: { cmd: 'mode_temp_full', arg: '30', inplace: true },
    },
    {
      label: '⚡ 常驻全权',
      type: mode === 'full' && !isTempFull ? 'primary' : 'default',
      value: { cmd: 'mode', arg: 'full', inplace: true },
    },
  ];

  const configRow = [
    { label: '🧠 模型', value: { cmd: 'models', inplace: true } },
    { label: '🎛️ 强度', value: { cmd: 'effort_menu', inplace: true } },
    { label: '🛠️ 设置', value: { cmd: 'system_menu', inplace: true } },
    { label: '🔄 刷新', value: { cmd: 'panel', inplace: true } },
    { label: '❓ 帮助', value: { cmd: 'help', inplace: true } },
  ];

  const frequentRow = buildFrequentPanelButtons({
    panelActionUsage,
    mode,
    isTempFull,
    remainingMin,
    guardEnabled: resolveRiskyApprovalEnabled(config),
    maxItems: 4,
  });

  const sections = [];
  if (activeRow.length > 0) {
    sections.push({ divider: false, rows: [activeRow] });
  }
  if (frequentRow.length > 0) {
    sections.push({ title: '⭐ 常用操作', divider: true, rows: [frequentRow] });
  }
  sections.push(
    { title: '💬 会话与跨端', divider: true, rows: [sessionRow] },
    { title: '📂 任务与工作区', divider: true, rows: [taskRow, quickDirRow] },
    { title: '🛡️ 权限与配置', divider: true, rows: [modeRow, configRow] },
  );

  return buildSectionedCard({
    title: '⚙️ Antigravity 控制面板',
    template: isRunning ? 'wathet' : 'blue',
    markdown: lines.join('\n'),
    sections,
    footer: '安全提示：按需点「⚡ 30m全权」· 通知/高危审批/重启在「🛠️ 设置」',
  });
}

function formatCardTimeoutLabel(sec) {
  const n = Number(sec);
  if (!n || n <= 0) return '不限时';
  const s = Math.floor(n);
  if (s >= 60) {
    return `${Math.round(s / 60)} 分钟（${s}s）`;
  }
  return `${s} 秒`;
}

function resolveTimeoutDisplay(chatState, config) {
  const rawGlobal = config?.agy?.timeoutSeconds;
  const globalSec = rawGlobal !== undefined && rawGlobal !== null && Number.isFinite(Number(rawGlobal)) && Number(rawGlobal) >= 0
    ? Math.floor(Number(rawGlobal))
    : 3600;
  const rawPerChat = chatState?.timeoutSeconds;
  const hasOverride = rawPerChat !== undefined && rawPerChat !== null && Number.isFinite(Number(rawPerChat)) && Number(rawPerChat) >= 0;
  const effectiveSec = hasOverride ? Math.floor(Number(rawPerChat)) : globalSec;
  return {
    effectiveSec,
    globalSec,
    hasOverride,
    effectiveLabel: formatCardTimeoutLabel(effectiveSec),
    globalLabel: formatCardTimeoutLabel(globalSec),
  };
}

export function buildNewSessionCard({ chatState, config, threadRootId = '' } = {}) {
  const cwd = chatState?.cwd || config?.agy?.defaultCwd || os.homedir();
  const mode = chatState?.mode || config?.agy?.defaultMode || 'auto';
  const model = chatState?.model || config?.agy?.defaultModel || '';
  const effort = chatState?.effort || config?.agy?.defaultEffort || '';
  const rawExpiresAt = Number(chatState?.fullExpiresAt || 0);
  const isTempFull = mode === 'full' && rawExpiresAt > Date.now();
  const remainingMin = isTempFull ? Math.max(1, Math.ceil((rawExpiresAt - Date.now()) / 60000)) : 0;
  const revertMode = chatState?.fullRevertMode || 'auto';
  const modeDisplay = isTempFull
    ? `\`full\`（⏱️ 临时全权，约 ${remainingMin} 分钟后自动切回 \`${revertMode}\`）`
    : `\`${mode}\``;
  const timeoutInfo = resolveTimeoutDisplay(chatState, config);

  const lines = [
    threadRootId ? `- **所属话题**：\`${threadRootId.slice(0, 12)}\`（独立并行会话）` : '',
    `- **工作目录**：\`${cwd}\``,
    `- **执行模式**：${modeDisplay}`,
    `- **当前模型**：\`${model || 'default (随 CLI 配置)'}\``,
    `- **推理强度**：\`${effort || 'default (随 CLI 配置)'}\``,
    `- **单轮超时**：\`${timeoutInfo.effectiveLabel}\``,
    '',
    '下条消息将以上述配置开启全新上下文。',
  ].filter((line, idx, arr) => line !== '' || (idx > 0 && arr[idx - 1] !== ''));

  return buildCard({
    title: '🆕 已开启新对话',
    template: 'green',
    markdown: lines.join('\n'),
    buttonRows: [
      [
        { label: '📁 切换目录', value: { cmd: 'dirs' } },
        { label: '🧠 模型', value: { cmd: 'models' } },
        { label: '🎛️ 强度', value: { cmd: 'effort_menu' } },
      ],
      [
        { label: '🧩 命令', value: { cmd: 'skills_menu' } },
        { label: '⚙️ 控制面板', value: { cmd: 'panel' } },
      ],
    ],
    footer: '目录或模型不对可直接点上方按钮调整，然后发送任务',
  });
}

export function buildSystemSettingsCard({ config, chatState = null, isRunning = false, uptimeText = '' } = {}) {
  const guardEnabled = resolveRiskyApprovalEnabled(config);
  const timeoutSec = Math.max(15, Math.min(160, Number(config?.security?.approvalTimeoutSeconds || 120)));
  const notifyMode = resolveStopNotifyMode(config);
  const awayMin = Math.max(1, Math.round(Number(config?.notifications?.awayIdleSeconds || 120) / 60));
  const notifyLabel = notifyMode === 'on'
    ? '🔔 始终提醒'
    : notifyMode === 'away'
      ? `🧠 仅离开电脑时（空闲 ≥ ${awayMin}m）`
      : '🔕 已关闭';
  const defaultTopic = String(config?.notifications?.defaultTopicChatId || '').trim();
  const timeoutInfo = resolveTimeoutDisplay(chatState, config);

  const lines = [
    `- **高危命令审批**：${guardEnabled ? `🛡️ 已开启（超时 \`${timeoutSec}s\` 自动拒绝）` : '⚪ 已关闭'}`,
    `- **桌面端完成提醒**：${notifyLabel}`,
    `- **单轮超时**：\`${timeoutInfo.effectiveLabel}\`${timeoutInfo.hasOverride ? `（本会话覆盖；全局 \`${timeoutInfo.globalLabel}\`）` : '（全局默认）'}`,
    `- **默认接管话题群**：\`${defaultTopic || '自动记忆最近活跃话题群'}\``,
    `- **任务状态**：${isRunning ? '⏳ 有任务运行中' : '🟢 空闲'}${uptimeText ? ` · 守护进程在线 \`${uptimeText}\`` : ''}`,
  ];

  return buildSectionedCard({
    title: '🛠️ 设置',
    template: 'blue',
    markdown: lines.join('\n'),
    sections: [
      {
        title: '🔒 安全与提醒',
        divider: true,
        rows: [[
          {
            label: guardEnabled ? '🛡️ 高危审批:开' : '⚪ 高危审批:关',
            type: guardEnabled ? 'primary' : 'default',
            value: { cmd: 'guard_toggle', inplace: true, fromSystem: true },
          },
          { label: '🔔 桌面提醒设置', value: { cmd: 'notify_menu', inplace: true } },
          { label: '⏱️ 单轮超时', value: { cmd: 'timeout_menu', inplace: true } },
          { label: '🔐 应用权限自检', value: { cmd: 'scopes', inplace: true } },
        ]],
      },
      {
        title: '⚙️ 运维与控制',
        divider: true,
        rows: [[
          { label: '♻️ 安全重启', value: { cmd: 'safe_restart', inplace: true } },
          { label: '⏪ 快照与回滚', value: { cmd: 'ops', inplace: true } },
          { label: '🧹 重置常用', value: { cmd: 'reset_frequent_actions', inplace: true } },
          { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
        ]],
      },
    ],
    footer: '可在话题群发 /topic set 绑定默认群 · /guard on|off 切换审批 · /timeout <时长> 调超时',
  });
}

export function buildPanelHelpCard() {
  const markdown = [
    '- `⭐ 常用操作`：自动按点击频次与最近使用动态置顶前 4 个高频按钮（含系统二级页快捷入口），可在「🛠️ 设置 → 🧹 重置常用」清空',
    '',
    '**💬 会话与跨端**',
    '- `🆕 新对话`：清空当前上下文，下条消息开启全新会话',
    '- `🗂️ 最近会话`：查看并切换近期手机 / CLI 历史会话',
    '- `💻 电脑对话`：查看电脑端 Antigravity IDE / CLI 对话，支持「🧵 新开话题接管」或「📱 当前对话接管」',
    '- `💻 交回电脑`：复制 `agy --conversation` 终端接续命令或桌面端交接提示词，无缝交回电脑继续',
    '',
    '**📂 任务与工作区**',
    '- `✅ 飞书待办`：查看并快速完成你的飞书任务列表',
    '- `📁 切换目录`：可视化切换工作目录（支持翻页与显示隐藏目录）',
    '- `🌿 Git`：查看当前仓库分支、改动文件与最近提交',
    '- `📂 快捷目录 / 📌 收藏目录`：一键跳回常用目录或收藏/取消收藏当前目录',
    '',
    '**🛡️ 权限与配置**',
    '- `🤖 自动` / `📖 只读`：智能平衡自动执行，或只分析规划不改任何文件',
    '- `⚡ 30m全权` / `⚡ 常驻全权`：放开 Shell / MCP 执行权限（30m全权到期后自动降权）',
    '- `🧠 模型` / `🎛️ 强度`：切换当前会话使用的模型与推理深度',
    '- `🛠️ 设置`：集中管理高危命令审批、桌面完成提醒、单轮超时、应用权限自检、安全重启与快照回滚',
    '- `🔄 刷新`：立即同步最新运行状态、目录与队列计数',
  ].join('\n');

  return buildCard({
    title: '❓ 控制面板功能说明',
    template: 'blue',
    markdown,
    buttonRows: [[
      { label: '📖 查看全部斜杠指令', type: 'primary', value: { cmd: 'help_commands', inplace: true } },
      { label: '🧩 命令', value: { cmd: 'skills_menu', inplace: true } },
      { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
    ]],
    footer: '提示：直接发 /help 或点上方按钮查看全部文字指令 · 话题群发 /topic set 可绑定默认接管群',
  });
}

function readSkillMeta(skillMdPath, fallbackName) {
  let raw = '';
  let fd = null;
  try {
    fd = fs.openSync(skillMdPath, 'r');
    const buf = Buffer.alloc(2048);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    raw = buf.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
  }

  let name = fallbackName;
  let description = '';
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '') || name;
    }
    if (descMatch) {
      description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  const cleanDesc = description.replace(/\s+/g, ' ').trim();
  return {
    name,
    description: cleanDesc.length > 72 ? `${cleanDesc.slice(0, 70)}…` : cleanDesc,
  };
}

const SKILLS_CACHE_TTL_MS = 30_000;
const skillsCache = new Map();

export function clearSkillsCache() {
  skillsCache.clear();
}

export function discoverLocalSkills({ homeDir = os.homedir(), maxSkills = 20 } = {}) {
  const cappedMax = Math.max(1, Math.min(40, Number(maxSkills) || 20));
  const cacheKey = `${path.resolve(homeDir || os.homedir())}:${cappedMax}`;
  const cached = skillsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SKILLS_CACHE_TTL_MS) {
    return cached.items;
  }

  const candidates = [];
  const collectSkillDirs = (parentDir, source) => {
    try {
      if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) return;
      for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || !isDirectoryEntry(parentDir, entry)) continue;
        const skillMd = path.join(parentDir, entry.name, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          candidates.push({ skillMd, fallbackName: entry.name, source });
        }
      }
    } catch {
      // Ignore unreadable skill directories
    }
  };

  collectSkillDirs(path.join(homeDir, '.gemini', 'config', 'skills'), 'config');
  collectSkillDirs(path.join(homeDir, '.agents', 'skills'), 'agents');

  const pluginsRoot = path.join(homeDir, '.gemini', 'config', 'plugins');
  try {
    if (fs.existsSync(pluginsRoot) && fs.statSync(pluginsRoot).isDirectory()) {
      for (const pluginEntry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
        if (pluginEntry.name.startsWith('.') || !isDirectoryEntry(pluginsRoot, pluginEntry)) continue;
        collectSkillDirs(path.join(pluginsRoot, pluginEntry.name, 'skills'), pluginEntry.name);
      }
    }
  } catch {
    // Ignore unreadable plugin directories
  }

  const byKey = new Map();
  for (const item of candidates) {
    const meta = readSkillMeta(item.skillMd, item.fallbackName);
    if (!meta?.name) continue;
    const key = meta.name.toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, { ...meta, source: item.source });
    }
  }

  const discovered = [...byKey.values()]
    .filter((item) => isValidCommandPrefix(`/${item.name}`))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, cappedMax);
  skillsCache.set(cacheKey, { ts: Date.now(), items: discovered });
  return discovered;
}

export function buildAgySkillsCard({
  skills = null,
  homeDir = os.homedir(),
  pendingCommand = null,
  skillPage = 0,
  skillPageSize = 9,
} = {}) {
  const resolvedSkills = (Array.isArray(skills) ? skills : discoverLocalSkills({ homeDir }))
    .filter((item) => item?.name && isValidCommandPrefix(`/${item.name}`));
  const activePending = pendingCommand && typeof pendingCommand === 'object'
    ? getActivePendingCommand({ pendingCommand })
    : null;
  const activePrefix = activePending ? activePending.prefix : '';

  const perPage = Math.max(3, Math.min(12, Number(skillPageSize) || 9));
  const totalPages = Math.max(1, Math.ceil(resolvedSkills.length / perPage));
  const safePage = Math.max(0, Math.min(totalPages - 1, Math.floor(Number(skillPage) || 0)));
  const startIdx = safePage * perPage;
  const visibleSkills = resolvedSkills.slice(startIdx, startIdx + perPage);

  const lines = [];
  if (activePrefix) {
    const armedFull = activePending?.template ? `${activePrefix} ${activePending.template}` : activePrefix;
    lines.push(
      `🎯 **已预选命令前缀**：\`${sanitizeForFeishuMarkdown(armedFull)}\``,
      `> 直接发文字、语音、截图或引用消息，插件会自动拼成 \`${sanitizeForFeishuMarkdown(armedFull)} <你的内容>\` 执行；再点一次按钮或点「❌ 取消预选」可取消。`,
      '',
    );
  }

  lines.push(
    '**⚡ agy 常用内置命令（点击下方按钮直接预选前缀，免复制）：**',
    '- `/compact`：压缩当前对话上下文（长对话提速省 token，点击立即执行）',
    '- `/plan <任务>`：先只读调研规划再动手执行（配专属审批看板）',
    '- `/grill-me <需求>`：交互式追问对齐需求细节与架构取舍',
    '- `/boost <复杂任务>`：深度思考、多角度规划与严格校验',
    '- `/goal <长耗时任务>`：持续推进直到目标达成（配启动检查 & 进度看板）',
    '- `/schedule <定时任务>`：设置一次性提醒或周期性 cron（配调度看板）',
    '- `/browser <网页任务>`：操控浏览器搜索或操作网页',
    '- `/learn <规则>`：把本次踩坑或偏好沉淀为长期规则',
    '- `/teamwork` / `/swarm <任务>`：多 Agent 分工协同（配成员状态看板，建议话题楼使用）',
    '- `/agy /<命令>`：强制透传与飞书插件重名的 `agy` 原始命令（如 `/agy /help`）',
    '',
    totalPages > 1
      ? `**🧩 本机已安装技能（Skills，共 ${resolvedSkills.length} 个 · 第 ${safePage + 1}/${totalPages} 页）：**`
      : `**🧩 本机已安装技能（Skills，共 ${resolvedSkills.length} 个）：**`,
  );

  if (resolvedSkills.length === 0) {
    lines.push('- _（暂未扫描到本地 SKILL.md，可检查 `~/.gemini/config/skills/` 或 `~/.agents/skills/`）_');
  } else {
    for (const s of visibleSkills) {
      const desc = s.description ? `：${sanitizeForFeishuMarkdown(s.description)}` : '';
      lines.push(`- \`/${sanitizeForFeishuMarkdown(s.name)}\`${desc}`);
    }
  }

  lines.push(
    '',
    '💡 用法：点下方任意命令/技能按钮即可预选前缀，或打开「📊 专属命令看板」进行启动配置、进度追踪与方案审批。',
  );

  const builtinButtons = [
    {
      label: '🗜️ /compact',
      type: activePrefix ? 'default' : 'primary',
      value: { cmd: 'run_agy_cmd', arg: '/compact' },
    },
    ...AGY_PRESET_COMMANDS.map((item) => {
      const isSelected = activePrefix === item.prefix;
      return {
        label: isSelected ? `✅ ${item.prefix}` : `${item.icon} ${item.prefix}`,
        type: isSelected ? 'primary' : 'default',
        value: { cmd: 'arm_cmd', arg: item.prefix, kind: 'builtin', skillPage: safePage, inplace: true },
      };
    }),
  ];

  const sections = [
    {
      title: '⚡ 常用命令（点选预填前缀，/compact 直接执行）',
      divider: true,
      rows: chunkButtons(builtinButtons, 4),
    },
    {
      title: '📊 专属命令看板（启动配置 / 进度监控 / 审批闭环）',
      divider: true,
      rows: [[
        { label: '🎯 Goal 看板', value: { cmd: 'cmd_board', board: 'goal', inplace: true } },
        { label: '🐝 Swarm 看板', value: { cmd: 'cmd_board', board: 'swarm', inplace: true } },
        { label: '⏰ 定时看板', value: { cmd: 'cmd_board', board: 'schedule', inplace: true } },
        { label: '🧭 Plan 看板', value: { cmd: 'cmd_board', board: 'plan', inplace: true } },
      ]],
    },
  ];

  if (visibleSkills.length > 0) {
    const skillButtons = visibleSkills.map((s) => {
      const prefix = `/${s.name}`;
      const shortName = s.name.length > 14 ? `${s.name.slice(0, 12)}…` : s.name;
      const isSelected = activePrefix === prefix;
      return {
        label: isSelected ? `✅ ${shortName}` : `🧩 ${shortName}`,
        type: isSelected ? 'primary' : 'default',
        value: { cmd: 'arm_cmd', arg: prefix, kind: 'skill', skillPage: safePage, inplace: true },
      };
    });
    const skillRows = chunkButtons(skillButtons, 3);
    if (totalPages > 1) {
      const pagerRow = [];
      if (safePage > 0) {
        pagerRow.push({
          label: `◀️ 上一页 (${safePage}/${totalPages})`,
          value: { cmd: 'skills_menu', skillPage: safePage - 1, inplace: true },
        });
      }
      if (safePage < totalPages - 1) {
        pagerRow.push({
          label: `▶️ 下一页 (${safePage + 2}/${totalPages})`,
          type: 'primary',
          value: { cmd: 'skills_menu', skillPage: safePage + 1, inplace: true },
        });
      }
      if (pagerRow.length > 0) {
        skillRows.push(pagerRow);
      }
    }
    sections.push({
      title: totalPages > 1
        ? `🧩 本机技能（点选预填 · 第 ${safePage + 1}/${totalPages} 页）`
        : '🧩 本机技能（点选预填 /技能名）',
      divider: true,
      rows: skillRows,
    });
  }

  const navRow = [];
  if (activePrefix) {
    navRow.push({
      label: '❌ 取消预选',
      type: 'danger',
      value: { cmd: 'clear_pending_cmd', fromSkills: true, skillPage: safePage, inplace: true },
    });
  }
  navRow.push(
    { label: '📖 插件指令', value: { cmd: 'help_commands', inplace: true } },
    { label: '📘 面板说明', value: { cmd: 'help', inplace: true } },
    { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
  );
  sections.push({ divider: true, rows: [navRow] });

  return buildSectionedCard({
    title: '🧩 agy 命令与本机技能',
    template: activePrefix ? 'wathet' : 'blue',
    markdown: lines.join('\n'),
    sections,
    footer: '发 / 或 /skills 可随时唤出 · 可在飞书机器人悬浮菜单配置 event_key: menu_commands',
  });
}

export function buildDirsCard({ chatState, config, page = 0, pageSize = 12, showHidden }) {
  const cwd = path.resolve(chatState?.cwd || config?.agy?.defaultCwd || os.homedir());
  const home = path.resolve(os.homedir());
  const parentDir = path.dirname(cwd);
  const includeHidden = showHidden !== undefined ? Boolean(showHidden) : Boolean(chatState?.showHiddenDirs);

  const rawFavorites = Array.isArray(config?.agy?.favoriteDirs) ? config.agy.favoriteDirs : [];
  const favoriteSeen = new Set();
  const canonicalCwd = canonicalizeDirPath(cwd);
  const favorites = [];
  for (const raw of rawFavorites) {
    if (!raw) continue;
    const resolved = path.resolve(raw);
    const canonical = canonicalizeDirPath(resolved);
    if (favoriteSeen.has(canonical)) continue;
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        favoriteSeen.add(canonical);
        favorites.push(resolved);
      }
    } catch {
      // Ignore inaccessible dirs
    }
  }
  const isPinned = favoriteSeen.has(canonicalCwd);

  let allSubDirs = [];
  let hiddenCount = 0;
  let readErr = '';
  try {
    const dirNames = fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => isDirectoryEntry(cwd, entry))
      .map((entry) => entry.name);
    hiddenCount = dirNames.filter((name) => name.startsWith('.')).length;
    allSubDirs = (includeHidden ? dirNames : dirNames.filter((name) => !name.startsWith('.')))
      .sort((a, b) => {
        if (includeHidden) {
          const aHidden = a.startsWith('.');
          const bHidden = b.startsWith('.');
          if (aHidden !== bHidden) return aHidden ? -1 : 1;
        }
        return a.localeCompare(b);
      });
  } catch (err) {
    readErr = err?.message || '无法读取目录';
  }
  const perPage = Math.max(3, Math.min(18, Number(pageSize) || 12));
  const totalPages = Math.max(1, Math.ceil(allSubDirs.length / perPage));
  const safePage = Math.max(0, Math.min(totalPages - 1, Math.floor(Number(page) || 0)));
  const startIdx = safePage * perPage;
  const subDirs = allSubDirs.slice(startIdx, startIdx + perPage);

  const hiddenHint = hiddenCount > 0 ? `（另有 ${hiddenCount} 个隐藏目录）` : '';
  const dirSummaryLine = readErr
    ? `- **子目录读取失败**：\`${readErr}\``
    : includeHidden
      ? allSubDirs.length > 0
        ? `- **子目录（含隐藏）**：共 ${allSubDirs.length} 个（隐藏 ${hiddenCount} 个）${totalPages > 1 ? `（第 ${safePage + 1}/${totalPages} 页，显示 ${startIdx + 1}–${startIdx + subDirs.length}）` : ''}`
        : '- **子目录（含隐藏）**：当前目录下暂无子文件夹'
      : allSubDirs.length > 0
        ? `- **可见子目录**：共 ${allSubDirs.length} 个${hiddenHint}${totalPages > 1 ? `（第 ${safePage + 1}/${totalPages} 页，显示 ${startIdx + 1}–${startIdx + subDirs.length}）` : ''}`
        : `- **可见子目录**：当前目录下暂无可见子文件夹${hiddenHint}`;

  const lines = [
    `- **当前目录**：\`${cwd}\``,
    `- **收藏目录**：${favorites.length} 个${isPinned ? '（当前目录已收藏）' : ''}`,
    dirSummaryLine,
  ];

  const navRow = [
    { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
  ];
  if (parentDir !== cwd) {
    navRow.push({ label: '⬆️ 上一级', value: { cmd: 'dir_nav', arg: parentDir, inplace: true } });
  }
  navRow.push({
    label: '🏠 ~',
    type: cwd === home ? 'primary' : 'default',
    value: { cmd: 'dir_nav', arg: home, inplace: true },
  });
  navRow.push({
    label: isPinned ? '📌 取消收藏' : '📌 收藏此目录',
    value: { cmd: 'pin_in_dirs', page: safePage, inplace: true },
  });
  navRow.push({
    label: includeHidden ? '👁️ 隐藏:开' : '🙈 显示隐藏',
    type: includeHidden ? 'primary' : 'default',
    value: { cmd: 'dirs', page: 0, showHidden: !includeHidden, inplace: true },
  });

  const favLabels = favorites.length > 0 ? formatQuickDirLabels(favorites.slice(0, 6), home) : [];
  const favRows = favorites.length > 0
    ? chunkButtons(
        favorites.slice(0, 6).map((dirPath, idx) => ({
          label: `⭐ ${favLabels[idx]}`,
          type: canonicalizeDirPath(dirPath) === canonicalCwd ? 'primary' : 'default',
          value: { cmd: 'dir_nav', arg: dirPath, inplace: true },
        })),
        3,
      )
    : [];

  const subDirRows = subDirs.length > 0
    ? chunkButtons(
        subDirs.map((name) => {
          const shortName = name.length > 14 ? `${name.slice(0, 12)}…` : name;
          return {
            label: `📁 ${shortName}`,
            value: { cmd: 'dir_nav', arg: path.join(cwd, name), inplace: true },
          };
        }),
        3,
      )
    : [];

  const pagerRow = [];
  if (totalPages > 1) {
    if (safePage > 0) {
      pagerRow.push({
        label: `◀️ 上一页 (${safePage}/${totalPages})`,
        value: { cmd: 'dirs', page: safePage - 1, inplace: true },
      });
    }
    if (safePage < totalPages - 1) {
      pagerRow.push({
        label: `▶️ 下一页 (${safePage + 2}/${totalPages})`,
        type: 'primary',
        value: { cmd: 'dirs', page: safePage + 1, inplace: true },
      });
    }
  }

  return buildCard({
    title: '📁 目录浏览与切换',
    template: 'blue',
    markdown: lines.join('\n'),
    buttonRows: [navRow, ...favRows, ...subDirRows, ...(pagerRow.length > 0 ? [pagerRow] : [])],
    footer: '点子目录进入，支持翻页与显示隐藏目录（如 .gemini）；也可发 /dirs -a 或 /cd <关键词>',
  });
}

function formatShortTimestamp(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return String(isoStr).slice(0, 16);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function buildOpsCard({
  snapshots = [],
  currentHash = '',
  runningHash = '',
  checkResult = null,
  isRunning = false,
  confirmSnapshot = null,
} = {}) {
  const hasUnappliedChanges = Boolean(currentHash && runningHash && currentHash !== runningHash);
  const lines = [
    `- **运行中版本**：\`${runningHash ? runningHash.slice(0, 8) : '-'}\``,
    `- **磁盘代码版本**：\`${currentHash ? currentHash.slice(0, 8) : '-'}\` ${hasUnappliedChanges ? '（⚠️ 有新改动待重启生效）' : '（✅ 与运行版本一致）'}`,
    `- **任务状态**：${isRunning ? '⏳ 有任务运行中（重启/回滚前请先中止）' : '🟢 空闲，可安全操作'}`,
  ];

  if (checkResult) {
    if (checkResult.ok) {
      lines.push(`- **最近体检**：✅ 通过（检查 ${checkResult.checkedFiles.length} 个脚本，耗时 ${checkResult.durationMs}ms）`);
    } else {
      lines.push(`- **最近体检**：❌ 发现 ${checkResult.errors.length} 处错误`);
      for (const errItem of checkResult.errors.slice(0, 5)) {
        const msg = sanitizeForFeishuMarkdown(String(errItem.error || '').replace(/\s+/g, ' ').trim().slice(0, 140));
        lines.push(`  - \`${errItem.file}\` [${errItem.stage}]：\`${msg}\``);
      }
    }
  }

  lines.push('', '**已存档快照（最多 5 个）：**');
  if (snapshots.length === 0) {
    lines.push('- _（暂无历史快照，点击「📸 保存快照」或重启后自动创建）_');
  } else {
    snapshots.slice(0, 5).forEach((snap, idx) => {
      const currentMark = snap.hash === currentHash ? ' ✅(磁盘当前)' : '';
      lines.push(`${idx + 1}. \`${snap.shortHash}\` · ${formatShortTimestamp(snap.createdAt)} · ${snap.reason}${currentMark}`);
    });
  }

  if (confirmSnapshot) {
    lines.push(
      '',
      `⚠️ **确认回滚**：将恢复到快照 \`${confirmSnapshot.shortHash}\`（${formatShortTimestamp(confirmSnapshot.createdAt)}，${confirmSnapshot.reason}）并自动重启守护进程？`,
    );
    return buildCard({
      title: '⚠️ 确认回滚快照',
      template: 'orange',
      markdown: lines.join('\n'),
      buttonRows: [[
        { label: '⚠️ 确认回滚并重启', type: 'danger', value: { cmd: 'rollback_exec', arg: confirmSnapshot.id, inplace: true } },
        { label: '取消', value: { cmd: 'ops', inplace: true } },
        { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
      ]],
      footer: '每次启动自动存档已知可用快照 · 安全重启前自动执行语法与导入预检',
    });
  }

  const row1 = [
    { label: '♻️ 安全重启', type: hasUnappliedChanges ? 'primary' : 'default', value: { cmd: 'safe_restart', inplace: true } },
    { label: '🧪 代码体检', value: { cmd: 'preflight', inplace: true } },
    { label: '📸 保存快照', value: { cmd: 'snapshot', inplace: true } },
    { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
  ];

  const otherSnapshots = snapshots.filter((s) => s.hash !== currentHash);
  const row2 = [];
  if (otherSnapshots[0]) {
    row2.push({
      label: `⏪ 回滚上一版 (${otherSnapshots[0].shortHash})`,
      type: 'danger',
      value: { cmd: 'rollback_confirm', arg: otherSnapshots[0].id, inplace: true },
    });
  }
  for (const snap of otherSnapshots.slice(1, 4)) {
    row2.push({
      label: `🕰️ ${formatShortTimestamp(snap.createdAt)} (${snap.shortHash})`,
      value: { cmd: 'rollback_confirm', arg: snap.id, inplace: true },
    });
  }

  const template = checkResult && !checkResult.ok ? 'red' : hasUnappliedChanges ? 'wathet' : 'blue';
  return buildCard({
    title: '🛡️ 运维与自迭代（重启 / 回滚）',
    template,
    markdown: lines.join('\n'),
    buttonRows: row2.length > 0 ? [row1, ...chunkButtons(row2, 2)] : [row1],
    footer: '每次启动自动存档已知可用快照 · 安全重启前自动执行语法与导入预检',
  });
}

const SKIP_SEARCH_DIRS = new Set(['node_modules', 'Library', 'Applications']);

function listChildDirsSafe(parentDir) {
  try {
    if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) return [];
    return fs
      .readdirSync(parentDir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && !SKIP_SEARCH_DIRS.has(e.name) && isDirectoryEntry(parentDir, e))
      .map((e) => path.join(parentDir, e.name));
  } catch {
    return [];
  }
}

export function searchDirsFuzzy(query, { config, currentCwd = '', limit = 8 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  const home = os.homedir();
  const favs = Array.isArray(config?.agy?.favoriteDirs) ? config.agy.favoriteDirs : [];
  const favoriteSet = new Set(favs.map((d) => path.resolve(d)));
  const candidates = new Set();
  const seenReal = new Set();

  const addCandidate = (dirPath) => {
    if (!dirPath) return;
    const resolved = path.resolve(dirPath);
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        const real = canonicalizeDirPath(resolved);
        if (seenReal.has(real)) return;
        seenReal.add(real);
        candidates.add(resolved);
      }
    } catch {
      // Ignore inaccessible dirs
    }
  };

  for (const fav of favs) addCandidate(fav);
  if (config?.agy?.defaultCwd) addCandidate(config.agy.defaultCwd);
  if (currentCwd) {
    addCandidate(currentCwd);
    for (const sub of listChildDirsSafe(currentCwd)) addCandidate(sub);
  }
  for (const sub of listChildDirsSafe(home)) addCandidate(sub);

  const roots = [
    path.join(home, 'Desktop'),
    path.join(home, 'Desktop', 'proj'),
    path.join(home, 'Projects'),
    path.join(home, 'projects'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    path.join(home, 'code'),
    path.join(home, 'workspace'),
    path.join(home, 'dev'),
    path.join(home, 'Library', 'CloudStorage'),
  ];
  for (const root of roots) {
    addCandidate(root);
    for (const child of listChildDirsSafe(root)) {
      addCandidate(child);
      for (const grand of listChildDirsSafe(child)) {
        addCandidate(grand);
      }
    }
  }

  const scored = [];
  for (const dir of candidates) {
    const base = path.basename(dir).toLowerCase();
    const fullLower = dir.toLowerCase();
    let score = 0;
    if (base === q) {
      score = 100;
    } else if (base.startsWith(q)) {
      score = 80;
    } else if (base.includes(q)) {
      score = 60;
    } else if (fullLower.includes(q)) {
      score = 30;
    }
    if (score === 0) continue;
    if (favoriteSet.has(dir)) score += 10;
    scored.push({ dir, score });
  }

  scored.sort((a, b) => b.score - a.score || a.dir.length - b.dir.length);
  return scored.slice(0, limit).map((item) => item.dir);
}

export function buildDirSearchCard({ query, matches = [], currentCwd = '' }) {
  const home = path.resolve(os.homedir());
  const resolvedCwd = currentCwd ? path.resolve(currentCwd) : '';
  const lines = [
    `- **搜索关键词**：\`${sanitizeForFeishuMarkdown(query)}\``,
    `- **匹配目录（前 ${matches.length} 个）**：`,
    '',
    ...matches.map((dirPath, idx) => {
      const currentMark = dirPath === resolvedCwd ? ' ✅(当前)' : '';
      return `${idx + 1}. \`${dirPath}\`${currentMark}`;
    }),
  ];

  const matchButtons = matches.map((dirPath) => ({
    label: `📂 ${formatShortDirName(dirPath, home)}`,
    type: dirPath === resolvedCwd ? 'primary' : 'default',
    value: { cmd: 'cd', arg: dirPath, inplace: true },
  }));

  const navRow = [
    { label: '📁 切换目录', value: { cmd: 'dirs', inplace: true } },
    { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
  ];

  return buildCard({
    title: '🔍 匹配到多个目录，请点击切换',
    template: 'blue',
    markdown: lines.join('\n'),
    buttonRows: [...chunkButtons(matchButtons, 2), navRow],
    footer: '点击按钮直接切换工作目录，也可发 /pin 收藏目录',
  });
}

export function buildQueuedCard({ position, queueId, promptPreview = '', runningPreview = '' }) {
  const previewClean = sanitizeForFeishuMarkdown(
    String(promptPreview || '').replace(/\s+/g, ' ').trim().slice(0, 80),
  );
  const runningClean = sanitizeForFeishuMarkdown(
    String(runningPreview || '').replace(/\s+/g, ' ').trim().slice(0, 80),
  );
  const lines = [
    `- **队列位置**：第 \`${position}\` 位（当前任务完成后将自动开始）`,
    previewClean ? `- **排队指令**：\`${previewClean}\`` : '',
    runningClean ? `- **当前运行**：\`${runningClean}\`` : '',
  ].filter(Boolean);

  return buildCard({
    title: `📥 已加入任务队列（第 ${position} 位）`,
    template: 'wathet',
    markdown: lines.join('\n'),
    buttonRows: [[
      { label: '🛑 中止当前并立刻执行', type: 'danger', value: { cmd: 'queue_promote', arg: queueId } },
      { label: '🗑️ 取消排队', value: { cmd: 'queue_cancel', arg: queueId } },
      { label: '📋 查看队列', value: { cmd: 'queue_list' } },
    ]],
    footer: '任务排队中 · 支持发多条指令自动接力，也可用 /queue 管理',
  });
}

export function buildQueueListCard({ running = null, queue = [] }) {
  const lines = [];
  if (running) {
    const elapsed = Math.round((Date.now() - (running.startedAt || Date.now())) / 1000);
    const runPreview = sanitizeForFeishuMarkdown(
      String(running.promptPreview || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    );
    lines.push(`- **运行中（${elapsed}s）**：\`${runPreview || '正在处理'}\``);
  } else {
    lines.push('- **运行中**：空闲');
  }

  lines.push('', `**等待队列（共 ${queue.length} 条）：**`);
  if (queue.length === 0) {
    lines.push('- _（队列为空）_');
  } else {
    queue.forEach((item, idx) => {
      const text = sanitizeForFeishuMarkdown(
        String(item?.payload?.displayPreview || item?.payload?.text || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 50),
      );
      lines.push(`${idx + 1}. \`${text || '待执行任务'}\``);
    });
  }

  const cancelButtons = queue.slice(0, 4).map((item, idx) => ({
    label: `🗑️ 取消第${idx + 1}条`,
    value: { cmd: 'queue_cancel', arg: item.id, inplace: true },
  }));

  const navRow = [];
  if (running) {
    navRow.push({ label: '🛑 中止当前任务', type: 'danger', value: { cmd: 'stop', inplace: true } });
  }
  if (queue.length > 0) {
    navRow.push({ label: '🗑️ 清空队列', type: 'danger', value: { cmd: 'queue_clear', inplace: true } });
  }
  navRow.push({ label: '🔄 刷新', value: { cmd: 'queue_list', inplace: true } });
  navRow.push({ label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } });

  return buildCard({
    title: '📋 任务排队队列',
    template: queue.length > 0 ? 'wathet' : 'blue',
    markdown: lines.join('\n'),
    buttonRows: [...chunkButtons(cancelButtons, 2), navRow].filter((r) => r.length > 0),
  });
}

const KEY_APP_SCOPES = [
  { name: 'im:resource', label: '图片/文件收发' },
  { name: 'cardkit:card:write', label: 'CardKit 2.0 打字机流式' },
  { name: 'im:message.reactions:write_only', label: '消息表情反馈' },
  { name: 'im:message:readonly', label: '引用历史消息读取' },
  { name: 'docx:document:readonly', label: '云文档只读' },
  { name: 'docx:document:write_only', label: '云文档写入' },
  { name: 'docx:document.block:convert', label: 'Markdown 转云文档块' },
  { name: 'docs:permission.member:create', label: '云文档协作者授权' },
  { name: 'wiki:node:read', label: 'Wiki 知识库节点解析' },
  { name: 'task:task:read', label: '飞书任务只读（个人/话题待办）' },
  { name: 'task:task:write', label: '飞书任务新建/完成' },
  { name: 'task:tasklist:read', label: '飞书任务清单只读' },
];

export function buildScopesCard({ scopes = [], granted = [], pending = [], applyResult = null } = {}) {
  const grantedSet = new Set(granted.map((s) => s.scopeName));
  const hasScope = (name) => grantedSet.has(name) || (name.startsWith('docx:document:') && grantedSet.has('docx:document'));

  const lines = [
    `- **总计已授权权限**：\`${granted.length} / ${scopes.length}\``,
    `- **待管理员审核权限**：\`${pending.length}\` 项`,
    '',
    '**关键能力权限自检：**',
    ...KEY_APP_SCOPES.map((item) => `- ${hasScope(item.name) ? '✅' : '⚠️'} **${item.label}**（\`${item.name}\`）`),
  ];

  if (pending.length > 0) {
    lines.push('', '**待授权（未生效）列表：**');
    for (const item of pending.slice(0, 10)) {
      lines.push(`- \`${item.scopeName}\` (${item.scopeType})`);
    }
    if (pending.length > 10) {
      lines.push(`- _...其余 ${pending.length - 10} 项_`);
    }
  }

  if (applyResult) {
    lines.push(
      '',
      applyResult.ok
        ? `✅ **申请结果**：${sanitizeForFeishuMarkdown(applyResult.msg)}`
        : `⚠️ **申请返回（code=${applyResult.code ?? '?'}）**：${sanitizeForFeishuMarkdown(applyResult.msg)}`,
    );
  }

  const row1 = [];
  if (pending.length > 0) {
    row1.push({ label: '📨 重发管理员审批申请', type: 'primary', value: { cmd: 'scopes_apply', inplace: true } });
  }
  row1.push({ label: '🔄 刷新权限', value: { cmd: 'scopes', inplace: true } });
  row1.push({ label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } });

  return buildCard({
    title: '🔐 飞书应用权限自检',
    template: pending.length > 0 ? 'orange' : 'green',
    markdown: lines.join('\n'),
    buttonRows: [row1],
    footer: '新权限需先在 open.feishu.cn 权限管理勾选并创建版本；待审权限可点上方按钮触发审批',
  });
}

export function buildGitStatusCard({ cwd, gitInfo }) {
  if (!gitInfo?.isRepo) {
    return buildCard({
      title: '🌿 Git 状态',
      template: 'grey',
      markdown: [
        `- **当前目录**：\`${cwd}\``,
        `- **状态**：当前目录不是 Git 仓库（\`${sanitizeForFeishuMarkdown(gitInfo?.error || 'not a git repository')}\`）`,
      ].join('\n'),
      buttonRows: [[
        { label: '📁 切换目录', value: { cmd: 'dirs', inplace: true } },
        { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
      ]],
    });
  }

  const statusLines = Array.isArray(gitInfo.statusLines) ? gitInfo.statusLines : [];
  const commits = Array.isArray(gitInfo.commits) ? gitInfo.commits : [];
  const lines = [
    `- **当前目录**：\`${cwd}\``,
    `- **当前分支**：\`${sanitizeForFeishuMarkdown(gitInfo.branch || 'HEAD')}\``,
    `- **工作区变更**：${statusLines.length > 0 ? `${statusLines.length} 个文件` : '✅ 干净（无未提交改动）'}`,
  ];

  if (statusLines.length > 0) {
    const shown = statusLines.slice(0, 20).join('\n');
    const more = statusLines.length > 20 ? `\n...其余 ${statusLines.length - 20} 条` : '';
    lines.push('', '```text', `${shown}${more}`, '```');
  }

  if (commits.length > 0) {
    lines.push('', '**最近 5 条提交：**', '```text', commits.join('\n'), '```');
  }

  return buildCard({
    title: '🌿 Git 仓库状态',
    template: statusLines.length > 0 ? 'wathet' : 'green',
    markdown: lines.join('\n'),
    buttonRows: [[
      { label: '🔄 刷新 Git', type: 'primary', value: { cmd: 'git', inplace: true } },
      { label: '📁 切换目录', value: { cmd: 'dirs', inplace: true } },
      { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
    ]],
    footer: '零延迟本地查询（不消耗模型额度）',
  });
}

export function buildEffortCard(currentEffort = '') {
  const options = [
    { id: 'default', label: 'default (随 CLI)' },
    { id: 'low', label: '⚡ low (极速)' },
    { id: 'medium', label: '⚖️ medium (均衡)' },
    { id: 'high', label: '🧠 high (深入)' },
    { id: 'xhigh', label: '🔥 xhigh (深度)' },
    { id: 'max', label: '🚀 max (极限)' },
  ];

  const buttons = options.map((opt) => {
    const isActive = opt.id === 'default' ? !currentEffort : currentEffort === opt.id;
    return {
      label: opt.label,
      type: isActive ? 'primary' : 'default',
      value: { cmd: 'effort', arg: opt.id, inplace: true },
    };
  });

  return buildCard({
    title: '🎛️ 推理强度设置 (Reasoning Effort)',
    template: 'blue',
    markdown: [
      `- **当前强度**：\`${currentEffort || 'default (随 CLI 配置)'}\``,
      '',
      '日常简单问答可用 `low` / `medium` 快速响应；复杂架构改造或定位疑难 bug 可调为 `high` / `xhigh` / `max`。',
    ].join('\n'),
    buttonRows: [
      ...chunkButtons(buttons, 2),
      [{ label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } }],
    ],
    footer: '也可在聊天发送 /effort <low|medium|high|xhigh|max|default>',
  });
}

function formatCompactTimeAgo(ms) {
  if (!ms) return '未知时间';
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  return `${Math.floor(diffHour / 24)}天前`;
}

/**
 * Render the desktop conversation scan/search list card (CLI + Desktop App).
 */
export function buildDesktopSessionsCard({
  items = [],
  query = '',
  filter = 'all',
  currentConvId = '',
  pendingHandoffId = '',
} = {}) {
  const safeQuery = String(query || '').trim();
  const visibleItems = items.slice(0, 8);

  const lines = [];
  if (safeQuery) {
    lines.push(`🔍 搜索关键词：\`${safeQuery}\`（命中 ${items.length} 条）`, '');
  }

  if (visibleItems.length === 0) {
    lines.push(
      safeQuery
        ? '未在本地电脑端历史对话中找到匹配记录。可尝试换个关键词或切换筛选范围。'
        : '暂未扫描到电脑端历史对话记录。',
    );
  } else {
    visibleItems.forEach((item, idx) => {
      const sourceIcon = item.source === 'cli' ? '⌨️ CLI' : '🖥️ 桌面';
      const statusBadge = item.running ? '🟡 运行中' : '⚪ 空闲';
      const modeBadge = item.takeoverMode === 'native' ? '原生直连' : '摘要接管';
      const timeLabel = formatCompactTimeAgo(item.lastModifiedMs);
      const workspaceName = item.workspace ? path.basename(item.workspace) : '无目录';
      const activeMark =
        item.id === currentConvId
          ? ' **✅当前**'
          : item.id === pendingHandoffId
            ? ' **🔗待注入**'
            : '';
      const shortTitle = sanitizeForFeishuMarkdown(item.title || '(无标题)').replace(/\s+/g, ' ').slice(0, 40);
      lines.push(
        `${idx + 1}. **${shortTitle}**${activeMark}`,
        `   ${sourceIcon} · ${statusBadge} · ${modeBadge} · \`${workspaceName}\` · ${item.stepCount || 0}步 · ${timeLabel}`,
      );
    });
    lines.push('', '点击下方编号按钮预览最近对话并选择接管方式，或发送 `/desktop <关键词>` 搜索。');
  }

  const tabRow = [
    { label: '📱 飞书会话', value: { cmd: 'sessions', inplace: true } },
    {
      label: '💻 全部电脑',
      type: filter === 'all' ? 'primary' : 'default',
      value: { cmd: 'desktop_list', filter: 'all', query: safeQuery, inplace: true },
    },
    {
      label: '⚡ 运行中',
      type: filter === 'running' ? 'primary' : 'default',
      value: { cmd: 'desktop_list', filter: 'running', query: safeQuery, inplace: true },
    },
  ];

  const filterRow = [
    {
      label: '🖥️ 桌面 App',
      type: filter === 'desktop' ? 'primary' : 'default',
      value: { cmd: 'desktop_list', filter: 'desktop', query: safeQuery, inplace: true },
    },
    {
      label: '⌨️ CLI',
      type: filter === 'cli' ? 'primary' : 'default',
      value: { cmd: 'desktop_list', filter: 'cli', query: safeQuery, inplace: true },
    },
    {
      label: '🔄 刷新扫描',
      value: { cmd: 'desktop_list', filter, query: safeQuery, inplace: true },
    },
  ];

  const previewButtons = visibleItems.slice(0, 6).map((item, idx) => {
    const labelText = (item.title || item.id.slice(0, 8)).replace(/\s+/g, ' ').slice(0, 10);
    return {
      label: `${idx + 1}. ${labelText}`,
      type: item.id === currentConvId ? 'primary' : 'default',
      value: { cmd: 'desktop_preview', arg: item.id, filter, query: safeQuery, inplace: true },
    };
  });

  const buttonRows = [
    tabRow,
    filterRow,
    ...chunkButtons(previewButtons, 2),
    [{ label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } }],
  ];

  return buildCard({
    title: '💻 电脑端历史对话',
    template: visibleItems.some((item) => item.running) ? 'orange' : 'blue',
    markdown: lines.join('\n'),
    buttonRows,
    footer: 'CLI 对话支持 --conversation 原生直连；桌面 App 对话自动通过只读摘要无损接力',
  });
}

/**
 * Render detailed preview card for a selected desktop conversation before takeover.
 */
export function buildDesktopSessionPreviewCard(detail, { filter = 'all', query = '' } = {}) {
  const safeQuery = String(query || '').trim();
  const safeTitle = sanitizeForFeishuMarkdown(detail?.title || '(无标题对话)');
  const modeDesc =
    detail?.takeoverMode === 'native'
      ? '✅ **原生直连**（直接续接 CLI 会话历史，保留完整轨迹）'
      : '🔄 **只读摘要接管**（桌面端独立存储，自动切目录并在下条消息注入最近对话上下文）';

  const lines = [
    `### ${safeTitle}`,
    `- **来源**：${detail?.sourceLabel || '电脑端'}（${detail?.running ? '🟡 运行中' : '⚪ 空闲'}）`,
    `- **接管模式**：${modeDesc}`,
    `- **工作目录**：\`${detail?.workspace || '(未记录，将沿用当前目录)'}\``,
    `- **累计步数**：\`${detail?.stepCount || 0}\` 步 · **最近更新**：${formatCompactTimeAgo(detail?.lastModifiedMs)}`,
    `- **会话 ID**：\`${detail?.id || ''}\``,
  ];

  if (detail?.running) {
    lines.push('> ⚠️ 该会话在扫描时显示为运行中，接管或操作文件前建议先检查目录变更状态。');
  }

  const turns = Array.isArray(detail?.turns) ? detail.turns : [];
  if (turns.length > 0) {
    lines.push('', '**最近对话摘要：**');
    for (const turn of turns.slice(-4)) {
      const icon = turn.role === 'user' ? '👤 用户' : '🤖 助手';
      const excerpt = sanitizeForFeishuMarkdown(String(turn.text || ''))
        .replace(/\n+/g, ' ')
        .slice(0, 180);
      lines.push(`- **${icon}**：${excerpt}${String(turn.text || '').length > 180 ? '...' : ''}`);
    }
  } else if (detail?.preview) {
    const safePreview = sanitizeForFeishuMarkdown(detail.preview).replace(/\n+/g, ' ').slice(0, 260);
    lines.push('', `**预览**：${safePreview}`);
  } else {
    lines.push('', '_暂未提取到对话正文，将仅使用标题与工作目录接管。_');
  }

  const secondRow = [];
  if (detail?.lastAssistantReply) {
    secondRow.push({
      label: '📄 查看最新回复',
      value: { cmd: 'desktop_last_reply', arg: detail.id },
    });
  }
  secondRow.push(
    {
      label: '⬅️ 返回列表',
      value: { cmd: 'desktop_list', filter, query: safeQuery, inplace: true },
    },
    { label: '⚙️ 控制面板', value: { cmd: 'panel', inplace: true } },
  );

  return buildCard({
    title: '🔍 电脑端对话详情预览',
    template: detail?.running ? 'orange' : 'blue',
    markdown: lines.join('\n'),
    buttonRows: [
      [
        {
          label: '🧵 新开话题接管',
          type: 'primary',
          value: { cmd: 'takeover_new_topic', arg: detail.id, summarize: false },
        },
        {
          label: '📱 当前对话接管',
          value: { cmd: 'desktop_takeover', arg: detail.id, summarize: false, inplace: true },
        },
        {
          label: '👀 接管并总结',
          value: { cmd: 'desktop_takeover', arg: detail.id, summarize: true, inplace: false },
        },
      ],
      secondRow,
    ],
    footer: '「新开话题接管」彻底隔离上下文 · 「当前对话接管」适合临时追问',
  });
}

/**
 * Render the 3-mode desktop stop-notification switcher card (on / away / off).
 */
export function buildNotifyCard({ config } = {}) {
  const mode = resolveStopNotifyMode(config);
  const idleSeconds = Math.max(10, Number(config?.notifications?.awayIdleSeconds || 120));
  const idleMin = Math.max(1, Math.round(idleSeconds / 60));

  const modeDesc = mode === 'on'
    ? '🔔 **始终提醒（`on`）** — 桌面端每次任务完成都会推飞书卡片'
    : mode === 'away'
      ? `🧠 **仅离开电脑时提醒（\`away\`）** — 键鼠空闲超过 **${idleMin} 分钟**（\`${idleSeconds}s\`）才推飞书，在电脑前操作时自动静音`
      : '🔕 **已关闭（`off`）** — 不再推送桌面端完成通知（飞书远程发起的任务正常流式回复）';

  const modeRow = [
    {
      label: '🔔 始终提醒',
      type: mode === 'on' ? 'primary' : 'default',
      value: { cmd: 'notify_mode', arg: 'on', inplace: true },
    },
    {
      label: '🧠 仅离开电脑时',
      type: mode === 'away' ? 'primary' : 'default',
      value: { cmd: 'notify_mode', arg: 'away', inplace: true },
    },
    {
      label: '🔕 关闭提醒',
      type: mode === 'off' ? 'primary' : 'default',
      value: { cmd: 'notify_mode', arg: 'off', inplace: true },
    },
  ];

  const idleRow = [
    {
      label: '⏱️ 离开 1 分钟',
      type: mode === 'away' && idleSeconds === 60 ? 'primary' : 'default',
      value: { cmd: 'notify_idle', arg: '60', inplace: true },
    },
    {
      label: '⏱️ 离开 2 分钟',
      type: mode === 'away' && idleSeconds === 120 ? 'primary' : 'default',
      value: { cmd: 'notify_idle', arg: '120', inplace: true },
    },
    {
      label: '⏱️ 离开 5 分钟',
      type: mode === 'away' && idleSeconds === 300 ? 'primary' : 'default',
      value: { cmd: 'notify_idle', arg: '300', inplace: true },
    },
  ];

  return buildCard({
    title: '🔔 桌面端完成提醒设置',
    template: mode === 'off' ? 'grey' : mode === 'away' ? 'wathet' : 'blue',
    markdown: [
      `- **当前模式**：${modeDesc}`,
      '',
      '**说明**：`away` 模式通过系统键鼠空闲时长（macOS `HIDIdleTime`）判断你是否在电脑前；切换后立即生效，无需重启守护进程。',
    ].join('\n'),
    buttonRows: [
      modeRow,
      idleRow,
      [{ label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } }],
    ],
    footer: '也可在聊天发送 /notify <on|away|off> 或 /mute',
  });
}

/**
 * Render the single-turn task timeout settings card (global default + per-chat override).
 */
export function buildTimeoutCard({ chatState = null, config = {} } = {}) {
  const {
    effectiveSec,
    hasOverride,
    effectiveLabel,
    globalLabel,
  } = resolveTimeoutDisplay(chatState, config);

  const globalOptions = [
    { label: '30 分钟', arg: '30m', seconds: 1800 },
    { label: '60 分钟', arg: '60m', seconds: 3600 },
    { label: '2 小时', arg: '2h', seconds: 7200 },
    { label: '4 小时', arg: '4h', seconds: 14400 },
    { label: '♾️ 不限时', arg: '0', seconds: 0 },
  ];

  const globalButtons = globalOptions.map((opt) => ({
    label: opt.label,
    type: !hasOverride && effectiveSec === opt.seconds ? 'primary' : 'default',
    value: { cmd: 'timeout_set', arg: opt.arg, scope: 'global', inplace: true },
  }));

  const chatOptions = [
    { label: '⏱️ 本会话 30m', arg: '30m', seconds: 1800 },
    { label: '⏱️ 本会话 2h', arg: '2h', seconds: 7200 },
    { label: '♾️ 本会话不限时', arg: '0', seconds: 0 },
  ];

  const chatRow = chatOptions.map((opt) => ({
    label: opt.label,
    type: hasOverride && effectiveSec === opt.seconds ? 'primary' : 'default',
    value: { cmd: 'timeout_set', arg: opt.arg, scope: 'chat', inplace: true },
  }));
  if (hasOverride) {
    chatRow.push({
      label: '↩️ 跟随全局默认',
      value: { cmd: 'timeout_clear_override', inplace: true },
    });
  }

  return buildSectionedCard({
    title: '⏱️ 单轮任务超时设置',
    template: effectiveSec === 0 ? 'wathet' : 'blue',
    markdown: [
      `- **当前生效**：\`${effectiveLabel}\`${hasOverride ? '（本会话单独覆盖）' : '（跟随全局默认）'}`,
      `- **全局默认**：\`${globalLabel}\``,
      '',
      '超过 10 分钟的长任务会自动切为全卡节流刷新；设为不限时后可随时点「🛑 立即中止」或发 `/stop` 结束。',
    ].join('\n'),
    sections: [
      {
        title: '🌍 设为全局默认（本会话立即生效）',
        divider: true,
        rows: [
          globalButtons.slice(0, 3),
          globalButtons.slice(3),
        ],
      },
      {
        title: '💬 仅当前会话覆盖',
        divider: true,
        rows: [chatRow],
      },
      {
        divider: true,
        rows: [[
          { label: '🛠️ 返回设置', value: { cmd: 'system_menu', inplace: true } },
          { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
        ]],
      },
    ],
    footer: '自定义时长可发送 /timeout 90m、/timeout 3h 或 /timeout 0（不限时）',
  });
}

export function buildTasksCard({
  items = [],
  filter = 'open',
  authStatus = null,
  error = '',
} = {}) {
  const safeFilter = ['open', 'done', 'all'].includes(filter) ? filter : 'open';
  const isAuthorized = Boolean(authStatus?.authorized);
  const authNeeded =
    !isAuthorized ||
    /FEISHU_USER_AUTH_REQUIRED|尚未完成飞书用户授权|授权已过期|缺少 refresh_token/i.test(String(error || ''));

  if (authNeeded) {
    const lines = [
      '- **当前状态**：🔒 尚未完成飞书用户 OAuth 授权（或授权已过期）',
      error ? `- **详细信息**：\`${sanitizeForFeishuMarkdown(String(error).slice(0, 220))}\`` : '',
      '',
      '**一次性授权步骤（3 步）：**',
      '1. 飞书开放平台 → **安全设置 → 重定向 URL**：添加 `http://127.0.0.1:18923/callback`',
      '2. 飞书开放平台 → **权限管理** 开通权限：`offline_access`、`task:task:read`、`task:task:write`、`task:tasklist:read` 并发布新版本',
      '3. 在本机终端运行一次（会自动启动本机回调服务并弹出带 state 校验的安全授权页）：',
      '```bash',
      `node ${path.join(getPluginRoot(), 'scripts', 'cli.mjs')} auth`,
      '```',
    ].filter(Boolean);

    return buildCard({
      title: '✅ 飞书任务中心（待授权）',
      template: 'orange',
      markdown: lines.join('\n'),
      buttonRows: [[
        { label: '🔄 重新检查', type: 'primary', value: { cmd: 'tasks', filter: safeFilter, inplace: true } },
        { label: '🔐 权限自检', value: { cmd: 'scopes', inplace: true } },
        { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
      ]],
      footer: '授权凭证以本地受保护存储存于 ~/.config/antigravity-feishu/user-auth.json（0600），支持自动刷新续期',
    });
  }

  const visibleItems = Array.isArray(items) ? items.slice(0, 10) : [];
  const filterTitle = safeFilter === 'open' ? '未完成' : safeFilter === 'done' ? '已完成' : '全部';
  const lines = [
    `- **视图**：\`${filterTitle}\`（展示 ${visibleItems.length}${Array.isArray(items) && items.length > visibleItems.length ? ` / ${items.length}` : ''} 条）`,
  ];
  if (error) {
    lines.push(`- **接口提示**：\`${sanitizeForFeishuMarkdown(String(error).slice(0, 200))}\``);
  }
  lines.push('');

  if (visibleItems.length === 0) {
    lines.push('_（当前视图下暂无任务）_');
  } else {
    visibleItems.forEach((item, idx) => {
      const icon = item.completed ? '✅' : '⬜';
      const title = sanitizeForFeishuMarkdown(String(item.summary || '(无标题任务)').replace(/\s+/g, ' ').trim());
      const duePart = item.dueText ? ` · ⏰ \`${item.dueText}\`` : '';
      const shortGuid = item.guid ? ` \`${item.guid.slice(0, 8)}\`` : '';
      lines.push(`${idx + 1}. ${icon} **${title}**${duePart}${shortGuid}`);
      if (item.description) {
        const descOneLine = String(item.description).replace(/\s+/g, ' ').trim();
        const snippet = descOneLine.length > 60 ? `${descOneLine.slice(0, 58)}…` : descOneLine;
        lines.push(`   > ${sanitizeForFeishuMarkdown(snippet)}`);
      }
    });
  }

  const filterRow = [
    {
      label: '📋 未完成',
      type: safeFilter === 'open' ? 'primary' : 'default',
      value: { cmd: 'tasks', filter: 'open', inplace: true },
    },
    {
      label: '✅ 已完成',
      type: safeFilter === 'done' ? 'primary' : 'default',
      value: { cmd: 'tasks', filter: 'done', inplace: true },
    },
    {
      label: '📑 全部',
      type: safeFilter === 'all' ? 'primary' : 'default',
      value: { cmd: 'tasks', filter: 'all', inplace: true },
    },
    { label: '🔄 刷新', value: { cmd: 'tasks', filter: safeFilter, inplace: true } },
    { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
  ];

  const actionButtons = [];
  visibleItems.slice(0, 4).forEach((item, idx) => {
    if (!item.guid) return;
    actionButtons.push({
      label: `🤖 执行 #${idx + 1}`,
      type: 'primary',
      value: { cmd: 'task_run', arg: item.guid },
    });
    actionButtons.push({
      label: item.completed ? `↩️ 重开 #${idx + 1}` : `✅ 完成 #${idx + 1}`,
      value: { cmd: 'task_toggle', arg: item.guid, done: !item.completed, filter: safeFilter, inplace: true },
    });
  });

  return buildCard({
    title: `✅ 飞书任务中心（${filterTitle}）`,
    template: error ? 'orange' : 'blue',
    markdown: lines.join('\n'),
    buttonRows: [filterRow, ...chunkButtons(actionButtons, 2)],
    footer: '支持 /tasks add 标题 | 说明 新建待办；直接发或引用任务卡片也可触发执行',
  });
}
