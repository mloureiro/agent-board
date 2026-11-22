import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BackendError } from '../backend/backend.mts';
import { fakeBackend, task } from '../__tests__/helpers/fakes.mts';
import { tempDir } from '../__tests__/helpers/watch.mts';
import type { CommandResult } from '../dispatch/waits.mts';
import { MIN_EVERY_MS, parseFeeds } from './config.mts';
import type { FeedConfig } from './config.mts';
import { parseItems } from './items.mts';
import { isFeedDue, runAsked, runFeed } from './run.mts';
import type { FeedRunDeps } from './run.mts';
import { createFeedStore } from './store.mts';
import type { FeedControl, FeedRecord } from './store.mts';

const DIR = '/work/app';
const NOW = new Date('2026-11-21T12:00:00Z');

const line = (item: Record<string, unknown>): string => JSON.stringify(item);

const FEED: FeedConfig = {
  name: 'gh',
  command: 'list-prs',
  everyMs: 600_000,
  dir: DIR,
  keyPrefix: 'feed:gh:',
  timeoutMs: 120_000,
};

function setup(output: Partial<CommandResult>, tasks = [task({ id: 'Old1' })]) {
  const backend = fakeBackend(tasks);
  const store = createFeedStore(join(tempDir(), 'feeds'), () => false);
  const logs: string[] = [];
  const clock = { at: NOW, output, beforeRun: (): void => undefined };
  const deps: FeedRunDeps = {
    backend,
    machine: 'laptop',
    dirs: undefined,
    store,
    run: async () => {
      clock.beforeRun();
      return { exitCode: 0, timedOut: false, output: '', stdout: '', stderr: '', ...clock.output };
    },
    link: (id) => `https://board.test/t/${id}`,
    now: () => clock.at,
    log: (text) => logs.push(text),
  };
  return { backend, store, logs, deps, clock };
}

const ZERO_COUNTS = { listed: 0, created: 0, requeued: 0, closed: 0, failed: 0 };

const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

const recordWith = (tasks: Record<string, string>, startedAtOffsetMs?: number): FeedRecord => ({
  ...(startedAtOffsetMs === undefined
    ? {}
    : {
        last: { startedAt: iso(startedAtOffsetMs), at: iso(startedAtOffsetMs), ok: true, counts: ZERO_COUNTS },
      }),
  history: [],
  tasks,
});

test('parseItems reads one item per line and skips empty lines', () => {
  const parsed = parseItems(
    `${line({ key: 'a', title: 'A', prompt: '/review a', version: 'v1' })}\n\n${line({ key: 'b', title: 'B', prompt: 'p' })}\n`,
  );
  assert.deepEqual(parsed, {
    ok: true,
    items: [
      { key: 'a', title: 'A', prompt: '/review a', version: 'v1' },
      { key: 'b', title: 'B', prompt: 'p' },
    ],
  });
});

test('parseItems fails the whole listing on one bad line', () => {
  assert.deepEqual(parseItems('not json'), { ok: false, error: 'line 1 is not JSON' });
  assert.deepEqual(parseItems(line({ key: 'a', prompt: 'p' })), { ok: false, error: 'line 1 has no title' });
  assert.deepEqual(parseItems(line({ key: 'a', title: 'A', prompt: 'p', agent: 'x' })), {
    ok: false,
    error: 'line 1 has no field "agent" (it takes key, title, prompt, version, dir)',
  });
  const twice = line({ key: 'a', title: 'A', prompt: 'p' });
  assert.deepEqual(parseItems(`${twice}\n${twice}`), { ok: false, error: 'line 2 repeats the key of an earlier line' });
});

