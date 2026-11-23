import {
  isBlindIndex,
  machineFeedsIndex,
  openMachineFeeds,
  sealMachineFeeds,
  sealMachineUsage,
} from '@agent-board/shared';
import type { MachineFeeds } from '@agent-board/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { machines } from './db/schema';
import { buildServer } from './server';
import { Changes } from './services/changes';
import type { MachineAnswer } from './test/client';
import { caller, testConfig, useTestDb } from './test/helpers';
import { keysFor, sealed } from './test/sealed';

const { db, admin } = useTestDb();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ID = '0123456789abcdef';

const FEEDS: MachineFeeds = {
  feeds: [
    {
      id: ID,
      name: 'github-reviews',
      integration: 'acme:github',
      action: 'list-pull-requests',
      everyMs: 600_000,
      paused: false,
      runAsked: false,
      history: [],
    },
  ],
};

async function body(machine: string, feeds = FEEDS) {
  return {
    feeds: await sealMachineFeeds(sealed.seal, machine, feeds),
    index: await machineFeedsIndex(await keysFor(), machine, feeds),
  };
}

let changes: Changes;
let app: Awaited<ReturnType<typeof buildServer>>;
beforeEach(async () => {
  changes = new Changes(20);
  app = await buildServer(testConfig, db, { changes });
});

async function machine(name: string) {
  const { token } = await caller(db).machines.issue({ name });
  return async (command: string, payload: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machine/${command}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    return { status: res.statusCode, json: res.json() as MachineAnswer['json'] };
  };
}

const rows = () => admin.select().from(machines).orderBy(machines.name);

describe('set-feeds', () => {
  it('keeps the sealed feeds and their index on the calling machine, and the browser lists and opens them', async () => {
    const laptop = await machine('laptop');
    await machine('desktop');
    const sent = await body('laptop');
    expect(await laptop('set-feeds', { body: sent })).toEqual({ status: 200, json: { result: null } });
    const [desktop, mine] = await rows();
    expect(desktop).toMatchObject({ feeds: null, feedsIndex: null });
    expect(mine).toMatchObject({ feeds: sent.feeds, feedsIndex: sent.index });
    expect(JSON.stringify(mine)).not.toContain('github-reviews');
    const listed = await caller(db).feeds.list();
    expect(listed.map(({ name }) => name)).toEqual(['laptop']);
    expect(await openMachineFeeds(sealed.open, 'laptop', listed[0]?.feeds)).toEqual(FEEDS);
  });

  it('refuses what is not sealed feeds with a blind index, and a usage status does not open as feeds', async () => {
    const laptop = await machine('laptop');
    const good = await body('laptop');
    for (const payload of [{ feeds: JSON.stringify(FEEDS), index: good.index }, { feeds: good.feeds }, {}])
      expect((await laptop('set-feeds', { body: payload })).status).toBe(400);
    const usage = await sealMachineUsage(sealed.seal, 'laptop', { windows: {}, reached: [], held: [], open: [] });
    await laptop('set-feeds', { body: { ...good, feeds: usage } });
    expect(await openMachineFeeds(sealed.open, 'laptop', (await rows())[0]?.feeds)).toBeUndefined();
  });
});

describe('feed requests', () => {
  it('wait in the version answer of their machine until it acknowledges them, and wake the dispatcher', async () => {
    const laptop = await machine('laptop');
    const desktop = await machine('desktop');
    await laptop('set-feeds', { body: await body('laptop') });
    let events = 0;
    const stop = changes.subscribe('jascha', () => (events += 1));
    await caller(db, 'jascha', changes).feeds.request({ machine: 'laptop', action: 'pause', id: ID });
    await caller(db, 'jascha', changes).feeds.request({ machine: 'laptop', action: 'run', id: ID });
    await sleep(200);
    stop();
    expect(events).toBeGreaterThan(0);
    const version = (await laptop('version')).json.result;
    expect(version.feedRequests).toEqual([`pause:${ID}`, `run:${ID}`]);
    expect(isBlindIndex(version.feedsIndex)).toBe(true);
    expect((await desktop('version')).json.result.feedRequests).toEqual([]);
    expect(await laptop('ack-feed-requests', { body: { requests: [`pause:${ID}`] } })).toEqual({
      status: 200,
      json: { result: null },
    });
    expect((await laptop('version')).json.result.feedRequests).toEqual([`run:${ID}`]);
    expect((await caller(db).feeds.list())[0]?.feedRequests).toEqual([`run:${ID}`]);
  });

  it('a pause and a resume of one feed replace each other, and the same request twice is one', async () => {
    await machine('laptop');
    const ask = (action: 'pause' | 'resume') => caller(db).feeds.request({ machine: 'laptop', action, id: ID });
    await ask('pause');
    await ask('pause');
    await ask('resume');
    expect((await rows())[0]?.feedRequests).toEqual([`resume:${ID}`]);
  });

  it('refuses an unknown machine, a revoked one and an id that is not a feed id', async () => {
    await machine('laptop');
    await expect(caller(db).feeds.request({ machine: 'nobody', action: 'run', id: ID })).rejects.toThrow(/No machine/);
    await expect(caller(db).feeds.request({ machine: 'laptop', action: 'run', id: 'x' })).rejects.toThrow();
    await caller(db).machines.revoke({ name: 'laptop' });
    await expect(caller(db).feeds.request({ machine: 'laptop', action: 'run', id: ID })).rejects.toThrow(/No machine/);
  });

  it('an ack refuses a request of another shape', async () => {
    const laptop = await machine('laptop');
    expect((await laptop('ack-feed-requests', { body: { requests: ['nonsense'] } })).status).toBe(400);
  });
});

describe('revoking', () => {
  it('clears the feeds and the requests', async () => {
    const laptop = await machine('laptop');
    await laptop('set-feeds', { body: await body('laptop') });
    await caller(db).feeds.request({ machine: 'laptop', action: 'run', id: ID });
    await caller(db).machines.revoke({ name: 'laptop' });
    expect((await rows())[0]).toMatchObject({ feeds: null, feedsIndex: null, feedRequests: [] });
  });

  it('names the feature', async () => {
    const laptop = await machine('laptop');
    expect((await laptop('version')).json.result.features).toContain('machine.feeds');
  });
});
