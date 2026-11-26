import fs from 'node:fs';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import {
  buildCard,
  sanitizeForFeishuMarkdown,
  splitMarkdownChunks,
} from './feishu-cards.mjs';
import { isImageFilePath, resolveFeishuFileType } from './media.mjs';

export * from './feishu-cards.mjs';

export function createStderrLogger(prefix = 'lark') {
  return {
    error: (...args) => console.error(`[${prefix}:error]`, ...args),
    warn: (...args) => console.error(`[${prefix}:warn]`, ...args),
    info: (...args) => console.error(`[${prefix}:info]`, ...args),
    debug: () => {},
    trace: () => {},
  };
}

export function resolveLarkDomain(domainStr) {
  return String(domainStr || '').toLowerCase() === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

export function createFeishuClient(config, { quiet = true } = {}) {
  const appId = config?.feishu?.appId?.trim();
  const appSecret = config?.feishu?.appSecret?.trim();
  if (!appId || !appSecret) {
    throw new Error('Feishu appId and appSecret are required.');
  }
  return new Lark.Client({
    appId,
    appSecret,
    domain: resolveLarkDomain(config?.feishu?.domain),
    disableTokenCache: false,
    logger: createStderrLogger('lark-api'),
    loggerLevel: quiet ? Lark.LoggerLevel.warn : Lark.LoggerLevel.info,
  });
}

export function assertLarkOk(res, action) {
  if (res && typeof res.code === 'number' && res.code !== 0) {
    throw new Error(`Feishu ${action} failed (code=${res.code}): ${res.msg || 'unknown error'}`);
  }
}

export async function sendCard(client, { receiveId, receiveIdType = 'open_id', card }) {
  const res = await client.im.v1.message.create({
    data: {
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
    params: {
      receive_id_type: receiveIdType,
    },
  });
  assertLarkOk(res, 'sendCard');
  return res?.data?.message_id || '';
}

export async function sendText(client, { receiveId, receiveIdType = 'open_id', text }) {
  const res = await client.im.v1.message.create({
    data: {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text: String(text || '') }),
    },
    params: {
      receive_id_type: receiveIdType,
    },
  });
  assertLarkOk(res, 'sendText');
  return res?.data?.message_id || '';
}

export async function replyCard(client, { messageId, card, replyInThread = false }) {
  const res = await client.im.v1.message.reply({
    data: {
      msg_type: 'interactive',
      content: JSON.stringify(card),
      ...(replyInThread ? { reply_in_thread: true } : {}),
    },
    path: {
      message_id: messageId,
    },
  });
  assertLarkOk(res, 'replyCard');
  return res?.data?.message_id || '';
}

export async function patchCard(client, { messageId, card }) {
  const payload = {
    data: {
      content: JSON.stringify(card),
    },
    path: {
      message_id: messageId,
    },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await client.im.v1.message.patch(payload);
      if (res && Number(res.code) === 230020 && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        continue;
      }
      assertLarkOk(res, 'patchCard');
      return;
    } catch (err) {
      const code = Number(err?.response?.data?.code ?? err?.code);
      if (code === 230020 && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        continue;
      }
      throw err;
    }
  }
}

export async function deliverFinalCard(
  client,
  {
    replyMessageId = '',
    replyTargetMessageId = '',
    replyInThread = false,
    chatId = '',
    receiveId = '',
    receiveIdType = 'chat_id',
    title,
    template,
    markdown,
    footer = '',
    buttonRows = [],
  },
) {
  const clean = sanitizeForFeishuMarkdown(markdown);
  const chunks = splitMarkdownChunks(clean, 7000, { maxUtf8Bytes: 22_000 });
  const targetId = chatId || receiveId;
  const targetType = chatId ? 'chat_id' : receiveIdType;

  const sentMessageIds = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const isLast = i === chunks.length - 1;
    const partTitle = chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title;
    const partFooter = isLast ? footer : '';
    const partButtons = isLast ? buttonRows : [];
    const card = buildCard({
      title: partTitle,
      template,
      markdown: chunks[i],
      footer: partFooter,
      buttonRows: partButtons,
    });

    if (i === 0 && replyMessageId) {
      try {
        await patchCard(client, { messageId: replyMessageId, card });
        sentMessageIds.push(replyMessageId);
        continue;
      } catch {
        // Fallback to sending a new card if patching fails (e.g., expired or deleted)
      }
    }
    if (replyInThread && replyTargetMessageId) {
      const msgId = await replyCard(client, { messageId: replyTargetMessageId, card, replyInThread: true });
      if (msgId) sentMessageIds.push(msgId);
    } else if (targetId) {
      const msgId = await sendCard(client, { receiveId: targetId, receiveIdType: targetType, card });
      if (msgId) sentMessageIds.push(msgId);
    }
  }
  return sentMessageIds;
}

