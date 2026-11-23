import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  migrationsBefore,
  removeFolder,
  SCRATCH_MIGRATION_TIMEOUT,
  SCRATCH_TEARDOWN_TIMEOUT,
  scratchDatabases,
} from '../test/scratch';
import { createDb, runMigrations, type Db } from './client';

// Each test gets a new database: dropping one is slow under load (see SCRATCH_TEARDOWN_TIMEOUT), so all go at the end.
const scratch = scratchDatabases('migration');
let scratchUrl: string;

/** The pool of the current test's scratch database that the test later drops: a connection it kills is no failure. */
function scratchDb(options: { backfillOwner?: string } = {}): ReturnType<typeof createDb> {
  return createDb(scratchUrl, { ...options, onError: () => undefined });
}

// These tests are about the migrations up to 0013, with plain text in the rows; the sealed-content constraints of a later release would refuse it.
let currentFolder: string | undefined;
afterAll(async () => {
  if (currentFolder !== undefined) removeFolder(currentFolder);
  await scratch.dropAll();
}, SCRATCH_TEARDOWN_TIMEOUT);

const migrateToCurrent = async (db: Db): Promise<void> => {
  currentFolder ??= migrationsBefore('_sealed_content_constraints');
  await migrate(db, { migrationsFolder: currentFolder });
};

describe('the tenancy migration on a database that already has rows', { timeout: SCRATCH_MIGRATION_TIMEOUT }, () => {
  let old: Awaited<ReturnType<typeof createDb>>;
  let folder: string;

  beforeEach(async () => {
    if (old) await old.pool.end();
    scratchUrl = await scratch.create();
    folder ??= migrationsBefore('_tenancy');
    old = await scratchDb();
    await migrate(old.db, { migrationsFolder: folder });
    await old.db.execute(sql`insert into task (id, title, input, position) values ('t1', 'old', 'x', 0)`);
    await old.db.execute(sql`insert into note (id, task_id, author, kind) values ('n1', 't1', 'user', 'comment')`);
    await old.db.execute(sql`insert into machine (name, token_hash) values ('laptop', 'h')`);
    await old.db.execute(
      sql`insert into transcript_run (id, task_id, machine, started_at, last_event_at) values ('r1', 't1', 'laptop', now(), now())`,
    );
    await old.db.execute(
      sql`insert into transcript_event (run_id, seq, at, kind, data) values ('r1', 0, now(), 'text', '{}')`,
    );
  }, SCRATCH_MIGRATION_TIMEOUT);

  afterAll(async () => {
    await old.pool.end();
    removeFolder(folder);
  });

  const owners = async (db: Db, table: string) =>
    (await db.execute<{ owner: string }>(sql`select owner from ${sql.identifier(table)}`)).rows.map((r) => r.owner);

  it('fails and changes nothing without BACKFILL_OWNER', async () => {
    const run = await scratchDb();
    try {
      await expect(runMigrations(run.db)).rejects.toThrow(/BACKFILL_OWNER/);
      const { rows } = await run.db.execute(
        sql`select 1 from information_schema.columns where table_name = 'task' and column_name = 'owner'`,
      );
      expect(rows).toEqual([]);
    } finally {
      await run.pool.end();
    }
  });

  it.each(['alice', 'corp\\jane', 'jane doe'])('gives every existing row to BACKFILL_OWNER %j', async (owner) => {
    const run = await scratchDb({ backfillOwner: owner });
    try {
      await migrateToCurrent(run.db);
      for (const table of ['task', 'note', 'machine', 'transcript_run', 'transcript_event'])
        expect(await owners(run.db, table), table).toEqual([owner]);
      const users = await run.db.execute<{ username: string }>(sql`select username from app_user`);
      expect(users.rows).toEqual([{ username: owner }]);
    } finally {
      await run.pool.end();
    }
  });
});

