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
  const deps: FeedsBoardDeps = { backend, machine: 'laptop', configFile, store, log: (line) => logs.push(line) };
  return { backend, store, logs, deps };
}

const GH = { command: 'list-prs', every: '10m', dir: '/work' };

test('every feed gets an id that stays, and a broken one is sent with its problem', () => {
  const { store, deps } = setup({ gh: GH, bad: { command: 'x', every: '30s', dir: '/work' }, '../x': GH });
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

test('requests from the board pause, resume or run a feed, are acknowledged, and the new state is sent', async () => {
  const { backend, store, deps } = setup({ gh: GH });
  const id = machineFeeds(deps.configFile, store).feeds[0]?.id ?? '';
  backend.boardFeeds.requests = [`pause:${id}`, `run:${id}`, 'pause:ffffffffffffffff'];
  await applyFeedRequests(deps);
  assert.equal(store.read('gh').paused, true);
  assert.equal(store.read('gh').runNow, true);
  assert.deepEqual(backend.writes, [`ack feeds pause:${id} run:${id} pause:ffffffffffffffff`, 'feeds laptop: gh']);
  assert.equal(backend.boardFeeds.held?.feeds[0]?.paused, true);
  backend.boardFeeds.requests = [`resume:${id}`];
  await applyFeedRequests(deps);
  assert.equal(store.read('gh').paused, false);
});
