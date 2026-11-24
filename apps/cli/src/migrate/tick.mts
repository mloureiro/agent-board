import type { MigrationDeps } from './deps.mts';
import { readJournal } from './journal.mts';
import { LockHeldError, releaseLock, takeLock } from './lock.mts';
import { currentPlan, pendingMigration } from './pending.mts';
import { runMigration } from './runner.mts';

export type TickMigration = 'none' | 'ran' | 'waiting' | 'stopped';

export interface TickMigrationRun {
  deps: MigrationDeps;
  activeWorkers: () => Promise<number>;
  tickStart: Date;
  // No step starts after this many milliseconds from the tick's start.
  startWindowMs: number;
  // A step still running this many milliseconds from the tick's start is aborted.
  abortAtMs: number;
  dryRun: boolean;
  log: (line: string) => void;
}

const RESUME = 'run "board self-update --resume"';

function pendingSteps(deps: MigrationDeps): number {
  const journal = readJournal(deps.paths.stateDir);
  if (journal !== undefined) return Math.max(1, journal.steps.length - journal.done.length);
  return currentPlan(deps).steps.length;
}

// Runs what a new release declares, from the dispatcher: the machine claims no task while anything is pending, stopped or
// running, so no worker keeps the old code against the new contract. Anything but `none` ends the tick.
export async function runPendingMigration(run: TickMigrationRun): Promise<TickMigration> {
  const { log, tickStart } = run;
  const { stateDir } = run.deps.paths;
  const pending = pendingSteps(run.deps);
  if (pending === 0) {
    if (!run.dryRun) pendingMigration(run.deps);
    return 'none';
  }
  if (run.dryRun) {
    log(`DRY migration ${pending} step(s)`);
    return 'waiting';
  }
  try {
    takeLock(stateDir, { adoptParent: false });
  } catch (error) {
    if (!(error instanceof LockHeldError)) throw error;
    log(`MIGRATION-RUNNING pid ${error.holder} runs it`);
    return 'waiting';
  }
  try {
    const stopped = readJournal(stateDir)?.stopped;
    if (stopped?.reason === 'failed') {
      log(`MIGRATION-FAILED ${stopped.id}: ${stopped.message}; ${RESUME}`);
      return 'stopped';
    }
    const workers = await run.activeWorkers();
    if (workers > 0) {
      log(`MIGRATION-WAIT ${workers} worker(s) running`);
      return 'waiting';
    }
    if (pendingMigration(run.deps) === undefined) return 'none';
    const elapsed = run.deps.now().getTime() - tickStart.getTime();
    const deps: MigrationDeps = { ...run.deps, print: (line) => log(`MIGRATION ${line}`) };
    const result = await runMigration(deps, {
      interactive: false,
      deadline: tickStart.getTime() + run.startWindowMs,
      signal: AbortSignal.timeout(Math.max(0, run.abortAtMs - elapsed)),
    });
    if (result === 'done') log('MIGRATION-DONE');
    if (result === 'out-of-time') log('MIGRATION-OUT-OF-TIME the next tick continues');
    if (result === 'stopped') {
      const after = readJournal(stateDir)?.stopped;
      if (after?.reason === 'needs-person') log(`MIGRATION-BLOCKED ${after.id}: ${after.message}; ${RESUME}`);
      else log(`MIGRATION-FAILED ${after?.id ?? 'unknown'}: ${after?.message ?? 'stopped'}; ${RESUME}`);
      return 'stopped';
    }
    return 'ran';
  } finally {
    releaseLock(stateDir);
  }
}
