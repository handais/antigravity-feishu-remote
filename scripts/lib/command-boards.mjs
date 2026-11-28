import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { formatTimeoutLabel, resolveEffectiveTimeoutSeconds } from './bridge-helpers.mjs';
import { resolveRiskyApprovalEnabled } from './config.mjs';
import { getGeminiRoot } from './desktop-sessions.mjs';
import {
  buildSectionedCard,
  chunkButtons,
  getActivePendingCommand,
  sanitizeForFeishuMarkdown,
} from './feishu-cards.mjs';

const SAFE_CONV_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export const SCHEDULE_PRESET_TEMPLATES = {
  remind_5m: { label: '⏰ 5分钟后提醒', template: '5分钟后提醒我：' },
  remind_30m: { label: '⏰ 30分钟后提醒', template: '30分钟后提醒我：' },
  hourly_check: { label: '🔁 每小时巡检', template: '每小时巡检一次：' },
  daily_9am: { label: '🌅 每日9点汇报', template: '每天早上9点定时执行：' },
};

export const BOARD_QUICK_PROMPTS = {
  swarm_status: '请汇总当前多 Agent / Swarm 团队成员的实时状态、各自进度和是否存在阻塞（只读汇总，不要修改代码）。',
  schedule_list: '请调用 manage_task(Action="list") 列出当前会话所有活跃的定时任务与 cron，并用简洁清单回报。',
  schedule_cancel_all: '请调用 manage_task(Action="list") 检查当前会话所有活跃的定时任务与 cron，并逐一取消（Action="kill"）后汇报结果。',
  plan_approve: '已确认以上计划，请按计划开始执行，完成后汇报改动与验证结果。',
};

function isSafeConversationId(id) {
  const s = String(id || '').trim();
  return Boolean(s && SAFE_CONV_ID_RE.test(s) && !s.includes('..'));
}

export function parseMaybeJson(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (!trimmed) return val;
  const first = trimmed[0];
  if (
    first === '"' ||
    first === '{' ||
    first === '[' ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    /^-?\d+(?:\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return val;
    }
  }
  return val;
}

function normalizeArgs(rawArgs) {
  const parsed = parseMaybeJson(rawArgs);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    out[k] = parseMaybeJson(v);
  }
  return out;
}

function getBrainConversationDir(conversationId) {
  if (!isSafeConversationId(conversationId)) return '';
  return path.join(getGeminiRoot(), 'antigravity-cli', 'brain', conversationId);
}

export function readSwarmPlanJson(conversationId) {
  const brainDir = getBrainConversationDir(conversationId);
  if (!brainDir) return null;
  const planPath = path.join(brainDir, '.system_generated', 'swarm', 'plan.json');
  try {
    if (!fs.existsSync(planPath)) return null;
    const raw = fs.readFileSync(planPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      goal: parsed.goal && typeof parsed.goal === 'object' ? parsed.goal : null,
      tasks: parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {},
      threads: Array.isArray(parsed.threads) ? parsed.threads : [],
    };
  } catch {
    return null;
  }
}

