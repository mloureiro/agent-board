import { sql } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { testAppDatabaseUrl, testDatabaseUrl } from '../test/global-setup';
import { createDb, type Db } from './client';

const admin = await createDb(testDatabaseUrl());
afterAll(() => admin.pool.end());
afterEach(() => vi.restoreAllMocks());

const backendPid = async (db: Db): Promise<number> => {
  const { rows } = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  return rows[0]!.pid;
};

const terminate = (pid: number) => admin.db.execute(sql`select pg_terminate_backend(${pid}::int)`);

// Vitest fails the run on an uncaught exception, so these tests also prove the `error` event no longer crashes.
describe('a pool whose idle client loses its connection', () => {
  it('reports the error to onError and serves the next query on a new connection', async () => {
    let report!: (err: Error) => void;
    const reported = new Promise<Error>((resolve) => (report = resolve));
    const app = await createDb(testAppDatabaseUrl(), { onError: report });
    try {
      const pid = await backendPid(app.db);
      await terminate(pid);

      const err = await reported;
      expect(err.message).toMatch(/terminating connection/);
      const next = await backendPid(app.db);
      expect(next).not.toBe(pid);
    } finally {
      await app.pool.end();
    }
  });

  it('logs to the console when no onError is given', async () => {
    let markLogged!: () => void;
    const logged = new Promise<void>((resolve) => (markLogged = resolve));
    const log = vi.spyOn(console, 'error').mockImplementation(() => markLogged());
    const app = await createDb(testAppDatabaseUrl());
    try {
      await terminate(await backendPid(app.db));

      await logged;
      expect(log).toHaveBeenCalledWith('idle database client failed:', expect.any(Error));
      await expect(backendPid(app.db)).resolves.toEqual(expect.any(Number));
    } finally {
      await app.pool.end();
    }
  });
});
