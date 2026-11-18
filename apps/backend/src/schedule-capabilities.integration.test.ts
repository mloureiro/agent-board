import { MAX_INTERVAL_MS, sealFields } from '@agent-board/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { schedules, tasks } from './db/schema';
import { buildServer } from './server';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
import { caller, question, testConfig, useTestDb } from './test/helpers';

const { db, admin } = await useTestDb();
const hour = 3_600_000;

async function setup() {
  const app = await buildServer(testConfig, db);
  const { token } = await caller(db).machines.issue({ name: 'laptop' });
  const raw = async (command: string, body: Record<string, unknown>, features?: string) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machine/${command}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(features === undefined ? {} : { 'x-board-features': features }),
      },
      payload: body,
    });
    return { status: res.statusCode, json: res.json() as MachineAnswer['json'] };
  };
  /** Plaintext in and out like the CLI of this build, which announces `schedule.after`; with `features` another client. */
  const call = (features = 'schedule.after') => plainMachine((command, body) => raw(command, body ?? {}, features));
  return { call: call(), as: call };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

const add = (body: Record<string, unknown>) =>
  ctx.call('add-schedule', { body: { title: 'Sweep', input: '/sweep', everyMs: hour, ...body } });
const addAfter = (scheduleId: string, body: Record<string, unknown> = {}) =>
  add({ everyMs: undefined, after: { scheduleId, ...body } });
const claim = (id: string) => ctx.call('claim-task', { id, machine: 'laptop' });
const move = (id: string, status: string) => ctx.call('update-task', { id, body: { status } });
const cardsOf = (scheduleId: string) =>
  admin.select().from(tasks).where(eq(tasks.scheduleId, scheduleId)).orderBy(tasks.createdAt);
const scheduleRow = async (id: string) => (await admin.select().from(schedules).where(eq(schedules.id, id)))[0]!;
const makeDue = (id: string) =>
  admin
    .update(tasks)
    .set({ notBefore: new Date(Date.now() - 1000) })
    .where(eq(tasks.id, id));
const listedSchedules = async (as = ctx.call) => (await as('list-schedules')).json.result as any[];

/** A card of the schedule that is claimed and handed back as done work. */
async function finish(id: string) {
  expect((await claim(id)).status).toBe(200);
  expect((await move(id, 'needs-me')).status).toBe(200);
}

