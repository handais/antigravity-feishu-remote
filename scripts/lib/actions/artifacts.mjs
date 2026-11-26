import fs from 'node:fs';
import path from 'node:path';
import { saveConfig, saveState, resolveRiskyApprovalEnabled } from '../config.mjs';
import { filterSensitiveGitDiff, isSensitiveFilePath } from '../security.mjs';
import {
  buildCard,
  buildSystemSettingsCard,
  chunkButtons,
  sendLocalMedia,
} from '../feishu-api.mjs';
import { collectTurnDiffAsync, formatUptime, toastCardResponse } from '../bridge-helpers.mjs';
import {
  buildApprovalCard,
  readApprovalRequest,
  tryWriteApprovalDecisionExclusive,
} from '../command-guard.mjs';

export { isSensitiveFilePath };

export async function handleArtifactAction(actionCtx) {
  const {
    client,
    config,
    state,
    chatState,
    openId,
    targetChatId,
    threadRootId,
    value,
    cmd,
    arg,
    inplace,
    sendToTarget,
    renderPanel,
  } = actionCtx;

  if (cmd === 'turn_diff') {
    const artifacts = chatState.lastTurnArtifacts;
    const cwd = artifacts?.cwd || chatState.cwd;
    const files = Array.isArray(artifacts?.files) ? artifacts.files : [];
    const safeFiles = files.filter((f) => !isSensitiveFilePath(f));
    const sensitiveFiles = files.filter((f) => isSensitiveFilePath(f));
    const diffInfo = files.length > 0 && safeFiles.length === 0
      ? { isRepo: false, stat: '', diff: '', truncated: false, untrackedFiles: [], existingFiles: [] }
      : await collectTurnDiffAsync(cwd, safeFiles);
    if (files.length === 0) {
      if (diffInfo.diff) {
        const filtered = filterSensitiveGitDiff(diffInfo.diff);
        diffInfo.diff = filtered.diff;
        for (const sf of filtered.skippedFiles) {
          sensitiveFiles.push(sf);
        }
      }
      if (Array.isArray(diffInfo.untrackedFiles)) {
        for (const uf of diffInfo.untrackedFiles) {
          if (isSensitiveFilePath(uf)) sensitiveFiles.push(uf);
        }
        diffInfo.untrackedFiles = diffInfo.untrackedFiles.filter((f) => !isSensitiveFilePath(f));
      }
    }

    const escapeFence = (s) => String(s || '').replace(/```/g, '\\`\\`\\`');
    const lines = [`- **工作目录**：\`${cwd}\``];
    if (files.length > 0) {
      lines.push(`- **本轮触及文件（${files.length}）**：${files.map((f) => `\`${path.basename(f)}\``).join('、')}`);
    }
    if (sensitiveFiles.length > 0) {
      lines.push(
        `> 🔒 出于隐私保护，已自动跳过 ${sensitiveFiles.length} 个敏感文件的明文 Diff：${sensitiveFiles.map((f) => `\`${path.basename(f)}\``).join('、')}`,
      );
    }

    if (diffInfo.isRepo) {
      if (diffInfo.stat) {
        lines.push('', '**变更统计：**', '```text', escapeFence(diffInfo.stat), '```');
      }
      if (diffInfo.diff) {
        lines.push('', '**Git Diff：**', '```diff', escapeFence(diffInfo.diff), '```');
      } else if (diffInfo.untrackedFiles.length > 0) {
        lines.push('', '**新增未跟踪文件：**', ...diffInfo.untrackedFiles.map((f) => `- \`${f}\``));
      } else {
        lines.push('', '_当前无未提交的 Git diff（可能已提交或仅新建了未跟踪文件）。_');
      }
    } else if (diffInfo.existingFiles.length > 0) {
      lines.push('', '**本地文件状态（非 Git 仓库）：**');
      for (const f of diffInfo.existingFiles) {
        lines.push(`- \`${f.path}\`（${(f.sizeBytes / 1024).toFixed(1)} KB）`);
      }
    } else if (sensitiveFiles.length === 0) {
      lines.push('', '_暂未记录本轮文件改动。_');
    }

    const buttons = [];
    if (files.length === 1) {
      buttons.push({ label: `📥 发到聊天：${path.basename(files[0]).slice(0, 12)}`, type: 'primary', value: { cmd: 'turn_send_file', arg: '0' } });
    } else if (files.length > 1) {
      buttons.push({ label: `📄 查看改动文件(${files.length})`, type: 'primary', value: { cmd: 'turn_files', inplace: true } });
    }
    buttons.push({ label: '💻 交回电脑', value: { cmd: 'handoff', inplace: true } });
    buttons.push({ label: '⚙️ 控制面板', value: { cmd: 'panel', inplace: true } });

    const card = buildCard({
      title: '🔍 本轮文件改动详情',
      template: diffInfo.diff || diffInfo.untrackedFiles.length > 0 ? 'wathet' : 'blue',
      markdown: lines.join('\n'),
      buttonRows: [buttons],
    });
    if (inplace) {
      return toastCardResponse('info', '本轮文件改动', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send turn_diff card error:', err.message);
    });
    return toastCardResponse('info', '已发送本轮改动详情');
  }

  if (cmd === 'turn_files') {
    const files = Array.isArray(chatState.lastTurnArtifacts?.files)
      ? chatState.lastTurnArtifacts.files
      : [];
    if (files.length === 0) {
      return toastCardResponse('info', '暂无本轮修改文件记录');
    }
    const lines = [
      `共记录 **${files.length}** 个本轮修改文件，点击下方按钮即可直接回传到飞书：`,
      '',
      ...files.map((f, idx) => `${idx + 1}. \`${f}\``),
    ];
    const fileButtons = files.slice(0, 8).map((f, idx) => ({
      label: `📥 发到聊天：${idx + 1}. ${path.basename(f).slice(0, 12)}`,
      type: idx === 0 ? 'primary' : 'default',
      value: { cmd: 'turn_send_file', arg: String(idx) },
    }));
    const card = buildCard({
      title: '📄 本轮改动文件列表',
      template: 'blue',
      markdown: lines.join('\n'),
      buttonRows: [
        ...chunkButtons(fileButtons, 2),
        [
          { label: '🔍 看改动 Diff', value: { cmd: 'turn_diff', inplace: true } },
          { label: '⚙️ 控制面板', value: { cmd: 'panel', inplace: true } },
        ],
      ],
    });
    if (inplace) {
      return toastCardResponse('info', '本轮修改文件列表', card);
    }
    void sendToTarget(card).catch((err) => {
      console.error('[feishu-remote] send turn_files card error:', err.message);
    });
    return toastCardResponse('info', '已打开本轮修改文件列表');
  }

  if (cmd === 'turn_send_file') {
    const files = Array.isArray(chatState.lastTurnArtifacts?.files)
      ? chatState.lastTurnArtifacts.files
      : [];
    const idx = Number(arg);
    if (!Number.isInteger(idx) || idx < 0 || idx >= files.length) {
      return toastCardResponse('error', '未找到对应的修改文件索引');
    }
    const targetFile = files[idx];
    if (isSensitiveFilePath(targetFile)) {
      return toastCardResponse(
        'warning',
        `🔒 出于隐私保护，拒绝一键外发敏感文件：${path.basename(targetFile)}（如需发送请核对后手动用 /send）`,
      );
    }
    try {
      if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
        return toastCardResponse('error', `文件不存在或不是普通文件：${path.basename(targetFile)}`);
      }
      const receiveId = targetChatId || openId;
      const receiveIdType = targetChatId ? 'chat_id' : 'open_id';
      const sent = await sendLocalMedia(client, {
        receiveId,
        receiveIdType,
        filePath: targetFile,
        replyToMessageId: threadRootId,
        replyInThread: Boolean(threadRootId),
      });
      return toastCardResponse('success', `✅ 已发送 ${sent.fileName}`);
    } catch (err) {
      return toastCardResponse('error', `发送文件失败：${err?.message || err}`);
    }
  }

  if (cmd === 'approval_decide') {
    const approvalId = arg.trim();
    const decision = String(value?.decision || '').trim().toLowerCase();
    if (!approvalId || (decision !== 'allow' && decision !== 'deny')) {
      return toastCardResponse('error', '无效的审批参数');
    }
    const request = readApprovalRequest(approvalId);
    if (!request) {
      return toastCardResponse('error', '审批请求不存在或已过期清理');
    }
    const timeoutMs = Math.max(15, Math.min(160, Number(request.timeoutSeconds || 120))) * 1000;
    const isPastDeadline = Number(request.createdAt || 0) > 0 && Date.now() > Number(request.createdAt) + timeoutMs;
    if (isPastDeadline) {
      const expClaim = tryWriteApprovalDecisionExclusive(approvalId, {
        decision: 'deny',
        decidedBy: '',
        expired: true,
      });
      const resolved = expClaim.written ? expClaim.record : expClaim.existing;
      if (resolved && !resolved.expired) {
        const card = buildApprovalCard({
          request,
          status: resolved.decision === 'allow' ? 'allowed' : 'denied',
          decidedBy: resolved.decidedBy,
        });
        return toastCardResponse('info', '该审批已处理过', card);
      }
      return toastCardResponse(
        'warning',
        '⏱️ 该审批请求已超时自动拒绝',
        buildApprovalCard({ request, status: 'expired' }),
      );
    }

    const claim = tryWriteApprovalDecisionExclusive(approvalId, { decision, decidedBy: openId });
    if (!claim.written) {
      const existing = claim.existing;
      if (existing?.expired) {
        return toastCardResponse(
          'warning',
          '⏱️ 该审批刚刚已超时自动拒绝',
          buildApprovalCard({ request, status: 'expired' }),
        );
      }
      const card = buildApprovalCard({
        request,
        status: existing?.decision === 'allow' ? 'allowed' : 'denied',
        decidedBy: existing?.decidedBy || '',
      });
      return toastCardResponse('info', '该审批已处理过', card);
    }

    const card = buildApprovalCard({
      request,
      status: decision === 'allow' ? 'allowed' : 'denied',
      decidedBy: openId,
    });
    return toastCardResponse(
      decision === 'allow' ? 'success' : 'warning',
      decision === 'allow' ? '✅ 已批准本次高危命令执行' : '❌ 已拒绝本次高危命令',
      card,
    );
  }

  if (cmd === 'guard_toggle') {
    const requested = arg.trim().toLowerCase();
    const currentlyEnabled = resolveRiskyApprovalEnabled(config);
    const nextEnabled = requested === 'on'
      ? true
      : requested === 'off'
        ? false
        : !currentlyEnabled;
    config.security.riskyCommandApproval = nextEnabled ? 'on' : 'off';
    saveConfig(config);
    saveState(state);
    return toastCardResponse(
      nextEnabled ? 'success' : 'warning',
      nextEnabled ? '🛡️ 已开启高危命令飞书审批' : '⚪ 已关闭高危命令飞书审批',
      inplace
        ? value?.fromSystem
          ? buildSystemSettingsCard({
              config,
              isRunning: actionCtx.anyBusy?.() || false,
              uptimeText: formatUptime(Date.now() - (actionCtx.startedAt || Date.now())),
            })
          : renderPanel()
        : null,
    );
  }

  return null;
}
