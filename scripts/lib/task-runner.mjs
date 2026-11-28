import fs from 'node:fs';
import path from 'node:path';
import { updateState } from './config.mjs';
import { buildCard, chunkButtons, replyCard } from './feishu-api.mjs';
import { isSafeCliConversationId, runAgyTurn } from './agy-runner.mjs';
import { getGeminiRoot } from './desktop-sessions.mjs';
import {
  ASYNC_ORCHESTRATION_TOOLS,
  createAgySessionPool,
  isAsyncWorkflowPrompt,
} from './agy-session-pool.mjs';
import {
  addMessageReaction,
  createStreamingCardSession,
  removeMessageReaction,
} from './cardkit-stream.mjs';
import {
  enforceTempFullExpiry,
  getOrCreateChatState,
  makeSessionKey,
  recordRecentConversation,
  resolveEffectiveTimeoutSeconds,
  sendCardToTarget,
} from './bridge-helpers.mjs';
import { checkOriginDesktopDrift } from './mobile-handoff.mjs';
import {
  detectTurnCommandBoard,
  hasAsyncSessionActivity,
  hasRunningChildSubagents,
} from './command-boards.mjs';

const FILE_MODIFY_TOOL_RE = /^(?:write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|create_file|apply_patch|notebook_edit)$/i;
const PERMISSION_DENIED_RE = /permission check failed|user denied permission|permission denied to run|requires approval|not allowed in (?:accept-edits|plan) mode/i;

export function isExplicitFailureStatus(status) {
  const normalized = String(status || '').trim().toUpperCase();
  return Boolean(normalized && normalized !== 'SUCCESS' && normalized !== 'OK');
}

export function isPermissionDeniedError(text) {
  return PERMISSION_DENIED_RE.test(String(text || ''));
}

function extractCommandArgFromToolCall(toolCall) {
  let args = toolCall?.args;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = null;
    }
  }
  const raw = args?.CommandLine || args?.command || '';
  return String(raw || '').replace(/^"|"$/g, '').trim();
}

function matchToolCallForError(toolCalls, errorText) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { toolName: '', commandLine: '' };
  }
  const errLower = String(errorText || '').toLowerCase();
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    const tc = toolCalls[i];
    const cmdLine = extractCommandArgFromToolCall(tc);
    if (cmdLine && errLower.includes(cmdLine.toLowerCase().slice(0, 40))) {
      return { toolName: String(tc?.name || ''), commandLine: cmdLine };
    }
  }
  const lastNonMeta = [...toolCalls].reverse().find((tc) => tc?.name && tc.name !== 'update_steps') || toolCalls[toolCalls.length - 1];
  return {
    toolName: String(lastNonMeta?.name || ''),
    commandLine: extractCommandArgFromToolCall(lastNonMeta),
  };
}

/**
 * Inspect the trailing turn of a conversation's transcript.jsonl for an unrecovered error.
 * Stops scanning backwards at the most recent PLANNER_RESPONSE or USER_INPUT boundary so earlier
 * recovered tool errors (e.g. probing a non-existent file) are never surfaced.
 */
export function inspectTranscriptLastTurnError(conversationId) {
  if (!isSafeCliConversationId(conversationId)) return null;
  const transcriptPath = path.join(
    getGeminiRoot(),
    'antigravity-cli',
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
  let tailText = '';
  let fd = null;
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size <= 0) return null;
    const readBytes = Math.min(stat.size, 65_536);
    const offset = Math.max(0, stat.size - readBytes);
    const buf = Buffer.alloc(readBytes);
    fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buf, 0, readBytes, offset);
    tailText = buf.toString('utf8');
    if (offset > 0) {
      const firstNl = tailText.indexOf('\n');
      tailText = firstNl >= 0 ? tailText.slice(firstNl + 1) : '';
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore
      }
    }
  }

  const lines = tailText.split(/\r?\n/).filter((l) => l.trim());
  let trailingError = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const entryType = String(entry?.type || '').toUpperCase();
    const entryStatus = String(entry?.status || '').toUpperCase();
    if (entryType === 'USER_INPUT') {
      break;
    }
    if (entryType === 'PLANNER_RESPONSE') {
      if (trailingError) {
        const matched = matchToolCallForError(entry.tool_calls, trailingError.error);
        return {
          error: trailingError.error,
          toolName: matched.toolName,
          commandLine: matched.commandLine,
          stepIndex: trailingError.stepIndex,
        };
      }
      if (entryStatus === 'ERROR' && entry.error) {
        return {
          error: String(entry.error).trim(),
          toolName: '',
          commandLine: '',
          stepIndex: entry.step_index ?? null,
        };
      }
      return null;
    }
    if (!trailingError && entryStatus === 'ERROR') {
      const errMsg = String(entry.error || entry.content || '').trim();
      if (errMsg) {
        trailingError = {
          error: errMsg,
          stepIndex: entry.step_index ?? null,
        };
      }
    }
  }

  if (trailingError) {
    return {
      error: trailingError.error,
      toolName: '',
      commandLine: '',
      stepIndex: trailingError.stepIndex,
    };
  }
  return null;
}

export function resolvePromptWithHandoff(text, pendingHandoff) {
  return pendingHandoff?.contextBlock
    ? `${pendingHandoff.contextBlock}\n\n${text}`
    : text;
}

export function shouldClearPendingHandoff({ hadConversationId, result } = {}) {
  if (!hadConversationId) {
    return Boolean(result?.conversationId);
  }
  return !result?.aborted && !isExplicitFailureStatus(result?.status) && result?.exitCode === 0;
}

export function extractModifiedFilePath(toolName, parameters, cwd = '') {
  if (!FILE_MODIFY_TOOL_RE.test(String(toolName || '').trim())) {
    return '';
  }
  if (!parameters || typeof parameters !== 'object') {
    return '';
  }
  const raw =
    parameters.Path ||
    parameters.TargetFile ||
    parameters.path ||
    parameters.file_path ||
    parameters.target_file ||
    parameters.FilePath ||
    '';
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd || process.cwd(), trimmed);
}

