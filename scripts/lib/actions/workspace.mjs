import fs from 'node:fs';
import path from 'node:path';
import { listAgyModels, VALID_EFFORTS, VALID_MODES } from '../agy-runner.mjs';
import { saveConfig, saveState } from '../config.mjs';
import {
  buildAgySkillsCard,
  buildCard,
  buildDirsCard,
  buildEffortCard,
  buildPanelHelpCard,
  canonicalizeDirPath,
  patchCard,
} from '../feishu-api.mjs';
import {
  buildModelsCard,
  buildSessionsCard,
  expandHomePath,
  formatHelpMarkdown,
  getOrCreateChatState,
  normalizeTempMinutes,
  toastCardResponse,
} from '../bridge-helpers.mjs';

export async function handleWorkspaceAndSessionAction(actionCtx) {
  const {
    client,
    activeRuns,
    runner,
    config,
    state,
    chatState,
    openId,
    targetChatId,
    openMessageId,
    threadRootId,
    runKey,
    value,
    cmd,
    arg,
    inplace,
    sendToTarget,
    renderPanel,
  } = actionCtx;

  if (cmd === 'panel' || cmd === 'status') {
    if (inplace) {
      return toastCardResponse('info', '已刷新控制面板', renderPanel());
    }
    void sendToTarget(renderPanel()).catch((err) => {
      console.error('[feishu-remote] send panel card error:', err.message);
    });
    return toastCardResponse('info', '已打开控制面板');
  }

  if (cmd === 'help') {
    const card = buildPanelHelpCard();
    if (inplace) {
      return toastCardResponse('info', '控制面板功能说明', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send help card error:', err.message);
    });
    return toastCardResponse('info', '已打开面板功能说明');
  }

  if (cmd === 'help_commands') {
    const card = buildCard({
      title: '📖 全部斜杠指令',
      template: 'blue',
      markdown: formatHelpMarkdown(),
      buttonRows: [[
        { label: '📘 面板按钮说明', type: 'primary', value: { cmd: 'help', inplace: true } },
        { label: '🧩 命令', value: { cmd: 'skills_menu', inplace: true } },
        { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
      ]],
      footer: '所有指令均可在私聊或话题群直接发送',
    });
    if (inplace) {
      return toastCardResponse('info', '全部斜杠指令', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send commands help card error:', err.message);
    });
    return toastCardResponse('info', '已打开斜杠指令说明');
  }

  if (cmd === 'skills_menu') {
    const card = buildAgySkillsCard();
    if (inplace) {
      return toastCardResponse('info', 'agy 命令与本机技能', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send skills card error:', err.message);
    });
    return toastCardResponse('info', '已打开命令与技能菜单');
  }

  if (cmd === 'run_agy_cmd') {
    const allowedCommands = new Set(['/compact']);
    const promptText = arg.trim();
    if (!allowedCommands.has(promptText)) {
      return toastCardResponse('error', '不支持一键执行的命令');
    }
    const wasRunning = Boolean(runKey && activeRuns.has(runKey));
    if (wasRunning && runner.getQueueForChat(runKey).length >= 5) {
      return toastCardResponse('warning', '任务队列已满（最多 5 条），请先清理队列');
    }
    saveState(state);
    void runner.enqueueOrExecutePrompt({
      text: promptText,
      displayPreview: promptText,
      chatId: targetChatId,
      openId,
      messageId: '',
      sessionKey: runKey,
      threadRootId,
      replyInThread: Boolean(threadRootId),
      config,
    }).catch((err) => {
      console.error('[feishu-remote] run_agy_cmd error:', err);
    });
    return toastCardResponse('success', wasRunning ? `📥 已加入队列：${promptText}` : `🚀 已触发：${promptText}`);
  }

  if (cmd === 'new') {
    chatState.conversationId = '';
    chatState.pendingHandoff = null;
    chatState.originDesktopSession = null;
    chatState.lastTurnArtifacts = null;
    chatState.topicClosed = false;
    saveState(state);
    return toastCardResponse('success', '✅ 已开启新对话', inplace ? renderPanel() : null);
  }

  if (cmd === 'mode') {
    if (!VALID_MODES.includes(arg)) {
      return toastCardResponse('error', `无效模式：${arg}`);
    }
    chatState.mode = arg;
    chatState.fullExpiresAt = 0;
    saveState(state);
    return toastCardResponse('success', `已切换为 ${arg} 模式`, inplace ? renderPanel() : null);
  }

  if (cmd === 'mode_temp_full') {
    const minutes = normalizeTempMinutes(arg, 30);
    chatState.fullRevertMode =
      chatState.mode && chatState.mode !== 'full'
        ? chatState.mode
        : chatState.fullRevertMode && chatState.fullRevertMode !== 'full'
          ? chatState.fullRevertMode
          : 'accept-edits';
    chatState.mode = 'full';
    chatState.fullExpiresAt = Date.now() + minutes * 60_000;
    saveState(state);
    return toastCardResponse(
      'warning',
      `⚡ 已开启 ${minutes}m 临时全权（到期自动切回 ${chatState.fullRevertMode}）`,
      inplace ? renderPanel() : null,
    );
  }

  if (cmd === 'effort_menu') {
    const card = buildEffortCard(chatState.effort || config.agy.defaultEffort || '');
    if (inplace) {
      return toastCardResponse('info', '推理强度设置', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send effort card error:', err.message);
    });
    return toastCardResponse('info', '已打开推理强度设置');
  }

  if (cmd === 'effort') {
    const normalized = arg.trim().toLowerCase();
    if (normalized && normalized !== 'default' && !VALID_EFFORTS.includes(normalized)) {
      return toastCardResponse('error', `无效推理强度：${arg}`);
    }
    chatState.effort = normalized === 'default' || !normalized ? '' : normalized;
    saveState(state);
    return toastCardResponse(
      'success',
      `已切换推理强度为 ${chatState.effort || 'default'}`,
      inplace ? renderPanel() : null,
    );
  }

  if (cmd === 'cd') {
    const targetDir = expandHomePath(arg, chatState.cwd);
    try {
      const stat = fs.statSync(targetDir);
      if (!stat.isDirectory()) {
        return toastCardResponse('error', '目标路径不是文件夹');
      }
      chatState.cwd = targetDir;
      if (threadRootId && targetChatId) {
        getOrCreateChatState(state, targetChatId, config).cwd = targetDir;
      }
      saveState(state);
      return toastCardResponse(
        'success',
        `已切换目录到 ${path.basename(targetDir) || targetDir}`,
        inplace ? renderPanel() : null,
      );
    } catch (err) {
      return toastCardResponse('error', `切换目录失败：${err.message}`);
    }
  }

  if (cmd === 'pin' || cmd === 'pin_in_dirs') {
    const resolved = path.resolve(chatState.cwd);
    const canonicalCurrent = canonicalizeDirPath(resolved);
    const existing = Array.isArray(config.agy.favoriteDirs)
      ? config.agy.favoriteDirs.map((d) => path.resolve(d))
      : [];
    const hasMatch = existing.some((d) => canonicalizeDirPath(d) === canonicalCurrent);
    let actionLabel = '';
    let nextFavorites;
    if (hasMatch) {
      nextFavorites = existing.filter((d) => canonicalizeDirPath(d) !== canonicalCurrent);
      actionLabel = '已取消收藏当前目录';
    } else {
      nextFavorites = [resolved, ...existing];
      actionLabel = '已收藏到快捷目录';
    }
    config.agy.favoriteDirs = nextFavorites;
    saveConfig(config);
    saveState(state);
    const page = Number(value?.page || 0);
    if (cmd === 'pin_in_dirs') {
      return toastCardResponse('success', actionLabel, buildDirsCard({ chatState, config, page }));
    }
    return toastCardResponse('success', actionLabel, inplace ? renderPanel() : null);
  }

  if (cmd === 'dirs') {
    if (value?.showHidden !== undefined) {
      chatState.showHiddenDirs = Boolean(value.showHidden);
    }
    saveState(state);
    const page = Number(value?.page || 0);
    const card = buildDirsCard({ chatState, config, page });
    if (inplace) {
      const toastMsg = value?.showHidden !== undefined
        ? chatState.showHiddenDirs
          ? '👁️ 已开启显示隐藏目录'
          : '🙈 已隐藏点开头目录'
        : value?.page !== undefined
          ? '已切换目录页'
          : '目录浏览';
      return toastCardResponse('info', toastMsg, card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send dirs card error:', err.message);
    });
    return toastCardResponse('info', '已打开目录浏览');
  }

  if (cmd === 'dir_nav') {
    const targetDir = expandHomePath(arg, chatState.cwd);
    try {
      const stat = fs.statSync(targetDir);
      if (!stat.isDirectory()) {
        return toastCardResponse('error', '目标路径不是文件夹');
      }
      chatState.cwd = targetDir;
      if (threadRootId && targetChatId) {
        getOrCreateChatState(state, targetChatId, config).cwd = targetDir;
      }
      saveState(state);
      return toastCardResponse(
        'success',
        `已进入 ${path.basename(targetDir) || targetDir}`,
        buildDirsCard({ chatState, config }),
      );
    } catch (err) {
      return toastCardResponse('error', `进入目录失败：${err.message}`);
    }
  }

  if (cmd === 'stop') {
    const running = runKey ? activeRuns.get(runKey) : null;
    if (!running) {
      return toastCardResponse('info', '当前没有运行中的任务', inplace ? renderPanel() : null);
    }
    running.controller.abort();
    return toastCardResponse('warning', '🛑 已发送中止信号', inplace ? renderPanel() : null);
  }

  if (cmd === 'use') {
    if (!arg) {
      return toastCardResponse('error', '缺少会话 ID');
    }
    chatState.conversationId = arg;
    chatState.pendingHandoff = null;
    chatState.originDesktopSession = null;
    chatState.lastTurnArtifacts = null;
    chatState.topicClosed = false;
    saveState(state);
    return toastCardResponse(
      'success',
      `已切换到会话 ${arg.slice(0, 8)}`,
      inplace ? buildSessionsCard(chatState) : null,
    );
  }

  if (cmd === 'model') {
    chatState.model = arg === 'default' || !arg ? '' : arg;
    saveState(state);
    return toastCardResponse(
      'success',
      `已切换模型为 ${chatState.model || 'default'}`,
      inplace ? renderPanel() : null,
    );
  }

  if (cmd === 'sessions') {
    const card = buildSessionsCard(chatState);
    if (inplace) {
      return toastCardResponse('info', '最近会话', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send sessions card error:', err.message);
    });
    return toastCardResponse('info', '已打开最近会话');
  }

  if (cmd === 'models') {
    void listAgyModels(config)
      .then(async (models) => {
        const card = buildModelsCard(models, chatState.model);
        if (inplace && openMessageId) {
          try {
            await patchCard(client, { messageId: openMessageId, card });
            return;
          } catch {
            // Fallback to sending a new card
          }
        }
        await sendToTarget(card);
      })
      .catch((err) => sendToTarget(buildCard({
        title: '❌ 查询模型失败',
        template: 'red',
        markdown: String(err.message || err),
      })))
      .catch((err) => {
        console.error('[feishu-remote] send models card error:', err.message);
      });
    return toastCardResponse('info', '正在获取模型列表...');
  }

  return null;
}
