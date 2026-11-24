import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createBackup } from './backup.mts';
import type { MigrationDeps } from './deps.mts';
import { readJournal, writeJournal } from './journal.mts';
import type { Journal } from './journal.mts';
import { readMarker, writeMarker } from './marker.mts';
import { fromVersion, planSteps } from './plan.mts';
import type { MigrationStep } from './steps.mts';
import { unitFilesOf } from './units.mts';

export interface MigrationPlan {
  from: string;
  to: string;
  steps: MigrationStep[];
}

// What this binary would apply against the marker. Reads only.
export function currentPlan(deps: MigrationDeps): MigrationPlan {
  const hasWebConfig = existsSync(join(deps.paths.configDir, 'web.json'));
  const from = fromVersion(readMarker(deps.paths.stateDir), hasWebConfig, deps.version);
  return { from, to: deps.version, steps: planSteps(deps.registry, from, deps.version) };
}

// The unfinished migration if there is a journal; otherwise a new journal (after a backup of kind steps) when the plan has
// steps. An empty plan brings the marker up to this version and returns nothing.
export function pendingMigration(deps: MigrationDeps): Journal | undefined {
  const { stateDir, configDir } = deps.paths;
  const existing = readJournal(stateDir);
  if (existing !== undefined) return existing;
  const plan = currentPlan(deps);
  if (plan.steps.length === 0) {
    if (readMarker(stateDir) !== deps.version) writeMarker(stateDir, deps.version);
    return undefined;
  }
  const now = deps.now();
  const backup = createBackup({
    stateDir,
    kind: 'steps',
    from: plan.from,
    to: plan.to,
    cliApi: deps.cliApi,
    configDir,
    unitFiles: unitFilesOf(deps.platform, deps.env, deps.home),
    platform: deps.platform,
    now,
  });
  const journal: Journal = {
    version: 1,
    from: plan.from,
    to: plan.to,
    steps: plan.steps.map((step) => step.id),
    done: [],
    backup: backup.name,
    startedAt: now.toISOString(),
  };
  writeJournal(stateDir, journal);
  return journal;
}
