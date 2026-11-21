import { serializePolish } from '@agent-board/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { notes, tasks } from './db/schema';
import { buildServer } from './server';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
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
  return { call: plainMachine(raw), raw, ui: plainUi(db) };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

/** A backlog task of the user's and its polish child, with the agent's polished prompt posted on the child. */
async function polished(options: { when?: 'backlog' | 'hold' | 'now' } = {}) {
  const { ui, call } = ctx;
  const target = await ui.tasks.create({
    title: 'rough idea',
    input: 'fix thing, maybe the export?? slow',
    priority: 'high',
    when: options.when ?? 'backlog',
  });
  const polish = await ui.tasks.create({
    title: 'Polish prompt: rough idea',
    input: `Polish the prompt of board task ${target.id}.`,
    priority: 'high',
    parentId: target.id,
  });
  const rewrite = { target: target.id, title: 'Speed up the export', prompt: 'Find out why the export is slow.' };
  const posted = await call('add-note', {
    id: polish.id,
    kind: 'polish',
    body: serializePolish(rewrite),
  });
  expect(posted.status).toBe(200);
  return { target, polish, rewrite };
}

const apply = (
  target: { id: string },
  polish: { id: string },
  rewrite: { title: string; prompt: string },
  previous = 'Prompt before polishing',
) =>
  ctx.ui.tasks.applyPolish({
    id: target.id,
    polishId: polish.id,
    title: rewrite.title,
    input: rewrite.prompt,
    previous,
  });

describe('creating a task under a parent', () => {
  it('links the child to its parent and keeps the priority it was given', async () => {
    const { target, polish } = await polished();
    expect(polish).toMatchObject({ parentId: target.id, priority: 'high', status: 'todo', createdBy: 'user' });
    expect((await ctx.ui.tasks.get({ id: target.id })).followUps.map((t) => t.id)).toEqual([polish.id]);
  });

  it('runs on the machine and in the directory it was given, which stays sealed', async () => {
    const polish = await ctx.ui.tasks.create({
      title: 'p',
      input: 'q',
      place: { machine: 'deskwork', workdir: '/home/me/code/thing' },
    });
    expect(polish).toMatchObject({ machine: 'deskwork', workdir: '/home/me/code/thing' });
    const [row] = await admin.select().from(tasks).where(eq(tasks.id, polish.id));
    expect(row?.workdir).not.toContain('/home/me');
  });

  it('refuses a machine name of the wrong shape', async () => {
    const workdir = '/home/me/code/thing';
    await expect(
      ctx.ui.tasks.create({ input: 'q', place: { machine: 'desk work;rm', workdir } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses a parent that is not on the board', async () => {
    await expect(ctx.ui.tasks.create({ title: 'x', input: 'y', parentId: 'nope1234' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('a polish note', () => {
  it('is the agent’s note on its own task, with the start of the prompt as its preview', async () => {
    const { polish, rewrite } = await polished();
    const { thread } = await ctx.ui.tasks.get({ id: polish.id });
    expect(thread.at(-1)).toMatchObject({ author: 'agent', kind: 'polish', text: JSON.stringify(rewrite) });
    const listed = (await ctx.ui.tasks.list()).find((t) => t.id === polish.id);
    expect(listed?.lastNote).toMatchObject({ kind: 'polish', text: expect.stringContaining('{"target"') });
  });

  it('is refused from author system, with an unknown kind, or as plain text', async () => {
    const { polish } = await polished();
    const note = { id: polish.id, body: 'x' };
    const system = await ctx.call('add-note', { ...note, author: 'system', kind: 'polish' });
    expect(system).toMatchObject({ status: 400, json: { error: expect.stringMatching(/only an agent/) } });
    expect((await ctx.call('add-note', { ...note, kind: 'answer' })).status).toBe(400);
    expect((await ctx.raw('add-note', { id: polish.id, kind: 'polish', body: { body: 'plain' } })).status).toBe(400);
    expect((await ctx.call('add-note', { ...note, kind: 'comment' })).status).toBe(200);
  });
});

describe('applying a polished prompt', () => {
  it('replaces the title and prompt, keeps the old text in the user’s note and marks the polish task done', async () => {
    const { target, polish, rewrite } = await polished();
    const applied = await apply(target, polish, rewrite, 'old text');
    expect(applied).toMatchObject({
      id: target.id,
      title: rewrite.title,
      input: rewrite.prompt,
      status: 'backlog',
    });
    expect(applied.createdBy).toBe('user');
    const { thread } = await ctx.ui.tasks.get({ id: target.id });
    expect(thread.at(-1)).toMatchObject({ author: 'user', kind: 'event', text: 'old text' });
    expect((await ctx.ui.tasks.get({ id: polish.id })).task.status).toBe('done');
  });

  it('works on a task in Needs me, and leaves a polish task that still runs to its run', async () => {
    const { target, polish, rewrite } = await polished({ when: 'hold' });
    await admin.update(tasks).set({ status: 'running' }).where(eq(tasks.id, polish.id));
    await apply(target, polish, rewrite);
    expect(await admin.select().from(tasks).where(eq(tasks.id, polish.id))).toMatchObject([{ status: 'running' }]);
  });

  it('is refused for a task that is no longer waiting, and changes nothing', async () => {
    const { target, polish, rewrite } = await polished({ when: 'now' });
    await expect(apply(target, polish, rewrite)).rejects.toMatchObject({ code: 'CONFLICT' });
    await admin.update(tasks).set({ status: 'backlog', closed: true }).where(eq(tasks.id, target.id));
    await expect(apply(target, polish, rewrite)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await admin.select().from(notes).where(eq(notes.taskId, target.id))).toEqual([]);
    expect((await ctx.ui.tasks.get({ id: target.id })).task.title).toBe('rough idea');
  });

  it('is refused for a task an agent created', async () => {
    const proposed = (await ctx.call('add-task', { body: { title: 'idea', input: 'do Y', createdBy: 'agent' } })).json
      .result.task;
    const polish = await ctx.ui.tasks.create({ title: 'p', input: 'q', parentId: proposed.id });
    await expect(apply(proposed, polish, { title: 'a', prompt: 'b' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('is refused for a scheduled occurrence, whose prompt belongs to its schedule', async () => {
    const occurrence = await ctx.ui.tasks.create({
      title: 'every day',
      input: 'sweep',
      when: { every: 3_600_000, at: new Date(Date.now() + 3_600_000) },
    });
    expect(occurrence.scheduleId).not.toBeNull();
    await admin.update(tasks).set({ status: 'backlog' }).where(eq(tasks.id, occurrence.id));
    const polish = await ctx.ui.tasks.create({ title: 'p', input: 'q', parentId: occurrence.id });
    await expect(apply(occurrence, polish, { title: 'a', prompt: 'b' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('is refused when the polishing task is not a child of the target', async () => {
    const { target, rewrite } = await polished();
    const stranger = await ctx.ui.tasks.create({ title: 'other', input: 'x' });
    await expect(apply(target, stranger, rewrite)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses text that is not sealed', async () => {
    const { target, polish } = await polished();
    const previous = await ctx.ui.raw.tasks.get({ id: polish.id });
    expect(previous).toBeDefined();
    await expect(
      ctx.ui.raw.tasks.applyPolish({
        id: target.id,
        polishId: polish.id,
        title: 'plain',
        input: 'plain',
        previous: { body: 'plain' },
      }),
    ).rejects.toThrow();
  });
});
