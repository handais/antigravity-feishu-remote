import fs from 'node:fs';
import path from 'node:path';
import { listAgyModels, VALID_EFFORTS, VALID_MODES } from './agy-runner.mjs';
import { removeMessageReaction } from './cardkit-stream.mjs';
import {
  getEffectiveQuickPrompts,
  loadConfig,
  loadState,
  saveConfig,
  saveState,
  VALID_NOTIFY_MODES,
} from './config.mjs';
import {
  buildCard,
  buildControlPanelCard,
  buildDesktopSessionPreviewCard,
  buildDesktopSessionsCard,
  buildDirsCard,
  buildEffortCard,
  buildGitStatusCard,
  buildNotifyCard,
  buildQuickPromptsCard,
  buildQueueListCard,
  buildScopesCard,
  patchCard,
} from './feishu-api.mjs';
import {
  buildDesktopHandoffContext,
  getDesktopSessionDetail,
  listDesktopSessions,
} from './desktop-sessions.mjs';
import { applyPendingAppScopes, queryAppScopes } from './feishu-docs.mjs';
import {
  createBackupSnapshot,
  findRollbackTarget,
  restoreBackupSnapshot,
  runPreflightCheck,
  scheduleDaemonSelfRestart,
  writePendingRestartNotice,
} from './self-ops.mjs';
import {
  buildCurrentOpsCard,
  buildModelsCard,
  buildSessionsCard,
  collectGitInfo,
  enforceTempFullExpiry,
  expandHomePath,
  formatHelpMarkdown,
  formatUptime,
  getOrCreateChatState,
  makeSessionKey,
  normalizeTempMinutes,
  recordRecentConversation,
  sendCardToTarget,
  toastCardResponse,
} from './bridge-helpers.mjs';

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
  if (allowed.length > 0 && !allowed.includes(openId)) {
    return toastCardResponse('error', '未授权账号，无法操作');
  }

  let threadMeta = openMessageId && cardThreadMap ? cardThreadMap.get(openMessageId) : null;
  if (!threadMeta && openMessageId && chatId && chatId.startsWith('oc_')) {
    try {
      const msgRes = await client.im.v1.message.get({ path: { message_id: openMessageId } });
      const msgItem = msgRes?.data?.items?.[0];
      if (msgItem?.thread_id) {
        const resolvedRootId = msgItem.root_id || msgItem.message_id;
        threadMeta = {
          sessionKey: makeSessionKey(chatId, resolvedRootId),
          threadRootId: resolvedRootId,
          chatId,
        };
        recordCardThread(openMessageId, threadMeta);
      }
    } catch {
      // Ignore fallback message lookup errors
    }
  }

  const state = loadState();
  const threadRootId = threadMeta?.threadRootId || '';
  const targetChatId = threadMeta?.chatId || chatId || state.lastP2pChatByOpenId[openId] || '';
  if (!threadRootId && chatId && openId && !state.lastP2pChatByOpenId[openId]) {
    state.lastP2pChatByOpenId[openId] = chatId;
  }
  const runKey = threadMeta?.sessionKey || makeSessionKey(targetChatId, threadRootId) || targetChatId || openId;
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
  });

  if (cmd === 'panel' || cmd === 'status') {
    saveState(state);
    if (inplace) {
      return toastCardResponse('info', '已刷新控制面板', renderPanel());
    }
    void sendToTarget(renderPanel()).catch((err) => {
      console.error('[feishu-remote] send panel card error:', err.message);
    });
    return toastCardResponse('info', '已打开控制面板');
  }

  function applyDesktopTakeover({ convId, fallbackCwd = '', fallbackSummary = '' }) {
    const detail = getDesktopSessionDetail(convId);
    const resolvedId = detail?.id || convId;
    const rawCwd = detail?.workspace || fallbackCwd;
    if (rawCwd) {
      try {
        const resolved = expandHomePath(rawCwd, chatState.cwd);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
          chatState.cwd = resolved;
        }
      } catch {
        // Ignore inaccessible workspace path
      }
    }
    const mode = detail?.takeoverMode === 'handoff' ? 'handoff' : 'native';
    const title = detail?.title || fallbackSummary || '(电脑端接管对话)';
    if (mode === 'handoff' && detail) {
      chatState.conversationId = '';
      chatState.pendingHandoff = {
        id: detail.id,
        title,
        source: detail.source,
        cwd: chatState.cwd,
        contextBlock: buildDesktopHandoffContext(detail),
        createdAt: Date.now(),
      };
    } else {
      chatState.conversationId = resolvedId;
      chatState.pendingHandoff = null;
      recordRecentConversation(chatState, resolvedId, title);
    }
    return { mode, detail, resolvedId, title };
  }

  if (cmd === 'takeover') {
    const convId = arg.trim();
    if (!convId) {
      return toastCardResponse('error', '缺少要接管的会话 ID');
    }
    const rawCwd = String(value?.cwd || '').trim();
    const summary = String(value?.summary || '').trim();
    const { mode, resolvedId, title } = applyDesktopTakeover({
      convId,
      fallbackCwd: rawCwd,
      fallbackSummary: summary,
    });
    saveState(state);

    const card = buildCard({
      title: '📱 已接管电脑端对话',
      template: 'green',
      markdown: [
        mode === 'handoff'
          ? '- **接管方式**：🔄 **只读摘要接管**（桌面端独立会话，下条消息自动注入上下文并在 CLI 延续）'
          : '- **接管方式**：✅ **原生直连**（已直接绑定底层 CLI 会话轨迹）',
        `- **原会话 ID**：\`${resolvedId.slice(0, 8)}\`（\`${resolvedId}\`）`,
        `- **工作目录**：\`${chatState.cwd}\``,
        title ? `- **原任务摘要**：${title}` : '',
        '',
        '现在可以直接在飞书发消息，继续推进该任务。',
      ].filter(Boolean).join('\n'),
      buttonRows: [[
        { label: '⚙️ 打开控制面板', type: 'primary', value: { cmd: 'panel', inplace: true } },
        { label: '💻 电脑对话', value: { cmd: 'desktop_list', filter: 'all', inplace: true } },
      ]],
    });
    return toastCardResponse(
      'success',
      mode === 'handoff' ? '✅ 已挂载桌面端上下文，直接发消息即可延续' : '✅ 已直连电脑端对话，直接发消息即可继续',
      card,
    );
  }

  if (cmd === 'desktop_list') {
    saveState(state);
    const filter = String(value?.filter || 'all');
    const query = String(value?.query || '');
    const items = listDesktopSessions({ query, filter, limit: 10 });
    const card = buildDesktopSessionsCard({
      items,
      query,
      filter,
      currentConvId: chatState.conversationId,
      pendingHandoffId: chatState.pendingHandoff?.id || '',
    });
    if (inplace) {
      return toastCardResponse('info', `已扫描到 ${items.length} 条电脑端对话`, card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send desktop list card error:', err.message);
    });
    return toastCardResponse('info', '已发送电脑端对话列表');
  }

  if (cmd === 'desktop_preview') {
    saveState(state);
    const detail = getDesktopSessionDetail(arg);
    if (!detail) {
      return toastCardResponse('error', '未找到对应的电脑端对话记录');
    }
    const card = buildDesktopSessionPreviewCard(detail, {
      filter: String(value?.filter || 'all'),
      query: String(value?.query || ''),
    });
    if (inplace) {
      return toastCardResponse('info', '已加载对话详情预览', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send desktop preview card error:', err.message);
    });
    return toastCardResponse('info', '已打开对话详情预览');
  }

  if (cmd === 'desktop_takeover') {
    const convId = arg.trim();
    if (!convId) {
      return toastCardResponse('error', '缺少要接管的会话 ID');
    }
    const summarize = Boolean(value?.summarize);
    const { mode, resolvedId, title } = applyDesktopTakeover({ convId });
    saveState(state);

    let summarizeQueuedMsg = '';
    if (summarize) {
      const wasRunning = Boolean(runKey && activeRuns.has(runKey));
      if (wasRunning && runner.getQueueForChat(runKey).length >= 5) {
        return toastCardResponse('warning', '已接管会话，但当前队列已满（最多 5 条），请稍后手动发消息总结');
      }
      summarizeQueuedMsg = wasRunning
        ? '已加入任务队列，稍候自动总结接管进展。'
        : '正在生成当前进度总结，请留意下方流式卡片。';
      void runner.enqueueOrExecutePrompt({
        text: '请结合接管到的历史上下文与当前工作目录现状（如文件与最近改动），用要点简要汇报当前进展、已完成事项与下一步建议。',
        displayPreview: `👀 总结电脑端进展：${title.slice(0, 24)}`,
        chatId: targetChatId,
        openId,
        messageId: '',
        sessionKey: runKey,
        threadRootId,
        replyInThread: Boolean(threadRootId),
        config,
      }).catch((err) => {
        console.error('[feishu-remote] desktop_takeover summarize error:', err);
      });
    }

    const card = buildCard({
      title: summarize ? '👀 已接管并启动进展总结' : '✅ 已接管电脑端对话',
      template: 'green',
      markdown: [
        mode === 'handoff'
          ? '- **接管方式**：🔄 **只读摘要接管**（桌面端独立存储，自动注入最近对话上下文）'
          : '- **接管方式**：✅ **原生直连**（已直接绑定 CLI 完整会话）',
        `- **对话标题**：${title}`,
        `- **原会话 ID**：\`${resolvedId.slice(0, 8)}\``,
        `- **当前目录**：\`${chatState.cwd}\``,
        summarizeQueuedMsg ? `- **自动动作**：${summarizeQueuedMsg}` : '',
      ].filter(Boolean).join('\n'),
      buttonRows: [[
        { label: '⚙️ 控制面板', type: 'primary', value: { cmd: 'panel', inplace: true } },
        { label: '💻 电脑对话', value: { cmd: 'desktop_list', filter: 'all', inplace: true } },
      ]],
    });
    return toastCardResponse(
      'success',
      summarize ? '👀 已接管并启动进度总结' : '✅ 已接管对话并切好目录',
      card,
    );
  }

  if (cmd === 'ops' || cmd === 'backups') {
    saveState(state);
    const card = buildCurrentOpsCard({ bootCodeHash, isRunning: anyBusy() });
    if (inplace) {
      return toastCardResponse('info', '运维与快照', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send ops card error:', err.message);
    });
    return toastCardResponse('info', '已打开运维与快照面板');
  }

  if (cmd === 'preflight') {
    const check = runPreflightCheck();
    return toastCardResponse(
      check.ok ? 'success' : 'error',
      check.ok ? '✅ 语法与导入检查全部通过' : '❌ 发现代码错误，请先修复或回滚',
      buildCurrentOpsCard({ bootCodeHash, checkResult: check, isRunning: anyBusy() }),
    );
  }

  if (cmd === 'snapshot') {
    const check = runPreflightCheck();
    if (!check.ok) {
      return toastCardResponse(
        'error',
        '❌ 当前代码未通过检查，拒绝创建快照',
        buildCurrentOpsCard({ bootCodeHash, checkResult: check, isRunning: anyBusy() }),
      );
    }
    const res = createBackupSnapshot({ reason: 'manual', force: true });
    return toastCardResponse(
      'success',
      `📸 已保存快照 ${res.snapshot.shortHash}`,
      buildCurrentOpsCard({ bootCodeHash, checkResult: check, isRunning: anyBusy() }),
    );
  }

  if (cmd === 'notify_menu') {
    saveState(state);
    const card = buildNotifyCard({ config });
    if (inplace) {
      return toastCardResponse('info', '桌面端完成提醒设置', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send notify card error:', err.message);
    });
    return toastCardResponse('info', '已打开桌面端提醒设置');
  }

  if (cmd === 'notify_mode') {
    const modeArg = arg.trim().toLowerCase();
    if (!VALID_NOTIFY_MODES.includes(modeArg)) {
      return toastCardResponse('error', `无效提醒模式：${arg}`);
    }
    config.notifications.stopNotifyMode = modeArg;
    config.notifications.stopHookEnabled = modeArg !== 'off';
    saveConfig(config);
    saveState(state);
    const label = modeArg === 'on'
      ? '🔔 已设为始终提醒'
      : modeArg === 'away'
        ? '🧠 已设为仅离开电脑时提醒'
        : '🔕 已关闭桌面端完成提醒';
    return toastCardResponse('success', label, inplace ? buildNotifyCard({ config }) : null);
  }

  if (cmd === 'notify_idle') {
    const rawSec = Number(arg);
    const clampedSec = Number.isFinite(rawSec) ? Math.max(30, Math.min(1800, Math.round(rawSec))) : 120;
    config.notifications.awayIdleSeconds = clampedSec;
    config.notifications.stopNotifyMode = 'away';
    config.notifications.stopHookEnabled = true;
    saveConfig(config);
    saveState(state);
    const minLabel = Math.max(1, Math.round(clampedSec / 60));
    return toastCardResponse(
      'success',
      `🧠 已设为离开电脑 ≥ ${minLabel} 分钟才提醒`,
      inplace ? buildNotifyCard({ config }) : null,
    );
  }

  if (cmd === 'safe_restart') {
    if (anyBusy()) {
      return toastCardResponse('warning', '当前有任务运行或排队中，请先中止或清空队列后再重启');
    }
    const check = runPreflightCheck();
    if (!check.ok) {
      return toastCardResponse(
        'error',
        '❌ 预检失败，已取消重启（服务保持在线）',
        buildCurrentOpsCard({ bootCodeHash, checkResult: check, isRunning }),
      );
    }
    saveState(state);
    writePendingRestartNotice({
      chatId: targetChatId,
      openId,
      sessionKey: runKey,
      threadRootId,
      replyInThread: Boolean(threadRootId),
      action: 'restart',
      snapshotId: '',
      previousHash: bootCodeHash,
      requestedAt: Date.now(),
    });
    scheduleDaemonSelfRestart({ delayMs: 700, onBeforeExit: stopWsForRestart });
    return toastCardResponse(
      'success',
      '✅ 预检通过，正在安全重启...',
      buildCard({
        title: '♻️ 正在安全重启守护进程...',
        template: 'wathet',
        markdown: [
          `- 预检结果：✅ 通过（${check.checkedFiles.length} 个脚本，耗时 ${check.durationMs}ms）`,
          `- 目标代码版本：\`${check.hash.slice(0, 8)}\``,
          '',
          '预计 1~3 秒后自动上线，上线后会推送确认卡片。',
        ].join('\n'),
        footer: '如长时间未收到上线通知，请在 Mac 终端查看 cli.mjs logs',
      }),
    );
  }

  if (cmd === 'rollback_confirm') {
    const target = findRollbackTarget(arg);
    if (!target) {
      return toastCardResponse('info', '暂无更早的可用快照可回滚', buildCurrentOpsCard({ bootCodeHash, isRunning }));
    }
    return toastCardResponse(
      'warning',
      `请确认回滚到 ${target.shortHash}`,
      buildCurrentOpsCard({ bootCodeHash, isRunning, confirmSnapshot: target }),
    );
  }

  if (cmd === 'rollback_exec') {
    if (anyBusy()) {
      return toastCardResponse('warning', '当前有任务运行或排队中，请先中止后再回滚');
    }
    const res = restoreBackupSnapshot(arg);
    if (!res.ok) {
      return toastCardResponse(
        'error',
        res.error || '❌ 回滚后预检失败',
        buildCurrentOpsCard({ bootCodeHash, checkResult: res.check, isRunning }),
      );
    }
    saveState(state);
    writePendingRestartNotice({
      chatId: targetChatId,
      openId,
      sessionKey: runKey,
      threadRootId,
      replyInThread: Boolean(threadRootId),
      action: 'rollback',
      snapshotId: res.snapshot.id,
      previousHash: bootCodeHash,
      requestedAt: Date.now(),
    });
    scheduleDaemonSelfRestart({ delayMs: 700, onBeforeExit: stopWsForRestart });
    return toastCardResponse(
      'success',
      `⏪ 已回滚到 ${res.snapshot.shortHash}，正在重启...`,
      buildCard({
        title: '⏪ 已恢复历史快照，正在重启...',
        template: 'orange',
        markdown: [
          `- 目标快照：\`${res.snapshot.id}\``,
          `- 恢复文件数：${res.restoredFilesCount}`,
          '- 预检结果：✅ 通过',
          '',
          '预计 1~3 秒后自动重新上线。',
        ].join('\n'),
        footer: '上线后会自动推送确认卡片',
      }),
    );
  }

  if (cmd === 'new') {
    chatState.conversationId = '';
    chatState.pendingHandoff = null;
    saveState(state);
    return toastCardResponse('success', '✅ 已开启新对话', inplace ? renderPanel() : null);
  }

  if (cmd === 'mode') {
    if (!VALID_MODES.includes(arg)) {
      return toastCardResponse('error', `无效模式：${arg}`);
    }
    chatState.mode = arg;
    chatState.fullExpiresAt = 0;
    saveState(state);
    return toastCardResponse('success', `已切换为 ${arg} 模式`, inplace ? renderPanel() : null);
  }

  if (cmd === 'mode_temp_full') {
    const minutes = normalizeTempMinutes(arg, 30);
    chatState.fullRevertMode =
      chatState.mode && chatState.mode !== 'full'
        ? chatState.mode
        : chatState.fullRevertMode && chatState.fullRevertMode !== 'full'
          ? chatState.fullRevertMode
          : 'accept-edits';
    chatState.mode = 'full';
    chatState.fullExpiresAt = Date.now() + minutes * 60_000;
    saveState(state);
    return toastCardResponse(
      'warning',
      `⚡ 已开启 ${minutes}m 临时全权（到期自动切回 ${chatState.fullRevertMode}）`,
      inplace ? renderPanel() : null,
    );
  }

  if (cmd === 'effort_menu') {
    saveState(state);
    const card = buildEffortCard(chatState.effort || config.agy.defaultEffort || '');
    if (inplace) {
      return toastCardResponse('info', '推理强度设置', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send effort card error:', err.message);
    });
    return toastCardResponse('info', '已打开推理强度设置');
  }

  if (cmd === 'effort') {
    const normalized = arg.trim().toLowerCase();
    if (normalized && normalized !== 'default' && !VALID_EFFORTS.includes(normalized)) {
      return toastCardResponse('error', `无效推理强度：${arg}`);
    }
    chatState.effort = normalized === 'default' || !normalized ? '' : normalized;
    saveState(state);
    return toastCardResponse(
      'success',
      `已切换推理强度为 ${chatState.effort || 'default'}`,
      inplace ? renderPanel() : null,
    );
  }

  if (cmd === 'git') {
    saveState(state);
    const card = buildGitStatusCard({ cwd: chatState.cwd, gitInfo: collectGitInfo(chatState.cwd) });
    if (inplace) {
      return toastCardResponse('info', 'Git 仓库状态', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send git card error:', err.message);
    });
    return toastCardResponse('info', '已查询 Git 状态');
  }

  if (cmd === 'scopes') {
    saveState(state);
    try {
      const scopeData = await queryAppScopes(client);
      const card = buildScopesCard(scopeData);
      if (inplace) {
        return toastCardResponse('info', '应用权限状态', card);
      }
      void sendToTarget(card).catch((err) => {
        console.error('[feishu-remote] send scopes card error:', err.message);
      });
      return toastCardResponse('info', '已查询权限状态');
    } catch (err) {
      return toastCardResponse('error', `查询权限失败：${err?.message || err}`);
    }
  }

  if (cmd === 'scopes_apply') {
    saveState(state);
    try {
      const applyResult = await applyPendingAppScopes(client);
      const scopeData = await queryAppScopes(client);
      return toastCardResponse(
        applyResult.ok ? 'success' : 'warning',
        applyResult.ok ? '已发送权限审批申请' : applyResult.msg,
        buildScopesCard({ ...scopeData, applyResult }),
      );
    } catch (err) {
      return toastCardResponse('error', `提交申请失败：${err?.message || err}`);
    }
  }

  if (cmd === 'queue_list') {
    saveState(state);
    const card = buildQueueListCard({
      running: runKey ? activeRuns.get(runKey) || null : null,
      queue: runner.getQueueForChat(runKey),
    });
    if (inplace) {
      return toastCardResponse('info', '任务队列', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send queue list card error:', err.message);
    });
    return toastCardResponse('info', '已打开任务队列');
  }

  if (cmd === 'queue_cancel') {
    const queue = runner.getQueueForChat(runKey);
    const idx = queue.findIndex((item) => item.id === arg);
    if (idx === -1) {
      return toastCardResponse(
        'info',
        '该任务已开始执行或已不在队列中',
        inplace ? buildQueueListCard({ running: activeRuns.get(runKey) || null, queue }) : null,
      );
    }
    const [removed] = queue.splice(idx, 1);
    if (queue.length === 0) chatQueues.delete(runKey);
    if (removed?.payload?.queueReactionId && removed?.payload?.messageId) {
      void removeMessageReaction(client, {
        messageId: removed.payload.messageId,
        reactionId: removed.payload.queueReactionId,
      });
    }
    return toastCardResponse(
      'success',
      '🗑️ 已取消该排队任务',
      inplace
        ? buildQueueListCard({ running: activeRuns.get(runKey) || null, queue })
        : buildCard({ title: '🗑️ 已取消排队', template: 'grey', markdown: '该排队任务已从执行队列中移除。' }),
    );
  }

  if (cmd === 'queue_clear') {
    const queue = runner.getQueueForChat(runKey);
    const count = queue.length;
    for (const item of queue) {
      if (item?.payload?.queueReactionId && item?.payload?.messageId) {
        void removeMessageReaction(client, {
          messageId: item.payload.messageId,
          reactionId: item.payload.queueReactionId,
        });
      }
    }
    chatQueues.delete(runKey);
    return toastCardResponse(
      count > 0 ? 'success' : 'info',
      count > 0 ? `🗑️ 已清空 ${count} 条排队任务` : '队列原本为空',
      inplace ? buildQueueListCard({ running: activeRuns.get(runKey) || null, queue: [] }) : null,
    );
  }

  if (cmd === 'queue_promote') {
    const queue = runner.getQueueForChat(runKey);
    const idx = queue.findIndex((item) => item.id === arg);
    if (idx === -1) {
      return toastCardResponse('info', '该任务已开始执行或已不在队列中');
    }
    const [item] = queue.splice(idx, 1);
    queue.unshift(item);
    const running = runKey ? activeRuns.get(runKey) : null;
    if (running) {
      running.controller.abort();
      return toastCardResponse('warning', '🛑 正在中止当前任务，随后立刻执行本条指令');
    }
    const nextItem = queue.shift();
    if (queue.length === 0) chatQueues.delete(runKey);
    void runner.executePrompt(nextItem.payload);
    return toastCardResponse('success', '🚀 已立刻开始执行');
  }

  if (cmd === 'retry') {
    const prev = runKey ? lastTaskByChat.get(runKey) : null;
    if (!prev) {
      return toastCardResponse('info', '暂无可重试的最近任务记录');
    }
    const wasRunning = Boolean(runKey && activeRuns.has(runKey));
    if (wasRunning && runner.getQueueForChat(runKey).length >= 5) {
      return toastCardResponse('warning', '任务队列已满（最多 5 条），请稍后再试');
    }
    void runner.enqueueOrExecutePrompt({
      ...prev,
      messageId: '',
      sessionKey: prev.sessionKey || runKey,
      threadRootId: prev.threadRootId || threadRootId,
      replyInThread: prev.replyInThread ?? Boolean(threadRootId),
      queueReactionId: '',
      config,
    }).catch((err) => {
      console.error('[feishu-remote] retry error:', err);
    });
    return toastCardResponse('success', wasRunning ? '📥 已将重试任务加入队列' : '🔄 正在重新执行上一次任务...');
  }

  if (cmd === 'cd') {
    const targetDir = expandHomePath(arg, chatState.cwd);
    try {
      const stat = fs.statSync(targetDir);
      if (!stat.isDirectory()) {
        return toastCardResponse('error', '目标路径不是文件夹');
      }
      chatState.cwd = targetDir;
      if (threadRootId && targetChatId) {
        getOrCreateChatState(state, targetChatId, config).cwd = targetDir;
      }
      saveState(state);
      return toastCardResponse(
        'success',
        `已切换目录到 ${path.basename(targetDir) || targetDir}`,
        inplace ? renderPanel() : null,
      );
    } catch (err) {
      return toastCardResponse('error', `切换目录失败：${err.message}`);
    }
  }

  if (cmd === 'pin' || cmd === 'pin_in_dirs') {
    const resolved = path.resolve(chatState.cwd);
    const existing = Array.isArray(config.agy.favoriteDirs)
      ? config.agy.favoriteDirs.map((d) => path.resolve(d))
      : [];
    const idx = existing.indexOf(resolved);
    let actionLabel = '';
    if (idx !== -1) {
      existing.splice(idx, 1);
      actionLabel = '已取消收藏当前目录';
    } else {
      existing.unshift(resolved);
      actionLabel = '已收藏到快捷目录';
    }
    config.agy.favoriteDirs = existing;
    saveConfig(config);
    saveState(state);
    const page = Number(value?.page || 0);
    if (cmd === 'pin_in_dirs') {
      return toastCardResponse('success', actionLabel, buildDirsCard({ chatState, config, page }));
    }
    return toastCardResponse('success', actionLabel, inplace ? renderPanel() : null);
  }

  if (cmd === 'dirs') {
    saveState(state);
    const page = Number(value?.page || 0);
    const card = buildDirsCard({ chatState, config, page });
    if (inplace) {
      return toastCardResponse('info', value?.page !== undefined ? '已切换目录页' : '目录浏览', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send dirs card error:', err.message);
    });
    return toastCardResponse('info', '已打开目录浏览');
  }

  if (cmd === 'dir_nav') {
    const targetDir = expandHomePath(arg, chatState.cwd);
    try {
      const stat = fs.statSync(targetDir);
      if (!stat.isDirectory()) {
        return toastCardResponse('error', '目标路径不是文件夹');
      }
      chatState.cwd = targetDir;
      if (threadRootId && targetChatId) {
        getOrCreateChatState(state, targetChatId, config).cwd = targetDir;
      }
      saveState(state);
      return toastCardResponse(
        'success',
        `已进入 ${path.basename(targetDir) || targetDir}`,
        buildDirsCard({ chatState, config }),
      );
    } catch (err) {
      return toastCardResponse('error', `进入目录失败：${err.message}`);
    }
  }

  if (cmd === 'quick') {
    saveState(state);
    const card = buildQuickPromptsCard({ chatState, config });
    if (inplace) {
      return toastCardResponse('info', '快捷任务', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send quick card error:', err.message);
    });
    return toastCardResponse('info', '已打开快捷任务');
  }

  if (cmd === 'quick_run') {
    const prompts = getEffectiveQuickPrompts(config);
    const idx = Number(arg);
    const item = Number.isInteger(idx) && idx >= 0 && idx < prompts.length ? prompts[idx] : null;
    if (!item) {
      return toastCardResponse('error', '未找到对应快捷任务');
    }
    const wasRunning = Boolean(runKey && activeRuns.has(runKey));
    if (wasRunning && runner.getQueueForChat(runKey).length >= 5) {
      return toastCardResponse('warning', '任务队列已满（最多 5 条），请先清理队列');
    }
    saveState(state);
    void runner.enqueueOrExecutePrompt({
      text: item.prompt,
      displayPreview: item.label,
      chatId: targetChatId,
      openId,
      messageId: '',
      sessionKey: runKey,
      threadRootId,
      replyInThread: Boolean(threadRootId),
      config,
    }).catch((err) => {
      console.error('[feishu-remote] quick_run error:', err);
    });
    return toastCardResponse('success', wasRunning ? `📥 已加入队列：${item.label}` : `🚀 已触发：${item.label}`);
  }

  if (cmd === 'quick_manage') {
    saveState(state);
    return toastCardResponse(
      'info',
      '点击条目可删除快捷任务',
      buildQuickPromptsCard({ chatState, config, manageMode: true }),
    );
  }

  if (cmd === 'quick_del') {
    const current = [...getEffectiveQuickPrompts(config)];
    const idx = Number(arg);
    if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
      return toastCardResponse('error', '未找到对应快捷任务');
    }
    const [removed] = current.splice(idx, 1);
    config.agy.quickPrompts = current;
    saveConfig(config);
    saveState(state);
    const note = current.length === 0
      ? `已删除「${removed.label}」，已恢复内置默认`
      : `已删除「${removed.label}」`;
    return toastCardResponse(
      'success',
      note,
      buildQuickPromptsCard({ chatState, config, manageMode: current.length > 0 }),
    );
  }

  if (cmd === 'quick_reset') {
    config.agy.quickPrompts = [];
    saveConfig(config);
    saveState(state);
    return toastCardResponse(
      'success',
      '🔄 已恢复内置默认快捷任务',
      buildQuickPromptsCard({ chatState, config, manageMode: false }),
    );
  }

  if (cmd === 'stop') {
    const running = runKey ? activeRuns.get(runKey) : null;
    if (!running) {
      return toastCardResponse('info', '当前没有运行中的任务', inplace ? renderPanel() : null);
    }
    running.controller.abort();
    return toastCardResponse('warning', '🛑 已发送中止信号', inplace ? renderPanel() : null);
  }

  if (cmd === 'use') {
    if (!arg) {
      return toastCardResponse('error', '缺少会话 ID');
    }
    chatState.conversationId = arg;
    chatState.pendingHandoff = null;
    saveState(state);
    return toastCardResponse(
      'success',
      `已切换到会话 ${arg.slice(0, 8)}`,
      inplace ? buildSessionsCard(chatState) : null,
    );
  }

  if (cmd === 'model') {
    chatState.model = arg === 'default' || !arg ? '' : arg;
    saveState(state);
    return toastCardResponse(
      'success',
      `已切换模型为 ${chatState.model || 'default'}`,
      inplace ? renderPanel() : null,
    );
  }

  if (cmd === 'sessions') {
    saveState(state);
    const card = buildSessionsCard(chatState);
    if (inplace) {
      return toastCardResponse('info', '最近会话', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send sessions card error:', err.message);
    });
    return toastCardResponse('info', '已打开最近会话');
  }

  if (cmd === 'models') {
    saveState(state);
    void listAgyModels(config)
      .then(async (models) => {
        const card = buildModelsCard(models, chatState.model);
        if (inplace && openMessageId) {
          try {
            await patchCard(client, { messageId: openMessageId, card });
            return;
          } catch {
            // Fallback to sending a new card
          }
        }
        await sendToTarget(card);
      })
      .catch((err) => sendToTarget(buildCard({
        title: '❌ 查询模型失败',
        template: 'red',
        markdown: String(err.message || err),
      })))
      .catch((err) => {
        console.error('[feishu-remote] send models card error:', err.message);
      });
    return toastCardResponse('info', '正在获取模型列表...');
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
  if (allowed.length > 0 && !allowed.includes(openId)) {
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
    const check = runPreflightCheck();
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
    await sendToTarget(buildGitStatusCard({ cwd: chatState.cwd, gitInfo: collectGitInfo(chatState.cwd) }));
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

  if (key === 'quick' || key === 'tasks') {
    await sendToTarget(buildQuickPromptsCard({ chatState, config }));
    return;
  }

  if (key === 'dirs' || key === 'cd') {
    await sendToTarget(buildDirsCard({ chatState, config }));
    return;
  }

  if (key === 'new') {
    chatState.conversationId = '';
    saveState(state);
    await sendToTarget(buildCard({
      title: '🆕 已开启新对话',
      template: 'green',
      markdown: `下条消息将在 \`${chatState.cwd}\` 下开启全新上下文。`,
      buttonRows: [[
        { label: '⚙️ 控制面板', value: { cmd: 'panel' } },
        { label: '⚡ 快捷任务', value: { cmd: 'quick' } },
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

  if (key === 'help') {
    await sendToTarget(buildCard({
      title: '🤖 Antigravity 飞书遥控指令',
      template: 'blue',
      markdown: formatHelpMarkdown(),
      buttonRows: [[
        { label: '⚙️ 打开控制面板', type: 'primary', value: { cmd: 'panel' } },
        { label: '⚡ 快捷任务', value: { cmd: 'quick' } },
      ]],
    }));
    return;
  }

  console.warn(`[feishu-remote] Unrecognized bot menu event_key=${eventKey}, falling back to control panel`);
  await sendPanel();
}
