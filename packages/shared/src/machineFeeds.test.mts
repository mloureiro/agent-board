import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blindIndex, deriveKeys, open, seal } from './crypto.mts';
import type { Keys } from './crypto.mts';
import { ContractError, parseVersionFeeds, parseWireFeedRequestAck } from './contract.mts';
import { machineFeedsJson, parseMachineFeeds, parseFeedRequest, feedRequest, feedsProblem } from './machineFeeds.mts';
import type { MachineFeeds } from './machineFeeds.mts';
import {
  machineFeedsBinding,
  machineFeedsIndex,
  openMachineFeeds,
  openMachineUsage,
  sealMachineFeeds,
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

const FEEDS: MachineFeeds = {
  feeds: [
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

test('feeds are one JSON document, sealed under the machine and opened as the same feeds', async () => {
  const wire = await sealMachineFeeds(seals, 'laptop', FEEDS);
  assert.equal(await open(keys, 'machine.feeds', 'machine:laptop', wire), machineFeedsJson(FEEDS));
  assert.deepEqual(machineFeedsBinding('laptop'), { field: 'machine.feeds', context: 'machine:laptop' });
  assert.deepEqual(await openMachineFeeds(opens, 'laptop', wire), FEEDS);
});

test('feeds sealed for one machine do not open as another’s, nor as a usage status', async () => {
  const wire = await sealMachineFeeds(seals, 'laptop', FEEDS);
  assert.equal(await openMachineFeeds(opens, 'desktop', wire), undefined);
  assert.equal(await openMachineUsage(opens, 'laptop', wire), undefined);
  assert.equal(await openMachineFeeds(opens, 'laptop', null), undefined);
  assert.equal(await openMachineFeeds(opens, 'laptop', machineFeedsJson(FEEDS)), undefined);
});

test('a feed of the wrong shape is dropped and the others kept; a document that is not a list is unreadable', () => {
  const [first] = FEEDS.feeds;
  assert.deepEqual(parseMachineFeeds({ feeds: [first, { ...first, id: 'not hex' }, { ...first, name: 'a\nb' }] }), {
    feeds: [first],
  });
  assert.equal(parseMachineFeeds({ feeds: 'x' }), undefined);
  assert.equal(parseMachineFeeds([]), undefined);
});

test('sealing refuses an entry the board would drop', async () => {
  const [first] = FEEDS.feeds;
  if (first === undefined) throw new Error('no feed');
  assert.match(feedsProblem({ feeds: [{ ...first, everyMs: -1 }] }) ?? '', /not of its shape/);
  await assert.rejects(sealMachineFeeds(seals, 'laptop', { feeds: [{ ...first, id: 'x' }] }), ContractError);
});

test('the blind index is of the same document, bound to the machine', async () => {
  assert.equal(
    await machineFeedsIndex(keys, 'laptop', FEEDS),
    await blindIndex(keys, `feeds:laptop:${machineFeedsJson(FEEDS)}`),
  );
  assert.notEqual(await machineFeedsIndex(keys, 'desktop', FEEDS), await machineFeedsIndex(keys, 'laptop', FEEDS));
});

test('a request names an action and a feed id, and nothing else parses', () => {
  assert.equal(feedRequest('pause', ID), `pause:${ID}`);
  assert.deepEqual(parseFeedRequest(`run:${ID}`), { action: 'run', id: ID });
  for (const bad of [`stop:${ID}`, 'pause:xyz', `pause:${ID}:x`, 'pause'])
    assert.equal(parseFeedRequest(bad), undefined, bad);
});

test('the version answer keeps the good requests; an ack refuses a bad one', () => {
  assert.deepEqual(parseVersionFeeds({ feedRequests: [`pause:${ID}`, 'nonsense', 3] }), {
    index: null,
    requests: [`pause:${ID}`],
  });
  assert.deepEqual(parseVersionFeeds(undefined), { index: null, requests: [] });
  assert.deepEqual(parseWireFeedRequestAck({ requests: [`run:${ID}`] }), { requests: [`run:${ID}`] });
  assert.throws(() => parseWireFeedRequestAck({ requests: ['nonsense'] }), ContractError);
});
