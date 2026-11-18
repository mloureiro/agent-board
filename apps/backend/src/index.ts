import { cleanupAllBoards } from './cleanup';
import { loadConfig } from './config';
import { assertUnprivileged, createDb, ensureAppRole, runMigrations } from './db/client';
import { buildServer } from './server';

const config = loadConfig();

// The admin pool only prepares the database and is closed before the first request, so nothing can reach it.
const admin = await createDb(config.databaseUrl, { backfillOwner: config.backfillOwner });
await ensureAppRole(admin.db, config.appDatabaseUrl);
await runMigrations(admin.db);
await admin.pool.end();

// Logs to the console until the server, and with it the request logger, exists.
let logPoolError = (err: Error) => console.error('idle database client failed:', err);
const { db, pool } = await createDb(config.appDatabaseUrl, { onError: (err) => logPoolError(err) });
await assertUnprivileged(db);
const app = await buildServer(config, db);
logPoolError = (err) => app.log.error({ err }, 'idle database client failed');

// At start and every hour, for every board.
const cleanup = () => cleanupAllBoards(db, app.log).catch((err: unknown) => app.log.error({ err }, 'cleanup failed'));
void cleanup();
setInterval(cleanup, 60 * 60_000).unref();
await app.listen({ host: config.host, port: config.port });

// A second signal while closing must not call `pool.end()` again, which rejects.
let closing: Promise<void> | undefined;
const shutdown = () =>
  (closing ??= (async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  })());
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
