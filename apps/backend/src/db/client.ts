import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPgliteDb, isPgliteUrl } from './pglite';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction; services accept either. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

/** Backslash and whitespace are special in the libpq `options` string. */
const escapeOption = (value: string): string => value.replace(/[\\\s]/g, '\\$&');

/**
 * `backfillOwner` becomes the session setting `app.backfill_owner` that the tenancy migration reads.
 * `onError` hears about idle clients that lost their connection (a Postgres restart, `pg_terminate_backend`). The pool
 * has already dropped such a client and the next query opens a new one; without a listener the `error` event would
 * crash the process.
 */
export function createDb(
  databaseUrl: string,
  options: { backfillOwner?: string | null; onError?: (err: Error) => void } = {},
): { db: Db; pool: pg.Pool } {
  if (isPgliteUrl(databaseUrl)) return createPgliteDb(databaseUrl, options);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    ...(options.backfillOwner ? { options: `-c app.backfill_owner=${escapeOption(options.backfillOwner)}` } : {}),
  });
  pool.on('error', options.onError ?? ((err) => console.error('idle database client failed:', err)));
  return { db: drizzle({ client: pool, schema }), pool };
}

/**
 * Migrations live in apps/backend/drizzle. In the bundled build (dist/index.js) the folder is
 * copied next to dist, so resolve relative to this module in both cases.
 */
export function migrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return path.resolve(process.env.MIGRATIONS_DIR);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, here.endsWith('dist') ? '../drizzle' : '../../drizzle');
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}

/** The login role that serves requests; the grants in migration 0010 name it. */
export const APP_ROLE = 'board_app';

/**
 * Creates the request role named by `appUrl` with that URL's password, or resets the password of an existing one.
 * Created NOSUPERUSER NOBYPASSRLS; an existing role only gets its password reset, because Postgres 16 refuses even a no-op NOSUPERUSER from a non-superuser (`assertUnprivileged` guards the rest). Run as the admin user, before migrations.
 */
export async function ensureAppRole(adminDb: Db, appUrl: string): Promise<void> {
  const url = new URL(appUrl);
  const role = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (role !== APP_ROLE) throw new Error(`APP_DATABASE_URL must connect as ${APP_ROLE}, not "${role}"`);
  if (!password) throw new Error('APP_DATABASE_URL needs a password');
  const { rows: admin } = await adminDb.execute<{ name: string }>(sql`select current_user as name`);
  if (admin[0]?.name === role) throw new Error('APP_DATABASE_URL must use a different user than DATABASE_URL');
  for (let attempt = 1; ; attempt++) {
    const { rows } = await adminDb.execute<{ ddl: string }>(sql`
      select case when exists (select 1 from pg_roles where rolname = ${role}::text)
        then format('alter role %I with login password %L', ${role}::text, ${password}::text)
        else format('create role %I with login nosuperuser nobypassrls nocreatedb nocreaterole password %L', ${role}::text, ${password}::text)
      end as ddl`);
    try {
      await adminDb.execute(sql.raw(rows[0]!.ddl));
      return;
    } catch (error) {
      if (attempt >= 5 || !isRoleRace(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

/**
 * Roles are cluster-wide, so another session can create or alter the same role at the same moment: two servers
 * starting together, or two test suites on separate databases of one Postgres. The loser fails with "tuple
 * concurrently updated" (XX000) or a duplicate role (23505, 42710), and simply trying again succeeds.
 */
function isRoleRace(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  return (
    cause?.code === '23505' ||
    cause?.code === '42710' ||
    (cause?.code === 'XX000' && cause.message === 'tuple concurrently updated')
  );
}

/** Refuses a connection that would bypass row-level security: a superuser, BYPASSRLS, or the owner of (or a member of the role owning) a table in public. */
export async function assertUnprivileged(db: Db): Promise<void> {
  const { rows } = await db.execute<{ name: string; superuser: boolean; bypassrls: boolean; owns_tables: boolean }>(sql`
    select r.rolname as name, r.rolsuper as superuser, r.rolbypassrls as bypassrls,
      exists (
        select 1 from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
          and pg_has_role(r.oid, c.relowner, 'MEMBER')
      ) as owns_tables
    from pg_roles r where r.rolname = current_user`);
  const role = rows[0];
  if (!role) throw new Error('cannot read the current database role');
  const problems = [
    role.superuser && 'is a superuser',
    role.bypassrls && 'has BYPASSRLS',
    role.owns_tables && 'owns or is a member of the owner of a table in public',
  ].filter(Boolean);
  if (problems.length > 0)
    throw new Error(
      `Database role "${role.name}" ${problems.join(' and ')}; APP_DATABASE_URL must use an unprivileged role`,
    );
}
