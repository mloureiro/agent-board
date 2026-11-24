// Prepares a running board for scripts/previous-cli-smoke.sh: sets up the owner's data key and issues a machine token, then
// prints the two lines of the CLI's `env` file. Needs the server's own DATABASE_URL and APP_DATABASE_URL, and the board
// started once so that the migrations ran.
//
//   DATABASE_URL=... APP_DATABASE_URL=... pnpm --filter @agent-board/backend exec tsx src/scripts/seedMachine.ts <owner> <machine>
import { deriveKeys, encodeDataKey, generateDataKey, wrapDataKey } from '@agent-board/shared';
import { MIN_UI_CLIENT } from '@agent-board/shared/ui';
import { loadConfig } from '../config';
import { createDb } from '../db/client';
import { OidcClient } from '../services/auth/oidc';
import { Changes } from '../services/changes';
import { appRouter } from '../trpc/router';

const [owner, machine] = process.argv.slice(2);
if (owner === undefined || machine === undefined) {
  console.error('usage: seedMachine <owner> <machine>');
  process.exit(2);
}

const config = loadConfig();
for (const [name, url] of [
  ['DATABASE_URL', config.databaseUrl],
  ['APP_DATABASE_URL', config.appDatabaseUrl],
] as const) {
  if (!new URL(url).pathname.slice(1).endsWith('_prevcli')) {
    console.error(`seedMachine: refusing ${name}: its database name does not end in _prevcli`);
    process.exit(2);
  }
}
const { db, pool } = createDb(config.appDatabaseUrl);
const board = appRouter.createCaller({
  root: db,
  config,
  changes: new Changes(),
  log: console,
  oidc: new OidcClient(null),
  username: owner,
  sessionHash: null,
  setSessionCookie: () => undefined,
  uiClientApi: null,
  minUiClient: MIN_UI_CLIENT,
});

const dataKey = generateDataKey();
const { keyId } = await deriveKeys(dataKey, owner);
await board.me();
// The server cannot open the slots, so these wrap the key under random keys nobody keeps.
const wrapped = await wrapDataKey(generateDataKey(), dataKey);
await board.keys.setup({
  keyId,
  slots: [
    { kind: 'passphrase', kdf: 'argon2id', m: 65536, t: 3, p: 1, salt: 'A'.repeat(22), wrapped },
    { kind: 'recovery', wrapped },
  ],
});
const { token } = await board.machines.issue({ name: machine });
await pool.end();

console.log(`AGENT_BOARD_TOKEN=${token}`);
console.log(`AGENT_BOARD_DATA_KEY=${encodeDataKey(dataKey)}`);
