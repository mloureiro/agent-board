import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { tasks } from './db/schema';
import { buildServer } from './server';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
import { caller, testConfig, useTestDb } from './test/helpers';

const { db, admin } = await useTestDb();
const HOUR = 3_600_000;

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
  return { raw, call: plainMachine(raw), ui: plainUi(db) };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

const editPrompt = (id: string, title = 'New title', input = 'New prompt', previous = 'Prompt before editing') =>
  ctx.call('edit-prompt', { id, body: { title, input, previous } });
const editSchedule = (id: string, title = 'Nightly', input = 'new') =>
  ctx.call('edit-schedule', { id, body: { title, input } });
const row = async (id: string) => (await admin.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const threadOf = async (id: string) => (await ctx.ui.tasks.get({ id })).thread.map((note) => note.text);
const claim = (id: string) => ctx.call('claim-task', { id, machine: 'laptop' });

describe('edit-prompt', () => {
  it.each(['now', 'backlog'] as const)(
    'takes a new title and prompt in %s and keeps the old text in a note of the user’s',
    async (when) => {
      const task = await ctx.ui.tasks.create({ title: 'Old title', input: 'Old prompt', when });
      const before = await row(task.id);
      const { status, json } = await editPrompt(task.id, 'New title', 'New prompt', 'Prompt before editing\n\nOld');
      expect(status).toBe(200);
      expect(json.result).toMatchObject({
        id: task.id,
        title: 'New title',
        input: 'New prompt',
        status: before.status,
      });
      const { thread } = await ctx.ui.tasks.get({ id: task.id });
      expect(thread.map((note) => note.text)).toEqual(['Prompt before editing\n\nOld']);
      expect(thread[0]).toMatchObject({ author: 'user', kind: 'event' });
    },
  );

  it('seals under the agent of a task that has one, and the task still opens', async () => {
    const task = await ctx.ui.tasks.create({ title: 't', input: 'one', agent: 'reviewer', when: 'backlog' });
    const { json } = await editPrompt(task.id);
    expect(json.result).toMatchObject({ input: 'New prompt', agent: 'reviewer' });
    expect((await ctx.ui.tasks.get({ id: task.id })).task).toMatchObject({ input: 'New prompt', agent: 'reviewer' });
  });

  it('refuses text that is not sealed, writing nothing', async () => {
    const task = await ctx.ui.tasks.create({ title: 't', input: 'x', when: 'backlog' });
    await editPrompt(task.id);
    const { thread } = await ctx.ui.raw.tasks.get({ id: task.id });
    const sealed = { title: (await row(task.id)).title, input: (await row(task.id)).input, previous: thread[0]! };
    const body = { title: sealed.title, input: sealed.input, previous: { body: sealed.previous.body } };
    expect((await ctx.raw('edit-prompt', { id: task.id, body })).status).toBe(200);
    for (const bad of [{ title: 'plain' }, { input: 'plain' }, { previous: { body: 'plain' } }]) {
      const answer = await ctx.raw('edit-prompt', { id: task.id, body: { ...body, ...bad } });
      expect(answer.status).toBe(400);
    }
    expect((await ctx.raw('edit-prompt', { id: task.id, body: { ...body, extra: 1 } })).status).toBe(400);
    expect((await ctx.raw('edit-prompt', { id: task.id, body: { ...body, previous: undefined } })).status).toBe(400);
    expect(await threadOf(task.id)).toHaveLength(2);
  });

  it('refuses a proposal and a task an agent created', async () => {
    const proposal = (await ctx.call('add-task', { body: { title: 'idea', input: 'do Y', createdBy: 'agent' } })).json
      .result.task;
    expect((await editPrompt(proposal.id)).status).toBe(403);
    const mine = await ctx.ui.tasks.create({ title: 't', input: 'x', when: 'backlog' });
    await admin.update(tasks).set({ createdBy: 'agent' }).where(eq(tasks.id, mine.id));
    expect((await editPrompt(mine.id)).status).toBe(403);
    expect((await row(mine.id)).input).not.toBe('New prompt');
  });

  it('refuses a task a worker claimed, even when it went back to Todo, and one in Needs me or Done', async () => {
    const claimed = await ctx.ui.tasks.create({ title: 't', input: 'x' });
    await claim(claimed.id);
    await ctx.call('update-task', { id: claimed.id, body: { status: 'todo' } });
    const answer = await editPrompt(claimed.id);
    expect(answer.status).toBe(409);
    expect(answer.json.error).toContain('has started');
    const hold = await ctx.ui.tasks.create({ title: 't', input: 'x', when: 'hold' });
    expect((await editPrompt(hold.id)).status).toBe(409);
    const done = await ctx.ui.tasks.create({ title: 't', input: 'x', when: 'backlog' });
    await ctx.ui.tasks.done({ id: done.id });
    expect((await editPrompt(done.id)).status).toBe(409);
    expect(await threadOf(claimed.id)).toEqual([]);
  });

  it('refuses a closed task and the card of a schedule, which takes its prompt from the schedule', async () => {
    const closed = await ctx.ui.tasks.create({ title: 't', input: 'x', when: 'backlog' });
    await ctx.ui.tasks.setClosed({ id: closed.id, closed: true });
    expect((await editPrompt(closed.id)).status).toBe(409);
    const card = await ctx.ui.tasks.create({ title: 'Sweep', input: 'old', when: { every: HOUR } });
    const answer = await editPrompt(card.id);
    expect(answer.status).toBe(409);
    expect(answer.json.error).toContain('Schedules page');
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ title: 'Sweep', input: 'old' });
    expect(await threadOf(card.id)).toEqual([]);
  });

  it('says not found for a task that does not exist', async () => {
    await ctx.ui.tasks.create({ title: 't', input: 'x' });
    const [other] = await admin.select().from(tasks);
    const body = { title: other!.title, input: other!.input, previous: { body: other!.input } };
    expect((await ctx.raw('edit-prompt', { id: 'nothere1', body })).status).toBe(404);
  });
});