describe('several cron expressions', () => {
  const crons = { everyMs: undefined, cron: '0 9 * * 5#1', moreCrons: ['0 9 * * 5#3'], timezone: 'UTC' };

  it('the next run is the earliest next match over all of them, and the schedule lists them all', async () => {
    const startAt = new Date('2031-01-01T00:00:00Z');
    const { status, json } = await add({ ...crons, startAt: startAt.toISOString() });
    expect(status).toBe(200);
    expect(json.result.task.notBefore).toBe('2031-01-03T09:00:00.000Z');
    expect(json.result.schedule).toMatchObject({ cron: '0 9 * * 5#1', moreCrons: ['0 9 * * 5#3'] });
    const listed = (await listedSchedules())[0];
    expect(listed).toMatchObject({ cron: '0 9 * * 5#1', moreCrons: ['0 9 * * 5#3'] });
    await makeDue(json.result.task.id);
    expect((await claim(json.result.task.id)).status).toBe(200);
    const [, second] = await cardsOf(json.result.schedule.id);
    expect(second?.notBefore?.toISOString()).toBe('2031-01-17T09:00:00.000Z');
  });

  it('a schedule with one expression names no moreCrons', async () => {
    const { json } = await add({ everyMs: undefined, cron: '0 9 * * *', timezone: 'UTC' });
    expect(json.result.schedule).not.toHaveProperty('moreCrons');
  });

  it('refuses a bad, a repeated or an eleventh expression, and moreCrons without cron', async () => {
    const bad = async (body: Record<string, unknown>) => (await add({ ...crons, ...body })).status;
    expect(await bad({ moreCrons: ['every day'] })).toBe(400);
    expect(await bad({ moreCrons: ['0 9 * *'] })).toBe(400);
    expect(await bad({ moreCrons: ['61 * * * *'] })).toBe(400);
    const same = await add({ ...crons, moreCrons: ['0  9 * * 5#1'] });
    expect(same.status).toBe(400);
    expect(same.json.error).toMatch(/twice/);
    expect((await add({ ...crons, moreCrons: ['0 1 * * *', '0 1 * * *'] })).status).toBe(400);
    for (const odd of ['0\t9 * * *', `0 9 * * ${'*'.repeat(120)}`]) {
      const refused = await add({ ...crons, moreCrons: [odd] });
      expect(refused.status).toBe(400);
      expect(refused.json.error).toMatch(/a client can read/);
    }
    const ten = Array.from({ length: 9 }, (_, hour) => `0 ${hour} * * *`);
    expect((await add({ ...crons, moreCrons: ten })).status).toBe(200);
    expect((await add({ ...crons, moreCrons: [...ten, '0 23 * * *'] })).status).toBe(400);
    expect((await add({ moreCrons: ['0 9 * * *'] })).status).toBe(400);
    expect(await admin.select().from(schedules)).toHaveLength(1);
  });

  it('the browser makes one with several expressions too', async () => {
    const ui = plainUi(db);
    const task = await ui.tasks.create({
      input: 'fridays',
      when: { cron: '0 9 * * 5#1', moreCrons: ['0 9 * * 5#3'], timezone: 'UTC' },
    });
    expect((await ui.schedules.list())[0]).toMatchObject({ moreCrons: ['0 9 * * 5#3'], occurrenceTaskId: task.id });
    await expect(
      ui.tasks.create({
        input: 'x',
        when: { cron: '0 9 * * *', moreCrons: Array.from({ length: 10 }, () => '0 9 * * *'), timezone: 'UTC' },
      }),
    ).rejects.toThrow();
  });
});

