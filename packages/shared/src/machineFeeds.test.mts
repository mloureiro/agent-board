import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blindIndex, deriveKeys, open, seal } from './crypto.mts';
import type { Keys } from './crypto.mts';
import { ContractError, SEALED_LIMITS, parseVersionFeeds, parseWireFeedRequestAck } from './contract.mts';
import {
  MAX_HISTORY_ERROR,
  MAX_HISTORY_RUNS,
  MAX_LAST_ERROR,
  MAX_LAST_TASKS,
  MAX_MACHINE_FEEDS,
  machineFeedsJson,
  parseMachineFeeds,
  parseFeedRequest,
  feedRequest,
  feedsProblem,
} from './machineFeeds.mts';
import type { MachineFeed, MachineFeeds } from './machineFeeds.mts';
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

const RUN = {
  startedAt: '2026-11-21T11:59:58.000Z',
  at: '2026-11-21T12:00:00.000Z',
  ok: true,
  listed: 3,
  created: 1,
  requeued: 1,
  rescheduled: 0,
  closed: 1,
  failed: 0,
};

const FEEDS: MachineFeeds = {
  feeds: [
    {
      id: ID,
      name: 'github-reviews',
      integration: 'acme:github',
      action: 'list-pull-requests',
      everyMs: 600_000,
      paused: false,
      runAsked: true,
      last: {
        ...RUN,
        ok: false,
        invalid: true,
        error: 'plugin acme is not pinned',
        tasks: [
          { id: 'task-1', outcome: 'created' },
          { id: 'task-2', outcome: 'rescheduled' },
        ],
      },
      history: [RUN, { ...RUN, ok: false, error: 'gh: not logged in', failed: 1 }],
    },
    { id: 'fedcba9876543210', name: 'slack', everyMs: 0, paused: false, runAsked: false, problem: 'bad', history: [] },
  ],
};

const [FIRST] = FEEDS.feeds;
if (FIRST?.last === undefined) throw new Error('fixture has no last run');
const LAST = FIRST.last;

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

test('a document that is not a list of feeds is unreadable', () => {
  assert.equal(parseMachineFeeds({ feeds: 'x' }), undefined);
  assert.equal(parseMachineFeeds([]), undefined);
  assert.equal(parseMachineFeeds({ feeds: Array.from({ length: MAX_MACHINE_FEEDS + 1 }, () => FIRST) }), undefined);
});

const dropped: [string, MachineFeed, MachineFeed][] = [
  ['a feed with a bad id', { ...FIRST, id: 'not hex' } as MachineFeed, FIRST as MachineFeed],
  [
    'a feed whose integration has no marketplace',
    { ...FIRST, integration: 'github' } as MachineFeed,
    FIRST as MachineFeed,
  ],
  ['a feed whose action is not a name', { ...FIRST, action: 'List PRs' } as MachineFeed, FIRST as MachineFeed],
];

test('a feed of the wrong shape is dropped and the others kept', () => {
  for (const [what, bad, good] of dropped)
    assert.deepEqual(parseMachineFeeds({ feeds: [good, bad] }), { feeds: [good] }, what);
});

test('inside a feed, only the part of the wrong shape is dropped', () => {
  const run = (patch: object) => ({ ...FIRST, last: { ...LAST, ...patch } });
  const kept = (patch: object): MachineFeed | undefined => parseMachineFeeds({ feeds: [run(patch)] })?.feeds[0];
  assert.deepEqual(
    kept({
      tasks: [
        { id: 'a b', outcome: 'created' },
        { id: 'task-3', outcome: 'closed' },
      ],
    })?.last?.tasks,
    [{ id: 'task-3', outcome: 'closed' }],
  );
  assert.deepEqual(
    kept({
      tasks: [
        { id: 'task-3', outcome: 'deleted' },
        { id: 'intake', outcome: 'closed' },
      ],
    })?.last?.tasks,
    [],
  );
  assert.equal(kept({ tasks: 'x' })?.last, undefined);
  assert.equal(kept({ at: 'yesterday' })?.last, undefined);
  assert.equal(kept({ invalid: false })?.last, undefined);
  assert.equal(kept({})?.history.length, 2);
  const history = parseMachineFeeds({
    feeds: [
      { ...FIRST, history: [RUN, { ...RUN, listed: -1 }, { ...RUN, error: 'x'.repeat(MAX_HISTORY_ERROR + 1) }, RUN] },
    ],
  })?.feeds[0]?.history;
  assert.deepEqual(history, [RUN, RUN]);
  const many = Array.from({ length: MAX_HISTORY_RUNS + 3 }, () => RUN);
  assert.equal(parseMachineFeeds({ feeds: [{ ...FIRST, history: many }] })?.feeds[0]?.history.length, MAX_HISTORY_RUNS);
});

