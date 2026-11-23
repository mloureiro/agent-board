import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWaitStore, runCheck, runCommand } from './waits.mts';

test('the wait store keeps a check per task, private to the user, and drops what it cannot read', () => {
  const dir = mkdtempSync('/tmp/board-waits-test-');
  try {
    const store = createWaitStore(join(dir, 'waits'));
    const createdAt = new Date('2026-01-01T12:00:00Z');
    store.write('Ab3dEf9x', { command: 'gh pr checks 1', cwd: '/w', everyMs: 120_000, createdAt });
    assert.deepEqual(store.read('Ab3dEf9x'), { command: 'gh pr checks 1', cwd: '/w', everyMs: 120_000, createdAt });
    assert.equal(statSync(join(dir, 'waits', 'Ab3dEf9x.json')).mode & 0o777, 0o600);
    store.write('Ab3dEf9x', {
      command: 'x',
      cwd: '/w',
      everyMs: 60_000,
      createdAt,
      lastCheckAt: createdAt,
      lastExit: null,
      lastOutput: 'slow',
    });
    assert.deepEqual(store.read('Ab3dEf9x')?.lastExit, null);
    writeFileSync(join(dir, 'waits', 'broken.json'), '{"command": "", "cwd": "relative"}');
    assert.equal(store.read('broken'), undefined);
    assert.deepEqual(store.list().sort(), ['Ab3dEf9x', 'broken']);
    store.remove('Ab3dEf9x');
    assert.equal(store.read('Ab3dEf9x'), undefined);
    assert.equal(store.read('../etc/passwd'), undefined);
    assert.throws(() => store.write('../x', { command: 'x', cwd: '/w', everyMs: 60_000, createdAt }), /not a task id/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a check runs in its directory with the env of the Claude Code settings, and reports its exit code and output', async () => {
  const dir = mkdtempSync('/tmp/board-waits-test-');
  try {
    const home = join(dir, 'home');
    const work = join(dir, 'work');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(work, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { FROM_USER: 'u', BOTH: 'user' } }));
    writeFileSync(join(work, '.claude', 'settings.local.json'), JSON.stringify({ env: { BOTH: 'project' } }));
    const check = { cwd: work, everyMs: 60_000, createdAt: new Date() };
    const passed = await runCheck({ ...check, command: 'echo "$PWD $FROM_USER $BOTH"' }, home);
    assert.deepEqual(passed, { exitCode: 0, timedOut: false, output: `${realpathSync(work)} u project\n` });
    const failed = await runCheck({ ...check, command: 'echo pending >&2; exit 3' }, home);
    assert.deepEqual(failed, { exitCode: 3, timedOut: false, output: 'pending\n' });
    const long = await runCheck({ ...check, command: 'seq 1 5000' }, home);
    assert.ok(long.output.length <= 2000 && long.output.endsWith('4999\n5000\n'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a check whose command cannot be started reports no exit code and the reason', async () => {
  const dir = mkdtempSync('/tmp/board-waits-test-');
  try {
    const check = { cwd: dir, everyMs: 60_000, createdAt: new Date() };
    const nulByte = await runCheck({ ...check, command: 'echo \0' }, dir);
    assert.equal(nulByte.exitCode, null);
    assert.equal(nulByte.timedOut, false);
    assert.match(nulByte.output, /NUL|null bytes|ERR_INVALID_ARG_VALUE/i);
    const noDirectory = await runCheck({ ...check, cwd: join(dir, 'gone'), command: 'true' }, dir);
    assert.equal(noDirectory.exitCode, null);
    assert.equal(noDirectory.timedOut, false);
    assert.match(noDirectory.output, /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a check keeps the end of its output across stdout and stderr, and a short output whole', async () => {
  const dir = mkdtempSync('/tmp/board-waits-test-');
  try {
    const check = { cwd: dir, everyMs: 60_000, createdAt: new Date() };
    const mixed = await runCheck({ ...check, command: 'echo out; sleep 0.1; echo err >&2' }, dir);
    assert.equal(mixed.output, 'out\nerr\n');
    const long = await runCheck({ ...check, command: 'head -c 5000 /dev/zero | tr "\\0" a; printf END' }, dir);
    assert.equal(long.output.length, 2000);
    assert.ok(long.output.endsWith('aaaEND'));
    assert.equal(long.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a check killed by a signal reports no exit code and no time out', async () => {
  const dir = mkdtempSync('/tmp/board-waits-test-');
  try {
    const killed = await runCheck({ cwd: dir, everyMs: 60_000, createdAt: new Date(), command: 'kill -9 $$' }, dir);
    assert.deepEqual(killed, { exitCode: null, timedOut: false, output: '' });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a check over its time limit is stopped with its whole process group', async () => {
  const dir = mkdtempSync('/tmp/board-waits-test-');
  try {
    const pidFile = join(dir, 'child.pid');
    const started = Date.now();
    // The background sleep keeps the output pipe open: the check only ends once the group kill reaches it too.
    const slow = await runCheck(
      {
        cwd: dir,
        everyMs: 60_000,
        createdAt: new Date(),
        command: `sleep 30 & echo $! > ${pidFile}; echo waiting; wait`,
      },
      dir,
      200,
    );
    assert.deepEqual(slow, { exitCode: null, timedOut: true, output: 'waiting\n' });
    assert.ok(Date.now() - started < 10_000, 'ended long before the sleep would have');
    const child = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(child > 0);
    for (let waited = 0; isAlive(child); waited += 1) {
      if (waited > 100) assert.fail(`the check's child ${child} outlived the kill`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a check that ends within its time limit is not marked as timed out', async () => {
  const dir = mkdtempSync('/tmp/board-waits-test-');
  try {
    const quick = await runCheck({ cwd: dir, everyMs: 60_000, createdAt: new Date(), command: 'exit 0' }, dir, 5_000);
    assert.deepEqual(quick, { exitCode: 0, timedOut: false, output: '' });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a command reports stdout and stderr apart as well as together, and stops at once when aborted', async () => {
  const dir = mkdtempSync('/tmp/board-waits-test-');
  try {
    const both = await runCommand({ cwd: dir, command: 'echo data; echo problem >&2; exit 1' }, dir);
    assert.deepEqual(both, {
      exitCode: 1,
      timedOut: false,
      output: 'data\nproblem\n',
      stdout: 'data\n',
      stderr: 'problem\n',
    });
    const controller = new AbortController();
    const running = runCommand({ cwd: dir, command: 'sleep 30', signal: controller.signal }, dir);
    setTimeout(() => controller.abort(), 50);
    const aborted = await running;
    assert.deepEqual([aborted.exitCode, aborted.timedOut], [null, false]);
    const before = await runCommand({ cwd: dir, command: 'sleep 30', signal: AbortSignal.abort() }, dir);
    assert.equal(before.exitCode, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a command reads the text it is given on stdin, and has none to read otherwise', async () => {
  const dir = mkdtempSync('/tmp/board-waits-test-');
  try {
    const given = await runCommand({ cwd: dir, command: 'cat', stdin: '{"a":1}\n' }, dir);
    assert.deepEqual([given.exitCode, given.stdout], [0, '{"a":1}\n']);
    const none = await runCommand({ cwd: dir, command: 'cat' }, dir);
    assert.deepEqual([none.exitCode, none.stdout], [0, '']);
    const unread = await runCommand({ cwd: dir, command: 'exit 3', stdin: 'x'.repeat(1_000_000) }, dir);
    assert.equal(unread.exitCode, 3);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a command sees the PATH it is given, with the settings env still on top', async () => {
  const dir = mkdtempSync('/tmp/board-waits-test-');
  try {
    const own = await runCommand({ cwd: dir, command: 'printf %s "$PATH"', path: '/units/bin:/bin:/usr/bin' }, dir);
    assert.equal(own.stdout, '/units/bin:/bin:/usr/bin');
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { PATH: '/settings:/bin' } }));
    const overridden = await runCommand({ cwd: dir, command: 'printf %s "$PATH"', path: '/bin' }, dir);
    assert.equal(overridden.stdout, '/settings:/bin');
  } finally {
    rmSync(dir, { recursive: true });
  }
});