describe('a limit of cards at once', () => {
  const limited = (limit: number, body: Record<string, unknown> = {}) => add({ maxConcurrent: limit, ...body });

  it('is kept and listed, and refused outside 1 to 100', async () => {
    const { json } = await limited(2);
    expect(json.result.schedule.maxConcurrent).toBe(2);
    expect((await listedSchedules())[0].maxConcurrent).toBe(2);
    expect((await add({})).json.result.schedule.maxConcurrent).toBeNull();
    for (const bad of [0, 101, -1, 1.5, '2', null])
      expect((await limited(bad as number)).status, String(bad)).toBe(400);
  });

  it('refuses a claim while the limit is used up by running cards, and allows it when one leaves', async () => {
    const { json } = await limited(1);
    const first = json.result.task.id;
    expect((await claim(first)).status).toBe(200);
    const second = (await cardsOf(json.result.schedule.id))[1]!;
    await makeDue(second.id);
    expect((await claim(second.id)).status).toBe(409);
    expect((await ctx.call('get-task', { id: second.id })).json.result).toMatchObject({ status: 'todo' });
    expect(await cardsOf(json.result.schedule.id)).toHaveLength(2);
    expect((await move(first, 'needs-me')).status).toBe(200);
    expect((await claim(second.id)).status).toBe(200);
    expect(await cardsOf(json.result.schedule.id)).toHaveLength(3);
  });

  it('counts a waiting card as under way', async () => {
    const { json } = await limited(1);
    const first = json.result.task.id;
    await claim(first);
    await ctx.call('update-task', { id: first, body: { sessionId: '22222222-2222-4222-8222-000000000001' } });
    const wait = await ctx.call('wait', {
      id: first,
      body: { text: 'later', wakeAt: new Date(Date.now() + hour).toISOString(), check: false },
    });
    expect(wait.status).toBe(200);
    expect(wait.json.result.status).toBe('waiting');
    const second = (await cardsOf(json.result.schedule.id))[1]!;
    await makeDue(second.id);
    expect((await claim(second.id)).status).toBe(409);
  });

  it('counts the other cards for a resume too: a card that runs again needs a free slot', async () => {
    const { json } = await limited(1);
    const first = json.result.task.id;
    await claim(first);
    await ctx.call('pause', { id: first, body: 'making room' });
    const second = (await cardsOf(json.result.schedule.id))[1]!;
    await makeDue(second.id);
    expect((await claim(second.id)).status).toBe(200);
    expect((await claim(first)).status).toBe(409);
    await move(second.id, 'needs-me');
    expect((await claim(first)).status).toBe(200);
  });

  it('lets other schedules, and cards of a schedule without a limit, start', async () => {
    const one = (await limited(1)).json.result;
    const other = (await limited(1, { title: 'Other' })).json.result;
    const free = (await add({ title: 'Free' })).json.result;
    expect((await claim(one.task.id)).status).toBe(200);
    expect((await claim(other.task.id)).status).toBe(200);
    expect((await claim(free.task.id)).status).toBe(200);
    const freeNext = (await cardsOf(free.schedule.id))[1]!;
    await makeDue(freeNext.id);
    expect((await claim(freeNext.id)).status).toBe(200);
  });

  it('a claim of a card whose schedule is gone is not held', async () => {
    const { json } = await limited(1);
    const first = json.result.task.id;
    await claim(first);
    await ctx.call('pause', { id: first, body: 'x' });
    const second = (await cardsOf(json.result.schedule.id))[1]!;
    await makeDue(second.id);
    await claim(second.id);
    await ctx.call('remove-schedule', { id: json.result.schedule.id });
    expect((await claim(first)).status).toBe(200);
  });

  it('two claims at once of two cards of a schedule with room for one start one', async () => {
    const { json } = await limited(1);
    const first = json.result.task.id;
    await claim(first);
    await ctx.call('pause', { id: first, body: 'x' });
    const second = (await cardsOf(json.result.schedule.id))[1]!;
    await makeDue(second.id);
    const results = await Promise.all([claim(first), claim(second.id)]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
    const running = (await cardsOf(json.result.schedule.id)).filter(({ status }) => status === 'running');
    expect(running).toHaveLength(1);
  });

  it('marks the cards that wait for a slot as held, in lists and singly, and clears it when a slot is free', async () => {
    const { json } = await limited(1);
    const first = json.result.task.id;
    const second = async () => (await cardsOf(json.result.schedule.id))[1]!;
    expect((await ctx.call('get-task', { id: first })).json.result).not.toHaveProperty('held');
    await claim(first);
    const next = await second();
    const held = (await ctx.call('get-task', { id: next.id })).json.result;
    expect(held).toMatchObject({ status: 'todo', held: true });
    const listed = (await ctx.call('list-tasks')).json.result as { id: string; held?: true }[];
    expect(listed.find(({ id }) => id === next.id)?.held).toBe(true);
    expect(listed.find(({ id }) => id === first)).not.toHaveProperty('held');
    const ui = plainUi(db);
    expect((await ui.tasks.list()).find(({ id }) => id === next.id)?.held).toBe(true);
    expect((await ui.tasks.get({ id: next.id })).task.held).toBe(true);
    await move(first, 'needs-me');
    expect((await ctx.call('get-task', { id: next.id })).json.result).not.toHaveProperty('held');
    expect((await ui.tasks.list()).find(({ id }) => id === next.id)).not.toHaveProperty('held');
  });

  it('a task of a schedule without a limit is never held', async () => {
    const { json } = await add({});
    await claim(json.result.task.id);
    const next = (await cardsOf(json.result.schedule.id))[1]!;
    expect((await ctx.call('get-task', { id: next.id })).json.result).not.toHaveProperty('held');
  });
});

describe('a schedule that runs after another', () => {
  const upstreamOf = async (body: Record<string, unknown> = {}) => (await add(body)).json.result;

  it('is made without a card, and lists what it follows', async () => {
    const upstream = await upstreamOf();
    const { status, json } = await addAfter(upstream.schedule.id, { delayMs: 600_000 });
    expect(status).toBe(200);
    expect(json.result.task).toBeNull();
    expect(json.result.schedule).toMatchObject({
      everyMs: null,
      cron: null,
      timezone: null,
      after: { scheduleId: upstream.schedule.id, delayMs: 600_000 },
      nextRunAt: null,
      occurrenceTaskId: null,
      paused: false,
      ended: false,
    });
    expect(await cardsOf(json.result.schedule.id)).toEqual([]);
    const chained = await addAfter(json.result.schedule.id);
    expect(chained.json.result.schedule.after).toEqual({ scheduleId: json.result.schedule.id, delayMs: 0 });
  });

  it('needs an upstream that exists and has not ended', async () => {
    const missing = await addAfter('nosuchschedule');
    expect(missing.status).toBe(400);
    expect(missing.json.error).toMatch(/no schedule nosuchschedule/);
    const upstream = await upstreamOf({ times: 1 });
    await claim(upstream.task.id);
    expect((await scheduleRow(upstream.schedule.id)).endedAt).not.toBeNull();
    const ended = await addAfter(upstream.schedule.id);
    expect(ended.status).toBe(400);
    expect(ended.json.error).toMatch(/has ended/);
    const paused = await upstreamOf({ title: 'paused' });
    await ctx.call('update-schedule', { id: paused.schedule.id, body: { paused: true } });
    expect((await addAfter(paused.schedule.id)).status).toBe(200);
  });

  it('refuses what the parser or the rule excludes', async () => {
    const upstream = await upstreamOf();
    const after = { scheduleId: upstream.schedule.id };
    const draft = (body: Record<string, unknown>) => add({ everyMs: undefined, ...body });
    expect((await draft({ after, everyMs: hour })).status).toBe(400);
    expect((await draft({ after, cron: '0 9 * * *', timezone: 'UTC' })).status).toBe(400);
    expect((await draft({ after, startAt: new Date().toISOString() })).status).toBe(400);
    expect((await draft({ after, timezone: 'UTC' })).status).toBe(400);
    expect((await draft({ after: { ...after, delayMs: -1 } })).status).toBe(400);
    expect((await draft({ after: { ...after, delayMs: MAX_INTERVAL_MS + 1 } })).status).toBe(400);
    expect((await draft({ after: { scheduleId: '../x' } })).status).toBe(400);
    expect((await draft({ id: 'selfref12345', after: { scheduleId: 'selfref12345' } })).status).toBe(400);
    expect((await draft({ after, delayMs: MAX_INTERVAL_MS })).status).toBe(400);
    expect((await draft({ after: { ...after, delayMs: MAX_INTERVAL_MS } })).status).toBe(200);
    expect((await draft({ after, times: 2, maxConcurrent: 3 })).status).toBe(200);
  });

  it('gets a card when a card of the upstream finishes, starting the delay later', async () => {
    const upstream = await upstreamOf();
    const delayed = (await addAfter(upstream.schedule.id, { delayMs: 600_000 })).json.result;
    const immediate = (await addAfter(upstream.schedule.id, {})).json.result;
    const before = Date.now();
    await finish(upstream.task.id);
    const after = Date.now();
    const [card] = await cardsOf(delayed.schedule.id);
    expect(card).toMatchObject({ status: 'todo', scheduleId: delayed.schedule.id, createdBy: 'user' });
    expect(card!.notBefore!.getTime()).toBeGreaterThanOrEqual(before + 600_000 - 1000);
    expect(card!.notBefore!.getTime()).toBeLessThanOrEqual(after + 600_000);
    const [now] = await cardsOf(immediate.schedule.id);
    expect(now).toMatchObject({ status: 'todo', notBefore: null });
    const listed = (await listedSchedules()).find(({ id }) => id === delayed.schedule.id);
    expect(listed).toMatchObject({ occurrenceTaskId: card!.id, nextRunAt: card!.notBefore!.toISOString() });
  });

  it('a card handed back as Done triggers too', async () => {
    const upstream = await upstreamOf();
    const dependent = (await addAfter(upstream.schedule.id)).json.result;
    await claim(upstream.task.id);
    expect((await move(upstream.task.id, 'done')).status).toBe(200);
    expect(await cardsOf(dependent.schedule.id)).toHaveLength(1);
  });

  it('does not trigger on a question, a failure, a stop, a pause, a wait, or a card moved without running', async () => {
    const upstream = await upstreamOf();
    const dependent = (await addAfter(upstream.schedule.id)).json.result;
    const later = async () => (await cardsOf(upstream.schedule.id)).at(-1)!;
    const none = async () => expect(await cardsOf(dependent.schedule.id)).toEqual([]);
    const first = upstream.task.id;

    await claim(first);
    expect((await ctx.call('ask', { id: first, body: { questions: [question] } })).status).toBe(200);
    await none();
    await plainUi(db).tasks.rerun({ id: first });
    await claim(first);
    expect((await ctx.call('fail', { id: first, body: 'it broke' })).status).toBe(200);
    await none();
    await plainUi(db).tasks.rerun({ id: first });
    await claim(first);
    await ctx.call('pause', { id: first, body: 'room' });
    await none();
    await claim(first);
    expect((await ctx.call('stopped', { id: first, body: 'gone' })).status).toBe(200);
    await none();
    await plainUi(db).tasks.setClosed({ id: (await later()).id, closed: true });
    await none();
  });

  it('triggers once per card: a card that is replied to and finishes again does not make another', async () => {
    const upstream = await upstreamOf();
    const dependent = (await addAfter(upstream.schedule.id)).json.result;
    await finish(upstream.task.id);
    const [card] = await cardsOf(dependent.schedule.id);
    expect(card).toBeDefined();
    expect((await claim(card!.id)).status).toBe(200);
    expect((await scheduleRow(dependent.schedule.id)).occurrenceTaskId).toBeNull();
    await plainUi(db).tasks.rerun({ id: upstream.task.id });
    await finish(upstream.task.id);
    expect(await cardsOf(dependent.schedule.id)).toHaveLength(1);
    expect(
      (await admin.select().from(tasks).where(eq(tasks.id, upstream.task.id)))[0]?.occurrenceFinishedAt,
    ).not.toBeNull();
  });

  it('leaves a dependent that already has a pending card alone: one card, never a pile', async () => {
    const upstream = await upstreamOf();
    const dependent = (await addAfter(upstream.schedule.id, { delayMs: hour })).json.result;
    await finish(upstream.task.id);
    const second = (await cardsOf(upstream.schedule.id))[1]!;
    await makeDue(second.id);
    await finish(second.id);
    expect(await cardsOf(dependent.schedule.id)).toHaveLength(1);
  });

  it('makes no card for a paused or an ended dependent, and none when it resumes', async () => {
    const upstream = await upstreamOf();
    const paused = (await addAfter(upstream.schedule.id)).json.result;
    const ended = (await addAfter(upstream.schedule.id, {})).json.result;
    await ctx.call('update-schedule', { id: paused.schedule.id, body: { paused: true } });
    await admin.update(schedules).set({ endedAt: new Date() }).where(eq(schedules.id, ended.schedule.id));
    await finish(upstream.task.id);
    expect(await cardsOf(paused.schedule.id)).toEqual([]);
    expect(await cardsOf(ended.schedule.id)).toEqual([]);
    const resumed = await ctx.call('update-schedule', { id: paused.schedule.id, body: { paused: false } });
    expect(resumed.json.result).toMatchObject({ paused: false, occurrenceTaskId: null, nextRunAt: null });
    expect(await cardsOf(paused.schedule.id)).toEqual([]);
  });

  it('counts the runs it made, ends when they are used up, and makes nothing when its card is claimed', async () => {
    const upstream = await upstreamOf();
    const twice = (await add({ everyMs: undefined, after: { scheduleId: upstream.schedule.id }, times: 2 })).json
      .result;
    let upstreamCard = upstream.task.id;
    for (const round of [1, 2, 3]) {
      await finish(upstreamCard);
      const cards = await cardsOf(twice.schedule.id);
      expect(cards, `after finish ${round}`).toHaveLength(Math.min(round, 2));
      const pending = cards.at(-1)!;
      if (pending.status === 'todo') {
        expect((await claim(pending.id)).status).toBe(200);
        expect(await cardsOf(twice.schedule.id)).toHaveLength(Math.min(round, 2));
      }
      upstreamCard = (await cardsOf(upstream.schedule.id)).at(-1)!.id;
      await makeDue(upstreamCard);
    }
    expect(await scheduleRow(twice.schedule.id)).toMatchObject({ remaining: 0, occurrenceTaskId: null });
    expect((await scheduleRow(twice.schedule.id)).endedAt).not.toBeNull();
  });

  it('ends instead of making a card that would start after until', async () => {
    const upstream = await upstreamOf();
    const dependent = (
      await add({
        everyMs: undefined,
        after: { scheduleId: upstream.schedule.id, delayMs: 2 * hour },
        until: new Date(Date.now() + hour).toISOString(),
      })
    ).json.result;
    await finish(upstream.task.id);
    expect(await cardsOf(dependent.schedule.id)).toEqual([]);
    expect((await scheduleRow(dependent.schedule.id)).endedAt).not.toBeNull();
  });

  it('runs on after a chain: the dependent of a dependent follows when its card finishes', async () => {
    const first = await upstreamOf();
    const second = (await addAfter(first.schedule.id)).json.result;
    const third = (await addAfter(second.schedule.id)).json.result;
    await finish(first.task.id);
    const [secondCard] = await cardsOf(second.schedule.id);
    expect(await cardsOf(third.schedule.id)).toEqual([]);
    await finish(secondCard!.id);
    expect(await cardsOf(third.schedule.id)).toHaveLength(1);
  });

  it('a card of a limited dependent waits for a slot like any other', async () => {
    const upstream = await upstreamOf();
    const dependent = (await add({ everyMs: undefined, after: { scheduleId: upstream.schedule.id }, maxConcurrent: 1 }))
      .json.result;
    await finish(upstream.task.id);
    const [card] = await cardsOf(dependent.schedule.id);
    expect((await claim(card!.id)).status).toBe(200);
    const next = (await cardsOf(upstream.schedule.id))[1]!;
    await makeDue(next.id);
    await finish(next.id);
    const [, second] = await cardsOf(dependent.schedule.id);
    expect((await ctx.call('get-task', { id: second!.id })).json.result).toMatchObject({ held: true });
    expect((await claim(second!.id)).status).toBe(409);
  });

  it('refuses to delete a schedule that others run after, naming them, until they are gone', async () => {
    const upstream = await upstreamOf();
    const dependent = (await addAfter(upstream.schedule.id)).json.result;
    const refused = await ctx.call('remove-schedule', { id: upstream.schedule.id });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toContain(dependent.schedule.id);
    expect(refused.json.error).toMatch(/delete those first/);
    expect(await scheduleRow(upstream.schedule.id)).toBeDefined();
    await admin.update(schedules).set({ endedAt: new Date() }).where(eq(schedules.id, upstream.schedule.id));
    expect((await ctx.call('remove-schedule', { id: upstream.schedule.id })).status).toBe(409);
    expect((await ctx.call('remove-schedule', { id: dependent.schedule.id })).status).toBe(200);
    expect((await ctx.call('remove-schedule', { id: upstream.schedule.id })).status).toBe(200);
  });

  it('a card still under way when its upstream ended still triggers, once', async () => {
    const upstream = await upstreamOf({ times: 1 });
    const dependent = (await addAfter(upstream.schedule.id)).json.result;
    await claim(upstream.task.id);
    expect((await scheduleRow(upstream.schedule.id)).endedAt).not.toBeNull();
    await move(upstream.task.id, 'needs-me');
    expect(await cardsOf(dependent.schedule.id)).toHaveLength(1);
    const [card] = await cardsOf(dependent.schedule.id);
    await claim(card!.id);
    await plainUi(db).tasks.rerun({ id: upstream.task.id });
    await finish(upstream.task.id);
    expect(await cardsOf(dependent.schedule.id)).toHaveLength(1);
  });

  describe('for a client that did not announce schedule.after', () => {
    it('is left out of the list, and a single one is refused with 422', async () => {
      const upstream = await upstreamOf();
      const dependent = (await addAfter(upstream.schedule.id)).json.result;
      const old = ctx.as('');
      expect((await listedSchedules(old)).map(({ id }) => id)).toEqual([upstream.schedule.id]);
      expect((await listedSchedules()).map(({ id }) => id).sort()).toEqual(
        [upstream.schedule.id, dependent.schedule.id].sort(),
      );
      const refused = await old('update-schedule', { id: dependent.schedule.id, body: { paused: true } });
      expect(refused).toMatchObject({
        status: 422,
        json: { error: 'this schedule runs after another schedule, which this CLI does not know; update the CLI' },
      });
      expect((await scheduleRow(dependent.schedule.id)).pausedAt).toBeNull();
      expect((await old('update-schedule', { id: upstream.schedule.id, body: { paused: true } })).status).toBe(200);
    });

    it('still reads the cards it made as ordinary tasks', async () => {
      const upstream = await upstreamOf();
      const dependent = (await addAfter(upstream.schedule.id)).json.result;
      await finish(upstream.task.id);
      const [card] = await cardsOf(dependent.schedule.id);
      expect((await ctx.as('')('get-task', { id: card!.id })).status).toBe(200);
    });
  });

  it('the browser lists it, pauses it and creates one', async () => {
    const ui = plainUi(db);
    const upstream = await ui.tasks.create({ input: 'build', when: { every: hour } });
    const [upstreamSchedule] = await ui.schedules.list();
    const after = { scheduleId: upstreamSchedule!.id, delayMs: 60_000 };
    const id = 'browserafter1';
    const sealed = await sealFields(
      ui.sealing.seal,
      { kind: 'schedule', id, agent: null },
      { title: 'Deploy', input: '/deploy', workdir: undefined },
    );
    const created = await ui.raw.tasks.create({
      id,
      title: sealed.title,
      input: sealed.input,
      when: { after, times: 3 },
    });
    expect(created).toBeNull();
    const listed = (await ui.schedules.list()).find((schedule) => schedule.id === id);
    expect(listed).toMatchObject({ after, remaining: 3, occurrenceTaskId: null, nextRunAt: null });
    expect(await ui.schedules.setPaused({ id, paused: true })).toMatchObject({ paused: true });
    await expect(ui.schedules.remove({ id: upstreamSchedule!.id })).rejects.toThrow(/delete those first/);
    expect(upstream.scheduleId).toBe(upstreamSchedule!.id);
  });
});

describe('the features of the server', () => {
  it('names the schedule capabilities and the held mark', async () => {
    const { json } = await ctx.call('version');
    expect(json.result.features).toEqual(
      expect.arrayContaining(['schedule.crons', 'schedule.max-concurrent', 'schedule.after', 'task.held']),
    );
  });
});
