import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir, getLogPaths, loadState, saveState } from './config.mjs';

export const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.ico',
  '.tif',
  '.tiff',
]);

let lastCleanupAt = 0;

export function isImageFilePath(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

export function resolveFeishuFileType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.doc' || ext === '.docx') return 'doc';
  if (ext === '.xls' || ext === '.xlsx') return 'xls';
  if (ext === '.ppt' || ext === '.pptx') return 'ppt';
  if (ext === '.mp4') return 'mp4';
  if (ext === '.opus') return 'opus';
  return 'stream';
}

export function getInboxDir() {
  return path.join(getConfigDir(), 'inbox');
}

function cleanupDirectoryRecursive(dirPath, cutoffMs, isRoot = false) {
  if (!fs.existsSync(dirPath)) return;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        cleanupDirectoryRecursive(abs, cutoffMs, false);
      } else if (entry.isFile()) {
        const stat = fs.statSync(abs);
        if (stat.mtimeMs < cutoffMs) {
          fs.rmSync(abs, { force: true });
        }
      }
    } catch {
      // Ignore individual entry cleanup errors
    }
  }
  if (!isRoot) {
    try {
      if (fs.readdirSync(dirPath).length === 0) {
        const dirStat = fs.statSync(dirPath);
        if (Date.now() - dirStat.mtimeMs >= 60_000) {
          fs.rmdirSync(dirPath);
        }
      }
    } catch {
      // Ignore non-empty or busy dirs
    }
  }
}

function collectInboxFiles(dirPath, out) {
  if (!fs.existsSync(dirPath)) return;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        collectInboxFiles(abs, out);
      } else if (entry.isFile()) {
        const stat = fs.statSync(abs);
        out.push({ abs, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // Ignore entry stat failures
    }
  }
}

function pruneEmptySubdirs(dirPath, isRoot = false) {
  if (!fs.existsSync(dirPath)) return;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      pruneEmptySubdirs(path.join(dirPath, entry.name), false);
    }
  }
  if (!isRoot) {
    try {
      if (fs.readdirSync(dirPath).length === 0) {
        const dirStat = fs.statSync(dirPath);
        if (Date.now() - dirStat.mtimeMs >= 60_000) {
          fs.rmdirSync(dirPath);
        }
      }
    } catch {
      // Ignore non-empty or busy dirs
    }
  }
}

export function cleanupOldInboxFiles(maxAgeDays = 7, { maxTotalBytes = 200 * 1024 * 1024 } = {}) {
  try {
    const inboxDir = getInboxDir();
    const cutoffMs = Date.now() - Math.max(1, Number(maxAgeDays) || 7) * 86400_000;
    cleanupDirectoryRecursive(inboxDir, cutoffMs, true);

    const cap = Number(maxTotalBytes);
    if (cap > 0 && fs.existsSync(inboxDir)) {
      const remaining = [];
      collectInboxFiles(inboxDir, remaining);
      let totalBytes = remaining.reduce((sum, f) => sum + f.size, 0);
      if (totalBytes > cap) {
        remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const item of remaining) {
          if (totalBytes <= cap) break;
          try {
            fs.rmSync(item.abs, { force: true });
            totalBytes -= item.size;
          } catch {
            // Ignore single file deletion error
          }
        }
        pruneEmptySubdirs(inboxDir, true);
      }
    }
  } catch {
    // Ignore cleanup failures
  }
}

/**
 * Truncate an oversized log file in place (keeping same inode so launchd O_APPEND FDs remain valid).
 */
