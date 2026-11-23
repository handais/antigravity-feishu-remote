import { assertLarkOk, splitMarkdownChunks, unwrapLarkError } from './feishu-api.mjs';

const DOC_URL_RE = /https?:\/\/([a-zA-Z0-9.-]*(?:feishu\.cn|larksuite\.com))\/(docx|wiki)\/([a-zA-Z0-9_-]+)/gi;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractFeishuDocLinks(text) {
  const raw = String(text || '');
  if (!raw) return [];
  const seen = new Set();
  const out = [];
  for (const match of raw.matchAll(DOC_URL_RE)) {
    const host = match[1];
    const kind = match[2].toLowerCase();
    const token = match[3];
    const key = `${kind}:${token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind,
      token,
      host,
      url: `https://${host}/${kind}/${token}`,
    });
  }
  return out;
}

export function parseDocTarget(input, domain = 'feishu') {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    throw new Error('Missing Feishu document URL or token.');
  }
  const links = extractFeishuDocLinks(trimmed);
  if (links.length > 0) {
    return links[0];
  }
  const cleanToken = trimmed.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanToken) {
    throw new Error(`Invalid Feishu document target: ${trimmed}`);
  }
  const host = String(domain || '').toLowerCase() === 'lark' ? 'larksuite.com' : 'feishu.cn';
  return {
    kind: 'docx',
    token: cleanToken,
    host,
    url: `https://${host}/docx/${cleanToken}`,
  };
}

async function resolveDocxIdFromTarget(client, parsed) {
  if (parsed.kind !== 'wiki') {
    return parsed.token;
  }
  let res;
  try {
    res = await client.wiki.v2.space.getNode({
      params: { token: parsed.token },
    });
  } catch (err) {
    throw unwrapLarkError(err, 'wiki.getNode');
  }
  assertLarkOk(res, 'wiki.getNode');
  const node = res?.data?.node;
  if (!node?.obj_token) {
    throw new Error('未找到对应的飞书知识库节点（可能链接无效或机器人无权访问）');
  }
  if (node.obj_type !== 'docx') {
    throw new Error(`该知识库节点类型为 \`${node.obj_type}\`，当前仅支持读取 \`docx\` 云文档`);
  }
  return node.obj_token;
}

export async function readFeishuDoc(client, target, { maxChars = 24000, domain = 'feishu' } = {}) {
  const parsed = parseDocTarget(target, domain);
  const documentId = await resolveDocxIdFromTarget(client, parsed);

  let metaRes;
  let contentRes;
  try {
    [metaRes, contentRes] = await Promise.all([
      client.docx.v1.document.get({ path: { document_id: documentId } }),
      client.docx.v1.document.rawContent({ path: { document_id: documentId } }),
    ]);
  } catch (err) {
    throw unwrapLarkError(err, 'readFeishuDoc');
  }
  assertLarkOk(metaRes, 'docx.get');
  assertLarkOk(contentRes, 'docx.rawContent');

  const docMeta = metaRes?.data?.document || {};
  const rawText = String(contentRes?.data?.content || '').trim();
  const totalChars = rawText.length;
  const limit = Math.max(200, Number(maxChars) || 24000);
  const truncated = totalChars > limit;
  const content = truncated ? `${rawText.slice(0, limit)}\n\n...(已截断，全文共 ${totalChars} 字符)` : rawText;

  return {
    documentId,
    title: docMeta.title || '未命名文档',
    revisionId: docMeta.revision_id ?? null,
    content,
    truncated,
    totalChars,
    url: `https://${parsed.host}/docx/${documentId}`,
  };
}

export function sanitizeConvertedBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.map((raw) => {
    const block = structuredClone(raw);
    if (block && block.parent_id === '') {
      delete block.parent_id;
    }
    if (block?.block_type === 31 && block.table) {
      if ('merge_info' in block.table) {
        delete block.table.merge_info;
      }
      if (block.table.property && 'merge_info' in block.table.property) {
        delete block.table.property.merge_info;
      }
    }
    return block;
  });
}

export function chunkDescendantBatches(firstLevelIds, blocks, maxBlocksPerBatch = 180) {
  if (!Array.isArray(firstLevelIds) || firstLevelIds.length === 0 || !Array.isArray(blocks) || blocks.length === 0) {
    return [];
  }
  const blockMap = new Map();
  for (const b of blocks) {
    if (b?.block_id) {
      blockMap.set(b.block_id, b);
    }
  }

  const collectRootTree = (rootId) => {
    const collected = [];
    const seen = new Set();
    const queue = [rootId];
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const node = blockMap.get(id);
      if (!node) continue;
      collected.push(node);
      if (Array.isArray(node.children)) {
        for (const childId of node.children) queue.push(childId);
      }
      if (Array.isArray(node.table?.cells)) {
        for (const cellId of node.table.cells) queue.push(cellId);
      }
    }
    return collected;
  };

  const batches = [];
  let curChildrenId = [];
  let curDescendants = [];
  let curSeen = new Set();

  for (const rootId of firstLevelIds) {
    const tree = collectRootTree(rootId);
    if (tree.length === 0) continue;

    if (curChildrenId.length > 0 && curDescendants.length + tree.length > maxBlocksPerBatch) {
      batches.push({ children_id: curChildrenId, descendants: curDescendants });
      curChildrenId = [];
      curDescendants = [];
      curSeen = new Set();
    }

    curChildrenId.push(rootId);
    for (const node of tree) {
      if (!curSeen.has(node.block_id)) {
        curSeen.add(node.block_id);
        curDescendants.push(node);
      }
    }
  }

  if (curChildrenId.length > 0 && curDescendants.length > 0) {
    batches.push({ children_id: curChildrenId, descendants: curDescendants });
  }
  return batches;
}

