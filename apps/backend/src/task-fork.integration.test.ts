import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { tasks } from './db/schema';
import { buildServer } from './server';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
import { caller, sessionNamed, testConfig, useTestDb } from './test/helpers';

const { db, admin } = await useTestDb();

const DIR = '/home/me/code/repo';

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

const row = async (id: string) => {
  const [found] = await admin.select().from(tasks).where(eq(tasks.id, id));
  return found!;
};

let sessions = 0;
/** A task on the laptop in DIR that ran once and waits in Needs me with its session. */
async function started(options: { agent?: string; model?: string; priority?: 'high' } = {}): Promise<string> {
  const task = await ctx.ui.tasks.create({
    title: 'parent',
    input: 'go',
    place: { machine: 'laptop', workdir: DIR },
    ...options,
  });
  await ctx.call('claim-task', { id: task.id, machine: 'laptop' });
  await ctx.call('update-task', { id: task.id, body: { sessionId: sessionNamed((sessions += 1)) } });
  await ctx.call('update-task', { id: task.id, body: { status: 'needs-me' } });
  return task.id;
}

const fork = (parentId: string, input = 'look into the flaky test') =>
  ctx.ui.tasks.fork({ parentId, title: 'Fork of parent', input });

describe('forking a task from the UI', () => {
  it('makes a task in Todo that follows the parent and takes its machine, directory, model and priority', async () => {
    const parentId = await started({ model: 'opus', priority: 'high' });
    const before = await row(parentId);
    const forked = await fork(parentId);
    expect(forked).toMatchObject({
      status: 'todo',
      title: 'Fork of parent',
      input: 'look into the flaky test',
      machine: 'laptop',
      workdir: DIR,
      model: 'opus',
      priority: 'high',
      createdBy: 'user',
      forkOf: parentId,
      parentId,
      sessionId: null,
      next: 'fresh',
    });
    const stored = await row(forked.id);
    expect(stored).toMatchObject({ forkOf: parentId, parentId, homeWorkdir: stored.workdir, proposed: false });
    expect(await row(parentId)).toEqual(before);
  });

  it('puts the fork on top of the tasks of its priority in Todo', async () => {
    const parentId = await started();
    const waiting = await ctx.ui.tasks.create({ title: 'waiting', input: 'x' });
    const forked = await fork(parentId);
    const todo = (await ctx.ui.tasks.list()).filter((task) => task.status === 'todo').map((task) => task.id);
    expect(todo).toEqual([forked.id, waiting.id]);
  });

  it('is allowed while the parent runs', async () => {
    const parentId = await started();
    await ctx.call('update-task', { id: parentId, body: { status: 'todo' } });
    await ctx.call('claim-task', { id: parentId, machine: 'laptop' });
    await fork(parentId);
    expect((await row(parentId)).status).toBe('running');
  });

  it('is refused for a fork that has not run yet, which has no session of its own', async () => {
    const forked = await fork(await started());
    await expect(fork(forked.id)).rejects.toThrow(/no Claude session/);
  });

  it('runs a fork as the parent’s agent, which the browser seals for the new task', async () => {
    const parentId = await started({ agent: 'reviewer' });
    const forked = await fork(parentId);
    expect(forked.agent).toBe('reviewer');
    expect((await row(forked.id)).agent).toMatch(/^abe1\./);
  });

  it('shows the link to a machine, and to nobody for a task that is not a fork', async () => {
    const parentId = await started();
    const forked = await fork(parentId);
    expect((await ctx.raw('get-task', { id: forked.id })).json.result.forkOf).toBe(parentId);
    expect((await ctx.raw('get-task', { id: parentId })).json.result).not.toHaveProperty('forkOf');
    expect((await ctx.call('get-task', { id: forked.id })).json.result).toMatchObject({ forkOf: parentId });
  });

  it('keeps the link, and the readable prompt, when the parent is deleted', async () => {
    const parentId = await started();
    const forked = await fork(parentId);
    await admin.delete(tasks).where(eq(tasks.id, parentId));
    expect(await row(forked.id)).toMatchObject({ forkOf: parentId, parentId: null });
    expect((await ctx.ui.tasks.get({ id: forked.id })).task.input).toBe('look into the flaky test');
  });

  it.each([
    [
      'has no session',
      async () =>
        (await ctx.ui.tasks.create({ title: 'p', input: 'x', place: { machine: 'laptop', workdir: DIR } })).id,
      /no Claude session/,
    ],
    [
      'is closed',
      async () => {
        const id = await started();
        await ctx.ui.tasks.setClosed({ id, closed: true });
        return id;
      },
      /closed/,
    ],
    [
      'is an agent’s proposal',
      async () =>
        (
          await ctx.call('add-task', {
            body: { title: 'p', input: 'x', createdBy: 'agent', machine: 'laptop', workdir: DIR },
          })
        ).json.result.task.id,
      /proposed/,
    ],
    ['does not exist', async () => 'nothere', /no task/],
  ])('refuses a parent that %s', async (_name, make, message) => {
    const parentId = await make();
    await expect(fork(parentId)).rejects.toThrow(message);
  });

  it('refuses a parent of the removed intake that names no agent, and forks one that names one', async () => {
    const intake = async (agent?: string) => {
      const { json } = await ctx.call('add-task', {
        body: {
          title: 'p',
          input: 'x',
          createdBy: 'intake',
          machine: 'laptop',
          workdir: DIR,
          ...(agent ? { agent } : {}),
        },
      });
      const id = json.result.task.id;
      await ctx.call('claim-task', { id, machine: 'laptop' });
      await ctx.call('update-task', { id, body: { sessionId: sessionNamed((sessions += 1)) } });
      await ctx.call('update-task', { id, body: { status: 'needs-me' } });
      return id as string;
    };
    await expect(fork(await intake())).rejects.toThrow(/intake/);
    expect(await fork(await intake('reviewer'))).toMatchObject({ agent: 'reviewer' });
  });

  it('refuses a parent of another user', async () => {
    const parentId = await started();
    await expect(plainUi(db, 'other').tasks.fork({ parentId, title: 't', input: 'x' })).rejects.toThrow();
  });

  it('refuses an agent the parent does not have, and no agent where the parent has one', async () => {
    const plain = await started();
    const restricted = await started({ agent: 'reviewer' });
    const model = await fork(restricted);
    const { title, input, workdir } = await row(model.id);
    const { agent } = await row(restricted);
    const send = ctx.ui.raw.tasks.fork;
    await expect(send({ id: 'agentless1', parentId: restricted, title, input, workdir: workdir! })).rejects.toThrow(
      /as the agent/,
    );
    await expect(
      send({ id: 'agentful1', parentId: plain, title, input, workdir: workdir!, agent: agent! }),
    ).rejects.toThrow(/as the agent/);
  });

  it('refuses an id that is taken', async () => {
    const parentId = await started();
    const first = await fork(parentId);
    await expect(ctx.ui.tasks.fork({ id: first.id, parentId, title: 't', input: 'x' })).rejects.toThrow(/taken/);
  });
});

