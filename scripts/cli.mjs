import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  clearUserAuth,
  detectAgyBin,
  detectLocalProxy,
  getConfigDir,
  getConfigPath,
  getPluginRoot,
  loadConfig,
  loadState,
  maskSecret,
  resolveOwnerOpenId,
  stripProcessProxyEnv,
  updateConfig,
  VALID_NOTIFY_MODES,
} from './lib/config.mjs';
import {
  buildCard,
  buildControlPanelCard,
  buildDirsCard,
  createFeishuClient,
  sendCard,
  sendLocalMedia,
} from './lib/feishu-api.mjs';
import { queryAppScopes, readFeishuDoc, writeFeishuDoc } from './lib/feishu-docs.mjs';
import {
  buildOAuthAuthorizeUrl,
  createFeishuTask,
  exchangeOAuthCode,
  getUserAuthStatus,
  listFeishuTasks,
  runInteractiveOAuthFlow,
  setFeishuTaskCompleted,
} from './lib/feishu-tasks.mjs';
import { VALID_EFFORTS, VALID_MODES } from './lib/agy-runner.mjs';
import { listDesktopSessions } from './lib/desktop-sessions.mjs';
import {
  copyToSystemClipboard,
  listMobileSessions,
  readMobileSession,
  writeHandoffSnapshot,
} from './lib/mobile-handoff.mjs';
import {
  getDaemonStatus,
  readDaemonLogs,
  restartDaemon,
  startDaemon,
  stopDaemon,
} from './lib/daemon-ctl.mjs';
import {
  computePluginCodeHash,
  createBackupSnapshot,
  listBackupSnapshots,
  restoreBackupSnapshot,
  runPreflightCheck,
} from './lib/self-ops.mjs';
import { expandHomePath } from './lib/io-utils.mjs';

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const eqIdx = token.indexOf('=');
    let key;
    let val;
    if (eqIdx !== -1) {
      key = token.slice(2, eqIdx);
      val = token.slice(eqIdx + 1);
    } else {
      key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        val = next;
        i += 1;
      } else {
        val = true;
      }
    }
    if (flags[key] === undefined) {
      flags[key] = val;
    } else if (Array.isArray(flags[key])) {
      flags[key].push(val);
    } else {
      flags[key] = [flags[key], val];
    }
  }
  return { positionals, flags };
}

function parseBool(val, fallback) {
  if (val === undefined) return fallback;
  if (val === true || val === 'true' || val === '1') return true;
  if (val === false || val === 'false' || val === '0') return false;
  return fallback;
}

