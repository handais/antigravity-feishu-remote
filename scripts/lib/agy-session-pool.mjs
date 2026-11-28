import readline from 'node:readline';
import {
  buildAgyStreamInputLine,
  killChildTree,
  parseAgyStreamLine,
  spawnAgyStreamProcess,
} from './agy-runner.mjs';

export const ASYNC_ORCHESTRATION_TOOLS = new Set([
  'invoke_subagent',
  'send_message',
  'manage_subagents',
  'swarm',
  'schedule',
  'manage_task',
  'run_workflow',
]);

export function isAsyncWorkflowPrompt(text = '') {
  const normalized = String(text || '')
    .trim()
    .replace(/^\[agy\]\s*/i, '');
  return /^\/(?:teamwork|swarm|schedule|goal)(?:\s|$)/i.test(normalized);
}

function isChildAlive(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null && !child.killed);
}

function signatureMatches(a, b) {
  return (
    a?.cwd === b?.cwd &&
    a?.mode === b?.mode &&
    a?.model === b?.model &&
    a?.effort === b?.effort
  );
}

export function createAgySessionPool({
  maxSessions = 4,
  idleTtlMs = 30 * 60 * 1000,
  asyncTurnWatchdogMs = 15 * 60 * 1000,
  onAsyncEvent = null,
} = {}) {
  const sessions = new Map();
  let asyncHandler = typeof onAsyncEvent === 'function' ? onAsyncEvent : null;

  const setOnAsyncEvent = (fn) => {
    asyncHandler = typeof fn === 'function' ? fn : null;
  };

  const clearIdleTimer = (entry) => {
    if (entry?.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  };

  const clearAsyncWatchdog = (entry) => {
    if (entry?.asyncWatchdogTimer) {
      clearTimeout(entry.asyncWatchdogTimer);
      entry.asyncWatchdogTimer = null;
    }
  };

  const terminateEntryProcess = (entry, { immediate = false } = {}) => {
    if (!entry) return;
    clearIdleTimer(entry);
    clearAsyncWatchdog(entry);
    try {
      entry.rl?.close();
    } catch {
      // Ignore readline close error
    }
    try {
      if (entry.child?.stdin && !entry.child.stdin.destroyed) {
        entry.child.stdin.end();
      }
    } catch {
      // Ignore stdin close error
    }
    if (!isChildAlive(entry.child)) return;

    let termTimer = null;
    if (immediate) {
      killChildTree(entry.child, 'SIGTERM', entry.useDetached);
    } else {
      termTimer = setTimeout(() => {
        if (isChildAlive(entry.child)) {
          killChildTree(entry.child, 'SIGTERM', entry.useDetached);
        }
      }, 1000);
      termTimer.unref?.();
    }

    const killTimer = setTimeout(() => {
      if (isChildAlive(entry.child)) {
        killChildTree(entry.child, 'SIGKILL', entry.useDetached);
      }
    }, immediate ? 1500 : 3000);
    killTimer.unref?.();

    entry.child.once('close', () => {
      if (termTimer) clearTimeout(termTimer);
      clearTimeout(killTimer);
    });
  };

  const release = (runKey, { immediate = false } = {}) => {
    const entry = sessions.get(runKey);
    if (!entry) return false;
    sessions.delete(runKey);
    terminateEntryProcess(entry, { immediate });
    return true;
  };

  const disposeAll = ({ immediate = true } = {}) => {
    const keys = [...sessions.keys()];
    for (const k of keys) {
      release(k, { immediate });
    }
  };

  const armIdleTimer = (entry) => {
    clearIdleTimer(entry);
    if (!Number.isFinite(idleTtlMs) || idleTtlMs <= 0) return;
    entry.idleTimer = setTimeout(() => {
      if (sessions.get(entry.key) === entry && !entry.busy && !entry.asyncTurn) {
        release(entry.key);
      }
    }, idleTtlMs);
    entry.idleTimer.unref?.();
  };

  const evictOldestIdle = () => {
    let oldest = null;
    for (const entry of sessions.values()) {
      if (entry.busy || entry.asyncTurn) continue;
      if (!oldest || entry.lastActiveAt < oldest.lastActiveAt) {
        oldest = entry;
      }
    }
    if (oldest) {
      release(oldest.key);
    }
  };

  const has = (runKey) => {
    const entry = sessions.get(runKey);
    return Boolean(entry && isChildAlive(entry.child));
  };

  const size = () => sessions.size;

  const getInfo = (runKey) => {
    const entry = sessions.get(runKey);
    if (!entry) return null;
    return {
      key: entry.key,
      pid: entry.child?.pid || 0,
      conversationId: entry.conversationId || '',
      busy: Boolean(entry.busy),
      lastActiveAt: entry.lastActiveAt,
    };
  };

  const getMeta = (runKey) => {
    const entry = sessions.get(runKey);
    return entry ? entry.meta || {} : {};
  };

  const updateMeta = (runKey, patch = {}) => {
    const entry = sessions.get(runKey);
    if (!entry || !patch || typeof patch !== 'object') return null;
    entry.meta = { ...(entry.meta || {}), ...patch };
    return entry.meta;
  };

  const spawnEntry = ({ runKey, cwd, conversationId, mode, model, effort, config, bridgeMeta, meta }) => {
    const spawned = spawnAgyStreamProcess({
      cwd,
      conversationId,
      mode,
      model,
      effort,
      timeoutSeconds: 0,
      config,
      bridgeMeta,
    });
    const { child, useDetached } = spawned;
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    const entry = {
      key: runKey,
      child,
      rl,
      useDetached,
      signature: { cwd, mode, model, effort },
      conversationId: conversationId || '',
      busy: false,
      activeTurn: null,
      asyncTurn: null,
      meta: meta || {},
      stderr: '',
      idleTimer: null,
      asyncWatchdogTimer: null,
      lastActiveAt: Date.now(),
    };

    const armAsyncWatchdog = () => {
      clearAsyncWatchdog(entry);
      if (!Number.isFinite(asyncTurnWatchdogMs) || asyncTurnWatchdogMs <= 0) return;
      entry.asyncWatchdogTimer = setTimeout(() => {
        if (!entry.asyncTurn) return;
        const stalled = entry.asyncTurn;
        entry.asyncTurn = null;
        emitAsync({
          type: 'result',
          runKey: entry.key,
          entry,
          result: {
            conversationId: entry.conversationId || '',
            response: stalled.accumulatedText.trim(),
            status: 'ERROR',
            finishedReason: `Async session wakeup timed out after ${Math.round(asyncTurnWatchdogMs / 1000)}s.`,
            durationSeconds: (Date.now() - stalled.startedAt) / 1000,
            usage: null,
            toolsUsed: [...stalled.toolsUsed],
            stderr: entry.stderr.trim(),
            exitCode: 1,
            aborted: false,
            persistent: false,
          },
        });
        release(entry.key, { immediate: true });
      }, asyncTurnWatchdogMs);
      entry.asyncWatchdogTimer.unref?.();
    };

    child.stdin.on('error', () => {
      // Handled by close/error listeners
    });

    child.stderr.on('data', (chunk) => {
      if (entry.stderr.length < 8192) {
        entry.stderr += chunk.toString('utf8');
        if (entry.stderr.length > 8192) {
          entry.stderr = entry.stderr.slice(0, 8192);
        }
      }
    });

    const emitAsync = (payload) => {
      if (!asyncHandler) return;
      try {
        Promise.resolve(asyncHandler(payload)).catch((err) => {
          console.error('[feishu-remote] async session event handler error:', err);
        });
      } catch (err) {
        console.error('[feishu-remote] async session event handler sync error:', err);
      }
    };

    rl.on('line', (line) => {
      const evt = parseAgyStreamLine(line);
      if (!evt) return;
      entry.lastActiveAt = Date.now();

      if (entry.activeTurn) {
        const turn = entry.activeTurn;
        if (evt.kind === 'init' && evt.conversationId) {
          entry.conversationId = evt.conversationId;
          turn.resolvedConvId = evt.conversationId;
        } else if (evt.kind === 'tool_start') {
          turn.toolsUsed.push(evt.toolName);
        } else if (evt.kind === 'text_delta') {
          turn.accumulatedText += evt.textDelta;
        }

        if (turn.onEvent) {
          try {
            turn.onEvent(evt);
          } catch {
            // Ignore UI callback errors
          }
        }

        if (evt.kind === 'result') {
          if (evt.conversationId) {
            entry.conversationId = evt.conversationId;
            turn.resolvedConvId = evt.conversationId;
          }
          const status = turn.aborted ? 'ABORTED' : evt.status || 'SUCCESS';
          const isErr = status !== 'SUCCESS';
          const payload = {
            conversationId: turn.resolvedConvId || evt.conversationId || entry.conversationId || '',
            response: (evt.response || turn.accumulatedText || '').trim(),
            status,
            finishedReason: evt.finishedReason || '',
            durationSeconds: evt.durationSeconds ?? null,
            usage: evt.usage || null,
            toolsUsed: [...turn.toolsUsed],
            stderr: entry.stderr.trim(),
            exitCode: isErr ? 1 : 0,
            aborted: Boolean(turn.aborted),
            persistent: !isErr && !turn.aborted,
          };
          entry.stderr = '';
          turn.settle(payload);
          if (isErr || turn.aborted) {
            release(entry.key);
          } else {
            armIdleTimer(entry);
          }
        }
        return;
      }

      // Unsolicited async event while parked (subagent wakeup / scheduled timer)
      if (evt.kind === 'init') {
        if (evt.conversationId) entry.conversationId = evt.conversationId;
        return;
      }
      if (evt.kind === 'other' || evt.kind === 'non_json') {
        return;
      }

      if (!entry.asyncTurn) {
        entry.asyncTurn = {
          startedAt: Date.now(),
          toolsUsed: [],
          accumulatedText: '',
        };
        emitAsync({ type: 'start', runKey: entry.key, entry, evt });
      }
      armIdleTimer(entry);
      armAsyncWatchdog();

      if (evt.kind === 'tool_start') {
        entry.asyncTurn.toolsUsed.push(evt.toolName);
      } else if (evt.kind === 'text_delta') {
        entry.asyncTurn.accumulatedText += evt.textDelta;
      }

      if (evt.kind !== 'result') {
        emitAsync({ type: 'event', runKey: entry.key, entry, evt });
        return;
      }

      clearAsyncWatchdog(entry);
      if (evt.conversationId) {
        entry.conversationId = evt.conversationId;
      }
      const finishedAsync = entry.asyncTurn;
      entry.asyncTurn = null;
      emitAsync({
        type: 'result',
        runKey: entry.key,
        entry,
        evt,
        result: {
          conversationId: evt.conversationId || entry.conversationId || '',
          response: (evt.response || finishedAsync.accumulatedText || '').trim(),
          status: evt.status || 'SUCCESS',
          finishedReason: evt.finishedReason || '',
          durationSeconds: (Date.now() - finishedAsync.startedAt) / 1000,
          usage: evt.usage || null,
          toolsUsed: [...finishedAsync.toolsUsed],
          stderr: entry.stderr.trim(),
          exitCode: evt.status && evt.status !== 'SUCCESS' ? 1 : 0,
          aborted: false,
          persistent: true,
        },
      });
      entry.stderr = '';
    });

    child.on('error', (err) => {
      clearIdleTimer(entry);
      clearAsyncWatchdog(entry);
      if (sessions.get(entry.key) === entry) {
        sessions.delete(entry.key);
      }
      try {
        entry.rl.close();
      } catch {
        // Ignore
      }
      if (entry.activeTurn) {
        entry.activeTurn.reject(err);
      } else if (entry.asyncTurn) {
        const finishedAsync = entry.asyncTurn;
        entry.asyncTurn = null;
        emitAsync({
          type: 'result',
          runKey: entry.key,
          entry,
          result: {
            conversationId: entry.conversationId || '',
            response: finishedAsync.accumulatedText.trim(),
            status: 'ERROR',
            finishedReason: err?.message || String(err),
            durationSeconds: (Date.now() - finishedAsync.startedAt) / 1000,
            usage: null,
            toolsUsed: [...finishedAsync.toolsUsed],
            stderr: entry.stderr.trim() || err?.message || String(err),
            exitCode: 1,
            aborted: false,
            persistent: false,
          },
        });
      }
    });

    child.on('close', (exitCode) => {
      clearIdleTimer(entry);
      clearAsyncWatchdog(entry);
      if (sessions.get(entry.key) === entry) {
        sessions.delete(entry.key);
      }
      try {
        entry.rl.close();
      } catch {
        // Ignore
      }
      if (entry.activeTurn) {
        const turn = entry.activeTurn;
        turn.settle({
          conversationId: turn.resolvedConvId || entry.conversationId || '',
          response: turn.accumulatedText.trim(),
          status: turn.aborted ? 'ABORTED' : exitCode === 0 ? 'SUCCESS' : 'ERROR',
          finishedReason: '',
          durationSeconds: (Date.now() - turn.startedAt) / 1000,
          usage: null,
          toolsUsed: [...turn.toolsUsed],
          stderr: entry.stderr.trim(),
          exitCode: exitCode ?? -1,
          aborted: Boolean(turn.aborted),
          persistent: false,
        });
      } else if (entry.asyncTurn) {
        const finishedAsync = entry.asyncTurn;
        entry.asyncTurn = null;
        emitAsync({
          type: 'result',
          runKey: entry.key,
          entry,
          result: {
            conversationId: entry.conversationId || '',
            response: finishedAsync.accumulatedText.trim(),
            status: exitCode === 0 ? 'SUCCESS' : 'ERROR',
            finishedReason: '',
            durationSeconds: (Date.now() - finishedAsync.startedAt) / 1000,
            usage: null,
            toolsUsed: [...finishedAsync.toolsUsed],
            stderr: entry.stderr.trim(),
            exitCode: exitCode ?? -1,
            aborted: false,
            persistent: false,
          },
        });
      }
    });

    sessions.set(runKey, entry);
    return entry;
  };

  const runTurn = ({
    runKey,
    prompt,
    cwd,
    conversationId = '',
    mode = 'accept-edits',
    model = '',
    effort = '',
    timeoutSeconds = null,
    config,
    bridgeMeta = {},
    meta = {},
    onEvent,
    signal,
  }) => {
    const signature = {
      cwd: cwd || config?.agy?.defaultCwd || process.cwd(),
      mode: mode || 'accept-edits',
      model: model || '',
      effort: effort || '',
    };

    let entry = sessions.get(runKey);
    const canReuse = Boolean(
      entry &&
      isChildAlive(entry.child) &&
      !entry.busy &&
      !entry.asyncTurn &&
      signatureMatches(entry.signature, signature) &&
      (!conversationId ? !entry.conversationId : (!entry.conversationId || entry.conversationId === conversationId)),
    );

    if (!canReuse) {
      if (entry) {
        release(runKey);
      }
      if (sessions.size >= Math.max(1, Number(maxSessions) || 4)) {
        evictOldestIdle();
      }
      entry = spawnEntry({
        runKey,
        cwd: signature.cwd,
        conversationId,
        mode: signature.mode,
        model: signature.model,
        effort: signature.effort,
        config,
        bridgeMeta,
        meta,
      });
    } else {
      entry.meta = { ...entry.meta, ...meta };
    }

    clearIdleTimer(entry);
    entry.busy = true;
    entry.lastActiveAt = Date.now();

    return new Promise((resolve, reject) => {
      let settled = false;
      let killTimer = null;
      let turnTimeoutTimer = null;

      const cleanupSignal = () => {
        if (turnTimeoutTimer) {
          clearTimeout(turnTimeoutTimer);
          turnTimeoutTimer = null;
        }
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        if (signal) {
          signal.removeEventListener('abort', handleAbort);
        }
      };

      const settle = (result) => {
        if (settled) return;
        settled = true;
        cleanupSignal();
        entry.busy = false;
        entry.activeTurn = null;
        resolve(result);
      };

      const rejectTurn = (err) => {
        if (settled) return;
        settled = true;
        cleanupSignal();
        entry.busy = false;
        entry.activeTurn = null;
        reject(err);
      };

      const handleAbort = () => {
        if (!entry.activeTurn) return;
        entry.activeTurn.aborted = true;
        if (isChildAlive(entry.child)) {
          killChildTree(entry.child, 'SIGTERM', entry.useDetached);
          killTimer = setTimeout(() => {
            if (isChildAlive(entry.child)) {
              killChildTree(entry.child, 'SIGKILL', entry.useDetached);
            }
          }, 3000);
          killTimer.unref?.();
        }
      };

      const effectiveTurnTimeoutSec = Number(timeoutSeconds);
      if (Number.isFinite(effectiveTurnTimeoutSec) && effectiveTurnTimeoutSec > 0) {
        turnTimeoutTimer = setTimeout(() => {
          handleAbort();
        }, effectiveTurnTimeoutSec * 1000);
        turnTimeoutTimer.unref?.();
      }

      entry.activeTurn = {
        startedAt: Date.now(),
        resolvedConvId: conversationId || entry.conversationId || '',
        accumulatedText: '',
        toolsUsed: [],
        aborted: false,
        onEvent,
        settle,
        reject: rejectTurn,
      };

      if (signal) {
        if (signal.aborted) {
          handleAbort();
        } else {
          signal.addEventListener('abort', handleAbort, { once: true });
        }
      }

      try {
        entry.child.stdin.write(buildAgyStreamInputLine(prompt));
      } catch (err) {
        release(runKey);
        rejectTurn(err);
      }
    });
  };

  return {
    runTurn,
    release,
    disposeAll,
    has,
    size,
    getInfo,
    getMeta,
    updateMeta,
    setOnAsyncEvent,
  };
}
