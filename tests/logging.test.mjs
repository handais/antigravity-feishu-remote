import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalTimestamp, installTimestampedConsole } from '../scripts/lib/io-utils.mjs';

test('formatLocalTimestamp formats valid dates with local offset and falls back for invalid input', () => {
  const fixed = new Date(2026, 10, 27, 9, 5, 3, 7);
  const formatted = formatLocalTimestamp(fixed);
  assert.match(formatted, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  assert.ok(formatted.startsWith('2026-11-27 09:05:03.007'));

  const invalid = formatLocalTimestamp('not-a-valid-date');
  assert.match(invalid, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  assert.equal(invalid.includes('NaN'), false);
});

test('installTimestampedConsole prefixes all console methods and is idempotent', () => {
  const calls = [];
  const fakeConsole = {
    log: (...args) => calls.push(['log', ...args]),
    info: (...args) => calls.push(['info', ...args]),
    warn: (...args) => calls.push(['warn', ...args]),
    error: (...args) => calls.push(['error', ...args]),
  };
  const fixedDate = new Date(2026, 10, 27, 11, 25, 30, 123);
  const expectedPrefix = `[${formatLocalTimestamp(fixedDate)}]`;

  const ret1 = installTimestampedConsole(fakeConsole, { now: () => fixedDate });
  const ret2 = installTimestampedConsole(fakeConsole, { now: () => fixedDate });
  assert.equal(ret1, fakeConsole);
  assert.equal(ret2, fakeConsole);

  fakeConsole.log('hello %s', 'world');
  fakeConsole.info('info line');
  fakeConsole.warn('warn line');
  fakeConsole.error('err line');
  fakeConsole.error({ code: 500 }, 'extra');
  fakeConsole.error();

  assert.deepEqual(calls, [
    ['log', `${expectedPrefix} hello %s`, 'world'],
    ['info', `${expectedPrefix} info line`],
    ['warn', `${expectedPrefix} warn line`],
    ['error', `${expectedPrefix} err line`],
    ['error', expectedPrefix, { code: 500 }, 'extra'],
    ['error', expectedPrefix],
  ]);
});
