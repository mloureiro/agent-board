import { SystemError } from '../setup/system.mts';
import type { MigrationDeps } from './deps.mts';
import { releaseLock, takeLock } from './lock.mts';
import { readJournal } from './journal.mts';
import { currentPlan, pendingMigration } from './pending.mts';
import { runMigration } from './runner.mts';
import type { RunResult } from './runner.mts';

export interface ResumeOptions {
  interactive: boolean;
  // How many workers run now; asked only when a person at a terminal resumes, because a worker keeps the code it started with.
  activeWorkers?: () => Promise<number>;
}

// `board self-update --resume`: continue a stopped migration, or start the one this binary's version needs.
export async function resumeMigration(deps: MigrationDeps, options: ResumeOptions): Promise<RunResult | 'nothing'> {
  const { stateDir } = deps.paths;
  takeLock(stateDir, { adoptParent: true });
  try {
    const waiting = readJournal(stateDir) !== undefined || currentPlan(deps).steps.length > 0;
    if (waiting && options.interactive && options.activeWorkers !== undefined) {
      const running = await options.activeWorkers();
      if (running > 0)
        throw new SystemError(`${running} worker(s) running; run board self-update --resume again once they end`);
    }
    if (pendingMigration(deps) === undefined) return 'nothing';
    return await runMigration(deps, { interactive: options.interactive });
  } finally {
    releaseLock(stateDir);
  }
}
