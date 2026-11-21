// What a source keeps on this machine, in `<stateDir>/sources/`:
//   <name>.json   paused, the last run and its outcome, a run asked for now, and the task of every key it scheduled
//   <name>.lock   the pid of the process running it, so the watch unit and `board sources run` never run it twice at once
// The board's keys cannot be read back, so the key → task map is how a source finds the tasks of items that went away.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isRecord, isSourceId } from '@agent-board/shared';
import { getPaths } from '../config/config.mts';

export interface SourceCounts {
  listed: number;
  created: number;
  requeued: number;
  closed: number;
  failed: number;
}

export interface SourceRun {
  at: string;
  ok: boolean;
  // Why the listing failed, or the first item that could not be scheduled.
  error?: string;
  counts: SourceCounts;
}

export interface SourceState {
  paused: boolean;
  // Asked for with `board sources run --later` or from the board: the next scan runs it whatever its timer says.
  runNow: boolean;
  // The opaque id the board and its requests know the source by; made on first publish.
  id?: string;
  last?: SourceRun;
  tasks: Record<string, string>;
}

export interface SourceStore {
  read: (name: string) => SourceState;
  write: (name: string, state: SourceState) => void;
  // Takes the run lock; false while another live process holds it.
  lock: (name: string) => boolean;
  unlock: (name: string) => void;
}

const EMPTY: SourceState = { paused: false, runNow: false, tasks: {} };

const ZERO: SourceCounts = { listed: 0, created: 0, requeued: 0, closed: 0, failed: 0 };

function parseRun(value: unknown): SourceRun | undefined {
  if (!isRecord(value) || typeof value['at'] !== 'string' || typeof value['ok'] !== 'boolean') return undefined;
  const counts = isRecord(value['counts']) ? value['counts'] : {};
  const count = (name: keyof SourceCounts): number => {
    const n = counts[name];
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0;
  };
  return {
    at: value['at'],
    ok: value['ok'],
    ...(typeof value['error'] === 'string' ? { error: value['error'] } : {}),
    counts: {
      listed: count('listed'),
      created: count('created'),
      requeued: count('requeued'),
      closed: count('closed'),
      failed: count('failed'),
    },
  };
}

export function parseSourceState(value: unknown): SourceState {
  if (!isRecord(value)) return EMPTY;
  const tasks: Record<string, string> = {};
  if (isRecord(value['tasks']))
    for (const [key, id] of Object.entries(value['tasks'])) if (typeof id === 'string') tasks[key] = id;
  const last = parseRun(value['last']);
  return {
    ...(isSourceId(value['id']) ? { id: value['id'] } : {}),
    paused: value['paused'] === true,
    runNow: value['runNow'] === true,
    ...(last === undefined ? {} : { last }),
    tasks,
  };
}

export const zeroCounts = (): SourceCounts => ({ ...ZERO });

export function createSourceStore(
  dir: string = join(getPaths().stateDir, 'sources'),
  isAlive: (pid: number) => boolean,
): SourceStore {
  const file = (name: string, ext: string): string => join(dir, `${name}.${ext}`);
  const ensure = (): void => void mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    read: (name) => {
      try {
        return parseSourceState(JSON.parse(readFileSync(file(name, 'json'), 'utf8')));
      } catch {
        return EMPTY;
      }
    },
    write: (name, state) => {
      ensure();
      const target = file(name, 'json');
      const temp = `${target}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, target);
    },
    lock: (name) => {
      ensure();
      const target = file(name, 'lock');
      for (let tries = 0; tries < 2; tries++) {
        try {
          writeFileSync(target, String(process.pid), { flag: 'wx', mode: 0o600 });
          return true;
        } catch {
          let holder: number;
          try {
            holder = Number(readFileSync(target, 'utf8'));
          } catch {
            continue;
          }
          if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) return false;
          rmSync(target, { force: true });
        }
      }
      return false;
    },
    unlock: (name) => rmSync(file(name, 'lock'), { force: true }),
  };
}
