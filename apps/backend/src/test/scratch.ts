import { sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, migrationsFolder } from '../db/client';
import { testDatabaseUrl } from './global-setup';

/** A copy of the migrations folder that stops before the migration whose tag ends with `suffix`. */
export function migrationsBefore(suffix: string): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'board-migrations-'));
  cpSync(migrationsFolder(), folder, { recursive: true });
  const journalPath = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const stop = journal.entries.findIndex(({ tag }) => tag.endsWith(suffix));
  journal.entries = journal.entries.slice(0, stop === -1 ? undefined : stop);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

export const removeFolder = (folder: string): void => rmSync(folder, { recursive: true, force: true });

/**
 * How long dropping the scratch databases may take. `drop database` forces an immediate checkpoint of the whole
 * cluster, so with other suites writing to the same Postgres (other worktrees, each on its own `TEST_DATABASE_URL`)
 * a single drop has taken more than 10 s, vitest's default hook timeout.
 */
export const SCRATCH_TEARDOWN_TIMEOUT = 60_000;

/** For tests and hooks that migrate a scratch database from empty, which slows down the same way under load. */
export const SCRATCH_MIGRATION_TIMEOUT = 30_000;

export interface ScratchDatabases {
  /**
   * Creates an empty database with a new name and returns its admin connection URL. Cheap, unlike a drop, so a test
   * that wants a clean slate takes a new database instead of dropping the last one.
   */
  create(): Promise<string>;
  /** Drops every database `create` made; close their pools first. Call from an `afterAll` with `SCRATCH_TEARDOWN_TIMEOUT`. */
  dropAll(): Promise<void>;
}

/** Databases named after the test database and unique per run, so two suites at once never drop each other's. */
export function scratchDatabases(label: string): ScratchDatabases {
  const base = new URL(testDatabaseUrl()).pathname.slice(1).replace(/[^A-Za-z0-9_]/g, '_');
  let admin: Awaited<ReturnType<typeof createDb>> | undefined;
  const adminDb = async () => (admin ??= await createDb(testDatabaseUrl()));
  const names: string[] = [];
  return {
    async create() {
      const name = `${base}_${label}_${randomBytes(4).toString('hex')}`;
      names.push(name);
      await (await adminDb()).db.execute(sql.raw(`create database ${name}`));
      const url = new URL(testDatabaseUrl());
      url.pathname = `/${name}`;
      return url.toString();
    },
    async dropAll() {
      // Not `with (force)`: callers close their connections first, and Postgres waits for a session that is still on
      // its way out. Forcing would kill that session, and its last message surfaces in the test run as an unhandled error.
      const { db, pool } = await adminDb();
      for (const name of names.splice(0)) await db.execute(sql.raw(`drop database if exists ${name}`));
      await pool.end();
    },
  };
}

/** An empty directory for a PGlite data directory; `pgliteUrl` turns it into a database URL. */
export const pgliteScratchDir = (): string => mkdtempSync(path.join(tmpdir(), 'board-pglite-'));

export function pgliteUrl(dataDir: string, login?: string): string {
  const encoded = dataDir.split('/').map(encodeURIComponent).join('/');
  return `pglite://${login ? `${login}@` : ''}local${encoded}`;
}
