import { MAX_SCHEDULE_CRONS, runsLeft } from '@agent-board/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { schedules, tasks } from './db/schema';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
import { buildServer } from './server';
import { caller, testConfig, useTestDb } from './test/helpers';

const { db, admin } = await useTestDb();
const HOUR = 3_600_000;
const crons = { cron: '0 9 * * 5#1', moreCrons: ['0 9 * * 5#3'], timezone: 'UTC' };

async function setup() {
  const app = await buildServer(testConfig, db);
  const { token } = await caller(db).machines.issue({ name: 'laptop' });
  const raw = async (command: string, body: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machine/${command}`,
      headers: { authorization: `Bearer ${token}`, 'x-board-features': 'schedule.after' },
      payload: body,
    });
    return { status: res.statusCode, json: res.json() as MachineAnswer['json'] };
  };
  return { call: plainMachine(raw), ui: plainUi(db) };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

type Create = Parameters<typeof ctx.ui.tasks.create>[0];
async function scheduled(when: Record<string, unknown> = { every: HOUR }, extra: Partial<Create> = {}) {
  const card = await ctx.ui.tasks.create({ title: 'Sweep', input: 'x', when: when as { every: number }, ...extra });
  return { card, scheduleId: card.scheduleId! };
}
const scheduleRow = async (id: string) => (await admin.select().from(schedules).where(eq(schedules.id, id)))[0]!;
const taskRow = async (id: string) => (await admin.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const cardsOf = (scheduleId: string) => admin.select().from(tasks).where(eq(tasks.scheduleId, scheduleId));
const listed = async (id: string) => (await ctx.ui.schedules.list()).find((schedule) => schedule.id === id)!;
/** A schedule that runs after `upstreamId`, made by editing one with a rule of its own, as the browser does. */
async function follower(upstreamId: string, delayMs = 0) {
  const made = await scheduled();
  await ctx.ui.schedules.update({ id: made.scheduleId, repeat: { after: { scheduleId: upstreamId, delayMs } } });
  return made.scheduleId;
}
/** A worker claims the card and hands it back as done work. */
async function finish(id: string) {
  expect((await ctx.call('claim-task', { id, machine: 'laptop' })).status).toBe(200);
  expect((await ctx.call('update-task', { id, body: { status: 'needs-me' } })).status).toBe(200);
}

describe('editing every property of a schedule', () => {
  it('replaces each field, and the pending card takes them, opened under the new agent', async () => {
    const { card, scheduleId } = await scheduled(
      { every: HOUR, times: 5 },
      { agent: 'reviewer', place: { machine: 'laptop', workdir: '/work/a' }, model: 'sonnet' },
    );
    const { schedule, pending } = await ctx.ui.schedules.update({
      id: scheduleId,
      title: 'Nightly',
      input: 'sweep harder',
      agent: 'auditor',
      place: { machine: 'desktop', workdir: '/work/b' },
      priority: 'high',
      model: 'opus',
      autoDone: true,
      maxConcurrent: 2,
      runsLeft: 3,
    });
    expect(pending).toBe('updated');
    expect(schedule).toMatchObject({
      title: 'Nightly',
      input: 'sweep harder',
      agent: 'auditor',
      machine: 'desktop',
      workdir: '/work/b',
      priority: 'high',
      model: 'opus',
      autoDone: true,
      maxConcurrent: 2,
      everyMs: HOUR,
    });
    expect(runsLeft(schedule)).toBe(3);
    expect((await scheduleRow(scheduleId)).remaining).toBe(2);
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({
      title: 'Nightly',
      input: 'sweep harder',
      agent: 'auditor',
      machine: 'desktop',
      workdir: '/work/b',
      priority: 'high',
      model: 'opus',
      autoDone: true,
    });
    const row = await taskRow(card.id);
    expect(row.homeWorkdir).toBe(row.workdir);
  });

  it('clears the agent, the directory, the model, the limit and the run count', async () => {
    const { card, scheduleId } = await scheduled(
      { every: HOUR, times: 4, maxConcurrent: 3 },
      { agent: 'reviewer', place: { machine: 'laptop', workdir: '/work' }, model: 'sonnet', autoDone: true },
    );
    const { schedule } = await ctx.ui.schedules.update({
      id: scheduleId,
      agent: null,
      place: null,
      model: null,
      autoDone: false,
      maxConcurrent: null,
      runsLeft: null,
    });
    expect(schedule).toMatchObject({ machine: null, workdir: null, model: null, autoDone: false, maxConcurrent: null });
    expect(schedule.agent ?? null).toBeNull();
    expect(schedule.remaining).toBeNull();
    const task = (await ctx.ui.tasks.get({ id: card.id })).task;
    expect(task).toMatchObject({ machine: null, workdir: null, model: null, autoDone: false });
    expect(task.agent ?? null).toBeNull();
  });

  it('keeps the end time and the first run when they are sent back unchanged', async () => {
    const until = new Date(Date.now() + 30 * 24 * HOUR);
    const { scheduleId } = await scheduled({ every: HOUR, until });
    const before = await scheduleRow(scheduleId);
    await ctx.ui.schedules.update({ id: scheduleId, title: 'Renamed' });
    const after = await scheduleRow(scheduleId);
    expect(after.until).toEqual(until);
    expect(after.anchorAt).toEqual(before.anchorAt);
  });

  it('counts the pending card in the runs left: with it one less is stored, without it all', async () => {
    const { scheduleId } = await scheduled();
    await ctx.ui.schedules.update({ id: scheduleId, runsLeft: 1 });
    expect(await scheduleRow(scheduleId)).toMatchObject({ remaining: 0 });
    expect(runsLeft(await listed(scheduleId))).toBe(1);
    await ctx.ui.schedules.setPaused({ id: scheduleId, paused: true });
    expect(await scheduleRow(scheduleId)).toMatchObject({ remaining: 1, occurrenceTaskId: null });
    await ctx.ui.schedules.update({ id: scheduleId, runsLeft: 4 });
    expect(await scheduleRow(scheduleId)).toMatchObject({ remaining: 4 });
    expect(runsLeft(await listed(scheduleId))).toBe(4);
  });

  it('refuses a run count together with an end time', async () => {
    const { scheduleId } = await scheduled();
    await expect(
      ctx.ui.schedules.update({ id: scheduleId, runsLeft: 2, until: new Date(Date.now() + HOUR * 5) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses text that is not sealed', async () => {
    const { scheduleId } = await scheduled();
    await expect(
      ctx.ui.raw.schedules.update({
        id: scheduleId,
        title: 'plain',
        input: 'plain',
        place: null,
        priority: 'normal',
        model: null,
        autoDone: false,
        repeat: { everyMs: HOUR },
        runsLeft: null,
        until: null,
        maxConcurrent: null,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses an ended schedule and a schedule that does not exist', async () => {
    const ended = await ctx.ui.tasks.create({ title: 'once', input: 'x', when: { every: HOUR, times: 1 } });
    await ctx.ui.tasks.move({ id: ended.id, status: 'backlog' });
    expect(await listed(ended.scheduleId!)).toMatchObject({ ended: true });
    await expect(
      ctx.ui.schedules.update({ id: ended.scheduleId!, title: 'again', runsLeft: null }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(ctx.ui.schedules.update({ id: 'nothere1', title: 'again' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('the pending card of an edited schedule', () => {
  it('stays as it is when a worker started it, and the schedule changes', async () => {
    const { card, scheduleId } = await scheduled();
    const before = await taskRow(card.id);
    await admin.update(tasks).set({ lastActiveAt: new Date() }).where(eq(tasks.id, card.id));
    const { pending } = await ctx.ui.schedules.update({
      id: scheduleId,
      title: 'Nightly',
      priority: 'low',
      repeat: crons,
    });
    expect(pending).toBe('started');
    const row = await taskRow(card.id);
    expect(row).toMatchObject({ title: before.title, priority: before.priority });
    expect(row.notBefore).toEqual(before.notBefore);
    expect(await scheduleRow(scheduleId)).toMatchObject({ cron: crons.cron, priority: 'low' });
    expect(await cardsOf(scheduleId)).toHaveLength(1);
  });

  it('stays as it is when it was closed', async () => {
    const { card, scheduleId } = await scheduled();
    await admin.update(tasks).set({ closed: true }).where(eq(tasks.id, card.id));
    expect((await ctx.ui.schedules.update({ id: scheduleId, title: 'n' })).pending).toBe('started');
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ title: 'Sweep' });
  });

  it('leaves a card that moved on alone, and the next card takes the edit', async () => {
    const { card, scheduleId } = await scheduled();
    await ctx.ui.tasks.move({ id: card.id, status: 'backlog' });
    const next = (await listed(scheduleId)).occurrenceTaskId!;
    expect(next).not.toBe(card.id);
    await ctx.ui.schedules.update({ id: scheduleId, title: 'Nightly', input: 'new', agent: 'auditor' });
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ title: 'Sweep', input: 'x' });
    expect((await ctx.ui.tasks.get({ id: next })).task).toMatchObject({
      title: 'Nightly',
      input: 'new',
      agent: 'auditor',
    });
    await ctx.ui.tasks.move({ id: next, status: 'backlog' });
    const after = (await listed(scheduleId)).occurrenceTaskId!;
    expect((await ctx.ui.tasks.get({ id: after })).task).toMatchObject({
      title: 'Nightly',
      input: 'new',
      agent: 'auditor',
    });
  });

  it('is not moved by an edit that leaves the rule, the first run and the end alone', async () => {
    const { card, scheduleId } = await scheduled();
    const before = await taskRow(card.id);
    await ctx.ui.schedules.update({ id: scheduleId, title: 'Nightly' });
    expect((await taskRow(card.id)).notBefore).toEqual(before.notBefore);
  });

  it('a paused schedule stays paused, makes no card, and resuming takes the edit', async () => {
    const { scheduleId } = await scheduled();
    await ctx.ui.schedules.setPaused({ id: scheduleId, paused: true });
    const { schedule, pending } = await ctx.ui.schedules.update({ id: scheduleId, repeat: crons, title: 'Nightly' });
    expect(pending).toBe('none');
    expect(schedule).toMatchObject({ paused: true, title: 'Nightly', occurrenceTaskId: null });
    expect(await cardsOf(scheduleId)).toHaveLength(0);
    const resumed = await ctx.ui.schedules.setPaused({ id: scheduleId, paused: false });
    expect(new Date(resumed.nextRunAt!).getUTCHours()).toBe(9);
    expect((await ctx.ui.tasks.get({ id: resumed.occurrenceTaskId! })).task).toMatchObject({ title: 'Nightly' });
  });
});

describe('changing the repeat of a schedule', () => {
  it('turns an interval into cron expressions and moves the pending card to the next match', async () => {
    const { card, scheduleId } = await scheduled();
    const before = await scheduleRow(scheduleId);
    const { schedule, pending } = await ctx.ui.schedules.update({ id: scheduleId, repeat: crons });
    expect(pending).toBe('updated');
    expect(schedule).toMatchObject({ everyMs: null, ...crons, occurrenceTaskId: card.id });
    const row = await scheduleRow(scheduleId);
    expect(row).toMatchObject({ everyMs: null, cron: crons.cron, moreCrons: crons.moreCrons, timezone: 'UTC' });
    expect(row.anchorAt).toEqual(before.anchorAt);
    const moved = (await taskRow(card.id)).notBefore!;
    expect(moved.getTime()).toBeGreaterThan(Date.now());
    expect(row.lastOccurrenceAt).toEqual(moved);
    expect(schedule.nextRunAt).toEqual(moved);
    expect(moved.getUTCHours()).toBe(9);
    expect(moved.getUTCDay()).toBe(5);
  });

  it('turns cron expressions into an interval and clears the cron fields', async () => {
    const { card, scheduleId } = await scheduled({ ...crons });
    const { schedule, pending } = await ctx.ui.schedules.update({ id: scheduleId, repeat: { everyMs: 2 * HOUR } });
    expect(pending).toBe('updated');
    expect(schedule).toMatchObject({ everyMs: 2 * HOUR, cron: null, timezone: null });
    expect(await scheduleRow(scheduleId)).toMatchObject({
      everyMs: 2 * HOUR,
      cron: null,
      moreCrons: [],
      timezone: null,
    });
    const moved = (await taskRow(card.id)).notBefore!.getTime();
    expect(moved).toBeGreaterThanOrEqual(Date.now() - 1000);
    expect(moved).toBeLessThanOrEqual(Date.now() + 2 * HOUR);
  });

  it('keeps one expression without more, replacing the old list', async () => {
    const { scheduleId } = await scheduled({ ...crons });
    await ctx.ui.schedules.update({ id: scheduleId, repeat: { cron: '0 8 * * *', timezone: 'Europe/Berlin' } });
    expect(await scheduleRow(scheduleId)).toMatchObject({
      cron: '0 8 * * *',
      moreCrons: [],
      timezone: 'Europe/Berlin',
    });
  });

  it('sets the first run, which moves the pending card to the first match from there', async () => {
    const { card, scheduleId } = await scheduled();
    const start = new Date(Date.now() + 5 * 24 * HOUR);
    await ctx.ui.schedules.update({ id: scheduleId, at: start });
    expect((await scheduleRow(scheduleId)).anchorAt).toEqual(start);
    expect((await taskRow(card.id)).notBefore).toEqual(start);
  });

  it('moves the pending card when only the end time changes', async () => {
    const { card, scheduleId } = await scheduled();
    const cutoff = new Date(Date.now() + 10 * HOUR);
    await ctx.ui.schedules.update({ id: scheduleId, until: cutoff });
    expect((await scheduleRow(scheduleId)).until).toEqual(cutoff);
    expect((await taskRow(card.id)).notBefore!.getTime()).toBeLessThanOrEqual(cutoff.getTime());
  });

  it('refuses an invalid or repeated cron expression, an unknown time zone and a short interval, and changes nothing', async () => {
    const { scheduleId } = await scheduled();
    const before = await scheduleRow(scheduleId);
    const bad = [
      { cron: '0 9 * *', timezone: 'UTC' },
      { cron: '0 99 * * *', timezone: 'UTC' },
      { cron: '0 9 * * *', moreCrons: ['0  9 * * *'], timezone: 'UTC' },
      { cron: '0 9 * * *', timezone: 'Nowhere/City' },
      { everyMs: 1000 },
    ];
    for (const repeat of bad)
      await expect(ctx.ui.schedules.update({ id: scheduleId, repeat }), JSON.stringify(repeat)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    expect(await scheduleRow(scheduleId)).toEqual(before);
  });

  it(`takes at most ${MAX_SCHEDULE_CRONS} cron expressions`, async () => {
    const { scheduleId } = await scheduled();
    const expressions = Array.from({ length: MAX_SCHEDULE_CRONS + 1 }, (_, hour) => `0 ${hour} * * *`);
    await expect(
      ctx.ui.schedules.update({
        id: scheduleId,
        repeat: { cron: expressions[0]!, moreCrons: expressions.slice(1), timezone: 'UTC' },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const ten = expressions.slice(0, MAX_SCHEDULE_CRONS);
    const { schedule } = await ctx.ui.schedules.update({
      id: scheduleId,
      repeat: { cron: ten[0]!, moreCrons: ten.slice(1), timezone: 'UTC' },
    });
    expect(schedule.moreCrons).toHaveLength(MAX_SCHEDULE_CRONS - 1);
  });

  it('refuses a rule that never runs before the schedule ends, and changes nothing', async () => {
    const until = new Date(Date.now() + 3 * HOUR);
    const { card, scheduleId } = await scheduled({ every: HOUR, until });
    const before = await scheduleRow(scheduleId);
    const pendingBefore = await taskRow(card.id);
    await expect(
      ctx.ui.schedules.update({ id: scheduleId, title: 'n', repeat: { cron: '0 0 29 2 *', timezone: 'UTC' } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('would never run') });
    expect(await scheduleRow(scheduleId)).toEqual(before);
    expect(await taskRow(card.id)).toEqual(pendingBefore);
  });
});

describe('running after another schedule', () => {
  it('removes the never-run pending card when a rule of its own becomes running after another', async () => {
    const { scheduleId: upstream } = await scheduled();
    const { card, scheduleId } = await scheduled({ every: HOUR, times: 3 });
    const { schedule, pending } = await ctx.ui.schedules.update({
      id: scheduleId,
      repeat: { after: { scheduleId: upstream, delayMs: 60_000 } },
    });
    expect(pending).toBe('removed');
    expect(schedule).toMatchObject({
      everyMs: null,
      cron: null,
      after: { scheduleId: upstream, delayMs: 60_000 },
      occurrenceTaskId: null,
      nextRunAt: null,
    });
    expect(await cardsOf(scheduleId)).toHaveLength(0);
    expect(await admin.select().from(tasks).where(eq(tasks.id, card.id))).toHaveLength(0);
    expect(runsLeft(schedule)).toBe(3);
  });

  it('leaves a pending card that started and does not make another', async () => {
    const { scheduleId: upstream } = await scheduled();
    const { card, scheduleId } = await scheduled();
    await admin.update(tasks).set({ lastActiveAt: new Date() }).where(eq(tasks.id, card.id));
    const { pending } = await ctx.ui.schedules.update({
      id: scheduleId,
      repeat: { after: { scheduleId: upstream, delayMs: 0 } },
    });
    expect(pending).toBe('started');
    expect(await cardsOf(scheduleId)).toHaveLength(1);
    expect(await scheduleRow(scheduleId)).toMatchObject({ afterScheduleId: upstream, occurrenceTaskId: card.id });
  });

  it('makes the first card when running after another becomes a rule of its own, from the first run', async () => {
    const { scheduleId: upstream } = await scheduled();
    const id = await follower(upstream);
    expect((await listed(id)).occurrenceTaskId).toBeNull();
    const start = new Date(Date.now() + 2 * 24 * HOUR);
    const { schedule, pending } = await ctx.ui.schedules.update({
      id,
      repeat: { everyMs: HOUR },
      at: start,
      title: 'Own',
    });
    expect(pending).toBe('created');
    expect(schedule).toMatchObject({ after: null, everyMs: HOUR, title: 'Own' });
    expect(schedule.nextRunAt).toEqual(start);
    expect((await ctx.ui.tasks.get({ id: schedule.occurrenceTaskId! })).task).toMatchObject({ title: 'Own' });
    expect(await cardsOf(id)).toHaveLength(1);
  });

  it('makes no card for a paused schedule that gets a rule of its own', async () => {
    const { scheduleId: upstream } = await scheduled();
    const id = await follower(upstream);
    await ctx.ui.schedules.setPaused({ id, paused: true });
    const { pending } = await ctx.ui.schedules.update({ id, repeat: { everyMs: HOUR } });
    expect(pending).toBe('none');
    expect(await cardsOf(id)).toHaveLength(0);
    const resumed = await ctx.ui.schedules.setPaused({ id, paused: false });
    expect(resumed.occurrenceTaskId).not.toBeNull();
  });

  it('moves a delayed pending card to the next run when running after another becomes a rule of its own', async () => {
    const { card: upstreamCard, scheduleId: upstream } = await scheduled();
    const id = await follower(upstream, 2 * HOUR);
    await finish(upstreamCard.id);
    const delayed = (await listed(id)).occurrenceTaskId!;
    expect((await taskRow(delayed)).notBefore!.getTime()).toBeGreaterThan(Date.now() + HOUR);
    const { pending } = await ctx.ui.schedules.update({ id, repeat: { cron: '0 9 * * *', timezone: 'UTC' } });
    expect(pending).toBe('updated');
    expect(await cardsOf(id)).toHaveLength(1);
    const moved = (await taskRow(delayed)).notBefore!;
    expect(moved.getUTCHours()).toBe(9);
  });

  it('changes the upstream schedule and the delay, and leaves an existing pending card alone', async () => {
    const { card: upstreamCard, scheduleId: upstream } = await scheduled();
    const { scheduleId: other } = await scheduled();
    const id = await follower(upstream, 0);
    await finish(upstreamCard.id);
    const cardId = (await listed(id)).occurrenceTaskId!;
    const before = await taskRow(cardId);
    const { schedule, pending } = await ctx.ui.schedules.update({
      id,
      repeat: { after: { scheduleId: other, delayMs: 5 * 60_000 } },
      title: 'Follower',
    });
    expect(pending).toBe('updated');
    expect(schedule).toMatchObject({ after: { scheduleId: other, delayMs: 5 * 60_000 }, occurrenceTaskId: cardId });
    const row = await taskRow(cardId);
    expect(row.notBefore).toEqual(before.notBefore);
    expect((await ctx.ui.tasks.get({ id: cardId })).task).toMatchObject({ title: 'Follower' });
  });

  it('refuses itself, a schedule that does not exist, one that ended, and a circle', async () => {
    const { scheduleId: a } = await scheduled();
    const b = await follower(a);
    const c = await follower(b);
    await expect(
      ctx.ui.schedules.update({ id: a, repeat: { after: { scheduleId: a, delayMs: 0 } } }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      ctx.ui.schedules.update({ id: a, repeat: { after: { scheduleId: 'nothere1', delayMs: 0 } } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      ctx.ui.schedules.update({ id: a, repeat: { after: { scheduleId: b, delayMs: 0 } } }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('circle'),
    });
    await expect(
      ctx.ui.schedules.update({ id: a, repeat: { after: { scheduleId: c, delayMs: 0 } } }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('circle'),
    });
    expect(await scheduleRow(a)).toMatchObject({ afterScheduleId: null, everyMs: HOUR });
    const ended = await ctx.ui.tasks.create({ title: 'once', input: 'x', when: { every: HOUR, times: 1 } });
    await ctx.ui.tasks.move({ id: ended.id, status: 'backlog' });
    await expect(
      ctx.ui.schedules.update({ id: a, repeat: { after: { scheduleId: ended.scheduleId!, delayMs: 0 } } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('ended') });
  });

  it('refuses a delay of more than ten years', async () => {
    const { scheduleId: a } = await scheduled();
    const { scheduleId: b } = await scheduled();
    await expect(
      ctx.ui.schedules.update({ id: b, repeat: { after: { scheduleId: a, delayMs: 11 * 365 * 24 * HOUR } } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