function cmdSetup(flags) {
  let stdinSecret = '';
  if (flags['app-secret-stdin']) {
    if (process.stdin.isTTY) {
      throw new Error(
        '--app-secret-stdin requires piped stdin (e.g. printf "%s" "$APP_SECRET" | node scripts/cli.mjs setup --app-secret-stdin)',
      );
    }
    stdinSecret = fs.readFileSync(0, 'utf8').trim();
  }

  const saved = updateConfig((config) => {
    if (typeof flags['app-id'] === 'string') config.feishu.appId = flags['app-id'].trim();
    if (flags['app-secret-stdin']) {
      if (stdinSecret) {
        config.feishu.appSecret = stdinSecret;
      }
    } else if (typeof flags['app-secret'] === 'string') {
      config.feishu.appSecret = flags['app-secret'].trim();
    } else if (!config.feishu.appSecret && process.env.FEISHU_APP_SECRET) {
      config.feishu.appSecret = String(process.env.FEISHU_APP_SECRET).trim();
    }
    if (typeof flags.domain === 'string') {
      const d = flags.domain.trim().toLowerCase();
      if (d !== 'feishu' && d !== 'lark') {
        throw new Error('--domain must be feishu or lark');
      }
      config.feishu.domain = d;
    }
    if (typeof flags['feishu-proxy'] === 'string') {
      config.feishu.proxy = flags['feishu-proxy'].trim();
    }

    if (typeof flags.cwd === 'string') {
      const resolvedCwd = flags.cwd === '~'
        ? os.homedir()
        : flags.cwd.startsWith('~/')
          ? path.join(os.homedir(), flags.cwd.slice(2))
          : path.resolve(flags.cwd);
      if (!fs.existsSync(resolvedCwd) || !fs.statSync(resolvedCwd).isDirectory()) {
        throw new Error(`--cwd is not an existing directory: ${resolvedCwd}`);
      }
      config.agy.defaultCwd = resolvedCwd;
    }

    if (typeof flags.mode === 'string') {
      if (!VALID_MODES.includes(flags.mode)) {
        throw new Error(`--mode must be one of: ${VALID_MODES.join(', ')}`);
      }
      config.agy.defaultMode = flags.mode;
    }

    if (typeof flags.model === 'string') {
      config.agy.defaultModel = flags.model === 'default' ? '' : flags.model.trim();
    }

    if (typeof flags.effort === 'string') {
      const e = flags.effort.trim().toLowerCase();
      if (e === 'default' || e === 'auto' || e === 'reset' || e === '') {
        config.agy.defaultEffort = '';
      } else if (!VALID_EFFORTS.includes(e)) {
        throw new Error(`--effort must be one of: default, ${VALID_EFFORTS.join(', ')}`);
      } else {
        config.agy.defaultEffort = e;
      }
    }

    if (typeof flags['agy-bin'] === 'string') {
      config.agy.bin = flags['agy-bin'].trim();
    } else if (!config.agy.bin) {
      config.agy.bin = detectAgyBin();
    }

    if (flags['no-proxy']) {
      config.agy.proxy = '';
    } else if (typeof flags.proxy === 'string') {
      config.agy.proxy = flags.proxy.trim();
    } else if (!config.agy.proxy) {
      config.agy.proxy = detectLocalProxy();
    }

    if (typeof flags.timeout === 'string') {
      const t = Number(flags.timeout);
      if (!Number.isFinite(t) || t < 0) {
        throw new Error('--timeout must be a non-negative number of seconds');
      }
      config.agy.timeoutSeconds = Math.floor(t);
    }

    if (typeof flags['max-concurrent'] === 'string') {
      const mc = Number(flags['max-concurrent']);
      if (!Number.isFinite(mc) || mc < 1 || mc > 10) {
        throw new Error('--max-concurrent must be between 1 and 10');
      }
      config.agy.maxConcurrentRuns = Math.floor(mc);
    }

    if (flags['allow-open-id'] !== undefined) {
      const rawList = Array.isArray(flags['allow-open-id'])
        ? flags['allow-open-id']
        : [flags['allow-open-id']];
      const cleanIds = [...new Set(rawList.map((s) => String(s).trim()).filter(Boolean))];
      config.security.allowedOpenIds = cleanIds;
      if (cleanIds.length > 0 && flags['auto-bind'] === undefined) {
        config.security.autoBindFirstUser = false;
      }
      if (!config.notifications.defaultReceiveId && cleanIds[0]) {
        config.notifications.defaultReceiveId = cleanIds[0];
        config.notifications.defaultReceiveIdType = 'open_id';
      }
    }

    if (flags['auto-bind'] !== undefined) {
      config.security.autoBindFirstUser = parseBool(flags['auto-bind'], config.security.autoBindFirstUser);
    }

    if (typeof flags['group-policy'] === 'string') {
      if (!['mention', 'off', 'all'].includes(flags['group-policy'])) {
        throw new Error('--group-policy must be mention, off, or all');
      }
      config.security.groupPolicy = flags['group-policy'];
    }

    if (typeof flags['receive-id'] === 'string') {
      config.notifications.defaultReceiveId = flags['receive-id'].trim();
    }
    if (typeof flags['receive-id-type'] === 'string') {
      config.notifications.defaultReceiveIdType = flags['receive-id-type'].trim();
    }
    if (flags['stop-hook'] !== undefined) {
      const enabled = parseBool(flags['stop-hook'], config.notifications.stopHookEnabled);
      config.notifications.stopHookEnabled = enabled;
      if (!enabled) {
        config.notifications.stopNotifyMode = 'off';
      } else if (config.notifications.stopNotifyMode === 'off') {
        config.notifications.stopNotifyMode = 'on';
      }
    }
    if (typeof flags['notify-mode'] === 'string') {
      const m = flags['notify-mode'].trim().toLowerCase();
      if (!VALID_NOTIFY_MODES.includes(m)) {
        throw new Error(`--notify-mode must be one of: ${VALID_NOTIFY_MODES.join(', ')}`);
      }
      config.notifications.stopNotifyMode = m;
      config.notifications.stopHookEnabled = m !== 'off';
    }
    if (typeof flags['away-seconds'] === 'string') {
      const sec = Number(flags['away-seconds']);
      if (!Number.isFinite(sec) || sec < 10 || sec > 3600) {
        throw new Error('--away-seconds must be between 10 and 3600');
      }
      config.notifications.awayIdleSeconds = Math.floor(sec);
    }
    if (typeof flags['risky-approval'] === 'string') {
      const val = flags['risky-approval'].trim().toLowerCase();
      if (val !== 'on' && val !== 'off') {
        throw new Error('--risky-approval must be on or off');
      }
      config.security.riskyCommandApproval = val;
    }
    if (typeof flags['approval-timeout'] === 'string') {
      const sec = Number(flags['approval-timeout']);
      if (!Number.isFinite(sec) || sec < 15 || sec > 160) {
        throw new Error('--approval-timeout must be between 15 and 160');
      }
      config.security.approvalTimeoutSeconds = Math.floor(sec);
    }
  });
  console.log(JSON.stringify({
    ok: true,
    configPath: getConfigPath(),
    feishu: {
      appId: saved.feishu.appId,
      appSecret: maskSecret(saved.feishu.appSecret),
      domain: saved.feishu.domain,
      proxy: saved.feishu.proxy || '',
    },
    security: saved.security,
    agy: saved.agy,
    notifications: saved.notifications,
  }, null, 2));
}

