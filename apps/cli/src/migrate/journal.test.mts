import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { journalPath, readJournal, writeJournal } from './journal.mts';
import type { Journal } from './journal.mts';

const good: Journal = {
  version: 1,
  from: '0.38.0',
  to: '0.40.0',
  steps: ['a', 'b'],
  done: ['a'],
  stopped: { id: 'b', reason: 'failed', message: 'boom', at: '2026-11-24T10:00:00.000Z' },
  backup: '2026-11-24T10-15-03Z-steps-0.38.0-0.40.0',
  startedAt: '2026-11-24T10:00:00.000Z',
};

test('a journal reads back what was written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-journal-test-'));
  try {
    writeJournal(dir, good);
    assert.deepEqual(readJournal(dir), good);
    assert.equal(readJournal(join(dir, 'empty')), undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a journal with a bad shape is an error that names its path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-journal-test-'));
  const bad: unknown[] = [
    { ...good, version: 2 },
    { ...good, done: ['zzz'] },
    { ...good, steps: ['../x'] },
    { ...good, backup: '../../etc' },
    { ...good, stopped: { ...good.stopped, reason: 'other' } },
    { ...good, from: 'latest' },
    'text',
  ];
  try {
    mkdirSync(join(dir, 'migration'));
    for (const value of bad) {
      writeFileSync(journalPath(dir), JSON.stringify(value));
      assert.throws(() => readJournal(dir), new RegExp(journalPath(dir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    writeFileSync(journalPath(dir), '{not json');
    assert.throws(() => readJournal(dir), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
