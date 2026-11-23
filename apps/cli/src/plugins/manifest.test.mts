import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarketplace } from './manifest.mts';

const feed = { program: 'feeds/github/run', description: 'PRs' };
const base = { protocol: 1, name: 'acme', feeds: { github: feed } };
const text = (change: Record<string, unknown>): string => JSON.stringify({ ...base, ...change });

test('parseMarketplace reads a valid manifest, an empty feeds object included', () => {
  assert.deepEqual(parseMarketplace(JSON.stringify({ ...base, description: 'd' })), {
    name: 'acme',
    description: 'd',
    feeds: { github: feed },
  });
  assert.deepEqual(parseMarketplace(text({ feeds: {} })), { name: 'acme', description: undefined, feeds: {} });
});

test('parseMarketplace refuses what it does not know, with the reason', () => {
  const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`f${index}`, feed]));
  const cases: [string, string, RegExp][] = [
    ['protocol 2', text({ protocol: 2 }), /protocol 2; this CLI speaks 1/],
    ['missing protocol', JSON.stringify({ name: 'acme', feeds: {} }), /protocol undefined/],
    ['bad marketplace name', text({ name: 'Acme' }), /marketplace name/],
    ['unknown top-level key', text({ extra: 1 }), /unknown key "extra"/],
    ['unknown feed key', text({ feeds: { github: { ...feed, env: {} } } }), /unknown key "env"/],
    ['bad feed name', text({ feeds: { 'Git Hub': feed } }), /feed name/],
    ['.. segment', text({ feeds: { github: { program: 'feeds/../run' } } }), /program/],
    ['leading slash', text({ feeds: { github: { program: '/feeds/run' } } }), /program/],
    ['dot segment', text({ feeds: { github: { program: './run' } } }), /program/],
    ['space in program', text({ feeds: { github: { program: 'feeds/my run' } } }), /program/],
    ['too many feeds', text({ feeds: tooMany }), /at most 50/],
    ['long description', text({ description: 'x'.repeat(301) }), /description/],
    ['feeds is a list', text({ feeds: [] }), /feeds object/],
    ['not JSON', '{', /not valid JSON/],
    ['not an object', '[]', /JSON object/],
    ['over 64 KiB', text({ description: 'x'.repeat(70_000) }), /larger than 64 KiB/],
  ];
  for (const [label, input, reason] of cases) {
    const result = parseMarketplace(input);
    assert.equal(typeof result, 'string', label);
    assert.match(String(result), reason, label);
  }
});
