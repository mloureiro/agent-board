import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFeed, parseFeeds } from './config.mts';

const GOOD = {
  integration: 'acme:github',
  action: 'list-pull-requests',
  options: { repositories: ['acme/app'] },
  every: '10m',
  dir: '/work/app',
  agent: 'reviewer',
  lane: 'reviews',
  timeout: '5m',
  prompts: { new: '/review {url}', update: '{url} changed' },
};

const without = (key: string): Record<string, unknown> => {
  const { [key]: _gone, ...rest } = GOOD as Record<string, unknown>;
  return rest;
};

test('a complete entry is read, with the defaults of the optional keys', () => {
  assert.deepEqual(parseFeed('gh', GOOD), {
    name: 'gh',
    integration: 'acme:github',
    action: 'list-pull-requests',
    options: { repositories: ['acme/app'] },
    everyMs: 600_000,
    dir: '/work/app',
    agent: 'reviewer',
    lane: 'reviews',
    timeoutMs: 300_000,
    prompts: { new: '/review {url}', update: '{url} changed' },
  });
  const minimal = parseFeed('gh', {
    ...GOOD,
    options: undefined,
    agent: undefined,
    lane: undefined,
    timeout: undefined,
  });
  assert.deepEqual(
    [minimal.options, minimal.timeoutMs, 'agent' in minimal, 'lane' in minimal],
    [{}, 120_000, false, false],
  );
});

const REFUSED: [string, Record<string, unknown>, RegExp][] = [
  ['no integration', without('integration'), /integration must be <marketplace>:<integration>/],
  [
    'an integration without a colon',
    { ...GOOD, integration: 'github' },
    /must name the plugin: <marketplace>:<integration>, see board plugins list/,
  ],
  [
    'an integration with a bad half',
    { ...GOOD, integration: 'Acme:github' },
    /integration must be <marketplace>:<integration>, each 1 to 40/,
  ],
  [
    'an integration with three parts',
    { ...GOOD, integration: 'a:b:c' },
    /integration must be <marketplace>:<integration>/,
  ],
  ['no action', without('action'), /action must be the name of an action/],
  ['an action with a space', { ...GOOD, action: 'list prs' }, /action must be the name of an action/],
  ['no every', without('every'), /every must be a duration/],
  ['every in seconds', { ...GOOD, every: '30s' }, /"30s" is not a duration/],
  ['no dir', without('dir'), /dir must be an absolute path/],
  ['a relative dir', { ...GOOD, dir: 'app' }, /dir must be an absolute path/],
  ['an agent that is not a name', { ...GOOD, agent: 'Not a name' }, /agent must be the name of an agent/],
  ['an empty lane', { ...GOOD, lane: '' }, /lane must be the name of a lane/],
  ['a timeout over 30m', { ...GOOD, timeout: '31m' }, /timeout must be at most 30m/],
  ['options that are a list', { ...GOOD, options: [] }, /options must be an object/],
  ['options over 16 KiB', { ...GOOD, options: { text: 'x'.repeat(17 * 1024) } }, /options must be at most 16 KiB/],
  ['no prompts', without('prompts'), /prompts must be an object with new and update/],
  ['no prompts.update', { ...GOOD, prompts: { new: 'n' } }, /prompts\.update must be text of 1 to 10000/],
  ['an empty prompts.new', { ...GOOD, prompts: { new: ' ', update: 'u' } }, /prompts\.new must be text/],
  [
    'a prompt over 10 000 characters',
    { ...GOOD, prompts: { new: 'x'.repeat(10_001), update: 'u' } },
    /prompts\.new must be text/,
  ],
  [
    'an unknown prompts key',
    { ...GOOD, prompts: { new: 'n', update: 'u', extra: 'x' } },
    /prompts has no setting "extra" \(it takes new, update\)/,
  ],
  [
    'an unknown key',
    { ...GOOD, customHandler: 'x' },
    /has no setting "customHandler" \(it takes integration, action, options/,
  ],
];

for (const [name, entry, reason] of REFUSED)
  test(`a feed with ${name} is refused`, () => assert.throws(() => parseFeed('gh', entry), reason));

test('a leftover command or keyPrefix is refused with the keys feeds take', () => {
  for (const key of ['command', 'keyPrefix'])
    assert.throws(
      () => parseFeed('gh', { ...GOOD, [key]: 'x' }),
      new RegExp(
        `feeds\\.gh\\.${key} is gone: feeds take integration, action, options, every, dir, agent, lane, timeout, prompts`,
      ),
    );
  assert.throws(() => parseFeed('gh', { command: 'list-prs', every: '10m', dir: '/work' }), /command is gone/);
});

test('one bad feed keeps its error apart from the good ones', () => {
  const { feeds, feedErrors } = parseFeeds({
    gh: GOOD,
    old: { command: 'x', every: '10m', dir: '/work' },
    'bad name!': GOOD,
  });
  assert.deepEqual(
    feeds.map(({ name }) => name),
    ['gh'],
  );
  assert.match(feedErrors['old'] ?? '', /command is gone/);
  assert.match(feedErrors['bad name!'] ?? '', /must be 1 to 40 letters/);
});
