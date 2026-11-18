import { agentBinding, inputBinding, sealFields } from '@agent-board/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { schedules, tasks } from './db/schema';
import { buildServer } from './server';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
import { sealerFor } from './test/sealed';
import { caller, testConfig, useTestDb } from './test/helpers';

const { db, admin } = await useTestDb();

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

const taskRow = async (id: string) => {
  const [found] = await admin.select().from(tasks).where(eq(tasks.id, id));
  return found!;
};

describe('the sealed agent of a task', () => {
  it('is stored as an envelope and comes back verbatim, opened by the client', async () => {
    const { status, json } = await ctx.call('add-task', { body: { title: 't', input: 'go', agent: 'reviewer' } });
    expect(status).toBe(200);
    const id = json.result.task.id;
    expect(json.result.task.agent).toBe('reviewer');
    const stored = await taskRow(id);
    expect(stored.agent).toMatch(/^abe1\./);
    expect(stored.agent).not.toContain('reviewer');

    expect((await ctx.call('get-task', { id })).json.result.agent).toBe('reviewer');
    const listed = (await ctx.call('list-tasks', {})).json.result;
    expect(listed.find((task: { id: string }) => task.id === id).agent).toBe('reviewer');
    const wire = (await ctx.raw('get-task', { id })).json.result;
    expect(wire.agent).toBe(stored.agent);
  });

  it('is left out of a task without one, so its wire form is what it was', async () => {
    const { json } = await ctx.call('add-task', { body: { title: 't', input: 'go' } });
    const wire = (await ctx.raw('get-task', { id: json.result.task.id })).json.result;
    expect(wire).not.toHaveProperty('agent');
    expect((await taskRow(json.result.task.id)).agent).toBeNull();
  });

  it('refuses an agent that is not sealed', async () => {
    const fields = await sealFields(
      sealerFor('jascha').seal,
      { kind: 'task', id: 'plain-agent-1', createdBy: 'user', scheduleId: null, forkOf: null },
      { title: 'x', input: 'y' },
    );
    const res = await ctx.raw('add-task', { body: { id: 'plain-agent-1', ...fields, agent: 'reviewer' } });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/agent/);
  });

  it('keeps the agent when the worker rewrites the task and the user starts it over', async () => {
    const { json } = await ctx.call('add-task', { body: { title: 't', input: 'go', agent: 'reviewer' } });
    const id = json.result.task.id;
    expect((await ctx.call('claim-task', { id, machine: 'laptop' })).json.result.agent).toBe('reviewer');
    expect((await ctx.call('update-task', { id, body: { input: 'again' } })).json.result).toMatchObject({
      agent: 'reviewer',
      input: 'again',
    });
    expect((await ctx.call('update-task', { id, body: { status: 'needs-me' } })).status).toBe(200);
    expect(await ctx.ui.tasks.rerun({ id })).toMatchObject({ agent: 'reviewer', status: 'todo' });
  });

  it('is a sealed binding to its task: another task takes none of it, and the prompt does not open without it', async () => {
    const { json } = await ctx.call('add-task', { body: { title: 't', input: 'go', agent: 'reviewer' } });
    const first = json.result.task.id;
    const second = (await ctx.call('add-task', { body: { title: 't', input: 'go' } })).json.result.task.id;
    const stolen = (await taskRow(first)).agent;
    await admin.update(tasks).set({ agent: stolen }).where(eq(tasks.id, second));
    // The server cannot make the second task an agent task, nor drop the first one's agent, without making its prompt unreadable.
    await expect(ctx.call('get-task', { id: second })).rejects.toThrow(/cannot open/);
    await admin.update(tasks).set({ agent: null }).where(eq(tasks.id, first));
    await expect(ctx.call('get-task', { id: first })).rejects.toThrow(/cannot open input/);
    const sealing = sealerFor('jascha');
    const wire = (await ctx.raw('get-task', { id: first })).json.result;
    const row = { kind: 'task', id: first, createdBy: 'user', scheduleId: null, forkOf: null } as const;
    expect(await sealing.open(inputBinding({ ...row, agent: 'reviewer' }), wire.input)).toBe('go');
    expect(await sealing.open(inputBinding(row), wire.input)).toBeUndefined();
    expect(agentBinding(row).context).toBe(`task:${first}`);
  });
});

describe('the sealed agent of a schedule', () => {
  it('is stored on the schedule and copied into each occurrence, which opens it', async () => {
    const { json } = await ctx.call('add-schedule', {
      body: { title: 'Sweep', input: '/sweep', agent: 'sweeper', everyMs: 3_600_000 },
    });
    const { schedule, task } = json.result;
    expect(schedule.agent).toBe('sweeper');
    expect(task.agent).toBe('sweeper');
    const [stored] = await admin.select().from(schedules).where(eq(schedules.id, schedule.id));
    const occurrence = await taskRow(task.id);
    expect(stored!.agent).toMatch(/^abe1\./);
    expect(occurrence.agent).toBe(stored!.agent);
    expect(occurrence.input).toBe(stored!.input);

    // The next occurrence is made when this one is claimed, and carries it too.
    await admin.update(tasks).set({ notBefore: null }).where(eq(tasks.id, task.id));
    expect((await ctx.call('claim-task', { id: task.id, machine: 'laptop' })).status).toBe(200);
    const next = (await ctx.call('list-schedules', {})).json.result[0].occurrenceTaskId;
    expect(next).not.toBe(task.id);
    expect((await ctx.call('get-task', { id: next })).json.result.agent).toBe('sweeper');
  });

  it('is made by the New task form, sealed in the browser, for a repeating task and for a single one', async () => {
    const repeating = await ctx.ui.tasks.create({
      input: '/sweep',
      agent: 'sweeper',
      when: { every: 3_600_000 },
    });
    expect(repeating.agent).toBe('sweeper');
    expect((await ctx.ui.schedules.list())[0]).toMatchObject({ agent: 'sweeper' });
    const single = await ctx.ui.tasks.create({ input: 'go', agent: 'reviewer' });
    expect(single).toMatchObject({ agent: 'reviewer', createdBy: 'user' });
    expect((await ctx.ui.tasks.get({ id: single.id })).task.agent).toBe('reviewer');
    const none = await ctx.ui.tasks.create({ input: 'go' });
    expect(none.agent).toBeUndefined();
  });

  it('a schedule without an agent makes occurrences without one', async () => {
    const { json } = await ctx.call('add-schedule', { body: { title: 'Sweep', input: '/sweep', everyMs: 3_600_000 } });
    expect(json.result.task).not.toHaveProperty('agent');
    expect((await taskRow(json.result.task.id)).agent).toBeNull();
  });
});
