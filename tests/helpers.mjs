import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { saveConfig } from '../scripts/lib/config.mjs';
import { makeSessionKey } from '../scripts/lib/bridge-helpers.mjs';

/**
 * Create a completely isolated temporary environment (config, fake gemini stores, workdir, clipboard file).
 */
export function createTestEnv(prefix = 'feishu-remote-suite-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(root, 'config');
  const geminiDir = path.join(root, 'gemini');
  const workDir = path.join(root, 'work');
  const clipboardFile = path.join(root, 'clipboard.txt');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  const prevEnv = {
    FEISHU_REMOTE_CONFIG_DIR: process.env.FEISHU_REMOTE_CONFIG_DIR,
    FEISHU_REMOTE_GEMINI_DIR: process.env.FEISHU_REMOTE_GEMINI_DIR,
    FEISHU_REMOTE_TEST_CLIPBOARD_FILE: process.env.FEISHU_REMOTE_TEST_CLIPBOARD_FILE,
  };

  process.env.FEISHU_REMOTE_CONFIG_DIR = configDir;
  process.env.FEISHU_REMOTE_GEMINI_DIR = geminiDir;
  process.env.FEISHU_REMOTE_TEST_CLIPBOARD_FILE = clipboardFile;

  return {
    root,
    configDir,
    geminiDir,
    workDir,
    clipboardFile,
    cleanup() {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function seedDefaultTestConfig(workDir, overrides = {}) {
  return saveConfig({
    feishu: {
      appId: 'cli_test_123',
      appSecret: 'super_secret_token_987654',
      domain: 'feishu',
      proxy: '',
      ...(overrides.feishu || {}),
    },
    security: {
      allowedOpenIds: ['ou_test_owner'],
      autoBindFirstUser: false,
      groupPolicy: 'mention',
      riskyCommandApproval: 'on',
      approvalTimeoutSeconds: 60,
      ...(overrides.security || {}),
    },
    agy: {
      bin: '',
      defaultCwd: workDir,
      defaultMode: 'accept-edits',
      defaultModel: '',
      defaultEffort: '',
      favoriteDirs: [workDir],
      proxy: '',
      timeoutSeconds: 120,
      maxConcurrentRuns: 4,
      ...(overrides.agy || {}),
    },
    notifications: {
      defaultReceiveId: 'ou_test_owner',
      defaultReceiveIdType: 'open_id',
      stopHookEnabled: true,
      stopNotifyMode: 'on',
      awayIdleSeconds: 120,
      ...(overrides.notifications || {}),
    },
  });
}

function seedStoreDb(dbFile, rows) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      preview TEXT,
      step_count INTEGER,
      last_modified_time TEXT,
      workspace_uris TEXT,
      status TEXT,
      nesting_depth INTEGER,
      app_data_dir TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(conversation_id, title, preview, workspace);
  `);
  db.exec('DELETE FROM conversation_summaries; DELETE FROM conversations_fts;');
  const ins = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insFts = db.prepare('INSERT INTO conversations_fts VALUES (?, ?, ?, ?)');
  for (const r of rows) {
    ins.run(
      r.id,
      r.title || '',
      r.preview || '',
      Number(r.stepCount || 0),
      r.modified || new Date().toISOString(),
      r.workspaces || '[]',
      r.status || 'CASCADE_RUN_STATUS_IDLE',
      Number(r.depth || 0),
      r.appDataDir || '',
    );
    insFts.run(r.id, r.title || '', r.preview || '', r.workspaces || '[]');
  }
  db.close();
}

export function seedFakeGeminiStores(geminiDir, { cliRows = [], desktopRows = [], transcripts = {} } = {}) {
  const cliAppDir = path.join(geminiDir, 'antigravity-cli');
  const desktopAppDir = path.join(geminiDir, 'antigravity');
  fs.mkdirSync(path.join(cliAppDir, 'conversations'), { recursive: true });
  fs.mkdirSync(desktopAppDir, { recursive: true });

  for (const r of cliRows) {
    if (Number(r.depth || 0) === 0) {
      fs.writeFileSync(path.join(cliAppDir, 'conversations', `${r.id}.db`), '');
    }
  }

  seedStoreDb(
    path.join(cliAppDir, 'conversation_summaries.db'),
    cliRows.map((r) => ({ ...r, appDataDir: r.appDataDir || cliAppDir })),
  );
  seedStoreDb(
    path.join(desktopAppDir, 'conversation_summaries.db'),
    desktopRows.map((r) => ({ ...r, appDataDir: r.appDataDir || desktopAppDir })),
  );

  for (const [convId, spec] of Object.entries(transcripts)) {
    const baseApp = spec.source === 'cli' ? cliAppDir : desktopAppDir;
    const logsDir = path.join(baseApp, 'brain', convId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    if (Array.isArray(spec.compact)) {
      fs.writeFileSync(
        path.join(logsDir, 'transcript.jsonl'),
        spec.compact.map((e) => JSON.stringify(e)).join('\n'),
        'utf8',
      );
    }
    if (Array.isArray(spec.full)) {
      fs.writeFileSync(
        path.join(logsDir, 'transcript_full.jsonl'),
        spec.full.map((e) => JSON.stringify(e)).join('\n'),
        'utf8',
      );
    }
  }
}

export function createMockFeishuClient(opts = {}) {
  let msgSeq = 0;
  let cardSeq = 0;
  let elementFailCount = 0;

  const calls = {
    sentCards: [],
    repliedCards: [],
    patchedCards: [],
    uploadedImages: [],
    uploadedFiles: [],
    cardkitCreates: [],
    cardkitSettings: [],
    cardkitUpdates: [],
    cardkitElements: [],
    reactionsAdded: [],
    reactionsRemoved: [],
    scopeApplyCalls: 0,
  };

  const parseCard = (raw) => {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };

  const client = {
    im: {
      v1: {
        message: {
          create: async ({ data, params }) => {
            const msgId = `om_mock_${++msgSeq}`;
            if (data?.msg_type === 'interactive') {
              calls.sentCards.push({
                messageId: msgId,
                receiveId: data.receive_id,
                receiveIdType: params?.receive_id_type,
                card: parseCard(data.content),
              });
            }
            return { code: 0, data: { message_id: msgId } };
          },
          reply: async ({ path: p, data }) => {
            const msgId = `om_reply_${++msgSeq}`;
            if (data?.msg_type === 'interactive') {
              calls.repliedCards.push({
                messageId: msgId,
                parentMessageId: p?.message_id,
                replyInThread: Boolean(data?.reply_in_thread),
                card: parseCard(data.content),
              });
            }
            return { code: 0, data: { message_id: msgId } };
          },
          patch: async ({ path: p, data }) => {
            if (opts.failPatch) {
              throw new Error('Mock patchCard failed');
            }
            calls.patchedCards.push({
              messageId: p?.message_id,
              card: parseCard(data?.content),
            });
            return { code: 0, data: {} };
          },
          get: async ({ path: p }) => ({
            code: 0,
            data: { items: [{ message_id: p?.message_id, msg_type: 'interactive', body: { content: '{}' } }] },
          }),
        },
        messageReaction: {
          create: async ({ path: p, data }) => {
            const reactionId = `rx_${++msgSeq}`;
            calls.reactionsAdded.push({ messageId: p?.message_id, emoji: data?.reaction_type?.emoji_type });
            return { code: 0, data: { reaction_id: reactionId } };
          },
          delete: async ({ path: p }) => {
            calls.reactionsRemoved.push({ messageId: p?.message_id, reactionId: p?.reaction_id });
            return { code: 0 };
          },
        },
        image: {
          create: async ({ data } = {}) => {
            if (data?.image && typeof data.image[Symbol.asyncIterator] === 'function') {
              for await (const _chunk of data.image) {
                // Drain stream so fd closes before test cleanup
              }
            }
            const imageKey = `img_mock_${++msgSeq}`;
            calls.uploadedImages.push(imageKey);
            return { code: 0, data: { image_key: imageKey } };
          },
        },
        file: {
          create: async ({ data } = {}) => {
            if (data?.file && typeof data.file[Symbol.asyncIterator] === 'function') {
              for await (const _chunk of data.file) {
                // Drain stream so fd closes before test cleanup
              }
            }
            const fileKey = `file_mock_${++msgSeq}`;
            calls.uploadedFiles.push({ fileKey, fileName: data?.file_name, fileType: data?.file_type });
            return { code: 0, data: { file_key: fileKey } };
          },
        },
        chat: {
          get: async () => ({ code: 0, data: { chat_mode: 'group' } }),
        },
      },
    },
    request: async ({ method, url }) => {
      if (method === 'GET' && url === '/open-apis/application/v6/scopes') {
        return {
          code: 0,
          data: {
            scopes: [
              { scope_name: 'im:message', scope_type: 'tenant', grant_status: 1 },
              { scope_name: 'im:resource', scope_type: 'tenant', grant_status: 1 },
              { scope_name: 'docx:document:write_only', scope_type: 'tenant', grant_status: 0 },
            ],
          },
        };
      }
      if (method === 'POST' && url === '/open-apis/application/v6/scopes/apply') {
        calls.scopeApplyCalls += 1;
        return { code: 0, msg: 'success' };
      }
      return { code: 0, data: {} };
    },
    cardkit: {
      v1: {
        card: {
          create: async ({ data }) => {
            if (opts.failCardkitCreate) {
              return { code: 99999, msg: 'Mock cardkit create disabled' };
            }
            const cardId = `ck_mock_${++cardSeq}`;
            calls.cardkitCreates.push({ cardId, card: parseCard(data?.data) });
            return { code: 0, data: { card_id: cardId } };
          },
          settings: async ({ path: p, data }) => {
            calls.cardkitSettings.push({ cardId: p?.card_id, settings: parseCard(data?.settings) });
            return { code: 0 };
          },
          update: async ({ path: p, data }) => {
            if (opts.failCardkitFinalUpdate) {
              return { code: 300308, msg: 'Server Internal Error' };
            }
            calls.cardkitUpdates.push({ cardId: p?.card_id, card: parseCard(data?.card?.data) });
            return { code: 0 };
          },
        },
        cardElement: {
          content: async ({ path: p, data }) => {
            if (opts.failCardkitElementTimes && elementFailCount < opts.failCardkitElementTimes) {
              elementFailCount += 1;
              return { code: 230020, msg: 'This operation triggers the frequency limit' };
            }
            calls.cardkitElements.push({
              cardId: p?.card_id,
              elementId: p?.element_id,
              content: data?.content,
            });
            return { code: 0 };
          },
        },
      },
    },
    application: {
      v6: {
        scope: {
          list: async () => ({
            code: 0,
            data: {
              scopes: [
                { scope_name: 'im:message', scope_type: 'tenant', grant_status: 1 },
                { scope_name: 'im:resource', scope_type: 'tenant', grant_status: 1 },
                { scope_name: 'docx:document:write_only', scope_type: 'tenant', grant_status: 0 },
              ],
            },
          }),
          apply: async () => {
            calls.scopeApplyCalls += 1;
            return { code: 0, msg: 'success' };
          },
        },
      },
    },
  };

  return { client, calls };
}

/**
 * Create a cross-platform executable fake `agy` binary backed by Node.
 */
export function createFakeAgyBin(dir, scriptBody) {
  const jsPath = path.join(dir, 'fake-agy.mjs');
  fs.writeFileSync(jsPath, `#!/usr/bin/env node\n${scriptBody}\n`, { encoding: 'utf8', mode: 0o755 });
  if (process.platform === 'win32') {
    const cmdPath = path.join(dir, 'fake-agy.cmd');
    fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`, 'utf8');
    return cmdPath;
  }
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

export function createBridgeContext({ client, runner, activeRuns, chatQueues, lastTaskByChat }) {
  const cardThreadMap = new Map();
  return {
    client,
    startedAt: Date.now() - 60_000,
    bootCodeHash: 'abcd1234ef567890',
    activeRuns: activeRuns || new Map(),
    chatQueues: chatQueues || new Map(),
    lastTaskByChat: lastTaskByChat || new Map(),
    cardThreadMap,
    recordCardThread: (cardMessageId, meta) => {
      if (!cardMessageId || !meta?.threadRootId) return;
      cardThreadMap.set(cardMessageId, {
        sessionKey: meta.sessionKey || makeSessionKey(meta.chatId, meta.threadRootId),
        threadRootId: meta.threadRootId,
        chatId: meta.chatId || '',
      });
    },
    runner: runner || {
      getQueueForChat: () => [],
      totalQueuedCount: () => 0,
      enqueueOrExecutePrompt: async () => {},
      executePrompt: async () => {},
    },
    stopWsForRestart: () => {},
  };
}
