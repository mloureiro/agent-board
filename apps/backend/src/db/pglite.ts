import type { PGlite, PGliteOptions, QueryOptions, Results, Transaction } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import type { Db } from './client';
import * as schema from './schema';

const PROTOCOL = 'pglite:';
const SHARED_BUFFERS = /^[0-9]+(kB|MB|GB)$/;

/** `pglite://[role[:password]@]local/<absolute data directory>`: an in-process database instead of a Postgres server. */
export const isPgliteUrl = (databaseUrl: string): boolean => databaseUrl.startsWith(PROTOCOL);

export interface PgliteTarget {
  dataDir: string;
  /** Empty when the URL names no role, so statements run as the bootstrap superuser. */
  role: string;
}

/** The host token `local` exists because a URL without a host cannot carry a username. The password is ignored. */
export function parsePgliteUrl(databaseUrl: string): PgliteTarget {
  const form = 'A pglite URL has the form pglite://[role[:password]@]local/<absolute data directory>';
  const url = new URL(databaseUrl);
  if (url.hostname !== 'local') throw new Error(form);
  const dataDir = decodeURIComponent(url.pathname);
  if (!path.isAbsolute(dataDir) || dataDir === '/') throw new Error(form);
  const role = decodeURIComponent(url.username);
  if (role && !/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`"${role}" is not a role name a pglite URL can carry`);
  return { dataDir, role };
}

/** `PGLITE_SHARED_BUFFERS` as PGlite's `shared_buffers` setting, or null when unset. */
export function parseSharedBuffers(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!SHARED_BUFFERS.test(trimmed))
    throw new Error(`PGLITE_SHARED_BUFFERS must be a number and a unit (kB, MB or GB), such as 8MB; got "${trimmed}"`);
  return trimmed;
}

/** A start error rather than a setting that does nothing. */
export function rejectPgliteSettings(): void {
  if (parseSharedBuffers(process.env.PGLITE_SHARED_BUFFERS))
    throw new Error('PGLITE_SHARED_BUFFERS only applies to a pglite:// database URL');
}

type Startup = Pick<PGliteOptions, 'pgliteWasmModule' | 'initdbWasmModule' | 'fsBundle' | 'startParams'>;

// A compiled executable has no node_modules for PGlite to find its own files in; PGLITE_ASSETS_DIR names a folder that holds them.
function startup(defaultStartParams: string[]): Startup {
  const sharedBuffers = parseSharedBuffers(process.env.PGLITE_SHARED_BUFFERS);
  const assetsDir = process.env.PGLITE_ASSETS_DIR?.trim();
  const read = (name: string): Uint8Array<ArrayBuffer> => {
    try {
      return new Uint8Array(readFileSync(path.join(assetsDir!, name)));
    } catch (cause) {
      throw new Error(`PGLITE_ASSETS_DIR "${assetsDir}" has no readable ${name}`, { cause });
    }
  };
  return {
    ...(assetsDir
      ? {
          pgliteWasmModule: new WebAssembly.Module(read('pglite.wasm')),
          initdbWasmModule: new WebAssembly.Module(read('initdb.wasm')),
          fsBundle: new Blob([read('pglite.data')]),
        }
      : {}),
    // `startParams` replaces PGlite's own defaults rather than adding to them.
    ...(sharedBuffers ? { startParams: [...defaultStartParams, '-c', `shared_buffers=${sharedBuffers}`] } : {}),
  };
}

interface Instance {
  client: PGlite;
  handles: number;
}

// One data directory must be opened by one PGlite at a time, so handles on the same directory share it.
const instances = new Map<string, Instance>();

async function acquire(dataDir: string): Promise<Instance> {
  const existing = instances.get(dataDir);
  if (existing) {
    existing.handles++;
    return existing;
  }
  const { PGlite, types } = await import('@electric-sql/pglite');
  // The import yielded, so another handle may have opened this directory in the meantime.
  const raced = instances.get(dataDir);
  if (raced) {
    raced.handles++;
    return raced;
  }
  const instance: Instance = {
    // node-postgres returns bigint and numeric columns as strings; PGlite would return numbers and bigints.
    client: new PGlite(dataDir, {
      ...startup(PGlite.defaultStartParams),
      parsers: { [types.INT8]: (v) => v, [types.NUMERIC]: (v) => v },
    }),
    handles: 1,
  };
  instances.set(dataDir, instance);
  try {
    await instance.client.waitReady;
  } catch (error) {
    instances.delete(dataDir);
    throw error;
  }
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

export async function createPgliteDb(
  databaseUrl: string,
  options: { backfillOwner?: string | null } = {},
): Promise<{ db: Db; pool: pg.Pool }> {
  const { dataDir, role } = parsePgliteUrl(databaseUrl);
  const backfillOwner = options.backfillOwner ?? null;

  const [{ drizzle }, instance] = await Promise.all([import('drizzle-orm/pglite'), acquire(dataDir)]);
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