function cmdStatus() {
  const config = loadConfig();
  const state = loadState();
  const daemon = getDaemonStatus();
  console.log(JSON.stringify({
    configPath: getConfigPath(),
    configured: Boolean(config.feishu.appId && config.feishu.appSecret),
    feishu: {
      appId: config.feishu.appId,
      appSecret: maskSecret(config.feishu.appSecret),
      domain: config.feishu.domain,
      proxy: config.feishu.proxy || '',
    },
    security: config.security,
    agy: config.agy,
    notifications: config.notifications,
    daemon,
    chatsCount: Object.keys(state.chats || {}).length,
  }, null, 2));
}

function cmdLogs(flags) {
  const lines = flags.lines ? Number(flags.lines) : 50;
  const logs = readDaemonLogs(Number.isFinite(lines) ? lines : 50);
  console.log(`=== stdout (${logs.outLog}) ===`);
  console.log(logs.out || '(empty)');
  console.log(`\n=== stderr (${logs.errLog}) ===`);
  console.log(logs.err || '(empty)');
}

async function cmdTestSend(flags) {
  const config = loadConfig();
  stripProcessProxyEnv(config.feishu.proxy);
  const receiveId =
    (typeof flags['receive-id'] === 'string' && flags['receive-id'].trim()) ||
    config.notifications.defaultReceiveId ||
    config.security.allowedOpenIds?.[0] ||
    '';
  const receiveIdType =
    (typeof flags['receive-id-type'] === 'string' && flags['receive-id-type'].trim()) ||
    config.notifications.defaultReceiveIdType ||
    'open_id';

  if (!receiveId) {
    throw new Error('No receive_id found. Bind a user first by messaging the bot, or pass --receive-id.');
  }

  const client = createFeishuClient(config, { quiet: true });
  const cardType = flags.panel ? 'panel' : flags.dirs ? 'dirs' : 'test';
  let card;
  if (cardType !== 'test') {
    const state = loadState();
    const mappedChatId = state.lastP2pChatByOpenId?.[receiveId] || Object.keys(state.chats || {})[0] || '';
    const chatState = mappedChatId && state.chats?.[mappedChatId]
      ? state.chats[mappedChatId]
      : {
          cwd: config.agy.defaultCwd,
          mode: config.agy.defaultMode,
          model: config.agy.defaultModel,
          conversationId: '',
        };
    if (cardType === 'dirs') {
      card = buildDirsCard({ chatState, config });
    } else {
      card = buildControlPanelCard({
        chatState,
        config,
        isRunning: false,
        panelActionUsage: state.panelActionUsage,
      });
    }
  } else {
    card = buildCard({
      title: '✅ 飞书远程控制测试通知',
      template: 'green',
      markdown: [
        '这是一条来自本机 Antigravity `feishu-remote` 插件的测试卡片。',
        `- **默认工作区**：\`${config.agy.defaultCwd}\``,
        `- **执行模式**：\`${config.agy.defaultMode}\``,
      ].join('\n'),
    });
  }
  const messageId = await sendCard(client, {
    receiveId,
    receiveIdType,
    card,
  });
  console.log(JSON.stringify({ ok: true, messageId, receiveId, receiveIdType, cardType, panel: Boolean(flags.panel) }, null, 2));
}

