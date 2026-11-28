import fs from 'node:fs';
import { updateState } from '../config.mjs';
import {
  buildCard,
  buildDesktopSessionPreviewCard,
  buildDesktopSessionsCard,
  deliverFinalCard,
  patchCard,
  sanitizeForFeishuMarkdown,
  sendCard,
  stampCardThreadRoot,
} from '../feishu-api.mjs';
import {
  buildDesktopHandoffContext,
  getDesktopSessionDetail,
  listDesktopSessions,
} from '../desktop-sessions.mjs';
import {
  buildHandoffCard,
  copyToSystemClipboardAsync,
  readMobileSession,
  writeHandoffSnapshot,
} from '../mobile-handoff.mjs';
import {
  expandHomePath,
  getOrCreateChatState,
  makeSessionKey,
  recordRecentConversation,
  resolveDefaultTopicChatId,
  toastCardResponse,
} from '../bridge-helpers.mjs';

export function applyDesktopTakeover({
  chatState,
  convId,
  fallbackCwd = '',
  fallbackSummary = '',
}) {
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
  chatState.topicClosed = false;
  chatState.persistentSession = false;
  chatState.pendingCommand = null;
  if (mode === 'handoff' && detail) {
    chatState.conversationId = '';
    chatState.lastTurnArtifacts = null;
    chatState.originDesktopSession = {
      id: detail.id,
      title,
      source: detail.source,
      workspace: chatState.cwd,
      takenOverAt: Date.now(),
      desktopLastModifiedMs: detail.lastModifiedMs || 0,
      desktopStepCount: detail.stepCount || 0,
    };
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
    chatState.originDesktopSession = null;
    chatState.lastTurnArtifacts = null;
    recordRecentConversation(chatState, resolvedId, title, { cwd: chatState.cwd });
  }
  return { mode, detail, resolvedId, title };
}

