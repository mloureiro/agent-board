import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { UsageError } from '../cli.mts';
import { fakeBackend } from '../__tests__/helpers/fakes.mts';
import { tempDir } from '../__tests__/helpers/watch.mts';
import { createFeedStore } from '../feeds/store.mts';
import { createFeedUpdates } from '../feeds/updates.mts';
import { feedsAdd, feedsList, feedsRemove, feedsSetPaused } from './feeds.mts';
import type { FeedsDeps } from './feeds.mts';

const NOW = new Date('2026-11-21T12:00:00Z');
const GH = {
  integration: 'acme:github',
  action: 'list',
  every: '10m',
  dir: '/work',
  prompts: { new: 'n', update: 'u' },
};

function setup(isAlive: (pid: number) => boolean = () => false) {
  const dir = tempDir('board-feeds-cmd-');
  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ machine: 'laptop', feeds: { gh: GH } }));
  const stateDir = join(dir, 'feeds');
  const store = createFeedStore(stateDir, isAlive);
  const printed: string[] = [];
  const deps: FeedsDeps = {
    configFile,
    dirs: undefined,
    unitRunning: true,
    now: () => NOW,
    print: (line) => printed.push(line),
    runDeps: () => ({
      backend: fakeBackend([]),
      machine: 'laptop',
      dirs: undefined,
      repos: {},
      store,
      updates: createFeedUpdates(join(stateDir, 'updates')),
      resolve: () => ({ problem: 'unused' }),
      run: async () => ({ exitCode: 0, timedOut: false, output: '', stdout: '', stderr: '' }),
      link: (id) => id,
      now: () => NOW,
      log: () => undefined,
    }),
  };
  return { dir, stateDir, store, printed, deps };
}

test('rm refuses while the lock is held and leaves the config and the state alone', () => {
  const { stateDir, store, deps } = setup(() => true);
  store.updateControl('gh', {});
  writeFileSync(join(stateDir, 'gh.lock'), '4000000');
  assert.throws(
    () => feedsRemove(deps, 'gh'),
    (error) => error instanceof UsageError && /is running/.test(error.message),
  );
  assert.match(readFileSync(deps.configFile, 'utf8'), /"gh"/);
  assert.equal(existsSync(join(stateDir, 'gh.control.json')), true);
});

test('rm removes the config entry, the control file, the record and the lock', () => {
  const { stateDir, store, deps } = setup();
  store.updateControl('gh', { paused: true });
  store.writeRecord('gh', { history: [], tasks: { a: 'T1' } });
  feedsRemove(deps, 'gh');
  assert.doesNotMatch(readFileSync(deps.configFile, 'utf8'), /"gh"/);
  for (const file of ['gh.json', 'gh.control.json', 'gh.lock']) assert.equal(existsSync(join(stateDir, file)), false);
});

test('rm checks the name before it touches a path', () => {
  const { deps } = setup();
  assert.throws(() => feedsRemove(deps, '../gh'), UsageError);
});

test('list shows a paused feed, one a run was asked of, and one waiting for its timer', () => {
  const { store, printed, deps } = setup();
  feedsSetPaused(deps, 'gh', true);
  feedsList(deps);
  assert.match(printed.at(-1) ?? '', /^gh {2}paused/);
  feedsSetPaused(deps, 'gh', false);
  store.updateControl('gh', { runRequestedAt: NOW.toISOString() });
  feedsList(deps);
  assert.match(printed.at(-1) ?? '', /^gh {2}runs next/);
  store.updateControl('gh', { runRequestedAt: new Date(0).toISOString() });
  store.writeRecord('gh', {
    last: {
      startedAt: NOW.toISOString(),
      at: NOW.toISOString(),
      ok: true,
      counts: { listed: 0, created: 0, requeued: 0, rescheduled: 0, closed: 0, failed: 0 },
    },
    history: [],
    tasks: {},
  });
  feedsList(deps);
  assert.match(printed.at(-1) ?? '', /^gh {2}every 10m/);
});

test('add writes a feed entry given as JSON, and replacing a name says so', () => {
  const { deps, printed } = setup();
  const entry = { ...GH, dir: '/work/other', prompts: { new: 'n', update: 'u' } };
  feedsAdd(deps, 'second', JSON.stringify(entry));
  feedsAdd(deps, 'second', JSON.stringify(entry));
  const written = JSON.parse(readFileSync(deps.configFile, 'utf8')) as { feeds: Record<string, unknown> };
  assert.deepEqual(Object.keys(written.feeds), ['gh', 'second']);
  assert.deepEqual(written.feeds['second'], entry);
  assert.deepEqual(printed, [
    'added feed second: acme:github · list every 10m in /work/other',
    'changed feed second: acme:github · list every 10m in /work/other',
  ]);
});

test('add refuses an entry that is not JSON, one with a leftover command, and a directory that is not listed, and writes nothing', () => {
  const { deps } = setup();
  const before = readFileSync(deps.configFile, 'utf8');
  const listed = { ...deps, dirs: [{ path: '/work' }] };
  const cases: [string, string, RegExp][] = [
    ['not JSON', '{', /not valid JSON/],
    ['a leftover command', JSON.stringify({ ...GH, command: 'x' }), /command is gone/],
    ['an unlisted directory', JSON.stringify({ ...GH, dir: '/elsewhere' }), /not a listed directory/],
  ];
  for (const [label, text, reason] of cases)
    assert.throws(
      () => feedsAdd(listed, 'gh2', text),
      (error) => error instanceof UsageError && reason.test(error.message),
      label,
    );
  assert.equal(readFileSync(deps.configFile, 'utf8'), before);
});
