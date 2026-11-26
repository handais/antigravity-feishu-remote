import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
  ensureConfigDir,
  getConfigDir,
  getLogPaths,
  getPluginRoot,
  loadConfig,
} from './config.mjs';

export const LAUNCHD_LABEL = 'com.antigravity.feishu-remote';
export const SYSTEMD_SERVICE_NAME = 'antigravity-feishu-remote.service';

export function getLaunchdPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function getSystemdUnitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_SERVICE_NAME);
}

/**
 * Resolve a stable symlinked Node binary path on macOS so Homebrew Cellar upgrades don't break launchd plists.
 */
export function resolveStableNodeBin(execPath = process.execPath, platform = process.platform) {
  const raw = String(execPath || process.execPath).trim();
  if (platform === 'darwin' && /\/Cellar\/node\//i.test(raw)) {
    for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
      try {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // Try next candidate
      }
    }
  }
  return raw;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildLaunchdPlist({ nodeBin, daemonScript, outLog, errLog, pathEnv }) {
  const envEntries = {
    HOME: os.homedir(),
    PATH: pathEnv,
  };
  if (process.env.FEISHU_REMOTE_CONFIG_DIR) {
    envEntries.FEISHU_REMOTE_CONFIG_DIR = getConfigDir();
  }
  const envXml = Object.entries(envEntries)
    .map(([k, v]) => `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBin)}</string>
    <string>${escapeXml(daemonScript)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errLog)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
}

function buildPathEnv() {
  if (process.platform === 'win32') {
    const parts = [
      path.dirname(process.execPath),
      path.join(os.homedir(), '.local', 'bin'),
      ...(process.env.PATH || '').split(path.delimiter),
    ].filter(Boolean);
    return [...new Set(parts)].join(path.delimiter);
  }
  const parts = [
    path.dirname(process.execPath),
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return [...new Set(parts)].join(':');
}

function getGuiDomain() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  return `gui/${uid}`;
}

function hasSystemdUser() {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('systemctl', ['--user', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function startDaemon() {
  const config = loadConfig();
  if (!config.feishu.appId || !config.feishu.appSecret) {
    throw new Error('Feishu appId and appSecret are not configured. Run `setup` first.');
  }
  ensureConfigDir();
  const { outLog, errLog, pidFile } = getLogPaths();
  const daemonScript = path.join(getPluginRoot(), 'scripts', 'bridge-daemon.mjs');
  const nodeBin = resolveStableNodeBin(process.execPath, process.platform);
  const pathEnv = buildPathEnv();

  if (process.platform === 'darwin') {
    const plistPath = getLaunchdPlistPath();
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(
      plistPath,
      buildLaunchdPlist({
        nodeBin,
        daemonScript,
        outLog,
        errLog,
        pathEnv,
      }),
      'utf8',
    );
    const domain = getGuiDomain();
    try {
      execFileSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
    } catch {
      // Ignore if not currently loaded
    }
    execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'pipe' });
    return { manager: 'launchd', plistPath, outLog, errLog };
  }

  if (hasSystemdUser()) {
    const unitPath = getSystemdUnitPath();
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    const envLines = [`Environment=PATH=${pathEnv}`];
    if (process.env.FEISHU_REMOTE_CONFIG_DIR) {
      envLines.push(`Environment=FEISHU_REMOTE_CONFIG_DIR=${getConfigDir()}`);
    }
    const unit = `[Unit]
Description=Antigravity Feishu Remote Control Bridge
After=network-online.target

[Service]
Type=simple
ExecStart="${nodeBin}" "${daemonScript}"
Restart=always
RestartSec=3
StandardOutput=append:${outLog}
StandardError=append:${errLog}
${envLines.join('\n')}

[Install]
WantedBy=default.target
`;
    fs.writeFileSync(unitPath, unit, 'utf8');
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
    execFileSync('systemctl', ['--user', 'enable', '--now', SYSTEMD_SERVICE_NAME], { stdio: 'pipe' });
    return { manager: 'systemd', unitPath, outLog, errLog };
  }

  // Generic detached background process fallback
  const existing = getDaemonStatus();
  if (existing.running && existing.pid) {
    return { manager: 'pid', pid: existing.pid, outLog, errLog };
  }
  const outFd = fs.openSync(outLog, 'a');
  const errFd = fs.openSync(errLog, 'a');
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', outFd, errFd],
    env: { ...process.env, PATH: pathEnv },
  });
  child.unref();
  try {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  } catch {
    // Ignore close errors
  }
  fs.writeFileSync(pidFile, `${child.pid}\n`, 'utf8');
  return { manager: 'pid', pid: child.pid, outLog, errLog };
}

export function stopDaemon() {
  const { pidFile } = getLogPaths();

  if (process.platform === 'darwin') {
    const plistPath = getLaunchdPlistPath();
    const domain = getGuiDomain();
    try {
      execFileSync('launchctl', ['bootout', domain, plistPath], { stdio: 'pipe' });
    } catch {
      // Ignore if not loaded
    }
    return { manager: 'launchd', stopped: true };
  }

  if (hasSystemdUser()) {
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_SERVICE_NAME], { stdio: 'pipe' });
    } catch {
      // Ignore
    }
    return { manager: 'systemd', stopped: true };
  }

  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Ignore if already dead
      }
    }
    fs.rmSync(pidFile, { force: true });
  }
  return { manager: 'pid', stopped: true };
}

export function restartDaemon() {
  stopDaemon();
  return startDaemon();
}

export function getDaemonStatus() {
  const { outLog, errLog, pidFile } = getLogPaths();

  if (process.platform === 'darwin') {
    const plistPath = getLaunchdPlistPath();
    const installed = fs.existsSync(plistPath);
    const domain = getGuiDomain();
    try {
      const output = execFileSync('launchctl', ['print', `${domain}/${LAUNCHD_LABEL}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const state = output.match(/state\s*=\s*(\S+)/)?.[1] || 'unknown';
      const pidMatch = output.match(/\bpid\s*=\s*(\d+)/)?.[1];
      const pid = pidMatch ? Number(pidMatch) : null;
      return {
        manager: 'launchd',
        installed,
        running: state === 'running' || (pid !== null && pid > 0),
        state,
        pid,
        plistPath,
        outLog,
        errLog,
      };
    } catch {
      return {
        manager: 'launchd',
        installed,
        running: false,
        state: 'not running',
        pid: null,
        plistPath,
        outLog,
        errLog,
      };
    }
  }

  if (hasSystemdUser()) {
    const unitPath = getSystemdUnitPath();
    const installed = fs.existsSync(unitPath);
    try {
      const state = execFileSync('systemctl', ['--user', 'is-active', SYSTEMD_SERVICE_NAME], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const pidOut = execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', SYSTEMD_SERVICE_NAME], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const pid = Number(pidOut) > 0 ? Number(pidOut) : null;
      return {
        manager: 'systemd',
        installed,
        running: state === 'active',
        state,
        pid,
        unitPath,
        outLog,
        errLog,
      };
    } catch {
      return {
        manager: 'systemd',
        installed,
        running: false,
        state: 'inactive',
        pid: null,
        unitPath,
        outLog,
        errLog,
      };
    }
  }

  let pid = null;
  let running = false;
  if (fs.existsSync(pidFile)) {
    const parsed = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (Number.isInteger(parsed) && parsed > 0) {
      try {
        process.kill(parsed, 0);
        pid = parsed;
        running = true;
      } catch {
        // Not alive
      }
    }
  }
  return {
    manager: 'pid',
    installed: running,
    running,
    state: running ? 'running' : 'not running',
    pid,
    outLog,
    errLog,
  };
}

export function readDaemonLogs(lines = 50) {
  const { outLog, errLog } = getLogPaths();
  const readTail = (filePath) => {
    if (!fs.existsSync(filePath)) return '';
    const allLines = fs.readFileSync(filePath, 'utf8').split('\n');
    return allLines.slice(-Math.max(1, lines)).join('\n').trim();
  };
  return {
    outLog,
    errLog,
    out: readTail(outLog),
    err: readTail(errLog),
  };
}
