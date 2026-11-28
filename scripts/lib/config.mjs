import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withFileLock, writePrivateJsonAtomic } from './io-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function getPluginRoot() {
  return path.resolve(__dirname, '..', '..');
}

export function getConfigDir() {
  if (process.env.FEISHU_REMOTE_CONFIG_DIR) {
    return path.resolve(process.env.FEISHU_REMOTE_CONFIG_DIR);
  }
  return path.join(os.homedir(), '.config', 'antigravity-feishu');
}

export function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

export function getStatePath() {
  return path.join(getConfigDir(), 'state.json');
}

export function getUserAuthPath() {
  return path.join(getConfigDir(), 'user-auth.json');
}

export function loadUserAuth() {
  const authPath = getUserAuthPath();
  if (!fs.existsSync(authPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return {
      accessToken: String(parsed.accessToken || '').trim(),
      refreshToken: String(parsed.refreshToken || '').trim(),
      expiresAt: Number(parsed.expiresAt || 0),
      refreshExpiresAt: Number(parsed.refreshExpiresAt || 0),
      scope: String(parsed.scope || '').trim(),
      tokenType: String(parsed.tokenType || 'Bearer').trim() || 'Bearer',
      domain: String(parsed.domain || 'feishu').trim().toLowerCase() === 'lark' ? 'lark' : 'feishu',
      updatedAt: Number(parsed.updatedAt || 0),
    };
  } catch {
    return null;
  }
}

export function saveUserAuth(auth) {
  const normalized = {
    accessToken: String(auth?.accessToken || '').trim(),
    refreshToken: String(auth?.refreshToken || '').trim(),
    expiresAt: Number(auth?.expiresAt || 0),
    refreshExpiresAt: Number(auth?.refreshExpiresAt || 0),
    scope: String(auth?.scope || '').trim(),
    tokenType: String(auth?.tokenType || 'Bearer').trim() || 'Bearer',
    domain: String(auth?.domain || 'feishu').trim().toLowerCase() === 'lark' ? 'lark' : 'feishu',
    updatedAt: Number(auth?.updatedAt || Date.now()),
  };
  writePrivateJsonAtomic(getUserAuthPath(), normalized);
  return normalized;
}

export function clearUserAuth() {
  const authPath = getUserAuthPath();
  try {
    fs.rmSync(authPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function getLogPaths() {
  const dir = getConfigDir();
  return {
    outLog: path.join(dir, 'daemon.log'),
    errLog: path.join(dir, 'daemon.err.log'),
    pidFile: path.join(dir, 'daemon.pid'),
  };
}

export function getApprovalsDir() {
  return path.join(getConfigDir(), 'approvals');
}

export function getHandoffsDir() {
  return path.join(getConfigDir(), 'handoffs');
}

export function resolveRiskyApprovalEnabled(config) {
  return String(config?.security?.riskyCommandApproval || 'on').trim().toLowerCase() !== 'off';
}

export const VALID_NOTIFY_MODES = ['on', 'away', 'off'];

export function resolveStopNotifyMode(config) {
  const notifications = config?.notifications || {};
  if (notifications.stopHookEnabled === false) {
    return 'off';
  }
  const mode = String(notifications.stopNotifyMode || '').trim().toLowerCase();
  if (VALID_NOTIFY_MODES.includes(mode)) {
    return mode;
  }
  return 'on';
}

export const DEFAULT_CONFIG = {
  feishu: {
    appId: '',
    appSecret: '',
    domain: 'feishu',
    proxy: '',
  },
  security: {
    allowedOpenIds: [],
    autoBindFirstUser: false,
    groupPolicy: 'mention',
    riskyCommandApproval: 'on',
    approvalTimeoutSeconds: 120,
    allowExternalMcpTargets: false,
  },
  agy: {
    bin: '',
    defaultCwd: os.homedir(),
    defaultMode: 'accept-edits',
    defaultModel: '',
    defaultEffort: '',
    favoriteDirs: [],
    proxy: '',
    timeoutSeconds: 3600,
    maxConcurrentRuns: 4,
  },
  notifications: {
    defaultReceiveId: '',
    defaultReceiveIdType: 'open_id',
    defaultTopicChatId: '',
    stopHookEnabled: true,
    stopNotifyMode: 'on',
    awayIdleSeconds: 120,
  },
};

function mergeConfig(base, override) {
  const out = structuredClone(base);
  if (!override || typeof override !== 'object') {
    return out;
  }
  for (const section of ['feishu', 'security', 'agy', 'notifications']) {
    if (override[section] && typeof override[section] === 'object') {
      out[section] = { ...out[section], ...override[section] };
    }
  }
  if (!Array.isArray(out.security.allowedOpenIds)) {
    out.security.allowedOpenIds = [];
  }
  if (!Array.isArray(out.agy.favoriteDirs)) {
    out.agy.favoriteDirs = [];
  }
  return out;
}

export function ensureConfigDir() {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Ignore on filesystems that don't support chmod
  }
  return dir;
}

export function loadConfig() {
  const cfgPath = getConfigPath();
  if (!fs.existsSync(cfgPath)) {
    return mergeConfig(DEFAULT_CONFIG, null);
  }
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
  } catch {
    return mergeConfig(DEFAULT_CONFIG, null);
  }
}

export function saveConfig(cfg) {
  const merged = mergeConfig(DEFAULT_CONFIG, cfg);
  writePrivateJsonAtomic(getConfigPath(), merged);
  return merged;
}

/**
 * Reload latest config under an advisory file lock, apply `mutator(config)`, and atomically save back.
 */
export function updateConfig(mutator) {
  return withFileLock(path.join(getConfigDir(), '.config.lock'), () => {
    const latest = loadConfig();
    if (typeof mutator === 'function') {
      mutator(latest);
    }
    return saveConfig(latest);
  });
}

/**
 * Resolve an owner `open_id` without misinterpreting group `chat_id` (`oc_...`) defaults as an `open_id`.
 */
export function resolveOwnerOpenId(config, explicitOpenId = '') {
  const explicit = String(explicitOpenId || '').trim();
  if (explicit) return explicit;
  const defId = String(config?.notifications?.defaultReceiveId || '').trim();
  const defType = String(config?.notifications?.defaultReceiveIdType || '').trim().toLowerCase();
  if (defId && (defId.startsWith('ou_') || (defType === 'open_id' && !defId.startsWith('oc_')))) {
    return defId;
  }
  const allowed = Array.isArray(config?.security?.allowedOpenIds) ? config.security.allowedOpenIds : [];
  const ouMatch = allowed.find((id) => String(id || '').trim().startsWith('ou_'));
  return String(ouMatch || allowed[0] || '').trim();
}

export function loadState() {
  const statePath = getStatePath();
  if (!fs.existsSync(statePath)) {
    return { chats: {}, lastP2pChatByOpenId: {}, lastTopicChatId: '', panelActionUsage: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return { chats: {}, lastP2pChatByOpenId: {}, lastTopicChatId: '', panelActionUsage: {} };
    }
    return {
      chats: parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {},
      lastP2pChatByOpenId:
        parsed.lastP2pChatByOpenId && typeof parsed.lastP2pChatByOpenId === 'object'
          ? parsed.lastP2pChatByOpenId
          : {},
      lastTopicChatId: String(parsed.lastTopicChatId || '').trim(),
      panelActionUsage:
        parsed.panelActionUsage && typeof parsed.panelActionUsage === 'object' && !Array.isArray(parsed.panelActionUsage)
          ? parsed.panelActionUsage
          : {},
    };
  } catch {
    return { chats: {}, lastP2pChatByOpenId: {}, lastTopicChatId: '', panelActionUsage: {} };
  }
}

export function saveState(state) {
  const normalized = state && typeof state === 'object'
    ? {
        chats: state.chats && typeof state.chats === 'object' ? state.chats : {},
        lastP2pChatByOpenId:
          state.lastP2pChatByOpenId && typeof state.lastP2pChatByOpenId === 'object'
            ? state.lastP2pChatByOpenId
            : {},
        lastTopicChatId: String(state.lastTopicChatId || '').trim(),
        panelActionUsage:
          state.panelActionUsage && typeof state.panelActionUsage === 'object' && !Array.isArray(state.panelActionUsage)
            ? state.panelActionUsage
            : {},
      }
    : { chats: {}, lastP2pChatByOpenId: {}, lastTopicChatId: '', panelActionUsage: {} };
  writePrivateJsonAtomic(getStatePath(), normalized);
  return normalized;
}

/**
 * Reload latest state from disk under an advisory file lock, apply `mutator(state)`, and atomically save back.
 */
export function updateState(mutator) {
  return withFileLock(path.join(getConfigDir(), '.state.lock'), () => {
    const latest = loadState();
    if (typeof mutator === 'function') {
      mutator(latest);
    }
    return saveState(latest);
  });
}

export function detectAgyBin() {
  const isWin = process.platform === 'win32';
  const lookupCmd = isWin ? 'where' : 'which';
  try {
    const out = execFileSync(lookupCmd, ['agy'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    if (out) {
      const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const preferred = isWin
        ? (lines.find((l) => /\.(exe|cmd|bat)$/i.test(l) && fs.existsSync(l)) || lines.find((l) => fs.existsSync(l)))
        : lines.find((l) => fs.existsSync(l));
      if (preferred) {
        return preferred;
      }
    }
  } catch {
    // Fallback to common install paths
  }
  const candidates = isWin
    ? [
        path.join(os.homedir(), '.local', 'bin', 'agy.exe'),
        path.join(os.homedir(), '.gemini', 'bin', 'agy.exe'),
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'agy.exe') : '',
        process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'agy.cmd') : '',
      ].filter(Boolean)
    : [
        path.join(os.homedir(), '.local', 'bin', 'agy'),
        '/opt/homebrew/bin/agy',
        '/usr/local/bin/agy',
        '/usr/bin/agy',
      ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return '';
}

function normalizeWindowsProxyValue(rawServer) {
  const raw = String(rawServer || '').trim();
  if (!raw) return '';
  let picked = raw;
  if (raw.includes('=')) {
    const entries = raw.split(';').map((s) => s.trim()).filter(Boolean);
    const httpsEntry = entries.find((e) => /^https=/i.test(e));
    const httpEntry = entries.find((e) => /^http=/i.test(e));
    const chosen = httpsEntry || httpEntry || entries[0] || '';
    picked = chosen.includes('=') ? chosen.slice(chosen.indexOf('=') + 1).trim() : chosen;
  }
  if (!picked) return '';
  return /^https?:\/\//i.test(picked) ? picked : `http://${picked}`;
}

export function detectLocalProxy() {
  const envProxy =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    '';
  if (envProxy) {
    return envProxy.trim();
  }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(out);
      const httpsHost = out.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
      const httpsPort = out.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
      if (httpsEnabled && httpsHost && httpsPort) {
        return `http://${httpsHost}:${httpsPort}`;
      }
      const httpEnabled = /HTTPEnable\s*:\s*1/.test(out);
      const httpHost = out.match(/HTTPProxy\s*:\s*(\S+)/)?.[1];
      const httpPort = out.match(/HTTPPort\s*:\s*(\d+)/)?.[1];
      if (httpEnabled && httpHost && httpPort) {
        return `http://${httpHost}:${httpPort}`;
      }
    } catch {
      // Ignore scutil errors
    }
  } else if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      );
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out);
      const serverMatch = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
      if (enabled && serverMatch) {
        return normalizeWindowsProxyValue(serverMatch[1]);
      }
    } catch {
      // Ignore registry proxy lookup errors
    }
  }
  return '';
}

export function maskSecret(secret) {
  if (!secret) return '';
  const str = String(secret);
  if (str.length <= 6) {
    return '*'.repeat(str.length);
  }
  return `${str.slice(0, 3)}***${str.slice(-3)}`;
}

const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
];

export function stripProcessProxyEnv(feishuProxy = '') {
  const captured = {};
  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key]) {
      captured[key] = process.env[key];
    }
    delete process.env[key];
  }
  if (feishuProxy) {
    process.env.http_proxy = feishuProxy;
    process.env.https_proxy = feishuProxy;
    process.env.HTTP_PROXY = feishuProxy;
    process.env.HTTPS_PROXY = feishuProxy;
  }
  return captured;
}
