import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  getPluginRoot,
  loadConfig,
  loadState,
  maskSecret,
  stripProcessProxyEnv,
} from './lib/config.mjs';
import { expandHomePath } from './lib/io-utils.mjs';
import { isSensitiveFilePath } from './lib/security.mjs';
import {
  getDaemonStatus,
  readDaemonLogs,
  restartDaemon,
  startDaemon,
  stopDaemon,
} from './lib/daemon-ctl.mjs';

let feishuApiPromise = null;
let feishuDocsPromise = null;
let feishuTasksPromise = null;
let mobileHandoffPromise = null;
let cachedClientKey = '';
let cachedFeishuClient = null;

function loadFeishuApi() {
  if (!feishuApiPromise) {
    feishuApiPromise = import('./lib/feishu-api.mjs');
  }
  return feishuApiPromise;
}

function loadFeishuDocs() {
  if (!feishuDocsPromise) {
    feishuDocsPromise = import('./lib/feishu-docs.mjs');
  }
  return feishuDocsPromise;
}

function loadFeishuTasks() {
  if (!feishuTasksPromise) {
    feishuTasksPromise = import('./lib/feishu-tasks.mjs');
  }
  return feishuTasksPromise;
}

function loadMobileHandoff() {
  if (!mobileHandoffPromise) {
    mobileHandoffPromise = import('./lib/mobile-handoff.mjs');
  }
  return mobileHandoffPromise;
}

const VALID_CARD_COLORS = new Set([
  'blue',
  'wathet',
  'turquoise',
  'green',
  'yellow',
  'orange',
  'red',
  'carmine',
  'violet',
  'purple',
  'indigo',
  'grey',
]);

function inferReceiveIdType(receiveId, fallback = 'open_id') {
  const id = String(receiveId || '').trim();
  if (id.startsWith('oc_')) return 'chat_id';
  if (id.startsWith('ou_')) return 'open_id';
  if (id.includes('@')) return 'email';
  return fallback || 'open_id';
}

