import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import readline from 'node:readline';

const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-remote-test-'));
process.env.FEISHU_REMOTE_CONFIG_DIR = tempConfigDir;

const {
  DEFAULT_CONFIG,
  getConfigPath,
  getPluginRoot,
  loadConfig,
  loadState,
  maskSecret,
  resolveStopNotifyMode,
  saveConfig,
  saveState,
  stripProcessProxyEnv,
} = await import('./lib/config.mjs');
const {
  buildCard,
  buildControlPanelCard,
  buildDesktopSessionPreviewCard,
  buildDesktopSessionsCard,
  buildDirsCard,
  buildEffortCard,
  buildGitStatusCard,
  buildNotifyCard,
  buildQueuedCard,
  buildScopesCard,
  sanitizeForFeishuMarkdown,
  searchDirsFuzzy,
  splitMarkdownChunks,
} = await import('./lib/feishu-api.mjs');
const {
  buildDesktopHandoffContext,
  extractTranscriptTurns,
  getDesktopSessionDetail,
  isSubagentConversation,
  listDesktopSessions,
} = await import('./lib/desktop-sessions.mjs');
const {
  buildAgyArgs,
  parseAgyStreamLine,
} = await import('./lib/agy-runner.mjs');
const {
  buildStreamingCardJson,
} = await import('./lib/cardkit-stream.mjs');
const {
  chunkDescendantBatches,
  extractFeishuDocLinks,
  sanitizeConvertedBlocks,
} = await import('./lib/feishu-docs.mjs');
const {
  buildMultimodalPrompt,
  cleanupOldInboxFiles,
  extractInboundMessage,
  extractInteractiveCardText,
  pruneLogFileIfOversized,
  pruneStaleThreadStates,
} = await import('./lib/media.mjs');
const {
  createBackupSnapshot,
  listBackupSnapshots,
  runPreflightCheck,
} = await import('./lib/self-ops.mjs');
const {
  getOrCreateChatState,
  makeSessionKey,
  parseSessionKey,
  parseTimeoutArg,
} = await import('./lib/bridge-helpers.mjs');
const {
  formatToolStatusMarkdown,
  formatUsageSummary,
  isTransientStartupRace,
} = await import('./lib/task-runner.mjs');

const pluginRoot = getPluginRoot();

function runSubprocess(scriptRel, { env = {}, stdinData = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(pluginRoot, scriptRel)], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdinData) child.stdin.write(stdinData);
    child.stdin.end();
  });
}