function cmdPack(flags) {
  const pluginRoot = getPluginRoot();
  const outRaw = typeof flags.out === 'string'
    ? flags.out
    : path.join(os.homedir(), 'Desktop', 'feishu-remote-plugin.zip');
  const outPath = expandHomePath(outRaw);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.rmSync(outPath, { force: true });

  const parentDir = path.dirname(pluginRoot);
  const folderName = path.basename(pluginRoot);

  const skipDirNames = new Set(['node_modules', '.git', '.github', 'tests']);
  const marketingAssetFiles = new Set(['keynote-demo.gif', 'hero-banner.svg', 'architecture-flow.svg']);
  const sensitiveLocalFiles = new Set(['config.json', 'state.json', 'user-auth.json']);
  const isExcludedPackFile = (name, relPath) => (
    name === '.DS_Store' ||
    name === '.env' ||
    name.startsWith('.env.') ||
    sensitiveLocalFiles.has(name) ||
    /\.tmp\./i.test(name) ||
    /\.(?:zip|log|pem|key|db|sqlite|sqlite3)$/i.test(name) ||
    (relPath.startsWith('assets/') && marketingAssetFiles.has(name))
  );

  if (process.platform === 'win32') {
    const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-remote-pack-'));
    const stageDir = path.join(stageRoot, folderName);
    try {
      fs.cpSync(pluginRoot, stageDir, {
        recursive: true,
        filter: (src) => {
          if (src === pluginRoot) return true;
          const base = path.basename(src);
          const relPosix = path.relative(pluginRoot, src).replace(/\\/g, '/');
          if (skipDirNames.has(base) || isExcludedPackFile(base, relPosix)) {
            return false;
          }
          return true;
        },
      });
      const psCmd = `Compress-Archive -Path '${stageDir.replace(/'/g, "''")}' -DestinationPath '${outPath.replace(/'/g, "''")}' -Force`;
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
        windowsHide: true,
        stdio: 'pipe',
      });
    } finally {
      fs.rmSync(stageRoot, { recursive: true, force: true });
    }
  } else {
    execFileSync(
      'zip',
      [
        '-r',
        outPath,
        folderName,
        '-x',
        `${folderName}/node_modules/*`,
        `${folderName}/node_modules/**`,
        `${folderName}/.git/*`,
        `${folderName}/.git/**`,
        `${folderName}/.github/*`,
        `${folderName}/.github/**`,
        `${folderName}/tests/*`,
        `${folderName}/tests/**`,
        `${folderName}/assets/keynote-demo.gif`,
        `${folderName}/assets/hero-banner.svg`,
        `${folderName}/assets/architecture-flow.svg`,
        `${folderName}/*.zip`,
        '**/*.zip',
        '**/.env',
        '**/.env.*',
        '**/*.tmp.*',
        '**/config.json',
        '**/state.json',
        '**/user-auth.json',
        '**/*.db',
        '**/*.sqlite',
        '**/*.sqlite3',
        '**/*.log',
        '**/*.pem',
        '**/*.key',
        '*/.DS_Store',
        '**/.DS_Store',
      ],
      { cwd: parentDir, stdio: 'pipe' },
    );
  }

  const sizeBytes = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  console.log(JSON.stringify({
    ok: true,
    archive: outPath,
    sizeBytes,
    configDirExcluded: getConfigDir(),
  }, null, 2));
}

