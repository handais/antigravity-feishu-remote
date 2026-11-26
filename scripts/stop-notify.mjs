import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  getConfigDir,
  getPluginRoot,
  loadConfig,
  loadState,
  resolveStopNotifyMode,
  stripProcessProxyEnv,
} from './lib/config.mjs';
import {
  readStdinWithTimeout,
  sanitizeInlineCode,
  writePrivateJsonAtomic,
} from './lib/io-utils.mjs';
import {
  findBoundTopicForConversation,
  resolveDefaultTopicChatId,
} from './lib/bridge-helpers.mjs';
import { extractStopReplyPreview, isSubagentConversation } from './lib/desktop-sessions.mjs';

const SKIP_REASONS = new Set(['TERMINAL_STEP_TYPE', 'USER_CANCELED', 'TERMINAL_CUSTOM_HOOK']);
const DEDUP_WINDOW_MS = 15_000;
const DEDUP_RETENTION_MS = 5 * 60_000;

function getSystemIdleSeconds() {
  if (process.env.FEISHU_REMOTE_TEST_IDLE_SECONDS !== undefined) {
    const mockVal = Number(process.env.FEISHU_REMOTE_TEST_IDLE_SECONDS);
    return Number.isFinite(mockVal) && mockVal >= 0 ? Math.floor(mockVal) : null;
  }
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-c', 'IOHIDSystem'], {
        encoding: 'utf8',
        timeout: 1200,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = out.match(/"?HIDIdleTime"?\s*=\s*(\d+)/);
      if (match) {
        return Math.floor(Number(match[1]) / 1e9);
      }
    } else if (process.platform === 'linux') {
      const out = execFileSync('xprintidle', [], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const ms = Number(String(out || '').trim());
      if (Number.isFinite(ms) && ms >= 0) {
        return Math.floor(ms / 1000);
      }
    } else if (process.platform === 'win32') {
      const psScript = [
        "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class IdleTime { [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; } [DllImport(\"user32.dll\")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii); public static uint GetIdleMs() { LASTINPUTINFO lii = new LASTINPUTINFO(); lii.cbSize = (uint)Marshal.SizeOf(lii); return GetLastInputInfo(ref lii) ? unchecked((uint)Environment.TickCount - lii.dwTime) : 0; } }';",
        'Write-Output ([Math]::Floor([IdleTime]::GetIdleMs() / 1000))',
      ].join(' ');
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        encoding: 'utf8',
        timeout: 1800,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const sec = Number(String(out || '').trim());
      if (Number.isFinite(sec) && sec >= 0) {
        return Math.floor(sec);
      }
    }
  } catch {
    // Fail-open when idle probe is unavailable
  }
  return null;
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
    writePrivateJsonAtomic(dedupPath, map);
  } catch {
    // Best-effort dedup; ignore FS errors
  }
  return false;
}