describe('edit-schedule', () => {
  async function scheduled(title = 'Sweep', input = 'old') {
    const card = await ctx.ui.tasks.create({ title, input, when: { every: HOUR } });
    return { card, scheduleId: card.scheduleId! };
  }

  it('changes the schedule and its pending card, which opens under the schedule’s binding', async () => {
    const { card, scheduleId } = await scheduled();
    const { status, json } = await editSchedule(scheduleId);
    expect(status).toBe(200);
    expect(json.result.pending).toBe('updated');
    expect(json.result.schedule).toMatchObject({ id: scheduleId, title: 'Nightly', input: 'new' });
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ title: 'Nightly', input: 'new' });
  });

  it('seals under the schedule’s agent', async () => {
    const card = await ctx.ui.tasks.create({ title: 's', input: 'old', agent: 'reviewer', when: { every: HOUR } });
    const { json } = await editSchedule(card.scheduleId!);
    expect(json.result.schedule).toMatchObject({ input: 'new', agent: 'reviewer' });
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ input: 'new', agent: 'reviewer' });
  });

  it('leaves a pending card that started alone and changes only the schedule', async () => {
    const { card, scheduleId } = await scheduled();
    await admin.update(tasks).set({ lastActiveAt: new Date() }).where(eq(tasks.id, card.id));
    expect((await editSchedule(scheduleId)).json.result.pending).toBe('started');
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ title: 'Sweep', input: 'old' });
    expect((await ctx.ui.schedules.list())[0]).toMatchObject({ title: 'Nightly', input: 'new' });
  });

  it('says there is no pending card for a paused schedule', async () => {
    const { scheduleId } = await scheduled();
    await ctx.ui.schedules.setPaused({ id: scheduleId, paused: true });
    const { json } = await editSchedule(scheduleId);
    expect(json.result.pending).toBe('none');
    expect(json.result.schedule).toMatchObject({ paused: true, input: 'new' });
  });

  it('refuses an ended schedule, an unknown one and text that is not sealed', async () => {
    const { scheduleId } = await scheduled();
    const { title, input } = (await admin.select().from(tasks))[0]!;
    expect((await ctx.raw('edit-schedule', { id: 'nothere1', body: { title, input } })).status).toBe(404);
    for (const body of [{ title: 'plain', input: 'plain' }, { title: 'a' }, { title: 'a', input: 'b', extra: 1 }])
      expect((await ctx.raw('edit-schedule', { id: scheduleId, body })).status).toBe(400);
    const ended = await ctx.ui.tasks.create({ title: 'once', input: 'x', when: { every: HOUR, times: 1 } });
    await ctx.ui.tasks.move({ id: ended.id, status: 'backlog' });
    expect((await editSchedule(ended.scheduleId!)).status).toBe(409);
  });
});

