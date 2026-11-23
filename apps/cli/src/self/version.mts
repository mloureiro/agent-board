import { readFileSync } from 'node:fs';
import { API_VERSION } from '@agent-board/shared';

export const RELEASE_REPO = 'mloureiro/agent-board';

// Set by `bun build --define` in a released binary.
declare const BOARD_VERSION: string | undefined;

// The version a release was built as; undefined in a checkout.
export function releaseVersion(): string | undefined {
  return typeof BOARD_VERSION === 'string' ? BOARD_VERSION : undefined;
}

// A checkout reports its package version as a development build.
export function cliVersion(): string {
  const released = releaseVersion();
  if (released !== undefined) return released;
  const raw: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const version = typeof raw === 'object' && raw !== null && 'version' in raw ? raw.version : undefined;
  return `${typeof version === 'string' ? version : '0.0.0'}-dev`;
}

export function versionLine(version: string, compiled: boolean): string {
  const updater = compiled ? `updates from ${RELEASE_REPO}` : 'updates with git pull';
  return `board ${version} (api ${API_VERSION}, ${updater})`;
}
