import { BASELINE_SERVER_FEATURES, SERVER_FEATURES } from '@agent-board/shared';
import type { VocabularyFeatures } from '@agent-board/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './server';
import { plainMachine, plainUi } from './test/client';
import type { MachineAnswer } from './test/client';
import { caller, testConfig, useTestDb } from './test/helpers';

const { db } = await useTestDb();

// Pretend these existing values were added after the baseline, so a client has to name the feature to be shown them.
const ADDED: VocabularyFeatures = {
  status: { backlog: 'status.backlog' },
  priority: { low: 'priority.low' },
  kind: { event: 'note.event' },
};

async function setup(vocabulary?: VocabularyFeatures, machine = 'laptop') {
  const app = await buildServer(testConfig, db, vocabulary === undefined ? {} : { vocabulary });
  const { token } = await caller(db).machines.issue({ name: machine });
  const raw = async (command: string, body: Record<string, unknown> = {}, features?: string) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machine/${command}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(features === undefined ? {} : { 'x-board-features': features }),
      },
      payload: body,
    });
    return { status: res.statusCode, json: res.json() as MachineAnswer['json'] };
  };
  /** Plaintext in and out like the CLI, sending the client features named (none: a CLI that sends no header). */
  const as = (features?: string) => plainMachine((command, body) => raw(command, body, features));
  return { raw, as };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup(ADDED);
});

const titles = (list: MachineAnswer): string[] => list.json.result.map((item: { title: string }) => item.title);

async function parkedAndTodo() {
  const ui = plainUi(db);
  const { id: parked } = await ui.tasks.create({ title: 'parked', input: 'a', when: 'backlog' });
  const { id: todo } = await ui.tasks.create({ title: 'todo', input: 'b' });
  return { parked, todo };
}

describe('the server features', () => {
  it('version names the features the server has', async () => {
    const { json } = await ctx.raw('version');
    expect(json.result.features).toEqual([...SERVER_FEATURES]);
    expect(SERVER_FEATURES).toEqual(expect.arrayContaining([...BASELINE_SERVER_FEATURES]));
  });
});

describe('filtering by what the client knows', () => {
  it('a list leaves out tasks whose status needs a feature the client did not send', async () => {
    await parkedAndTodo();
    expect(titles(await ctx.as()('list-tasks', { all: true }))).toEqual(['todo']);
    expect(titles(await ctx.as('status.backlog')('list-tasks', { all: true })).sort()).toEqual(['parked', 'todo']);
  });

  it('a request without the header knows the baseline only', async () => {
    await parkedAndTodo();
    const plain = await setup(undefined, 'workstation');
    expect(titles(await plain.as()('list-tasks', { all: true })).sort()).toEqual(['parked', 'todo']);
    expect(titles(await ctx.as()('list-tasks', { all: true }))).toEqual(['todo']);
  });

  it('takes the header leniently: junk is ignored, the length and the count are capped, and it is never a 400', async () => {
    await parkedAndTodo();
    const list = async (header: string) => {
      const answer = await ctx.as(header)('list-tasks', { all: true });
      expect(answer.status).toBe(200);
      return titles(answer).sort();
    };
    expect(await list('<script>, ,,;;, A B ,status.backlog')).toEqual(['parked', 'todo']);
    expect(await list('x'.repeat(8000))).toEqual(['todo']);
    expect(await list(`${'a,'.repeat(600)}status.backlog`)).toEqual(['todo']);
    expect(await list(`${Array.from({ length: 70 }, (_, i) => `f${i}`).join(',')},status.backlog`)).toEqual(['todo']);
    expect((await ctx.as('')('version')).status).toBe(200);
  });

  it('a single read of such a task is a 422 saying what to do', async () => {
    const { parked, todo } = await parkedAndTodo();
    const refused = await ctx.as()('get-task', { id: parked });
    expect(refused).toMatchObject({
      status: 422,
      json: { error: 'this task uses status "backlog", which this CLI does not know; update the CLI' },
    });
    expect((await ctx.as()('get-task', { id: todo })).status).toBe(200);
    expect((await ctx.as('status.backlog')('get-task', { id: parked })).status).toBe(200);
  });

  it('a write whose result the client cannot read is refused, and does not happen', async () => {
    const { parked } = await parkedAndTodo();
    const refused = await ctx.as()('update-task', { id: parked, body: { priority: 'high' } });
    expect(refused.status).toBe(422);
    expect(refused.json.error).toMatch(/this task uses status "backlog"/);
    expect((await ctx.as('status.backlog')('get-task', { id: parked })).json.result.priority).toBe('normal');
  });

  it('claiming a task that needs a feature is refused before the claim is kept', async () => {
    const ui = plainUi(db);
    const { id } = await ui.tasks.create({ title: 'urgent-low', input: 'c', priority: 'low' });
    const refused = await ctx.as()('claim-task', { id, machine: 'laptop' });
    expect(refused).toMatchObject({ status: 422, json: { error: expect.stringContaining('priority "low"') } });
    const after = await ctx.as('priority.low')('get-task', { id });
    expect(after.json.result).toMatchObject({ status: 'todo', machine: null });
  });

  it('read-notes leaves out notes whose kind needs a feature', async () => {
    const { todo } = await parkedAndTodo();
    await ctx.as()('add-note', { id: todo, body: 'comment' });
    await ctx.as()('add-note', { id: todo, author: 'system', body: 'an event' });
    const kinds = async (features?: string) =>
      (await ctx.as(features)('read-notes', { id: todo })).json.result.map((note: { kind: string }) => note.kind);
    expect(await kinds()).toEqual(['comment']);
    expect(await kinds('note.event')).toEqual(['comment', 'event']);
  });

  it('list-schedules leaves out schedules by priority, and adding one the client cannot read is refused', async () => {
    const body = { title: 'Sweep', input: '/sweep', everyMs: 3_600_000 };
    const refused = await ctx.as()('add-schedule', { body: { ...body, priority: 'low' } });
    expect(refused.status).toBe(422);
    expect((await ctx.as('priority.low')('list-schedules')).json.result).toEqual([]);
    expect((await ctx.as()('add-schedule', { body })).status).toBe(200);
    await ctx.as('priority.low')('add-schedule', { body: { ...body, title: 'Low', priority: 'low' } });
    expect(titles(await ctx.as()('list-schedules'))).toEqual(['Sweep']);
    expect(titles(await ctx.as('priority.low')('list-schedules')).sort()).toEqual(['Low', 'Sweep']);
  });
});
