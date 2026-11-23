import { sealFields } from '@agent-board/shared';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupAllBoards } from './cleanup';
import type { Tx } from './db/client';
import { appUsers, machines, notes, schedules, taskPrs, tasks, transcriptEvents, transcriptRuns } from './db/schema';
import { withOwner } from './db/scope';
import { buildServer } from './server';
import { plainMachine, plainUi } from './test/client';
import { asOwner, question, SEALED, SESSION, testConfig, useTestDb } from './test/helpers';
import { sealed } from './test/sealed';

const { db, admin } = await useTestDb();

const HOUR = 60 * 60_000;
const notFound = { code: 'NOT_FOUND' };
const at = (s: number) => new Date(Date.UTC(2026, 10, 13, 12, 0, s)).toISOString();
const transcript = (runId: string) => ({
  runId,
  startedAt: at(0),
  sessionId: '7c1e2f0a-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
  resumed: false,
  events: [
    { seq: 0, at: at(1), parent: null, kind: 'tool_use', toolUseId: 'tu1', name: 'Bash', input: { command: 'ls' } },
    { seq: 1, at: at(2), parent: null, kind: 'tool_result', toolUseId: 'tu1', isError: false, output: 'secret' },
  ],
});

type Who = 'alice' | 'bob';

/** Two users with a board each, both with a machine called "laptop". Bob's board has one of everything. */
async function setup() {
  const app = await buildServer(testConfig, db);
  const ui = { alice: plainUi(db, 'alice'), bob: plainUi(db, 'bob') };
  const tokens = {
    alice: (await ui.alice.machines.issue({ name: 'laptop' })).token,
    bob: (await ui.bob.machines.issue({ name: 'laptop' })).token,
  };
  const raw = async (who: Who, command: string, body: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machine/${command}`,
      headers: { authorization: `Bearer ${tokens[who]}` },
      payload: body,
    });
    return { status: res.statusCode, json: res.json() as { result?: any; error?: string } };
  };
  const plain = {
    alice: plainMachine((command, body) => raw('alice', command, body), 'alice'),
    bob: plainMachine((command, body) => raw('bob', command, body), 'bob'),
  };
  const call = (who: Who, command: string, body: Record<string, unknown> = {}) => plain[who](command, body);

  const idle = await ui.bob.tasks.create({ input: 'idle' });
  await call('bob', 'add-pr', { id: idle.id, body: { pr: SEALED } });
  const asked = await ui.bob.tasks.create({ input: 'asked' });
  await call('bob', 'claim-task', { id: asked.id, machine: 'laptop' });
  await call('bob', 'update-task', { id: asked.id, body: { sessionId: SESSION } });
  await call('bob', 'ask', { id: asked.id, body: { questions: [question] } });
  const questionId = (await ui.bob.tasks.get({ id: asked.id })).thread.find((n) => n.kind === 'question')!.id;
  const running = await ui.bob.tasks.create({ input: 'running' });
  await call('bob', 'claim-task', { id: running.id, machine: 'laptop' });
  const scheduled = await ui.bob.tasks.create({ input: 'sweep', when: { every: HOUR } });
  await call('bob', 'transcript', { id: idle.id, body: transcript('run-bob-0001') });
  return {
    app,
    ui,
    call,
    raw,
    bob: { idle, asked, running, scheduled, questionId, scheduleId: scheduled.scheduleId! },
  };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

/** Everything Bob owns, read around row-level security. */
async function bobsRows() {
  const own = <T extends { owner: string }>(rows: T[]) => rows.filter((row) => row.owner === 'bob');
  return JSON.stringify({
    tasks: own(await admin.select().from(tasks).orderBy(tasks.id)),
    notes: own(await admin.select().from(notes).orderBy(notes.id)),
    prs: own(await admin.select().from(taskPrs).orderBy(taskPrs.id)),
    schedules: own(await admin.select().from(schedules).orderBy(schedules.id)),
    machines: own(await admin.select().from(machines).orderBy(machines.name)),
    runs: own(await admin.select().from(transcriptRuns).orderBy(transcriptRuns.id)),
    events: own(await admin.select().from(transcriptEvents).orderBy(transcriptEvents.seq)),
  });
}

describe('one user cannot reach another user’s board', () => {
  it('reads every foreign id in tRPC as not found or empty, and changes nothing', async () => {
    const { ui, bob } = ctx;
    const alice = ui.alice;
    const before = await bobsRows();
    const own = await alice.tasks.create({ input: 'mine' });
    const [bobsPr] = await admin.select().from(taskPrs).where(eq(taskPrs.taskId, bob.idle.id));
    const attempts: (() => Promise<unknown>)[] = [
      () => alice.tasks.get({ id: bob.idle.id }),
      () => alice.tasks.answer({ id: bob.asked.id, questionNoteId: bob.questionId, answers: [{ selected: ['Yes'] }] }),
      () => alice.tasks.dismissQuestion({ id: bob.asked.id, questionNoteId: bob.questionId }),
      () => alice.tasks.reply({ id: bob.idle.id, message: 'hi', resume: true }),
      () => alice.tasks.reply({ id: bob.idle.id, message: 'hi', resume: false }),
      () => alice.tasks.done({ id: bob.idle.id }),
      () => alice.tasks.rerun({ id: bob.idle.id }),
      () => alice.tasks.setPriority({ id: bob.idle.id, priority: 'urgent' }),
      () => alice.tasks.configure({ id: bob.idle.id, priority: 'urgent', model: 'opus', place: null }),
      () => alice.tasks.setNotBefore({ id: bob.idle.id, notBefore: new Date(Date.now() + HOUR) }),
      () => alice.tasks.takeBack({ id: bob.running.id }),
      () => alice.tasks.setClosed({ id: bob.idle.id, closed: true }),
      () => alice.tasks.move({ id: bob.idle.id, status: 'backlog' }),
      () => alice.tasks.removePr({ id: bob.idle.id, prId: bobsPr!.id }),
      () => alice.schedules.setPaused({ id: bob.scheduleId, paused: true }),
      () => alice.schedules.remove({ id: bob.scheduleId }),
      () => alice.transcript.output({ taskId: bob.idle.id, runId: 'run-bob-0001', seq: 1 }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject(notFound);
    expect(await alice.transcript.runs({ id: bob.idle.id })).toEqual([]);
    expect(await alice.transcript.events({ taskId: bob.idle.id, runId: 'run-bob-0001' })).toEqual([]);
    // A foreign neighbour is not found, so the drop lands as if it were not named.
    const moved = await alice.tasks.move({
      id: own.id,
      status: 'backlog',
      beforeId: bob.idle.id,
      afterId: bob.asked.id,
    });
    expect(moved.status).toBe('backlog');
    // Revoking a name Alice does not have is a no-op, whoever has it.
    await alice.machines.revoke({ name: 'nobody' });
    expect(await bobsRows()).toBe(before);
  });

  it('reads every foreign id on the machine API as not found, and changes nothing', async () => {
    const { call, bob } = ctx;
    const before = await bobsRows();
    const alice = ctx.ui.alice;
    const own = await alice.tasks.create({ input: 'mine' });
    const ownSchedule = (await alice.tasks.create({ input: 'sweep', when: { every: HOUR } })).scheduleId!;
    const foreign = { id: bob.idle.id };
    const [bobsPr] = await admin.select().from(taskPrs).where(eq(taskPrs.taskId, bob.idle.id));
    const commands: [string, Record<string, unknown>][] = [
      ['get-task', foreign],
      ['attach-session', foreign],
      ['update-task', { ...foreign, body: { sessionId: SESSION } }],
      ['configure-task', { ...foreign, body: { priority: 'urgent', model: 'opus', place: null } }],
      ['claim-task', { ...foreign, machine: 'laptop' }],
      ['add-note', { ...foreign, body: 'hello' }],
      ['ask', { ...foreign, body: { questions: [question] } }],
      ['heartbeat', { id: bob.running.id, body: { lane: 'a', borrowed: false } }],
      ['pause', { id: bob.running.id, body: 'stop' }],
      ['fail', { id: bob.running.id, body: 'broke' }],
      ['transcript', { ...foreign, body: transcript('run-alice-01') }],
      ['read-notes', foreign],
      ['add-pr', { ...foreign, body: { pr: SEALED } }],
      ['set-pr', { ...foreign, body: { pr: SEALED } }],
      ['remove-pr', { ...foreign, body: { pr: bobsPr!.id } }],
      ['set-pr-states', { ...foreign, body: { prompt: 'merged' } }],
      ['set-pr-state', { ...foreign, body: { prState: 'merged' } }],
      ['update-schedule', { id: bob.scheduleId, body: { paused: true } }],
      ['remove-schedule', { id: bob.scheduleId }],
      ['add-task', { body: { title: 'child', parentId: bob.idle.id } }],
    ];
    for (const [command, body] of commands) {
      expect(await call('alice', command, body), command).toMatchObject({ status: 404 });
    }
    // Bob's run on Alice's own task: the run id is taken, not writable and not readable.
    expect(await call('alice', 'transcript', { id: own.id, body: transcript('run-bob-0001') })).toMatchObject({
      status: 409,
    });
    expect(await call('alice', 'update-schedule', { id: ownSchedule, body: { paused: true } })).toMatchObject({
      status: 200,
    });
    expect(await bobsRows()).toBe(before);
  });

  it('never mixes lists', async () => {
    const { ui, call } = ctx;
    await ui.alice.tasks.create({ input: 'alice task' });
    await ui.alice.tasks.create({ input: 'alice sweep', when: { every: HOUR } });
    const titles = async (who: Who) => (await ui[who].tasks.list()).map((t) => t.title);
    expect(await titles('alice')).toEqual(expect.arrayContaining(['alice task']));
    expect((await titles('alice')).some((title) => title.includes('idle') || title.includes('asked'))).toBe(false);
    expect((await titles('bob')).some((title) => title.includes('alice'))).toBe(false);
    expect((await ui.alice.schedules.list()).map((s) => s.title)).toEqual(['alice sweep']);
    expect((await ui.bob.schedules.list()).map((s) => s.title)).toEqual(['sweep']);
    expect((await ui.alice.machines.list()).map((m) => m.name)).toEqual(['laptop']);
    expect((await call('alice', 'list-tasks', { all: true })).json.result.map((t: any) => t.title)).not.toContain(
      'idle',
    );
    expect((await call('alice', 'list-schedules')).json.result.map((s: any) => s.title)).toEqual(['alice sweep']);
  });

  it('lets both users use the same dedupe key and machine name', async () => {
    const { call } = ctx;
    const draft = { body: { title: 'review', dedupeKey: 'https://github.com/x/y/pull/1' } };
    const a = await call('alice', 'add-task', draft);
    const b = await call('bob', 'add-task', draft);
    expect(a.json.result).toMatchObject({ created: true });
    expect(b.json.result).toMatchObject({ created: true });
    expect(a.json.result.task.id).not.toBe(b.json.result.task.id);
    expect((await call('alice', 'add-task', draft)).json.result).toMatchObject({
      created: false,
      task: { id: a.json.result.task.id },
    });
    // The setup issued "laptop" for both: tokens stay separate, and each works on its own board only.
    expect((await call('alice', 'get-task', { id: a.json.result.task.id })).status).toBe(200);
    expect((await call('bob', 'get-task', { id: a.json.result.task.id })).status).toBe(404);
  });

  it('keeps one user’s positions out of the other’s', async () => {
    const { ui } = ctx;
    const first = await ui.alice.tasks.create({ input: 'a1' });
    const second = await ui.alice.tasks.create({ input: 'a2' });
    const positions = async () =>
      (await admin.select({ id: tasks.id, position: tasks.position }).from(tasks).orderBy(tasks.id)).filter(
        ({ id }) => id === first.id || id === second.id,
      );
    const before = await positions();
    await ui.bob.tasks.create({ input: 'b1', when: 'now' });
    await ui.bob.tasks.create({ input: 'b2', when: 'now' });
    expect(await positions()).toEqual(before);
    // Bob already has Todo cards, and Alice's first one still starts at 0.
    expect(before.find((p) => p.id === first.id)!.position).toBe(0);
    const [row] = await admin
      .select({ position: tasks.position })
      .from(tasks)
      .where(sql`id = ${second.id}`);
    expect(row!.position).toBeGreaterThan(before.find((p) => p.id === first.id)!.position);
  });

  it('shows nothing and allows nothing to a connection with no owner', async () => {
    for (const table of [
      'task',
      'schedule',
      'note',
      'task_pr',
      'machine',
      'transcript_run',
      'transcript_event',
      'app_user',
    ]) {
      const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)}`);
      expect(rows[0]!.n, table).toBe(0);
    }
    await expect(db.insert(tasks).values({ id: 'raw-1', title: SEALED, input: SEALED, position: 0 })).rejects.toThrow();
    await expect(
      db.insert(tasks).values({ id: 'raw-2', title: SEALED, input: SEALED, position: 0, owner: 'bob' }),
    ).rejects.toThrow();
    await expect(db.update(tasks).set({ title: 'x' })).resolves.toBeDefined();
    expect(
      (
        await admin
          .select()
          .from(tasks)
          .where(sql`title = 'x'`)
      ).length,
    ).toBe(0);
  });

  it('cannot write a row for another owner, nor attach a child to a foreign parent', async () => {
    const { bob } = ctx;
    await asOwner(db, 'alice', async (tx) => {
      const attempt = (fn: () => Promise<unknown>) =>
        // A savepoint, so a refused write does not abort the transaction for the next attempt.
        tx.transaction(() => fn());
      await expect(
        attempt(() => tx.insert(tasks).values({ id: 'x-1', title: SEALED, input: SEALED, position: 0, owner: 'bob' })),
      ).rejects.toThrow();
      await expect(
        attempt(() =>
          tx
            .insert(notes)
            .values({ id: 'x-note-1', taskId: bob.idle.id, author: 'user', kind: 'comment', body: SEALED }),
        ),
      ).rejects.toThrow();
      await expect(
        attempt(() =>
          tx.insert(transcriptRuns).values({
            id: 'x-run-1',
            taskId: bob.idle.id,
            machine: 'laptop',
            startedAt: new Date(),
            lastEventAt: new Date(),
          }),
        ),
      ).rejects.toThrow();
      await expect(
        attempt(() =>
          tx
            .insert(transcriptEvents)
            .values({ runId: 'run-bob-0001', seq: 9, at: new Date(), kind: 'text', data: SEALED }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('references', () => {
    /** The error of a refused write: the same for a foreign id and a missing one. */
    const refusal = async (tx: Tx, write: () => Promise<unknown>) => {
      try {
        await tx.transaction(() => write());
      } catch (error) {
        const { code, constraint } = (error as { cause: { code: string; constraint: string } }).cause;
        return { code, constraint };
      }
      return 'accepted';
    };

    it('refuses a row of the other owner exactly as it refuses a missing id', async () => {
      const { bob } = ctx;
      await asOwner(db, 'alice', async (tx) => {
        const [own] = await tx
          .insert(tasks)
          .values({ id: 'alice-task', title: SEALED, input: SEALED, position: 0 })
          .returning();
        const [ownSchedule] = await tx
          .insert(schedules)
          .values({ id: 'alice-sched', title: SEALED, input: SEALED, everyMs: HOUR, anchorAt: new Date() })
          .returning();
        const cases: [string, (id: string) => Promise<unknown>, string][] = [
          ['task_parent_fk', (id) => tx.update(tasks).set({ parentId: id }).where(eq(tasks.id, own!.id)), bob.idle.id],
          [
            'schedule_occurrence_task_fk',
            (id) => tx.update(schedules).set({ occurrenceTaskId: id }).where(eq(schedules.id, ownSchedule!.id)),
            bob.idle.id,
          ],
          [
            'schedule_after_fk',
            (id) =>
              tx.insert(schedules).values({
                id: `s-${id}`.slice(0, 20),
                title: SEALED,
                input: SEALED,
                afterScheduleId: id,
                afterDelayMs: 0,
                anchorAt: new Date(),
              }),
            bob.scheduleId,
          ],
          [
            'note_task_fk',
            (id) =>
              tx
                .insert(notes)
                .values({ id: `n-${id}`.slice(0, 20), taskId: id, author: 'user', kind: 'comment', body: SEALED }),
            bob.idle.id,
          ],
          [
            'task_pr_task_fk',
            (id) => tx.insert(taskPrs).values({ id: `p-${id}`.slice(0, 20), taskId: id, pr: SEALED }),
            bob.idle.id,
          ],
          [
            'transcript_run_task_fk',
            (id) =>
              tx.insert(transcriptRuns).values({
                id: `r-${id}`.slice(0, 20),
                taskId: id,
                machine: 'laptop',
                startedAt: new Date(),
                lastEventAt: new Date(),
              }),
            bob.idle.id,
          ],
          [
            'transcript_event_run_fk',
            (id) =>
              tx.insert(transcriptEvents).values({ runId: id, seq: 0, at: new Date(), kind: 'text', data: SEALED }),
            'run-bob-0001',
          ],
        ];
        for (const [constraint, write, foreignId] of cases) {
          const foreign = await refusal(tx, () => write(foreignId));
          const missing = await refusal(tx, () => write('does-not-exist'));
          expect(foreign, constraint).toEqual({ code: '23503', constraint });
          expect(missing, constraint).toEqual(foreign);
        }
      });
    });

    it('clears only the reference column when the parent goes', async () => {
      await asOwner(db, 'alice', async (tx) => {
        const row = (id: string) => ({ id, title: SEALED, input: SEALED, position: 0 });
        await tx.insert(tasks).values(row('parent-1'));
        await tx.insert(tasks).values({ ...row('child-1'), parentId: 'parent-1' });
        await tx.insert(schedules).values({
          id: 'sched-1',
          title: SEALED,
          input: SEALED,
          everyMs: HOUR,
          anchorAt: new Date(),
          occurrenceTaskId: 'parent-1',
        });
        await tx.update(tasks).set({ scheduleId: 'sched-1' }).where(eq(tasks.id, 'child-1'));
        await tx.delete(tasks).where(eq(tasks.id, 'parent-1'));
        const [child] = await tx.select().from(tasks).where(eq(tasks.id, 'child-1'));
        expect(child).toMatchObject({ owner: 'alice', parentId: null, scheduleId: 'sched-1' });
        const [schedule] = await tx.select().from(schedules);
        expect(schedule).toMatchObject({ owner: 'alice', occurrenceTaskId: null });
        // A task keeps naming its schedule after it is gone: its sealed fields are bound to that id.
        await tx.delete(schedules).where(eq(schedules.id, 'sched-1'));
        const [after] = await tx.select().from(tasks).where(eq(tasks.id, 'child-1'));
        expect(after).toMatchObject({ owner: 'alice', scheduleId: 'sched-1' });
      });
    });
  });

  it('reads a task or schedule id that another user holds as the same conflict as an own duplicate, and writes nothing', async () => {
    const { ui, bob } = ctx;
    const before = await bobsRows();
    const task = async (id: string) => ({
      id,
      ...(await sealFields(
        sealed.seal,
        { kind: 'task', id, createdBy: 'user', scheduleId: null, forkOf: null },
        { title: SEALED, input: SEALED },
      )),
    });
    const schedule = async (id: string) => ({
      id,
      ...(await sealFields(sealed.seal, { kind: 'schedule', id }, { title: SEALED, input: SEALED })),
    });
    const foreignTask = await ctx.raw('alice', 'add-task', { body: await task(bob.idle.id) });
    const foreignSchedule = await ctx.raw('alice', 'add-schedule', {
      body: { ...(await schedule(bob.scheduleId)), everyMs: HOUR },
    });
    expect(foreignTask).toMatchObject({ status: 409, json: { error: 'that task id is already taken' } });
    expect(foreignSchedule).toMatchObject({ status: 409, json: { error: 'that schedule id is already taken' } });
    await expect(ui.alice.raw.tasks.create({ ...(await task(bob.idle.id)) })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      ui.alice.raw.tasks.create({ ...(await schedule(bob.scheduleId)), when: { every: HOUR } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // An own duplicate says the same, so the answer does not tell whose the id is.
    const own = await task('alice-own-id');
    expect((await ctx.raw('alice', 'add-task', { body: own })).status).toBe(200);
    expect(await ctx.raw('alice', 'add-task', { body: own })).toMatchObject({
      status: 409,
      json: { error: foreignTask.json.error },
    });
    expect(await bobsRows()).toBe(before);
  });

  it('closes stale Done tasks of every board, with the event under the right owner', async () => {
    const { ui, bob } = ctx;
    const mine = await ui.alice.tasks.create({ input: 'old' });
    for (const id of [mine.id, bob.idle.id]) {
      await admin
        .update(tasks)
        .set({ status: 'done', updatedAt: new Date(Date.now() - 30 * 24 * HOUR) })
        .where(sql`id = ${id}`);
    }
    const errors: unknown[] = [];
    await cleanupAllBoards(db, { info: () => undefined, error: (context) => errors.push(context.err) });
    expect(errors).toEqual([]);
    for (const [id, owner] of [
      [mine.id, 'alice'],
      [bob.idle.id, 'bob'],
    ] as const) {
      const [task] = await admin
        .select()
        .from(tasks)
        .where(sql`id = ${id}`);
      expect(task).toMatchObject({ closed: true, owner });
      const events = (
        await admin
          .select()
          .from(notes)
          .where(sql`task_id = ${id}`)
      ).filter((n) => n.kind === 'event');
      expect(events.map((n) => [n.owner, n.body])).toEqual([[owner, expect.stringMatching(/^Closed after/)]]);
    }
  });

  it('refuses a revoked token, in the database function and on the API', async () => {
    const { ui, call } = ctx;
    const token = (await ui.alice.machines.issue({ name: 'extra' })).token;
    const hash = createHash('sha256').update(token).digest('hex');
    const lookup = () => db.execute<{ owner: string; name: string }>(sql`select * from machine_for_token(${hash})`);
    expect((await lookup()).rows).toEqual([{ owner: 'alice', name: 'extra' }]);
    await ui.alice.machines.revoke({ name: 'extra' });
    expect((await lookup()).rows).toEqual([]);
    expect((await call('alice', 'version')).json.result).toMatchObject({ owner: 'alice' });
  });

  it('a user can neither read nor replace another user’s key slots', async () => {
    const { ui } = ctx;
    const wrapped = `abw1.${'A'.repeat(80)}`;
    const slots = [
      { kind: 'passphrase', kdf: 'argon2id', m: 65536, t: 3, p: 1, salt: 'A'.repeat(22), wrapped },
    ] as const;
    await ui.bob.keys.setup({ keyId: '0573c0a7b6879764', slots: [...slots] });
    expect(await ui.alice.keys.get()).toBeNull();
    expect(await ui.alice.me()).toEqual({ username: 'alice', keyId: null });
    await expect(ui.alice.keys.replaceSlots({ keyId: '0573c0a7b6879764', slots: [...slots] })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const before = await admin.select().from(appUsers).where(eq(appUsers.username, 'bob'));
    const changed = await withOwner(db, 'alice', (tx) =>
      tx.update(appUsers).set({ keySlots: [] }).where(eq(appUsers.username, 'bob')).returning(),
    );
    expect(changed).toEqual([]);
    expect(await admin.select().from(appUsers).where(eq(appUsers.username, 'bob'))).toEqual(before);
  });
});