test('the document is emitted with known fields only, in a fixed order', () => {
  const noisy = {
    ...FIRST,
    commit: 'abc',
    last: { ...LAST, url: 'https://x', tasks: [{ id: 'task-1', outcome: 'created', title: 't' }] },
  };
  const [feed] = JSON.parse(machineFeedsJson({ feeds: [noisy as MachineFeed] })).feeds;
  assert.deepEqual(Object.keys(feed), [
    'id',
    'name',
    'integration',
    'action',
    'everyMs',
    'paused',
    'runAsked',
    'last',
    'history',
  ]);
  assert.deepEqual(Object.keys(feed.last), [
    'startedAt',
    'at',
    'ok',
    'invalid',
    'error',
    'listed',
    'created',
    'requeued',
    'rescheduled',
    'closed',
    'failed',
    'tasks',
  ]);
  assert.deepEqual(Object.keys(feed.last.tasks[0]), ['id', 'outcome']);
});

test('feedsProblem rejects a document over a cap or with an entry that would be dropped', () => {
  const tooMany = { feeds: Array.from({ length: MAX_MACHINE_FEEDS + 1 }, () => FIRST as MachineFeed) };
  assert.match(feedsProblem(tooMany) ?? '', /more than 30 feeds/);
  const tasks = Array.from({ length: MAX_LAST_TASKS + 1 }, () => ({ id: 'task-1', outcome: 'created' as const }));
  const history = Array.from({ length: MAX_HISTORY_RUNS + 1 }, () => RUN);
  for (const patch of [
    { last: { ...LAST, tasks } },
    { last: { ...LAST, error: 'x'.repeat(MAX_LAST_ERROR + 1) } },
    { history },
    { history: [{ ...RUN, error: 'x'.repeat(MAX_HISTORY_ERROR + 1) }] },
    { integration: 'github' },
  ])
    assert.match(feedsProblem({ feeds: [{ ...FIRST, ...patch } as MachineFeed] }) ?? '', /not of its shape/);
  assert.equal(feedsProblem(FEEDS), undefined);
});

test('the largest document the caps allow stays within what the board takes', () => {
  const run = {
    ...RUN,
    ok: false,
    invalid: true as const,
    error: 'x'.repeat(MAX_HISTORY_ERROR),
    startedAt: '2026-11-21T11:59:58.123456789Z',
  };
  const feed: MachineFeed = {
    id: ID,
    name: 'n'.repeat(40),
    integration: `${'m'.repeat(40)}:${'i'.repeat(40)}`,
    action: 'a'.repeat(64),
    everyMs: Number.MAX_SAFE_INTEGER,
    paused: true,
    runAsked: true,
    problem: 'p'.repeat(300),
    last: {
      ...run,
      error: 'e'.repeat(MAX_LAST_ERROR),
      tasks: Array.from({ length: MAX_LAST_TASKS }, () => ({ id: 't'.repeat(64), outcome: 'rescheduled' as const })),
    },
    history: Array.from({ length: MAX_HISTORY_RUNS }, () => run),
  };
  const document = { feeds: Array.from({ length: MAX_MACHINE_FEEDS }, () => feed) };
  assert.equal(feedsProblem(document), undefined);
  const bytes = new TextEncoder().encode(machineFeedsJson(document)).length;
  assert.ok(bytes <= SEALED_LIMITS['machine.feeds'], `${bytes} bytes`);
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
