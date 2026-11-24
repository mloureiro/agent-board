import { generateDataKey, wrapDataKey, type KeySlot } from '@agent-board/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from './db/client';
import { machines, notes, schedules, tasks } from './db/schema';
import { buildServer } from './server';
import { ACCOUNT_TABLES, type AccountTable } from './services/account';
import { asOwner, caller, SEALED, testConfig } from './test/helpers';
import { SCRATCH_MIGRATION_TIMEOUT, SCRATCH_TEARDOWN_TIMEOUT, scratchDatabases } from './test/scratch';
import { testAppDatabaseUrl } from './test/global-setup';

const KEY = '0573c0a7b6879764';
const BLIND = `abh1.${'B'.repeat(43)}`;
const FEEDS_INDEX = `abh1.${'F'.repeat(43)}`;

const scratch = scratchDatabases('move');
const pools: ReturnType<typeof createDb>[] = [];

interface Board {
  db: Db;
  admin: Db;
  url: string;
}

async function newBoard(): Promise<Board> {
  const url = await scratch.create();
  const admin = createDb(url);
  const appUrl = new URL(testAppDatabaseUrl());
  appUrl.pathname = new URL(url).pathname;
  const app = createDb(appUrl.toString());
  pools.push(admin, app);
  await runMigrations(admin.db);
  return { db: app.db, admin: admin.db, url };
}

type Rows = Record<string, unknown>[];

async function exportAll(client: ReturnType<typeof caller>, table: AccountTable): Promise<Rows> {
  const rows: Rows = [];
  let cursor: string | null = null;
  do {
    const page: { rows: Rows; next: string | null } = await client.account.export({ table, cursor });
    rows.push(...page.rows);
    cursor = page.next;
  } while (cursor !== null);
  return rows;
}

async function machineCall(db: Db, token: string, command: string) {
  const app = await buildServer(testConfig, db);
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machine/${command}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    return { status: res.statusCode, json: res.json() as { result?: any } };
  } finally {
    await app.close();
  }
}

afterAll(async () => {
  await Promise.all(pools.map(({ pool }) => pool.end()));
  await scratch.dropAll();
}, SCRATCH_TEARDOWN_TIMEOUT);

describe('moving a board to another server', { timeout: SCRATCH_MIGRATION_TIMEOUT }, () => {
  let source: Board;
  let target: Board;
  let token: string;
  let summaryBefore: unknown;
  let exported: Record<AccountTable, Rows>;
  let slots: KeySlot[];

  beforeAll(async () => {
    [source, target] = [await newBoard(), await newBoard()];
    const wrapped = await wrapDataKey(generateDataKey(), generateDataKey());
    slots = [
      { kind: 'passphrase', kdf: 'argon2id', m: 65536, t: 3, p: 1, salt: 'A'.repeat(22), wrapped },
      { kind: 'recovery', wrapped },
    ];

    const user = caller(source.db, 'jascha');
    await user.keys.setup({ keyId: KEY, slots });
    const base = { title: SEALED, input: SEALED };
    await asOwner(source.db, 'jascha', async (tx) => {
      await tx.insert(tasks).values([
        { id: 'task1', ...base, position: 0, dedupeKey: BLIND, head: BLIND },
        { id: 'task2', ...base, position: 1 },
        { id: 'task3', ...base, position: 2, status: 'done' },
      ]);
      await tx.insert(schedules).values({
        id: 'sched1',
        ...base,
        everyMs: 3_600_000,
        anchorAt: new Date('2026-01-01T00:00:00Z'),
      });
      await tx.insert(notes).values({ id: 'note1', taskId: 'task1', author: 'agent', kind: 'comment', body: SEALED });
    });
    ({ token } = await user.machines.issue({ name: 'laptop' }));
    await source.admin
      .update(machines)
      .set({ feeds: SEALED, feedsIndex: FEEDS_INDEX, feedsUpdatedAt: new Date() })
      .where(eq(machines.name, 'laptop'));

    summaryBefore = await user.account.summary();
    exported = Object.fromEntries(
      await Promise.all(ACCOUNT_TABLES.map(async (table) => [table, await exportAll(user, table)] as const)),
    ) as Record<AccountTable, Rows>;

    const moved = caller(target.db, 'jascha');
    await moved.keys.setup({ keyId: KEY, slots });
    for (const table of ACCOUNT_TABLES) await moved.account.import({ keyId: KEY, table, rows: exported[table] });
  }, SCRATCH_MIGRATION_TIMEOUT);

  it('accepts the machine token of the old server and reports the same owner and key id', async () => {
    const [before, after] = [
      await machineCall(source.db, token, 'version'),
      await machineCall(target.db, token, 'version'),
    ];
    expect(after.status).toBe(200);
    expect(after.json.result).toMatchObject({ owner: 'jascha', keyId: KEY });
    expect(after.json.result.owner).toBe(before.json.result.owner);
    expect(after.json.result.keyId).toBe(before.json.result.keyId);
  });

  it('lists the same tasks', async () => {
    const ids = async (db: Db) =>
      (await machineCall(db, token, 'list-tasks')).json.result.map((task: { id: string }) => task.id).sort();
    expect(await ids(target.db)).toEqual(['task1', 'task2', 'task3']);
    expect(await ids(target.db)).toEqual(await ids(source.db));
  });

  it('refuses a token that was never on the old server', async () => {
    expect((await machineCall(target.db, `abm_${'x'.repeat(43)}`, 'version')).status).toBe(401);
  });

  it('leaves the old server as it was', async () => {
    expect(await caller(source.db, 'jascha').account.summary()).toEqual(summaryBefore);
  });

  it('carries the feeds of a machine with their index', async () => {
    const [row] = await target.admin.select().from(machines).where(eq(machines.name, 'laptop'));
    expect(row).toMatchObject({ feeds: SEALED, feedsIndex: FEEDS_INDEX });
  });
});