function cmdCheck() {
  const check = runPreflightCheck();
  console.log(JSON.stringify(check, null, 2));
  if (!check.ok) {
    process.exit(1);
  }
}

function cmdSafeRestart() {
  const check = runPreflightCheck();
  if (!check.ok) {
    console.log(JSON.stringify({ ok: false, abortedRestart: true, check }, null, 2));
    process.exit(1);
  }
  const snap = createBackupSnapshot({ reason: 'pre-restart', force: false });
  const result = restartDaemon();
  console.log(JSON.stringify({ ok: true, check, snapshot: snap.snapshot, ...result, status: getDaemonStatus() }, null, 2));
}

function cmdSnapshot() {
  const check = runPreflightCheck();
  if (!check.ok) {
    console.log(JSON.stringify({ ok: false, check }, null, 2));
    process.exit(1);
  }
  const res = createBackupSnapshot({ reason: 'cli', force: true });
  console.log(JSON.stringify({ ok: true, check, ...res }, null, 2));
}

function cmdBackups() {
  console.log(JSON.stringify({
    ok: true,
    currentHash: computePluginCodeHash(),
    snapshots: listBackupSnapshots(),
  }, null, 2));
}

function cmdRollback(positionals) {
  const requestedId = positionals[1] ? String(positionals[1]).trim() : '';
  const res = restoreBackupSnapshot(requestedId);
  if (!res.ok) {
    console.log(JSON.stringify({ ok: false, ...res }, null, 2));
    process.exit(1);
  }
  const statusBefore = getDaemonStatus();
  const restarted = statusBefore.running ? restartDaemon() : null;
  console.log(JSON.stringify({
    ok: true,
    ...res,
    restarted: Boolean(restarted),
    ...(restarted ? { restart: restarted } : {}),
    status: getDaemonStatus(),
  }, null, 2));
}

async function cmdSendFile(positionals, flags) {
  const rawPath = (typeof flags.file === 'string' && flags.file.trim()) || positionals[1] || '';
  if (!rawPath) {
    throw new Error('Usage: cli.mjs send-file <path> [--as-file] [--receive-id ID]');
  }
  const filePath = rawPath === '~'
    ? os.homedir()
    : rawPath.startsWith('~/')
      ? path.join(os.homedir(), rawPath.slice(2))
      : path.resolve(rawPath);

  const config = loadConfig();
  stripProcessProxyEnv(config.feishu.proxy);
  const receiveId =
    (typeof flags['receive-id'] === 'string' && flags['receive-id'].trim()) ||
    config.notifications.defaultReceiveId ||
    config.security.allowedOpenIds?.[0] ||
    '';
  const receiveIdType =
    (typeof flags['receive-id-type'] === 'string' && flags['receive-id-type'].trim()) ||
    config.notifications.defaultReceiveIdType ||
    'open_id';

  if (!receiveId) {
    throw new Error('No receive_id found. Bind a user first by messaging the bot, or pass --receive-id.');
  }

  const client = createFeishuClient(config, { quiet: true });
  const sent = await sendLocalMedia(client, {
    receiveId,
    receiveIdType,
    filePath,
    forceFile: Boolean(flags['as-file']),
  });
  console.log(JSON.stringify({ ok: true, receiveId, receiveIdType, ...sent }, null, 2));
}

async function cmdScopes() {
  const config = loadConfig();
  stripProcessProxyEnv(config.feishu.proxy);
  const client = createFeishuClient(config, { quiet: true });
  const res = await queryAppScopes(client);
  console.log(JSON.stringify({
    ok: true,
    totalCount: res.scopes.length,
    grantedCount: res.granted.length,
    pendingCount: res.pending.length,
    granted: res.granted,
    pending: res.pending,
  }, null, 2));
}

