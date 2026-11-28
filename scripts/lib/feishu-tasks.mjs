import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { getPluginRoot, loadUserAuth, saveUserAuth, stripProcessProxyEnv } from './config.mjs';

function syncFeishuProxyEnv(feishuProxy = '') {
  const desired = String(feishuProxy || '').trim();
  const curHttp = String(process.env.http_proxy || process.env.HTTP_PROXY || '').trim();
  const curHttps = String(process.env.https_proxy || process.env.HTTPS_PROXY || '').trim();
  const hasAll = Boolean(process.env.all_proxy || process.env.ALL_PROXY);
  if (!hasAll && curHttp === desired && curHttps === desired) {
    return;
  }
  stripProcessProxyEnv(desired);
}

function getCliCommandHint() {
  return `node ${path.join(getPluginRoot(), 'scripts', 'cli.mjs')} auth`;
}

export const DEFAULT_OAUTH_PORT = 18923;
export const DEFAULT_OAUTH_REDIRECT_URI = `http://127.0.0.1:${DEFAULT_OAUTH_PORT}/callback`;
export const DEFAULT_TASK_OAUTH_SCOPES = [
  'offline_access',
  'task:task:read',
  'task:task:write',
  'task:tasklist:read',
];

const TOKEN_EXPIRED_CODES = new Set([99991668, 99991663, 99991677]);
let refreshInFlight = null;

export function getOAuthEndpoints(domain = 'feishu') {
  const isLark = String(domain || '').trim().toLowerCase() === 'lark';
  return {
    authorizeBase: isLark
      ? 'https://accounts.larksuite.com/open-apis/authen/v1/authorize'
      : 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
    apiBase: isLark ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
  };
}

export function buildOAuthAuthorizeUrl({
  appId,
  domain = 'feishu',
  redirectUri = DEFAULT_OAUTH_REDIRECT_URI,
  scopes = DEFAULT_TASK_OAUTH_SCOPES,
  state = '',
} = {}) {
  const { authorizeBase } = getOAuthEndpoints(domain);
  const url = new URL(authorizeBase);
  url.searchParams.set('client_id', String(appId || '').trim());
  url.searchParams.set('redirect_uri', String(redirectUri || DEFAULT_OAUTH_REDIRECT_URI));
  url.searchParams.set('response_type', 'code');
  const scopeList = Array.isArray(scopes)
    ? scopes.map((s) => String(s || '').trim()).filter(Boolean)
    : String(scopes || '').split(/\s+/).filter(Boolean);
  if (scopeList.length > 0) {
    url.searchParams.set('scope', scopeList.join(' '));
  }
  if (state) {
    url.searchParams.set('state', String(state));
  }
  return url.toString();
}

export function getUserAuthStatus() {
  const auth = loadUserAuth();
  if (!auth || !auth.accessToken) {
    return {
      authorized: false,
      hasRefreshToken: false,
      accessExpiresAt: 0,
      refreshExpiresAt: 0,
      accessExpired: true,
      refreshExpired: true,
      scopes: [],
      domain: 'feishu',
      updatedAt: 0,
    };
  }
  const now = Date.now();
  const hasRefreshToken = Boolean(auth.refreshToken);
  const accessExpired = !auth.expiresAt || auth.expiresAt <= now;
  const refreshExpired = !hasRefreshToken || (Boolean(auth.refreshExpiresAt) && auth.refreshExpiresAt <= now);
  return {
    authorized: !accessExpired || !refreshExpired,
    hasRefreshToken,
    accessExpiresAt: auth.expiresAt || 0,
    refreshExpiresAt: auth.refreshExpiresAt || 0,
    accessExpired,
    refreshExpired,
    scopes: auth.scope ? auth.scope.split(/\s+/).filter(Boolean) : [],
    domain: auth.domain || 'feishu',
    updatedAt: auth.updatedAt || 0,
  };
}

function makeAuthRequiredError(message) {
  const err = new Error(message);
  err.code = 'FEISHU_USER_AUTH_REQUIRED';
  return err;
}

