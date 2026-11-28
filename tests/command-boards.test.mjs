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

const env = createTestEnv('feishu-cmd-boards-');
let config;

const { loadConfig, loadState, saveConfig, saveState } = await import('../scripts/lib/config.mjs');
const { buildAgySkillsCard, consumePendingCommand } = await import('../scripts/lib/feishu-api.mjs');
const { handleBotMenuEvent, handleCardAction } = await import('../scripts/lib/card-actions.mjs');
const { handleSlashCommand } = await import('../scripts/lib/slash-commands.mjs');
const { createTaskRunner } = await import('../scripts/lib/task-runner.mjs');
const {
  detectTurnCommandBoard,
  inspectCommandBoardTelemetry,
  SCHEDULE_PRESET_TEMPLATES,
} = await import('../scripts/lib/command-boards.mjs');

function assertCardColumnBudget(card) {
  assert.equal(card?.schema, '2.0');
  for (const el of card?.body?.elements || []) {
    if (el.tag === 'column_set') {
      assert.ok(el.columns.length <= 5, `column_set exceeded 5 columns: ${el.columns.length}`);
    }
  }
}

function makeEvent(value, openId = 'ou_test_owner', chatId = 'oc_board_p2p', messageId = 'om_board_card') {
  return {
    operator: { open_id: openId },
    action: { value },
    context: { open_message_id: messageId, open_chat_id: chatId },
  };
}

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