async function cmdReadDoc(positionals, flags) {
  const target = (typeof flags.doc === 'string' && flags.doc.trim()) || positionals[1] || '';
  if (!target) {
    throw new Error('Usage: cli.mjs read-doc <url|token> [--max-chars N]');
  }
  const config = loadConfig();
  stripProcessProxyEnv(config.feishu.proxy);
  const client = createFeishuClient(config, { quiet: true });
  const maxChars = flags['max-chars'] ? Number(flags['max-chars']) : 24000;
  const doc = await readFeishuDoc(client, target, {
    maxChars: Number.isFinite(maxChars) ? maxChars : 24000,
    domain: config.feishu.domain,
  });
  console.log(JSON.stringify({ ok: true, ...doc }, null, 2));
}

async function cmdWriteDoc(flags) {
  const rawFile = typeof flags.file === 'string' ? flags.file.trim() : '';
  let markdown = typeof flags.markdown === 'string' ? flags.markdown : '';
  if (rawFile) {
    const resolvedFile = rawFile === '~'
      ? os.homedir()
      : rawFile.startsWith('~/')
        ? path.join(os.homedir(), rawFile.slice(2))
        : path.resolve(rawFile);
    markdown = fs.readFileSync(resolvedFile, 'utf8');
  }
  if (!markdown.trim()) {
    throw new Error('Usage: cli.mjs write-doc [--title "..."] [--doc <url|token>] (--file <path> | --markdown "...")');
  }
  const config = loadConfig();
  stripProcessProxyEnv(config.feishu.proxy);
  const client = createFeishuClient(config, { quiet: true });
  const grantOpenId = resolveOwnerOpenId(
    config,
    typeof flags['grant-open-id'] === 'string' ? flags['grant-open-id'].trim() : '',
  );
  const doc = await writeFeishuDoc(client, {
    title: typeof flags.title === 'string' ? flags.title.trim() : '',
    markdown,
    documentId: typeof flags.doc === 'string' ? flags.doc.trim() : '',
    grantOpenId,
    domain: config.feishu.domain,
  });
  console.log(JSON.stringify({ ok: true, ...doc }, null, 2));
}

function cmdDesktop(flags) {
  const query = String(flags.query || flags.q || '').trim();
  const filter = String(flags.filter || 'all').trim();
  const limit = Number(flags.limit || 10);
  const sessions = listDesktopSessions({ query, filter, limit });
  console.log(JSON.stringify({
    ok: true,
    query,
    filter,
    count: sessions.length,
    sessions,
  }, null, 2));
}

function cmdHandoff(positionals, flags) {
  const cwd = typeof flags.cwd === 'string' ? flags.cwd.trim() : '';
  const originDesktopId = typeof flags.origin === 'string' ? flags.origin.trim() : '';
  const conversationId =
    (typeof flags.conv === 'string' && flags.conv.trim()) ||
    positionals[1] ||
    '';

  if (flags.list) {
    const sessions = listMobileSessions({
      cwd,
      originDesktopId,
      limit: flags.limit ? Number(flags.limit) : 10,
    });
    console.log(JSON.stringify({ ok: true, count: sessions.length, sessions }, null, 2));
    return;
  }

  const session = readMobileSession({ conversationId, cwd, originDesktopId });
  if (!session.found) {
    console.log(JSON.stringify({ ok: false, error: session.error }, null, 2));
    process.exitCode = 1;
    return;
  }

  const snap = writeHandoffSnapshot({
    conversationId: session.conversationId,
    cwd: session.cwd,
    cliResumeCommand: session.cliResumeCommand,
    desktopHandoffPrompt: session.desktopHandoffPrompt,
    modifiedFiles: session.modifiedFiles,
    originDesktopSession: session.originDesktopSession,
  });

  let clipboard = null;
  if (typeof flags.copy === 'string' || flags.copy === true) {
    const mode = String(flags.copy).toLowerCase() === 'desktop' ? 'desktop' : 'cli';
    clipboard = {
      target: mode,
      ...copyToSystemClipboard(mode === 'desktop' ? session.desktopHandoffPrompt : session.cliResumeCommand),
    };
  }

  console.log(JSON.stringify({
    ok: true,
    ...session,
    snapshotPath: snap.latestPath,
    clipboard,
  }, null, 2));
}

