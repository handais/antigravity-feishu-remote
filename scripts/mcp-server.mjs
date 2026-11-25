import os from 'node:os';
import path from 'node:path';
import {
  getPluginRoot,
  loadConfig,
  loadState,
  maskSecret,
  stripProcessProxyEnv,
} from './lib/config.mjs';
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

function resolveTarget(args, config) {
  const receiveId =
    args?.receive_id ||
    config.notifications.defaultReceiveId ||
    config.security.allowedOpenIds?.[0] ||
    '';
  const receiveIdType = args?.receive_id_type || config.notifications.defaultReceiveIdType || 'open_id';
  if (!receiveId) {
    throw new Error(
      'No receive_id provided and no defaultReceiveId or bound allowedOpenIds configured yet.',
    );
  }
  return { receiveId, receiveIdType };
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
      description: 'Send a plain text message to the configured Feishu user or chat.',
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
        },
        required: ['text'],
      },
    },
    {
      name: 'feishu_send_card',
      description: 'Send a rich Feishu interactive markdown card to the configured user or chat.',
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
        },
        required: ['title', 'markdown'],
      },
    },
    {
      name: 'feishu_send_file',
      description: 'Upload and send a local image or file to the configured Feishu user or chat.',
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const config = loadConfig();
    stripProcessProxyEnv(config.feishu.proxy);

    if (name === 'feishu_send_message') {
      const { createFeishuClient, sendText } = await loadFeishuApi();
      const client = createFeishuClient(config, { quiet: true });
      const target = resolveTarget(args, config);
      const messageId = await sendText(client, {
        ...target,
        text: String(args.text || ''),
      });
      return toolResult({ ok: true, messageId, ...target });
    }

    if (name === 'feishu_send_card') {
      const { buildCard, createFeishuClient, sanitizeForFeishuMarkdown, sendCard } = await loadFeishuApi();
      const client = createFeishuClient(config, { quiet: true });
      const target = resolveTarget(args, config);
      const template = VALID_CARD_COLORS.has(args.color) ? args.color : 'blue';
      const card = buildCard({
        title: String(args.title || 'Antigravity 通知'),
        template,
        markdown: sanitizeForFeishuMarkdown(String(args.markdown || '')),
      });
      const messageId = await sendCard(client, { ...target, card });
      return toolResult({ ok: true, messageId, ...target });
    }

    if (name === 'feishu_send_file') {
      const { createFeishuClient, sendLocalMedia } = await loadFeishuApi();
      const client = createFeishuClient(config, { quiet: true });
      const target = resolveTarget(args, config);
      const rawPath = String(args.file_path || '').trim();
      if (!rawPath) {
        return toolResult('file_path is required.', true);
      }
      const resolvedPath = rawPath === '~'
        ? os.homedir()
        : rawPath.startsWith('~/')
          ? path.join(os.homedir(), rawPath.slice(2))
          : path.resolve(rawPath);
      const sent = await sendLocalMedia(client, {
        ...target,
        filePath: resolvedPath,
        forceFile: Boolean(args.as_file),
      });
      return toolResult({ ok: true, ...sent, ...target });
    }

    if (name === 'feishu_read_doc') {
      const [{ createFeishuClient }, { readFeishuDoc }] = await Promise.all([
        loadFeishuApi(),
        loadFeishuDocs(),
      ]);
      const client = createFeishuClient(config, { quiet: true });
      const target = String(args.url_or_token || '').trim();
      if (!target) {
        return toolResult('url_or_token is required.', true);
      }
      const maxChars = typeof args.max_chars === 'number' ? args.max_chars : 24000;
      const doc = await readFeishuDoc(client, target, {
        maxChars,
        domain: config.feishu.domain,
      });
      return toolResult({ ok: true, ...doc });
    }

    if (name === 'feishu_write_doc') {
      const [{ createFeishuClient }, { writeFeishuDoc }] = await Promise.all([
        loadFeishuApi(),
        loadFeishuDocs(),
      ]);
      const client = createFeishuClient(config, { quiet: true });
      const markdown = String(args.markdown || '').trim();
      if (!markdown) {
        return toolResult('markdown is required.', true);
      }
      const grantOpenId =
        String(args.grant_open_id || '').trim() ||
        config.notifications.defaultReceiveId ||
        config.security.allowedOpenIds?.[0] ||
        '';
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

main().catch((err) => {
  console.error('[feishu-remote-mcp] Fatal error:', err);
  process.exit(1);
});