describe('command-boards dashboards, telemetry & missing menu commands', () => {
  before(() => {
    config = seedDefaultTestConfig(env.workDir);
    const st = loadState();
    st.lastP2pChatByOpenId.ou_test_owner = 'oc_board_p2p';
    st.chats.oc_board_p2p = {
      conversationId: 'conv-board-1',
      cwd: env.workDir,
      mode: 'accept-edits',
      recentConversations: [],
    };
    saveState(st);
  });

  after(() => env.cleanup());

  it('includes /grill-me, /schedule, and 4 dashboard buttons in buildAgySkillsCard within column limits', () => {
    const card = buildAgySkillsCard({ skills: [] });
    assertCardColumnBudget(card);
    const json = JSON.stringify(card);
    assert.ok(json.includes('/grill-me'));
    assert.ok(json.includes('/schedule'));
    assert.ok(json.includes('🎯 Goal 看板'));
    assert.ok(json.includes('🐝 Swarm 看板'));
    assert.ok(json.includes('⏰ 定时看板'));
    assert.ok(json.includes('🧭 Plan 看板'));
  });

  it('inspectCommandBoardTelemetry parses transcript, swarm plan.json, sqlite children, and rejects unsafe IDs', () => {
    assert.deepEqual(inspectCommandBoardTelemetry('../etc/passwd'), {
      steps: [],
      swarm: { title: '', goal: null, threads: [], workers: [] },
      schedules: [],
      planSummary: '',
    });

    const convId = 'conv-telemetry-1';
    const cliRoot = path.join(env.geminiDir, 'antigravity-cli');
    const brainDir = path.join(cliRoot, 'brain', convId, '.system_generated');
    fs.mkdirSync(path.join(brainDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(brainDir, 'swarm'), { recursive: true });

    fs.writeFileSync(
      path.join(brainDir, 'swarm', 'plan.json'),
      JSON.stringify({
        goal: { title: '多端协同联调', line: '并行完成前后端验证' },
        tasks: { reviewer: '代码静态审查与用例验证' },
        threads: [{ id: 't-1', title: 'QA', goal: 'Verify', tasks: ['reviewer'] }],
      }),
    );

    const nowIso = new Date().toISOString();
    const transcriptLines = [
      JSON.stringify({
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: nowIso,
        content: '<USER_REQUEST>\n/plan 重构通知中心\n</USER_REQUEST>',
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: nowIso,
        tool_calls: [
          {
            name: 'update_steps',
            args: {
              steps: JSON.stringify([
                { title: '调研现存实现', status: 'done' },
                { title: '补充单测验证', status: 'in_progress' },
              ]),
            },
          },
          {
            name: 'swarm',
            args: {
              action: JSON.stringify('title'),
              title: JSON.stringify('通知重构小队'),
            },
          },
          {
            name: 'swarm',
            args: {
              action: JSON.stringify('add'),
              name: JSON.stringify('coder'),
              model: JSON.stringify('gemini-4-neon-high'),
              brief: JSON.stringify('实现核心接口改造'),
            },
          },
          {
            name: 'invoke_subagent',
            args: {
              Role: JSON.stringify('Codebase Researcher'),
              Model: JSON.stringify('flash'),
              Prompt: JSON.stringify('梳理全部调用方'),
            },
          },
          {
            name: 'schedule',
            args: {
              CronExpression: JSON.stringify('*/30 * * * *'),
              Prompt: JSON.stringify('检查构建状态'),
              IsDaemon: true,
            },
          },
          {
            name: 'schedule',
            args: {
              DurationSeconds: 600,
              Prompt: JSON.stringify('10分钟后提醒我'),
            },
          },
          {
            name: 'manage_task',
            args: {
              Action: JSON.stringify('kill'),
              TaskId: JSON.stringify('timer-2'),
            },
          },
          {
            name: 'exit_plan_mode',
            args: {
              plan: JSON.stringify('分两步重构：先抽离适配层，再补全回归测试。'),
            },
          },
        ],
      }),
    ];
    fs.writeFileSync(path.join(brainDir, 'logs', 'transcript.jsonl'), transcriptLines.join('\n') + '\n');

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
    db.prepare(`
      INSERT INTO conversation_summaries
      (conversation_id, title, preview, step_count, last_modified_time, status, agent_name, parent_conversation_id, killed, not_fully_idle)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('child-coder-1', 'coder', '正在修改路由', 6, nowIso, 'RUNNING', 'coder', convId, 0, 1);
    db.close();

    const telemetry = inspectCommandBoardTelemetry(convId);
    assert.equal(telemetry.steps.length, 2);
    assert.equal(telemetry.steps[0].status, 'done');
    assert.equal(telemetry.steps[1].status, 'in_progress');
    assert.equal(telemetry.swarm.title, '通知重构小队');
    assert.equal(telemetry.swarm.goal.line, '并行完成前后端验证');
    assert.ok(telemetry.swarm.workers.some((w) => w.name === 'coder' && w.status === 'working' && w.stepCount === 6));
    assert.ok(telemetry.swarm.workers.some((w) => w.name === 'reviewer' && w.brief.includes('静态审查')));
    assert.ok(telemetry.swarm.workers.some((w) => w.name === 'Codebase Researcher'));
    assert.equal(telemetry.schedules.length, 2);
    assert.equal(telemetry.schedules[0].cronExpression, '*/30 * * * *');
    assert.equal(telemetry.schedules[0].cancelled, false);
    assert.equal(telemetry.schedules[1].cancelled, true);
    assert.ok(telemetry.planSummary.includes('分两步重构'));
  });

  it('handles all 4 command board card actions, allowlisted quick prompts, plan decisions, and bot menu events', async () => {
    const { client, calls } = createMockFeishuClient();
    const dispatched = [];
    const ctx = createBridgeContext({
      client,
      runner: {
        getQueueForChat: () => [],
        totalQueuedCount: () => 0,
        enqueueOrExecutePrompt: async (payload) => {
          dispatched.push(payload);
        },
      },
    });

    // 1. Open all 4 boards via cmd_board
    for (const board of ['goal', 'swarm', 'schedule', 'plan']) {
      const res = await handleCardAction(ctx, makeEvent({ cmd: 'cmd_board', board, inplace: true }));
      assert.equal(res.toast.type, 'info');
      assertCardColumnBudget(res.card?.data);
    }

    // 2. goal_prepare sets per-chat unlimited timeout + full mode + arms /goal without mutating global config
    const globalTimeoutBefore = loadConfig().agy.timeoutSeconds;
    const goalPrep = await handleCardAction(
      ctx,
      makeEvent({ cmd: 'goal_prepare', setUnlimited: true, setFull: true, arm: true, inplace: true }),
    );
    assert.equal(goalPrep.toast.type, 'success');
    assert.equal(loadConfig().agy.timeoutSeconds, globalTimeoutBefore);
    assert.equal(loadState().chats.oc_board_p2p.timeoutSeconds, 0);
    assert.equal(loadState().chats.oc_board_p2p.mode, 'full');
    assert.equal(loadState().chats.oc_board_p2p.pendingCommand?.prefix, '/goal');

    // 3. board_set_timeout switches per-chat timeout back to 60m (3600s)
    const setTo60 = await handleCardAction(
      ctx,
      makeEvent({ cmd: 'board_set_timeout', arg: '60m', board: 'goal', inplace: true }),
    );
    assert.equal(setTo60.toast.type, 'success');
    assert.equal(loadConfig().agy.timeoutSeconds, globalTimeoutBefore);
    assert.equal(loadState().chats.oc_board_p2p.timeoutSeconds, 3600);

    // 4. schedule_arm_template arms template and consumePendingCommand composes "/schedule <template>"
    const armTpl = await handleCardAction(
      ctx,
      makeEvent({ cmd: 'schedule_arm_template', preset: 'remind_5m', inplace: true }),
    );
    assert.equal(armTpl.toast.type, 'success');
    const stAfterTpl = loadState();
    assert.equal(stAfterTpl.chats.oc_board_p2p.pendingCommand?.prefix, '/schedule');
    assert.equal(stAfterTpl.chats.oc_board_p2p.pendingCommand?.template, SCHEDULE_PRESET_TEMPLATES.remind_5m.template);
    const consumed = consumePendingCommand(stAfterTpl.chats.oc_board_p2p, '喝水休息');
    assert.equal(consumed.applied, true);
    assert.equal(consumed.prefix, '/schedule 5分钟后提醒我：');

    // Reject unknown schedule preset
    const badTpl = await handleCardAction(
      ctx,
      makeEvent({ cmd: 'schedule_arm_template', preset: 'hack_eval', inplace: true }),
    );
    assert.equal(badTpl.toast.type, 'error');

    // 5. board_quick_prompt allowlist check
    const badQuick = await handleCardAction(
      ctx,
      makeEvent({ cmd: 'board_quick_prompt', preset: 'rm_rf_root' }),
    );
    assert.equal(badQuick.toast.type, 'error');
    const okQuick = await handleCardAction(
      ctx,
      makeEvent({ cmd: 'board_quick_prompt', preset: 'swarm_status' }),
    );
    assert.equal(okQuick.toast.type, 'success');
    assert.ok(dispatched.some((d) => d.text.includes('Swarm')));

    // 6. plan_decision: approve switches plan -> accept-edits, revise arms /plan template, discard resets conversationId
    const stPlan = loadState();
    stPlan.chats.oc_board_p2p.mode = 'plan';
    stPlan.chats.oc_board_p2p.conversationId = 'conv-plan-1';
    saveState(stPlan);

    const approveRes = await handleCardAction(
      ctx,
      makeEvent({ cmd: 'plan_decision', decision: 'approve' }),
    );
    assert.equal(approveRes.toast.type, 'success');
    assert.equal(loadState().chats.oc_board_p2p.mode, 'accept-edits');
    assert.ok(dispatched.some((d) => d.text.includes('按计划开始执行')));

    const reviseRes = await handleCardAction(
      ctx,
      makeEvent({ cmd: 'plan_decision', decision: 'revise', inplace: true }),
    );
    assert.equal(reviseRes.toast.type, 'info');
    assert.equal(loadState().chats.oc_board_p2p.pendingCommand?.prefix, '/plan');
    assert.ok(loadState().chats.oc_board_p2p.pendingCommand?.template.includes('调整方案'));

    const discardRes = await handleCardAction(
      ctx,
      makeEvent({ cmd: 'plan_decision', decision: 'discard', inplace: true }),
    );
    assert.equal(discardRes.toast.type, 'info');
    assert.equal(loadState().chats.oc_board_p2p.conversationId, '');

    // 7. Bot menu events open each board directly
    for (const menuKey of ['menu_goal', 'menu_swarm', 'menu_schedule', 'menu_plan']) {
      await handleBotMenuEvent(ctx, {
        operator: { operator_id: { open_id: 'ou_test_owner' } },
        event_key: menuKey,
      });
    }
    assert.equal(calls.sentCards.length, 4);
    assert.ok(calls.sentCards[0].card.header.title.content.includes('/goal'));
    assert.ok(calls.sentCards[1].card.header.title.content.includes('Swarm'));
    assert.ok(calls.sentCards[2].card.header.title.content.includes('/schedule'));
    assert.ok(calls.sentCards[3].card.header.title.content.includes('/plan'));
  });

  it('opens boards on bare slash commands while passing through commands with task arguments', async () => {
    async function invokeSlash(text) {
      const { client, calls } = createMockFeishuClient();
      const ctx = createBridgeContext({ client });
      const handled = await handleSlashCommand(ctx, {
        text,
        chatId: 'oc_board_p2p',
        openId: 'ou_test_owner',
        messageId: 'om_slash_msg',
        sessionKey: 'oc_board_p2p',
        config: loadConfig(),
      });
      return { handled, calls };
    }

    for (const [cmd, titleHint] of [
      ['/goal', '/goal'],
      ['/swarm', 'Swarm'],
      ['/teamwork', 'Swarm'],
      ['/schedule', '/schedule'],
      ['/plan', '/plan'],
      ['/grill-me', '/grill-me'],
    ]) {
      const res = await invokeSlash(cmd);
      assert.equal(res.handled, true, `Expected ${cmd} to be handled`);
      const card = res.calls.repliedCards[0].card;
      assert.ok(card.header.title.content.includes(titleHint));
      assertCardColumnBudget(card);
    }

    for (const cmdWithArg of ['/goal 完成全部单测', '/plan 优化登录流程', '/schedule 5分钟后提醒我喝水', '/swarm 检查架构']) {
      const res = await invokeSlash(cmdWithArg);
      assert.equal(res.handled, false, `Expected "${cmdWithArg}" to pass through to agy`);
    }
  });

  it('detectTurnCommandBoard and task-runner attach contextual board/approval buttons on turn completion', async () => {
    assert.deepEqual(detectTurnCommandBoard('/plan 设计插件权限系统'), { kind: 'plan' });
    assert.deepEqual(detectTurnCommandBoard('[agy] /grill-me 梳理需求'), { kind: 'plan' });
    assert.deepEqual(detectTurnCommandBoard('/goal 跑通全量测试'), { kind: 'goal' });
    assert.deepEqual(detectTurnCommandBoard('/swarm 多端审查'), { kind: 'swarm' });
    assert.deepEqual(detectTurnCommandBoard('普通指令', ['schedule']), { kind: 'schedule' });

    const scenarioFile = path.join(env.root, 'board-agy-scenario.json');
    const fakeAgyScript = `
import fs from 'node:fs';
const scenarioPath = ${JSON.stringify(scenarioFile)};
const args = process.argv.slice(2);
if (args[0] === 'models') {
  console.log('gemini-4-neon-high\\tGemini 4 Neon (High)');
  process.exit(0);
}
const queue = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const step = queue.shift() || { conversationId: 'conv-plan-run', response: 'Plan ready' };
fs.writeFileSync(scenarioPath, JSON.stringify(queue, null, 2));
console.log(JSON.stringify({ event: 'init', conversation_id: step.conversationId, init: { cwd: process.cwd(), permission_mode: 'plan' } }));
console.log(JSON.stringify({ event: 'message', role: 'assistant', content: step.response, delta: true }));
console.log(JSON.stringify({ event: 'result', status: 'SUCCESS', stats: { duration_seconds: 0.4, total_tokens: 120 } }));
`;
    const fakeAgyBin = createFakeAgyBin(env.root, fakeAgyScript);
    const cfg = loadConfig();
    cfg.agy.bin = fakeAgyBin;
    saveConfig(cfg);

    fs.writeFileSync(
      scenarioFile,
      JSON.stringify([{ conversationId: 'conv-plan-run', response: '## 实施计划\n1. 调整配置\n2. 运行单测' }]),
    );

    const { client, calls } = createMockFeishuClient();
    const activeRuns = new Map();
    const chatQueues = new Map();
    const lastTaskByChat = new Map();
    const runner = createTaskRunner({ client, activeRuns, chatQueues, lastTaskByChat });

    await runner.enqueueOrExecutePrompt({
      text: '/plan 设计命令看板',
      displayPreview: '/plan 设计命令看板',
      chatId: 'oc_board_p2p',
      openId: 'ou_test_owner',
      messageId: 'om_user_plan_1',
      sessionKey: 'oc_board_p2p',
      config: loadConfig(),
    });

    await waitUntil(() => calls.cardkitUpdates.length > 0 && activeRuns.size === 0);
    const finalCardJson = JSON.stringify(calls.cardkitUpdates.at(-1).card);
    assert.ok(finalCardJson.includes('✅ 按计划执行'));
    assert.ok(finalCardJson.includes('🧭 Plan 看板'));
  });
});
