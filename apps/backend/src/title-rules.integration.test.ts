import { openTitleRules, sealIcon, sealTitle, sealTitleRules } from '@agent-board/shared';
import type { RowRef, TitleRule } from '@agent-board/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { titleRules } from './db/schema';
import { buildServer } from './server';
import { Changes } from './services/changes';
import { plainUi, type MachineAnswer } from './test/client';
import { caller, testConfig, useTestDb } from './test/helpers';
import { sealed, sealerFor } from './test/sealed';

const { db, admin } = await useTestDb();

const REVIEW: TitleRule = { pattern: '^/review (\\d+)', icon: '🔎', instruction: 'Name the PR.' };

/** What the browser sends: the next version sealed under its own binding. */
async function body(version: number, rules: TitleRule[] = [REVIEW], seal = sealed.seal) {
  return { document: await sealTitleRules(seal, { version, rules }), version, expectedVersion: version - 1 };
}

let app: Awaited<ReturnType<typeof buildServer>>;
let changes: Changes;
beforeEach(async () => {
  changes = new Changes(20);
  app = await buildServer(testConfig, db, { changes });
});

async function machine(name: string, username = 'jascha') {
  const { token } = await caller(db, username).machines.issue({ name });
  return async (command: string, payload: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machine/${command}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    return { status: res.statusCode, json: res.json() as MachineAnswer['json'] };
  };
}

const result = (answer: { json: MachineAnswer['json'] }): unknown => (answer.json as { result?: unknown }).result;

describe('titleRules.get and titleRules.set', () => {
  it('is null before the first save, then serves the sealed document with its version and time', async () => {
    expect(await caller(db).titleRules.get()).toBeNull();
    const before = Date.now();
    const sent = await body(1);
    await caller(db).titleRules.set(sent);
    const read = await caller(db).titleRules.get();
    expect(read).toMatchObject({ version: 1, document: sent.document });
    expect(read?.updatedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await openTitleRules(sealed.open, 1, read?.document ?? '')).toEqual({ version: 1, rules: [REVIEW] });
    const [row] = await admin.select().from(titleRules);
    expect(JSON.stringify(row)).not.toContain('review');
  });

  it('is compare-and-set: a save against a version that moved on is a CONFLICT, and the stored one stays', async () => {
    const api = caller(db);
    await api.titleRules.set(await body(1));
    const second = await body(2, []);
    await api.titleRules.set(second);
    await expect(api.titleRules.set(await body(2))).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/holds version 2 of the title rules, not 1/) as unknown,
    });
    expect(await api.titleRules.get()).toMatchObject({ version: 2, document: second.document });
  });

  it("keeps each user's document to themselves", async () => {
    await caller(db).titleRules.set(await body(1));
    expect(await caller(db, 'other').titleRules.get()).toBeNull();
    await caller(db, 'other').titleRules.set(await body(1, [], sealerFor('other').seal));
    expect(await caller(db).titleRules.get()).toMatchObject({ version: 1 });
  });
});

describe('get-title-rules', () => {
  it('is named by the version answer, null before a save, then the browser’s document', async () => {
    const laptop = await machine('laptop');
    expect(result(await laptop('version'))).toMatchObject({ features: expect.arrayContaining(['task.title-rules']) });
    expect(result(await laptop('get-title-rules'))).toBeNull();
    const sent = await body(1);
    await caller(db).titleRules.set(sent);
    expect(result(await laptop('get-title-rules'))).toEqual({ version: 1, document: sent.document });
  });
});

