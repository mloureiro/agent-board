import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRunFiles, lockDir, runDir } from './runtime.mts';

test("an agent's definition is written private to the user, next to the task's other run files, and goes with the run", () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-run-'));
  try {
    const files = createRunFiles(join(dir, 'run'));
    files.writeAgents('abc', '{"reviewer":{}}');
    const path = files.agentsPath('abc');
    assert.equal(path, join(dir, 'run', 'abc.agents'));
    assert.equal(readFileSync(path, 'utf8'), '{"reviewer":{}}');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'run')).mode & 0o777, 0o700);
    files.clear('abc');
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the run directory: an override, the runtime directory, then on macOS the state directory', () => {
  assert.equal(runDir({ AGENT_BOARD_RUN_DIR: '/x/run', XDG_RUNTIME_DIR: '/run/user/1' }, 'linux'), '/x/run');
  assert.equal(runDir({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux'), '/run/user/1000/agent-board');
  assert.equal(runDir({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'darwin'), '/run/user/1000/agent-board');
  assert.equal(runDir({ AGENT_BOARD_STATE_DIR: '/s' }, 'darwin'), '/s/run');
  assert.equal(runDir({ XDG_STATE_HOME: '/home/me/state' }, 'darwin'), '/home/me/state/agent-board/run');
  assert.match(runDir({ HOME: '/home/me' }, 'darwin'), /\/\.local\/state\/agent-board\/run$/);
  assert.match(runDir({}, 'linux'), /^\/run\/user\/\d+\/agent-board$/);
});

test('the lock directory: the runtime directory (or /tmp) on Linux, the run directory on macOS', () => {
  assert.equal(lockDir({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux'), '/run/user/1000');
  assert.equal(lockDir({}, 'linux'), '/tmp');
  assert.equal(lockDir({ AGENT_BOARD_STATE_DIR: '/s' }, 'darwin'), '/s/run');
});

test("the agent's process group is recorded in the run directory, in a private directory, and cleared with the run", () => {
  const root = mkdtempSync(join(tmpdir(), 'board-runtime-test-'));
  try {
    const dir = join(root, 'run');
    const files = createRunFiles(dir);
    assert.equal(files.processGroup('t1'), undefined);
    files.writeProcessGroup('t1', 4321);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(files.processGroup('t1'), 4321);
    files.clear('t1');
    assert.equal(files.processGroup('t1'), undefined);
    assert.equal(existsSync(join(dir, 't1.pgid')), false);
    // A group id that is not a plain number above 1 is never signalled.
    for (const hostile of ['0', '1', '-5', 'abc', '12 34', '1.5']) {
      writeFileSync(join(dir, 't2.pgid'), hostile);
      assert.equal(files.processGroup('t2'), undefined, hostile);
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('the dispatcher marks its ticks in the run directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-runtime-test-'));
  try {
    const files = createRunFiles(join(root, 'run'));
    assert.equal(files.lastDispatchTick(), undefined);
    const at = new Date('2026-01-01T10:00:00Z');
    files.markDispatchTick(at);
    assert.equal(files.lastDispatchTick()?.getTime(), at.getTime());
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('the next due time is written whole, read back, and removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-runtime-test-'));
  try {
    const files = createRunFiles(join(root, 'run'));
    assert.equal(files.nextDue(), undefined);
    const at = new Date('2026-01-01T10:05:00Z');
    files.writeNextDue(at);
    assert.equal(files.nextDue()?.getTime(), at.getTime());
    assert.deepEqual(readdirSync(join(root, 'run')), ['dispatch.next']);
    writeFileSync(join(root, 'run', 'dispatch.next'), 'soon');
    assert.equal(files.nextDue(), undefined);
    files.writeNextDue(undefined);
    assert.deepEqual(readdirSync(join(root, 'run')), []);
    files.writeNextDue(undefined);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('a shutdown request holds the worker deadline and goes with the run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-run-'));
  try {
    const files = createRunFiles(join(dir, 'run'));
    assert.equal(files.shutdownDeadline('abc'), undefined);
    const deadline = new Date('2026-01-01T10:00:15.000Z');
    files.requestShutdown('abc', deadline);
    assert.deepEqual(files.shutdownDeadline('abc'), deadline);
    writeFileSync(join(dir, 'run', 'abc.shutdown'), 'soon');
    assert.equal(files.shutdownDeadline('abc'), undefined);
    files.requestShutdown('abc', deadline);
    files.clear('abc');
    assert.equal(existsSync(join(dir, 'run', 'abc.shutdown')), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
