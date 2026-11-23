import { sql } from 'drizzle-orm';
import { afterAll, beforeEach } from 'vitest';
import type { Config, LoginConfig } from '../config';
import { createDb, type Db, type Tx } from '../db/client';
import { appUsers } from '../db/schema';
import { withOwner } from '../db/scope';
import { Changes } from '../services/changes';
import { OidcClient } from '../services/auth/oidc';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/trpc';
import { testAppDatabaseUrl, testDatabaseUrl } from './global-setup';

export const testConfig: Config = {
  nodeEnv: 'test',
  port: 0,
  host: '127.0.0.1',
  databaseUrl: testDatabaseUrl(),
  appDatabaseUrl: testAppDatabaseUrl(),
  backfillOwner: null,
  auth: { login: false, user: 'jascha' },
  cliVersion: null,
  revision: null,
};

/** A board with sign-in on: passkeys, no identity provider unless a test adds one. */
export function loginConfig(overrides: Partial<LoginConfig> = {}): Config & { auth: LoginConfig } {
  const auth: LoginConfig = {
    login: true,
    publicUrl: 'http://localhost:5173',
    rpId: 'localhost',
    sessionDays: 30,
    passkeys: true,
    signupToken: null,
    allowedGroups: [],
    oidc: null,
    saml: null,
    ...overrides,
  };
  return { ...testConfig, auth };
}

/** `db` is the unprivileged handle that serves requests; `admin` bypasses row-level security. The tables are wiped before each test. */
export async function useTestDb(): Promise<{ db: Db; admin: Db }> {
  const app = await createDb(testAppDatabaseUrl());
  const admin = await createDb(testDatabaseUrl());
  beforeEach(async () => {
    await admin.db.execute(
      sql`truncate app_user, session, passkey, auth_flow, note, task, schedule, machine restart identity cascade`,
    );
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

/** The context of a tRPC call as `username`, for a server-less test; `overrides` swaps what a test needs to look at. */
export function testContext(root: Db, username: string | null = 'jascha', overrides: Partial<Context> = {}): Context {
  return {
    root,
    config: testConfig,
    changes: new Changes(),
    log: { warn: () => undefined },
    oidc: new OidcClient(null),
    username,
    sessionHash: null,
    setSessionCookie: () => undefined,
    ...overrides,
  };
}

export function caller(root: Db, username = 'jascha', changes = new Changes()) {
  return appRouter.createCaller(testContext(root, username, { changes }));
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
