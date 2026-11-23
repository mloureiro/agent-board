import { readFileSync } from 'node:fs';
import { UsageError } from '../cli.mts';
import { plainLine } from '../output/terminal.mts';

export function readTextFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown error';
    throw new UsageError(`cannot read ${plainLine(path)} (${code})`);
  }
}
