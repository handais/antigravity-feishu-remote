import { listAgyModels } from './agy-runner.mjs';
import {
  loadConfig,
  loadState,
  resolveRiskyApprovalEnabled,
  updateConfig,
  updateState,
} from './config.mjs';
import {
  buildAgySkillsCard,
  buildCard,
  buildControlPanelCard,
  buildDesktopSessionsCard,
  buildDirsCard,
  buildEffortCard,
  buildGitStatusCard,
  buildNewSessionCard,
  buildNotifyCard,
  buildQueueListCard,
  buildScopesCard,
  buildTasksCard,
  getActivePendingCommand,
  patchCard,
  recordPanelActionUsage,
  stampCardThreadRoot,
} from './feishu-api.mjs';
import { listDesktopSessions } from './desktop-sessions.mjs';
import { queryAppScopes } from './feishu-docs.mjs';
import {
  buildOAuthAuthorizeUrl,
  getUserAuthStatus,
  listFeishuTasks,
} from './feishu-tasks.mjs';
import {
  buildHandoffCard,
  copyToSystemClipboardAsync,
  readMobileSession,
  writeHandoffSnapshot,
} from './mobile-handoff.mjs';
import { runPreflightCheckAsync, scheduleDaemonSelfRestart, writePendingRestartNotice } from './self-ops.mjs';
import {
  buildCurrentOpsCard,
  buildModelsCard,
  buildSessionsCard,
  collectGitInfoAsync,
  enforceTempFullExpiry,
  formatHelpMarkdown,
  formatUptime,
  getOrCreateChatState,
  makeSessionKey,
  sendCardToTarget,
  toastCardResponse,
} from './bridge-helpers.mjs';
import { handleDesktopAction } from './actions/desktop.mjs';
import { handleArtifactAction } from './actions/artifacts.mjs';
import { handleOpsAction } from './actions/ops.mjs';
import { handleTaskAndQueueAction } from './actions/tasks.mjs';
import { handleWorkspaceAndSessionAction } from './actions/workspace.mjs';
import { handleCommandBoardAction } from './actions/command-boards.mjs';
import {
  buildGoalBoardCard,
  buildPlanBoardCard,
  buildScheduleBoardCard,
  buildSwarmBoardCard,
  inspectCommandBoardTelemetry,
} from './command-boards.mjs';

const ACTION_HANDLERS = [
  handleDesktopAction,
  handleArtifactAction,
  handleOpsAction,
  handleTaskAndQueueAction,
  handleCommandBoardAction,
  handleWorkspaceAndSessionAction,
];

function withTimeout(promise, ms) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  });
}

function cacheNonThreadCard(cardThreadMap, openMessageId, chatId) {
  if (!cardThreadMap || !openMessageId) return;
  if (cardThreadMap.size >= 1500) {
    const oldest = cardThreadMap.keys().next().value;
    if (oldest !== undefined) cardThreadMap.delete(oldest);
  }
  cardThreadMap.set(openMessageId, { sessionKey: '', threadRootId: '', chatId });
}