export function pruneLogFileIfOversized(
  filePath,
  { maxBytes = 5 * 1024 * 1024, keepBytes = 512 * 1024 } = {},
) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { pruned: false, beforeBytes: 0, afterBytes: 0 };
  }
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return { pruned: false, beforeBytes: stat.size, afterBytes: stat.size };
  }
  const tailLen = Math.min(stat.size, Math.max(256, Number(keepBytes) || 512 * 1024));
  const start = Math.max(0, stat.size - tailLen);
  const fd = fs.openSync(filePath, 'r+');
  try {
    const tailBuf = Buffer.allocUnsafe(tailLen);
    const bytesRead = fs.readSync(fd, tailBuf, 0, tailLen, start);
    let text = tailBuf.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    const header = '[feishu-remote] Log truncated in-place to keep latest tail\n';
    const outBuf = Buffer.from(`${header}${text}`, 'utf8');
    fs.writeSync(fd, outBuf, 0, outBuf.length, 0);
    fs.ftruncateSync(fd, outBuf.length);
    return { pruned: true, beforeBytes: stat.size, afterBytes: outBuf.length };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Prune stale per-thread chat state entries older than maxAgeDays (only `#` thread sub-sessions).
 */
export function pruneStaleThreadStates(maxAgeDays = 30) {
  let removed = 0;
  try {
    const state = loadState();
    const cutoff = Date.now() - Math.max(1, Number(maxAgeDays) || 30) * 86400_000;
    let dirty = false;
    for (const [key, info] of Object.entries(state.chats || {})) {
      if (!key.includes('#')) continue;
      const lastActive = Number(info?.lastActiveAt || 0);
      if (lastActive > 0 && lastActive < cutoff) {
        delete state.chats[key];
        removed += 1;
        dirty = true;
      }
    }
    if (dirty) {
      saveState(state);
    }
  } catch {
    // Ignore stale thread state cleanup failures
  }
  return removed;
}

/**
 * Run periodic maintenance on daemon logs and downloaded inbox attachments.
 */
export function maintainRuntimeStorage({
  maxLogBytes = 5 * 1024 * 1024,
  keepLogBytes = 512 * 1024,
  inboxMaxAgeDays = 7,
  inboxMaxBytes = 200 * 1024 * 1024,
  threadMaxAgeDays = 30,
} = {}) {
  const { outLog, errLog } = getLogPaths();
  let outRes = { pruned: false, beforeBytes: 0, afterBytes: 0 };
  let errRes = { pruned: false, beforeBytes: 0, afterBytes: 0 };
  try {
    outRes = pruneLogFileIfOversized(outLog, { maxBytes: maxLogBytes, keepBytes: keepLogBytes });
  } catch {
    // Ignore log prune failure
  }
  try {
    errRes = pruneLogFileIfOversized(errLog, { maxBytes: maxLogBytes, keepBytes: keepLogBytes });
  } catch {
    // Ignore errLog prune failure
  }
  cleanupOldInboxFiles(inboxMaxAgeDays, { maxTotalBytes: inboxMaxBytes });
  const prunedThreads = pruneStaleThreadStates(threadMaxAgeDays);
  return { outLog: outRes, errLog: errRes, prunedThreads };
}

export function detectExtensionFromBuffer(buf, fallbackExt = '.bin') {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return fallbackExt;
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return '.png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return '.jpg';
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'GIF8') {
    return '.gif';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return '.webp';
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF') {
    return '.pdf';
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'OggS') {
    return '.ogg';
  }
  if (buf.length >= 8 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    return '.mp4';
  }
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return '.zip';
  }
  return fallbackExt;
}

export function sanitizeFileName(name, fallback = 'attachment') {
  const base = path.basename(String(name || '').trim()).replace(/^\.+/, '');
  if (!base) return fallback;
  const rawExt = path.extname(base);
  const rawStem = rawExt ? base.slice(0, -rawExt.length) : base;
  const cleanStem = rawStem.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '').slice(0, 64);
  const cleanExt = rawExt ? rawExt.replace(/[^\p{L}\p{N}._-]+/gu, '') : '';
  return `${cleanStem || fallback}${cleanExt}`;
}