function parseTokenResponsePayload(data, fallbackDomain, previousRefreshToken = '') {
  if (!data || typeof data !== 'object') {
    throw new Error('Feishu OAuth token endpoint returned empty response.');
  }
  if (data.error) {
    throw new Error(`Feishu OAuth failed (${data.error}): ${data.error_description || data.msg || 'unknown error'}`);
  }
  if (typeof data.code === 'number' && data.code !== 0) {
    throw new Error(`Feishu OAuth failed (code=${data.code}): ${data.msg || 'unknown error'}`);
  }
  const accessToken = String(data.access_token || '').trim();
  if (!accessToken) {
    throw new Error('Feishu OAuth response missing access_token.');
  }
  const now = Date.now();
  const expiresIn = Number(data.expires_in || 7200);
  const refreshExpiresIn = Number(data.refresh_token_expires_in || 0);
  return {
    accessToken,
    refreshToken: String(data.refresh_token || previousRefreshToken || '').trim(),
    expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7200) * 1000,
    refreshExpiresAt:
      Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0 ? now + refreshExpiresIn * 1000 : 0,
    scope: String(data.scope || '').trim(),
    tokenType: String(data.token_type || 'Bearer').trim() || 'Bearer',
    domain: fallbackDomain,
    updatedAt: now,
  };
}

export async function exchangeOAuthCode(config, { code, redirectUri = DEFAULT_OAUTH_REDIRECT_URI } = {}) {
  const appId = String(config?.feishu?.appId || '').trim();
  const appSecret = String(config?.feishu?.appSecret || '').trim();
  if (!appId || !appSecret) {
    throw new Error('Feishu appId and appSecret are required before OAuth authorization.');
  }
  const cleanCode = String(code || '').trim();
  if (!cleanCode) {
    throw new Error('Missing OAuth authorization code.');
  }

  const domain = String(config?.feishu?.domain || 'feishu').trim().toLowerCase() === 'lark' ? 'lark' : 'feishu';
  const { apiBase } = getOAuthEndpoints(domain);
  syncFeishuProxyEnv(config?.feishu?.proxy);

  const resp = await fetch(`${apiBase}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: appId,
      client_secret: appSecret,
      code: cleanCode,
      redirect_uri: redirectUri,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok && !data?.error && data?.code === undefined) {
    throw new Error(`Feishu OAuth HTTP ${resp.status}`);
  }
  const normalized = parseTokenResponsePayload(data, domain);
  saveUserAuth(normalized);
  return getUserAuthStatus();
}

export async function refreshUserAccessToken(config, existingAuth = loadUserAuth()) {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    const diskLatest = loadUserAuth();
    const auth =
      diskLatest?.accessToken &&
      (!existingAuth?.updatedAt || Number(diskLatest.updatedAt || 0) > Number(existingAuth.updatedAt || 0)) &&
      Number(diskLatest.expiresAt || 0) - Date.now() > 120_000
        ? diskLatest
        : existingAuth || diskLatest;
    if (
      auth &&
      existingAuth &&
      auth !== existingAuth &&
      auth.accessToken &&
      Number(auth.expiresAt || 0) - Date.now() > 120_000
    ) {
      return auth;
    }
    if (!auth?.refreshToken) {
      throw makeAuthRequiredError(
        `缺少 refresh_token，请重新运行 \`${getCliCommandHint()}\` 完成飞书用户授权。`,
      );
    }
    const appId = String(config?.feishu?.appId || '').trim();
    const appSecret = String(config?.feishu?.appSecret || '').trim();
    if (!appId || !appSecret) {
      throw new Error('Feishu appId and appSecret are required.');
    }
    const domain = String(config?.feishu?.domain || auth.domain || 'feishu').trim().toLowerCase() === 'lark'
      ? 'lark'
      : 'feishu';
    const { apiBase } = getOAuthEndpoints(domain);
    syncFeishuProxyEnv(config?.feishu?.proxy);

    try {
      const resp = await fetch(`${apiBase}/open-apis/authen/v2/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: appId,
          client_secret: appSecret,
          refresh_token: auth.refreshToken,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok && !data?.error && data?.code === undefined) {
        throw new Error(`Feishu OAuth refresh HTTP ${resp.status}`);
      }
      const normalized = parseTokenResponsePayload(data, domain, auth.refreshToken);
      saveUserAuth(normalized);
      return normalized;
    } catch (err) {
      const reloaded = loadUserAuth();
      if (
        reloaded?.accessToken &&
        reloaded.updatedAt > Number(auth.updatedAt || 0) &&
        Number(reloaded.expiresAt || 0) - Date.now() > 60_000
      ) {
        return reloaded;
      }
      throw err;
    }
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

export async function getValidUserAccessToken(config, { forceRefresh = false } = {}) {
  const auth = loadUserAuth();
  if (!auth || !auth.accessToken) {
    throw makeAuthRequiredError(
      `尚未完成飞书用户授权（Task v2 个人/话题待办需要 user_access_token）。请先在飞书开放平台添加重定向 URL \`http://127.0.0.1:18923/callback\` 并开通 \`offline_access\`、\`task:task:read\`、\`task:task:write\`、\`task:tasklist:read\`，再执行 \`${getCliCommandHint()}\`。`,
    );
  }
  const now = Date.now();
  if (!forceRefresh && auth.expiresAt - now > 120_000) {
    return auth.accessToken;
  }
  if (auth.refreshToken && (!auth.refreshExpiresAt || auth.refreshExpiresAt > now + 10_000)) {
    const refreshed = await refreshUserAccessToken(config, auth);
    return refreshed.accessToken;
  }
  throw makeAuthRequiredError(
    `飞书用户授权已过期，请重新执行 \`${getCliCommandHint()}\` 授权。`,
  );
}

