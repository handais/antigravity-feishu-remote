import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureConfigDir, getApprovalsDir, getConfigDir } from './config.mjs';
import { expandHomePath, writePrivateJsonAtomic } from './io-utils.mjs';
import { buildCard, sanitizeForFeishuMarkdown } from './feishu-api.mjs';

const APPROVAL_ID_RE = /^apr-[a-z0-9-]+$/i;
const GIT_GLOBAL_FLAGS = '(?:\\s+(?:-C\\s+\\S+|-c\\s+\\S+|--git-dir(?:=\\S+|\\s+\\S+)|--work-tree(?:=\\S+|\\s+\\S+)|--no-pager))*';

const RISKY_COMMAND_RULES = [
  {
    rule: 'recursive-delete',
    level: 'critical',
    summary: '递归强制删除文件/目录 (rm -rf / rmdir /s / del /s / Remove-Item -Recurse)',
    pattern: /(?:^|[;&|(`]\s*)(?:(?:(?:\/(?:usr\/)?bin\/)|(?:command|env)\s+)?rm\s+(?:[^\n]*\s)?(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|--recursive\b|-r\b[^\n]*\s-f\b|-f\b[^\n]*\s-r\b|-[^\s]*[rR](?:\s|$))|(?:cmd\s+\/c\s+)?rmdir\s+\/s\b|rd\s+\/s\b|del\s+(?:[^\n]*\s)?\/[sfq]\b|remove-item\b[^\n]*-recurse|find\b[^\n]*\s-delete(?:\s|$))/i,
  },
  {
    rule: 'git-force-push',
    level: 'critical',
    summary: 'Git 强制推送或删除远端分支 (git push --force / -f / +branch / --delete / :branch)',
    pattern: new RegExp(
      `(?:^|[;&|(\\x60]\\s*)(?:\\/\\S*\\/)?git${GIT_GLOBAL_FLAGS}\\s+push\\b[^\\n]*(?:--force(?:-with-lease)?|\\s-f(?:\\s|$)|\\s-d(?:\\s|$)|\\s--delete\\b|\\s\\+[a-zA-Z0-9._/-]+(?::[a-zA-Z0-9._/-]+)?(?:\\s|$)|\\s:[a-zA-Z0-9._/-]+(?:\\s|$))`,
      'i',
    ),
  },
  {
    rule: 'git-destructive-reset',
    level: 'high',
    summary: 'Git 破坏性重置或清理工作区 (reset --hard / clean -f / branch -D)',
    pattern: new RegExp(
      `(?:^|[;&|(\\x60]\\s*)(?:\\/\\S*\\/)?git${GIT_GLOBAL_FLAGS}\\s+(?:reset\\s+--hard|clean\\s+-[^\\n]*f|checkout\\s+--\\s+\\.|branch\\s+-D\\b)`,
      'i',
    ),
  },
  {
    rule: 'privilege-escalation',
    level: 'high',
    summary: '使用提权命令 (sudo)',
    pattern: /(?:^|(?:&&|\|\||[;&|(`])\s*|(?:env|command)\s+)(?:\/(?:usr\/)?bin\/)?sudo\b/i,
  },
  {
    rule: 'system-mutation',
    level: 'critical',
    summary: '系统级磁盘、服务、权限或进程强杀操作',
    pattern: /(?:^|[;&|(`]\s*)(?:(?:\/(?:usr\/)?(?:s?bin)\/)|(?:env|command)\s+)?(?:mkfs(?:\.\w+)?|dd\s+if=|diskutil\s+(?:erase|unmount|partition)|shutdown\b|reboot\b|launchctl\s+(?:unload|remove|bootout)|chmod\s+-R\s+777\b|chown\s+-R\b|killall\b|pkill\s+-9\b)/i,
  },
  {
    rule: 'pipe-to-shell',
    level: 'high',
    summary: '远程脚本直接交由 Shell / 解释器执行 (curl/wget/irm | sh/python/node/iex)',
    pattern: /(?:(?:curl|wget)\b[^\n|]*\|\s*(?:(?:env|command)\s+)?(?:\/(?:usr\/(?:local\/)?)?bin\/)?(?:(?:ba|z|da)?sh|python\d*|node|perl|ruby)\b|(?:(?:ba|z)?sh)\s+<\(\s*(?:curl|wget)\b|\b(?:irm|invoke-restmethod|iwr|invoke-webrequest)\b[^\n|]*\|\s*(?:iex|invoke-expression)\b)/i,
  },
  {
    rule: 'shell-wrapper-or-eval',
    level: 'critical',
    summary: '通过子 Shell / eval / xargs / 解释器内联执行高危操作',
    pattern: /(?:(?:(?:ba|z|da)?sh)\s+-[a-zA-Z]*c\s+[^\n]*(?:\brm\s+-[^\s]*r|\bsudo\b|\bmkfs\b|\bdd\s+if=|\bgit\s+push\b[^\n]*--force)|\b(?:eval|xargs)\b[^\n]*(?:\brm\s+-[^\s]*r|\bsudo\b|\bmkfs\b|\bdd\s+if=)|\bfind\b[^\n]*-exec\b[^\n]*\brm\s+-[^\s]*r|\bpython\d*\s+-c\b[^\n]*(?:rmtree|unlink|os\.remove|os\.system|popen)|\bnode\s+-e\b[^\n]*(?:rmSync|unlinkSync|execSync))/i,
  },
  {
    rule: 'sensitive-overwrite',
    level: 'critical',
    summary: '重定向或改写系统目录、SSH 密钥、云凭证或插件配置目录',
    pattern: /(?:(?:>{1,2}\s*|\b(?:tee(?:\s+-[a-zA-Z]+)*|cp|mv|install|ln(?:\s+-[a-zA-Z]+)*)\b[^\n]*\s)(?:["'])?(?:\/etc\/|\/System\/|\/dev\/(?!null\b)|(?:~|\$HOME|\$\{HOME\}|(?:\/Users|\/home)\/[^/\s"']+)\/(?:\.ssh\/|\.aws\/|\.gnupg\/|\.config\/antigravity-feishu\/|\.npmrc\b|\.netrc\b|\.kube\/config\b)))/i,
  },
];

export function classifyWritePathRisk(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) {
    return { risky: false, level: 'safe', rule: '', summary: '' };
  }
  const normalized = path.normalize(expandHomePath(raw)).replace(/\\/g, '/').toLowerCase();
  let cfgDirNorm = '';
  try {
    cfgDirNorm = path.normalize(path.resolve(getConfigDir())).replace(/\\/g, '/').toLowerCase();
  } catch {
    cfgDirNorm = '';
  }

  if (
    (cfgDirNorm && (normalized === cfgDirNorm || normalized.startsWith(`${cfgDirNorm}/`))) ||
    normalized.includes('/.config/antigravity-feishu/') ||
    normalized.includes('/.ssh/') ||
    normalized.includes('/.aws/') ||
    normalized.includes('/.gnupg/')
  ) {
    return {
      risky: true,
      level: 'critical',
      rule: 'sensitive-file-write',
      summary: '改写插件运行时配置/状态目录或本机敏感密钥目录',
    };
  }
  return { risky: false, level: 'safe', rule: '', summary: '' };
}

export function classifyCommandRisk(commandLine) {
  const cmd = String(commandLine || '').trim();
  if (!cmd) {
    return { risky: false, level: 'safe', rule: '', summary: '' };
  }
  for (const item of RISKY_COMMAND_RULES) {
    if (item.pattern.test(cmd)) {
      return {
        risky: true,
        level: item.level,
        rule: item.rule,
        summary: item.summary,
      };
    }
  }
  return { risky: false, level: 'safe', rule: '', summary: '' };
}

function assertValidApprovalId(id) {
  const clean = String(id || '').trim();
  if (!APPROVAL_ID_RE.test(clean)) {
    throw new Error(`Invalid approval request id: ${id}`);
  }
  return clean;
}

export function getApprovalPaths(id) {
  const cleanId = assertValidApprovalId(id);
  const dir = getApprovalsDir();
  return {
    reqPath: path.join(dir, `${cleanId}.req.json`),
    resPath: path.join(dir, `${cleanId}.res.json`),
  };
}

export function createApprovalRequest({
  commandLine,
  cwd = '',
  risk,
  chatId = '',
  openId = '',
  sessionKey = '',
  threadRootId = '',
  timeoutSeconds = 120,
}) {
  const id = `apr-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const clampedTimeout = Math.max(15, Math.min(160, Number(timeoutSeconds) || 120));
  const request = {
    id,
    commandLine: String(commandLine || ''),
    cwd: String(cwd || ''),
    risk: risk || classifyCommandRisk(commandLine),
    chatId: String(chatId || ''),
    openId: String(openId || ''),
    sessionKey: String(sessionKey || ''),
    threadRootId: String(threadRootId || ''),
    messageId: '',
    timeoutSeconds: clampedTimeout,
    createdAt: Date.now(),
  };
  const { reqPath } = getApprovalPaths(id);
  writePrivateJsonAtomic(reqPath, request);
  return request;
}

export function updateApprovalRequestMeta(id, patch = {}) {
  const existing = readApprovalRequest(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  const { reqPath } = getApprovalPaths(id);
  writePrivateJsonAtomic(reqPath, updated);
  return updated;
}

export function readApprovalRequest(id) {
  try {
    const { reqPath } = getApprovalPaths(id);
    if (!fs.existsSync(reqPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeApprovalDecision(id, { decision, decidedBy = '', expired = false } = {}) {
  const normalized = String(decision || '').trim().toLowerCase();
  if (normalized !== 'allow' && normalized !== 'deny') {
    throw new Error(`Invalid approval decision: ${decision}`);
  }
  const { resPath } = getApprovalPaths(id);
  const record = {
    id: assertValidApprovalId(id),
    decision: normalized,
    decidedBy: String(decidedBy || ''),
    expired: Boolean(expired),
    decidedAt: Date.now(),
  };
  writePrivateJsonAtomic(resPath, record);
  return record;
}

/**
 * Atomically claim the outcome of an approval request via O_EXCL (`flag: 'wx'`) to eliminate timeout races.
 */
export function tryWriteApprovalDecisionExclusive(id, { decision, decidedBy = '', expired = false } = {}) {
  const normalized = String(decision || '').trim().toLowerCase();
  if (normalized !== 'allow' && normalized !== 'deny') {
    throw new Error(`Invalid approval decision: ${decision}`);
  }
  ensureConfigDir();
  const { resPath } = getApprovalPaths(id);
  const dir = path.dirname(resPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Ignore on unsupported FS
  }
  const record = {
    id: assertValidApprovalId(id),
    decision: normalized,
    decidedBy: String(decidedBy || ''),
    expired: Boolean(expired),
    decidedAt: Date.now(),
  };
  try {
    fs.writeFileSync(resPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    try {
      fs.chmodSync(resPath, 0o600);
    } catch {
      // Ignore
    }
    return { written: true, record, existing: null };
  } catch (err) {
    if (err?.code === 'EEXIST') {
      return { written: false, record: null, existing: readApprovalDecision(id) };
    }
    throw err;
  }
}

export function readApprovalDecision(id) {
  try {
    const { resPath } = getApprovalPaths(id);
    if (!fs.existsSync(resPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(resPath, 'utf8'));
    if (!parsed || (parsed.decision !== 'allow' && parsed.decision !== 'deny')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function waitForApprovalDecision(id, { timeoutMs = 120_000, pollMs = 300 } = {}) {
  const deadline = Date.now() + Math.max(50, Number(timeoutMs) || 120_000);
  const interval = Math.max(30, Math.min(1000, Number(pollMs) || 300));
  while (true) {
    const res = readApprovalDecision(id);
    if (res) {
      return {
        decided: !res.expired,
        timedOut: Boolean(res.expired),
        decision: res.decision,
        decidedBy: res.decidedBy || '',
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const claim = tryWriteApprovalDecisionExclusive(id, {
        decision: 'deny',
        decidedBy: '',
        expired: true,
      });
      if (!claim.written && claim.existing) {
        return {
          decided: !claim.existing.expired,
          timedOut: Boolean(claim.existing.expired),
          decision: claim.existing.decision,
          decidedBy: claim.existing.decidedBy || '',
        };
      }
      return {
        decided: false,
        timedOut: true,
        decision: 'deny',
        decidedBy: '',
      };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
  }
}

export function cleanupStaleApprovals(maxAgeMs = 3600_000) {
  let removed = 0;
  try {
    const dir = getApprovalsDir();
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - Math.max(60_000, Number(maxAgeMs) || 3600_000);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.req.json') && !entry.name.endsWith('.res.json')) continue;
      const abs = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(abs);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(abs, { force: true });
          removed += 1;
        }
      } catch {
        // Ignore single file errors
      }
    }
  } catch {
    // Ignore approval cleanup errors
  }
  return removed;
}

export function buildApprovalCard({ request, status = 'pending', decidedBy = '' } = {}) {
  const cmdText = String(request?.commandLine || '').replace(/```/g, '\\`\\`\\`');
  const riskSummary = sanitizeForFeishuMarkdown(request?.risk?.summary || '检测到高危 Shell 命令');
  const riskRule = request?.risk?.rule || 'high-risk';
  const cwd = request?.cwd || '-';
  const timeoutSec = Number(request?.timeoutSeconds || 120);

  const lines = [
    `- **风险类型**：${riskSummary}（\`${riskRule}\`）`,
    `- **执行目录**：\`${cwd}\``,
    '',
    '**待执行命令：**',
    '```bash',
    cmdText,
    '```',
  ];

  if (status === 'allowed') {
    lines.push('', `✅ **已批准本次执行**${decidedBy ? `（操作人 \`${decidedBy.slice(0, 12)}\`）` : ''}`);
    return buildCard({
      title: '✅ 已批准高危命令',
      template: 'green',
      markdown: lines.join('\n'),
    });
  }

  if (status === 'denied') {
    lines.push('', `❌ **已拒绝执行**${decidedBy ? `（操作人 \`${decidedBy.slice(0, 12)}\`）` : ''}`);
    return buildCard({
      title: '❌ 已拒绝高危命令',
      template: 'grey',
      markdown: lines.join('\n'),
    });
  }

  if (status === 'expired') {
    lines.push('', `⏱️ **审批超时（${timeoutSec}s）**：已自动拒绝执行（Fail-Closed）。`);
    return buildCard({
      title: '⏱️ 高危命令审批已超时（已自动拒绝）',
      template: 'grey',
      markdown: lines.join('\n'),
    });
  }

  lines.push('', `⏱️ 请在 **${timeoutSec} 秒** 内确认是否允许本次执行；超时将自动拒绝。`);
  const isCritical = request?.risk?.level === 'critical';
  return buildCard({
    title: '🛡️ 高危命令审批请求',
    template: isCritical ? 'red' : 'orange',
    markdown: lines.join('\n'),
    buttonRows: [[
      {
        label: '✅ 允许本次执行',
        type: 'primary',
        value: {
          cmd: 'approval_decide',
          arg: request?.id || '',
          decision: 'allow',
          ...(request?.threadRootId ? { threadRootId: request.threadRootId } : {}),
        },
      },
      {
        label: '❌ 拒绝执行',
        type: 'danger',
        value: {
          cmd: 'approval_decide',
          arg: request?.id || '',
          decision: 'deny',
          ...(request?.threadRootId ? { threadRootId: request.threadRootId } : {}),
        },
      },
    ]],
    footer: '发送 /guard off 可关闭此高危命令审批拦截',
  });
}