async function cmdAuth(flags) {
  const config = loadConfig();
  if (flags.status) {
    console.log(JSON.stringify({ ok: true, userAuth: getUserAuthStatus() }, null, 2));
    return;
  }
  if (flags.logout) {
    clearUserAuth();
    console.log(JSON.stringify({ ok: true, loggedOut: true, userAuth: getUserAuthStatus() }, null, 2));
    return;
  }
  if (typeof flags.code === 'string' && flags.code.trim()) {
    const redirectUri = typeof flags['redirect-uri'] === 'string' && flags['redirect-uri'].trim()
      ? flags['redirect-uri'].trim()
      : undefined;
    const status = await exchangeOAuthCode(config, { code: flags.code.trim(), redirectUri });
    console.log(JSON.stringify({ ok: true, userAuth: status }, null, 2));
    return;
  }
  if (flags.url) {
    const url = buildOAuthAuthorizeUrl({
      appId: config?.feishu?.appId,
      domain: config?.feishu?.domain,
    });
    console.log(JSON.stringify({ ok: true, authorizeUrl: url }, null, 2));
    return;
  }
  const port = flags.port ? Number(flags.port) : undefined;
  const timeoutSeconds = flags.timeout ? Number(flags.timeout) : 180;
  const result = await runInteractiveOAuthFlow(config, {
    port,
    timeoutSeconds,
    openBrowser: !flags['no-browser'],
  });
  console.log(JSON.stringify({ ok: true, redirectUri: result.redirectUri, userAuth: result.auth }, null, 2));
}

async function cmdTasks(flags) {
  const config = loadConfig();
  const filter = String(flags.filter || 'open').trim();
  const pageSize = flags.limit ? Number(flags.limit) : 50;
  const res = await listFeishuTasks(config, { filter, pageSize });
  console.log(JSON.stringify({ ok: true, ...res }, null, 2));
}

async function cmdTaskCreate(positionals, flags) {
  const config = loadConfig();
  const summary = (typeof flags.summary === 'string' && flags.summary.trim()) || positionals[1] || '';
  if (!summary) {
    throw new Error('Usage: cli.mjs task-create --summary "..." [--desc "..."] [--due "YYYY-MM-DD"] [--tasklist GUID]');
  }
  const task = await createFeishuTask(config, {
    summary,
    description: typeof flags.desc === 'string' ? flags.desc : '',
    due: typeof flags.due === 'string' ? flags.due : '',
    tasklistGuid: typeof flags.tasklist === 'string' ? flags.tasklist : '',
    assigneeOpenId: resolveOwnerOpenId(config),
  });
  console.log(JSON.stringify({ ok: true, task }, null, 2));
}

async function cmdTaskDone(positionals, flags) {
  const config = loadConfig();
  const guid = (typeof flags.guid === 'string' && flags.guid.trim()) || positionals[1] || '';
  if (!guid) {
    throw new Error('Usage: cli.mjs task-done <task_guid> [--reopen]');
  }
  const task = await setFeishuTaskCompleted(config, guid, !flags.reopen);
  console.log(JSON.stringify({ ok: true, task }, null, 2));
}

