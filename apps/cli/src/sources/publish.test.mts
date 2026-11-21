import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeBackend } from '../__tests__/helpers/fakes.mts';
import { tempDir } from '../__tests__/helpers/watch.mts';
import { applySourceRequests, machineSources, publishSources } from './publish.mts';
import type { SourcesBoardDeps } from './publish.mts';
import { createSourceStore } from './store.mts';

function setup(sources: Record<string, unknown>) {
  const dir = tempDir('board-sources-test-');
  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ machine: 'laptop', sources }));
  const store = createSourceStore(join(dir, 'sources'), () => false);
  const backend = fakeBackend([]);
  const logs: string[] = [];
  const deps: SourcesBoardDeps = { backend, machine: 'laptop', configFile, store, log: (line) => logs.push(line) };
  return { backend, store, logs, deps };
}

const GH = { command: 'list-prs', every: '10m', dir: '/work' };

test('every source gets an id that stays, and a broken one is sent with its problem', () => {
  const { store, deps } = setup({ gh: GH, bad: { command: 'x', every: '30s', dir: '/work' }, '../x': GH });
  const first = machineSources(deps.configFile, store);
  assert.deepEqual(
    first.sources.map(({ name, everyMs, problem }) => ({ name, everyMs, broken: problem !== undefined })),
    [
      { name: 'gh', everyMs: 600_000, broken: false },
      { name: 'bad', everyMs: 0, broken: true },
    ],
  );
  assert.match(first.sources[0]?.id ?? '', /^[0-9a-f]{16}$/);
  assert.deepEqual(machineSources(deps.configFile, store), first);
});

test('the sources are sent when the board holds another version, and not again when it holds this one', async () => {
  const { backend, deps } = setup({ gh: GH });
  await publishSources(deps);
  await publishSources(deps);
  assert.deepEqual(backend.writes, ['sources laptop: gh']);
});

test('a server without the feature is left alone', async () => {
  const { backend, deps } = setup({ gh: GH });
  backend.boardSources.supported = false;
  await applySourceRequests(deps);
  assert.deepEqual(backend.writes, []);
});

test('requests from the board pause, resume or run a source, are acknowledged, and the new state is sent', async () => {
  const { backend, store, deps } = setup({ gh: GH });
  const id = machineSources(deps.configFile, store).sources[0]?.id ?? '';
  backend.boardSources.requests = [`pause:${id}`, `run:${id}`, 'pause:ffffffffffffffff'];
  await applySourceRequests(deps);
  assert.equal(store.read('gh').paused, true);
  assert.equal(store.read('gh').runNow, true);
  assert.deepEqual(backend.writes, [`ack sources pause:${id} run:${id} pause:ffffffffffffffff`, 'sources laptop: gh']);
  assert.equal(backend.boardSources.held?.sources[0]?.paused, true);
  backend.boardSources.requests = [`resume:${id}`];
  await applySourceRequests(deps);
  assert.equal(store.read('gh').paused, false);
});
