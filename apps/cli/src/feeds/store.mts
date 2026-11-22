// What a feed keeps on this machine, in `<stateDir>/feeds/`:
//   <name>.json   paused, the last run and its outcome, a run asked for now, and the task of every key it scheduled
//   <name>.lock   the pid of the process running it, so the watch unit and `board feeds run` never run it twice at once
// The board's keys cannot be read back, so the key → task map is how a feed finds the tasks of items that went away.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isRecord, isFeedId } from '@agent-board/shared';
import { getPaths } from '../config/config.mts';

export interface FeedCounts {
  listed: number;
  created: number;
  requeued: number;
  closed: number;
  failed: number;
}

export interface FeedRun {
  at: string;
  ok: boolean;
  // Why the listing failed, or the first item that could not be scheduled.
  error?: string;
  counts: FeedCounts;
}

export interface FeedState {
  paused: boolean;
  // Asked for with `board feeds run --later` or from the board: the next scan runs it whatever its timer says.
  runNow: boolean;
  // The opaque id the board and its requests know the feed by; made on first publish.
  id?: string;
  last?: FeedRun;
  tasks: Record<string, string>;
}

export interface FeedStore {
  read: (name: string) => FeedState;
  write: (name: string, state: FeedState) => void;
  // Takes the run lock; false while another live process holds it.
  lock: (name: string) => boolean;
  unlock: (name: string) => void;
}

const EMPTY: FeedState = { paused: false, runNow: false, tasks: {} };

const ZERO: FeedCounts = { listed: 0, created: 0, requeued: 0, closed: 0, failed: 0 };

function parseRun(value: unknown): FeedRun | undefined {
  if (!isRecord(value) || typeof value['at'] !== 'string' || typeof value['ok'] !== 'boolean') return undefined;
  const counts = isRecord(value['counts']) ? value['counts'] : {};
  const count = (name: keyof FeedCounts): number => {
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

export function parseFeedState(value: unknown): FeedState {
  if (!isRecord(value)) return EMPTY;
  const tasks: Record<string, string> = {};
  if (isRecord(value['tasks']))
    for (const [key, id] of Object.entries(value['tasks'])) if (typeof id === 'string') tasks[key] = id;
  const last = parseRun(value['last']);
  return {
    ...(isFeedId(value['id']) ? { id: value['id'] } : {}),
    paused: value['paused'] === true,
    runNow: value['runNow'] === true,
    ...(last === undefined ? {} : { last }),
    tasks,
  };
}

export const zeroCounts = (): FeedCounts => ({ ...ZERO });

export function createFeedStore(
  dir: string = join(getPaths().stateDir, 'feeds'),
  isAlive: (pid: number) => boolean,
): FeedStore {
  const file = (name: string, ext: string): string => join(dir, `${name}.${ext}`);
  const ensure = (): void => void mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    read: (name) => {
      try {
        return parseFeedState(JSON.parse(readFileSync(file(name, 'json'), 'utf8')));
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
