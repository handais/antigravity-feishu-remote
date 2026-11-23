import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { detectAgyBin } from './config.mjs';

export const VALID_MODES = ['accept-edits', 'plan', 'auto', 'full', 'default'];
export const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function buildAgyArgs({ prompt, conversationId = '', mode = 'accept-edits', model = '', effort = '', timeoutSeconds = 3600 }) {
  const args = ['-p', prompt, '--output-format', 'stream-json'];
  if (conversationId) {
    args.push('--conversation', conversationId);
  }
  if (mode === 'plan' || mode === 'accept-edits' || mode === 'auto') {
    args.push('--mode', mode);
  } else if (mode === 'full') {
    args.push('--dangerously-skip-permissions');
  }
  if (model && model !== 'default') {
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

function summarizeToolParameters(toolName, params = {}) {
  if (!params || typeof params !== 'object') return '';
  if (params.CommandLine) return String(params.CommandLine).slice(0, 80);
  if (params.Path) return String(params.Path).slice(0, 80);
  if (params.query) return String(params.query).slice(0, 80);
  if (params.Prompt) return String(params.Prompt).slice(0, 60);
  const firstKey = Object.keys(params)[0];
  if (firstKey && params[firstKey] !== undefined) {
    return `${firstKey}=${String(params[firstKey]).slice(0, 60)}`;
  }
  return toolName || '';
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
      durationSeconds: r.duration_seconds,
      finishedReason: r.finished_reason || '',
      usage: r.usage || null,
    };
  }

  return { kind: 'other', raw: parsed };
}

export function buildChildEnv(config, agyBin) {
  const pathParts = [
    path.dirname(process.execPath),
    agyBin ? path.dirname(agyBin) : '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    process.env.PATH || '',
  ].filter(Boolean);
  const dedupedPath = [...new Set(pathParts.join(':').split(':').filter(Boolean))].join(':');

  const env = {
    HOME: process.env.HOME || '',
    USER: process.env.USER || '',
    LOGNAME: process.env.LOGNAME || '',
    SHELL: process.env.SHELL || '/bin/zsh',
    TERM: 'xterm-256color',
    LANG: process.env.LANG || 'en_US.UTF-8',
    PATH: dedupedPath,
    FEISHU_REMOTE_BRIDGE_CHILD: '1',
  };

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

export function runAgyTurn({ prompt, cwd, conversationId = '', mode = 'accept-edits', model = '', effort = '', config, onEvent, signal }) {
  return new Promise((resolve, reject) => {
    const agyBin = config?.agy?.bin?.trim() || detectAgyBin();
    if (!agyBin) {
      reject(new Error('Could not find `agy` binary. Set `agy.bin` in config or check PATH.'));
      return;
    }

    const args = buildAgyArgs({
      prompt,
      conversationId,
      mode,
      model,
      effort,
      timeoutSeconds: config?.agy?.timeoutSeconds ?? 3600,
    });
    const env = buildChildEnv(config, agyBin);

    const child = spawn(agyBin, args, {
      cwd: cwd || config?.agy?.defaultCwd || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let resolvedConvId = conversationId;
    let accumulatedText = '';
    let finalResult = null;
    const toolsUsed = [];
    let aborted = false;
    let killTimer = null;

    const handleAbort = () => {
      aborted = true;
      if (!child.killed) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore
          }
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
        durationSeconds: finalResult?.durationSeconds ?? null,
        usage: finalResult?.usage || null,
        toolsUsed,
        stderr: stderr.trim(),
        exitCode: exitCode ?? -1,
        aborted,
      });
    });
  });
}

export function listAgyModels(config) {
  return new Promise((resolve, reject) => {
    const agyBin = config?.agy?.bin?.trim() || detectAgyBin();
    if (!agyBin) {
      reject(new Error('Could not find `agy` binary.'));
      return;
    }
    const child = spawn(agyBin, ['models'], {
      env: buildChildEnv(config, agyBin),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
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
