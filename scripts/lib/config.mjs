import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

export function getLogPaths() {
  const dir = getConfigDir();
  return {
    outLog: path.join(dir, 'daemon.log'),
    errLog: path.join(dir, 'daemon.err.log'),
    pidFile: path.join(dir, 'daemon.pid'),
  };
}

export const DEFAULT_QUICK_PROMPTS = [
  {
    label: '📋 总结当前项目',
    prompt: '请快速概览当前工作目录的项目结构、技术栈和近期重点文件，给出简洁清晰的中文总结。',
  },
  {
    label: '🔍 Git 状态与变更',
    prompt: '请检查当前目录的 git status、当前分支以及最近 5 条提交记录，如果有未提交修改请简要概括。',
  },
  {
    label: '🧪 运行检查/测试',
    prompt: '请识别当前项目的构建或测试命令，执行一次基础检查并汇报结果（如有失败请指出原因）。',
  },
  {
    label: '🧹 代码审查建议',
    prompt: '请检查当前目录中未提交的改动（或最近一次提交），从正确性、边界条件和可维护性角度给出简短审查建议。',
  },
];

export const DEFAULT_CONFIG = {
  feishu: {
    appId: '',
    appSecret: '',
    domain: 'feishu',
    proxy: '',
  },
  security: {
    allowedOpenIds: [],
    autoBindFirstUser: true,
    groupPolicy: 'mention',
  },
  agy: {
    bin: '',
    defaultCwd: os.homedir(),
    defaultMode: 'accept-edits',
    defaultModel: '',
    defaultEffort: '',
    favoriteDirs: [],
    quickPrompts: [],
    proxy: '',
    timeoutSeconds: 3600,
    maxConcurrentRuns: 4,
  },
  notifications: {
    defaultReceiveId: '',
    defaultReceiveIdType: 'open_id',
    stopHookEnabled: true,
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
  if (!Array.isArray(out.agy.quickPrompts)) {
    out.agy.quickPrompts = [];
  } else {
    out.agy.quickPrompts = out.agy.quickPrompts
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        label: String(item.label || '').trim(),
        prompt: String(item.prompt || '').trim(),
      }))
      .filter((item) => item.label && item.prompt);
  }
  return out;
}

export function getEffectiveQuickPrompts(config) {
  const custom = Array.isArray(config?.agy?.quickPrompts) ? config.agy.quickPrompts : [];
  const valid = custom
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      label: String(item.label || '').trim(),
      prompt: String(item.prompt || '').trim(),
    }))
    .filter((item) => item.label && item.prompt);
  if (valid.length > 0) {
    return valid;
  }
  return DEFAULT_QUICK_PROMPTS.map((item) => ({ ...item }));
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

function writePrivateJsonAtomic(targetPath, data) {
  ensureConfigDir();
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  const content = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // Ignore
  }
  fs.renameSync(tmpPath, targetPath);
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

export function loadState() {
  const statePath = getStatePath();
  if (!fs.existsSync(statePath)) {
    return { chats: {}, lastP2pChatByOpenId: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return { chats: {}, lastP2pChatByOpenId: {} };
    }
    return {
      chats: parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {},
      lastP2pChatByOpenId:
        parsed.lastP2pChatByOpenId && typeof parsed.lastP2pChatByOpenId === 'object'
          ? parsed.lastP2pChatByOpenId
          : {},
    };
  } catch {
    return { chats: {}, lastP2pChatByOpenId: {} };
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
      }
    : { chats: {}, lastP2pChatByOpenId: {} };
  writePrivateJsonAtomic(getStatePath(), normalized);
  return normalized;
}

export function detectAgyBin() {
  try {
    const found = execFileSync('which', ['agy'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (found && fs.existsSync(found)) {
      return found;
    }
  } catch {
    // Fallback to common install paths
  }
  const candidates = [
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
