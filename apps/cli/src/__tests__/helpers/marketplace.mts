import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type FixtureFile = string | { content: string; mode: number } | { link: string };

export const VALID_MANIFEST = {
  protocol: 1,
  name: 'acme',
  description: 'Acme feeds',
  feeds: { github: { program: 'feeds/github/run', description: 'Pull requests' } },
};

export const PROGRAM_FILES: Record<string, FixtureFile> = {
  'feeds/github/run': { content: '#!/bin/sh\necho ok\n', mode: 0o755 },
};

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false'];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Writes `files` (a path with content, a content with a mode, or a link) into the repository at `dir`, commits them and returns the commit. */
export function commitFiles(dir: string, files: Record<string, FixtureFile>, message = 'change'): string {
  for (const [path, file] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    if (typeof file === 'string') writeFileSync(target, file);
    else if ('link' in file) symlinkSync(file.link, target);
    else {
      writeFileSync(target, file.content);
      chmodSync(target, file.mode);
    }
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** A git repository at `dir` holding the manifest and `files` in one commit; returns that commit. */
export function makeMarketplace(
  dir: string,
  manifest: unknown,
  files: Record<string, FixtureFile> = PROGRAM_FILES,
): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet', '-b', 'main');
  const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
  return commitFiles(dir, { '.agent-board/marketplace.json': text, ...files }, 'initial');
}
