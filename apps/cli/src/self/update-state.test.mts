import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createUpdateState, updateStateFile } from './update-state.mts';

const NOW = new Date('2026-01-01T12:00:00Z');

test('the state file is update.json in the state directory', () => {
  assert.equal(updateStateFile('/state'), '/state/update.json');
});

test('the state file survives a missing, broken or unwritable place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-state-test-'));
  try {
    const path = join(dir, 'nested', 'update.json');
    const state = createUpdateState(path);
    assert.equal(state.hintShownAt(), undefined);
    state.markHintShown(NOW);
    state.deferUpdateUntil(NOW);
    assert.deepEqual(createUpdateState(path).hintShownAt(), NOW);
    state.clearDeferral();
    assert.equal(createUpdateState(path).retryAfter(), undefined);
    assert.deepEqual(createUpdateState(path).hintShownAt(), NOW);
    writeFileSync(path, 'not json');
    assert.equal(createUpdateState(path).hintShownAt(), undefined);
    writeFileSync(join(dir, 'file'), '');
    assert.doesNotThrow(() => createUpdateState(join(dir, 'file', 'update.json')).markHintShown(NOW));
    assert.equal(readFileSync(join(dir, 'file'), 'utf8'), '');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the hold survives other writes, is set by version, and is cleared on its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-state-test-'));
  try {
    const path = join(dir, 'update.json');
    const state = createUpdateState(path);
    state.holdThrough('0.40.0');
    state.deferUpdateUntil(NOW);
    state.markHintShown(NOW);
    state.clearDeferral();
    assert.equal(createUpdateState(path).heldThrough(), '0.40.0');
    state.clearHold();
    assert.equal(createUpdateState(path).heldThrough(), undefined);
    assert.deepEqual(createUpdateState(path).hintShownAt(), NOW);
    writeFileSync(path, '{"heldThrough":"latest"}');
    assert.equal(createUpdateState(path).heldThrough(), undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
