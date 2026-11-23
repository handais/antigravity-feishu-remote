import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { getEffectiveQuickPrompts } from './config.mjs';
import { isImageFilePath, resolveFeishuFileType } from './media.mjs';

export function createStderrLogger(prefix = 'lark') {
  return {
    error: (...args) => console.error(`[${prefix}:error]`, ...args),
    warn: (...args) => console.error(`[${prefix}:warn]`, ...args),
    info: (...args) => console.error(`[${prefix}:info]`, ...args),
    debug: () => {},
    trace: () => {},
  };
}

export function resolveLarkDomain(domainStr) {
  return String(domainStr || '').toLowerCase() === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

export function createFeishuClient(config, { quiet = true } = {}) {
  const appId = config?.feishu?.appId?.trim();
  const appSecret = config?.feishu?.appSecret?.trim();
  if (!appId || !appSecret) {
    throw new Error('Feishu appId and appSecret are required.');
  }
  return new Lark.Client({
    appId,
    appSecret,
    domain: resolveLarkDomain(config?.feishu?.domain),
    disableTokenCache: false,
    logger: createStderrLogger('lark-api'),
    loggerLevel: quiet ? Lark.LoggerLevel.warn : Lark.LoggerLevel.info,
  });
}

export function sanitizeForFeishuMarkdown(text) {
  if (!text) return '';
  return String(text)
    .replace(/\0/g, '')
    .replace(/\[([^\]]+)\]\(file:\/\/[^)]+\)/g, '`$1`');
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