export function queryChildConversationsFromDb(conversationId, { maxDepth = 3 } = {}) {
  if (!isSafeConversationId(conversationId)) return [];
  const dbPath = path.join(getGeminiRoot(), 'antigravity-cli', 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return [];

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 1000;');
    const summaryCols = new Set(
      db.prepare('PRAGMA table_info(conversation_summaries)').all().map((c) => String(c.name || '').trim()),
    );
    const hasParentsTable = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_parents'").get(),
    );
    if (!summaryCols.has('parent_conversation_id') && !hasParentsTable) {
      return [];
    }
    const selectFields = [
      'conversation_id',
      summaryCols.has('title') ? 'title' : "'' AS title",
      summaryCols.has('preview') ? 'preview' : "'' AS preview",
      summaryCols.has('step_count') ? 'step_count' : '0 AS step_count',
      summaryCols.has('last_modified_time') ? 'last_modified_time' : "'' AS last_modified_time",
      summaryCols.has('status') ? 'status' : "'' AS status",
      summaryCols.has('agent_name') ? 'agent_name' : "'' AS agent_name",
      summaryCols.has('killed') ? 'killed' : '0 AS killed',
      summaryCols.has('not_fully_idle') ? 'not_fully_idle' : '0 AS not_fully_idle',
    ];
    const whereClauses = [];
    if (summaryCols.has('parent_conversation_id')) {
      whereClauses.push('parent_conversation_id = ?');
    }
    if (hasParentsTable) {
      whereClauses.push('conversation_id IN (SELECT conversation_id FROM conversation_parents WHERE parent_id = ?)');
    }
    const orderClause = summaryCols.has('last_modified_time') ? 'ORDER BY last_modified_time DESC' : '';
    const stmt = db.prepare(`
      SELECT ${selectFields.join(', ')}
      FROM conversation_summaries
      WHERE ${whereClauses.join(' OR ')}
      ${orderClause}
      LIMIT 30
    `);

    const visited = new Set([conversationId]);
    let frontier = [conversationId];
    const results = [];
    const hops = Math.max(1, Math.min(5, Number(maxDepth) || 3));

    for (let depth = 1; depth <= hops && frontier.length > 0 && results.length < 30; depth += 1) {
      const nextFrontier = [];
      for (const parentId of frontier) {
        const bindArgs = whereClauses.length === 2 ? [parentId, parentId] : [parentId];
        const rows = stmt.all(...bindArgs);
        for (const row of rows) {
          const cid = String(row.conversation_id || '').trim();
          if (!cid || visited.has(cid)) continue;
          visited.add(cid);
          nextFrontier.push(cid);
          results.push({
            id: cid,
            name: String(row.agent_name || row.title || cid).trim(),
            title: String(row.title || '').trim(),
            preview: String(row.preview || '').trim(),
            stepCount: Number(row.step_count || 0),
            lastModifiedTime: String(row.last_modified_time || ''),
            status: String(row.status || '').trim(),
            killed: Boolean(row.killed),
            notFullyIdle: Boolean(row.not_fully_idle),
            depth,
          });
          if (results.length >= 30) break;
        }
        if (results.length >= 30) break;
      }
      frontier = nextFrontier;
    }
    return results;
  } catch {
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

export function hasRunningChildSubagents(conversationId) {
  const children = queryChildConversationsFromDb(conversationId, { maxDepth: 3 });
  return children.some(
    (child) => !child.killed && (child.notFullyIdle || /running|active|progress/i.test(child.status)),
  );
}

function readTailLines(filePath, maxTailBytes = 1024 * 1024) {
  const stat = fs.statSync(filePath);
  if (stat.size <= 0) return [];
  if (stat.size <= maxTailBytes) {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxTailBytes);
    const start = Math.max(0, stat.size - maxTailBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxTailBytes, start);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    const nl = text.indexOf('\n');
    if (nl >= 0) {
      text = text.slice(nl + 1);
    }
    return text.split(/\r?\n/).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function extractUserInputText(rawContent) {
  const s = String(rawContent || '').trim();
  if (!s) return '';
  const m = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  return (m ? m[1] : s).trim();
}

function truncateText(text, maxLen = 280) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

export function readTranscriptCommandTelemetry(conversationId, { maxTailBytes = 1024 * 1024, now = Date.now() } = {}) {
  const empty = {
    steps: [],
    swarmTitle: '',
    transcriptWorkers: [],
    schedules: [],
    planSummary: '',
    hasAsyncActivity: false,
  };
  const brainDir = getBrainConversationDir(conversationId);
  if (!brainDir) return empty;
  const transcriptPath = path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');
  try {
    if (!fs.existsSync(transcriptPath)) return empty;
    const lines = readTailLines(transcriptPath, maxTailBytes);
    let steps = [];
    let swarmTitle = '';
    const workerMap = new Map();
    const schedules = [];
    let latestPlanPrompt = '';
    let latestPlanContent = '';
    let inPlanContext = false;
    let hasAsyncActivity = false;

    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const createdAtMs = entry.created_at ? Date.parse(entry.created_at) : 0;

      if (entry.type === 'USER_INPUT' || entry.source === 'USER_EXPLICIT') {
        const userText = extractUserInputText(entry.content);
        if (/^\/(?:teamwork|swarm|schedule|goal)\b/i.test(userText)) {
          hasAsyncActivity = true;
        }
        if (/^\/(?:plan|grill-me)\b/i.test(userText)) {
          inPlanContext = true;
          latestPlanPrompt = userText;
        } else {
          inPlanContext = false;
        }
      }

      if ((entry.type === 'PLANNER_RESPONSE' || entry.source === 'MODEL') && typeof entry.content === 'string') {
        const cleaned = entry.content.trim();
        if (cleaned && inPlanContext) {
          latestPlanContent = cleaned;
        }
      }

      const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      for (const tc of toolCalls) {
        const name = String(tc?.name || '').trim();
        const args = normalizeArgs(tc?.args);
        if (
          name === 'swarm' ||
          name === 'invoke_subagent' ||
          name === 'send_message' ||
          name === 'manage_subagents' ||
          name === 'schedule' ||
          name === 'manage_task' ||
          name === 'run_workflow'
        ) {
          hasAsyncActivity = true;
        }

        if (name === 'update_steps' && Array.isArray(args.steps)) {
          steps = args.steps
            .filter((s) => s && typeof s === 'object' && s.title)
            .map((s) => ({
              title: String(s.title).trim(),
              status: String(s.status || 'pending').trim().toLowerCase(),
            }));
        } else if (name === 'swarm') {
          const action = String(args.action || '').trim().toLowerCase();
          if (action === 'title' && args.title) {
            swarmTitle = String(args.title).trim();
          } else if (action === 'add' && args.name) {
            const wName = String(args.name).trim();
            workerMap.set(wName, {
              name: wName,
              model: args.model ? String(args.model).trim() : '',
              brief: args.brief ? truncateText(args.brief, 120) : '',
              status: 'active',
              source: 'swarm',
            });
          } else if (action === 'model' && args.name) {
            const wName = String(args.name).trim();
            const existing = workerMap.get(wName) || { name: wName, source: 'swarm', status: 'active' };
            existing.model = args.model ? String(args.model).trim() : existing.model;
            workerMap.set(wName, existing);
          } else if (action === 'kill' && args.name) {
            const wName = String(args.name).trim();
            const existing = workerMap.get(wName) || { name: wName, source: 'swarm' };
            existing.status = 'killed';
            workerMap.set(wName, existing);
          }
        } else if (name === 'invoke_subagent') {
          const wName = String(args.Role || args.TypeName || 'subagent').trim();
          workerMap.set(`sub:${wName}:${workerMap.size + 1}`, {
            name: wName,
            model: args.Model && args.Model !== 'inherit' ? String(args.Model).trim() : '',
            brief: args.Prompt ? truncateText(args.Prompt, 120) : '',
            status: 'invoked',
            source: 'subagent',
          });
        } else if (name === 'manage_subagents') {
          const action = String(args.Action || '').trim().toLowerCase();
          if (action === 'kill_all') {
            for (const w of workerMap.values()) {
              if (w.source === 'subagent') w.status = 'killed';
            }
          }
        } else if (name === 'schedule') {
          const cronExpr = args.CronExpression ? String(args.CronExpression).trim() : '';
          const durationSec = Number(args.DurationSeconds || 0);
          const isDaemon = Boolean(args.IsDaemon);
          const prompt = args.Prompt ? truncateText(args.Prompt, 100) : '';
          const elapsed =
            !cronExpr && durationSec > 0 && createdAtMs > 0
              ? now - createdAtMs >= durationSec * 1000
              : false;
          schedules.push({
            kind: cronExpr ? 'cron' : 'timer',
            cronExpression: cronExpr,
            durationSeconds: durationSec,
            isDaemon,
            maxIterations: Number(args.MaxIterations || 0),
            prompt,
            createdAt: entry.created_at || '',
            cancelled: false,
            elapsed,
          });
        } else if (name === 'manage_task') {
          const action = String(args.Action || '').trim().toLowerCase();
          if (action === 'kill') {
            for (let i = schedules.length - 1; i >= 0; i -= 1) {
              if (!schedules[i].cancelled && !schedules[i].elapsed) {
                schedules[i].cancelled = true;
                break;
              }
            }
          }
        } else if (name === 'exit_plan_mode' && args.plan) {
          latestPlanContent = String(args.plan).trim();
        }
      }
    }

    const planSummary = latestPlanContent
      ? truncateText(latestPlanContent, 320)
      : latestPlanPrompt
        ? `最近规划请求：${truncateText(latestPlanPrompt, 160)}`
        : '';

    return {
      steps,
      swarmTitle,
      transcriptWorkers: [...workerMap.values()],
      schedules: schedules.slice(-8),
      planSummary,
      hasAsyncActivity,
    };
  } catch {
    return empty;
  }
}

export function hasAsyncSessionActivity(conversationId) {
  if (!isSafeConversationId(conversationId)) return false;
  const children = queryChildConversationsFromDb(conversationId, { maxDepth: 3 });
  if (children.some((c) => !c.killed)) {
    return true;
  }
  const transcript = readTranscriptCommandTelemetry(conversationId);
  return Boolean(transcript.hasAsyncActivity);
}

function formatShortTime(rawTime) {
  if (!rawTime) return '';
  const text = String(rawTime).trim();
  if (!text) return '';
  const isoLike = text.includes('T') ? text : text.replace(' ', 'T');
  const ms = Date.parse(isoLike);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function inspectCommandBoardTelemetry(conversationId, { now = Date.now() } = {}) {
  const empty = {
    steps: [],
    swarm: { title: '', goal: null, threads: [], workers: [] },
    schedules: [],
    planSummary: '',
  };
  if (!isSafeConversationId(conversationId)) return empty;

  const planJson = readSwarmPlanJson(conversationId);
  const dbChildren = queryChildConversationsFromDb(conversationId);
  const transcript = readTranscriptCommandTelemetry(conversationId, { now });

  const mergedByKey = new Map();
  for (const tw of transcript.transcriptWorkers) {
    mergedByKey.set(tw.name.toLowerCase(), { ...tw });
  }
  if (planJson?.tasks) {
    for (const [taskName, desc] of Object.entries(planJson.tasks)) {
      const key = taskName.toLowerCase();
      const existing = mergedByKey.get(key) || { name: taskName, source: 'swarm', status: 'active' };
      existing.brief = String(desc || existing.brief || '').trim();
      mergedByKey.set(key, existing);
    }
  }
  const claimedKeys = new Set();
  for (const child of dbChildren) {
    const key = child.name.toLowerCase();
    const existing = key && !claimedKeys.has(key) ? mergedByKey.get(key) : null;
    const rawTime = String(child.lastModifiedTime || '').trim();
    const modifiedMs = rawTime ? Date.parse(rawTime.includes('T') ? rawTime : rawTime.replace(' ', 'T')) : 0;
    const recentlyActive = Number.isFinite(modifiedMs) && modifiedMs > 0 && now - modifiedMs <= 90_000;
    const derivedStatus = child.killed
      ? 'killed'
      : child.notFullyIdle || /running|active|progress/i.test(child.status) || recentlyActive
        ? 'working'
        : 'done';
    if (existing) {
      claimedKeys.add(key);
      existing.id = child.id;
      existing.status = derivedStatus;
      existing.stepCount = child.stepCount;
      existing.lastModifiedTime = child.lastModifiedTime;
      if (!existing.brief && child.preview) existing.brief = truncateText(child.preview, 100);
    } else {
      mergedByKey.set(`db:${child.id}`, {
        id: child.id,
        name: child.name || child.id.slice(0, 8),
        model: '',
        brief: truncateText(child.title || child.preview, 100),
        status: derivedStatus,
        stepCount: child.stepCount,
        lastModifiedTime: child.lastModifiedTime,
        source: 'db',
      });
    }
  }

  return {
    steps: transcript.steps,
    swarm: {
      title: transcript.swarmTitle || planJson?.goal?.title || '',
      goal: planJson?.goal || null,
      threads: planJson?.threads || [],
      workers: [...mergedByKey.values()],
    },
    schedules: transcript.schedules,
    planSummary: transcript.planSummary,
  };
}

function stepStatusIcon(status) {
  if (status === 'done') return '✅';
  if (status === 'in_progress') return '⏳';
  if (status === 'failed') return '❌';
  if (status === 'skipped') return '⏭️';
  return '⬜';
}

function formatStepChecklistLines(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const lines = ['', `**📋 当前进度清单（${doneCount}/${steps.length}）：**`];
  for (const s of steps.slice(0, 12)) {
    lines.push(`- ${stepStatusIcon(s.status)} ${sanitizeForFeishuMarkdown(s.title)}`);
  }
  return lines;
}

export function buildGoalBoardCard({
  chatState,
  config,
  isRunning = false,
  telemetry = null,
} = {}) {
  const timeoutSec = resolveEffectiveTimeoutSeconds(chatState, config);
  const timeoutReady = timeoutSec === 0;
  const mode = chatState?.mode || config?.agy?.defaultMode || 'auto';
  const guardEnabled = resolveRiskyApprovalEnabled(config);
  const activePending = getActivePendingCommand(chatState);
  const goalArmed = activePending?.prefix === '/goal';
  const data = telemetry || inspectCommandBoardTelemetry(chatState?.conversationId);

  const lines = [
    `- **超时设置**：${timeoutReady ? '✅ 不限时（适合长耗时目标）' : `⚠️ \`${formatTimeoutLabel(timeoutSec)}\`（长任务易中途超时）`}`,
    `- **执行权限**：${mode === 'full' ? '⚡ `full`（全权执行）' : `🛡️ \`${mode}\`${guardEnabled ? ' · 高危审批已开' : ''}`}`,
    `- **运行状态**：${isRunning ? '⏳ 任务执行中' : '🟢 空闲'}${chatState?.conversationId ? ` · 会话 \`${chatState.conversationId.slice(0, 8)}\`` : ''}`,
    goalArmed
      ? '- **已预选命令**：🎯 `/goal`（下条消息直接发目标描述即可启动）'
      : '- **快速启动**：点下方「🚀 不限时+预选 /goal」一步配齐，再发送你的目标描述',
  ];
  lines.push(...formatStepChecklistLines(data.steps));

  const prepRow1 = [
    {
      label: '🚀 不限时+预选 /goal',
      type: !timeoutReady || !goalArmed ? 'primary' : 'default',
      value: { cmd: 'goal_prepare', setUnlimited: true, arm: true, inplace: true },
    },
    {
      label: '⚡ 全权+不限时+预选',
      value: { cmd: 'goal_prepare', setUnlimited: true, setFull: true, arm: true, inplace: true },
    },
  ];
  const prepRow2 = [
    {
      label: timeoutReady ? '⏱️ 恢复60m' : '⏱️ 切不限时',
      value: { cmd: 'board_set_timeout', arg: timeoutReady ? '60m' : '0', board: 'goal', inplace: true },
    },
    {
      label: goalArmed ? '✅ /goal' : '🎯 预选 /goal',
      type: goalArmed ? 'primary' : 'default',
      value: { cmd: 'board_arm_cmd', arg: '/goal', board: 'goal', inplace: true },
    },
  ];

  const navRow = [
    { label: '🔄 刷新进度', value: { cmd: 'cmd_board', board: 'goal', inplace: true } },
    ...(isRunning ? [{ label: '🛑 立即中止', type: 'danger', value: { cmd: 'stop', inplace: true } }] : []),
    { label: '🧩 命令菜单', value: { cmd: 'skills_menu', inplace: true } },
    { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
  ];

  return buildSectionedCard({
    title: '🎯 /goal 长目标启动与进度看板',
    template: goalArmed || isRunning ? 'wathet' : 'blue',
    markdown: lines.join('\n'),
    sections: [
      {
        title: '🚀 一键启动准备',
        divider: true,
        rows: [prepRow1, prepRow2],
      },
      {
        title: '📡 进度与导航',
        divider: true,
        rows: [navRow],
      },
    ],
    footer: '发 /goal（不带内容）或通过命令菜单可随时打开本看板',
  });
}

function workerStatusBadge(status) {
  if (status === 'working' || status === 'active' || status === 'invoked') return '⏳ 运行中';
  if (status === 'done') return '✅ 已完成';
  if (status === 'killed') return '🛑 已终止';
  return `🔹 ${status || '未知'}`;
}

export function buildSwarmBoardCard({
  chatState,
  config,
  isRunning = false,
  threadRootId = '',
  keepAliveActive = false,
  telemetry = null,
} = {}) {
  const convId = chatState?.conversationId || '';
  const activePending = getActivePendingCommand(chatState);
  const swarmArmed = activePending?.prefix === '/swarm';
  const teamworkArmed = activePending?.prefix === '/teamwork';
  const data = telemetry || inspectCommandBoardTelemetry(convId);
  const { swarm } = data;

  const lines = [
    threadRootId
      ? `- **隔离模式**：🧵 当前在独立话题楼（\`${threadRootId.slice(0, 12)}\`），适合独立调度多 Agent 协同`
      : '- **建议用法**：在飞书「话题群」单开一个话题楼发起 `/swarm` / `/teamwork`，输出不会刷屏主群',
    `- **保活状态**：${keepAliveActive ? '🟢 后台常驻保活中（子代理可随时异步回信推飞书）' : '⚪ 当前未保活（下条协作消息将自动开启保活）'}`,
    `- **当前状态**：${isRunning ? '⏳ 协同任务执行中' : '🟢 空闲'}${convId ? ` · 会话 \`${convId.slice(0, 8)}\`` : ''}`,
  ];
  if (swarm.title || swarm.goal?.title) {
    lines.push(`- **协同主题**：${sanitizeForFeishuMarkdown(swarm.title || swarm.goal.title)}`);
  }
  if (swarm.goal?.line) {
    lines.push(`- **总目标**：${sanitizeForFeishuMarkdown(swarm.goal.line)}`);
  }

  if (swarm.workers.length > 0) {
    lines.push('', `**🐝 成员状态清单（${swarm.workers.length} 个）：**`);
    for (const w of swarm.workers.slice(0, 12)) {
      const idTag = w.id ? ` \`${sanitizeForFeishuMarkdown(w.id.slice(0, 8))}\`` : '';
      const modelTag = w.model ? ` · \`${sanitizeForFeishuMarkdown(w.model)}\`` : '';
      const stepTag = w.stepCount > 0 ? ` · ${w.stepCount}步` : '';
      const timeStr = formatShortTime(w.lastModifiedTime);
      const timeTag = timeStr ? ` · ${timeStr}` : '';
      const briefTag = w.brief ? ` — ${sanitizeForFeishuMarkdown(w.brief)}` : '';
      lines.push(`- **${sanitizeForFeishuMarkdown(w.name)}**${idTag}（${workerStatusBadge(w.status)}${modelTag}${stepTag}${timeTag}）${briefTag}`);
    }
  } else {
    lines.push('', '_（当前会话暂未捕获到 Swarm / 子 Agent 记录；点下方 `/swarm` 或 `/teamwork` 即可发任务启动协同。）_');
  }

  const armRow = [
    {
      label: swarmArmed ? '✅ /swarm' : '🐝 /swarm',
      type: swarmArmed ? 'primary' : 'default',
      value: { cmd: 'board_arm_cmd', arg: '/swarm', board: 'swarm', inplace: true },
    },
    {
      label: teamworkArmed ? '✅ /teamwork' : '🤝 /teamwork',
      type: teamworkArmed ? 'primary' : 'default',
      value: { cmd: 'board_arm_cmd', arg: '/teamwork', board: 'swarm', inplace: true },
    },
  ];
  if (swarmArmed || teamworkArmed) {
    armRow.push({
      label: '❌ 取消预选',
      type: 'danger',
      value: { cmd: 'board_arm_cmd', arg: activePending.prefix, board: 'swarm', inplace: true },
    });
  }

  const monitorButtons = [
    { label: '🔄 刷新成员状态', value: { cmd: 'cmd_board', board: 'swarm', inplace: true } },
    ...(convId ? [{ label: '📊 汇总实时进展', value: { cmd: 'board_quick_prompt', preset: 'swarm_status' } }] : []),
    ...(keepAliveActive ? [{ label: '🔌 释放保活', type: 'danger', value: { cmd: 'stop_keepalive', board: 'swarm', inplace: true } }] : []),
    ...(isRunning ? [{ label: '🛑 中止任务', type: 'danger', value: { cmd: 'stop', inplace: true } }] : []),
    { label: '🧩 命令菜单', value: { cmd: 'skills_menu', inplace: true } },
    { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
  ];

  return buildSectionedCard({
    title: '🐝 多 Agent / Swarm 协同看板',
    template: isRunning || swarm.workers.length > 0 ? 'wathet' : 'blue',
    markdown: lines.join('\n'),
    sections: [
      {
        title: '🐝 发起协同（点选预填前缀）',
        divider: true,
        rows: [armRow],
      },
      {
        title: '📡 协同监控',
        divider: true,
        rows: chunkButtons(monitorButtons, 3),
      },
    ],
    footer: '发 /swarm 或 /teamwork（不带内容）可随时打开本看板',
  });
}

