import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir, loadConfig, stripProcessProxyEnv } from './lib/config.mjs';
import { isSubagentConversation } from './lib/desktop-sessions.mjs';

const SKIP_REASONS = new Set(['TERMINAL_STEP_TYPE', 'USER_CANCELED', 'TERMINAL_CUSTOM_HOOK']);
const DEDUP_WINDOW_MS = 15_000;
const DEDUP_RETENTION_MS = 5 * 60_000;

function readStdinWithTimeout(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    process.stdin.resume();
  });
}

function shouldSkipByDedup(conversationId) {
  if (!conversationId) return false;
  try {
    const dedupPath = path.join(getConfigDir(), 'stop-notify-dedup.json');
    let map = {};
    if (fs.existsSync(dedupPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(dedupPath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          map = parsed;
        }
      } catch {
        map = {};
      }
    }
    const now = Date.now();
    for (const [k, ts] of Object.entries(map)) {
      if (!Number.isFinite(Number(ts)) || now - Number(ts) > DEDUP_RETENTION_MS) {
        delete map[k];
      }
    }
    const prevAt = Number(map[conversationId] || 0);
    if (prevAt > 0 && now - prevAt < DEDUP_WINDOW_MS) {
      return true;
    }
    map[conversationId] = now;
    fs.mkdirSync(path.dirname(dedupPath), { recursive: true, mode: 0o700 });
    const tmpPath = `${dedupPath}.tmp.${process.pid}.${now}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(map)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, dedupPath);
  } catch {
    // Best-effort dedup; ignore FS errors
  }
  return false;
}

async function run() {
  if (process.env.FEISHU_REMOTE_BRIDGE_CHILD === '1') {
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

  if (payload.continuationActive === true || payload.continuation_active === true) {
    return;
  }
  if (payload.fullyIdle === false || payload.fully_idle === false) {
    return;
  }

  const reason = String(payload.terminationReason || payload.termination_reason || 'COMPLETED')
    .trim()
    .toUpperCase();
  const isError = reason === 'ERROR' || Boolean(payload.error);
  if (!isError && SKIP_REASONS.has(reason)) {
    return;
  }

  const conversationId = String(payload.conversationId || payload.conversation_id || '').trim();
  if (conversationId && isSubagentConversation(conversationId)) {
    return;
  }

  const config = loadConfig();
  if (!config.notifications.stopHookEnabled) {
    return;
  }
  if (!config.feishu.appId || !config.feishu.appSecret) {
    return;
  }

  const receiveId = config.notifications.defaultReceiveId || config.security.allowedOpenIds?.[0] || '';
  const receiveIdType = config.notifications.defaultReceiveId
    ? config.notifications.defaultReceiveIdType || 'open_id'
    : 'open_id';
  if (!receiveId) {
    return;
  }

  if (shouldSkipByDedup(conversationId)) {
    return;
  }

  const {
    buildCard,
    createFeishuClient,
    sanitizeForFeishuMarkdown,
    sendCard,
  } = await import('./lib/feishu-api.mjs');

  stripProcessProxyEnv(config.feishu.proxy);
  const client = createFeishuClient(config, { quiet: true });

  const workspaceDir = String(payload.cwd || payload.workspacePaths?.[0] || '').trim();
  const workspaceName = workspaceDir ? path.basename(workspaceDir) || workspaceDir : '未指定目录';
  const modelName = String(payload.modelName || '').trim();
  const promptPreview = String(payload.lastUserInput || '').replace(/\s+/g, ' ').trim().slice(0, 120);

  const lines = [
    `- **工作区**：\`${workspaceName}\``,
    conversationId ? `- **会话 ID**：\`${conversationId.slice(0, 8)}\`` : '',
    modelName ? `- **模型**：\`${modelName}\`` : '',
    `- **结束状态**：\`${reason}\``,
  ].filter(Boolean);

  if (promptPreview) {
    lines.push(`- **任务内容**：${sanitizeForFeishuMarkdown(promptPreview)}`);
  }
  if (payload.error) {
    lines.push(`- **错误摘要**：\`${String(payload.error).slice(0, 160)}\``);
  }

  const actionRow = [];
  if (conversationId) {
    actionRow.push({
      label: '📱 接管此对话',
      type: 'primary',
      value: {
        cmd: 'takeover',
        arg: conversationId,
        cwd: workspaceDir,
        summary: promptPreview.slice(0, 48),
      },
    });
  }
  if (workspaceDir) {
    actionRow.push({
      label: '📂 切到此目录',
      value: { cmd: 'cd', arg: workspaceDir },
    });
  }
  actionRow.push({ label: '⚙️ 控制面板', value: { cmd: 'panel' } });

  const card = buildCard({
    title: isError ? '⚠️ 本地 Antigravity 任务异常结束' : '🔔 本地 Antigravity 任务已完成',
    template: isError ? 'orange' : 'green',
    markdown: lines.join('\n'),
    buttonRows: [actionRow],
    footer: conversationId
      ? '点「📱 接管此对话」可在手机飞书无缝续聊电脑端上下文'
      : '点下方按钮可快速切换目录或打开控制面板',
  });

  const timeoutPromise = new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error('Feishu notification timeout')), 5000);
    t.unref();
  });

  await Promise.race([
    sendCard(client, { receiveId, receiveIdType, card }),
    timeoutPromise,
  ]);
}

try {
  await run();
} catch (err) {
  console.error('[feishu-stop-notify] Ignored notification error:', err?.message || err);
} finally {
  process.stdout.write('{}\n');
  process.exit(0);
}
