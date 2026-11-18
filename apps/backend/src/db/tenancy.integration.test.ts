import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { AppError } from '../services/errors';
import { testAppDatabaseUrl, testDatabaseUrl } from '../test/global-setup';
import { SEALED, testContext, useTestDb } from '../test/helpers';
import { procedure, router } from '../trpc/trpc';
import { appUsers, tasks } from './schema';
import { assertUnprivileged, createDb, ensureAppRole, type DbOrTx } from './client';
import { withOwner } from './scope';

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
  const call = () => probe.createCaller(testContext(db, 'jascha'));
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
    const carol = probe.createCaller(testContext(db, 'carol'));
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

describe('the sign-in tables', () => {
  const seed = async () => {
    await admin.insert(appUsers).values({ username: 'alice' });
    await admin.execute(sql`
      insert into session (token_hash, owner, method, expires_at) values ('h1', 'alice', 'oidc', now() + interval '1 day')`);
    await admin.execute(sql`
      insert into passkey (credential_id, owner, public_key, name) values ('c1', 'alice', 'pk', 'Laptop')`);
  };
  const count = (tx: DbOrTx, table: 'session' | 'passkey') =>
    tx.execute(sql`select 1 from ${sql.identifier(table)}`).then(({ rows }) => rows.length);

  it('shows board_app nothing without an owner, and nothing of another owner', async () => {
    await seed();
    for (const table of ['session', 'passkey'] as const) {
      expect(await count(db, table), table).toBe(0);
      expect(await withOwner(db, 'bob', (tx) => count(tx, table)), table).toBe(0);
      expect(await withOwner(db, 'alice', (tx) => count(tx, table)), table).toBe(1);
    }
  });

  it('refuses board_app a session or passkey for no owner or for another one', async () => {
    await seed();
    await expect(
      db.execute(
        sql`insert into session (token_hash, owner, method, expires_at) values ('h2', 'alice', 'oidc', now())`,
      ),
    ).rejects.toThrow();
    await expect(
      withOwner(db, 'bob', (tx) =>
        tx.execute(sql`insert into passkey (credential_id, owner, public_key, name) values ('c2', 'alice', 'pk', 'x')`),
      ),
    ).rejects.toThrow();
  });

  it('opens a session or a passkey to board_app only through the sign-in functions', async () => {
    await seed();
    const { rows } = await db.execute<{ owner: string | null }>(sql`select session_owner('h1', 60) as owner`);
    expect(rows[0]?.owner).toBe('alice');
    expect((await db.execute(sql`select * from passkey_by_credential('c1')`)).rows).toHaveLength(1);
    expect((await db.execute<{ taken: boolean }>(sql`select username_taken('alice') as taken`)).rows[0]?.taken).toBe(
      true,
    );
    expect((await db.execute<{ taken: boolean }>(sql`select username_taken('nobody') as taken`)).rows[0]?.taken).toBe(
      false,
    );
    const { rows: unknown } = await db.execute<{ owner: string | null }>(
      sql`select session_owner('nope', 60) as owner`,
    );
    expect(unknown[0]?.owner).toBeNull();
  });
});