export async function runWithinCallbackBudget({
  client,
  openMessageId = '',
  inplace = false,
  threadRootId = '',
  sendToTarget,
  pendingToast = '⏳ 正在处理...',
  workFn,
  budgetMs = 1800,
}) {
  let timedOut = false;
  const workPromise = Promise.resolve().then(() => workFn());
  const budgetSymbol = Symbol('budget');
  let timer = null;

  const outcome = await Promise.race([
    workPromise.then((res) => ({ kind: 'result', res })),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve({ kind: budgetSymbol });
      }, Math.max(50, Number(budgetMs) || 1800));
      timer.unref?.();
    }),
  ]);
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }

  if (outcome.kind !== budgetSymbol) {
    return outcome.res;
  }

  void workPromise
    .then(async (res) => {
      if (!timedOut) return;
      if (res?.card?.data) {
        const stampedCard = threadRootId ? stampCardThreadRoot(res.card.data, threadRootId) : res.card.data;
        if (inplace && openMessageId) {
          try {
            await patchCard(client, { messageId: openMessageId, card: stampedCard });
            return;
          } catch {
            // Fall back to sending a new card
          }
        }
        await sendToTarget(stampedCard);
      } else if (res?.toast?.type === 'error' && res?.toast?.text) {
        await sendToTarget(buildCard({
          title: '❌ 操作处理失败',
          template: 'red',
          markdown: String(res.toast.text),
        }));
      }
    })
    .catch(async (err) => {
      console.error('[feishu-remote] Deferred card action failed:', err?.message || err);
      try {
        await sendToTarget(buildCard({
          title: '❌ 操作处理失败',
          template: 'red',
          markdown: String(err?.message || err),
        }));
      } catch {
        // Ignore error card delivery failures
      }
    });

  return toastCardResponse('info', pendingToast);
}

