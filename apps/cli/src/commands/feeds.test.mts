import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { UsageError } from '../cli.mts';
import { fakeBackend } from '../__tests__/helpers/fakes.mts';
import { tempDir } from '../__tests__/helpers/watch.mts';
import { createFeedStore } from '../feeds/store.mts';
import { feedsList, feedsRemove, feedsSetPaused } from './feeds.mts';
import type { FeedsDeps } from './feeds.mts';

const NOW = new Date('2026-11-21T12:00:00Z');
const GH = { command: 'list-prs', every: '10m', dir: '/work' };

function setup(isAlive: (pid: number) => boolean = () => false) {
  const dir = tempDir('board-feeds-cmd-');
  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ machine: 'laptop', feeds: { gh: GH } }));
  const stateDir = join(dir, 'feeds');
  const store = createFeedStore(stateDir, isAlive);
  const printed: string[] = [];
  const deps: FeedsDeps = {
    configFile,
    cwd: '/work',
    dirs: undefined,
    unitRunning: true,
    now: () => NOW,
    print: (line) => printed.push(line),
    runDeps: () => ({
      backend: fakeBackend([]),
      machine: 'laptop',
      dirs: undefined,
      store,
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
      counts: { listed: 0, created: 0, requeued: 0, closed: 0, failed: 0 },
    },
    history: [],
    tasks: {},
  });
  feedsList(deps);
  assert.match(printed.at(-1) ?? '', /^gh {2}every 10m/);
});
