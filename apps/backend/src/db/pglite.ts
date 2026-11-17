import {
  PGlite,
  types,
  type PGliteOptions,
  type QueryOptions,
  type Results,
  type Transaction,
} from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import type { Db } from './client';
import * as schema from './schema';

const PROTOCOL = 'pglite:';

/** `pglite://[role[:password]@]local/<absolute data directory>`: an in-process database instead of a Postgres server. */
export const isPgliteUrl = (databaseUrl: string): boolean => databaseUrl.startsWith(PROTOCOL);

interface Instance {
  client: PGlite;
  handles: number;
}

// One data directory must be opened by one PGlite at a time, so handles on the same directory share it.
const instances = new Map<string, Instance>();

// A compiled executable has no node_modules for PGlite to find its own files in; PGLITE_ASSETS_DIR names a folder that holds them.
function bundledAssets(): Pick<PGliteOptions, 'pgliteWasmModule' | 'initdbWasmModule' | 'fsBundle'> {
  const dir = process.env.PGLITE_ASSETS_DIR;
  if (!dir) return {};
  const read = (name: string) => new Uint8Array(readFileSync(path.join(dir, name)));
  return {
    pgliteWasmModule: new WebAssembly.Module(read('pglite.wasm')),
    initdbWasmModule: new WebAssembly.Module(read('initdb.wasm')),
    fsBundle: new Blob([read('pglite.data')]),
  };
}

function acquire(dataDir: string): Instance {
  let instance = instances.get(dataDir);
  if (!instance) {
    // node-postgres returns bigint and numeric columns as strings; PGlite would return numbers and bigints.
    instance = {
      client: new PGlite(dataDir, {
        ...bundledAssets(),
        parsers: { [types.INT8]: (v) => v, [types.NUMERIC]: (v) => v },
      }),
      handles: 0,
    };
    instances.set(dataDir, instance);
  }
  instance.handles++;
  return instance;
}

type Enter = (tx: Transaction) => Promise<void>;

/**
 * PGlite has one session, owned by its bootstrap superuser. A handle that names a role takes that role for the length
 * of each statement or transaction with `set local`, so nothing it runs sees the session's own privileges and nothing
 * is left behind for the next handle.
 */
function scoped(client: PGlite, enter: Enter): Pick<PGlite, 'query' | 'transaction'> {
  return {
    query: <T>(query: string, params?: unknown[], options?: QueryOptions) =>
      client.transaction(async (tx) => {
        await enter(tx);
        return tx.query<T>(query, params, options);
      }) as Promise<Results<T>>,
    transaction: <T>(callback: (tx: Transaction) => Promise<T>) =>
      client.transaction(async (tx) => {
        await enter(tx);
        return callback(tx);
      }) as Promise<T>,
  };
}

export function createPgliteDb(
  databaseUrl: string,
  options: { backfillOwner?: string | null } = {},
): { db: Db; pool: pg.Pool } {
  const url = new URL(databaseUrl);
  const dataDir = decodeURIComponent(url.pathname);
  if (url.hostname !== 'local' || dataDir.length < 2)
    throw new Error('A pglite URL has the form pglite://[role@]local/<absolute data directory>');
  const role = decodeURIComponent(url.username);
  if (role && !/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`"${role}" is not a role name a pglite URL can carry`);
  const backfillOwner = options.backfillOwner ?? null;

  const instance = acquire(dataDir);
  const enter: Enter = async (tx) => {
    if (backfillOwner) await tx.query(`select set_config('app.backfill_owner', $1, true)`, [backfillOwner]);
    if (role) await tx.exec(`set local role ${role}`);
  };
  const client = scoped(instance.client, enter);

  let ended = false;
  const pool = {
    query: (text: string, params?: unknown[]) => client.query(text, params),
    async end() {
      if (ended) throw new Error('Called end on pool more than once');
      ended = true;
      if (--instance.handles > 0) return;
      instances.delete(dataDir);
      await instance.client.close();
    },
  };
  return {
    db: drizzle({ client: client as PGlite, schema }) as unknown as Db,
    pool: pool as unknown as pg.Pool,
  };
}
