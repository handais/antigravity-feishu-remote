import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, createMockFeishuClient, seedDefaultTestConfig } from './helpers.mjs';

const env = createTestEnv('feishu-mcp-thread-');
seedDefaultTestConfig(env.workDir);
after(() => env.cleanup());
const { loadConfig, loadState } = await import('../scripts/lib/config.mjs');
const { replyText } = await import('../scripts/lib/feishu-api.mjs');
const { resolveTarget } = await import('../scripts/mcp-server.mjs');

test('resolveTarget routes bridge child topic session into active topic thread by default', () => {
  const config = loadConfig();
  const state = loadState();
  const target = resolveTarget(
    {},
    config,
    state,
    {
      FEISHU_REMOTE_BRIDGE_CHILD: '1',
      FEISHU_REMOTE_CHAT_ID: 'oc_topic_1',
      FEISHU_REMOTE_THREAD_ROOT_ID: 'om_root_1',
    },
  );
  assert.deepEqual(target, {
    receiveId: 'oc_topic_1',
    receiveIdType: 'chat_id',
    replyToMessageId: 'om_root_1',
    replyInThread: true,
  });
});

test('resolveTarget routes bridge child non-topic chat directly to active chat_id', () => {
  const config = loadConfig();
  const state = loadState();
  const target = resolveTarget(
    {},
    config,
    state,
    {
      FEISHU_REMOTE_BRIDGE_CHILD: '1',
      FEISHU_REMOTE_CHAT_ID: 'oc_p2p_1',
    },
  );
  assert.deepEqual(target, {
    receiveId: 'oc_p2p_1',
    receiveIdType: 'chat_id',
    replyToMessageId: '',
    replyInThread: false,
  });
});

test('resolveTarget honors explicit authorized receive_id override without forcing thread reply', () => {
  const config = loadConfig();
  const state = loadState();
  const target = resolveTarget(
    { receive_id: 'ou_test_owner' },
    config,
    state,
    {
      FEISHU_REMOTE_BRIDGE_CHILD: '1',
      FEISHU_REMOTE_CHAT_ID: 'oc_topic_1',
      FEISHU_REMOTE_THREAD_ROOT_ID: 'om_root_1',
    },
  );
  assert.deepEqual(target, {
    receiveId: 'ou_test_owner',
    receiveIdType: 'open_id',
    replyToMessageId: '',
    replyInThread: false,
  });
});

test('resolveTarget rejects unauthorized receive_id and unauthorized reply_to_message_id', () => {
  const config = loadConfig();
  const state = loadState();
  assert.throws(
    () => resolveTarget({ receive_id: 'ou_stranger' }, config, state, {}),
    /outside authorized Feishu targets/,
  );
  assert.throws(
    () =>
      resolveTarget(
        { reply_to_message_id: 'om_external_thread' },
        config,
        state,
        {
          FEISHU_REMOTE_BRIDGE_CHILD: '1',
          FEISHU_REMOTE_CHAT_ID: 'oc_topic_1',
          FEISHU_REMOTE_THREAD_ROOT_ID: 'om_root_1',
        },
      ),
    /outside authorized Feishu topic threads/,
  );
});

test('resolveTarget defaults standalone desktop MCP calls to configured defaultReceiveId', () => {
  const config = loadConfig();
  const state = loadState();
  const target = resolveTarget({}, config, state, {});
  assert.deepEqual(target, {
    receiveId: 'ou_test_owner',
    receiveIdType: 'open_id',
    replyToMessageId: '',
    replyInThread: false,
  });
});

test('replyText sends reply_in_thread text payload via message.reply', async () => {
  const { client } = createMockFeishuClient();
  const calls = [];
  client.im.v1.message.reply = async (payload) => {
    calls.push(payload);
    return { code: 0, data: { message_id: 'om_reply_txt_1' } };
  };
  const msgId = await replyText(client, {
    messageId: 'om_root_1',
    text: 'hello topic',
    replyInThread: true,
  });
  assert.equal(msgId, 'om_reply_txt_1');
  assert.deepEqual(calls, [
    {
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: 'hello topic' }),
        reply_in_thread: true,
      },
      path: {
        message_id: 'om_root_1',
      },
    },
  ]);
});
