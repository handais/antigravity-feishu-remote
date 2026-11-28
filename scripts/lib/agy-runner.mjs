import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { detectAgyBin } from './config.mjs';

export const VALID_MODES = ['accept-edits', 'plan', 'auto', 'full', 'default'];
export const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SAFE_MODEL_NAME_RE = /^[a-zA-Z0-9._:/@+-]{1,128}$/;
const SAFE_CONV_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

export function isValidModelName(model) {
  const clean = String(model || '').trim();
  return Boolean(clean && SAFE_MODEL_NAME_RE.test(clean));
}

export function isSafeCliConversationId(id) {
  const clean = String(id || '').trim();
  return Boolean(clean && clean !== '.' && clean !== '..' && SAFE_CONV_ID_RE.test(clean));
}

export function buildAgyStreamInputLine(prompt) {
  return `${JSON.stringify({ event: 'user', message: { content: String(prompt ?? '') } })}\n`;
}

export function buildAgyArgs({
  prompt = '',
  useStdin = false,
  conversationId = '',
  mode = 'auto',
  model = '',
  effort = '',
  timeoutSeconds = 3600,
}) {
  const args = useStdin
    ? ['--input-format', 'stream-json', '--output-format', 'stream-json']
    : ['-p', prompt, '--output-format', 'stream-json'];
  if (conversationId) {
    if (!isSafeCliConversationId(conversationId)) {
      throw new Error(`Invalid conversationId rejected: ${conversationId}`);
    }
    args.push('--conversation', conversationId);
  }
  if (mode === 'plan' || mode === 'accept-edits' || mode === 'auto') {
    args.push('--mode', mode);
  } else if (mode === 'full') {
    args.push('--dangerously-skip-permissions');
  }
  if (model && model !== 'default') {
    if (!isValidModelName(model)) {
      throw new Error(`Invalid model name rejected: ${model}`);
    }
    args.push('--model', model);
  }
  if (effort && VALID_EFFORTS.includes(effort)) {
    args.push('--effort', effort);
  }
  if (typeof timeoutSeconds === 'number' && timeoutSeconds > 0) {
    args.push('--print-timeout', `${Math.floor(timeoutSeconds)}s`);
  }
  return args;
}