export function buildScheduleBoardCard({
  chatState,
  config: _config,
  isRunning = false,
  telemetry = null,
} = {}) {
  const convId = chatState?.conversationId || '';
  const activePending = getActivePendingCommand(chatState);
  const scheduleArmed = activePending?.prefix === '/schedule';
  const data = telemetry || inspectCommandBoardTelemetry(convId);

  const lines = [
    `- **当前会话**：${convId ? `\`${convId.slice(0, 8)}\`` : '（未开始，下条消息新建）'}${isRunning ? ' · ⏳ 任务运行中' : ''}`,
  ];
  if (scheduleArmed) {
    const tplText = activePending.template ? ` ${activePending.template}` : '';
    lines.push(`- **已预选模板**：⏰ \`/schedule${sanitizeForFeishuMarkdown(tplText)}\`（直接发提醒/任务内容即可）`);
  } else {
    lines.push('- **快捷创建**：点下方常用定时模板，直接发送要定时执行的内容即可');
  }

  if (data.schedules.length > 0) {
    lines.push('', `**📅 本会话已捕获定时记录（最近 ${data.schedules.length} 条）：**`);
    for (const item of data.schedules) {
      const spec = item.cronExpression
        ? `cron \`${item.cronExpression}\`${item.isDaemon ? ' (Daemon)' : ''}`
        : `单次 \`${item.durationSeconds}s\``;
      const status = item.cancelled ? '🛑 已取消' : item.elapsed ? '✅ 已触发' : '🟢 待触发/运行中';
      const promptDesc = item.prompt ? ` — ${sanitizeForFeishuMarkdown(item.prompt)}` : '';
      lines.push(`- ${status} · ${spec}${promptDesc}`);
    }
  } else {
    lines.push('', '_（暂未在本会话记录中发现定时任务；也可点下方「📋 查询实时任务」让当前会话核对后台调度器。）_');
  }

  const templateButtons = Object.entries(SCHEDULE_PRESET_TEMPLATES).map(([preset, info]) => {
    const isSelected = scheduleArmed && activePending?.template === info.template;
    return {
      label: isSelected ? `✅ ${info.label}` : info.label,
      type: isSelected ? 'primary' : 'default',
      value: { cmd: 'schedule_arm_template', preset, inplace: true },
    };
  });
  templateButtons.push({
    label: scheduleArmed && !activePending?.template ? '✅ 自由 /schedule' : '⏰ 自由 /schedule',
    type: scheduleArmed && !activePending?.template ? 'primary' : 'default',
    value: { cmd: 'board_arm_cmd', arg: '/schedule', board: 'schedule', inplace: true },
  });

  const manageButtons = [
    { label: '🔄 刷新看板', value: { cmd: 'cmd_board', board: 'schedule', inplace: true } },
    ...(convId
      ? [
          { label: '📋 查询实时任务', value: { cmd: 'board_quick_prompt', preset: 'schedule_list' } },
          { label: '🧹 取消全部定时', type: 'danger', value: { cmd: 'board_quick_prompt', preset: 'schedule_cancel_all' } },
        ]
      : []),
    { label: '🧩 命令菜单', value: { cmd: 'skills_menu', inplace: true } },
    { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
  ];

  return buildSectionedCard({
    title: '⏰ 定时任务与调度看板 (/schedule)',
    template: scheduleArmed ? 'wathet' : 'blue',
    markdown: lines.join('\n'),
    sections: [
      {
        title: '⚡ 快捷定时模板（点选后直接发提醒/任务内容）',
        divider: true,
        rows: chunkButtons(templateButtons, 3),
      },
      {
        title: '📋 定时任务管理',
        divider: true,
        rows: chunkButtons(manageButtons, 3),
      },
    ],
    footer: '发 /schedule（不带内容）或点命令菜单「⏰ 定时看板」可随时查看',
  });
}

