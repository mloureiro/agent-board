import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@agent-board/shared';
import { SystemError } from '../setup/system.mts';
import { migrationDir } from './layout.mts';

export interface LockOptions {
  adoptParent: boolean;
  pid?: number;
  parentPid?: number;
  now?: () => Date;
  alive?: (pid: number) => boolean;
}

export class LockHeldError extends SystemError {
  holder: number;

  constructor(holder: number) {
    super(`another migration is running (pid ${holder}); wait for it to end`);
    this.holder = holder;
  }
}

// A taker that died while replacing a stale lock leaves its guard behind; one this old is no longer in use.
const GUARD_STALE_MS = 60_000;

export const lockPath = (stateDir: string): string => join(migrationDir(stateDir), 'lock');

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

function holderOf(path: string): number | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const pid = isRecord(raw) ? raw['pid'] : undefined;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

// A lock file appears whole or not at all: it is written under another name and linked into place, so a reader never sees it empty.
function createWhole(path: string, text: string, pid: number): boolean {
  const temp = `${path}.new-${pid}`;
  rmSync(temp, { force: true });
  writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return false;
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

function takeGuard(path: string, pid: number, now: Date): void {
  const guard = `${path}.replace`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(guard, String(pid), { flag: 'wx', mode: 0o600 });
      return;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      const age = now.getTime() - (statSync(guard, { throwIfNoEntry: false })?.mtimeMs ?? now.getTime());
      if (age <= GUARD_STALE_MS) throw new LockHeldError(holderOf(path) ?? 0);
      rmSync(guard, { force: true });
    }
  }
  throw new LockHeldError(holderOf(path) ?? 0);
}

// Not flock: the CLI also runs on Bun, which has no flock. A taker that dies leaves a lock whose pid is gone.
// A stale lock is replaced under a guard file, and judged again once the guard is held: two takers that both saw it stale cannot both win.
export function takeLock(stateDir: string, options: LockOptions): void {
  const pid = options.pid ?? process.pid;
  const parentPid = options.parentPid ?? process.ppid;
  const alive = options.alive ?? pidAlive;
  const now = options.now ?? (() => new Date());
  const path = lockPath(stateDir);
  const text = `${JSON.stringify({ pid, startedAt: now().toISOString() })}\n`;
  mkdirSync(migrationDir(stateDir), { recursive: true, mode: 0o700 });
  if (createWhole(path, text, pid)) return;
  const holder = holderOf(path);
  if (holder === pid) return;
  if (holder !== undefined && alive(holder)) {
    if (!(options.adoptParent && holder === parentPid)) throw new LockHeldError(holder);
    const temp = `${path}.tmp-${pid}`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, path);
    return;
  }
  takeGuard(path, pid, now());
  try {
    const current = holderOf(path);
    if (current === pid) return;
    if (current !== undefined && alive(current)) throw new LockHeldError(current);
    rmSync(path, { force: true });
    if (!createWhole(path, text, pid)) throw new LockHeldError(holderOf(path) ?? 0);
  } finally {
    rmSync(`${path}.replace`, { force: true });
  }
}

export function releaseLock(stateDir: string, pid: number = process.pid): void {
  const path = lockPath(stateDir);
  if (holderOf(path) === pid) rmSync(path, { force: true });
}
