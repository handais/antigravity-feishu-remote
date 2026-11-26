import { listAgyModels } from './agy-runner.mjs';
import {
  loadConfig,
  loadState,
  resolveRiskyApprovalEnabled,
  saveConfig,
  saveState,
} from './config.mjs';
import {
  buildAgySkillsCard,
  buildCard,
  buildControlPanelCard,
  buildDesktopSessionsCard,
  buildDirsCard,
  buildEffortCard,
  buildGitStatusCard,
  buildNotifyCard,
  buildQueueListCard,
  buildScopesCard,
  buildTasksCard,
  recordPanelActionUsage,
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

const ACTION_HANDLERS = [
  handleDesktopAction,
  handleArtifactAction,
  handleOpsAction,
  handleTaskAndQueueAction,
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
  if (!hasCachedThreadMeta && !isKnownP2pChat && openMessageId && chatId && chatId.startsWith('oc_')) {
    try {
      const msgRes = await withTimeout(
        client.im.v1.message.get({ path: { message_id: openMessageId } }),
        800,
      );
      const msgItem = msgRes?.data?.items?.[0];
      if (msgItem?.thread_id) {
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
  const chatState = getOrCreateChatState(state, runKey, config);
  enforceTempFullExpiry(state, chatState);

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

  const usageRecorded = recordPanelActionUsage(state, cmd, arg);

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
    renderPanel,
  };

  for (const handler of ACTION_HANDLERS) {
    const res = await handler(actionCtx);
    if (res !== null && res !== undefined) {
      if (usageRecorded && res?.toast?.type !== 'error') {
        saveState(state);
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

  const state = loadState();
  const chatId = state.lastP2pChatByOpenId[openId] || '';
  const stateKey = chatId || openId;
  const chatState = getOrCreateChatState(state, stateKey, config);
  const expiryInfo = enforceTempFullExpiry(state, chatState);
  if (expiryInfo.expired) {
    saveState(state);
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
      footer: '如长时间未收到上线通知，请在 Mac 终端查看 cli.mjs logs',
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
    config.security.riskyCommandApproval = nextEnabled ? 'on' : 'off';
    saveConfig(config);
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
    chatState.conversationId = '';
    chatState.pendingHandoff = null;
    chatState.originDesktopSession = null;
    chatState.lastTurnArtifacts = null;
    saveState(state);
    await sendToTarget(buildCard({
      title: '🆕 已开启新对话',
      template: 'green',
      markdown: `下条消息将在 \`${chatState.cwd}\` 下开启全新上下文。`,
      buttonRows: [[
        { label: '⚙️ 控制面板', value: { cmd: 'panel' } },
        { label: '🧩 命令', value: { cmd: 'skills_menu' } },
      ]],
    }));
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
    await sendToTarget(buildSessionsCard(chatState));
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
    chatState.fullRevertMode =
      chatState.mode && chatState.mode !== 'full'
        ? chatState.mode
        : chatState.fullRevertMode && chatState.fullRevertMode !== 'full'
          ? chatState.fullRevertMode
          : 'accept-edits';
    chatState.mode = 'full';
    chatState.fullExpiresAt = Date.now() + 30 * 60_000;
    saveState(state);
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
    chatState.mode = modeMap[key];
    chatState.fullExpiresAt = 0;
    saveState(state);
    await sendPanel();
    return;
  }

  if (key === 'commands' || key === 'skills' || key === 'agy' || key === 'slash') {
    await sendToTarget(buildAgySkillsCard());
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
