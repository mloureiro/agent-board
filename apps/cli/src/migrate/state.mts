import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { errorText } from '../output/text.mts';
import { backupsDir } from './layout.mts';
import { readJournal } from './journal.mts';
import type { Journal } from './journal.mts';
import type { MigrationDeps } from './deps.mts';
import { currentPlan } from './pending.mts';
import { createUpdateState, updateStateFile } from '../self/update-state.mts';

export interface MigrationState {
  // The journal of an unfinished migration, or why it cannot be read.
  journal: { present: Journal } | { unreadable: string } | undefined;
  // Steps this binary brings that no journal covers yet: the marker is behind and the next tick or `--resume` starts them.
  waitingSteps: number;
  // Why the marker of applied migrations cannot be read: no tick can plan anything until it is fixed.
  markerProblem?: string;
  // Backup paths that are readable by anyone but the owner.
  looseBackups: string[];
  // The release a rollback holds auto-update at.
  heldThrough?: string;
}

const MAX_LISTED = 5;

function looseEntries(root: string, found: string[]): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (found.length >= MAX_LISTED) return;
    const path = join(root, name);
    const info = lstatSync(path);
    if (info.isDirectory()) {
      if ((info.mode & 0o077) !== 0) found.push(path);
      looseEntries(path, found);
    } else if ((info.mode & 0o177) !== 0) found.push(path);
  }
}

export function readMigrationState(deps: MigrationDeps): MigrationState {
  const { stateDir } = deps.paths;
  let journal: MigrationState['journal'];
  try {
    const read = readJournal(stateDir);
    journal = read === undefined ? undefined : { present: read };
  } catch (error) {
    journal = { unreadable: errorText(error) };
  }
  let waitingSteps = 0;
  let markerProblem: string | undefined;
  if (journal === undefined) {
    try {
      waitingSteps = currentPlan(deps).steps.length;
    } catch (error) {
      markerProblem = errorText(error);
    }
  }
  const looseBackups: string[] = [];
  const root = backupsDir(stateDir);
  const rootInfo = lstatSync(root, { throwIfNoEntry: false });
  if (rootInfo !== undefined) {
    if ((rootInfo.mode & 0o077) !== 0) looseBackups.push(root);
    looseEntries(root, looseBackups);
  }
  const heldThrough = createUpdateState(updateStateFile(stateDir)).heldThrough();
  return {
    journal,
    waitingSteps,
    ...(markerProblem === undefined ? {} : { markerProblem }),
    looseBackups,
    ...(heldThrough === undefined ? {} : { heldThrough }),
  };
}
