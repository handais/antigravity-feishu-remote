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
 * Acquire an exclusive advisory lockfile around synchronous read-modify-write transactions.
 */
export function withFileLock(lockPath, fn, { timeoutMs = 2000, staleMs = 5000 } = {}) {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + Math.max(50, Number(timeoutMs) || 2000);
  const staleLimit = Math.max(500, Number(staleMs) || 5000);
  let acquired = false;
  let fd = null;

  while (true) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, 'utf8');
      fs.closeSync(fd);
      fd = null;
      acquired = true;
      break;
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close error
        }
        fd = null;
      }
      if (err?.code !== 'EEXIST') {
        throw err;
      }
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleLimit) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // Lock disappeared concurrently; retry immediately
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring file lock: ${lockPath}`);
      }
      sleepSync(15);
    }
  }

  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // Ignore lock cleanup errors
      }
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

const TIMESTAMPED_CONSOLE_SYM = Symbol.for('antigravity.feishuRemote.timestampedConsole');

function pad2(num) {
  return String(num).padStart(2, '0');
}

function pad3(num) {
  return String(num).padStart(3, '0');
}

/**
 * Format a Date (or timestamp) as local wall-clock time `YYYY-MM-DD HH:mm:ss.SSS±HH:MM`.
 */
export function formatLocalTimestamp(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  const year = safe.getFullYear();
  const month = pad2(safe.getMonth() + 1);
  const day = pad2(safe.getDate());
  const hours = pad2(safe.getHours());
  const minutes = pad2(safe.getMinutes());
  const seconds = pad2(safe.getSeconds());
  const millis = pad3(safe.getMilliseconds());
  const offsetMin = -safe.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMin);
  const offsetHours = pad2(Math.floor(absOffset / 60));
  const offsetMins = pad2(absOffset % 60);
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}${sign}${offsetHours}:${offsetMins}`;
}

/**
 * Idempotently prefix `console.log`/`info`/`warn`/`error` with local timestamps.
 */
export function installTimestampedConsole(targetConsole = console, { now = () => new Date() } = {}) {
  if (!targetConsole || targetConsole[TIMESTAMPED_CONSOLE_SYM]) {
    return targetConsole;
  }
  for (const method of ['log', 'info', 'warn', 'error']) {
    const original = targetConsole[method];
    if (typeof original !== 'function') continue;
    targetConsole[method] = (...args) => {
      const prefix = `[${formatLocalTimestamp(now())}]`;
      if (args.length === 0) {
        return original.call(targetConsole, prefix);
      }
      if (typeof args[0] === 'string') {
        return original.call(targetConsole, `${prefix} ${args[0]}`, ...args.slice(1));
      }
      return original.call(targetConsole, prefix, ...args);
    };
  }
  Object.defineProperty(targetConsole, TIMESTAMPED_CONSOLE_SYM, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return targetConsole;
}
