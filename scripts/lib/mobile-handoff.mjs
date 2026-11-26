import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureConfigDir, getHandoffsDir, loadState } from './config.mjs';
import { writePrivateFileAtomic } from './io-utils.mjs';
import {
  extractLatestAssistantReply,
  extractTranscriptTurns,
  getDesktopSessionDetail,
  getDesktopSessionMeta,
  getGeminiRoot,
} from './desktop-sessions.mjs';
import { buildCard, chunkButtons, sanitizeForFeishuMarkdown } from './feishu-api.mjs';

const SAFE_CONV_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function isSafeConversationId(id) {
  const s = String(id || '').trim();
  return Boolean(s && SAFE_CONV_ID_RE.test(s) && !s.includes('..'));
}

export function buildCliResumeCommand(cwd, conversationId = '') {
  const dir = String(cwd || os.homedir()).trim() || os.homedir();
  const conv = String(conversationId || '').trim();
  const convPart = conv ? ` --conversation ${conv}` : '';
  if (process.platform === 'win32') {
    const escaped = dir.replace(/"/g, '\\"');
    return `cd /d "${escaped}" && agy${convPart}`;
  }
  const escaped = dir.replace(/'/g, `'\\''`);
  return `cd '${escaped}' && agy${convPart}`;
}

export function copyToSystemClipboard(text) {
  const payload = String(text ?? '');
  const testFile = process.env.FEISHU_REMOTE_TEST_CLIPBOARD_FILE;
  if (testFile) {
    try {
      fs.mkdirSync(path.dirname(testFile), { recursive: true });
      fs.writeFileSync(testFile, payload, { encoding: 'utf8', mode: 0o600 });
      return { ok: true, method: 'test-file' };
    } catch (err) {
      return { ok: false, method: 'test-file', error: err?.message || String(err) };
    }
  }

  try {
    if (process.platform === 'darwin') {
      execFileSync('pbcopy', [], {
        input: payload,
        encoding: 'utf8',
        timeout: 2500,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      return { ok: true, method: 'pbcopy' };
    }
    if (process.platform === 'win32') {
      execFileSync('clip', [], {
        input: payload,
        encoding: 'utf8',
        timeout: 2500,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      return { ok: true, method: 'clip' };
    }
    const candidates = [
      ['wl-copy', []],
      ['xclip', ['-selection', 'clipboard']],
      ['xsel', ['--clipboard', '--input']],
    ];
    for (const [bin, args] of candidates) {
      try {
        execFileSync(bin, args, {
          input: payload,
          encoding: 'utf8',
          timeout: 2500,
          stdio: ['pipe', 'ignore', 'pipe'],
        });
        return { ok: true, method: bin };
      } catch {
        // Try next clipboard utility
      }
    }
    return { ok: false, method: 'none', error: 'No clipboard utility available (wl-copy/xclip/xsel)' };
  } catch (err) {
    return { ok: false, method: 'none', error: err?.message || String(err) };
  }
}

function runClipboardCommandAsync(bin, args, payload, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, error = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, method: ok ? bin : 'none', ...(error ? { error } : {}) });
    };
    let child;
    try {
      child = spawn(bin, args, {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    } catch (err) {
      finish(false, err?.message || String(err));
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore
      }
      finish(false, 'Clipboard timeout');
    }, timeoutMs);
    timer.unref?.();

    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.stdin?.on('error', () => {});
    child.on('error', (err) => finish(false, err?.message || String(err)));
    child.on('close', (code) => {
      if (code === 0) finish(true);
      else finish(false, stderr.trim() || `Exited with code ${code}`);
    });
    try {
      child.stdin.write(payload);
      child.stdin.end();
    } catch (err) {
      finish(false, err?.message || String(err));
    }
  });
}

/**
 * Asynchronously copy text into the host OS clipboard without blocking the event loop.
 */
export async function copyToSystemClipboardAsync(text) {
  const payload = String(text ?? '');
  const testFile = process.env.FEISHU_REMOTE_TEST_CLIPBOARD_FILE;
  if (testFile) {
    try {
      await fs.promises.mkdir(path.dirname(testFile), { recursive: true });
      await fs.promises.writeFile(testFile, payload, { encoding: 'utf8', mode: 0o600 });
      return { ok: true, method: 'test-file' };
    } catch (err) {
      return { ok: false, method: 'test-file', error: err?.message || String(err) };
    }
  }
  if (process.platform === 'darwin') {
    return runClipboardCommandAsync('pbcopy', [], payload);
  }
  if (process.platform === 'win32') {
    return runClipboardCommandAsync('clip', [], payload);
  }
  for (const [bin, args] of [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ]) {
    const res = await runClipboardCommandAsync(bin, args, payload);
    if (res.ok) return res;
  }
  return { ok: false, method: 'none', error: 'No clipboard utility available (wl-copy/xclip/xsel)' };
}

export function buildDesktopReturnPrompt({
  conversationId = '',
  cwd = '',
  title = '',
  originDesktopSession = null,
  modifiedFiles = [],
  turns = [],
  lastAssistantReply = '',
  transcriptPath = '',
} = {}) {
  const lines = [
    '[手机飞书端进展回流]',
    `- 手机端 CLI 会话 ID：${conversationId || '未知'}`,
    cwd ? `- 工作目录：${cwd}` : '',
    title ? `- 会话摘要：${title}` : '',
    originDesktopSession?.id
      ? `- 关联原桌面端会话：${originDesktopSession.title || '(无标题)'} (${originDesktopSession.id})`
      : '',
    transcriptPath ? `- 手机端完整日志：${transcriptPath}` : '',
  ].filter(Boolean);

  const files = Array.isArray(modifiedFiles) ? modifiedFiles.filter(Boolean).slice(0, 10) : [];
  if (files.length > 0) {
    lines.push('', '手机端修改过的本地文件：');
    for (const file of files) {
      lines.push(`- ${file}`);
    }
  }

  const recentTurns = Array.isArray(turns) ? turns.slice(-6) : [];
  if (recentTurns.length > 0) {
    lines.push('', '最近对话摘录：');
    for (const turn of recentTurns) {
      const roleLabel = turn.role === 'user' ? '用户' : '助手';
      const snippet = String(turn.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      if (snippet) {
        lines.push(`- ${roleLabel}：${snippet}`);
      }
    }
  }

  const replyText = String(lastAssistantReply || '').trim();
  if (replyText) {
    const capped = replyText.length > 2000
      ? `${replyText.slice(0, 2000)}...\n(完整内容见上方手机端完整日志)`
      : replyText;
    lines.push('', '手机端最新回复结论：', capped);
  }

  lines.push('', '请结合以上手机端进展，先按需重新读取变更过的本地文件，再继续推进后续工作。');
  return lines.join('\n');
}

function isSameOrChildPath(targetPath, basePath) {
  if (!targetPath || !basePath) return false;
  const resolvedTarget = path.resolve(targetPath);
  const resolvedBase = path.resolve(basePath);
  if (resolvedTarget === resolvedBase) return true;
  const rel = path.relative(resolvedBase, resolvedTarget);
  return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function scoreCwdMatch(sessionCwd, queryCwd) {
  if (!sessionCwd || !queryCwd) return 0;
  const a = path.resolve(sessionCwd);
  const b = path.resolve(queryCwd);
  if (a === b) return 60;
  if (isSameOrChildPath(a, b) || isSameOrChildPath(b, a)) return 40;
  return 0;
}

export function listMobileSessions({ cwd = '', originDesktopId = '', limit = 10 } = {}) {
  const state = loadState();
  const byId = new Map();

  const upsert = (convId, record) => {
    const id = String(convId || '').trim();
    if (!id) return;
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, { id, ...record });
      return;
    }
    byId.set(id, {
      ...prev,
      ...record,
      isCurrent: Boolean(prev.isCurrent || record.isCurrent),
      cwd: record.cwd || prev.cwd || '',
      summary: record.summary || prev.summary || '',
      originDesktopSession: record.originDesktopSession || prev.originDesktopSession || null,
      lastTurnArtifacts: record.lastTurnArtifacts || prev.lastTurnArtifacts || null,
      lastActiveAt: Math.max(Number(prev.lastActiveAt || 0), Number(record.lastActiveAt || 0)),
    });
  };

  for (const [chatKey, info] of Object.entries(state.chats || {})) {
    if (!info || typeof info !== 'object') continue;
    const chatActiveAt = Number(info.lastActiveAt || 0);
    if (info.conversationId) {
      upsert(info.conversationId, {
        chatKey,
        cwd: info.cwd || '',
        summary: '',
        isCurrent: true,
        originDesktopSession: info.originDesktopSession || null,
        lastTurnArtifacts:
          info.lastTurnArtifacts?.conversationId === info.conversationId
            ? info.lastTurnArtifacts
            : null,
        lastActiveAt: chatActiveAt,
      });
    }
    const recent = Array.isArray(info.recentConversations) ? info.recentConversations : [];
    for (const item of recent) {
      if (!item?.id) continue;
      const itemMs = item.updatedAt ? Date.parse(item.updatedAt) || 0 : 0;
      const matchOrigin =
        info.originDesktopSession && item.originDesktopId === info.originDesktopSession.id
          ? info.originDesktopSession
          : item.originDesktopId
            ? { id: item.originDesktopId, title: item.originDesktopTitle || '' }
            : null;
      upsert(item.id, {
        chatKey,
        cwd: item.cwd || info.cwd || '',
        summary: item.summary || '',
        isCurrent: info.conversationId === item.id,
        originDesktopSession: matchOrigin,
        lastTurnArtifacts:
          info.lastTurnArtifacts?.conversationId === item.id ? info.lastTurnArtifacts : null,
        updatedAt: item.updatedAt || '',
        lastActiveAt: Math.max(itemMs, info.conversationId === item.id ? chatActiveAt : 0),
      });
    }
  }

  const originNeedle = String(originDesktopId || '').trim();
  const cwdNeedle = String(cwd || '').trim();

  const enriched = [];
  for (const entry of byId.values()) {
    const detail = getDesktopSessionMeta(entry.id);
    const resolvedCwd = detail?.workspace || entry.cwd || '';
    const lastModifiedMs = Math.max(Number(detail?.lastModifiedMs || 0), Number(entry.lastActiveAt || 0));
    let score = 0;
    const originId = entry.originDesktopSession?.id || '';
    if (originNeedle && originId && (originId === originNeedle || originId.startsWith(originNeedle) || originNeedle.startsWith(originId))) {
      score += 100;
    }
    score += scoreCwdMatch(resolvedCwd, cwdNeedle);

    enriched.push({
      conversationId: entry.id,
      title: detail?.title || entry.summary || '(无标题手机会话)',
      summary: entry.summary || '',
      cwd: resolvedCwd,
      chatKey: entry.chatKey || '',
      isCurrent: Boolean(entry.isCurrent),
      stepCount: detail?.stepCount || 0,
      running: Boolean(detail?.running),
      lastModifiedTime: detail?.lastModifiedTime || entry.updatedAt || '',
      lastModifiedMs,
      transcriptFile: '',
      originDesktopSession: entry.originDesktopSession || null,
      modifiedFiles: Array.isArray(entry.lastTurnArtifacts?.files) ? entry.lastTurnArtifacts.files : [],
      _score: score,
    });
  }

  enriched.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0);
  });

  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 10, 30));
  return enriched.slice(0, normalizedLimit).map(({ _score, ...item }) => item);
}

export function readMobileSession({
  conversationId = '',
  cwd = '',
  originDesktopId = '',
  maxTurns = 12,
  maxCharsPerTurn = 1200,
  maxLastReplyChars = 8000,
} = {}) {
  const sessions = listMobileSessions({ cwd, originDesktopId, limit: 30 });
  const targetId = String(conversationId || '').trim();
  if (targetId && !isSafeConversationId(targetId)) {
    return {
      found: false,
      error: '无效的会话 ID 格式。',
    };
  }
  let match = null;
  if (targetId) {
    match = sessions.find((s) => s.conversationId === targetId || s.conversationId.startsWith(targetId)) || null;
  } else {
    match = sessions[0] || null;
  }

  const resolvedId = match?.conversationId || targetId;
  if (!resolvedId) {
    return {
      found: false,
      error: '未找到任何手机飞书端会话记录。',
    };
  }

  const detail = getDesktopSessionDetail(resolvedId);
  if (!match && !detail) {
    return {
      found: false,
      error: `未找到会话 ${resolvedId} 的本地记录。`,
    };
  }

  const safeId = isSafeConversationId(resolvedId) ? resolvedId : '';
  const brainCandidates = [
    detail?.brainDir,
    safeId ? path.join(getGeminiRoot(), 'antigravity-cli', 'brain', safeId) : '',
    safeId ? path.join(getGeminiRoot(), 'antigravity', 'brain', safeId) : '',
  ].filter(Boolean);

  let turns = [];
  for (const dir of brainCandidates) {
    turns = extractTranscriptTurns(dir, { maxTurns, maxCharsPerTurn });
    if (turns.length > 0) break;
  }

  let latestReply = null;
  for (const dir of brainCandidates) {
    latestReply = extractLatestAssistantReply(dir, { maxChars: maxLastReplyChars });
    if (latestReply) break;
  }

  const resolvedCwd = match?.cwd || detail?.workspace || cwd || os.homedir();
  const title = match?.title || detail?.title || '(无标题手机会话)';
  const originDesktopSession = match?.originDesktopSession || null;
  const modifiedFiles = match?.modifiedFiles || [];
  const transcriptPath = latestReply?.sourceFile || detail?.transcriptFile || '';
  const cliResumeCommand = buildCliResumeCommand(resolvedCwd, resolvedId);
  const desktopHandoffPrompt = buildDesktopReturnPrompt({
    conversationId: resolvedId,
    cwd: resolvedCwd,
    title,
    originDesktopSession,
    modifiedFiles,
    turns,
    lastAssistantReply: latestReply?.text || detail?.lastAssistantReply || '',
    transcriptPath,
  });

  return {
    found: true,
    conversationId: resolvedId,
    title,
    cwd: resolvedCwd,
    chatKey: match?.chatKey || '',
    stepCount: detail?.stepCount || match?.stepCount || 0,
    lastModifiedTime: detail?.lastModifiedTime || match?.lastModifiedTime || '',
    lastModifiedMs: detail?.lastModifiedMs || match?.lastModifiedMs || 0,
    transcriptPath,
    originDesktopSession,
    modifiedFiles,
    turns,
    lastAssistantReply: latestReply?.text || detail?.lastAssistantReply || '',
    cliResumeCommand,
    desktopHandoffPrompt,
  };
}

export function writeHandoffSnapshot({
  conversationId = '',
  cwd = '',
  cliResumeCommand = '',
  desktopHandoffPrompt = '',
  modifiedFiles = [],
  originDesktopSession = null,
} = {}) {
  ensureConfigDir();
  const dir = getHandoffsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Ignore chmod error on unsupported FS
  }

  const safeShortId = String(conversationId || 'session')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 8) || 'session';
  const snapshotName = `${safeShortId}.md`;
  const snapshotPath = path.join(dir, snapshotName);
  const latestPath = path.join(dir, 'latest.md');

  const content = [
    '# Feishu Remote → Desktop Handoff Snapshot',
    '',
    `- **Generated At**: ${new Date().toISOString()}`,
    `- **Mobile CLI Session**: \`${conversationId || '-'}\``,
    `- **Working Directory**: \`${cwd || '-'}\``,
    originDesktopSession?.id
      ? `- **Origin Desktop Session**: ${originDesktopSession.title || '(untitled)'} (\`${originDesktopSession.id}\`)`
      : '',
    modifiedFiles.length > 0 ? `- **Modified Files**: ${modifiedFiles.join(', ')}` : '',
    '',
    '## Resume in Terminal (`agy` CLI)',
    '```bash',
    cliResumeCommand || buildCliResumeCommand(cwd, conversationId),
    '```',
    '',
    '## Resume in Desktop App',
    desktopHandoffPrompt || '',
    '',
  ].filter((line) => line !== undefined).join('\n');

  writePrivateFileAtomic(snapshotPath, content);
  writePrivateFileAtomic(latestPath, content);

  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'latest.md')
      .map((e) => {
        const abs = path.join(dir, e.name);
        return { abs, mtimeMs: fs.statSync(abs).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const old of entries.slice(10)) {
      fs.rmSync(old.abs, { force: true });
    }
  } catch {
    // Ignore snapshot pruning failures
  }

  return { latestPath, snapshotPath };
}

export function checkOriginDesktopDrift(originDesktopSession) {
  if (!originDesktopSession?.id) {
    return { drifted: false, running: false, detail: null, newSteps: 0 };
  }
  const detail = getDesktopSessionMeta(originDesktopSession.id);
  if (!detail) {
    return { drifted: false, running: false, detail: null, newSteps: 0 };
  }
  const baseModified = Math.max(
    Number(originDesktopSession.desktopLastModifiedMs || 0),
    Number(originDesktopSession.lastNotifiedModifiedMs || 0),
  );
  const baseSteps = Math.max(
    Number(originDesktopSession.desktopStepCount || 0),
    Number(originDesktopSession.lastNotifiedStepCount || 0),
  );
  const newSteps = Math.max(0, Number(detail.stepCount || 0) - baseSteps);
  const drifted =
    (baseModified > 0 && Number(detail.lastModifiedMs || 0) > baseModified + 1000) ||
    newSteps > 0;
  return {
    drifted,
    running: Boolean(detail.running),
    detail,
    newSteps,
  };
}

export function buildHandoffCard({
  session,
  clipboardResult = null,
  copiedTarget = '',
  snapshotPath = '',
} = {}) {
  const convId = session?.conversationId || '';
  const shortId = convId ? convId.slice(0, 8) : '-';
  const cwd = session?.cwd || os.homedir();
  const origin = session?.originDesktopSession;
  const modifiedFiles = Array.isArray(session?.modifiedFiles) ? session.modifiedFiles : [];
  const cliCmd = session?.cliResumeCommand || buildCliResumeCommand(cwd, convId);

  const lines = [
    `- **手机端会话 ID**：\`${shortId}\`${convId ? `（\`${convId}\`）` : ''}`,
    `- **工作目录**：\`${cwd}\``,
    origin?.id
      ? `- **原桌面端对话**：${sanitizeForFeishuMarkdown(origin.title || '(无标题)')}（\`${origin.id.slice(0, 8)}\`）`
      : null,
    modifiedFiles.length > 0
      ? `- **本轮修改文件**：${modifiedFiles.slice(0, 5).map((f) => `\`${path.basename(f)}\``).join('、')}${modifiedFiles.length > 5 ? ` 等 ${modifiedFiles.length} 个` : ''}`
      : null,
    '',
    '**方式 1 · 终端直连（100% 完整上下文）：**',
    '```bash',
    cliCmd,
    '```',
    '',
    '**方式 2 · 桌面端 App 无感回流：**',
    origin?.id
      ? '回到桌面端原窗口直接发一句：**「同步一下我刚才在手机上聊的进度」**（将自动调用 `feishu_read_mobile_session` 拉取手机端记录），或点下方按钮复制交接词粘贴发送。'
      : '回到桌面端窗口可让 AI 调用 `feishu_read_mobile_session` 同步本会话，或点下方按钮复制交接词粘贴发送。',
  ].filter((l) => l !== null && l !== undefined);

  if (clipboardResult) {
    const targetLabel = copiedTarget === 'desktop' ? '桌面交接提示词' : '终端恢复命令';
    if (clipboardResult.ok) {
      lines.push('', `📋 **剪贴板**：已自动写入「${targetLabel}」（\`${clipboardResult.method}\`），回电脑直接 \`Cmd+V\` 粘贴即可。`);
    } else {
      lines.push('', `⚠️ **剪贴板未写入**：${sanitizeForFeishuMarkdown(clipboardResult.error || '当前环境不支持')}（可直接复制上方代码块）`);
    }
  }

  if (snapshotPath) {
    lines.push(`💾 **交接快照**：\`${snapshotPath}\``);
  }

  const buttons = [
    {
      label: '📋 复制终端命令',
      type: copiedTarget !== 'desktop' ? 'primary' : 'default',
      value: { cmd: 'handoff_copy', arg: convId, target: 'cli', inplace: true },
    },
    {
      label: '📋 复制桌面交接词',
      type: copiedTarget === 'desktop' ? 'primary' : 'default',
      value: { cmd: 'handoff_copy', arg: convId, target: 'desktop', inplace: true },
    },
  ];
  if (modifiedFiles.length > 0) {
    buttons.push({ label: '🔍 看改动 Diff', value: { cmd: 'turn_diff' } });
  }
  buttons.push({ label: '⚙️ 控制面板', value: { cmd: 'panel', inplace: true } });

  return buildCard({
    title: '💻 交回电脑端继续',
    template: 'blue',
    markdown: lines.join('\n'),
    buttonRows: chunkButtons(buttons, 2),
    footer: '支持终端 `agy --conversation` 原生续聊，或桌面端通过 MCP 工具无感同步',
  });
}
