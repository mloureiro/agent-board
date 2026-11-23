import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, ensureAppRole, runMigrations } from './client';
import { isPgliteUrl } from './pglite';
import { withOwner } from './scope';
import { testDatabaseUrl } from '../test/global-setup';
import { SEALED } from '../test/helpers';
import {
  migrationsBefore,
  pgliteScratchDir,
  pgliteUrl,
  removeFolder,
  SCRATCH_MIGRATION_TIMEOUT,
} from '../test/scratch';

const TABLES = ['app_user', 'task', 'task_pr', 'schedule', 'note', 'machine', 'transcript_run', 'transcript_event'];

// On Postgres, migration.integration.test.ts covers upgrades from older databases, using scratch databases that PGlite cannot create.
describe.skipIf(!isPgliteUrl(testDatabaseUrl()))(
  'upgrading a populated PGlite data directory',
  { timeout: SCRATCH_MIGRATION_TIMEOUT },
  () => {
    it('keeps every row when the migrations added since are applied after a restart', async () => {
      const dir = pgliteScratchDir();
      const folder = migrationsBefore('_task-watches');
      const open = async () => ({
        admin: await createDb(pgliteUrl(dir)),
        app: await createDb(pgliteUrl(dir, 'board_app:board_app')),
      });
      try {
        const old = await open();
        await ensureAppRole(old.admin.db, pgliteUrl(dir, 'board_app:board_app'));
        await migrate(old.admin.db, { migrationsFolder: folder });
        await withOwner(old.app.db, 'alice', async (tx) => {
          await tx.execute(sql`insert into app_user (username) values ('alice')`);
          await tx.execute(sql`
            insert into task (id, title, input, position) values ('t1', ${SEALED}, ${SEALED}, 0)`);
          await tx.execute(sql`insert into task_pr (id, task_id, pr) values ('p1', 't1', ${SEALED})`);
          await tx.execute(sql`
            insert into schedule (id, title, input, every_ms, anchor_at) values ('s1', ${SEALED}, ${SEALED}, 1000, now())`);
          await tx.execute(sql`
            insert into note (id, task_id, author, kind, body) values ('n1', 't1', 'agent', 'comment', ${SEALED})`);
          await tx.execute(sql`insert into machine (name, token_hash) values ('laptop', 'hash')`);
          await tx.execute(sql`
            insert into transcript_run (id, task_id, machine, started_at, last_event_at) values ('r1', 't1', 'laptop', now(), now())`);
          await tx.execute(sql`
            insert into transcript_event (run_id, seq, at, kind, data) values ('r1', 0, now(), 'note', ${SEALED})`);
        });
        await Promise.all([old.admin.pool.end(), old.app.pool.end()]);

        const upgraded = await open();
        try {
          await runMigrations(upgraded.admin.db);
          const counts = await withOwner(upgraded.app.db, 'alice', async (tx) =>
            Promise.all(
              TABLES.map(async (table) => {
                const { rows } = await tx.execute<{ n: number }>(
                  sql`select count(*)::int as n from ${sql.identifier(table)}`,
                );
                return [table, rows[0]?.n];
              }),
            ),
          );
          expect(Object.fromEntries(counts)).toEqual(Object.fromEntries(TABLES.map((table) => [table, 1])));
          const { rows } = await upgraded.admin.db.execute<{ watch_stops: string[] }>(
            sql`select watch_stops from task where id = 't1'`,
          );
          expect(rows).toEqual([{ watch_stops: [] }]);
        } finally {
          await Promise.all([upgraded.admin.pool.end(), upgraded.app.pool.end()]);
        }
      } finally {
        removeFolder(folder);
        removeFolder(dir);
      }
    });
  },
);

describe.skipIf(!isPgliteUrl(testDatabaseUrl()))('the PGlite start settings', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('PGLITE_SHARED_BUFFERS reaches the database', async () => {
    vi.stubEnv('PGLITE_SHARED_BUFFERS', '8MB');
    const dir = pgliteScratchDir();
    const { pool } = await createDb(pgliteUrl(dir));
    try {
      expect((await pool.query('show shared_buffers')).rows).toEqual([{ shared_buffers: '8MB' }]);
    } finally {
      await pool.end();
      removeFolder(dir);
    }
  });

  it('names the file PGLITE_ASSETS_DIR lacks', async () => {
    const empty = pgliteScratchDir();
    vi.stubEnv('PGLITE_ASSETS_DIR', empty);
    const dir = pgliteScratchDir();
    try {
      await expect(createDb(pgliteUrl(dir))).rejects.toThrow('has no readable pglite.wasm');
    } finally {
      removeFolder(empty);
      removeFolder(dir);
    }
  });
});
