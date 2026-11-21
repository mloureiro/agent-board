import {
  API_VERSION,
  deriveKeys,
  MIN_SERVER,
  parseVersion,
  parseVersionCli,
  parseVersionCatalogIndex,
  parseVersionDirsIndex,
  parseVersionFeatures,
  parseVersionIdentity,
  parseVersionMachine,
  parseVersionUsageIndex,
} from '@agent-board/shared';
import type { Keys } from '@agent-board/shared';
import { isCompiledBinary } from '../self/self.mts';
import { asBackendError, BackendError, callServer } from './backend.mts';
import type { Fetch } from './backend.mts';
import type { WebConfig } from './web-config.mts';

function mismatch(kind: 'cli-older' | 'server-older', message: string, status?: number): BackendError {
  const error = new BackendError(message, status);
  error.contractMismatch = kind;
  return error;
}

// How to bring this CLI up to the board's API: a binary updates itself, a checkout is pulled.
export const updateCliHint = (): string =>
  isCompiledBinary() ? 'run "board self-update"' : 'run "git pull" and "pnpm install" in the checkout';

// Whose board this is and which data key it expects (null before encryption is set up).
export interface ServerIdentity {
  owner: string;
  keyId: string | null;
  // The machine the token belongs to; absent from a server that does not say.
  machine?: string;
  // The API range the server speaks: its own break level and the oldest client level it serves.
  api: { version: number; minClient: number };
  // What the server can do beyond the range; the baseline for a server that names none.
  features: ReadonlySet<string>;
  // The newest CLI release the board knows of; absent from a server that does not say.
  cli?: string;
  // The blind index of the directory list this machine last sent; absent when the board holds none or does not say.
  dirsIndex?: string;
  // The same for the catalogue of skills and models.
  catalogIndex?: string;
  // The same for the usage status.
  usageIndex?: string;
}

// Asks the server for its API range and refuses a CLI the server no longer serves and a server older than the CLI
// works with; returns whose board it is.
export async function verifyContract(
  config: Pick<WebConfig, 'url' | 'token'>,
  fetcher?: Fetch,
  timeoutMs?: number,
): Promise<ServerIdentity> {
  let version: unknown;
  let served: { version: number; minClient: number };
  try {
    version = await callServer(config, 'version', {}, fetcher, timeoutMs);
    served = parseVersion(version);
  } catch (error) {
    // A server from before the version command.
    if (error instanceof BackendError && error.status === 404 && error.fromApi) {
      throw mismatch(
        'server-older',
        `the board server is older than this CLI: it does not know the version command; the CLI needs API ${MIN_SERVER} or newer; update the board server`,
        404,
      );
    }
    throw asBackendError('version', error);
  }
  if (API_VERSION < served.minClient)
    throw mismatch(
      'cli-older',
      `this CLI is older than the board server: it speaks API ${API_VERSION}, the server serves clients from ${served.minClient}; ${updateCliHint()}`,
    );
  if (served.version < MIN_SERVER)
    throw mismatch(
      'server-older',
      `the board server is older than this CLI: it speaks API ${served.version}, the CLI needs ${MIN_SERVER} or newer; update the board server`,
    );
  try {
    const identity = parseVersionIdentity(version);
    const machine = parseVersionMachine(version);
    const cli = parseVersionCli(version);
    const dirsIndex = parseVersionDirsIndex(version);
    const catalogIndex = parseVersionCatalogIndex(version);
    const usageIndex = parseVersionUsageIndex(version);
    return {
      ...identity,
      ...(machine === null ? {} : { machine }),
      api: served,
      features: parseVersionFeatures(version),
      ...(cli === null ? {} : { cli }),
      ...(dirsIndex === null ? {} : { dirsIndex }),
      ...(catalogIndex === null ? {} : { catalogIndex }),
      ...(usageIndex === null ? {} : { usageIndex }),
    };
  } catch (error) {
    throw asBackendError('version', error);
  }
}

export type DataKeyCheck =
  { keys: Keys } | { problem: 'board-has-no-key' } | { problem: 'different-key'; mine: string; boards: string };

// Whether the data key is the board's: derives the keys for this board's owner and compares key ids.
export async function checkDataKey(dataKey: Uint8Array, identity: ServerIdentity): Promise<DataKeyCheck> {
  if (identity.keyId === null) return { problem: 'board-has-no-key' };
  const keys = await deriveKeys(dataKey, identity.owner, { index: true });
  if (keys.keyId !== identity.keyId) return { problem: 'different-key', mine: keys.keyId, boards: identity.keyId };
  return { keys };
}

export function keyProblemMessage(problem: Exclude<DataKeyCheck, { keys: Keys }>): string {
  return problem.problem === 'board-has-no-key'
    ? 'the board has no data key yet: set up encryption in the browser first'
    : `this machine holds a different data key (id ${problem.mine}) than the board's (id ${problem.boards}): copy the current key from the board's Settings page into AGENT_BOARD_DATA_KEY`;
}