async function testMcpStdio() {
  const child = spawn(process.execPath, [path.join(pluginRoot, 'scripts', 'mcp-server.mjs')], {
    env: { ...process.env, FEISHU_REMOTE_CONFIG_DIR: tempConfigDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed); // Fails test immediately if stdout contains non-JSON
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg);
      pending.delete(msg.id);
    }
  });

  const rpc = (id, method, params = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP timeout waiting for ${method}`)), 5000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  try {
    const initRes = await rpc(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    });
    assert.equal(initRes.result.serverInfo.name, 'feishu-remote-tools');

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const listRes = await rpc(2, 'tools/list');
    const toolNames = listRes.result.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      'feishu_bridge_status',
      'feishu_manage_bridge',
      'feishu_read_doc',
      'feishu_send_card',
      'feishu_send_file',
      'feishu_send_message',
      'feishu_write_doc',
    ]);

    const statusRes = await rpc(3, 'tools/call', {
      name: 'feishu_bridge_status',
      arguments: {},
    });
    const text = statusRes.result.content[0].text;
    const parsed = JSON.parse(text);
    assert.equal(parsed.configured, true);
    assert.ok(!text.includes('super_secret_token_987654'), 'Secret must never appear raw in MCP status');
    assert.equal(parsed.feishu.appSecret, 'sup***654');
  } finally {
    rl.close();
    child.kill('SIGTERM');
    await new Promise((r) => child.once('close', r));
  }
  assert.equal(stderr.includes('Fatal error'), false);
}

try {
  // 1. Config save/load, 0600 permissions, secret masking, proxy stripping
  saveConfig({
    feishu: { appId: 'cli_test_123', appSecret: 'super_secret_token_987654', domain: 'feishu', proxy: '' },
    security: { allowedOpenIds: ['ou_test_owner'], autoBindFirstUser: false, groupPolicy: 'mention' },
    agy: { defaultCwd: pluginRoot, defaultMode: 'accept-edits', defaultModel: '', proxy: 'http://127.0.0.1:7897', timeoutSeconds: 300 },
    notifications: { defaultReceiveId: '', defaultReceiveIdType: 'open_id', stopHookEnabled: true },
  });
  const loaded = loadConfig();
  assert.equal(loaded.feishu.appId, 'cli_test_123');
  assert.equal(loaded.feishu.appSecret, 'super_secret_token_987654');
  assert.equal(fs.statSync(getConfigPath()).mode & 0o777, 0o600);
  assert.equal(maskSecret('super_secret_token_987654'), 'sup***654');
  assert.equal(maskSecret(''), '');

  process.env.all_proxy = 'socks5://127.0.0.1:7897';
  stripProcessProxyEnv('');
  assert.equal(process.env.all_proxy, undefined);

  // 2. parseAgyStreamLine
  assert.equal(parseAgyStreamLine('warning: something')?.kind, 'non_json');
  assert.deepEqual(parseAgyStreamLine('{"event":"init","conversation_id":"conv-1","init":{"cwd":"/tmp","permission_mode":"auto"}}'), {
    kind: 'init',
    conversationId: 'conv-1',
    cwd: '/tmp',
    permissionMode: 'auto',
  });
  assert.equal(
    parseAgyStreamLine('{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"ls -la"}}}}')?.kind,
    'tool_start',
  );
  assert.equal(
    parseAgyStreamLine('{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.5}}')?.kind,
    'tool_done',
  );
  assert.equal(
    parseAgyStreamLine('{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"hello"}}')?.textDelta,
    'hello',
  );
  assert.equal(
    parseAgyStreamLine('{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","response":"done","duration_seconds":1.2}}')?.status,
    'SUCCESS',
  );

  // 3. buildAgyArgs across all 5 modes
  assert.deepEqual(
    buildAgyArgs({ prompt: 'hi', conversationId: 'c1', mode: 'accept-edits', model: 'm1', timeoutSeconds: 120 }),
    ['-p', 'hi', '--output-format', 'stream-json', '--conversation', 'c1', '--mode', 'accept-edits', '--model', 'm1', '--print-timeout', '120s'],
  );
  assert.ok(buildAgyArgs({ prompt: 'hi', mode: 'plan' }).includes('--mode'));
  assert.ok(buildAgyArgs({ prompt: 'hi', mode: 'auto' }).includes('auto'));
  assert.ok(buildAgyArgs({ prompt: 'hi', mode: 'full' }).includes('--dangerously-skip-permissions'));
  assert.ok(!buildAgyArgs({ prompt: 'hi', mode: 'default' }).includes('--mode'));
  assert.equal(DEFAULT_CONFIG.agy.timeoutSeconds, 3600);
  assert.ok(!buildAgyArgs({ prompt: 'hi', timeoutSeconds: 0 }).includes('--print-timeout'));

  // 4. Feishu formatting, splitting, and cards
  assert.equal(
    sanitizeForFeishuMarkdown('Check [README.md](file:///Users/test/README.md) and [docs](https://example.com)'),
    'Check `README.md` and [docs](https://example.com)',
  );
  const longCode = ['```js', ...Array.from({ length: 120 }, (_, i) => `const x${i} = ${i};`), '```'].join('\n');
  const chunks = splitMarkdownChunks(longCode, 600);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.ok(c.length <= 600);
    const fenceCount = (c.match(/```/g) || []).length;
    assert.equal(fenceCount % 2, 0, `Unbalanced code fence in chunk:\n${c}`);
  }
  const card = buildCard({
    title: 'T',
    template: 'green',
    markdown: 'M',
    footer: 'F',
    buttonRows: [[{ label: 'B1', type: 'primary', value: { cmd: 'panel', inplace: true } }]],
  });
  assert.equal(card.schema, '2.0');
  assert.equal(card.header.template, 'green');
  assert.equal(card.body.elements.length, 3);
  assert.equal(card.body.elements[1].tag, 'column_set');
  assert.equal(card.body.elements[1].columns[0].elements[0].tag, 'button');
  assert.equal(card.body.elements[1].columns[0].elements[0].behaviors[0].type, 'callback');
  assert.equal(card.body.elements[2].text_size, 'notation');

  const panelCard = buildControlPanelCard({
    chatState: {
      cwd: pluginRoot,
      mode: 'full',
      fullExpiresAt: Date.now() + 20 * 60_000,
      fullRevertMode: 'accept-edits',
      model: '',
      conversationId: 'conv-12345678',
    },
    config: loadConfig(),
    isRunning: true,
    uptimeText: '0h 1m 0s',
    queueLength: 2,
  });
  assert.equal(panelCard.schema, '2.0');
  assert.ok(panelCard.body.elements.some((el) => el.tag === 'column_set'));
  assert.ok(JSON.stringify(panelCard).includes('临时全权'));
  assert.ok(JSON.stringify(panelCard).includes('队列(2)'));

  const queuedCard = buildQueuedCard({ position: 2, queueId: 'q-1', promptPreview: 'run tests', runningPreview: 'build' });
  assert.equal(queuedCard.schema, '2.0');
  assert.ok(JSON.stringify(queuedCard).includes('queue_promote'));

  const scopesCard = buildScopesCard({
    scopes: [
      { scopeName: 'im:resource', scopeType: 'tenant', grantStatus: 1 },
      { scopeName: 'docx:document:write_only', scopeType: 'tenant', grantStatus: 0 },
    ],
    granted: [{ scopeName: 'im:resource', scopeType: 'tenant', grantStatus: 1 }],
    pending: [{ scopeName: 'docx:document:write_only', scopeType: 'tenant', grantStatus: 0 }],
  });
  assert.equal(scopesCard.header.template, 'orange');
  assert.ok(JSON.stringify(scopesCard).includes('scopes_apply'));

  const gitCard = buildGitStatusCard({
    cwd: pluginRoot,
    gitInfo: { isRepo: true, branch: 'main...origin/main', statusLines: [' M scripts/cli.mjs'], commits: ['abc1234 test'], error: '' },
  });
  assert.equal(gitCard.schema, '2.0');
  assert.ok(JSON.stringify(gitCard).includes('main...origin/main'));

  assert.ok(searchDirsFuzzy('scripts', { config: loaded, currentCwd: pluginRoot }).length >= 1);

  // 4b. CardKit streaming JSON structure
  const streamCard = buildStreamingCardJson({ title: 'Stream', initialStatus: 'step 1', initialStream: 'hi' });
  assert.equal(streamCard.schema, '2.0');
  assert.equal(streamCard.config.streaming_mode, true);
  assert.equal(streamCard.config.update_multi, true);
  assert.equal(streamCard.body.elements[0].element_id, 'md_status');
  assert.equal(streamCard.body.elements[1].element_id, 'md_stream');

  // 4c. Feishu Docx / Wiki link parsing, block sanitization, and batching
  const links = extractFeishuDocLinks(
    '看这两个：https://acme.feishu.cn/docx/Dox123_ab?from=share#h1 以及 [Wiki](https://acme.feishu.cn/wiki/Wiki789) 和重复 https://acme.feishu.cn/docx/Dox123_ab。',
  );
  assert.equal(links.length, 2);
  assert.deepEqual(links.map((l) => `${l.kind}:${l.token}`), ['docx:Dox123_ab', 'wiki:Wiki789']);

  const sanitizedBlocks = sanitizeConvertedBlocks([
    {
      block_id: 'tbl1',
      block_type: 31,
      parent_id: '',
      children: ['cell1'],
      table: {
        cells: ['cell1'],
        merge_info: [{ row_span: 1 }],
        property: { column_size: 1, row_size: 1, merge_info: [{ row_span: 1 }] },
      },
    },
    { block_id: 'cell1', block_type: 32, parent_id: '', children: ['txt1'], table_cell: {} },
    { block_id: 'txt1', block_type: 2, parent_id: '', text: { elements: [] } },
  ]);
  assert.equal('parent_id' in sanitizedBlocks[0], false);
  assert.equal('merge_info' in sanitizedBlocks[0].table, false);
  assert.equal('merge_info' in sanitizedBlocks[0].table.property, false);
  const descendantBatches = chunkDescendantBatches(['tbl1'], sanitizedBlocks, 2);
  assert.equal(descendantBatches.length, 1);
  assert.deepEqual(descendantBatches[0].children_id, ['tbl1']);
  assert.equal(descendantBatches[0].descendants.length, 3);

  // 4d. Inbound message / quoted interactive card / multimodal prompt
  assert.equal(extractInboundMessage({ message_type: 'text', content: '{"text":"hello"}' }).text, 'hello');
  const postParsed = extractInboundMessage({
    message_type: 'post',
    content: JSON.stringify({ zh_cn: { title: '日报', content: [[{ tag: 'text', text: '内容' }], [{ tag: 'img', image_key: 'img_1' }]] } }),
  });
  assert.equal(postParsed.text, '日报\n内容');
  assert.equal(postParsed.attachments.length, 1);
  const cardText = extractInteractiveCardText({
    title: '旧卡片',
    elements: [[{ tag: 'text', text: '第一行' }], [{ tag: 'a', text: '链接', href: 'https://feishu.cn/docx/abc' }]],
  });
  assert.ok(cardText.includes('旧卡片') && cardText.includes('第一行') && cardText.includes('https://feishu.cn/docx/abc'));
  const mmPrompt = buildMultimodalPrompt({
    text: '补充说明',
    quoted: { messageId: 'om_q1', senderType: 'app', text: '上一条结论', downloaded: [], failed: [] },
    docs: [{ title: '需求文档', url: 'https://feishu.cn/docx/abc', content: '需求正文', totalChars: 4, truncated: false }],
    downloaded: [{ kind: 'image', localPath: '/tmp/a.png', sizeBytes: 1024, duration: 0 }],
    failed: [],
  });
  assert.ok(mmPrompt.includes('【引用回复的机器人消息') && mmPrompt.includes('【飞书云文档上下文】') && mmPrompt.includes('/tmp/a.png'));

  saveState({
    chats: { oc_test_chat: { conversationId: 'conv-1', cwd: pluginRoot, mode: 'accept-edits', model: '', recentConversations: [] } },
    lastP2pChatByOpenId: { ou_test_owner: 'oc_test_chat' },
  });
  const loadedState = loadState();
  assert.equal(loadedState.lastP2pChatByOpenId.ou_test_owner, 'oc_test_chat');
  assert.equal(loadedState.chats.oc_test_chat.conversationId, 'conv-1');

  // 4e. Self-ops preflight and snapshot
  const preflight = runPreflightCheck();
  assert.equal(preflight.ok, true);
  assert.equal(preflight.checkedFiles.length, 18);
  for (const rel of [
    'scripts/lib/cardkit-stream.mjs',
    'scripts/lib/feishu-docs.mjs',
    'scripts/lib/bridge-helpers.mjs',
    'scripts/lib/task-runner.mjs',
    'scripts/lib/slash-commands.mjs',
    'scripts/lib/card-actions.mjs',
    'scripts/lib/desktop-sessions.mjs',
  ]) {
    assert.ok(preflight.checkedFiles.includes(rel), `Missing in preflight: ${rel}`);
  }
  const snapRes = createBackupSnapshot({ reason: 'smoke-test', force: true });
  assert.equal(snapRes.created, true);
  assert.ok(listBackupSnapshots().length >= 1);

  // 4f. Effort control, timeout parser, and task-runner formatting helpers
  const effortArgs = buildAgyArgs({ prompt: 'hi', mode: 'accept-edits', effort: 'high' });
  assert.ok(effortArgs.includes('--effort') && effortArgs[effortArgs.indexOf('--effort') + 1] === 'high');
  assert.ok(!buildAgyArgs({ prompt: 'hi', effort: 'default' }).includes('--effort'));
  assert.ok(!buildAgyArgs({ prompt: 'hi', effort: 'invalid' }).includes('--effort'));

  const effortCard = buildEffortCard('high');
  assert.equal(effortCard.schema, '2.0');
  const effortButtons = effortCard.body.elements
    .filter((el) => el.tag === 'column_set')
    .flatMap((cs) => cs.columns.map((c) => c.elements[0]));
  const highBtn = effortButtons.find((b) => b.behaviors?.[0]?.value?.arg === 'high');
  assert.equal(highBtn?.type, 'primary');

  assert.equal(parseTimeoutArg('0'), 0);
  assert.equal(parseTimeoutArg('不限时'), 0);
  assert.equal(parseTimeoutArg('60'), 3600);
  assert.equal(parseTimeoutArg('2h'), 7200);
  assert.equal(parseTimeoutArg('90s'), 90);
  assert.equal(parseTimeoutArg('invalid'), null);

  const statusMd = formatToolStatusMarkdown({
    cwd: pluginRoot,
    mode: 'accept-edits',
    effort: 'high',
    toolEntries: [{ stepIndex: 1, toolName: 'read_file', summary: 'README.md', done: true, durationSeconds: 0.4 }],
  });
  assert.ok(statusMd.includes('🎛️ `high`') && statusMd.includes('✅ `read_file`'));
  assert.equal(
    formatUsageSummary({ input_tokens: 1500, output_tokens: 500, total_tokens: 2000 }),
    'Token 2.0k (1.5k→500)',
  );
  assert.equal(
    isTransientStartupRace({
      aborted: false,
      status: 'ERROR',
      exitCode: 1,
      conversationId: '',
      stderr: 'error: failed to start conversation: backend returned an empty conversation id',
    }),
    true,
  );
  assert.equal(
    isTransientStartupRace({
      aborted: false,
      status: 'ERROR',
      exitCode: 1,
      conversationId: 'conv-123',
      stderr: 'failed to start conversation',
    }),
    false,
  );
  assert.equal(
    isTransientStartupRace({
      aborted: true,
      status: 'ERROR',
      exitCode: 1,
      conversationId: '',
      stderr: 'failed to start conversation',
    }),
    false,
  );

  // 4g. Desktop session scanner, FTS5 search, transcript turns, handoff cards
  const fakeGeminiDir = path.join(tempConfigDir, 'fake-gemini');
  const { DatabaseSync } = await import('node:sqlite');
  const cliAppDir = path.join(fakeGeminiDir, 'antigravity-cli');
  const desktopAppDir = path.join(fakeGeminiDir, 'antigravity');
  fs.mkdirSync(path.join(cliAppDir, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(desktopAppDir, 'brain', 'desk-1', '.system_generated', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(cliAppDir, 'brain', 'cli-1', '.system_generated', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(cliAppDir, 'conversations', 'cli-1.db'), '');
  fs.writeFileSync(
    path.join(desktopAppDir, 'brain', 'desk-1', '.system_generated', 'logs', 'transcript.jsonl'),
    [
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-23T05:00:00Z', content: '<USER_REQUEST>\n分析 PPT 优化方案\n</USER_REQUEST><ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>' }),
      JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-23T05:00:10Z', content: '已完成结构梳理，建议补充图表页。' }),
    ].join('\n'),
  );

  const seedStoreDb = (dbFile, rows) => {
    const db = new DatabaseSync(dbFile);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        step_count INTEGER,
        last_modified_time TEXT,
        workspace_uris TEXT,
        status TEXT,
        nesting_depth INTEGER,
        app_data_dir TEXT
      );
      CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id, title, preview, workspace);
    `);
    const ins = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insFts = db.prepare('INSERT INTO conversations_fts VALUES (?, ?, ?, ?)');
    for (const r of rows) {
      ins.run(r.id, r.title, r.preview, r.stepCount, r.modified, r.workspaces, r.status, r.depth, r.appDataDir);
      insFts.run(r.id, r.title, r.preview, r.workspaces);
    }
    db.close();
  };

  seedStoreDb(path.join(cliAppDir, 'conversation_summaries.db'), [
    {
      id: 'cli-1',
      title: 'CLI 原生重构任务',
      preview: '模块化完成',
      stepCount: 12,
      modified: '2026-11-23 06:00:00+00:00',
      workspaces: JSON.stringify([`file://${pluginRoot}`]),
      status: 'CASCADE_RUN_STATUS_IDLE',
      depth: 0,
      appDataDir: cliAppDir,
    },
    {
      id: 'sub-ignored',
      title: '子代理隐藏会话',
      preview: 'internal',
      stepCount: 2,
      modified: '2026-11-23 06:01:00+00:00',
      workspaces: '[]',
      status: 'CASCADE_RUN_STATUS_IDLE',
      depth: 1,
      appDataDir: cliAppDir,
    },
  ]);

  seedStoreDb(path.join(desktopAppDir, 'conversation_summaries.db'), [
    {
      id: 'cli-1',
      title: 'CLI 原生重构任务',
      preview: 'duplicate in desktop store',
      stepCount: 12,
      modified: '2026-11-23 05:59:00+00:00',
      workspaces: JSON.stringify([`file://${pluginRoot}`]),
      status: 'CASCADE_RUN_STATUS_IDLE',
      depth: 0,
      appDataDir: cliAppDir,
    },
    {
      id: 'desk-1',
      title: '制作季度汇报 PPT',
      preview: '已完成目录与视觉风格建议',
      stepCount: 8,
      modified: '2026-11-23 05:30:00+00:00',
      workspaces: JSON.stringify([`file://${os.homedir()}`]),
      status: 'CASCADE_RUN_STATUS_RUNNING',
      depth: 0,
      appDataDir: 'antigravity',
    },
  ]);

  const prevGeminiEnv = process.env.FEISHU_REMOTE_GEMINI_DIR;
  process.env.FEISHU_REMOTE_GEMINI_DIR = fakeGeminiDir;
  try {
    const allDesk = listDesktopSessions({ limit: 10 });
    assert.equal(allDesk.length, 2);
    assert.equal(allDesk[0].id, 'cli-1');
    assert.equal(allDesk[0].takeoverMode, 'native');
    assert.equal(allDesk[1].id, 'desk-1');
    assert.equal(allDesk[1].takeoverMode, 'handoff');
    assert.equal(allDesk[1].running, true);

    const runningOnly = listDesktopSessions({ filter: 'running', limit: 10 });
    assert.equal(runningOnly.length, 1);
    assert.equal(runningOnly[0].id, 'desk-1');

    const ftsHit = listDesktopSessions({ query: 'PPT / 汇报', limit: 10 });
    assert.equal(ftsHit.length, 1);
    assert.equal(ftsHit[0].id, 'desk-1');

    const detail = getDesktopSessionDetail('desk-1');
    assert.ok(detail && detail.turns.length === 2);
    assert.ok(path.isAbsolute(detail.brainDir) && detail.brainDir.startsWith(fakeGeminiDir));
    assert.equal(detail.turns[0].text, '分析 PPT 优化方案');
    const handoffCtx = buildDesktopHandoffContext(detail);
    assert.ok(handoffCtx.includes('[电脑端对话上下文接管]') && handoffCtx.includes('已完成结构梳理'));

    const listCard = buildDesktopSessionsCard({ items: allDesk, query: 'PPT' });
    assert.equal(listCard.schema, '2.0');
    const previewCard = buildDesktopSessionPreviewCard(detail);
    assert.equal(previewCard.schema, '2.0');
    assert.ok(extractTranscriptTurns(path.join(cliAppDir, 'brain', 'cli-1')).length === 0);
    assert.equal(isSubagentConversation('sub-ignored'), true);
    assert.equal(isSubagentConversation('desk-1'), false);
  } finally {
    if (prevGeminiEnv === undefined) {
      delete process.env.FEISHU_REMOTE_GEMINI_DIR;
    } else {
      process.env.FEISHU_REMOTE_GEMINI_DIR = prevGeminiEnv;
    }
  }

  // 4h. In-place log tail pruning and inbox total byte cap
  const testLogPath = path.join(tempConfigDir, 'daemon.test.log');
  const logLines = Array.from({ length: 200 }, (_, i) => `line-${i + 1}: sample log payload padding`).join('\n');
  fs.writeFileSync(testLogPath, `${logLines}\n`, 'utf8');
  const inoBefore = fs.statSync(testLogPath).ino;
  const pruneRes = pruneLogFileIfOversized(testLogPath, { maxBytes: 1024, keepBytes: 256 });
  assert.equal(pruneRes.pruned, true);
  assert.equal(fs.statSync(testLogPath).ino, inoBefore);
  assert.ok(pruneRes.afterBytes < 1024);
  const prunedContent = fs.readFileSync(testLogPath, 'utf8');
  assert.ok(prunedContent.startsWith('[feishu-remote] Log truncated in-place'));
  assert.ok(prunedContent.trimEnd().endsWith('line-200: sample log payload padding'));

  const capDir = path.join(tempConfigDir, 'inbox', 'chat_cap');
  fs.mkdirSync(capDir, { recursive: true });
  const nowSec = Math.floor(Date.now() / 1000);
  const oldFile = path.join(capDir, 'old.bin');
  const midFile = path.join(capDir, 'mid.bin');
  const newFile = path.join(capDir, 'new.bin');
  fs.writeFileSync(oldFile, Buffer.alloc(100, 1));
  fs.writeFileSync(midFile, Buffer.alloc(100, 2));
  fs.writeFileSync(newFile, Buffer.alloc(100, 3));
  fs.utimesSync(oldFile, nowSec - 300, nowSec - 300);
  fs.utimesSync(midFile, nowSec - 200, nowSec - 200);
  fs.utimesSync(newFile, nowSec - 100, nowSec - 100);
  cleanupOldInboxFiles(7, { maxTotalBytes: 150 });
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(midFile), false);
  assert.equal(fs.existsSync(newFile), true);

  // 4i. Topic group session keys, inheritance, stale thread pruning, and panel badges
  assert.equal(makeSessionKey('oc_topic_1', ''), 'oc_topic_1');
  assert.equal(makeSessionKey('oc_topic_1', 'om_root_1'), 'oc_topic_1#om_root_1');
  assert.deepEqual(parseSessionKey('oc_topic_1'), { chatId: 'oc_topic_1', threadRootId: '' });
  assert.deepEqual(parseSessionKey('oc_topic_1#om_root_1'), {
    chatId: 'oc_topic_1',
    threadRootId: 'om_root_1',
  });

  const topicConfig = {
    agy: {
      defaultCwd: os.homedir(),
      defaultMode: 'accept-edits',
      defaultModel: '',
      defaultEffort: '',
      maxConcurrentRuns: 4,
    },
  };
  const nowMs = Date.now();
  const topicState = {
    chats: {
      oc_topic_1: {
        conversationId: '',
        cwd: pluginRoot,
        mode: 'auto',
        model: 'gemini-3.1-pro',
        effort: 'high',
        recentConversations: [],
        pendingHandoff: null,
        fullExpiresAt: 0,
        fullRevertMode: 'accept-edits',
        lastActiveAt: nowMs - 40 * 86400_000,
      },
      'oc_topic_1#om_stale': {
        conversationId: 'old-conv',
        cwd: os.homedir(),
        mode: 'accept-edits',
        lastActiveAt: nowMs - 35 * 86400_000,
      },
      'oc_topic_1#om_fresh': {
        conversationId: 'fresh-conv',
        cwd: os.homedir(),
        mode: 'accept-edits',
        lastActiveAt: nowMs - 1000,
      },
    },
    lastP2pChatByOpenId: {},
  };

  const inheritedThread = getOrCreateChatState(topicState, 'oc_topic_1#om_new_1', topicConfig);
  assert.equal(inheritedThread.cwd, pluginRoot);
  assert.equal(inheritedThread.mode, 'auto');
  assert.equal(inheritedThread.model, 'gemini-3.1-pro');
  assert.equal(inheritedThread.effort, 'high');
  assert.ok(inheritedThread.lastActiveAt > 0);
  assert.equal(topicState.chats['oc_topic_1#om_fresh'].cwd, os.homedir());

  saveState(topicState);
  const prunedCount = pruneStaleThreadStates(30);
  assert.equal(prunedCount, 1);
  const afterPrune = loadState();
  assert.equal(Boolean(afterPrune.chats.oc_topic_1), true);
  assert.equal(Boolean(afterPrune.chats['oc_topic_1#om_stale']), false);
  assert.equal(Boolean(afterPrune.chats['oc_topic_1#om_fresh']), true);

  const topicPanelCard = buildControlPanelCard({
    chatState: inheritedThread,
    config: topicConfig,
    isRunning: true,
    threadRootId: 'om_new_1_abc',
    activeParallelCount: 2,
    maxConcurrentRuns: 4,
  });
  assert.equal(topicPanelCard.schema, '2.0');
  const topicPanelJson = JSON.stringify(topicPanelCard);
  assert.ok(topicPanelJson.includes('om_new_1_abc'));
  assert.ok(topicPanelJson.includes('全局并行 2/4'));

  // 4j. Directory browser pagination
  const manyDirRoot = path.join(tempConfigDir, 'many-dirs');
  for (let i = 1; i <= 15; i += 1) {
    fs.mkdirSync(path.join(manyDirRoot, `dir-${String(i).padStart(2, '0')}`), { recursive: true });
  }
  const dirPage0Json = JSON.stringify(
    buildDirsCard({ chatState: { cwd: manyDirRoot }, config: topicConfig, page: 0 }),
  );
  assert.ok(dirPage0Json.includes('第 1/2 页'));
  assert.ok(dirPage0Json.includes('▶️ 下一页 (2/2)'));
  assert.ok(!dirPage0Json.includes('◀️ 上一页'));

  const dirPage1Json = JSON.stringify(
    buildDirsCard({ chatState: { cwd: manyDirRoot }, config: topicConfig, page: 1 }),
  );
  assert.ok(dirPage1Json.includes('第 2/2 页'));
  assert.ok(dirPage1Json.includes('◀️ 上一页 (1/2)'));
  assert.ok(dirPage1Json.includes('dir-15'));

  // 5. stop-notify.mjs subprocess checks
  const stopChildRes = await runSubprocess('scripts/stop-notify.mjs', {
    env: { FEISHU_REMOTE_CONFIG_DIR: tempConfigDir, FEISHU_REMOTE_BRIDGE_CHILD: '1' },
    stdinData: JSON.stringify({ terminationReason: 'NO_TOOL_CALL' }),
  });
  assert.equal(stopChildRes.code, 0);
  assert.equal(stopChildRes.stdout.trim(), '{}');

  const stopContinuationRes = await runSubprocess('scripts/stop-notify.mjs', {
    env: { FEISHU_REMOTE_CONFIG_DIR: tempConfigDir },
    stdinData: JSON.stringify({ continuationActive: true, terminationReason: 'NO_TOOL_CALL' }),
  });
  assert.equal(stopContinuationRes.code, 0);
  assert.equal(stopContinuationRes.stdout.trim(), '{}');

  const stopUnconfiguredRes = await runSubprocess('scripts/stop-notify.mjs', {
    env: { FEISHU_REMOTE_CONFIG_DIR: path.join(tempConfigDir, 'empty') },
    stdinData: JSON.stringify({ terminationReason: 'NO_TOOL_CALL' }),
  });
  assert.equal(stopUnconfiguredRes.code, 0);
  assert.equal(stopUnconfiguredRes.stdout.trim(), '{}');

  const stopNotIdleRes = await runSubprocess('scripts/stop-notify.mjs', {
    env: { FEISHU_REMOTE_CONFIG_DIR: tempConfigDir },
    stdinData: JSON.stringify({ fullyIdle: false, terminationReason: 'NO_TOOL_CALL' }),
  });
  assert.equal(stopNotIdleRes.code, 0);
  assert.equal(stopNotIdleRes.stdout.trim(), '{}');
  assert.equal(stopNotIdleRes.stderr.trim(), '');

  const stopTerminalStepRes = await runSubprocess('scripts/stop-notify.mjs', {
    env: { FEISHU_REMOTE_CONFIG_DIR: tempConfigDir },
    stdinData: JSON.stringify({ fullyIdle: true, terminationReason: 'TERMINAL_STEP_TYPE' }),
  });
  assert.equal(stopTerminalStepRes.code, 0);
  assert.equal(stopTerminalStepRes.stdout.trim(), '{}');
  assert.equal(stopTerminalStepRes.stderr.trim(), '');

  const stopCanceledRes = await runSubprocess('scripts/stop-notify.mjs', {
    env: { FEISHU_REMOTE_CONFIG_DIR: tempConfigDir },
    stdinData: JSON.stringify({ fullyIdle: true, terminationReason: 'USER_CANCELED' }),
  });
  assert.equal(stopCanceledRes.code, 0);
  assert.equal(stopCanceledRes.stdout.trim(), '{}');
  assert.equal(stopCanceledRes.stderr.trim(), '');

  const stopSubagentRes = await runSubprocess('scripts/stop-notify.mjs', {
    env: { FEISHU_REMOTE_CONFIG_DIR: tempConfigDir, FEISHU_REMOTE_GEMINI_DIR: fakeGeminiDir },
    stdinData: JSON.stringify({ conversationId: 'sub-ignored', fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }),
  });
  assert.equal(stopSubagentRes.code, 0);
  assert.equal(stopSubagentRes.stdout.trim(), '{}');
  assert.equal(stopSubagentRes.stderr.trim(), '');

  assert.equal(resolveStopNotifyMode({ notifications: { stopHookEnabled: false, stopNotifyMode: 'on' } }), 'off');
  assert.equal(resolveStopNotifyMode({ notifications: { stopHookEnabled: true, stopNotifyMode: 'away' } }), 'away');
  assert.equal(resolveStopNotifyMode({ notifications: { stopHookEnabled: true } }), 'on');

  const notifyTestCfg = loadConfig();
  notifyTestCfg.notifications.stopHookEnabled = true;
  notifyTestCfg.notifications.stopNotifyMode = 'away';
  notifyTestCfg.notifications.awayIdleSeconds = 120;
  saveConfig(notifyTestCfg);
  assert.equal(buildNotifyCard({ config: notifyTestCfg }).schema, '2.0');

  const stopActiveUserRes = await runSubprocess('scripts/stop-notify.mjs', {
    env: { FEISHU_REMOTE_CONFIG_DIR: tempConfigDir, FEISHU_REMOTE_TEST_IDLE_SECONDS: '15' },
    stdinData: JSON.stringify({ fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }),
  });
  assert.equal(stopActiveUserRes.code, 0);
  assert.equal(stopActiveUserRes.stdout.trim(), '{}');
  assert.equal(stopActiveUserRes.stderr.trim(), '');

  notifyTestCfg.notifications.stopNotifyMode = 'off';
  notifyTestCfg.notifications.stopHookEnabled = false;
  saveConfig(notifyTestCfg);
  const stopMutedRes = await runSubprocess('scripts/stop-notify.mjs', {
    env: { FEISHU_REMOTE_CONFIG_DIR: tempConfigDir, FEISHU_REMOTE_TEST_IDLE_SECONDS: '999' },
    stdinData: JSON.stringify({ fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }),
  });
  assert.equal(stopMutedRes.code, 0);
  assert.equal(stopMutedRes.stdout.trim(), '{}');
  assert.equal(stopMutedRes.stderr.trim(), '');

  const ioregSample = '    | | |   "HIDIdleTime" = 6728880875\n';
  const ioregMatch = ioregSample.match(/"?HIDIdleTime"?\s*=\s*(\d+)/);
  assert.ok(ioregMatch);
  assert.equal(Math.floor(Number(ioregMatch[1]) / 1e9), 6);

  // 6. mcp-server.mjs stdio JSON-RPC handshake
  await testMcpStdio();

  // 7. cli.mjs pack check
  const zipPath = path.join(tempConfigDir, 'feishu-remote-test.zip');
  execFileSync(process.execPath, [path.join(pluginRoot, 'scripts', 'cli.mjs'), 'pack', '--out', zipPath], {
    env: { ...process.env, FEISHU_REMOTE_CONFIG_DIR: tempConfigDir },
  });
  const zipList = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  assert.ok(zipList.includes('feishu-remote/plugin.json'));
  assert.ok(zipList.includes('feishu-remote/mcp_config.json'));
  assert.ok(zipList.includes('feishu-remote/hooks.json'));
  assert.ok(zipList.includes('feishu-remote/skills/feishu-remote/SKILL.md'));
  assert.ok(zipList.includes('feishu-remote/scripts/bridge-daemon.mjs'));
  assert.ok(!zipList.includes('node_modules'), 'Zip must not contain node_modules');
  assert.ok(!zipList.includes('super_secret_token_987654'), 'Zip must not contain secrets');

  console.log('ALL SMOKE TESTS PASSED');
} finally {
  fs.rmSync(tempConfigDir, { recursive: true, force: true });
}