function tryOpenBrowser(url) {
  try {
    if (!/^https?:\/\//i.test(String(url || ''))) return;
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:FEISHU_OAUTH_URL'],
        {
          detached: true,
          windowsHide: true,
          stdio: 'ignore',
          env: { ...process.env, FEISHU_OAUTH_URL: url },
        },
      ).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Ignore browser launch failures; user can copy URL manually
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function runInteractiveOAuthFlow(
  config,
  {
    port = DEFAULT_OAUTH_PORT,
    timeoutSeconds = 180,
    scopes = DEFAULT_TASK_OAUTH_SCOPES,
    openBrowser = true,
  } = {},
) {
  const appId = String(config?.feishu?.appId || '').trim();
  const appSecret = String(config?.feishu?.appSecret || '').trim();
  if (!appId || !appSecret) {
    throw new Error('Feishu appId and appSecret are required. Run `cli.mjs setup` first.');
  }

  const listenPort = Number(port) || DEFAULT_OAUTH_PORT;
  const redirectUri = `http://127.0.0.1:${listenPort}/callback`;
  const expectedState = crypto.randomBytes(16).toString('hex');
  const authorizeUrl = buildOAuthAuthorizeUrl({
    appId,
    domain: config?.feishu?.domain || 'feishu',
    redirectUri,
    scopes,
    state: expectedState,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = (server) => {
      if (timer) clearTimeout(timer);
      try {
        server.closeAllConnections?.();
        server.close();
      } catch {
        // Ignore close error
      }
    };

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${listenPort}`);
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        const errParam = reqUrl.searchParams.get('error');
        const code = reqUrl.searchParams.get('code') || '';
        const state = reqUrl.searchParams.get('state') || '';

        if (errParam) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:24px;"><h2>授权已取消或失败</h2><p>${escapeHtml(errParam)}</p></body></html>`);
          if (!settled) {
            settled = true;
            cleanup(server);
            reject(new Error(`Feishu OAuth denied: ${errParam}`));
          }
          return;
        }
        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><html><body style="font-family:sans-serif;padding:24px;"><h2>State 校验失败</h2><p>请使用最新打开的授权页面继续。</p></body></html>');
          return;
        }

        const authStatus = await exchangeOAuthCode(config, { code, redirectUri });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body style="font-family:sans-serif;padding:24px;"><h2>✅ 飞书用户授权成功</h2><p>凭证已安全保存至 <code>~/.config/antigravity-feishu/user-auth.json</code>，现在可以关闭此标签页并在飞书发送 <code>/tasks</code> 查看待办。</p></body></html>');
        if (!settled) {
          settled = true;
          cleanup(server);
          resolve({ ok: true, redirectUri, authorizeUrl, auth: authStatus });
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:24px;"><h2>❌ 换取 Token 失败</h2><p>${escapeHtml(err?.message || err)}</p></body></html>`);
        if (!settled) {
          settled = true;
          cleanup(server);
          reject(err);
        }
      }
    });

    server.on('error', (err) => {
      if (!settled) {
        settled = true;
        cleanup(server);
        reject(new Error(`OAuth callback server failed on ${redirectUri}: ${err?.message || err}`));
      }
    });

    server.listen(listenPort, '127.0.0.1', () => {
      console.error(`[feishu-remote] Open this URL in browser to authorize Feishu Tasks:\n${authorizeUrl}`);
      if (openBrowser) {
        tryOpenBrowser(authorizeUrl);
      }
      const timeoutMs = Math.max(15, Number(timeoutSeconds) || 180) * 1000;
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup(server);
          reject(new Error(`OAuth authorization timed out after ${Math.round(timeoutMs / 1000)}s.`));
        }
      }, timeoutMs);
      timer.unref();
    });
  });
}

