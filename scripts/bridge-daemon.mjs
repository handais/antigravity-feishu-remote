import * as Lark from '@larksuiteoapi/node-sdk';
import {
  loadConfig,
  loadState,
  saveConfig,
  saveState,
  stripProcessProxyEnv,
} from './lib/config.mjs';
import {
  buildCard,
  createFeishuClient,
  createStderrLogger,
  resolveLarkDomain,
} from './lib/feishu-api.mjs';
import { extractFeishuDocLinks, readFeishuDoc } from './lib/feishu-docs.mjs';
import {
  buildMultimodalPrompt,
  downloadMessageAttachments,
  extractInboundMessage,
  fetchQuotedMessageContext,
  maintainRuntimeStorage,
} from './lib/media.mjs';
import {
  computePluginCodeHash,
  consumePendingRestartNotice,
  createBackupSnapshot,
} from './lib/self-ops.mjs';
import { maskIdentifier } from './lib/io-utils.mjs';
import {
  enforceTempFullExpiry,
  formatHelpMarkdown,
  makeSessionKey,
  parseSessionKey,
  replySimpleCard,
  sendCardToTarget,
  stripMentions,
  toastCardResponse,
} from './lib/bridge-helpers.mjs';
import { createTaskRunner } from './lib/task-runner.mjs';
import { handleSlashCommand } from './lib/slash-commands.mjs';
import { handleBotMenuEvent, handleCardAction } from './lib/card-actions.mjs';

const startedAt = Date.now();
const bootCodeHash = computePluginCodeHash();
const initialConfig = loadConfig();
stripProcessProxyEnv(initialConfig.feishu.proxy);

if (!initialConfig.feishu.appId || !initialConfig.feishu.appSecret) {
  console.error('[feishu-remote] Missing appId or appSecret. Run `cli.mjs setup` first.');
  process.exit(1);
}

const client = createFeishuClient(initialConfig, { quiet: false });
const wsClient = new Lark.WSClient({
  appId: initialConfig.feishu.appId,
  appSecret: initialConfig.feishu.appSecret,
  domain: resolveLarkDomain(initialConfig.feishu.domain),
  logger: createStderrLogger('lark-ws'),
  loggerLevel: Lark.LoggerLevel.warn,
});

const seenMessageIds = new Set();
const activeRuns = new Map(); // runKey -> { controller, promptPreview, startedAt }
const chatQueues = new Map(); // runKey -> Array<{ id, queuedAt, payload, queueMessageId }>
const lastTaskByChat = new Map(); // runKey -> payload
const cardThreadMap = new Map(); // cardMessageId -> { sessionKey, threadRootId, chatId }
const chatModeCache = new Map(); // chatId -> 'topic' | 'group' | ...
let cachedBotOpenId = '';
let botInfoFetchedAt = 0;

async function getBotOpenId() {
  if (cachedBotOpenId) return cachedBotOpenId;
  if (Date.now() - botInfoFetchedAt < 60_000) return '';
  botInfoFetchedAt = Date.now();
  try {
    const res = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    const id = String(res?.bot?.open_id || res?.data?.bot?.open_id || '').trim();
    if (id) cachedBotOpenId = id;
  } catch {
    // Non-fatal; fallback to non-empty mentions check
  }
  return cachedBotOpenId;
}

function recordCardThread(cardMessageId, meta) {
  if (!cardMessageId || !meta?.threadRootId) return;
  if (cardThreadMap.size >= 1500) {
    const oldest = cardThreadMap.keys().next().value;
    if (oldest !== undefined) cardThreadMap.delete(oldest);
  }
  cardThreadMap.set(cardMessageId, {
    sessionKey: meta.sessionKey || makeSessionKey(meta.chatId, meta.threadRootId),
    threadRootId: meta.threadRootId,
    chatId: meta.chatId || '',
  });
}

async function resolveTopicContext(message, chatId, chatType) {
  if (chatType === 'p2p' || !chatId) {
    return { isTopicThread: false, threadRootId: '', sessionKey: chatId };
  }
  if (message.thread_id) {
    const threadRootId = message.root_id || message.message_id;
    return {
      isTopicThread: Boolean(threadRootId),
      threadRootId,
      sessionKey: makeSessionKey(chatId, threadRootId),
    };
  }
  let chatMode = chatModeCache.get(chatId);
  if (!chatMode && chatId.startsWith('oc_')) {
    try {
      const res = await client.im.v1.chat.get({ path: { chat_id: chatId } });
      chatMode = res?.data?.chat_mode || 'group';
    } catch {
      chatMode = 'group';
    }
    if (chatModeCache.size >= 500) {
      const oldest = chatModeCache.keys().next().value;
      if (oldest !== undefined) chatModeCache.delete(oldest);
    }
    chatModeCache.set(chatId, chatMode);
  }
  if (chatMode === 'topic') {
    const threadRootId = message.root_id || message.message_id;
    return {
      isTopicThread: Boolean(threadRootId),
      threadRootId,
      sessionKey: makeSessionKey(chatId, threadRootId),
    };
  }
  return { isTopicThread: false, threadRootId: '', sessionKey: chatId };
}

