import { openWatches, sealWatches, SEALED_LIMITS, watchesBinding } from '@agent-board/shared';
import type { TaskWatch } from '@agent-board/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { tasks } from './db/schema';
import { buildServer } from './server';
import { Changes } from './services/changes';
import { plainUi } from './test/client';
import type { MachineAnswer } from './test/client';
import { caller, testConfig, useTestDb } from './test/helpers';
import { sealed } from './test/sealed';

const { db, admin } = await useTestDb();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const WATCH_ID = '0123456789abcdef';
const OTHER_ID = 'fedcba9876543210';

const watch = (overrides: Partial<TaskWatch> = {}): TaskWatch => ({
  id: WATCH_ID,
  name: 'ci',
  kind: 'ci',
  label: 'CI #116',
  status: '4 of 7 passed, 3 running',
  deadline: '2026-11-17T14:20:00.000Z',
  lastAttemptAt: '2026-11-17T13:20:00.000Z',
  ...overrides,
});

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

const ui = () => caller(db, 'jascha', changes);
const rowOf = async (id: string) => (await admin.select().from(tasks).where(eq(tasks.id, id)))[0]!;

/** A task claimed by `laptop`, with `desktop` as a machine that does not hold it. */
async function setup() {
  const laptop = await machine('laptop');
  const desktop = await machine('desktop');
  const { id } = await plainUi(db).tasks.create({ title: 't', input: 'i' });
  expect((await laptop('claim-task', { id, machine: 'laptop' })).status).toBe(200);
  const publish = async (watches: TaskWatch[] | null) =>
    laptop('set-watches', {
      id,
      body: { watches: watches === null ? null : await sealWatches(sealed.seal, id, watches, 2) },
    });
  return { laptop, desktop, id, publish };
}

describe('set-watches', () => {
  it('keeps the sealed watches of the task’s machine, serves them sealed, and answers null', async () => {
    const { laptop, id, publish } = await setup();
    const answer = await publish([watch()]);
    expect(answer).toEqual({ status: 200, json: { result: null } });
    const row = await rowOf(id);
    expect(row.watches).toMatch(/^abe1\./);
    expect(row.watches).not.toContain('CI #116');
    const wire = (await laptop('get-task', { id })).json.result;
    expect(wire).toMatchObject({ watches: row.watches, watchStops: [] });
    expect(await openWatches(sealed.open, id, wire.watches)).toEqual({
      watches: [watch()],
      pendingEvents: 2,
      unreadable: false,
    });
    const [listed] = await ui().tasks.list();
    expect(listed).toMatchObject({ watches: row.watches });
  });

  it('clears the watches with null, and a task without any serves null', async () => {
    const { laptop, id, publish } = await setup();
    expect((await laptop('get-task', { id })).json.result).toMatchObject({ watches: null, watchStops: [] });
    await publish([watch()]);
    await publish(null);
    expect((await rowOf(id)).watches).toBeNull();
  });

  it('does not wake the board or touch the task', async () => {
    const { id, publish } = await setup();
    const before = await rowOf(id);
    await sleep(60);
    let woken = 0;
    changes.subscribe('jascha', () => (woken += 1));
    await publish([watch()]);
    await sleep(60);
    expect(woken).toBe(0);
    expect((await rowOf(id)).updatedAt).toEqual(before.updatedAt);
  });

  it('is refused for another machine’s task, a task without a machine and an unknown task', async () => {
    const { desktop, id, publish } = await setup();
    const sent = { id, body: { watches: await sealWatches(sealed.seal, id, [watch()], 0) } };
    expect((await desktop('set-watches', sent)).status).toBe(409);
    const free = await plainUi(db).tasks.create({ title: 't', input: 'i' });
    const freeBody = { watches: await sealWatches(sealed.seal, free.id, [watch()], 0) };
    expect((await desktop('set-watches', { id: free.id, body: freeBody })).status).toBe(409);
    expect((await desktop('set-watches', { id: 'Nope1234', body: freeBody })).status).toBe(404);
    expect((await rowOf(id)).watches).toBeNull();
    expect((await publish([watch()])).status).toBe(200);
  });

  it('is accepted in any status of the task', async () => {
    const { id, publish } = await setup();
    await admin.update(tasks).set({ status: 'waiting' }).where(eq(tasks.id, id));
    expect((await publish([watch()])).status).toBe(200);
  });

  it('refuses plain text, another binding, another key, unknown keys and a value that is too long', async () => {
    const { laptop, id } = await setup();
    const other = await plainUi(db).tasks.create({ title: 't', input: 'i' });
    const ofOther = await sealWatches(sealed.seal, other.id, [watch()], 0);
    expect((await laptop('set-watches', { id, body: { watches: '{"watches":[]}' } })).status).toBe(400);
    expect((await laptop('set-watches', { id, body: {} })).status).toBe(400);
    expect((await laptop('set-watches', { id, body: { watches: 7 } })).status).toBe(400);
    expect((await laptop('set-watches', { id, body: { watches: ofOther, extra: 1 } })).status).toBe(400);
    const huge = `abe1.${'A'.repeat(Math.ceil((SEALED_LIMITS.watches * 4) / 3) + 100)}`;
    expect((await laptop('set-watches', { id, body: { watches: huge } })).json.error).toMatch(/too long/);
    expect((await rowOf(id)).watches).toBeNull();
    // The server cannot tell another task's ciphertext; opening is what binds it.
    await laptop('set-watches', { id, body: { watches: ofOther } });
    const wire = (await laptop('get-task', { id })).json.result;
    expect(await openWatches(sealed.open, id, wire.watches)).toEqual({
      watches: null,
      pendingEvents: 0,
      unreadable: true,
    });
    expect(watchesBinding(id)).toEqual({ field: 'watches', context: `task:${id}:agent` });
  });
});

