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
  clearUserAuth,
  getApprovalsDir,
  getConfigPath,
  getHandoffsDir,
  getPluginRoot,
  loadConfig,
  loadState,
  loadUserAuth,
  maskSecret,
  resolveRiskyApprovalEnabled,
  resolveStopNotifyMode,
  saveConfig,
  saveState,
  saveUserAuth,
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
  buildTasksCard,
  sanitizeForFeishuMarkdown,
  searchDirsFuzzy,
  splitMarkdownChunks,
} = await import('./lib/feishu-api.mjs');
const {
  buildOAuthAuthorizeUrl,
  formatTaskDueText,
  getUserAuthStatus,
  parseDueTimeInput,
} = await import('./lib/feishu-tasks.mjs');
const {
  buildDesktopHandoffContext,
  extractLatestAssistantReply,
  extractStopReplyPreview,
  extractTranscriptTurns,
  getDesktopSessionDetail,
  isSubagentConversation,
  listDesktopSessions,
} = await import('./lib/desktop-sessions.mjs');
const {
  buildAgyArgs,
  buildChildEnv,
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
  downloadMessageAttachments,
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
  collectTurnDiff,
  getOrCreateChatState,
  makeSessionKey,
  parseSessionKey,
  parseTimeoutArg,
} = await import('./lib/bridge-helpers.mjs');
const {
  extractModifiedFilePath,
  formatToolStatusMarkdown,
  formatUsageSummary,
  isTransientStartupRace,
  resolvePromptWithHandoff,
  shouldClearPendingHandoff,
} = await import('./lib/task-runner.mjs');
const {
  buildCliResumeCommand,
  buildDesktopReturnPrompt,
  buildHandoffCard,
  checkOriginDesktopDrift,
  copyToSystemClipboard,
  listMobileSessions,
  readMobileSession,
  writeHandoffSnapshot,
} = await import('./lib/mobile-handoff.mjs');
const {
  buildApprovalCard,
  classifyCommandRisk,
  cleanupStaleApprovals,
  createApprovalRequest,
  readApprovalDecision,
  readApprovalRequest,
  waitForApprovalDecision,
  writeApprovalDecision,
} = await import('./lib/command-guard.mjs');
const {
  handleCardAction,
} = await import('./lib/card-actions.mjs');

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

