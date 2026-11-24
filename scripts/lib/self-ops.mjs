import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureConfigDir, getConfigDir, getPluginRoot } from './config.mjs';
import { getDaemonStatus } from './daemon-ctl.mjs';

const MAX_SNAPSHOTS = 5;

export function getBackupsDir() {
  return path.join(getConfigDir(), 'backups');
}

export function getPendingRestartPath() {
  return path.join(getConfigDir(), 'pending-restart.json');
}

function collectFilesRecursive(baseDir, relPrefix = '') {
  if (!fs.existsSync(baseDir)) return [];
  const entries = fs.readdirSync(baseDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.DS_Store' || entry.name === 'node_modules' || entry.name.startsWith('.tmp')) {
      continue;
    }
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const abs = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFilesRecursive(abs, rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

function collectTrackedPluginFiles(pluginRoot = getPluginRoot()) {
  const files = collectFilesRecursive(path.join(pluginRoot, 'scripts'), 'scripts');
  for (const extra of ['package.json', 'README.md', 'skills/feishu-remote/SKILL.md']) {
    const abs = path.join(pluginRoot, extra);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        files.push(extra);
      }
    } catch {
      // Ignore inaccessible optional file
    }
  }
  return [...new Set(files)].sort();
}

function collectScriptMjsFiles(pluginRoot = getPluginRoot()) {
  return collectFilesRecursive(path.join(pluginRoot, 'scripts'), 'scripts').filter((rel) => rel.endsWith('.mjs'));
}

function writePrivateJsonAtomic(filePath, data) {
  const parentDir = path.dirname(filePath);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(parentDir, 0o700);
  } catch {
    // Ignore on filesystems that don't support chmod
  }
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // Ignore
  }
  fs.renameSync(tmpPath, filePath);
}

