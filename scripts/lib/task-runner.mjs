import path from 'node:path';
import { loadState, saveState } from './config.mjs';
import { buildCard, replyCard } from './feishu-api.mjs';
import { runAgyTurn } from './agy-runner.mjs';
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
  sendCardToTarget,
} from './bridge-helpers.mjs';

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
      const icon = entry.done ? '✅' : '🔧';
      const detail = entry.summary ? ` \`${entry.summary}\`` : '';
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

function getMaxConcurrent(config) {
  const n = Number(config?.agy?.maxConcurrentRuns || 4);
  if (!Number.isFinite(n) || n < 1) return 4;
  return Math.max(1, Math.min(10, Math.floor(n)));
}

export function createTaskRunner({
  client,
  activeRuns,
  chatQueues,
  lastTaskByChat,
  recordCardThread = () => {},
}) {
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

  const executePrompt = async ({
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
  }) => {
    const runKey = sessionKey || makeSessionKey(chatId, threadRootId) || chatId || openId;
    const replyTarget = threadRootId || messageId;
    const summaryText = displayPreview || text;

    const state = loadState();
    const chatState = getOrCreateChatState(state, runKey, config);
    enforceTempFullExpiry(state, chatState);
    const pendingHandoff = chatState.pendingHandoff || null;
    if (pendingHandoff) {
      chatState.pendingHandoff = null;
    }
    saveState(state);

    const promptToRun = pendingHandoff?.contextBlock
      ? `${pendingHandoff.contextBlock}\n\n${text}`
      : text;

    lastTaskByChat.set(
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

    const controller = new AbortController();
    const runStartedAt = Date.now();
    activeRuns.set(runKey, {
      controller,
      promptPreview: summaryText.slice(0, 60),
      startedAt: runStartedAt,
    });

    const isTempFull = chatState.mode === 'full' && Number(chatState.fullExpiresAt || 0) > Date.now();
    const remainMin = isTempFull ? Math.max(1, Math.ceil((chatState.fullExpiresAt - Date.now()) / 60000)) : 0;
    const effectiveEffort = chatState.effort || config?.agy?.defaultEffort || '';
    const toolEntries = [];
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

    const streamSession = await createStreamingCardSession(client, {
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

    try {
      const executeAttempt = (effortValue) =>
        runAgyTurn({
          prompt: promptToRun,
          cwd: chatState.cwd,
          conversationId: chatState.conversationId,
          mode: chatState.mode,
          model: chatState.model,
          effort: effortValue,
          config,
          signal: controller.signal,
          onEvent: (evt) => {
            if (evt.kind === 'tool_start') {
              toolEntries.push({
                stepIndex: evt.stepIndex,
                toolName: evt.toolName,
                summary: evt.summary || '',
                done: false,
                durationSeconds: null,
              });
              refreshStatus();
            } else if (evt.kind === 'tool_done') {
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
                target.durationSeconds = evt.durationSeconds ?? null;
              } else {
                toolEntries.push({
                  stepIndex: evt.stepIndex,
                  toolName: evt.toolName,
                  summary: '',
                  done: true,
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
          },
        });

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
        streamSession.updateStream('_当前模型不支持指定推理强度，已自动回退 default 强度重试..._');
        refreshStatus();
        result = await executeAttempt('');
      }

      const freshState = loadState();
      const freshChat = getOrCreateChatState(freshState, runKey, config);
      if (result.conversationId) {
        freshChat.conversationId = result.conversationId;
        recordRecentConversation(freshChat, result.conversationId, summaryText);
        saveState(freshState);
      }

      const totalSec = result.durationSeconds !== null
        ? result.durationSeconds.toFixed(1)
        : ((Date.now() - runStartedAt) / 1000).toFixed(1);
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
      footerParts.push(`目录 ${workspaceName}`, `会话 ${shortConv}`);

      let title = '✅ Antigravity 已完成';
      let template = 'green';
      let body = result.response;
      let isFailed = false;

      if (result.aborted) {
        title = '🛑 任务已中止';
        template = 'grey';
        body = result.response || '任务已被用户中止。';
        isFailed = true;
      } else if (result.status !== 'SUCCESS' && result.exitCode !== 0) {
        title = '❌ 执行异常';
        template = 'red';
        isFailed = true;
        const errDetail = result.stderr || result.finishedReason || `exit code ${result.exitCode}`;
        body = result.response ? `${result.response}\n\n---\n**错误信息：**\n\`\`\`\n${errDetail}\n\`\`\`` : `\`\`\`\n${errDetail}\n\`\`\``;
      } else if (!body) {
        body = '_（本次执行没有输出文本回复）_';
      }

      const buttons = [
        ...(isFailed ? [{ label: '🔄 重试', type: 'primary', value: { cmd: 'retry' } }] : []),
        { label: '🆕 新对话', value: { cmd: 'new' } },
        { label: '⚙️ 控制面板', value: { cmd: 'panel' } },
        { label: '⚡ 快捷任务', value: { cmd: 'quick' } },
        { label: '🗂️ 最近会话', value: { cmd: 'sessions' } },
      ];

      await streamSession.finish({
        title,
        template,
        markdown: body,
        footer: footerParts.join(' · '),
        buttonRows: [buttons],
        chatId,
        openId,
        replyTargetMessageId: replyTarget,
        replyInThread,
      });

      if (messageId && !result.aborted && !isFailed) {
        void addMessageReaction(client, {
          messageId,
          emojiType: 'DONE',
        });
      }
    } catch (err) {
      console.error('[feishu-remote] executePrompt error:', err);
      await streamSession.finish({
        title: '❌ 调起 Antigravity 失败',
        template: 'red',
        markdown: String(err.message || err),
        footer: `目录 ${path.basename(chatState.cwd) || chatState.cwd}`,
        buttonRows: [[
          { label: '🔄 重试', type: 'primary', value: { cmd: 'retry' } },
          { label: '🆕 新对话', value: { cmd: 'new' } },
          { label: '⚙️ 控制面板', value: { cmd: 'panel' } },
          { label: '⚡ 快捷任务', value: { cmd: 'quick' } },
        ]],
        chatId,
        openId,
        replyTargetMessageId: replyTarget,
        replyInThread,
      });
    } finally {
      activeRuns.delete(runKey);
      const queue = chatQueues.get(runKey);
      if (queue && queue.length > 0) {
        const nextItem = queue.shift();
        if (queue.length === 0) {
          chatQueues.delete(runKey);
        }
        setTimeout(() => {
          void executePrompt(nextItem.payload);
        }, 150);
      } else {
        const maxConcurrent = getMaxConcurrent(config);
        if (activeRuns.size < maxConcurrent) {
          for (const [otherKey, otherQueue] of chatQueues.entries()) {
            if (activeRuns.has(otherKey) || !Array.isArray(otherQueue) || otherQueue.length === 0) {
              continue;
            }
            const nextOther = otherQueue.shift();
            if (otherQueue.length === 0) {
              chatQueues.delete(otherKey);
            }
            setTimeout(() => {
              void executePrompt(nextOther.payload);
            }, 150);
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
      void executePrompt({ ...payload, sessionKey: runKey });
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
    getQueueForChat,
    totalQueuedCount,
    enqueueOrExecutePrompt,
    executePrompt,
  };
}
