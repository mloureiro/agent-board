import {
  compareVersions,
  isSafeMachineName,
  MACHINE_NAME_RULE,
  MAX_FEED_REQUESTS,
  MIN_CLIENT,
  feedRequest,
} from '@agent-board/shared';
import type { FeedAction } from '@agent-board/shared';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { DbOrTx } from '../db/client';
import { machines } from '../db/schema';
import { AppError } from './errors';

export interface FeedRequest {
  action: FeedAction;
  id: string;
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** A new token for `name`, shown once; a machine that had one gets a new one and the old one stops working. */
export async function issueToken(db: DbOrTx, name: string): Promise<string> {
  if (!isSafeMachineName(name)) throw new AppError('BAD_REQUEST', `A machine name is ${MACHINE_NAME_RULE}.`);
  const token = `abm_${randomBytes(32).toString('base64url')}`;
  await db
    .insert(machines)
    .values({ name, tokenHash: hash(token) })
    .onConflictDoUpdate({
      target: [machines.owner, machines.name],
      set: {
        tokenHash: hash(token),
        revokedAt: null,
        createdAt: new Date(),
        lastSeenAt: null,
        clientVersion: null,
        clientApi: null,
        dirs: null,
        dirsIndex: null,
        dirsUpdatedAt: null,
        catalog: null,
        catalogIndex: null,
        catalogUpdatedAt: null,
        usage: null,
        usageIndex: null,
        usageUpdatedAt: null,
        feeds: null,
        feedsIndex: null,
        feedsUpdatedAt: null,
        feedRequests: [],
      },
    });
  return token;
}

/**
 * The machine a bearer token belongs to and whose board it works on, or null. Runs before any owner is known, so it
 * goes through a database function that reads across owners; it also records the sighting.
 */
export async function machineForToken(db: DbOrTx, token: string): Promise<{ owner: string; name: string } | null> {
  if (!token.startsWith('abm_')) return null;
  const { rows } = await db.execute<{ owner: string; name: string }>(
    sql`select owner, name from machine_for_token(${hash(token)})`,
  );
  return rows[0] ?? null;
}

/** Whether a client at this break level can work with this server. */
export function isCompatibleClientApi(level: number): boolean {
  return level >= MIN_CLIENT;
}

/** Remembers what a machine's CLI reported; writes only when that differs from what is stored, so heartbeats do not write. */
export async function recordClient(
  db: DbOrTx,
  name: string,
  client: { version: string | null; api: number | null },
): Promise<void> {
  if (client.version === null && client.api === null) return;
  await db
    .update(machines)
    .set({ clientVersion: client.version, clientApi: client.api })
    .where(
      and(
        eq(machines.name, name),
        sql`(${machines.clientVersion} is distinct from ${client.version} or ${machines.clientApi} is distinct from ${client.api})`,
      ),
    );
}

export type ClientStatus = 'current' | 'outdated' | 'incompatible' | 'unknown';

export function clientStatus(
  machine: { clientVersion: string | null; clientApi: number | null },
  advertised: string | null,
): ClientStatus {
  const { clientVersion, clientApi } = machine;
  if (clientVersion === null && clientApi === null) return 'unknown';
  if (clientApi !== null && !isCompatibleClientApi(clientApi)) return 'incompatible';
  if (clientVersion !== null && advertised !== null && compareVersions(clientVersion, advertised) < 0)
    return 'outdated';
  return 'current';
}

export async function listMachines(db: DbOrTx, advertisedCli: string | null) {
  const rows = await db
    .select({
      name: machines.name,
      createdAt: machines.createdAt,
      lastSeenAt: machines.lastSeenAt,
      revokedAt: machines.revokedAt,
      clientVersion: machines.clientVersion,
      clientApi: machines.clientApi,
      dirs: machines.dirs,
      dirsUpdatedAt: machines.dirsUpdatedAt,
      usage: machines.usage,
      usageUpdatedAt: machines.usageUpdatedAt,
    })
    .from(machines)
    .orderBy(asc(machines.name));
  return rows.map(({ clientApi, ...machine }) => ({
    ...machine,
    clientStatus: clientStatus({ clientVersion: machine.clientVersion, clientApi }, advertisedCli),
  }));
}

/** The owner's machines whose token still works, by name, with the sighting of each: what another machine may know of them. */
export async function listActiveMachines(
  db: DbOrTx,
  current: string,
): Promise<{ name: string; lastSeenAt: string | null; current: boolean }[]> {
  const rows = await db
    .select({ name: machines.name, lastSeenAt: machines.lastSeenAt })
    .from(machines)
    .where(isNull(machines.revokedAt))
    .orderBy(asc(machines.name));
  return rows.map(({ name, lastSeenAt }) => ({
    name,
    lastSeenAt: lastSeenAt === null ? null : lastSeenAt.toISOString(),
    current: name === current,
  }));
}

/** The sealed catalogues the machines sent, by machine name; kept out of `listMachines` because that one is polled. */
export async function listMachineCatalogs(db: DbOrTx) {
  return db
    .select({ name: machines.name, catalog: machines.catalog, catalogUpdatedAt: machines.catalogUpdatedAt })
    .from(machines)
    .where(and(isNull(machines.revokedAt), isNotNull(machines.catalog)))
    .orderBy(asc(machines.name));
}

export async function revokeMachine(db: DbOrTx, name: string): Promise<void> {
  await db
    .update(machines)
    .set({
      revokedAt: new Date(),
      dirs: null,
      dirsIndex: null,
      dirsUpdatedAt: null,
      catalog: null,
      catalogIndex: null,
      catalogUpdatedAt: null,
      usage: null,
      usageIndex: null,
      usageUpdatedAt: null,
      feeds: null,
      feedsIndex: null,
      feedsUpdatedAt: null,
      feedRequests: [],
    })
    .where(eq(machines.name, name));
}

/** Stores the sealed directory list a machine sent, with the blind index of what it holds. */
export async function setMachineDirs(db: DbOrTx, name: string, list: { dirs: string; index: string }): Promise<void> {
  await db
    .update(machines)
    .set({ dirs: list.dirs, dirsIndex: list.index, dirsUpdatedAt: new Date() })
    .where(eq(machines.name, name));
}

/** The blind index of the list a machine last sent, or null when it sent none. */
export async function machineDirsIndex(db: DbOrTx, name: string): Promise<string | null> {
  const [row] = await db.select({ index: machines.dirsIndex }).from(machines).where(eq(machines.name, name));
  return row?.index ?? null;
}

/** Stores the sealed catalogue a machine sent, with the blind index of what it holds. */
export async function setMachineCatalog(
  db: DbOrTx,
  name: string,
  sent: { catalog: string; index: string },
): Promise<void> {
  await db
    .update(machines)
    .set({ catalog: sent.catalog, catalogIndex: sent.index, catalogUpdatedAt: new Date() })
    .where(eq(machines.name, name));
}

/** The blind index of the catalogue a machine last sent, or null when it sent none. */
export async function machineCatalogIndex(db: DbOrTx, name: string): Promise<string | null> {
  const [row] = await db.select({ index: machines.catalogIndex }).from(machines).where(eq(machines.name, name));
  return row?.index ?? null;
}

/** Stores the sealed usage status a machine sent, with the blind index of what it holds. */
export async function setMachineUsage(db: DbOrTx, name: string, sent: { usage: string; index: string }): Promise<void> {
  await db
    .update(machines)
    .set({ usage: sent.usage, usageIndex: sent.index, usageUpdatedAt: new Date() })
    .where(eq(machines.name, name));
}

/** The blind index of the usage status a machine last sent, or null when it sent none. */
export async function machineUsageIndex(db: DbOrTx, name: string): Promise<string | null> {
  const [row] = await db.select({ index: machines.usageIndex }).from(machines).where(eq(machines.name, name));
  return row?.index ?? null;
}

/** Stores the sealed feeds a machine sent, with the blind index of what they hold. */
export async function setMachineFeeds(db: DbOrTx, name: string, sent: { feeds: string; index: string }): Promise<void> {
  await db
    .update(machines)
    .set({ feeds: sent.feeds, feedsIndex: sent.index, feedsUpdatedAt: new Date() })
    .where(eq(machines.name, name));
}

/** The blind index of the feeds a machine last sent (null when it sent none), and the requests that wait for it. */
export async function machineFeedsState(
  db: DbOrTx,
  name: string,
): Promise<{ index: string | null; requests: string[] }> {
  const [row] = await db
    .select({ index: machines.feedsIndex, requests: machines.feedRequests })
    .from(machines)
    .where(eq(machines.name, name));
  return { index: row?.index ?? null, requests: row?.requests ?? [] };
}

/** The machine applied these requests: they stop being pending. A request that is not pending changes nothing. */
export async function ackFeedRequests(db: DbOrTx, name: string, done: readonly string[]): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ requests: machines.feedRequests })
      .from(machines)
      .where(eq(machines.name, name))
      .for('update');
    if (row === undefined) return;
    const requests = row.requests.filter((request) => !done.includes(request));
    if (requests.length !== row.requests.length)
      await tx.update(machines).set({ feedRequests: requests }).where(eq(machines.name, name));
  });
}

