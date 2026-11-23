import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeBackend } from '../__tests__/helpers/fakes.mts';
import { tempDir } from '../__tests__/helpers/watch.mts';
import { applyFeedRequests, machineFeeds, publishFeeds } from './publish.mts';
import type { FeedsBoardDeps } from './publish.mts';
import { createFeedStore } from './store.mts';

function setup(feeds: Record<string, unknown>) {
  const dir = tempDir('board-feeds-test-');
  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ machine: 'laptop', feeds }));
  const store = createFeedStore(join(dir, 'feeds'), () => false);
  const backend = fakeBackend([]);
  const logs: string[] = [];
  const clock = { at: new Date('2026-11-21T12:00:00Z') };
  const deps: FeedsBoardDeps = {
    backend,
    machine: 'laptop',
    configFile,
    store,
    now: () => clock.at,
    log: (line) => logs.push(line),
  };
  return { backend, store, logs, deps, clock };
}

const GH = {
  integration: 'acme:github',
  action: 'list',
  every: '10m',
  dir: '/work',
  prompts: { new: 'n', update: 'u' },
};

test('every feed gets an id that stays, and a broken one is sent with its problem', () => {
  const { store, deps } = setup({ gh: GH, bad: { ...GH, every: '30s' }, '../x': GH });
  const first = machineFeeds(deps.configFile, store);
  assert.deepEqual(
    first.feeds.map(({ name, everyMs, problem }) => ({ name, everyMs, broken: problem !== undefined })),
    [
      { name: 'gh', everyMs: 600_000, broken: false },
      { name: 'bad', everyMs: 0, broken: true },
    ],
  );
  assert.match(first.feeds[0]?.id ?? '', /^[0-9a-f]{16}$/);
  assert.deepEqual(machineFeeds(deps.configFile, store), first);
});

test('the feeds are sent when the board holds another version, and not again when it holds this one', async () => {
  const { backend, deps } = setup({ gh: GH });
  await publishFeeds(deps);
  await publishFeeds(deps);
  assert.deepEqual(backend.writes, ['feeds laptop: gh']);
});

test('a server without the feature is left alone', async () => {
  const { backend, deps } = setup({ gh: GH });
  backend.boardFeeds.supported = false;
  await applyFeedRequests(deps);
  assert.deepEqual(backend.writes, []);
});

test('the feeds are sent again with always, as long as the server has the feature', async () => {
  const { backend, deps } = setup({ gh: GH });
  await publishFeeds(deps, true);
  await publishFeeds(deps, true);
  assert.deepEqual(backend.writes, ['feeds laptop: gh', 'feeds laptop: gh']);
  backend.boardFeeds.supported = false;
  await publishFeeds(deps, true);
  assert.equal(backend.writes.length, 2);
});

test('requests from the board pause, resume or ask a run of a feed, are acknowledged, and the new state is sent', async () => {
  const { backend, store, deps, clock } = setup({ gh: GH });
  const id = machineFeeds(deps.configFile, store).feeds[0]?.id ?? '';
  backend.boardFeeds.requests = [`pause:${id}`, `run:${id}`, 'pause:ffffffffffffffff'];
  await applyFeedRequests(deps);
  assert.deepEqual(store.readControl('gh'), { id, paused: true, runRequestedAt: clock.at.toISOString() });
  assert.deepEqual(backend.writes, [`ack feeds pause:${id} run:${id} pause:ffffffffffffffff`, 'feeds laptop: gh']);
  assert.equal(backend.boardFeeds.held?.feeds[0]?.paused, true);
  assert.equal(backend.boardFeeds.held?.feeds[0]?.runNow, true);
  backend.boardFeeds.requests = [`resume:${id}`];
  await applyFeedRequests(deps);
  assert.equal(store.readControl('gh').paused, false);
});

test('a run the feed made after the request clears runNow on the board', async () => {
  const { store, deps, clock } = setup({ gh: GH });
  store.updateControl('gh', { runRequestedAt: clock.at.toISOString() });
  assert.equal(machineFeeds(deps.configFile, store).feeds[0]?.runNow, true);
  const at = new Date(clock.at.getTime() + 1000).toISOString();
  store.writeRecord('gh', {
    last: {
      startedAt: at,
      at,
      ok: true,
      counts: { listed: 0, created: 0, requeued: 0, rescheduled: 0, closed: 0, failed: 0 },
    },
    history: [],
    tasks: {},
  });
  assert.equal(machineFeeds(deps.configFile, store).feeds[0]?.runNow, false);
});
