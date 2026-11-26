import crypto from 'node:crypto';
import {
  assertLarkOk,
  buildCard,
  deliverFinalCard,
  patchCard,
  replyCard,
  sanitizeForFeishuMarkdown,
  sendCard,
  splitMarkdownChunks,
  unwrapLarkError,
} from './feishu-api.mjs';

export async function addMessageReaction(client, { messageId, emojiType = 'Typing' }) {
  if (!messageId || !emojiType || !client?.im?.v1?.messageReaction?.create) {
    return '';
  }
  try {
    const res = await client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: {
          emoji_type: emojiType,
        },
      },
    });
    if (res && typeof res.code === 'number' && res.code !== 0) {
      console.error(`[feishu-remote] addMessageReaction(${emojiType}) code=${res.code}: ${res.msg || ''}`);
      return '';
    }
    return res?.data?.reaction_id || '';
  } catch (err) {
    console.error(`[feishu-remote] addMessageReaction(${emojiType}) error:`, err?.message || err);
    return '';
  }
}

export async function removeMessageReaction(client, { messageId, reactionId }) {
  if (!messageId || !reactionId || !client?.im?.v1?.messageReaction?.delete) {
    return;
  }
  try {
    await client.im.v1.messageReaction.delete({
      path: {
        message_id: messageId,
        reaction_id: reactionId,
      },
    });
  } catch {
    // Best-effort cleanup; ignore missing/already-removed reactions
  }
}