function extractPostMessage(parsed) {
  const root = parsed?.content && Array.isArray(parsed.content)
    ? parsed
    : parsed?.zh_cn ||
      parsed?.en_us ||
      parsed?.ja_jp ||
      Object.values(parsed || {}).find((v) => v && Array.isArray(v.content));
  if (!root || !Array.isArray(root.content)) {
    return { text: '', attachments: [] };
  }

  const parts = [];
  const attachments = [];
  if (root.title) parts.push(String(root.title));

  for (const paragraph of root.content) {
    if (!Array.isArray(paragraph)) continue;
    const lineParts = [];
    for (const elem of paragraph) {
      if (!elem) continue;
      if (elem.tag === 'text' && elem.text) {
        lineParts.push(elem.text);
      } else if (elem.tag === 'a' && elem.text) {
        lineParts.push(elem.href ? `[${elem.text}](${elem.href})` : elem.text);
      } else if (elem.tag === 'at' && elem.user_name) {
        lineParts.push(`@${elem.user_name}`);
      } else if (elem.tag === 'code_block' && elem.text) {
        const lang = elem.language ? String(elem.language).trim() : '';
        parts.push(`\`\`\`${lang}\n${elem.text}\n\`\`\``);
      } else if (elem.tag === 'md' && elem.text) {
        lineParts.push(elem.text);
      } else if (elem.tag === 'img' && elem.image_key) {
        attachments.push({
          kind: 'image',
          resourceType: 'image',
          fileKey: String(elem.image_key),
          fileName: '',
        });
      } else if (elem.tag === 'media' && elem.file_key) {
        attachments.push({
          kind: 'media',
          resourceType: 'file',
          fileKey: String(elem.file_key),
          fileName: String(elem.file_name || ''),
        });
      }
    }
    const line = lineParts.join('').trim();
    if (line) parts.push(line);
  }

  return { text: parts.join('\n').trim(), attachments };
}

function formatTodoDueTime(rawDueTime) {
  const rawStr = String(rawDueTime ?? '').trim();
  if (!rawStr) return '';
  const num = Number(rawStr);
  if (!Number.isFinite(num) || num <= 0) return '';
  const ms = num < 1e11 ? num * 1000 : num;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function extractTodoMessage(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { text: '', attachments: [] };
  }
  let bodyText = '';
  let attachments = [];
  if (parsed.summary && typeof parsed.summary === 'object') {
    const postRes = extractPostMessage(parsed.summary);
    bodyText = postRes.text;
    attachments = postRes.attachments;
    if (!bodyText && parsed.summary.title) {
      bodyText = String(parsed.summary.title).trim();
    }
  } else if (typeof parsed.summary === 'string') {
    bodyText = parsed.summary.trim();
  } else if (parsed.title) {
    bodyText = String(parsed.title).trim();
  }

  const metaParts = [];
  const dueText = formatTodoDueTime(parsed.due_time);
  if (dueText) {
    metaParts.push(`截止时间：${dueText}`);
  }
  const taskId = String(parsed.task_id || '').trim();
  if (taskId) {
    metaParts.push(`task_id=${taskId}`);
  }

  const lines = [];
  if (bodyText) {
    lines.push('【飞书任务】', bodyText);
  } else if (metaParts.length > 0 || attachments.length > 0) {
    lines.push('【飞书任务】');
  }
  if (metaParts.length > 0) {
    lines.push(metaParts.join(' · '));
  }

  return { text: lines.join('\n').trim(), attachments };
}

