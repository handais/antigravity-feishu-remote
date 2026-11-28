import { VALID_MODES } from '../agy-runner.mjs';
import { updateState } from '../config.mjs';
import { getActivePendingCommand, isValidCommandPrefix } from '../feishu-api.mjs';
import {
  formatTimeoutLabel,
  getOrCreateChatState,
  parseTimeoutArg,
  toastCardResponse,
} from '../bridge-helpers.mjs';
import {
  BOARD_QUICK_PROMPTS,
  buildGoalBoardCard,
  buildPlanBoardCard,
  buildScheduleBoardCard,
  buildSwarmBoardCard,
  inspectCommandBoardTelemetry,
  SCHEDULE_PRESET_TEMPLATES,
} from '../command-boards.mjs';

function renderBoardCard(board, { chatState, config, isRunning, threadRootId, keepAliveActive = false }) {
  const telemetry = inspectCommandBoardTelemetry(chatState?.conversationId);
  switch (board) {
    case 'goal':
      return buildGoalBoardCard({ chatState, config, isRunning, telemetry });
    case 'swarm':
      return buildSwarmBoardCard({ chatState, config, isRunning, threadRootId, keepAliveActive, telemetry });
    case 'schedule':
      return buildScheduleBoardCard({ chatState, config, isRunning, telemetry });
    case 'plan':
      return buildPlanBoardCard({ chatState, config, isRunning, telemetry });
    default:
      return null;
  }
}

function respondWithBoard(board, { chatState, config, isRunning, threadRootId, keepAliveActive = false, inplace, sendToTarget, toastType = 'info', toastText = '' }) {
  const card = renderBoardCard(board, { chatState, config, isRunning, threadRootId, keepAliveActive });
  if (!card) {
    return toastCardResponse('error', '未知命令看板类型');
  }
  if (inplace) {
    return toastCardResponse(toastType, toastText, card);
  }
  void sendToTarget(card).catch((err) => {
    console.error(`[feishu-remote] send ${board} board error:`, err?.message || err);
  });
  return toastCardResponse(toastType, toastText);
}