function markMessageSeen(messageId) {
  if (!messageId) return false;
  if (seenMessageIds.has(messageId)) return true;
  if (seenMessageIds.size >= 2000) {
    const oldest = seenMessageIds.values().next().value;
    if (oldest !== undefined) seenMessageIds.delete(oldest);
  }
  seenMessageIds.add(messageId);
  return false;
}

function stopWsForRestart() {
  for (const running of activeRuns.values()) {
    try {
      running.controller.abort();
    } catch {
      // Ignore
    }
  }
  chatQueues.clear();
  try {
    wsClient.close({ force: true });
  } catch {
    // Ignore
  }
}

const runner = createTaskRunner({
  client,
  activeRuns,
  chatQueues,
  lastTaskByChat,
  recordCardThread,
});

const ctx = {
  client,
  startedAt,
  bootCodeHash,
  activeRuns,
  chatQueues,
  lastTaskByChat,
  cardThreadMap,
  chatModeCache,
  recordCardThread,
  runner,
  stopWsForRestart,
};

async function handleIncomingMessage(rawEvent) {
  const payload = rawEvent?.message ? rawEvent : rawEvent?.event || rawEvent;
  const sender = payload?.sender;
  const message = payload?.message;
  if (!sender || !message) return;

  if (sender.sender_type !== 'user') return;
  if (markMessageSeen(message.message_id)) return;

  const createMs = Number(message.create_time || 0);
  if (createMs > 0 && Date.now() - createMs > 5 * 60 * 1000) {
    return;
  }

  const config = loadConfig();
  const openId = sender.sender_id?.open_id || '';
  const chatId = message.chat_id || '';
  const chatType = message.chat_type || 'p2p';
  const messageId = message.message_id || '';

  if (!openId || !chatId || !messageId) return;

  if (chatType === 'group') {
    const policy = config.security.groupPolicy || 'mention';
    if (policy === 'off') return;
    if (policy === 'mention') {
      const mentions = Array.isArray(message.mentions) ? message.mentions : [];
      if (mentions.length === 0) return;
      const botId = await getBotOpenId();
      if (botId) {
        const mentionedBot = mentions.some((m) => (m?.id?.open_id || m?.open_id || '') === botId);
        if (!mentionedBot) return;
      }
    }
  }

  const { supported, text: rawText, msgType, attachments } = extractInboundMessage(message);
  const text = stripMentions(rawText, message.mentions);

  const allowed = config.security.allowedOpenIds || [];
  let justBound = false;

  if (allowed.length === 0 && config.security.autoBindFirstUser && chatType === 'p2p') {
    config.security.allowedOpenIds = [openId];
    config.security.autoBindFirstUser = false;
    if (!config.notifications.defaultReceiveId) {
      config.notifications.defaultReceiveId = openId;
      config.notifications.defaultReceiveIdType = 'open_id';
    }
    saveConfig(config);
    justBound = true;
    console.error(`[feishu-remote] Auto-bound first p2p user open_id=${maskIdentifier(openId)}`);

    await replySimpleCard(client, messageId, {
      title: '🎉 绑定成功，已授权为主人账号',
      template: 'green',
      markdown: [
        `已将你的飞书 \`open_id\`（\`${openId}\`）设为唯一授权白名单。`,
        '',
        formatHelpMarkdown(),
      ].join('\n'),
      buttonRows: [[{ label: '⚙️ 打开控制面板', type: 'primary', value: { cmd: 'panel' } }]],
    });

    const greetingWords = new Set(['你好', 'hi', 'hello', 'hey', '/bind', '/start', '开始']);
    if (attachments.length === 0 && (!supported || !text || greetingWords.has(text.toLowerCase()))) {
      const stateAfterBind = loadState();
      if (stateAfterBind.lastP2pChatByOpenId[openId] !== chatId) {
        stateAfterBind.lastP2pChatByOpenId[openId] = chatId;
        saveState(stateAfterBind);
      }
      return;
    }
  } else if (!openId || allowed.length === 0 || !allowed.includes(openId)) {
    if (chatType === 'p2p') {
      await replySimpleCard(client, messageId, {
        title: '🔒 未授权访问',
        template: 'grey',
        markdown: allowed.length === 0
          ? `当前机器人未配置允许白名单且已关闭自动绑定（Fail-Closed）。\n请在主机运行以下命令添加你的 \`open_id\`：\n\`cli.mjs setup --allow-open-id ${openId || '<OPEN_ID>'}\``
          : `当前机器人仅限白名单用户使用。\n你的 \`open_id\` 为：\`${openId}\`\n\n如需授权，请在主机运行：\n\`cli.mjs setup --allow-open-id ${openId}\``,
      });
    }
    return;
  }

  if (chatType === 'p2p') {
    if (chatModeCache.get(chatId) !== 'p2p') {
      if (chatModeCache.size >= 500) {
        const oldest = chatModeCache.keys().next().value;
        if (oldest !== undefined) chatModeCache.delete(oldest);
      }
      chatModeCache.set(chatId, 'p2p');
    }
    const p2pState = loadState();
    if (p2pState.lastP2pChatByOpenId[openId] !== chatId) {
      p2pState.lastP2pChatByOpenId[openId] = chatId;
      saveState(p2pState);
    }
  }

  const { isTopicThread, threadRootId, sessionKey } = await resolveTopicContext(message, chatId, chatType);
  if (isTopicThread && chatId) {
    const topicState = loadState();
    if (topicState.lastTopicChatId !== chatId) {
      topicState.lastTopicChatId = chatId;
      saveState(topicState);
    }
  }
  const runKey = sessionKey || chatId || openId;
  const replyTargetId = isTopicThread ? (threadRootId || messageId) : messageId;

  if (!supported) {
    if (!justBound) {
      const sentErrId = await replySimpleCard(client, replyTargetId, {
        title: 'ℹ️ 暂不支持该消息类型',
        template: 'grey',
        markdown: `当前支持文本、富文本、任务(todo)、图片/截图、文件和语音消息，暂不支持 \`${msgType || 'unknown'}\` 类型。`,
        replyInThread: isTopicThread,
      });
      if (isTopicThread && sentErrId) {
        recordCardThread(sentErrId, { sessionKey: runKey, threadRootId, chatId });
      }
    }
    return;
  }

  if (!text && attachments.length === 0) return;

  if (text.startsWith('/') && attachments.length === 0) {
    const handled = await handleSlashCommand(ctx, {
      text,
      chatId,
      openId,
      messageId,
      sessionKey: runKey,
      threadRootId,
      replyInThread: isTopicThread,
      config,
    });
    if (handled) return;
  }

  let quoted = null;
  if (message.parent_id) {
    const isPlainTopicFollowup =
      isTopicThread &&
      message.parent_id === threadRootId &&
      Boolean(loadState().chats?.[runKey]?.conversationId);
    if (!isPlainTopicFollowup) {
      try {
        quoted = await fetchQuotedMessageContext(client, {
          parentId: message.parent_id,
          chatKey: chatId || openId,
        });
      } catch {
        quoted = null;
      }
    }
  }

  const docLinks = extractFeishuDocLinks([text, quoted?.text].filter(Boolean).join('\n')).slice(0, 2);
  const docs = [];
  for (const link of docLinks) {
    try {
      const doc = await readFeishuDoc(client, link.url, {
        maxChars: 16000,
        domain: config.feishu.domain,
      });
      docs.push(doc);
    } catch (err) {
      docs.push({
        url: link.url,
        error: err?.message || String(err),
      });
    }
  }

  let downloaded = [];
  let failed = [];
  if (attachments.length > 0) {
    const dl = await downloadMessageAttachments(client, {
      messageId,
      chatKey: chatId || openId,
      attachments,
    });
    downloaded = dl.downloaded;
    failed = dl.failed;
    if (downloaded.length === 0 && !text && !quoted && docs.length === 0) {
      const errReason = failed[0]?.error || '未知错误';
      const sentDlErrId = await replySimpleCard(client, replyTargetId, {
        title: '❌ 附件下载失败',
        template: 'red',
        markdown: [
          `未能下载你发送的附件：\`${errReason}\``,
          '',
          '如提示无权限，请在飞书开放平台「权限管理」开通 **`im:resource`**（获取与上传图片或文件资源）并发布新版本。',
        ].join('\n'),
        replyInThread: isTopicThread,
      });
      if (isTopicThread && sentDlErrId) {
        recordCardThread(sentDlErrId, { sessionKey: runKey, threadRootId, chatId });
      }
      return;
    }
  }

  const hasContext = Boolean(
    downloaded.length > 0 ||
    failed.length > 0 ||
    (quoted && (quoted.text || quoted.downloaded?.length > 0)) ||
    docs.length > 0,
  );
  const finalPrompt = hasContext
    ? buildMultimodalPrompt({ text, downloaded, failed, quoted, docs })
    : text;

  const allFiles = [...downloaded, ...(quoted?.downloaded || [])];
  const kindLabels = [...new Set(allFiles.map((d) => (
    d.kind === 'image' ? '图片' : d.kind === 'audio' ? '语音' : d.kind === 'media' ? '视频' : '文件'
  )))];
  const noteParts = [];
  if (quoted && (quoted.text || quoted.downloaded?.length > 0)) {
    noteParts.push('↩️ 已带入引用消息');
  }
  const okDocsCount = docs.filter((d) => !d.error).length;
  if (docs.length > 0) {
    noteParts.push(okDocsCount > 0 ? `📄 已读取 ${okDocsCount} 篇云文档` : '⚠️ 云文档读取受限');
  }
  if (downloaded.length > 0) {
    noteParts.push(`📎 已接收 ${downloaded.length} 个附件（${kindLabels.join('、')}）`);
  } else if (failed.length > 0) {
    noteParts.push('⚠️ 附件下载失败');
  }

  const tag = kindLabels.length > 0 ? `[${kindLabels.join('/')}]` : docs.length > 0 ? '[云文档]' : quoted ? '[引用]' : '';
  const displayPreview = text
    ? (tag ? `${tag} ${text}` : text)
    : allFiles[0]?.fileName
      ? `${tag} ${allFiles[0].fileName}`
      : docs[0]?.title
        ? `[云文档] ${docs[0].title}`
        : '多模态上下文分析';

  await runner.enqueueOrExecutePrompt({
    text: finalPrompt,
    displayPreview,
    attachmentNote: noteParts.join(' · '),
    chatId,
    openId,
    messageId,
    sessionKey: runKey,
    threadRootId,
    replyInThread: isTopicThread,
    config,
  });
}