export function formatToolStatusMarkdown({
  cwd,
  mode,
  effort = '',
  isTempFull = false,
  remainMin = 0,
  attachmentNote = '',
  toolEntries = [],
}) {
  const modeText = isTempFull ? `\`full\`（⏱️ 临时约 ${remainMin}m）` : `\`${mode}\``;
  const effortSegment = effort ? ` · 🎛️ \`${effort}\`` : '';
  const lines = [`📂 \`${cwd}\` · 🛡️ ${modeText}${effortSegment}`];
  if (attachmentNote) {
    lines.push(attachmentNote);
  }
  if (toolEntries.length > 0) {
    lines.push('', '**执行步骤：**');
    for (const entry of toolEntries.slice(-6)) {
      const icon = entry.failed ? '❌' : entry.done ? '✅' : '🔧';
      const safeSummary = entry.summary
        ? String(entry.summary).replace(/\s+/g, ' ').replace(/`/g, "'").trim()
        : '';
      const detail = safeSummary ? ` \`${safeSummary}\`` : '';
      const dur = entry.done
        ? ` (${entry.durationSeconds ? `${entry.durationSeconds.toFixed(1)}s` : 'done'})`
        : '...';
      lines.push(`- ${icon} \`${entry.toolName}\`${detail}${dur}`);
    }
  }
  return lines.join('\n');
}

export function formatTokenCount(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return '';
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(Math.round(num));
}

export function formatUsageSummary(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? 0);
  const total = Number(usage.total_tokens ?? usage.totalTokens ?? (input + output || 0));
  if (!Number.isFinite(total) || total <= 0) return '';
  const totalStr = formatTokenCount(total);
  if (input > 0 && output > 0) {
    return `Token ${totalStr} (${formatTokenCount(input)}→${formatTokenCount(output)})`;
  }
  return `Token ${totalStr}`;
}

export function sanitizeRetryPayload(payload) {
  const { queueReactionId: _ignored, ...rest } = payload;
  return { ...rest, queueReactionId: '' };
}

export function isTransientStartupRace(result) {
  if (!result || result.aborted || (!isExplicitFailureStatus(result.status) && result.exitCode === 0)) {
    return false;
  }
  if (result.conversationId) return false;
  const text = `${result.stderr || ''}\n${result.finishedReason || ''}\n${result.response || ''}`;
  return /failed to start conversation|initialized by another opener|empty conversation id/i.test(text);
}

function getMaxConcurrent(config) {
  const n = Number(config?.agy?.maxConcurrentRuns || 4);
  if (!Number.isFinite(n) || n < 1) return 4;
  return Math.max(1, Math.min(10, Math.floor(n)));
}

function recordLastTask(lastTaskByChat, runKey, payload) {
  if (!lastTaskByChat || !runKey) return;
  if (lastTaskByChat.has(runKey)) {
    lastTaskByChat.delete(runKey);
  }
  while (lastTaskByChat.size >= 200) {
    const oldest = lastTaskByChat.keys().next().value;
    if (oldest === undefined) break;
    lastTaskByChat.delete(oldest);
  }
  lastTaskByChat.set(runKey, payload);
}