test('parseFeeds keeps the error of a bad feed apart from the good ones', () => {
  const { feeds, feedErrors } = parseFeeds({
    gh: { command: 'list-prs', every: '10m', dir: DIR },
    fast: { command: 'x', every: '30s', dir: DIR },
    'bad name!': { command: 'x', every: '10m', dir: DIR },
  });
  assert.deepEqual(
    feeds.map(({ name, keyPrefix, everyMs }) => ({ name, keyPrefix, everyMs })),
    [{ name: 'gh', keyPrefix: 'feed:gh:', everyMs: 600_000 }],
  );
  assert.match(feedErrors['fast'] ?? '', /"30s" is not a duration/);
  assert.match(feedErrors['bad name!'] ?? '', /must be 1 to 40 letters/);
});

test('a run schedules each listed item under the prefixed key and remembers its task', async () => {
  const { backend, store, deps } = setup({ stdout: line({ key: 'pr/7', title: '#7 Fix', prompt: '/review pr/7' }) });
  const run = await runFeed(deps, FEED);
  assert.equal(run?.ok, true);
  assert.deepEqual(run?.counts, { listed: 1, created: 1, requeued: 0, closed: 0, failed: 0 });
  assert.deepEqual(backend.writes, ['create #7 Fix | /review pr/7 | review | key feed:gh:pr/7']);
  assert.deepEqual(store.readRecord('gh').tasks, { 'pr/7': 'new' });
});

test('a failed listing schedules nothing, closes nothing and keeps what it remembered', async () => {
  const { backend, store, deps } = setup({ exitCode: 1, stderr: 'gh: not logged in\n' });
  store.writeRecord('gh', recordWith({ gone: 'Old1' }));
  store.updateControl('gh', { runRequestedAt: iso(-1000) });
  const run = await runFeed(deps, FEED);
  assert.equal(run?.ok, false);
  assert.equal(run?.error, 'the command exited 1: gh: not logged in');
  assert.deepEqual(backend.writes, []);
  assert.deepEqual(store.readRecord('gh').tasks, { gone: 'Old1' });
  assert.equal(store.readRecord('gh').last?.startedAt, NOW.toISOString());
  assert.equal(store.readControl('gh').runRequestedAt, iso(-1000));
});

test('an item no longer listed: its task waiting in Todo goes to Done, a started one is left and forgotten', async () => {
  const { backend, store, deps } = setup({ stdout: '' }, [
    task({ id: 'Wait1', status: 'todo', next: 'fresh' }),
    task({ id: 'Run1', status: 'running' }),
  ]);
  store.writeRecord('gh', recordWith({ a: 'Wait1', b: 'Run1' }));
  const run = await runFeed(deps, FEED);
  assert.equal(run?.counts.closed, 1);
  assert.deepEqual(backend.writes, ['status Wait1 -> done']);
  assert.deepEqual(store.readRecord('gh').tasks, {});
});

test('an item mapped by an earlier run that fails to schedule keeps its task, and is closed once it is unlisted', async () => {
  const { backend, store, deps, clock } = setup({ stdout: line({ key: 'a', title: 'A', prompt: 'p' }) }, [
    task({ id: 'Wait1', status: 'todo', next: 'fresh' }),
  ]);
  store.writeRecord('gh', recordWith({ a: 'Wait1' }));
  const addTask = backend.addTask;
  backend.addTask = async () => {
    throw new Error('503');
  };
  const failed = await runFeed(deps, FEED);
  assert.equal(failed?.counts.failed, 1);
  assert.deepEqual(store.readRecord('gh').tasks, { a: 'Wait1' });
  backend.addTask = addTask;
  clock.output = { stdout: '' };
  const closed = await runFeed(deps, FEED);
  assert.equal(closed?.counts.closed, 1);
  assert.deepEqual(backend.writes, ['status Wait1 -> done']);
  assert.deepEqual(store.readRecord('gh').tasks, {});
});

test('listing the board throws after tasks were made: the record keeps the new ids and the old mapping', async () => {
  const { backend, store, deps } = setup({ stdout: line({ key: 'fresh', title: 'F', prompt: 'p' }) });
  store.writeRecord('gh', recordWith({ gone: 'Old1' }));
  backend.listTasks = async () => {
    throw new Error('network down');
  };
  const run = await runFeed(deps, FEED);
  assert.equal(run?.ok, false);
  assert.equal(run?.error, 'network down');
  assert.deepEqual(store.readRecord('gh').tasks, { gone: 'Old1', fresh: 'new' });
});