describe('stopWatch', () => {
  it('adds the id once, answers the task and wakes the machine', async () => {
    const { laptop, id } = await setup();
    await sleep(60);
    let woken = 0;
    changes.subscribe('jascha', () => (woken += 1));
    const stopped = await ui().tasks.stopWatch({ id, watchId: WATCH_ID });
    expect(stopped).toMatchObject({ id, watchStops: [WATCH_ID] });
    await sleep(60);
    expect(woken).toBeGreaterThan(0);
    await ui().tasks.stopWatch({ id, watchId: WATCH_ID });
    const again = await ui().tasks.stopWatch({ id, watchId: OTHER_ID });
    expect(again.watchStops).toEqual([WATCH_ID, OTHER_ID]);
    expect((await laptop('get-task', { id })).json.result.watchStops).toEqual([WATCH_ID, OTHER_ID]);
  });

  it('refuses a bad id, a task without a machine, a done or closed task and an unknown task', async () => {
    const { id } = await setup();
    await expect(ui().tasks.stopWatch({ id, watchId: 'ZZZ' })).rejects.toThrow(/not a watch id/);
    await expect(ui().tasks.stopWatch({ id, watchId: 'ABCDEF0123456789' })).rejects.toThrow(/not a watch id/);
    await expect(ui().tasks.stopWatch({ id: 'Nope1234', watchId: WATCH_ID })).rejects.toThrow(/no task/);
    const free = await plainUi(db).tasks.create({ title: 't', input: 'i' });
    await expect(ui().tasks.stopWatch({ id: free.id, watchId: WATCH_ID })).rejects.toThrow(/no machine/);
    await admin.update(tasks).set({ status: 'done' }).where(eq(tasks.id, id));
    await expect(ui().tasks.stopWatch({ id, watchId: WATCH_ID })).rejects.toThrow(/done or closed/);
    await admin.update(tasks).set({ status: 'waiting', closed: true }).where(eq(tasks.id, id));
    await expect(ui().tasks.stopWatch({ id, watchId: WATCH_ID })).rejects.toThrow(/done or closed/);
    expect((await rowOf(id)).watchStops).toEqual([]);
  });

  it('holds at most 32 stop requests', async () => {
    const { id } = await setup();
    const ids = Array.from({ length: 32 }, (_, n) => n.toString(16).padStart(16, '0'));
    for (const watchId of ids) await ui().tasks.stopWatch({ id, watchId });
    await expect(ui().tasks.stopWatch({ id, watchId: WATCH_ID })).rejects.toThrow(/32 stop requests/);
    expect((await rowOf(id)).watchStops).toEqual(ids);
  });
});

