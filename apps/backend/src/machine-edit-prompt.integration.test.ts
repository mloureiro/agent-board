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
      headers: { authorization: `Bearer ${token}` },
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
