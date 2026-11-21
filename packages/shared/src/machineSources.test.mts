import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blindIndex, deriveKeys, open, seal } from './crypto.mts';
import type { Keys } from './crypto.mts';
import { ContractError, parseVersionSources, parseWireSourceRequestAck } from './contract.mts';
import {
  machineSourcesJson,
  parseMachineSources,
  parseSourceRequest,
  sourceRequest,
  sourcesProblem,
} from './machineSources.mts';
import type { MachineSources } from './machineSources.mts';
import {
  machineSourcesBinding,
  machineSourcesIndex,
  openMachineSources,
  openMachineUsage,
  sealMachineSources,
} from './sealing.mts';
import type { Opener, Sealer } from './sealing.mts';

const keys = await deriveKeys(
  Uint8Array.from({ length: 32 }, (_, i) => i),
  'alice',
  { index: true },
);
const sealer =
  (k: Keys): Sealer =>
  (binding, text) =>
    seal(k, binding.field, binding.context, text);
const opens: Opener = async (binding, value) => {
  try {
    return await open(keys, binding.field, binding.context, value);
  } catch {
    return undefined;
  }
};
const seals = sealer(keys);

const ID = '0123456789abcdef';

const SOURCES: MachineSources = {
  sources: [
    {
      id: ID,
      name: 'github-reviews',
      everyMs: 600_000,
      paused: false,
      runNow: false,
      last: {
        at: '2026-11-21T12:00:00.000Z',
        ok: false,
        error: 'gh: not logged in',
        listed: 0,
        created: 0,
        requeued: 0,
        closed: 0,
        failed: 0,
      },
    },
    { id: 'fedcba9876543210', name: 'slack', everyMs: 0, paused: false, runNow: false, problem: 'config: bad' },
  ],
};

test('sources are one JSON document, sealed under the machine and opened as the same sources', async () => {
  const wire = await sealMachineSources(seals, 'laptop', SOURCES);
  assert.equal(await open(keys, 'machine.sources', 'machine:laptop', wire), machineSourcesJson(SOURCES));
  assert.deepEqual(machineSourcesBinding('laptop'), { field: 'machine.sources', context: 'machine:laptop' });
  assert.deepEqual(await openMachineSources(opens, 'laptop', wire), SOURCES);
});

test('sources sealed for one machine do not open as another’s, nor as a usage status', async () => {
  const wire = await sealMachineSources(seals, 'laptop', SOURCES);
  assert.equal(await openMachineSources(opens, 'desktop', wire), undefined);
  assert.equal(await openMachineUsage(opens, 'laptop', wire), undefined);
  assert.equal(await openMachineSources(opens, 'laptop', null), undefined);
  assert.equal(await openMachineSources(opens, 'laptop', machineSourcesJson(SOURCES)), undefined);
});

test('a source of the wrong shape is dropped and the others kept; a document that is not a list is unreadable', () => {
  const [first] = SOURCES.sources;
  assert.deepEqual(parseMachineSources({ sources: [first, { ...first, id: 'not hex' }, { ...first, name: 'a\nb' }] }), {
    sources: [first],
  });
  assert.equal(parseMachineSources({ sources: 'x' }), undefined);
  assert.equal(parseMachineSources([]), undefined);
});

test('sealing refuses an entry the board would drop', async () => {
  const [first] = SOURCES.sources;
  if (first === undefined) throw new Error('no source');
  assert.match(sourcesProblem({ sources: [{ ...first, everyMs: -1 }] }) ?? '', /not of its shape/);
  await assert.rejects(sealMachineSources(seals, 'laptop', { sources: [{ ...first, id: 'x' }] }), ContractError);
});

test('the blind index is of the same document, bound to the machine', async () => {
  assert.equal(
    await machineSourcesIndex(keys, 'laptop', SOURCES),
    await blindIndex(keys, `sources:laptop:${machineSourcesJson(SOURCES)}`),
  );
  assert.notEqual(
    await machineSourcesIndex(keys, 'desktop', SOURCES),
    await machineSourcesIndex(keys, 'laptop', SOURCES),
  );
});

test('a request names an action and a source id, and nothing else parses', () => {
  assert.equal(sourceRequest('pause', ID), `pause:${ID}`);
  assert.deepEqual(parseSourceRequest(`run:${ID}`), { action: 'run', id: ID });
  for (const bad of [`stop:${ID}`, 'pause:xyz', `pause:${ID}:x`, 'pause'])
    assert.equal(parseSourceRequest(bad), undefined, bad);
});

test('the version answer keeps the good requests; an ack refuses a bad one', () => {
  assert.deepEqual(parseVersionSources({ sourceRequests: [`pause:${ID}`, 'nonsense', 3] }), {
    index: null,
    requests: [`pause:${ID}`],
  });
  assert.deepEqual(parseVersionSources(undefined), { index: null, requests: [] });
  assert.deepEqual(parseWireSourceRequestAck({ requests: [`run:${ID}`] }), { requests: [`run:${ID}`] });
  assert.throws(() => parseWireSourceRequestAck({ requests: ['nonsense'] }), ContractError);
});
