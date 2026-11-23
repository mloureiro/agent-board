import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeBackend } from '../__tests__/helpers/fakes.mts';
import { tempDir } from '../__tests__/helpers/watch.mts';
import { applyFeedRequests, boardLine, machineFeeds, publishFeeds } from './publish.mts';
import type { FeedsBoardDeps } from './publish.mts';
import { createFeedStore, zeroCounts } from './store.mts';
import type { FeedRun } from './store.mts';
import { feedsProblem } from '@agent-board/shared';

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
  assert.equal(backend.boardFeeds.held?.feeds[0]?.runAsked, true);
  backend.boardFeeds.requests = [`resume:${id}`];
  await applyFeedRequests(deps);
  assert.equal(store.readControl('gh').paused, false);
});

test('a run the feed made after the request clears runAsked on the board', async () => {
  const { store, deps, clock } = setup({ gh: GH });
  store.updateControl('gh', { runRequestedAt: clock.at.toISOString() });
  assert.equal(machineFeeds(deps.configFile, store).feeds[0]?.runAsked, true);
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
  assert.equal(machineFeeds(deps.configFile, store).feeds[0]?.runAsked, false);
});

test('the document carries the integration, the last run with its tasks, the invalid flag and the history', () => {
  const { store, deps, clock } = setup({ gh: GH });
  store.updateControl('gh', { runRequestedAt: clock.at.toISOString() });
  const run = (at: string, patch: Partial<FeedRun>): FeedRun => ({
    startedAt: at,
    at,
    ok: true,
    counts: { listed: 2, created: 1, requeued: 0, rescheduled: 1, closed: 0, failed: 0 },
    ...patch,
  });
  const older = run('2026-11-21T11:00:00.000Z', { ok: false, error: 'boom\nsecond line' });
  const newest = run('2026-11-21T11:30:00.000Z', {
    ok: false,
    invalid: true,
    error: 'plugin is not pinned',
    tasks: [
      { id: 'task-1', outcome: 'created' },
      { id: 'task-2', outcome: 'rescheduled' },
    ],
  });
  store.writeRecord('gh', { last: newest, history: [newest, older], tasks: { key: 'task-1' } });
  const [feed] = machineFeeds(deps.configFile, store).feeds;
  assert.equal(feed?.integration, 'acme:github');
  assert.equal(feed?.action, 'list');
  assert.equal(feed?.runAsked, true);
  assert.equal(feed?.last?.invalid, true);
  assert.deepEqual(feed?.last?.tasks, newest.tasks);
  assert.equal(feed?.last?.rescheduled, 1);
  assert.deepEqual(
    feed?.history.map(({ at, error }) => ({ at, error })),
    [
      { at: newest.at, error: 'plugin is not pinned' },
      { at: older.at, error: 'boom second line' },
    ],
  );
});

test('a feed whose config is not read has no integration or action, only its problem', () => {
  const { store, deps } = setup({ bad: { ...GH, every: '30s' } });
  const [feed] = machineFeeds(deps.configFile, store).feeds;
  assert.equal(feed?.integration, undefined);
  assert.equal(feed?.action, undefined);
  assert.match(feed?.problem ?? '', /every/);
  assert.deepEqual(feed?.history, []);
});

test('a long error is cut to what the board takes, and the result passes the sender check', () => {
  const { store, deps } = setup({ gh: GH });
  const at = '2026-11-21T11:30:00.000Z';
  const long = { startedAt: at, at, ok: false, error: 'é'.repeat(500), counts: zeroCounts() };
  store.writeRecord('gh', { last: long, history: [long], tasks: {} });
  const feeds = machineFeeds(deps.configFile, store);
  assert.equal(feeds.feeds[0]?.last?.error?.length, 300);
  assert.equal(feeds.feeds[0]?.history[0]?.error?.length, 120);
  assert.equal(feedsProblem(feeds), undefined);
});

test('an emoji at the cut is not split, and the document still passes the sender check', () => {
  const { store, deps } = setup({ gh: GH });
  const at = '2026-11-21T11:30:00.000Z';
  const error = `${'a'.repeat(299)}😀😀`;
  const run = { startedAt: at, at, ok: false, error, counts: zeroCounts() };
  store.writeRecord('gh', { last: run, history: [{ ...run, error: `${'a'.repeat(119)}😀😀` }], tasks: {} });
  const feeds = machineFeeds(deps.configFile, store);
  assert.equal(feeds.feeds[0]?.last?.error, 'a'.repeat(299));
  assert.equal(feeds.feeds[0]?.history[0]?.error, 'a'.repeat(119));
  assert.equal(feedsProblem(feeds), undefined);
});

test('a text cut at the problem length keeps whole characters and no control characters', () => {
  const cut = boardLine(`${'a'.repeat(299)}😀\n`, 300);
  assert.equal(cut, 'a'.repeat(299));
  assert.equal(boardLine(`${'a'.repeat(298)}😀\nb`, 300), `${'a'.repeat(298)}😀`);
  assert.equal(boardLine('x\ny', 10), 'x y');
});

test('thirty feeds are sent as they are and a thirty-first is left out, so the board keeps showing all that fit', () => {
  const names = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}`, GH]));
  const thirty = setup(names(30));
  assert.equal(machineFeeds(thirty.deps.configFile, thirty.store).feeds.length, 30);
  const over = setup(names(31));
  const sent = machineFeeds(over.deps.configFile, over.store).feeds;
  assert.equal(sent.length, 30);
  assert.equal(
    sent.some(({ name }) => name === 'f30'),
    false,
  );
  assert.equal(feedsProblem({ feeds: sent }), undefined);
});