export function buildStreamingCardJson({
  title = '⏳ Antigravity 处理中...',
  template = 'blue',
  initialStatus = '',
  initialStream = '_正在等待模型响应..._',
  footer = '',
  stopButton = true,
  statusElementId = 'md_status',
  streamElementId = 'md_stream',
} = {}) {
  const elements = [
    {
      tag: 'markdown',
      element_id: statusElementId,
      content: initialStatus || ' ',
    },
    {
      tag: 'markdown',
      element_id: streamElementId,
      content: initialStream || ' ',
    },
  ];

  if (stopButton) {
    elements.push({
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: 'small',
      columns: [
        {
          tag: 'column',
          width: 'auto',
          elements: [
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: '🛑 立即中止',
              },
              type: 'danger',
              size: 'small',
              behaviors: [
                {
                  type: 'callback',
                  value: { cmd: 'stop' },
                },
              ],
            },
          ],
        },
      ],
    });
  }

  if (footer) {
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>${footer}</font>`,
      text_size: 'notation',
    });
  }

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      streaming_mode: true,
      summary: {
        content: title,
      },
      streaming_config: {
        print_frequency_ms: { default: 50, android: 50, ios: 50, pc: 50 },
        print_step: { default: 2, android: 2, ios: 2, pc: 2 },
        print_strategy: 'fast',
      },
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    body: {
      elements,
    },
  };
}

function clampMarkdownTail(text, maxLen) {
  const clean = sanitizeForFeishuMarkdown(text || '');
  if (!clean) return ' ';
  if (clean.length <= maxLen) return clean;
  return `...${clean.slice(-(maxLen - 3))}`;
}

export async function createStreamingCardSession(
  client,
  {
    messageId = '',
    replyTargetMessageId = '',
    replyInThread = false,
    chatId = '',
    openId = '',
    title = '⏳ Antigravity 正在处理...',
    template = 'blue',
    initialStatus = '',
    initialStream = '_已接收指令，正在启动处理..._',
    footer = '点下方按钮或发送 /stop 可中止',
    stopButton = true,
    minWriteIntervalMs = 350,
  } = {},
) {
  const STATUS_ID = 'md_status';
  const STREAM_ID = 'md_stream';
  let mode = 'patch';
  let cardId = '';
  let replyMessageId = '';
  const effectiveReplyTarget = replyTargetMessageId || messageId;

  const canUseCardKit = Boolean(
    client?.cardkit?.v1?.card?.create &&
    client?.cardkit?.v1?.cardElement?.content &&
    client?.cardkit?.v1?.card?.update &&
    client?.cardkit?.v1?.card?.settings,
  );

  if (canUseCardKit) {
    try {
      const cardJson = buildStreamingCardJson({
        title,
        template,
        initialStatus,
        initialStream,
        footer,
        stopButton,
        statusElementId: STATUS_ID,
        streamElementId: STREAM_ID,
      });
      const createRes = await client.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(cardJson),
        },
      });
      assertLarkOk(createRes, 'cardkit.create');
      const createdCardId = createRes?.data?.card_id || '';
      if (!createdCardId) {
        throw new Error('Feishu cardkit.create returned empty card_id');
      }

      const contentPayload = JSON.stringify({
        type: 'card',
        data: { card_id: createdCardId },
      });
      let sendRes;
      if (effectiveReplyTarget) {
        sendRes = await client.im.v1.message.reply({
          path: { message_id: effectiveReplyTarget },
          data: {
            msg_type: 'interactive',
            content: contentPayload,
            ...(replyInThread ? { reply_in_thread: true } : {}),
          },
        });
      } else if (chatId || openId) {
        sendRes = await client.im.v1.message.create({
          params: { receive_id_type: chatId ? 'chat_id' : 'open_id' },
          data: {
            receive_id: chatId || openId,
            msg_type: 'interactive',
            content: contentPayload,
          },
        });
      } else {
        throw new Error('Missing target for CardKit initial message');
      }
      assertLarkOk(sendRes, 'cardkit.send');
      cardId = createdCardId;
      replyMessageId = sendRes?.data?.message_id || '';
      mode = 'cardkit';
    } catch (err) {
      const unwrapped = unwrapLarkError(err, 'cardkitInit');
      console.error('[feishu-remote] CardKit init failed, falling back to patchCard:', unwrapped.message);
    }
  }

  if (mode !== 'cardkit') {
    const fallbackBody = [initialStatus, initialStream].filter(Boolean).join('\n\n---\n\n') || ' ';
    const initialCard = buildCard({
      title,
      template,
      markdown: fallbackBody,
      footer,
      buttonRows: stopButton ? [[{ label: '🛑 立即中止', type: 'danger', value: { cmd: 'stop' } }]] : [],
    });
    try {
      if (effectiveReplyTarget) {
        replyMessageId = await replyCard(client, {
          messageId: effectiveReplyTarget,
          card: initialCard,
          replyInThread,
        });
      } else if (chatId || openId) {
        replyMessageId = await sendCard(client, {
          receiveId: chatId || openId,
          receiveIdType: chatId ? 'chat_id' : 'open_id',
          card: initialCard,
        });
      }
    } catch (err) {
      console.error('[feishu-remote] Failed to send fallback initial card:', err?.message || err);
    }
  }

  const CARDKIT_STREAM_MAX_MS = 9 * 60 * 1000 + 20 * 1000;
  const MIN_CARDKIT_WRITE_MS = Math.max(0, Number(minWriteIntervalMs ?? 350));
  const streamStartedAt = Date.now();
  let closed = false;
  let streamingActive = true;
  let streamErrorCount = 0;
  let sequence = 0;
  let queue = Promise.resolve();
  let currentStatus = initialStatus || '';
  let currentStream = initialStream || '';
  let statusDirty = false;
  let streamDirty = false;
  let longRunDirty = false;
  let statusTimer = null;
  let streamTimer = null;
  let longRunTimer = null;
  let patchTimer = null;
  let lastCardWriteAt = 0;
  let lastStatusAt = 0;
  let lastStreamAt = 0;
  let lastLongRunUpdateAt = 0;
  let lastPatchAt = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const enqueueOp = (fn) => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };

  const paceCardKitWrite = async () => {
    const waitMs = MIN_CARDKIT_WRITE_MS - (Date.now() - lastCardWriteAt);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastCardWriteAt = Date.now();
  };

  const pushCardKitLongRunUpdate = () => enqueueOp(async () => {
    if (closed || mode !== 'cardkit' || !cardId) return;
    const streamTail = currentStream.trim() ? clampMarkdownTail(currentStream, 2600) : '';
    const combined = [currentStatus, streamTail].filter((s) => s && s.trim()).join('\n\n---\n\n') || ' ';
    try {
      const updRes = await client.cardkit.v1.card.update({
        path: { card_id: cardId },
        data: {
          card: {
            type: 'card_json',
            data: JSON.stringify(
              buildCard({
                title: '⏳ Antigravity 持续执行中...',
                template,
                markdown: combined,
                footer,
                buttonRows: stopButton ? [[{ label: '🛑 立即中止', type: 'danger', value: { cmd: 'stop' } }]] : [],
              }),
            ),
          },
          sequence: ++sequence,
          uuid: crypto.randomUUID(),
        },
      });
      assertLarkOk(updRes, 'cardkit.longRunUpdate');
    } catch (err) {
      console.error(
        '[feishu-remote] cardkit.longRunUpdate error:',
        unwrapLarkError(err, 'cardkit.longRunUpdate').message,
      );
    }
  });

  const flushCardKitLongRun = () => {
    if (closed || mode !== 'cardkit' || !cardId || !longRunDirty) return;
    const elapsed = Date.now() - lastLongRunUpdateAt;
    if (elapsed < 3000) {
      if (!longRunTimer) {
        longRunTimer = setTimeout(() => {
          longRunTimer = null;
          flushCardKitLongRun();
        }, 3000 - elapsed);
      }
      return;
    }
    longRunDirty = false;
    lastLongRunUpdateAt = Date.now();
    void pushCardKitLongRunUpdate();
  };

  const switchToLongRunUpdates = () => {
    if (closed || mode !== 'cardkit' || !streamingActive) return;
    streamingActive = false;
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
    statusDirty = false;
    streamDirty = false;
    longRunDirty = true;
    enqueueOp(async () => {
      if (closed || !cardId) return;
      try {
        await client.cardkit.v1.card.settings({
          path: { card_id: cardId },
          data: {
            settings: JSON.stringify({
              config: {
                wide_screen_mode: true,
                streaming_mode: false,
                update_multi: true,
                summary: { content: '⏳ Antigravity 持续执行中...' },
              },
            }),
            sequence: ++sequence,
            uuid: crypto.randomUUID(),
          },
        });
      } catch {
        // Streaming window may already have closed; card.update handles long-run refresh
      }
    });
    flushCardKitLongRun();
  };

  const pushElementContent = (elementId, content) => enqueueOp(async () => {
    if (closed || mode !== 'cardkit' || !cardId || !streamingActive) return;
    await paceCardKitWrite();
    if (closed || mode !== 'cardkit' || !cardId || !streamingActive) return;
    try {
      const res = await client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: elementId },
        data: {
          content: content || ' ',
          sequence: ++sequence,
          uuid: crypto.randomUUID(),
        },
      });
      assertLarkOk(res, `cardElement.content(${elementId})`);
      streamErrorCount = 0;
    } catch (err) {
      streamErrorCount += 1;
      console.error(`[feishu-remote] cardElement.content(${elementId}) error:`, unwrapLarkError(err, 'cardElement').message);
      if (streamingActive && streamErrorCount >= 2) {
        switchToLongRunUpdates();
      }
    }
  });

  const pushClassicPatch = () => enqueueOp(async () => {
    if (closed || !replyMessageId) return;
    const streamTail = currentStream.trim() ? clampMarkdownTail(currentStream, 2600) : '';
    const combined = [currentStatus, streamTail].filter((s) => s && s.trim()).join('\n\n---\n\n') || ' ';
    try {
      await patchCard(client, {
        messageId: replyMessageId,
        card: buildCard({
          title: '⏳ Antigravity 执行中...',
          template,
          markdown: combined,
          footer,
          buttonRows: stopButton ? [[{ label: '🛑 立即中止', type: 'danger', value: { cmd: 'stop' } }]] : [],
        }),
      });
    } catch (err) {
      console.error('[feishu-remote] patchCard error:', err?.message || err);
    }
  });

  const flushPatchMode = () => {
    if (closed || !replyMessageId || (!statusDirty && !streamDirty)) return;
    const elapsed = Date.now() - lastPatchAt;
    if (elapsed < 1200) {
      if (!patchTimer) {
        patchTimer = setTimeout(() => {
          patchTimer = null;
          flushPatchMode();
        }, 1200 - elapsed);
      }
      return;
    }
    statusDirty = false;
    streamDirty = false;
    lastPatchAt = Date.now();
    void pushClassicPatch();
  };

  const flushStatusCardKit = () => {
    if (closed || !statusDirty) return;
    if (!streamingActive || Date.now() - streamStartedAt >= CARDKIT_STREAM_MAX_MS) {
      switchToLongRunUpdates();
      return;
    }
    const lastAt = Math.max(lastStatusAt, lastCardWriteAt);
    const elapsed = Date.now() - lastAt;
    if (elapsed < MIN_CARDKIT_WRITE_MS) {
      if (!statusTimer) {
        statusTimer = setTimeout(() => {
          statusTimer = null;
          flushStatusCardKit();
        }, MIN_CARDKIT_WRITE_MS - elapsed);
      }
      return;
    }
    statusDirty = false;
    lastStatusAt = Date.now();
    const content = sanitizeForFeishuMarkdown(currentStatus || ' ');
    void pushElementContent(STATUS_ID, content);
  };

  const flushStreamCardKit = () => {
    if (closed || !streamDirty) return;
    if (!streamingActive || Date.now() - streamStartedAt >= CARDKIT_STREAM_MAX_MS) {
      switchToLongRunUpdates();
      return;
    }
    const lastAt = Math.max(lastStreamAt, lastCardWriteAt);
    const elapsed = Date.now() - lastAt;
    if (elapsed < MIN_CARDKIT_WRITE_MS) {
      if (!streamTimer) {
        streamTimer = setTimeout(() => {
          streamTimer = null;
          flushStreamCardKit();
        }, MIN_CARDKIT_WRITE_MS - elapsed);
      }
      return;
    }
    streamDirty = false;
    lastStreamAt = Date.now();
    const content = clampMarkdownTail(currentStream || ' ', 6500);
    void pushElementContent(STREAM_ID, content);
  };

  return {
    get mode() {
      return mode;
    },
    get cardId() {
      return cardId;
    },
    get replyMessageId() {
      return replyMessageId;
    },
    updateStatus(markdown) {
      if (closed) return;
      currentStatus = String(markdown || '');
      if (mode === 'cardkit') {
        if (!streamingActive) {
          longRunDirty = true;
          flushCardKitLongRun();
        } else {
          statusDirty = true;
          flushStatusCardKit();
        }
      } else {
        statusDirty = true;
        flushPatchMode();
      }
    },
    updateStream(markdown) {
      if (closed) return;
      currentStream = String(markdown || '');
      if (mode === 'cardkit') {
        if (!streamingActive) {
          longRunDirty = true;
          flushCardKitLongRun();
        } else {
          streamDirty = true;
          flushStreamCardKit();
        }
      } else {
        streamDirty = true;
        flushPatchMode();
      }
    },
    async finish({
      title: finalTitle,
      template: finalTemplate = 'green',
      markdown,
      footer: finalFooter = '',
      buttonRows = [],
      chatId: targetChatId = chatId,
      openId: targetOpenId = openId,
      replyTargetMessageId: finalReplyTarget = effectiveReplyTarget,
      replyInThread: finalReplyInThread = replyInThread,
    }) {
      closed = true;
      const wasStreamingActive = streamingActive;
      streamingActive = false;
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      if (streamTimer) {
        clearTimeout(streamTimer);
        streamTimer = null;
      }
      if (longRunTimer) {
        clearTimeout(longRunTimer);
        longRunTimer = null;
      }
      if (patchTimer) {
        clearTimeout(patchTimer);
        patchTimer = null;
      }

      await queue;

      const clean = sanitizeForFeishuMarkdown(markdown);
      const chunks = splitMarkdownChunks(clean, 7000, { maxUtf8Bytes: 22_000 });
      const targetId = targetChatId || targetOpenId;
      const targetType = targetChatId ? 'chat_id' : 'open_id';
      const sentMessageIds = [];

      if (mode === 'cardkit' && cardId) {
        const part0Title = chunks.length > 1 ? `${finalTitle} (1/${chunks.length})` : finalTitle;
        const part0Footer = chunks.length === 1 ? finalFooter : '';
        const part0Buttons = chunks.length === 1 ? buttonRows : [];
        const finalCard0 = buildCard({
          title: part0Title,
          template: finalTemplate,
          markdown: chunks[0],
          footer: part0Footer,
          buttonRows: part0Buttons,
        });

        let settingsCalled = false;
        if (wasStreamingActive) {
          try {
            await client.cardkit.v1.card.settings({
              path: { card_id: cardId },
              data: {
                settings: JSON.stringify({
                  config: {
                    wide_screen_mode: true,
                    streaming_mode: false,
                    update_multi: true,
                    summary: { content: part0Title },
                  },
                }),
                sequence: ++sequence,
                uuid: crypto.randomUUID(),
              },
            });
            settingsCalled = true;
          } catch (err) {
            console.error('[feishu-remote] cardkit settings close error:', unwrapLarkError(err, 'cardkit.settings').message);
          }
        }
        if (settingsCalled) {
          await sleep(250);
        }

        let updatedOk = false;
        try {
          const updRes = await client.cardkit.v1.card.update({
            path: { card_id: cardId },
            data: {
              card: {
                type: 'card_json',
                data: JSON.stringify(finalCard0),
              },
              sequence: ++sequence,
              uuid: crypto.randomUUID(),
            },
          });
          assertLarkOk(updRes, 'cardkit.update');
          updatedOk = true;
        } catch (err) {
          console.error(
            '[feishu-remote] cardkit final update failed, falling back to deliverFinalCard:',
            unwrapLarkError(err, 'cardkit.update').message,
          );
          await sleep(350);
        }

        if (updatedOk) {
          if (replyMessageId) {
            sentMessageIds.push(replyMessageId);
          }
          for (let i = 1; i < chunks.length; i += 1) {
            if (!targetId && !(finalReplyInThread && finalReplyTarget)) break;
            const isLast = i === chunks.length - 1;
            const extraCard = buildCard({
              title: `${finalTitle} (${i + 1}/${chunks.length})`,
              template: finalTemplate,
              markdown: chunks[i],
              footer: isLast ? finalFooter : '',
              buttonRows: isLast ? buttonRows : [],
            });
            if (finalReplyInThread && finalReplyTarget) {
              const extraId = await replyCard(client, {
                messageId: finalReplyTarget,
                card: extraCard,
                replyInThread: true,
              });
              if (extraId) sentMessageIds.push(extraId);
            } else {
              const extraId = await sendCard(client, {
                receiveId: targetId,
                receiveIdType: targetType,
                card: extraCard,
              });
              if (extraId) sentMessageIds.push(extraId);
            }
          }
          return sentMessageIds;
        }
      }

      const fallbackIds = await deliverFinalCard(client, {
        replyMessageId,
        replyTargetMessageId: finalReplyTarget,
        replyInThread: finalReplyInThread,
        chatId: targetChatId,
        receiveId: targetOpenId,
        receiveIdType: 'open_id',
        title: finalTitle,
        template: finalTemplate,
        markdown,
        footer: finalFooter,
        buttonRows,
      });
      return Array.isArray(fallbackIds) ? fallbackIds : [];
    },
  };
}