export function unwrapLarkError(err, action) {
  const apiMsg = err?.response?.data?.msg || err?.response?.data?.error?.message || '';
  const apiCode = err?.response?.data?.code;
  if (apiMsg) {
    return new Error(`Feishu ${action} failed (code=${apiCode ?? '?'}): ${apiMsg}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function assertLocalFile(filePath, maxBytes, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在：${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`目标路径不是普通文件：${filePath}`);
  }
  if (stat.size === 0) {
    throw new Error(`文件为空（0 字节），飞书不支持上传空文件：${path.basename(filePath)}`);
  }
  if (stat.size > maxBytes) {
    const mb = (maxBytes / (1024 * 1024)).toFixed(0);
    throw new Error(`${label}大小超出飞书限制（最大 ${mb} MB）：${path.basename(filePath)}`);
  }
  return stat;
}

export async function uploadAndSendImage(
  client,
  { receiveId, receiveIdType = 'open_id', filePath, replyToMessageId = '', replyInThread = false },
) {
  const stat = assertLocalFile(filePath, 10 * 1024 * 1024, '图片');
  let uploadRes;
  try {
    uploadRes = await client.im.v1.image.create({
      data: {
        image_type: 'message',
        image: fs.createReadStream(filePath),
      },
    });
  } catch (err) {
    throw unwrapLarkError(err, 'uploadImage');
  }
  assertLarkOk(uploadRes, 'uploadImage');
  const imageKey = uploadRes?.data?.image_key || uploadRes?.image_key || '';
  if (!imageKey) {
    throw new Error('Feishu uploadImage returned empty image_key');
  }

  let sendRes;
  try {
    if (replyInThread && replyToMessageId) {
      sendRes = await client.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
          reply_in_thread: true,
        },
      });
    } else {
      sendRes = await client.im.v1.message.create({
        data: {
          receive_id: receiveId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
        params: {
          receive_id_type: receiveIdType,
        },
      });
    }
  } catch (err) {
    throw unwrapLarkError(err, 'sendImage');
  }
  assertLarkOk(sendRes, 'sendImage');
  return {
    messageId: sendRes?.data?.message_id || '',
    imageKey,
    kind: 'image',
    fileName: path.basename(filePath),
    sizeBytes: stat.size,
  };
}

export async function uploadAndSendFile(
  client,
  { receiveId, receiveIdType = 'open_id', filePath, replyToMessageId = '', replyInThread = false },
) {
  const stat = assertLocalFile(filePath, 30 * 1024 * 1024, '文件');
  const fileType = resolveFeishuFileType(filePath);
  const fileName = path.basename(filePath);
  let uploadRes;
  try {
    uploadRes = await client.im.v1.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        file: fs.createReadStream(filePath),
      },
    });
  } catch (err) {
    throw unwrapLarkError(err, 'uploadFile');
  }
  assertLarkOk(uploadRes, 'uploadFile');
  const fileKey = uploadRes?.data?.file_key || uploadRes?.file_key || '';
  if (!fileKey) {
    throw new Error('Feishu uploadFile returned empty file_key');
  }

  let sendRes;
  try {
    if (replyInThread && replyToMessageId) {
      sendRes = await client.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
          reply_in_thread: true,
        },
      });
    } else {
      sendRes = await client.im.v1.message.create({
        data: {
          receive_id: receiveId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
        params: {
          receive_id_type: receiveIdType,
        },
      });
    }
  } catch (err) {
    throw unwrapLarkError(err, 'sendFile');
  }
  assertLarkOk(sendRes, 'sendFile');
  return {
    messageId: sendRes?.data?.message_id || '',
    fileKey,
    fileType,
    kind: 'file',
    fileName,
    sizeBytes: stat.size,
  };
}

export async function sendLocalMedia(
  client,
  { receiveId, receiveIdType = 'open_id', filePath, forceFile = false, replyToMessageId = '', replyInThread = false },
) {
  if (!forceFile && isImageFilePath(filePath)) {
    return uploadAndSendImage(client, { receiveId, receiveIdType, filePath, replyToMessageId, replyInThread });
  }
  return uploadAndSendFile(client, { receiveId, receiveIdType, filePath, replyToMessageId, replyInThread });
}
