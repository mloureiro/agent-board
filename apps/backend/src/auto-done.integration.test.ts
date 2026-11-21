import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { schedules, tasks } from './db/schema';
import { buildServer } from './server';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
import { caller, question, sessionNamed, testConfig, useTestDb } from './test/helpers';

const { db, admin } = await useTestDb();

const DIR = '/home/me/code/repo';
const HOUR = 3_600_000;
const NOT_AUTO_DONE = 'This task is not set to finish by itself: move it to needs-me, and the user marks it done.';

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

const threadOf = async (id: string) => (await ctx.ui.tasks.get({ id })).thread.map((note) => note.text);

/** A running task and the run id of its claim. */
async function running(options: { autoDone?: boolean } = {}): Promise<{ id: string; run: string }> {
  const task = await ctx.ui.tasks.create({
    title: 't',
    input: 'go',
    place: { machine: 'laptop', workdir: DIR },
    ...options,
  });
  const claimed = await ctx.call('claim-task', { id: task.id, machine: 'laptop' });
  return { id: task.id, run: claimed.json.result.run as string };
}

describe('the autoDone setting', () => {
  it('is off for a new task, set at creation or later in any status, and cleared again', async () => {
    const plain = await ctx.ui.tasks.create({ title: 'a', input: 'x' });
    expect(plain.autoDone).toBe(false);
    const on = await ctx.ui.tasks.create({ title: 'b', input: 'x', autoDone: true });
    expect(on.autoDone).toBe(true);
    expect((await row(on.id)).autoDone).toBe(true);

    const { id } = await running();
    expect(await ctx.ui.tasks.configure({ id, autoDone: true })).toMatchObject({ autoDone: true, status: 'running' });
    expect(await ctx.ui.tasks.configure({ id, autoDone: false })).toMatchObject({ autoDone: false });
    expect(await threadOf(id)).toEqual([]);
    await expect(ctx.ui.tasks.configure({ id })).rejects.toThrow(/change at least one of/);
  });

  it('is written by a machine through configure-task, and the machine API reads it back', async () => {
    const { id } = await running();
    const set = await ctx.call('configure-task', { id, body: { autoDone: true } });
    expect(set.json.result).toMatchObject({ autoDone: true });
    expect((await ctx.call('get-task', { id })).json.result.autoDone).toBe(true);
    expect((await ctx.call('configure-task', { id, body: { autoDone: 'yes' } })).status).toBe(400);
  });

  it('goes with a task of the machine API at creation, and with a schedule', async () => {
    const added = await ctx.call('add-task', { body: { title: 't', input: 'x', autoDone: true } });
    expect(added.json.result.task.autoDone).toBe(true);
    const schedule = await ctx.call('add-schedule', {
      body: { title: 's', input: 'x', everyMs: HOUR, autoDone: true },
    });
    expect(schedule.json.result.schedule.autoDone).toBe(true);
    expect(schedule.json.result.task.autoDone).toBe(true);
  });

  it('a schedule hands it to each occurrence it makes', async () => {
    const first = await ctx.ui.tasks.create({ title: 's', input: 'x', autoDone: true, when: { every: HOUR } });
    expect(first.autoDone).toBe(true);
    const [stored] = await admin.select().from(schedules).where(eq(schedules.id, first.scheduleId!));
    expect(stored!.autoDone).toBe(true);
    await admin
      .update(tasks)
      .set({ notBefore: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, first.id));
    expect((await ctx.call('claim-task', { id: first.id, machine: 'laptop' })).status).toBe(200);
    const next = (await ctx.ui.tasks.list()).find(
      (task) => task.scheduleId === first.scheduleId && task.id !== first.id,
    );
    expect(next).toMatchObject({ autoDone: true, status: 'todo' });
    const plain = await ctx.ui.tasks.create({ title: 'p', input: 'x', when: { every: HOUR } });
    expect(plain.autoDone).toBe(false);
  });

  it('is not inherited by a fork', async () => {
    const { id } = await running({ autoDone: true });
    await ctx.call('update-task', { id, body: { sessionId: sessionNamed(900) } });
    await ctx.call('update-task', { id, body: { status: 'needs-me' } });
    const forked = await ctx.ui.tasks.fork({ parentId: id, title: 'fork', input: 'look into it' });
    expect(forked.autoDone).toBe(false);
    expect((await row(id)).autoDone).toBe(true);
  });
});

