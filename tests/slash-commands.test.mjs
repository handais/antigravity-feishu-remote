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

const env = createTestEnv('feishu-slash-cmds-');
let config;

const { loadConfig, loadState, resolveRiskyApprovalEnabled, saveState } = await import('../scripts/lib/config.mjs');
const { resolveEffectiveTimeoutSeconds } = await import('../scripts/lib/bridge-helpers.mjs');
const { handleSlashCommand } = await import('../scripts/lib/slash-commands.mjs');

describe('slash-commands coverage', () => {
  before(() => {
    config = seedDefaultTestConfig(env.workDir);
    fs.mkdirSync(path.join(env.workDir, 'sub-alpha'), { recursive: true });
    fs.mkdirSync(path.join(env.workDir, '.hidden-dir'), { recursive: true });
    seedFakeGeminiStores(env.geminiDir, {
      cliRows: [
        {
          id: 'cli-slash-1',
          title: 'Slash 测试会话',
          preview: 'done',
          stepCount: 3,
          modified: '2026-11-26T03:00:00Z',
          workspaces: JSON.stringify([`file://${env.workDir}`]),
        },
      ],
      transcripts: {
        'cli-slash-1': {
          source: 'cli',
          compact: [
            { step_index: 1, type: 'USER_INPUT', created_at: '2026-11-26T03:00:00Z', content: '测试' },
            { step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-26T03:00:10Z', content: '完成' },
          ],
          full: [
            { step_index: 1, type: 'USER_INPUT', created_at: '2026-11-26T03:00:00Z', content: '测试' },
            { step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-26T03:00:10Z', content: '完成' },
          ],
        },
      },
    });

    saveState({
      chats: {
        oc_slash: {
          conversationId: 'cli-slash-1',
          cwd: env.workDir,
          mode: 'accept-edits',
          model: '',
          effort: '',
          recentConversations: [{ id: 'cli-slash-1', summary: 'Slash 测试会话', updatedAt: new Date().toISOString() }],
          originDesktopSession: { id: 'desk-0', title: 'Origin Doc' },
          lastTurnArtifacts: { conversationId: 'cli-slash-1', cwd: env.workDir, files: [] },
          pendingHandoff: null,
        },
      },
      lastP2pChatByOpenId: { ou_test_owner: 'oc_slash' },
    });
  });

  after(() => {
    env.cleanup();
  });

  async function runCmd(text, ctxOverrides = {}) {
    const { client, calls } = createMockFeishuClient();
    const ctx = createBridgeContext({ client, ...ctxOverrides });
    const handled = await handleSlashCommand(ctx, {
      text,
      chatId: 'oc_slash',
      openId: 'ou_test_owner',
      messageId: 'om_cmd_1',
      sessionKey: 'oc_slash',
      config: loadConfig(),
    });
    return { handled, calls };
  }

  it('handles /help, /status, /panel, and unknown commands', async () => {
    const help = await runCmd('/help');
    assert.equal(help.handled, true);
    assert.ok(JSON.stringify(help.calls.repliedCards[0].card).includes('/handoff'));
    assert.ok(JSON.stringify(help.calls.repliedCards[0].card).includes('/guard'));

    const status = await runCmd('/status');
    assert.equal(status.handled, true);
    const statusJson = JSON.stringify(status.calls.repliedCards[0].card);
    assert.ok(statusJson.includes('Origin Doc'));
    assert.ok(statusJson.includes('高危命令审批'));

    const panel = await runCmd('/panel');
    assert.equal(panel.handled, true);
    assert.ok(JSON.stringify(panel.calls.repliedCards[0].card).includes('交回电脑'));

    const unknown = await runCmd('/not_a_real_command');
    assert.equal(unknown.handled, false);
  });

  it('handles /handoff cli, /handoff desktop, and /guard on|off', async () => {
    const hCli = await runCmd('/handoff');
    assert.equal(hCli.handled, true);
    assert.ok(fs.readFileSync(env.clipboardFile, 'utf8').includes('--conversation cli-slash-1'));

    const hDesk = await runCmd('/back desktop');
    assert.equal(hDesk.handled, true);
    assert.ok(fs.readFileSync(env.clipboardFile, 'utf8').includes('[手机飞书端进展回流]'));

    const gOff = await runCmd('/guard off');
    assert.equal(gOff.handled, true);
    assert.equal(resolveRiskyApprovalEnabled(loadConfig()), false);

    const gOn = await runCmd('/approval on');
    assert.equal(gOn.handled, true);
    assert.equal(resolveRiskyApprovalEnabled(loadConfig()), true);
  });

  it('handles /cd, /dirs, /mode, /timeout, /effort, /notify, /new, and /use', async () => {
    const cdOk = await runCmd('/cd sub-alpha');
    assert.equal(cdOk.handled, true);
    assert.ok(JSON.stringify(cdOk.calls.repliedCards[0].card).includes('sub-alpha'));

    const cdBack = await runCmd(`/cd ${env.workDir}`);
    assert.equal(cdBack.handled, true);

    const cdMissing = await runCmd('/cd non-existent-folder-xyz');
    assert.equal(cdMissing.handled, true);
    assert.ok(JSON.stringify(cdMissing.calls.repliedCards[0].card).includes('未找到匹配目录'));

    const dirsShow = await runCmd('/dirs -a');
    assert.equal(dirsShow.handled, true);
    assert.ok(JSON.stringify(dirsShow.calls.repliedCards[0].card).includes('.hidden-dir'));

    const modeTemp = await runCmd('/mode full 15m');
    assert.equal(modeTemp.handled, true);
    assert.ok(JSON.stringify(modeTemp.calls.repliedCards[0].card).includes('临时 15 分钟'));

    const timeoutMenuRes = await runCmd('/timeout');
    assert.equal(timeoutMenuRes.handled, true);
    const timeoutMenuJson = JSON.stringify(timeoutMenuRes.calls.repliedCards[0].card);
    assert.ok(timeoutMenuJson.includes('单轮任务超时设置'));
    assert.ok(timeoutMenuJson.includes('"cmd":"timeout_set"'));

    // Simulate a prior per-chat override (e.g. from /goal board) and ensure /timeout clears it
    const stBeforeTimeout = loadState();
    stBeforeTimeout.chats.oc_slash = { ...(stBeforeTimeout.chats.oc_slash || {}), timeoutSeconds: 0 };
    saveState(stBeforeTimeout);

    const timeoutRes = await runCmd('/timeout 90m');
    assert.equal(timeoutRes.handled, true);
    assert.equal(loadConfig().agy.timeoutSeconds, 5400);
    assert.equal(loadState().chats.oc_slash?.timeoutSeconds, undefined);
    assert.equal(resolveEffectiveTimeoutSeconds(loadState().chats.oc_slash, loadConfig()), 5400);
    assert.ok(JSON.stringify(timeoutRes.calls.repliedCards[0].card).includes('已清除本会话覆盖'));

    const effortRes = await runCmd('/effort high');
    assert.equal(effortRes.handled, true);
    assert.ok(JSON.stringify(effortRes.calls.repliedCards[0].card).includes('high'));

    const muteRes = await runCmd('/mute');
    assert.equal(muteRes.handled, true);
    assert.equal(loadConfig().notifications.stopNotifyMode, 'off');

    const unmuteRes = await runCmd('/notify away 5');
    assert.equal(unmuteRes.handled, true);
    assert.equal(loadConfig().notifications.stopNotifyMode, 'away');
    assert.equal(loadConfig().notifications.awayIdleSeconds, 300);

    const quickUnknown = await runCmd('/quick');
    assert.equal(quickUnknown.handled, false);

    const useRes = await runCmd('/use 1');
    assert.equal(useRes.handled, true);
    const newRes = await runCmd('/new');
    assert.equal(newRes.handled, true);
    assert.ok(JSON.stringify(newRes.calls.repliedCards[0].card).includes('已开启新对话'));
  });

  it('handles /topic set|clear and /unlink', async () => {
    const { client: c1, calls: calls1 } = createMockFeishuClient();
    const ctx1 = createBridgeContext({ client: c1 });
    // /topic set outside topic thread warns
    const warnSet = await handleSlashCommand(ctx1, {
      text: '/topic set',
      chatId: 'oc_slash',
      openId: 'ou_test_owner',
      messageId: 'om_t0',
      sessionKey: 'oc_slash',
      replyInThread: false,
      config: loadConfig(),
    });
    assert.equal(warnSet, true);
    assert.ok(JSON.stringify(calls1.repliedCards[0].card).includes('请在话题群内使用'));

    // /topic set inside topic thread binds defaultTopicChatId
    const { client: c2, calls: calls2 } = createMockFeishuClient();
    const ctx2 = createBridgeContext({ client: c2 });
    await handleSlashCommand(ctx2, {
      text: '/topic set',
      chatId: 'oc_topic_bound',
      openId: 'ou_test_owner',
      messageId: 'om_t1',
      sessionKey: 'oc_topic_bound#om_root_t1',
      threadRootId: 'om_root_t1',
      replyInThread: true,
      config: loadConfig(),
    });
    assert.equal(loadConfig().notifications.defaultTopicChatId, 'oc_topic_bound');
    assert.ok(JSON.stringify(calls2.repliedCards[0].card).includes('已绑定默认接管话题群'));

    const statusTopic = await runCmd('/topic');
    assert.ok(JSON.stringify(statusTopic.calls.repliedCards[0].card).includes('oc_topic_bound'));

    await runCmd('/topic clear');
    assert.equal(loadConfig().notifications.defaultTopicChatId, '');

    const unlinkRes = await runCmd('/unlink');
    assert.equal(unlinkRes.handled, true);
    assert.ok(JSON.stringify(unlinkRes.calls.repliedCards[0].card).includes('已结束当前对话的电脑端自动回流追踪'));
  });

  it('handles /, /skills, and /agy <raw> passthrough', async () => {
    const slashMenu = await runCmd('/');
    assert.equal(slashMenu.handled, true);
    assert.equal(slashMenu.calls.repliedCards[0]?.card?.header?.title?.content, '🧩 agy 命令与本机技能');

    const skillsCmd = await runCmd('/skills');
    assert.equal(skillsCmd.handled, true);
    assert.equal(skillsCmd.calls.repliedCards[0]?.card?.header?.title?.content, '🧩 agy 命令与本机技能');

    const enqueued = [];
    const agyPassthrough = await runCmd('/agy /help', {
      runner: {
        getQueueForChat: () => [],
        totalQueuedCount: () => 0,
        enqueueOrExecutePrompt: async (p) => { enqueued.push(p); },
        executePrompt: async () => {},
      },
    });
    assert.equal(agyPassthrough.handled, true);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].text, '/help');
  });

  it('handles /sessions scope switching and cross-chat /use inside a topic thread', async () => {
    const otherDir = path.join(env.workDir, 'topic-other-dir');
    fs.mkdirSync(otherDir, { recursive: true });

    const st = loadState();
    const now = Date.now();
    st.lastP2pChatByOpenId = { ...st.lastP2pChatByOpenId, ou_test_owner: 'oc_p2p_chat' };
    st.chats.oc_p2p_chat = {
      conversationId: 'p2p-topic-cross-1',
      cwd: otherDir,
      mode: 'accept-edits',
      recentConversations: [
        { id: 'p2p-topic-cross-1', summary: '来自私聊的跨端会话', updatedAt: new Date(now + 60_000).toISOString(), cwd: otherDir },
      ],
    };
    st.chats['oc_grp_t#om_root_x'] = {
      conversationId: 'topic-cur-1',
      cwd: env.workDir,
      mode: 'accept-edits',
      recentConversations: [
        { id: 'topic-cur-1', summary: '当前话题会话', updatedAt: new Date(now + 120_000).toISOString(), cwd: env.workDir },
      ],
    };
    saveState(st);

    async function runTopicCmd(text) {
      const { client, calls } = createMockFeishuClient();
      const ctx = createBridgeContext({ client });
      const handled = await handleSlashCommand(ctx, {
        text,
        chatId: 'oc_grp_t',
        openId: 'ou_test_owner',
        messageId: 'om_topic_msg',
        sessionKey: 'oc_grp_t#om_root_x',
        threadRootId: 'om_root_x',
        replyInThread: true,
        config: loadConfig(),
      });
      return { handled, calls };
    }

    // 1. Default /sessions renders '全部飞书' including [本话题] and [私聊]
    const allSess = await runTopicCmd('/sessions');
    assert.equal(allSess.handled, true);
    const allCard = allSess.calls.repliedCards[0].card;
    assert.ok(allCard.header.title.content.includes('全部飞书'));
    const allJson = JSON.stringify(allCard);
    assert.ok(allJson.includes('[本话题]'));
    assert.ok(allJson.includes('[私聊]'));
    assert.ok(allJson.includes('p2p-topi'));

    // 2. /use 2 matches index 2 in 'all' view (p2p-topic-cross-1) and syncs cwd
    const useIdx2 = await runTopicCmd('/use 2');
    assert.equal(useIdx2.handled, true);
    assert.ok(JSON.stringify(useIdx2.calls.repliedCards[0].card).includes('p2p-topic-cross-1'));
    assert.ok(JSON.stringify(useIdx2.calls.repliedCards[0].card).includes('已同步工作目录'));
    assert.equal(loadState().chats['oc_grp_t#om_root_x'].conversationId, 'p2p-topic-cross-1');
    assert.equal(loadState().chats['oc_grp_t#om_root_x'].cwd, otherDir);

    // 3. /sessions here switches to 'current' view and updates lastSessionsScope
    const curSess = await runTopicCmd('/sessions here');
    assert.equal(curSess.handled, true);
    const curCard = curSess.calls.repliedCards[0].card;
    assert.ok(curCard.header.title.content.includes('本话题'));
    assert.ok(!JSON.stringify(curCard).includes('p2p-topi'));

    // 4. /use 1 now resolves against 'current' view (topic-cur-1)
    const useIdx1 = await runTopicCmd('/use 1');
    assert.equal(useIdx1.handled, true);
    assert.equal(loadState().chats['oc_grp_t#om_root_x'].conversationId, 'topic-cur-1');

    // 5. /use <prefix> resolves cross-chat sessions even when lastSessionsScope is 'current'
    const usePrefix = await runTopicCmd('/use p2p-topic');
    assert.equal(usePrefix.handled, true);
    assert.equal(loadState().chats['oc_grp_t#om_root_x'].conversationId, 'p2p-topic-cross-1');
  });

  it('displays pendingCommand in /status and clears it on /cancel or /new when idle', async () => {
    const st = loadState();
    st.chats.oc_slash.pendingCommand = { prefix: '/plan', kind: 'builtin', armedAt: Date.now() };
    saveState(st);

    const statusRes = await runCmd('/status');
    assert.equal(statusRes.handled, true);
    assert.ok(JSON.stringify(statusRes.calls.repliedCards[0].card).includes('/plan'));

    const cancelRes = await runCmd('/cancel');
    assert.equal(cancelRes.handled, true);
    assert.ok(JSON.stringify(cancelRes.calls.repliedCards[0].card).includes('已取消预选命令'));
    assert.equal(loadState().chats.oc_slash.pendingCommand, null);

    const st2 = loadState();
    st2.chats.oc_slash.pendingCommand = { prefix: '/boost', kind: 'builtin', armedAt: Date.now() };
    saveState(st2);

    const newRes = await runCmd('/new');
    assert.equal(newRes.handled, true);
    assert.equal(loadState().chats.oc_slash.pendingCommand, null);
    const newCard = newRes.calls.repliedCards[0].card;
    const newJson = JSON.stringify(newCard);
    assert.equal(newCard.header.title.content, '🆕 已开启新对话');
    assert.ok(newJson.includes('工作目录'));
    assert.ok(newJson.includes('执行模式'));
    assert.ok(newJson.includes('当前模型'));
    assert.ok(newJson.includes('推理强度'));
    assert.ok(newJson.includes('单轮超时'));
    assert.ok(newJson.includes('📁 切换目录'));
  });

  it('preserves multiline Markdown in /doc create, blocks /send sensitive files, validates /model, and resolves owner open_id safely', async () => {
    const { resolveOwnerOpenId } = await import('../scripts/lib/config.mjs');
    const cfg = loadConfig();
    cfg.notifications.defaultReceiveId = 'oc_group_not_open_id';
    cfg.notifications.defaultReceiveIdType = 'chat_id';
    cfg.security.allowedOpenIds = ['ou_real_owner'];
    assert.equal(resolveOwnerOpenId(cfg), 'ou_real_owner');
    assert.equal(resolveOwnerOpenId(cfg, 'ou_explicit'), 'ou_explicit');

    // Multiline /doc create keeps newlines cleanly
    let capturedDocBlocks = null;
    const docClient = {
      docx: {
        v1: {
          document: {
            create: async () => ({ code: 0, data: { document: { document_id: 'docx_ml_1', title: 'Multi', revision_id: 1 } } }),
            get: async () => ({ code: 0, data: { document: { title: 'Multi', revision_id: 1 } } }),
            convert: async ({ data }) => {
              capturedDocBlocks = data.content;
              return { code: 0, data: { first_level_block_ids: ['b1'], blocks: [{ block_id: 'b1', block_type: 2, text: { elements: [{ text_run: { content: 'ok' } }] } }] } };
            },
          },
          documentBlockDescendant: {
            create: async () => ({ code: 0, data: { children: [{ block_id: 'b1' }] } }),
          },
        },
      },
      drive: {
        v1: {
          permissionMember: {
            create: async () => ({ code: 0 }),
          },
        },
      },
      im: {
        v1: {
          message: {
            reply: async () => ({ code: 0, data: { message_id: 'om_doc_ok' } }),
          },
        },
      },
    };
    const docCtx = createBridgeContext({ client: docClient });
    const docRes = await handleSlashCommand(docCtx, {
      text: '/doc create Report | # Title\n\n- Line 1\n- Line 2',
      chatId: 'oc_slash',
      openId: 'ou_test_owner',
      messageId: 'om_doc_1',
      config: cfg,
    });
    assert.equal(docRes, true);
    assert.ok(capturedDocBlocks.includes('# Title\n\n- Line 1\n- Line 2'), `Expected newlines preserved, got: ${capturedDocBlocks}`);

    // /send rejects sensitive files (.env and ~/.gemini/*)
    const dotEnvFile = path.join(env.workDir, '.env');
    fs.writeFileSync(dotEnvFile, 'SECRET=123\n', 'utf8');
    const fakeGeminiDb = path.join(env.workDir, '.gemini', 'antigravity-cli', 'conversation_summaries.db');
    fs.mkdirSync(path.dirname(fakeGeminiDb), { recursive: true });
    fs.writeFileSync(fakeGeminiDb, 'sqlite', 'utf8');

    const { client: sendClient, calls: sendCalls } = createMockFeishuClient();
    const sendCtx = createBridgeContext({ client: sendClient });
    await handleSlashCommand(sendCtx, {
      text: `/send ${dotEnvFile}`,
      chatId: 'oc_slash',
      openId: 'ou_test_owner',
      messageId: 'om_send_env',
      config: cfg,
    });
    assert.ok(JSON.stringify(sendCalls.repliedCards.at(-1).card).includes('拒绝外发敏感文件'));

    await handleSlashCommand(sendCtx, {
      text: `/send ${fakeGeminiDb}`,
      chatId: 'oc_slash',
      openId: 'ou_test_owner',
      messageId: 'om_send_gemini',
      config: cfg,
    });
    assert.ok(JSON.stringify(sendCalls.repliedCards.at(-1).card).includes('拒绝外发敏感文件'));

    // /model rejects cmd.exe metacharacters
    const { client: modClient, calls: modCalls } = createMockFeishuClient();
    const modCtx = createBridgeContext({ client: modClient });
    await handleSlashCommand(modCtx, {
      text: '/model bad&calc',
      chatId: 'oc_slash',
      openId: 'ou_test_owner',
      messageId: 'om_mod_bad',
      config: cfg,
    });
    assert.ok(JSON.stringify(modCalls.repliedCards.at(-1).card).includes('无效模型名称'));
  });
});