describe(
  'the encrypted content migration on a database that already has rows',
  { timeout: SCRATCH_MIGRATION_TIMEOUT },
  () => {
    let old: Awaited<ReturnType<typeof createDb>>;
    let folder: string;
    const questions = [
      { header: 'Scope', question: 'Q?', multiSelect: false, options: [{ label: 'A', description: '' }] },
    ];

    beforeEach(async () => {
      if (old) await old.pool.end();
      scratchUrl = await scratch.create();
      folder ??= migrationsBefore('_encrypted_content');
      old = await scratchDb();
      await migrate(old.db, { migrationsFolder: folder });
      await old.db.execute(sql`insert into app_user (username) values ('alice')`);
      await old.db.execute(
        sql`insert into task (owner, id, title, input, position, labels) values ('alice', 't1', 'old', 'x', 0, '{review-pr}')`,
      );
      await old.db.execute(sql`
      insert into note (owner, id, task_id, author, kind, body, questions, answers)
      values ('alice', 'n1', 't1', 'agent', 'question', '', ${JSON.stringify(questions)}::jsonb, null),
             ('alice', 'n2', 't1', 'user', 'answer', 'thanks', null, '[{"selected":["A"],"other":"é"}]'::jsonb),
             ('alice', 'n3', 't1', 'system', 'event', 'Marked done.', null, null)`);
      await old.db.execute(
        sql`insert into transcript_run (owner, id, task_id, machine, started_at, last_event_at) values ('alice', 'r1', 't1', 'laptop', now(), now())`,
      );
      await old.db.execute(
        sql`insert into transcript_event (owner, run_id, seq, at, kind, data) values ('alice', 'r1', 0, now(), 'text', ${JSON.stringify({ kind: 'text', text: 'hi "there"' })}::jsonb)`,
      );
    }, SCRATCH_MIGRATION_TIMEOUT);

    afterAll(async () => {
      await old.pool.end();
      removeFolder(folder);
    });

    const columnType = async (table: string, column: string) =>
      (
        await old.db.execute<{ data_type: string }>(
          sql`select data_type from information_schema.columns where table_name = ${table} and column_name = ${column}`,
        )
      ).rows[0]?.data_type;

    it('keeps questions, answers and event data as their JSON text, adds the preview and drops the labels', async () => {
      expect(await columnType('note', 'questions')).toBe('jsonb');
      await migrateToCurrent(old.db);
      for (const [table, column] of [
        ['note', 'questions'],
        ['note', 'answers'],
        ['transcript_event', 'data'],
        ['note', 'preview'],
      ] as const)
        expect(await columnType(table, column), `${table}.${column}`).toBe('text');
      expect(await columnType('task', 'labels')).toBeUndefined();

      const { rows } = await old.db.execute<{
        id: string;
        questions: string | null;
        answers: string | null;
        preview: string | null;
      }>(sql`select id, questions, answers, preview from note order by id`);
      expect(
        rows.map((r) => [
          r.id,
          r.questions === null ? null : JSON.parse(r.questions),
          r.answers === null ? null : JSON.parse(r.answers),
          r.preview,
        ]),
      ).toEqual([
        ['n1', questions, null, null],
        ['n2', null, [{ selected: ['A'], other: 'é' }], null],
        ['n3', null, null, null],
      ]);
      const event = await old.db.execute<{ data: string }>(sql`select data from transcript_event`);
      expect(JSON.parse(event.rows[0]!.data)).toEqual({ kind: 'text', text: 'hi "there"' });
      const task = await old.db.execute<{ title: string; input: string }>(sql`select title, input from task`);
      expect(task.rows).toEqual([{ title: 'old', input: 'x' }]);
    });

    it('accepts the author "server" afterwards', async () => {
      await migrateToCurrent(old.db);
      await old.db.execute(
        sql`insert into note (owner, id, task_id, author, kind, body) values ('alice', 'n4', 't1', 'server', 'event', 'Marked done.')`,
      );
      const { rows } = await old.db.execute<{ author: string }>(sql`select author from note where id = 'n4'`);
      expect(rows).toEqual([{ author: 'server' }]);
    });
  },
);

describe('the task_prs migration on a database that already has rows', { timeout: SCRATCH_MIGRATION_TIMEOUT }, () => {
  const ENVELOPE = `abe1.${'A'.repeat(40)}`;
  let old: Awaited<ReturnType<typeof createDb>>;
  let folder: string;

  beforeEach(async () => {
    if (old) await old.pool.end();
    scratchUrl = await scratch.create();
    folder ??= migrationsBefore('_task_prs');
    old = await scratchDb();
    await migrate(old.db, { migrationsFolder: folder });
    await old.db.execute(sql`insert into app_user (username) values ('alice'), ('bob')`);
    await old.db.execute(sql`
      insert into task (owner, id, title, input, position, pr, pr_state)
      values ('alice', 'with-pr', ${ENVELOPE}, ${ENVELOPE}, 0, ${ENVELOPE}, 'merged'),
             ('alice', 'prompt-only', ${ENVELOPE}, ${ENVELOPE}, 1, null, 'open'),
             ('alice', 'none', ${ENVELOPE}, ${ENVELOPE}, 2, null, null),
             ('bob', 'bobs', ${ENVELOPE}, ${ENVELOPE}, 0, ${ENVELOPE}, null)`);
  }, SCRATCH_MIGRATION_TIMEOUT);

  afterAll(async () => {
    await old.pool.end();
    removeFolder(folder);
  });

  it('turns each reported PR into a row with the state it had, and leaves the prompt PR’s state where there was no report', async () => {
    await runMigrations(old.db);
    const rows = await old.db.execute<{ owner: string; task_id: string; pr: string; state: string | null }>(
      sql`select owner, task_id, pr, state from task_pr order by task_id`,
    );
    expect(rows.rows).toEqual([
      { owner: 'bob', task_id: 'bobs', pr: ENVELOPE, state: null },
      { owner: 'alice', task_id: 'with-pr', pr: ENVELOPE, state: 'merged' },
    ]);
    const tasks = await old.db.execute<{ id: string; pr_state: string | null }>(
      sql`select id, pr_state from task order by id`,
    );
    expect(tasks.rows).toEqual([
      { id: 'bobs', pr_state: null },
      { id: 'none', pr_state: null },
      { id: 'prompt-only', pr_state: 'open' },
      { id: 'with-pr', pr_state: null },
    ]);
  });
});
