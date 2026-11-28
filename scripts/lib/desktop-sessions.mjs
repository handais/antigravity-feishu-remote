import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FULL_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_TAIL_BYTES = 1536 * 1024;

/**
 * Resolve the base `.gemini` directory (overrideable in tests via FEISHU_REMOTE_GEMINI_DIR).
 */
export function getGeminiRoot() {
  return process.env.FEISHU_REMOTE_GEMINI_DIR || path.join(os.homedir(), '.gemini');
}

function resolveAppDataDir(rawValue, fallbackDir) {
  const raw = String(rawValue || '').trim();
  if (!raw) return fallbackDir;
  return path.isAbsolute(raw) ? raw : path.join(getGeminiRoot(), raw);
}

function getAppStores() {
  const root = getGeminiRoot();
  return [
    {
      source: 'cli',
      sourceLabel: 'CLI 会话',
      dir: path.join(root, 'antigravity-cli'),
    },
    {
      source: 'desktop',
      sourceLabel: '桌面端 App',
      dir: path.join(root, 'antigravity'),
    },
    {
      source: 'ide',
      sourceLabel: '桌面 IDE',
      dir: path.join(root, 'antigravity-ide'),
    },
  ];
}

function parseTimestampMs(raw) {
  if (!raw) return 0;
  const text = String(raw).trim();
  if (!text) return 0;
  const isoLike = text.includes('T') ? text : text.replace(' ', 'T');
  const parsed = Date.parse(isoLike);
  return Number.isFinite(parsed) ? parsed : 0;
}

function decodeWorkspaceUris(rawJson) {
  if (!rawJson) return '';
  try {
    const arr = JSON.parse(rawJson);
    if (!Array.isArray(arr) || arr.length === 0) return '';
    const first = String(arr[0] || '').trim();
    if (!first) return '';
    if (first.startsWith('file://')) {
      return fileURLToPath(first);
    }
    return first;
  } catch {
    return '';
  }
}

function extractSearchTokens(rawQuery) {
  return String(rawQuery || '')
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => /[\p{L}\p{N}]/u.test(token));
}

function buildFtsMatchQuery(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return '';
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ');
}

function hasCliNativeConversation(convId) {
  if (!convId) return false;
  const cliConvDb = path.join(getGeminiRoot(), 'antigravity-cli', 'conversations', `${convId}.db`);
  try {
    return fs.existsSync(cliConvDb);
  } catch {
    return false;
  }
}

function queryStoreSessions(store, queryText) {
  const dbPath = path.join(store.dir, 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 1000;');

    const searchTokens = extractSearchTokens(queryText);
    const ftsQuery = buildFtsMatchQuery(searchTokens);
    let rows = [];

    if (ftsQuery) {
      try {
        const stmt = db.prepare(`
          SELECT
            s.conversation_id,
            s.title,
            s.preview,
            s.step_count,
            s.last_modified_time,
            s.workspace_uris,
            s.status,
            s.nesting_depth,
            s.app_data_dir
          FROM conversation_summaries s
          WHERE COALESCE(s.nesting_depth, 0) = 0
            AND s.conversation_id IN (
              SELECT DISTINCT conversation_id
              FROM conversations_fts
              WHERE conversations_fts MATCH ?
            )
          ORDER BY s.last_modified_time DESC
          LIMIT 200
        `);
        rows = stmt.all(ftsQuery);
      } catch {
        rows = [];
      }

      if (rows.length === 0 && searchTokens.length > 0) {
        const clauses = searchTokens.map(
          () => "(LOWER(COALESCE(title, '')) LIKE ? OR LOWER(COALESCE(preview, '')) LIKE ? OR LOWER(COALESCE(workspace_uris, '')) LIKE ?)",
        );
        const params = [];
        for (const token of searchTokens) {
          const pattern = `%${token.toLowerCase()}%`;
          params.push(pattern, pattern, pattern);
        }
        const fallbackStmt = db.prepare(`
          SELECT
            conversation_id,
            title,
            preview,
            step_count,
            last_modified_time,
            workspace_uris,
            status,
            nesting_depth,
            app_data_dir
          FROM conversation_summaries
          WHERE COALESCE(nesting_depth, 0) = 0
            AND ${clauses.join(' AND ')}
          ORDER BY last_modified_time DESC
          LIMIT 200
        `);
        rows = fallbackStmt.all(...params);
      }
    } else {
      const stmt = db.prepare(`
        SELECT
          conversation_id,
          title,
          preview,
          step_count,
          last_modified_time,
          workspace_uris,
          status,
          nesting_depth,
          app_data_dir
        FROM conversation_summaries
        WHERE COALESCE(nesting_depth, 0) = 0
        ORDER BY last_modified_time DESC
        LIMIT 200
      `);
      rows = stmt.all();
    }

    return rows.map((row) => {
      const id = String(row.conversation_id || '').trim();
      const isNative = store.source === 'cli' || hasCliNativeConversation(id);
      const workspace = decodeWorkspaceUris(row.workspace_uris);
      const appDataDir = resolveAppDataDir(row.app_data_dir, store.dir);
      const running = String(row.status || '') === 'CASCADE_RUN_STATUS_RUNNING';
      const lastModifiedMs = parseTimestampMs(row.last_modified_time);
      return {
        id,
        title: String(row.title || '').trim() || '(无标题对话)',
        preview: String(row.preview || '').trim(),
        source: store.source,
        sourceLabel: store.sourceLabel,
        takeoverMode: isNative ? 'native' : 'handoff',
        takeoverLabel: isNative ? '原生直连' : '摘要接管',
        running,
        status: String(row.status || ''),
        stepCount: Number(row.step_count || 0),
        workspace,
        lastModifiedTime: String(row.last_modified_time || ''),
        lastModifiedMs,
        appDataDir,
        brainDir: path.join(appDataDir, 'brain', id),
      };
    });
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures
    }
  }
}