async function callUserApi(config, method, apiPath, { query = null, body = undefined } = {}) {
  const domain = String(config?.feishu?.domain || 'feishu').trim().toLowerCase() === 'lark' ? 'lark' : 'feishu';
  const { apiBase } = getOAuthEndpoints(domain);
  syncFeishuProxyEnv(config?.feishu?.proxy);

  const url = new URL(`${apiBase}${apiPath}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getValidUserAccessToken(config, { forceRefresh: attempt === 1 });
    const resp = await fetch(url.toString(), {
      method,
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await resp.json().catch(() => ({}));
    if ((resp.status === 401 || TOKEN_EXPIRED_CODES.has(Number(data?.code))) && attempt === 0) {
      continue;
    }
    if (!resp.ok && data?.code === undefined) {
      throw new Error(`Feishu Task API HTTP ${resp.status}`);
    }
    if (typeof data?.code === 'number' && data.code !== 0) {
      throw new Error(`Feishu Task API failed (code=${data.code}): ${data.msg || 'unknown error'}`);
    }
    return data?.data ?? {};
  }
  throw new Error('Feishu Task API retry exhausted.');
}

export function parseDueTimeInput(rawDue) {
  if (rawDue === undefined || rawDue === null) return null;
  const trimmed = String(rawDue).trim();
  if (!trimmed) return null;
  if (/^\d{13}$/.test(trimmed)) {
    return { timestamp: trimmed, is_all_day: false };
  }
  if (/^\d{10}$/.test(trimmed)) {
    return { timestamp: String(Number(trimmed) * 1000), is_all_day: false };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [y, m, d] = trimmed.split('-').map(Number);
    const dt = new Date(y, m - 1, d, 23, 59, 59, 0);
    if (Number.isNaN(dt.getTime())) return null;
    return { timestamp: String(dt.getTime()), is_all_day: true };
  }
  const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?$/.test(trimmed)
    ? trimmed.replace(/\s+/, 'T')
    : trimmed;
  const parsedMs = Date.parse(normalized);
  if (!Number.isFinite(parsedMs)) return null;
  return { timestamp: String(parsedMs), is_all_day: false };
}

export function formatTaskDueText(due) {
  const rawTs = due?.timestamp ?? due;
  const str = String(rawTs ?? '').trim();
  if (!str || str === '0') return '';
  const num = Number(str);
  if (!Number.isFinite(num) || num <= 0) return '';
  const ms = num < 1e11 ? num * 1000 : num;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (due?.is_all_day) {
    return datePart;
  }
  return `${datePart} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function normalizeTaskItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const completedAt = String(raw.completed_at || '0').trim();
  const completed = Boolean(completedAt && completedAt !== '0');
  return {
    guid: String(raw.guid || ''),
    taskId: String(raw.task_id || ''),
    summary: String(raw.summary || '(无标题任务)').trim(),
    description: String(raw.description || '').trim(),
    completed,
    completedAt: completed ? completedAt : '0',
    dueTimestamp: String(raw.due?.timestamp || ''),
    dueIsAllDay: Boolean(raw.due?.is_all_day),
    dueText: formatTaskDueText(raw.due),
    url: String(raw.url || ''),
    members: Array.isArray(raw.members) ? raw.members : [],
    tasklists: Array.isArray(raw.tasklists) ? raw.tasklists : [],
  };
}

export async function listFeishuTasks(
  config,
  { filter = 'open', pageSize = 50, pageToken = '', type = 'my_tasks' } = {},
) {
  const normalizedFilter = ['open', 'done', 'all'].includes(String(filter || '').toLowerCase())
    ? String(filter).toLowerCase()
    : 'open';
  const query = {
    type,
    page_size: Math.max(1, Math.min(100, Number(pageSize) || 50)),
    user_id_type: 'open_id',
    ...(pageToken ? { page_token: pageToken } : {}),
    ...(normalizedFilter === 'open' ? { completed: 'false' } : normalizedFilter === 'done' ? { completed: 'true' } : {}),
  };
  const data = await callUserApi(config, 'GET', '/open-apis/task/v2/tasks', { query });
  const items = (Array.isArray(data?.items) ? data.items : []).map(normalizeTaskItem).filter(Boolean);
  return {
    items,
    hasMore: Boolean(data?.has_more),
    pageToken: String(data?.page_token || ''),
    filter: normalizedFilter,
  };
}

export async function getFeishuTask(config, taskGuid) {
  const guid = String(taskGuid || '').trim();
  if (!guid) {
    throw new Error('task_guid is required.');
  }
  const data = await callUserApi(config, 'GET', `/open-apis/task/v2/tasks/${encodeURIComponent(guid)}`, {
    query: { user_id_type: 'open_id' },
  });
  const task = normalizeTaskItem(data?.task || data);
  if (!task || !task.guid) {
    throw new Error(`Task not found: ${guid}`);
  }
  return task;
}

export async function listFeishuTasklists(config, { pageSize = 50, pageToken = '' } = {}) {
  const data = await callUserApi(config, 'GET', '/open-apis/task/v2/tasklists', {
    query: {
      page_size: Math.max(1, Math.min(100, Number(pageSize) || 50)),
      user_id_type: 'open_id',
      ...(pageToken ? { page_token: pageToken } : {}),
    },
  });
  const items = (Array.isArray(data?.items) ? data.items : []).map((tl) => ({
    guid: String(tl.guid || ''),
    name: String(tl.name || '(未命名清单)').trim(),
    url: String(tl.url || ''),
  }));
  return {
    items,
    hasMore: Boolean(data?.has_more),
    pageToken: String(data?.page_token || ''),
  };
}

export async function listFeishuTasklistTasks(
  config,
  tasklistGuid,
  { filter = 'open', pageSize = 50, pageToken = '' } = {},
) {
  const guid = String(tasklistGuid || '').trim();
  if (!guid) {
    throw new Error('tasklist_guid is required.');
  }
  const normalizedFilter = ['open', 'done', 'all'].includes(String(filter || '').toLowerCase())
    ? String(filter).toLowerCase()
    : 'open';
  const query = {
    page_size: Math.max(1, Math.min(100, Number(pageSize) || 50)),
    user_id_type: 'open_id',
    ...(pageToken ? { page_token: pageToken } : {}),
    ...(normalizedFilter === 'open' ? { completed: 'false' } : normalizedFilter === 'done' ? { completed: 'true' } : {}),
  };
  const data = await callUserApi(
    config,
    'GET',
    `/open-apis/task/v2/tasklists/${encodeURIComponent(guid)}/tasks`,
    { query },
  );
  const items = (Array.isArray(data?.items) ? data.items : []).map(normalizeTaskItem).filter(Boolean);
  return {
    items,
    hasMore: Boolean(data?.has_more),
    pageToken: String(data?.page_token || ''),
    filter: normalizedFilter,
    tasklistGuid: guid,
  };
}

export async function createFeishuTask(
  config,
  { summary, description = '', due = '', tasklistGuid = '', assigneeOpenId = '' } = {},
) {
  const cleanSummary = String(summary || '').trim();
  if (!cleanSummary) {
    throw new Error('Task summary is required.');
  }
  const body = { summary: cleanSummary };
  const cleanDesc = String(description || '').trim();
  if (cleanDesc) body.description = cleanDesc;
  const parsedDue = parseDueTimeInput(due);
  if (parsedDue) body.due = parsedDue;
  const cleanListGuid = String(tasklistGuid || '').trim();
  if (cleanListGuid) body.tasklists = [{ tasklist_guid: cleanListGuid }];
  const cleanAssignee = String(assigneeOpenId || '').trim();
  if (cleanAssignee) body.members = [{ id: cleanAssignee, type: 'user', role: 'assignee' }];

  const data = await callUserApi(config, 'POST', '/open-apis/task/v2/tasks', {
    query: { user_id_type: 'open_id' },
    body,
  });
  return normalizeTaskItem(data?.task || data);
}

export async function setFeishuTaskCompleted(config, taskGuid, completed = true) {
  const guid = String(taskGuid || '').trim();
  if (!guid) {
    throw new Error('task_guid is required.');
  }
  const data = await callUserApi(config, 'PATCH', `/open-apis/task/v2/tasks/${encodeURIComponent(guid)}`, {
    query: { user_id_type: 'open_id' },
    body: {
      update_fields: ['completed_at'],
      task: {
        completed_at: completed ? String(Date.now()) : '0',
      },
    },
  });
  return normalizeTaskItem(data?.task || data);
}