test('closing: a 409 drops the mapping, another error keeps it for the next run', async () => {
  const { backend, store, deps } = setup({ stdout: '' }, [
    task({ id: 'Raced', status: 'todo', next: 'fresh' }),
    task({ id: 'Broken', status: 'todo', next: 'fresh' }),
  ]);
  store.writeRecord('gh', recordWith({ a: 'Raced', b: 'Broken' }));
  backend.updateTask = async (id) => {
    throw id === 'Raced' ? new BackendError('the task is running, not todo', 409) : new Error('boom');
  };
  const run = await runFeed(deps, FEED);
  assert.equal(run?.counts.closed, 0);
  assert.deepEqual(store.readRecord('gh').tasks, { b: 'Broken' });
});

test('a task that waits in Done for a new version is requeued and counted', async () => {
  const { backend, store, deps } = setup({ stdout: line({ key: 'pr/1', title: 'P', prompt: 'p', version: 'v2' }) }, [
    task({ id: 'Old1', status: 'done' }),
  ]);
  backend.keys.set('Old1', 'feed:gh:pr/1');
  const run = await runFeed(deps, FEED);
  assert.deepEqual(run?.counts, { listed: 1, created: 0, requeued: 1, closed: 0, failed: 0 });
  assert.deepEqual(store.readRecord('gh').tasks, { 'pr/1': 'Old1' });
});

test('a run keeps the last ten runs, newest first, and the control file untouched', async () => {
  const { store, deps, clock } = setup({ stdout: '' });
  store.updateControl('gh', { paused: true, runRequestedAt: iso(-5000) });
  const control = store.readControl('gh');
  for (let n = 0; n < 12; n++) {
    clock.at = new Date(NOW.getTime() + n * 1000);
    await runFeed(deps, FEED);
  }
  const { last, history } = store.readRecord('gh');
  assert.equal(history.length, 10);
  assert.equal(last?.startedAt, iso(11_000));
  assert.deepEqual(history[0], last);
  assert.equal(history[9]?.startedAt, iso(2000));
  assert.deepEqual(store.readControl('gh'), control);
});

test('an item outside the listed directories fails alone', async () => {
  const { backend, deps } = setup({
    stdout: line({ key: 'x', title: 'X', prompt: 'p', dir: '/elsewhere' }),
  });
  const run = await runFeed({ ...deps, dirs: [{ path: DIR }] }, FEED);
  assert.equal(run?.ok, false);
  assert.equal(run?.counts.failed, 1);
  assert.match(run?.error ?? '', /^x: \/elsewhere is not a listed directory on laptop/);
  assert.deepEqual(backend.writes, []);
});

test('a feed another live process runs is left alone', async () => {
  const dir = join(tempDir(), 'feeds');
  const { backend, deps } = setup({ stdout: line({ key: 'x', title: 'X', prompt: 'p' }) });
  const store = createFeedStore(dir, () => true);
  assert.equal(createFeedStore(dir, () => true).lock('gh'), true);
  assert.equal(await runFeed({ ...deps, store }, FEED), undefined);
  assert.equal(store.readRecord('gh').last, undefined);
  assert.deepEqual(backend.writes, []);
});

test('a lock naming a dead process is replaced; one naming a live process is not', () => {
  const dir = join(tempDir(), 'feeds');
  const dead = createFeedStore(dir, () => false);
  dead.lock('gh');
  writeFileSync(join(dir, 'gh.lock'), '4000000');
  assert.equal(dead.lock('gh'), true);
  assert.deepEqual(readdirSync(dir), ['gh.lock']);
  const live = createFeedStore(dir, () => true);
  writeFileSync(join(dir, 'gh.lock'), '4000000');
  assert.equal(live.lock('gh'), false);
  assert.deepEqual(readdirSync(dir), ['gh.lock']);
});