describe('edit-schedule with settings', () => {
  const settings = (overrides: Record<string, unknown> = {}) => ({
    place: null,
    priority: 'normal',
    model: null,
    autoDone: false,
    repeat: { everyMs: HOUR },
    runsLeft: null,
    until: null,
    maxConcurrent: null,
    ...overrides,
  });
  const update = (id: string, overrides: Record<string, unknown> = {}, title = 'Nightly', input = 'new') =>
    ctx.call('edit-schedule', { id, body: { title, input, settings: settings(overrides) } });
  async function scheduled() {
    const card = await ctx.ui.tasks.create({ title: 'Sweep', input: 'old', when: { every: HOUR } });
    return { card, scheduleId: card.scheduleId! };
  }

  it('replaces every setting of the schedule and its pending card, sealed together under the new agent', async () => {
    const { card, scheduleId } = await scheduled();
    const { status, json } = await update(scheduleId, {
      agent: 'reviewer',
      place: { machine: 'laptop', workdir: '/home/me/repo' },
      priority: 'high',
      model: 'opus',
      autoDone: true,
      repeat: { cron: '0 9 * * 1-5', moreCrons: ['0 17 * * 1-5'], timezone: 'Europe/Berlin' },
      runsLeft: 5,
      maxConcurrent: 2,
    });
    expect(status).toBe(200);
    expect(json.result.pending).toBe('updated');
    expect(json.result.schedule).toMatchObject({
      title: 'Nightly',
      input: 'new',
      agent: 'reviewer',
      machine: 'laptop',
      workdir: '/home/me/repo',
      priority: 'high',
      model: 'opus',
      autoDone: true,
      everyMs: null,
      cron: '0 9 * * 1-5',
      moreCrons: ['0 17 * * 1-5'],
      timezone: 'Europe/Berlin',
      remaining: 4,
      maxConcurrent: 2,
    });
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({
      title: 'Nightly',
      input: 'new',
      agent: 'reviewer',
      workdir: '/home/me/repo',
      priority: 'high',
      model: 'opus',
      autoDone: true,
    });
  });

  it('sets the lane of the schedule and its pending card, and keeps it when the settings leave the lane out', async () => {
    const { card, scheduleId } = await scheduled();
    const set = await update(scheduleId, { lane: 'review' });
    expect(set.json.result.schedule).toMatchObject({ requestedLane: 'review' });
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ requestedLane: 'review' });
    const kept = await update(scheduleId, { priority: 'high' });
    expect(kept.json.result.schedule).toMatchObject({ requestedLane: 'review' });
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ requestedLane: 'review' });
    const cleared = await update(scheduleId, { lane: null });
    expect(cleared.json.result.schedule).toMatchObject({ requestedLane: null });
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ requestedLane: null });
    expect((await update(scheduleId, { lane: 'a b' })).status).toBe(400);
  });

  it('clears what the settings leave out: the agent, the directory, the limit and the end', async () => {
    const { scheduleId } = await scheduled();
    await update(scheduleId, {
      agent: 'reviewer',
      place: { machine: 'laptop', workdir: '/home/me/repo' },
      maxConcurrent: 3,
      until: new Date(Date.now() + 5 * HOUR).toISOString(),
    });
    const { json } = await update(scheduleId);
    expect(json.result.schedule.agent ?? null).toBeNull();
    expect(json.result.schedule).toMatchObject({
      machine: null,
      workdir: null,
      maxConcurrent: null,
      until: null,
      remaining: null,
    });
  });

  it('takes the first run from `at` and ends after `until`', async () => {
    const { scheduleId } = await scheduled();
    const at = new Date(Date.now() + 3 * HOUR);
    const { json } = await update(scheduleId, { at: at.toISOString() });
    expect(new Date(json.result.schedule.anchorAt).getTime()).toBe(at.getTime());
    expect(new Date(json.result.schedule.nextRunAt).getTime()).toBe(at.getTime());
  });

  it('removes the pending card for a schedule that now runs after another, and makes one when it no longer does', async () => {
    const { scheduleId } = await scheduled();
    const upstream = (await ctx.ui.tasks.create({ title: 'Build', input: 'b', when: { every: HOUR } })).scheduleId!;
    const toAfter = await update(scheduleId, { repeat: { after: { scheduleId: upstream, delayMs: 600_000 } } });
    expect(toAfter.status).toBe(200);
    expect(toAfter.json.result.pending).toBe('removed');
    expect(toAfter.json.result.schedule).toMatchObject({ after: { scheduleId: upstream, delayMs: 600_000 } });
    expect(toAfter.json.result.schedule.everyMs).toBeNull();
    const back = await update(scheduleId, { repeat: { everyMs: 2 * HOUR } });
    expect(back.json.result.pending).toBe('created');
    expect(back.json.result.schedule).toMatchObject({ everyMs: 2 * HOUR, after: null });
  });

  it('leaves a pending card that started alone', async () => {
    const { card, scheduleId } = await scheduled();
    await admin.update(tasks).set({ lastActiveAt: new Date() }).where(eq(tasks.id, card.id));
    expect((await update(scheduleId, { priority: 'high' })).json.result.pending).toBe('started');
    expect((await ctx.ui.tasks.get({ id: card.id })).task).toMatchObject({ title: 'Sweep', priority: 'normal' });
    expect((await ctx.ui.schedules.list())[0]).toMatchObject({ title: 'Nightly', priority: 'high' });
  });

  it('refuses an ended schedule with 409 and an unknown one with 404', async () => {
    const ended = await ctx.ui.tasks.create({ title: 'once', input: 'x', when: { every: HOUR, times: 1 } });
    await ctx.ui.tasks.move({ id: ended.id, status: 'backlog' });
    expect((await update(ended.scheduleId!)).status).toBe(409);
    const { title, input } = (await admin.select().from(tasks))[0]!;
    const body = { title, input, settings: settings() };
    expect((await ctx.raw('edit-schedule', { id: 'nothere1', body })).status).toBe(404);
  });

  it('refuses a body the parser or the rules do not take, and writes nothing', async () => {
    const { scheduleId } = await scheduled();
    const other = (await ctx.ui.tasks.create({ title: 'o', input: 'o', when: { every: HOUR } })).scheduleId!;
    const refused: Record<string, unknown>[] = [
      { extra: 1 },
      { place: { machine: 'bad name', workdir: undefined } },
      { priority: 'bogus' },
      { model: 'not a model!' },
      { autoDone: 'yes' },
      { repeat: { everyMs: HOUR, cron: '0 9 * * *', timezone: 'UTC' } },
      { repeat: { everyMs: 1000 } },
      { repeat: { everyMs: 11 * 365 * 24 * HOUR } },
      { repeat: { cron: '0 9 * * *' } },
      { repeat: { cron: 'not cron', timezone: 'UTC' } },
      { repeat: { cron: '0 9 * * *', timezone: 'Nowhere/Land' } },
      { repeat: { cron: '0 9 * * *', timezone: 'UTC', extra: 1 } },
      { repeat: { after: { scheduleId: other } } },
      { repeat: { after: { scheduleId: other, delayMs: -1 } } },
      { repeat: { after: { scheduleId, delayMs: 0 } } },
      { repeat: { after: { scheduleId: other, delayMs: 0 } }, at: new Date().toISOString() },
      { at: 'yesterday-ish' },
      { runsLeft: 0 },
      { runsLeft: 2_147_483_648 },
      { until: 'soon' },
      { runsLeft: 3, until: new Date(Date.now() + 5 * HOUR).toISOString() },
      { maxConcurrent: 0 },
      { maxConcurrent: 101 },
    ];
    for (const overrides of refused) {
      const { status } = await update(scheduleId, overrides);
      expect(status, JSON.stringify(overrides)).toBe(400);
    }
    expect((await ctx.ui.schedules.list()).find((found) => found.id === scheduleId)).toMatchObject({
      title: 'Sweep',
      input: 'old',
    });
  });

  it('refuses settings that are not an object, and a body with settings but no sealed text', async () => {
    const { scheduleId } = await scheduled();
    const { title, input } = (await admin.select().from(tasks))[0]!;
    expect((await ctx.raw('edit-schedule', { id: scheduleId, body: { title, input, settings: 'x' } })).status).toBe(
      400,
    );
    expect((await ctx.raw('edit-schedule', { id: scheduleId, body: { title, input, settings: null } })).status).toBe(
      400,
    );
    expect((await ctx.raw('edit-schedule', { id: scheduleId, body: { settings: settings() } })).status).toBe(400);
  });

  it('refuses an agent and a directory that are not sealed', async () => {
    const { scheduleId } = await scheduled();
    const { title, input } = (await admin.select().from(tasks))[0]!;
    for (const overrides of [{ agent: 'plain-agent' }, { place: { machine: 'laptop', workdir: '/plain' } }])
      expect(
        (await ctx.raw('edit-schedule', { id: scheduleId, body: { title, input, settings: settings(overrides) } }))
          .status,
      ).toBe(400);
  });
});