describe('ack-watch-stops', () => {
  it('removes the named ids, keeps the others, and answers null', async () => {
    const { laptop, id } = await setup();
    await ui().tasks.stopWatch({ id, watchId: WATCH_ID });
    await ui().tasks.stopWatch({ id, watchId: OTHER_ID });
    const answer = await laptop('ack-watch-stops', { id, body: { ids: [WATCH_ID, '1111111111111111'] } });
    expect(answer).toEqual({ status: 200, json: { result: null } });
    expect((await rowOf(id)).watchStops).toEqual([OTHER_ID]);
    await laptop('ack-watch-stops', { id, body: { ids: [] } });
    expect((await rowOf(id)).watchStops).toEqual([OTHER_ID]);
  });

  it('is refused for another machine’s task, a bad body and an unknown task', async () => {
    const { laptop, desktop, id } = await setup();
    await ui().tasks.stopWatch({ id, watchId: WATCH_ID });
    expect((await desktop('ack-watch-stops', { id, body: { ids: [WATCH_ID] } })).status).toBe(409);
    for (const body of [
      {},
      { ids: 'x' },
      { ids: ['nope'] },
      { ids: [WATCH_ID], extra: 1 },
      { ids: Array(33).fill(WATCH_ID) },
    ])
      expect((await laptop('ack-watch-stops', { id, body })).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    expect((await laptop('ack-watch-stops', { id: 'Nope1234', body: { ids: [] } })).status).toBe(404);
    expect((await rowOf(id)).watchStops).toEqual([WATCH_ID]);
  });
});

describe('clearing', () => {
  async function held() {
    const context = await setup();
    await context.publish([watch()]);
    await ui().tasks.stopWatch({ id: context.id, watchId: WATCH_ID });
    expect(await rowOf(context.id)).toMatchObject({ watchStops: [WATCH_ID] });
    return context;
  }
  const cleared = async (id: string) => {
    const row = await rowOf(id);
    expect({ watches: row.watches, watchStops: row.watchStops }).toEqual({ watches: null, watchStops: [] });
  };
  /** The task leaves Running the way a wait does: parked, with the machine's watches in place. */
  const park = async (id: string) =>
    admin
      .update(tasks)
      .set({ status: 'waiting', wakeAt: new Date(Date.now() + 60_000) })
      .where(eq(tasks.id, id));

  it('happens when the task is marked Done', async () => {
    const { id } = await held();
    await park(id);
    await ui().tasks.done({ id });
    await cleared(id);
  });

  it('happens when the task goes to Backlog', async () => {
    const { id } = await held();
    await park(id);
    await ui().tasks.move({ id, status: 'backlog' });
    await cleared(id);
  });

  it('happens when the task is closed', async () => {
    const { id } = await held();
    await park(id);
    await ui().tasks.setClosed({ id, closed: true });
    await cleared(id);
  });

  it('happens when the task is re-run fresh', async () => {
    const { id } = await held();
    await park(id);
    await ui().tasks.rerun({ id });
    await cleared(id);
  });

  it('happens when the user stops a wait, which moves the task to Backlog', async () => {
    const { id } = await held();
    await park(id);
    await ui().tasks.stop({ id });
    expect((await rowOf(id)).status).toBe('backlog');
    await cleared(id);
  });

  it('happens when the user moves the task to another machine, which drops its session', async () => {
    const { id } = await held();
    await admin.update(tasks).set({ status: 'needs-me' }).where(eq(tasks.id, id));
    await plainUi(db).tasks.configure({ id, place: { machine: 'desktop', workdir: '/home/me/code/new' } });
    expect(await rowOf(id)).toMatchObject({ machine: 'desktop', sessionId: null });
    await cleared(id);
  });

  it('does not happen when only the priority or model changes', async () => {
    const { id } = await held();
    await admin.update(tasks).set({ status: 'needs-me' }).where(eq(tasks.id, id));
    await plainUi(db).tasks.configure({ id, model: 'opus' });
    expect(await rowOf(id)).toMatchObject({ watchStops: [WATCH_ID] });
    expect((await rowOf(id)).watches).not.toBeNull();
  });

  it('does not happen when the task is woken to resume', async () => {
    const { id } = await held();
    await park(id);
    await ui().tasks.wakeNow({ id });
    expect(await rowOf(id)).toMatchObject({ status: 'todo', watchStops: [WATCH_ID] });
    expect((await rowOf(id)).watches).not.toBeNull();
  });
});
