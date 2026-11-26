import fs from 'node:fs';
import path from 'node:path';
import {
  loadConfig,
  loadState,
  resolveRiskyApprovalEnabled,
  stripProcessProxyEnv,
} from './lib/config.mjs';
import { readStdinWithTimeout } from './lib/io-utils.mjs';
import {
  buildApprovalCard,
  classifyCommandRisk,
  createApprovalRequest,
  updateApprovalRequestMeta,
  waitForApprovalDecision,
} from './lib/command-guard.mjs';

function writeDecision(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function passThrough() {
  // Intentionally emit no stdout so Antigravity treats the hook as a no-op pass-through.
}

async function run() {
  if (process.env.FEISHU_REMOTE_BRIDGE_CHILD !== '1') {
    passThrough();
    return;
  }

  const rawStdin = await readStdinWithTimeout(2000);
  let payload = {};
  if (rawStdin.trim()) {
    try {
      payload = JSON.parse(rawStdin);
    } catch {
      payload = {};
    }
  }

  const commandLine = String(
    payload?.toolCall?.args?.CommandLine ?? payload?.toolCall?.args?.command ?? '',
  ).trim();
  if (!commandLine) {
    passThrough();
    return;
  }

  const config = loadConfig();
  if (!resolveRiskyApprovalEnabled(config)) {
    passThrough();
    return;
  }

  const risk = classifyCommandRisk(commandLine);
  if (!risk.risky) {
    passThrough();
    return;
  }

  if (String(process.env.FEISHU_REMOTE_MODE || '').trim().toLowerCase() === 'plan') {
    writeDecision({
      decision: 'deny',
      reason: 'Risky command blocked in read-only plan mode (fail-closed).',
    });
    return;
  }

  const cwd = String(payload?.cwd || process.cwd());
  const state = loadState();
  const openId =
    process.env.FEISHU_REMOTE_OPEN_ID ||
    config.notifications?.defaultReceiveId ||
    config.security?.allowedOpenIds?.[0] ||
    '';
  const chatId =
    process.env.FEISHU_REMOTE_CHAT_ID ||
    (openId ? state.lastP2pChatByOpenId?.[openId] : '') ||
    '';
  const sessionKey = process.env.FEISHU_REMOTE_SESSION_KEY || chatId || openId;
  const threadRootId = process.env.FEISHU_REMOTE_THREAD_ROOT_ID || '';

  const configuredTimeoutSec = Math.max(
    15,
    Math.min(160, Number(config.security?.approvalTimeoutSeconds || 120)),
  );
  const envTimeoutMs = Number(process.env.FEISHU_REMOTE_TEST_APPROVAL_TIMEOUT_MS || 0);
  const timeoutMs = Number.isFinite(envTimeoutMs) && envTimeoutMs > 0
    ? envTimeoutMs
    : configuredTimeoutSec * 1000;

  const request = createApprovalRequest({
    commandLine,
    cwd,
    risk,
    chatId,
    openId,
    sessionKey,
    threadRootId,
    timeoutSeconds: configuredTimeoutSec,
  });

  const captureFile = process.env.FEISHU_REMOTE_TEST_CAPTURE_CARD_FILE;
  const skipSend = process.env.FEISHU_REMOTE_TEST_APPROVAL_SKIP_SEND === '1' || Boolean(captureFile);
  let feishuCtx = null;

  if (captureFile) {
    const card = buildApprovalCard({ request, status: 'pending' });
    fs.mkdirSync(path.dirname(captureFile), { recursive: true });
    fs.writeFileSync(captureFile, `${JSON.stringify({ request, card }, null, 2)}\n`, 'utf8');
  }

  if (!skipSend) {
    if (!config.feishu?.appId || !config.feishu?.appSecret || (!chatId && !openId)) {
      writeDecision({
        decision: 'deny',
        reason: 'Failed to send Feishu approval request (missing Feishu target or credentials, fail-closed).',
      });
      return;
    }

    try {
      const feishuApi = await import('./lib/feishu-api.mjs');
      const { sendCardToTarget } = await import('./lib/bridge-helpers.mjs');
      stripProcessProxyEnv(config.feishu.proxy);
      const client = feishuApi.createFeishuClient(config, { quiet: true });
      const card = buildApprovalCard({ request, status: 'pending' });
      const sentMsgId = await sendCardToTarget(client, {
        chatId,
        openId,
        card,
        replyToMessageId: threadRootId,
        replyInThread: Boolean(threadRootId),
      });
      if (sentMsgId) {
        updateApprovalRequestMeta(request.id, { messageId: sentMsgId });
      }
      feishuCtx = { client, patchCard: feishuApi.patchCard, messageId: sentMsgId || '' };
    } catch (err) {
      writeDecision({
        decision: 'deny',
        reason: `Failed to send Feishu approval request (fail-closed): ${err?.message || err}`,
      });
      return;
    }
  }

  const outcome = await waitForApprovalDecision(request.id, {
    timeoutMs,
    pollMs: envTimeoutMs > 0 ? 40 : 300,
  });

  if (outcome.decision === 'allow') {
    writeDecision({
      decision: 'allow',
    });
    return;
  }

  if (outcome.timedOut && feishuCtx?.messageId) {
    try {
      await feishuCtx.patchCard(feishuCtx.client, {
        messageId: feishuCtx.messageId,
        card: buildApprovalCard({ request, status: 'expired' }),
      });
    } catch {
      // Ignore expired card patch error
    }
  }

  writeDecision({
    decision: 'deny',
    reason: outcome.timedOut
      ? `Feishu approval timed out after ${configuredTimeoutSec}s (fail-closed).`
      : 'Denied by user via Feishu card.',
  });
}

try {
  await run();
} catch (err) {
  if (process.env.FEISHU_REMOTE_BRIDGE_CHILD === '1') {
    writeDecision({
      decision: 'deny',
      reason: `Feishu approval hook error (fail-closed): ${err?.message || err}`,
    });
  } else {
    passThrough();
  }
} finally {
  process.exit(0);
}
