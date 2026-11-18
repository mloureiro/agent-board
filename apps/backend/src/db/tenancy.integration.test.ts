import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { Changes } from '../services/changes';
import { AppError } from '../services/errors';
import { testAppDatabaseUrl, testDatabaseUrl } from '../test/global-setup';
import { SEALED, testConfig, useTestDb } from '../test/helpers';
import { procedure, router } from '../trpc/trpc';
import { appUsers, tasks } from './schema';
import { assertUnprivileged, createDb, ensureAppRole } from './client';

const { db, admin } = await useTestDb();

const roleFlags = async () => {
  const { rows } = await admin.execute<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
  }>(sql`select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole from pg_roles where rolname = 'board_app'`);
  return rows;
};

const currentOwner = async (handle: typeof db) => {
  const { rows } = await handle.execute<{ owner: string | null }>(
    sql`select current_setting('app.owner', true) as owner`,
  );
  return rows[0]?.owner;
};

describe('the app role', () => {
  it('is created idempotently, can log in, and bypasses nothing', async () => {
    await ensureAppRole(admin, testAppDatabaseUrl());
    await ensureAppRole(admin, testAppDatabaseUrl());
    expect(await roleFlags()).toEqual([
      { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false },
    ]);
    const { pool } = await createDb(testAppDatabaseUrl());
    try {
      expect((await pool.query('select current_user as name')).rows).toEqual([{ name: 'board_app' }]);
    } finally {
      await pool.end();
    }
  });

  it('refuses the admin URL and any other role name', async () => {
    await expect(ensureAppRole(admin, testDatabaseUrl())).rejects.toThrow('must connect as board_app');
    const asAdminUser = new URL(testAppDatabaseUrl());
    asAdminUser.username = new URL(testDatabaseUrl()).username;
    await expect(ensureAppRole(admin, asAdminUser.toString())).rejects.toThrow('must connect as board_app');
  });

  it('is accepted at startup, while the admin connection is not', async () => {
    await expect(assertUnprivileged(db)).resolves.toBeUndefined();
    await expect(assertUnprivileged(admin)).rejects.toThrow('is a superuser');
  });

  it('is rejected at startup when it is a member of the table owner', async () => {
    const { rows } = await admin.execute<{ name: string }>(sql`select current_user as name`);
    const owner = sql.identifier(rows[0]!.name);
    try {
      await admin.execute(sql`grant ${owner} to board_app`);
      await expect(assertUnprivileged(db)).rejects.toThrow('member of the owner');
    } finally {
      await admin.execute(sql`revoke ${owner} from board_app`);
    }
  });
});

describe('request scoping', () => {
  const probe = router({
    owner: procedure.query(({ ctx }) => currentOwner(ctx.db)),
    writeThenFail: procedure.mutation(async ({ ctx }) => {
      await ctx.db.insert(tasks).values({ id: 'rollback1', title: SEALED, input: SEALED, position: 0 });
      throw new AppError('CONFLICT', 'nope');
    }),
    writeThenCrash: procedure.mutation(async ({ ctx }) => {
      await ctx.db.insert(tasks).values({ id: 'rollback2', title: SEALED, input: SEALED, position: 0 });
      throw new Error('boom');
    }),
    write: procedure.mutation(({ ctx }) =>
      ctx.db.insert(tasks).values({ id: 'committed', title: SEALED, input: SEALED, position: 0 }),
    ),
  });
  const call = () => probe.createCaller({ root: db, config: testConfig, changes: new Changes(), username: 'jascha' });
  const ids = async () => (await admin.select({ id: tasks.id }).from(tasks)).map(({ id }) => id);

  it('rolls back what a failed procedure wrote, and keeps the mapped error', async () => {
    await expect(call().writeThenFail()).rejects.toMatchObject({ code: 'CONFLICT', message: 'nope' });
    await expect(call().writeThenCrash()).rejects.toThrow('boom');
    expect(await ids()).toEqual([]);
  });

  it('commits what a successful procedure wrote', async () => {
    await call().write();
    expect(await ids()).toEqual(['committed']);
  });

  it('provisions a user when a mutation commits, and not for a query or a failed mutation', async () => {
    const users = async () => (await admin.select().from(appUsers)).map(({ username }) => username);
    const carol = probe.createCaller({ root: db, config: testConfig, changes: new Changes(), username: 'carol' });
    await expect(carol.writeThenFail()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await users()).toEqual([]);
    await carol.owner();
    expect(await users()).toEqual([]);
    await carol.write();
    expect(await users()).toEqual(['carol']);
  });

  it('sets app.owner inside the procedure and not on the connection afterwards', async () => {
    expect(await call().owner()).toBe('jascha');
    expect(await currentOwner(db)).toBeFalsy();
  });
});