function stripNodeExperimentalWarnings(stderr = '') {
  return String(stderr)
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/^\(node:\d+\)\s+ExperimentalWarning:/.test(trimmed)) return false;
      if (/^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/.test(trimmed)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

async function testMcpStdio(extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(pluginRoot, 'scripts', 'mcp-server.mjs')], {
    env: { ...process.env, FEISHU_REMOTE_CONFIG_DIR: tempConfigDir, ...extraEnv },
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
      'feishu_complete_task',
      'feishu_create_task',
      'feishu_list_mobile_sessions',
      'feishu_list_tasks',
      'feishu_manage_bridge',
      'feishu_read_doc',
      'feishu_read_mobile_session',
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

    const mobileListRes = await rpc(4, 'tools/call', {
      name: 'feishu_list_mobile_sessions',
      arguments: { origin_desktop_id: 'desk-1' },
    });
    const mobileListData = JSON.parse(mobileListRes.result.content[0].text);
    assert.equal(mobileListData.ok, true);
    assert.ok(mobileListData.count >= 1);
    assert.equal(mobileListData.sessions[0].conversationId, 'cli-1');

    const mobileReadRes = await rpc(5, 'tools/call', {
      name: 'feishu_read_mobile_session',
      arguments: { origin_desktop_id: 'desk-1' },
    });
    const mobileReadData = JSON.parse(mobileReadRes.result.content[0].text);
    assert.equal(mobileReadData.ok, true);
    assert.equal(mobileReadData.conversationId, 'cli-1');
    assert.ok(mobileReadData.cliResumeCommand.includes('--conversation cli-1'));
    assert.ok(mobileReadData.desktopHandoffPrompt.includes('[手机飞书端进展回流]'));
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
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(getConfigPath()).mode & 0o777, 0o600);
  }
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
  for (const el of panelCard.body.elements.filter((item) => item.tag === 'column_set')) {
    assert.ok(el.columns.length <= 5, `Panel button row too wide (${el.columns.length} cols)`);
  }
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

  const todoFullParsed = extractInboundMessage({
    message_type: 'todo',
    content: JSON.stringify({
      task_id: 'task_abc_123',
      due_time: '1764000000000',
      summary: {
        title: '排查线上告警',
        content: [
          [{ tag: 'text', text: '检查网关超时日志' }],
          [{ tag: 'img', image_key: 'img_todo_1' }],
        ],
      },
    }),
  });
  assert.equal(todoFullParsed.supported, true);
  assert.ok(todoFullParsed.text.includes('【飞书任务】'));
  assert.ok(todoFullParsed.text.includes('排查线上告警'));
  assert.ok(todoFullParsed.text.includes('检查网关超时日志'));
  assert.ok(todoFullParsed.text.includes('截止时间：'));
  assert.ok(todoFullParsed.text.includes('task_id=task_abc_123'));
  assert.equal(todoFullParsed.attachments.length, 1);
  assert.equal(todoFullParsed.attachments[0].fileKey, 'img_todo_1');

  const todoTitleOnlyParsed = extractInboundMessage({
    message_type: 'todo',
    content: JSON.stringify({
      summary: { title: '仅标题任务' },
    }),
  });
  assert.equal(todoTitleOnlyParsed.supported, true);
  assert.ok(todoTitleOnlyParsed.text.includes('仅标题任务'));
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
  assert.equal(preflight.checkedFiles.length, 30);
  for (const rel of [
    'scripts/pre-tool-approval.mjs',
    'scripts/lib/io-utils.mjs',
    'scripts/lib/security.mjs',
    'scripts/lib/feishu-cards.mjs',
    'scripts/lib/cardkit-stream.mjs',
    'scripts/lib/feishu-docs.mjs',
    'scripts/lib/feishu-tasks.mjs',
    'scripts/lib/bridge-helpers.mjs',
    'scripts/lib/task-runner.mjs',
    'scripts/lib/slash-commands.mjs',
    'scripts/lib/card-actions.mjs',
    'scripts/lib/desktop-sessions.mjs',
    'scripts/lib/mobile-handoff.mjs',
    'scripts/lib/command-guard.mjs',
    'scripts/lib/actions/desktop.mjs',
    'scripts/lib/actions/artifacts.mjs',
    'scripts/lib/actions/ops.mjs',
    'scripts/lib/actions/tasks.mjs',
    'scripts/lib/actions/workspace.mjs',
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
  const fullMarkdownReply = [
    '### 完整优化方案',
    '',
    '1. 精简封面文字并突出核心结论，控制每页不超过三个关键指标，确保远程汇报与投屏阅读都清晰明了',
    '2. 新增核心指标对比图表页与季度环比趋势图，并在底部补充数据口径说明与异常波动归因分析',
    '3. 为每页补充一页一句话结论摘要，方便管理层快速扫读与决策确认，同时附上后续两周的里程碑排期建议',
  ].join('\n');
  fs.writeFileSync(
    path.join(desktopAppDir, 'brain', 'desk-1', '.system_generated', 'logs', 'transcript_full.jsonl'),
    [
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-23T05:00:00Z', content: '<USER_REQUEST>\n分析 PPT 优化方案\n</USER_REQUEST><ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>' }),
      JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-23T05:00:10Z', content: fullMarkdownReply }),
      JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-11-23T05:00:12Z', tool_calls: [{ name: 'read_file' }] }),
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
    assert.equal(detail.lastAssistantReply, fullMarkdownReply);
    assert.ok(detail.transcriptFile.endsWith('transcript_full.jsonl'));
    assert.equal(detail.lastAssistantReplyTruncated, false);
    const truncatedReply = extractLatestAssistantReply(path.join(desktopAppDir, 'brain', 'desk-1'), { maxChars: 100 });
    assert.ok(truncatedReply && truncatedReply.truncated === true && truncatedReply.totalChars === fullMarkdownReply.length);
    const handoffCtx = buildDesktopHandoffContext(detail);
    assert.ok(handoffCtx.includes('[电脑端对话上下文接管]') && handoffCtx.includes('电脑端最后一条模型回复：'));
    assert.ok(handoffCtx.includes('原对话完整日志：') && handoffCtx.includes(fullMarkdownReply));

    const listCard = buildDesktopSessionsCard({ items: allDesk, query: 'PPT' });
    assert.equal(listCard.schema, '2.0');
    const previewCard = buildDesktopSessionPreviewCard(detail);
    assert.equal(previewCard.schema, '2.0');
    assert.ok(JSON.stringify(previewCard).includes('desktop_last_reply'));
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

  // 4h-2. downloadMessageAttachments must not ENOENT when initial cleanup runs on an empty chat inbox dir
  const mockJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const mockFeishuClient = {
    im: {
      v1: {
        messageResource: {
          get: async () => mockJpeg,
        },
      },
    },
  };
  const dlRes = await downloadMessageAttachments(mockFeishuClient, {
    messageId: 'om_test_img_1',
    chatKey: 'oc_fresh_empty_dir_test',
    attachments: [{ kind: 'image', resourceType: 'image', fileKey: 'img_v3_test', fileName: '' }],
  });
  assert.equal(dlRes.failed.length, 0, `Expected 0 download failures, got: ${JSON.stringify(dlRes.failed)}`);
  assert.equal(dlRes.downloaded.length, 1);
  assert.ok(dlRes.downloaded[0].localPath.endsWith('.jpg'));
  assert.equal(fs.existsSync(dlRes.downloaded[0].localPath), true);

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

  // 4j. Directory browser pagination & hidden directories toggle
  const manyDirRoot = path.join(tempConfigDir, 'many-dirs');
  for (let i = 1; i <= 15; i += 1) {
    fs.mkdirSync(path.join(manyDirRoot, `dir-${String(i).padStart(2, '0')}`), { recursive: true });
  }
  fs.mkdirSync(path.join(manyDirRoot, '.gemini-hidden'), { recursive: true });
  const dirPage0Json = JSON.stringify(
    buildDirsCard({ chatState: { cwd: manyDirRoot }, config: topicConfig, page: 0 }),
  );
  assert.ok(dirPage0Json.includes('第 1/2 页'));
  assert.ok(dirPage0Json.includes('▶️ 下一页 (2/2)'));
  assert.ok(!dirPage0Json.includes('◀️ 上一页'));
  assert.ok(!dirPage0Json.includes('.gemini-hidden'));
  assert.ok(dirPage0Json.includes('另有 1 个隐藏目录'));
  assert.ok(dirPage0Json.includes('🙈 显示隐藏'));
  assert.ok(dirPage0Json.includes('"showHidden":true'));

  const dirPage1Json = JSON.stringify(
    buildDirsCard({ chatState: { cwd: manyDirRoot }, config: topicConfig, page: 1 }),
  );
  assert.ok(dirPage1Json.includes('第 2/2 页'));
  assert.ok(dirPage1Json.includes('◀️ 上一页 (1/2)'));
  assert.ok(dirPage1Json.includes('dir-15'));

  const dirHiddenOnJson = JSON.stringify(
    buildDirsCard({ chatState: { cwd: manyDirRoot, showHiddenDirs: true }, config: topicConfig, page: 0 }),
  );
  assert.ok(dirHiddenOnJson.includes('.gemini-hidden'));
  assert.ok(dirHiddenOnJson.includes('隐藏 1 个'));
  assert.ok(dirHiddenOnJson.includes('👁️ 隐藏:开'));
  assert.ok(dirHiddenOnJson.includes('"showHidden":false'));

  // 4k. Feishu Task v2 OAuth helpers, due parsing, user-auth storage (0600), and tasks card
  const feishuAuthUrl = buildOAuthAuthorizeUrl({
    appId: 'cli_test_123',
    domain: 'feishu',
    state: 'st_abc',
  });
  assert.ok(feishuAuthUrl.startsWith('https://accounts.feishu.cn/open-apis/authen/v1/authorize'));
  assert.ok(feishuAuthUrl.includes('offline_access') && feishuAuthUrl.includes('task%3Atask%3Aread'));
  assert.ok(feishuAuthUrl.includes('127.0.0.1%3A18923%2Fcallback'));
  const larkAuthUrl = buildOAuthAuthorizeUrl({ appId: 'cli_test_123', domain: 'lark' });
  assert.ok(larkAuthUrl.startsWith('https://accounts.larksuite.com/open-apis/authen/v1/authorize'));

  const dueDateOnly = parseDueTimeInput('2026-11-26');
  assert.equal(dueDateOnly?.is_all_day, true);
  assert.equal(formatTaskDueText(dueDateOnly), '2026-11-26');
  const dueWithTime = parseDueTimeInput('2026-11-26 18:30');
  assert.equal(dueWithTime?.is_all_day, false);
  assert.equal(formatTaskDueText(dueWithTime), '2026-11-26 18:30');
  assert.ok(formatTaskDueText({ timestamp: '1764000000000', is_all_day: false }).length >= 16);

  clearUserAuth();
  assert.equal(getUserAuthStatus().authorized, false);
  saveUserAuth({
    accessToken: 'u-secret-access-token',
    refreshToken: 'ur-secret-refresh-token',
    expiresAt: Date.now() + 3600_000,
    refreshExpiresAt: Date.now() + 86400_000,
    scope: 'offline_access task:task:read task:task:write',
    domain: 'feishu',
  });
  const loadedUserAuth = loadUserAuth();
  assert.equal(loadedUserAuth?.accessToken, 'u-secret-access-token');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(tempConfigDir, 'user-auth.json')).mode & 0o777, 0o600);
  }
  const statusSafe = getUserAuthStatus();
  assert.equal(statusSafe.authorized, true);
  assert.equal(statusSafe.hasRefreshToken, true);
  assert.ok(!JSON.stringify(statusSafe).includes('u-secret-access-token'));
  assert.ok(!JSON.stringify(statusSafe).includes('ur-secret-refresh-token'));

  const tasksUnauthJson = JSON.stringify(
    buildTasksCard({ authStatus: { authorized: false }, authUrl: feishuAuthUrl }),
  );
  assert.ok(tasksUnauthJson.includes('127.0.0.1:18923/callback'));
  assert.ok(tasksUnauthJson.includes('cli.mjs auth'));

  const tasksAuthedJson = JSON.stringify(
    buildTasksCard({
      authStatus: statusSafe,
      filter: 'open',
      items: [
        { guid: 'task-guid-1111', summary: '修复下载 bug', description: '检查 media.mjs', dueText: '2026-11-26', completed: false },
        { guid: 'task-guid-2222', summary: '补充单测', description: '', dueText: '', completed: true },
      ],
    }),
  );
  assert.ok(tasksAuthedJson.includes('修复下载 bug'));
  assert.ok(tasksAuthedJson.includes('task_run'));
  assert.ok(tasksAuthedJson.includes('task_toggle'));
  clearUserAuth();

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
  assert.equal(stripNodeExperimentalWarnings(stopNotIdleRes.stderr), '');

  const stopTerminalStepRes = await runSubprocess('scripts/stop-notify.mjs', {
    env: { FEISHU_REMOTE_CONFIG_DIR: tempConfigDir },
    stdinData: JSON.stringify({ fullyIdle: true, terminationReason: 'TERMINAL_STEP_TYPE' }),
  });
  assert.equal(stopTerminalStepRes.code, 0);
  assert.equal(stopTerminalStepRes.stdout.trim(), '{}');
  assert.equal(stripNodeExperimentalWarnings(stopTerminalStepRes.stderr), '');

  const stopCanceledRes = await runSubprocess('scripts/stop-notify.mjs', {
    env: { FEISHU_REMOTE_CONFIG_DIR: tempConfigDir },
    stdinData: JSON.stringify({ fullyIdle: true, terminationReason: 'USER_CANCELED' }),
  });
  assert.equal(stopCanceledRes.code, 0);
  assert.equal(stopCanceledRes.stdout.trim(), '{}');
  assert.equal(stripNodeExperimentalWarnings(stopCanceledRes.stderr), '');

  const stopSubagentRes = await runSubprocess('scripts/stop-notify.mjs', {
    env: { FEISHU_REMOTE_CONFIG_DIR: tempConfigDir, FEISHU_REMOTE_GEMINI_DIR: fakeGeminiDir },
    stdinData: JSON.stringify({ conversationId: 'sub-ignored', fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }),
  });
  assert.equal(stopSubagentRes.code, 0);
  assert.equal(stopSubagentRes.stdout.trim(), '{}');
  assert.equal(stripNodeExperimentalWarnings(stopSubagentRes.stderr), '');

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
  assert.equal(stripNodeExperimentalWarnings(stopActiveUserRes.stderr), '');

  notifyTestCfg.notifications.stopNotifyMode = 'off';
  notifyTestCfg.notifications.stopHookEnabled = false;
  saveConfig(notifyTestCfg);
  const stopMutedRes = await runSubprocess('scripts/stop-notify.mjs', {
    env: { FEISHU_REMOTE_CONFIG_DIR: tempConfigDir, FEISHU_REMOTE_TEST_IDLE_SECONDS: '999' },
    stdinData: JSON.stringify({ fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }),
  });
  assert.equal(stopMutedRes.code, 0);
  assert.equal(stopMutedRes.stdout.trim(), '{}');
  assert.equal(stripNodeExperimentalWarnings(stopMutedRes.stderr), '');

  const ioregSample = '    | | |   "HIDIdleTime" = 6728880875\n';
  const ioregMatch = ioregSample.match(/"?HIDIdleTime"?\s*=\s*(\d+)/);
  assert.ok(ioregMatch);
  assert.equal(Math.floor(Number(ioregMatch[1]) / 1e9), 6);

  const childEnv = buildChildEnv(DEFAULT_CONFIG, process.execPath);
  assert.equal(childEnv.FEISHU_REMOTE_BRIDGE_CHILD, '1');
  assert.ok(childEnv.PATH.split(path.delimiter).length >= 1);

  // 6. P0 Mobile handoff, P1 artifacts/retry/stop-preview, P2 command guard & PreToolUse hook
  fs.writeFileSync(
    path.join(cliAppDir, 'brain', 'cli-1', '.system_generated', 'logs', 'transcript.jsonl'),
    [
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-23T06:00:00Z', content: '<USER_REQUEST>\n在手机上继续优化插件\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-23T06:00:15Z', content: '已完成手机端改造并补充单测。' }),
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(cliAppDir, 'brain', 'cli-1', '.system_generated', 'logs', 'transcript_full.jsonl'),
    [
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-23T06:00:00Z', content: '<USER_REQUEST>\n在手机上继续优化插件\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-23T06:00:15Z', content: '已完成手机端改造并补充单测。' }),
    ].join('\n'),
  );

  saveState({
    chats: {
      oc_handoff_test: {
        conversationId: 'cli-1',
        cwd: pluginRoot,
        mode: 'accept-edits',
        model: '',
        recentConversations: [
          {
            id: 'cli-1',
            summary: '手机端插件优化',
            updatedAt: new Date().toISOString(),
            cwd: pluginRoot,
            originDesktopId: 'desk-1',
            originDesktopTitle: '制作季度汇报 PPT',
          },
        ],
        originDesktopSession: {
          id: 'desk-1',
          title: '制作季度汇报 PPT',
          source: 'desktop',
          workspace: pluginRoot,
          takenOverAt: Date.now() - 60_000,
          desktopLastModifiedMs: 1000,
          desktopStepCount: 5,
        },
        lastTurnArtifacts: {
          conversationId: 'cli-1',
          cwd: pluginRoot,
          files: [path.join(pluginRoot, 'package.json')],
          updatedAt: Date.now(),
        },
        lastActiveAt: Date.now(),
      },
    },
    lastP2pChatByOpenId: { ou_test_owner: 'oc_handoff_test' },
  });

  const prevGeminiHandoffEnv = process.env.FEISHU_REMOTE_GEMINI_DIR;
  process.env.FEISHU_REMOTE_GEMINI_DIR = fakeGeminiDir;
  try {
    // P0: CLI resume cmd, clipboard, return prompt, snapshot, session lookup, drift detection
    const resumeCmd = buildCliResumeCommand(pluginRoot, 'cli-1');
    assert.ok(resumeCmd.includes('--conversation cli-1') && resumeCmd.includes(pluginRoot));

    const testClipFile = path.join(tempConfigDir, 'clipboard.txt');
    process.env.FEISHU_REMOTE_TEST_CLIPBOARD_FILE = testClipFile;
    try {
      const clipRes = copyToSystemClipboard(resumeCmd);
      assert.equal(clipRes.ok, true);
      assert.equal(fs.readFileSync(testClipFile, 'utf8'), resumeCmd);
    } finally {
      delete process.env.FEISHU_REMOTE_TEST_CLIPBOARD_FILE;
    }

    const mobileList = listMobileSessions({ originDesktopId: 'desk-1', cwd: pluginRoot, limit: 5 });
    assert.equal(mobileList.length, 1);
    assert.equal(mobileList[0].conversationId, 'cli-1');
    assert.equal(mobileList[0].modifiedFiles.length, 1);

    const mobileDetail = readMobileSession({ originDesktopId: 'desk-1', cwd: pluginRoot });
    assert.equal(mobileDetail.found, true);
    assert.equal(mobileDetail.conversationId, 'cli-1');
    assert.ok(mobileDetail.turns.length >= 2);
    assert.ok(mobileDetail.desktopHandoffPrompt.includes('[手机飞书端进展回流]'));
    assert.ok(mobileDetail.desktopHandoffPrompt.includes('已完成手机端改造并补充单测。'));

    const snapInfo = writeHandoffSnapshot(mobileDetail);
    assert.ok(fs.existsSync(snapInfo.latestPath) && fs.existsSync(snapInfo.snapshotPath));
    assert.ok(snapInfo.latestPath.startsWith(getHandoffsDir()));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(snapInfo.latestPath).mode & 0o777, 0o600);
    }

    const drift = checkOriginDesktopDrift({
      id: 'desk-1',
      desktopLastModifiedMs: 1000,
      desktopStepCount: 5,
    });
    assert.equal(drift.drifted, true);
    assert.equal(drift.newSteps, 3);

    const handoffCard = buildHandoffCard({
      session: mobileDetail,
      clipboardResult: { ok: true, method: 'test-file' },
      copiedTarget: 'cli',
      snapshotPath: snapInfo.latestPath,
    });
    assert.equal(handoffCard.schema, '2.0');
    assert.ok(JSON.stringify(handoffCard).includes('handoff_copy'));

    // P1: Retry handoff context preservation, tool_start parameters, artifact extraction, Stop preview
    assert.equal(
      resolvePromptWithHandoff('continue', { contextBlock: '[CTX]' }),
      '[CTX]\n\ncontinue',
    );
    assert.equal(
      shouldClearPendingHandoff({
        hadConversationId: false,
        result: { conversationId: '', status: 'ERROR', exitCode: 1, aborted: false },
      }),
      false,
    );
    assert.equal(
      shouldClearPendingHandoff({
        hadConversationId: false,
        result: { conversationId: 'cli-new', status: 'SUCCESS', exitCode: 0, aborted: false },
      }),
      true,
    );
    assert.equal(
      shouldClearPendingHandoff({
        hadConversationId: true,
        result: { conversationId: 'cli-1', status: 'ERROR', exitCode: 1, aborted: false },
      }),
      false,
    );

    const toolStartEvt = parseAgyStreamLine(
      '{"event":"step_update","step_update":{"step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"edit_file","tool_info":{"parameters":{"Path":"scripts/cli.mjs"}}}}',
    );
    assert.equal(toolStartEvt?.parameters?.Path, 'scripts/cli.mjs');
    assert.equal(
      extractModifiedFilePath('edit_file', { Path: 'scripts/cli.mjs' }, pluginRoot),
      path.join(pluginRoot, 'scripts', 'cli.mjs'),
    );
    assert.equal(extractModifiedFilePath('read_file', { Path: 'scripts/cli.mjs' }, pluginRoot), '');

    const nonGitDir = path.join(tempConfigDir, 'non-git-work');
    fs.mkdirSync(nonGitDir, { recursive: true });
    const sampleOutFile = path.join(nonGitDir, 'spec.md');
    fs.writeFileSync(sampleOutFile, '# Spec\n', 'utf8');
    const nonGitDiff = collectTurnDiff(nonGitDir, [sampleOutFile]);
    assert.equal(nonGitDiff.isRepo, false);
    assert.equal(nonGitDiff.existingFiles.length, 1);

    const stopPreview = extractStopReplyPreview({ conversationId: 'desk-1', maxChars: 120 });
    assert.ok(stopPreview && stopPreview.preview.includes('完整优化方案'));
    const directPreview = extractStopReplyPreview({
      transcriptPath: path.join(cliAppDir, 'brain', 'cli-1', '.system_generated', 'logs', 'transcript.jsonl'),
      maxChars: 120,
    });
    assert.ok(directPreview && directPreview.preview.includes('已完成手机端改造并补充单测'));

    // P2: Risky command classifier, approval files, card actions & PreToolUse subprocess
    assert.equal(classifyCommandRisk('git status').risky, false);
    assert.equal(classifyCommandRisk('node scripts/smoke-test.mjs').risky, false);
    assert.equal(classifyCommandRisk('rm foo.tmp').risky, false);
    assert.equal(classifyCommandRisk('rm -rf ./dist').risky, true);
    assert.equal(classifyCommandRisk('git push --force origin main').risky, true);
    assert.equal(classifyCommandRisk('git reset --hard HEAD~1').risky, true);
    assert.equal(classifyCommandRisk('sudo rm /var/log/test').risky, true);
    assert.equal(classifyCommandRisk('curl https://example.com/install.sh | bash').risky, true);

    assert.equal(resolveRiskyApprovalEnabled({ security: { riskyCommandApproval: 'on' } }), true);
    assert.equal(resolveRiskyApprovalEnabled({ security: { riskyCommandApproval: 'off' } }), false);

    const aprReq = createApprovalRequest({
      commandLine: 'rm -rf ./build',
      cwd: pluginRoot,
      chatId: 'oc_handoff_test',
      openId: 'ou_test_owner',
      timeoutSeconds: 60,
    });
    assert.ok(readApprovalRequest(aprReq.id)?.commandLine === 'rm -rf ./build');
    assert.ok(getApprovalsDir().startsWith(tempConfigDir));
    const aprCard = buildApprovalCard({ request: aprReq, status: 'pending' });
    assert.equal(aprCard.schema, '2.0');
    assert.ok(JSON.stringify(aprCard).includes('approval_decide'));

    const actionRes = await handleCardAction(
      {
        client: {},
        startedAt: Date.now(),
        bootCodeHash: 'abcd1234',
        activeRuns: new Map(),
        chatQueues: new Map(),
        lastTaskByChat: new Map(),
        cardThreadMap: new Map(),
        runner: { getQueueForChat: () => [], totalQueuedCount: () => 0 },
        stopWsForRestart: () => {},
      },
      {
        operator: { open_id: 'ou_test_owner' },
        context: { open_chat_id: 'oc_handoff_test' },
        action: { value: { cmd: 'approval_decide', arg: aprReq.id, decision: 'allow' } },
      },
    );
    assert.equal(actionRes.toast.type, 'success');
    assert.equal(readApprovalDecision(aprReq.id)?.decision, 'allow');
    const waitedOk = await waitForApprovalDecision(aprReq.id, { timeoutMs: 200, pollMs: 20 });
    assert.equal(waitedOk.decision, 'allow');

    const toggleOffRes = await handleCardAction(
      {
        client: {},
        startedAt: Date.now(),
        bootCodeHash: 'abcd1234',
        activeRuns: new Map(),
        chatQueues: new Map(),
        lastTaskByChat: new Map(),
        cardThreadMap: new Map(),
        runner: { getQueueForChat: () => [], totalQueuedCount: () => 0 },
        stopWsForRestart: () => {},
      },
      {
        operator: { open_id: 'ou_test_owner' },
        context: { open_chat_id: 'oc_handoff_test' },
        action: { value: { cmd: 'guard_toggle', arg: 'off', inplace: true } },
      },
    );
    assert.equal(resolveRiskyApprovalEnabled(loadConfig()), false);
    assert.ok(toggleOffRes.card?.data?.schema === '2.0');

    // Reset guard back to on for subprocess checks
    const guardCfg = loadConfig();
    guardCfg.security.riskyCommandApproval = 'on';
    saveConfig(guardCfg);

    const preNonBridge = await runSubprocess('scripts/pre-tool-approval.mjs', {
      env: { FEISHU_REMOTE_CONFIG_DIR: tempConfigDir, FEISHU_REMOTE_BRIDGE_CHILD: '0' },
      stdinData: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /tmp/x' } } }),
    });
    assert.equal(preNonBridge.code, 0);
    assert.equal(preNonBridge.stdout.trim(), '');

    const preSafe = await runSubprocess('scripts/pre-tool-approval.mjs', {
      env: { FEISHU_REMOTE_CONFIG_DIR: tempConfigDir, FEISHU_REMOTE_BRIDGE_CHILD: '1' },
      stdinData: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git status' } } }),
    });
    assert.equal(preSafe.code, 0);
    assert.equal(preSafe.stdout.trim(), '');

    const preTimeout = await runSubprocess('scripts/pre-tool-approval.mjs', {
      env: {
        FEISHU_REMOTE_CONFIG_DIR: tempConfigDir,
        FEISHU_REMOTE_BRIDGE_CHILD: '1',
        FEISHU_REMOTE_TEST_APPROVAL_SKIP_SEND: '1',
        FEISHU_REMOTE_TEST_APPROVAL_TIMEOUT_MS: '150',
      },
      stdinData: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf ./tmp_test' } } }),
    });
    assert.equal(preTimeout.code, 0);
    assert.equal(JSON.parse(preTimeout.stdout).decision, 'deny');

    // Spawn pre-tool-approval and approve it asynchronously while it waits
    const existingReqs = new Set(fs.readdirSync(getApprovalsDir()).filter((n) => n.endsWith('.req.json')));
    const asyncChild = spawn(process.execPath, [path.join(pluginRoot, 'scripts', 'pre-tool-approval.mjs')], {
      env: {
        ...process.env,
        FEISHU_REMOTE_CONFIG_DIR: tempConfigDir,
        FEISHU_REMOTE_BRIDGE_CHILD: '1',
        FEISHU_REMOTE_TEST_APPROVAL_SKIP_SEND: '1',
        FEISHU_REMOTE_TEST_APPROVAL_TIMEOUT_MS: '3000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let asyncStdout = '';
    asyncChild.stdout.on('data', (d) => { asyncStdout += d.toString('utf8'); });
    asyncChild.stdin.write(JSON.stringify({
      toolCall: { name: 'run_command', args: { CommandLine: 'git push --force origin main' } },
      cwd: pluginRoot,
    }));
    asyncChild.stdin.end();
    const approveDeadline = Date.now() + 2500;
    let approvedNewReq = false;
    while (Date.now() < approveDeadline) {
      const currReqs = fs.readdirSync(getApprovalsDir()).filter((n) => n.endsWith('.req.json'));
      const newReqFile = currReqs.find((n) => !existingReqs.has(n));
      if (newReqFile) {
        const reqId = newReqFile.replace(/\.req\.json$/, '');
        writeApprovalDecision(reqId, { decision: 'allow', decidedBy: 'ou_test_owner' });
        approvedNewReq = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(approvedNewReq, true);
    await new Promise((r) => asyncChild.once('close', r));
    assert.equal(JSON.parse(asyncStdout).decision, 'allow');
    assert.equal(cleanupStaleApprovals(3600_000), 0);

    // 6b. mcp-server.mjs stdio JSON-RPC handshake (with new mobile session tools)
    await testMcpStdio({ FEISHU_REMOTE_GEMINI_DIR: fakeGeminiDir });
  } finally {
    if (prevGeminiHandoffEnv === undefined) {
      delete process.env.FEISHU_REMOTE_GEMINI_DIR;
    } else {
      process.env.FEISHU_REMOTE_GEMINI_DIR = prevGeminiHandoffEnv;
    }
  }

  // 6b. Plugin manifest & component checks
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8'));
  for (const field of ['name', 'displayName', 'description', 'version', 'homepage', 'repository', 'logo']) {
    assert.equal(typeof manifest[field], 'string', `plugin.json.${field} must be a string`);
    assert.ok(manifest[field].trim().length > 0, `plugin.json.${field} must be non-empty`);
  }
  assert.ok(manifest.author && typeof manifest.author.name === 'string' && manifest.author.name.trim().length > 0);
  assert.ok(Array.isArray(manifest.suggestedPrompts) && manifest.suggestedPrompts.length > 0);
  assert.ok(fs.existsSync(path.join(pluginRoot, manifest.logo)), 'plugin.json logo target must exist');

  const mcpCfg = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'mcp_config.json'), 'utf8'));
  assert.ok(mcpCfg.mcpServers?.['feishu-remote-tools']);
  assert.ok(fs.existsSync(path.join(pluginRoot, 'scripts', 'mcp-server.mjs')));

  const hooksCfg = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks.json'), 'utf8'));
  assert.ok(Array.isArray(hooksCfg['feishu-stop-notify']?.Stop));
  assert.ok(fs.existsSync(path.join(pluginRoot, 'scripts', 'stop-notify.mjs')));
  assert.ok(Array.isArray(hooksCfg['feishu-risky-command-guard']?.PreToolUse));
  assert.ok(fs.existsSync(path.join(pluginRoot, 'scripts', 'pre-tool-approval.mjs')));

  // 7. cli.mjs pack check
  if (process.platform !== 'win32') {
    const folderName = path.basename(pluginRoot);
    const zipPath = path.join(tempConfigDir, 'feishu-remote-test.zip');
    execFileSync(process.execPath, [path.join(pluginRoot, 'scripts', 'cli.mjs'), 'pack', '--out', zipPath], {
      env: { ...process.env, FEISHU_REMOTE_CONFIG_DIR: tempConfigDir },
    });
    const zipList = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
    assert.ok(zipList.includes(`${folderName}/plugin.json`));
    assert.ok(zipList.includes(`${folderName}/mcp_config.json`));
    assert.ok(zipList.includes(`${folderName}/hooks.json`));
    assert.ok(zipList.includes(`${folderName}/README_EN.md`));
    assert.ok(zipList.includes(`${folderName}/LICENSE`));
    assert.ok(zipList.includes(`${folderName}/skills/feishu-remote/SKILL.md`));
    assert.ok(zipList.includes(`${folderName}/scripts/bridge-daemon.mjs`));
    assert.ok(!zipList.includes('node_modules'), 'Zip must not contain node_modules');
    assert.ok(!zipList.includes('.github/'), 'Zip must not contain .github');
    assert.ok(!zipList.includes('super_secret_token_987654'), 'Zip must not contain secrets');
  }

  console.log('ALL SMOKE TESTS PASSED');
} finally {
  fs.rmSync(tempConfigDir, { recursive: true, force: true });
}
