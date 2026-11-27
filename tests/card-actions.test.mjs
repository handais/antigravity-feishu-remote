import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  createBridgeContext,
  createMockFeishuClient,
  createTestEnv,
  seedDefaultTestConfig,
  seedFakeGeminiStores,
} from './helpers.mjs';

const env = createTestEnv('feishu-card-actions-');
let config;

const { getConfigDir, getHandoffsDir, loadConfig, loadState, resolveRiskyApprovalEnabled, saveState } = await import('../scripts/lib/config.mjs');
const { classifyCommandRisk, createApprovalRequest, readApprovalDecision } = await import('../scripts/lib/command-guard.mjs');
const { computePanelActionScore, discoverLocalSkills, discoverQuickDirs } = await import('../scripts/lib/feishu-api.mjs');
const { isSensitiveFilePath } = await import('../scripts/lib/actions/artifacts.mjs');
const { buildHandoffCard, readMobileSession, writeHandoffSnapshot } = await import('../scripts/lib/mobile-handoff.mjs');
const { createBackupSnapshot, getBackupsDir, runPreflightCheckAsync } = await import('../scripts/lib/self-ops.mjs');
const { handleBotMenuEvent, handleCardAction } = await import('../scripts/lib/card-actions.mjs');

describe('card-actions & bot-menu across all 5 action submodules', () => {
  before(() => {
    config = seedDefaultTestConfig(env.workDir);
    seedFakeGeminiStores(env.geminiDir, {
      cliRows: [
        {
          id: 'cli-sess-1',
          title: 'CLI 原生任务',
          preview: 'cli preview',
          stepCount: 4,
          modified: '2026-11-26T03:00:00Z',
          workspaces: JSON.stringify([`file://${env.workDir}`]),
        },
      ],
      desktopRows: [
        {
          id: 'desk-sess-1',
          title: '桌面端分析任务',
          preview: 'desktop preview',
          stepCount: 10,
          modified: '2026-11-26T04:00:00Z',
          workspaces: JSON.stringify([`file://${env.workDir}`]),
          status: 'CASCADE_RUN_STATUS_RUNNING',
        },
      ],
      transcripts: {
        'cli-sess-1': {
          source: 'cli',
          compact: [
            { step_index: 1, type: 'USER_INPUT', created_at: '2026-11-26T03:00:00Z', content: '<USER_REQUEST>\n手机测试任务\n</USER_REQUEST>' },
            { step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-26T03:00:10Z', content: '手机端执行完成。' },
          ],
          full: [
            { step_index: 1, type: 'USER_INPUT', created_at: '2026-11-26T03:00:00Z', content: '<USER_REQUEST>\n手机测试任务\n</USER_REQUEST>' },
            { step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-26T03:00:10Z', content: '手机端执行完成。' },
          ],
        },
        'desk-sess-1': {
          source: 'desktop',
          compact: [
            { step_index: 1, type: 'USER_INPUT', created_at: '2026-11-26T04:00:00Z', content: '<USER_REQUEST>\n电脑端测试\n</USER_REQUEST>' },
            { step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-26T04:00:10Z', content: '电脑端最新完整回复内容。' },
          ],
          full: [
            { step_index: 1, type: 'USER_INPUT', created_at: '2026-11-26T04:00:00Z', content: '<USER_REQUEST>\n电脑端测试\n</USER_REQUEST>' },
            { step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-26T04:00:10Z', content: '电脑端最新完整回复内容。' },
          ],
        },
      },
    });
  });

  after(() => {
    env.cleanup();
  });

  function makeEvent(value, openId = 'ou_test_owner', chatId = 'oc_act_1') {
    return {
      operator: { open_id: openId },
      context: { open_chat_id: chatId, open_message_id: 'om_card_1' },
      action: { value },
    };
  }

  it('rejects unauthorized operators', async () => {
    const { client } = createMockFeishuClient();
    const ctx = createBridgeContext({ client });
    const res = await handleCardAction(ctx, makeEvent({ cmd: 'panel' }, 'ou_stranger'));
    assert.equal(res.toast.type, 'error');
    assert.ok(res.toast.content.includes('未授权'));
  });

  it('handles desktop takeover, sync_latest, preview, and handoff_copy actions', async () => {
    const { client, calls } = createMockFeishuClient();
    const enqueued = [];
    const ctx = createBridgeContext({
      client,
      runner: {
        getQueueForChat: () => [],
        totalQueuedCount: () => 0,
        enqueueOrExecutePrompt: async (p) => { enqueued.push(p); },
        executePrompt: async () => {},
      },
    });

    // List & Preview
    const listRes = await handleCardAction(ctx, makeEvent({ cmd: 'desktop_list', filter: 'all', inplace: true }));
    assert.ok(JSON.stringify(listRes.card).includes('desk-sess-1'));

    const previewRes = await handleCardAction(ctx, makeEvent({ cmd: 'desktop_preview', arg: 'desk-sess-1', inplace: true }));
    assert.ok(JSON.stringify(previewRes.card).includes('电脑端对话详情预览'));

    // Takeover desktop handoff session
    const takeRes = await handleCardAction(ctx, makeEvent({ cmd: 'takeover', arg: 'desk-sess-1', cwd: env.workDir }));
    assert.equal(takeRes.toast.type, 'success');
    const st1 = loadState();
    assert.equal(st1.chats.oc_act_1.originDesktopSession.id, 'desk-sess-1');
    assert.ok(st1.chats.oc_act_1.pendingHandoff.contextBlock.includes('电脑端最新完整回复内容。'));

    // Incremental sync keeps conversationId intact
    st1.chats.oc_act_1.conversationId = 'cli-sess-1';
    saveState(st1);
    const syncRes = await handleCardAction(ctx, makeEvent({ cmd: 'desktop_sync_latest', arg: 'desk-sess-1' }));
    assert.equal(syncRes.toast.type, 'success');
    const st2 = loadState();
    assert.equal(st2.chats.oc_act_1.conversationId, 'cli-sess-1');
    assert.ok(st2.chats.oc_act_1.pendingHandoff.contextBlock.includes('电脑端最新完整回复内容。'));

    // Handoff CLI & Desktop copy
    const handoffCli = await handleCardAction(ctx, makeEvent({ cmd: 'handoff_copy', arg: 'cli-sess-1', target: 'cli', inplace: true }));
    assert.equal(handoffCli.toast.type, 'success');
    assert.ok(fs.readFileSync(env.clipboardFile, 'utf8').includes('--conversation cli-sess-1'));

    const handoffDesk = await handleCardAction(ctx, makeEvent({ cmd: 'handoff_copy', arg: 'cli-sess-1', target: 'desktop', inplace: true }));
    assert.equal(handoffDesk.toast.type, 'success');
    assert.ok(fs.readFileSync(env.clipboardFile, 'utf8').includes('[手机飞书端进展回流]'));

    // Desktop takeover with summarize: true enqueues summary prompt
    const sumRes = await handleCardAction(ctx, makeEvent({ cmd: 'desktop_takeover', arg: 'desk-sess-1', summarize: true }));
    assert.equal(sumRes.toast.type, 'success');
    assert.equal(enqueued.length, 1);

    // Native CLI takeover clears originDesktopSession
    await handleCardAction(ctx, makeEvent({ cmd: 'takeover', arg: 'cli-sess-1' }));
    const st3 = loadState();
    assert.equal(st3.chats.oc_act_1.conversationId, 'cli-sess-1');
    assert.equal(st3.chats.oc_act_1.originDesktopSession, null);

    assert.ok(calls.sentCards.length >= 1);
  });

  it('handles artifact actions: turn_diff, turn_files, turn_send_file, approval_decide, guard_toggle', async () => {
    const { client, calls } = createMockFeishuClient();
    const ctx = createBridgeContext({ client });
    const sampleFile = path.join(env.workDir, 'out.md');
    fs.writeFileSync(sampleFile, '# Artifact\n', 'utf8');

    const st = loadState();
    st.chats.oc_art_1 = {
      conversationId: 'cli-sess-1',
      cwd: env.workDir,
      mode: 'accept-edits',
      lastTurnArtifacts: { conversationId: 'cli-sess-1', cwd: env.workDir, files: [sampleFile], updatedAt: Date.now() },
      recentConversations: [],
    };
    saveState(st);

    const diffRes = await handleCardAction(ctx, makeEvent({ cmd: 'turn_diff', inplace: true }, 'ou_test_owner', 'oc_art_1'));
    assert.ok(JSON.stringify(diffRes.card).includes('out.md'));

    const filesRes = await handleCardAction(ctx, makeEvent({ cmd: 'turn_files', inplace: true }, 'ou_test_owner', 'oc_art_1'));
    assert.ok(JSON.stringify(filesRes.card).includes('turn_send_file'));

    const badSendRes = await handleCardAction(ctx, makeEvent({ cmd: 'turn_send_file', arg: '99' }, 'ou_test_owner', 'oc_art_1'));
    assert.equal(badSendRes.toast.type, 'error');

    const sendRes = await handleCardAction(ctx, makeEvent({ cmd: 'turn_send_file', arg: '0' }, 'ou_test_owner', 'oc_art_1'));
    assert.equal(sendRes.toast.type, 'success');
    assert.equal(calls.uploadedFiles.length, 1);

    // Approval decision + idempotency + guard toggle
    const req = createApprovalRequest({ commandLine: 'rm -rf ./tmp', cwd: env.workDir });
    const allowRes = await handleCardAction(ctx, makeEvent({ cmd: 'approval_decide', arg: req.id, decision: 'allow' }, 'ou_test_owner', 'oc_art_1'));
    assert.equal(allowRes.toast.type, 'success');
    assert.equal(readApprovalDecision(req.id).decision, 'allow');

    const dupRes = await handleCardAction(ctx, makeEvent({ cmd: 'approval_decide', arg: req.id, decision: 'deny' }, 'ou_test_owner', 'oc_art_1'));
    assert.equal(dupRes.toast.type, 'info');
    assert.equal(readApprovalDecision(req.id).decision, 'allow');

    await handleCardAction(ctx, makeEvent({ cmd: 'guard_toggle', arg: 'off', inplace: true }, 'ou_test_owner', 'oc_art_1'));
    assert.equal(resolveRiskyApprovalEnabled(loadConfig()), false);
    await handleCardAction(ctx, makeEvent({ cmd: 'guard_toggle', arg: 'on', inplace: true }, 'ou_test_owner', 'oc_art_1'));
    assert.equal(resolveRiskyApprovalEnabled(loadConfig()), true);
  });

  it('handles ops, queue/task, workspace/session actions, and bot menu events', async () => {
    const { client, calls } = createMockFeishuClient();
    const activeRuns = new Map();
    const chatQueues = new Map([
      ['oc_ops_1', [{ id: 'q1', queuedAt: Date.now(), payload: { text: 'a' } }, { id: 'q2', queuedAt: Date.now(), payload: { text: 'b' } }]],
    ]);
    const ctx = createBridgeContext({
      client,
      activeRuns,
      chatQueues,
      runner: {
        getQueueForChat: (k) => chatQueues.get(k) || [],
        totalQueuedCount: () => [...chatQueues.values()].reduce((s, a) => s + a.length, 0),
        enqueueOrExecutePrompt: async () => {},
        executePrompt: async () => {},
      },
    });

    // Ops actions
    const opsRes = await handleCardAction(ctx, makeEvent({ cmd: 'ops', inplace: true }, 'ou_test_owner', 'oc_ops_1'));
    assert.ok(JSON.stringify(opsRes.card).includes('运维与自迭代'));

    const checkRes = await handleCardAction(ctx, makeEvent({ cmd: 'preflight', inplace: true }, 'ou_test_owner', 'oc_ops_1'));
    assert.equal(checkRes.toast.type, 'success');

    const gitRes = await handleCardAction(ctx, makeEvent({ cmd: 'git', inplace: true }, 'ou_test_owner', 'oc_ops_1'));
    assert.equal(gitRes.toast.type, 'info');

    const scopesRes = await handleCardAction(ctx, makeEvent({ cmd: 'scopes', inplace: true }, 'ou_test_owner', 'oc_ops_1'));
    assert.ok(JSON.stringify(scopesRes.card).includes('im:message'));

    const applyRes = await handleCardAction(ctx, makeEvent({ cmd: 'scopes_apply', inplace: true }, 'ou_test_owner', 'oc_ops_1'));
    assert.equal(applyRes.toast.type, 'success');
    assert.equal(calls.scopeApplyCalls, 1);

    const notifyRes = await handleCardAction(ctx, makeEvent({ cmd: 'notify_mode', arg: 'away', inplace: true }, 'ou_test_owner', 'oc_ops_1'));
    assert.equal(notifyRes.toast.type, 'success');
    assert.equal(loadConfig().notifications.stopNotifyMode, 'away');

    // Queue actions
    const qList = await handleCardAction(ctx, makeEvent({ cmd: 'queue_list', inplace: true }, 'ou_test_owner', 'oc_ops_1'));
    assert.ok(JSON.stringify(qList.card).includes('q1'));

    const qCancel = await handleCardAction(ctx, makeEvent({ cmd: 'queue_cancel', arg: 'q1', inplace: true }, 'ou_test_owner', 'oc_ops_1'));
    assert.equal(qCancel.toast.type, 'success');
    assert.equal(chatQueues.get('oc_ops_1').length, 1);

    const qClear = await handleCardAction(ctx, makeEvent({ cmd: 'queue_clear', inplace: true }, 'ou_test_owner', 'oc_ops_1'));
    assert.equal(qClear.toast.type, 'success');
    assert.equal(chatQueues.has('oc_ops_1'), false);

    // Workspace & session reset regressions (`new` & `use`)
    const st = loadState();
    st.chats.oc_ops_1 = {
      ...(st.chats.oc_ops_1 || {}),
      conversationId: 'cli-sess-1',
      cwd: env.workDir,
      mode: 'accept-edits',
      originDesktopSession: { id: 'desk-sess-1', title: 'X' },
      lastTurnArtifacts: { conversationId: 'cli-sess-1', cwd: env.workDir, files: ['a.md'] },
      pendingHandoff: { id: 'desk-sess-1', contextBlock: 'ctx' },
    };
    st.lastP2pChatByOpenId.ou_test_owner = 'oc_ops_1';
    saveState(st);

    const newRes = await handleCardAction(ctx, makeEvent({ cmd: 'new', inplace: true }, 'ou_test_owner', 'oc_ops_1'));
    assert.equal(newRes.toast.type, 'success');
    const stAfterNew = loadState().chats.oc_ops_1;
    assert.equal(stAfterNew.conversationId, '');
    assert.equal(stAfterNew.pendingHandoff, null);
    assert.equal(stAfterNew.originDesktopSession, null);
    assert.equal(stAfterNew.lastTurnArtifacts, null);

    // Quick, mode, effort, dirs
    await handleCardAction(ctx, makeEvent({ cmd: 'mode_temp_full', arg: '20', inplace: true }, 'ou_test_owner', 'oc_ops_1'));
    assert.equal(loadState().chats.oc_ops_1.mode, 'full');
    await handleCardAction(ctx, makeEvent({ cmd: 'effort', arg: 'high', inplace: true }, 'ou_test_owner', 'oc_ops_1'));
    assert.equal(loadState().chats.oc_ops_1.effort, 'high');
    const dirsRes = await handleCardAction(ctx, makeEvent({ cmd: 'dirs', showHidden: true, inplace: true }, 'ou_test_owner', 'oc_ops_1'));
    assert.equal(dirsRes.toast.type, 'info');

    // Bot menu events
    await handleBotMenuEvent(ctx, { operator: { operator_id: { open_id: 'ou_test_owner' } }, event_key: 'menu_guard' });
    assert.equal(resolveRiskyApprovalEnabled(loadConfig()), false);
    await handleBotMenuEvent(ctx, { operator: { operator_id: { open_id: 'ou_test_owner' } }, event_key: 'menu_guard' });
    assert.equal(resolveRiskyApprovalEnabled(loadConfig()), true);
    await handleBotMenuEvent(ctx, { operator: { operator_id: { open_id: 'ou_test_owner' } }, event_key: 'menu_help' });
    assert.ok(calls.sentCards.some((c) => c.card?.header?.title?.content?.includes('飞书遥控指令')));
  });

  it('handles takeover_new_topic (creating isolated topic thread) and unlink_topic', async () => {
    const { client, calls } = createMockFeishuClient();
    const ctx = createBridgeContext({ client });

    // 1. Without any topic group known, warns cleanly
    saveState({
      chats: {
        oc_p2p_only: {
          conversationId: 'cli-old-p2p',
          cwd: env.workDir,
          mode: 'accept-edits',
        },
      },
      lastP2pChatByOpenId: { ou_test_owner: 'oc_p2p_only' },
      lastTopicChatId: '',
    });
    const noTopicRes = await handleCardAction(ctx, makeEvent({ cmd: 'takeover_new_topic', arg: 'desk-sess-1' }, 'ou_test_owner', 'oc_p2p_only'));
    assert.equal(noTopicRes.toast.type, 'warning');
    assert.ok(noTopicRes.toast.content.includes('尚未绑定话题群'));

    // 2. With lastTopicChatId set, creates a new topic card in the topic group and keeps P2P session intact
    const st = loadState();
    st.lastTopicChatId = 'oc_topic_grp_1';
    saveState(st);

    const newTopicRes = await handleCardAction(ctx, makeEvent({ cmd: 'takeover_new_topic', arg: 'desk-sess-1', cwd: env.workDir }, 'ou_test_owner', 'oc_p2p_only'));
    assert.equal(newTopicRes.toast.type, 'success');
    assert.ok(JSON.stringify(newTopicRes.card).includes('已在话题群新开独立话题承接'));

    // Root card sent to topic group, and reply card pushed inside the new thread
    assert.equal(calls.sentCards.length, 1);
    assert.equal(calls.sentCards[0].receiveId, 'oc_topic_grp_1');
    assert.equal(calls.sentCards[0].receiveIdType, 'chat_id');
    const rootMsgId = calls.sentCards[0].messageId;
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(calls.repliedCards.some((r) => r.parentMessageId === rootMsgId && r.replyInThread === true));

    const stAfter = loadState();
    const newThreadKey = `oc_topic_grp_1#${rootMsgId}`;
    assert.ok(stAfter.chats[newThreadKey], 'New topic thread state must be created');
    assert.equal(stAfter.chats[newThreadKey].originDesktopSession.id, 'desk-sess-1');
    assert.equal(stAfter.chats[newThreadKey].topicClosed, false);
    assert.equal(stAfter.chats.oc_p2p_only.conversationId, 'cli-old-p2p', 'Source P2P session must remain untouched');

    // 3. Unlink topic stops future auto-routing
    const unlinkRes = await handleCardAction(
      ctx,
      {
        operator: { open_id: 'ou_test_owner' },
        context: { open_chat_id: 'oc_topic_grp_1', open_message_id: rootMsgId },
        action: { value: { cmd: 'unlink_topic' } },
      },
    );
    assert.equal(unlinkRes.toast.type, 'success');
    const stUnlinked = loadState();
    assert.equal(stUnlinked.chats[newThreadKey].topicClosed, true);
    assert.equal(stUnlinked.chats[newThreadKey].originDesktopSession, null);
  });

  it('renders sectioned control panel and system_menu sub-page with fromSystem guard toggle', async () => {
    const { client } = createMockFeishuClient();
    const ctx = createBridgeContext({ client });

    const panelRes = await handleCardAction(ctx, makeEvent({ cmd: 'panel', inplace: true }, 'ou_test_owner', 'oc_act_1'));
    const panelCard = panelRes.card?.data;
    assert.equal(panelCard.schema, '2.0');
    assert.ok(panelCard.body.elements.some((el) => el.tag === 'hr'));
    const panelJson = JSON.stringify(panelCard);
    for (const fieldLabel of ['工作目录', '执行模式', '当前模型', '推理强度', '电脑端提醒', '当前会话']) {
      assert.ok(panelJson.includes(fieldLabel), `Missing status field ${fieldLabel}`);
    }
    assert.ok(!panelJson.includes('目录 / 模式'));
    assert.ok(!panelJson.includes('模型 / 会话'));
    assert.ok(!panelJson.includes('✏️ 改文件'));
    assert.ok(!panelJson.includes('⚡ 快捷任务'));
    assert.ok(panelJson.includes('会话与跨端'));
    assert.ok(panelJson.includes('任务与工作区'));
    assert.ok(panelJson.includes('权限与配置'));
    assert.ok(panelJson.includes('"cmd":"system_menu"'));
    assert.ok(panelJson.includes('"cmd":"help"'));
    for (const el of panelCard.body.elements) {
      if (el.tag === 'column_set') {
        assert.ok(el.columns.length <= 5, `column_set exceeded 5 columns: ${el.columns.length}`);
      }
    }

    const helpRes = await handleCardAction(ctx, makeEvent({ cmd: 'help', inplace: true }, 'ou_test_owner', 'oc_act_1'));
    const helpCard = helpRes.card?.data;
    assert.equal(helpCard?.header?.title?.content, '❓ 控制面板功能说明');
    const helpJson = JSON.stringify(helpCard);
    for (const expected of ['会话与跨端', '任务与工作区', '权限与配置', '30m全权', '设置', '"cmd":"help_commands"', '"cmd":"panel"']) {
      assert.ok(helpJson.includes(expected), `Missing ${expected} in panel help card`);
    }

    const cmdHelpRes = await handleCardAction(ctx, makeEvent({ cmd: 'help_commands', inplace: true }, 'ou_test_owner', 'oc_act_1'));
    const cmdHelpCard = cmdHelpRes.card?.data;
    assert.equal(cmdHelpCard?.header?.title?.content, '📖 全部斜杠指令');
    const cmdHelpJson = JSON.stringify(cmdHelpCard);
    for (const expected of ['/handoff', '/guard', '/topic', '/unlink', '"cmd":"help"', '"cmd":"panel"']) {
      assert.ok(cmdHelpJson.includes(expected), `Missing ${expected} in commands help card`);
    }

    const sysRes = await handleCardAction(ctx, makeEvent({ cmd: 'system_menu', inplace: true }, 'ou_test_owner', 'oc_act_1'));
    const sysCard = sysRes.card?.data;
    assert.equal(sysCard.header.title.content, '🛠️ 设置');
    const sysJson = JSON.stringify(sysCard);
    for (const cmdName of ['guard_toggle', 'notify_menu', 'scopes', 'safe_restart', 'ops', 'panel']) {
      assert.ok(sysJson.includes(`"cmd":"${cmdName}"`), `Missing ${cmdName} in system settings card`);
    }

    const toggleFromSys = await handleCardAction(
      ctx,
      makeEvent({ cmd: 'guard_toggle', inplace: true, fromSystem: true }, 'ou_test_owner', 'oc_act_1'),
    );
    assert.equal(toggleFromSys.card?.data?.header?.title?.content, '🛠️ 设置');
    assert.equal(resolveRiskyApprovalEnabled(loadConfig()), false);
    // Restore guard back to on
    await handleCardAction(
      ctx,
      makeEvent({ cmd: 'guard_toggle', arg: 'on', inplace: true, fromSystem: true }, 'ou_test_owner', 'oc_act_1'),
    );
    assert.equal(resolveRiskyApprovalEnabled(loadConfig()), true);
  });

  it('avoids redundant message.get on P2P/cached cards, bounds lookup timeout, and runs async preflight fast', async () => {
    const { client } = createMockFeishuClient();
    let getCallCount = 0;
    const origGet = client.im.v1.message.get;
    client.im.v1.message.get = async (args) => {
      getCallCount += 1;
      return origGet(args);
    };

    const st = loadState();
    st.lastP2pChatByOpenId.ou_test_owner = 'oc_p2p_fast';
    saveState(st);

    const ctx = createBridgeContext({ client });

    // 1. Known P2P chat skips message.get completely
    const p2pRes = await handleCardAction(ctx, {
      operator: { open_id: 'ou_test_owner' },
      context: { open_chat_id: 'oc_p2p_fast', open_message_id: 'om_p2p_card_1' },
      action: { value: { cmd: 'panel', inplace: true } },
    });
    assert.equal(p2pRes.card?.data?.schema, '2.0');
    assert.equal(getCallCount, 0);

    // 2. Non-thread group card queries message.get at most once and caches negative lookup
    await handleCardAction(ctx, {
      operator: { open_id: 'ou_test_owner' },
      context: { open_chat_id: 'oc_grp_unknown', open_message_id: 'om_grp_card_1' },
      action: { value: { cmd: 'panel', inplace: true } },
    });
    assert.equal(getCallCount, 1);

    await handleCardAction(ctx, {
      operator: { open_id: 'ou_test_owner' },
      context: { open_chat_id: 'oc_grp_unknown', open_message_id: 'om_grp_card_1' },
      action: { value: { cmd: 'panel', inplace: true } },
    });
    assert.equal(getCallCount, 1);

    // 3. Hanging message.get does not block callback beyond bounded timeout (~800ms)
    client.im.v1.message.get = () => new Promise((resolve) => {
      const t = setTimeout(() => resolve({ code: 0, data: { items: [] } }), 4000);
      t.unref?.();
    });
    const tStart = Date.now();
    const slowRes = await handleCardAction(ctx, {
      operator: { open_id: 'ou_test_owner' },
      context: { open_chat_id: 'oc_grp_slow', open_message_id: 'om_grp_card_slow' },
      action: { value: { cmd: 'panel', inplace: true } },
    });
    const elapsed = Date.now() - tStart;
    assert.equal(slowRes.card?.data?.schema, '2.0');
    assert.ok(elapsed < 1500, `Expected bounded callback latency < 1500ms, got ${elapsed}ms`);

    // 4. Async preflight check passes and checks all 30 scripts
    const asyncCheck = await runPreflightCheckAsync();
    assert.equal(asyncCheck.ok, true);
    assert.equal(asyncCheck.errors.length, 0);
    assert.equal(asyncCheck.checkedFiles.length, 30);
  });

  it('tracks frequent panel actions, renders ⭐ 常用操作 as 2nd section (max 4), decays old clicks, and supports reset', async () => {
    const { client } = createMockFeishuClient();
    const ctx = createBridgeContext({ client });

    // Ensure clean usage history
    const cleanState = loadState();
    cleanState.panelActionUsage = {};
    cleanState.lastP2pChatByOpenId.ou_test_owner = 'oc_freq_p2p';
    saveState(cleanState);

    // 1. Cold start hides ⭐ 常用操作
    const coldRes = await handleCardAction(ctx, makeEvent({ cmd: 'panel', inplace: true }, 'ou_test_owner', 'oc_freq_p2p'));
    const coldJson = JSON.stringify(coldRes.card?.data);
    assert.equal(coldJson.includes('常用操作'), false);

    // 2. Click tracked commands + noisy/excluded commands
    const clicks = [
      { cmd: 'git', inplace: true },
      { cmd: 'git', inplace: true },
      { cmd: 'git', inplace: true },
      { cmd: 'desktop_list', filter: 'all', inplace: true },
      { cmd: 'desktop_list', filter: 'all', inplace: true },
      { cmd: 'ops', inplace: true },
      { cmd: 'ops', inplace: true },
      { cmd: 'mode_temp_full', arg: '30', inplace: true },
      { cmd: 'mode_temp_full', arg: '30', inplace: true },
      { cmd: 'dirs', inplace: true },
      // Excluded commands should not pollute panelActionUsage
      { cmd: 'panel', inplace: true },
      { cmd: 'help', inplace: true },
      { cmd: 'system_menu', inplace: true },
    ];
    for (const action of clicks) {
      await handleCardAction(ctx, makeEvent(action, 'ou_test_owner', 'oc_freq_p2p'));
    }

    const recorded = loadState().panelActionUsage;
    assert.equal(recorded.git?.count, 3);
    assert.equal(recorded.desktop_list?.count, 2);
    assert.equal(recorded.ops?.count, 2);
    assert.equal(recorded.mode_temp_full?.count, 2);
    assert.equal(recorded.dirs?.count, 1);
    assert.equal(recorded.panel, undefined);
    assert.equal(recorded.help, undefined);
    assert.equal(recorded.system_menu, undefined);

    // 3. Rendered panel places ⭐ 常用操作 right after status summary and before 💬 会话与跨端
    const warmRes = await handleCardAction(ctx, makeEvent({ cmd: 'panel', inplace: true }, 'ou_test_owner', 'oc_freq_p2p'));
    const elements = warmRes.card?.data?.body?.elements || [];
    const freqTitleIdx = elements.findIndex((el) => el.tag === 'markdown' && String(el.content || '').includes('⭐ 常用操作'));
    const sessionTitleIdx = elements.findIndex((el) => el.tag === 'markdown' && String(el.content || '').includes('💬 会话与跨端'));
    assert.ok(freqTitleIdx > 0, '⭐ 常用操作 section header must exist after status block');
    assert.ok(freqTitleIdx < sessionTitleIdx, '⭐ 常用操作 must appear before 💬 会话与跨端');

    const freqColSet = elements[freqTitleIdx + 1];
    assert.equal(freqColSet.tag, 'column_set');
    assert.equal(freqColSet.columns.length, 4, '⭐ 常用操作 must display top 4 buttons');
    const freqLabels = freqColSet.columns.map((col) => col.elements[0].text.content);
    assert.equal(freqLabels[0], '🌿 Git');
    assert.ok(!freqLabels.includes('📁 切换目录'), '5th-ranked dirs must not appear when capped at 4');
    for (const el of elements) {
      if (el.tag === 'column_set') {
        assert.ok(el.columns.length <= 5, `column_set exceeded 5 columns: ${el.columns.length}`);
      }
    }

    // 4. Time decay ranks recent usage higher than stale equal-count usage
    const now = Date.now();
    const recentScore = computePanelActionScore({ count: 2, lastUsedAt: now }, now);
    const staleScore = computePanelActionScore({ count: 2, lastUsedAt: now - 30 * 86_400_000 }, now);
    assert.ok(recentScore > staleScore, `Expected recentScore (${recentScore}) > staleScore (${staleScore})`);

    // 5. Reset clears usage and hides section again
    const resetRes = await handleCardAction(
      ctx,
      makeEvent({ cmd: 'reset_frequent_actions', inplace: true }, 'ou_test_owner', 'oc_freq_p2p'),
    );
    assert.equal(resetRes.toast.type, 'success');
    assert.equal(resetRes.card?.data?.header?.title?.content, '🛠️ 设置');
    assert.deepEqual(loadState().panelActionUsage, {});

    const afterResetRes = await handleCardAction(ctx, makeEvent({ cmd: 'panel', inplace: true }, 'ou_test_owner', 'oc_freq_p2p'));
    assert.equal(JSON.stringify(afterResetRes.card?.data).includes('常用操作'), false);
  });

  it('deduplicates symlinked quick directories and matches pin/unpin across realpath aliases', async (t) => {
    const realRoot = path.join(env.workDir, 'real-root');
    const linkRoot = path.join(env.workDir, 'link-root');
    const realProj = path.join(realRoot, 'sampleproj');
    const linkProj = path.join(linkRoot, 'sampleproj');
    fs.mkdirSync(realProj, { recursive: true });
    fs.mkdirSync(linkRoot, { recursive: true });
    try {
      if (!fs.existsSync(linkProj)) {
        fs.symlinkSync(realProj, linkProj, 'dir');
      }
    } catch (err) {
      if (process.platform === 'win32' && (err?.code === 'EPERM' || err?.code === 'EACCES')) {
        t.skip('Symlink creation requires elevated privileges on Windows');
        return;
      }
      throw err;
    }

    const { saveConfig: persistTestConfig } = await import('../scripts/lib/config.mjs');
    const { client } = createMockFeishuClient();
    const ctx = createBridgeContext({ client });
    const cfg = loadConfig();
    cfg.agy.favoriteDirs = [linkProj];
    persistTestConfig(cfg);

    const st = loadState();
    st.lastP2pChatByOpenId.ou_test_owner = 'oc_sym_p2p';
    st.chats.oc_sym_p2p = {
      ...(st.chats.oc_sym_p2p || {}),
      cwd: realProj,
      mode: 'accept-edits',
      recentConversations: [],
    };
    saveState(st);

    const discovered = discoverQuickDirs(loadConfig(), realProj);
    const matchingSample = discovered.filter((d) => path.basename(d) === 'sampleproj');
    assert.equal(matchingSample.length, 1, `Expected only 1 sampleproj entry, got ${JSON.stringify(matchingSample)}`);

    const panelRes = await handleCardAction(ctx, makeEvent({ cmd: 'panel', inplace: true }, 'ou_test_owner', 'oc_sym_p2p'));
    const elements = panelRes.card?.data?.body?.elements || [];
    const quickButtons = elements
      .filter((el) => el.tag === 'column_set')
      .flatMap((el) => el.columns.flatMap((c) => c.elements))
      .filter((btn) => btn.tag === 'button');
    const projBtns = quickButtons.filter((b) => String(b.text?.content || '').includes('sampleproj'));
    assert.equal(projBtns.length, 1, 'Symlink alias and realpath must not appear twice');
    assert.equal(projBtns[0].type, 'primary');
    assert.ok(quickButtons.some((b) => b.text?.content === '📌 取消收藏'));

    const unpinRes = await handleCardAction(ctx, makeEvent({ cmd: 'pin', inplace: true }, 'ou_test_owner', 'oc_sym_p2p'));
    assert.equal(unpinRes.toast.type, 'success');
    assert.equal(loadConfig().agy.favoriteDirs.length, 0);
    assert.ok(JSON.stringify(unpinRes.card?.data).includes('📌 收藏目录'));
  });

  it('covers review hardening: hooks backup, handoff path sanitization, guard rules, and sensitive file diff/send protection', async () => {
    const { execFileSync } = await import('node:child_process');

    // 1. Backup snapshot tracks hooks.json & rules/AGENTS.md
    const snap = createBackupSnapshot({ reason: 'test-hooks', force: true });
    assert.equal(snap.created, true);
    const snapDir = path.join(getBackupsDir(), snap.snapshot.id);
    assert.equal(fs.existsSync(path.join(snapDir, 'hooks.json')), true);
    assert.equal(fs.existsSync(path.join(snapDir, 'rules/AGENTS.md')), true);

    // 2. Handoff path traversal sanitization & card blank line preservation
    const badRead = readMobileSession({ conversationId: '../../etc/passwd' });
    assert.equal(badRead.found, false);
    const snapWrite = writeHandoffSnapshot({
      conversationId: '../../evil',
      cwd: env.workDir,
      cliResumeCommand: 'agy',
      desktopHandoffPrompt: 'test',
    });
    const handoffRel = path.relative(getHandoffsDir(), snapWrite.snapshotPath);
    assert.ok(!handoffRel.startsWith('..') && !path.isAbsolute(handoffRel));

    const handoffCard = buildHandoffCard({
      session: {
        conversationId: 'cli-sess-1',
        cwd: env.workDir,
        cliResumeCommand: 'agy --conversation cli-sess-1',
      },
    });
    const handoffMd = handoffCard.body.elements.find((e) => e.tag === 'markdown')?.content || '';
    assert.ok(handoffMd.includes('\n\n**方式 1'), 'Blank separator line must be preserved in handoff card');

    // 3. Guard rules catch bypass patterns without false positives
    for (const riskyCmd of [
      'rm -r -f ./tmp',
      '/bin/rm -rf ./tmp',
      'git push origin +main',
      'echo ok && sudo ls',
      'find . -name "*.tmp" -delete',
    ]) {
      assert.equal(classifyCommandRisk(riskyCmd).risky, true, `Expected risky: ${riskyCmd}`);
    }
    for (const safeCmd of ['git push origin main', 'echo "do not use sudo"', 'rm ./single.txt']) {
      assert.equal(classifyCommandRisk(safeCmd).risky, false, `Expected safe: ${safeCmd}`);
    }

    // 4. Sensitive file path detection
    for (const sens of ['/tmp/.env', '/tmp/.env.local', '/tmp/server.pem', '/home/u/.ssh/id_ed25519', `${getConfigDir()}/config.json`]) {
      assert.equal(isSensitiveFilePath(sens), true, `Expected sensitive: ${sens}`);
    }
    for (const safeFile of ['/tmp/.env.example', '/tmp/README.md']) {
      assert.equal(isSensitiveFilePath(safeFile), false, `Expected safe file: ${safeFile}`);
    }

    // 5. turn_diff escapes triple backticks and skips .env; turn_send_file blocks .env
    const repoDir = path.join(env.workDir, 'sec-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
    const readmeFile = path.join(repoDir, 'notes.md');
    fs.writeFileSync(readmeFile, 'hello\n', 'utf8');
    execFileSync('git', ['add', 'notes.md'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
    fs.writeFileSync(readmeFile, 'hello\n```js\nconst x = 1;\n```\n', 'utf8');
    const envFile = path.join(repoDir, '.env');
    fs.writeFileSync(envFile, 'SECRET=super_secret_value\n', 'utf8');

    const { client, calls } = createMockFeishuClient();
    const ctx = createBridgeContext({ client });
    const st = loadState();
    st.chats.oc_sec_1 = {
      conversationId: 'cli-sec-1',
      cwd: repoDir,
      mode: 'accept-edits',
      lastTurnArtifacts: { conversationId: 'cli-sec-1', cwd: repoDir, files: [readmeFile, envFile], updatedAt: Date.now() },
      recentConversations: [],
    };
    saveState(st);

    const diffRes = await handleCardAction(ctx, makeEvent({ cmd: 'turn_diff', inplace: true }, 'ou_test_owner', 'oc_sec_1'));
    const diffMd = diffRes.card?.data?.body?.elements?.find((e) => e.tag === 'markdown')?.content || '';
    assert.ok(diffMd.includes('🔒'), 'turn_diff must warn about skipped sensitive file');
    assert.ok(!diffMd.includes('super_secret_value'), 'turn_diff must never expose sensitive file contents');
    assert.ok(diffMd.includes('\\`\\`\\`js'), 'turn_diff must escape triple backticks in diff markdown');

    const sendRes = await handleCardAction(ctx, makeEvent({ cmd: 'turn_send_file', arg: '1' }, 'ou_test_owner', 'oc_sec_1'));
    assert.equal(sendRes.toast.type, 'warning');
    assert.ok(sendRes.toast.content.includes('🔒'));
    assert.equal(calls.uploadedFiles.length, 0);
  });

  it('discovers local skills, renders skills menu from floating menu & card action, and triggers /compact safely', async () => {
    // 1. discoverLocalSkills across all 3 roots with deduplication
    const fakeHome = path.join(env.workDir, 'fake-home');
    const cfgSkillDir = path.join(fakeHome, '.gemini', 'config', 'skills', 'demo-skill');
    const agentSkillDir = path.join(fakeHome, '.agents', 'skills', 'agent-skill');
    const pluginSkillDir = path.join(fakeHome, '.gemini', 'config', 'plugins', 'p1', 'skills', 'plug-skill');
    const dupAgentSkillDir = path.join(fakeHome, '.agents', 'skills', 'demo-skill-dup');
    fs.mkdirSync(cfgSkillDir, { recursive: true });
    fs.mkdirSync(agentSkillDir, { recursive: true });
    fs.mkdirSync(pluginSkillDir, { recursive: true });
    fs.mkdirSync(dupAgentSkillDir, { recursive: true });
    fs.writeFileSync(path.join(cfgSkillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: "First demo skill"\n---\nbody\n', 'utf8');
    fs.writeFileSync(path.join(agentSkillDir, 'SKILL.md'), '---\nname: agent-skill\ndescription: Agent helper skill\n---\n', 'utf8');
    fs.writeFileSync(path.join(pluginSkillDir, 'SKILL.md'), '---\nname: plug-skill\ndescription: Plugin helper skill\n---\n', 'utf8');
    fs.writeFileSync(path.join(dupAgentSkillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: Duplicate ignored\n---\n', 'utf8');

    const discovered = discoverLocalSkills({ homeDir: fakeHome });
    assert.deepEqual(
      discovered.map((s) => s.name),
      ['agent-skill', 'demo-skill', 'plug-skill'],
    );
    assert.equal(discovered.find((s) => s.name === 'demo-skill')?.description, 'First demo skill');

    // 2. Floating menu event_key: menu_commands & menu_skills
    const { client, calls } = createMockFeishuClient();
    const enqueued = [];
    const ctx = createBridgeContext({
      client,
      runner: {
        getQueueForChat: () => [],
        totalQueuedCount: () => 0,
        enqueueOrExecutePrompt: async (p) => { enqueued.push(p); },
        executePrompt: async () => {},
      },
    });
    await handleBotMenuEvent(ctx, { operator: { operator_id: { open_id: 'ou_test_owner' } }, event_key: 'menu_commands' });
    await handleBotMenuEvent(ctx, { operator: { operator_id: { open_id: 'ou_test_owner' } }, event_key: 'menu_skills' });
    const menuCards = calls.sentCards.filter((c) => c.card?.header?.title?.content === '🧩 agy 命令与本机技能');
    assert.equal(menuCards.length, 2);

    // 3. In-place card navigation + run_agy_cmd /compact & deny unknown cmd
    const skillsRes = await handleCardAction(ctx, makeEvent({ cmd: 'skills_menu', inplace: true }, 'ou_test_owner', 'oc_act_1'));
    assert.equal(skillsRes.card?.data?.header?.title?.content, '🧩 agy 命令与本机技能');
    const skillsJson = JSON.stringify(skillsRes.card?.data);
    assert.ok(skillsJson.includes('/compact'));
    assert.ok(skillsJson.includes('"cmd":"run_agy_cmd"'));

    const compactRes = await handleCardAction(ctx, makeEvent({ cmd: 'run_agy_cmd', arg: '/compact' }, 'ou_test_owner', 'oc_act_1'));
    assert.equal(compactRes.toast.type, 'success');
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].text, '/compact');

    const badCmdRes = await handleCardAction(ctx, makeEvent({ cmd: 'run_agy_cmd', arg: '/evil' }, 'ou_test_owner', 'oc_act_1'));
    assert.equal(badCmdRes.toast.type, 'error');
    assert.equal(enqueued.length, 1);
  });

  it('aggregates Feishu sessions across topics/p2p with scope switching, dedup, and cross-chat cwd sync', async () => {
    const p2pDir = path.join(env.workDir, 'p2p-proj');
    fs.mkdirSync(p2pDir, { recursive: true });

    const st = loadState();
    st.lastP2pChatByOpenId = { ...st.lastP2pChatByOpenId, ou_test_owner: 'oc_p2p_sess' };
    st.chats.oc_p2p_sess = {
      conversationId: 'conv-p2p-1',
      cwd: p2pDir,
      mode: 'accept-edits',
      recentConversations: [
        { id: 'conv-p2p-1', summary: '私聊历史任务', updatedAt: '2026-11-26T10:00:00Z', cwd: p2pDir },
        { id: 'conv-dup-1', summary: '旧版重复摘要', updatedAt: '2026-11-26T08:00:00Z', cwd: env.workDir },
      ],
    };
    st.chats['oc_topic_grp#om_other_root'] = {
      conversationId: 'conv-other-topic',
      cwd: env.workDir,
      mode: 'accept-edits',
      recentConversations: [
        { id: 'conv-other-topic', summary: '同群其他话题任务', updatedAt: '2026-11-26T09:00:00Z', cwd: env.workDir },
      ],
    };
    st.chats['oc_topic_grp#om_cur_root'] = {
      conversationId: 'conv-cur-1',
      cwd: env.workDir,
      mode: 'accept-edits',
      recentConversations: [
        { id: 'conv-cur-1', summary: '本话题任务', updatedAt: '2026-11-26T11:00:00Z', cwd: env.workDir },
        { id: 'conv-dup-1', summary: '本话题重复摘要', updatedAt: '2026-11-26T09:30:00Z', cwd: env.workDir },
      ],
    };
    st.chats['oc_topic_grp#om_empty_root'] = {
      conversationId: '',
      cwd: env.workDir,
      mode: 'accept-edits',
      recentConversations: [],
    };
    saveState(st);

    const { client } = createMockFeishuClient();
    const ctx = createBridgeContext({ client });
    ctx.cardThreadMap.set('om_topic_card_1', {
      sessionKey: 'oc_topic_grp#om_cur_root',
      threadRootId: 'om_cur_root',
      chatId: 'oc_topic_grp',
    });
    ctx.cardThreadMap.set('om_empty_card_1', {
      sessionKey: 'oc_topic_grp#om_empty_root',
      threadRootId: 'om_empty_root',
      chatId: 'oc_topic_grp',
    });

    const makeTopicEvent = (value, msgId = 'om_topic_card_1') => ({
      operator: { open_id: 'ou_test_owner' },
      context: { open_chat_id: 'oc_topic_grp', open_message_id: msgId },
      action: { value },
    });

    // 1. Default 'all' view shows aggregated Feishu sessions with source tags and deduplication
    const allRes = await handleCardAction(ctx, makeTopicEvent({ cmd: 'sessions', inplace: true }));
    assert.ok(allRes.card?.data?.header?.title?.content.includes('全部飞书'));
    const allMd = allRes.card?.data?.body?.elements?.find((e) => e.tag === 'markdown')?.content || '';
    assert.ok(allMd.includes('[本话题]'));
    assert.ok(allMd.includes('[私聊]'));
    assert.ok(allMd.includes('[同群话题]'));
    assert.ok(allMd.includes('本话题重复摘要'));
    assert.ok(!allMd.includes('旧版重复摘要'));
    assert.equal(allMd.split('conv-dup').length - 1, 1);

    // 2. Switching to 'current' view only shows current topic sessions
    const curRes = await handleCardAction(ctx, makeTopicEvent({ cmd: 'sessions', scope: 'current', inplace: true }));
    assert.ok(curRes.card?.data?.header?.title?.content.includes('本话题'));
    const curMd = curRes.card?.data?.body?.elements?.find((e) => e.tag === 'markdown')?.content || '';
    assert.ok(curMd.includes('本话题任务'));
    assert.ok(!curMd.includes('私聊历史任务'));
    assert.ok(!curMd.includes('同群其他话题任务'));

    // 3. Empty current topic shows prompt with '全部飞书' tab
    const emptyRes = await handleCardAction(ctx, makeTopicEvent({ cmd: 'sessions', scope: 'current', inplace: true }, 'om_empty_card_1'));
    assert.equal(emptyRes.card?.data?.header?.title?.content, '🗂️ 最近会话 · 本话题');
    const emptyJson = JSON.stringify(emptyRes.card?.data);
    assert.ok(emptyJson.includes('📱 全部飞书'));

    // 4. Switching to a cross-chat session updates conversationId, syncs valid cwd, and keeps scope='all'
    const useRes = await handleCardAction(ctx, makeTopicEvent({ cmd: 'use', arg: 'conv-p2p-1', scope: 'all', inplace: true }));
    assert.equal(useRes.toast.type, 'success');
    assert.ok(useRes.card?.data?.header?.title?.content.includes('全部飞书'));
    const afterSt = loadState();
    assert.equal(afterSt.chats['oc_topic_grp#om_cur_root'].conversationId, 'conv-p2p-1');
    assert.equal(afterSt.chats['oc_topic_grp#om_cur_root'].cwd, p2pDir);
    assert.equal(afterSt.chats.oc_topic_grp?.cwd, undefined);
  });
});
