import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { tasks } from './db/schema';
import { buildServer } from './server';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
import { caller, sessionNamed, testConfig, useTestDb } from './test/helpers';

const { db, admin } = await useTestDb();

const OLD = '/home/me/code/old';
const NEW = '/home/me/code/new';
const HOUR = 3_600_000;

async function setup() {
  const app = await buildServer(testConfig, db);
  const ui = plainUi(db);
  const tokens: Record<string, string> = {
    laptop: (await caller(db).machines.issue({ name: 'laptop' })).token,
    workstation: (await caller(db).machines.issue({ name: 'workstation' })).token,
  };
  const rawAs =
    (machine: string) =>
    async (command: string, body: Record<string, unknown> = {}) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/machine/${command}`,
        headers: { authorization: `Bearer ${tokens[machine]}` },
        payload: body,
      });
      return { status: res.statusCode, json: res.json() as MachineAnswer['json'] };
    };
  return {
    ui,
    raw: rawAs('laptop'),
    call: plainMachine(rawAs('laptop')),
    callAs: (machine: string) => plainMachine(rawAs(machine)),
  };
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
/** A task pinned to the laptop and OLD that ran once and waits in Needs me with its session. */
async function started(): Promise<string> {
  const task = await ctx.ui.tasks.create({ title: 't', input: 'go', place: { machine: 'laptop', workdir: OLD } });
  await ctx.call('claim-task', { id: task.id, machine: 'laptop' });
  await ctx.call('update-task', { id: task.id, body: { sessionId: sessionNamed((sessions += 1)) } });
  await ctx.call('update-task', { id: task.id, body: { status: 'needs-me' } });
  return task.id;
}

const threadOf = async (id: string) => (await ctx.ui.tasks.get({ id })).thread.map((note) => note.text);

describe('configuring a task from the UI', () => {
  it('a priority change is setPriority: the bottom of the new band and the one event', async () => {
    await ctx.ui.tasks.create({ title: 'high-1', input: 'x', priority: 'high' });
    const task = await ctx.ui.tasks.create({ title: 'normal', input: 'x' });
    expect(await ctx.ui.tasks.configure({ id: task.id, priority: 'high' })).toMatchObject({ priority: 'high' });
    expect((await ctx.ui.tasks.list()).map((t) => t.title)).toEqual(['high-1', 'normal']);
    expect(await threadOf(task.id)).toEqual(['Priority normal → high.']);
    await ctx.ui.tasks.configure({ id: task.id, priority: 'high' });
    expect(await threadOf(task.id)).toHaveLength(1);
  });

  it('an effort is set and cleared in any status, writes no note, and leaves a run alone', async () => {
    const id = await started();
    expect(await ctx.ui.tasks.configure({ id, effort: 'xhigh' })).toMatchObject({
      effort: 'xhigh',
      status: 'needs-me',
    });
    const running = await ctx.ui.tasks.create({ title: 'r', input: 'x' });
    await ctx.call('claim-task', { id: running.id, machine: 'laptop' });
    expect(await ctx.ui.tasks.configure({ id: running.id, effort: 'low' })).toMatchObject({
      effort: 'low',
      status: 'running',
    });
    expect(await ctx.ui.tasks.configure({ id: running.id, effort: null })).toMatchObject({ effort: null });
    expect(await threadOf(id)).toEqual([]);
    expect(await threadOf(running.id)).toEqual([]);
  });

  it('a model is set and cleared in any status, writes no note, and leaves a run alone', async () => {
    const id = await started();
    expect(await ctx.ui.tasks.configure({ id, model: 'opus' })).toMatchObject({ model: 'opus', status: 'needs-me' });
    const running = await ctx.ui.tasks.create({ title: 'r', input: 'x' });
    await ctx.call('claim-task', { id: running.id, machine: 'laptop' });
    expect(await ctx.ui.tasks.configure({ id: running.id, model: 'sonnet' })).toMatchObject({
      model: 'sonnet',
      status: 'running',
    });
    expect(await ctx.ui.tasks.configure({ id: running.id, model: null })).toMatchObject({ model: null });
    expect(await threadOf(id)).toEqual([]);
    expect(await threadOf(running.id)).toEqual([]);
  });

  it('a title is renamed in any status, writes no note, and leaves a run alone', async () => {
    const id = await started();
    expect(await ctx.ui.tasks.configure({ id, title: 'Renamed' })).toMatchObject({
      title: 'Renamed',
      status: 'needs-me',
    });
    const running = await ctx.ui.tasks.create({ title: 'r', input: 'x' });
    await ctx.call('claim-task', { id: running.id, machine: 'laptop' });
    expect(await ctx.ui.tasks.configure({ id: running.id, title: 'Still running' })).toMatchObject({
      title: 'Still running',
      status: 'running',
      input: 'x',
    });
    expect((await ctx.ui.tasks.get({ id: running.id })).task.title).toBe('Still running');
    expect(await threadOf(id)).toEqual([]);
    expect(await threadOf(running.id)).toEqual([]);
  });

  it('refuses a title for a schedule’s occurrence and writes nothing; its other settings still go through', async () => {
    const occurrence = await ctx.ui.tasks.create({ title: 'sweep', input: '/sweep', when: { every: HOUR } });
    await expect(
      ctx.ui.tasks.configure({ id: occurrence.id, title: 'This sweep', model: 'opus' }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await ctx.ui.tasks.get({ id: occurrence.id })).task).toMatchObject({ title: 'sweep', model: null });
    expect(await ctx.ui.tasks.configure({ id: occurrence.id, model: 'opus' })).toMatchObject({ model: 'opus' });
  });

  it('a new place sets the directory and the home directory, pins the machine, drops the session and keeps the status', async () => {
    const id = await started();
    expect((await row(id)).sessionId).not.toBeNull();
    await ctx.call('update-task', { id, body: { status: 'todo' } });
    const before = await row(id);
    const moved = await ctx.ui.tasks.configure({ id, place: { machine: 'workstation', workdir: NEW } });
    expect(moved).toMatchObject({
      status: 'todo',
      machine: 'workstation',
      workdir: NEW,
      sessionId: null,
      next: 'fresh',
    });
    const after = await row(id);
    expect(after.workdir).not.toBe(before.workdir);
    expect(after.homeWorkdir).toBe(after.workdir);
    expect(after.workdir).not.toContain('/home/me');
    expect(await threadOf(id)).toEqual([]);
  });

  it('a claim planned before a re-pin loses: only the machine the task was moved to wins it', async () => {
    const id = await started();
    await ctx.call('update-task', { id, body: { status: 'todo' } });
    await ctx.ui.tasks.configure({ id, place: { machine: 'workstation', workdir: NEW } });
    const lost = await ctx.call('claim-task', { id, machine: 'laptop' });
    expect(lost.status).toBe(409);
    expect(await row(id)).toMatchObject({ status: 'todo', machine: 'workstation' });
    const won = await ctx.callAs('workstation')('claim-task', { id, machine: 'workstation' });
    expect(won.status).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'running', machine: 'workstation' });
  });

  it('a place drops a pause and a wake with the session, and leaves a question open in Needs me', async () => {
    const id = await started();
    await admin
      .update(tasks)
      .set({ pausedAt: new Date(), wokenAt: new Date(), status: 'todo' })
      .where(eq(tasks.id, id));
    expect(await ctx.ui.tasks.configure({ id, place: { machine: 'laptop', workdir: NEW } })).toMatchObject({
      paused: false,
      woken: false,
      next: 'fresh',
    });
    const { id: asked } = await ctx.ui.tasks.create({
      title: 'q',
      input: 'x',
      place: { machine: 'laptop', workdir: OLD },
    });
    await ctx.call('claim-task', { id: asked, machine: 'laptop' });
    await ctx.call('update-task', { id: asked, body: { sessionId: sessionNamed((sessions += 1)) } });
    await ctx.call('ask', {
      id: asked,
      body: {
        questions: [
          {
            header: 'h',
            question: 'q?',
            multiSelect: false,
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        ],
      },
    });
    expect(await ctx.ui.tasks.configure({ id: asked, place: { machine: 'laptop', workdir: NEW } })).toMatchObject({
      status: 'needs-me',
      openQuestion: true,
      sessionId: null,
    });
  });

  it('place null removes the directory and the pin and drops the session', async () => {
    const id = await started();
    const moved = await ctx.ui.tasks.configure({ id, place: null });
    expect(moved).toMatchObject({ machine: null, workdir: null, sessionId: null, next: 'fresh', status: 'needs-me' });
    const after = await row(id);
    expect([after.workdir, after.homeWorkdir]).toEqual([null, null]);
  });

  it('refuses a new place while the task runs or waits, and writes nothing; the other settings still go through', async () => {
    const running = await ctx.ui.tasks.create({ title: 'r', input: 'x', place: { machine: 'laptop', workdir: OLD } });
    await ctx.call('claim-task', { id: running.id, machine: 'laptop' });
    await ctx.call('update-task', { id: running.id, body: { sessionId: sessionNamed((sessions += 1)) } });
    const before = await row(running.id);
    await expect(
      ctx.ui.tasks.configure({ id: running.id, priority: 'urgent', place: { machine: 'laptop', workdir: NEW } }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('Stop it first') });
    expect(await row(running.id)).toEqual(before);
    expect(await ctx.ui.tasks.configure({ id: running.id, priority: 'urgent' })).toMatchObject({ status: 'running' });

    await ctx.call('wait', {
      id: running.id,
      body: { text: 'CI', wakeAt: new Date(Date.now() + HOUR).toISOString() },
    });
    expect((await row(running.id)).status).toBe('waiting');
    await expect(ctx.ui.tasks.configure({ id: running.id, place: null })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await row(running.id)).sessionId).not.toBeNull();
  });

  it('Re-run fresh afterwards restores the new directory, not the old one', async () => {
    const id = await started();
    await ctx.ui.tasks.configure({ id, place: { machine: 'laptop', workdir: NEW } });
    await ctx.call('claim-task', { id, machine: 'laptop' });
    await ctx.call('update-task', { id, body: { workdir: '/home/me/code/new/.claude/worktrees/x' } });
    await ctx.call('update-task', { id, body: { status: 'needs-me' } });
    expect(await ctx.ui.tasks.rerun({ id })).toMatchObject({ machine: 'laptop', workdir: NEW, sessionId: null });
  });

  it('a schedule’s occurrence takes the new directory under its own binding, and opens', async () => {
    const occurrence = await ctx.ui.tasks.create({
      title: 'sweep',
      input: '/sweep',
      place: { machine: 'laptop', workdir: OLD },
      when: { every: HOUR },
    });
    expect(occurrence.scheduleId).not.toBeNull();
    expect(
      await ctx.ui.tasks.configure({ id: occurrence.id, place: { machine: 'laptop', workdir: NEW } }),
    ).toMatchObject({
      workdir: NEW,
    });
    expect((await ctx.ui.tasks.get({ id: occurrence.id })).task.workdir).toBe(NEW);
  });

  it('wants at least one change, a sealed directory and a safe machine name, and a task that exists', async () => {
    const id = await started();
    const raw = ctx.ui.raw.tasks;
    await expect(raw.configure({ id })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(raw.configure({ id, model: 'not a model' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(raw.configure({ id, effort: 'huge' as 'low' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(raw.configure({ id, title: 'plain title' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(raw.configure({ id, place: { machine: 'laptop', workdir: '/plain/path' } })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(raw.configure({ id, place: { machine: '../x', workdir: 'abe1.AAAA' } })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(ctx.ui.tasks.configure({ id: 'nothere1', priority: 'low' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('configure-task on the machine API', () => {
  it('pins to the machine of the token, whichever machine the task had', async () => {
    const id = await started();
    const answer = await ctx.callAs('workstation')('configure-task', { id, body: { place: { workdir: NEW } } });
    expect(answer.status).toBe(200);
    expect(answer.json.result).toMatchObject({
      machine: 'workstation',
      workdir: NEW,
      sessionId: null,
      next: 'fresh',
      status: 'needs-me',
    });
    const stored = await row(id);
    expect(stored.homeWorkdir).toBe(stored.workdir);
    const back = await ctx.call('configure-task', { id, body: { place: { workdir: OLD } } });
    expect(back.json.result).toMatchObject({ machine: 'laptop', workdir: OLD });
  });

  it('refuses a machine in the body: the token names it', async () => {
    const id = await started();
    const sealed = await ctx.ui.sealing.seal({ field: 'workdir', context: `task:${id}` }, NEW);
    const answer = await ctx.raw('configure-task', {
      id,
      body: { place: { machine: 'workstation', workdir: sealed } },
    });
    expect(answer.status).toBe(400);
    expect((await row(id)).machine).toBe('laptop');
  });

  it('place null clears the pin, and priority and model go through with the one event', async () => {
    const id = await started();
    const answer = await ctx.call('configure-task', { id, body: { priority: 'urgent', model: 'haiku', place: null } });
    expect(answer.json.result).toMatchObject({ priority: 'urgent', model: 'haiku', machine: null, workdir: null });
    expect(await threadOf(id)).toEqual(['Priority normal → urgent.']);
    expect((await ctx.call('configure-task', { id, body: { model: null } })).json.result.model).toBeNull();
    expect((await ctx.call('configure-task', { id, body: { effort: 'max' } })).json.result.effort).toBe('max');
    expect((await ctx.call('configure-task', { id, body: { effort: null } })).json.result.effort).toBeNull();
  });

  it('answers 409 while the task runs or waits, and 404 for an unknown task', async () => {
    const { id } = await ctx.ui.tasks.create({ title: 'r', input: 'x' });
    await ctx.call('claim-task', { id, machine: 'laptop' });
    const running = await ctx.call('configure-task', { id, body: { place: null } });
    expect(running.status).toBe(409);
    expect((await ctx.call('configure-task', { id, body: { model: 'opus' } })).status).toBe(200);
    expect((await ctx.call('configure-task', { id: 'nothere1', body: { model: 'opus' } })).status).toBe(404);
  });

  it('parses the body strictly', async () => {
    const id = await started();
    const sealed = await ctx.ui.sealing.seal({ field: 'workdir', context: `task:${id}` }, NEW);
    const bad: Record<string, unknown>[] = [
      {},
      { priority: 'soon' },
      { model: 'not a model' },
      { model: 5 },
      { effort: 'huge' },
      { effort: 5 },
      { place: { workdir: '/plain/path' } },
      { place: { workdir: 5 } },
      { place: {} },
      { place: 'x' },
      { place: { workdir: sealed, extra: 1 } },
      { extra: 1 },
      { status: 'done' },
    ];
    for (const body of bad)
      expect((await ctx.raw('configure-task', { id, body })).status, JSON.stringify(body)).toBe(400);
    expect((await ctx.raw('configure-task', { id })).status).toBe(400);
    const stored = await row(id);
    expect([stored.machine, stored.priority, stored.model, stored.effort]).toEqual(['laptop', 'normal', null, null]);
  });
});
