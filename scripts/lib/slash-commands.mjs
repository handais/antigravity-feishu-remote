import fs from 'node:fs';
import path from 'node:path';
import { listAgyModels, VALID_EFFORTS, VALID_MODES } from './agy-runner.mjs';
import {
  loadState,
  resolveRiskyApprovalEnabled,
  resolveStopNotifyMode,
  saveConfig,
  saveState,
} from './config.mjs';
import {
  buildAgySkillsCard,
  buildControlPanelCard,
  buildDesktopSessionsCard,
  buildDirSearchCard,
  buildDirsCard,
  buildEffortCard,
  buildGitStatusCard,
  buildNotifyCard,
  buildQueueListCard,
  buildScopesCard,
  buildTasksCard,
  canonicalizeDirPath,
  replyCard as sendReplyCard,
  searchDirsFuzzy,
  sendLocalMedia,
} from './feishu-api.mjs';
import { listDesktopSessions } from './desktop-sessions.mjs';
import {
  buildHandoffCard,
  copyToSystemClipboardAsync,
  readMobileSession,
  writeHandoffSnapshot,
} from './mobile-handoff.mjs';
import { queryAppScopes, readFeishuDoc, writeFeishuDoc } from './feishu-docs.mjs';
import {
  buildOAuthAuthorizeUrl,
  createFeishuTask,
  getUserAuthStatus,
  listFeishuTasks,
  setFeishuTaskCompleted,
} from './feishu-tasks.mjs';
import {
  createBackupSnapshot,
  findRollbackTarget,
  runPreflightCheckAsync,
  scheduleDaemonSelfRestart,
  writePendingRestartNotice,
} from './self-ops.mjs';
import {
  buildCurrentOpsCard,
  buildModelsCard,
  buildSessionsCard,
  collectGitInfoAsync,
  enforceTempFullExpiry,
  expandHomePath,
  formatHelpMarkdown,
  formatTimeoutLabel,
  formatUptime,
  getOrCreateChatState,
  normalizeTempMinutes,
  parseTimeoutArg,
  replySimpleCard,
  resolveDefaultTopicChatId,
} from './bridge-helpers.mjs';

