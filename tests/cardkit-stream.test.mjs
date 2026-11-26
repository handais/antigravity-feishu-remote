import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMockFeishuClient } from './helpers.mjs';

const { createStreamingCardSession } = await import('../scripts/lib/cardkit-stream.mjs');

describe('cardkit-stream fallback and rate-limit regressions', () => {
  it('completes CardKit streaming happy path and splits multi-chunk replies', async () => {
    const { client, calls } = createMockFeishuClient();
    const session = await createStreamingCardSession(client, {
      messageId: 'om_u1',
      chatId: 'oc_stream_1',
      openId: 'ou_test_owner',
      initialStatus: 'init',
      minWriteIntervalMs: 10,
    });

    assert.equal(session.mode, 'cardkit');
    assert.ok(session.cardId);
    assert.ok(session.replyMessageId);

    session.updateStatus('running step');
    await new Promise((r) => setTimeout(r, 25));
    session.updateStream('hello world');
    await new Promise((r) => setTimeout(r, 40));

    const longMarkdown = Array.from({ length: 260 }, (_, i) => `line ${i}: ${'x'.repeat(30)}`).join('\n');
    const sentIds = await session.finish({
      title: '✅ 完成',
      template: 'green',
      markdown: longMarkdown,
      footer: 'done',
      buttonRows: [[{ label: 'OK', value: { cmd: 'panel' } }]],
    });
    assert.ok(Array.isArray(sentIds) && sentIds.length >= 2);

    assert.ok(calls.cardkitElements.length >= 2);
    assert.ok(calls.cardkitSettings.some((s) => s.settings.config.streaming_mode === false));
    assert.equal(calls.cardkitUpdates.length, 1);
    assert.ok(calls.cardkitUpdates[0].card.header.title.content.includes('(1/'));
    assert.ok(calls.repliedCards.length >= 1, 'Extra markdown chunks should be sent as follow-up cards');
  });

  it('switches to long-run card.update when cardElement.content hits rate limit (code 230020) twice', async () => {
    const { client, calls } = createMockFeishuClient({ failCardkitElementTimes: 2 });
    const session = await createStreamingCardSession(client, {
      messageId: 'om_u2',
      chatId: 'oc_stream_2',
      openId: 'ou_test_owner',
      minWriteIntervalMs: 10,
    });

    session.updateStatus('step 1');
    await new Promise((r) => setTimeout(r, 25));
    session.updateStream('stream 1');
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(calls.cardkitSettings.some((s) => s.settings.config.streaming_mode === false));
    assert.ok(calls.cardkitUpdates.length >= 1, 'Should switch to card.update after 2 element failures');

    await session.finish({
      title: '✅ 恢复完成',
      template: 'green',
      markdown: 'ok',
    });
  });

  it('falls back to deliverFinalCard (patchCard) when cardkit.update fails in finish() (code 300308)', async () => {
    const { client, calls } = createMockFeishuClient({ failCardkitFinalUpdate: true });
    const session = await createStreamingCardSession(client, {
      messageId: 'om_u3',
      chatId: 'oc_stream_3',
      openId: 'ou_test_owner',
    });

    await session.finish({
      title: '✅ 兜底送达',
      template: 'green',
      markdown: 'final fallback payload',
    });

    assert.equal(calls.cardkitUpdates.length, 0);
    assert.equal(calls.patchedCards.length, 1);
    assert.ok(JSON.stringify(calls.patchedCards[0].card).includes('final fallback payload'));
  });

  it('falls back cleanly to patch mode when cardkit.create fails', async () => {
    const { client, calls } = createMockFeishuClient({ failCardkitCreate: true });
    const session = await createStreamingCardSession(client, {
      messageId: 'om_u4',
      chatId: 'oc_stream_4',
      openId: 'ou_test_owner',
    });

    assert.equal(session.mode, 'patch');
    assert.equal(calls.repliedCards.length, 1);

    session.updateStatus('working');
    await session.finish({
      title: '✅ Patch 完成',
      template: 'green',
      markdown: 'patch mode ok',
    });

    assert.ok(calls.patchedCards.length >= 1);
    assert.ok(JSON.stringify(calls.patchedCards.at(-1).card).includes('patch mode ok'));
  });
});