async function run() {
  if (process.env.FEISHU_REMOTE_BRIDGE_CHILD === '1') {
    return;
  }

  const rawStdin = await readStdinWithTimeout(1200);
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
  const notifyMode = resolveStopNotifyMode(config);
  if (notifyMode === 'off') {
    return;
  }
  if (notifyMode === 'away') {
    const awayThreshold = Math.max(10, Number(config.notifications.awayIdleSeconds || 120));
    const idleSec = getSystemIdleSeconds();
    if (idleSec !== null && idleSec < awayThreshold) {
      return;
    }
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
    chunkButtons,
    createFeishuClient,
    replyCard,
    sanitizeForFeishuMarkdown,
    sendCard,
  } = await import('./lib/feishu-api.mjs');

  stripProcessProxyEnv(config.feishu.proxy);
  const client = createFeishuClient(config, { quiet: true });
  const state = loadState();
  const captureFile = process.env.FEISHU_REMOTE_TEST_CAPTURE_CARD_FILE;

  const workspaceDir = String(payload.cwd || payload.workspacePaths?.[0] || '').trim();
  const workspaceName = sanitizeInlineCode(
    workspaceDir ? path.basename(workspaceDir) || workspaceDir : '未指定目录',
    80,
  ) || '未指定目录';
  const modelName = sanitizeInlineCode(payload.modelName || '', 64);
  const promptPreview = String(payload.lastUserInput || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const replyPreviewInfo = extractStopReplyPreview({
    conversationId,
    transcriptPath: payload.transcriptPath || payload.transcript_path || '',
    maxChars: 360,
  });

  const lines = [
    `- **工作区**：\`${workspaceName}\``,
    conversationId ? `- **会话 ID**：\`${sanitizeInlineCode(conversationId.slice(0, 8), 16)}\`` : '',
    modelName ? `- **模型**：\`${modelName}\`` : '',
    `- **结束状态**：\`${sanitizeInlineCode(reason, 48)}\``,
  ].filter(Boolean);

  if (promptPreview) {
    lines.push(`- **任务内容**：${sanitizeForFeishuMarkdown(promptPreview)}`);
  }
  if (payload.error) {
    lines.push(`- **错误摘要**：\`${sanitizeInlineCode(String(payload.error), 160)}\``);
  }
  if (replyPreviewInfo?.preview) {
    lines.push('', '**结果预览：**', `> ${sanitizeForFeishuMarkdown(replyPreviewInfo.preview).replace(/\n+/g, '\n> ')}`);
  }

  const muteRow = notifyMode === 'on'
    ? [
        { label: '🧠 改为仅离开提醒', value: { cmd: 'notify_mode', arg: 'away' } },
        { label: '🔕 关闭桌面提醒', value: { cmd: 'notify_mode', arg: 'off' } },
      ]
    : [
        { label: '🔕 关闭桌面提醒', value: { cmd: 'notify_mode', arg: 'off' } },
      ];

  const boundTopic = conversationId ? findBoundTopicForConversation(state, conversationId) : null;
  if (boundTopic) {
    const tRoot = boundTopic.threadRootId;
    const topicActionRow = [
      boundTopic.matchType === 'desktop'
        ? {
            label: '🔄 同步电脑最新进展',
            type: 'primary',
            value: { cmd: 'desktop_sync_latest', arg: conversationId, threadRootId: tRoot },
          }
        : {
            label: '📄 查看完整回复',
            type: 'primary',
            value: { cmd: 'desktop_last_reply', arg: conversationId, threadRootId: tRoot },
          },
      {
        label: '🧵 另开新话题',
        value: {
          cmd: 'takeover_new_topic',
          arg: conversationId,
          cwd: workspaceDir,
          summary: promptPreview.slice(0, 48),
          threadRootId: tRoot,
        },
      },
      { label: '🔓 结束本楼追踪', value: { cmd: 'unlink_topic', threadRootId: tRoot } },
      { label: '⚙️ 控制面板', value: { cmd: 'panel', threadRootId: tRoot } },
    ];
    const topicCard = buildCard({
      title: isError ? '⚠️ 电脑端任务异常结束（本话题）' : '🔔 电脑端有新进展（已回流本话题）',
      template: isError ? 'orange' : 'green',
      markdown: lines.join('\n'),
      buttonRows: [
        ...chunkButtons(topicActionRow, 2),
        muteRow.map((b) => ({ ...b, value: { ...b.value, threadRootId: tRoot } })),
      ],
      footer: boundTopic.matchType === 'desktop'
        ? '已自动回流至原接管话题楼 · 点「🔄 同步电脑最新进展」即可将新回复注入本话题'
        : '已自动回流至原 CLI 关联话题楼 · 点「🔓 结束本楼追踪」可关闭后续自动回流',
    });

    if (captureFile) {
      fs.mkdirSync(path.dirname(captureFile), { recursive: true });
      fs.writeFileSync(
        captureFile,
        `${JSON.stringify({
          route: 'topic_thread',
          chatId: boundTopic.chatId,
          threadRootId: boundTopic.threadRootId,
          matchType: boundTopic.matchType,
          card: topicCard,
        }, null, 2)}\n`,
        'utf8',
      );
      return;
    }

    try {
      const topicTimeoutPromise = new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('Feishu topic notification timeout')), 4000);
        t.unref();
      });
      await Promise.race([
        replyCard(client, { messageId: boundTopic.threadRootId, card: topicCard, replyInThread: true }),
        topicTimeoutPromise,
      ]);
      return;
    } catch (err) {
      console.error('[feishu-stop-notify] Topic reply failed, falling back to P2P:', err?.message || err);
    }
  }

  const hasTopicGroup = Boolean(resolveDefaultTopicChatId(state, config));
  const actionRow = [];
  if (conversationId) {
    if (hasTopicGroup) {
      actionRow.push(
        {
          label: '🧵 新开话题接管',
          type: 'primary',
          value: {
            cmd: 'takeover_new_topic',
            arg: conversationId,
            cwd: workspaceDir,
            summary: promptPreview.slice(0, 48),
          },
        },
        {
          label: '📱 当前私聊接管',
          value: {
            cmd: 'takeover',
            arg: conversationId,
            cwd: workspaceDir,
            summary: promptPreview.slice(0, 48),
          },
        },
      );
    } else {
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
  }
  if (replyPreviewInfo?.preview && conversationId) {
    actionRow.push({
      label: '📄 查看完整回复',
      value: { cmd: 'desktop_last_reply', arg: conversationId },
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
    buttonRows: [...chunkButtons(actionRow, 3), muteRow],
    footer: conversationId
      ? hasTopicGroup
        ? '点「🧵 新开话题接管」在话题群独立承接，或点「📱 当前私聊接管」快速续聊'
        : '点「📱 接管此对话」将同步电脑端最新回复并在手机飞书无缝续聊'
      : '点下方按钮可快速切换目录或打开控制面板',
  });

  if (captureFile) {
    fs.mkdirSync(path.dirname(captureFile), { recursive: true });
    fs.writeFileSync(
      captureFile,
      `${JSON.stringify({ route: 'p2p', receiveId, receiveIdType, hasTopicGroup, card }, null, 2)}\n`,
      'utf8',
    );
    return;
  }

  const timeoutPromise = new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error('Feishu notification timeout')), 4000);
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
  if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
    console.error(`[feishu-stop-notify] Missing node_modules; run: cd "${getPluginRoot()}" && npm install --omit=dev`);
  } else {
    console.error('[feishu-stop-notify] Ignored notification error:', err?.message || err);
  }
} finally {
  process.stdout.write('{}\n');
  process.exit(0);
}