export async function handleCardAction(ctx, rawEvent) {
  const {
    client,
    startedAt,
    bootCodeHash,
    activeRuns,
    chatQueues,
    lastTaskByChat,
    cardThreadMap,
    recordCardThread = () => {},
    runner,
    stopWsForRestart,
  } = ctx;
  const payload = rawEvent?.action ? rawEvent : rawEvent?.event || rawEvent;
  const openId = payload?.operator?.open_id || '';
  const chatId = payload?.context?.open_chat_id || payload?.open_chat_id || '';
  const openMessageId = payload?.context?.open_message_id || payload?.open_message_id || '';
  let value = payload?.action?.value ?? {};
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = {};
    }
  }

  const config = loadConfig();
  const allowed = config.security.allowedOpenIds || [];
  if (!openId || allowed.length === 0 || !allowed.includes(openId)) {
    return toastCardResponse('error', '未授权账号，无法操作');
  }

  const state = loadState();
  const isKnownP2pChat = Boolean(
    chatId && (
      ctx.chatModeCache?.get(chatId) === 'p2p' ||
      Object.values(state.lastP2pChatByOpenId || {}).includes(chatId)
    ),
  );
  const hasCachedThreadMeta = Boolean(openMessageId && cardThreadMap && cardThreadMap.has(openMessageId));
  let threadMeta = hasCachedThreadMeta ? cardThreadMap.get(openMessageId) : null;
  const embeddedThreadRootId = String(value?.threadRootId || '').trim();
  if (!threadMeta && embeddedThreadRootId && chatId) {
    threadMeta = {
      sessionKey: makeSessionKey(chatId, embeddedThreadRootId),
      threadRootId: embeddedThreadRootId,
      chatId,
    };
    recordCardThread(openMessageId, threadMeta);
  } else if (!hasCachedThreadMeta && !isKnownP2pChat && openMessageId && chatId && chatId.startsWith('oc_')) {
    try {
      const msgRes = await withTimeout(
        client.im.v1.message.get({ path: { message_id: openMessageId } }),
        1000,
      );
      const msgItem = msgRes?.data?.items?.[0];
      if (msgItem?.thread_id || msgItem?.root_id) {
        const resolvedRootId = msgItem.root_id || msgItem.message_id;
        threadMeta = {
          sessionKey: makeSessionKey(chatId, resolvedRootId),
          threadRootId: resolvedRootId,
          chatId,
        };
        recordCardThread(openMessageId, threadMeta);
      } else {
        cacheNonThreadCard(cardThreadMap, openMessageId, chatId);
      }
    } catch {
      // Ignore fallback message lookup errors or timeouts
    }
  }

  const threadRootId = threadMeta?.threadRootId || String(value?.threadRootId || '').trim();
  const targetChatId = threadMeta?.chatId || chatId || state.lastP2pChatByOpenId[openId] || '';
  const runKey =
    (threadMeta?.threadRootId ? threadMeta.sessionKey : '') ||
    makeSessionKey(targetChatId, threadRootId) ||
    targetChatId ||
    openId;
  let chatState = getOrCreateChatState(state, runKey, config);
  const exp = enforceTempFullExpiry(state, chatState);
  if (exp.expired) {
    runner?.releasePersistentSession?.(runKey);
    updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, runKey, config);
      enforceTempFullExpiry(latest, targetChat);
      targetChat.persistentSession = false;
      chatState = { ...targetChat };
    });
  }

  const cmd = String(value?.cmd || '').toLowerCase();
  const arg = value?.arg !== undefined ? String(value.arg) : '';
  const inplace = Boolean(value?.inplace);
  const isRunning = Boolean(runKey && activeRuns.has(runKey));
  const anyBusy = () => activeRuns.size > 0 || runner.totalQueuedCount() > 0;
  const sendToTarget = async (card) => {
    const sentId = await sendCardToTarget(client, {
      chatId: targetChatId,
      openId,
      card,
      replyToMessageId: threadRootId,
      replyInThread: Boolean(threadRootId),
    });
    if (threadRootId && sentId) {
      recordCardThread(sentId, { sessionKey: runKey, threadRootId, chatId: targetChatId });
    }
    return sentId;
  };
  const runWithinBudget = (pendingToast, workFn, budgetMs = 1800) => runWithinCallbackBudget({
    client,
    openMessageId,
    inplace,
    threadRootId,
    sendToTarget,
    pendingToast,
    workFn,
    budgetMs,
  });

  const renderPanel = () => buildControlPanelCard({
    chatState,
    config,
    isRunning: Boolean(runKey && activeRuns.has(runKey)),
    uptimeText: formatUptime(Date.now() - startedAt),
    queueLength: runner.getQueueForChat(runKey).length,
    threadRootId,
    activeParallelCount: activeRuns.size,
    maxConcurrentRuns: config.agy.maxConcurrentRuns || 4,
    panelActionUsage: state.panelActionUsage,
  });

  const actionCtx = {
    ctx,
    client,
    startedAt,
    bootCodeHash,
    activeRuns,
    chatQueues,
    lastTaskByChat,
    runner,
    stopWsForRestart,
    recordCardThread,
    config,
    state,
    chatState,
    openId,
    chatId,
    targetChatId,
    openMessageId,
    threadRootId,
    runKey,
    value,
    cmd,
    arg,
    inplace,
    isRunning,
    anyBusy,
    sendToTarget,
    runWithinBudget,
    renderPanel,
  };

  for (const handler of ACTION_HANDLERS) {
    const res = await handler(actionCtx);
    if (res !== null && res !== undefined) {
      if (res?.toast?.type !== 'error') {
        updateState((latest) => {
          recordPanelActionUsage(latest, cmd, arg);
        });
      }
      if (threadRootId && res?.card?.data) {
        return {
          ...res,
          card: {
            ...res.card,
            data: stampCardThreadRoot(res.card.data, threadRootId),
          },
        };
      }
      return res;
    }
  }

  return toastCardResponse('info', '已收到操作');
}

