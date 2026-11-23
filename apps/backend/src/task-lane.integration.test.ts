import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { schedules, tasks } from './db/schema';
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
  return { call: plainMachine(raw), raw, ui: plainUi(db), rawUi: caller(db) };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

const taskRow = async (id: string) => (await admin.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const scheduleRow = async (id: string) => (await admin.select().from(schedules).where(eq(schedules.id, id)))[0]!;

describe('the lane of a task', () => {
  it('is none by default, and is stored in clear when the user names one', async () => {
    const plain = await ctx.ui.tasks.create({ title: 'a', input: 'x' });
    expect(plain).toMatchObject({ requestedLane: null, lane: null });
    const asked = await ctx.ui.tasks.create({ title: 'b', input: 'x', lane: 'reviews' });
    expect(asked).toMatchObject({ requestedLane: 'reviews', lane: null });
    expect((await taskRow(asked.id)).requestedLane).toBe('reviews');
    expect((await ctx.ui.tasks.list()).find((task) => task.id === asked.id)).toMatchObject({
      requestedLane: 'reviews',
    });
  });

  it('is refused when it is not a lane name, from the browser and from a machine', async () => {
    for (const lane of ['not a lane', 'x'.repeat(65), '-x', '']) {
      await expect(ctx.ui.tasks.create({ title: 'a', input: 'x', lane })).rejects.toThrow();
      await expect(ctx.rawUi.tasks.configure({ id: 'task0001', lane })).rejects.toThrow();
    }
    const fine = await ctx.ui.tasks.create({ title: 'a', input: 'x' });
    await expect(ctx.ui.tasks.configure({ id: fine.id, lane: 'a b' })).rejects.toThrow();
    const draft = { title: 'abe1.x', input: 'abe1.x', createdBy: 'agent' as const, lane: 'a b' };
    expect((await ctx.raw('add-task', { body: { id: 'newtask1', ...draft } })).status).toBe(400);
    expect((await ctx.raw('configure-task', { id: fine.id, body: { lane: 'a;b' } })).status).toBe(400);
    expect((await taskRow(fine.id)).requestedLane).toBeNull();
  });

  it('is set and cleared by configure while the task waits, with no note', async () => {
    const task = await ctx.ui.tasks.create({ title: 'a', input: 'x' });
    expect(await ctx.ui.tasks.configure({ id: task.id, lane: 'reviews' })).toMatchObject({ requestedLane: 'reviews' });
    expect(await ctx.ui.tasks.configure({ id: task.id, lane: null })).toMatchObject({ requestedLane: null });
    expect((await ctx.ui.tasks.get({ id: task.id })).thread).toEqual([]);
  });

  it('cannot be changed while the task runs: it keeps the lane it started in until its next start', async () => {
    const task = await ctx.ui.tasks.create({ title: 'a', input: 'x', lane: 'reviews' });
    expect((await ctx.call('claim-task', { id: task.id, machine: 'laptop' })).status).toBe(200);
    expect((await ctx.call('heartbeat', { id: task.id, body: { lane: 'reviews', borrowed: false } })).status).toBe(200);
    await expect(ctx.ui.tasks.configure({ id: task.id, lane: 'docs' })).rejects.toThrow(/running/);
    await expect(ctx.ui.tasks.configure({ id: task.id, lane: null })).rejects.toThrow(/running/);
    expect(await taskRow(task.id)).toMatchObject({ requestedLane: 'reviews', status: 'running' });
    expect(await ctx.ui.tasks.get({ id: task.id })).toMatchObject({
      task: { requestedLane: 'reviews', lane: 'reviews' },
    });
    expect(await ctx.ui.tasks.configure({ id: task.id, model: 'opus' })).toMatchObject({ model: 'opus' });
    await ctx.call('update-task', { id: task.id, body: { status: 'needs-me' } });
    await ctx.call('update-task', { id: task.id, body: { status: 'todo' } });
    expect(await ctx.ui.tasks.configure({ id: task.id, lane: 'docs' })).toMatchObject({ requestedLane: 'docs' });
  });

  it('is set by a machine’s add-task, and a task an agent adds inside a run does not inherit the parent’s', async () => {
    const parent = await ctx.ui.tasks.create({ title: 'parent', input: 'x', lane: 'reviews' });
    await ctx.call('claim-task', { id: parent.id, machine: 'laptop' });
    const proposed = await ctx.call('add-task', {
      body: { title: 'child', input: 'follow up', createdBy: 'agent', parentId: parent.id },
    });
    expect(proposed.json.result.task).toMatchObject({ requestedLane: null });
    const named = await ctx.call('add-task', {
      body: { title: 'child 2', input: 'follow up', createdBy: 'agent', parentId: parent.id, lane: 'docs' },
    });
    expect(named.json.result.task).toMatchObject({ requestedLane: 'docs' });
    const listed = await ctx.call('list-tasks', {});
    expect(listed.json.result.find((task: { id: string }) => task.id === parent.id)).toMatchObject({
      requestedLane: 'reviews',
    });
  });

  it('is kept by a re-run', async () => {
    const task = await ctx.ui.tasks.create({ title: 'a', input: 'x', lane: 'reviews' });
    await ctx.call('claim-task', { id: task.id, machine: 'laptop' });
    await ctx.call('update-task', { id: task.id, body: { status: 'needs-me' } });
    expect(await ctx.ui.tasks.rerun({ id: task.id })).toMatchObject({ requestedLane: 'reviews' });
  });
});

describe('the lane of a schedule', () => {
  it('goes to every occurrence, and is edited with the schedule and its pending card', async () => {
    const card = await ctx.ui.tasks.create({ title: 'Sweep', input: 'x', when: { every: HOUR }, lane: 'reviews' });
    const scheduleId = card.scheduleId!;
    expect(card).toMatchObject({ requestedLane: 'reviews' });
    expect((await scheduleRow(scheduleId)).requestedLane).toBe('reviews');
    expect((await ctx.ui.schedules.list())[0]).toMatchObject({ requestedLane: 'reviews' });

    const { pending } = await ctx.ui.schedules.update({ id: scheduleId, lane: 'docs' });
    expect(pending).toBe('updated');
    expect((await scheduleRow(scheduleId)).requestedLane).toBe('docs');
    expect((await taskRow(card.id)).requestedLane).toBe('docs');

    await ctx.ui.schedules.update({ id: scheduleId, priority: 'high' });
    expect((await scheduleRow(scheduleId)).requestedLane).toBe('docs');

    await ctx.call('claim-task', { id: card.id, machine: 'laptop' });
    await ctx.call('update-task', { id: card.id, body: { status: 'needs-me' } });
    const next = (await admin.select().from(tasks).where(eq(tasks.scheduleId, scheduleId))).find(
      (row) => row.id !== card.id,
    )!;
    expect(next.requestedLane).toBe('docs');

    await ctx.ui.schedules.update({ id: scheduleId, lane: null });
    expect((await scheduleRow(scheduleId)).requestedLane).toBeNull();
    expect((await taskRow(next.id)).requestedLane).toBeNull();
  });

  it('is refused when it is not a lane name, and is taken from a machine’s add-schedule', async () => {
    await expect(
      ctx.ui.tasks.create({ title: 'a', input: 'x', when: { every: HOUR }, lane: 'bad lane' }),
    ).rejects.toThrow();
    const made = await ctx.call('add-schedule', {
      body: { title: 'S', input: 'x', everyMs: HOUR, lane: 'reviews', machine: 'laptop', workdir: '/work' },
    });
    expect(made.json.error).toBeUndefined();
    expect(made.json.result.schedule).toMatchObject({ requestedLane: 'reviews' });
    expect(made.json.result.task).toMatchObject({ requestedLane: 'reviews' });
    const bad = await ctx.call('add-schedule', { body: { title: 'S', input: 'x', everyMs: HOUR, lane: 'a b' } });
    expect(bad.status).toBe(400);
  });
});