test('two first writers of a control file end with one id and both patches', () => {
  const dir = join(tempDir(), 'feeds');
  const one = createFeedStore(dir, () => false);
  const other = createFeedStore(dir, () => false);
  const first = one.updateControl('gh', { paused: true });
  const second = other.updateControl('gh', { runRequestedAt: iso(0) });
  assert.match(first.id, /^[0-9a-f]{16}$/);
  assert.equal(second.id, first.id);
  assert.deepEqual(one.readControl('gh'), { id: first.id, paused: true, runRequestedAt: iso(0) });
  assert.equal(one.updateControl('gh', {}).id, first.id);
});

test('an unreadable control file or record reads as empty', () => {
  const dir = join(tempDir(), 'feeds');
  const store = createFeedStore(dir, () => false);
  store.updateControl('gh', {});
  writeFileSync(join(dir, 'gh.control.json'), '{not json');
  writeFileSync(join(dir, 'gh.json'), '[]');
  assert.deepEqual(store.readControl('gh'), { paused: false });
  assert.deepEqual(store.readRecord('gh'), { history: [], tasks: {} });
  assert.equal(existsSync(join(dir, 'gh.lock')), false);
});

const control = (patch: Partial<FeedControl> = {}): FeedControl => ({ paused: false, ...patch });

const DUE_CASES: { name: string; control: FeedControl; record: FeedRecord; due: boolean; asked: boolean }[] = [
  { name: 'never ran', control: control(), record: recordWith({}), due: true, asked: false },
  { name: 'never ran, paused', control: control({ paused: true }), record: recordWith({}), due: false, asked: false },
  {
    name: 'never ran, paused, asked',
    control: control({ paused: true, runRequestedAt: iso(-10) }),
    record: recordWith({}),
    due: true,
    asked: true,
  },
  { name: 'interval not passed', control: control(), record: recordWith({}, -300_000), due: false, asked: false },
  { name: 'interval passed', control: control(), record: recordWith({}, -600_000), due: true, asked: false },
  {
    name: 'interval passed, paused',
    control: control({ paused: true }),
    record: recordWith({}, -600_000),
    due: false,
    asked: false,
  },
  {
    name: 'asked after the last start',
    control: control({ runRequestedAt: iso(-100_000) }),
    record: recordWith({}, -300_000),
    due: true,
    asked: true,
  },
  {
    name: 'asked while paused',
    control: control({ paused: true, runRequestedAt: iso(-100_000) }),
    record: recordWith({}, -300_000),
    due: true,
    asked: true,
  },
  {
    name: 'asked within a minute of the last start',
    control: control({ runRequestedAt: iso(-10_000) }),
    record: recordWith({}, -MIN_EVERY_MS + 1000),
    due: false,
    asked: true,
  },
  {
    name: 'asked before the last start: already served',
    control: control({ runRequestedAt: iso(-400_000) }),
    record: recordWith({}, -300_000),
    due: false,
    asked: false,
  },
];

for (const { name, control: asked, record, due, asked: wasAsked } of DUE_CASES)
  test(`isFeedDue: ${name}`, () => {
    assert.equal(isFeedDue(FEED, asked, record, NOW), due);
    assert.equal(runAsked(asked, record), wasAsked);
  });

test('a request written while a run is in flight makes the feed due again once a minute has passed', async () => {
  const { store, deps, clock } = setup({ stdout: '' });
  clock.beforeRun = () => {
    store.updateControl('gh', { runRequestedAt: iso(1000) });
  };
  await runFeed(deps, FEED);
  const due = (offsetMs: number): boolean =>
    isFeedDue(FEED, store.readControl('gh'), store.readRecord('gh'), new Date(NOW.getTime() + offsetMs));
  assert.equal(due(30_000), false);
  assert.equal(due(MIN_EVERY_MS), true);
  assert.equal(runAsked(store.readControl('gh'), store.readRecord('gh')), true);
});