export async function handleBotMenuEvent(ctx, rawEvent) {
  const { client, startedAt, bootCodeHash, activeRuns, runner, stopWsForRestart } = ctx;
  const payload = rawEvent?.operator ? rawEvent : rawEvent?.event || rawEvent;
  const openId = payload?.operator?.operator_id?.open_id || '';
  const eventKey = String(payload?.event_key || '').trim();
  if (!openId || !eventKey) return;

  const config = loadConfig();
  const allowed = config.security.allowedOpenIds || [];
  if (!openId || allowed.length === 0 || !allowed.includes(openId)) {
    return;
  }

  let state = loadState();
  const chatId = state.lastP2pChatByOpenId[openId] || '';
  const stateKey = chatId || openId;
  let chatState = getOrCreateChatState(state, stateKey, config);
  const expiryInfo = enforceTempFullExpiry(state, chatState);
  if (expiryInfo.expired) {
    runner?.releasePersistentSession?.(stateKey);
    state = updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, stateKey, config);
      enforceTempFullExpiry(latest, targetChat);
      targetChat.persistentSession = false;
      chatState = targetChat;
    });
  }
  const isRunning = Boolean(stateKey && activeRuns.has(stateKey));
  const anyBusy = () => activeRuns.size > 0 || runner.totalQueuedCount() > 0;
  const key = eventKey.toLowerCase().replace(/^\/+/, '').replace(/^menu_/, '');
  const sendToTarget = (card) => sendCardToTarget(client, { chatId, openId, card });

  const sendPanel = () => sendToTarget(buildControlPanelCard({
    chatState,
    config,
    isRunning,
    uptimeText: formatUptime(Date.now() - startedAt),
    queueLength: runner.getQueueForChat(stateKey).length,
    panelActionUsage: state.panelActionUsage,
  }));

  if (key === 'panel' || key === 'status' || key === 'control' || key === 'control_panel') {
    await sendPanel();
    return;
  }

  if (key === 'ops' || key === 'backups' || key === 'rollback') {
    await sendToTarget(buildCurrentOpsCard({ bootCodeHash, isRunning: anyBusy() }));
    return;
  }

  if (key === 'reload' || key === 'restart' || key === 'safe_restart') {
    if (anyBusy()) {
      await sendToTarget(buildCard({
        title: '⏳ 当前有任务运行或排队中',
        template: 'orange',
        markdown: '请等待当前任务及队列执行完成，或先点击下方按钮中止后再重启。',
        buttonRows: [[
          { label: '🛑 立即中止', type: 'danger', value: { cmd: 'stop' } },
          { label: '📋 查看队列', value: { cmd: 'queue_list' } },
          { label: '🛡️ 运维与回滚', value: { cmd: 'ops' } },
        ]],
      }));
      return;
    }
    const check = await runPreflightCheckAsync();
    if (!check.ok) {
      await sendToTarget(buildCurrentOpsCard({ bootCodeHash, checkResult: check, isRunning: false }));
      return;
    }
    writePendingRestartNotice({
      chatId,
      openId,
      sessionKey: stateKey,
      action: 'restart',
      snapshotId: '',
      previousHash: bootCodeHash,
      requestedAt: Date.now(),
    });
    await sendToTarget(buildCard({
      title: '♻️ 预检通过，正在安全重启...',
      template: 'wathet',
      markdown: [
        `- **预检结果**：✅ 通过（检查 ${check.checkedFiles.length} 个脚本，耗时 ${check.durationMs}ms）`,
        `- **目标代码版本**：\`${check.hash.slice(0, 8)}\``,
        '',
        '预计 1~3 秒后自动上线，上线后会推送确认卡片。',
      ].join('\n'),
      footer: '如长时间未收到上线通知，请在本机终端查看 cli.mjs logs',
    }));
    scheduleDaemonSelfRestart({ delayMs: 700, onBeforeExit: stopWsForRestart });
    return;
  }

  if (key === 'git') {
    await sendToTarget(buildGitStatusCard({ cwd: chatState.cwd, gitInfo: await collectGitInfoAsync(chatState.cwd) }));
    return;
  }

  if (key === 'scopes' || key === 'perms') {
    try {
      const scopeData = await queryAppScopes(client);
      await sendToTarget(buildScopesCard(scopeData));
    } catch (err) {
      await sendToTarget(buildCard({
        title: '❌ 查询权限状态失败',
        template: 'red',
        markdown: String(err?.message || err),
      }));
    }
    return;
  }

  if (key === 'queue') {
    await sendToTarget(buildQueueListCard({
      running: stateKey ? activeRuns.get(stateKey) || null : null,
      queue: runner.getQueueForChat(stateKey),
    }));
    return;
  }

  if (key === 'effort') {
    await sendToTarget(buildEffortCard(chatState.effort || config.agy.defaultEffort || ''));
    return;
  }

  if (key === 'notify') {
    await sendToTarget(buildNotifyCard({ config }));
    return;
  }

  if (key === 'handoff' || key === 'back' || key === 'return') {
    const session = readMobileSession({
      conversationId: chatState.conversationId || '',
      cwd: chatState.cwd,
      originDesktopId: chatState.originDesktopSession?.id || '',
    });
    if (!session.found) {
      await sendToTarget(buildCard({
        title: 'ℹ️ 暂无可交回电脑的手机端会话',
        template: 'grey',
        markdown: session.error || '请先在飞书端进行至少一轮对话后再使用交回电脑。',
        buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
      }));
      return;
    }
    const clipboardResult = await copyToSystemClipboardAsync(session.cliResumeCommand);
    const snap = writeHandoffSnapshot({
      conversationId: session.conversationId,
      cwd: session.cwd,
      cliResumeCommand: session.cliResumeCommand,
      desktopHandoffPrompt: session.desktopHandoffPrompt,
      modifiedFiles: session.modifiedFiles,
      originDesktopSession: session.originDesktopSession,
    });
    await sendToTarget(buildHandoffCard({
      session,
      clipboardResult,
      copiedTarget: 'cli',
      snapshotPath: snap.latestPath,
    }));
    return;
  }

  if (key === 'guard' || key === 'approval') {
    const nextEnabled = !resolveRiskyApprovalEnabled(config);
    updateConfig((c) => {
      c.security.riskyCommandApproval = nextEnabled ? 'on' : 'off';
    });
    config.security.riskyCommandApproval = nextEnabled ? 'on' : 'off';
    await sendPanel();
    return;
  }

  if (key === 'todo' || key === 'feishu_tasks' || key === 'tasks') {
    const authUrl = config?.feishu?.appId
      ? buildOAuthAuthorizeUrl({ appId: config.feishu.appId, domain: config.feishu.domain })
      : '';
    try {
      const res = await listFeishuTasks(config, { filter: 'open', pageSize: 20 });
      await sendToTarget(buildTasksCard({
        items: res.items,
        filter: res.filter,
        authStatus: getUserAuthStatus(),
        authUrl,
      }));
    } catch (err) {
      await sendToTarget(buildTasksCard({
        items: [],
        filter: 'open',
        authStatus: getUserAuthStatus(),
        error: err?.message || String(err),
        authUrl,
      }));
    }
    return;
  }

  if (key === 'dirs' || key === 'cd') {
    await sendToTarget(buildDirsCard({ chatState, config }));
    return;
  }

  if (key === 'new') {
    runner?.releasePersistentSession?.(stateKey);
    state = updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, stateKey, config);
      targetChat.conversationId = '';
      targetChat.persistentSession = false;
      targetChat.pendingHandoff = null;
      targetChat.pendingCommand = null;
      targetChat.originDesktopSession = null;
      targetChat.lastTurnArtifacts = null;
      targetChat.topicClosed = false;
      chatState = targetChat;
    });
    await sendToTarget(buildNewSessionCard({ chatState, config }));
    return;
  }

  if (key === 'stop' || key === 'cancel') {
    const running = stateKey ? activeRuns.get(stateKey) : null;
    if (running) running.controller.abort();
    await sendToTarget(buildCard({
      title: running ? '🛑 正在中止任务' : 'ℹ️ 当前无运行中任务',
      template: running ? 'orange' : 'grey',
      markdown: running ? '已发送终止信号给正在运行的 `agy` 进程。' : '这个对话目前是空闲状态。',
      buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
    }));
    return;
  }

  if (key === 'sessions') {
    state = updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, stateKey, config);
      targetChat.lastSessionsScope = 'all';
      chatState = targetChat;
    });
    await sendToTarget(buildSessionsCard(chatState, { state, sessionKey: stateKey, scope: 'all' }));
    return;
  }

  if (key === 'desktop' || key === 'pc') {
    const items = listDesktopSessions({ filter: 'all', limit: 10 });
    await sendToTarget(buildDesktopSessionsCard({
      items,
      filter: 'all',
      currentConvId: chatState.conversationId,
      pendingHandoffId: chatState.pendingHandoff?.id || '',
    }));
    return;
  }

  if (key === 'models') {
    try {
      const models = await listAgyModels(config);
      await sendToTarget(buildModelsCard(models, chatState.model));
    } catch (err) {
      await sendToTarget(buildCard({
        title: '❌ 查询模型失败',
        template: 'red',
        markdown: String(err.message || err),
      }));
    }
    return;
  }

  if (key === 'mode_temp_full') {
    runner?.releasePersistentSession?.(stateKey);
    state = updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, stateKey, config);
      targetChat.fullRevertMode =
        targetChat.mode && targetChat.mode !== 'full'
          ? targetChat.mode
          : targetChat.fullRevertMode && targetChat.fullRevertMode !== 'full'
            ? targetChat.fullRevertMode
            : 'auto';
      targetChat.mode = 'full';
      targetChat.fullExpiresAt = Date.now() + 30 * 60_000;
      targetChat.persistentSession = false;
      chatState = targetChat;
    });
    await sendPanel();
    return;
  }

  const modeMap = {
    mode_full: 'full',
    mode_edits: 'accept-edits',
    mode_auto: 'auto',
    mode_plan: 'plan',
  };
  if (modeMap[key]) {
    runner?.releasePersistentSession?.(stateKey);
    state = updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, stateKey, config);
      targetChat.mode = modeMap[key];
      targetChat.fullExpiresAt = 0;
      targetChat.persistentSession = false;
      chatState = targetChat;
    });
    await sendPanel();
    return;
  }

  if (key === 'commands' || key === 'skills' || key === 'agy' || key === 'slash') {
    await sendToTarget(buildAgySkillsCard({ pendingCommand: getActivePendingCommand(chatState) }));
    return;
  }

  if (key === 'goal') {
    await sendToTarget(buildGoalBoardCard({
      chatState,
      config,
      isRunning,
      telemetry: inspectCommandBoardTelemetry(chatState.conversationId),
    }));
    return;
  }

  if (key === 'swarm' || key === 'teamwork') {
    await sendToTarget(buildSwarmBoardCard({
      chatState,
      config,
      isRunning,
      keepAliveActive: Boolean(runner?.hasPersistentSession?.(stateKey)),
      telemetry: inspectCommandBoardTelemetry(chatState.conversationId),
    }));
    return;
  }

  if (key === 'schedule') {
    await sendToTarget(buildScheduleBoardCard({
      chatState,
      config,
      isRunning,
      telemetry: inspectCommandBoardTelemetry(chatState.conversationId),
    }));
    return;
  }

  if (key === 'plan' || key === 'grill_me' || key === 'grill-me') {
    await sendToTarget(buildPlanBoardCard({
      chatState,
      config,
      isRunning,
      telemetry: inspectCommandBoardTelemetry(chatState.conversationId),
    }));
    return;
  }

  if (key === 'help') {
    await sendToTarget(buildCard({
      title: '🤖 Antigravity 飞书遥控指令',
      template: 'blue',
      markdown: formatHelpMarkdown(),
      buttonRows: [[
        { label: '⚙️ 打开控制面板', type: 'primary', value: { cmd: 'panel' } },
        { label: '🧩 命令', value: { cmd: 'skills_menu' } },
      ]],
    }));
    return;
  }

  console.warn(`[feishu-remote] Unrecognized bot menu event_key=${eventKey}, falling back to control panel`);
  await sendPanel();
}
