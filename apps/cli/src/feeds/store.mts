// What a feed keeps on this machine, in `<stateDir>/feeds/`, split by who writes it:
//   <name>.control.json   the pause, a run asked for, and the id the board knows the feed by: the verbs and the board's requests
//   <name>.json           the last runs and the task of every key it scheduled: the runner only
//   <name>.lock           the pid of the process running it, so the watch unit and `board feeds run` never run it twice at once
// The board's keys cannot be read back, so the key → task map is how a feed finds the tasks of items that went away.
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  startedAt: string;
  at: string;
  ok: boolean;
  error?: string;
  counts: FeedCounts;
}

export interface FeedControl {
  id?: string;
  paused: boolean;
  runRequestedAt?: string;
}

export interface FeedRecord {
  last?: FeedRun;
  history: FeedRun[];
  tasks: Record<string, string>;
}

export interface FeedControlPatch {
  paused?: boolean;
  runRequestedAt?: string;
}

export interface FeedStore {
  readControl: (name: string) => FeedControl;
  updateControl: (name: string, patch: FeedControlPatch) => FeedControl & { id: string };
  readRecord: (name: string) => FeedRecord;
  writeRecord: (name: string, record: FeedRecord) => void;
  lock: (name: string) => boolean;
  unlock: (name: string) => void;
  discard: (name: string) => void;
}

export const HISTORY_LIMIT = 10;

const EMPTY_CONTROL: FeedControl = { paused: false };

const ZERO: FeedCounts = { listed: 0, created: 0, requeued: 0, closed: 0, failed: 0 };

const isInstant = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

function parseRun(value: unknown): FeedRun | undefined {
  if (!isRecord(value) || !isInstant(value['at']) || typeof value['ok'] !== 'boolean') return undefined;
  const counts = isRecord(value['counts']) ? value['counts'] : {};
  const count = (name: keyof FeedCounts): number => {
    const n = counts[name];
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0;
  };
  return {
    startedAt: isInstant(value['startedAt']) ? value['startedAt'] : value['at'],
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

export function parseFeedControl(value: unknown): FeedControl {
  if (!isRecord(value)) return EMPTY_CONTROL;
  return {
    ...(isFeedId(value['id']) ? { id: value['id'] } : {}),
    paused: value['paused'] === true,
    ...(isInstant(value['runRequestedAt']) ? { runRequestedAt: value['runRequestedAt'] } : {}),
  };
}

export function parseFeedRecord(value: unknown): FeedRecord {
  if (!isRecord(value)) return { history: [], tasks: {} };
  const tasks: Record<string, string> = {};
  if (isRecord(value['tasks']))
    for (const [key, id] of Object.entries(value['tasks'])) if (typeof id === 'string') tasks[key] = id;
  const last = parseRun(value['last']);
  const history = Array.isArray(value['history'])
    ? value['history'].flatMap((run) => parseRun(run) ?? []).slice(0, HISTORY_LIMIT)
    : [];
  return { ...(last === undefined ? {} : { last }), history, tasks };
}

export const zeroCounts = (): FeedCounts => ({ ...ZERO });

export function createFeedStore(
  dir: string = join(getPaths().stateDir, 'feeds'),
  isAlive: (pid: number) => boolean,
): FeedStore {
  const file = (name: string, ext: string): string => join(dir, `${name}.${ext}`);
  const ensure = (): void => void mkdirSync(dir, { recursive: true, mode: 0o700 });
  const readJson = (path: string): unknown => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return undefined;
    }
  };
  const tempFile = (target: string, value: unknown): string => {
    ensure();
    const temp = `${target}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    return temp;
  };
  const replace = (target: string, value: unknown): void => renameSync(tempFile(target, value), target);
  const readControl = (name: string): FeedControl => parseFeedControl(readJson(file(name, 'control.json')));
  return {
    readControl,
    updateControl: (name, patch) => {
      ensure();
      const target = file(name, 'control.json');
      const fresh = { ...EMPTY_CONTROL, ...patch, id: randomBytes(8).toString('hex') };
      const temp = tempFile(target, fresh);
      try {
        linkSync(temp, target);
        return fresh;
      } catch {
        const current = readControl(name);
        const merged = { ...current, ...patch, id: current.id ?? fresh.id };
        if (current.id !== undefined && JSON.stringify(merged) === JSON.stringify(current)) return merged;
        replace(target, merged);
        return merged;
      } finally {
        rmSync(temp, { force: true });
      }
    },
    readRecord: (name) => parseFeedRecord(readJson(file(name, 'json'))),
    writeRecord: (name, record) => replace(file(name, 'json'), record),
    lock: (name) => {
      ensure();
      const target = file(name, 'lock');
      for (let tries = 0; tries < 2; tries++) {
        try {
          writeFileSync(target, String(process.pid), { flag: 'wx', mode: 0o600 });
          return true;
        } catch {
          let heldText: string;
          try {
            heldText = readFileSync(target, 'utf8');
          } catch {
            continue;
          }
          const holder = Number(heldText);
          if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) return false;
          const stale = `${target}.stale-${process.pid}-${randomBytes(3).toString('hex')}`;
          try {
            renameSync(target, stale);
          } catch {
            continue;
          }
          if (readFileSync(stale, 'utf8') !== heldText) {
            try {
              linkSync(stale, target);
            } catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
              // A third process locked in the meantime: its lock stands, and the process whose lock was moved runs unguarded.
            }
            rmSync(stale, { force: true });
            return false;
          }
          rmSync(stale, { force: true });
        }
      }
      return false;
    },
    unlock: (name) => rmSync(file(name, 'lock'), { force: true }),
    discard: (name) => {
      rmSync(file(name, 'json'), { force: true });
      rmSync(file(name, 'control.json'), { force: true });
    },
  };
}