function collectAllowedTargets(config, state, env = process.env) {
  const allowedOpenIds = new Set(
    (Array.isArray(config?.security?.allowedOpenIds) ? config.security.allowedOpenIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const allowedChatIds = new Set();
  const allowedThreadRootIds = new Set();

  const defaultId = String(config?.notifications?.defaultReceiveId || '').trim();
  const defaultType = inferReceiveIdType(
    defaultId,
    config?.notifications?.defaultReceiveIdType || 'open_id',
  );
  if (defaultId) {
    if (defaultType === 'chat_id') allowedChatIds.add(defaultId);
    else if (defaultType === 'open_id') allowedOpenIds.add(defaultId);
  }

  const topicId = String(config?.notifications?.defaultTopicChatId || '').trim();
  if (topicId) allowedChatIds.add(topicId);
  if (state?.lastTopicChatId) allowedChatIds.add(String(state.lastTopicChatId).trim());

  for (const chatId of Object.values(state?.lastP2pChatByOpenId || {})) {
    const clean = String(chatId || '').trim();
    if (clean) allowedChatIds.add(clean);
  }
  for (const key of Object.keys(state?.chats || {})) {
    const [rawBase, rawThread] = String(key || '').split('#');
    const base = String(rawBase || '').trim();
    const threadRoot = String(rawThread || '').trim();
    if (base.startsWith('oc_')) {
      allowedChatIds.add(base);
    } else if (base.startsWith('ou_') && allowedOpenIds.size > 0 && allowedOpenIds.has(base)) {
      allowedOpenIds.add(base);
    }
    if (threadRoot) {
      allowedThreadRootIds.add(threadRoot);
    }
  }
  if (env?.FEISHU_REMOTE_BRIDGE_CHILD === '1') {
    const bridgeChatId = String(env.FEISHU_REMOTE_CHAT_ID || '').trim();
    if (bridgeChatId.startsWith('oc_')) {
      allowedChatIds.add(bridgeChatId);
    }
    const bridgeThreadRootId = String(env.FEISHU_REMOTE_THREAD_ROOT_ID || '').trim();
    if (bridgeThreadRootId) {
      allowedThreadRootIds.add(bridgeThreadRootId);
    }
  }
  return { allowedOpenIds, allowedChatIds, allowedThreadRootIds };
}

function assertTargetAuthorized(receiveId, receiveIdType, config, state, env = process.env) {
  if (config?.security?.allowExternalMcpTargets === true) return;
  const { allowedOpenIds, allowedChatIds } = collectAllowedTargets(config, state, env);
  const cleanId = String(receiveId || '').trim();
  if (receiveIdType === 'open_id' && allowedOpenIds.has(cleanId)) {
    return;
  }
  if (receiveIdType === 'chat_id' && allowedChatIds.has(cleanId)) {
    return;
  }
  const configuredDefault = String(config?.notifications?.defaultReceiveId || '').trim();
  if (configuredDefault && cleanId === configuredDefault && receiveIdType === inferReceiveIdType(configuredDefault, config?.notifications?.defaultReceiveIdType || 'open_id')) {
    return;
  }
  throw new Error(
    `Target ${receiveIdType}:${cleanId} is outside authorized Feishu targets (allowedOpenIds / known chats). Set security.allowExternalMcpTargets=true to override.`,
  );
}

function assertReplyTargetAuthorized(replyToMessageId, config, state, env = process.env) {
  if (config?.security?.allowExternalMcpTargets === true) return;
  const cleanReplyTo = String(replyToMessageId || '').trim();
  if (!cleanReplyTo) return;
  const { allowedThreadRootIds } = collectAllowedTargets(config, state, env);
  if (allowedThreadRootIds.has(cleanReplyTo)) {
    return;
  }
  throw new Error(
    `Reply target message_id:${cleanReplyTo} is outside authorized Feishu topic threads. Set security.allowExternalMcpTargets=true to override.`,
  );
}

async function getReusableClient(config) {
  const { createFeishuClient } = await loadFeishuApi();
  const key = [
    config?.feishu?.appId || '',
    config?.feishu?.appSecret || '',
    config?.feishu?.domain || 'feishu',
    config?.feishu?.proxy || '',
  ].join('|');
  if (!cachedFeishuClient || cachedClientKey !== key) {
    cachedFeishuClient = createFeishuClient(config, { quiet: true });
    cachedClientKey = key;
  }
  return cachedFeishuClient;
}

export function resolveTarget(args, config, state = loadState(), env = process.env) {
  const isBridgeChild = env?.FEISHU_REMOTE_BRIDGE_CHILD === '1';
  const bridgeChatId = isBridgeChild ? String(env?.FEISHU_REMOTE_CHAT_ID || '').trim() : '';
  const bridgeThreadRootId = isBridgeChild ? String(env?.FEISHU_REMOTE_THREAD_ROOT_ID || '').trim() : '';

  const explicitId = String(args?.receive_id || '').trim();
  const explicitReplyTo = String(args?.reply_to_message_id || '').trim();
  const defaultId = String(config?.notifications?.defaultReceiveId || '').trim();
  const fallbackOpenId = String(config?.security?.allowedOpenIds?.[0] || '').trim();

  let receiveId = '';
  let receiveIdType = 'open_id';
  let replyToMessageId = '';
  let replyInThread = false;

  if (explicitId) {
    receiveId = explicitId;
    receiveIdType =
      String(args?.receive_id_type || '').trim() ||
      inferReceiveIdType(explicitId, config?.notifications?.defaultReceiveIdType || 'open_id');
    replyToMessageId = explicitReplyTo;
    replyInThread = Boolean(explicitReplyTo && args?.reply_in_thread !== false);
  } else if (bridgeThreadRootId) {
    receiveId = bridgeChatId || defaultId || fallbackOpenId;
    receiveIdType =
      String(args?.receive_id_type || '').trim() ||
      (bridgeChatId
        ? inferReceiveIdType(bridgeChatId, 'chat_id')
        : config?.notifications?.defaultReceiveIdType || inferReceiveIdType(receiveId, 'open_id'));
    replyToMessageId = explicitReplyTo || bridgeThreadRootId;
    replyInThread = args?.reply_in_thread === false ? false : true;
  } else if (bridgeChatId) {
    receiveId = bridgeChatId;
    receiveIdType = String(args?.receive_id_type || '').trim() || inferReceiveIdType(bridgeChatId, 'chat_id');
    replyToMessageId = explicitReplyTo;
    replyInThread = Boolean(explicitReplyTo && args?.reply_in_thread === true);
  } else if (defaultId) {
    receiveId = defaultId;
    receiveIdType =
      String(args?.receive_id_type || '').trim() ||
      config?.notifications?.defaultReceiveIdType ||
      inferReceiveIdType(defaultId, 'open_id');
    replyToMessageId = explicitReplyTo;
    replyInThread = Boolean(explicitReplyTo && args?.reply_in_thread === true);
  } else if (fallbackOpenId) {
    receiveId = fallbackOpenId;
    receiveIdType = String(args?.receive_id_type || '').trim() || 'open_id';
    replyToMessageId = explicitReplyTo;
    replyInThread = Boolean(explicitReplyTo && args?.reply_in_thread === true);
  }

  if (!receiveId && !replyToMessageId) {
    throw new Error(
      'No receive_id provided and no defaultReceiveId or bound allowedOpenIds configured yet.',
    );
  }
  if (receiveId) {
    assertTargetAuthorized(receiveId, receiveIdType, config, state, env);
  }
  if (replyToMessageId) {
    assertReplyTargetAuthorized(replyToMessageId, config, state, env);
  }
  return { receiveId, receiveIdType, replyToMessageId, replyInThread };
}

function toolResult(data, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function createMcpServer({ Server, CallToolRequestSchema, ListToolsRequestSchema }) {
  const server = new Server(
    {
      name: 'feishu-remote-tools',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'feishu_send_message',
      description: 'Send a plain text message to the configured Feishu user or chat (auto-replies into the active topic thread when invoked inside a Feishu topic session).',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to send.' },
          receive_id: { type: 'string', description: 'Optional target open_id or chat_id.' },
          receive_id_type: {
            type: 'string',
            enum: ['open_id', 'chat_id', 'user_id', 'union_id', 'email'],
            description: 'Optional ID type (defaults to config defaultReceiveIdType).',
          },
          reply_to_message_id: {
            type: 'string',
            description: 'Optional topic root message_id to reply under.',
          },
          reply_in_thread: {
            type: 'boolean',
            description: 'Whether to reply inside the topic thread when reply_to_message_id is active.',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'feishu_send_card',
      description: 'Send a rich Feishu interactive markdown card to the configured user or chat (auto-replies into the active topic thread when invoked inside a Feishu topic session).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Card header title.' },
          markdown: { type: 'string', description: 'Card markdown body.' },
          color: {
            type: 'string',
            description: 'Card header template color (blue, green, orange, red, grey, etc.).',
          },
          receive_id: { type: 'string', description: 'Optional target open_id or chat_id.' },
          receive_id_type: {
            type: 'string',
            enum: ['open_id', 'chat_id', 'user_id', 'union_id', 'email'],
            description: 'Optional ID type (defaults to config defaultReceiveIdType).',
          },
          reply_to_message_id: {
            type: 'string',
            description: 'Optional topic root message_id to reply under.',
          },
          reply_in_thread: {
            type: 'boolean',
            description: 'Whether to reply inside the topic thread when reply_to_message_id is active.',
          },
        },
        required: ['title', 'markdown'],
      },
    },
    {
      name: 'feishu_send_file',
      description: 'Upload and send a local image or file to the configured Feishu user or chat (auto-replies into the active topic thread when invoked inside a Feishu topic session).',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or ~-prefixed path to the local image or file.' },
          as_file: {
            type: 'boolean',
            description: 'When true, always send as a generic file attachment even if the path is an image.',
          },
          receive_id: { type: 'string', description: 'Optional target open_id or chat_id.' },
          receive_id_type: {
            type: 'string',
            enum: ['open_id', 'chat_id', 'user_id', 'union_id', 'email'],
            description: 'Optional ID type (defaults to config defaultReceiveIdType).',
          },
          reply_to_message_id: {
            type: 'string',
            description: 'Optional topic root message_id to reply under.',
          },
          reply_in_thread: {
            type: 'boolean',
            description: 'Whether to reply inside the topic thread when reply_to_message_id is active.',
          },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'feishu_read_doc',
      description: 'Read a Feishu Docx or Wiki page content by URL or document token.',
      inputSchema: {
        type: 'object',
        properties: {
          url_or_token: { type: 'string', description: 'Feishu docx/wiki URL or document token.' },
          max_chars: {
            type: 'number',
            description: 'Maximum characters to return (default 24000).',
          },
          include_comments: {
            type: 'boolean',
            description: 'Whether to include inline and document-level comments/annotations (default true).',
          },
        },
        required: ['url_or_token'],
      },
    },
    {
      name: 'feishu_write_doc',
      description: 'Create a new Feishu Docx document or append Markdown content to an existing document.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title for a newly created Feishu document.' },
          markdown: { type: 'string', description: 'Markdown content to convert and insert into the document.' },
          document_id: {
            type: 'string',
            description: 'Optional existing Feishu docx/wiki URL or token to append content into.',
          },
          grant_open_id: {
            type: 'string',
            description: 'Optional open_id to grant full_access on newly created documents (defaults to bound owner).',
          },
        },
        required: ['markdown'],
      },
    },
    {
      name: 'feishu_list_tasks',
      description: 'List Feishu Task v2 tasks (personal "my_tasks" or a specific tasklist) using authorized user OAuth.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['open', 'done', 'all'],
            description: 'Filter tasks by completion state (default open).',
          },
          tasklist_guid: {
            type: 'string',
            description: 'Optional tasklist GUID to list tasks from a specific shared/group tasklist.',
          },
          include_tasklists: {
            type: 'boolean',
            description: 'Also return the user\'s accessible tasklists.',
          },
          limit: {
            type: 'number',
            description: 'Maximum tasks to return (1-100, default 50).',
          },
        },
      },
    },
    {
      name: 'feishu_create_task',
      description: 'Create a new Feishu Task v2 task using authorized user OAuth.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Task title / summary.' },
          description: { type: 'string', description: 'Optional detailed description.' },
          due: { type: 'string', description: 'Optional due date/time (e.g. "2026-11-26" or "2026-11-26 18:00").' },
          tasklist_guid: { type: 'string', description: 'Optional tasklist GUID to attach the task to.' },
          assign_to_owner: {
            type: 'boolean',
            description: 'Assign to the configured default owner open_id (default true).',
          },
        },
        required: ['summary'],
      },
    },
    {
      name: 'feishu_complete_task',
      description: 'Mark a Feishu Task v2 task as completed (or reopen it).',
      inputSchema: {
        type: 'object',
        properties: {
          task_guid: { type: 'string', description: 'Feishu Task v2 GUID.' },
          completed: {
            type: 'boolean',
            description: 'true to mark complete (default), false to reopen.',
          },
        },
        required: ['task_guid'],
      },
    },
    {
      name: 'feishu_bridge_status',
      description: 'Check masked Feishu configuration, background daemon status, and active chat sessions.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'feishu_manage_bridge',
      description: 'Start, stop, restart, or read recent logs of the Feishu remote bridge daemon.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop', 'restart', 'logs'],
            description: 'Action to run against the bridge daemon.',
          },
          lines: {
            type: 'number',
            description: 'Number of log lines to return when action=logs (default 50).',
          },
        },
        required: ['action'],
      },
    },
    {
      name: 'feishu_list_mobile_sessions',
      description: 'List recent mobile Feishu remote CLI sessions (strictly read-only), ranked by origin_desktop_id and workspace cwd.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: {
            type: 'string',
            description: 'Optional workspace directory path to prioritize matching mobile sessions.',
          },
          origin_desktop_id: {
            type: 'string',
            description: 'Optional original Desktop App conversation ID to match sessions handed off from desktop.',
          },
          limit: {
            type: 'number',
            description: 'Maximum sessions to return (1-30, default 10).',
          },
        },
      },
    },
    {
      name: 'feishu_read_mobile_session',
      description: 'Read turns, latest assistant reply, modified local files, and desktop return prompt from a mobile Feishu remote session.',
      inputSchema: {
        type: 'object',
        properties: {
          conversation_id: {
            type: 'string',
            description: 'Optional mobile CLI conversation ID (full or prefix). If omitted, auto-picks the best match for cwd / origin_desktop_id.',
          },
          cwd: {
            type: 'string',
            description: 'Optional workspace directory path used to locate the latest mobile session.',
          },
          origin_desktop_id: {
            type: 'string',
            description: 'Optional original Desktop App conversation ID to match the mobile session.',
          },
          max_turns: {
            type: 'number',
            description: 'Maximum recent user/assistant turns to include (default 12).',
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const config = loadConfig();
    stripProcessProxyEnv(config.feishu.proxy);

    if (name === 'feishu_send_message') {
      const { replyText, sendText } = await loadFeishuApi();
      const client = await getReusableClient(config);
      const target = resolveTarget(args, config);
      const text = String(args.text || '');
      const messageId = target.replyToMessageId
        ? await replyText(client, {
            messageId: target.replyToMessageId,
            text,
            replyInThread: target.replyInThread,
          })
        : await sendText(client, {
            receiveId: target.receiveId,
            receiveIdType: target.receiveIdType,
            text,
          });
      return toolResult({ ok: true, messageId, ...target });
    }

    if (name === 'feishu_send_card') {
      const { buildCard, replyCard, sanitizeForFeishuMarkdown, sendCard } = await loadFeishuApi();
      const client = await getReusableClient(config);
      const target = resolveTarget(args, config);
      const template = VALID_CARD_COLORS.has(args.color) ? args.color : 'blue';
      const card = buildCard({
        title: String(args.title || 'Antigravity 通知'),
        template,
        markdown: sanitizeForFeishuMarkdown(String(args.markdown || '')),
      });
      const messageId = target.replyToMessageId
        ? await replyCard(client, {
            messageId: target.replyToMessageId,
            card,
            replyInThread: target.replyInThread,
          })
        : await sendCard(client, {
            receiveId: target.receiveId,
            receiveIdType: target.receiveIdType,
            card,
          });
      return toolResult({ ok: true, messageId, ...target });
    }

    if (name === 'feishu_send_file') {
      const { sendLocalMedia } = await loadFeishuApi();
      const rawPath = String(args.file_path || '').trim();
      if (!rawPath) {
        return toolResult('file_path is required.', true);
      }
      const resolvedPath = expandHomePath(rawPath);
      if (isSensitiveFilePath(resolvedPath)) {
        return toolResult(`Refused to send sensitive file for security protection: ${resolvedPath}`, true);
      }
      const client = await getReusableClient(config);
      const target = resolveTarget(args, config);
      const sent = await sendLocalMedia(client, {
        receiveId: target.receiveId,
        receiveIdType: target.receiveIdType,
        replyToMessageId: target.replyToMessageId,
        replyInThread: target.replyInThread,
        filePath: resolvedPath,
        forceFile: Boolean(args.as_file),
      });
      return toolResult({ ok: true, ...sent, ...target });
    }

    if (name === 'feishu_read_doc') {
      const { readFeishuDoc } = await loadFeishuDocs();
      const client = await getReusableClient(config);
      const target = String(args.url_or_token || '').trim();
      if (!target) {
        return toolResult('url_or_token is required.', true);
      }
      const maxChars = typeof args.max_chars === 'number' ? args.max_chars : 24000;
      const includeComments = args.include_comments !== false;
      const doc = await readFeishuDoc(client, target, {
        maxChars,
        domain: config.feishu.domain,
        includeComments,
      });
      return toolResult({ ok: true, ...doc });
    }

    if (name === 'feishu_write_doc') {
      const { writeFeishuDoc } = await loadFeishuDocs();
      const client = await getReusableClient(config);
      const markdown = String(args.markdown || '').trim();
      if (!markdown) {
        return toolResult('markdown is required.', true);
      }
      const grantOpenId =
        String(args.grant_open_id || '').trim() ||
        config.notifications.defaultReceiveId ||
        config.security.allowedOpenIds?.[0] ||
        '';
      if (grantOpenId) {
        assertTargetAuthorized(grantOpenId, 'open_id', config, loadState());
      }
      const doc = await writeFeishuDoc(client, {
        title: String(args.title || '').trim(),
        markdown,
        documentId: String(args.document_id || '').trim(),
        grantOpenId,
        domain: config.feishu.domain,
      });
      return toolResult({ ok: true, ...doc });
    }

    if (name === 'feishu_list_tasks') {
      const { listFeishuTasklistTasks, listFeishuTasklists, listFeishuTasks } = await loadFeishuTasks();
      const filter = ['open', 'done', 'all'].includes(args.filter) ? args.filter : 'open';
      const limit = typeof args.limit === 'number' ? args.limit : 50;
      const tasklistGuid = String(args.tasklist_guid || '').trim();
      const tasksRes = tasklistGuid
        ? await listFeishuTasklistTasks(config, tasklistGuid, { filter, pageSize: limit })
        : await listFeishuTasks(config, { filter, pageSize: limit });
      let tasklists;
      if (args.include_tasklists) {
        tasklists = (await listFeishuTasklists(config, { pageSize: 50 })).items;
      }
      return toolResult({
        ok: true,
        ...tasksRes,
        ...(tasklists ? { tasklists } : {}),
      });
    }

    if (name === 'feishu_create_task') {
      const { createFeishuTask } = await loadFeishuTasks();
      const assignToOwner = args.assign_to_owner !== false;
      const assigneeOpenId = assignToOwner
        ? (config.notifications.defaultReceiveId || config.security.allowedOpenIds?.[0] || '')
        : '';
      const task = await createFeishuTask(config, {
        summary: String(args.summary || ''),
        description: String(args.description || ''),
        due: String(args.due || ''),
        tasklistGuid: String(args.tasklist_guid || ''),
        assigneeOpenId,
      });
      return toolResult({ ok: true, task });
    }

    if (name === 'feishu_complete_task') {
      const { setFeishuTaskCompleted } = await loadFeishuTasks();
      const completed = args.completed !== false;
      const task = await setFeishuTaskCompleted(config, String(args.task_guid || ''), completed);
      return toolResult({ ok: true, task });
    }

    if (name === 'feishu_bridge_status') {
      const daemon = getDaemonStatus();
      const state = loadState();
      const { getUserAuthStatus } = await loadFeishuTasks();
      const chats = Object.entries(state.chats || {}).map(([chatId, info]) => ({
        chatId,
        cwd: info.cwd,
        mode: info.mode,
        fullExpiresAt: info.fullExpiresAt || 0,
        model: info.model || 'default',
        effort: info.effort || 'default',
        conversationId: info.conversationId || '',
        recentCount: Array.isArray(info.recentConversations) ? info.recentConversations.length : 0,
      }));
      return toolResult({
        configured: Boolean(config.feishu.appId && config.feishu.appSecret),
        feishu: {
          appId: config.feishu.appId || '',
          appSecret: maskSecret(config.feishu.appSecret),
          domain: config.feishu.domain,
          proxy: config.feishu.proxy || '',
        },
        userAuth: getUserAuthStatus(),
        security: config.security,
        agy: config.agy,
        notifications: config.notifications,
        daemon,
        chats,
      });
    }

    if (name === 'feishu_manage_bridge') {
      const action = args.action;
      if (process.env.FEISHU_REMOTE_BRIDGE_CHILD === '1' && (action === 'stop' || action === 'restart')) {
        return toolResult(
          'Refused to stop/restart the Feishu bridge daemon from inside a bridge-spawned child session (doing so would terminate your own parent process). Ask the user to send `/reload` in Feishu instead.',
          true,
        );
      }
      if (action === 'start') {
        return toolResult({ ok: true, result: startDaemon(), status: getDaemonStatus() });
      }
      if (action === 'stop') {
        return toolResult({ ok: true, result: stopDaemon(), status: getDaemonStatus() });
      }
      if (action === 'restart') {
        return toolResult({ ok: true, result: restartDaemon(), status: getDaemonStatus() });
      }
      if (action === 'logs') {
        const lines = typeof args.lines === 'number' ? args.lines : 50;
        return toolResult({ ok: true, ...readDaemonLogs(lines) });
      }
      return toolResult(`Unsupported action: ${action}`, true);
    }

    if (name === 'feishu_list_mobile_sessions') {
      const { listMobileSessions } = await loadMobileHandoff();
      const sessions = listMobileSessions({
        cwd: typeof args.cwd === 'string' ? args.cwd : '',
        originDesktopId: typeof args.origin_desktop_id === 'string' ? args.origin_desktop_id : '',
        limit: typeof args.limit === 'number' ? args.limit : 10,
      });
      return toolResult({ ok: true, count: sessions.length, sessions });
    }

    if (name === 'feishu_read_mobile_session') {
      const { readMobileSession } = await loadMobileHandoff();
      const detail = readMobileSession({
        conversationId: typeof args.conversation_id === 'string' ? args.conversation_id : '',
        cwd: typeof args.cwd === 'string' ? args.cwd : '',
        originDesktopId: typeof args.origin_desktop_id === 'string' ? args.origin_desktop_id : '',
        maxTurns: typeof args.max_turns === 'number' ? args.max_turns : 12,
      });
      return toolResult({ ok: Boolean(detail.found), ...detail }, !detail.found);
    }

    return toolResult(`Unknown tool: ${name}`, true);
  } catch (err) {
    return toolResult(`Error: ${err.message || err}`, true);
  }
  });

  return server;
}

async function main() {
  let Server;
  let StdioServerTransport;
  let CallToolRequestSchema;
  let ListToolsRequestSchema;
  try {
    ({ Server } = await import('@modelcontextprotocol/sdk/server/index.js'));
    ({ StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js'));
    ({ CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js'));
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
      console.error(`[feishu-remote-mcp] Dependencies not installed. Run: cd "${getPluginRoot()}" && npm install --omit=dev`);
      process.exit(1);
    }
    throw err;
  }

  const server = createMcpServer({ Server, CallToolRequestSchema, ListToolsRequestSchema });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isMain = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href,
);

if (isMain) {
  main().catch((err) => {
    console.error('[feishu-remote-mcp] Fatal error:', err);
    process.exit(1);
  });
}