const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.warn }).register({
  'im.message.receive_v1': async (data) => {
    void handleIncomingMessage(data).catch((err) => {
      console.error('[feishu-remote] Unhandled message worker error:', err);
    });
  },
  'card.action.trigger': async (data) => {
    const started = Date.now();
    try {
      const result = await handleCardAction(ctx, data);
      const elapsed = Date.now() - started;
      if (elapsed >= 1000) {
        let rawVal = (data?.action || data?.event?.action)?.value;
        if (typeof rawVal === 'string') {
          try {
            rawVal = JSON.parse(rawVal);
          } catch {
            rawVal = {};
          }
        }
        const cmdLabel = String(rawVal?.cmd || 'unknown');
        console.error(`[feishu-remote] Slow card action cmd=${cmdLabel} took ${elapsed}ms`);
      }
      return result;
    } catch (err) {
      console.error('[feishu-remote] Unhandled card action error:', err);
      return toastCardResponse('error', '操作处理失败');
    }
  },
  'application.bot.menu_v6': async (data) => {
    void handleBotMenuEvent(ctx, data).catch((err) => {
      console.error('[feishu-remote] Unhandled bot menu error:', err);
    });
  },
  'im.message.reaction.created_v1': async () => {},
  'im.message.reaction.deleted_v1': async () => {},
});

