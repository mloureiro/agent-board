import { sql } from 'drizzle-orm';
import { afterAll, beforeEach } from 'vitest';
import type { Config } from '../config';
import { createDb, type Db, type Tx } from '../db/client';
import { appUsers } from '../db/schema';
import { withOwner } from '../db/scope';
import { Changes } from '../services/changes';
import { appRouter } from '../trpc/router';
import { testAppDatabaseUrl, testDatabaseUrl } from './global-setup';

export const testConfig: Config = {
  nodeEnv: 'test',
  port: 0,
  databaseUrl: testDatabaseUrl(),
  appDatabaseUrl: testAppDatabaseUrl(),
  backfillOwner: null,
  allowedGroups: ['admins'],
  devAuthUser: null,
  proxySecret: null,
  cliVersion: null,
};

/** `db` is the unprivileged handle that serves requests; `admin` bypasses row-level security. The tables are wiped before each test. */
export async function useTestDb(): Promise<{ db: Db; admin: Db }> {
  const app = await createDb(testAppDatabaseUrl());
  const admin = await createDb(testDatabaseUrl());
  beforeEach(async () => {
    await admin.db.execute(sql`truncate app_user, note, task, schedule, machine restart identity cascade`);
  });
  afterAll(() => Promise.all([app.pool.end(), admin.pool.end()]));
  return { db: app.db, admin: admin.db };
}

/** Runs `fn` as the user `owner`, who is created first: for tests that call services without a request. */
export function asOwner<T>(db: Db, owner: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withOwner(db, owner, async (tx) => {
    await tx.insert(appUsers).values({ username: owner }).onConflictDoNothing();
    return fn(tx);
  });
}

export function caller(root: Db, username = 'jascha', changes = new Changes()) {
  return appRouter.createCaller({ root, config: testConfig, changes, username });
}

/** A value of the shape of an envelope, for rows a test inserts directly: the sealed-content constraints of a later release refuse anything else. */
export const SEALED = `abe1.${'A'.repeat(40)}`;

export const question = {
  header: 'Scope',
  question: 'Review the migration too?',
  multiSelect: false,
  options: [
    { label: 'Yes', description: 'Include it', recommended: true },
    { label: 'No', description: 'Skip it' },
  ],
};

/** Claude session ids, which the board only takes as UUIDs. */
export const SESSION = '11111111-1111-4111-8111-111111111111';
export const sessionNamed = (n: number): string => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