/**
 * Scan local CLI and Desktop App conversation SQLite indexes (strictly read-only).
 */
export function listDesktopSessions({ query = '', filter = 'all', limit = 10 } = {}) {
  const merged = new Map();
  for (const store of getAppStores()) {
    const items = queryStoreSessions(store, query);
    for (const item of items) {
      if (!item.id) continue;
      if (filter === 'running' && !item.running) continue;
      if (filter === 'cli' && item.source !== 'cli') continue;
      if (filter === 'desktop' && item.source !== 'desktop') continue;

      const existing = merged.get(item.id);
      if (!existing) {
        merged.set(item.id, item);
        continue;
      }
      // Prefer native CLI record when both stores reference the same ID, otherwise keep newer timestamp.
      const preferNew =
        (item.takeoverMode === 'native' && existing.takeoverMode !== 'native') ||
        (item.takeoverMode === existing.takeoverMode && item.lastModifiedMs > existing.lastModifiedMs);
      if (preferNew) {
        merged.set(item.id, item);
      }
    }
  }

  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  return [...merged.values()]
    .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs)
    .slice(0, normalizedLimit);
}

function cleanUserInputContent(raw) {
  let text = String(raw || '');
  const reqMatch = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (reqMatch) {
    text = reqMatch[1];
  }
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '').trim();
  return text.replace(/\s+/g, ' ').trim();
}

function cleanAssistantContent(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readTranscriptText(transcriptPath) {
  const stat = fs.statSync(transcriptPath);
  if (stat.size <= MAX_FULL_TRANSCRIPT_BYTES) {
    return fs.readFileSync(transcriptPath, 'utf8');
  }
  const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
  const length = stat.size - start;
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, start);
    const slice = buf.subarray(0, bytesRead).toString('utf8');
    // Drop the potentially cut first line when seeking into the middle of the file.
    const firstNewline = slice.indexOf('\n');
    return firstNewline >= 0 ? slice.slice(firstNewline + 1) : slice;
  } finally {
    fs.closeSync(fd);
  }
}

function resolveTranscriptPaths(brainDir) {
  if (!brainDir) return { fullPath: '', compactPath: '' };
  const logsDir = path.join(brainDir, '.system_generated', 'logs');
  const fullCandidate = path.join(logsDir, 'transcript_full.jsonl');
  const compactCandidate = path.join(logsDir, 'transcript.jsonl');
  let fullPath = '';
  let compactPath = '';
  try {
    if (fs.existsSync(fullCandidate)) fullPath = fullCandidate;
  } catch {
    fullPath = '';
  }
  try {
    if (fs.existsSync(compactCandidate)) compactPath = compactCandidate;
  } catch {
    compactPath = '';
  }
  return { fullPath, compactPath };
}

