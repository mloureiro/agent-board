import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lockPath, releaseLock, takeLock } from './lock.mts';

const withDir = (run: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'board-lock-test-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
};

const holder = (dir: string): number => (JSON.parse(readFileSync(lockPath(dir), 'utf8')) as { pid: number }).pid;

test('a second taker is refused while the first pid is alive', () => {
  withDir((dir) => {
    takeLock(dir, { adoptParent: false, pid: 100, alive: () => true });
    assert.throws(() => takeLock(dir, { adoptParent: false, pid: 200, parentPid: 1, alive: () => true }), /pid 100/);
    assert.equal(holder(dir), 100);
  });
});

test('a lock whose pid is gone is replaced', () => {
  withDir((dir) => {
    takeLock(dir, { adoptParent: false, pid: 100 });
    takeLock(dir, { adoptParent: false, pid: 200, alive: () => false });
    assert.equal(holder(dir), 200);
  });
});

test('a lock that cannot be read is replaced', () => {
  withDir((dir) => {
    takeLock(dir, { adoptParent: false, pid: 100 });
    rmSync(lockPath(dir));
    takeLock(dir, { adoptParent: false, pid: 100 });
    assert.equal(holder(dir), 100);
  });
});

test('the parent hands its lock over only when adoption is asked for', () => {
  withDir((dir) => {
    takeLock(dir, { adoptParent: false, pid: 100 });
    assert.throws(
      () => takeLock(dir, { adoptParent: false, pid: 200, parentPid: 100, alive: () => true }),
      /another migration is running/,
    );
    takeLock(dir, { adoptParent: true, pid: 200, parentPid: 100, alive: () => true });
    assert.equal(holder(dir), 200);
  });
});

test('release removes the lock of the caller and leaves another process lock alone', () => {
  withDir((dir) => {
    takeLock(dir, { adoptParent: false, pid: 100 });
    releaseLock(dir, 999);
    assert.equal(existsSync(lockPath(dir)), true);
    releaseLock(dir, 100);
    assert.equal(existsSync(lockPath(dir)), false);
  });
});
