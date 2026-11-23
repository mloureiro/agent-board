import { generateDataKey, wrapDataKey, type KeySlot } from '@agent-board/shared';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appUsers,
  machines,
  notes,
  schedules,
  sharedAgents,
  linkRules,
  titleRules,
  taskPrs,
  tasks,
  transcriptEvents,
  transcriptRuns,
} from './db/schema';
import { buildServer } from './server';
import { ACCOUNT_TABLES, exportPage, type AccountTable } from './services/account';
import { Changes } from './services/changes';
import { asOwner, caller, SEALED, testConfig, useTestDb } from './test/helpers';

const { db, admin } = await useTestDb();

const KEY = '0573c0a7b6879764';
const OTHER_KEY = 'ffffffffffffffff';
const BLIND = `abh1.${'B'.repeat(43)}`;
const RUN = 'run-0001-aaaa';

let wrapped: string;
beforeAll(async () => {
  wrapped = await wrapDataKey(generateDataKey(), generateDataKey());
});
const slots = (): KeySlot[] => [
  { kind: 'passphrase', kdf: 'argon2id', m: 65536, t: 3, p: 1, salt: 'A'.repeat(22), wrapped },
  { kind: 'recovery', wrapped },
];

type Rows = Record<string, unknown>[];
type Client = ReturnType<typeof caller>;

async function exportAll(client: Client, table: AccountTable): Promise<Rows> {
  const rows: Rows = [];
  let cursor: string | null = null;
  do {
    const page: { rows: Rows; next: string | null } = await client.account.export({ table, cursor });
    rows.push(...page.rows);
    cursor = page.next;
  } while (cursor !== null);
  return rows;
}

const exportEverything = async (client: Client): Promise<Record<AccountTable, Rows>> =>
  Object.fromEntries(
    await Promise.all(ACCOUNT_TABLES.map(async (table) => [table, await exportAll(client, table)] as const)),
  ) as Record<AccountTable, Rows>;

async function importEverything(client: Client, data: Record<AccountTable, Rows>, keyId = KEY) {
  const results = [];
  for (const table of ACCOUNT_TABLES) results.push(await client.account.import({ keyId, table, rows: data[table] }));
  return results;
}

/** A board with a parent and a child task, a schedule on the child, notes of every sort, a PR, a machine and a run. */
async function seed(owner = 'jascha'): Promise<{ token: string }> {
  /** Ids are unique across users, so a second user's board gets its own. */
  const id = (name: string) => (owner === 'jascha' ? name : `${name}-${owner}`);
  const client = caller(db, owner);
  await client.keys.setup({ keyId: KEY, slots: slots() });
  const task = { title: SEALED, input: SEALED, position: 0 };
  await asOwner(db, owner, (tx) =>
    tx.insert(tasks).values({ id: id('parent1'), ...task, status: 'done', dedupeKey: BLIND, head: BLIND }),
  );
  await asOwner(db, owner, (tx) => tx.insert(tasks).values({ id: id('child1'), ...task, parentId: id('parent1') }));
  await asOwner(db, owner, (tx) =>
    tx.insert(tasks).values({
      id: id('running1'),
      ...task,
      status: 'running',
      machine: 'laptop',
      runId: 'runtoken-1234567890',
      runStartedAt: new Date(),
      stopRequestedAt: new Date(),
      stopMessageId: 'stopmsg1',
      inboxRead: true,
      pausedAt: new Date(),
      lane: 'main',
      watchStops: ['0123456789abcdef'],
    }),
  );
  await asOwner(db, owner, async (tx) => {
    await tx.insert(schedules).values({
      id: id('sched1'),
      title: SEALED,
      input: SEALED,
      everyMs: 3_600_000,
      anchorAt: new Date('2026-01-01T00:00:00Z'),
      occurrenceTaskId: id('child1'),
    });
    await tx.insert(notes).values([
      { id: id('note1'), taskId: id('parent1'), author: 'agent', kind: 'comment', body: SEALED, suggestion: SEALED },
      { id: id('note2'), taskId: id('parent1'), author: 'server', kind: 'event', body: 'Closed.' },
      {
        id: id('note3'),
        taskId: id('running1'),
        author: 'user',
        kind: 'comment',
        body: SEALED,
        pending: true,
        queued: true,
      },
    ]);
    await tx.insert(taskPrs).values({ id: id('pr1'), taskId: id('parent1'), pr: SEALED, state: 'merged' });
    await tx.insert(transcriptRuns).values({
      id: id(RUN),
      taskId: id('running1'),
      machine: 'laptop',
      startedAt: new Date('2026-02-01T00:00:00Z'),
      lastEventAt: new Date('2026-02-01T00:01:00Z'),
      eventCount: 2,
    });
    await tx.insert(transcriptEvents).values([
      { runId: id(RUN), seq: 0, at: new Date('2026-02-01T00:00:01Z'), kind: 'text', data: SEALED },
      {
        runId: id(RUN),
        seq: 1,
        at: new Date('2026-02-01T00:00:02Z'),
        kind: 'tool_result',
        parent: 'toolu_1',
        data: SEALED,
        output: SEALED,
        outputSize: 12,
      },
    ]);
  });
  const { token } = await client.machines.issue({ name: 'laptop' });
  await asOwner(db, owner, (tx) =>
    tx
      .update(machines)
      .set({ dirs: SEALED, dirsIndex: BLIND, lastSeenAt: new Date() })
      .where(eq(machines.name, 'laptop')),
  );
  await asOwner(db, owner, (tx) => tx.insert(sharedAgents).values({ version: 3, document: SEALED }));
  await asOwner(db, owner, (tx) => tx.insert(linkRules).values({ version: 2, document: SEALED }));
  await asOwner(db, owner, (tx) => tx.insert(titleRules).values({ version: 4, document: SEALED }));
  return { token };
}

