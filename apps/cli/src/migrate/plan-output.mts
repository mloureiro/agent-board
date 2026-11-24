import { execFile } from 'node:child_process';
import { isRecord } from '@agent-board/shared';
import { SystemError } from '../setup/system.mts';
import { STEP_ID_PATTERN, VERSION_PATTERN } from './layout.mts';

export interface PlannedStep {
  id: string;
  since: string;
  title: string;
  kind: 'auto' | 'person';
}

export interface Plan {
  from: string;
  to: string;
  steps: PlannedStep[];
}

const TITLE = /^[^\p{C}]{1,200}$/u;
const MAX_STEPS = 100;
const PLAN_TIMEOUT_MS = 20_000;
const PLAN_MAX_BYTES = 64 * 1024;

function stepOf(value: unknown): PlannedStep | undefined {
  if (!isRecord(value)) return undefined;
  const { id, since, title, kind } = value;
  if (typeof id !== 'string' || !STEP_ID_PATTERN.test(id)) return undefined;
  if (typeof since !== 'string' || !VERSION_PATTERN.test(since)) return undefined;
  if (typeof title !== 'string' || !TITLE.test(title)) return undefined;
  if (kind !== 'auto' && kind !== 'person') return undefined;
  return { id, since, title, kind };
}

// The output of `internal migration-plan --json` of a binary that has not been trusted yet.
export function parsePlan(output: string): Plan {
  const bad = (): SystemError =>
    new SystemError('the new binary did not answer its migration plan in the expected form');
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    throw bad();
  }
  if (!isRecord(raw)) throw bad();
  const { from, to } = raw;
  const list = raw['steps'];
  if (typeof from !== 'string' || !VERSION_PATTERN.test(from)) throw bad();
  if (typeof to !== 'string' || !VERSION_PATTERN.test(to)) throw bad();
  if (!Array.isArray(list) || list.length > MAX_STEPS) throw bad();
  const steps = list.map(stepOf);
  const known = steps.filter((step): step is PlannedStep => step !== undefined);
  if (known.length !== steps.length || new Set(known.map((step) => step.id)).size !== known.length) throw bad();
  return { from, to, steps: known };
}

export function realPlanOf(env: Record<string, string | undefined>): (staged: string) => Promise<Plan> {
  return (staged) =>
    new Promise((resolve, reject) => {
      execFile(
        staged,
        ['internal', 'migration-plan', '--json'],
        { timeout: PLAN_TIMEOUT_MS, maxBuffer: PLAN_MAX_BYTES, env },
        (error, stdout) => {
          if (error !== null)
            return reject(
              new SystemError(`the new binary could not tell its migration plan: ${error.message.split('\n')[0]}`),
            );
          try {
            resolve(parsePlan(stdout));
          } catch (failure) {
            reject(failure);
          }
        },
      );
    });
}
