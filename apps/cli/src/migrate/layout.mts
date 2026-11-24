import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
export const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const migrationDir = (stateDir: string): string => join(stateDir, 'migration');
export const backupsDir = (stateDir: string): string => join(stateDir, 'backups');

// Written beside its place with its final mode and renamed over it, so a reader sees the old file or the new one.
export function writeFileAtomic(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  rmSync(temp, { force: true });
  try {
    writeFileSync(temp, text, { mode, flag: 'wx' });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

// Written beside its place with its final mode, to be renamed over it later; an unpredictable name made exclusively, so nobody
// who can write that directory can plant it first.
export function stageFile(dest: string, content: Buffer | string, mode: number, label: string): string {
  const temp = join(dirname(dest), `.${basename(dest)}.${label}-${randomBytes(8).toString('hex')}`);
  writeFileSync(temp, content, { flag: 'wx', mode });
  chmodSync(temp, mode);
  return temp;
}
