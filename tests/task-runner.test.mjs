import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  createBridgeContext,
  createFakeAgyBin,
  createMockFeishuClient,
  createTestEnv,
  seedDefaultTestConfig,
  seedFakeGeminiStores,
} from './helpers.mjs';

const env = createTestEnv('feishu-task-runner-');
let config;
let fakeAgyPath;
let scenarioFile;
let invocationLogFile;

const { loadState, saveState } = await import('../scripts/lib/config.mjs');
const { createTaskRunner, inspectTranscriptLastTurnError } = await import('../scripts/lib/task-runner.mjs');
const { handleCardAction } = await import('../scripts/lib/card-actions.mjs');

function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for condition`));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('task-runner state machine regressions', () => {
  before(() => {
    scenarioFile = path.join(env.root, 'agy-scenario.json');
    invocationLogFile = path.join(env.root, 'agy-invocations.jsonl');

    const fakeAgyScript = `
import fs from 'node:fs';

const scenarioPath = ${JSON.stringify(scenarioFile)};
const logPath = ${JSON.stringify(invocationLogFile)};
const args = process.argv.slice(2);

if (args[0] === 'models') {
  console.log('gemini-4-neon-high\\tGemini 4 Neon (High)');
  process.exit(0);
}

let prompt = '';
const pIdx = args.indexOf('-p');
if (pIdx >= 0) {
  prompt = args[pIdx + 1] || '';
} else if (args.includes('--input-format') && args.includes('stream-json')) {
  const rawIn = fs.readFileSync(0, 'utf8').trim().split(/\\r?\\n/).filter(Boolean).pop() || '';
  try {
    const parsedIn = JSON.parse(rawIn);
    prompt = parsedIn?.message?.content || '';
  } catch {
    prompt = rawIn;
  }
}
const hasEffort = args.includes('--effort');
const convIdx = args.indexOf('--conversation');
const convArg = convIdx >= 0 ? args[convIdx + 1] : '';

fs.appendFileSync(logPath, JSON.stringify({
  args,
  prompt,
  hasEffort,
  convArg,
  env: {
    FEISHU_REMOTE_BRIDGE_CHILD: process.env.FEISHU_REMOTE_BRIDGE_CHILD,
    FEISHU_REMOTE_CHAT_ID: process.env.FEISHU_REMOTE_CHAT_ID,
    FEISHU_REMOTE_OPEN_ID: process.env.FEISHU_REMOTE_OPEN_ID,
    FEISHU_REMOTE_SESSION_KEY: process.env.FEISHU_REMOTE_SESSION_KEY,
    FEISHU_REMOTE_MODE: process.env.FEISHU_REMOTE_MODE,
  },
}) + '\\n');

const queue = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const step = queue.shift() || { type: 'success', conversationId: 'cli-default', response: 'ok' };
fs.writeFileSync(scenarioPath, JSON.stringify(queue, null, 2));

if (step.type === 'error') {
  if (step.conversationId) {
    console.log(JSON.stringify({ event: 'init', conversation_id: step.conversationId, init: { cwd: process.cwd() } }));
  }
  if (step.stderr) console.error(step.stderr);
  process.exit(step.exitCode || 1);
}