export function buildPlanBoardCard({
  chatState,
  config,
  isRunning = false,
  telemetry = null,
} = {}) {
  const convId = chatState?.conversationId || '';
  const mode = chatState?.mode || config?.agy?.defaultMode || 'auto';
  const resumeMode = config?.agy?.defaultMode && config.agy.defaultMode !== 'plan' ? config.agy.defaultMode : 'auto';
  const activePending = getActivePendingCommand(chatState);
  const planArmed = activePending?.prefix === '/plan';
  const grillArmed = activePending?.prefix === '/grill-me';
  const data = telemetry || inspectCommandBoardTelemetry(convId);

  const lines = [
    `- **当前权限模式**：${mode === 'plan' ? '📖 `plan`（只读规划）' : `🛡️ \`${mode}\``}${isRunning ? ' · ⏳ 运行中' : ''}`,
    `- **当前会话**：${convId ? `\`${convId.slice(0, 8)}\`` : '（未开始，下条消息新建）'}`,
  ];
  if (activePending && (planArmed || grillArmed)) {
    const extra = activePending.template ? ` ${activePending.template}` : '';
    lines.push(`- **已预选指令**：\`${sanitizeForFeishuMarkdown(activePending.prefix + extra)}\`（直接发送你的需求或修改意见即可）`);
  }
  if (data.planSummary) {
    lines.push('', '**📝 最近方案摘要：**', `> ${sanitizeForFeishuMarkdown(data.planSummary)}`);
  }
  lines.push(...formatStepChecklistLines(data.steps));

  const prepRow = [
    {
      label: planArmed ? '✅ /plan' : '🧭 /plan',
      type: planArmed ? 'primary' : 'default',
      value: { cmd: 'board_arm_cmd', arg: '/plan', board: 'plan', inplace: true },
    },
    {
      label: grillArmed ? '✅ /grill-me' : '🎤 /grill-me',
      type: grillArmed ? 'primary' : 'default',
      value: { cmd: 'board_arm_cmd', arg: '/grill-me', board: 'plan', inplace: true },
    },
    {
      label: mode === 'plan' ? '🤖 切自动执行' : '📖 切只读规划',
      value: { cmd: 'board_set_mode', arg: mode === 'plan' ? resumeMode : 'plan', board: 'plan', inplace: true },
    },
  ];
  if (planArmed || grillArmed) {
    prepRow.push({
      label: '❌ 取消预选',
      type: 'danger',
      value: { cmd: 'board_arm_cmd', arg: activePending.prefix, board: 'plan', inplace: true },
    });
  }

  const sections = [
    {
      title: '🧭 规划与访谈预选',
      divider: true,
      rows: [prepRow],
    },
  ];

  if (convId) {
    sections.push({
      title: '✅ 计划审批闭环',
      divider: true,
      rows: [[
        { label: '✅ 按计划执行', type: 'primary', value: { cmd: 'plan_decision', decision: 'approve' } },
        { label: '✏️ 补充修改', value: { cmd: 'plan_decision', decision: 'revise', inplace: true } },
        { label: '❌ 放弃并新开', type: 'danger', value: { cmd: 'plan_decision', decision: 'discard', inplace: true } },
      ]],
    });
  }

  sections.push({
    divider: true,
    rows: [[
      { label: '🔄 刷新状态', value: { cmd: 'cmd_board', board: 'plan', inplace: true } },
      { label: '🧩 命令菜单', value: { cmd: 'skills_menu', inplace: true } },
      { label: '⬅️ 返回面板', value: { cmd: 'panel', inplace: true } },
    ]],
  });

  return buildSectionedCard({
    title: '🧭 方案规划与需求追问看板 (/plan · /grill-me)',
    template: planArmed || grillArmed ? 'wathet' : 'blue',
    markdown: lines.join('\n'),
    sections,
    footer: '确认方案点「✅ 按计划执行」会自动将只读模式切回可执行模式',
  });
}

export function detectTurnCommandBoard(promptText = '', toolsUsed = []) {
  const normalized = String(promptText || '')
    .trim()
    .replace(/^\[agy\]\s*/i, '');
  const cmdMatch = normalized.match(/^\/(plan|grill-me|goal|swarm|teamwork|schedule)(?:\s|$)/i);
  if (cmdMatch) {
    const name = cmdMatch[1].toLowerCase();
    if (name === 'plan' || name === 'grill-me') return { kind: 'plan' };
    if (name === 'goal') return { kind: 'goal' };
    if (name === 'swarm' || name === 'teamwork') return { kind: 'swarm' };
    if (name === 'schedule') return { kind: 'schedule' };
  }
  const tools = Array.isArray(toolsUsed) ? toolsUsed.map((t) => String(t || '').toLowerCase()) : [];
  if (tools.some((t) => t === 'swarm' || t === 'invoke_subagent' || t === 'send_message' || t === 'manage_subagents' || t === 'run_workflow')) {
    return { kind: 'swarm' };
  }
  if (tools.some((t) => t === 'schedule' || t === 'manage_task')) {
    return { kind: 'schedule' };
  }
  return { kind: '' };
}
