import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

export const TRANSFER_TIMEOUT_MS = 5 * 60_000;

/** Clone and fetch, which may ask for credentials on the terminal and take long: each returns whether git succeeded. */
export interface Transfer {
  clone: (url: string, dest: string) => boolean;
  fetch: (dir: string) => boolean;
}

function transfer(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', ['-c', 'protocol.ext.allow=never', ...args], {
      cwd,
      timeout: TRANSFER_TIMEOUT_MS,
      stdio: ['inherit', 'ignore', 'inherit'],
    });
    return true;
  } catch {
    return false;
  }
}

export const runTransfer: Transfer = {
  clone: (url, dest) =>
    transfer(dirname(dest), [
      '-c',
      'protocol.file.allow=user',
      'clone',
      '--no-recurse-submodules',
      '--quiet',
      '--',
      url,
      dest,
    ]),
  fetch: (dir) => transfer(dir, ['fetch', '--quiet', '--no-recurse-submodules', 'origin', 'HEAD']),
};
