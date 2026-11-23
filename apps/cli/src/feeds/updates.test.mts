import assert from 'node:assert/strict';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../__tests__/helpers/watch.mts';
import { createFeedUpdates } from './updates.mts';

test('an update prompt is kept per task, privately, until it is dropped, and a later put replaces it', () => {
  const dir = join(tempDir(), 'updates');
  const updates = createFeedUpdates(dir);
  assert.equal(updates.read('t1'), undefined);
  updates.put('t1', 'first', 'gh');
  updates.put('t1', 'second', 'gh');
  assert.equal(updates.read('t1'), 'second');
  assert.equal(statSync(join(dir, 't1.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['t1.json']);
  updates.drop('t1');
  assert.equal(updates.read('t1'), undefined);
});

test('a task id that is not safe never reaches a path', () => {
  const dir = join(tempDir(), 'updates');
  const updates = createFeedUpdates(dir);
  assert.throws(() => updates.put('../escape', 'x', 'gh'), /is not a task id/);
  assert.equal(updates.read('../escape'), undefined);
  assert.doesNotThrow(() => updates.drop('../escape'));
});

test('a damaged file reads as no update', () => {
  const dir = join(tempDir(), 'updates');
  const updates = createFeedUpdates(dir);
  updates.put('t1', 'x', 'gh');
  writeFileSync(join(dir, 't1.json'), '{"prompt": ');
  assert.equal(updates.read('t1'), undefined);
  writeFileSync(join(dir, 't1.json'), '{"prompt": 7}');
  assert.equal(updates.read('t1'), undefined);
});