describe('what a machine can do about forks', () => {
  it('cannot name a parent to fork with add-task', async () => {
    const parentId = await started();
    const { status, json } = await ctx.call('add-task', { body: { title: 't', input: 'x', forkOf: parentId } });
    expect(status).toBe(400);
    expect(json.error).toMatch(/forkOf/);
  });
});

describe('the fork link in the sealing of the prompt', () => {
  it('stays readable when the prompt of a fork is edited in Todo', async () => {
    const forked = await fork(await started());
    const edited = await ctx.ui.tasks.edit({
      id: forked.id,
      title: 'New title',
      input: 'new instructions',
      previous: 'old',
    });
    expect(edited).toMatchObject({ input: 'new instructions', forkOf: forked.forkOf });
    expect((await ctx.ui.tasks.get({ id: forked.id })).task.input).toBe('new instructions');
  });

  it('makes a fork unreadable when the server drops the link', async () => {
    const forked = await fork(await started());
    await admin.update(tasks).set({ forkOf: null }).where(eq(tasks.id, forked.id));
    await expect(ctx.ui.tasks.get({ id: forked.id })).rejects.toThrow(/cannot open input/);
  });

  it('makes a fork unreadable when the server points it at another task', async () => {
    const parentId = await started();
    const forked = await fork(parentId);
    await admin
      .update(tasks)
      .set({ forkOf: await started() })
      .where(eq(tasks.id, forked.id));
    await expect(ctx.ui.tasks.get({ id: forked.id })).rejects.toThrow(/cannot open input/);
  });

  it('makes a task that is not a fork unreadable when the server adds a link', async () => {
    const parentId = await started();
    const other = await ctx.ui.tasks.create({ title: 'o', input: 'x' });
    await admin.update(tasks).set({ forkOf: parentId }).where(eq(tasks.id, other.id));
    await expect(ctx.ui.tasks.get({ id: other.id })).rejects.toThrow(/cannot open input/);
  });
});