const countsOf = async (owner: string) => {
  const { rows } = await admin.execute<{ n: number }>(sql`
    select (
      (select count(*) from task where owner = ${owner}) + (select count(*) from schedule where owner = ${owner}) +
      (select count(*) from note where owner = ${owner}) + (select count(*) from task_pr where owner = ${owner}) +
      (select count(*) from machine where owner = ${owner}) + (select count(*) from transcript_run where owner = ${owner}) +
      (select count(*) from shared_agents where owner = ${owner}) +
      (select count(*) from link_rules where owner = ${owner}) +
      (select count(*) from title_rules where owner = ${owner}) +
      (select count(*) from transcript_event where owner = ${owner})
    )::int as n`);
  return rows[0]!.n;
};

describe('account.summary', () => {
  it('counts what the user has, and nothing of another user', async () => {
    await seed('jascha');
    await seed('carol');
    expect(await caller(db).account.summary()).toEqual({
      tasks: 3,
      schedules: 1,
      notes: 3,
      taskPrs: 1,
      machines: 1,
      sharedAgents: 1,
      linkRules: 1,
      titleRules: 1,
      transcriptRuns: 1,
      transcriptEvents: 2,
      running: 1,
    });
  });

  it('is all zero for a user who has never written anything, and does not create the user', async () => {
    expect(await caller(db, 'nobody').account.summary()).toEqual({
      tasks: 0,
      schedules: 0,
      notes: 0,
      taskPrs: 0,
      machines: 0,
      sharedAgents: 0,
      linkRules: 0,
      titleRules: 0,
      transcriptRuns: 0,
      transcriptEvents: 0,
      running: 0,
    });
    expect(await admin.select().from(appUsers)).toEqual([]);
  });
});