describe('a run moving its task to Done', () => {
  it('is refused with a reason it can act on while the task is not set to auto-done', async () => {
    const { id, run } = await running();
    const refused = await ctx.call('update-task', { id, run, body: { status: 'done' } });
    expect(refused).toMatchObject({ status: 403, json: { error: NOT_AUTO_DONE } });
    expect(await row(id)).toMatchObject({ status: 'running', movedBy: 'machine' });
    expect(await threadOf(id)).toEqual([]);
    expect((await ctx.call('update-task', { id, run, body: { status: 'needs-me' } })).status).toBe(200);
  });

  it('takes effect at once when the user turns the setting off during the run', async () => {
    const { id, run } = await running({ autoDone: true });
    await ctx.ui.tasks.configure({ id, autoDone: false });
    expect((await ctx.call('update-task', { id, run, body: { status: 'done' } })).status).toBe(403);
    await ctx.ui.tasks.configure({ id, autoDone: true });
    expect((await ctx.call('update-task', { id, run, body: { status: 'done' } })).status).toBe(200);
  });

  it('is allowed when the task is set to auto-done: the moved event, the top of Done, movedBy agent', async () => {
    const earlier = await ctx.ui.tasks.create({ title: 'earlier', input: 'x' });
    await ctx.ui.tasks.done({ id: earlier.id });
    const { id, run } = await running({ autoDone: true });
    const done = await ctx.call('update-task', { id, run, body: { status: 'done' } });
    expect(done.json.result).toMatchObject({ status: 'done', movedBy: 'agent', autoDone: true });
    expect(await threadOf(id)).toEqual(['Moved from running to done.']);
    expect((await ctx.ui.tasks.get({ id })).thread[0]).toMatchObject({ author: 'server', kind: 'event' });
    const column = (await ctx.ui.tasks.list()).filter((task) => task.status === 'done').map((task) => task.id);
    expect(column).toEqual([id, earlier.id]);
    expect(await row(id)).toMatchObject({ runId: null, runStartedAt: null });
  });

  it('a pending message sends the task back to Todo instead, and nothing was finished', async () => {
    const { id, run } = await running({ autoDone: true });
    await ctx.call('update-task', { id, run, body: { sessionId: sessionNamed(901) } });
    await ctx.call('run-inbox', { id, run });
    await ctx.ui.tasks.send({ id, message: 'one more thing' });
    const answer = await ctx.call('update-task', { id, run, body: { status: 'done' } });
    expect(answer.json.result).toMatchObject({ status: 'todo', next: 'resume', movedBy: 'agent' });
    const thread = await threadOf(id);
    expect(thread).toContain('Your message reached the agent after its run ended; resuming with it.');
    expect(thread).not.toContain('Moved from running to done.');
  });

  it('a call without a run keeps working as it does today, whatever the setting', async () => {
    const { id } = await running();
    const moved = await ctx.call('update-task', { id, body: { status: 'done' } });
    expect(moved.json.result).toMatchObject({ status: 'done', movedBy: 'machine' });
    expect(await threadOf(id)).toEqual([]);
    const todo = await ctx.ui.tasks.create({ title: 'script', input: 'x' });
    expect(
      (await ctx.call('update-task', { id: todo.id, body: { status: 'done', expect: 'todo' } })).json.result,
    ).toMatchObject({ status: 'done', movedBy: 'machine' });
  });

  it('is refused for a run that no longer holds the task before the setting is looked at', async () => {
    const { id, run } = await running();
    await ctx.call('update-task', { id, run, body: { status: 'needs-me' } });
    expect((await ctx.call('update-task', { id, run, body: { status: 'done' } })).status).toBe(409);
  });
});