/**
 * The user's Pause, Resume or Run now of one feed: the request waits in `feedRequests` until the machine applies it on its
 * next dispatch tick. A request that already waits changes nothing; a pause and a resume of one feed replace each other.
 */
export async function requestFeed(db: DbOrTx, name: string, request: FeedRequest): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ requests: machines.feedRequests, revokedAt: machines.revokedAt })
      .from(machines)
      .where(eq(machines.name, name))
      .for('update');
    if (row === undefined || row.revokedAt !== null) throw new AppError('NOT_FOUND', `No machine ${name}.`);
    const wanted = feedRequest(request.action, request.id);
    if (row.requests.includes(wanted)) return;
    const opposite = request.action === 'pause' ? 'resume' : request.action === 'resume' ? 'pause' : undefined;
    const kept = row.requests.filter(
      (pending) => opposite === undefined || pending !== feedRequest(opposite, request.id),
    );
    if (kept.length >= MAX_FEED_REQUESTS)
      throw new AppError('BAD_REQUEST', `${MAX_FEED_REQUESTS} requests already wait for the machine`);
    await tx
      .update(machines)
      .set({ feedRequests: [...kept, wanted] })
      .where(eq(machines.name, name));
  });
}

/** The sealed feeds and pending requests of the machines that sent feeds; kept out of `listMachines` like the catalogues. */
export async function listMachineFeeds(db: DbOrTx) {
  return db
    .select({
      name: machines.name,
      feeds: machines.feeds,
      feedsUpdatedAt: machines.feedsUpdatedAt,
      feedRequests: machines.feedRequests,
      lastSeenAt: machines.lastSeenAt,
    })
    .from(machines)
    .where(and(isNull(machines.revokedAt), isNotNull(machines.feeds)))
    .orderBy(asc(machines.name));
}
