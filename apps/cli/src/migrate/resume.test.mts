import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { autoStep, fixture } from '../__tests__/helpers/migration.mts';
import { readJournal } from './journal.mts';
import { lockPath } from './lock.mts';
import { readMarker, writeMarker } from './marker.mts';
import { resumeMigration } from './resume.mts';

test('nothing pending brings the marker up to date and reports nothing to resume', async () => {
  const f = fixture([]);
  try {
    assert.equal(await resumeMigration(f.deps, { interactive: false }), 'nothing');
    assert.equal(readMarker(f.deps.paths.stateDir), '0.40.0');
    assert.equal(existsSync(lockPath(f.deps.paths.stateDir)), false);
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});

test('a plan from the marker runs through a backup and a journal and releases the lock', async () => {
  const f = fixture([autoStep('a', '0.39.0')]);
  try {
    writeMarker(f.deps.paths.stateDir, '0.38.0');
    assert.equal(await resumeMigration(f.deps, { interactive: false }), 'done');
    assert.equal(readMarker(f.deps.paths.stateDir), '0.40.0');
    assert.equal(readJournal(f.deps.paths.stateDir), undefined);
    assert.equal(existsSync(lockPath(f.deps.paths.stateDir)), false);
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});

test('a terminal refuses while workers run and changes nothing, but a run without one goes ahead', async () => {
  const f = fixture([autoStep('a', '0.39.0')]);
  try {
    await assert.rejects(
      resumeMigration(f.deps, { interactive: true, activeWorkers: async () => 2 }),
      /2 worker\(s\) running; run board self-update --resume again once they end/,
    );
    assert.equal(readJournal(f.deps.paths.stateDir), undefined);
    assert.equal(existsSync(lockPath(f.deps.paths.stateDir)), false);
    assert.equal(await resumeMigration(f.deps, { interactive: false, activeWorkers: async () => 2 }), 'done');
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});

test('a terminal with nothing pending does not ask about workers', async () => {
  const f = fixture([]);
  try {
    const result = await resumeMigration(f.deps, {
      interactive: true,
      activeWorkers: async () => assert.fail('no worker check expected'),
    });
    assert.equal(result, 'nothing');
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});
