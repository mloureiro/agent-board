import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LockHeldError, lockPath, releaseLock, takeLock } from './lock.mts';

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

test('two takers that both see the same stale lock cannot both win', () => {
  withDir((dir) => {
    takeLock(dir, { adoptParent: false, pid: 111 });
    let raced = false;
    const alive = (pid: number): boolean => {
      if (pid !== 111) return true;
      if (!raced) {
        raced = true;
        takeLock(dir, { adoptParent: false, pid: 222, alive });
      }
      return false;
    };
    assert.throws(
      () => takeLock(dir, { adoptParent: false, pid: 333, alive }),
      (error) => error instanceof LockHeldError && error.holder === 222,
    );
    assert.equal(holder(dir), 222);
    assert.equal(existsSync(`${lockPath(dir)}.replace`), false);
  });
});

test('a taker that is replacing the lock keeps a second one out', () => {
  withDir((dir) => {
    takeLock(dir, { adoptParent: false, pid: 111 });
    writeFileSync(`${lockPath(dir)}.replace`, '222');
    assert.throws(() => takeLock(dir, { adoptParent: false, pid: 333, alive: () => false }), LockHeldError);
    assert.equal(holder(dir), 111);
  });
});

test('a replacement guard left by a dead taker is cleared once it is old', () => {
  withDir((dir) => {
    takeLock(dir, { adoptParent: false, pid: 111 });
    const guard = `${lockPath(dir)}.replace`;
    writeFileSync(guard, '222');
    const old = new Date('2026-01-01T00:00:00Z');
    utimesSync(guard, old, old);
    takeLock(dir, { adoptParent: false, pid: 333, alive: () => false, now: () => new Date('2026-01-01T00:05:00Z') });
    assert.equal(holder(dir), 333);
    assert.equal(existsSync(guard), false);
  });
});

test('a lock that is empty counts as stale and is replaced', () => {
  withDir((dir) => {
    takeLock(dir, { adoptParent: false, pid: 111 });
    writeFileSync(lockPath(dir), '');
    takeLock(dir, { adoptParent: false, pid: 222, alive: () => true });
    assert.equal(holder(dir), 222);
  });
});