const cid = step.conversationId || convArg || 'cli-default';
console.log(JSON.stringify({ event: 'init', conversation_id: cid, init: { cwd: process.cwd(), permission_mode: 'accept-edits' } }));
if (step.editFile) {
  console.log(JSON.stringify({
    event: 'step_update',
    step_update: {
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'edit_file',
      tool_info: { parameters: { Path: step.editFile } },
    },
  }));
  console.log(JSON.stringify({
    event: 'step_update',
    step_update: {
      step_index: 1,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'edit_file',
      duration_seconds: 0.2,
    },
  }));
}
if (step.toolError) {
  console.log(JSON.stringify({
    event: 'step_update',
    step_update: {
      step_index: 2,
      state: step.toolError.state || 'ERROR',
      step_type: 'tool',
      tool_name: step.toolError.toolName || 'run_command',
      tool_info: { parameters: step.toolError.parameters || {} },
      error: step.toolError.error || 'tool execution error',
    },
  }));
}
const finalResp = step.response !== undefined ? step.response : 'ok';
if (finalResp) {
  console.log(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: finalResp },
  }));
}
console.log(JSON.stringify({
  event: 'result',
  result: {
    conversation_id: cid,
    status: step.status || 'SUCCESS',
    response: finalResp,
    finished_reason: step.finishedReason || '',
    error: step.resultError || '',
    duration_seconds: 0.5,
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  },
}));
if (typeof step.exitCode === 'number') {
  process.exit(step.exitCode);
}
`;

    fakeAgyPath = createFakeAgyBin(env.root, fakeAgyScript);
    config = seedDefaultTestConfig(env.workDir, {
      agy: { bin: fakeAgyPath, defaultCwd: env.workDir },
    });
  });

  after(() => {
    env.cleanup();
  });

  it('preserves pendingHandoff on first-turn failure, restores it on retry, injects bridge env, and records artifacts', async () => {
    const specFile = path.join(env.workDir, 'spec.md');
    fs.writeFileSync(specFile, '# Sample Spec\n', 'utf8');

    saveState({
      chats: {
        oc_retry_1: {
          conversationId: '',
          cwd: env.workDir,
          mode: 'accept-edits',
          model: '',
          effort: '',
          recentConversations: [],
          pendingHandoff: {
            id: 'desk-1',
            title: 'Spec Review',
            source: 'desktop',
            cwd: env.workDir,
            contextBlock: '[电脑端对话上下文接管]\n原上下文内容：待补完示例章节',
            createdAt: Date.now(),
          },
          originDesktopSession: {
            id: 'desk-1',
            title: 'Spec Review',
            source: 'desktop',
            workspace: env.workDir,
            takenOverAt: Date.now(),
            desktopLastModifiedMs: 1000,
            desktopStepCount: 5,
          },
          lastTurnArtifacts: null,
          fullExpiresAt: 0,
          fullRevertMode: 'accept-edits',
          lastActiveAt: Date.now(),
        },
      },
      lastP2pChatByOpenId: { ou_test_owner: 'oc_retry_1' },
    });

    fs.writeFileSync(scenarioFile, JSON.stringify([
      { type: 'error', stderr: 'network timeout', exitCode: 1 },
      { type: 'success', conversationId: 'cli-recovered-1', editFile: 'spec.md', response: '已更新 spec.md' },
    ]));
    fs.writeFileSync(invocationLogFile, '', 'utf8');

    const { client, calls } = createMockFeishuClient();
    const activeRuns = new Map();
    const chatQueues = new Map();
    const lastTaskByChat = new Map();
    const runner = createTaskRunner({ client, activeRuns, chatQueues, lastTaskByChat });
    const ctx = createBridgeContext({ client, runner, activeRuns, chatQueues, lastTaskByChat });

    await runner.executePrompt({
      text: '继续完善文档',
      chatId: 'oc_retry_1',
      openId: 'ou_test_owner',
      messageId: 'om_user_1',
      config,
    });

    assert.equal(calls.cardkitUpdates.length, 1);
    const errCardJson = JSON.stringify(calls.cardkitUpdates[0].card);
    assert.ok(errCardJson.includes('❌ 执行异常'));
    assert.ok(errCardJson.includes('"cmd":"retry"'));

    // Crucial regression: pendingHandoff MUST still exist after failure without conversationId
    const stateAfterFail = loadState();
    assert.ok(stateAfterFail.chats.oc_retry_1.pendingHandoff, 'pendingHandoff must survive first-turn failure');
    assert.equal(stateAfterFail.chats.oc_retry_1.conversationId, '');

    // Trigger retry card action
    const retryToast = await handleCardAction(ctx, {
      operator: { open_id: 'ou_test_owner' },
      context: { open_chat_id: 'oc_retry_1' },
      action: { value: { cmd: 'retry' } },
    });
    assert.equal(retryToast.toast.type, 'success');

    await waitUntil(() => !activeRuns.has('oc_retry_1') && calls.cardkitUpdates.length >= 2);

    const logs = fs.readFileSync(invocationLogFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(logs.length, 2);
    assert.ok(logs[1].prompt.includes('[电脑端对话上下文接管]'), 'Retried prompt must retain handoff context');
    assert.ok(logs[1].prompt.includes('继续完善文档'));
    assert.equal(logs[1].env.FEISHU_REMOTE_BRIDGE_CHILD, '1');
    assert.equal(logs[1].env.FEISHU_REMOTE_CHAT_ID, 'oc_retry_1');
    assert.equal(logs[1].env.FEISHU_REMOTE_OPEN_ID, 'ou_test_owner');
    assert.equal(logs[1].env.FEISHU_REMOTE_MODE, 'accept-edits');

    const stateAfterOk = loadState();
    assert.equal(stateAfterOk.chats.oc_retry_1.pendingHandoff, null);
    assert.equal(stateAfterOk.chats.oc_retry_1.conversationId, 'cli-recovered-1');
    assert.equal(stateAfterOk.chats.oc_retry_1.recentConversations[0].originDesktopId, 'desk-1');
    assert.deepEqual(stateAfterOk.chats.oc_retry_1.lastTurnArtifacts.files, [specFile]);

    const okCardJson = JSON.stringify(calls.cardkitUpdates[1].card);
    assert.ok(okCardJson.includes('"cmd":"turn_diff"'));
    assert.ok(okCardJson.includes('"cmd":"turn_send_file"'));
    assert.ok(okCardJson.includes('"cmd":"handoff"'));
    assert.equal(calls.reactionsAdded.length, 0, 'Retry runs have no user messageId to react to');
  });

  it('detects origin desktop drift on completion and surfaces sync button', async () => {
    seedFakeGeminiStores(env.geminiDir, {
      desktopRows: [
        {
          id: 'desk-drift',
          title: '桌面端同步会话',
          preview: '新增3步',
          stepCount: 8,
          modified: new Date(Date.now() + 10_000).toISOString(),
          workspaces: JSON.stringify([`file://${env.workDir}`]),
          status: 'CASCADE_RUN_STATUS_IDLE',
          depth: 0,
        },
      ],
    });

    saveState({
      chats: {
        oc_drift: {
          conversationId: 'cli-drift-1',
          cwd: env.workDir,
          mode: 'accept-edits',
          model: '',
          effort: '',
          recentConversations: [],
          pendingHandoff: null,
          originDesktopSession: {
            id: 'desk-drift',
            title: '桌面端同步会话',
            source: 'desktop',
            workspace: env.workDir,
            takenOverAt: Date.now() - 60_000,
            desktopLastModifiedMs: 1000,
            desktopStepCount: 5,
          },
          lastTurnArtifacts: null,
          fullExpiresAt: 0,
          fullRevertMode: 'accept-edits',
          lastActiveAt: Date.now(),
        },
      },
      lastP2pChatByOpenId: {},
    });

    fs.writeFileSync(scenarioFile, JSON.stringify([
      { type: 'success', conversationId: 'cli-drift-1', response: '手机端已完成' },
    ]));

    const { client, calls } = createMockFeishuClient();
    const runner = createTaskRunner({
      client,
      activeRuns: new Map(),
      chatQueues: new Map(),
      lastTaskByChat: new Map(),
    });

    await runner.executePrompt({
      text: '检查状态',
      chatId: 'oc_drift',
      openId: 'ou_test_owner',
      messageId: 'om_drift_1',
      config,
    });

    const finalCardJson = JSON.stringify(calls.cardkitUpdates[0].card);
    assert.ok(finalCardJson.includes('检测到原电脑端对话在你接管后有新进展（+3 步）'));
    assert.ok(finalCardJson.includes('"cmd":"desktop_sync_latest"'));
    assert.ok(calls.reactionsAdded.some((r) => r.emoji === 'DONE'));
  });

  it('auto-falls back when effort is unsupported and auto-retries transient startup race', async () => {
    saveState({
      chats: {
        oc_fallback: {
          conversationId: '',
          cwd: env.workDir,
          mode: 'accept-edits',
          model: '',
          effort: 'xhigh',
          recentConversations: [],
          pendingHandoff: null,
          originDesktopSession: null,
          lastTurnArtifacts: null,
          fullExpiresAt: 0,
          fullRevertMode: 'accept-edits',
          lastActiveAt: Date.now(),
        },
      },
      lastP2pChatByOpenId: {},
    });

    fs.writeFileSync(scenarioFile, JSON.stringify([
      { type: 'error', stderr: '--effort is not supported for this model', exitCode: 1 },
      { type: 'error', stderr: 'failed to start conversation: backend returned an empty conversation id', exitCode: 1 },
      { type: 'success', conversationId: 'cli-ok-2', response: '回退重试后成功' },
    ]));
    fs.writeFileSync(invocationLogFile, '', 'utf8');

    const { client, calls } = createMockFeishuClient();
    const runner = createTaskRunner({
      client,
      activeRuns: new Map(),
      chatQueues: new Map(),
      lastTaskByChat: new Map(),
    });

    await runner.executePrompt({
      text: '测试回退',
      chatId: 'oc_fallback',
      openId: 'ou_test_owner',
      messageId: 'om_fb_1',
      config,
    });

    const logs = fs.readFileSync(invocationLogFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(logs.length, 3);
    assert.equal(logs[0].hasEffort, true);
    assert.equal(logs[1].hasEffort, false);
    assert.equal(logs[2].hasEffort, false);

    const finalCardJson = JSON.stringify(calls.cardkitUpdates[0].card);
    assert.ok(finalCardJson.includes('回退重试后成功'));
    assert.ok(finalCardJson.includes('强度 default(不支持已自动回退)'));
  });

  it('queues up to 5 concurrent requests per chat and warns on the 6th', async () => {
    const { client, calls } = createMockFeishuClient();
    const activeRuns = new Map([
      ['oc_queue', { controller: new AbortController(), promptPreview: 'active', startedAt: Date.now() }],
    ]);
    const chatQueues = new Map();
    const runner = createTaskRunner({
      client,
      activeRuns,
      chatQueues,
      lastTaskByChat: new Map(),
    });

    for (let i = 1; i <= 5; i += 1) {
      await runner.enqueueOrExecutePrompt({
        text: `task ${i}`,
        chatId: 'oc_queue',
        openId: 'ou_test_owner',
        messageId: `om_q_${i}`,
        config,
      });
    }
    assert.equal(runner.getQueueForChat('oc_queue').length, 5);
    assert.equal(calls.repliedCards.length, 5);

    await runner.enqueueOrExecutePrompt({
      text: 'task 6 overflow',
      chatId: 'oc_queue',
      openId: 'ou_test_owner',
      messageId: 'om_q_6',
      config,
    });
    assert.equal(runner.getQueueForChat('oc_queue').length, 5);
    assert.equal(calls.repliedCards.length, 6);
    assert.ok(JSON.stringify(calls.repliedCards[5].card).includes('任务队列已满（最多 5 条）'));
  });

  it('diagnoses permission-denied empty reply from transcript, flags non-SUCCESS exitCode=0 failures, and ignores recovered earlier errors', async () => {
    // 1. Simulate real accept-edits interruption: file modified, empty response, exitCode=0, trailing permission error in transcript.jsonl
    const permConvId = 'conv-perm-denied-1';
    const permTranscriptDir = path.join(env.geminiDir, 'antigravity-cli', 'brain', permConvId, '.system_generated', 'logs');
    fs.mkdirSync(permTranscriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(permTranscriptDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-28T15:05:19Z' }),
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm run typecheck && npm run build' } }],
        }),
        JSON.stringify({
          step_index: 3,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'ERROR',
          error: 'permission check failed for unsandboxed "npm run typecheck && npm run build": user denied permission to run command',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const editedPath = path.join(env.workDir, 'src', 'xLongform.ts');
    saveState({
      chats: {
        oc_perm_blocked: {
          conversationId: permConvId,
          cwd: env.workDir,
          mode: 'accept-edits',
          model: '',
          effort: '',
          recentConversations: [],
          pendingHandoff: null,
          originDesktopSession: null,
          lastTurnArtifacts: null,
          fullExpiresAt: 0,
          fullRevertMode: 'auto',
          lastActiveAt: Date.now(),
        },
      },
      lastP2pChatByOpenId: {},
    });

    fs.writeFileSync(scenarioFile, JSON.stringify([
      { type: 'success', conversationId: permConvId, editFile: editedPath, response: '', exitCode: 0 },
      { type: 'success', conversationId: 'conv-err-status-0', status: 'ERROR', resultError: 'backend aborted', response: '', exitCode: 0 },
    ]));

    const { client, calls } = createMockFeishuClient();
    const runner = createTaskRunner({
      client,
      activeRuns: new Map(),
      chatQueues: new Map(),
      lastTaskByChat: new Map(),
    });

    await runner.executePrompt({
      text: '实现 X 长文并跑测试',
      chatId: 'oc_perm_blocked',
      openId: 'ou_test_owner',
      messageId: 'om_perm_1',
      config,
    });

    const permCard = calls.cardkitUpdates[0].card;
    const permCardJson = JSON.stringify(permCard);
    assert.equal(permCard.header.template, 'orange');
    assert.ok(permCard.header.title.content.includes('权限检查处中断'));
    assert.ok(!permCardJson.includes('本次执行没有输出文本回复'));
    assert.ok(permCardJson.includes('npm run typecheck && npm run build'));
    assert.ok(permCardJson.includes('已完成 **1 个文件** 的修改'));
    assert.ok(permCardJson.includes('"cmd":"mode","arg":"auto"'));
    assert.ok(permCardJson.includes('"cmd":"mode_temp_full"'));
    assert.ok(permCardJson.includes('"cmd":"retry"'));

    // 2. Non-SUCCESS result.status with exitCode=0 must be flagged as failed (red card), never green
    saveState({
      chats: {
        oc_status_fail: {
          conversationId: '',
          cwd: env.workDir,
          mode: 'auto',
          model: '',
          effort: '',
          recentConversations: [],
          pendingHandoff: null,
          originDesktopSession: null,
          lastTurnArtifacts: null,
          fullExpiresAt: 0,
          fullRevertMode: 'auto',
          lastActiveAt: Date.now(),
        },
      },
      lastP2pChatByOpenId: {},
    });

    await runner.executePrompt({
      text: '触发 status=ERROR 但 exitCode=0',
      chatId: 'oc_status_fail',
      openId: 'ou_test_owner',
      messageId: 'om_status_0',
      config,
    });

    const errCard = calls.cardkitUpdates[1].card;
    const errCardJson = JSON.stringify(errCard);
    assert.equal(errCard.header.template, 'red');
    assert.ok(errCard.header.title.content.includes('执行异常'));
    assert.ok(errCardJson.includes('backend aborted'));
    assert.ok(errCardJson.includes('"cmd":"retry"'));

    // 3. Earlier recovered ERROR step followed by a newer PLANNER_RESPONSE must NOT be surfaced by inspectTranscriptLastTurnError
    const recoveredConvId = 'conv-recovered-err-1';
    const recDir = path.join(env.geminiDir, 'antigravity-cli', 'brain', recoveredConvId, '.system_generated', 'logs');
    fs.mkdirSync(recDir, { recursive: true });
    fs.writeFileSync(
      path.join(recDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE' }),
        JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file' }] }),
        JSON.stringify({ step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'ERROR', error: 'file does not exist' }),
        JSON.stringify({ step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }),
      ].join('\n') + '\n',
      'utf8',
    );
    assert.equal(inspectTranscriptLastTurnError(recoveredConvId), null);
  });
});
