import { sql } from 'drizzle-orm';
import { APP_ROLE, createDb, ensureAppRole, runMigrations } from '../db/client';

export const testDatabaseUrl = (): string =>
  process.env.TEST_DATABASE_URL ?? 'postgresql://board:board@localhost:54331/board_test';

/** The request role on the test database: same host and database as the admin URL, user board_app. */
export function testAppDatabaseUrl(): string {
  const url = new URL(testDatabaseUrl());
  url.username = APP_ROLE;
  url.password = APP_ROLE;
  return url.toString();
}

/** Fresh schema for every test run, then all migrations. */
export default async function setup() {
  const { db, pool } = await createDb(testDatabaseUrl());
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await ensureAppRole(db, testAppDatabaseUrl());
  await runMigrations(db);
  await pool.end();
}