/**
 * Extract the latest non-empty assistant Markdown reply from transcript_full.jsonl (preferred) or transcript.jsonl.
 * Also accepts a direct `.jsonl` file path.
 */
export function extractLatestAssistantReply(brainDirOrFile, { maxChars = 28000 } = {}) {
  const inputPath = String(brainDirOrFile || '').trim();
  if (!inputPath) return null;

  let candidates = [];
  if (inputPath.endsWith('.jsonl')) {
    try {
      if (fs.existsSync(inputPath) && fs.statSync(inputPath).isFile()) {
        candidates.push(inputPath);
        const fullSibling = path.join(path.dirname(inputPath), 'transcript_full.jsonl');
        if (path.basename(inputPath) !== 'transcript_full.jsonl' && fs.existsSync(fullSibling)) {
          candidates.unshift(fullSibling);
        }
      }
    } catch {
      candidates = [];
    }
  } else {
    const { fullPath, compactPath } = resolveTranscriptPaths(inputPath);
    candidates = [fullPath, compactPath].filter(Boolean);
  }
  if (candidates.length === 0) return null;

  for (const filePath of candidates) {
    let rawText = '';
    try {
      rawText = readTranscriptText(filePath);
    } catch {
      continue;
    }

    let latestEntry = null;
    for (const line of rawText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (entry?.type !== 'PLANNER_RESPONSE') continue;
      if (typeof entry?.content !== 'string' || !entry.content.trim()) continue;
      latestEntry = entry;
    }

    if (!latestEntry) continue;

    const cleaned = latestEntry.content.replace(/\r\n/g, '\n').trim();
    const totalChars = cleaned.length;
    const limit = Math.max(100, Number(maxChars) || 28000);
    const truncated = totalChars > limit;
    const text = truncated
      ? `${cleaned.slice(0, limit)}\n\n...(内容较长，已截断，完整内容见本机日志文件)`
      : cleaned;

    return {
      text,
      totalChars,
      truncated,
      stepIndex: latestEntry.step_index ?? null,
      createdAt: String(latestEntry.created_at || ''),
      sourceFile: filePath,
    };
  }

  return null;
}

/**
 * Extract a compact reply preview for desktop Stop notifications.
 */
export function extractStopReplyPreview({ conversationId = '', transcriptPath = '', maxChars = 360 } = {}) {
  const limit = Math.max(80, Number(maxChars) || 360);
  let reply = null;

  const rawTranscript = String(transcriptPath || '').trim();
  if (rawTranscript) {
    reply = extractLatestAssistantReply(rawTranscript, { maxChars: limit * 4 });
  }
  if (!reply && conversationId) {
    const detail = getDesktopSessionDetail(conversationId);
    if (detail?.lastAssistantReply) {
      reply = {
        text: detail.lastAssistantReply,
        totalChars: detail.lastAssistantReplyTotalChars || detail.lastAssistantReply.length,
      };
    }
  }
  if (!reply?.text) return null;

  const normalized = String(reply.text)
    .replace(/\r\n/g, '\n')
    .replace(/```[\s\S]*?```/g, '[代码块]')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return null;

  const totalChars = Number(reply.totalChars || normalized.length);
  const truncated = normalized.length > limit;
  const preview = truncated ? `${normalized.slice(0, limit).trimEnd()}…` : normalized;
  return { preview, totalChars, truncated };
}

/**
 * Extract the last few user/assistant turns from brain/<id>/.system_generated/logs/transcript.jsonl.
 */
export function extractTranscriptTurns(brainDir, { maxTurns = 6, maxCharsPerTurn = 400 } = {}) {
  if (!brainDir) return [];
  const transcriptPath = path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(transcriptPath)) {
    return [];
  }

  let rawText = '';
  try {
    rawText = readTranscriptText(transcriptPath);
  } catch {
    return [];
  }

  const turns = [];
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const type = String(entry?.type || '');
    if (type !== 'USER_INPUT' && type !== 'PLANNER_RESPONSE') continue;

    const cleaned =
      type === 'USER_INPUT'
        ? cleanUserInputContent(entry.content)
        : cleanAssistantContent(entry.content);
    if (!cleaned) continue;

    const truncated =
      cleaned.length > maxCharsPerTurn ? `${cleaned.slice(0, maxCharsPerTurn)}...` : cleaned;
    turns.push({
      role: type === 'USER_INPUT' ? 'user' : 'assistant',
      stepIndex: entry.step_index ?? null,
      createdAt: String(entry.created_at || ''),
      text: truncated,
    });
  }

  return turns.slice(-Math.max(1, maxTurns));
}