function cleanSummaryText(val, maxLen = 80) {
  return String(val || '')
    .replace(/\s+/g, ' ')
    .replace(/`/g, "'")
    .trim()
    .slice(0, maxLen);
}

function summarizeToolParameters(toolName, params = {}) {
  if (!params || typeof params !== 'object') return '';
  if (params.CommandLine) return cleanSummaryText(params.CommandLine, 80);
  if (params.Path) return cleanSummaryText(params.Path, 80);
  if (params.query) return cleanSummaryText(params.query, 80);
  if (params.Prompt) return cleanSummaryText(params.Prompt, 60);
  const firstKey = Object.keys(params)[0];
  if (firstKey && params[firstKey] !== undefined) {
    return cleanSummaryText(`${firstKey}=${params[firstKey]}`, 72);
  }
  return cleanSummaryText(toolName || '', 40);
}

export function parseAgyStreamLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{')) {
    return { kind: 'non_json', raw: trimmed };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'non_json', raw: trimmed };
  }

  if (parsed.event === 'init') {
    return {
      kind: 'init',
      conversationId: parsed.conversation_id || '',
      cwd: parsed.init?.cwd || '',
      permissionMode: parsed.init?.permission_mode || '',
    };
  }

  if (parsed.event === 'step_update' && parsed.step_update) {
    const su = parsed.step_update;
    const stepType = su.step_type || '';
    const state = su.state || '';
    if (stepType === 'tool' && state === 'ACTIVE') {
      const toolName = su.tool_name || su.tool_info?.name || 'tool';
      return {
        kind: 'tool_start',
        stepIndex: su.step_index,
        toolName,
        summary: summarizeToolParameters(toolName, su.tool_info?.parameters),
        parameters: su.tool_info?.parameters || null,
      };
    }
    if (stepType === 'tool' && state === 'DONE') {
      return {
        kind: 'tool_done',
        stepIndex: su.step_index,
        toolName: su.tool_name || su.tool_info?.name || 'tool',
        durationSeconds: su.duration_seconds,
      };
    }
    const upperState = String(state || '').toUpperCase();
    const rawToolErr = String(su.error || su.error_message || su.tool_info?.error || '').trim();
    if (
      stepType === 'tool' &&
      (['ERROR', 'FAILED', 'DENIED', 'CANCELLED', 'CANCELED'].includes(upperState) || (state !== 'ACTIVE' && Boolean(rawToolErr)))
    ) {
      const toolName = su.tool_name || su.tool_info?.name || 'tool';
      return {
        kind: 'tool_error',
        stepIndex: su.step_index,
        toolName,
        state: upperState || 'ERROR',
        summary: summarizeToolParameters(toolName, su.tool_info?.parameters),
        error: rawToolErr,
        durationSeconds: su.duration_seconds,
      };
    }
    if (stepType === 'agent_response' && typeof su.text_delta === 'string') {
      return {
        kind: 'text_delta',
        stepIndex: su.step_index,
        textDelta: su.text_delta,
        state,
      };
    }
    return {
      kind: 'step_update',
      stepType,
      state,
      stepIndex: su.step_index,
    };
  }

  if (parsed.event === 'result' && parsed.result) {
    const r = parsed.result;
    return {
      kind: 'result',
      conversationId: r.conversation_id || '',
      status: r.status || '',
      response: r.response || '',
      error: String(r.error || r.error_message || '').trim(),
      durationSeconds: r.duration_seconds,
      finishedReason: r.finished_reason || '',
      usage: r.usage || null,
    };
  }

  return { kind: 'other', raw: parsed };
}

export function buildChildEnv(config, agyBin, bridgeMeta = {}) {
  const isWin = process.platform === 'win32';
  const delim = path.delimiter;
  const pathParts = [
    path.dirname(process.execPath),
    agyBin ? path.dirname(agyBin) : '',
    ...(isWin
      ? []
      : [
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
          '/usr/sbin',
          '/sbin',
        ]),
    ...(process.env.PATH || '').split(delim),
  ].filter(Boolean);
  const dedupedPath = [...new Set(pathParts)].join(delim);

  const env = {
    HOME: process.env.HOME || process.env.USERPROFILE || '',
    USER: process.env.USER || process.env.USERNAME || '',
    LOGNAME: process.env.LOGNAME || process.env.USERNAME || '',
    ...(isWin ? {} : { SHELL: process.env.SHELL || '/bin/zsh' }),
    TERM: 'xterm-256color',
    LANG: process.env.LANG || 'en_US.UTF-8',
    PATH: dedupedPath,
    FEISHU_REMOTE_BRIDGE_CHILD: '1',
  };

  if (bridgeMeta?.chatId) env.FEISHU_REMOTE_CHAT_ID = String(bridgeMeta.chatId);
  if (bridgeMeta?.openId) env.FEISHU_REMOTE_OPEN_ID = String(bridgeMeta.openId);
  if (bridgeMeta?.sessionKey) env.FEISHU_REMOTE_SESSION_KEY = String(bridgeMeta.sessionKey);
  if (bridgeMeta?.threadRootId) env.FEISHU_REMOTE_THREAD_ROOT_ID = String(bridgeMeta.threadRootId);
  if (bridgeMeta?.mode) env.FEISHU_REMOTE_MODE = String(bridgeMeta.mode);

  if (isWin) {
    for (const winKey of [
      'USERPROFILE',
      'HOMEDRIVE',
      'HOMEPATH',
      'APPDATA',
      'LOCALAPPDATA',
      'SystemRoot',
      'COMSPEC',
      'PATHEXT',
      'TEMP',
      'TMP',
      'ProgramFiles',
      'ProgramFiles(x86)',
    ]) {
      if (process.env[winKey]) {
        env[winKey] = process.env[winKey];
      }
    }
  }

  if (process.env.FEISHU_REMOTE_CONFIG_DIR) {
    env.FEISHU_REMOTE_CONFIG_DIR = process.env.FEISHU_REMOTE_CONFIG_DIR;
  }
  if (!isWin && process.env.TMPDIR) {
    env.TMPDIR = process.env.TMPDIR;
  }
  for (const safeKey of [
    'SSH_AUTH_SOCK',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_CONFIG_HOME',
    'LC_ALL',
    'LC_CTYPE',
  ]) {
    if (process.env[safeKey]) {
      env[safeKey] = process.env[safeKey];
    }
  }

  if (process.env.ANTIGRAVITY_API_KEY) {
    env.ANTIGRAVITY_API_KEY = process.env.ANTIGRAVITY_API_KEY;
  }

  const proxy = config?.agy?.proxy?.trim();
  if (proxy) {
    env.http_proxy = proxy;
    env.https_proxy = proxy;
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
    env.no_proxy = '127.0.0.1,localhost,::1';
    env.NO_PROXY = '127.0.0.1,localhost,::1';
  }
  return env;
}

export function getWindowsSpawnOpts(binPath) {
  if (process.platform !== 'win32') {
    return {};
  }
  return {
    windowsHide: true,
    ...(/\.(cmd|bat)$/i.test(String(binPath || '')) ? { shell: true } : {}),
  };
}

export function killChildTree(child, sig = 'SIGTERM', useDetached = process.platform !== 'win32') {
  if (!child) return;
  if (process.platform === 'win32') {
    if (sig === 'SIGKILL' && child.pid) {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        }).unref();
        return;
      } catch {
        // Fall back to child.kill
      }
    }
    try {
      child.kill(sig);
    } catch {
      // Ignore
    }
    return;
  }
  if (useDetached && child.pid) {
    try {
      process.kill(-child.pid, sig);
      return;
    } catch {
      // Fall back to direct child signal
    }
  }
  try {
    child.kill(sig);
  } catch {
    // Ignore
  }
}

export function spawnAgyStreamProcess({
  cwd,
  conversationId = '',
  mode = 'auto',
  model = '',
  effort = '',
  timeoutSeconds = 3600,
  config,
  bridgeMeta = {},
}) {
  const agyBin = config?.agy?.bin?.trim() || detectAgyBin();
  if (!agyBin) {
    throw new Error('Could not find `agy` binary. Set `agy.bin` in config or check PATH.');
  }
  const args = buildAgyArgs({
    useStdin: true,
    conversationId,
    mode,
    model,
    effort,
    timeoutSeconds,
  });
  const env = buildChildEnv(config, agyBin, bridgeMeta);
  const useDetached = process.platform !== 'win32';
  const child = spawn(agyBin, args, {
    cwd: cwd || config?.agy?.defaultCwd || process.cwd(),
    env,
    detached: useDetached,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...getWindowsSpawnOpts(agyBin),
  });
  return { child, useDetached, agyBin };
}

export function runAgyTurn({ prompt, cwd, conversationId = '', mode = 'auto', model = '', effort = '', config, bridgeMeta = {}, onEvent, signal }) {
  return new Promise((resolve, reject) => {
    let spawned;
    try {
      spawned = spawnAgyStreamProcess({
        cwd,
        conversationId,
        mode,
        model,
        effort,
        timeoutSeconds: config?.agy?.timeoutSeconds ?? 3600,
        config,
        bridgeMeta,
      });
    } catch (err) {
      reject(err);
      return;
    }
    const { child, useDetached } = spawned;

    child.stdin.on('error', () => {
      // Ignore EPIPE if child exits before stdin completes
    });
    try {
      child.stdin.write(buildAgyStreamInputLine(prompt));
      child.stdin.end();
    } catch {
      // Handled via child error/close listeners
    }

    let stderr = '';
    let resolvedConvId = conversationId;
    let accumulatedText = '';
    let finalResult = null;
    const toolsUsed = [];
    const toolErrors = [];
    let aborted = false;
    let killTimer = null;

    const handleAbort = () => {
      aborted = true;
      if (!child.killed) {
        killChildTree(child, 'SIGTERM', useDetached);
        killTimer = setTimeout(() => {
          killChildTree(child, 'SIGKILL', useDetached);
        }, 3000);
        killTimer.unref();
      }
    };

    if (signal) {
      if (signal.aborted) {
        handleAbort();
      } else {
        signal.addEventListener('abort', handleAbort, { once: true });
      }
    }

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const evt = parseAgyStreamLine(line);
      if (!evt) return;
      if (evt.kind === 'init' && evt.conversationId) {
        resolvedConvId = evt.conversationId;
      } else if (evt.kind === 'tool_start') {
        toolsUsed.push(evt.toolName);
      } else if (evt.kind === 'tool_error') {
        toolErrors.push({
          stepIndex: evt.stepIndex,
          toolName: evt.toolName,
          summary: evt.summary || '',
          error: evt.error || '',
          state: evt.state || 'ERROR',
        });
      } else if (evt.kind === 'text_delta') {
        accumulatedText += evt.textDelta;
      } else if (evt.kind === 'result') {
        finalResult = evt;
        if (evt.conversationId) {
          resolvedConvId = evt.conversationId;
        }
      }
      if (onEvent) {
        try {
          onEvent(evt);
        } catch {
          // Ignore callback errors
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) {
        stderr += chunk.toString('utf8');
        if (stderr.length > 8192) {
          stderr = stderr.slice(0, 8192);
        }
      }
    });

    child.on('error', (err) => {
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', handleAbort);
      rl.close();
      reject(err);
    });

    child.on('close', (exitCode) => {
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', handleAbort);
      rl.close();

      resolve({
        conversationId: resolvedConvId || finalResult?.conversationId || '',
        response: (finalResult?.response || accumulatedText || '').trim(),
        status: aborted ? 'ABORTED' : finalResult?.status || (exitCode === 0 ? 'SUCCESS' : 'ERROR'),
        finishedReason: finalResult?.finishedReason || '',
        error: finalResult?.error || '',
        durationSeconds: finalResult?.durationSeconds ?? null,
        usage: finalResult?.usage || null,
        toolsUsed,
        toolErrors,
        stderr: stderr.trim(),
        exitCode: exitCode ?? -1,
        aborted,
      });
    });
  });
}

export function listAgyModels(config, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const agyBin = config?.agy?.bin?.trim() || detectAgyBin();
    if (!agyBin) {
      reject(new Error('Could not find `agy` binary.'));
      return;
    }
    const child = spawn(agyBin, ['models'], {
      env: buildChildEnv(config, agyBin),
      stdio: ['ignore', 'pipe', 'pipe'],
      ...getWindowsSpawnOpts(agyBin),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore kill failures
      }
      reject(new Error(`agy models timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, Math.max(2000, Number(timeoutMs) || 15_000));
    timer.unref();

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `agy models exited with code ${code}`));
        return;
      }
      resolve(
        stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('Fetching available models')),
      );
    });
  });
}