export function splitMarkdownChunks(text, maxLen = 7000) {
  const normalized = String(text || '').trim();
  if (!normalized) return [''];
  if (normalized.length <= maxLen) return [normalized];

  const lines = normalized.split('\n');
  const chunks = [];
  let currentLines = [];
  let currentLen = 0;
  let activeFence = null;

  const flushChunk = () => {
    if (currentLines.length === 0) return;
    if (activeFence) {
      currentLines.push(activeFence.char.repeat(activeFence.len));
    }
    chunks.push(currentLines.join('\n').trimEnd());
    currentLines = activeFence ? [activeFence.header] : [];
    currentLen = currentLines.reduce((sum, l) => sum + l.length + 1, 0);
  };

  for (const rawLine of lines) {
    let line = rawLine;
    // Handle a single line exceeding maxLen by slicing safely
    while (line.length > maxLen - 40) {
      if (currentLines.length > 0) {
        flushChunk();
      }
      const sliceSize = Math.max(200, maxLen - 40);
      chunks.push(line.slice(0, sliceSize));
      line = line.slice(sliceSize);
    }

    const fenceReserve = activeFence ? activeFence.len + 2 : 0;
    const needed = line.length + 1 + fenceReserve;
    if (currentLines.length > 0 && currentLen + needed > maxLen) {
      flushChunk();
    }

    currentLines.push(line);
    currentLen += line.length + 1;
    activeFence = updateFenceState(line, activeFence);
  }

  if (currentLines.length > 0) {
    const joined = currentLines.join('\n').trimEnd();
    if (joined) {
      chunks.push(joined);
    }
  }

  return chunks.length > 0 ? chunks : [''];
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
    elements.push({
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
    });
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
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
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
    if (seen.has(resolved)) continue;
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        seen.add(resolved);
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

export function chunkButtons(buttons, perRow = 3) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow));
  }
  return rows;
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
}) {
  const cwd = chatState?.cwd || config?.agy?.defaultCwd || os.homedir();
  const mode = chatState?.mode || config?.agy?.defaultMode || 'accept-edits';
  const model = chatState?.model || config?.agy?.defaultModel || '';
  const effort = chatState?.effort || config?.agy?.defaultEffort || '';
  const convId = chatState?.conversationId || '';
  const rawExpiresAt = Number(chatState?.fullExpiresAt || 0);
  const isTempFull = mode === 'full' && rawExpiresAt > Date.now();
  const remainingMin = isTempFull ? Math.max(1, Math.ceil((rawExpiresAt - Date.now()) / 60000)) : 0;
  const revertMode = chatState?.fullRevertMode || 'accept-edits';
  const quickDirs = discoverQuickDirs(config, cwd);
  const resolvedCwd = path.resolve(cwd);
  const favoriteSet = new Set(
    (Array.isArray(config?.agy?.favoriteDirs) ? config.agy.favoriteDirs : []).map((d) => path.resolve(d)),
  );
  const isPinned = favoriteSet.has(resolvedCwd);

  const modeDisplay = isTempFull
    ? `\`full\`（⏱️ 临时全权，约 ${remainingMin} 分钟后自动切回 \`${revertMode}\`）`
    : `\`${mode}\``;
  const queueSuffix = queueLength > 0 ? `（排队 ${queueLength} 条）` : '';
  const parallelSuffix = activeParallelCount > 1 ? ` · 全局并行 ${activeParallelCount}/${maxConcurrentRuns}` : '';
  const pendingHandoff = chatState.pendingHandoff;

  const lines = [
    threadRootId ? `- **所属话题**：\`${threadRootId.slice(0, 12)}\`（独立并行会话）` : '',
    `- **工作目录**：\`${cwd}\``,
    `- **执行模式**：${modeDisplay}`,
    `- **当前模型**：\`${model || 'default (随 CLI 配置)'}\``,
    `- **推理强度**：\`${effort || 'default (随 CLI 配置)'}\``,
    `- **当前会话**：\`${convId ? convId.slice(0, 8) : '(未开始，下条消息新建)'}\``,
    pendingHandoff
      ? `- **待注入上下文**：已挂接电脑端「${(pendingHandoff.title || '').slice(0, 24)}」（下条消息自动注入）`
      : '',
    `- **运行状态**：${isRunning ? `⏳ 正在执行任务${queueSuffix}${parallelSuffix}` : `🟢 空闲${queueSuffix}${parallelSuffix}`}`,
  ].filter(Boolean);
  if (uptimeText) {
    lines.push(`- **守护进程在线**：\`${uptimeText}\``);
  }

  const row1 = [
    { label: '🆕 新对话', value: { cmd: 'new', inplace: true } },
    { label: '🗂️ 最近会话', value: { cmd: 'sessions', inplace: true } },
    { label: '🧠 模型', value: { cmd: 'models', inplace: true } },
    { label: '🎛️ 强度', value: { cmd: 'effort_menu', inplace: true } },
    { label: '🌿 Git', value: { cmd: 'git', inplace: true } },
    { label: '🔐 权限', value: { cmd: 'scopes', inplace: true } },
    { label: '🔄 刷新', value: { cmd: 'panel', inplace: true } },
  ];
  if (isRunning) {
    row1.push({ label: '🛑 立即中止', type: 'danger', value: { cmd: 'stop', inplace: true } });
  }
  if (queueLength > 0) {
    row1.push({ label: `📋 队列(${queueLength})`, value: { cmd: 'queue_list', inplace: true } });
  }

  const row2 = [
    { label: '⚡ 快捷任务', type: 'primary', value: { cmd: 'quick', inplace: true } },
    { label: '📁 浏览目录', value: { cmd: 'dirs', inplace: true } },
    {
      label: isPinned ? '📌 取消收藏' : '📌 收藏目录',
      value: { cmd: 'pin', inplace: true },
    },
    { label: '♻️ 安全重启', value: { cmd: 'safe_restart', inplace: true } },
    { label: '⏪ 快照回滚', value: { cmd: 'ops', inplace: true } },
  ];

  const row3 = [
    {
      label: '✏️ 改文件',
      type: mode === 'accept-edits' ? 'primary' : 'default',
      value: { cmd: 'mode', arg: 'accept-edits', inplace: true },
    },
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
      label: isTempFull ? `⚡ 临时全权(${remainingMin}m)` : '⚡ 临时全权30m',
      type: isTempFull ? 'primary' : 'default',
      value: { cmd: 'mode_temp_full', arg: '30', inplace: true },
    },
    {
      label: '⚡ 常驻全权',
      type: mode === 'full' && !isTempFull ? 'primary' : 'default',
      value: { cmd: 'mode', arg: 'full', inplace: true },
    },
  ];

  const home = path.resolve(os.homedir());
  const row4 = quickDirs.map((dirPath) => ({
    label: `📂 ${formatShortDirName(dirPath, home)}`,
    type: dirPath === resolvedCwd ? 'primary' : 'default',
    value: { cmd: 'cd', arg: dirPath, inplace: true },
  }));

  return buildCard({
    title: '⚙️ Antigravity 控制面板',
    template: isRunning ? 'wathet' : 'blue',
    markdown: lines.join('\n'),
    buttonRows: [row1, row2, row3, row4].filter((r) => r.length > 0),
    footer: '推荐按需点「⚡ 临时全权30m」（到期自动切回安全模式）',
  });
}