function escapeSqlLike(value) {
  return String(value || '').replace(/[\\%_]/g, '\\$&');
}

function rowToSessionMeta(row, store) {
  const id = String(row.conversation_id || '').trim();
  const isNative = store.source === 'cli' || hasCliNativeConversation(id);
  const appDataDir = resolveAppDataDir(row.app_data_dir, store.dir);
  return {
    id,
    title: String(row.title || '').trim() || '(无标题对话)',
    preview: String(row.preview || '').trim(),
    source: store.source,
    sourceLabel: store.sourceLabel,
    takeoverMode: isNative ? 'native' : 'handoff',
    takeoverLabel: isNative ? '原生直连' : '摘要接管',
    running: String(row.status || '') === 'CASCADE_RUN_STATUS_RUNNING',
    status: String(row.status || ''),
    stepCount: Number(row.step_count || 0),
    workspace: decodeWorkspaceUris(row.workspace_uris),
    lastModifiedTime: String(row.last_modified_time || ''),
    lastModifiedMs: parseTimestampMs(row.last_modified_time),
    appDataDir,
    brainDir: path.join(appDataDir, 'brain', id),
  };
}

function shouldPreferSessionCandidate(candidate, best) {
  if (!best) return true;
  return (
    (candidate.takeoverMode === 'native' && best.takeoverMode !== 'native') ||
    (candidate.takeoverMode === best.takeoverMode && candidate.lastModifiedMs > best.lastModifiedMs)
  );
}

/**
 * Batch-lookup SQLite metadata for multiple conversation IDs in minimal DB opens.
 */
export function getDesktopSessionMetaMap(conversationIds = []) {
  const uniqueIds = [...new Set(
    (Array.isArray(conversationIds) ? conversationIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  )];
  const resultMap = new Map();
  if (uniqueIds.length === 0) return resultMap;

  const CHUNK_SIZE = 200;
  for (const store of getAppStores()) {
    const dbPath = path.join(store.dir, 'conversation_summaries.db');
    if (!fs.existsSync(dbPath)) continue;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 1000;');
      for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
        const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = db
          .prepare(`
            SELECT
              conversation_id,
              title,
              preview,
              step_count,
              last_modified_time,
              workspace_uris,
              status,
              nesting_depth,
              app_data_dir
            FROM conversation_summaries
            WHERE conversation_id IN (${placeholders})
          `)
          .all(...chunk);
        for (const row of rows) {
          const candidate = rowToSessionMeta(row, store);
          const existing = resultMap.get(candidate.id);
          if (shouldPreferSessionCandidate(candidate, existing)) {
            resultMap.set(candidate.id, candidate);
          }
        }
      }
    } catch {
      // Ignore single-store errors
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close failures
      }
    }
  }
  return resultMap;
}

/**
 * Look up SQLite metadata for a single conversation without reading any transcript JSONL files.
 */
export function getDesktopSessionMeta(conversationId) {
  const target = String(conversationId || '').trim();
  if (!target) return null;

  let best = null;
  const escapedTarget = escapeSqlLike(target);
  for (const store of getAppStores()) {
    const dbPath = path.join(store.dir, 'conversation_summaries.db');
    if (!fs.existsSync(dbPath)) continue;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 1000;');
      const row = db
        .prepare(`
          SELECT
            conversation_id,
            title,
            preview,
            step_count,
            last_modified_time,
            workspace_uris,
            status,
            nesting_depth,
            app_data_dir
          FROM conversation_summaries
          WHERE conversation_id = ? OR conversation_id LIKE ? ESCAPE '\\'
          ORDER BY (conversation_id = ?) DESC, last_modified_time DESC
          LIMIT 1
        `)
        .get(target, `${escapedTarget}%`, target);
      if (row) {
        const candidate = rowToSessionMeta(row, store);
        if (shouldPreferSessionCandidate(candidate, best)) {
          best = candidate;
        }
      }
    } catch {
      // Ignore single-store errors
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close failures
      }
    }
  }
  return best;
}

/**
 * Look up a single session by full ID or unique prefix and attach recent transcript turns.
 */
