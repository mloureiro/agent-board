import { statSync } from 'node:fs';
import type { GitRunner } from '../config/checkout-repo.mts';

export const LOCAL_CHANGES_ADVICE =
  'discard them with git checkout -- . in that directory, or keep a copy elsewhere first';

export const localChangesProblem = (name: string, dir: string): string =>
  `marketplace ${name} has local changes in ${dir}; ${LOCAL_CHANGES_ADVICE}`;

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Whether tracked files of the checkout differ from HEAD; undefined when git fails. */
export function hasLocalChanges(dir: string, git: GitRunner): boolean | undefined {
  const status = git(dir, ['status', '--porcelain', '--untracked-files=no']);
  return status === undefined ? undefined : status !== '';
}

/** Why the checkout at `dir` is not the code installed as `entry`, or undefined when HEAD is the pin and no tracked file changed. */
export function verifyPin(entry: { name: string; commit: string }, dir: string, git: GitRunner): string | undefined {
  if (!isDirectory(dir))
    return `marketplace ${entry.name}: the checkout ${dir} is missing; remove it with board plugins remove ${entry.name} and install it again`;
  const head = git(dir, ['rev-parse', 'HEAD']);
  if (head === undefined) return `git failed in ${dir}`;
  if (head !== entry.commit)
    return `marketplace ${entry.name} is not at its pinned commit ${entry.commit.slice(0, 12)} (HEAD ${head.slice(0, 12)}); run board plugins update ${entry.name} to accept the new code`;
  const changed = hasLocalChanges(dir, git);
  if (changed === undefined) return `git failed in ${dir}`;
  return changed ? localChangesProblem(entry.name, dir) : undefined;
}
