import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import {
  createTestEnv,
  seedDefaultTestConfig,
  seedFakeGeminiStores,
} from './helpers.mjs';

const env = createTestEnv('feishu-hooks-stop-');
const { getApprovalsDir, getPluginRoot, saveState } = await import('../scripts/lib/config.mjs');
const { writeApprovalDecision } = await import('../scripts/lib/command-guard.mjs');
const pluginRoot = getPluginRoot();

function runHookSubprocess(scriptRel, { extraEnv = {}, stdinData = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(pluginRoot, scriptRel)], {
      env: { ...process.env, FEISHU_REMOTE_BRIDGE_CHILD: '0', ...extraEnv },
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

describe('Stop hook & PreToolUse hook subprocess contracts', () => {
  before(() => {
    seedDefaultTestConfig(env.workDir);
    seedFakeGeminiStores(env.geminiDir, {
      desktopRows: [
        {
          id: 'desk-stop-1',
          title: '桌面端完成通知测试',
          preview: '完成',
          stepCount: 4,
          modified: new Date().toISOString(),
          workspaces: JSON.stringify([`file://${env.workDir}`]),
        },
      ],
      transcripts: {
        'desk-stop-1': {
          source: 'desktop',
          compact: [
            { step_index: 1, type: 'USER_INPUT', created_at: '2026-11-26T04:00:00Z', content: '检查构建' },
            { step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-26T04:00:10Z', content: '所有构建检查均已通过，未发现回归。' },
          ],
          full: [
            { step_index: 1, type: 'USER_INPUT', created_at: '2026-11-26T04:00:00Z', content: '检查构建' },
            { step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-26T04:00:10Z', content: '所有构建检查均已通过，未发现回归。' },
          ],
        },
      },
    });
  });

  after(() => {
    env.cleanup();
  });

  it('stop-notify.mjs builds card with reply preview & action buttons and deduplicates repeats', async () => {
    const captureFile = path.join(env.root, 'stop-card-1.json');
    const transcriptFile = path.join(
      env.geminiDir,
      'antigravity',
      'brain',
      'desk-stop-1',
      '.system_generated',
      'logs',
      'transcript_full.jsonl',
    );

    const res1 = await runHookSubprocess('scripts/stop-notify.mjs', {
      extraEnv: { FEISHU_REMOTE_TEST_CAPTURE_CARD_FILE: captureFile },
      stdinData: JSON.stringify({
        conversationId: 'desk-stop-1',
        cwd: env.workDir,
        modelName: 'gemini-4-neon-high',
        lastUserInput: '帮我检查一下构建状态',
        transcriptPath: transcriptFile,
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
      }),
    });
    assert.equal(res1.code, 0);
    assert.equal(res1.stdout.trim(), '{}');
    assert.equal(fs.existsSync(captureFile), true);

    const captured = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    const cardJson = JSON.stringify(captured.card);
    assert.equal(captured.card.header.title.content, '🔔 本地 Antigravity 任务已完成');
    assert.ok(cardJson.includes('结果预览'));
    assert.ok(cardJson.includes('所有构建检查均已通过'));
    assert.ok(cardJson.includes('"cmd":"takeover"'));
    assert.ok(cardJson.includes('"cmd":"desktop_last_reply"'));

    // Dedup within 15s for the same conversationId
    const captureDup = path.join(env.root, 'stop-card-dup.json');
    const resDup = await runHookSubprocess('scripts/stop-notify.mjs', {
      extraEnv: { FEISHU_REMOTE_TEST_CAPTURE_CARD_FILE: captureDup },
      stdinData: JSON.stringify({
        conversationId: 'desk-stop-1',
        cwd: env.workDir,
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
      }),
    });
    assert.equal(resDup.code, 0);
    assert.equal(fs.existsSync(captureDup), false);

    // Error card path with conversationId lookup (no transcriptPath)
    const captureErr = path.join(env.root, 'stop-card-err.json');
    const resErr = await runHookSubprocess('scripts/stop-notify.mjs', {
      extraEnv: { FEISHU_REMOTE_TEST_CAPTURE_CARD_FILE: captureErr },
      stdinData: JSON.stringify({
        conversationId: 'desk-stop-err-2',
        cwd: env.workDir,
        error: 'compile failed',
        fullyIdle: true,
        terminationReason: 'ERROR',
      }),
    });
    assert.equal(resErr.code, 0);
    const capturedErr = JSON.parse(fs.readFileSync(captureErr, 'utf8'));
    assert.equal(capturedErr.card.header.title.content, '⚠️ 本地 Antigravity 任务异常结束');
    assert.ok(JSON.stringify(capturedErr.card).includes('compile failed'));
  });

  it('stop-notify.mjs routes to bound open topic thread and falls back to P2P dual options when unlinked or unbound', async () => {
    // 1. Bound desktop topic thread -> routes into thread with sync button
    saveState({
      chats: {
        'oc_topic_r#om_root_desk': {
          conversationId: 'cli-sub-1',
          originDesktopSession: { id: 'desk-route-1', title: 'Desktop Route' },
          topicClosed: false,
          lastActiveAt: Date.now(),
        },
      },
      lastP2pChatByOpenId: {},
      lastTopicChatId: 'oc_topic_r',
    });

    const capDeskTopic = path.join(env.root, 'stop-route-desk-topic.json');
    const r1 = await runHookSubprocess('scripts/stop-notify.mjs', {
      extraEnv: { FEISHU_REMOTE_TEST_CAPTURE_CARD_FILE: capDeskTopic },
      stdinData: JSON.stringify({
        conversationId: 'desk-route-1',
        cwd: env.workDir,
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
      }),
    });
    assert.equal(r1.code, 0);
    const d1 = JSON.parse(fs.readFileSync(capDeskTopic, 'utf8'));
    assert.equal(d1.route, 'topic_thread');
    assert.equal(d1.threadRootId, 'om_root_desk');
    assert.equal(d1.matchType, 'desktop');
    assert.ok(d1.card.header.title.content.includes('已回流本话题'));
    assert.ok(JSON.stringify(d1.card).includes('"cmd":"desktop_sync_latest"'));
    assert.ok(JSON.stringify(d1.card).includes('"cmd":"unlink_topic"'));

    // 2. Bound CLI topic thread -> routes into thread with desktop_last_reply primary
    saveState({
      chats: {
        'oc_topic_r#om_root_cli': {
          conversationId: 'cli-route-2',
          topicClosed: false,
          lastActiveAt: Date.now(),
        },
      },
      lastP2pChatByOpenId: {},
      lastTopicChatId: 'oc_topic_r',
    });
    const capCliTopic = path.join(env.root, 'stop-route-cli-topic.json');
    const r2 = await runHookSubprocess('scripts/stop-notify.mjs', {
      extraEnv: { FEISHU_REMOTE_TEST_CAPTURE_CARD_FILE: capCliTopic },
      stdinData: JSON.stringify({
        conversationId: 'cli-route-2',
        cwd: env.workDir,
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
      }),
    });
    assert.equal(r2.code, 0);
    const d2 = JSON.parse(fs.readFileSync(capCliTopic, 'utf8'));
    assert.equal(d2.route, 'topic_thread');
    assert.equal(d2.threadRootId, 'om_root_cli');
    assert.equal(d2.matchType, 'cli');
    assert.ok(JSON.stringify(d2.card).includes('"cmd":"desktop_last_reply"'));

    // 3. Closed/unlinked topic + known topic group -> routes to P2P with dual takeover buttons
    saveState({
      chats: {
        'oc_topic_r#om_root_closed': {
          conversationId: 'desk-route-3',
          originDesktopSession: { id: 'desk-route-3', title: 'Closed' },
          topicClosed: true,
          lastActiveAt: Date.now(),
        },
      },
      lastP2pChatByOpenId: {},
      lastTopicChatId: 'oc_topic_r',
    });
    const capP2pDual = path.join(env.root, 'stop-route-p2p-dual.json');
    const r3 = await runHookSubprocess('scripts/stop-notify.mjs', {
      extraEnv: { FEISHU_REMOTE_TEST_CAPTURE_CARD_FILE: capP2pDual },
      stdinData: JSON.stringify({
        conversationId: 'desk-route-3',
        cwd: env.workDir,
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
      }),
    });
    assert.equal(r3.code, 0);
    const d3 = JSON.parse(fs.readFileSync(capP2pDual, 'utf8'));
    assert.equal(d3.route, 'p2p');
    assert.equal(d3.hasTopicGroup, true);
    assert.ok(JSON.stringify(d3.card).includes('"cmd":"takeover_new_topic"'));
    assert.ok(JSON.stringify(d3.card).includes('"cmd":"takeover"'));
  });

  it('pre-tool-approval.mjs emits strictly empty stdout on pass-through paths (never {})', async () => {
    const nonBridge = await runHookSubprocess('scripts/pre-tool-approval.mjs', {
      extraEnv: { FEISHU_REMOTE_BRIDGE_CHILD: '0' },
      stdinData: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /tmp/x' } } }),
    });
    assert.equal(nonBridge.code, 0);
    assert.equal(nonBridge.stdout, '');

    const bridgeSafe = await runHookSubprocess('scripts/pre-tool-approval.mjs', {
      extraEnv: { FEISHU_REMOTE_BRIDGE_CHILD: '1' },
      stdinData: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'node scripts/cli.mjs status' } } }),
    });
    assert.equal(bridgeSafe.code, 0);
    assert.equal(bridgeSafe.stdout, '');

    const emptyCmd = await runHookSubprocess('scripts/pre-tool-approval.mjs', {
      extraEnv: { FEISHU_REMOTE_BRIDGE_CHILD: '1' },
      stdinData: JSON.stringify({ toolCall: { name: 'run_command', args: {} } }),
    });
    assert.equal(emptyCmd.code, 0);
    assert.equal(emptyCmd.stdout, '');
  });

  it('pre-tool-approval.mjs captures approval card, handles allow/deny, and fails closed on timeout', async () => {
    const captureAllow = path.join(env.root, 'approval-allow.json');
    const existing = new Set(
      fs.existsSync(getApprovalsDir())
        ? fs.readdirSync(getApprovalsDir()).filter((n) => n.endsWith('.req.json'))
        : [],
    );

    const allowChild = spawn(process.execPath, [path.join(pluginRoot, 'scripts', 'pre-tool-approval.mjs')], {
      env: {
        ...process.env,
        FEISHU_REMOTE_BRIDGE_CHILD: '1',
        FEISHU_REMOTE_TEST_CAPTURE_CARD_FILE: captureAllow,
        FEISHU_REMOTE_TEST_APPROVAL_TIMEOUT_MS: '3000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let allowOut = '';
    allowChild.stdout.on('data', (d) => { allowOut += d.toString('utf8'); });
    allowChild.stdin.write(JSON.stringify({
      toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf ./dist' } },
      cwd: env.workDir,
    }));
    allowChild.stdin.end();

    const deadline = Date.now() + 2500;
    let foundReqId = '';
    while (Date.now() < deadline) {
      if (fs.existsSync(getApprovalsDir())) {
        const nextFile = fs.readdirSync(getApprovalsDir()).find((n) => n.endsWith('.req.json') && !existing.has(n));
        if (nextFile) {
          foundReqId = nextFile.replace(/\.req\.json$/, '');
          writeApprovalDecision(foundReqId, { decision: 'allow', decidedBy: 'ou_test_owner' });
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(foundReqId, 'Approval request file should have been created');
    await new Promise((r) => allowChild.once('close', r));

    assert.equal(JSON.parse(allowOut).decision, 'allow');
    const capturedCard = JSON.parse(fs.readFileSync(captureAllow, 'utf8'));
    assert.equal(capturedCard.card.header.title.content, '🛡️ 高危命令审批请求');
    assert.ok(JSON.stringify(capturedCard.card).includes('"decision":"allow"'));
    assert.ok(JSON.stringify(capturedCard.card).includes('"decision":"deny"'));

    // Deny case
    const existing2 = new Set(fs.readdirSync(getApprovalsDir()).filter((n) => n.endsWith('.req.json')));
    const denyChild = spawn(process.execPath, [path.join(pluginRoot, 'scripts', 'pre-tool-approval.mjs')], {
      env: {
        ...process.env,
        FEISHU_REMOTE_BRIDGE_CHILD: '1',
        FEISHU_REMOTE_TEST_APPROVAL_SKIP_SEND: '1',
        FEISHU_REMOTE_TEST_APPROVAL_TIMEOUT_MS: '3000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let denyOut = '';
    denyChild.stdout.on('data', (d) => { denyOut += d.toString('utf8'); });
    denyChild.stdin.write(JSON.stringify({
      toolCall: { name: 'run_command', args: { CommandLine: 'git reset --hard HEAD~1' } },
      cwd: env.workDir,
    }));
    denyChild.stdin.end();

    const deadline2 = Date.now() + 2500;
    let foundReqId2 = '';
    while (Date.now() < deadline2) {
      const nextFile = fs.readdirSync(getApprovalsDir()).find((n) => n.endsWith('.req.json') && !existing2.has(n));
      if (nextFile) {
        foundReqId2 = nextFile.replace(/\.req\.json$/, '');
        writeApprovalDecision(foundReqId2, { decision: 'deny', decidedBy: 'ou_test_owner' });
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(foundReqId2);
    await new Promise((r) => denyChild.once('close', r));
    assert.equal(JSON.parse(denyOut).decision, 'deny');
  });
});
