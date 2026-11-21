import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeBackend, task } from '../__tests__/helpers/fakes.mts';
import { tempDir } from '../__tests__/helpers/watch.mts';
import type { CommandResult } from '../dispatch/waits.mts';
import { parseSources } from './config.mts';
import type { SourceConfig } from './config.mts';
import { parseItems } from './items.mts';
import { isSourceDue, runSource } from './run.mts';
import type { SourceRunDeps } from './run.mts';
import { createSourceStore } from './store.mts';

const DIR = '/work/app';
const NOW = new Date('2026-11-21T12:00:00Z');

const line = (item: Record<string, unknown>): string => JSON.stringify(item);

const SOURCE: SourceConfig = {
  name: 'gh',
  command: 'list-prs',
  everyMs: 600_000,
  dir: DIR,
  keyPrefix: 'source:gh:',
  timeoutMs: 120_000,
};

function setup(output: Partial<CommandResult>, tasks = [task({ id: 'Old1' })]) {
  const backend = fakeBackend(tasks);
  const store = createSourceStore(join(tempDir(), 'sources'), () => false);
  const logs: string[] = [];
  const deps: SourceRunDeps = {
    backend,
    machine: 'laptop',
    dirs: undefined,
    store,
    run: async () => ({ exitCode: 0, timedOut: false, output: '', stdout: '', stderr: '', ...output }),
    link: (id) => `https://board.test/t/${id}`,
    now: () => NOW,
    log: (text) => logs.push(text),
  };
  return { backend, store, logs, deps };
}

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

test('parseSources keeps the error of a bad source apart from the good ones', () => {
  const { sources, sourceErrors } = parseSources({
    gh: { command: 'list-prs', every: '10m', dir: DIR },
    fast: { command: 'x', every: '30s', dir: DIR },
    'bad name!': { command: 'x', every: '10m', dir: DIR },
  });
  assert.deepEqual(
    sources.map(({ name, keyPrefix, everyMs }) => ({ name, keyPrefix, everyMs })),
    [{ name: 'gh', keyPrefix: 'source:gh:', everyMs: 600_000 }],
  );
  assert.match(sourceErrors['fast'] ?? '', /"30s" is not a duration/);
  assert.match(sourceErrors['bad name!'] ?? '', /must be 1 to 40 letters/);
});

test('a run schedules each listed item under the prefixed key and remembers its task', async () => {
  const { backend, store, deps } = setup({ stdout: line({ key: 'pr/7', title: '#7 Fix', prompt: '/review pr/7' }) });
  const run = await runSource(deps, SOURCE);
  assert.equal(run?.ok, true);
  assert.deepEqual(run?.counts, { listed: 1, created: 1, requeued: 0, closed: 0, failed: 0 });
  assert.deepEqual(backend.writes, ['create #7 Fix | /review pr/7 | review | key source:gh:pr/7']);
  assert.deepEqual(store.read('gh').tasks, { 'pr/7': 'new' });
});

test('a failed listing schedules nothing, closes nothing and keeps what it remembered', async () => {
  const { backend, store, deps } = setup({ exitCode: 1, stderr: 'gh: not logged in\n' });
  store.write('gh', { paused: false, runNow: true, tasks: { gone: 'Old1' } });
  const run = await runSource(deps, SOURCE);
  assert.equal(run?.ok, false);
  assert.equal(run?.error, 'the command exited 1: gh: not logged in');
  assert.deepEqual(backend.writes, []);
  assert.deepEqual(store.read('gh').tasks, { gone: 'Old1' });
  assert.equal(store.read('gh').runNow, false);
});

test('an item no longer listed: its task waiting in Todo goes to Done, a started one is left and forgotten', async () => {
  const { backend, store, deps } = setup({ stdout: '' }, [
    task({ id: 'Wait1', status: 'todo', next: 'fresh' }),
    task({ id: 'Run1', status: 'running' }),
  ]);
  store.write('gh', { paused: false, runNow: false, tasks: { a: 'Wait1', b: 'Run1' } });
  const run = await runSource(deps, SOURCE);
  assert.equal(run?.counts.closed, 1);
  assert.deepEqual(backend.writes, ['status Wait1 -> done']);
  assert.deepEqual(store.read('gh').tasks, {});
});

test('an item outside the listed directories fails alone', async () => {
  const { backend, deps } = setup({
    stdout: line({ key: 'x', title: 'X', prompt: 'p', dir: '/elsewhere' }),
  });
  const run = await runSource({ ...deps, dirs: [{ path: DIR }] }, SOURCE);
  assert.equal(run?.ok, false);
  assert.equal(run?.counts.failed, 1);
  assert.match(run?.error ?? '', /^x: \/elsewhere is not a listed directory on laptop/);
  assert.deepEqual(backend.writes, []);
});

test('a source another live process runs is left alone', async () => {
  const { store, deps } = setup({ stdout: '' });
  const held = createSourceStore(join(tempDir(), 'sources'), () => true);
  assert.equal(held.lock('gh'), true);
  assert.equal(await runSource({ ...deps, store: held }, SOURCE), undefined);
  assert.equal(store.read('gh').last, undefined);
});

test('a source is due when asked for, when it never ran, or when its interval has passed; never while paused', () => {
  const store = createSourceStore(join(tempDir(), 'sources'), () => false);
  assert.equal(isSourceDue(SOURCE, store, NOW), true);
  const last = {
    at: new Date(NOW.getTime() - 60_000).toISOString(),
    ok: true,
    counts: { listed: 0, created: 0, requeued: 0, closed: 0, failed: 0 },
  };
  store.write('gh', { paused: false, runNow: false, last, tasks: {} });
  assert.equal(isSourceDue(SOURCE, store, NOW), false);
  assert.equal(isSourceDue(SOURCE, store, new Date(NOW.getTime() + 600_000)), true);
  store.write('gh', { paused: false, runNow: true, last, tasks: {} });
  assert.equal(isSourceDue(SOURCE, store, NOW), true);
  store.write('gh', { paused: true, runNow: true, last, tasks: {} });
  assert.equal(isSourceDue(SOURCE, store, NOW), false);
});
