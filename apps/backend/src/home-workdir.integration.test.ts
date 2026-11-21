import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { schedules, tasks } from './db/schema';
import { buildServer } from './server';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
import { caller, testConfig, useTestDb } from './test/helpers';

const { db, admin } = await useTestDb();

const HOME = '/home/me/code/thing';
const WORKTREE = '/home/me/code/thing/.claude/worktrees/fix-x';

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
  return { call: plainMachine(raw), ui: plainUi(db) };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

const row = async (id: string) => {
  const [found] = await admin.select().from(tasks).where(eq(tasks.id, id));
  return found!;
};

/** Claims the task as the laptop's worker, rewrites its directory the way a finished run does and parks it in Needs me. */
async function runAndMove(id: string, workdir: string): Promise<void> {
  expect((await ctx.call('claim-task', { id, machine: 'laptop' })).status).toBe(200);
  expect((await ctx.call('update-task', { id, body: { workdir } })).status).toBe(200);
  expect((await ctx.call('update-task', { id, body: { status: 'needs-me' } })).status).toBe(200);
}

describe('the directory a task was created with', () => {
  it('survives the worker rewriting the directory, and Re-run fresh restores it on the same machine', async () => {
    const { json } = await ctx.call('add-task', {
      body: { title: 't', input: 'go', machine: 'laptop', workdir: HOME },
    });
    const id = json.result.task.id;
    const created = await row(id);
    expect(created.homeWorkdir).toBe(created.workdir);
    expect(created.homeWorkdir).not.toContain('/home/me');

    await runAndMove(id, WORKTREE);
    const ran = await row(id);
    expect(ran.workdir).not.toBe(created.workdir);
    expect(ran.homeWorkdir).toBe(created.homeWorkdir);

    const rerun = await ctx.ui.tasks.rerun({ id });
    expect(rerun).toMatchObject({ status: 'todo', next: 'fresh', sessionId: null, machine: 'laptop', workdir: HOME });
    const restored = await row(id);
    expect(restored.workdir).toBe(created.workdir);
    expect(restored.homeWorkdir).toBe(created.homeWorkdir);
  });

  it('a task created without a directory still starts over in the default one', async () => {
    const { json } = await ctx.call('add-task', { body: { title: 't', input: 'go' } });
    const id = json.result.task.id;
    expect((await row(id)).homeWorkdir).toBeNull();
    await runAndMove(id, WORKTREE);
    expect((await row(id)).workdir).not.toBeNull();
    expect(await ctx.ui.tasks.rerun({ id })).toMatchObject({ workdir: null });
    expect((await row(id)).homeWorkdir).toBeNull();
  });

  it('a task from before the migration (a directory, no home) is cleared as it always was', async () => {
    const { json } = await ctx.call('add-task', {
      body: { title: 't', input: 'go', machine: 'laptop', workdir: HOME },
    });
    const id = json.result.task.id;
    await admin.update(tasks).set({ homeWorkdir: null }).where(eq(tasks.id, id));
    expect(await ctx.ui.tasks.rerun({ id })).toMatchObject({ machine: 'laptop', workdir: null });
  });

  it('is never changed by a later update, however often the worker rewrites the directory', async () => {
    const { json } = await ctx.call('add-task', {
      body: { title: 't', input: 'go', machine: 'laptop', workdir: HOME },
    });
    const id = json.result.task.id;
    const { homeWorkdir } = await row(id);
    await runAndMove(id, WORKTREE);
    await ctx.call('update-task', { id, body: { workdir: '/home/me/code/other' } });
    expect((await row(id)).homeWorkdir).toBe(homeWorkdir);
    await ctx.ui.tasks.rerun({ id });
    await runAndMove(id, '/home/me/code/other');
    expect((await row(id)).homeWorkdir).toBe(homeWorkdir);
  });

  it('is refused as plain text by the sealed-column constraint', async () => {
    const { json } = await ctx.call('add-task', { body: { title: 't', input: 'go' } });
    await expect(
      admin.update(tasks).set({ homeWorkdir: HOME }).where(eq(tasks.id, json.result.task.id)),
    ).rejects.toThrow();
  });

  it('an agent’s proposal made in a directory keeps it through the user starting it and a re-run', async () => {
    const { json } = await ctx.call('add-task', {
      body: { title: 'idea', input: 'do Y', createdBy: 'agent', machine: 'laptop', workdir: HOME },
    });
    const id = json.result.task.id;
    const proposed = await row(id);
    expect(proposed.homeWorkdir).toBe(proposed.workdir);

    const started = await ctx.ui.tasks.move({ id, status: 'todo' });
    expect(started).toMatchObject({ proposed: false, createdBy: 'user', workdir: HOME });
    expect((await row(id)).homeWorkdir).toBe(proposed.homeWorkdir);

    await runAndMove(id, WORKTREE);
    expect(await ctx.ui.tasks.rerun({ id })).toMatchObject({ machine: 'laptop', workdir: HOME });
  });

  it('an occurrence of a pinned schedule gets the schedule’s directory as its home', async () => {
    const { json } = await ctx.call('add-schedule', {
      body: { title: 's', input: 'go', machine: 'laptop', workdir: HOME, everyMs: 3_600_000 },
    });
    const occurrence = await row(json.result.task.id);
    const [schedule] = await admin.select().from(schedules);
    expect(occurrence).toMatchObject({ machine: 'laptop', workdir: schedule!.workdir, homeWorkdir: schedule!.workdir });

    await admin.update(tasks).set({ notBefore: null }).where(eq(tasks.id, occurrence.id));
    await runAndMove(occurrence.id, WORKTREE);
    expect((await row(occurrence.id)).homeWorkdir).toBe(schedule!.workdir);
    expect(await ctx.ui.tasks.rerun({ id: occurrence.id })).toMatchObject({ machine: 'laptop', workdir: HOME });
  });
});

describe('a repeating task made in the browser', () => {
  it('pins the schedule and every occurrence to the chosen machine and directory', async () => {
    const task = await ctx.ui.tasks.create({
      input: 'weekly check',
      when: { every: 3_600_000 },
      place: { machine: 'laptop', workdir: HOME },
    });
    expect(task).toMatchObject({ machine: 'laptop', workdir: HOME });
    const [schedule] = await admin.select().from(schedules);
    expect(schedule).toMatchObject({ machine: 'laptop' });
    expect(schedule!.workdir).not.toContain('/home/me');
    expect(await row(task.id)).toMatchObject({ homeWorkdir: schedule!.workdir, workdir: schedule!.workdir });
    const [listed] = await ctx.ui.schedules.list();
    expect(listed).toMatchObject({ machine: 'laptop', workdir: HOME });
  });
});