describe('apply-title-rule', () => {
  const ref = (id: string): RowRef => ({
    kind: 'task',
    id,
    createdBy: 'user',
    scheduleId: null,
    agent: null,
    forkOf: null,
  });
  const hour = 3_600_000;

  /** A running task of the laptop with the default title; `expect` is its sealed title as the board holds it. */
  async function running(icon = false) {
    const ui = plainUi(db);
    const created = await ui.tasks.create({ input: '/review 8' });
    if (icon)
      await caller(db).tasks.configure({ id: created.id, icon: await sealIcon(sealed.seal, ref(created.id), '🚀') });
    const laptop = await machine('laptop');
    const claimed = result(await laptop('claim-task', { id: created.id, machine: 'laptop' })) as { run: string };
    const stored = result(await laptop('get-task', { id: created.id })) as { title: string; icon: string | null };
    return { ui, laptop, id: created.id, run: claimed.run, wireTitle: stored.title };
  }
  const wire = async (id: string) => (await admin.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!;

  it('stores the icon on a task without one and keeps the icon a task has', async () => {
    const bare = await running();
    const icon = await sealIcon(sealed.seal, ref(bare.id), '🔎');
    expect(result(await bare.laptop('apply-title-rule', { id: bare.id, run: bare.run, body: { icon } }))).toEqual({
      icon: true,
      title: false,
    });
    expect((await wire(bare.id)).icon).toBe(icon);

    const kept = await running(true);
    const before = (await wire(kept.id)).icon;
    const sent = await sealIcon(sealed.seal, ref(kept.id), '🔎');
    expect(result(await kept.laptop('apply-title-rule', { id: kept.id, run: kept.run, body: { icon: sent } }))).toEqual(
      {
        icon: false,
        title: false,
      },
    );
    expect((await wire(kept.id)).icon).toBe(before);
  });

  it('stores the title while it is the envelope the caller expects, and not after a rename', async () => {
    const task = await running();
    const title = await sealTitle(sealed.seal, ref(task.id), 'Review PR 8');
    const apply = { title, expectTitle: task.wireTitle };
    await task.ui.tasks.configure({ id: task.id, title: 'My own name' });
    expect(result(await task.laptop('apply-title-rule', { id: task.id, run: task.run, body: apply }))).toEqual({
      icon: false,
      title: false,
    });
    expect(await task.ui.tasks.get({ id: task.id }).then(({ task: t }) => t.title)).toBe('My own name');

    const fresh = await running();
    expect(
      result(
        await fresh.laptop('apply-title-rule', {
          id: fresh.id,
          run: fresh.run,
          body: { title, expectTitle: fresh.wireTitle },
        }),
      ),
    ).toEqual({ icon: false, title: true });
    expect((await wire(fresh.id)).title).toBe(title);
  });

  it('tells the listeners only when something was stored', async () => {
    const task = await running();
    await new Promise((resolve) => setTimeout(resolve, 100));
    let told = 0;
    changes.subscribe('jascha', () => told++);
    const icon = await sealIcon(sealed.seal, ref(task.id), '🔎');
    await task.laptop('apply-title-rule', { id: task.id, run: task.run, body: { icon } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(told).toBe(1);
    await task.laptop('apply-title-rule', { id: task.id, run: task.run, body: { icon } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(told).toBe(1);
  });

  it('refuses a schedule’s occurrence', async () => {
    const ui = plainUi(db);
    const occurrence = await ui.tasks.create({ input: '/review 8', when: { every: hour } });
    const laptop = await machine('laptop');
    const icon = await sealIcon(sealed.seal, ref(occurrence.id), '🔎');
    const answer = await laptop('apply-title-rule', {
      id: occurrence.id,
      run: 'AAAAAAAAAAAAAAAAAAAAAA',
      body: { icon },
    });
    expect(answer.status).toBe(409);
    expect(answer.json.error).toMatch(/schedule/);
  });

  it('refuses a run that is not the one the task runs in, and takes the same run after the task moved on', async () => {
    const task = await running();
    const icon = await sealIcon(sealed.seal, ref(task.id), '🔎');
    const other = await task.laptop('apply-title-rule', { id: task.id, run: 'AAAAAAAAAAAAAAAAAAAAAA', body: { icon } });
    expect(other.status).toBe(409);
    expect(other.json.error).toMatch(/later run/);
    expect((await wire(task.id)).icon).toBeNull();

    await task.laptop('update-task', { id: task.id, run: task.run, body: { status: 'needs-me' } });
    expect(result(await task.laptop('apply-title-rule', { id: task.id, run: task.run, body: { icon } }))).toEqual({
      icon: true,
      title: false,
    });
    expect((await wire(task.id)).status).toBe('needs-me');
  });

  it('needs a run', async () => {
    const task = await running();
    const icon = await sealIcon(sealed.seal, ref(task.id), '🔎');
    const answer = await task.laptop('apply-title-rule', { id: task.id, body: { icon } });
    expect(answer.status).toBe(400);
    expect(answer.json.error).toBe('run is required');
  });
});
