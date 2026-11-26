import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RETRY_SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  try {
    Atomics.wait(RETRY_SLEEP_BUF, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Fallback busy-wait if Atomics.wait is disallowed
    }
  }
}

/**
 * Atomically write a private file with restrictive permissions and Windows EPERM/EBUSY rename retries.
 */
export function writePrivateFileAtomic(filePath, content, { mode = 0o600, dirMode = 0o700 } = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: dirMode });
  try {
    fs.chmodSync(dir, dirMode);
  } catch {
    // Ignore on filesystems that do not support POSIX chmod
  }

  const suffix = crypto.randomBytes(4).toString('hex');
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${suffix}`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode });
    try {
      fs.chmodSync(tmpPath, mode);
    } catch {
      // Ignore on unsupported filesystems
    }

    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        fs.renameSync(tmpPath, filePath);
        return;
      } catch (err) {
        const retryable = err?.code === 'EPERM' || err?.code === 'EBUSY';
        if (!retryable || attempt === maxAttempts) {
          throw err;
        }
        sleepSync(20 * attempt);
      }
    }
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.rmSync(tmpPath, { force: true });
      }
    } catch {
      // Ignore temp file cleanup errors
    }
  }
}

/**
 * Atomically write a JSON object with 0600 permissions.
 */
export function writePrivateJsonAtomic(filePath, data) {
  writePrivateFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Read stdin completely up to `timeoutMs` (resolves early on EOF or TTY).
 */
export function readStdinWithTimeout(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    process.stdin.resume();
  });
}

/**
 * Expand `~` / `~/` / `~\` prefixes and resolve relative paths against `baseCwd`.
 */
export function expandHomePath(inputPath, baseCwd = '') {
  const trimmed = String(inputPath || '').trim();
  if (!trimmed) return baseCwd || os.homedir();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(baseCwd || os.homedir(), trimmed);
}

/**
 * Sanitize dynamic strings before embedding inside markdown inline code spans.
 */
export function sanitizeInlineCode(text, maxLen = 0) {
  let clean = String(text ?? '')
    .replace(/\0/g, '')
    .replace(/[`\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (maxLen > 0 && clean.length > maxLen) {
    clean = clean.slice(0, maxLen);
  }
  return clean;
}

/**
 * Mask opaque user/chat identifiers for safe diagnostic logging.
 */
export function maskIdentifier(id) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  if (raw.length <= 8) return '***';
  return `${raw.slice(0, 6)}***${raw.slice(-4)}`;
}