describe('account.export', () => {
  it('leaves out the owner, gives dates as ISO text and keeps sealed text sealed', async () => {
    await seed();
    const [row] = await exportAll(caller(db), 'task');
    expect(row).not.toHaveProperty('owner');
    expect(row).toMatchObject({ id: 'parent1', title: SEALED, status: 'done' });
    expect(row!['createdAt']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    for (const table of ACCOUNT_TABLES)
      for (const each of await exportAll(caller(db), table)) expect(each).not.toHaveProperty('owner');
  });

  it('orders tasks by creation, so a parent comes before its child', async () => {
    await seed();
    expect((await exportAll(caller(db), 'task')).map((row) => row['id'])).toEqual(['parent1', 'child1', 'running1']);
  });

  it('pages through every table in a stable order, without repeating or skipping a row', async () => {
    await asOwner(db, 'jascha', async (tx) => {
      // One transaction, so one `now()`: the page boundary falls between rows with equal creation times.
      await tx
        .insert(tasks)
        .values(['g', 'e', 'a', 'f', 'c', 'b', 'd'].map((id) => ({ id, title: SEALED, input: SEALED, position: 0 })));
      await tx.insert(notes).values(
        Array.from({ length: 7 }, (_, n) => ({
          id: `n${n}`,
          taskId: 'a',
          author: 'agent' as const,
          kind: 'comment' as const,
          body: SEALED,
        })),
      );
    });
    for (const table of ['task', 'note'] as const) {
      const whole = (await asOwner(db, 'jascha', (tx) => exportPage(tx, table, null, { maxRows: 100, maxBytes: 1e9 })))
        .rows;
      const paged: Rows = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: { rows: Rows; next: string | null } = await asOwner(db, 'jascha', (tx) =>
          exportPage(tx, table, cursor, { maxRows: 3, maxBytes: 1e9 }),
        );
        expect(page.rows.length).toBeLessThanOrEqual(3);
        paged.push(...page.rows);
        cursor = page.next;
        pages += 1;
      } while (cursor !== null);
      expect(pages).toBe(3);
      expect(paged).toEqual(whole);
      expect(whole.map((row) => row['id'])).toHaveLength(7);
    }
    const ids = (await exportAll(caller(db), 'task')).map((row) => row['id']);
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('cuts a page by size but always returns at least one row, and ends with next null', async () => {
    await seed();
    const pages: Rows[] = [];
    let cursor: string | null = null;
    do {
      const page: { rows: Rows; next: string | null } = await asOwner(db, 'jascha', (tx) =>
        exportPage(tx, 'transcript_event', cursor, { maxRows: 500, maxBytes: 1 }),
      );
      pages.push(page.rows);
      cursor = page.next;
    } while (cursor !== null);
    expect(pages.map((rows) => rows.length)).toEqual([1, 1]);
    expect(pages.flat().map((row) => row['seq'])).toEqual([0, 1]);
  });

  it('refuses a cursor it did not give out', async () => {
    await seed();
    const bad = ['nonsense', Buffer.from('[1,2]').toString('base64url'), Buffer.from('{"a":1}').toString('base64url')];
    for (const cursor of bad)
      await expect(caller(db).account.export({ table: 'task', cursor })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    const task = await caller(db).account.export({ table: 'machine', cursor: null });
    await expect(caller(db).account.export({ table: 'task', cursor: task.next ?? 'x' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('does not create a user', async () => {
    expect(await caller(db, 'nobody').account.export({ table: 'task', cursor: null })).toEqual({
      rows: [],
      next: null,
    });
    expect(await admin.select().from(appUsers)).toEqual([]);
  });
});

describe('account.import', () => {
  it('moves a whole board: delete, set the same key up again, import, and it is the same board', async () => {
    const { token } = await seed();
    const jascha = caller(db);
    const before = await exportEverything(jascha);
    await jascha.account.delete({ username: 'jascha' });
    await jascha.keys.setup({ keyId: KEY, slots: slots() });
    const results = await importEverything(jascha, before);
    expect(results).toEqual([
      { inserted: 3, existing: 0, invalid: 0, orphaned: 0 },
      { inserted: 1, existing: 0, invalid: 0, orphaned: 0 },
      { inserted: 3, existing: 0, invalid: 0, orphaned: 0 },
      { inserted: 1, existing: 0, invalid: 0, orphaned: 0 },
      { inserted: 1, existing: 0, invalid: 0, orphaned: 0 },
      { inserted: 1, existing: 0, invalid: 0, orphaned: 0 },
      { inserted: 1, existing: 0, invalid: 0, orphaned: 0 },
      { inserted: 1, existing: 0, invalid: 0, orphaned: 0 },
      { inserted: 1, existing: 0, invalid: 0, orphaned: 0 },
      { inserted: 2, existing: 0, invalid: 0, orphaned: 0 },
    ]);
    const after = await exportEverything(jascha);
    const running = (rows: Rows) => rows.find((row) => row['id'] === 'running1');
    expect(after.task.filter((row) => row['id'] !== 'running1')).toEqual(
      before.task.filter((row) => row['id'] !== 'running1'),
    );
    expect(after.task.find((row) => row['id'] === 'child1')).toMatchObject({ parentId: 'parent1' });
    expect(running(after.task)).toMatchObject({ status: 'needs-me' });
    for (const table of ACCOUNT_TABLES.filter((name) => name !== 'task' && name !== 'note'))
      expect(after[table]).toEqual(before[table]);
    expect(after.schedule[0]).toMatchObject({ occurrenceTaskId: 'child1' });
    expect(after.note.map((row) => row['id'])).toEqual(before.note.map((row) => row['id']));

    const app = await buildServer(testConfig, db);
    const version = await app.inject({
      method: 'POST',
      url: '/api/machine/version',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(version.statusCode).toBe(200);
    expect(version.json().result).toMatchObject({ owner: 'jascha', keyId: KEY });
    await app.close();
  });

  it('puts the rows under whoever imports them', async () => {
    await seed('jascha');
    const data = await exportEverything(caller(db, 'jascha'));
    await caller(db, 'jascha').account.delete({ username: 'jascha' });
    const carol = caller(db, 'carol');
    await carol.keys.setup({ keyId: KEY, slots: slots() });
    const named = (row: Rows[number]) => ({ ...row, owner: 'jascha' });
    const withOwner: Record<AccountTable, Rows> = {
      task: data.task.map(named),
      schedule: data.schedule.map(named),
      note: data.note.map(named),
      task_pr: data.task_pr.map(named),
      machine: data.machine.map(named),
      shared_agents: data.shared_agents.map(named),
      link_rules: data.link_rules.map(named),
      title_rules: data.title_rules.map(named),
      transcript_run: data.transcript_run.map(named),
      transcript_event: data.transcript_event.map(named),
    };
    await importEverything(carol, withOwner);
    expect(await countsOf('carol')).toBe(15);
    expect(await countsOf('jascha')).toBe(0);
  });

  it('is idempotent: a second import changes nothing and counts every row as existing', async () => {
    await seed();
    const jascha = caller(db);
    const data = await exportEverything(jascha);
    const results = await importEverything(jascha, data);
    expect(results.map(({ inserted, existing }) => [inserted, existing])).toEqual([
      [0, 3],
      [0, 1],
      [0, 3],
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 2],
    ]);
    expect(await exportEverything(jascha)).toEqual(data);
  });

  it('counts a row that clashes with another user’s unique value as existing, and says no more', async () => {
    await seed('carol');
    const carolsTask = (await exportAll(caller(db, 'carol'), 'task'))[0]!;
    const carolsMachine = (await exportAll(caller(db, 'carol'), 'machine'))[0]!;
    const jascha = caller(db);
    await jascha.keys.setup({ keyId: KEY, slots: slots() });
    expect(await jascha.account.import({ keyId: KEY, table: 'task', rows: [carolsTask] })).toEqual({
      inserted: 0,
      existing: 1,
      invalid: 0,
      orphaned: 0,
    });
    expect(await jascha.account.import({ keyId: KEY, table: 'machine', rows: [carolsMachine] })).toEqual({
      inserted: 0,
      existing: 1,
      invalid: 0,
      orphaned: 0,
    });
    expect(await jascha.account.summary()).toMatchObject({ tasks: 0, machines: 0 });
  });

  it('counts invalid and orphaned rows and skips them without failing the batch', async () => {
    const jascha = caller(db);
    await jascha.keys.setup({ keyId: KEY, slots: slots() });
    const now = '2026-03-01T10:00:00.123456Z';
    const task = (id: string, more: object = {}) => ({
      id,
      title: SEALED,
      input: SEALED,
      status: 'todo',
      position: 1,
      createdAt: now,
      updatedAt: now,
      ...more,
    });
    const result = await jascha.account.import({
      keyId: KEY,
      table: 'task',
      rows: [
        task('good1'),
        task('good2', { parentId: 'good1' }),
        task('orphanparent', { parentId: 'nowhere' }),
        task('badtitle', { title: 'plain text' }),
        task('bad id'),
        task('badstatus', { status: 'sleeping' }),
        task('baddate', { createdAt: 'yesterday' }),
        task('badmodel', { model: '--evil' }),
        task('badeffort', { effort: 'huge' }),
        task('badicon', { icon: '🚀' }),
        task('badlabels', { labels: '["bug"]' }),
        task('badmachine', { machine: 'a b' }),
        task('badlane', { requestedLane: 'a b' }),
        task('badindex', { dedupeKey: 'abh1.short' }),
        'not an object',
        null,
      ],
    });
    expect(result).toEqual({ inserted: 3, existing: 0, invalid: 13, orphaned: 0 });
    const rows = await exportAll(jascha, 'task');
    expect(rows.map((row) => [row['id'], row['parentId']])).toEqual([
      ['good1', null],
      ['good2', 'good1'],
      ['orphanparent', null],
    ]);
    expect(rows[0]!['createdAt']).toBe(now);
    expect(
      await jascha.account.import({
        keyId: KEY,
        table: 'task',
        rows: [task('lane1', { requestedLane: 'reviews' }), task('lane2', { requestedLane: null })],
      }),
    ).toMatchObject({ inserted: 2 });
    expect(
      (await exportAll(jascha, 'task'))
        .filter((row) => String(row['id']).startsWith('lane'))
        .map((row) => row['requestedLane']),
    ).toEqual(['reviews', null]);

    const note = (id: string, more: object = {}) => ({
      id,
      taskId: 'good1',
      author: 'agent',
      kind: 'comment',
      body: SEALED,
      createdAt: now,
      ...more,
    });
    expect(
      await jascha.account.import({
        keyId: KEY,
        table: 'note',
        rows: [
          note('ok1'),
          note('ok2', { author: 'server', kind: 'event', body: 'Reopened.' }),
          note('lost1', { taskId: 'gone' }),
          note('plain', { body: 'plain text' }),
          note('fake', { author: 'server', kind: 'event', body: 'anything the server never says' }),
          note('serverchat', { author: 'server', kind: 'comment', body: 'Closed.' }),
          note('suggested', { author: 'user', suggestion: SEALED }),
        ],
      }),
    ).toEqual({ inserted: 2, existing: 0, invalid: 4, orphaned: 1 });

    expect(
      await jascha.account.import({
        keyId: KEY,
        table: 'transcript_event',
        rows: [
          { runId: RUN, seq: 0, at: now, kind: 'text', data: SEALED },
          { runId: RUN, seq: -1, at: now, kind: 'text', data: SEALED },
        ],
      }),
    ).toEqual({ inserted: 0, existing: 0, invalid: 1, orphaned: 1 });
    expect(
      await jascha.account.import({
        keyId: KEY,
        table: 'transcript_run',
        rows: [{ id: RUN, taskId: 'missing', machine: 'laptop', startedAt: now, lastEventAt: now }],
      }),
    ).toEqual({ inserted: 0, existing: 0, invalid: 0, orphaned: 1 });
    expect(
      await jascha.account.import({
        keyId: KEY,
        table: 'task_pr',
        rows: [{ id: 'pr9', taskId: 'missing', pr: SEALED, createdAt: now }],
      }),
    ).toEqual({ inserted: 0, existing: 0, invalid: 0, orphaned: 1 });
  });

  describe('schedules and the columns of later migrations', () => {
    const now = '2026-03-01T10:00:00.123456Z';
    const schedule = (id: string, more: object = {}) => ({
      id,
      title: SEALED,
      input: SEALED,
      anchorAt: now,
      createdAt: now,
      cron: '0 9 * * 1',
      timezone: 'Europe/Berlin',
      ...more,
    });
    const task = (id: string, more: object = {}) => ({
      id,
      title: SEALED,
      input: SEALED,
      position: 1,
      createdAt: now,
      updatedAt: now,
      ...more,
    });
    const ready = async () => {
      const jascha = caller(db);
      await jascha.keys.setup({ keyId: KEY, slots: slots() });
      return jascha;
    };
    const importSchedules = (client: Client, rows: unknown[]) =>
      client.account.import({ keyId: KEY, table: 'schedule', rows });

    it('keeps the lane a task or a schedule asks for, and drops a row whose lane is not a name', async () => {
      const jascha = await ready();
      expect(
        await jascha.account.import({
          keyId: KEY,
          table: 'task',
          rows: [task('lt1', { requestedLane: 'reviews' }), task('lt2'), task('lt3', { requestedLane: 'a b' })],
        }),
      ).toEqual({ inserted: 2, existing: 0, invalid: 1, orphaned: 0 });
      expect(
        await importSchedules(jascha, [
          schedule('ls1', { requestedLane: 'docs' }),
          schedule('ls2', { requestedLane: 'x'.repeat(65) }),
        ]),
      ).toEqual({ inserted: 1, existing: 0, invalid: 1, orphaned: 0 });
      expect((await exportAll(jascha, 'task')).map((row) => [row['id'], row['requestedLane']])).toEqual([
        ['lt1', 'reviews'],
        ['lt2', null],
      ]);
      expect((await exportAll(jascha, 'schedule')).map((row) => row['requestedLane'])).toEqual(['docs']);
    });

    it('keeps auto done, who moved a task, when its occurrence finished, and every schedule setting', async () => {
      const jascha = await ready();
      await jascha.account.import({
        keyId: KEY,
        table: 'task',
        rows: [task('t1', { autoDone: true, movedBy: 'agent', occurrenceFinishedAt: '2026-03-02T11:00:00.654321Z' })],
      });
      expect(
        await importSchedules(jascha, [
          schedule('s1', {
            autoDone: true,
            moreCrons: ['30 18 * * 5'],
            maxConcurrent: 3,
            occurrenceTaskId: 't1',
          }),
          schedule('s2', { cron: null, timezone: null, afterScheduleId: 's1', afterDelayMs: 90_000 }),
        ]),
      ).toEqual({ inserted: 2, existing: 0, invalid: 0, orphaned: 0 });
      const [t1] = await exportAll(jascha, 'task');
      expect(t1).toMatchObject({
        autoDone: true,
        movedBy: 'agent',
        occurrenceFinishedAt: '2026-03-02T11:00:00.654321Z',
      });
      const rows = await exportAll(jascha, 'schedule');
      expect(rows.find((row) => row['id'] === 's1')).toMatchObject({
        autoDone: true,
        moreCrons: ['30 18 * * 5'],
        maxConcurrent: 3,
        occurrenceTaskId: 't1',
        pausedAt: null,
      });
      expect(rows.find((row) => row['id'] === 's2')).toMatchObject({ afterScheduleId: 's1', afterDelayMs: 90_000 });
    });

    it('adds a schedule that runs after one later in the file, and counts one whose upstream is missing as orphaned', async () => {
      const jascha = await ready();
      const result = await importSchedules(jascha, [
        schedule('later', { cron: null, timezone: null, afterScheduleId: 'first', afterDelayMs: 0 }),
        schedule('first'),
        schedule('nowhere', { cron: null, timezone: null, afterScheduleId: 'gone', afterDelayMs: 0 }),
        schedule('loopa', { cron: null, timezone: null, afterScheduleId: 'loopb', afterDelayMs: 0 }),
        schedule('loopb', { cron: null, timezone: null, afterScheduleId: 'loopa', afterDelayMs: 0 }),
        schedule('behind', { cron: null, timezone: null, afterScheduleId: 'nowhere', afterDelayMs: 0 }),
        schedule('myself', { cron: null, timezone: null, afterScheduleId: 'myself', afterDelayMs: 0 }),
      ]);
      expect(result).toEqual({ inserted: 2, existing: 0, invalid: 1, orphaned: 4 });
      expect((await exportAll(jascha, 'schedule')).map((row) => [row['id'], row['afterScheduleId']])).toEqual([
        ['first', null],
        ['later', 'first'],
      ]);
      expect(
        await importSchedules(jascha, [
          schedule('next', { cron: null, timezone: null, afterScheduleId: 'later', afterDelayMs: 5 }),
        ]),
      ).toMatchObject({ inserted: 1 });
    });

    it('orphans a schedule that runs after a schedule held by another account', async () => {
      await seed('carol');
      const jascha = await ready();
      expect(
        await importSchedules(jascha, [
          schedule('mine', { cron: null, timezone: null, afterScheduleId: 'sched1-carol', afterDelayMs: 0 }),
        ]),
      ).toEqual({ inserted: 0, existing: 0, invalid: 0, orphaned: 1 });
    });

    it('can be deleted with the account when schedules run after each other', async () => {
      const jascha = await ready();
      await importSchedules(jascha, [
        schedule('a1'),
        schedule('a2', { cron: null, timezone: null, afterScheduleId: 'a1', afterDelayMs: 0 }),
        schedule('a3', { cron: null, timezone: null, afterScheduleId: 'a2', afterDelayMs: 0 }),
      ]);
      await jascha.account.delete({ username: 'jascha' });
      expect(await admin.select().from(schedules)).toEqual([]);
    });

    it('refuses the rules the service refuses, and rules the database would', async () => {
      const jascha = await ready();
      const after = { cron: null, timezone: null, afterScheduleId: 'ok1', afterDelayMs: 0 };
      const result = await importSchedules(jascha, [
        schedule('ok1'),
        schedule('ok2', { cron: null, timezone: null, everyMs: 60_000 }),
        schedule('short', { cron: null, timezone: null, everyMs: 59_999 }),
        schedule('huge', { cron: null, timezone: null, everyMs: Number.MAX_SAFE_INTEGER }),
        schedule('both', { everyMs: 120_000 }),
        schedule('neither', { cron: null, timezone: null }),
        schedule('afterandcron', { ...after, cron: '0 9 * * 1', timezone: 'UTC' }),
        schedule('badcron', { cron: '99 99 * * *' }),
        schedule('sentence', { cron: 'run this every day please' }),
        schedule('notz', { timezone: 'Mars/Olympus' }),
        schedule('notzset', { timezone: null }),
        schedule('tzwithinterval', { cron: null, everyMs: 120_000 }),
        schedule('twice', { moreCrons: ['0 9 * * 1'] }),
        schedule('manycrons', { moreCrons: Array.from({ length: 10 }, (_, hour) => `0 ${hour} * * 2`) }),
        schedule('moreonly', { cron: null, timezone: null, everyMs: 120_000, moreCrons: ['0 9 * * 1'] }),
        schedule('limit0', { maxConcurrent: 0 }),
        schedule('limit101', { maxConcurrent: 101 }),
        schedule('delaynoafter', { cron: null, timezone: null, everyMs: 120_000, afterDelayMs: 5 }),
        schedule('afternodelay', { ...after, afterDelayMs: null }),
        schedule('negdelay', { ...after, afterDelayMs: -1 }),
        schedule('bigdelay', { ...after, afterDelayMs: Number.MAX_SAFE_INTEGER }),
      ]);
      expect(result).toEqual({ inserted: 2, existing: 0, invalid: 19, orphaned: 0 });
    });

    it('pauses an active schedule whose pending occurrence is not on the board, and Resume makes the next one', async () => {
      const jascha = await ready();
      const stamp = '2026-03-02T00:00:00Z';
      await importSchedules(jascha, [
        schedule('active', { occurrenceTaskId: 'gone' }),
        schedule('paused', { occurrenceTaskId: 'gone', pausedAt: stamp }),
        schedule('ended', { occurrenceTaskId: 'gone', endedAt: stamp }),
        schedule('plain'),
        schedule('waiting', { cron: null, timezone: null, afterScheduleId: 'plain', afterDelayMs: 0 }),
        schedule('lostwaiting', {
          cron: null,
          timezone: null,
          afterScheduleId: 'plain',
          afterDelayMs: 0,
          occurrenceTaskId: 'gone',
        }),
      ]);
      const byId = async () =>
        Object.fromEntries((await exportAll(jascha, 'schedule')).map((row) => [row['id'] as string, row]));
      const rows = await byId();
      expect(rows['active']).toMatchObject({ occurrenceTaskId: null, pausedAt: expect.any(String) });
      expect(rows['paused']).toMatchObject({ occurrenceTaskId: null, pausedAt: '2026-03-02T00:00:00.000000Z' });
      expect(rows['ended']).toMatchObject({ occurrenceTaskId: null, pausedAt: null });
      expect(rows['plain']).toMatchObject({ pausedAt: null });
      expect(rows['waiting']).toMatchObject({ pausedAt: null, occurrenceTaskId: null });
      expect(rows['lostwaiting']).toMatchObject({ pausedAt: expect.any(String) });

      await jascha.schedules.setPaused({ id: 'active', paused: false });
      const resumed = (await byId())['active']!;
      expect(resumed['pausedAt']).toBeNull();
      expect(resumed['occurrenceTaskId']).toEqual(expect.any(String));
      expect(await jascha.account.summary()).toMatchObject({ tasks: 1 });
    });

    it('lands the rest of a batch when a row has a time or text the database refuses', async () => {
      const jascha = await ready();
      const rows = [
        task('fine1'),
        task('year0', { createdAt: '0000-06-01T00:00:00Z' }),
        task('year0b', { updatedAt: '0000-01-01T00:00:00.000000+00:00' }),
        task('before1', { closedAt: '0000-12-31T23:59:59Z' }),
        task('fine2', { createdAt: '0001-01-01T00:00:00Z', updatedAt: '9999-12-31T23:59:59Z' }),
        task('toolate', { updatedAt: '9999-12-31T23:59:59.999999Z' }),
        task('nulmodel', { model: 'opus\u0000' }),
        task('nulmachine', { machine: 'lap\u0000top' }),
        task('fine3'),
      ];
      expect(await jascha.account.import({ keyId: KEY, table: 'task', rows })).toEqual({
        inserted: 3,
        existing: 0,
        invalid: 6,
        orphaned: 0,
      });
      expect((await exportAll(jascha, 'task')).map((row) => row['id']).sort()).toEqual(['fine1', 'fine2', 'fine3']);

      expect(
        await importSchedules(jascha, [
          schedule('okcron'),
          schedule('nulcron', { cron: '0 9 * * 1\u0000' }),
          schedule('newlinecron', { cron: '0 9 * * 1\n' }),
          schedule('nultz', { timezone: 'UTC\u0000' }),
          schedule('nulmore', { moreCrons: ['0 9 * * 2\u0000'] }),
          schedule('year0', { anchorAt: '0000-01-01T00:00:00Z' }),
        ]),
      ).toEqual({ inserted: 1, existing: 0, invalid: 5, orphaned: 0 });

      const note = (id: string, more: object = {}) => ({
        id,
        taskId: 'fine1',
        author: 'agent',
        kind: 'comment',
        body: SEALED,
        createdAt: now,
        ...more,
      });
      expect(
        await jascha.account.import({
          keyId: KEY,
          table: 'note',
          rows: [note('n1'), note('n2', { by: 'sam\u0000' }), note('n3', { createdAt: '0000-01-01T00:00:00Z' })],
        }),
      ).toEqual({ inserted: 1, existing: 0, invalid: 2, orphaned: 0 });

      const machine = (name: string, more: object = {}) => ({
        name,
        tokenHash: name.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a'),
        createdAt: now,
        ...more,
      });
      expect(
        await jascha.account.import({
          keyId: KEY,
          table: 'machine',
          rows: [
            machine('m1'),
            machine('m2', { clientVersion: '1.0\u0000' }),
            machine('m3', { revokedAt: '0000-01-01T00:00:00Z' }),
          ],
        }),
      ).toEqual({ inserted: 1, existing: 0, invalid: 2, orphaned: 0 });

      const run = { taskId: 'fine1', startedAt: now, lastEventAt: now };
      expect(
        await jascha.account.import({
          keyId: KEY,
          table: 'transcript_run',
          rows: [
            { id: RUN, machine: 'laptop', ...run },
            { id: 'run-0002-aaaa', machine: 'lap\u0000top', ...run },
            { id: 'run-0003-aaaa', machine: 'laptop', ...run, startedAt: '0000-01-01T00:00:00Z' },
          ],
        }),
      ).toEqual({ inserted: 1, existing: 0, invalid: 2, orphaned: 0 });
    });
  });

  it('drops an occurrence task that is not on the board, and takes no more than 1000 rows', async () => {
    const jascha = caller(db);
    await jascha.keys.setup({ keyId: KEY, slots: slots() });
    const now = '2026-03-01T10:00:00Z';
    const schedule = { id: 'sched9', title: SEALED, input: SEALED, anchorAt: now, createdAt: now };
    expect(
      await jascha.account.import({
        keyId: KEY,
        table: 'schedule',
        rows: [{ ...schedule, occurrenceTaskId: 'nowhere', everyMs: 60_000 }],
      }),
    ).toMatchObject({ inserted: 1 });
    expect((await exportAll(jascha, 'schedule'))[0]).toMatchObject({
      occurrenceTaskId: null,
      pausedAt: expect.any(String),
    });
    await expect(
      jascha.account.import({ keyId: KEY, table: 'task', rows: Array.from({ length: 1001 }, () => ({})) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('brings a running task in as a task in Needs me, with the run cleared, and no note pending', async () => {
    await seed();
    const jascha = caller(db);
    const data = await exportEverything(jascha);
    expect(data.task.find((row) => row['id'] === 'running1')).toMatchObject({
      status: 'running',
      inboxRead: true,
      stopMessageId: 'stopmsg1',
    });
    await jascha.account.delete({ username: 'jascha' });
    await jascha.keys.setup({ keyId: KEY, slots: slots() });
    await importEverything(jascha, data);
    const [running] = await admin.select().from(tasks).where(eq(tasks.id, 'running1'));
    expect(running).toMatchObject({
      status: 'needs-me',
      runId: null,
      runStartedAt: null,
      stopRequestedAt: null,
      stopMessageId: null,
      inboxRead: false,
      pausedAt: null,
      machine: 'laptop',
    });
    const [pending] = await admin.select().from(notes).where(eq(notes.id, 'note3'));
    expect(pending).toMatchObject({ pending: false, queued: true });
    expect(await jascha.account.summary()).toMatchObject({ running: 0 });
  });

  it('is refused under a different key, and with no key set up, without creating anything', async () => {
    await seed();
    const data = await exportEverything(caller(db));
    await caller(db).account.delete({ username: 'jascha' });
    const jascha = caller(db);
    await expect(jascha.account.import({ keyId: KEY, table: 'task', rows: data.task })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await admin.select().from(appUsers)).toEqual([]);
    await jascha.keys.setup({ keyId: OTHER_KEY, slots: slots() });
    await expect(jascha.account.import({ keyId: KEY, table: 'task', rows: data.task })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await jascha.account.summary()).toMatchObject({ tasks: 0 });
  });

  it('tells the owner’s machines that the board changed', async () => {
    const changes = new Changes();
    const notify = vi.spyOn(changes, 'notify');
    const jascha = caller(db, 'jascha', changes);
    await jascha.keys.setup({ keyId: KEY, slots: slots() });
    expect(notify).not.toHaveBeenCalled();
    await jascha.account.import({ keyId: KEY, table: 'machine', rows: [] });
    expect(notify).toHaveBeenCalledWith('jascha');
    changes.close();
  });
});

describe('account.delete', () => {
  it('refuses another name than the signed-in user’s', async () => {
    await seed();
    await expect(caller(db).account.delete({ username: 'carol' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller(db).account.delete({ username: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await countsOf('jascha')).toBe(15);
  });

  it('removes the user and every table of theirs, and leaves another user alone', async () => {
    const { token } = await seed('jascha');
    const other = await seed('carol');
    const app = await buildServer(testConfig, db);
    const authenticates = async (bearer: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/machine/version',
          headers: { authorization: `Bearer ${bearer}` },
          payload: {},
        })
      ).statusCode;
    expect(await authenticates(token)).toBe(200);

    await caller(db).account.delete({ username: 'jascha' });

    expect(await admin.select().from(appUsers)).toMatchObject([{ username: 'carol' }]);
    expect(await countsOf('jascha')).toBe(0);
    for (const table of [tasks, schedules, notes, taskPrs, machines, transcriptRuns, transcriptEvents])
      expect(await admin.select().from(table).where(eq(table.owner, 'jascha'))).toEqual([]);
    expect(await authenticates(token)).toBe(401);
    expect(await authenticates(other.token)).toBe(200);
    expect(await countsOf('carol')).toBe(15);
    await app.close();
  });

  it('is not brought back by a query, only by a mutation', async () => {
    await seed();
    const jascha = caller(db);
    await jascha.account.delete({ username: 'jascha' });
    expect(await admin.select().from(appUsers)).toEqual([]);
    expect(await jascha.me()).toEqual({ username: 'jascha', keyId: null });
    expect(await jascha.tasks.list()).toEqual([]);
    expect(await jascha.account.summary()).toMatchObject({ tasks: 0 });
    expect(await admin.select().from(appUsers)).toEqual([]);
    await jascha.keys.setup({ keyId: KEY, slots: slots() });
    expect(await admin.select().from(appUsers)).toMatchObject([{ username: 'jascha', keyId: KEY }]);
  });

  it('deletes a user whose row a mutation just created', async () => {
    await caller(db, 'fresh').account.delete({ username: 'fresh' });
    expect(await admin.select().from(appUsers)).toEqual([]);
  });
});

describe('account.delete and the machine streams', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let url: string;
  const controllers: AbortController[] = [];

  beforeEach(async () => {
    // A ping every minute: only the deletion itself can end a stream within the test.
    app = await buildServer(testConfig, db, { changes: new Changes(), pingMs: 60_000 });
    url = await app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterEach(async () => {
    controllers.splice(0).forEach((controller) => controller.abort());
    await app.close();
  });

  async function openStream(token: string) {
    const controller = new AbortController();
    controllers.push(controller);
    const res = await fetch(`${url}/api/machine/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    let text = '';
    let ended = false;
    const reader = res.body!.getReader();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += new TextDecoder().decode(value);
        }
      } catch {
        // Aborted by the test.
      }
      ended = true;
    })();
    await vi.waitFor(() => expect(text).toContain(': connected'), { timeout: 3000, interval: 10 });
    return { isEnded: () => ended };
  }

  it('ends the deleted user’s streams at once, and no one else’s', async () => {
    const { token } = await seed('jascha');
    const carol = await seed('carol');
    const mine = await openStream(token);
    const second = await openStream(token);
    const hers = await openStream(carol.token);
    const res = await fetch(`${url}/trpc/account.delete`, {
      method: 'POST',
      headers: { 'remote-user': 'jascha', 'remote-groups': 'admins', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'jascha' }),
    });
    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(mine.isEnded() && second.isEnded()).toBe(true), { timeout: 3000, interval: 10 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hers.isEnded()).toBe(false);
  });
});