export function buildDirsCard({ chatState, config, page = 0, pageSize = 12 }) {
  const cwd = path.resolve(chatState?.cwd || config?.agy?.defaultCwd || os.homedir());
  const home = path.resolve(os.homedir());
  const parentDir = path.dirname(cwd);

  const rawFavorites = Array.isArray(config?.agy?.favoriteDirs) ? config.agy.favoriteDirs : [];
  const favoriteSeen = new Set();
  const favorites = [];
  for (const raw of rawFavorites) {
    if (!raw) continue;
    const resolved = path.resolve(raw);
    if (favoriteSeen.has(resolved)) continue;
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        favoriteSeen.add(resolved);
        favorites.push(resolved);
      }
    } catch {
      // Ignore inaccessible dirs
    }
  }
  const isPinned = favorites.includes(cwd);

  let allSubDirs = [];
  let readErr = '';
  try {
    allSubDirs = fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    readErr = err?.message || '无法读取目录';
  }
  const perPage = Math.max(3, Math.min(18, Number(pageSize) || 12));
  const totalPages = Math.max(1, Math.ceil(allSubDirs.length / perPage));
  const safePage = Math.max(0, Math.min(totalPages - 1, Math.floor(Number(page) || 0)));
  const startIdx = safePage * perPage;
  const subDirs = allSubDirs.slice(startIdx, startIdx + perPage);

  const lines = [
    `- **当前目录**：\`${cwd}\``,
    `- **收藏目录**：${favorites.length} 个${isPinned ? '（当前目录已收藏）' : ''}`,
    readErr
      ? `- **子目录读取失败**：\`${readErr}\``
      : allSubDirs.length > 0
        ? `- **可见子目录**：共 ${allSubDirs.length} 个${totalPages > 1 ? `（第 ${safePage + 1}/${totalPages} 页，显示 ${startIdx + 1}–${startIdx + subDirs.length}）` : ''}`
        : '- **可见子目录**：当前目录下暂无可见子文件夹',
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

  const favRows = favorites.length > 0
    ? chunkButtons(
        favorites.slice(0, 6).map((dirPath) => ({
          label: `⭐ ${formatShortDirName(dirPath, home)}`,
          type: dirPath === cwd ? 'primary' : 'default',
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
    footer: '点子目录进入，支持翻页；也可发送 /cd <关键词> 模糊直达',
  });
}

export function buildQuickPromptsCard({ chatState, config, manageMode = false }) {
  const prompts = getEffectiveQuickPrompts(config).slice(0, 8);
  const isCustom = Array.isArray(config?.agy?.quickPrompts) && config.agy.quickPrompts.length > 0;
  const cwd = chatState?.cwd || config?.agy?.defaultCwd || os.homedir();
  const mode = chatState?.mode || config?.agy?.defaultMode || 'accept-edits';

  const lines = [
    `- **当前目录**：\`${cwd}\``,
    `- **执行模式**：\`${mode}\``,
    '',
    ...prompts.map((item, idx) => {
      const normalized = item.prompt.replace(/\s+/g, ' ').trim();
      const preview = normalized.length > 42 ? `${normalized.slice(0, 40)}…` : normalized;
      return `${idx + 1}. **${item.label}** — ${sanitizeForFeishuMarkdown(preview)}`;
    }),
  ];

  const promptButtons = manageMode
    ? prompts.map((item, idx) => ({
        label: `🗑️ ${idx + 1}. ${item.label.slice(0, 12)}`,
        type: 'danger',
        value: { cmd: 'quick_del', arg: String(idx), inplace: true },
      }))
    : prompts.map((item, idx) => ({
        label: item.label.slice(0, 18),
        type: 'primary',
        value: { cmd: 'quick_run', arg: String(idx) },
      }));

  const navRow = manageMode
    ? [
        { label: '✅ 完成管理', type: 'primary', value: { cmd: 'quick', inplace: true } },
        { label: '🔄 恢复默认', value: { cmd: 'quick_reset', inplace: true } },
        { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
      ]
    : [
        { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
        { label: '🆕 新对话', value: { cmd: 'new', inplace: true } },
        { label: '🗑️ 管理/删除', value: { cmd: 'quick_manage', inplace: true } },
      ];

  return buildCard({
    title: manageMode ? '🗑️ 管理快捷任务（点击删除）' : '⚡ 快捷任务（一键执行）',
    template: manageMode ? 'orange' : 'turquoise',
    markdown: lines.join('\n'),
    buttonRows: [...chunkButtons(promptButtons, 2), navRow],
    footer: manageMode
      ? '点击任意任务按钮即可删除 · 若全部删空将自动恢复内置默认'
      : isCustom
        ? '已使用自定义快捷任务 · /quick add 名称 | 提示词 可继续添加'
        : '当前为内置快捷任务 · 发送 /quick add 名称 | 提示词 可自定义',
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

export function assertLarkOk(res, action) {
  if (res && typeof res.code === 'number' && res.code !== 0) {
    throw new Error(`Feishu ${action} failed (code=${res.code}): ${res.msg || 'unknown error'}`);
  }
}

export async function sendCard(client, { receiveId, receiveIdType = 'open_id', card }) {
  const res = await client.im.v1.message.create({
    data: {
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
    params: {
      receive_id_type: receiveIdType,
    },
  });
  assertLarkOk(res, 'sendCard');
  return res?.data?.message_id || '';
}

export async function sendText(client, { receiveId, receiveIdType = 'open_id', text }) {
  const res = await client.im.v1.message.create({
    data: {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text: String(text || '') }),
    },
    params: {
      receive_id_type: receiveIdType,
    },
  });
  assertLarkOk(res, 'sendText');
  return res?.data?.message_id || '';
}

export async function replyCard(client, { messageId, card, replyInThread = false }) {
  const res = await client.im.v1.message.reply({
    data: {
      msg_type: 'interactive',
      content: JSON.stringify(card),
      ...(replyInThread ? { reply_in_thread: true } : {}),
    },
    path: {
      message_id: messageId,
    },
  });
  assertLarkOk(res, 'replyCard');
  return res?.data?.message_id || '';
}

export async function patchCard(client, { messageId, card }) {
  const res = await client.im.v1.message.patch({
    data: {
      content: JSON.stringify(card),
    },
    path: {
      message_id: messageId,
    },
  });
  assertLarkOk(res, 'patchCard');
}

export async function deliverFinalCard(
  client,
  {
    replyMessageId = '',
    replyTargetMessageId = '',
    replyInThread = false,
    chatId = '',
    receiveId = '',
    receiveIdType = 'chat_id',
    title,
    template,
    markdown,
    footer = '',
    buttonRows = [],
  },
) {
  const clean = sanitizeForFeishuMarkdown(markdown);
  const chunks = splitMarkdownChunks(clean, 7000);
  const targetId = chatId || receiveId;
  const targetType = chatId ? 'chat_id' : receiveIdType;

  for (let i = 0; i < chunks.length; i += 1) {
    const isLast = i === chunks.length - 1;
    const partTitle = chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title;
    const partFooter = isLast ? footer : '';
    const partButtons = isLast ? buttonRows : [];
    const card = buildCard({
      title: partTitle,
      template,
      markdown: chunks[i],
      footer: partFooter,
      buttonRows: partButtons,
    });

    if (i === 0 && replyMessageId) {
      try {
        await patchCard(client, { messageId: replyMessageId, card });
        continue;
      } catch {
        // Fallback to sending a new card if patching fails (e.g., expired or deleted)
      }
    }
    if (replyInThread && replyTargetMessageId) {
      await replyCard(client, { messageId: replyTargetMessageId, card, replyInThread: true });
    } else if (targetId) {
      await sendCard(client, { receiveId: targetId, receiveIdType: targetType, card });
    }
  }
}

export function unwrapLarkError(err, action) {
  const apiMsg = err?.response?.data?.msg || err?.response?.data?.error?.message || '';
  const apiCode = err?.response?.data?.code;
  if (apiMsg) {
    return new Error(`Feishu ${action} failed (code=${apiCode ?? '?'}): ${apiMsg}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function assertLocalFile(filePath, maxBytes, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在：${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`目标路径不是普通文件：${filePath}`);
  }
  if (stat.size === 0) {
    throw new Error(`文件为空（0 字节），飞书不支持上传空文件：${path.basename(filePath)}`);
  }
  if (stat.size > maxBytes) {
    const mb = (maxBytes / (1024 * 1024)).toFixed(0);
    throw new Error(`${label}大小超出飞书限制（最大 ${mb} MB）：${path.basename(filePath)}`);
  }
  return stat;
}

export async function uploadAndSendImage(
  client,
  { receiveId, receiveIdType = 'open_id', filePath, replyToMessageId = '', replyInThread = false },
) {
  const stat = assertLocalFile(filePath, 10 * 1024 * 1024, '图片');
  let uploadRes;
  try {
    uploadRes = await client.im.v1.image.create({
      data: {
        image_type: 'message',
        image: fs.createReadStream(filePath),
      },
    });
  } catch (err) {
    throw unwrapLarkError(err, 'uploadImage');
  }
  assertLarkOk(uploadRes, 'uploadImage');
  const imageKey = uploadRes?.data?.image_key || uploadRes?.image_key || '';
  if (!imageKey) {
    throw new Error('Feishu uploadImage returned empty image_key');
  }

  let sendRes;
  try {
    if (replyInThread && replyToMessageId) {
      sendRes = await client.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
          reply_in_thread: true,
        },
      });
    } else {
      sendRes = await client.im.v1.message.create({
        data: {
          receive_id: receiveId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
        params: {
          receive_id_type: receiveIdType,
        },
      });
    }
  } catch (err) {
    throw unwrapLarkError(err, 'sendImage');
  }
  assertLarkOk(sendRes, 'sendImage');
  return {
    messageId: sendRes?.data?.message_id || '',
    imageKey,
    kind: 'image',
    fileName: path.basename(filePath),
    sizeBytes: stat.size,
  };
}

export async function uploadAndSendFile(
  client,
  { receiveId, receiveIdType = 'open_id', filePath, replyToMessageId = '', replyInThread = false },
) {
  const stat = assertLocalFile(filePath, 30 * 1024 * 1024, '文件');
  const fileType = resolveFeishuFileType(filePath);
  const fileName = path.basename(filePath);
  let uploadRes;
  try {
    uploadRes = await client.im.v1.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        file: fs.createReadStream(filePath),
      },
    });
  } catch (err) {
    throw unwrapLarkError(err, 'uploadFile');
  }
  assertLarkOk(uploadRes, 'uploadFile');
  const fileKey = uploadRes?.data?.file_key || uploadRes?.file_key || '';
  if (!fileKey) {
    throw new Error('Feishu uploadFile returned empty file_key');
  }

  let sendRes;
  try {
    if (replyInThread && replyToMessageId) {
      sendRes = await client.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
          reply_in_thread: true,
        },
      });
    } else {
      sendRes = await client.im.v1.message.create({
        data: {
          receive_id: receiveId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
        params: {
          receive_id_type: receiveIdType,
        },
      });
    }
  } catch (err) {
    throw unwrapLarkError(err, 'sendFile');
  }
  assertLarkOk(sendRes, 'sendFile');
  return {
    messageId: sendRes?.data?.message_id || '',
    fileKey,
    fileType,
    kind: 'file',
    fileName,
    sizeBytes: stat.size,
  };
}

export async function sendLocalMedia(
  client,
  { receiveId, receiveIdType = 'open_id', filePath, forceFile = false, replyToMessageId = '', replyInThread = false },
) {
  if (!forceFile && isImageFilePath(filePath)) {
    return uploadAndSendImage(client, { receiveId, receiveIdType, filePath, replyToMessageId, replyInThread });
  }
  return uploadAndSendFile(client, { receiveId, receiveIdType, filePath, replyToMessageId, replyInThread });
}

const SKIP_SEARCH_DIRS = new Set(['node_modules', 'Library', 'Applications']);

function listChildDirsSafe(parentDir) {
  try {
    if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) return [];
    return fs
      .readdirSync(parentDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_SEARCH_DIRS.has(e.name))
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

  const addCandidate = (dirPath) => {
    if (!dirPath) return;
    const resolved = path.resolve(dirPath);
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
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
    { label: '📁 浏览目录', value: { cmd: 'dirs', inplace: true } },
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
  { name: 'wiki:node:read', label: 'Wiki 知识库节点解析' },
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
        { label: '📁 浏览目录', value: { cmd: 'dirs', inplace: true } },
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
      { label: '📁 浏览目录', value: { cmd: 'dirs', inplace: true } },
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

  return buildCard({
    title: '🔍 电脑端对话详情预览',
    template: detail?.running ? 'orange' : 'blue',
    markdown: lines.join('\n'),
    buttonRows: [
      [
        {
          label: '✅ 接管并切目录',
          type: 'primary',
          value: { cmd: 'desktop_takeover', arg: detail.id, summarize: false, inplace: true },
        },
        {
          label: '👀 接管并总结进展',
          value: { cmd: 'desktop_takeover', arg: detail.id, summarize: true, inplace: false },
        },
      ],
      [
        {
          label: '⬅️ 返回列表',
          value: { cmd: 'desktop_list', filter, query: safeQuery, inplace: true },
        },
        { label: '⚙️ 控制面板', value: { cmd: 'panel', inplace: true } },
      ],
    ],
    footer: '只读扫描本地索引，绝不修改桌面 App 数据库',
  });
}