export async function handleCommandBoardAction(actionCtx) {
  const {
    runner,
    config,
    state,
    chatState,
    openId,
    targetChatId,
    threadRootId,
    runKey,
    value,
    cmd,
    arg,
    inplace,
    isRunning,
    sendToTarget,
  } = actionCtx;
  const keepAliveActive = Boolean(runner?.hasPersistentSession?.(runKey));

  if (cmd === 'stop_keepalive') {
    const released = Boolean(runner?.releasePersistentSession?.(runKey));
    updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, runKey, config);
      targetChat.persistentSession = false;
      Object.assign(chatState, targetChat);
    });
    const toastText = released ? '🔌 已释放后台保活进程' : '当前无后台保活进程';
    const board = String(value?.board || '').trim().toLowerCase();
    if (board) {
      return respondWithBoard(board, {
        chatState,
        config,
        isRunning,
        threadRootId,
        keepAliveActive: false,
        inplace,
        sendToTarget,
        toastType: 'info',
        toastText,
      });
    }
    return toastCardResponse('info', toastText);
  }

  if (cmd === 'cmd_board') {
    const board = String(value?.board || arg || 'goal').trim().toLowerCase();
    const labelMap = {
      goal: '已刷新 /goal 看板',
      swarm: '已刷新 Swarm 协同看板',
      schedule: '已刷新定时任务看板',
      plan: '已刷新规划与审批看板',
    };
    return respondWithBoard(board, {
      chatState,
      config,
      isRunning,
      threadRootId,
      keepAliveActive,
      inplace,
      sendToTarget,
      toastType: 'info',
      toastText: labelMap[board] || '已刷新看板',
    });
  }

  if (cmd === 'board_arm_cmd') {
    const prefix = String(arg || '').trim();
    const board = String(value?.board || 'goal').trim().toLowerCase();
    if (!isValidCommandPrefix(prefix)) {
      return toastCardResponse('error', '不支持的命令前缀');
    }
    const current = getActivePendingCommand(chatState);
    let toastText;
    let toastType;
    let nextPending;
    if (current && current.prefix === prefix && !current.template) {
      nextPending = null;
      toastType = 'info';
      toastText = `已取消预选：${prefix}`;
    } else {
      nextPending = {
        prefix,
        kind: 'builtin',
        armedAt: Date.now(),
      };
      toastType = 'success';
      toastText = `✅ 已预选 ${prefix}，直接发送内容即可`;
    }
    updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, runKey, config);
      targetChat.pendingCommand = nextPending;
      Object.assign(chatState, targetChat);
    });
    return respondWithBoard(board, {
      chatState,
      config,
      isRunning,
      threadRootId,
      inplace,
      sendToTarget,
      toastType,
      toastText,
    });
  }

  if (cmd === 'goal_prepare') {
    const setUnlimited = Boolean(value?.setUnlimited);
    const setFull = Boolean(value?.setFull);
    const arm = value?.arm !== false;
    if (setFull) {
      runner?.releasePersistentSession?.(runKey);
    }
    updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, runKey, config);
      if (setUnlimited) {
        targetChat.timeoutSeconds = 0;
      }
      if (setFull) {
        targetChat.mode = 'full';
        targetChat.fullExpiresAt = 0;
        targetChat.persistentSession = false;
      }
      if (arm) {
        targetChat.pendingCommand = {
          prefix: '/goal',
          kind: 'builtin',
          armedAt: Date.now(),
        };
      }
      Object.assign(chatState, targetChat);
    });
    const note = setFull
      ? '✅ 已切不限时 + 全权并预选 /goal，请直接发送目标'
      : '✅ 已切不限时并预选 /goal，请直接发送目标';
    return respondWithBoard('goal', {
      chatState,
      config,
      isRunning,
      threadRootId,
      inplace,
      sendToTarget,
      toastType: 'success',
      toastText: note,
    });
  }

  if (cmd === 'board_set_timeout') {
    const board = String(value?.board || 'goal').trim().toLowerCase();
    const seconds = parseTimeoutArg(arg);
    if (seconds === null) {
      return toastCardResponse('error', '无效超时参数');
    }
    updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, runKey, config);
      targetChat.timeoutSeconds = seconds;
      Object.assign(chatState, targetChat);
    });
    return respondWithBoard(board, {
      chatState,
      config,
      isRunning,
      threadRootId,
      inplace,
      sendToTarget,
      toastType: 'success',
      toastText: `⏱️ 本会话单轮超时已设为：${formatTimeoutLabel(seconds)}`,
    });
  }

  if (cmd === 'board_set_mode') {
    const board = String(value?.board || 'plan').trim().toLowerCase();
    const nextMode = String(arg || '').trim().toLowerCase();
    if (!VALID_MODES.includes(nextMode)) {
      return toastCardResponse('error', '不支持的权限模式');
    }
    runner?.releasePersistentSession?.(runKey);
    updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, runKey, config);
      targetChat.mode = nextMode;
      targetChat.fullExpiresAt = 0;
      targetChat.persistentSession = false;
      Object.assign(chatState, targetChat);
    });
    return respondWithBoard(board, {
      chatState,
      config,
      isRunning,
      threadRootId,
      inplace,
      sendToTarget,
      toastType: 'success',
      toastText: `🛡️ 已切换权限模式：${nextMode}`,
    });
  }

  if (cmd === 'schedule_arm_template') {
    const presetKey = String(value?.preset || '').trim();
    const tpl = SCHEDULE_PRESET_TEMPLATES[presetKey];
    if (!tpl) {
      return toastCardResponse('error', '未知定时模板');
    }
    const current = getActivePendingCommand(chatState);
    let toastType;
    let toastText;
    let nextPending;
    if (current && current.prefix === '/schedule' && current.template === tpl.template) {
      nextPending = null;
      toastType = 'info';
      toastText = `已取消定时模板：${tpl.label}`;
    } else {
      nextPending = {
        prefix: '/schedule',
        template: tpl.template,
        kind: 'builtin',
        armedAt: Date.now(),
      };
      toastType = 'success';
      toastText = `✅ 已预填「${tpl.template}」，直接发送提醒/任务内容即可`;
    }
    updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, runKey, config);
      targetChat.pendingCommand = nextPending;
      Object.assign(chatState, targetChat);
    });
    return respondWithBoard('schedule', {
      chatState,
      config,
      isRunning,
      threadRootId,
      inplace,
      sendToTarget,
      toastType,
      toastText,
    });
  }

  if (cmd === 'board_quick_prompt') {
    const presetKey = String(value?.preset || '').trim();
    const promptText = BOARD_QUICK_PROMPTS[presetKey];
    if (!promptText) {
      return toastCardResponse('error', '不支持的快捷指令');
    }
    const wasRunning = Boolean(runKey && isRunning);
    if (wasRunning && runner.getQueueForChat(runKey).length >= 5) {
      return toastCardResponse('warning', '任务队列已满（最多 5 条），请先清理队列');
    }
    void runner.enqueueOrExecutePrompt({
      text: promptText,
      displayPreview: promptText.slice(0, 48),
      chatId: targetChatId,
      openId,
      messageId: '',
      sessionKey: runKey,
      threadRootId,
      replyInThread: Boolean(threadRootId),
      config,
    }).catch((err) => {
      console.error('[feishu-remote] board_quick_prompt error:', err);
    });
    return toastCardResponse('success', wasRunning ? '📥 已加入执行队列' : '🚀 已向当前会话发送指令');
  }

  if (cmd === 'plan_decision') {
    const decision = String(value?.decision || '').trim().toLowerCase();
    if (decision === 'approve') {
      const wasRunning = Boolean(runKey && isRunning);
      if (wasRunning && runner.getQueueForChat(runKey).length >= 5) {
        return toastCardResponse('warning', '任务队列已满（最多 5 条），请先清理队列');
      }
      let modeSwitched = false;
      if (chatState.mode === 'plan') {
        modeSwitched = true;
      }
      updateState((latest) => {
        const targetChat = getOrCreateChatState(latest, runKey, config);
        if (targetChat.mode === 'plan') {
          targetChat.mode = 'accept-edits';
          targetChat.fullExpiresAt = 0;
          modeSwitched = true;
        }
        targetChat.pendingCommand = null;
        Object.assign(chatState, targetChat);
      });
      void runner.enqueueOrExecutePrompt({
        text: BOARD_QUICK_PROMPTS.plan_approve,
        displayPreview: '✅ 按计划执行',
        chatId: targetChatId,
        openId,
        messageId: '',
        sessionKey: runKey,
        threadRootId,
        replyInThread: Boolean(threadRootId),
        config,
      }).catch((err) => {
        console.error('[feishu-remote] plan_decision approve error:', err);
      });
      const note = modeSwitched
        ? '✅ 已切回 accept-edits 并开始按计划执行'
        : wasRunning
          ? '📥 已加入队列，将按计划执行'
          : '🚀 已下发：按计划开始执行';
      return toastCardResponse('success', note);
    }

    if (decision === 'revise') {
      updateState((latest) => {
        const targetChat = getOrCreateChatState(latest, runKey, config);
        targetChat.pendingCommand = {
          prefix: '/plan',
          template: '按以下意见调整方案：',
          kind: 'builtin',
          armedAt: Date.now(),
        };
        Object.assign(chatState, targetChat);
      });
      return respondWithBoard('plan', {
        chatState,
        config,
        isRunning,
        threadRootId,
        inplace,
        sendToTarget,
        toastType: 'info',
        toastText: '✏️ 请直接发送你的修改意见，将自动带回方案重规划',
      });
    }

    if (decision === 'discard') {
      runner?.releasePersistentSession?.(runKey);
      updateState((latest) => {
        const targetChat = getOrCreateChatState(latest, runKey, config);
        targetChat.conversationId = '';
        targetChat.persistentSession = false;
        targetChat.pendingCommand = null;
        targetChat.pendingHandoff = null;
        targetChat.originDesktopSession = null;
        targetChat.lastTurnArtifacts = null;
        Object.assign(chatState, targetChat);
      });
      return respondWithBoard('plan', {
        chatState,
        config,
        isRunning,
        threadRootId,
        inplace,
        sendToTarget,
        toastType: 'info',
        toastText: '🆕 已放弃当前方案并重置为新对话',
      });
    }

    return toastCardResponse('error', '未知计划审批操作');
  }

  return null;
}
