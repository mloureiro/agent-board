import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

// Not flock: the CLI also runs on Bun, which has no flock. A taker that dies leaves a lock whose pid is gone.
export function takeLock(stateDir: string, options: LockOptions): void {
  const pid = options.pid ?? process.pid;
  const parentPid = options.parentPid ?? process.ppid;
  const alive = options.alive ?? pidAlive;
  const path = lockPath(stateDir);
  const text = `${JSON.stringify({ pid, startedAt: (options.now ?? (() => new Date()))().toISOString() })}\n`;
  mkdirSync(migrationDir(stateDir), { recursive: true, mode: 0o700 });
  const held = (holder: number): SystemError =>
    new SystemError(`another migration is running (pid ${holder}); wait for it to end`);
  try {
    writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
    return;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const holder = holderOf(path);
  if (holder === pid) return;
  if (holder !== undefined && alive(holder)) {
    if (!(options.adoptParent && holder === parentPid)) throw held(holder);
    const temp = `${path}.tmp-${pid}`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, path);
    return;
  }
  rmSync(path, { force: true });
  try {
    writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw held(holderOf(path) ?? 0);
    throw error;
  }
}

export function releaseLock(stateDir: string, pid: number = process.pid): void {
  const path = lockPath(stateDir);
  if (holderOf(path) === pid) rmSync(path, { force: true });
}