function shutdown(signalName) {
  console.error(`[feishu-remote] Received ${signalName}, shutting down...`);
  stopWsForRestart();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[feishu-remote] Unhandled promise rejection:', reason);
});

setInterval(() => {
  try {
    const currentState = loadState();
    const currentConfig = loadConfig();
    let dirty = false;
    for (const [key, chatInfo] of Object.entries(currentState.chats || {})) {
      if (activeRuns.has(key)) continue;
      const exp = enforceTempFullExpiry(currentState, chatInfo);
      if (!exp.expired) continue;
      dirty = true;
      const { chatId: parsedChatId, threadRootId } = parseSessionKey(key);
      const targetChatId = parsedChatId.startsWith('oc_')
        ? parsedChatId
        : (currentState.lastP2pChatByOpenId?.[parsedChatId] || '');
      const targetOpenId = parsedChatId.startsWith('ou_')
        ? parsedChatId
        : (currentConfig.notifications.defaultReceiveId || currentConfig.security.allowedOpenIds?.[0] || '');
      void sendCardToTarget(client, {
        chatId: targetChatId,
        openId: targetOpenId,
        replyToMessageId: threadRootId,
        replyInThread: Boolean(threadRootId),
        card: buildCard({
          title: '🛡️ 临时全权限已到期',
          template: 'grey',
          markdown: `临时全权限已到期，系统已自动切回 \`${chatInfo.mode}\` 安全模式。`,
          buttonRows: [[{ label: '⚙️ 打开控制面板', value: { cmd: 'panel' } }]],
        }),
      })
        .then((sentId) => {
          if (threadRootId && sentId) {
            recordCardThread(sentId, { sessionKey: key, threadRootId, chatId: targetChatId });
          }
        })
        .catch(() => {});
    }
    if (dirty) {
      saveState(currentState);
    }
  } catch (err) {
    console.error('[feishu-remote] Temp-full watcher error:', err?.message || err);
  }
}, 30_000).unref();

