import assert from 'node:assert/strict';
import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { autoStep, fixture } from '../__tests__/helpers/migration.mts';
import { createBackup } from './backup.mts';
import { pendingMigration } from './pending.mts';
import { writeMarker } from './marker.mts';
import { readMigrationState } from './state.mts';
import { unitFilesOf } from './units.mts';

test('a machine with nothing pending and no backups reports an empty state', () => {
  const f = fixture([]);
  try {
    writeMarker(f.deps.paths.stateDir, '0.40.0');
    assert.deepEqual(readMigrationState(f.deps), { journal: undefined, waitingSteps: 0, looseBackups: [] });
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});

test('steps a marker leaves behind count as waiting until a journal exists for them', () => {
  const f = fixture([autoStep('a', '0.38.0')]);
  try {
    writeMarker(f.deps.paths.stateDir, '0.37.0');
    assert.equal(readMigrationState(f.deps).waitingSteps, 1);
    pendingMigration(f.deps);
    const state = readMigrationState(f.deps);
    assert.equal(state.waitingSteps, 0);
    assert.ok(state.journal !== undefined && 'present' in state.journal);
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});

test('backups wider than 700 and 600 are listed, and ones made by the CLI are not', () => {
  const f = fixture([]);
  try {
    const { stateDir, configDir } = f.deps.paths;
    const backup = createBackup({
      stateDir,
      kind: 'steps',
      from: '0.37.0',
      to: '0.40.0',
      cliApi: 9,
      configDir,
      unitFiles: unitFilesOf('linux', f.deps.env, f.deps.home),
      platform: 'linux',
      now: f.clock.now,
    });
    assert.deepEqual(readMigrationState(f.deps).looseBackups, []);
    chmodSync(join(backup.dir, 'config', 'env'), 0o644);
    chmodSync(backup.dir, 0o755);
    const loose = readMigrationState(f.deps).looseBackups;
    assert.ok(loose.includes(backup.dir));
    assert.ok(loose.includes(join(backup.dir, 'config', 'env')));
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});