export async function handleSlashCommand(
  ctx,
  {
    text,
    chatId,
    openId = '',
    messageId,
    sessionKey = '',
    threadRootId = '',
    replyInThread = false,
    config,
  },
) {
  const { client, startedAt, bootCodeHash, activeRuns, runner, stopWsForRestart, recordCardThread = () => {} } = ctx;
  const [rawCmd, ...rest] = text.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(' ').trim();
  const runKey = sessionKey || chatId || openId;
  const state = loadState();
  const chatState = getOrCreateChatState(state, runKey, config);
  const expiryInfo = enforceTempFullExpiry(state, chatState);
  if (expiryInfo.expired) {
    saveState(state);
  }
  const isRunning = Boolean(runKey && activeRuns.has(runKey));
  const queueLength = runner.getQueueForChat(runKey).length;
  const anyBusy = () => activeRuns.size > 0 || runner.totalQueuedCount() > 0;
  const replyTargetId = replyInThread ? (threadRootId || messageId) : messageId;
  const replyCard = async (targetClient, { messageId: targetMsgId, card }) => {
    const sentId = await sendReplyCard(targetClient || client, {
      messageId: replyInThread ? (threadRootId || targetMsgId) : targetMsgId,
      card,
      replyInThread,
    });
    if (threadRootId && sentId) {
      recordCardThread(sentId, { sessionKey: runKey, threadRootId, chatId });
    }
    return sentId;
  };
  const replySimple = async (opts) => {
    const sentId = await replySimpleCard(client, replyTargetId, { ...opts, replyInThread });
    if (threadRootId && sentId) {
      recordCardThread(sentId, { sessionKey: runKey, threadRootId, chatId });
    }
    return sentId;
  };

  if (cmd === '/' || cmd === '/skills' || cmd === '/commands') {
    await replyCard(client, {
      messageId,
      card: buildAgySkillsCard(),
    });
    return true;
  }

  if (cmd === '/agy') {
    if (!arg) {
      await replyCard(client, {
        messageId,
        card: buildAgySkillsCard(),
      });
      return true;
    }
    await runner.enqueueOrExecutePrompt({
      text: arg,
      displayPreview: `[agy] ${arg.slice(0, 40)}`,
      chatId,
      openId,
      messageId,
      sessionKey: runKey,
      threadRootId,
      replyInThread,
      config,
    });
    return true;
  }

  if (cmd === '/panel' || cmd === '/menu') {
    await replyCard(client, {
      messageId,
      card: buildControlPanelCard({
        chatState,
        config,
        isRunning,
        uptimeText: formatUptime(Date.now() - startedAt),
        queueLength,
        threadRootId,
        activeParallelCount: activeRuns.size,
        maxConcurrentRuns: config.agy.maxConcurrentRuns || 4,
        panelActionUsage: state.panelActionUsage,
      }),
    });
    return true;
  }

  if (cmd === '/ops' || cmd === '/backups') {
    await replyCard(client, {
      messageId,
      card: buildCurrentOpsCard({ bootCodeHash, isRunning: anyBusy() }),
    });
    return true;
  }

  if (cmd === '/check') {
    const check = await runPreflightCheckAsync();
    await replyCard(client, {
      messageId,
      card: buildCurrentOpsCard({ bootCodeHash, checkResult: check, isRunning }),
    });
    return true;
  }

  if (cmd === '/snapshot') {
    const check = await runPreflightCheckAsync();
    if (!check.ok) {
      await replyCard(client, {
        messageId,
        card: buildCurrentOpsCard({ bootCodeHash, checkResult: check, isRunning }),
      });
      return true;
    }
    createBackupSnapshot({ reason: 'manual', force: true });
    await replyCard(client, {
      messageId,
      card: buildCurrentOpsCard({ bootCodeHash, checkResult: check, isRunning }),
    });
    return true;
  }

  if (cmd === '/reload' || cmd === '/restart') {
    if (anyBusy()) {
      await replySimple({
        title: '⏳ 当前有任务运行或排队中',
        template: 'orange',
        markdown: '请等待当前任务及队列执行完成，或先中止/清空后再安全重启。',
        buttonRows: [[
          { label: '🛑 立即中止', type: 'danger', value: { cmd: 'stop' } },
          { label: '📋 查看队列', value: { cmd: 'queue_list' } },
          { label: '🛡️ 运维与回滚', value: { cmd: 'ops' } },
        ]],
      });
      return true;
    }
    const check = await runPreflightCheckAsync();
    if (!check.ok) {
      await replyCard(client, {
        messageId,
        card: buildCurrentOpsCard({ bootCodeHash, checkResult: check, isRunning: false }),
      });
      return true;
    }
    writePendingRestartNotice({
      chatId,
      openId,
      sessionKey: runKey,
      threadRootId: replyInThread ? (threadRootId || messageId) : '',
      replyInThread: Boolean(replyInThread),
      action: 'restart',
      snapshotId: '',
      previousHash: bootCodeHash,
      requestedAt: Date.now(),
    });
    await replySimple({
      title: '♻️ 预检通过，正在安全重启...',
      template: 'wathet',
      markdown: [
        `- **预检结果**：✅ 通过（检查 ${check.checkedFiles.length} 个脚本，耗时 ${check.durationMs}ms）`,
        `- **目标代码版本**：\`${check.hash.slice(0, 8)}\``,
        '',
        '预计 1~3 秒后自动上线，上线后会推送确认卡片。',
      ].join('\n'),
      footer: '如长时间未收到上线通知，请在 Mac 终端查看 cli.mjs logs',
    });
    scheduleDaemonSelfRestart({ delayMs: 700, onBeforeExit: stopWsForRestart });
    return true;
  }

  if (cmd === '/rollback') {
    const target = findRollbackTarget(arg);
    if (!target) {
      await replySimple({
        title: 'ℹ️ 暂无更早的可用快照可回滚',
        template: 'grey',
        markdown: '未找到与当前代码不同的历史快照（或指定的快照 ID 不存在）。',
        buttonRows: [[{ label: '🛡️ 运维与回滚', value: { cmd: 'ops' } }]],
      });
      return true;
    }
    await replyCard(client, {
      messageId,
      card: buildCurrentOpsCard({ bootCodeHash, isRunning: anyBusy(), confirmSnapshot: target }),
    });
    return true;
  }

  if (cmd === '/dirs') {
    const subArg = arg.trim().toLowerCase();
    if (['-a', 'all', 'hidden', 'show', 'on'].includes(subArg)) {
      chatState.showHiddenDirs = true;
      saveState(state);
    } else if (['hide', 'off', 'nohidden', 'normal'].includes(subArg)) {
      chatState.showHiddenDirs = false;
      saveState(state);
    }
    await replyCard(client, {
      messageId,
      card: buildDirsCard({ chatState, config }),
    });
    return true;
  }

  if (cmd === '/help') {
    await replySimple({
      title: '🤖 Antigravity 飞书遥控指令',
      template: 'blue',
      markdown: formatHelpMarkdown(),
      buttonRows: [[
        { label: '⚙️ 打开控制面板', type: 'primary', value: { cmd: 'panel' } },
        { label: '🧩 命令与技能', value: { cmd: 'skills_menu' } },
      ]],
    });
    return true;
  }

  if (cmd === '/status') {
    const running = activeRuns.get(runKey);
    const isTempFull = chatState.mode === 'full' && Number(chatState.fullExpiresAt || 0) > Date.now();
    const remainMin = isTempFull ? Math.max(1, Math.ceil((chatState.fullExpiresAt - Date.now()) / 60000)) : 0;
    const modeText = isTempFull
      ? `\`full\`（临时授权，约 ${remainMin}m 后切回 \`${chatState.fullRevertMode || 'accept-edits'}\`）`
      : `\`${chatState.mode}\``;
    const notifyMode = resolveStopNotifyMode(config);
    const awayMin = Math.max(1, Math.round(Number(config?.notifications?.awayIdleSeconds || 120) / 60));
    const notifyText = notifyMode === 'on'
      ? '🔔 始终提醒'
      : notifyMode === 'away'
        ? `🧠 仅离开电脑时（空闲 ≥ ${awayMin}m）`
        : '🔕 已关闭';
    const lines = [
      threadRootId ? `- **所属话题**：\`${threadRootId.slice(0, 12)}\`（独立并行会话）` : '',
      `- **工作目录**：\`${chatState.cwd}\``,
      `- **执行模式**：${modeText}`,
      `- **单轮超时**：\`${formatTimeoutLabel(config.agy.timeoutSeconds)}\``,
      `- **当前模型**：\`${chatState.model || 'default (随 CLI 配置)'}\``,
      `- **推理强度**：\`${chatState.effort || config.agy.defaultEffort || 'default (随 CLI 配置)'}\``,
      `- **高危命令审批**：${resolveRiskyApprovalEnabled(config) ? '🛡️ 已开启' : '⚪ 已关闭'}`,
      `- **电脑端提醒**：${notifyText}`,
      `- **当前会话**：\`${chatState.conversationId || '(未开始，下条消息新建)'}\``,
      chatState.originDesktopSession?.id
        ? `- **关联桌面会话**：${chatState.originDesktopSession.title || '(无标题)'}（\`${chatState.originDesktopSession.id.slice(0, 8)}\`）`
        : '',
      chatState.pendingHandoff
        ? `- **待注入电脑端上下文**：\`${chatState.pendingHandoff.id?.slice(0, 8) || '-'}\` · ${chatState.pendingHandoff.title || '(无标题)'}`
        : '',
      `- **运行中任务**：${running ? `是（已运行 ${Math.round((Date.now() - running.startedAt) / 1000)}s）` : '空闲'}`,
      activeRuns.size > 0 ? `- **全局并行运行**：\`${activeRuns.size}/${config.agy.maxConcurrentRuns || 4}\`` : '',
      `- **排队中任务**：\`${queueLength}\` 条`,
      `- **守护进程在线**：\`${formatUptime(Date.now() - startedAt)}\``,
    ].filter(Boolean);
    await replySimple({
      title: '📊 当前状态',
      template: 'blue',
      markdown: lines.join('\n'),
      buttonRows: [[
        { label: '⚙️ 打开控制面板', type: 'primary', value: { cmd: 'panel' } },
        { label: '🧩 命令与技能', value: { cmd: 'skills_menu' } },
        { label: '📋 查看队列', value: { cmd: 'queue_list' } },
      ]],
    });
    return true;
  }

  if (cmd === '/new') {
    chatState.conversationId = '';
    chatState.pendingHandoff = null;
    chatState.originDesktopSession = null;
    chatState.lastTurnArtifacts = null;
    chatState.topicClosed = false;
    saveState(state);
    await replySimple({
      title: '🆕 已开启新对话',
      template: 'green',
      markdown: `下条消息将在 \`${chatState.cwd}\` 下开启全新上下文。`,
      buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
    });
    return true;
  }

  if (cmd === '/unlink' || cmd === '/close') {
    chatState.topicClosed = true;
    chatState.originDesktopSession = null;
    chatState.pendingHandoff = null;
    saveState(state);
    await replySimple({
      title: '🔓 已结束当前对话的电脑端自动回流追踪',
      template: 'grey',
      markdown: '后续电脑端若再运行原对话，完成通知将回到私聊总收件箱，不再推送到此话题楼。',
      buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
    });
    return true;
  }

  if (cmd === '/topic') {
    const sub = arg.trim().toLowerCase();
    if (sub === 'set') {
      if (!replyInThread || !chatId) {
        await replySimple({
          title: '⚠️ 请在话题群内使用 `/topic set`',
          template: 'orange',
          markdown: '请在飞书「话题群」的任意消息或话题楼里发送 `/topic set`，即可将该群设为「🧵 新开话题接管」的默认目标群。',
        });
        return true;
      }
      config.notifications.defaultTopicChatId = chatId;
      saveConfig(config);
      state.lastTopicChatId = chatId;
      saveState(state);
      await replySimple({
        title: '🧵 已绑定默认接管话题群',
        template: 'green',
        markdown: `已将当前话题群（\`${chatId}\`）设为默认接管群。以后在私聊点「🧵 新开话题接管」时，会自动在此群创建独立话题楼。`,
      });
      return true;
    }
    if (sub === 'clear' || sub === 'reset') {
      config.notifications.defaultTopicChatId = '';
      saveConfig(config);
      await replySimple({
        title: '🧹 已清除手动指定的默认话题群',
        template: 'grey',
        markdown: '后续将恢复自动识别最近活跃的话题群。',
      });
      return true;
    }
    const resolvedTopic = resolveDefaultTopicChatId(state, config, chatId, Boolean(replyInThread));
    const configured = String(config?.notifications?.defaultTopicChatId || '').trim();
    await replySimple({
      title: '🧵 默认接管话题群',
      template: resolvedTopic ? 'blue' : 'grey',
      markdown: [
        `- **当前生效话题群**：\`${resolvedTopic || '(未绑定，请先在话题群发消息或 /topic set)'}\``,
        configured ? `- **来源**：手动指定（\`defaultTopicChatId\`）` : '- **来源**：自动记忆最近活跃话题群',
        '',
        '用法：在话题群发送 `/topic set` 绑定，`/topic clear` 清除手动绑定。',
      ].join('\n'),
    });
    return true;
  }

  if (cmd === '/handoff' || cmd === '/back' || cmd === '/return') {
    const target = arg.trim().toLowerCase() === 'desktop' ? 'desktop' : 'cli';
    const session = readMobileSession({
      conversationId: chatState.conversationId || '',
      cwd: chatState.cwd,
      originDesktopId: chatState.originDesktopSession?.id || '',
    });
    if (!session.found) {
      await replySimple({
        title: 'ℹ️ 暂无可交回电脑的手机端会话',
        template: 'grey',
        markdown: session.error || '请先在飞书端发送一条任务消息后再使用 `/handoff`。',
        buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
      });
      return true;
    }
    const textToCopy = target === 'desktop' ? session.desktopHandoffPrompt : session.cliResumeCommand;
    const clipboardResult = await copyToSystemClipboardAsync(textToCopy);
    const snap = writeHandoffSnapshot({
      conversationId: session.conversationId,
      cwd: session.cwd,
      cliResumeCommand: session.cliResumeCommand,
      desktopHandoffPrompt: session.desktopHandoffPrompt,
      modifiedFiles: session.modifiedFiles,
      originDesktopSession: session.originDesktopSession,
    });
    await replyCard(client, {
      messageId,
      card: buildHandoffCard({
        session,
        clipboardResult,
        copiedTarget: target,
        snapshotPath: snap.latestPath,
      }),
    });
    return true;
  }

  if (cmd === '/guard' || cmd === '/approval') {
    const sub = arg.trim().toLowerCase();
    if (sub === 'on' || sub === 'enable' || sub === '开') {
      config.security.riskyCommandApproval = 'on';
      saveConfig(config);
    } else if (sub === 'off' || sub === 'disable' || sub === '关') {
      config.security.riskyCommandApproval = 'off';
      saveConfig(config);
    } else if (sub) {
      await replySimple({
        title: '⚠️ /guard 用法提示',
        template: 'orange',
        markdown: '用法：`/guard`（查看状态）、`/guard on`（开启高危命令审批）、`/guard off`（关闭）。',
        buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
      });
      return true;
    }
    const enabled = resolveRiskyApprovalEnabled(config);
    const timeoutSec = Math.max(15, Math.min(160, Number(config.security?.approvalTimeoutSeconds || 120)));
    await replySimple({
      title: '🛡️ 高危命令飞书审批',
      template: enabled ? 'green' : 'grey',
      markdown: [
        `- **当前状态**：${enabled ? '🛡️ **已开启**' : '⚪ **已关闭**'}`,
        `- **审批超时**：\`${timeoutSec}s\`（超时默认拒绝 Fail-Closed）`,
        '- **拦截范围**：`rm -rf`、`git push --force`、`git reset --hard`、`sudo`、`curl | sh`、系统目录覆写等高危命令',
      ].join('\n'),
      buttonRows: [[
        {
          label: enabled ? '⚪ 关闭高危审批' : '🛡️ 开启高危审批',
          type: enabled ? 'default' : 'primary',
          value: { cmd: 'guard_toggle', arg: enabled ? 'off' : 'on', inplace: true },
        },
        { label: '⚙️ 控制面板', value: { cmd: 'panel' } },
      ]],
    });
    return true;
  }

  if (cmd === '/sessions') {
    await replyCard(client, {
      messageId,
      card: buildSessionsCard(chatState),
    });
    return true;
  }

  if (cmd === '/desktop' || cmd === '/pc') {
    const items = listDesktopSessions({ query: arg, filter: 'all', limit: 10 });
    await replyCard(client, {
      messageId,
      card: buildDesktopSessionsCard({
        items,
        query: arg,
        filter: 'all',
        currentConvId: chatState.conversationId,
        pendingHandoffId: chatState.pendingHandoff?.id || '',
      }),
    });
    return true;
  }

  if (cmd === '/use') {
    if (!arg) {
      await replySimple({
        title: '⚠️ 用法提示',
        template: 'orange',
        markdown: '请提供序号或会话 ID，例如 `/use 1` 或 `/use a466b643`。',
        buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
      });
      return true;
    }
    const list = chatState.recentConversations || [];
    let targetId = '';
    if (/^\d+$/.test(arg)) {
      const idx = Number(arg) - 1;
      if (idx >= 0 && idx < list.length) targetId = list[idx].id;
    } else {
      const match = list.find((item) => item.id === arg || item.id.startsWith(arg));
      targetId = match ? match.id : arg;
    }
    if (!targetId) {
      await replySimple({
        title: '❌ 未找到对应会话',
        template: 'red',
        markdown: `未在历史记录中找到 \`${arg}\`，请先发 \`/sessions\` 查看编号。`,
        buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
      });
      return true;
    }
    chatState.conversationId = targetId;
    chatState.pendingHandoff = null;
    chatState.originDesktopSession = null;
    chatState.lastTurnArtifacts = null;
    chatState.topicClosed = false;
    saveState(state);
    await replySimple({
      title: '🔁 已切换会话',
      template: 'green',
      markdown: `当前对话已绑定到 \`${targetId}\`。`,
      buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
    });
    return true;
  }

  if (cmd === '/cd' || cmd === '/cwd') {
    if (!arg) {
      await replySimple({
        title: '📂 当前工作目录',
        template: 'blue',
        markdown: `\`${chatState.cwd}\``,
        buttonRows: [[
          { label: '📁 浏览目录', value: { cmd: 'dirs' } },
          { label: '⚙️ 控制面板', value: { cmd: 'panel' } },
        ]],
      });
      return true;
    }
    const targetDir = expandHomePath(arg, chatState.cwd);
    let directIsDir = false;
    try {
      directIsDir = fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory();
    } catch {
      directIsDir = false;
    }
    if (directIsDir) {
      chatState.cwd = targetDir;
      if (threadRootId && chatId) {
        getOrCreateChatState(state, chatId, config).cwd = targetDir;
      }
      saveState(state);
      await replySimple({
        title: '📂 已切换工作目录',
        template: 'green',
        markdown: `当前目录：\`${targetDir}\``,
        buttonRows: [[
          { label: '📌 收藏当前目录', value: { cmd: 'pin' } },
          { label: '⚙️ 控制面板', value: { cmd: 'panel' } },
        ]],
      });
      return true;
    }

    const matches = searchDirsFuzzy(arg, { config, currentCwd: chatState.cwd });
    if (matches.length === 1) {
      chatState.cwd = matches[0];
      if (threadRootId && chatId) {
        getOrCreateChatState(state, chatId, config).cwd = matches[0];
      }
      saveState(state);
      await replySimple({
        title: '📂 已模糊匹配并切换工作目录',
        template: 'green',
        markdown: `关键词 \`${arg}\` 唯一匹配：\n\`${matches[0]}\``,
        buttonRows: [[
          { label: '📌 收藏当前目录', value: { cmd: 'pin' } },
          { label: '⚙️ 控制面板', value: { cmd: 'panel' } },
        ]],
      });
      return true;
    }
    if (matches.length > 1) {
      await replyCard(client, {
        messageId,
        card: buildDirSearchCard({ query: arg, matches, currentCwd: chatState.cwd }),
      });
      return true;
    }

    await replySimple({
      title: '❌ 未找到匹配目录',
      template: 'red',
      markdown: `路径不存在且未在常用目录中找到匹配 \`${arg}\` 的文件夹。`,
      buttonRows: [[
        { label: '📁 浏览目录', value: { cmd: 'dirs' } },
        { label: '⚙️ 控制面板', value: { cmd: 'panel' } },
      ]],
    });
    return true;
  }

  if (cmd === '/send' || cmd === '/sendfile') {
    let forceFile = false;
    let pathArg = arg;
    if (/(?:^|\s)--file(?:\s|$)/i.test(pathArg)) {
      forceFile = true;
      pathArg = pathArg.replace(/(?:^|\s)--file(?:\s|$)/gi, ' ').trim();
    }
    if (!pathArg) {
      await replySimple({
        title: '⚠️ 发送文件用法',
        template: 'orange',
        markdown: [
          '格式：`/send <本机文件路径>`（支持相对当前工作目录或 `~` 路径）',
          '- 图片（png/jpg/webp/gif 等）默认以图片消息发送',
          '- 加 `--file` 可强制按普通文件附件发送，例如：`/send --file ./preview.png`',
        ].join('\n'),
        buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
      });
      return true;
    }
    const targetFile = expandHomePath(pathArg, chatState.cwd);
    try {
      const sent = await sendLocalMedia(client, {
        receiveId: chatId || openId,
        receiveIdType: chatId ? 'chat_id' : 'open_id',
        filePath: targetFile,
        forceFile,
        replyToMessageId: replyTargetId,
        replyInThread,
      });
      await replySimple({
        title: sent.kind === 'image' ? '🖼️ 图片已发送' : '📎 文件已发送',
        template: 'green',
        markdown: [
          `- **文件名**：\`${sent.fileName}\``,
          `- **路径**：\`${targetFile}\``,
          `- **大小**：\`${(sent.sizeBytes / 1024).toFixed(1)} KB\``,
        ].join('\n'),
      });
    } catch (err) {
      await replySimple({
        title: '❌ 发送文件失败',
        template: 'red',
        markdown: `${err?.message || err}\n\n如提示无权限，请在飞书开放平台开通 \`im:resource\` 权限并发布版本。`,
      });
    }
    return true;
  }

  if (cmd === '/pin') {
    const resolved = path.resolve(chatState.cwd);
    const canonicalCurrent = canonicalizeDirPath(resolved);
    const existing = Array.isArray(config.agy.favoriteDirs) ? config.agy.favoriteDirs.map((d) => path.resolve(d)) : [];
    const hasMatch = existing.some((d) => canonicalizeDirPath(d) === canonicalCurrent);
    let actionLabel = '';
    let nextFavorites;
    if (hasMatch) {
      nextFavorites = existing.filter((d) => canonicalizeDirPath(d) !== canonicalCurrent);
      actionLabel = '已从快捷目录取消收藏';
    } else {
      nextFavorites = [resolved, ...existing];
      actionLabel = '已收藏到控制面板快捷目录';
    }
    config.agy.favoriteDirs = nextFavorites;
    saveConfig(config);
    await replySimple({
      title: '📌 快捷目录已更新',
      template: 'green',
      markdown: `${actionLabel}：\`${resolved}\``,
      buttonRows: [[{ label: '⚙️ 打开控制面板', type: 'primary', value: { cmd: 'panel' } }]],
    });
    return true;
  }

  if (cmd === '/mode') {
    if (!arg) {
      const isTempFull = chatState.mode === 'full' && Number(chatState.fullExpiresAt || 0) > Date.now();
      const remainMin = isTempFull ? Math.max(1, Math.ceil((chatState.fullExpiresAt - Date.now()) / 60000)) : 0;
      const modeDesc = isTempFull
        ? `\`full\`（⏱️ 临时授权，约 ${remainMin} 分钟后自动切回 \`${chatState.fullRevertMode || 'accept-edits'}\`）`
        : `\`${chatState.mode}\``;
      await replySimple({
        title: '🛡️ 当前执行模式',
        template: 'blue',
        markdown: [
          `当前模式：${modeDesc}`,
          '',
          `可选模式：\`${VALID_MODES.join('` · `')}\``,
          '临时授权用法：`/mode full 30m`（执行完整能力并在到期后自动切回安全模式）',
        ].join('\n'),
        buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
      });
      return true;
    }
    const tokens = arg.split(/\s+/).filter(Boolean);
    const first = tokens[0].toLowerCase();
    const isTempTrigger =
      first === 'temp' ||
      (first === 'full' && tokens[1] && /^\d+(?:m|min)?$/i.test(tokens[1]));
    if (isTempTrigger && (!tokens[1] || /^\d+(?:m|min)?$/i.test(tokens[1]))) {
      const minutes = normalizeTempMinutes(tokens[1], 30);
      chatState.fullRevertMode =
        chatState.mode && chatState.mode !== 'full'
          ? chatState.mode
          : chatState.fullRevertMode && chatState.fullRevertMode !== 'full'
            ? chatState.fullRevertMode
            : 'accept-edits';
      chatState.mode = 'full';
      chatState.fullExpiresAt = Date.now() + minutes * 60_000;
      saveState(state);
      await replySimple({
        title: '⚡ 已开启临时全权限',
        template: 'orange',
        markdown: [
          `- **当前模式**：\`full\`（临时 ${minutes} 分钟）`,
          `- **到期自动切回**：\`${chatState.fullRevertMode}\``,
        ].join('\n'),
        buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
      });
      return true;
    }

    if (!VALID_MODES.includes(first)) {
      await replySimple({
        title: '❌ 无效模式',
        template: 'red',
        markdown: `不支持的模式 \`${arg}\`。\n可选：\`${VALID_MODES.join('` · `')}\` 或 \`full 30m\``,
        buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
      });
      return true;
    }
    chatState.mode = first;
    chatState.fullExpiresAt = 0;
    saveState(state);
    await replySimple({
      title: '🛡️ 已切换执行模式',
      template: 'green',
      markdown: `当前执行模式已设置为：\`${first}\``,
      buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
    });
    return true;
  }

  if (cmd === '/timeout') {
    if (!arg) {
      await replySimple({
        title: '⏱️ 单轮任务超时设置',
        template: 'blue',
        markdown: [
          `- **当前超时**：\`${formatTimeoutLabel(config.agy.timeoutSeconds)}\``,
          '',
          '**调整用法（下条任务起实时生效）：**',
          '- `/timeout 60`（或 `/timeout 120m`）：设为 60 / 120 分钟',
          '- `/timeout 2h`：设为 2 小时（最长 24 小时）',
          '- `/timeout 0`：设为**不限时**（直到任务自然完成或手动 `/stop`）',
        ].join('\n'),
        buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
      });
      return true;
    }

    const seconds = parseTimeoutArg(arg);
    if (seconds === null) {
      await replySimple({
        title: '⚠️ 超时参数格式无效',
        template: 'orange',
        markdown: `未能解析 \`${arg}\`。\n示例：\`/timeout 60\`、\`/timeout 2h\`、\`/timeout 90s\`、\`/timeout 0\`（不限时）`,
        buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
      });
      return true;
    }

    config.agy.timeoutSeconds = seconds;
    saveConfig(config);
    await replySimple({
      title: '⏱️ 已更新单轮超时设置',
      template: 'green',
      markdown: [
        `- **最新超时**：\`${formatTimeoutLabel(seconds)}\``,
        seconds === 0
          ? '- **说明**：任务将一直运行到自然结束（可随时点卡片「🛑 立即中止」或发 `/stop`）'
          : '- **说明**：超过 10 分钟的长任务会自动切为全卡节流刷新，保证持续更新与最终送达',
      ].join('\n'),
      buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
    });
    return true;
  }

  if (cmd === '/effort') {
    const effective = chatState.effort || config.agy.defaultEffort || '';
    if (!arg) {
      await replyCard(client, {
        messageId,
        card: buildEffortCard(effective),
      });
      return true;
    }
    const normalized = arg.trim().toLowerCase();
    if (normalized === 'default' || normalized === 'auto' || normalized === 'reset' || normalized === 'off') {
      chatState.effort = '';
      saveState(state);
      await replySimple({
        title: '🎛️ 已切换推理强度',
        template: 'green',
        markdown: '当前推理强度已设置为：`default (随 CLI 配置)`',
        buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
      });
      return true;
    }
    if (!VALID_EFFORTS.includes(normalized)) {
      await replySimple({
        title: '❌ 无效推理强度',
        template: 'red',
        markdown: `不支持的强度 \`${arg}\`。\n可选：\`${VALID_EFFORTS.join('` · `')}\` · \`default\``,
        buttonRows: [[{ label: '🎛️ 选择推理强度', value: { cmd: 'effort_menu' } }]],
      });
      return true;
    }
    chatState.effort = normalized;
    saveState(state);
    await replySimple({
      title: '🎛️ 已切换推理强度',
      template: 'green',
      markdown: `当前推理强度已设置为：\`${normalized}\``,
      buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
    });
    return true;
  }

  if (cmd === '/notify' || cmd === '/mute' || cmd === '/unmute') {
    if (cmd === '/mute') {
      config.notifications.stopNotifyMode = 'off';
      config.notifications.stopHookEnabled = false;
      saveConfig(config);
      await replyCard(client, { messageId, card: buildNotifyCard({ config }) });
      return true;
    }
    if (cmd === '/unmute') {
      config.notifications.stopNotifyMode = 'on';
      config.notifications.stopHookEnabled = true;
      saveConfig(config);
      await replyCard(client, { messageId, card: buildNotifyCard({ config }) });
      return true;
    }
    if (!arg) {
      await replyCard(client, { messageId, card: buildNotifyCard({ config }) });
      return true;
    }
    const parts = arg.trim().toLowerCase().split(/\s+/);
    const modeArg = parts[0];
    if (modeArg === 'on' || modeArg === 'always' || modeArg === '开') {
      config.notifications.stopNotifyMode = 'on';
      config.notifications.stopHookEnabled = true;
      saveConfig(config);
      await replyCard(client, { messageId, card: buildNotifyCard({ config }) });
      return true;
    }
    if (modeArg === 'off' || modeArg === 'mute' || modeArg === '关') {
      config.notifications.stopNotifyMode = 'off';
      config.notifications.stopHookEnabled = false;
      saveConfig(config);
      await replyCard(client, { messageId, card: buildNotifyCard({ config }) });
      return true;
    }
    if (modeArg === 'away' || modeArg === 'auto' || modeArg === '离开') {
      if (parts[1]) {
        const minRaw = parts[1].replace(/m(?:in)?$/i, '');
        const minNum = Number(minRaw);
        if (!Number.isFinite(minNum) || minNum <= 0 || minNum > 60) {
          await replySimple({
            title: '⚠️ 用法提示',
            template: 'orange',
            markdown: '离开超时分钟数请填 `1~60`，例如 `/notify away 2` 或 `/notify away 5`。',
          });
          return true;
        }
        config.notifications.awayIdleSeconds = Math.max(30, Math.round(minNum * 60));
      }
      config.notifications.stopNotifyMode = 'away';
      config.notifications.stopHookEnabled = true;
      saveConfig(config);
      await replyCard(client, { messageId, card: buildNotifyCard({ config }) });
      return true;
    }
    await replySimple({
      title: '⚠️ 无效提醒模式',
      template: 'orange',
      markdown: '支持：`/notify on`（始终）、`/notify away [分钟]`（离开电脑时）、`/notify off`（关闭）。',
      buttonRows: [[{ label: '🔔 打开提醒设置', value: { cmd: 'notify_menu' } }]],
    });
    return true;
  }

  if (cmd === '/git') {
    const gitInfo = await collectGitInfoAsync(chatState.cwd);
    await replyCard(client, {
      messageId,
      card: buildGitStatusCard({ cwd: chatState.cwd, gitInfo }),
    });
    return true;
  }

  if (cmd === '/scopes' || cmd === '/perms') {
    try {
      const scopeData = await queryAppScopes(client);
      await replyCard(client, {
        messageId,
        card: buildScopesCard(scopeData),
      });
    } catch (err) {
      await replySimple({
        title: '❌ 查询飞书权限失败',
        template: 'red',
        markdown: String(err?.message || err),
      });
    }
    return true;
  }

  if (cmd === '/queue') {
    await replyCard(client, {
      messageId,
      card: buildQueueListCard({
        running: activeRuns.get(runKey) || null,
        queue: runner.getQueueForChat(runKey),
      }),
    });
    return true;
  }

  if (cmd === '/doc') {
    if (!arg) {
      await replySimple({
        title: '📄 飞书云文档用法',
        template: 'blue',
        markdown: [
          '- **直接读取**：消息中贴飞书文档/知识库链接会自动读取，也可发 `/doc <文档链接或ID>`',
          '- **新建文档**：`/doc create 文档标题 | Markdown 内容`',
          '- **追加写入**：`/doc write <文档链接或ID> | Markdown 内容`',
        ].join('\n'),
        buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
      });
      return true;
    }
    const isCreate = /^create\s+/i.test(arg);
    const isWrite = /^write\s+/i.test(arg);
    if (isCreate || isWrite) {
      const body = arg.replace(/^(?:create|write)\s+/i, '');
      const sepIdx = body.search(/[|｜]/);
      const left = sepIdx !== -1 ? body.slice(0, sepIdx).trim() : '';
      const right = sepIdx !== -1 ? body.slice(sepIdx + 1).trim() : '';
      if (!left || !right) {
        await replySimple({
          title: '⚠️ 参数格式提示',
          template: 'orange',
          markdown: isCreate
            ? '格式：`/doc create 文档标题 | Markdown 内容`'
            : '格式：`/doc write <文档链接或ID> | Markdown 内容`',
        });
        return true;
      }
      try {
        const res = await writeFeishuDoc(client, {
          title: isCreate ? left : '',
          documentId: isWrite ? left : '',
          markdown: right,
          grantOpenId: openId || config.notifications.defaultReceiveId || config.security.allowedOpenIds?.[0] || '',
          domain: config.feishu.domain,
        });
        const lines = [
          `- **文档标题**：${res.title}`,
          `- **文档链接**：${res.url}`,
          `- **写入块数**：\`${res.blocksInserted}\``,
        ];
        if (res.permissionWarning) {
          lines.push('', `⚠️ ${res.permissionWarning}`);
        }
        await replySimple({
          title: res.created ? '📄 已创建飞书云文档' : '📝 已追加写入飞书云文档',
          template: 'green',
          markdown: lines.join('\n'),
        });
      } catch (err) {
        await replySimple({
          title: '❌ 写入飞书云文档失败',
          template: 'red',
          markdown: String(err?.message || err),
        });
      }
      return true;
    }

    try {
      const doc = await readFeishuDoc(client, arg, {
        maxChars: 6000,
        domain: config.feishu.domain,
      });
      await replySimple({
        title: `📄 ${doc.title}`,
        template: 'blue',
        markdown: [
          `链接：${doc.url}（共 ${doc.totalChars} 字）`,
          '',
          doc.content || '_（文档内容为空）_',
        ].join('\n'),
      });
    } catch (err) {
      await replySimple({
        title: '❌ 读取飞书云文档失败',
        template: 'red',
        markdown: String(err?.message || err),
      });
    }
    return true;
  }

  if (cmd === '/tasks' || cmd === '/todo') {
    const authStatus = getUserAuthStatus();
    const authUrl = config?.feishu?.appId
      ? buildOAuthAuthorizeUrl({
          appId: config.feishu.appId,
          domain: config.feishu.domain,
        })
      : '';

    if (/^auth$/i.test(arg)) {
      await replyCard(client, {
        messageId,
        card: buildTasksCard({
          items: [],
          filter: 'open',
          authStatus,
          authUrl,
        }),
      });
      return true;
    }

    if (/^add\s+/i.test(arg)) {
      const body = arg.replace(/^add\s+/i, '');
      const sepIdx = body.search(/[|｜]/);
      const summary = (sepIdx !== -1 ? body.slice(0, sepIdx) : body).trim();
      const description = sepIdx !== -1 ? body.slice(sepIdx + 1).trim() : '';
      if (!summary) {
        await replySimple({
          title: '⚠️ 新建待办用法',
          template: 'orange',
          markdown: '格式：`/tasks add 任务标题 | 可选描述`',
          buttonRows: [[{ label: '✅ 查看飞书待办', value: { cmd: 'tasks', filter: 'open' } }]],
        });
        return true;
      }
      try {
        const created = await createFeishuTask(config, {
          summary,
          description,
          assigneeOpenId: openId || config.security.allowedOpenIds?.[0] || '',
        });
        await replySimple({
          title: '✅ 已创建飞书任务',
          template: 'green',
          markdown: [
            `- **任务标题**：${created.summary}`,
            created.description ? `- **任务说明**：${created.description}` : '',
            created.guid ? `- **GUID**：\`${created.guid}\`` : '',
          ].filter(Boolean).join('\n'),
          buttonRows: [[
            { label: '✅ 查看飞书待办', type: 'primary', value: { cmd: 'tasks', filter: 'open' } },
            { label: '⚙️ 控制面板', value: { cmd: 'panel' } },
          ]],
        });
      } catch (err) {
        await replyCard(client, {
          messageId,
          card: buildTasksCard({
            items: [],
            filter: 'open',
            authStatus: getUserAuthStatus(),
            error: err?.message || String(err),
            authUrl,
          }),
        });
      }
      return true;
    }

    const toggleMatch = arg.match(/^(complete|done|reopen|undo)\s+(\S+)$/i);
    if (toggleMatch) {
      const completed = ['complete', 'done'].includes(toggleMatch[1].toLowerCase());
      const guid = toggleMatch[2].trim();
      try {
        const updated = await setFeishuTaskCompleted(config, guid, completed);
        await replySimple({
          title: completed ? '✅ 任务已标记完成' : '↩️ 任务已重新打开',
          template: completed ? 'green' : 'blue',
          markdown: `- **任务**：${updated.summary}\n- **GUID**：\`${updated.guid}\``,
          buttonRows: [[{ label: '✅ 查看飞书待办', type: 'primary', value: { cmd: 'tasks', filter: 'open' } }]],
        });
      } catch (err) {
        await replyCard(client, {
          messageId,
          card: buildTasksCard({
            items: [],
            filter: 'open',
            authStatus: getUserAuthStatus(),
            error: err?.message || String(err),
            authUrl,
          }),
        });
      }
      return true;
    }

    const filterArg = arg.trim().toLowerCase();
    const filter = ['done', 'completed'].includes(filterArg)
      ? 'done'
      : ['all', '-a'].includes(filterArg)
        ? 'all'
        : 'open';
    try {
      const res = await listFeishuTasks(config, { filter, pageSize: 20 });
      await replyCard(client, {
        messageId,
        card: buildTasksCard({
          items: res.items,
          filter: res.filter,
          authStatus: getUserAuthStatus(),
          authUrl,
        }),
      });
    } catch (err) {
      await replyCard(client, {
        messageId,
        card: buildTasksCard({
          items: [],
          filter,
          authStatus: getUserAuthStatus(),
          error: err?.message || String(err),
          authUrl,
        }),
      });
    }
    return true;
  }

  if (cmd === '/model') {
    if (!arg) {
      await replySimple({
        title: '🧠 当前模型',
        template: 'blue',
        markdown: `当前模型：\`${chatState.model || 'default'}\`\n\n发送 \`/models\` 查看可用列表，发送 \`/model <模型名>\` 切换。`,
        buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
      });
      return true;
    }
    chatState.model = arg === 'default' ? '' : arg;
    saveState(state);
    await replySimple({
      title: '🧠 已更新模型设置',
      template: 'green',
      markdown: `当前模型已设置为：\`${chatState.model || 'default'}\``,
      buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
    });
    return true;
  }

  if (cmd === '/models') {
    try {
      const models = await listAgyModels(config);
      await replyCard(client, {
        messageId,
        card: buildModelsCard(models, chatState.model),
      });
    } catch (err) {
      await replySimple({
        title: '❌ 查询模型失败',
        template: 'red',
        markdown: String(err.message || err),
      });
    }
    return true;
  }

  if (cmd === '/stop' || cmd === '/cancel') {
    const running = activeRuns.get(runKey);
    if (!running) {
      await replySimple({
        title: 'ℹ️ 当前无运行中任务',
        template: 'grey',
        markdown: '这个对话目前是空闲状态。',
        buttonRows: [[{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }]],
      });
      return true;
    }
    running.controller.abort();
    const extraNote = queueLength > 0 ? `\n\n队列中仍有 ${queueLength} 条排队任务，将在中止完成后自动接续。` : '';
    const buttons = [{ label: '⚙️ 控制面板', value: { cmd: 'panel' } }];
    if (queueLength > 0) {
      buttons.push({ label: `📋 管理队列(${queueLength})`, value: { cmd: 'queue_list' } });
    }
    await replySimple({
      title: '🛑 正在中止任务',
      template: 'orange',
      markdown: `已发送终止信号给正在运行的 \`agy\` 进程。${extraNote}`,
      buttonRows: [buttons],
    });
    return true;
  }

  if (cmd === '/bind') {
    await replySimple({
      title: '✅ 当前账号已授权',
      template: 'green',
      markdown: '你的飞书账号已在白名单中，可以直接发送任务指令。',
    });
    return true;
  }

  return false;
}
