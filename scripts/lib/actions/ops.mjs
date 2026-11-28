import { updateConfig, updateState, VALID_NOTIFY_MODES } from '../config.mjs';
import {
  buildCard,
  buildGitStatusCard,
  buildNotifyCard,
  buildScopesCard,
  buildSystemSettingsCard,
  buildTimeoutCard,
} from '../feishu-api.mjs';
import { applyPendingAppScopes, queryAppScopes } from '../feishu-docs.mjs';
import {
  createBackupSnapshot,
  findRollbackTarget,
  restoreBackupSnapshotAsync,
  runPreflightCheckAsync,
  scheduleDaemonSelfRestart,
  writePendingRestartNotice,
} from '../self-ops.mjs';
import {
  buildCurrentOpsCard,
  collectGitInfoAsync,
  formatTimeoutLabel,
  formatUptime,
  getOrCreateChatState,
  parseTimeoutArg,
  toastCardResponse,
} from '../bridge-helpers.mjs';

export async function handleOpsAction(actionCtx) {
  const {
    client,
    startedAt,
    bootCodeHash,
    stopWsForRestart,
    config,
    state,
    chatState,
    openId,
    targetChatId,
    threadRootId,
    runKey,
    value,
    cmd,
    arg,
    inplace,
    isRunning,
    anyBusy,
    sendToTarget,
  } = actionCtx;

  const wrapSlow = (pendingToast, fn) => (
    typeof actionCtx.runWithinBudget === 'function'
      ? actionCtx.runWithinBudget(pendingToast, fn)
      : fn()
  );

  if (cmd === 'system_menu') {
    const card = buildSystemSettingsCard({
      config,
      chatState,
      isRunning: anyBusy(),
      uptimeText: formatUptime(Date.now() - (startedAt || Date.now())),
    });
    if (inplace) {
      return toastCardResponse('info', '设置', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send system settings card error:', err.message);
    });
    return toastCardResponse('info', '已打开设置');
  }

  if (cmd === 'reset_frequent_actions') {
    updateState((latest) => {
      latest.panelActionUsage = {};
    });
    state.panelActionUsage = {};
    const card = buildSystemSettingsCard({
      config,
      chatState,
      isRunning: anyBusy(),
      uptimeText: formatUptime(Date.now() - (startedAt || Date.now())),
    });
    return toastCardResponse('success', '🧹 已清空常用操作记录', inplace ? card : null);
  }

  if (cmd === 'ops' || cmd === 'backups') {
    const card = buildCurrentOpsCard({ bootCodeHash, isRunning: anyBusy() });
    if (inplace) {
      return toastCardResponse('info', '运维与快照', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send ops card error:', err.message);
    });
    return toastCardResponse('info', '已打开运维与快照面板');
  }

  if (cmd === 'preflight') {
    return wrapSlow('🧪 正在执行代码体检...', async () => {
      const check = await runPreflightCheckAsync();
      return toastCardResponse(
        check.ok ? 'success' : 'error',
        check.ok ? '✅ 语法与导入检查全部通过' : '❌ 发现代码错误，请先修复或回滚',
        buildCurrentOpsCard({ bootCodeHash, checkResult: check, isRunning: anyBusy() }),
      );
    });
  }

  if (cmd === 'snapshot') {
    return wrapSlow('📸 正在创建预检与代码快照...', async () => {
      const check = await runPreflightCheckAsync();
      if (!check.ok) {
        return toastCardResponse(
          'error',
          '❌ 当前代码未通过检查，拒绝创建快照',
          buildCurrentOpsCard({ bootCodeHash, checkResult: check, isRunning: anyBusy() }),
        );
      }
      const res = createBackupSnapshot({ reason: 'manual', force: true });
      return toastCardResponse(
        'success',
        `📸 已保存快照 ${res.snapshot.shortHash}`,
        buildCurrentOpsCard({ bootCodeHash, checkResult: check, isRunning: anyBusy() }),
      );
    });
  }

  if (cmd === 'notify_menu') {
    const card = buildNotifyCard({ config });
    if (inplace) {
      return toastCardResponse('info', '桌面端完成提醒设置', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send notify card error:', err.message);
    });
    return toastCardResponse('info', '已打开桌面端提醒设置');
  }

  if (cmd === 'notify_mode') {
    const modeArg = arg.trim().toLowerCase();
    if (!VALID_NOTIFY_MODES.includes(modeArg)) {
      return toastCardResponse('error', `无效提醒模式：${arg}`);
    }
    updateConfig((c) => {
      c.notifications.stopNotifyMode = modeArg;
      c.notifications.stopHookEnabled = modeArg !== 'off';
    });
    config.notifications.stopNotifyMode = modeArg;
    config.notifications.stopHookEnabled = modeArg !== 'off';
    const label = modeArg === 'on'
      ? '🔔 已设为始终提醒'
      : modeArg === 'away'
        ? '🧠 已设为仅离开电脑时提醒'
        : '🔕 已关闭桌面端完成提醒';
    return toastCardResponse('success', label, inplace ? buildNotifyCard({ config }) : null);
  }

  if (cmd === 'notify_idle') {
    const rawSec = Number(arg);
    const clampedSec = Number.isFinite(rawSec) ? Math.max(30, Math.min(1800, Math.round(rawSec))) : 120;
    updateConfig((c) => {
      c.notifications.awayIdleSeconds = clampedSec;
      c.notifications.stopNotifyMode = 'away';
      c.notifications.stopHookEnabled = true;
    });
    config.notifications.awayIdleSeconds = clampedSec;
    config.notifications.stopNotifyMode = 'away';
    config.notifications.stopHookEnabled = true;
    const minLabel = Math.max(1, Math.round(clampedSec / 60));
    return toastCardResponse(
      'success',
      `🧠 已设为离开电脑 ≥ ${minLabel} 分钟才提醒`,
      inplace ? buildNotifyCard({ config }) : null,
    );
  }

  if (cmd === 'timeout_menu') {
    const card = buildTimeoutCard({ chatState, config });
    if (inplace) {
      return toastCardResponse('info', '单轮超时设置', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send timeout card error:', err.message);
    });
    return toastCardResponse('info', '已打开单轮超时设置');
  }

  if (cmd === 'timeout_set') {
    const seconds = parseTimeoutArg(arg);
    if (seconds === null) {
      return toastCardResponse('error', `无效超时参数：${arg}`);
    }
    const scope = String(value?.scope || 'global').trim().toLowerCase();
    if (scope === 'chat') {
      updateState((latest) => {
        const targetChat = getOrCreateChatState(latest, runKey, config);
        targetChat.timeoutSeconds = seconds;
        Object.assign(chatState, targetChat);
      });
      return toastCardResponse(
        'success',
        `⏱️ 本会话单轮超时已设为：${formatTimeoutLabel(seconds)}`,
        inplace ? buildTimeoutCard({ chatState, config }) : null,
      );
    }

    updateConfig((c) => {
      c.agy.timeoutSeconds = seconds;
    });
    config.agy.timeoutSeconds = seconds;
    let clearedOverride = false;
    updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, runKey, config);
      if (targetChat.timeoutSeconds !== undefined && targetChat.timeoutSeconds !== null) {
        delete targetChat.timeoutSeconds;
        clearedOverride = true;
      }
      delete chatState.timeoutSeconds;
      Object.assign(chatState, targetChat);
    });
    const toastText = clearedOverride
      ? `⏱️ 全局单轮超时已设为：${formatTimeoutLabel(seconds)}（已清除本会话覆盖）`
      : `⏱️ 全局单轮超时已设为：${formatTimeoutLabel(seconds)}`;
    return toastCardResponse(
      'success',
      toastText,
      inplace ? buildTimeoutCard({ chatState, config }) : null,
    );
  }

  if (cmd === 'timeout_clear_override') {
    updateState((latest) => {
      const targetChat = getOrCreateChatState(latest, runKey, config);
      delete targetChat.timeoutSeconds;
      delete chatState.timeoutSeconds;
      Object.assign(chatState, targetChat);
    });
    return toastCardResponse(
      'success',
      `↩️ 已清除本会话覆盖，恢复跟随全局默认（${formatTimeoutLabel(config?.agy?.timeoutSeconds ?? 3600)}）`,
      inplace ? buildTimeoutCard({ chatState, config }) : null,
    );
  }

  if (cmd === 'safe_restart') {
    if (anyBusy()) {
      return toastCardResponse('warning', '当前有任务运行或排队中，请先中止或清空队列后再重启');
    }
    return wrapSlow('♻️ 正在预检并准备安全重启...', async () => {
      const check = await runPreflightCheckAsync();
      if (!check.ok) {
        return toastCardResponse(
          'error',
          '❌ 预检失败，已取消重启（服务保持在线）',
          buildCurrentOpsCard({ bootCodeHash, checkResult: check, isRunning }),
        );
      }
      writePendingRestartNotice({
        chatId: targetChatId,
        openId,
        sessionKey: runKey,
        threadRootId,
        replyInThread: Boolean(threadRootId),
        action: 'restart',
        snapshotId: '',
        previousHash: bootCodeHash,
        requestedAt: Date.now(),
      });
      scheduleDaemonSelfRestart({ delayMs: 700, onBeforeExit: stopWsForRestart });
      return toastCardResponse(
        'success',
        '✅ 预检通过，正在安全重启...',
        buildCard({
          title: '♻️ 正在安全重启守护进程...',
          template: 'wathet',
          markdown: [
            `- 预检结果：✅ 通过（${check.checkedFiles.length} 个脚本，耗时 ${check.durationMs}ms）`,
            `- 目标代码版本：\`${check.hash.slice(0, 8)}\``,
            '',
            '预计 1~3 秒后自动上线，上线后会推送确认卡片。',
          ].join('\n'),
          footer: '如长时间未收到上线通知，请在本机终端查看 cli.mjs logs',
        }),
      );
    });
  }

  if (cmd === 'rollback_confirm') {
    const target = findRollbackTarget(arg);
    if (!target) {
      return toastCardResponse('info', '暂无更早的可用快照可回滚', buildCurrentOpsCard({ bootCodeHash, isRunning }));
    }
    return toastCardResponse(
      'warning',
      `请确认回滚到 ${target.shortHash}`,
      buildCurrentOpsCard({ bootCodeHash, isRunning, confirmSnapshot: target }),
    );
  }

  if (cmd === 'rollback_exec') {
    if (anyBusy()) {
      return toastCardResponse('warning', '当前有任务运行或排队中，请先中止后再回滚');
    }
    return wrapSlow('⏪ 正在校验并恢复快照...', async () => {
      const res = await restoreBackupSnapshotAsync(arg);
      if (!res.ok) {
        return toastCardResponse(
          'error',
          res.error || '❌ 回滚后预检失败',
          buildCurrentOpsCard({ bootCodeHash, checkResult: res.check, isRunning }),
        );
      }
      writePendingRestartNotice({
        chatId: targetChatId,
        openId,
        sessionKey: runKey,
        threadRootId,
        replyInThread: Boolean(threadRootId),
        action: 'rollback',
        snapshotId: res.snapshot.id,
        previousHash: bootCodeHash,
        requestedAt: Date.now(),
      });
      scheduleDaemonSelfRestart({ delayMs: 700, onBeforeExit: stopWsForRestart });
      return toastCardResponse(
        'success',
        `⏪ 已回滚到 ${res.snapshot.shortHash}，正在重启...`,
        buildCard({
          title: '⏪ 已恢复历史快照，正在重启...',
          template: 'orange',
          markdown: [
            `- 目标快照：\`${res.snapshot.id}\``,
            `- 恢复文件数：${res.restoredFilesCount}`,
            '- 预检结果：✅ 通过',
            '',
            '预计 1~3 秒后自动重新上线。',
          ].join('\n'),
          footer: '上线后会自动推送确认卡片',
        }),
      );
    });
  }

  if (cmd === 'git') {
    const card = buildGitStatusCard({ cwd: chatState.cwd, gitInfo: await collectGitInfoAsync(chatState.cwd) });
    if (inplace) {
      return toastCardResponse('info', 'Git 仓库状态', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send git card error:', err.message);
    });
    return toastCardResponse('info', '已查询 Git 状态');
  }

  if (cmd === 'scopes') {
    return wrapSlow('🔐 正在查询应用权限状态...', async () => {
      try {
        const scopeData = await queryAppScopes(client);
        const card = buildScopesCard(scopeData);
        if (inplace) {
          return toastCardResponse('info', '应用权限状态', card);
        }
        void sendToTarget(card).catch((err) => {
          console.error('[feishu-remote] send scopes card error:', err.message);
        });
        return toastCardResponse('info', '已查询权限状态');
      } catch (err) {
        return toastCardResponse('error', `查询权限失败：${err?.message || err}`);
      }
    });
  }

  if (cmd === 'scopes_apply') {
    return wrapSlow('🔐 正在提交权限审批申请...', async () => {
      try {
        const applyResult = await applyPendingAppScopes(client);
        const scopeData = await queryAppScopes(client);
        return toastCardResponse(
          applyResult.ok ? 'success' : 'warning',
          applyResult.ok ? '已发送权限审批申请' : applyResult.msg,
          buildScopesCard({ ...scopeData, applyResult }),
        );
      } catch (err) {
        return toastCardResponse('error', `提交申请失败：${err?.message || err}`);
      }
    });
  }

  return null;
}