export function getDesktopSessionDetail(conversationId) {
  const match = getDesktopSessionMeta(conversationId);
  if (!match) return null;

  const brainCandidates = [
    match.brainDir,
    path.join(getGeminiRoot(), 'antigravity', 'brain', match.id),
    path.join(getGeminiRoot(), 'antigravity-cli', 'brain', match.id),
  ].filter(Boolean);

  let turns = [];
  for (const dir of brainCandidates) {
    turns = extractTranscriptTurns(dir, { maxTurns: 6 });
    if (turns.length > 0) break;
  }

  let latestReply = null;
  for (const dir of brainCandidates) {
    latestReply = extractLatestAssistantReply(dir);
    if (latestReply) break;
  }

  return {
    ...match,
    turns,
    lastAssistantReply: latestReply?.text || '',
    lastAssistantReplyTotalChars: latestReply?.totalChars || 0,
    lastAssistantReplyTruncated: Boolean(latestReply?.truncated),
    lastAssistantReplyStepIndex: latestReply?.stepIndex ?? null,
    lastAssistantReplyCreatedAt: latestReply?.createdAt || '',
    transcriptFile: latestReply?.sourceFile || '',
  };
}

/**
 * Format a compact relative time label in Chinese.
 */
export function formatRelativeTime(ms) {
  if (!ms) return '未知时间';
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} 天前`;
}

/**
 * Build the one-shot handoff context block injected into the next CLI turn for Desktop-only sessions.
 */
export function buildDesktopHandoffContext(detail, { maxTurns = 6, maxLastReplyChars = 6000 } = {}) {
  const turns = Array.isArray(detail?.turns) ? detail.turns.slice(-maxTurns) : [];
  const lastReply = String(detail?.lastAssistantReply || '').trim();
  const headerLines = [
    '[电脑端对话上下文接管]',
    `你正在飞书端接管并延续一个来自「${detail?.sourceLabel || '桌面端 App'}」的历史对话（只读上下文接力）：`,
    `- 原会话 ID：${detail?.id || '未知'}`,
    `- 原对话标题：${detail?.title || '(无标题)'}`,
    detail?.workspace ? `- 原工作目录：${detail.workspace}` : '',
    detail?.stepCount ? `- 累计步数：${detail.stepCount}` : '',
    detail?.transcriptFile ? `- 原对话完整日志：${detail.transcriptFile}` : '',
    detail?.running ? '- 注意：原桌面端会话在扫描时显示为运行中，请在需要修改文件前先确认当前目录状态。' : '',
  ].filter(Boolean);

  const turnsForExcerpt =
    lastReply && turns.length > 0 && turns[turns.length - 1]?.role === 'assistant'
      ? turns.slice(0, -1)
      : turns;

  if (turnsForExcerpt.length > 0) {
    headerLines.push('', '最近对话摘录：');
    for (const turn of turnsForExcerpt) {
      const roleLabel = turn.role === 'user' ? '用户' : '助手';
      headerLines.push(`- ${roleLabel}：${turn.text}`);
    }
  } else if (!lastReply && detail?.preview) {
    headerLines.push('', `对话预览：${detail.preview}`);
  }

  if (lastReply) {
    const replyLimit = Math.max(200, Number(maxLastReplyChars) || 6000);
    const replySnippet =
      lastReply.length > replyLimit
        ? `${lastReply.slice(0, replyLimit)}...\n(完整内容可读取上方原对话完整日志)`
        : lastReply;
    headerLines.push('', '电脑端最后一条模型回复：', replySnippet);
  }

  headerLines.push('', '请基于以上上下文直接响应用户接下来的请求：');
  return headerLines.join('\n');
}

/**
 * Check read-only SQLite indexes to determine whether a conversation is a nested subagent (nesting_depth > 0).
 */
export function isSubagentConversation(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return false;
  for (const store of getAppStores()) {
    const dbPath = path.join(store.dir, 'conversation_summaries.db');
    if (!fs.existsSync(dbPath)) continue;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 500;');
      const row = db
        .prepare('SELECT COALESCE(nesting_depth, 0) AS depth FROM conversation_summaries WHERE conversation_id = ? LIMIT 1')
        .get(id);
      if (row && Number(row.depth) > 0) {
        return true;
      }
    } catch {
      // Ignore single-store lookup failures
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close failures
      }
    }
  }
  return false;
}