try {
  const maint = maintainRuntimeStorage();
  if (maint.outLog.pruned || maint.errLog.pruned) {
    console.error(
      `[feishu-remote] Pruned oversized daemon logs (out: ${maint.outLog.pruned}, err: ${maint.errLog.pruned})`,
    );
  }
} catch (err) {
  console.error('[feishu-remote] Startup storage maintenance error:', err?.message || err);
}

setInterval(() => {
  try {
    maintainRuntimeStorage();
  } catch {
    // Ignore periodic maintenance errors
  }
}, 24 * 60 * 60 * 1000).unref();

try {
  const startupSnap = createBackupSnapshot({ reason: 'startup' });
  if (startupSnap.created) {
    console.error(`[feishu-remote] Saved startup snapshot ${startupSnap.snapshot.id}`);
  }
} catch (err) {
  console.error('[feishu-remote] Startup snapshot error:', err?.message || err);
}

console.error(`[feishu-remote] Starting Feishu WebSocket bridge (domain=${initialConfig.feishu.domain}, hash=${bootCodeHash.slice(0, 8)})...`);
wsClient.start({ eventDispatcher: dispatcher }).catch((err) => {
  console.error('[feishu-remote] WSClient fatal error:', err);
  process.exit(1);
});

setTimeout(() => {
  const notice = consumePendingRestartNotice();
  if (!notice || !notice.requestedAt || Date.now() - Number(notice.requestedAt) >= 5 * 60 * 1000) {
    return;
  }
  const isRollback = notice.action === 'rollback';
  const threadRootId = String(notice.threadRootId || '').trim();
  const replyInThread = Boolean(threadRootId) && notice.replyInThread !== false;
  const lines = [
    `- **当前运行版本**：\`${bootCodeHash.slice(0, 8)}\``,
    notice.previousHash ? `- **切换前版本**：\`${String(notice.previousHash).slice(0, 8)}\`` : '',
    isRollback && notice.snapshotId ? `- **恢复快照**：\`${notice.snapshotId}\`` : '',
    `- **进程 PID**：\`${process.pid}\``,
  ].filter(Boolean);
  const card = buildCard({
    title: isRollback ? '✅ 已回滚并重启上线' : '✅ 飞书桥接已安全重启上线',
    template: 'green',
    markdown: lines.join('\n'),
    buttonRows: [[
      { label: '⚙️ 打开控制面板', type: 'primary', value: { cmd: 'panel' } },
      { label: '⏪ 快照回滚', value: { cmd: 'ops' } },
    ]],
  });
  let sentInThread = replyInThread;
  const sendPromise = replyInThread
    ? sendCardToTarget(client, {
        chatId: notice.chatId || '',
        openId: notice.openId || '',
        replyToMessageId: threadRootId,
        replyInThread: true,
        card,
      }).catch((err) => {
        console.error('[feishu-remote] Post-restart thread reply failed, falling back to chat:', err?.message || err);
        sentInThread = false;
        return sendCardToTarget(client, {
          chatId: notice.chatId || '',
          openId: notice.openId || '',
          card,
        });
      })
    : sendCardToTarget(client, {
        chatId: notice.chatId || '',
        openId: notice.openId || '',
        card,
      });
  void sendPromise
    .then((sentId) => {
      if (sentInThread && threadRootId && sentId) {
        recordCardThread(sentId, {
          sessionKey: notice.sessionKey || makeSessionKey(notice.chatId || '', threadRootId),
          threadRootId,
          chatId: notice.chatId || '',
        });
      }
    })
    .catch((err) => {
      console.error('[feishu-remote] Failed to send post-restart confirmation card:', err?.message || err);
    });
}, 1500);