export function createTaskRunner({
  client,
  activeRuns,
  chatQueues,
  lastTaskByChat,
  recordCardThread = () => {},
  sessionPool: providedPool = null,
}) {
  const sessionPool = providedPool || createAgySessionPool();
  const asyncStreamStates = new Map();

  const handleAsyncSessionEvent = ({ type, runKey, entry, evt, result }) => {
    let stateEntry = asyncStreamStates.get(runKey);
    if (!stateEntry) {
      stateEntry = {
        chain: Promise.resolve(),
        session: null,
        toolEntries: [],
        liveText: '',
        lastTextStepIndex: null,
        startedAt: Date.now(),
      };
      asyncStreamStates.set(runKey, stateEntry);
    }

    const meta = entry?.meta || {};
    const cfg = meta.config || {};
    const chatId = meta.chatId || '';
    const openId = meta.openId || '';
    const threadRootId = meta.threadRootId || '';
    const replyInThread = Boolean(meta.replyInThread && threadRootId);

    stateEntry.chain = stateEntry.chain.then(async () => {
      const refreshAsyncStatus = () => {
        if (!stateEntry.session) return;
        stateEntry.session.updateStatus(
          formatToolStatusMarkdown({
            cwd: entry?.signature?.cwd || process.cwd(),
            mode: entry?.signature?.mode || 'auto',
            effort: entry?.signature?.effort || '',
            attachmentNote: '🔔 来自后台子代理 / 定时器的异步回信',
            toolEntries: stateEntry.toolEntries,
          }),
        );
      };

      if (type === 'start') {
        stateEntry.toolEntries = [];
        stateEntry.liveText = '';
        stateEntry.lastTextStepIndex = null;
        stateEntry.startedAt = Date.now();
        stateEntry.session = await createStreamingCardSession(client, {
          replyTargetMessageId: threadRootId,
          replyInThread,
          chatId,
          openId,
          title: '🔔 后台协作 / 定时任务有新进展',
          template: 'wathet',
          initialStatus: formatToolStatusMarkdown({
            cwd: entry?.signature?.cwd || process.cwd(),
            mode: entry?.signature?.mode || 'auto',
            effort: entry?.signature?.effort || '',
            attachmentNote: '🔔 来自后台子代理 / 定时器的异步回信',
            toolEntries: [],
          }),
          initialStream: '_正在整理异步进展..._',
          footer: '🟢 后台保活监听中',
          stopButton: false,
        });
        if (threadRootId && stateEntry.session?.replyMessageId) {
          recordCardThread(stateEntry.session.replyMessageId, {
            sessionKey: runKey,
            threadRootId,
            chatId,
          });
        }
      }

      if (type === 'start' || type === 'event') {
        if (!evt) return;
        if (evt.kind === 'tool_start') {
          stateEntry.toolEntries.push({
            stepIndex: evt.stepIndex,
            toolName: evt.toolName,
            summary: evt.summary || '',
            done: false,
            durationSeconds: null,
          });
          refreshAsyncStatus();
        } else if (evt.kind === 'tool_done' || evt.kind === 'tool_error') {
          const target = [...stateEntry.toolEntries].reverse().find(
            (e) => !e.done && (e.stepIndex === evt.stepIndex || e.toolName === evt.toolName),
          );
          if (target) {
            target.done = true;
            if (evt.kind === 'tool_error') target.failed = true;
            target.durationSeconds = evt.durationSeconds ?? null;
          }
          refreshAsyncStatus();
        } else if (evt.kind === 'text_delta') {
          if (
            stateEntry.lastTextStepIndex !== null &&
            evt.stepIndex !== stateEntry.lastTextStepIndex &&
            stateEntry.liveText.trim() &&
            !stateEntry.liveText.endsWith('\n')
          ) {
            stateEntry.liveText += '\n\n';
          }
          stateEntry.lastTextStepIndex = evt.stepIndex;
          stateEntry.liveText += evt.textDelta;
          stateEntry.session?.updateStream(stateEntry.liveText);
        }
        return;
      }

      if (type === 'result' && result) {
        const isFailed = isExplicitFailureStatus(result.status) || result.exitCode !== 0;
        const convId = result.conversationId || entry?.conversationId || '';
        const stillRunningBackground = !isFailed && Boolean(convId && hasRunningChildSubagents(convId));
        const errDetail = result.stderr || result.error || result.finishedReason || `exit code ${result.exitCode}`;
        const body = isFailed
          ? (result.response ? `${result.response}\n\n---\n**错误信息：**\n\`\`\`\n${errDetail}\n\`\`\`` : `\`\`\`\n${errDetail}\n\`\`\``)
          : (result.response || stateEntry.liveText.trim() || '_（后台协作唤醒完成，无附加文本输出）_');
        const elapsedSec = ((Date.now() - stateEntry.startedAt) / 1000).toFixed(1);
        const isParked = sessionPool.has(runKey);
        const footerParts = [`耗时 ${elapsedSec}s`];
        if (result.toolsUsed?.length > 0) footerParts.push(`工具 ${result.toolsUsed.length} 次`);
        const usageText = formatUsageSummary(result.usage);
        if (usageText) footerParts.push(usageText);
        if (isParked) footerParts.push('🟢 后台保活中');
        if (result.conversationId) footerParts.push(`会话 ${result.conversationId.slice(0, 8)}`);

        const buttons = [
          { label: '🐝 Swarm 看板', value: { cmd: 'cmd_board', board: 'swarm' } },
          ...(isParked ? [{ label: '🔌 释放保活', value: { cmd: 'stop_keepalive' } }] : []),
          { label: '⚙️ 控制面板', value: { cmd: 'panel' } },
        ];
        const cardTitle = isFailed
          ? '❌ 后台协作异常'
          : stillRunningBackground
            ? '🔄 后台协作新进展（进行中）'
            : '✅ 后台协作新进展（已完成）';
        const cardTemplate = isFailed ? 'red' : stillRunningBackground ? 'wathet' : 'green';
        let sentIds = [];
        if (stateEntry.session) {
          sentIds = await stateEntry.session.finish({
            title: cardTitle,
            template: cardTemplate,
            markdown: body,
            footer: footerParts.join(' · '),
            buttonRows: chunkButtons(buttons, 3),
            chatId,
            openId,
            replyTargetMessageId: threadRootId,
            replyInThread,
          });
          if (threadRootId && Array.isArray(sentIds)) {
            for (const msgId of sentIds) {
              if (msgId) {
                recordCardThread(msgId, { sessionKey: runKey, threadRootId, chatId });
              }
            }
          }
        }
        const latestMeta = sessionPool.getMeta(runKey);
        const pendingUserMessageId = String(latestMeta.pendingUserMessageId || meta.pendingUserMessageId || '');
        const pendingReactionId = String(latestMeta.pendingReactionId || meta.pendingReactionId || '');
        if (isFailed) {
          if (pendingUserMessageId && pendingReactionId) {
            void removeMessageReaction(client, { messageId: pendingUserMessageId, reactionId: pendingReactionId });
          }
          sessionPool.updateMeta(runKey, { pendingUserMessageId: '', pendingReactionId: '' });
        } else if (!stillRunningBackground) {
          if (pendingUserMessageId) {
            sessionPool.updateMeta(runKey, { pendingUserMessageId: '', pendingReactionId: '' });
            if (pendingReactionId) {
              await removeMessageReaction(client, { messageId: pendingUserMessageId, reactionId: pendingReactionId });
            }
            void addMessageReaction(client, { messageId: pendingUserMessageId, emojiType: 'DONE' });
          } else if (Array.isArray(sentIds) && sentIds.length > 0) {
            void addMessageReaction(client, { messageId: sentIds.at(-1), emojiType: 'DONE' });
          }
        }
        asyncStreamStates.delete(runKey);
      }
    }).catch((err) => {
      console.error('[feishu-remote] async stream card error:', err);
      if (type === 'result') {
        asyncStreamStates.delete(runKey);
      }
    });
  };

  sessionPool.setOnAsyncEvent(handleAsyncSessionEvent);

  const getQueueForChat = (runKey) => {
    if (!runKey) return [];
    return chatQueues.get(runKey) || [];
  };

  const totalQueuedCount = () => {
    let total = 0;
    for (const list of chatQueues.values()) {
      total += list.length;
    }
    return total;
  };

  const reserveActiveSlot = (runKey, preview = '') => {
    const controller = new AbortController();
    const startedAt = Date.now();
    activeRuns.set(runKey, {
      controller,
      promptPreview: String(preview || '').slice(0, 60),
      startedAt,
      pending: true,
    });
    return { controller, startedAt };
  };

  const safeExecute = (payload, slot) => {
    void executePrompt(payload, slot).catch((err) => {
      console.error('[feishu-remote] executePrompt fatal catch:', err);
    });
  };

  const scheduleNextQueuedRun = (targetKey, nextItem) => {
    const preview = nextItem?.payload?.displayPreview || nextItem?.payload?.text || '';
    const slot = reserveActiveSlot(targetKey, preview);
    const timer = setTimeout(() => {
      if (slot.controller.signal.aborted) {
        if (activeRuns.get(targetKey)?.controller === slot.controller) {
          activeRuns.delete(targetKey);
        }
        return;
      }
      safeExecute(nextItem.payload, slot);
    }, 150);
    timer.unref?.();
  };

  const executePrompt = async (
    {
      text,
      displayPreview = '',
      attachmentNote = '',
      chatId = '',
      openId = '',
      messageId = '',
      sessionKey = '',
      threadRootId = '',
      replyInThread = false,
      queueReactionId = '',
      config,
    },
    preAllocatedSlot = null,
  ) => {
    const runKey = sessionKey || makeSessionKey(chatId, threadRootId) || chatId || openId;
    const replyTarget = threadRootId || messageId;
    const summaryText = displayPreview || text;

    const slot = preAllocatedSlot || reserveActiveSlot(runKey, summaryText);
    const controller = slot.controller;
    const runStartedAt = slot.startedAt;
    activeRuns.set(runKey, {
      controller,
      promptPreview: summaryText.slice(0, 60),
      startedAt: runStartedAt,
      pending: false,
    });

    let chatState = {
      cwd: config?.agy?.defaultCwd || process.cwd(),
      mode: config?.agy?.defaultMode || 'auto',
      effort: config?.agy?.defaultEffort || '',
      model: config?.agy?.defaultModel || '',
      conversationId: '',
      fullExpiresAt: 0,
    };
    let streamSession = null;

    try {
      let expiredTempFull = false;
      updateState((state) => {
        const latestChat = getOrCreateChatState(state, runKey, config);
        const exp = enforceTempFullExpiry(state, latestChat);
        if (exp.expired) {
          latestChat.persistentSession = false;
          expiredTempFull = true;
        }
        chatState = { ...latestChat };
      });
      if (expiredTempFull) {
        sessionPool.release(runKey, { immediate: true });
      }
      const pendingHandoff = chatState.pendingHandoff || null;
      const hadConversationId = Boolean(chatState.conversationId);

      const promptToRun = resolvePromptWithHandoff(text, pendingHandoff);

      recordLastTask(
        lastTaskByChat,
        runKey,
        sanitizeRetryPayload({
          text,
          displayPreview,
          attachmentNote,
          chatId,
          openId,
          messageId,
          sessionKey: runKey,
          threadRootId,
          replyInThread,
          config,
        }),
      );

      if (queueReactionId && messageId) {
        void removeMessageReaction(client, { messageId, reactionId: queueReactionId });
      }

      const isTempFull = chatState.mode === 'full' && Number(chatState.fullExpiresAt || 0) > Date.now();
      const remainMin = isTempFull ? Math.max(1, Math.ceil((chatState.fullExpiresAt - Date.now()) / 60000)) : 0;
      const effectiveEffort = chatState.effort || config?.agy?.defaultEffort || '';
      const toolEntries = [];
      const modifiedFilesSet = new Set();
      let liveText = '';
      let lastTextStepIndex = null;

      const initialStatus = formatToolStatusMarkdown({
        cwd: chatState.cwd,
        mode: chatState.mode,
        effort: effectiveEffort,
        isTempFull,
        remainMin,
        attachmentNote,
        toolEntries,
      });

      const usePersistent = Boolean(
        sessionPool.has(runKey) ||
        chatState.persistentSession ||
        isAsyncWorkflowPrompt(text) ||
        hasAsyncSessionActivity(chatState.conversationId),
      );

      streamSession = await createStreamingCardSession(client, {
        messageId,
        replyTargetMessageId: replyTarget,
        replyInThread,
        chatId,
        openId,
        title: '⏳ Antigravity 正在处理...',
        template: 'blue',
        initialStatus,
        initialStream: '_正在等待模型响应..._',
        footer: '点下方按钮或发送 /stop 可中止',
        stopButton: true,
        extraButtons: usePersistent
          ? [{ label: '🐝 看团队进度', value: { cmd: 'cmd_board', board: 'swarm' } }]
          : [],
      });
      if (threadRootId && streamSession.replyMessageId) {
        recordCardThread(streamSession.replyMessageId, {
          sessionKey: runKey,
          threadRootId,
          chatId,
        });
      }

      let actualEffort = effectiveEffort;
      let effortFallbackUsed = false;

      const refreshStatus = () => {
        streamSession.updateStatus(
          formatToolStatusMarkdown({
            cwd: chatState.cwd,
            mode: chatState.mode,
            effort: actualEffort,
            isTempFull,
            remainMin,
            attachmentNote: pendingHandoff?.title
              ? `${attachmentNote ? `${attachmentNote} · ` : ''}已注入电脑端上下文（${pendingHandoff.title.slice(0, 20)}）`
              : attachmentNote,
            toolEntries,
          }),
        );
      };

      const bridgeMeta = {
        chatId,
        openId,
        sessionKey: runKey,
        threadRootId,
        mode: chatState.mode,
      };
      const handleTurnEvent = (evt) => {
        if (evt.kind === 'tool_start') {
          const modifiedPath = extractModifiedFilePath(evt.toolName, evt.parameters, chatState.cwd);
          if (modifiedPath) {
            modifiedFilesSet.add(modifiedPath);
          }
          toolEntries.push({
            stepIndex: evt.stepIndex,
            toolName: evt.toolName,
            summary: evt.summary || '',
            done: false,
            durationSeconds: null,
          });
          refreshStatus();
        } else if (evt.kind === 'tool_done' || evt.kind === 'tool_error') {
          let target = null;
          for (let i = toolEntries.length - 1; i >= 0; i -= 1) {
            const candidate = toolEntries[i];
            if (candidate.stepIndex === evt.stepIndex && !candidate.done) {
              target = candidate;
              break;
            }
          }
          if (!target) {
            for (let i = toolEntries.length - 1; i >= 0; i -= 1) {
              if (!toolEntries[i].done && toolEntries[i].toolName === evt.toolName) {
                target = toolEntries[i];
                break;
              }
            }
          }
          if (target) {
            target.done = true;
            if (evt.kind === 'tool_error') target.failed = true;
            target.durationSeconds = evt.durationSeconds ?? null;
          } else {
            toolEntries.push({
              stepIndex: evt.stepIndex,
              toolName: evt.toolName,
              summary: evt.summary || '',
              done: true,
              failed: evt.kind === 'tool_error',
              durationSeconds: evt.durationSeconds ?? null,
            });
          }
          refreshStatus();
        } else if (evt.kind === 'text_delta') {
          if (
            lastTextStepIndex !== null &&
            evt.stepIndex !== lastTextStepIndex &&
            liveText.trim() &&
            !liveText.endsWith('\n')
          ) {
            liveText += '\n\n';
          }
          lastTextStepIndex = evt.stepIndex;
          liveText += evt.textDelta;
          streamSession.updateStream(liveText);
        }
      };

      const effectiveTimeoutSeconds = resolveEffectiveTimeoutSeconds(chatState, config);
      const effectiveConfig = effectiveTimeoutSeconds === (config?.agy?.timeoutSeconds ?? 3600)
        ? config
        : { ...config, agy: { ...(config?.agy || {}), timeoutSeconds: effectiveTimeoutSeconds } };

      const executeAttempt = (effortValue) => {
        if (usePersistent) {
          return sessionPool.runTurn({
            runKey,
            prompt: promptToRun,
            cwd: chatState.cwd,
            conversationId: chatState.conversationId,
            mode: chatState.mode,
            model: chatState.model,
            effort: effortValue,
            timeoutSeconds: effectiveTimeoutSeconds,
            config: effectiveConfig,
            bridgeMeta,
            meta: {
              chatId,
              openId,
              sessionKey: runKey,
              threadRootId,
              replyInThread,
              config: effectiveConfig,
            },
            signal: controller.signal,
            onEvent: handleTurnEvent,
          });
        }
        return runAgyTurn({
          prompt: promptToRun,
          cwd: chatState.cwd,
          conversationId: chatState.conversationId,
          mode: chatState.mode,
          model: chatState.model,
          effort: effortValue,
          config: effectiveConfig,
          bridgeMeta,
          signal: controller.signal,
          onEvent: handleTurnEvent,
        });
      };

      let result = await executeAttempt(actualEffort);
      const attemptErrText = `${result.stderr || ''}\n${result.finishedReason || ''}\n${result.response || ''}`;
      if (
        actualEffort &&
        !result.aborted &&
        result.status !== 'SUCCESS' &&
        result.exitCode !== 0 &&
        /--effort is not supported|invalid model selection/i.test(attemptErrText)
      ) {
        actualEffort = '';
        effortFallbackUsed = true;
        liveText = '';
        lastTextStepIndex = null;
        toolEntries.length = 0;
        modifiedFilesSet.clear();
        streamSession.updateStream('_当前模型不支持指定推理强度，已自动回退 default 强度重试..._');
        refreshStatus();
        result = await executeAttempt('');
      }

      if (isTransientStartupRace(result) && !controller.signal.aborted) {
        liveText = '';
        lastTextStepIndex = null;
        toolEntries.length = 0;
        modifiedFilesSet.clear();
        streamSession.updateStream('_检测到会话初始化瞬时冲突，1 秒后自动重试..._');
        refreshStatus();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!controller.signal.aborted) {
          result = await executeAttempt(actualEffort);
        }
      }

      const modifiedFiles = [...modifiedFilesSet].slice(0, 12);
      const driftPreview = chatState.originDesktopSession?.id
        ? checkOriginDesktopDrift(chatState.originDesktopSession)
        : { drifted: false, running: false, detail: null, newSteps: 0 };
      const usedAsyncTools = Array.isArray(result.toolsUsed) &&
        result.toolsUsed.some((t) => ASYNC_ORCHESTRATION_TOOLS.has(String(t || '').toLowerCase()));

      let freshChat = { ...chatState };
      updateState((freshState) => {
        const target = getOrCreateChatState(freshState, runKey, config);
        if (pendingHandoff && shouldClearPendingHandoff({ hadConversationId, result })) {
          target.pendingHandoff = null;
        }
        if (result.conversationId) {
          target.conversationId = result.conversationId;
          recordRecentConversation(target, result.conversationId, summaryText, {
            cwd: target.cwd,
            originDesktopId: target.originDesktopSession?.id || '',
            originDesktopTitle: target.originDesktopSession?.title || '',
          });
        }
        if (modifiedFiles.length > 0) {
          target.lastTurnArtifacts = {
            conversationId: result.conversationId || target.conversationId || '',
            cwd: target.cwd,
            files: modifiedFiles,
            updatedAt: Date.now(),
          };
        }
        if (driftPreview.drifted && driftPreview.detail && target.originDesktopSession) {
          target.originDesktopSession.lastNotifiedModifiedMs = Math.max(
            Number(target.originDesktopSession.lastNotifiedModifiedMs || 0),
            Number(driftPreview.detail.lastModifiedMs || 0),
          );
          target.originDesktopSession.lastNotifiedStepCount = Math.max(
            Number(target.originDesktopSession.lastNotifiedStepCount || 0),
            Number(driftPreview.detail.stepCount || 0),
          );
        }
        if ((usedAsyncTools || isAsyncWorkflowPrompt(text)) && !target.persistentSession) {
          target.persistentSession = true;
        }
        freshChat = { ...target };
      });
      const drift = driftPreview;

      const isParkedAlive = sessionPool.has(runKey);
      const totalSec = Math.max(0, (Date.now() - runStartedAt) / 1000).toFixed(1);
      const shortConv = result.conversationId ? result.conversationId.slice(0, 8) : '-';
      const workspaceName = path.basename(freshChat.cwd) || freshChat.cwd;
      const footerParts = [`耗时 ${totalSec}s`];
      if (result.toolsUsed.length > 0) {
        footerParts.push(`工具 ${result.toolsUsed.length} 次`);
      }
      const usageText = formatUsageSummary(result.usage);
      if (usageText) {
        footerParts.push(usageText);
      }
      footerParts.push(`模式 ${freshChat.mode}`);
      if (actualEffort) {
        footerParts.push(`强度 ${actualEffort}`);
      } else if (effortFallbackUsed) {
        footerParts.push('强度 default(不支持已自动回退)');
      }
      if (isParkedAlive && !result.aborted) {
        footerParts.push('🟢 后台保活中');
      }
      footerParts.push(`目录 ${workspaceName}`, `会话 ${shortConv}`);

      let title = '✅ Antigravity 已完成';
      let template = 'green';
      let body = result.response;
      let isFailed = false;
      let isPermissionBlocked = false;
      const isHardFailed = isExplicitFailureStatus(result.status) || result.exitCode !== 0;

      if (result.aborted) {
        title = '🛑 任务已中止';
        template = 'grey';
        body = result.response || '任务已被用户中止。';
        isFailed = true;
      } else if (isHardFailed || !body) {
        const lastToolErr = Array.isArray(result.toolErrors) && result.toolErrors.length > 0
          ? result.toolErrors[result.toolErrors.length - 1]
          : null;
        const toolErrText = lastToolErr
          ? [
              lastToolErr.toolName ? `[${lastToolErr.toolName}]` : '',
              lastToolErr.summary || '',
              lastToolErr.error || '',
            ].filter(Boolean).join(' ')
          : '';
        let diagText = String(result.stderr || result.error || result.finishedReason || toolErrText || '').trim();
        let transcriptErr = null;
        if (!diagText) {
          transcriptErr = inspectTranscriptLastTurnError(result.conversationId || freshChat.conversationId);
          if (transcriptErr?.error) {
            diagText = transcriptErr.error;
          }
        }
        const trimmedDiag = diagText.length > 500 ? `${diagText.slice(0, 497)}...` : diagText;

        if (diagText && isPermissionDeniedError(diagText)) {
          isPermissionBlocked = true;
          isFailed = true;
          title = '⚠️ 执行在权限检查处中断';
          template = 'orange';
          const detailParts = [
            `当前会话处于 \`${freshChat.mode}\` 模式，飞书无头模式无法弹出终端确认，命令被系统权限检查自动拦截，导致本轮提前中止。`,
          ];
          if (transcriptErr?.commandLine) {
            detailParts.push('', `**被拦截命令：** \`${transcriptErr.commandLine}\``);
          }
          detailParts.push('', '**中断详情：**', '```', trimmedDiag, '```');
          if (modifiedFiles.length > 0) {
            detailParts.push(
              '',
              `✅ 中断前已完成 **${modifiedFiles.length} 个文件** 的修改（改动已保留，无需重写），切到 \`auto\` 或 \`full\` 模式后继续验证即可。`,
            );
          }
          const diagBlock = detailParts.join('\n');
          body = result.response ? `${result.response}\n\n---\n${diagBlock}` : diagBlock;
        } else if (isHardFailed) {
          title = '❌ 执行异常';
          template = 'red';
          isFailed = true;
          const errDetail = trimmedDiag || `exit code ${result.exitCode}`;
          body = result.response
            ? `${result.response}\n\n---\n**错误信息：**\n\`\`\`\n${errDetail}\n\`\`\``
            : `\`\`\`\n${errDetail}\n\`\`\``;
        } else if (trimmedDiag) {
          title = '⚠️ 本轮未输出文本回复';
          template = 'orange';
          isFailed = true;
          const warnParts = [
            '本轮执行未生成最终文本回复，最后一步存在异常退出记录：',
            '```',
            trimmedDiag,
            '```',
          ];
          if (modifiedFiles.length > 0) {
            warnParts.push('', `> 提示：中断前已完成 **${modifiedFiles.length} 个文件** 的修改，可点击「🔍 看改动 Diff」或「🔄 重试」。`);
          }
          body = warnParts.join('\n');
        } else {
          body = modifiedFiles.length > 0
            ? `_（本次执行已完成 ${modifiedFiles.length} 个文件改动，模型未附带额外文本总结）_`
            : '_（本次执行没有输出文本回复）_';
        }
      } else if (isParkedAlive && usedAsyncTools) {
        const usedSubagentTools = result.toolsUsed.some((t) =>
          ['send_message', 'invoke_subagent', 'swarm', 'run_workflow'].includes(String(t || '').toLowerCase()),
        );
        if (usedSubagentTools) {
          title = '⏳ 已派发后台协作（保活等待中）';
          template = 'wathet';
        } else if (result.toolsUsed.some((t) => String(t || '').toLowerCase() === 'schedule')) {
          title = '⏰ 定时任务已就绪（保活中）';
          template = 'wathet';
        }
      }

      if (drift.drifted) {
        const stepNote = drift.newSteps > 0 ? `（+${drift.newSteps} 步）` : '';
        body += `\n\n---\n> ⚠️ 检测到原电脑端对话在你接管后有新进展${stepNote}，可点击下方「🔄 同步电脑进展」增量同步。`;
      }

      const turnBoard = !result.aborted && !isFailed
        ? detectTurnCommandBoard(text, result.toolsUsed)
        : { kind: '' };

      const buttons = [
        ...(turnBoard.kind === 'plan'
          ? [
              { label: '✅ 按计划执行', type: 'primary', value: { cmd: 'plan_decision', decision: 'approve' } },
              { label: '🧭 Plan 看板', value: { cmd: 'cmd_board', board: 'plan' } },
            ]
          : []),
        ...(turnBoard.kind === 'goal' ? [{ label: '🎯 Goal 看板', value: { cmd: 'cmd_board', board: 'goal' } }] : []),
        ...(turnBoard.kind === 'swarm' ? [{ label: '🐝 Swarm 看板', value: { cmd: 'cmd_board', board: 'swarm' } }] : []),
        ...(turnBoard.kind === 'schedule' ? [{ label: '⏰ 定时看板', value: { cmd: 'cmd_board', board: 'schedule' } }] : []),
        ...(isParkedAlive && !result.aborted ? [{ label: '🔌 释放保活', value: { cmd: 'stop_keepalive' } }] : []),
        ...(isPermissionBlocked && freshChat.mode !== 'auto'
          ? [{ label: '🤖 切自动模式', type: 'primary', value: { cmd: 'mode', arg: 'auto' } }]
          : []),
        ...(isPermissionBlocked && freshChat.mode !== 'full'
          ? [{ label: '⚡ 30m全权', value: { cmd: 'mode_temp_full', arg: '30' } }]
          : []),
        ...(isFailed ? [{ label: '🔄 重试', type: isPermissionBlocked ? 'default' : 'primary', value: { cmd: 'retry' } }] : []),
        ...(!result.aborted && modifiedFiles.length > 0
          ? [
              { label: '🔍 看改动 Diff', value: { cmd: 'turn_diff' } },
              modifiedFiles.length === 1
                ? { label: `📥 发到聊天：${path.basename(modifiedFiles[0]).slice(0, 12)}`, value: { cmd: 'turn_send_file', arg: '0' } }
                : { label: `📄 查看改动文件(${modifiedFiles.length})`, value: { cmd: 'turn_files' } },
            ]
          : []),
        ...(drift.drifted
          ? [{ label: '🔄 同步电脑进展', value: { cmd: 'desktop_sync_latest', arg: freshChat.originDesktopSession.id } }]
          : []),
        ...(freshChat.conversationId ? [{ label: '💻 交回电脑', value: { cmd: 'handoff' } }] : []),
        { label: '🆕 新对话', value: { cmd: 'new' } },
        { label: '⚙️ 控制面板', value: { cmd: 'panel' } },
        { label: '🗂️ 最近会话', value: { cmd: 'sessions' } },
      ];

      const finalConvId = result.conversationId || freshChat.conversationId || '';
      const isWaitingOnBackground = Boolean(
        isParkedAlive &&
        !result.aborted &&
        !isFailed &&
        (usedAsyncTools || (isAsyncWorkflowPrompt(text) && hasRunningChildSubagents(finalConvId))),
      );

      if (messageId && isWaitingOnBackground) {
        const prevMeta = sessionPool.getMeta(runKey);
        if (prevMeta?.pendingUserMessageId && prevMeta?.pendingReactionId && prevMeta.pendingUserMessageId !== messageId) {
          void removeMessageReaction(client, {
            messageId: prevMeta.pendingUserMessageId,
            reactionId: prevMeta.pendingReactionId,
          });
        }
        // Record pendingUserMessageId before asyncCard finish() resolves so fast async wakeups can still swap Typing -> DONE
        sessionPool.updateMeta(runKey, {
          pendingUserMessageId: messageId,
          pendingReactionId: '',
        });
        const typingReactionId = await addMessageReaction(client, {
          messageId,
          emojiType: 'Typing',
        });
        if (typingReactionId && sessionPool.getMeta(runKey)?.pendingUserMessageId === messageId) {
          sessionPool.updateMeta(runKey, {
            pendingUserMessageId: messageId,
            pendingReactionId: typingReactionId,
          });
        }
      }

      try {
        const sentIds = await streamSession.finish({
          title,
          template,
          markdown: body,
          footer: footerParts.join(' · '),
          buttonRows: chunkButtons(buttons, 3),
          chatId,
          openId,
          replyTargetMessageId: replyTarget,
          replyInThread,
        });
        if (threadRootId && Array.isArray(sentIds)) {
          for (const msgId of sentIds) {
            if (msgId) {
              recordCardThread(msgId, { sessionKey: runKey, threadRootId, chatId });
            }
          }
        }
      } catch (finishErr) {
        console.error('[feishu-remote] streamSession.finish error after turn completed:', finishErr);
      }

      if (messageId && !result.aborted && !isFailed && !isWaitingOnBackground) {
        void addMessageReaction(client, {
          messageId,
          emojiType: 'DONE',
        });
      }
    } catch (err) {
      console.error('[feishu-remote] executePrompt error:', err);
      const errButtons = chunkButtons([
        { label: '🔄 重试', type: 'primary', value: { cmd: 'retry' } },
        { label: '🆕 新对话', value: { cmd: 'new' } },
        { label: '⚙️ 控制面板', value: { cmd: 'panel' } },
        { label: '🧩 命令', value: { cmd: 'skills_menu' } },
      ], 2);
      const errFooter = `目录 ${path.basename(chatState.cwd) || chatState.cwd}`;
      if (streamSession) {
        try {
          const sentErrIds = await streamSession.finish({
            title: '❌ 调起 Antigravity 失败',
            template: 'red',
            markdown: String(err?.message || err),
            footer: errFooter,
            buttonRows: errButtons,
            chatId,
            openId,
            replyTargetMessageId: replyTarget,
            replyInThread,
          });
          if (threadRootId && Array.isArray(sentErrIds)) {
            for (const msgId of sentErrIds) {
              if (msgId) {
                recordCardThread(msgId, { sessionKey: runKey, threadRootId, chatId });
              }
            }
          }
        } catch (errFinish) {
          console.error('[feishu-remote] Failed to deliver executePrompt error card:', errFinish);
        }
      } else {
        try {
          const fallbackMsgId = await sendCardToTarget(client, {
            chatId,
            openId,
            replyToMessageId: replyTarget,
            replyInThread,
            card: buildCard({
              title: '❌ 调起 Antigravity 失败',
              template: 'red',
              markdown: String(err?.message || err),
              footer: errFooter,
              buttonRows: errButtons,
            }),
          });
          if (threadRootId && fallbackMsgId) {
            recordCardThread(fallbackMsgId, { sessionKey: runKey, threadRootId, chatId });
          }
        } catch (sendErr) {
          console.error('[feishu-remote] Failed to send fallback error card:', sendErr);
        }
      }
    } finally {
      if (activeRuns.get(runKey)?.controller === controller) {
        activeRuns.delete(runKey);
      }
      const maxConcurrent = getMaxConcurrent(config);
      if (activeRuns.size < maxConcurrent) {
        const queue = chatQueues.get(runKey);
        if (queue && queue.length > 0 && !activeRuns.has(runKey)) {
          const nextItem = queue.shift();
          if (queue.length === 0) {
            chatQueues.delete(runKey);
          }
          scheduleNextQueuedRun(runKey, nextItem);
        } else {
          for (const [otherKey, otherQueue] of chatQueues.entries()) {
            if (activeRuns.has(otherKey) || !Array.isArray(otherQueue) || otherQueue.length === 0) {
              continue;
            }
            const nextOther = otherQueue.shift();
            if (otherQueue.length === 0) {
              chatQueues.delete(otherKey);
            }
            scheduleNextQueuedRun(otherKey, nextOther);
            break;
          }
        }
      }
    }
  };

  const enqueueOrExecutePrompt = async (payload) => {
    const runKey =
      payload.sessionKey ||
      makeSessionKey(payload.chatId, payload.threadRootId) ||
      payload.chatId ||
      payload.openId;
    if (!runKey) return;

    const maxConcurrent = getMaxConcurrent(payload.config);
    const replyTarget = payload.threadRootId || payload.messageId;
    const replyInThread = Boolean(payload.replyInThread);

    if (!activeRuns.has(runKey) && activeRuns.size < maxConcurrent) {
      safeExecute({ ...payload, sessionKey: runKey });
      return;
    }

    const queue = getQueueForChat(runKey);
    if (queue.length >= 5) {
      const fullCard = buildCard({
        title: '⚠️ 任务队列已满（最多 5 条）',
        template: 'orange',
        markdown: '当前等待执行的任务已达上限，请先查看或清理队列后再发新任务。',
        buttonRows: [[
          { label: '📋 查看队列', value: { cmd: 'queue_list' } },
          { label: '🛑 中止当前任务', type: 'danger', value: { cmd: 'stop' } },
        ]],
      });
      try {
        let fullMsgId = '';
        if (replyTarget) {
          fullMsgId = await replyCard(client, { messageId: replyTarget, card: fullCard, replyInThread });
        } else {
          fullMsgId = await sendCardToTarget(client, { chatId: payload.chatId, openId: payload.openId, card: fullCard });
        }
        if (payload.threadRootId && fullMsgId) {
          recordCardThread(fullMsgId, { sessionKey: runKey, threadRootId: payload.threadRootId, chatId: payload.chatId });
        }
      } catch (err) {
        console.error('[feishu-remote] Failed to send queue-full card:', err?.message || err);
      }
      return;
    }

    const { buildQueuedCard } = await import('./feishu-api.mjs');
    const queueId = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const queueReactionId = '';
    const item = {
      id: queueId,
      queuedAt: Date.now(),
      payload: { ...payload, sessionKey: runKey, queueReactionId },
      queueMessageId: '',
    };
    queue.push(item);
    chatQueues.set(runKey, queue);

    const runningPreview = activeRuns.get(runKey)?.promptPreview ||
      (!activeRuns.has(runKey) ? `全局并行上限已满 (${activeRuns.size}/${maxConcurrent})` : '');
    const card = buildQueuedCard({
      position: queue.length,
      queueId,
      promptPreview: payload.displayPreview || payload.text,
      runningPreview,
    });
    try {
      item.queueMessageId = replyTarget
        ? await replyCard(client, { messageId: replyTarget, card, replyInThread })
        : await sendCardToTarget(client, { chatId: payload.chatId, openId: payload.openId, card });
      if (payload.threadRootId && item.queueMessageId) {
        recordCardThread(item.queueMessageId, {
          sessionKey: runKey,
          threadRootId: payload.threadRootId,
          chatId: payload.chatId,
        });
      }
    } catch (err) {
      console.error('[feishu-remote] Failed to send queued card:', err?.message || err);
    }
  };

  return {
    sessionPool,
    hasPersistentSession: (runKey) => sessionPool.has(runKey),
    releasePersistentSession: (runKey) => sessionPool.release(runKey),
    getQueueForChat,
    totalQueuedCount,
    enqueueOrExecutePrompt,
    executePrompt,
    canStartImmediately: (cfg) => activeRuns.size < getMaxConcurrent(cfg),
    startPromotedItem: (item) => {
      safeExecute(item?.payload || item);
    },
  };
}
