import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createProcessSystem, isWorkerCommand, taskIdOfUnit } from './process-system.mts';
import { SystemError } from './system.mts';
import type { ProcessSystemOptions } from './process-system.mts';
import { createRunFiles } from '../worker/runtime.mts';
import { unitName } from '../task-id.mts';

let root: string;
const started: number[] = [];

before(() => {
  root = mkdtempSync(join(tmpdir(), 'board-process-system-test-'));
});

after(() => {
  for (const pid of started) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  rmSync(root, { recursive: true, force: true });
});

// A worker stand-in: a process whose command line ends in `internal worker <id>`, and which, like a worker with a run, has an
// agent in a group of its own (recorded in <id>.pgid) that outlives a SIGTERM to the worker alone.
const WORKER_SCRIPT = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const id = process.argv.at(-1);
const agent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
writeFileSync(process.env.AGENT_BOARD_RUN_DIR + '/' + id + '.pgid', String(agent.pid));
setInterval(() => {}, 1000);
`;

function system(name: string, overrides: Partial<ProcessSystemOptions> = {}) {
  const dir = join(root, name);
  const lines: string[] = [];
  return {
    dir,
    lines,
    files: createRunFiles(dir),
    system: createProcessSystem({
      dryRun: false,
      print: (line) => void lines.push(line),
      dir,
      env: {
        PATH: process.env['PATH'],
        HOME: root,
        AGENT_BOARD_RUN_DIR: dir,
        AGENT_BOARD_CREDENTIALS_COMMAND: '/opt/board/credentials',
        SECRET: 'must not pass',
      },
      graceMs: 3000,
      command: (id) => [process.execPath, '-e', WORKER_SCRIPT, 'internal', 'worker', id],
      openLog: () => openSync(join(root, `${name}.log`), 'a'),
      ...overrides,
    }),
  };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 5000; waited += 50) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`${what} did not happen`);
}

test('the identity of a worker is the end of its command line', () => {
  assert.equal(isWorkerCommand('/home/u/.local/bin/board internal worker abc12345', 'abc12345'), true);
  assert.equal(isWorkerCommand('/usr/bin/node /opt/main.mts internal worker abc12345\n', 'abc12345'), true);
  assert.equal(isWorkerCommand('/home/u/.local/bin/board internal worker abc12345', 'bc12345'), false);
  assert.equal(isWorkerCommand('/home/u/.local/bin/board internal worker xabc12345', 'abc12345'), false);
  assert.equal(isWorkerCommand('/home/u/.local/bin/board internal listen', 'abc12345'), false);
  assert.equal(isWorkerCommand('sleep 600', 'abc12345'), false);
});

test('a unit name is the task id behind agent-board-, of the safe shape only', () => {
  assert.equal(taskIdOfUnit(unitName('Ab3dEf9x')), 'Ab3dEf9x');
  for (const hostile of [
    'Ab3dEf9x',
    'agent-board-',
    'agent-board-../x',
    'agent-board-dispatch',
    'agent-board-listen',
    'agent-board-watch',
  ])
    assert.throws(() => taskIdOfUnit(hostile), SystemError, hostile);
});

test('a worker is started detached, tracked by its pid file, and found by its identity', async () => {
  const { system: supervisor, dir, files } = system('start');
  const { pid } = await supervisor.startWorker('Ab3dEf9x');
  assert.ok(pid !== undefined && pid > 1);
  started.push(pid);
  assert.equal(JSON.parse(readFileSync(join(dir, 'Ab3dEf9x.pid'), 'utf8')).pid, pid);
  assert.equal(await supervisor.isActive(unitName('Ab3dEf9x')), true);
  const startedAt = await supervisor.startedAt(unitName('Ab3dEf9x'));
  assert.ok(startedAt && Math.abs(Date.now() - startedAt.getTime()) < 10_000);
  assert.deepEqual(await supervisor.activeWorkers(), ['Ab3dEf9x']);
  assert.equal(await supervisor.isActive(unitName('Zz9xxxxx')), false);
  // It leads a group of its own, so a stop reaches what it started.
  await eventually(() => files.processGroup('Ab3dEf9x') !== undefined, 'the agent group file');
  await supervisor.stop(unitName('Ab3dEf9x'));
});

test('stop signals the worker group and the agent group, and clears the files', async () => {
  const { system: supervisor, dir, files } = system('stop');
  const { pid } = await supervisor.startWorker('Stop0001');
  assert.ok(pid !== undefined);
  started.push(pid);
  await eventually(() => files.processGroup('Stop0001') !== undefined, 'the agent group file');
  const agent = files.processGroup('Stop0001');
  assert.ok(agent !== undefined && alive(agent));
  await supervisor.stop(unitName('Stop0001'));
  await eventually(() => !alive(pid) && !alive(agent), 'both groups to end');
  assert.equal(await supervisor.isActive(unitName('Stop0001')), false);
  assert.deepEqual(await supervisor.activeWorkers(), []);
  assert.throws(() => readFileSync(join(dir, 'Stop0001.pid')), 'the pid file is gone');
  assert.equal(files.processGroup('Stop0001'), undefined);
});

test('what ignores SIGTERM is killed after the grace period', async () => {
  const stubborn = ['process.on("SIGTERM", () => {});', 'setInterval(() => {}, 1000);'].join('');
  const { system: supervisor } = system('kill', {
    graceMs: 300,
    command: (id) => [process.execPath, '-e', stubborn, 'internal', 'worker', id],
  });
  const { pid } = await supervisor.startWorker('Kill0001');
  assert.ok(pid !== undefined);
  started.push(pid);
  await supervisor.stop(unitName('Kill0001'));
  await eventually(() => !alive(pid), 'the worker to be killed');
});

test('a reused pid is not a worker: the process of another command does not count, and its file is cleared', async () => {
  const { system: supervisor, dir } = system('reused');
  mkdirSync(dir, { recursive: true });
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const pid = other.pid;
  assert.ok(pid !== undefined);
  started.push(pid);
  writeFileSync(join(dir, 'Reuse001.pid'), JSON.stringify({ pid, startedAt: new Date().toISOString() }));
  assert.equal(await supervisor.isActive(unitName('Reuse001')), false);
  assert.equal(await supervisor.startedAt(unitName('Reuse001')), undefined);
  assert.throws(() => readFileSync(join(dir, 'Reuse001.pid')), 'the stale file is cleared');
  // A worker of another task is not this task's either.
  writeFileSync(join(dir, 'Reuse002.pid'), JSON.stringify({ pid, startedAt: new Date().toISOString() }));
  await supervisor.stop(unitName('Reuse002'));
  assert.ok(alive(pid), 'a stop never signals a process that is not the worker');
  other.kill('SIGKILL');
});

test('a worker of another task id under the same pid is not found by id', async () => {
  const { system: supervisor, dir } = system('othertask');
  const { pid } = await supervisor.startWorker('Task0001');
  assert.ok(pid !== undefined);
  started.push(pid);
  writeFileSync(join(dir, 'Task0002.pid'), JSON.stringify({ pid, startedAt: new Date().toISOString() }));
  assert.equal(await supervisor.isActive(unitName('Task0002')), false);
  assert.deepEqual(await supervisor.activeWorkers(), ['Task0001']);
  await supervisor.stop(unitName('Task0001'));
});

test('stale and unreadable pid files are not workers', async () => {
  const { system: supervisor, dir } = system('stale');
  await supervisor.startWorker('Seed0001').then(async ({ pid }) => {
    if (pid !== undefined) started.push(pid);
    await supervisor.stop(unitName('Seed0001'));
  });
  writeFileSync(join(dir, 'Gone0001.pid'), JSON.stringify({ pid: 2 ** 22 - 3, startedAt: new Date().toISOString() }));
  writeFileSync(join(dir, 'Junk0001.pid'), 'not json');
  writeFileSync(join(dir, 'Junk0002.pid'), JSON.stringify({ pid: 'x', startedAt: 'y' }));
  writeFileSync(join(dir, 'Self0001.pid'), JSON.stringify({ pid: 1, startedAt: new Date().toISOString() }));
  writeFileSync(join(dir, 'dispatch.pid'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  assert.deepEqual(await supervisor.activeWorkers(), []);
  for (const id of ['Gone0001', 'Junk0001', 'Junk0002', 'Self0001'])
    assert.equal(await supervisor.isActive(unitName(id)), false, id);
  await supervisor.stop(unitName('Gone0001'));
  assert.deepEqual(
    await createProcessSystem({ dryRun: false, print: () => undefined, dir: join(root, 'nowhere') }).activeWorkers(),
    [],
  );
});

test('only a task id of the safe shape starts a worker, and the worker gets the units environment and the task log', async () => {
  const { system: supervisor, lines } = system('shape');
  for (const hostile of ['--help', '../x', 'a b', 'dispatch', 'listen', 'watch', '', 'x'.repeat(65)])
    await assert.rejects(supervisor.startWorker(hostile), SystemError, hostile);
  assert.deepEqual(lines, []);

  const out = join(root, 'env.txt');
  const envScript = `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env)); setInterval(() => {}, 1000);`;
  const logPath = join(root, 'shape.log');
  const { system: envSystem } = system('env', {
    command: (id) => [process.execPath, '-e', envScript, 'internal', 'worker', id],
    openLog: () => openSync(logPath, 'a'),
  });
  const { pid } = await envSystem.startWorker('Env00001');
  assert.ok(pid !== undefined);
  started.push(pid);
  await eventually(() => {
    try {
      return readFileSync(out, 'utf8') !== '';
    } catch {
      return false;
    }
  }, 'the worker to write its environment');
  const env = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>;
  assert.equal(env['HOME'], root);
  assert.equal(env['SECRET'], undefined, 'only the variables the units pass');
  assert.equal(env['AGENT_BOARD_RUN_DIR'], join(root, 'env'));
  assert.equal(env['AGENT_BOARD_CREDENTIALS_COMMAND'], '/opt/board/credentials');
  await envSystem.stop(unitName('Env00001'));
});

test('a worker that cannot be started fails with the reason and leaves no pid file', async () => {
  const { system: supervisor, dir } = system('nostart', {
    command: () => ['/nonexistent/board', 'internal', 'worker', 'x'],
  });
  await assert.rejects(supervisor.startWorker('Fail0001'), /could not start \/nonexistent\/board/);
  assert.throws(() => readFileSync(join(dir, 'Fail0001.pid')));
});

test('a dry run prints what it would do and touches nothing', async () => {
  const lines: string[] = [];
  const dir = join(root, 'dry');
  const supervisor = createProcessSystem({
    dryRun: true,
    print: (line) => void lines.push(line),
    dir,
    command: (id) => ['/usr/bin/board', 'internal', 'worker', id],
  });
  assert.deepEqual(await supervisor.startWorker('Dry00001'), { pid: undefined });
  await supervisor.stop(unitName('Dry00001'));
  assert.match(lines[0] ?? '', /^DRY spawn detached \/usr\/bin\/board internal worker Dry00001$/);
  assert.match(lines[1] ?? '', /^DRY stop the process groups of worker Dry00001$/);
  assert.throws(() => readFileSync(join(dir, 'Dry00001.pid')));
});

test('only `ps` exit 1 means no such process: any other failure throws and keeps the pid file', async () => {
  const { system: supervisor, dir } = system('psfail');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Ps000001.pid'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const bin = join(root, 'psbin');
  mkdirSync(bin, { recursive: true });
  const saved = process.env['PATH'];
  try {
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\necho boom >&2\nexit 2\n', { mode: 0o755 });
    process.env['PATH'] = `${bin}:${saved ?? ''}`;
    await assert.rejects(supervisor.isActive(unitName('Ps000001')), /ps failed/);
    await assert.rejects(supervisor.activeWorkers(), SystemError);
    assert.ok(readFileSync(join(dir, 'Ps000001.pid'), 'utf8'), 'the file stays');
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    assert.equal(await supervisor.isActive(unitName('Ps000001')), false);
    assert.throws(() => readFileSync(join(dir, 'Ps000001.pid')), 'ps exit 1: the process is gone, the file is cleared');
  } finally {
    process.env['PATH'] = saved;
  }
});

test('signalWorker reaches the verified worker process and not the agent group', async () => {
  const handler = `
    const { writeFileSync } = require('node:fs');
    const id = process.argv.at(-1);
    process.on('SIGUSR2', () => writeFileSync(process.env.AGENT_BOARD_RUN_DIR + '/' + id + '.got', 'yes'));
    setInterval(() => {}, 1000);
  `;
  const { system: supervisor, dir } = system('signal', {
    command: (id) => [process.execPath, '-e', handler, 'internal', 'worker', id],
  });
  const { pid } = await supervisor.startWorker('Sig00001');
  assert.ok(pid !== undefined);
  started.push(pid);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await supervisor.signalWorker(unitName('Sig00001'), 'SIGUSR2');
  await eventually(() => {
    try {
      return readFileSync(join(dir, 'Sig00001.got'), 'utf8') === 'yes';
    } catch {
      return false;
    }
  }, 'the worker to get SIGUSR2');
  assert.ok(alive(pid));

  const other = spawn(
    process.execPath,
    ['-e', 'process.on("SIGUSR2", () => process.exit(0)); setInterval(() => {}, 1000)'],
    {
      stdio: 'ignore',
    },
  );
  started.push(other.pid ?? 0);
  writeFileSync(join(dir, 'Sig00002.pid'), JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString() }));
  await supervisor.signalWorker(unitName('Sig00002'), 'SIGUSR2');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(alive(other.pid ?? 0), 'a process that is not the worker is not signalled');
  other.kill('SIGKILL');
  await supervisor.stop(unitName('Sig00001'));
});
