import { labelsBinding, newTaskId, openLabels, sealLabels, type RowRef } from '@agent-board/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { schedules, tasks } from './db/schema';
import { buildServer } from './server';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
import { caller, testConfig, useTestDb } from './test/helpers';
import { sealed } from './test/sealed';

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
const taskRef = (id: string, scheduleId: string | null = null): RowRef => ({
  kind: 'task',
  id,
  createdBy: 'user',
  scheduleId,
  forkOf: null,
});
const labelsOf = (row: RowRef, wire: string | null | undefined) => openLabels(sealed.open, row, wire);
const sealedLabels = async (row: RowRef, labels: string[]) => (await sealLabels(sealed.seal, row, labels))!;

describe('the labels of a task', () => {
  it('are stored sealed when the browser creates the task, and set and cleared by configure in any status', async () => {
    const id = newTaskId();
    const labels = await sealedLabels(taskRef(id), ['bug']);
    const created = await ctx.rawUi.tasks.create({
      id,
      title: await sealed.seal({ field: 'title', context: `task:${id}` }, 'a'),
      input: await sealed.seal({ field: 'input', context: `task:${id}:user` }, 'x'),
      labels,
    });
    expect(created?.labels).toBe(labels);
    expect((await taskRow(id)).labels).toBe(labels);
    expect(await labelsOf(taskRef(id), (await ctx.rawUi.tasks.get({ id })).task.labels)).toEqual(['bug']);

    await ctx.call('claim-task', { id, machine: 'laptop' });
    const more = await sealedLabels(taskRef(id), ['bug', 'ui']);
    expect((await ctx.rawUi.tasks.configure({ id, labels: more })).status).toBe('running');
    expect(await labelsOf(taskRef(id), (await taskRow(id)).labels)).toEqual(['bug', 'ui']);
    expect((await ctx.rawUi.tasks.configure({ id, labels: null })).labels).toBeNull();
    expect((await taskRow(id)).labels).toBeNull();
    expect((await ctx.ui.tasks.get({ id })).thread).toEqual([]);
  });

  it('are set and cleared through the machine API, which refuses plain text', async () => {
    const task = await ctx.ui.tasks.create({ title: 'a', input: 'x' });
    const labels = await sealedLabels(taskRef(task.id), ['deps']);
    const set = await ctx.raw('configure-task', { id: task.id, body: { labels } });
    expect(set.status).toBe(200);
    expect(set.json.result.labels).toBe(labels);
    for (const bad of ['["deps"]', ['deps'], `abe1.${'A'.repeat(8000)}`])
      expect((await ctx.raw('configure-task', { id: task.id, body: { labels: bad } })).status, String(bad)).toBe(400);
    expect((await ctx.raw('configure-task', { id: task.id, body: { labels: null } })).json.result.labels).toBeNull();
    const draftId = newTaskId();
    const added = await ctx.raw('add-task', {
      body: {
        id: draftId,
        title: await sealed.seal({ field: 'title', context: `task:${draftId}` }, 'b'),
        input: await sealed.seal({ field: 'input', context: `task:${draftId}:user` }, 'y'),
        labels: await sealedLabels(taskRef(draftId), ['test']),
      },
    });
    expect(await labelsOf(taskRef(draftId), added.json.result.task.labels)).toEqual(['test']);
    await expect(ctx.rawUi.tasks.configure({ id: task.id, labels: '["deps"]' })).rejects.toThrow();
  });
});

describe('the labels of a schedule', () => {
  it('go to every occurrence, which opens them, and an update sets, keeps and clears them on the pending card', async () => {
    const id = newTaskId();
    const schedule: RowRef = { kind: 'schedule', id };
    const labels = await sealedLabels(schedule, ['chore']);
    const pending = await ctx.ui.tasks.create({ id, title: 'sweep', input: '/sweep', when: { every: HOUR } });
    expect(pending.labels ?? null).toBeNull();
    const withLabels = newTaskId();
    const first = await ctx.rawUi.tasks.create({
      id: withLabels,
      title: await sealed.seal({ field: 'title', context: `schedule:${withLabels}` }, 'sweep'),
      input: await sealed.seal({ field: 'input', context: `schedule:${withLabels}:user` }, '/sweep'),
      when: { every: HOUR },
      labels: await sealedLabels({ kind: 'schedule', id: withLabels }, ['chore']),
    });
    expect(first?.scheduleId).toBe(withLabels);
    expect(await labelsOf(taskRef(first!.id, withLabels), first!.labels)).toEqual(['chore']);
    expect(await labelsOf({ kind: 'schedule', id: withLabels }, (await scheduleRow(withLabels)).labels)).toEqual([
      'chore',
    ]);

    const occurrence = pending.id;
    const current = (await ctx.rawUi.schedules.list()).find((row) => row.id === id)!;
    const update = {
      id,
      title: current.title,
      input: current.input,
      place: null,
      priority: current.priority,
      model: null,
      autoDone: false,
      repeat: { everyMs: HOUR },
      runsLeft: null,
      until: null,
      maxConcurrent: null,
    };
    const set = await ctx.rawUi.schedules.update({ ...update, labels });
    expect(set.pending).toBe('updated');
    expect(await labelsOf(schedule, set.schedule.labels)).toEqual(['chore']);
    expect(await labelsOf(taskRef(occurrence, id), (await taskRow(occurrence)).labels)).toEqual(['chore']);
    const kept = await ctx.rawUi.schedules.update({ ...update, priority: 'high' });
    expect(kept.schedule.labels).toBe(labels);
    expect((await taskRow(occurrence)).labels).toBe(labels);
    const cleared = await ctx.rawUi.schedules.update({ ...update, labels: null });
    expect(cleared.schedule.labels).toBeNull();
    expect((await taskRow(occurrence)).labels).toBeNull();
    expect(labelsBinding(taskRef(occurrence, id))).toEqual(labelsBinding(schedule));
  });

  it('come with a schedule the machine API adds, and go to the occurrence after the first one', async () => {
    const id = newTaskId();
    const labels = await sealedLabels({ kind: 'schedule', id }, ['tick']);
    const added = await ctx.raw('add-schedule', {
      body: {
        id,
        title: await sealed.seal({ field: 'title', context: `schedule:${id}` }, 'tick'),
        input: await sealed.seal({ field: 'input', context: `schedule:${id}:user` }, '/tick'),
        everyMs: HOUR,
        labels,
      },
    });
    expect(added.status).toBe(200);
    expect(added.json.result.schedule.labels).toBe(labels);
    const firstId: string = added.json.result.task.id;
    expect(added.json.result.task.labels).toBe(labels);
    await ctx.call('claim-task', { id: firstId, machine: 'laptop' });
    const next = (await scheduleRow(id)).occurrenceTaskId!;
    expect(next).not.toBe(firstId);
    expect(await labelsOf(taskRef(next, id), (await taskRow(next)).labels)).toEqual(['tick']);
  });
});
