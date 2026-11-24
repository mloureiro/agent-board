import { join } from 'node:path';
import { errorText } from '../output/text.mts';
import { pruneBackups } from './backup.mts';
import { stepContext } from './deps.mts';
import type { MigrationDeps } from './deps.mts';
import { readJournal, writeJournal, deleteJournal } from './journal.mts';
import type { Journal } from './journal.mts';
import { backupsDir } from './layout.mts';
import { writeMarker } from './marker.mts';
import type { MigrationStep, StepContext } from './steps.mts';
import { SystemError } from '../setup/system.mts';

export interface RunOptions {
  interactive: boolean;
  // Epoch milliseconds after which no further step starts.
  deadline?: number;
  signal?: AbortSignal;
}

export type RunResult = 'done' | 'stopped' | 'out-of-time';

const RESUME_HINT = 'run "board self-update --resume" when it is done';

type Verdict = { stop: Pick<NonNullable<Journal['stopped']>, 'reason' | 'message'> } | { unitsChanged: boolean };

async function runStep(
  deps: MigrationDeps,
  step: MigrationStep,
  context: StepContext,
  options: RunOptions,
): Promise<Verdict> {
  if (step.kind === 'auto') {
    try {
      const outcome = await step.run(context);
      return { unitsChanged: outcome?.unitsChanged === true };
    } catch (error) {
      return { stop: { reason: 'failed', message: errorText(error) } };
    }
  }
  const check = async (): Promise<boolean> => (step.check === undefined ? true : step.check(context));
  if (options.interactive) {
    deps.print(step.instruction);
    if (!(await deps.confirm('Done?'))) {
      deps.print(`migration stopped at ${step.id} (${step.title}); ${RESUME_HINT}`);
      return { stop: { reason: 'needs-person', message: step.instruction } };
    }
    if (await check()) return { unitsChanged: false };
    deps.print(`${step.id} is not done yet: its check still fails`);
    deps.print(`migration stopped at ${step.id} (${step.title}); ${RESUME_HINT}`);
    return { stop: { reason: 'needs-person', message: step.instruction } };
  }
  if (step.check !== undefined && (await step.check(context))) return { unitsChanged: false };
  deps.print(step.instruction);
  deps.print(`migration stopped at ${step.id} (${step.title}); ${RESUME_HINT}`);
  return { stop: { reason: 'needs-person', message: step.instruction } };
}

function withoutStop(journal: Journal): Journal {
  const copy = { ...journal };
  delete copy.stopped;
  return copy;
}

export async function runMigration(deps: MigrationDeps, options: RunOptions): Promise<RunResult> {
  const { stateDir } = deps.paths;
  const journal = readJournal(stateDir);
  if (journal === undefined) throw new SystemError('there is no migration to run');
  const context = stepContext(deps, options.signal ?? new AbortController().signal);
  let unitsChanged = false;
  const reloadUnits = async (): Promise<void> => {
    if (unitsChanged && deps.platform === 'linux') await deps.run('systemctl', ['--user', 'daemon-reload']);
  };
  let current: Journal = { ...journal };
  for (const id of journal.steps) {
    if (current.done.includes(id)) continue;
    if (options.deadline !== undefined && deps.now().getTime() >= options.deadline) {
      await reloadUnits();
      return 'out-of-time';
    }
    current = withoutStop(current);
    writeJournal(stateDir, current);
    const step = deps.registry.find((candidate) => candidate.id === id);
    const verdict: Verdict =
      step === undefined
        ? { stop: { reason: 'failed', message: 'this CLI does not know the step; update it' } }
        : await runStep(deps, step, context, options);
    if ('stop' in verdict) {
      current = { ...current, stopped: { id, ...verdict.stop, at: deps.now().toISOString() } };
      writeJournal(stateDir, current);
      if (verdict.stop.reason === 'failed')
        deps.print(`migration stopped at ${id} (${step?.title ?? id}): ${verdict.stop.message}`);
      await reloadUnits();
      return 'stopped';
    }
    unitsChanged ||= verdict.unitsChanged;
    current = { ...current, done: [...current.done, id] };
    writeJournal(stateDir, current);
    deps.print(`✓ ${step?.title ?? id}`);
  }
  writeMarker(stateDir, journal.to);
  await reloadUnits();
  deleteJournal(stateDir);
  pruneBackups(stateDir, 3, []);
  const restarted = await deps.restart();
  if (restarted !== undefined) deps.print(restarted);
  deps.print(`migration done; the backup stays at ${join(backupsDir(stateDir), journal.backup)}`);
  return 'done';
}
