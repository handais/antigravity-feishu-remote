import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.mjs';
import { expandHomePath } from './io-utils.mjs';

const SAFE_ENV_TEMPLATE_NAMES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);
const SENSITIVE_EXT_RE = /\.(?:pem|key|p12|pfx|jks|keystore|p8|kdbx)$/i;
const SSH_KEY_BASENAME_RE = /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:\.ppk)?$/i;
const CONFIG_SENSITIVE_FILES = new Set([
  'config.json',
  'user-auth.json',
  'state.json',
  'pending-restart.json',
  'stop-notify-dedup.json',
  'daemon.pid',
  'daemon.log',
  'daemon.err.log',
]);
const CONFIG_SENSITIVE_DIRS = ['approvals', 'backups', 'handoffs'];

function normalizePosixLower(p) {
  return path.normalize(String(p || '')).replace(/\\/g, '/').toLowerCase();
}

function checkNormalizedPathSensitivity(normalized, cfgDirNormalized) {
  if (!normalized) return false;
  const base = path.posix.basename(normalized);
  if (base === '.env' || (base.startsWith('.env.') && !SAFE_ENV_TEMPLATE_NAMES.has(base))) {
    return true;
  }
  if (SENSITIVE_EXT_RE.test(base) || SSH_KEY_BASENAME_RE.test(base)) {
    return true;
  }
  if (
    base === 'user-auth.json' ||
    base === 'credentials.json' ||
    base === 'application_default_credentials.json' ||
    /^.*secret.*\.json$/i.test(base) ||
    /^secrets?\.(?:ya?ml|toml|ini|json)$/i.test(base)
  ) {
    return true;
  }
  if (
    normalized.includes('/.ssh/') ||
    normalized.includes('/.aws/') ||
    normalized.includes('/.gnupg/') ||
    normalized.includes('/.gemini/') ||
    normalized.includes('/.config/gcloud/') ||
    normalized.includes('/library/keychains/') ||
    normalized.endsWith('/.git-credentials') ||
    normalized.endsWith('/.bash_history') ||
    normalized.endsWith('/.zsh_history') ||
    normalized.endsWith('/.sh_history') ||
    normalized.endsWith('/.node_repl_history') ||
    normalized.endsWith('/.python_history') ||
    normalized.endsWith('/.npmrc') ||
    normalized.endsWith('/.netrc') ||
    normalized.endsWith('/.pypirc') ||
    normalized.endsWith('/.docker/config.json') ||
    normalized.endsWith('/.kube/config')
  ) {
    return true;
  }
  if (normalized.includes('/antigravity-feishu/') || normalized.includes('/.config/antigravity-feishu/')) {
    return true;
  }
  if (cfgDirNormalized && (normalized === cfgDirNormalized || normalized.startsWith(`${cfgDirNormalized}/`))) {
    const rel = normalized.slice(cfgDirNormalized.length + 1);
    const firstSeg = rel.split('/')[0] || '';
    if (CONFIG_SENSITIVE_FILES.has(rel) || CONFIG_SENSITIVE_DIRS.includes(firstSeg)) {
      return true;
    }
  }
  return false;
}

/**
 * Determine whether a local or repository-relative path points to sensitive credentials or config.
 */
export function isSensitiveFilePath(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return false;

  let cfgDir = '';
  try {
    const resolvedCfg = path.resolve(getConfigDir());
    cfgDir = normalizePosixLower(fs.existsSync(resolvedCfg) ? fs.realpathSync(resolvedCfg) : resolvedCfg);
  } catch {
    cfgDir = normalizePosixLower(getConfigDir());
  }

  const expanded = expandHomePath(raw);
  const candidates = new Set([
    normalizePosixLower(raw),
    normalizePosixLower(expanded),
  ]);
  try {
    if (fs.existsSync(expanded)) {
      candidates.add(normalizePosixLower(fs.realpathSync(expanded)));
    }
  } catch {
    // Ignore unresolvable symlinks
  }

  for (const candidate of candidates) {
    if (checkNormalizedPathSensitivity(candidate, cfgDir)) {
      return true;
    }
  }
  return false;
}

/**
 * Strip hunks belonging to sensitive files from a full-repo `git diff` output.
 */
export function filterSensitiveGitDiff(diffText) {
  const raw = String(diffText || '');
  if (!raw.trim()) {
    return { diff: '', skippedFiles: [] };
  }

  const lines = raw.split('\n');
  const keptLines = [];
  const skippedFiles = [];
  let skippingCurrent = false;

  for (const line of lines) {
    const headerMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (headerMatch) {
      const aPath = headerMatch[1];
      const bPath = headerMatch[2];
      if (isSensitiveFilePath(aPath) || isSensitiveFilePath(bPath)) {
        skippingCurrent = true;
        skippedFiles.push(bPath || aPath);
        continue;
      }
      skippingCurrent = false;
    }
    if (!skippingCurrent) {
      keptLines.push(line);
    }
  }

  return {
    diff: keptLines.join('\n').trim(),
    skippedFiles: [...new Set(skippedFiles)],
  };
}
