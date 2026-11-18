import { iconBinding, newTaskId, openIcon, sealIcon, type RowRef } from '@agent-board/shared';
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
const iconOf = (row: RowRef, wire: string | null | undefined) => openIcon(sealed.open, row, wire);

describe('the icon of a task', () => {
  it('is stored sealed when the browser creates the task, and set and cleared by configure in any status', async () => {
    const id = newTaskId();
    const icon = await sealIcon(sealed.seal, taskRef(id), '🚀');
    const created = await ctx.rawUi.tasks.create({
      id,
      title: await sealed.seal({ field: 'title', context: `task:${id}` }, 'a'),
      input: await sealed.seal({ field: 'input', context: `task:${id}:user` }, 'x'),
      icon,
    });
    expect(created?.icon).toBe(icon);
    expect((await taskRow(id)).icon).toBe(icon);
    expect(await iconOf(taskRef(id), (await ctx.rawUi.tasks.get({ id })).task.icon)).toBe('🚀');

    await ctx.call('claim-task', { id, machine: 'laptop' });
    const bug = await sealIcon(sealed.seal, taskRef(id), '🐛');
    expect((await ctx.rawUi.tasks.configure({ id, icon: bug })).status).toBe('running');
    expect(await iconOf(taskRef(id), (await taskRow(id)).icon)).toBe('🐛');
    expect((await ctx.rawUi.tasks.configure({ id, icon: null })).icon).toBeNull();
    expect((await taskRow(id)).icon).toBeNull();
    expect((await ctx.ui.tasks.get({ id })).thread).toEqual([]);
  });

  it('is set and cleared through the machine API, which refuses plain text', async () => {
    const task = await ctx.ui.tasks.create({ title: 'a', input: 'x' });
    const icon = await sealIcon(sealed.seal, taskRef(task.id), '📦');
    const set = await ctx.raw('configure-task', { id: task.id, body: { icon } });
    expect(set.status).toBe(200);
    expect(set.json.result.icon).toBe(icon);
    for (const bad of ['📦', 5, `abe1.${'A'.repeat(400)}`])
      expect((await ctx.raw('configure-task', { id: task.id, body: { icon: bad } })).status, String(bad)).toBe(400);
    expect((await ctx.raw('configure-task', { id: task.id, body: { icon: null } })).json.result.icon).toBeNull();
    const draftId = newTaskId();
    const added = await ctx.raw('add-task', {
      body: {
        id: draftId,
        title: await sealed.seal({ field: 'title', context: `task:${draftId}` }, 'b'),
        input: await sealed.seal({ field: 'input', context: `task:${draftId}:user` }, 'y'),
        icon: await sealIcon(sealed.seal, taskRef(draftId), '🧪'),
      },
    });
    expect(await iconOf(taskRef(draftId), added.json.result.task.icon)).toBe('🧪');
    await expect(ctx.rawUi.tasks.configure({ id: task.id, icon: '📦' })).rejects.toThrow();
  });
});

describe('the icon of a schedule', () => {
  it('goes to every occurrence, which opens it, and an update sets, keeps and clears it on the pending card', async () => {
    const id = newTaskId();
    const schedule: RowRef = { kind: 'schedule', id };
    const icon = await sealIcon(sealed.seal, schedule, '🧹');
    const pending = await ctx.ui.tasks.create({ id, title: 'sweep', input: '/sweep', when: { every: HOUR } });
    expect(pending.icon).toBeNull();
    const withIcon = newTaskId();
    const first = await ctx.rawUi.tasks.create({
      id: withIcon,
      title: await sealed.seal({ field: 'title', context: `schedule:${withIcon}` }, 'sweep'),
      input: await sealed.seal({ field: 'input', context: `schedule:${withIcon}:user` }, '/sweep'),
      when: { every: HOUR },
      icon: await sealIcon(sealed.seal, { kind: 'schedule', id: withIcon }, '🧹'),
    });
    expect(first?.scheduleId).toBe(withIcon);
    expect(await iconOf(taskRef(first!.id, withIcon), first!.icon)).toBe('🧹');
    expect(await iconOf({ kind: 'schedule', id: withIcon }, (await scheduleRow(withIcon)).icon)).toBe('🧹');

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
    const set = await ctx.rawUi.schedules.update({ ...update, icon });
    expect(set.pending).toBe('updated');
    expect(await iconOf(schedule, set.schedule.icon)).toBe('🧹');
    expect(await iconOf(taskRef(occurrence, id), (await taskRow(occurrence)).icon)).toBe('🧹');
    const kept = await ctx.rawUi.schedules.update({ ...update, priority: 'high' });
    expect(kept.schedule.icon).toBe(icon);
    expect((await taskRow(occurrence)).icon).toBe(icon);
    const cleared = await ctx.rawUi.schedules.update({ ...update, icon: null });
    expect(cleared.schedule.icon).toBeNull();
    expect((await taskRow(occurrence)).icon).toBeNull();
    expect(iconBinding(taskRef(occurrence, id))).toEqual(iconBinding(schedule));
  });

  it('comes with a schedule the machine API adds, and goes to the occurrence after the first one', async () => {
    const id = newTaskId();
    const icon = await sealIcon(sealed.seal, { kind: 'schedule', id }, '⏰');
    const added = await ctx.raw('add-schedule', {
      body: {
        id,
        title: await sealed.seal({ field: 'title', context: `schedule:${id}` }, 'tick'),
        input: await sealed.seal({ field: 'input', context: `schedule:${id}:user` }, '/tick'),
        everyMs: HOUR,
        icon,
      },
    });
    expect(added.status).toBe(200);
    expect(added.json.result.schedule.icon).toBe(icon);
    const firstId: string = added.json.result.task.id;
    expect(added.json.result.task.icon).toBe(icon);
    await ctx.call('claim-task', { id: firstId, machine: 'laptop' });
    const next = (await scheduleRow(id)).occurrenceTaskId!;
    expect(next).not.toBe(firstId);
    expect(await iconOf(taskRef(next, id), (await taskRow(next)).icon)).toBe('⏰');
  });
});
