// The dispatcher updates this CLI by itself, when the config allows it (`autoUpdate`).
import { compareVersions } from '@agent-board/shared';
import type { UpdateState } from './update-state.mts';
import { errorText } from '../output/text.mts';

// After a failed update (no gh, not logged in, a download cut off) the dispatcher does not try again for this long.
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
// The board advertises a release before it is published; that clears up soon.
export const RETRY_AFTER_UNPUBLISHED_MS = 5 * 60 * 1000;

export interface UpdateDeps {
  // Whether this is a released binary; a checkout cannot replace itself.
  compiled: boolean;
  // This CLI's version.
  version: string;
  // The newest release the board advertised, known once a call reached it.
  advertised: () => string | undefined;
  state: UpdateState;
  // Replaces the binary and restarts the listener: self-update with real dependencies.
  update: () => Promise<'updated' | 'unchanged'>;
}

export interface UpdateRun extends UpdateDeps {
  now: () => Date;
  log: (line: string) => void;
  dryRun: boolean;
}

// How an attempt ended: `unavailable` means none was made because this machine cannot update itself or is only reading.
export type UpdateOutcome = 'updated' | 'failed' | 'backoff' | 'unavailable';

// Whether the board advertises a release newer than this CLI.
export function isBehind({
  advertised,
  version,
}: Pick<UpdateDeps, 'version'> & { advertised: string | undefined }): boolean {
  return advertised !== undefined && compareVersions(advertised, version) > 0;
}

export async function tryUpdate(run: UpdateRun, why: string): Promise<UpdateOutcome> {
  const { log, state } = run;
  if (!run.compiled) {
    log(`UPDATE-NEEDED ${why}; run "git pull" and "pnpm install" in the checkout`);
    return 'unavailable';
  }
  if (run.dryRun) {
    log(`DRY self-update (${why})`);
    return 'unavailable';
  }
  const held = state.heldThrough();
  const advertised = run.advertised();
  if (held !== undefined && advertised !== undefined && compareVersions(advertised, held) <= 0) {
    log(`UPDATE-HELD ${advertised} was rolled back; run "board self-update" to take it`);
    return 'unavailable';
  }
  const retryAfter = state.retryAfter();
  if (retryAfter !== undefined && run.now() < retryAfter) {
    log(`UPDATE-SKIPPED ${why}; the last attempt did not finish, the next one is after ${retryAfter.toISOString()}`);
    return 'backoff';
  }
  // Written first: a tick that is killed by its time limit never reaches the code below, and must not start over.
  state.deferUpdateUntil(new Date(run.now().getTime() + RETRY_AFTER_FAILURE_MS));
  try {
    log(`UPDATING ${why}`);
    if ((await run.update()) === 'unchanged') {
      state.deferUpdateUntil(new Date(run.now().getTime() + RETRY_AFTER_UNPUBLISHED_MS));
      log('UPDATE-FAILED no newer release is published yet; trying again in 5 min');
      return 'failed';
    }
    state.clearDeferral();
    return 'updated';
  } catch (error) {
    log(`UPDATE-FAILED ${errorText(error)}; not trying again for 1 h`);
    return 'failed';
  }
}