export function extractInboundMessage(message) {
  const msgType = message?.message_type || '';
  const rawContent = message?.content || '';
  if (!rawContent) {
    return { supported: false, msgType, text: '', attachments: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return { supported: false, msgType, text: '', attachments: [] };
  }

  if (msgType === 'text') {
    return {
      supported: true,
      msgType,
      text: String(parsed?.text || ''),
      attachments: [],
    };
  }
  if (msgType === 'post') {
    const { text, attachments } = extractPostMessage(parsed);
    return { supported: true, msgType, text, attachments };
  }
  if (msgType === 'todo') {
    const { text, attachments } = extractTodoMessage(parsed);
    return {
      supported: Boolean(text || attachments.length > 0),
      msgType,
      text,
      attachments,
    };
  }
  if (msgType === 'image') {
    const fileKey = String(parsed?.image_key || '').trim();
    return {
      supported: Boolean(fileKey),
      msgType,
      text: '',
      attachments: fileKey
        ? [{ kind: 'image', resourceType: 'image', fileKey, fileName: '' }]
        : [],
    };
  }
  if (msgType === 'file') {
    const fileKey = String(parsed?.file_key || '').trim();
    return {
      supported: Boolean(fileKey),
      msgType,
      text: '',
      attachments: fileKey
        ? [{ kind: 'file', resourceType: 'file', fileKey, fileName: String(parsed?.file_name || '') }]
        : [],
    };
  }
  if (msgType === 'audio') {
    const fileKey = String(parsed?.file_key || '').trim();
    return {
      supported: Boolean(fileKey),
      msgType,
      text: '',
      attachments: fileKey
        ? [{ kind: 'audio', resourceType: 'file', fileKey, fileName: '', duration: Number(parsed?.duration || 0) }]
        : [],
    };
  }
  if (msgType === 'media') {
    const fileKey = String(parsed?.file_key || '').trim();
    return {
      supported: Boolean(fileKey),
      msgType,
      text: '',
      attachments: fileKey
        ? [
            {
              kind: 'media',
              resourceType: 'file',
              fileKey,
              fileName: String(parsed?.file_name || ''),
              duration: Number(parsed?.duration || 0),
            },
          ]
        : [],
    };
  }

  return { supported: false, msgType, text: '', attachments: [] };
}

function defaultExtForKind(kind) {
  if (kind === 'image') return '.png';
  if (kind === 'audio') return '.ogg';
  if (kind === 'media') return '.mp4';
  return '.bin';
}

async function readResourceBuffer(resp, tempDir, maxBytes) {
  if (typeof resp?.getReadableStream === 'function') {
    const stream = resp.getReadableStream();
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        if (typeof stream.destroy === 'function') stream.destroy();
        throw new Error(`附件体积超过限制 (${formatBytes(maxBytes)})`);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }
  if (Buffer.isBuffer(resp)) {
    if (resp.length > maxBytes) {
      throw new Error(`附件体积超过限制 (${formatBytes(maxBytes)})`);
    }
    return resp;
  }
  if (typeof resp?.writeFile === 'function') {
    const tmpFile = path.join(tempDir, `.dl-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
    try {
      fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
      await resp.writeFile(tmpFile);
      const stat = fs.statSync(tmpFile);
      if (stat.size > maxBytes) {
        throw new Error(`附件体积超过限制 (${formatBytes(maxBytes)})`);
      }
      return fs.readFileSync(tmpFile);
    } finally {
      try {
        fs.rmSync(tmpFile, { force: true });
      } catch {
        // Ignore temp cleanup errors
      }
    }
  }
  throw new Error('Unsupported Feishu resource response format');
}

function extractLarkErrorMessage(err) {
  const apiMsg = err?.response?.data?.msg || err?.response?.data?.error?.message || '';
  const apiCode = err?.response?.data?.code;
  if (apiMsg) {
    return apiCode !== undefined ? `code=${apiCode}: ${apiMsg}` : apiMsg;
  }
  return err?.message || String(err);
}

export async function downloadMessageAttachments(
  client,
  { messageId, chatKey = 'default', attachments = [], maxItems = 6, maxBytes = 30 * 1024 * 1024 },
) {
  if (Date.now() - lastCleanupAt >= 3600_000) {
    lastCleanupAt = Date.now();
    cleanupOldInboxFiles(7);
  }

  const chatInboxDir = path.join(getInboxDir(), sanitizeFileName(chatKey, 'default'));
  fs.mkdirSync(chatInboxDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(chatInboxDir, 0o700);
  } catch {
    // Ignore on unsupported filesystems
  }

  const downloaded = [];
  const failed = [];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const targets = attachments.slice(0, maxItems);

  for (let i = 0; i < targets.length; i += 1) {
    const att = targets[i];
    try {
      const resp = await client.im.v1.messageResource.get({
        path: {
          message_id: messageId,
          file_key: att.fileKey,
        },
        params: {
          type: att.resourceType,
        },
      });
      const buf = await readResourceBuffer(resp, chatInboxDir, maxBytes);
      const fallbackExt = defaultExtForKind(att.kind);
      const baseCandidate = att.fileName
        ? sanitizeFileName(att.fileName, att.kind)
        : `${att.kind}${detectExtensionFromBuffer(buf, fallbackExt)}`;
      const hasExt = Boolean(path.extname(baseCandidate));
      const finalBase = hasExt ? baseCandidate : `${baseCandidate}${detectExtensionFromBuffer(buf, fallbackExt)}`;
      const finalName = `${stamp}-${i + 1}-${finalBase}`;
      const localPath = path.join(chatInboxDir, finalName);

      fs.mkdirSync(chatInboxDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(localPath, buf, { mode: 0o600 });
      try {
        fs.chmodSync(localPath, 0o600);
      } catch {
        // Ignore
      }

      downloaded.push({
        ...att,
        localPath,
        fileName: finalName,
        sizeBytes: buf.length,
      });
    } catch (err) {
      failed.push({
        ...att,
        error: extractLarkErrorMessage(err),
      });
    }
  }

  return { downloaded, failed };
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function labelForKind(kind) {
  if (kind === 'image') return '图片';
  if (kind === 'audio') return '语音';
  if (kind === 'media') return '视频';
  return '文件';
}

function collectTextSegments(node, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      collectTextSegments(item, out);
    }
    return;
  }
  if (typeof node !== 'object') return;

  if (typeof node.content === 'string' && (node.tag === 'markdown' || node.tag === 'lark_md' || node.tag === 'plain_text')) {
    const s = node.content.trim();
    if (s) out.push(s);
  } else if (typeof node.text === 'string' && (node.tag === 'text' || node.tag === 'md' || node.tag === 'plain_text' || node.tag === 'lark_md')) {
    const s = node.text.trim();
    if (s) out.push(node.href ? `[${s}](${node.href})` : s);
  } else if (node.tag === 'a' && typeof node.text === 'string') {
    const s = node.text.trim();
    if (s) out.push(node.href ? `[${s}](${node.href})` : s);
  }

  if (node.text && typeof node.text === 'object') collectTextSegments(node.text, out);
  if (Array.isArray(node.elements)) collectTextSegments(node.elements, out);
  if (Array.isArray(node.columns)) collectTextSegments(node.columns, out);
  if (Array.isArray(node.fields)) collectTextSegments(node.fields, out);
  if (node.body?.elements) collectTextSegments(node.body.elements, out);
}

export function extractInteractiveCardText(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  const parts = [];
  const headerTitle = parsed.header?.title?.content || parsed.title || '';
  if (typeof headerTitle === 'string' && headerTitle.trim()) {
    parts.push(`【卡片标题】${headerTitle.trim()}`);
  }
  collectTextSegments(parsed.body?.elements || parsed.elements || [], parts);
  const seen = new Set();
  const deduped = [];
  for (const part of parts) {
    if (!seen.has(part)) {
      seen.add(part);
      deduped.push(part);
    }
  }
  return deduped.join('\n').trim();
}

export async function fetchQuotedMessageContext(
  client,
  { parentId, chatKey = 'default', maxTextChars = 4000 } = {},
) {
  if (!parentId || !client?.im?.v1?.message?.get) {
    return null;
  }
  let res;
  try {
    res = await client.im.v1.message.get({
      path: { message_id: parentId },
    });
  } catch (err) {
    console.error(`[feishu-remote] fetchQuotedMessageContext(${parentId}) error:`, err?.message || err);
    return null;
  }
  if (res && typeof res.code === 'number' && res.code !== 0) {
    console.error(`[feishu-remote] fetchQuotedMessageContext(${parentId}) code=${res.code}: ${res.msg || ''}`);
    return null;
  }
  const item = res?.data?.items?.[0];
  if (!item || item.deleted) {
    return null;
  }

  const msgType = item.msg_type || '';
  const rawBody = item.body?.content || '';
  let text = '';
  let downloaded = [];
  let failed = [];

  if (msgType === 'interactive') {
    try {
      text = extractInteractiveCardText(JSON.parse(rawBody));
    } catch {
      text = String(rawBody || '').trim();
    }
  } else {
    const parsed = extractInboundMessage({
      message_type: msgType,
      content: rawBody,
    });
    text = parsed.text || '';
    if (parsed.attachments.length > 0) {
      const dl = await downloadMessageAttachments(client, {
        messageId: parentId,
        chatKey,
        attachments: parsed.attachments,
        maxItems: 3,
      });
      downloaded = dl.downloaded;
      failed = dl.failed;
    }
  }

  const cleanText = String(text || '').trim();
  const limit = Math.max(200, Number(maxTextChars) || 4000);
  const cappedText = cleanText.length > limit ? `${cleanText.slice(0, limit)}\n...(引用文本已截断)` : cleanText;

  return {
    messageId: parentId,
    senderType: item.sender?.sender_type || '',
    msgType,
    text: cappedText,
    downloaded,
    failed,
  };
}

export function buildMultimodalPrompt({ text = '', downloaded = [], failed = [], quoted = null, docs = [] }) {
  const hasQuoted = Boolean(quoted && (quoted.text || (quoted.downloaded && quoted.downloaded.length > 0)));
  const hasDocs = Array.isArray(docs) && docs.length > 0;
  const combinedDownloaded = [];
  const seenPaths = new Set();
  for (const item of [...downloaded, ...(quoted?.downloaded || [])]) {
    if (!item?.localPath || seenPaths.has(item.localPath)) continue;
    seenPaths.add(item.localPath);
    combinedDownloaded.push(item);
  }
  const combinedFailed = [...failed, ...(quoted?.failed || [])];

  if (combinedDownloaded.length === 0 && combinedFailed.length === 0 && !hasQuoted && !hasDocs) {
    return String(text || '');
  }

  const lines = [];

  if (hasQuoted) {
    const who = quoted.senderType === 'app' ? '机器人消息' : '历史消息';
    lines.push(`【引用回复的${who}（msg_id=${quoted.messageId}）】`);
    if (quoted.text) {
      lines.push(quoted.text);
    } else if (quoted.downloaded?.length > 0) {
      lines.push('（引用了一条媒体/文件消息，附件路径见下方）');
    }
  }

  if (hasDocs) {
    if (lines.length > 0) lines.push('');
    lines.push('【飞书云文档上下文】');
    for (const doc of docs) {
      if (doc.error) {
        lines.push(`- 链接：${doc.url}\n  读取失败：${doc.error}（若为无权限，可提醒用户把文档分享给机器人或开通应用文档读权限）`);
      } else {
        const truncNote = doc.truncated ? `（仅截取前 ${doc.content.length} / 共 ${doc.totalChars} 字）` : '';
        lines.push(`### ${doc.title}${truncNote}\n链接：${doc.url}\n\n${doc.content}`);
      }
    }
  }

  if (combinedDownloaded.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('【飞书附带的本地媒体/文件】');
    for (const item of combinedDownloaded) {
      const durationNote = item.duration > 0 ? `，时长 ${Math.round(item.duration / 1000)}s` : '';
      lines.push(`- ${labelForKind(item.kind)}：\`${item.localPath}\`（${formatBytes(item.sizeBytes)}${durationNote}）`);
    }
    lines.push('请先使用 `read_file` 工具读取上述本地文件路径中的内容（`read_file` 原生支持图片、PDF、音频、视频与文本/代码文件），再结合上下文给出准确答复。');
  }

  if (combinedFailed.length > 0) {
    lines.push('', '【部分附件下载失败】');
    for (const item of combinedFailed) {
      lines.push(`- ${labelForKind(item.kind)}（key=${item.fileKey}）：${item.error}`);
    }
    lines.push('（如提示权限不足，请提醒用户在飞书开放平台开通 `im:resource` 权限并发布应用版本。）');
  }

  const trimmedText = String(text || '').trim();
  if (trimmedText) {
    lines.push('', combinedDownloaded.length > 0 ? '【用户附言】' : '【用户消息】', trimmedText);
  } else if (combinedDownloaded.length > 0) {
    const primaryKind = combinedDownloaded[0].kind;
    let defaultReq = '请阅读以上附件内容，总结核心信息并按内容协助处理。';
    if (primaryKind === 'audio') {
      defaultReq = '请先听取上述语音内容，理解用户意图并直接用中文回复或执行对应任务。';
    } else if (primaryKind === 'image') {
      defaultReq = '请查看分析上述图片/截图内容（如有报错截图、UI 或代码问题请直接诊断并给出方案）。';
    }
    lines.push('', '【任务说明】', defaultReq);
  }

  return lines.join('\n');
}