export function pushDesktopLastReply(
  { client, targetChatId, openId, threadRootId, runKey, recordCardThread },
  detail,
  fallbackTitle = '',
) {
  const replyText = String(detail?.lastAssistantReply || '').trim();
  if (!replyText) return false;

  const rawTitle = String(detail?.title || fallbackTitle || '(无标题对话)')
    .replace(/[`\r\n]+/g, ' ')
    .trim();
  const safeTitle = sanitizeForFeishuMarkdown(rawTitle);
  const shortId = String(detail?.id || '').slice(0, 8) || '-';
  const quoteLines = [
    `> 💻 来自「${detail?.sourceLabel || '电脑端'}」· **${safeTitle}**（\`${shortId}\`）`,
  ];
  if (detail?.lastAssistantReplyTruncated) {
    quoteLines.push(
      `> ⚠️ 原回复共 ${detail.lastAssistantReplyTotalChars} 字，当前展示前 ${replyText.length} 字`,
    );
  }

  const fullMarkdown = `${quoteLines.join('\n')}\n\n${replyText}`;
  const footer = detail?.lastAssistantReplyTotalChars
    ? `来自电脑端最后一条模型回复 · 共 ${detail.lastAssistantReplyTotalChars} 字`
    : '来自电脑端最后一条模型回复';

  void deliverFinalCard(client, {
    chatId: targetChatId,
    receiveId: openId,
    receiveIdType: 'open_id',
    replyTargetMessageId: threadRootId,
    replyInThread: Boolean(threadRootId),
    title: '💬 电脑端最新模型回复',
    template: 'wathet',
    markdown: fullMarkdown,
    footer,
    buttonRows: [[
      { label: '⚙️ 控制面板', value: { cmd: 'panel' } },
      { label: '💻 电脑对话', value: { cmd: 'desktop_list', filter: 'all' } },
    ]],
  })
    .then((msgIds) => {
      if (threadRootId && Array.isArray(msgIds)) {
        for (const msgId of msgIds) {
          if (msgId) {
            recordCardThread(msgId, { sessionKey: runKey, threadRootId, chatId: targetChatId });
          }
        }
      }
    })
    .catch((err) => {
      console.error('[feishu-remote] pushDesktopLastReply error:', err?.message || err);
    });

  return true;
}

export async function handleDesktopAction(actionCtx) {
  const {
    client,
    activeRuns,
    runner,
    recordCardThread,
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
    sendToTarget,
  } = actionCtx;

  const replyOpts = { client, targetChatId, openId, threadRootId, runKey, recordCardThread };

  if (cmd === 'takeover') {
    const convId = arg.trim();
    if (!convId) {
      return toastCardResponse('error', '缺少要接管的会话 ID');
    }
    const rawCwd = String(value?.cwd || '').trim();
    const summary = String(value?.summary || '').trim();
    runner?.releasePersistentSession?.(runKey);
    let takeoverInfo;
    updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, runKey, config);
      takeoverInfo = applyDesktopTakeover({
        chatState: targetChat,
        convId,
        fallbackCwd: rawCwd,
        fallbackSummary: summary,
      });
      Object.assign(chatState, targetChat);
    });
    const { mode, detail, resolvedId, title } = takeoverInfo;
    const pushedReply = pushDesktopLastReply(replyOpts, detail, title);

    const buttonRow = [
      { label: '⚙️ 打开控制面板', type: 'primary', value: { cmd: 'panel', inplace: true } },
      { label: '💻 电脑对话', value: { cmd: 'desktop_list', filter: 'all', inplace: true } },
    ];
    if (pushedReply) {
      buttonRow.push({ label: '📄 重发最新回复', value: { cmd: 'desktop_last_reply', arg: resolvedId } });
    }

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
        pushedReply
          ? `- **模型最新回复**：✅ 已自动推送至下方卡片（共 ${detail.lastAssistantReplyTotalChars} 字）`
          : '- **模型最新回复**：_（暂未读取到该会话的模型文本回复）_',
        mode === 'handoff'
          ? '- **回电脑继续**：聊完后点「💻 交回电脑」或回桌面端说「同步一下手机进度」即可衔接'
          : '',
        '',
        '现在可以直接在飞书发消息，继续推进该任务。',
      ].filter(Boolean).join('\n'),
      buttonRows: [buttonRow],
    });
    return toastCardResponse(
      'success',
      mode === 'handoff' ? '✅ 已挂载桌面端上下文，直接发消息即可延续' : '✅ 已直连电脑端对话，直接发消息即可继续',
      card,
    );
  }

  if (cmd === 'desktop_list') {
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

  if (cmd === 'desktop_last_reply') {
    const detail = getDesktopSessionDetail(arg);
    if (!detail) {
      return toastCardResponse('error', '未找到对应的电脑端对话记录');
    }
    const pushed = pushDesktopLastReply(replyOpts, detail, detail.title);
    return toastCardResponse(
      pushed ? 'success' : 'info',
      pushed ? '💬 正在推送电脑端最新模型回复...' : '该对话暂无可展示的模型文本回复',
    );
  }

  if (cmd === 'desktop_takeover') {
    const convId = arg.trim();
    if (!convId) {
      return toastCardResponse('error', '缺少要接管的会话 ID');
    }
    const summarize = Boolean(value?.summarize);
    runner?.releasePersistentSession?.(runKey);
    let takeoverInfo;
    updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, runKey, config);
      takeoverInfo = applyDesktopTakeover({ chatState: targetChat, convId });
      Object.assign(chatState, targetChat);
    });
    const { mode, detail, resolvedId, title } = takeoverInfo;
    const pushedReply = !summarize ? pushDesktopLastReply(replyOpts, detail, title) : false;

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

    const buttonRow = [
      { label: '⚙️ 控制面板', type: 'primary', value: { cmd: 'panel', inplace: true } },
      { label: '💻 电脑对话', value: { cmd: 'desktop_list', filter: 'all', inplace: true } },
    ];
    if (pushedReply) {
      buttonRow.push({ label: '📄 重发最新回复', value: { cmd: 'desktop_last_reply', arg: resolvedId } });
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
        !summarize
          ? pushedReply
            ? `- **模型最新回复**：✅ 已自动推送至下方卡片（共 ${detail.lastAssistantReplyTotalChars} 字）`
            : '- **模型最新回复**：_（暂未读取到该会话的模型文本回复）_'
          : '',
        summarizeQueuedMsg ? `- **自动动作**：${summarizeQueuedMsg}` : '',
        mode === 'handoff'
          ? '- **回电脑继续**：后续点「💻 交回电脑」或回桌面端让 AI 同步手机进展即可'
          : '',
      ].filter(Boolean).join('\n'),
      buttonRows: [buttonRow],
    });
    return toastCardResponse(
      'success',
      summarize ? '👀 已接管并启动进度总结' : '✅ 已接管对话并切好目录',
      card,
    );
  }

  if (cmd === 'takeover_new_topic') {
    const convId = arg.trim();
    if (!convId) {
      return toastCardResponse('error', '缺少要接管的会话 ID');
    }
    const topicChatId = resolveDefaultTopicChatId(state, config, targetChatId, Boolean(threadRootId));
    if (!topicChatId) {
      return toastCardResponse(
        'warning',
        '尚未绑定话题群：请先把机器人拉进飞书话题群并发送一条消息，或在话题群发送 /topic set',
      );
    }

    const detail = getDesktopSessionDetail(convId);
    const resolvedId = detail?.id || convId;
    const rawCwd = String(value?.cwd || '').trim();
    const summary = String(value?.summary || '').trim();
    const title = detail?.title || summary || '(电脑端接管对话)';
    const summarize = Boolean(value?.summarize);
    const targetCwdPreview = rawCwd || detail?.workspace || chatState.cwd;
    const safeTitle = sanitizeForFeishuMarkdown(title).replace(/\s+/g, ' ').slice(0, 36);

    const rootCard = buildCard({
      title: `🧵 接管：${safeTitle}`,
      template: 'green',
      markdown: [
        detail?.takeoverMode === 'native'
          ? '- **接管方式**：✅ **原生直连（独立话题楼）**'
          : '- **接管方式**：🔄 **只读摘要接管（独立话题楼）**',
        `- **原会话 ID**：\`${resolvedId.slice(0, 8)}\`（\`${resolvedId}\`）`,
        `- **工作目录**：\`${targetCwdPreview}\``,
        '- **自动回流**：后续若继续在电脑端处理此会话，完成通知会自动回到本话题楼，避免重复建楼。',
        '',
        '请在本话题楼内直接回复，即可推进此任务。',
      ].join('\n'),
      buttonRows: [[
        { label: '⚙️ 控制面板', type: 'primary', value: { cmd: 'panel' } },
        { label: '💻 交回电脑', value: { cmd: 'handoff' } },
        { label: '🔓 结束追踪', value: { cmd: 'unlink_topic' } },
      ]],
    });

    let rootMessageId = '';
    try {
      rootMessageId = await sendCard(client, {
        receiveId: topicChatId,
        receiveIdType: 'chat_id',
        card: rootCard,
      });
    } catch (err) {
      return toastCardResponse('error', `在话题群新开话题失败：${err?.message || err}`);
    }
    if (!rootMessageId) {
      return toastCardResponse('error', '在话题群新开话题失败：未返回消息 ID');
    }
    void patchCard(client, {
      messageId: rootMessageId,
      card: stampCardThreadRoot(rootCard, rootMessageId),
    }).catch(() => {});

    const newSessionKey = makeSessionKey(topicChatId, rootMessageId);
    let newChatState = {};
    let mode = 'native';
    updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, newSessionKey, config);
      const res = applyDesktopTakeover({
        chatState: targetChat,
        convId,
        fallbackCwd: rawCwd,
        fallbackSummary: summary,
      });
      mode = res.mode;
      latest.lastTopicChatId = topicChatId;
      newChatState = { ...targetChat };
    });
    recordCardThread(rootMessageId, {
      sessionKey: newSessionKey,
      threadRootId: rootMessageId,
      chatId: topicChatId,
    });

    const newThreadReplyOpts = {
      client,
      targetChatId: topicChatId,
      openId,
      threadRootId: rootMessageId,
      runKey: newSessionKey,
      recordCardThread,
    };

    let pushedReply = false;
    if (summarize) {
      void runner.enqueueOrExecutePrompt({
        text: '请结合接管到的历史上下文与当前工作目录现状（如文件与最近改动），用要点简要汇报当前进展、已完成事项与下一步建议。',
        displayPreview: `👀 总结电脑端进展：${title.slice(0, 24)}`,
        chatId: topicChatId,
        openId,
        messageId: '',
        sessionKey: newSessionKey,
        threadRootId: rootMessageId,
        replyInThread: true,
        config,
      }).catch((err) => {
        console.error('[feishu-remote] takeover_new_topic summarize error:', err);
      });
    } else {
      pushedReply = pushDesktopLastReply(newThreadReplyOpts, detail, title);
    }

    const confirmCard = buildCard({
      title: '🧵 已在话题群新开独立话题承接',
      template: 'green',
      markdown: [
        `- **话题标题**：${safeTitle}`,
        `- **接管模式**：${mode === 'handoff' ? '🔄 只读摘要接管' : '✅ 原生直连'}`,
        `- **新楼工作目录**：\`${newChatState.cwd}\``,
        pushedReply ? '- **模型最新回复**：✅ 已一并推送到新话题楼内' : '',
        '- **当前窗口**：未受影响，保持原有上下文不变。',
        '',
        '请前往话题群的新话题楼内继续对话。',
      ].filter(Boolean).join('\n'),
      buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel', inplace: true } }]],
    });
    return toastCardResponse('success', '🧵 已在话题群新开话题承接，请前往话题群续聊', confirmCard);
  }

  if (cmd === 'unlink_topic') {
    updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, runKey, config);
      targetChat.topicClosed = true;
      targetChat.originDesktopSession = null;
      targetChat.pendingHandoff = null;
      Object.assign(chatState, targetChat);
    });
    const card = buildCard({
      title: '🔓 已结束本话题与电脑端的自动回流追踪',
      template: 'grey',
      markdown: '后续电脑端若再运行原对话，完成通知将回到私聊总收件箱，不再推送到此话题楼。',
      buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel', inplace: true } }]],
    });
    return toastCardResponse('success', '🔓 已解除本话题与电脑端的自动回流追踪', card);
  }

  if (cmd === 'desktop_sync_latest') {
    const convId = arg.trim() || chatState.originDesktopSession?.id || '';
    if (!convId) {
      return toastCardResponse('error', '当前会话未绑定原电脑端会话');
    }
    const detail = getDesktopSessionDetail(convId);
    if (!detail) {
      return toastCardResponse('error', '未找到原电脑端对话记录');
    }
    updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, runKey, config);
      targetChat.topicClosed = false;
      targetChat.originDesktopSession = {
        ...(targetChat.originDesktopSession || {}),
        id: detail.id,
        title: detail.title || targetChat.originDesktopSession?.title || '',
        source: detail.source || targetChat.originDesktopSession?.source || 'desktop',
        workspace: targetChat.cwd,
        takenOverAt: targetChat.originDesktopSession?.takenOverAt || Date.now(),
        desktopLastModifiedMs: detail.lastModifiedMs || 0,
        desktopStepCount: detail.stepCount || 0,
      };
      targetChat.pendingHandoff = {
        id: detail.id,
        title: detail.title,
        source: detail.source,
        cwd: targetChat.cwd,
        contextBlock: buildDesktopHandoffContext(detail),
        createdAt: Date.now(),
      };
      Object.assign(chatState, targetChat);
    });

    const pushed = pushDesktopLastReply(replyOpts, detail, detail.title);
    const card = buildCard({
      title: '🔄 已增量同步电脑端最新进展',
      template: 'green',
      markdown: [
        `- **原桌面端对话**：${sanitizeForFeishuMarkdown(detail.title || '(无标题)')}（\`${detail.id.slice(0, 8)}\`）`,
        `- **最新步数**：\`${detail.stepCount || 0}\` 步`,
        pushed
          ? `- **最新回复**：✅ 已推送至下方卡片（共 ${detail.lastAssistantReplyTotalChars} 字）`
          : '- **最新回复**：_（暂未读取到新回复）_',
        '',
        '已将电脑端最新上下文挂载为待注入块，你下一条飞书消息会自动带上它。',
      ].join('\n'),
      buttonRows: [[
        { label: '⚙️ 控制面板', type: 'primary', value: { cmd: 'panel', inplace: true } },
        { label: '💻 交回电脑', value: { cmd: 'handoff', inplace: true } },
      ]],
    });
    return toastCardResponse('success', '🔄 已同步电脑端最新进展', card);
  }

  if (cmd === 'handoff' || cmd === 'handoff_copy') {
    const runHandoff = async () => {
      const targetConvId = arg.trim() || chatState.conversationId || '';
      const session = readMobileSession({
        conversationId: targetConvId,
        cwd: chatState.cwd,
        originDesktopId: chatState.originDesktopSession?.id || '',
      });
      if (!session.found) {
        return toastCardResponse('info', session.error || '当前暂无可交回电脑的手机端会话');
      }
      const target = String(value?.target || 'cli').toLowerCase() === 'desktop' ? 'desktop' : 'cli';
      const textToCopy = target === 'desktop' ? session.desktopHandoffPrompt : session.cliResumeCommand;
      const clipboardResult = await copyToSystemClipboardAsync(textToCopy);
      const snap = writeHandoffSnapshot({
        conversationId: session.conversationId,
        cwd: session.cwd,
        cliResumeCommand: session.cliResumeCommand,
        desktopHandoffPrompt: session.desktopHandoffPrompt,
        modifiedFiles: session.modifiedFiles,
        originDesktopSession: session.originDesktopSession,
      });
      const card = buildHandoffCard({
        session,
        clipboardResult,
        copiedTarget: target,
        snapshotPath: snap.latestPath,
      });
      const toastMsg = clipboardResult.ok
        ? (target === 'desktop' ? '📋 已复制桌面交接提示词' : '📋 已复制终端恢复命令')
        : '💻 已生成交接信息（剪贴板未写入，请直接复制卡片命令）';
      if (inplace) {
        return toastCardResponse(clipboardResult.ok ? 'success' : 'info', toastMsg, card);
      }
      void sendToTarget(card).catch((err) => {
        console.error('[feishu-remote] send handoff card error:', err.message);
      });
      return toastCardResponse(clipboardResult.ok ? 'success' : 'info', toastMsg);
    };
    return typeof actionCtx.runWithinBudget === 'function'
      ? actionCtx.runWithinBudget('💻 正在生成交接卡片...', runHandoff)
      : runHandoff();
  }

  return null;
}
