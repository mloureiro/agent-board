import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@agent-board/shared';
import { SystemError } from '../setup/system.mts';
import { migrationDir, STEP_ID_PATTERN, VERSION_PATTERN, writeFileAtomic } from './layout.mts';

export interface JournalStop {
  id: string;
  reason: 'failed' | 'needs-person';
  message: string;
  at: string;
}

export interface Journal {
  version: 1;
  from: string;
  to: string;
  steps: string[];
  done: string[];
  stopped?: JournalStop;
  backup: string;
  startedAt: string;
}

export const journalPath = (stateDir: string): string => join(migrationDir(stateDir), 'journal.json');

const BACKUP_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && STEP_ID_PATTERN.test(item))
    ? (value as string[])
    : undefined;
}

function stopOf(value: unknown): JournalStop | undefined {
  if (!isRecord(value)) return undefined;
  const { id, reason, message, at } = value;
  if (typeof id !== 'string' || !STEP_ID_PATTERN.test(id)) return undefined;
  if (reason !== 'failed' && reason !== 'needs-person') return undefined;
  if (typeof message !== 'string' || typeof at !== 'string') return undefined;
  return { id, reason, message, at };
}

function parseJournal(raw: unknown): Journal | undefined {
  if (!isRecord(raw) || raw['version'] !== 1) return undefined;
  const { from, to, backup, startedAt } = raw;
  const steps = stringList(raw['steps']);
  const done = stringList(raw['done']);
  if (typeof from !== 'string' || !VERSION_PATTERN.test(from)) return undefined;
  if (typeof to !== 'string' || !VERSION_PATTERN.test(to)) return undefined;
  if (typeof backup !== 'string' || !BACKUP_NAME.test(backup)) return undefined;
  if (typeof startedAt !== 'string') return undefined;
  if (steps === undefined || done === undefined || !done.every((id) => steps.includes(id))) return undefined;
  const base: Journal = { version: 1, from, to, steps, done, backup, startedAt };
  if (raw['stopped'] === undefined) return base;
  const stopped = stopOf(raw['stopped']);
  return stopped === undefined || !steps.includes(stopped.id) ? undefined : { ...base, stopped };
}

export function readJournal(stateDir: string): Journal | undefined {
  const path = journalPath(stateDir);
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
    throw new SystemError(`the migration journal ${path} is not valid JSON; nothing was changed`);
  }
  const journal = parseJournal(raw);
  if (journal === undefined)
    throw new SystemError(`the migration journal ${path} is not in the expected shape; nothing was changed`);
  return journal;
}

export function writeJournal(stateDir: string, journal: Journal): void {
  writeFileAtomic(journalPath(stateDir), `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

export function deleteJournal(stateDir: string): void {
  rmSync(journalPath(stateDir), { force: true });
}