function printHelp() {
  console.log(`Usage: node scripts/cli.mjs <command> [options]

Commands:
  setup         Configure Feishu app credentials (--app-secret-stdin / FEISHU_APP_SECRET), proxy, and defaults
  auth          Authorize Feishu User OAuth for Task v2 (--status|--logout|--url|--no-browser)
  start         Start and register background daemon (launchd / systemd)
  stop          Stop background daemon
  restart       Restart background daemon
  safe-restart  Run preflight check, snapshot, and restart only if checks pass
  check         Run two-stage syntax & ESM import verification on plugin scripts
  snapshot      Create a backup snapshot after passing preflight check
  backups       List saved rollback snapshots and current plugin hash
  rollback      Restore a backup snapshot ([id|hash]) and restart if running
  status        Show daemon status and masked configuration
  logs          Print recent daemon stdout/stderr logs (--lines N)
  test-send     Send a test card to the bound Feishu user (--panel|--dirs)
  send-file     Upload and send a local image or file (<path> [--as-file])
  scopes        Inspect Feishu Open Platform scope authorization status
  read-doc      Read a Feishu docx/wiki document (<url|token> [--max-chars N])
  write-doc     Create or append a Feishu docx document (--title|--doc|--file|--markdown)
  tasks         List Feishu Task v2 tasks (--filter <open|done|all> --limit N)
  task-create   Create a Feishu Task v2 task (--summary "..." [--desc "..."] [--due "..."])
  task-done     Mark a Feishu Task v2 task complete (<task_guid> [--reopen])
  desktop       Scan local CLI/Desktop conversations (--query <kw> --filter <all|cli|desktop|running> --limit N)
  handoff       Inspect or copy mobile session handoff (--list|--conv <id>|--cwd <dir>|--origin <id>|--copy cli|desktop)
  pack          Create a clean shareable plugin zip (--out path/to.zip)
`);
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const sub = positionals[0] || 'help';

  const isBridgeChild = process.env.FEISHU_REMOTE_BRIDGE_CHILD === '1' && !flags.force;
  if (isBridgeChild && ['stop', 'restart', 'safe-restart', 'rollback'].includes(sub)) {
    console.error(JSON.stringify({
      ok: false,
      blocked: true,
      error: `Refused to run \`cli.mjs ${sub}\` from inside a bridge-spawned child session. Ask the user to run \`/reload\` in Feishu, or pass --force outside child contexts.`,
    }, null, 2));
    process.exit(1);
  }

  if (sub === 'help' || flags.help || flags.h) {
    printHelp();
    return;
  }
  if (sub === 'setup') {
    cmdSetup(flags);
    return;
  }
  if (sub === 'auth') {
    await cmdAuth(flags);
    return;
  }
  if (sub === 'start') {
    console.log(JSON.stringify({ ok: true, ...startDaemon(), status: getDaemonStatus() }, null, 2));
    return;
  }
  if (sub === 'stop') {
    console.log(JSON.stringify({ ok: true, ...stopDaemon(), status: getDaemonStatus() }, null, 2));
    return;
  }
  if (sub === 'restart') {
    console.log(JSON.stringify({ ok: true, ...restartDaemon(), status: getDaemonStatus() }, null, 2));
    return;
  }
  if (sub === 'safe-restart') {
    cmdSafeRestart();
    return;
  }
  if (sub === 'check') {
    cmdCheck();
    return;
  }
  if (sub === 'snapshot') {
    cmdSnapshot();
    return;
  }
  if (sub === 'backups') {
    cmdBackups();
    return;
  }
  if (sub === 'rollback') {
    cmdRollback(positionals);
    return;
  }
  if (sub === 'status') {
    cmdStatus();
    return;
  }
  if (sub === 'logs') {
    cmdLogs(flags);
    return;
  }
  if (sub === 'test-send') {
    await cmdTestSend(flags);
    return;
  }
  if (sub === 'send-file') {
    await cmdSendFile(positionals, flags);
    return;
  }
  if (sub === 'scopes') {
    await cmdScopes();
    return;
  }
  if (sub === 'read-doc') {
    await cmdReadDoc(positionals, flags);
    return;
  }
  if (sub === 'write-doc') {
    await cmdWriteDoc(flags);
    return;
  }
  if (sub === 'tasks') {
    await cmdTasks(flags);
    return;
  }
  if (sub === 'task-create') {
    await cmdTaskCreate(positionals, flags);
    return;
  }
  if (sub === 'task-done') {
    await cmdTaskDone(positionals, flags);
    return;
  }
  if (sub === 'desktop') {
    cmdDesktop(flags);
    return;
  }
  if (sub === 'handoff') {
    cmdHandoff(positionals, flags);
    return;
  }
  if (sub === 'pack') {
    cmdPack(flags);
    return;
  }

  console.error(`Unknown command: ${sub}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(`Error: ${err.message || err}`);
  process.exit(1);
});