export async function writeFeishuDoc(
  client,
  { title = '', markdown = '', documentId = '', grantOpenId = '', domain = 'feishu' } = {},
) {
  const md = String(markdown || '').trim();
  if (!md) {
    throw new Error('Document markdown content must not be empty.');
  }

  const host = String(domain || '').toLowerCase() === 'lark' ? 'larksuite.com' : 'feishu.cn';
  let docId = '';
  let resolvedTitle = String(title || '').trim() || 'Antigravity 文档';
  let created = false;

  if (String(documentId || '').trim()) {
    const parsed = parseDocTarget(documentId, domain);
    docId = await resolveDocxIdFromTarget(client, parsed);
    try {
      const metaRes = await client.docx.v1.document.get({ path: { document_id: docId } });
      if (metaRes?.data?.document?.title) {
        resolvedTitle = metaRes.data.document.title;
      }
    } catch {
      // Non-fatal if metadata title fetch fails
    }
  } else {
    let createRes;
    try {
      createRes = await client.docx.v1.document.create({
        data: { title: resolvedTitle },
      });
    } catch (err) {
      throw unwrapLarkError(err, 'docx.create');
    }
    assertLarkOk(createRes, 'docx.create');
    docId = createRes?.data?.document?.document_id || '';
    if (!docId) {
      throw new Error('Feishu docx.create returned empty document_id');
    }
    created = true;
  }

  const mdChunks = splitMarkdownChunks(md, 12000);
  let blocksInserted = 0;

  for (let c = 0; c < mdChunks.length; c += 1) {
    const chunkText = mdChunks[c];
    if (!chunkText.trim()) continue;
    let convertRes;
    try {
      convertRes = await client.docx.v1.document.convert({
        data: {
          content_type: 'markdown',
          content: chunkText,
        },
      });
    } catch (err) {
      throw unwrapLarkError(err, 'docx.convert');
    }
    assertLarkOk(convertRes, 'docx.convert');

    const cleanedBlocks = sanitizeConvertedBlocks(convertRes?.data?.blocks || []);
    const firstLevelIds = convertRes?.data?.first_level_block_ids || [];
    const batches = chunkDescendantBatches(firstLevelIds, cleanedBlocks, 180);

    for (let b = 0; b < batches.length; b += 1) {
      const batch = batches[b];
      let insertRes;
      try {
        insertRes = await client.docx.v1.documentBlockDescendant.create({
          path: {
            document_id: docId,
            block_id: docId,
          },
          data: {
            children_id: batch.children_id,
            index: -1,
            descendants: batch.descendants,
          },
        });
      } catch (err) {
        throw unwrapLarkError(err, 'docx.descendant.create');
      }
      assertLarkOk(insertRes, 'docx.descendant.create');
      blocksInserted += batch.descendants.length;

      const hasMore = b < batches.length - 1 || c < mdChunks.length - 1;
      if (hasMore) {
        await sleep(380);
      }
    }
  }

  let permissionGranted = !created;
  let permissionWarning = '';
  if (created && grantOpenId && client?.drive?.v1?.permissionMember?.create) {
    try {
      const permRes = await client.drive.v1.permissionMember.create({
        path: { token: docId },
        params: { type: 'docx', need_notification: false },
        data: {
          member_type: 'openid',
          member_id: grantOpenId,
          perm: 'full_access',
          type: 'user',
        },
      });
      assertLarkOk(permRes, 'drive.permissionMember.create');
      permissionGranted = true;
    } catch {
      permissionGranted = false;
      permissionWarning =
        '文档已由机器人创建，但未能自动授予你协作者权限（如需打开机器人新建文档，请在飞书开放平台开通 docs:permission.member:create 权限，或先在飞书建好文档把链接发我追加写入）';
    }
  }

  return {
    documentId: docId,
    title: resolvedTitle,
    url: `https://${host}/docx/${docId}`,
    created,
    blocksInserted,
    permissionGranted,
    permissionWarning,
  };
}

export async function queryAppScopes(client) {
  let res;
  try {
    res = await client.request({
      method: 'GET',
      url: '/open-apis/application/v6/scopes',
    });
  } catch (err) {
    throw unwrapLarkError(err, 'queryAppScopes');
  }
  assertLarkOk(res, 'queryAppScopes');
  const rawScopes = Array.isArray(res?.data?.scopes) ? res.data.scopes : [];
  const scopes = rawScopes.map((s) => ({
    scopeName: String(s.scope_name || ''),
    scopeType: String(s.scope_type || 'tenant'),
    grantStatus: Number(s.grant_status ?? 0),
  }));
  const granted = scopes.filter((s) => s.grantStatus === 1);
  const pending = scopes.filter((s) => s.grantStatus !== 1);
  return { scopes, granted, pending };
}

export async function applyPendingAppScopes(client) {
  try {
    const res = await client.request({
      method: 'POST',
      url: '/open-apis/application/v6/scopes/apply',
      data: {},
    });
    if (res && typeof res.code === 'number' && res.code !== 0) {
      return { ok: false, code: res.code, msg: res.msg || '申请失败' };
    }
    return { ok: true, code: 0, msg: res?.msg || '已向管理员提交权限申请' };
  } catch (err) {
    const apiData = err?.response?.data;
    if (apiData && typeof apiData === 'object') {
      return {
        ok: false,
        code: apiData.code ?? -1,
        msg: apiData.msg || apiData.error?.message || err.message || '申请失败',
      };
    }
    return {
      ok: false,
      code: -1,
      msg: err?.message || String(err),
    };
  }
}
