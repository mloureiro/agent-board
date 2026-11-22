import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  contextWindowsIn,
  MAX_CONTEXT_TOKENS,
  modelWindowsOf,
  parseAutoCompactPct,
  parseContextEvent,
  usedTokensOf,
} from './context.mts';

test('usedTokensOf sums the four token fields and refuses what is not a reading', () => {
  const full = { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 4 };
  const cases: [string, unknown, number | undefined][] = [
    ['all four fields', full, 244],
    ['missing cache fields count 0', { input_tokens: 5, output_tokens: 7 }, 12],
    ['a string field', { ...full, cache_read_input_tokens: '200' }, undefined],
    ['a missing input', { output_tokens: 7 }, undefined],
    ['a negative field', { ...full, output_tokens: -1 }, undefined],
    ['all zero', { input_tokens: 0, output_tokens: 0 }, undefined],
    ['over the bound', { input_tokens: MAX_CONTEXT_TOKENS, output_tokens: 1 }, undefined],
    ['not an object', 'usage', undefined],
  ];
  for (const [name, usage, expected] of cases) assert.equal(usedTokensOf(usage), expected, name);
});

test('modelWindowsOf keeps the integer windows of modelUsage and skips the rest', () => {
  const cases: [string, Record<string, unknown>, Record<string, number>][] = [
    ['one model', { modelUsage: { a: { contextWindow: 200_000 } } }, { a: 200_000 }],
    ['no modelUsage', {}, {}],
    ['a fractional window', { modelUsage: { a: { contextWindow: 1.5 } } }, {}],
    ['a string window', { modelUsage: { a: { contextWindow: '200000' } } }, {}],
    [
      'several models, one unusable',
      { modelUsage: { a: { contextWindow: 200_000 }, b: { contextWindow: 1_000_000 }, c: {} } },
      { a: 200_000, b: 1_000_000 },
    ],
  ];
  for (const [name, result, expected] of cases) assert.deepEqual(modelWindowsOf(result), expected, name);
});

test('contextWindowsIn reads only a result line that names a window', () => {
  const result = JSON.stringify({ type: 'result', modelUsage: { a: { contextWindow: 1_000_000 } } });
  assert.deepEqual(contextWindowsIn(result), { a: 1_000_000 });
  assert.equal(contextWindowsIn('{"type":"result"}'), undefined, 'prefilter miss');
  assert.equal(contextWindowsIn(JSON.stringify({ type: 'assistant', modelUsage: {} })), undefined, 'not a result');
  assert.equal(contextWindowsIn('{"modelUsage": nope'), undefined, 'not JSON');
  assert.equal(contextWindowsIn(JSON.stringify({ type: 'result', modelUsage: {} })), undefined, 'no window');
});

test('parseAutoCompactPct takes a plain percentage from 1 to 100', () => {
  const cases: [string | undefined, number | null][] = [
    ['50', 50],
    ['87.5', 87.5],
    ['100', 100],
    ['0', null],
    ['101', null],
    ['abc', null],
    ['', null],
    [undefined, null],
    [' 75 ', null],
  ];
  for (const [value, expected] of cases) assert.equal(parseAutoCompactPct(value), expected, String(value));
});

test('parseContextEvent reads an opened event and refuses a malformed one', () => {
  const event = {
    seq: 4,
    at: '2026-11-13T12:00:00.000Z',
    parent: null,
    kind: 'context',
    used: 133_600,
    window: 1_000_000,
    threshold: 80,
    model: 'claude-opus-4-7',
  };
  assert.deepEqual(parseContextEvent(event), event);
  assert.equal(parseContextEvent({ ...event, window: null })?.window, null);
  assert.equal(parseContextEvent({ ...event, threshold: null })?.threshold, null);
  const bad: [string, Record<string, unknown>][] = [
    ['wrong kind', { kind: 'note' }],
    ['negative used', { used: -5 }],
    ['zero used', { used: 0 }],
    ['string window', { window: '1000000' }],
    ['threshold past 100', { threshold: 101 }],
    ['overlong model', { model: 'm'.repeat(257) }],
    ['bad seq', { seq: -1 }],
  ];
  for (const [name, change] of bad) assert.equal(parseContextEvent({ ...event, ...change }), undefined, name);
  assert.equal(parseContextEvent('x'), undefined);
});