describe('who moved a task', () => {
  it('is empty until the first status change', async () => {
    const created = await ctx.ui.tasks.create({ title: 'a', input: 'x' });
    expect(created.movedBy).toBeUndefined();
    expect((await ctx.call('get-task', { id: created.id })).json.result.movedBy).toBeUndefined();
  });

  it('is the user for everything from the browser', async () => {
    const task = await ctx.ui.tasks.create({ title: 'a', input: 'x' });
    expect(await ctx.ui.tasks.move({ id: task.id, status: 'backlog' })).toMatchObject({ movedBy: 'user' });
    expect(await ctx.ui.tasks.done({ id: task.id })).toMatchObject({ status: 'done', movedBy: 'user' });
    expect(await ctx.ui.tasks.rerun({ id: task.id })).toMatchObject({ status: 'todo', movedBy: 'user' });
    const { id } = await running();
    expect(await row(id)).toMatchObject({ movedBy: 'machine' });
    await ctx.call('update-task', { id, body: { sessionId: sessionNamed(902) } });
    await ctx.call('update-task', { id, body: { status: 'needs-me' } });
    expect(await ctx.ui.tasks.reply({ id, message: 'go on', resume: true })).toMatchObject({
      status: 'todo',
      movedBy: 'user',
    });
  });

  it('is the user for a stop, a take back and a wake now', async () => {
    const stopped = await running();
    await ctx.call('update-task', { id: stopped.id, body: { sessionId: sessionNamed(903) } });
    await ctx.call('update-task', { id: stopped.id, body: { status: 'needs-me' } });
    await ctx.ui.tasks.reply({ id: stopped.id, message: 'go', resume: true });
    expect(await ctx.ui.tasks.stop({ id: stopped.id })).toMatchObject({ status: 'needs-me', movedBy: 'user' });

    const quiet = await running();
    await admin
      .update(tasks)
      .set({ lastActiveAt: new Date(Date.now() - 3 * HOUR) })
      .where(eq(tasks.id, quiet.id));
    expect(await ctx.ui.tasks.takeBack({ id: quiet.id })).toMatchObject({ status: 'needs-me', movedBy: 'user' });

    const waiting = await running();
    await ctx.call('wait', {
      id: waiting.id,
      run: waiting.run,
      body: { text: 'CI', wakeAt: new Date(Date.now() + HOUR).toISOString(), check: false },
    });
    expect(await row(waiting.id)).toMatchObject({ status: 'waiting', movedBy: 'agent' });
    expect(await ctx.ui.tasks.wakeNow({ id: waiting.id })).toMatchObject({ status: 'todo', movedBy: 'user' });
  });

  it('is the agent for a move from inside its run, a question and a wait', async () => {
    const moved = await running();
    expect(
      (await ctx.call('update-task', { id: moved.id, run: moved.run, body: { status: 'needs-me' } })).json.result,
    ).toMatchObject({ status: 'needs-me', movedBy: 'agent' });

    const asked = await running();
    await ctx.call('ask', { id: asked.id, run: asked.run, body: { questions: [question] } });
    expect(await row(asked.id)).toMatchObject({ status: 'needs-me', movedBy: 'agent' });

    const waits = await running();
    await ctx.call('wait', {
      id: waits.id,
      run: waits.run,
      body: { text: 'CI', wakeAt: new Date(Date.now() + HOUR).toISOString(), check: true },
    });
    expect(await row(waits.id)).toMatchObject({ status: 'waiting', movedBy: 'agent' });
  });

  it('is the machine for a claim, a wake, a failed run, a pause, a stopped run and a move outside a run', async () => {
    const claimed = await running();
    expect(await row(claimed.id)).toMatchObject({ status: 'running', movedBy: 'machine' });

    const paused = await running();
    await ctx.call('pause', { id: paused.id, run: paused.run, body: 'Paused on laptop.' });
    expect(await row(paused.id)).toMatchObject({ status: 'todo', movedBy: 'machine' });

    const failed = await running();
    await ctx.call('fail', { id: failed.id, run: failed.run, body: 'exit 1' });
    expect(await row(failed.id)).toMatchObject({ status: 'needs-me', movedBy: 'machine' });

    const stopped = await running();
    await ctx.ui.tasks.stop({ id: stopped.id });
    await ctx.call('stopped', { id: stopped.id, run: stopped.run, body: 'Stopped by you.' });
    expect(await row(stopped.id)).toMatchObject({ status: 'needs-me', movedBy: 'machine' });

    const woken = await running();
    await ctx.call('wait', {
      id: woken.id,
      run: woken.run,
      body: { text: 'CI', wakeAt: new Date(Date.now() + HOUR).toISOString(), check: true },
    });
    await ctx.call('wake', { id: woken.id, body: 'check passed' });
    expect(await row(woken.id)).toMatchObject({ status: 'todo', movedBy: 'machine' });

    const scripted = await running();
    await ctx.call('update-task', { id: scripted.id, body: { status: 'needs-me' } });
    expect(await row(scripted.id)).toMatchObject({ status: 'needs-me', movedBy: 'machine' });
    const requeued = await ctx.call('update-task', {
      id: scripted.id,
      body: { status: 'todo', next: 'fresh', expect: 'needs-me' },
    });
    expect(requeued.json.result).toMatchObject({ status: 'todo', movedBy: 'machine' });
  });

  it('is left as it was when the status stays', async () => {
    const task = await ctx.ui.tasks.create({ title: 'a', input: 'x' });
    await ctx.ui.tasks.move({ id: task.id, status: 'backlog' });
    await ctx.ui.tasks.configure({ id: task.id, priority: 'high' });
    expect(await ctx.ui.tasks.configure({ id: task.id, autoDone: true })).toMatchObject({ movedBy: 'user' });
    const { id } = await running();
    await ctx.call('update-task', { id, body: { sessionId: sessionNamed(904) } });
    expect(await row(id)).toMatchObject({ status: 'running', movedBy: 'machine' });
    expect(await ctx.ui.tasks.configure({ id, autoDone: true })).toMatchObject({ movedBy: 'machine' });
  });

  it('a machine reads an unknown task field leniently: the wire carries movedBy only when there is one', async () => {
    const task = await ctx.ui.tasks.create({ title: 'a', input: 'x' });
    const before = (await ctx.raw('get-task', { id: task.id })).json.result;
    expect('movedBy' in before).toBe(false);
  });
});
