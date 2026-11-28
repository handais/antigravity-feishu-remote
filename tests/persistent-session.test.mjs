import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import {
  createBridgeContext,
  createFakeAgyBin,
  createMockFeishuClient,
  createTestEnv,
  seedDefaultTestConfig,
} from './helpers.mjs';

const env = createTestEnv('feishu-persist-');

const { loadConfig, loadState, saveConfig, saveState } = await import('../scripts/lib/config.mjs');
const { createTaskRunner, formatToolStatusMarkdown } = await import('../scripts/lib/task-runner.mjs');
const { handleCardAction } = await import('../scripts/lib/card-actions.mjs');
const {
  buildSwarmBoardCard,
  detectTurnCommandBoard,
  hasAsyncSessionActivity,
  inspectCommandBoardTelemetry,
  queryChildConversationsFromDb,
} = await import('../scripts/lib/command-boards.mjs');

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

describe('persistent open-stdin session pool, duration fix & multi-hop subagent discovery', () => {
  let activeRunner = null;

  before(() => {
    seedDefaultTestConfig(env.workDir);
    const st = loadState();
    st.lastP2pChatByOpenId.ou_test_owner = 'oc_persist_p2p';
    st.chats.oc_persist_p2p = {
      conversationId: '',
      cwd: env.workDir,
      mode: 'accept-edits',
      recentConversations: [],
    };
    saveState(st);
  });

  after(() => {
    activeRunner?.sessionPool?.disposeAll?.();
    env.cleanup();
  });

  it('uses actual wall-clock turn duration instead of cumulative agy duration_seconds', async () => {
    const fakeScript = `
import fs from 'node:fs';
if (process.argv.includes('models')) {
  console.log('gemini-4-neon-high\\tGemini 4 Neon (High)');
  process.exit(0);
}
fs.readFileSync(0, 'utf8');
console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-dur-1', init: { cwd: process.cwd(), permission_mode: 'accept-edits' } }));
console.log(JSON.stringify({ event: 'message', role: 'assistant', content: 'Quick reply', delta: true }));
console.log(JSON.stringify({
  event: 'result',
  result: {
    conversation_id: 'conv-dur-1',
    status: 'SUCCESS',
    response: 'Quick reply',
    duration_seconds: 32868.3,
    usage: { total_tokens: 100 }
  }
}));
`;
    const fakeBin = createFakeAgyBin(env.root, fakeScript);
    const cfg = loadConfig();
    cfg.agy.bin = fakeBin;
    saveConfig(cfg);

    const { client, calls } = createMockFeishuClient();
    const activeRuns = new Map();
    const chatQueues = new Map();
    const lastTaskByChat = new Map();
    const runner = createTaskRunner({ client, activeRuns, chatQueues, lastTaskByChat });
    activeRunner = runner;

    await runner.enqueueOrExecutePrompt({
      text: '你好',
      displayPreview: '你好',
      chatId: 'oc_persist_p2p',
      openId: 'ou_test_owner',
      messageId: 'om_dur_1',
      sessionKey: 'oc_persist_p2p',
      config: loadConfig(),
    });

    await waitUntil(() => calls.cardkitUpdates.length > 0 && activeRuns.size === 0);
    const finalJson = JSON.stringify(calls.cardkitUpdates.at(-1).card);
    assert.ok(!finalJson.includes('32868.3'), `Expected wall-clock duration, got cumulative: ${finalJson}`);
    const durMatch = finalJson.match(/耗时 (\d+\.\d+)s/);
    assert.ok(durMatch && Number(durMatch[1]) < 10, `Expected elapsed < 10s, got ${durMatch?.[0]}`);
  });

  it('keeps stdin open for /teamwork & subagent sessions, streams async wakeups, reuses same PID, and supports stop_keepalive', async () => {
    const pidLog = path.join(env.root, 'persist-pids.log');
    const fakeScript = `
import fs from 'node:fs';
import readline from 'node:readline';

const pidLog = ${JSON.stringify(pidLog)};
if (process.argv.includes('models')) {
  console.log('gemini-4-neon-high\\tGemini 4 Neon (High)');
  process.exit(0);
}

console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-team-live', init: { cwd: process.cwd(), permission_mode: 'full' } }));

let turn = 0;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  turn += 1;
  fs.appendFileSync(pidLog, String(process.pid) + '\\n');
  if (turn === 1) {
    console.log(JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'send_message', tool_info: { parameters: { Recipient: 'interviewer' } } }
    }));
    console.log(JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'send_message', duration_seconds: 0.2 }
    }));
    console.log(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'conv-team-live',
        status: 'SUCCESS',
        response: '已转发给 Task Interviewer 并唤醒它继续整理。',
        duration_seconds: 32868.3,
        usage: { total_tokens: 500 }
      }
    }));
    setTimeout(() => {
      console.log(JSON.stringify({
        event: 'step_update',
        step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'update_steps', tool_info: { parameters: { steps: '[]' } } }
      }));
      console.log(JSON.stringify({
        event: 'step_update',
        step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'update_steps', duration_seconds: 0.1 }
      }));
      console.log(JSON.stringify({
        event: 'step_update',
        step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Task Interviewer 草稿已就绪，请确认。' }
      }));
      console.log(JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-team-live',
          status: 'SUCCESS',
          response: 'Task Interviewer 草稿已就绪，请确认。',
          duration_seconds: 1.5,
          usage: { total_tokens: 300 }
        }
      }));
    }, 180);
  } else {
    console.log(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'conv-team-live',
        status: 'SUCCESS',
        response: '收到确认，团队正式开始执行。',
        duration_seconds: 0.4,
        usage: { total_tokens: 200 }
      }
    }));
  }
});
rl.on('close', () => {
  process.exit(0);
});
`;
    const fakeBin = createFakeAgyBin(env.root, fakeScript);
    const cfg = loadConfig();
    cfg.agy.bin = fakeBin;
    saveConfig(cfg);

    const st = loadState();
    st.chats.oc_persist_p2p = {
      conversationId: '',
      cwd: env.workDir,
      mode: 'accept-edits',
      recentConversations: [],
    };
    saveState(st);

    const { client, calls } = createMockFeishuClient();
    const activeRuns = new Map();
    const chatQueues = new Map();
    const lastTaskByChat = new Map();
    const runner = createTaskRunner({ client, activeRuns, chatQueues, lastTaskByChat });
    activeRunner = runner;

    // 1. Turn 1: /teamwork triggers persistent session + waiting card + keep-alive status
    await runner.enqueueOrExecutePrompt({
      text: '/teamwork 审查健康助手',
      displayPreview: '/teamwork 审查健康助手',
      chatId: 'oc_persist_p2p',
      openId: 'ou_test_owner',
      messageId: 'om_team_1',
      sessionKey: 'oc_persist_p2p',
      config: loadConfig(),
    });

    await waitUntil(() => calls.cardkitUpdates.length >= 1 && activeRuns.size === 0);
    assert.equal(runner.hasPersistentSession('oc_persist_p2p'), true);
    assert.equal(loadState().chats.oc_persist_p2p.persistentSession, true);

    const turn1InitialCard = calls.cardkitCreates[0].card;
    const turn1InitialJson = JSON.stringify(turn1InitialCard);
    assert.ok(turn1InitialJson.includes('🛑 立即中止'));
    assert.ok(turn1InitialJson.includes('🐝 看团队进度'));
    const swarmProgBtn = turn1InitialCard.body.elements
      .filter((el) => el.tag === 'column_set')
      .flatMap((el) => el.columns.flatMap((c) => c.elements))
      .find((b) => b.text?.content === '🐝 看团队进度');
    assert.ok(swarmProgBtn && swarmProgBtn.behaviors?.[0]?.value?.inplace === undefined);

    const turn1Card = calls.cardkitUpdates[0].card;
    const turn1Json = JSON.stringify(turn1Card);
    assert.ok(turn1Card.header.title.content.includes('已派发后台协作（保活等待中）'));
    assert.ok(turn1Json.includes('🟢 后台保活中'));
    assert.ok(turn1Json.includes('🐝 Swarm 看板'));
    assert.ok(turn1Json.includes('🔌 释放保活'));
    assert.ok(!turn1Json.includes('32868.3'));

    // Turn 1 dispatched background work: Typing reaction is stamped on user message, NOT DONE yet
    assert.ok(calls.reactionsAdded.some((r) => r.messageId === 'om_team_1' && r.emoji === 'Typing'));
    assert.equal(calls.reactionsAdded.some((r) => r.messageId === 'om_team_1' && r.emoji === 'DONE'), false);

    // 0-token Swarm board check must not interfere with pending reaction metadata
    const ctxBoard = createBridgeContext({ client, runner });
    const boardCheck = await handleCardAction(ctxBoard, {
      operator: { open_id: 'ou_test_owner' },
      action: { value: { cmd: 'cmd_board', board: 'swarm', inplace: true } },
      context: { open_message_id: 'om_board_swarm_chk', open_chat_id: 'oc_persist_p2p' },
    });
    assert.equal(boardCheck.toast.type, 'info');

    // 2. Unsolicited async wakeup arrives automatically, streams a second Feishu card, and flips Typing -> DONE on om_team_1
    await waitUntil(() => (
      calls.cardkitUpdates.length >= 2 &&
      calls.reactionsAdded.some((r) => r.messageId === 'om_team_1' && r.emoji === 'DONE')
    ));
    const asyncCard = calls.cardkitUpdates[1].card;
    assert.ok(asyncCard.header.title.content.includes('后台协作新进展（已完成）'));
    assert.ok(JSON.stringify(asyncCard).includes('Task Interviewer 草稿已就绪'));
    assert.ok(calls.reactionsRemoved.some((r) => r.messageId === 'om_team_1'));
    assert.ok(calls.reactionsAdded.some((r) => r.messageId === 'om_team_1' && r.emoji === 'DONE'));

    // 3. Turn 2 reuses the exact same parked PID
    await runner.enqueueOrExecutePrompt({
      text: '确认执行',
      displayPreview: '确认执行',
      chatId: 'oc_persist_p2p',
      openId: 'ou_test_owner',
      messageId: 'om_team_2',
      sessionKey: 'oc_persist_p2p',
      config: loadConfig(),
    });
    await waitUntil(() => calls.cardkitUpdates.length >= 3 && activeRuns.size === 0);
    const pids = fs.readFileSync(pidLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    assert.equal(pids.length, 2);
    assert.equal(pids[0], pids[1], 'Turn 2 must reuse the exact same persistent agy PID');

    // 4. stop_keepalive card action releases the parked process and updates Swarm board
    const ctx = createBridgeContext({ client, runner });
    const stopRes = await handleCardAction(ctx, {
      operator: { open_id: 'ou_test_owner' },
      action: { value: { cmd: 'stop_keepalive', board: 'swarm', inplace: true } },
      context: { open_message_id: 'om_board_swarm', open_chat_id: 'oc_persist_p2p' },
    });
    assert.equal(stopRes.toast.type, 'info');
    assert.ok(stopRes.toast.content.includes('已释放后台保活进程'));
    assert.equal(runner.hasPersistentSession('oc_persist_p2p'), false);
    assert.equal(loadState().chats.oc_persist_p2p.persistentSession, false);
    assert.ok(JSON.stringify(stopRes.card?.data).includes('当前未保活'));
  });

  it('discovers multi-hop grandchild subagents via BFS and detects send_message as swarm board activity', () => {
    assert.deepEqual(detectTurnCommandBoard('1a 2c', ['send_message']), { kind: 'swarm' });
    assert.deepEqual(detectTurnCommandBoard('ok', ['manage_subagents']), { kind: 'swarm' });

    const cliRoot = path.join(env.geminiDir, 'antigravity-cli');
    fs.mkdirSync(cliRoot, { recursive: true });
    const dbPath = path.join(cliRoot, 'conversation_summaries.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time TEXT NOT NULL DEFAULT '',
        workspace_uris TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT '',
        agent_name TEXT NOT NULL DEFAULT '',
        parent_conversation_id TEXT NOT NULL DEFAULT '',
        killed INTEGER NOT NULL DEFAULT 0,
        not_fully_idle INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS conversation_parents (
        conversation_id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL
      );
    `);
    const nowIso = new Date().toISOString();
    const insert = db.prepare(`
      INSERT OR REPLACE INTO conversation_summaries
      (conversation_id, title, preview, step_count, last_modified_time, status, agent_name, parent_conversation_id, killed, not_fully_idle)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('root-892e', 'Teamwork Root', 'root', 10, nowIso, 'IDLE', '', '', 0, 0);
    insert.run('coord-8e52', 'Teamwork Coordinator', 'sentinel', 5, nowIso, 'RUNNING', 'teamwork_coordinator', 'root-892e', 0, 1);
    insert.run('interviewer-e898', 'Task Interviewer', 'waiting user answers', 9, nowIso, 'RUNNING', 'teamwork_interviewer', 'coord-8e52', 0, 1);
    insert.run('exp-4cd6f872', 'Explorer A', 'inspecting scripts', 65, nowIso, 'CASCADE_RUN_STATUS_IDLE', 'teamwork_explorer', 'coord-8e52', 0, 0);
    insert.run('exp-746bae96', 'Explorer B', 'inspecting tests', 67, nowIso, 'CASCADE_RUN_STATUS_IDLE', 'teamwork_explorer', 'coord-8e52', 0, 0);
    db.close();

    const children = queryChildConversationsFromDb('root-892e', { maxDepth: 3 });
    assert.equal(children.length, 4);
    assert.ok(children.some((c) => c.id === 'coord-8e52' && c.depth === 1));
    assert.ok(children.some((c) => c.id === 'interviewer-e898' && c.depth === 2 && c.notFullyIdle));
    assert.equal(hasAsyncSessionActivity('root-892e'), true);

    const telemetry = inspectCommandBoardTelemetry('root-892e');
    const explorers = telemetry.swarm.workers.filter((w) => w.name === 'teamwork_explorer');
    assert.equal(explorers.length, 2, 'Both duplicate-named explorers must be preserved');
    assert.ok(explorers.every((w) => w.status === 'working'), 'Recently active explorers should show working');

    const boardCard = buildSwarmBoardCard({
      chatState: { conversationId: 'root-892e', mode: 'full' },
      config: loadConfig(),
      isRunning: true,
      keepAliveActive: true,
      telemetry,
    });
    const boardJson = JSON.stringify(boardCard);
    assert.ok(boardJson.includes('exp-4cd6'));
    assert.ok(boardJson.includes('exp-746b'));
    assert.ok(/\b\d{2}:\d{2}\b/.test(boardJson));

    const statusMd = formatToolStatusMarkdown({
      cwd: env.workDir,
      mode: 'full',
      toolEntries: [
        { toolName: 'send_message', summary: 'Message=Approved\n`prompt`:\nhello', done: true, durationSeconds: 1.8 },
      ],
    });
    assert.ok(statusMd.includes("`Message=Approved 'prompt': hello`"));
  });

  it('guards active asyncTurn from runTurn reuse/eviction, rejects blank conversationId reuse on bound sessions, and enforces per-turn timeout', async () => {
    const { createAgySessionPool } = await import('../scripts/lib/agy-session-pool.mjs');
    const pidLog = path.join(env.workDir, 'async-collision-pids.log');
    const agyBin = createFakeAgyBin(env.root, `
import fs from 'node:fs';
import readline from 'node:readline';
const pidFile = ${JSON.stringify(pidLog)};
fs.appendFileSync(pidFile, String(process.pid) + '\\n');
const args = process.argv.slice(2);
const convIdx = args.indexOf('--conversation');
let convId = convIdx !== -1 ? args[convIdx + 1] : '';
if (args.includes('--input-format')) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const parsed = JSON.parse(line);
    const prompt = parsed.message?.content || '';
    if (!convId) convId = 'conv-bound-' + process.pid;
    if (prompt.includes('emit_async')) {
      console.log(JSON.stringify({ event: 'init', conversation_id: convId }));
      console.log(JSON.stringify({ event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: 'started', duration_seconds: 0.1 } }));
      setTimeout(() => {
        console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: 2, text_delta: 'async stream chunk' } }));
      }, 40);
      setTimeout(() => {
        console.log(JSON.stringify({ event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: 'async finished', duration_seconds: 0.3 } }));
      }, 320);
    } else if (prompt.includes('hang_turn')) {
      console.log(JSON.stringify({ event: 'init', conversation_id: convId }));
    } else {
      console.log(JSON.stringify({ event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: 'fresh turn ok', duration_seconds: 0.1 } }));
    }
  });
}
`);
    {
      const cfg = loadConfig();
      cfg.agy.bin = agyBin;
      saveConfig(cfg);

      const asyncEvents = [];
      const pool = createAgySessionPool({
        maxSessions: 1,
        idleTtlMs: 30_000,
        onAsyncEvent: (evt) => asyncEvents.push(evt),
      });

      const r1 = await pool.runTurn({
        runKey: 'key_async_1',
        prompt: 'emit_async',
        cwd: env.workDir,
        config: cfg,
      });
      assert.equal(r1.response, 'started');

      // Wait until unsolicited asyncTurn starts streaming (before result arrives at ~320ms)
      await waitUntil(() => asyncEvents.some((e) => e.type === 'start'));

      // Eviction / same-key reuse while asyncTurn is streaming must NOT share the active asyncTurn process or evict it when starting another key
      const rOther = await pool.runTurn({
        runKey: 'key_other_1',
        prompt: 'other work',
        cwd: env.workDir,
        config: cfg,
      });
      assert.equal(rOther.response, 'fresh turn ok');

      // Wait for asyncTurn result to still land cleanly on key_async_1
      await waitUntil(() => asyncEvents.some((e) => e.type === 'result' && e.runKey === 'key_async_1'));
      const asyncResult = asyncEvents.find((e) => e.type === 'result' && e.runKey === 'key_async_1');
      assert.equal(asyncResult.result.response, 'async finished');

      // Next turn with same conversationId reuses key_async_1; blank conversationId must NOT reuse bound entry
      const infoBefore = pool.getInfo('key_async_1');
      assert.ok(infoBefore?.conversationId?.startsWith('conv-bound-'));
      const rBlank = await pool.runTurn({
        runKey: 'key_async_1',
        prompt: 'new clean conversation',
        cwd: env.workDir,
        conversationId: '',
        config: cfg,
      });
      const infoAfterBlank = pool.getInfo('key_async_1');
      assert.notEqual(infoAfterBlank.pid, infoBefore.pid, 'Blank conversationId must spawn a fresh process');
      assert.equal(rBlank.response, 'fresh turn ok');

      // Per-turn timeout aborts a hung turn inside persistent pool
      const rTimedOut = await pool.runTurn({
        runKey: 'key_timeout_1',
        prompt: 'hang_turn',
        cwd: env.workDir,
        timeoutSeconds: 0.25,
        config: cfg,
      });
      assert.equal(rTimedOut.aborted, true);
      assert.equal(rTimedOut.status, 'ABORTED');

      pool.disposeAll({ immediate: true });
    }
  });
});
