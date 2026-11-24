import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@agent-board/shared';
import { SystemError } from '../setup/system.mts';
import { migrationDir, VERSION_PATTERN, writeFileAtomic } from './layout.mts';

export const markerPath = (stateDir: string): string => join(migrationDir(stateDir), 'applied.json');

export function readMarker(stateDir: string): string | undefined {
  const path = markerPath(stateDir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new SystemError(`cannot read ${path}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SystemError(`${path} is not valid JSON; delete it to start from the baseline`);
  }
  const applied = isRecord(raw) ? raw['appliedThrough'] : undefined;
  if (typeof applied !== 'string' || !VERSION_PATTERN.test(applied))
    throw new SystemError(`${path} does not hold an appliedThrough version; delete it to start from the baseline`);
  return applied;
}

export function writeMarker(stateDir: string, version: string): void {
  writeFileAtomic(markerPath(stateDir), `${JSON.stringify({ appliedThrough: version }, null, 2)}\n`, 0o600);
}