export function computePluginCodeHash(pluginRoot = getPluginRoot()) {
  const hash = crypto.createHash('sha256');
  for (const rel of collectTrackedPluginFiles(pluginRoot)) {
    const abs = path.join(pluginRoot, rel);
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const IMPORT_VERIFIER_CODE = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import { pathToFileURL } from 'node:url';",
  'const root = process.env.FEISHU_PREFLIGHT_ROOT;',
  "const scriptsDir = path.join(root, 'scripts');",
  "const libDir = path.join(scriptsDir, 'lib');",
  'const errors = [];',
  'function walkMjs(dir) {',
  '  if (!fs.existsSync(dir)) return [];',
  '  const out = [];',
  '  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {',
  '    const abs = path.join(dir, entry.name);',
  '    if (entry.isDirectory()) out.push(...walkMjs(abs));',
  "    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(abs);",
  '  }',
  '  return out.sort();',
  '}',
  'const libExports = new Map();',
  'for (const libFile of walkMjs(libDir)) {',
  '  const rel = path.relative(root, libFile).split(path.sep).join("/");',
  '  try {',
  '    const mod = await import(pathToFileURL(libFile).href);',
  '    libExports.set(path.resolve(libFile), new Set(Object.keys(mod)));',
  '  } catch (err) {',
  "    errors.push({ file: rel, stage: 'imports', error: err?.stack || err?.message || String(err) });",
  '  }',
  '}',
  'for (const scriptFile of walkMjs(scriptsDir)) {',
  '  const rel = path.relative(root, scriptFile).split(path.sep).join("/");',
  "  const src = fs.readFileSync(scriptFile, 'utf8');",
  '  const existRe = /(?:^|\\n)\\s*import\\s+(?:[^;]*?\\s+from\\s+)?[\'"](\\.[^\'"]+)[\'"]/g;',
  '  let m;',
  '  while ((m = existRe.exec(src)) !== null) {',
  '    const spec = m[1];',
  '    const resolved = path.resolve(path.dirname(scriptFile), spec);',
  '    if (!fs.existsSync(resolved)) {',
  "      errors.push({ file: rel, stage: 'imports', error: `Missing relative import target: ${spec}` });",
  '    }',
  '  }',
  '  const namedRe = /(?:^|\\n)\\s*import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"](\\.[^\'"]+)[\'"]/g;',
  '  while ((m = namedRe.exec(src)) !== null) {',
  '    const rawNames = m[1];',
  '    const spec = m[2];',
  '    const resolved = path.resolve(path.dirname(scriptFile), spec);',
  '    const exported = libExports.get(resolved);',
  '    if (!exported) continue;',
  "    for (const part of rawNames.split(',')) {",
  '      const cleaned = part.trim();',
  '      if (!cleaned) continue;',
  '      const importedName = cleaned.split(/\\s+as\\s+/)[0].trim();',
  '      if (importedName && !exported.has(importedName)) {',
  "        errors.push({ file: rel, stage: 'imports', error: `Export '${importedName}' not found in ${spec}` });",
  '      }',
  '    }',
  '  }',
  '}',
  'if (errors.length > 0) {',
  '  process.stdout.write(JSON.stringify({ errors }));',
  '  process.exit(1);',
  '}',
].join('\n');

export function runPreflightCheck(pluginRoot = getPluginRoot()) {
  const startedAt = Date.now();
  const mjsFiles = collectScriptMjsFiles(pluginRoot);
  const errors = [];

  for (const relPath of mjsFiles) {
    try {
      execFileSync(process.execPath, ['--check', path.join(pluginRoot, relPath)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 8000,
      });
    } catch (err) {
      errors.push({
        file: relPath,
        stage: 'syntax',
        error: String(err?.stderr || err?.message || err).trim().slice(0, 500),
      });
    }
  }

  if (errors.length === 0) {
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', IMPORT_VERIFIER_CODE], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
        env: { ...process.env, FEISHU_PREFLIGHT_ROOT: pluginRoot },
      });
    } catch (err) {
      const stdout = String(err?.stdout || '').trim();
      const stderr = String(err?.stderr || '').trim();
      let parsedErrors = null;
      if (stdout) {
        try {
          const parsed = JSON.parse(stdout);
          if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
            parsedErrors = parsed.errors;
          }
        } catch {
          // Ignore non-JSON stdout
        }
      }
      if (parsedErrors) {
        for (const item of parsedErrors) {
          errors.push({
            file: String(item?.file || 'scripts'),
            stage: 'imports',
            error: String(item?.error || 'Import verification error').trim().slice(0, 500),
          });
        }
      } else {
        errors.push({
          file: 'scripts/lib',
          stage: 'imports',
          error: (stderr || stdout || err?.message || 'Import verification failed').trim().slice(0, 500),
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    checkedFiles: mjsFiles,
    errors,
    durationMs: Date.now() - startedAt,
    hash: computePluginCodeHash(pluginRoot),
  };
}

export function listBackupSnapshots() {
  const backupsDir = getBackupsDir();
  const indexPath = path.join(backupsDir, 'index.json');
  if (!fs.existsSync(indexPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => {
      if (!entry || typeof entry !== 'object' || !entry.id) return false;
      const snapDir = path.join(backupsDir, String(entry.id));
      try {
        return fs.existsSync(snapDir) && fs.statSync(snapDir).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export function createBackupSnapshot({ reason = 'auto', force = false, pluginRoot = getPluginRoot() } = {}) {
  ensureConfigDir();
  const backupsDir = getBackupsDir();
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });

  const hash = computePluginCodeHash(pluginRoot);
  const existing = listBackupSnapshots();
  if (!force && existing[0]?.hash === hash) {
    return { created: false, skipped: true, snapshot: existing[0] };
  }

  const now = new Date();
  const compactUtc = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const baseId = `snap-${compactUtc}-${hash.slice(0, 8)}`;
  let id = baseId;
  let seq = 2;
  const existingIds = new Set(existing.map((s) => s.id));
  while (existingIds.has(id) || fs.existsSync(path.join(backupsDir, id))) {
    id = `${baseId}-${seq}`;
    seq += 1;
  }

  const files = collectTrackedPluginFiles(pluginRoot);
  const snapDir = path.join(backupsDir, id);
  fs.mkdirSync(snapDir, { recursive: true, mode: 0o700 });

  for (const rel of files) {
    const src = path.join(pluginRoot, rel);
    const dest = path.join(snapDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dest);
  }

  const snapshot = {
    id,
    createdAt: now.toISOString(),
    hash,
    shortHash: hash.slice(0, 8),
    reason: String(reason || 'auto'),
    filesCount: files.length,
  };

  const nextList = [snapshot, ...existing];
  const kept = nextList.slice(0, MAX_SNAPSHOTS);
  const pruned = nextList.slice(MAX_SNAPSHOTS);
  for (const old of pruned) {
    if (!old?.id) continue;
    try {
      fs.rmSync(path.join(backupsDir, old.id), { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  writePrivateJsonAtomic(path.join(backupsDir, 'index.json'), kept);
  return { created: true, skipped: false, snapshot };
}

export function findRollbackTarget(requestedId = '', pluginRoot = getPluginRoot()) {
  const snapshots = listBackupSnapshots();
  const query = String(requestedId || '').trim();
  if (query) {
    return (
      snapshots.find((s) => s.id === query || s.shortHash === query || s.id.includes(query)) ||
      null
    );
  }
  const currentHash = computePluginCodeHash(pluginRoot);
  return snapshots.find((s) => s.hash !== currentHash) || null;
}

export function restoreBackupSnapshot(requestedId = '', pluginRoot = getPluginRoot()) {
  const target = findRollbackTarget(requestedId, pluginRoot);
  if (!target) {
    return {
      ok: false,
      error: '没有可回滚的历史快照',
      snapshot: null,
      check: null,
    };
  }

  const snapDir = path.join(getBackupsDir(), target.id);
  const snapFiles = collectFilesRecursive(snapDir);
  const buffered = new Map();
  for (const rel of snapFiles) {
    buffered.set(rel, fs.readFileSync(path.join(snapDir, rel)));
  }

  if (!buffered.has('scripts/bridge-daemon.mjs')) {
    return {
      ok: false,
      error: `快照 ${target.id} 缺少核心文件 scripts/bridge-daemon.mjs`,
      snapshot: target,
      check: null,
    };
  }

  if (computePluginCodeHash(pluginRoot) !== target.hash) {
    const currentCheck = runPreflightCheck(pluginRoot);
    if (currentCheck.ok) {
      createBackupSnapshot({ reason: 'pre-rollback', force: false, pluginRoot });
    }
  }

  for (const [rel, buf] of buffered.entries()) {
    const dest = path.join(pluginRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }

  for (const existingMjs of collectScriptMjsFiles(pluginRoot)) {
    if (!buffered.has(existingMjs)) {
      try {
        fs.rmSync(path.join(pluginRoot, existingMjs), { force: true });
      } catch {
        // Ignore removal errors
      }
    }
  }

  const check = runPreflightCheck(pluginRoot);
  return {
    ok: check.ok,
    snapshot: target,
    restoredFilesCount: buffered.size,
    check,
  };
}

export function writePendingRestartNotice(notice) {
  ensureConfigDir();
  writePrivateJsonAtomic(getPendingRestartPath(), {
    ...notice,
    writtenAt: Date.now(),
  });
}

export function consumePendingRestartNotice() {
  const noticePath = getPendingRestartPath();
  if (!fs.existsSync(noticePath)) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(noticePath, 'utf8'));
  } catch {
    parsed = null;
  }
  try {
    fs.rmSync(noticePath, { force: true });
  } catch {
    // Ignore
  }
  return parsed && typeof parsed === 'object' ? parsed : null;
}

export function scheduleDaemonSelfRestart({ delayMs = 700, onBeforeExit } = {}) {
  const timer = setTimeout(() => {
    try {
      onBeforeExit?.();
    } catch (err) {
      console.error('[feishu-remote] onBeforeExit error:', err?.message || err);
    }

    let status;
    try {
      status = getDaemonStatus();
    } catch {
      status = { manager: 'unknown', running: false, pid: null };
    }

    if ((status.manager === 'launchd' || status.manager === 'systemd') && status.running && status.pid === process.pid) {
      console.error(`[feishu-remote] Exiting cleanly so ${status.manager} respawns daemon...`);
      process.exit(0);
    }

    console.error('[feishu-remote] Spawning detached cli.mjs restart before exiting...');
    const cliPath = path.join(getPluginRoot(), 'scripts', 'cli.mjs');
    const child = spawn(process.execPath, [cliPath, 'restart'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
    process.exit(0);
  }, delayMs);
  return timer;
}
