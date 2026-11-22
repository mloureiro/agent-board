import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_BATCH_EVENTS } from '@agent-board/shared';
import type { Note, RunEvent, Task, WireBackend } from '@agent-board/shared';
import type { AgentConfig } from '../config/config.mts';
import { BackendError } from '../backend/backend.mts';
import { sealingBackend } from '../backend/sealing.mts';
import { START_MARKER, WAKE_MARKER } from '../task-rules.mts';
import { createWatchStore, newWatchId } from '../watch/store.mts';
import type { WatchEvent } from '../watch/store.mts';
import { commandDef, tempDir, timerDef, watchDef } from '../__tests__/helpers/watch.mts';
import type { Invocation, Supervision } from './plan.mts';
import { latchShutdownSignal, runWorker } from './worker.mts';
import { groupExists, runProcess } from './process.mts';
import type { RunChannel, RunResult, Watch } from './process.mts';
import type { WorkerDeps } from './worker.mts';
import {
  CONFIG,
  fakeBackend,
  fakeRunFiles,
  fakeSessions,
  fakeWorktreeLocks,
  KEYS,
  note,
  OTHER_SESSION,
  SESSION,
  task,
  wireTask,
} from '../__tests__/helpers/fakes.mts';

function setup(result: RunResult | Error, moveDuringRun = false) {
  // A task scheduled from /tmp on this machine.
  const running = task({
    id: 'w1',
    status: 'running',
    input: '/selftest go',
    machine: 'here',
    workdir: '/tmp',
    runStartedAt: new Date('2026-01-01T10:00:00Z'),
  });
  const backend = fakeBackend([running]);
  const calls: string[] = [];
  const deps: WorkerDeps = {
    backend,
    config: CONFIG,
    dryRun: false,
    print: () => undefined,
    run: async () => {
      if (moveDuringRun) running.status = 'needs-me';
      if (result instanceof Error) throw result;
      return result;
    },
    logTail: () => 'tail of log',
    resetLog: (shortLink) => void calls.push(`reset ${shortLink}`),
    appendLog: (shortLink, text) => void calls.push(`append ${shortLink}: ${text}`),
    pluginPath: () => '/plugins/pr-review',
    dirExists: () => true,
    pathExists: () => false,
    realpath: (path) => path,
    settingsEnv: () => ({}),
    mcpServers: () => ({ config: { mcpServers: {} }, missing: [] }),
    home: '/h',
    newSessionId: () => SESSION,
    sessions: fakeSessions(),
    worktreeLocks: fakeWorktreeLocks(),
    files: fakeRunFiles(),
    hookCommand: (dir, id) => `hook ${dir} ${id}`,
    now: () => new Date(),
    watchEveryMs: 10,
    watches: createWatchStore(tempDir()),
    spoolEveryMs: 5,
    writeTitle: async () => ({ problem: 'no title writer in this test' }),
  };
  return { deps, backend, calls };
}

// The calls to the board that a tick starts without waiting need a few turns of the event loop to finish.
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((done) => setImmediate(done));
};

test('non-zero exit reports the error and log tail', async () => {
  const { deps, backend } = setup({ exitCode: 1, signal: null });
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.includes('exited with code 1') && w.includes('tail of log')));
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:')));
});

test('a run the watch stopped is reported with the reason', async () => {
  const { deps, backend } = setup({
    exitCode: null,
    signal: 'SIGTERM',
    stopped: { kind: 'stop', why: 'inactive', message: 'Stopped: the agent made no tool call for 15 minutes.' },
  });
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.includes('no tool call for 15 minutes')));
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:')));
});

test('exit 0 with the task still in Running is reported as unreported', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.includes('finished without reporting')));
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:')));
});

test('exit 0 after the worker moved the task writes nothing', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null }, true);
  await runWorker(deps, 'w1');
  assert.deepEqual(
    backend.writes.filter((w) => !/^(heartbeat|session|next) /.test(w)),
    [],
  );
});

test('a task the board hides from this CLI at the end of the run keeps its run files and is logged, not thrown', async () => {
  const { deps, backend, calls } = setup({ exitCode: 0, signal: null });
  const cleared: string[] = [];
  deps.files = { ...deps.files, clear: (id) => void cleared.push(id) };
  const getTask = backend.getTask.bind(backend);
  let ran = false;
  deps.run = async () => {
    ran = true;
    return { exitCode: 0, signal: null };
  };
  backend.getTask = async (id) => {
    if (ran) throw new BackendError('get-task: HTTP 422', 422, true);
    return getTask(id);
  };
  await runWorker(deps, 'w1');
  assert.ok(
    calls.some((line) => /does not know/.test(line)),
    calls.join('\n'),
  );
  assert.deepEqual(cleared, []);
});

test('a command that cannot start is reported on the task', async () => {
  const { deps, backend } = setup(new Error('could not start claude: ENOENT'));
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.includes('could not start claude')));
});

test('the log is reset before anything else', async () => {
  const { deps, calls } = setup({ exitCode: 0, signal: null }, true);
  await runWorker(deps, 'w1');
  assert.equal(calls[0], 'reset w1');
});

test('exit 0 with the task already moved to Todo by a quick answer writes nothing', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.run = async () => {
    backend.tasks[0]!.status = 'todo';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(
    backend.writes.filter((w) => !/^(heartbeat|session|next) /.test(w)),
    [],
  );
});

test('a missing working directory is named in the error', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.dirExists = () => false;
  backend.tasks[0]!.workdir = '/no/such/dir';
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.includes('/no/such/dir')));
});

test('a task closed during the run is left alone, whatever the outcome', async () => {
  for (const result of [
    { exitCode: 0, signal: null },
    { exitCode: 1, signal: null },
    { exitCode: null, signal: 'SIGTERM', timedOut: true },
  ]) {
    const { deps, backend } = setup(result);
    deps.run = async () => {
      backend.tasks[0]!.closed = true;
      return result;
    };
    await runWorker(deps, 'w1');
    assert.deepEqual(
      backend.writes.filter((w) => !/^(heartbeat|session|next) /.test(w)),
      [],
    );
  }
});

test('a run another machine took over is left alone: no workdir, no failure', async () => {
  for (const result of [
    { exitCode: 0, signal: null },
    { exitCode: 1, signal: null },
  ]) {
    const { deps, backend } = setup(result);
    backend.tasks[0]!.runStartedAt = new Date('2026-01-01T10:00:00Z');
    deps.run = async () => {
      deps.files.writeCwd('w1', '/tmp/.claude/worktrees/feat-x');
      // Taken back and claimed again: still Running, with the other run's start.
      backend.tasks[0]!.runStartedAt = new Date('2026-01-01T11:00:00Z');
      return result;
    };
    await runWorker(deps, 'w1');
    assert.ok(!backend.writes.some((w) => w.startsWith('workdir w1: /tmp/.claude') || w.startsWith('fail ')));
  }
});

test('a fresh skill run gets a new session, stored on the task before the run', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null }, true);
  const runs: Invocation[] = [];
  deps.run = async (invocation) => {
    runs.push(invocation);
    assert.ok(backend.writes.includes(`session w1: ${SESSION}`), 'stored before the run');
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(runs[0]?.args.slice(0, 2), ['-p', `--session-id=${SESSION}`]);
  assert.equal(runs[0]?.prompt, '/selftest go');
});

test("a resume runs the stored session with the user's reply and uses the resume up", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { next: 'resume', sessionId: SESSION, machine: 'here' });
  deps.sessions.record('w1', SESSION);
  backend.notes.set('w1', [
    note('Done, one question', new Date('2026-11-13T10:00:00Z')),
    note('please also check X', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  const runs: Invocation[] = [];
  deps.run = async (invocation) => {
    runs.push(invocation);
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(runs[0]?.args[1], `--resume=${SESSION}`);
  assert.match(runs[0]?.prompt ?? '', /please also check X/);
  assert.ok(backend.writes.includes('next w1: fresh'));
  assert.ok(!backend.writes.some((w) => w.startsWith('session w1')));
});

// The fork w1 of the task p1, which ran on this machine in its session SESSION; a fork's own session is OTHER_SESSION.
function forkSetup(parent: Partial<Task> | null = {}) {
  const made = setup({ exitCode: 0, signal: null });
  const { deps, backend } = made;
  Object.assign(backend.tasks[0]!, { forkOf: 'p1', input: 'look into the flaky test', status: 'running' });
  if (parent !== null)
    backend.tasks.push(
      task({
        id: 'p1',
        title: 'Parent work',
        status: 'needs-me',
        machine: 'here',
        workdir: '/tmp',
        sessionId: SESSION,
        ...parent,
      }),
    );
  deps.newSessionId = () => OTHER_SESSION;
  deps.sessions.record('p1', SESSION);
  const runs: Invocation[] = [];
  deps.run = async (invocation) => {
    runs.push(invocation);
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  return { ...made, runs };
}

test('the first run of a fork continues a copy of the parent’s session and stores the copy as its own', async () => {
  const { deps, backend, runs } = forkSetup();
  await runWorker(deps, 'w1');
  assert.deepEqual(runs[0]?.args.slice(0, 4), [
    '-p',
    `--resume=${SESSION}`,
    '--fork-session',
    `--session-id=${OTHER_SESSION}`,
  ]);
  assert.equal(runs[0]?.cwd, '/tmp');
  assert.match(
    runs[0]?.prompt ?? '',
    /forked from board task p1 \("Parent work"\)[^]*Your task:\n\nlook into the flaky test$/,
  );
  assert.ok(backend.writes.includes(`session w1: ${OTHER_SESSION}`));
  assert.ok(deps.sessions.has('w1', OTHER_SESSION));
  assert.ok(deps.sessions.has('p1', SESSION), 'the parent’s session is untouched');
  assert.ok(!backend.writes.some((w) => w.startsWith('session p1') || w.startsWith('fail ')));
});

test('a fork whose parent’s session this machine did not start is not run, and says why', async () => {
  const { deps, backend, runs } = forkSetup();
  deps.sessions = fakeSessions();
  await runWorker(deps, 'w1');
  assert.equal(runs.length, 0);
  assert.ok(
    backend.writes.some((w) => w.startsWith('fail w1:') && /this machine did not start/.test(w)),
    backend.writes.join('\n'),
  );
  assert.ok(!backend.writes.some((w) => w.startsWith('session w1')));
});

test('a fork whose parent has no session, or is not on the board, is not run, and says why', async () => {
  for (const [parent, why] of [
    [{ sessionId: null }, /no Claude session now/],
    [null, /not on the board any more/],
  ] as const) {
    const { deps, backend, runs } = forkSetup(parent);
    await runWorker(deps, 'w1');
    assert.equal(runs.length, 0);
    assert.ok(
      backend.writes.some((w) => w.startsWith('fail w1:') && why.test(w)),
      backend.writes.join('\n'),
    );
  }
});

test('a fork is not run when the board answers for its parent with another task that has a recorded session', async () => {
  const { deps, backend, runs } = forkSetup();
  const other = task({ id: 'q1', status: 'needs-me', machine: 'here', workdir: '/tmp', sessionId: OTHER_SESSION });
  deps.sessions.record('q1', OTHER_SESSION);
  const getTask = backend.getTask.bind(backend);
  backend.getTask = async (id) => (id === 'p1' ? other : getTask(id));
  await runWorker(deps, 'w1');
  assert.equal(runs.length, 0);
  assert.ok(
    backend.writes.some((w) => w.startsWith('fail w1:') && /another task/.test(w)),
    backend.writes.join('\n'),
  );
});

test('a fork that failed to look its parent up for another reason is not blamed on the parent', async () => {
  const { deps, backend, runs } = forkSetup();
  const getTask = backend.getTask.bind(backend);
  backend.getTask = async (id) => {
    if (id === 'p1') throw new BackendError('get-task: HTTP 503', 503, true);
    return getTask(id);
  };
  await assert.rejects(runWorker(deps, 'w1'), /HTTP 503/);
  assert.equal(runs.length, 0);
});

test('after its first run a fork resumes its own session with the reply, and does not fork again', async () => {
  const { deps, backend, runs } = forkSetup();
  Object.assign(backend.tasks[0]!, { next: 'resume', sessionId: OTHER_SESSION });
  deps.sessions.record('w1', OTHER_SESSION);
  backend.notes.set('w1', [
    note('Done, one question', new Date('2026-11-13T10:00:00Z')),
    note('please also check X', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  await runWorker(deps, 'w1');
  assert.deepEqual(runs[0]?.args.slice(0, 2), ['-p', `--resume=${OTHER_SESSION}`]);
  assert.ok(!runs[0]?.args.includes('--fork-session'));
  assert.match(runs[0]?.prompt ?? '', /please also check X/);
  assert.ok(!backend.writes.some((w) => w.startsWith('session w1')));
});

test('Re-run fresh forks a fork again, from the parent’s session as it is now', async () => {
  const { deps, backend, runs } = forkSetup({ sessionId: '33333333-3333-4333-8333-333333333333' });
  deps.sessions.record('p1', '33333333-3333-4333-8333-333333333333');
  Object.assign(backend.tasks[0]!, { next: 'fresh', sessionId: null });
  await runWorker(deps, 'w1');
  assert.deepEqual(runs[0]?.args.slice(0, 4), [
    '-p',
    '--resume=33333333-3333-4333-8333-333333333333',
    '--fork-session',
    `--session-id=${OTHER_SESSION}`,
  ]);
});

test('a run asked to pause gives its task back to Todo with a note naming the lane', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { sessionId: 's' });
  deps.files.writeRun('w1', { lane: 'implement', borrowed: true, startedAt: new Date() });
  deps.run = async () => {
    deps.files.requestPause('w1');
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  const pause = backend.writes.find((w) => w.startsWith('pause w1'));
  assert.match(pause ?? '', /Paused on here: its implement lane needed the slot/);
  assert.ok(!backend.writes.some((w) => w.includes('needs-me')));
  assert.equal(deps.files.readRun('w1'), undefined, 'the run files are cleared');
});

test("the watch passes liveness on with the run's lane and stops a quiet skill run", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.files.writeRun('w1', { lane: 'reviews', borrowed: true, startedAt: new Date() });
  let clock = Date.now();
  deps.now = () => new Date(clock);
  let decision: unknown;
  deps.run = async (_invocation, _taskId, _env, watch) => {
    for (let elapsed = 0; elapsed < 20 * 60_000; elapsed += 15_000) {
      clock += 15_000;
      decision = await watch.tick();
    }
    return {
      exitCode: null,
      signal: 'SIGTERM',
      stopped: { kind: 'stop', why: 'inactive', message: 'Stopped: the agent made no tool call for 15 minutes.' },
    };
  };
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.includes('heartbeat w1 reviews borrowed'));
  assert.deepEqual(decision, {
    kind: 'stop',
    why: 'inactive',
    message: 'Stopped: the agent made no tool call for 15 minutes.',
  });
  assert.ok(backend.writes.some((w) => w.includes('no tool call for 15 minutes')));
});

test('a jump of the clock is a sleep, not inactivity: the idle time starts over, for the worker and for the sweep', async () => {
  const { deps } = setup({ exitCode: 0, signal: null });
  let clock = Date.now();
  deps.now = () => new Date(clock);
  const decisions: unknown[] = [];
  const quiet: { kind: string }[] = [];
  deps.run = async (_invocation, _taskId, _env, watch) => {
    clock += 15_000;
    decisions.push(await watch.tick());
    // Two hours asleep.
    clock += 2 * 60 * 60_000;
    decisions.push(await watch.tick());
    assert.equal(deps.files.lastActive('w1')?.getTime(), clock, "the agent's last sign of life moved up to the wake");
    // Real quiet counts again from the wake.
    for (let elapsed = 0; elapsed < 16 * 60_000; elapsed += 15_000) {
      clock += 15_000;
      quiet.push(await watch.tick());
    }
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(
    decisions.map((decision) => (decision as { kind: string }).kind),
    ['continue', 'continue'],
  );
  // The 61st tick after the wake is the first more than 15 minutes on.
  assert.equal(
    quiet.findIndex((decision) => decision.kind === 'stop'),
    60,
  );
});

test("the hook goes into a skill run's settings", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null }, true);
  let settings = '';
  deps.run = async (invocation) => {
    settings = invocation.args[invocation.args.indexOf('--settings') + 1] ?? '';
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.match(settings, /"command":"hook \/run\/test\/agent-board w1"/);
});

test('a fresh skill run binds the task to its directory, and to the worktree it ended in', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { machine: null, workdir: null });
  deps.run = async () => {
    deps.files.writeCwd('w1', '/tmp/.claude/worktrees/feat-x');
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  const workdirs = backend.writes.filter((w) => w.startsWith('workdir w1'));
  assert.deepEqual(workdirs, ['workdir w1: /home/me', 'workdir w1: /tmp/.claude/worktrees/feat-x']);
});

test('a run that reported keeps the worktree it ended in, though the board dropped its runStartedAt', async () => {
  for (const status of ['needs-me', 'waiting', 'todo'] as const) {
    const { deps, backend } = setup({ exitCode: 0, signal: null });
    deps.run = async () => {
      deps.files.writeCwd('w1', '/tmp/.claude/worktrees/feat-x');
      backend.tasks[0]!.status = status;
      return { exitCode: 0, signal: null };
    };
    await runWorker(deps, 'w1');
    assert.deepEqual(
      backend.writes.filter((w) => w.startsWith('workdir w1')),
      ['workdir w1: /tmp/.claude/worktrees/feat-x'],
      status,
    );
    assert.ok(!backend.writes.some((w) => w.startsWith('fail ')), status);
  }
});

test('the task holds a lock on its workdir: the one it starts in, then the worktree it ended in', async () => {
  const { deps, backend, calls } = setup({ exitCode: 0, signal: null });
  const locks = fakeWorktreeLocks({ w1: ['/tmp/.claude/worktrees/old'] });
  deps.worktreeLocks = locks;
  deps.run = async () => {
    assert.deepEqual(locks.held.get('w1'), ['/tmp'], 'the old worktree is let go before the run');
    // The hook locked a worktree the agent passed through.
    locks.hold('w1', '/tmp/.claude/worktrees/passing');
    deps.files.writeCwd('w1', '/tmp/.claude/worktrees/feat-x');
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(locks.held.get('w1'), ['/tmp/.claude/worktrees/feat-x']);
  assert.ok(calls.includes('append w1: unlocked the worktree /tmp/.claude/worktrees/old'), calls.join('\n'));
  assert.ok(calls.includes('append w1: locked the worktree /tmp/.claude/worktrees/feat-x for this task'));
});

test('a worktree the session ended in that is not a listed directory gets no lock', async () => {
  const { deps } = setup({ exitCode: 0, signal: null });
  const locks = fakeWorktreeLocks();
  deps.worktreeLocks = locks;
  deps.config = { ...deps.config, dirs: [{ path: '/tmp' }] };
  deps.run = async () => {
    deps.files.writeCwd('w1', '/var/elsewhere');
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(locks.held.get('w1'), ['/tmp']);
});

test("a resume starts in the task's directory, and a missing one fails without starting", async () => {
  const resumable = {
    next: 'resume' as const,
    sessionId: SESSION,
    machine: 'here',
    workdir: '/repo/.claude/worktrees/feat-x',
  };
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.sessions.record('w1', SESSION);
  Object.assign(backend.tasks[0]!, resumable);
  backend.notes.set('w1', [
    note('asked', new Date('2026-11-13T10:00:00Z')),
    note('go on', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  let cwd = '';
  deps.run = async (invocation) => {
    cwd = invocation.cwd;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(cwd, '/repo/.claude/worktrees/feat-x');

  const gone = setup({ exitCode: 0, signal: null });
  gone.deps.sessions.record('w1', SESSION);
  Object.assign(gone.backend.tasks[0]!, resumable);
  gone.backend.notes.set('w1', [
    note('asked', new Date('2026-11-13T10:00:00Z')),
    note('go on', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  gone.deps.dirExists = (path) => path !== '/repo/.claude/worktrees/feat-x';
  let started = false;
  gone.deps.run = async () => {
    started = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(gone.deps, 'w1');
  assert.equal(started, false);
  assert.ok(
    gone.backend.writes.some(
      (w) => w.includes("task's directory is gone: /repo/.claude/worktrees/feat-x") && w.includes('no git checkout'),
    ),
  );
});

// A resume of a task whose worktree was deleted, with the checkout `/repo` still there.
function goneWorktree(overrides: Partial<Task> = {}) {
  const made = setup({ exitCode: 0, signal: null });
  Object.assign(made.backend.tasks[0]!, {
    next: 'resume',
    sessionId: SESSION,
    machine: 'here',
    workdir: '/repo/.claude/worktrees/feat-x',
    ...overrides,
  });
  made.deps.sessions.record('w1', SESSION);
  made.backend.notes.set('w1', [
    note('asked', new Date('2026-11-13T10:00:00Z')),
    note('go on', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  made.deps.dirExists = (path) => path !== '/repo/.claude/worktrees/feat-x';
  made.deps.pathExists = (path) => path === '/repo/.git';
  const runs: { invocation: Invocation; startDir: string | undefined }[] = [];
  made.deps.run = async (invocation, _taskId, env) => {
    runs.push({ invocation, startDir: env.AGENT_BOARD_START_DIR });
    made.backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  return { ...made, runs };
}

test('a resume whose worktree is gone continues the session in the checkout that held it, and says so', async () => {
  const { deps, backend, runs } = goneWorktree();
  await runWorker(deps, 'w1');
  const { invocation, startDir } = runs[0]!;
  assert.equal(invocation.cwd, '/repo');
  assert.equal(startDir, '/repo');
  assert.ok(invocation.prompt.startsWith('The directory this session last worked in, /repo/.claude/worktrees/feat-x,'));
  assert.ok(invocation.prompt.includes('continues the same session in /repo,'));
  assert.ok(invocation.prompt.includes('go on'), 'the reply is still there');
  assert.ok(
    backend.writes.some(
      (w) =>
        w.startsWith('note w1 (system):') &&
        w.includes('directory is gone: /repo/.claude/worktrees/feat-x') &&
        w.includes('continues in /repo'),
    ),
  );
  assert.ok(backend.writes.includes('workdir w1: /repo'));
  assert.ok(!backend.writes.some((w) => w.startsWith('fail ')));
});

test('a gone worktree whose checkout is not a listed directory is refused, naming the checkout', async () => {
  const { deps, backend, runs } = goneWorktree();
  withDirs(deps, '/srv/app');
  await runWorker(deps, 'w1');
  assert.equal(runs.length, 0);
  assert.ok(
    backend.writes.some(
      (w) => w.startsWith('fail w1:') && w.includes('/repo, the checkout that held it, is not a listed directory'),
    ),
  );
});

test('a fresh run in a gone directory still fails', async () => {
  const fresh = goneWorktree({ next: 'fresh', sessionId: null });
  await runWorker(fresh.deps, 'w1');
  assert.equal(fresh.runs.length, 0);
  assert.ok(fresh.backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('Recreate it to run there')));
});

test("the run's stream becomes readable log lines and a transcript sent with each check and at the end", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  const logged: (string | undefined)[] = [];
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    logged.push(
      onLine(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
        }),
      ),
    );
    await watch.tick();
    await settle();
    logged.push(
      onLine(
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] },
        }),
      ),
    );
    logged.push(onLine(JSON.stringify({ type: 'result', result: 'All done', is_error: false })));
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(logged, ['→ Bash: ls', undefined, 'All done']);
  assert.deepEqual(
    backend.writes.filter((w) => w.startsWith('transcript')),
    [`transcript w1 ${SESSION} tool_use`, `transcript w1 ${SESSION} tool_result,result`],
  );
});

const INIT_LINE = JSON.stringify({ type: 'system', subtype: 'init', cwd: '/tmp', skills: ['review', 'docx'] });

test("the skills in the run's start event are handed over once with the run's directory", async () => {
  const { deps } = setup({ exitCode: 0, signal: null });
  const recorded: [string, unknown[]][] = [];
  deps.recordSkills = (cwd, skills) => void recorded.push([cwd, skills]);
  deps.run = async (_invocation, _taskId, _env, _watch, onLine) => {
    onLine(INIT_LINE);
    onLine(INIT_LINE);
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(recorded, [['/tmp', ['review', 'docx']]]);
});

test("a run restricted to an agent does not report its skills: its list lacks the directory's own", async () => {
  const { deps } = setupAgent();
  const recorded: unknown[] = [];
  deps.recordSkills = (_cwd, skills) => void recorded.push(skills);
  const run = deps.run;
  deps.run = async (invocation, taskId, env, watch, onLine) => {
    onLine(INIT_LINE);
    return run(invocation, taskId, env, watch, onLine);
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(recorded, []);
});

test('recording the skills of a run can fail without touching the run, and is logged', async () => {
  const { deps, backend, calls } = setup({ exitCode: 0, signal: null });
  deps.recordSkills = () => {
    throw new Error('disk full');
  };
  deps.run = async (_invocation, _taskId, _env, _watch, onLine) => {
    onLine(INIT_LINE);
    onLine(JSON.stringify({ type: 'result', result: 'All done', is_error: false }));
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.ok(calls.includes("append w1: the run's skills were not recorded: disk full"));
  assert.ok(!backend.writes.some((w) => w.startsWith('fail w1')));
});

const MAIN_LINE = (used: number) =>
  JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      id: `msg_${used}`,
      model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: used - 10, output_tokens: 10 },
    },
  });
const RESULT_WITH_WINDOW = JSON.stringify({
  type: 'result',
  result: 'done',
  is_error: false,
  modelUsage: { 'claude-haiku-5-5': { contextWindow: 1_000_000 } },
});

const contextEvents = (events: RunEvent[]) => events.flatMap((event) => (event.kind === 'context' ? [event] : []));

function transcriptEvents(backend: ReturnType<typeof fakeBackend>) {
  const sent: RunEvent[] = [];
  const original = backend.transcript.bind(backend);
  backend.transcript = async (id, batch) => {
    sent.push(...batch.events);
    await original(id, batch);
  };
  return sent;
}

test("a run's result hands its context windows to the store, and the run's main agent lines become context events", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  const recorded: Record<string, number>[] = [];
  deps.contextWindows = {
    read: () => ({ 'claude-haiku-5-5': 200_000 }),
    record: (windows) => void recorded.push(windows),
  };
  const sent = transcriptEvents(backend);
  deps.run = async (_invocation, _taskId, _env, _watch, onLine) => {
    onLine(MAIN_LINE(5000));
    onLine(RESULT_WITH_WINDOW);
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(recorded, [{ 'claude-haiku-5-5': 1_000_000 }]);
  const readings = contextEvents(sent);
  assert.deepEqual(
    readings.map((event) => [event.used, event.window]),
    [
      [5000, 200_000],
      [5000, 1_000_000],
    ],
  );
});

test('recording the context windows can fail without touching the run, and is logged', async () => {
  const { deps, backend, calls } = setup({ exitCode: 0, signal: null });
  deps.contextWindows = {
    read: () => {
      throw new Error('unreadable');
    },
    record: () => {
      throw new Error('disk full');
    },
  };
  deps.run = async (_invocation, _taskId, _env, _watch, onLine) => {
    onLine(RESULT_WITH_WINDOW);
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.ok(calls.includes("append w1: the machine's context windows were not read: unreadable"));
  assert.ok(calls.includes("append w1: the run's context windows were not recorded: disk full"));
  assert.ok(!backend.writes.some((w) => w.startsWith('fail w1')));
});

test('the auto-compact variable in the settings the run loads becomes the threshold of its context events', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.settingsEnv = (dir): Record<string, string> =>
    dir === deps.home ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' } : {};
  const sent = transcriptEvents(backend);
  deps.run = async (_invocation, _taskId, _env, _watch, onLine) => {
    onLine(MAIN_LINE(5000));
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(
    contextEvents(sent).map((event) => event.threshold),
    [80],
  );
});

const USAGE_LINE = (utilization: number) =>
  JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: { unifiedWindows: { five_hour: { utilization, resetsAt: 1794925200 } } },
  });

test('a rate limit event is handed over when its numbers changed', async () => {
  const { deps } = setup({ exitCode: 0, signal: null });
  const recorded: unknown[] = [];
  deps.recordUsage = (reading) => void recorded.push(reading);
  deps.run = async (_invocation, _taskId, _env, _watch, onLine) => {
    onLine(USAGE_LINE(0.3));
    onLine(USAGE_LINE(0.3));
    onLine(USAGE_LINE(0.4));
    onLine('{"type":"assistant"}');
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(recorded, [
    { fiveHour: { utilization: 0.3, resetsAt: new Date(1794925200 * 1000) } },
    { fiveHour: { utilization: 0.4, resetsAt: new Date(1794925200 * 1000) } },
  ]);
});

test('recording the usage can fail without touching the run, and is logged', async () => {
  const { deps, backend, calls } = setup({ exitCode: 0, signal: null });
  deps.recordUsage = () => {
    throw new Error('disk full');
  };
  deps.run = async (_invocation, _taskId, _env, _watch, onLine) => {
    onLine(USAGE_LINE(0.3));
    onLine(JSON.stringify({ type: 'result', result: 'All done', is_error: false }));
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.ok(calls.includes("append w1: the run's usage was not recorded: disk full"));
  assert.ok(!backend.writes.some((w) => w.startsWith('fail w1')));
});

test('a transcript batch the board refused is sent again with the next one', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  let failures = 1;
  const sent: string[] = [];
  backend.transcript = async (_id, batch) => {
    if (failures-- > 0) throw new Error('board down');
    sent.push(batch.events.map((e) => e.kind).join(','));
  };
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }));
    await watch.tick();
    await settle();
    onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } }));
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(sent, ['text,text']);
});

test("a scheduled run loads the checkout's settings itself: no variables are copied", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  let env: Record<string, string> = { unset: 'x' };
  deps.settingsEnv = () => ({ CIRCLECI_TOKEN: 'ci-secret' });
  deps.run = async (_invocation, _taskId, runEnv) => {
    env = runEnv;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(env, {
    AGENT_BOARD_TASK: 'w1',
    AGENT_BOARD_START_DIR: '/tmp',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  });
});

test('a run that failed before it started leaves no session behind, and one that could not be spawned gives it back', async () => {
  const gone = setup({ exitCode: 0, signal: null });
  gone.deps.dirExists = () => false;
  await runWorker(gone.deps, 'w1');
  assert.ok(!gone.backend.writes.some((w) => w.startsWith('session w1')), 'the directory check failed first');

  const unplanned = setup({ exitCode: 0, signal: null });
  unplanned.backend.tasks[0]!.input = '  ';
  await runWorker(unplanned.deps, 'w1');
  assert.ok(!unplanned.backend.writes.some((w) => w.startsWith('session w1')), 'no prompt');

  const unspawned = setup(new Error('could not start claude: ENOENT'));
  await runWorker(unspawned.deps, 'w1');
  assert.deepEqual(
    unspawned.backend.writes.filter((w) => w.startsWith('session w1')),
    [`session w1: ${SESSION}`, 'session w1: null'],
  );
});

test("the agent's environment names the task, so `board schedule` can refuse inside a run", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  let env: Record<string, string> = {};
  deps.run = async (_invocation, _taskId, runEnv) => {
    env = runEnv;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(env['AGENT_BOARD_TASK'], 'w1');
});

test('every run waits for background work: print mode would otherwise stop it 10 minutes after the last turn', async () => {
  for (const asAgent of [false, true]) {
    const { deps, backend } = setup({ exitCode: 0, signal: null });
    if (asAgent) {
      deps.config = {
        ...CONFIG,
        agents: {
          reviewer: {
            description: 'd',
            tools: ['Read'],
            allowedTools: [],
            disallowedTools: [],
            env: ['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS', 'AGENT_BOARD_TASK'],
            mcpServers: [],
          },
        },
      };
      deps.settingsEnv = () => ({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '600000', AGENT_BOARD_TASK: 'other' });
      backend.tasks[0]!.agent = 'reviewer';
    }
    let env: Record<string, string> = {};
    deps.run = async (_invocation, _taskId, runEnv) => {
      env = runEnv;
      backend.tasks[0]!.status = 'needs-me';
      return { exitCode: 0, signal: null };
    };
    await runWorker(deps, 'w1');
    assert.equal(env['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS'], '0');
    assert.equal(env['AGENT_BOARD_TASK'], 'w1');
  }
});

test("a fresh run's prompt carries the user's message and points at the thread", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  backend.notes.set('w1', [
    note('Findings', new Date('2026-11-13T10:00:00Z')),
    note('now with the seed too', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  let prompt = '';
  deps.run = async (invocation) => {
    prompt = invocation.prompt;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.match(
    prompt,
    /^\/selftest go\n\nThe user wrote on board task w1 since its last run started:\n\nnow with the seed too\n/,
  );
  assert.match(prompt, /run `board show w1` first/);
});

test("a worker that finds the task paused tells the agent, from the task's flag", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { next: 'resume', sessionId: SESSION, paused: true });
  deps.sessions.record('w1', SESSION);
  let prompt = '';
  deps.run = async (invocation) => {
    prompt = invocation.prompt;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.match(prompt, /You were paused on board task w1/);
});

test('the upload still in flight when the run ends is awaited, then the rest is sent', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  const sent: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => void (release = resolve));
  backend.transcript = async (_id, batch) => {
    if (sent.length === 0) await gate;
    sent.push(batch.events.map((e) => e.kind).join(','));
  };
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }));
    void watch.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    onLine(JSON.stringify({ type: 'result', result: 'All done', is_error: false }));
    setTimeout(release, 10);
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(sent, ['text', 'result']);
});

test("a backlog is sent in batches of at most the board's limit, and a refused one is retried", async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  const sizes: number[] = [];
  let failures = 1;
  backend.transcript = async (_id, batch) => {
    if (failures-- > 0) throw new Error('board down');
    sizes.push(batch.events.length);
  };
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    for (let n = 0; n < MAX_BATCH_EVENTS + 10; n++)
      onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `t${n}` }] } }));
    await watch.tick();
    await settle();
    assert.deepEqual(sizes, [], 'the first batch was refused, nothing else went out');
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(sizes, [MAX_BATCH_EVENTS, 10]);
});

test('a task whose prompt cannot be decrypted is reported, never run', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  const [running] = backend.tasks;
  Object.assign(running!, { input: '', unreadable: ['input'] });
  let ran = false;
  deps.run = async () => {
    ran = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(ran, false);
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('input could not be decrypted')));
});

test('a run that fails before it starts clears the run files the dispatcher wrote', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { input: '', unreadable: ['input'] });
  const cleared: string[] = [];
  deps.files = { ...deps.files, clear: (id) => void cleared.push(id) };
  await runWorker(deps, 'w1');
  assert.deepEqual(cleared, ['w1']);
});

test('a task whose directory cannot be decrypted is not run in the default directory', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { workdir: null, unreadable: ['workdir'] });
  let ran = false;
  deps.run = async () => {
    ran = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(ran, false);
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('workdir could not be decrypted')));
});

test('an unreadable comment of the user stops the run; an unreadable title or agent note does not', async () => {
  const stopped = setup({ exitCode: 0, signal: null }, true);
  stopped.backend.notes.set('w1', [note('', new Date('2026-01-01T10:00:00Z'), { author: 'user', unreadable: true })]);
  let ran = false;
  stopped.deps.run = async () => {
    ran = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(stopped.deps, 'w1');
  assert.equal(ran, false);
  assert.ok(stopped.backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('could not be decrypted')));

  const fine = setup({ exitCode: 0, signal: null }, true);
  Object.assign(fine.backend.tasks[0]!, { unreadable: ['title'] });
  fine.backend.notes.set('w1', [note('', new Date('2026-01-01T10:00:00Z'), { author: 'agent', unreadable: true })]);
  await runWorker(fine.deps, 'w1');
  assert.ok(!fine.backend.writes.some((w) => w.startsWith('fail w1:')));
});

const HOSTILE_SESSION = '--dangerously-skip-permissions';

async function resumeOf(sessionId: string, known: string[] = []) {
  const run = setup({ exitCode: 0, signal: null });
  Object.assign(run.backend.tasks[0]!, { next: 'resume', sessionId, machine: 'here' });
  for (const session of known) run.deps.sessions.record('w1', session);
  run.backend.notes.set('w1', [
    note('asked', new Date('2026-11-13T10:00:00Z')),
    note('go on', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  const invocations: string[][] = [];
  run.deps.run = async (invocation) => {
    invocations.push(invocation.args);
    run.backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(run.deps, 'w1');
  return { ...run, invocations };
}

test('a session id the board names that this machine did not start is never resumed (flag injection)', async () => {
  for (const hostile of [HOSTILE_SESSION, '-p', `${SESSION} --dangerously-skip-permissions`, OTHER_SESSION]) {
    const { invocations, backend } = await resumeOf(hostile, [SESSION]);
    assert.deepEqual(invocations, [], `${hostile} must not start claude`);
    const failure = backend.writes.find((w) => w.startsWith('fail w1:')) ?? '';
    assert.match(failure, /did not start for this task, so the run was not started/);
    assert.match(failure, /Re-run fresh/);
    assert.ok(!backend.writes.some((w) => w.startsWith('next w1')), 'the resume is not used up');
  }
});

test('a session this machine started for the task resumes, as one argument', async () => {
  const { invocations } = await resumeOf(SESSION.toUpperCase(), [SESSION]);
  assert.equal(invocations.length, 1);
  assert.ok(invocations[0]!.includes(`--resume=${SESSION}`));
  assert.ok(!invocations[0]!.includes('--resume'));
});

test('a session recorded for another task is not this task’s', async () => {
  const run = setup({ exitCode: 0, signal: null });
  run.deps.sessions.record('other', SESSION);
  Object.assign(run.backend.tasks[0]!, { next: 'resume', sessionId: SESSION, machine: 'here' });
  run.backend.notes.set('w1', [
    note('asked', new Date('2026-11-13T10:00:00Z')),
    note('go on', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  let ran = false;
  run.deps.run = async () => ((ran = true), { exitCode: 0, signal: null });
  await runWorker(run.deps, 'w1');
  assert.equal(ran, false);
});

test('a fresh run records its session before it starts, so a later resume is allowed', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null }, true);
  deps.run = async () => {
    assert.ok(deps.sessions.has('w1', SESSION), 'recorded before the process starts');
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.ok(deps.sessions.has('w1', SESSION));
});

test('only the notes the run would hand the agent can stop it: an old unreadable note does not (unrunnable forever)', async () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 13, 10, minute));
  const unreadable = (minute: number) => note('', at(minute), { author: 'user', unreadable: true });
  const started = (minute: number) =>
    note(`${START_MARKER} ${at(minute).toISOString()} (x, here)`, at(minute), { author: 'system', kind: 'event' });
  const attempt = async (notes: ReturnType<typeof note>[], overrides: Partial<Task> = {}) => {
    const run = setup({ exitCode: 0, signal: null }, true);
    Object.assign(run.backend.tasks[0]!, { runStartedAt: at(30), ...overrides });
    run.deps.sessions.record('w1', SESSION);
    run.backend.notes.set('w1', notes);
    let ran = false;
    run.deps.run = async () => ((ran = true), { exitCode: 0, signal: null });
    await runWorker(run.deps, 'w1');
    return { ran, failure: run.backend.writes.find((w) => w.startsWith('fail w1:')) ?? '' };
  };
  // Fresh: an unreadable note written since the last run started would be handed over, so the run is refused, with advice.
  const refused = await attempt([started(1), unreadable(10)]);
  assert.equal(refused.ran, false);
  assert.match(refused.failure, /Re-run fresh: a fresh run starts after this attempt/);
  // Re-run fresh keeps the note, but the refused attempt left a start note behind it: the note is no longer handed over.
  assert.equal((await attempt([unreadable(10), started(20)])).ran, true);
  // Resume: the user's reply is what is handed over.
  const resume = { next: 'resume' as const, sessionId: SESSION, machine: 'here' };
  assert.equal((await attempt([note('Findings', at(5)), unreadable(10)], resume)).ran, false);
  assert.equal(
    (await attempt([unreadable(1), note('Findings', at(5)), note('go on', at(10), { author: 'user' })], resume)).ran,
    true,
  );
});

const textEvent = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('an event the board refuses for good is dropped alone, and never holds the transcript back (transcript stall)', async () => {
  const { deps, backend, calls } = setup({ exitCode: 0, signal: null });
  const stored: string[] = [];
  backend.transcript = async (_id, batch) => {
    if (batch.events.some((event) => event.kind === 'text' && event.text === 'too big for the board'))
      throw new BackendError('transcript: event 2 is too long', 400);
    stored.push(...batch.events.map((event) => (event.kind === 'text' ? event.text : event.kind)));
  };
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    for (const text of ['a', 'b', 'too big for the board', 'c']) onLine(textEvent(text));
    await watch.tick();
    await settle();
    onLine(textEvent('d'));
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(stored, ['a', 'b', 'c', 'd']);
  assert.ok(calls.some((c) => c.includes('transcript event 2 was refused and dropped')));
});

test('an event the board refused for a passing reason waits, in order, with everything after it', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  const stored: string[] = [];
  let down = true;
  backend.transcript = async (_id, batch) => {
    if (down) throw new BackendError('transcript: error from the board server (HTTP 503)', 503);
    stored.push(...batch.events.map((event) => (event.kind === 'text' ? event.text : event.kind)));
  };
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    onLine(textEvent('a'));
    await watch.tick();
    await settle();
    onLine(textEvent('b'));
    down = false;
    await watch.tick();
    await settle();
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(stored, ['a', 'b']);
});

test('a worker refuses a task whose creator is an agent, as the board lists it as Todo (unstarted proposal)', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  Object.assign(backend.tasks[0]!, { createdBy: 'agent', input: 'rm -rf the world' });
  let ran = false;
  deps.run = async () => {
    ran = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(ran, false);
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('you have not started it')));
});

test('a session that a fresh run abandoned is not resumed, even when the board still names it (Re-run fresh)', async () => {
  const run = setup({ exitCode: 0, signal: null });
  Object.assign(run.backend.tasks[0]!, { next: 'resume', sessionId: SESSION, machine: 'here' });
  run.deps.sessions.record('w1', SESSION);
  run.deps.sessions.record('w1', OTHER_SESSION);
  run.backend.notes.set('w1', [
    note('asked', new Date('2026-11-13T10:00:00Z')),
    note('go on', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  let ran = false;
  run.deps.run = async () => {
    ran = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(run.deps, 'w1');
  assert.equal(ran, false);
  assert.ok(run.backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('did not start for this task')));
});

// The board is the other side of every call the worker makes: it may refuse, hold an answer for as long as the client waits, or
// answer slowly on purpose. None of that may keep the worker from checking the run's own limits.
function stalledRun(options: { quietSince: Date; now: Date }) {
  const run = setup({ exitCode: 0, signal: null });
  const { deps, backend } = run;
  deps.now = () => options.now;
  (deps.files as ReturnType<typeof fakeRunFiles>).touchAlive('w1', options.quietSince);
  const decisions: Supervision[] = [];
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    for (let n = 0; n < 1000; n += 1) onLine(textEvent(`t${n}`));
    decisions.push(await watch.tick());
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  return { ...run, decisions };
}

test('a board that never answers a transcript upload or a heartbeat cannot hold back the run’s limits (stalled supervision)', async () => {
  const now = new Date('2026-11-14T12:00:00Z');
  const { deps, backend, decisions } = stalledRun({ quietSince: new Date(now.getTime() - 20 * 60_000), now });
  let uploads = 0;
  const never = new Promise<never>(() => undefined);
  backend.transcript = async () => {
    uploads += 1;
    return never;
  };
  backend.heartbeat = async () => never;
  // The run ends only when the test lets it; the hanging calls are still open then.
  const ended = Promise.race([
    runWorker(deps, 'w1').then(() => 'ended'),
    new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 300)),
  ]);
  assert.equal(
    await ended,
    'waiting',
    'the end of the run waits for the hanging upload, which is bounded in the real client',
  );
  assert.equal(decisions.length, 1, 'the tick answered without waiting for the board');
  assert.deepEqual(decisions[0], {
    kind: 'stop',
    why: 'inactive',
    message: 'Stopped: the agent made no tool call for 15 minutes.',
  });
  assert.equal(uploads, 1);
});

test('a board that refuses every transcript batch costs a bounded number of calls per pass, never the limits (2N-1 calls)', async () => {
  const now = new Date('2026-11-14T12:00:00Z');
  const { deps, backend, decisions } = stalledRun({ quietSince: new Date(now.getTime() - 20 * 60_000), now });
  let calls = 0;
  backend.transcript = async () => {
    calls += 1;
    throw new BackendError('transcript: refused', 400);
  };
  let afterTick = -1;
  const inner = deps.run;
  deps.run = async (invocation, taskId, env, watch, onLine) => {
    const result = await inner(invocation, taskId, env, watch, onLine);
    await settle();
    afterTick = calls;
    return result;
  };
  await runWorker(deps, 'w1');
  assert.equal(decisions[0]?.kind, 'stop');
  assert.ok(afterTick >= 1 && afterTick <= 24, `${afterTick} calls in one pass`);
  assert.ok(calls <= 72, `${calls} calls in all, the end of the run with its two passes included`);
});

const toolPair = (n: number, output: string) => [
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: `t${n}`, name: 'Bash', input: { command: `step ${n}` } }] },
  }),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: output }] },
  }),
];

test('a backlog past its byte budget loses the oldest tool outputs first, and the transcript says so', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.maxPendingBytes = 5_000;
  const stored: { kind: string; output?: string; text?: string }[] = [];
  let down = true;
  backend.transcript = async (_id, batch) => {
    if (down) throw new BackendError('transcript: error from the board server (HTTP 503)', 503);
    stored.push(...batch.events);
  };
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    for (let n = 0; n < 6; n++) for (const line of toolPair(n, `output ${n} ${'x'.repeat(1_000)}`)) onLine(line);
    await watch.tick();
    await settle();
    down = false;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  const results = stored.filter((event) => event.kind === 'tool_result');
  assert.equal(results.length, 6, 'every tool result is still there, in order');
  assert.equal(results[0]?.output, '', 'the oldest output went first');
  assert.match(results.at(-1)?.output ?? '', /^output 5 /, 'the newest output is kept');
  assert.equal(stored.filter((event) => event.kind === 'tool_use').length, 6);
  const notes = stored.filter((event) => event.kind === 'note');
  assert.ok(notes.length >= 1, 'a note says that outputs were dropped');
  for (const note of notes)
    assert.match(note.text ?? '', /\d+ tool outputs of this run were dropped from the transcript/);
});

test('a backlog that outgrows its budget even without outputs drops its oldest events, and notes it', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.maxPendingBytes = 2_000;
  const stored: { kind: string; text?: string }[] = [];
  let down = true;
  backend.transcript = async (_id, batch) => {
    if (down) throw new BackendError('transcript: error from the board server (HTTP 503)', 503);
    stored.push(...batch.events);
  };
  deps.run = async (_invocation, _taskId, _env, watch, onLine) => {
    for (let n = 0; n < 30; n++) onLine(textEvent(`event ${n} ${'y'.repeat(200)}`));
    await watch.tick();
    await settle();
    down = false;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  const texts = stored.filter((event) => event.kind === 'text').map((event) => event.text ?? '');
  assert.ok(texts.length > 0 && texts.length < 30, `${texts.length} events kept`);
  assert.match(texts.at(-1) ?? '', /^event 29 /, 'the newest events are the ones kept');
  assert.match(stored.find((event) => event.kind === 'note')?.text ?? '', /\d+ events of this run were dropped/);
});

test('the end of the run makes a second pass over what the first left', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  let calls = 0;
  const sent: string[] = [];
  backend.transcript = async (_id, batch) => {
    calls += 1;
    if (calls === 1) throw new BackendError('transcript: error from the board server (HTTP 503)', 503);
    sent.push(...batch.events.map((event) => (event.kind === 'text' ? event.text : event.kind)));
  };
  deps.run = async (_invocation, _taskId, _env, _watch, onLine) => {
    onLine(textEvent('a'));
    onLine(textEvent('b'));
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(calls, 2);
  assert.deepEqual(sent, ['a', 'b']);
});

// A running agent's stdin, recorded.
function fakeChannel() {
  const calls: string[] = [];
  const sent: string[] = [];
  let open = true;
  const channel: RunChannel = {
    get open() {
      return open;
    },
    send(text) {
      if (!open) return false;
      sent.push(text);
      calls.push('send');
      return true;
    },
    interrupt() {
      if (open) calls.push('interrupt');
    },
    end() {
      if (open) calls.push('end');
      open = false;
    },
    stop() {
      if (open) calls.push('interrupt', 'end');
      open = false;
    },
    kill() {
      calls.push('kill');
      return true;
    },
  };
  return { channel, calls, sent };
}

const userMessage = (text: string, overrides: Partial<Note> = {}): Note =>
  note(text, new Date('2026-01-01T10:05:00Z'), { author: 'user', pending: true, ...overrides });

// Runs the worker with a process that stays for `during`, which gets the watch and the agent's channel.
async function runWith(
  during: (input: {
    watch: Watch;
    channel: ReturnType<typeof fakeChannel>;
    backend: ReturnType<typeof setup>['backend'];
    deps: WorkerDeps;
  }) => Promise<void>,
  result: RunResult = { exitCode: 0, signal: null },
) {
  const harness = setup(result);
  const channel = fakeChannel();
  harness.deps.run = async (_invocation, _taskId, _env, watch) => {
    watch.start?.(channel.channel);
    await during({ watch, channel, backend: harness.backend, deps: harness.deps });
    return result;
  };
  await runWorker(harness.deps, 'w1');
  return { ...harness, channel };
}

test('a pause request is told to the agent as a message, once, and an agent that ignores it is interrupted after the grace', async () => {
  const decisions: Supervision[] = [];
  let clock = Date.now();
  const { channel, backend } = await runWith(async ({ watch, channel, deps }) => {
    deps.now = () => new Date(clock);
    deps.files.writeRun('w1', { lane: 'implement', borrowed: true, startedAt: new Date(clock) });
    deps.files.touchAlive('w1', new Date(clock));
    deps.files.requestPause('w1');
    decisions.push(await watch.tick());
    decisions.push(await watch.tick());
    assert.equal(channel.sent.length, 1);
    clock += 3 * 60_000;
    deps.files.touchAlive('w1', new Date(clock));
    decisions.push(await watch.tick());
  });
  assert.match(channel.sent[0] ?? '', /Pause requested.*board comment w1 "\.\.\."/);
  assert.deepEqual(
    decisions.map((decision) => decision.kind),
    ['continue', 'continue', 'stop'],
  );
  assert.ok(decisions[2]?.kind === 'stop' && decisions[2].why === 'pause-forced');
  assert.ok(backend.writes.some((w) => w.startsWith('pause w1')));
});

function shutdownHarness(options: { graceMs?: number; deadline?: Date } = {}) {
  const harness = setup({ exitCode: 0, signal: null });
  const channel = fakeChannel();
  let announce: (() => void) | undefined;
  harness.deps.watchShutdown = (onRequest) => {
    announce = onRequest;
    return () => void (announce = undefined);
  };
  harness.deps.shutdownGraceMs = options.graceMs ?? 30;
  if (options.deadline !== undefined) harness.deps.files.requestShutdown('w1', options.deadline);
  Object.assign(harness.backend.tasks[0]!, { sessionId: 's' });
  return { ...harness, channel, announce: () => announce?.() };
}

test('a shutdown request interrupts the agent, stops it once the grace is over, and pauses the task with its own note', async () => {
  const { deps, backend, channel, announce } = shutdownHarness();
  deps.run = async (_invocation, _taskId, _env, watch) => {
    watch.start?.(channel.channel);
    announce();
    assert.deepEqual(channel.calls, ['interrupt']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { exitCode: 143, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(channel.calls, ['interrupt', 'interrupt', 'end']);
  const pause = backend.writes.filter((w) => w.startsWith('pause w1'));
  assert.deepEqual(pause, ['pause w1: Paused: the worker on here shut down. Resumes next, on here.']);
  assert.ok(!backend.writes.some((w) => w.startsWith('fail ')));
});

test('an agent that ends its turn within the grace is not stopped, and a second request changes nothing', async () => {
  const { deps, backend, channel, announce } = shutdownHarness({ graceMs: 5_000 });
  deps.run = async (_invocation, _taskId, _env, watch) => {
    watch.start?.(channel.channel);
    announce();
    announce();
    channel.channel.end();
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(channel.calls, ['interrupt', 'end']);
  assert.equal(backend.writes.filter((w) => w.startsWith('pause w1')).length, 1);
});

test('the grace comes from the deadline the shutdown command wrote, and a deadline that has passed stops at once', async () => {
  const { deps, channel, announce } = shutdownHarness({ graceMs: 60_000, deadline: new Date(Date.now() - 1_000) });
  deps.run = async (_invocation, _taskId, _env, watch) => {
    watch.start?.(channel.channel);
    announce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { exitCode: 143, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(channel.calls, ['interrupt', 'interrupt', 'end']);
});

test('a shutdown request after the agent ended its turn kills the agent once, and the task is paused', async () => {
  const { deps, backend, calls, channel, announce } = shutdownHarness({ graceMs: 5_000 });
  deps.run = async (_invocation, _taskId, _env, watch) => {
    watch.start?.(channel.channel);
    channel.channel.end();
    announce();
    announce();
    return { exitCode: null, signal: 'SIGTERM' };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(channel.calls, ['end', 'kill']);
  assert.ok(calls.some((line) => /stopped the agent, which had ended its turn/.test(line)));
  assert.deepEqual(
    backend.writes.filter((w) => w.startsWith('pause w1')),
    ['pause w1: Paused: the worker on here shut down. Resumes next, on here.'],
  );
  assert.ok(!backend.writes.some((w) => w.startsWith('fail ')));
});

test('an agent that ends its turn during the grace but lingers is killed when the grace is over', async () => {
  const { deps, channel, announce } = shutdownHarness({ graceMs: 30 });
  deps.run = async (_invocation, _taskId, _env, watch) => {
    watch.start?.(channel.channel);
    announce();
    channel.channel.end();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { exitCode: null, signal: 'SIGTERM' };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(channel.calls, ['interrupt', 'end', 'kill']);
});

test('SIGUSR2 reaches an agent that ended its turn and still runs background work: it is stopped and the task paused', async () => {
  process.env['AGENT_BOARD_STATE_DIR'] = mkdtempSync(join(tmpdir(), 'agent-board-shutdown-'));
  const { deps, backend } = shutdownHarness({ graceMs: 5_000 });
  const signals = new EventEmitter();
  deps.watchShutdown = latchShutdownSignal(signals);
  const pidFile = join(mkdtempSync(join(tmpdir(), 'agent-board-lingering-')), 'pgid');
  const lingeringAgent = [
    'read -r prompt',
    `echo $$ > '${pidFile}'`,
    `printf '%s\\n' '{"type":"result","subtype":"success"}'`,
    'sleep 300 &',
    'wait',
  ].join('\n');
  deps.run = (invocation, taskId, env, watch, onLine) =>
    runProcess(
      { ...invocation, command: 'sh', args: ['-c', lingeringAgent] },
      taskId,
      env,
      {
        ...watch,
        start: (live) => {
          watch.start?.(live);
          setTimeout(() => signals.emit('SIGUSR2'), 300);
        },
      },
      onLine,
    );
  const started = Date.now();
  await runWorker(deps, 'w1');
  assert.ok(Date.now() - started < 3_000, 'the run ended at the signal, not at the grace');
  assert.deepEqual(
    backend.writes.filter((w) => w.startsWith('pause w1')),
    ['pause w1: Paused: the worker on here shut down. Resumes next, on here.'],
  );
  const pgid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.equal(groupExists(pgid), false, 'the agent and its background work are gone');
});

test('a request that came before the agent started interrupts it as soon as it has', async () => {
  const { deps, channel, announce } = shutdownHarness({ graceMs: 5_000 });
  deps.run = async (_invocation, _taskId, _env, watch) => {
    announce();
    assert.deepEqual(channel.calls, []);
    watch.start?.(channel.channel);
    assert.deepEqual(channel.calls, ['interrupt']);
    channel.channel.end();
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
});

test('while the machine shuts down, no message from the board is handed to the agent', async () => {
  const { deps, backend, channel, announce } = shutdownHarness({ graceMs: 5_000 });
  backend.inboxes.set('w1', { stop: false, messages: [userMessage('hello', { id: 'm1' })] });
  deps.run = async (_invocation, _taskId, _env, watch) => {
    announce();
    watch.start?.(channel.channel);
    await settle();
    channel.channel.end();
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.deepEqual(channel.sent, []);
});

test('a board that refuses the pause report is logged and the worker still ends', async () => {
  const { deps, backend, calls, channel, announce } = shutdownHarness();
  backend.pause = async () => {
    throw new BackendError('pause: HTTP 503', 503, true);
  };
  deps.run = async (_invocation, _taskId, _env, watch) => {
    watch.start?.(channel.channel);
    announce();
    channel.channel.end();
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.ok(calls.some((line) => /the board did not take the pause report/.test(line)));
});

test('SIGUSR2 on the real process path ends the agent turn, and the task is reported paused', async () => {
  process.env['AGENT_BOARD_STATE_DIR'] = mkdtempSync(join(tmpdir(), 'agent-board-shutdown-'));
  const { deps, backend } = shutdownHarness({ graceMs: 5_000 });
  const signals = new EventEmitter();
  deps.watchShutdown = latchShutdownSignal(signals);
  const fakeAgent = [
    'read -r prompt',
    'while IFS= read -r line; do',
    '  case "$line" in',
    `    *control_request*) printf '%s\\n' '{"type":"result","subtype":"error_during_execution"}';;`,
    '  esac',
    'done',
  ].join('\n');
  deps.run = (invocation, taskId, env, watch, onLine) =>
    runProcess(
      { ...invocation, command: 'sh', args: ['-c', fakeAgent] },
      taskId,
      env,
      {
        ...watch,
        start: (live) => {
          watch.start?.(live);
          setTimeout(() => signals.emit('SIGUSR2'), 50);
        },
      },
      onLine,
    );
  const started = Date.now();
  await runWorker(deps, 'w1');
  assert.ok(Date.now() - started < 3_000, 'the run ended by its own turn end, not by the grace');
  assert.deepEqual(
    backend.writes.filter((w) => w.startsWith('pause w1')),
    ['pause w1: Paused: the worker on here shut down. Resumes next, on here.'],
  );
});

test('the pause message is not sent into a closed stdin', async () => {
  const { channel } = await runWith(async ({ watch, channel, deps }) => {
    channel.channel.end();
    deps.files.requestPause('w1');
    await watch.tick();
  });
  assert.deepEqual(channel.sent, []);
});

test("a message of the user's reaches the running agent without interrupting it, and is acknowledged", async () => {
  const message = userMessage('also check the migration');
  const { channel, backend } = await runWith(async ({ watch, channel, backend }) => {
    backend.inboxes.set('w1', { stop: false, messages: [message] });
    await watch.tick();
    await settle();
    assert.equal(channel.sent.length, 1);
  });
  assert.deepEqual(channel.calls, ['send']);
  assert.match(
    channel.sent[0] ?? '',
    /sent you a message on board task w1 while you work:\n\nalso check the migration/,
  );
  assert.ok(backend.writes.includes(`ack w1: ${message.id}`));
});

test('a change the board announces makes the worker look at its inbox at once', async () => {
  const message = userMessage('go on');
  let announce: (() => void) | undefined;
  let listening = true;
  const harness = setup({ exitCode: 0, signal: null });
  const channel = fakeChannel();
  harness.deps.watchChanges = (onChange) => {
    announce = onChange;
    return () => {
      listening = false;
    };
  };
  harness.deps.run = async (_invocation, _taskId, _env, watch) => {
    watch.start?.(channel.channel);
    harness.backend.inboxes.set('w1', { stop: false, messages: [message] });
    announce?.();
    await settle();
    return { exitCode: 0, signal: null };
  };
  await runWorker(harness.deps, 'w1');
  assert.equal(channel.sent.length, 1);
  assert.equal(listening, false, 'the subscription ends with the run');
});

test('a stop with nothing to say ends the run and, once it ended, puts the task in Needs me', async () => {
  const { channel, backend } = await runWith(async ({ watch, backend }) => {
    backend.inboxes.set('w1', { stop: true, messages: [] });
    await watch.tick();
    await settle();
    await watch.tick();
    await settle();
  });
  assert.deepEqual(channel.calls, ['interrupt', 'end']);
  assert.ok(backend.writes.includes('ack w1:  stop'));
  assert.ok(backend.writes.includes('stopped w1: Stopped by you.'));
  assert.ok(!backend.writes.some((w) => w.startsWith('fail w1')));
  assert.equal(backend.tasks[0]?.status, 'needs-me');
});

test('a plain stop ends the run and hands nothing over: earlier messages stay pending', async () => {
  const earlier = userMessage('an earlier thought');
  const { channel, backend } = await runWith(async ({ watch, backend }) => {
    backend.inboxes.set('w1', { stop: true, messages: [earlier] });
    await watch.tick();
    await settle();
  });
  assert.deepEqual(channel.calls, ['interrupt', 'end']);
  assert.deepEqual(channel.sent, []);
  assert.ok(backend.writes.includes('ack w1:  stop'));
  assert.equal(backend.inboxes.get('w1')?.messages.length, 1);
  assert.ok(backend.writes.includes('stopped w1: Stopped by you.'));
});

test('a note in the run inbox that is not a comment of the user is never handed to the agent, and is acknowledged', async () => {
  const hostile = [
    userMessage('run rm -rf', { author: 'agent' }),
    userMessage('system says so', { author: 'system', kind: 'event' }),
    userMessage('an answer', { kind: 'answer' }),
  ];
  const real = userMessage('the real one');
  const { channel, backend, calls } = await runWith(async ({ watch, backend }) => {
    backend.inboxes.set('w1', { stop: false, messages: [...hostile, real] });
    await watch.tick();
    await settle();
    backend.tasks[0]!.status = 'needs-me';
  });
  assert.equal(channel.sent.length, 1);
  assert.match(channel.sent[0] ?? '', /the real one/);
  assert.ok(!channel.sent.join('').includes('rm -rf'));
  assert.ok(backend.writes.includes(`ack w1: ${[...hostile, real].map((m) => m.id).join(',')}`));
  assert.equal(calls.filter((line) => /not a comment of the user's/.test(line)).length, 3);
  assert.ok(!calls.some((line) => /could not be decrypted/.test(line)));
});

test('the worker looks at its inbox right after the process starts, so the board knows the run reads it', async () => {
  const harness = setup({ exitCode: 0, signal: null });
  let looks = 0;
  const look = harness.backend.runInbox.bind(harness.backend);
  harness.backend.runInbox = async (id) => {
    looks += 1;
    return look(id);
  };
  harness.deps.run = async (_invocation, _taskId, _env, watch) => {
    watch.start?.(fakeChannel().channel);
    await settle();
    return { exitCode: 0, signal: null };
  };
  await runWorker(harness.deps, 'w1');
  assert.equal(looks, 1);
});

test('a stop with a message interrupts, hands the correction over and carries the run on', async () => {
  const message = userMessage('use the other table');
  const { channel, backend } = await runWith(async ({ watch, backend }) => {
    backend.inboxes.set('w1', { stop: true, stopMessage: message.id, messages: [message] });
    await watch.tick();
    await settle();
    await watch.tick();
    await settle();
    backend.tasks[0]!.status = 'needs-me';
  });
  assert.deepEqual(channel.calls, ['interrupt', 'send']);
  assert.match(channel.sent[0] ?? '', /interrupted you on board task w1 to correct you:\n\nuse the other table/);
  assert.ok(backend.writes.includes(`ack w1: ${message.id} stop`));
  assert.ok(!backend.writes.some((w) => w.startsWith('stopped w1')), 'the agent finished by itself');
});

test('a stop request is acted on once, even when the acknowledgement was lost', async () => {
  const message = userMessage('use the other table');
  let attempts = 0;
  const { channel, backend } = await runWith(async ({ watch, backend }) => {
    backend.inboxes.set('w1', { stop: true, stopMessage: message.id, messages: [message] });
    const ack = backend.ackMessages.bind(backend);
    backend.ackMessages = async (id, request) => {
      attempts += 1;
      if (attempts === 1) throw new BackendError('ack-messages: cannot reach the board');
      return ack(id, request);
    };
    for (let round = 0; round < 3; round += 1) {
      await watch.tick();
      await settle();
    }
    backend.tasks[0]!.status = 'needs-me';
  });
  assert.deepEqual(channel.calls, ['interrupt', 'send'], 'one interrupt and one delivery');
  assert.equal(attempts, 2);
  assert.ok(backend.writes.includes(`ack w1: ${message.id} stop`));
});

test('nothing is handed over once the run ended its stdin; the message stays pending', async () => {
  const { channel, backend } = await runWith(async ({ watch, channel, backend }) => {
    channel.channel.end();
    backend.inboxes.set('w1', { stop: false, messages: [userMessage('too late')] });
    await watch.tick();
    await settle();
    backend.tasks[0]!.status = 'needs-me';
  });
  assert.deepEqual(channel.sent, []);
  assert.ok(!backend.writes.some((w) => w.startsWith('ack ')));
  assert.equal(backend.inboxes.get('w1')?.messages.length, 1);
});

test('a message that cannot be decrypted is not handed over, and is acknowledged so it does not come back', async () => {
  const unreadable = userMessage('', { unreadable: true });
  const { channel, backend, calls } = await runWith(async ({ watch, backend }) => {
    backend.inboxes.set('w1', { stop: false, messages: [unreadable] });
    await watch.tick();
    await settle();
    backend.tasks[0]!.status = 'needs-me';
  });
  assert.deepEqual(channel.sent, []);
  assert.ok(backend.writes.includes(`ack w1: ${unreadable.id}`));
  assert.ok(calls.some((line) => /could not be decrypted.*acknowledged/.test(line)));
});

test('a board without the run inbox is left alone for the rest of the run', async () => {
  let looks = 0;
  const { calls, channel } = await runWith(async ({ watch, backend }) => {
    backend.runInbox = async () => {
      looks += 1;
      const error = new BackendError('the board server does not support messages yet');
      error.missingFeature = 'run-inbox';
      throw error;
    };
    await watch.tick();
    await settle();
    await watch.tick();
    await settle();
  });
  assert.equal(looks, 1);
  assert.deepEqual(channel.calls, []);
  assert.ok(calls.some((line) => /no run inbox/.test(line)));
});

test('the resume prompt of a run leaves out what the agent was handed while it ran', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  deps.sessions = fakeSessions([['w1', SESSION]]);
  Object.assign(backend.tasks[0]!, { next: 'resume', sessionId: SESSION });
  backend.notes.set('w1', [
    note('earlier', new Date('2026-01-01T09:00:00Z'), { author: 'agent' }),
    note('handed over mid-run', new Date('2026-01-01T09:10:00Z'), {
      author: 'user',
      deliveredAt: new Date('2026-01-01T09:11:00Z'),
    }),
    note('said after the stop', new Date('2026-01-01T09:20:00Z'), { author: 'user' }),
  ]);
  let prompt = '';
  deps.run = async (invocation) => {
    prompt = invocation.prompt;
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.match(prompt, /said after the stop/);
  assert.doesNotMatch(prompt, /handed over mid-run/);
});

// Enforcement: config.json has a `dirs` list.
const withDirs = (deps: WorkerDeps, ...dirs: string[]): void => {
  deps.config = { ...CONFIG, dirs: dirs.map((path) => ({ path })) };
};

test('a run in a listed directory, or below one, starts as before', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  withDirs(deps, '/tmp');
  deps.run = async () => {
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  backend.tasks[0]!.workdir = '/tmp/sub';
  await runWorker(deps, 'w1');
  assert.ok(!backend.writes.some((w) => w.startsWith('fail ')));
});

test('a task in a directory outside the list is refused with the reason, and the agent never starts', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  withDirs(deps, '/srv/app');
  let started = false;
  deps.run = async () => {
    started = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(started, false);
  assert.ok(
    backend.writes.some(
      (w) =>
        w.startsWith('fail w1:') &&
        w.includes('/tmp is not a listed directory on here') &&
        w.includes('board dirs add') &&
        w.includes('Re-run fresh'),
    ),
  );
  assert.ok(!backend.writes.some((w) => w.startsWith('workdir ')));
});

test('an empty list refuses every start; no list at all changes nothing', async () => {
  const empty = setup({ exitCode: 0, signal: null });
  withDirs(empty.deps);
  await runWorker(empty.deps, 'w1');
  assert.ok(empty.backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('not a listed directory')));

  const none = setup({ exitCode: 0, signal: null });
  await runWorker(none.deps, 'w1');
  assert.ok(!none.backend.writes.some((w) => w.includes('not a listed directory')));
});

test('a missing directory keeps its own message even when it is not listed either', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  withDirs(deps, '/srv/app');
  deps.dirExists = () => false;
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('directory is gone')));
  assert.ok(!backend.writes.some((w) => w.includes('not a listed directory')));
});

test('a symlink inside a listed directory that points outside is refused, and a listed link is followed', async () => {
  const links: Record<string, string> = { '/srv/app/out': '/etc', '/home/me/alias': '/srv/app' };
  const realpath = (path: string): string => links[path] ?? path;
  const outside = setup({ exitCode: 0, signal: null });
  withDirs(outside.deps, '/srv/app');
  outside.deps.realpath = realpath;
  outside.backend.tasks[0]!.workdir = '/srv/app/out';
  await runWorker(outside.deps, 'w1');
  assert.ok(outside.backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('not a listed directory')));

  const listed = setup({ exitCode: 0, signal: null });
  withDirs(listed.deps, '/home/me/alias');
  listed.deps.realpath = realpath;
  listed.backend.tasks[0]!.workdir = '/srv/app';
  await runWorker(listed.deps, 'w1');
  assert.ok(!listed.backend.writes.some((w) => w.includes('not a listed directory')));
});

test('a form task routed to the default directory is refused when that is not listed', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  withDirs(deps, '/srv/app');
  Object.assign(backend.tasks[0]!, { machine: null, workdir: null });
  await runWorker(deps, 'w1');
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('/home/me is not a listed directory')));
});

test('a resume in a workdir that left the list is refused, not started', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  withDirs(deps, '/srv/app');
  Object.assign(backend.tasks[0]!, {
    next: 'resume',
    sessionId: SESSION,
    workdir: '/repo/.claude/worktrees/feat-x',
  });
  deps.sessions.record('w1', SESSION);
  backend.notes.set('w1', [
    note('asked', new Date('2026-11-13T10:00:00Z')),
    note('go on', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
  ]);
  let started = false;
  deps.run = async () => {
    started = true;
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(started, false);
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('feat-x is not a listed directory')));
});

test('a run that ends outside the list keeps its directory and leaves a system note', async () => {
  const { deps, backend } = setup({ exitCode: 0, signal: null });
  withDirs(deps, '/tmp');
  deps.run = async () => {
    deps.files.writeCwd('w1', '/var/elsewhere');
    backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.ok(!backend.writes.some((w) => w.startsWith('workdir ')));
  const noted = backend.writes.find((w) => w.startsWith('note w1 (system):'));
  assert.ok(noted?.includes('/var/elsewhere') && noted.includes('not a listed directory') && noted.includes('/tmp'));
  assert.ok(!backend.writes.some((w) => w.startsWith('fail ')));
});

test('a note that cannot be added does not lose the run, and an end inside the list is stored', async () => {
  const failing = setup({ exitCode: 0, signal: null });
  withDirs(failing.deps, '/tmp');
  failing.deps.run = async () => {
    failing.deps.files.writeCwd('w1', '/var/elsewhere');
    failing.backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  failing.backend.addNote = async () => {
    throw new Error('board down');
  };
  await runWorker(failing.deps, 'w1');
  assert.ok(failing.calls.some((c) => c.includes('could not add the note: board down')));
  assert.ok(!failing.backend.writes.some((w) => w.startsWith('fail ')));

  const inside = setup({ exitCode: 0, signal: null });
  withDirs(inside.deps, '/tmp');
  inside.deps.run = async () => {
    inside.deps.files.writeCwd('w1', '/tmp/.claude/worktrees/feat-x');
    inside.backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  await runWorker(inside.deps, 'w1');
  assert.deepEqual(
    inside.backend.writes.filter((w) => w.startsWith('workdir w1')),
    ['workdir w1: /tmp/.claude/worktrees/feat-x'],
  );
});

const REVIEWER: AgentConfig = {
  description: 'Reviews a PR.',
  prompt: 'You review.',
  tools: ['Read', 'Bash'],
  allowedTools: ['Read', 'Bash({pr-review}/x.sh *)'],
  disallowedTools: ['Bash(git push *)'],
  env: ['CIRCLECI_TOKEN'],
  mcpServers: ['shortcut', 'gone'],
};

function setupAgent(overrides: Partial<Task> = { agent: 'reviewer' }) {
  const made = setup({ exitCode: 0, signal: null });
  made.deps.config = { ...CONFIG, agents: { reviewer: REVIEWER } };
  Object.assign(made.backend.tasks[0]!, overrides);
  const seen: { invocation?: Invocation; env?: Record<string, string>; agentsFile?: string } = {};
  made.deps.run = async (invocation, taskId, env) => {
    seen.invocation = invocation;
    seen.env = env;
    seen.agentsFile = (made.deps.files as ReturnType<typeof fakeRunFiles>).agents.get(taskId);
    made.backend.tasks[0]!.status = 'needs-me';
    return { exitCode: 0, signal: null };
  };
  return { ...made, seen };
}

test('a task that names an agent runs as it: its file, its lists, its variables and servers, and the restricted marker', async () => {
  const { deps, backend, calls, seen } = setupAgent();
  const pluginAsked: string[] = [];
  deps.pluginPath = (name) => {
    pluginAsked.push(name);
    return '/plugins/pr';
  };
  const read: string[] = [];
  deps.settingsEnv = (dir) => {
    read.push(dir);
    return { CIRCLECI_TOKEN: 'ci-secret', OTHER: 'not asked for' };
  };
  deps.mcpServers = (dir, names) => {
    assert.equal(dir, '/tmp');
    assert.deepEqual(names, ['shortcut', 'gone']);
    return { config: { mcpServers: { shortcut: { type: 'http', url: 'https://mcp.example' } } }, missing: ['gone'] };
  };
  await runWorker(deps, 'w1');
  const args = seen.invocation?.args ?? [];
  assert.deepEqual(pluginAsked, ['pr-review']);
  assert.equal(
    args[args.indexOf('--agents=/run/test/agent-board/w1.agents')],
    '--agents=/run/test/agent-board/w1.agents',
  );
  assert.ok(args.includes('--agent=reviewer'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--allowedTools') + 2], 'Bash(/plugins/pr/x.sh *)');
  assert.equal(
    args[args.indexOf('--mcp-config') + 1],
    '{"mcpServers":{"shortcut":{"type":"http","url":"https://mcp.example"}}}',
  );
  assert.deepEqual(JSON.parse(seen.agentsFile ?? ''), {
    reviewer: { description: 'Reviews a PR.', prompt: 'You review.', tools: ['Read', 'Bash'] },
  });
  assert.deepEqual(read, ['/tmp', '/h']);
  assert.deepEqual(seen.env, {
    CIRCLECI_TOKEN: 'ci-secret',
    AGENT_BOARD_TASK: 'w1',
    AGENT_BOARD_RESTRICTED: '1',
    AGENT_BOARD_START_DIR: '/tmp',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  });
  assert.ok(calls.some((c) => c.includes("not in the checkout's .mcp.json: gone")));
  assert.ok(!calls.some((c) => c.includes('ci-secret')), 'values never reach the log');
  assert.deepEqual((deps.files as ReturnType<typeof fakeRunFiles>).agents.size, 0, 'the file goes with the run');
  assert.ok(!backend.writes.some((w) => w.startsWith('fail ')));
});

test("the agent's own variables cannot override the restricted marker or the task", async () => {
  const { deps, seen } = setupAgent();
  deps.config = {
    ...CONFIG,
    agents: { reviewer: { ...REVIEWER, env: ['AGENT_BOARD_RESTRICTED', 'AGENT_BOARD_TASK'], allowedTools: [] } },
  };
  deps.settingsEnv = () => ({ AGENT_BOARD_RESTRICTED: '0', AGENT_BOARD_TASK: 'other' });
  await runWorker(deps, 'w1');
  assert.equal(seen.env?.['AGENT_BOARD_RESTRICTED'], '1');
  assert.equal(seen.env?.['AGENT_BOARD_TASK'], 'w1');
});

test('only an agent run gets the restricted marker: a user run does not', async () => {
  const { deps, seen } = setupAgent({});
  await runWorker(deps, 'w1');
  assert.ok(seen.env !== undefined && !('AGENT_BOARD_RESTRICTED' in seen.env));
  assert.equal(seen.agentsFile, undefined);
});

const OLD_INTAKE = {
  createdBy: 'intake' as const,
  input: '/review-pr https://github.com/cosuno/cosuno/pull/1 --auto',
  machine: null,
  workdir: null,
};

test('a task of the removed intake that names no agent fails closed with the reason, whatever the config holds, a resume included', async () => {
  for (const resume of [false, true]) {
    const { deps, backend, seen } = setupAgent({
      ...OLD_INTAKE,
      ...(resume ? { next: 'resume' as const, sessionId: SESSION } : {}),
    });
    await runWorker(deps, 'w1');
    assert.equal(seen.invocation, undefined, 'nothing starts, in auto mode or any other');
    assert.ok(
      backend.writes.some(
        (w) => w.startsWith('fail w1:') && w.includes('built-in intake') && w.includes('board schedule --agent'),
      ),
      `resume ${resume}`,
    );
    assert.ok(!backend.writes.some((w) => w.startsWith('session w1')), 'no session is started');
  }
});

test('a task of the removed intake that names an agent runs as that agent, like any other task', async () => {
  const { deps, backend, seen } = setupAgent({ ...OLD_INTAKE, agent: 'reviewer' });
  deps.pluginPath = () => '/plugins/pr';
  await runWorker(deps, 'w1');
  const args = seen.invocation?.args ?? [];
  assert.ok(args.includes('--agent=reviewer'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(!args.includes('auto'));
  assert.equal(seen.env?.['AGENT_BOARD_RESTRICTED'], '1');
  assert.ok(!backend.writes.some((w) => w.startsWith('fail ')));
});

test('a task naming an agent this machine lacks fails closed with the reason, and nothing starts, a resume included', async () => {
  for (const resume of [false, true]) {
    const { deps, backend, calls, seen } = setupAgent({ agent: 'ghost' });
    if (resume) {
      Object.assign(backend.tasks[0]!, { next: 'resume', sessionId: SESSION });
      deps.sessions.record('w1', SESSION);
      backend.notes.set('w1', [
        note('asked', new Date('2026-11-13T10:00:00Z')),
        note('go on', new Date('2026-11-13T10:05:00Z'), { author: 'user' }),
      ]);
    }
    await runWorker(deps, 'w1');
    assert.equal(seen.invocation, undefined, 'nothing started');
    assert.ok(
      backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('no agent ghost defined here')),
      backend.writes.join('\n'),
    );
    assert.ok(!backend.writes.some((w) => w.startsWith('next w1')), 'the resume is not used up');
    assert.ok(calls.some((c) => c.startsWith('append w1:') && c.includes('no agent ghost defined here')));
  }
});

test('a failure to write the agents file fails the task with the reason, gives the session back and clears the files', async () => {
  const { deps, backend, seen } = setupAgent();
  deps.pluginPath = () => '/plugins/pr';
  deps.files = {
    ...deps.files,
    writeAgents: () => {
      throw new Error('EACCES: cannot write');
    },
  };
  await runWorker(deps, 'w1');
  assert.equal(seen.invocation, undefined);
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('EACCES: cannot write')));
  assert.deepEqual(
    backend.writes.filter((w) => w.startsWith('session w1')),
    [`session w1: ${SESSION}`, 'session w1: null'],
  );
});

test("an agent's plugin that cannot be resolved sends the task to Needs me with the reason", async () => {
  const { deps, backend, seen } = setupAgent();
  deps.pluginPath = () => {
    throw new Error('plugin pr-review is installed from several marketplaces (a@x, b@y)');
  };
  await runWorker(deps, 'w1');
  assert.equal(seen.invocation, undefined);
  assert.ok(
    backend.writes.some(
      (w) =>
        w.startsWith('fail w1:') &&
        w.includes('Cannot resolve the pr-review plugin: plugin pr-review is installed from several'),
    ),
  );
});

test("an agent run's settings and servers are read only once its directory is a listed one", async () => {
  const { deps, backend, seen } = setupAgent({ agent: 'reviewer', workdir: '/srv/other', machine: 'here' });
  deps.config = { ...deps.config, dirs: [{ path: '/srv/app' }] };
  deps.pluginPath = () => '/plugins/pr';
  let touched = false;
  deps.settingsEnv = () => ((touched = true), {});
  deps.mcpServers = () => ((touched = true), { config: { mcpServers: {} }, missing: [] });
  await runWorker(deps, 'w1');
  assert.equal(seen.invocation, undefined);
  assert.equal(touched, false);
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('not a listed directory')));
});

// The task as the board hands it over: sealed with the test key, taken through the CLI's own opening, as the worker gets it.
function boardTask(
  overrides: () => Partial<Task>,
  strip: (wire: Awaited<ReturnType<typeof wireTask>>) => void = () => undefined,
) {
  const wire = async () => {
    const sealed = await wireTask({
      id: 'w1',
      status: 'running',
      input: '/selftest go',
      machine: 'here',
      workdir: '/tmp',
      runStartedAt: new Date('2026-01-01T10:00:00Z'),
      ...overrides(),
    });
    strip(sealed);
    return sealed;
  };
  return sealingBackend({ getTask: async () => wire() } as unknown as WireBackend, KEYS);
}

test('a task the board sealed with an agent runs as that agent, end to end', async () => {
  const { deps, seen, backend } = setupAgent({});
  const sealed = boardTask(() => ({ agent: 'reviewer', status: backend.tasks[0]!.status }));
  deps.backend = { ...backend, getTask: (id) => sealed.getTask(id) };
  await runWorker(deps, 'w1');
  const args = seen.invocation?.args ?? [];
  assert.ok(args.includes('--agent=reviewer'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(seen.env?.['AGENT_BOARD_RESTRICTED'], '1');
  assert.ok(!backend.writes.some((w) => w.startsWith('fail ')));
});

test('a board that drops the sealed agent of a task cannot make it run unrestricted: the prompt no longer opens, and nothing starts', async () => {
  for (const strip of [
    (wire: { agent?: string | null }) => void delete wire.agent,
    (wire: { agent?: string | null }) => void (wire.agent = null),
  ]) {
    const { deps, seen, backend } = setupAgent({});
    const stripped = boardTask(() => ({ agent: 'reviewer', status: backend.tasks[0]!.status }), strip);
    deps.backend = { ...backend, getTask: (id) => stripped.getTask(id) };
    await runWorker(deps, 'w1');
    assert.equal(seen.invocation, undefined, 'claude was not started');
    assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('input could not be decrypted')));
  }
});

test('an agent the board sealed for another task is unreadable, and the task is not run', async () => {
  const { deps, seen, backend } = setupAgent({});
  const other = await wireTask({ id: 'zzz', agent: 'reviewer', status: 'running' });
  const moved = boardTask(
    () => ({ agent: 'reviewer', status: backend.tasks[0]!.status }),
    (wire) => void (wire.agent = other.agent ?? null),
  );
  deps.backend = { ...backend, getTask: (id) => moved.getTask(id) };
  await runWorker(deps, 'w1');
  assert.equal(seen.invocation, undefined);
  assert.ok(backend.writes.some((w) => w.startsWith('fail w1:') && w.includes('agent could not be decrypted')));
});

const W1 = { task: 'w1' };
const spoolEvent = (deps: WorkerDeps, name: string, at: string, text = `${name} is done`): string =>
  deps.watches.writeEvent({ id: newWatchId(), task: 'w1', name, at, kind: 'event', text } satisfies WatchEvent);
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

test('a run marks its task live while it works and clears the marker at its end', async () => {
  const { deps } = setup({ exitCode: 0, signal: null }, true);
  let during: number | undefined;
  deps.run = async () => {
    during = deps.watches.livePid('w1');
    return { exitCode: 0, signal: null };
  };
  await runWorker(deps, 'w1');
  assert.equal(during, process.pid);
  assert.equal(deps.watches.livePid('w1'), undefined);
});

test('a fresh run drops the watches of its task, a resume keeps them', async () => {
  const fresh = setup({ exitCode: 0, signal: null }, true);
  fresh.deps.watches.write(watchDef({ ...W1 }));
  spoolEvent(fresh.deps, 'ci', '2026-01-01T10:10:00.000Z');
  await runWorker(fresh.deps, 'w1');
  assert.deepEqual(fresh.deps.watches.list('w1').defs, []);
  assert.deepEqual(fresh.deps.watches.events('w1'), []);
  await settle();
  assert.ok(fresh.backend.writes.includes('watches w1 null'), 'the board’s list is cleared too');

  const resumed = setup({ exitCode: 0, signal: null }, true);
  Object.assign(resumed.backend.tasks[0]!, { next: 'resume', sessionId: SESSION, woken: true });
  resumed.deps.sessions.record('w1', SESSION);
  resumed.deps.watches.write(timerDef({ ...W1 }));
  await runWorker(resumed.deps, 'w1');
  assert.equal(resumed.deps.watches.list('w1').defs.length, 1);
  await settle();
  assert.ok(!resumed.backend.writes.some((write) => write.startsWith('watches w1 null')));
});

test('events that arrive while the agent works are sent over the channel, and exactly those files go', async () => {
  const harness = setup({ exitCode: 0, signal: null }, true);
  harness.deps.watches.write(timerDef({ ...W1 }));
  const { channel } = await runWithDeps(harness, async ({ deps, channel: fake }) => {
    const sentFile = spoolEvent(deps, 'ci', '2026-01-01T10:10:00.000Z', 'CI passed');
    await sleep(60);
    assert.equal(fake.sent.length, 1);
    assert.match(fake.sent[0] ?? '', /Watch "ci" on board task w1 reported[\s\S]*CI passed[\s\S]*Still open: "timer"/);
    assert.ok(!deps.watches.events('w1').some(({ file }) => file === sentFile));
    // One that comes after the look stays until the next one.
    fake.channel.end();
    spoolEvent(deps, 'health', '2026-01-01T10:11:00.000Z');
    await sleep(30);
    assert.equal(deps.watches.events('w1').length, 1, 'nothing is deleted that was not sent');
  });
  assert.equal(channel.sent.length, 1);
});

// `runWith` for a prepared harness.
async function runWithDeps(
  harness: ReturnType<typeof setup>,
  during: (input: { deps: WorkerDeps; channel: ReturnType<typeof fakeChannel>; watch: Watch }) => Promise<void>,
) {
  const channel = fakeChannel();
  harness.deps.run = async (_invocation, _taskId, _env, watch) => {
    watch.start?.(channel.channel);
    await during({ deps: harness.deps, channel, watch });
    return { exitCode: 0, signal: null };
  };
  await runWorker(harness.deps, 'w1');
  return { ...harness, channel };
}

test('the log says what was handed to the agent', async () => {
  const harness = setup({ exitCode: 0, signal: null }, true);
  const { calls } = await runWithDeps(harness, async ({ deps, channel }) => {
    spoolEvent(deps, 'ci', '2026-01-01T10:10:00.000Z');
    spoolEvent(deps, 'health', '2026-01-01T10:11:00.000Z');
    await sleep(60);
    assert.equal(channel.sent.length, 1);
  });
  assert.ok(calls.some((line) => line.includes('handed the agent 2 watch event(s) (ci, health)')));
});

test('no events and no board call at the end of a turn: the run ends', async () => {
  const harness = setup({ exitCode: 0, signal: null }, true);
  let gets = 0;
  const getTask = harness.backend.getTask.bind(harness.backend);
  harness.backend.getTask = async (id) => ((gets += 1), getTask(id));
  let answer: string | undefined = 'unset';
  await runWithDeps(harness, async ({ watch }) => {
    const before = gets;
    answer = await watch.onTurnEnd?.();
    assert.equal(gets, before);
  });
  assert.equal(answer, undefined);
});

test('events at the end of a turn continue the run while the task is running; the files go once the message is out', async () => {
  const harness = setup({ exitCode: 0, signal: null });
  let answer: string | undefined;
  await runWithDeps(harness, async ({ deps, watch }) => {
    Object.assign(harness.backend.tasks[0]!, { status: 'running' });
    spoolEvent(deps, 'ci', '2026-01-01T10:10:00.000Z', 'CI failed');
    answer = await watch.onTurnEnd?.();
    assert.equal(deps.watches.events('w1').length, 1, 'still there until sent');
    watch.turnMessageSent?.();
    assert.deepEqual(deps.watches.events('w1'), []);
  });
  assert.match(answer ?? '', /CI failed/);
});

test('events at the end of a turn stay when the task asked, waits or moved on', async () => {
  for (const status of ['needs-me', 'waiting', 'todo'] as const) {
    const harness = setup({ exitCode: 0, signal: null }, true);
    let answer: string | undefined = 'unset';
    await runWithDeps(harness, async ({ deps, watch }) => {
      harness.backend.tasks[0]!.status = status;
      spoolEvent(deps, 'ci', '2026-01-01T10:10:00.000Z');
      answer = await watch.onTurnEnd?.();
      assert.equal(deps.watches.events('w1').length, 1, status);
    });
    assert.equal(answer, undefined, status);
  }
});

test('a failing board at the end of a turn ends the run and keeps the events', async () => {
  const harness = setup({ exitCode: 0, signal: null }, true);
  let answer: string | undefined = 'unset';
  await runWithDeps(harness, async ({ deps, watch }) => {
    spoolEvent(deps, 'ci', '2026-01-01T10:10:00.000Z');
    const getTask = harness.backend.getTask.bind(harness.backend);
    harness.backend.getTask = async () => {
      throw new Error('board down');
    };
    answer = await watch.onTurnEnd?.();
    harness.backend.getTask = getTask;
    assert.equal(deps.watches.events('w1').length, 1);
  });
  assert.equal(answer, undefined);
});

// A task that was woken and resumes its session: the watches it holds are kept.
function setupResumed(result: RunResult, moveDuringRun = false) {
  const harness = setup(result, moveDuringRun);
  Object.assign(harness.backend.tasks[0]!, { next: 'resume', sessionId: SESSION, woken: true });
  harness.deps.sessions.record('w1', SESSION);
  return harness;
}

// A run that ended with the task still running and a watch open.
async function endedWatching(overrides: { result?: RunResult; watches?: ReturnType<typeof watchDef>[] } = {}) {
  const harness = setupResumed(overrides.result ?? { exitCode: 0, signal: null });
  for (const def of overrides.watches ?? [watchDef({ ...W1, deadline: '2099-01-01T14:00:00.000Z' })])
    harness.deps.watches.write(def);
  await runWorker(harness.deps, 'w1');
  return harness;
}

test('a run that ended its turn with watches open parks the task until the earliest deadline', async () => {
  const { backend, calls } = await endedWatching({
    watches: [
      commandDef('true', { ...W1, deadline: '2099-01-01T15:00:00.000Z' }),
      timerDef({ ...W1, deadline: '2099-01-01T14:00:00.000Z' }),
    ],
  });
  const wait = backend.writes.find((line) => line.startsWith('wait w1'));
  assert.match(
    wait ?? '',
    /^wait w1 until 2099-01-01T14:00:00.000Z check: Waiting for watches: "health" \(until .*\), "timer" \(until .*\)\.$/,
  );
  assert.ok(!backend.writes.some((line) => line.startsWith('fail ')));
  assert.equal(backend.tasks[0]?.status, 'waiting');
  assert.ok(calls.some((line) => line.includes('waits for its watches')));
});

test('a timer alone parks without the check flag', async () => {
  const { backend } = await endedWatching({ watches: [timerDef({ ...W1, deadline: '2099-01-01T14:00:00.000Z' })] });
  assert.ok(!backend.writes.find((line) => line.startsWith('wait w1'))?.includes(' check'));
});

test('a failed, paused or stopped run does not park, and neither does a task that changed', async () => {
  const failed = await endedWatching({ result: { exitCode: 1, signal: null } });
  assert.ok(failed.backend.writes.some((line) => line.startsWith('fail w1')));
  assert.ok(!failed.backend.writes.some((line) => line.startsWith('wait ')));

  const paused = setupResumed({ exitCode: 0, signal: null });
  paused.deps.watches.write(watchDef({ ...W1 }));
  paused.deps.files.requestPause('w1');
  await runWorker(paused.deps, 'w1');
  assert.ok(paused.backend.writes.some((line) => line.startsWith('pause w1')));
  assert.ok(!paused.backend.writes.some((line) => line.startsWith('wait ')));

  const stopped = setupResumed({ exitCode: 0, signal: null });
  stopped.deps.watches.write(watchDef({ ...W1 }));
  await runWithDeps(stopped, async ({ watch }) => {
    stopped.backend.inboxes.set('w1', { messages: [], stop: true });
    await watch.tick();
    await settle();
  });
  assert.ok(!stopped.backend.writes.some((line) => line.startsWith('wait ')));

  const asked = setupResumed({ exitCode: 0, signal: null }, true);
  asked.deps.watches.write(watchDef({ ...W1 }));
  await runWorker(asked.deps, 'w1');
  assert.ok(!asked.backend.writes.some((line) => line.startsWith('wait ') || line.startsWith('fail ')));
});

test('a refused park is logged, not reported as a failure', async () => {
  const harness = setupResumed({ exitCode: 0, signal: null });
  harness.deps.watches.write(watchDef({ ...W1, deadline: '2099-01-01T14:00:00.000Z' }));
  harness.backend.wait = async () => {
    throw new BackendError('wait: the task is needs-me, not running', 409);
  };
  await runWorker(harness.deps, 'w1');
  assert.ok(harness.calls.some((line) => line.includes('did not park the task')));
  assert.ok(!harness.backend.writes.some((line) => line.startsWith('fail ')));
});

test('an event that arrives after the park decision stays in the spool, and the live marker is gone', async () => {
  const harness = setupResumed({ exitCode: 0, signal: null });
  harness.deps.watches.write(watchDef({ ...W1, deadline: '2099-01-01T14:00:00.000Z' }));
  const wait = harness.backend.wait.bind(harness.backend);
  harness.backend.wait = async (id, request) => {
    spoolEvent(harness.deps, 'ci', '2026-01-01T10:10:00.000Z');
    return wait(id, request);
  };
  await runWorker(harness.deps, 'w1');
  assert.equal(harness.deps.watches.events('w1').length, 1);
  assert.equal(harness.deps.watches.livePid('w1'), undefined);
});

test('a resume starts from the spool: the events are in the prompt, and go at the first output line', async () => {
  const harness = setup({ exitCode: 0, signal: null }, true);
  Object.assign(harness.backend.tasks[0]!, { next: 'resume', sessionId: SESSION, woken: true });
  harness.deps.sessions.record('w1', SESSION);
  harness.backend.notes.set('w1', [
    note(`${WAKE_MARKER} watch "ci" reported.`, new Date('2026-01-01T10:12:00Z'), { author: 'system', kind: 'event' }),
  ]);
  harness.deps.watches.write(timerDef({ ...W1 }));
  const kept = spoolEvent(harness.deps, 'ci', '2026-01-01T10:10:00.000Z', 'CI failed: unit');
  const printed: string[] = [];
  harness.deps.print = (line) => void printed.push(line);
  let prompt = '';
  let onLineSeen: ((line: string) => string | undefined) | undefined;
  let before = 0;
  let after = -1;
  harness.deps.run = async (invocation, _taskId, _env, _watch, onLine) => {
    prompt = invocation.prompt;
    onLineSeen = onLine;
    before = harness.deps.watches.events('w1').length;
    onLine('{"type":"system"}');
    after = harness.deps.watches.events('w1').length;
    return { exitCode: 0, signal: null };
  };
  await runWorker(harness.deps, 'w1');
  assert.ok(onLineSeen !== undefined);
  assert.match(prompt, /<watch-event name="ci" at="2026-01-01T10:10:00.000Z">\nCI failed: unit\n<\/watch-event>/);
  assert.match(prompt, /Still open: "timer"/);
  assert.doesNotMatch(prompt, /Your wait on board task/);
  assert.equal(before, 1, kept);
  assert.equal(after, 0);
  assert.ok(
    printed.some((line) =>
      /resume with watch events: oldest event 2026-01-01T10:10:00.000Z, wake 2026-01-01T10:12:00.000Z, worker start/.test(
        line,
      ),
    ),
  );
  assert.ok(
    printed.some((line) =>
      /first agent output after \d+ ms from worker start, \d+ ms from the oldest event/.test(line),
    ),
  );
  assert.ok(harness.calls.some((line) => line.includes('resume with watch events')));
});

test('the events of the prompt are not sent again by the spool look', async () => {
  const harness = setup({ exitCode: 0, signal: null }, true);
  Object.assign(harness.backend.tasks[0]!, { next: 'resume', sessionId: SESSION, woken: true });
  harness.deps.sessions.record('w1', SESSION);
  spoolEvent(harness.deps, 'ci', '2026-01-01T10:10:00.000Z');
  const { channel } = await runWithDeps(harness, async () => {
    await sleep(40);
  });
  assert.deepEqual(channel.sent, []);
});

test('an event left in the spool after the last watch was claimed still parks the task, not a failure', async () => {
  const harness = setupResumed({ exitCode: 0, signal: null });
  // The unit claimed the only watch and wrote its event while the run ended.
  harness.deps.run = async () => {
    spoolEvent(harness.deps, 'ci', '2026-01-01T10:10:00.000Z');
    return { exitCode: 0, signal: null };
  };
  await runWorker(harness.deps, 'w1');
  assert.ok(!harness.backend.writes.some((line) => line.startsWith('fail ')));
  assert.match(
    harness.backend.writes.find((line) => line.startsWith('wait w1')) ?? '',
    /Waiting for watches: a watch event\./,
  );
  assert.equal(harness.deps.watches.events('w1').length, 1);
});

test('a deadline that has passed parks for at least a minute, and a 400 from the board is logged', async () => {
  const { backend } = await endedWatching({ watches: [timerDef({ ...W1, deadline: '2000-01-01T14:00:00.000Z' })] });
  const wait = backend.writes.find((line) => line.startsWith('wait w1')) ?? '';
  const until = Date.parse(/until (\S+Z)/.exec(wait)?.[1] ?? '');
  assert.ok(until - Date.now() > 50_000, wait);

  const refused = setupResumed({ exitCode: 0, signal: null });
  refused.deps.watches.write(watchDef({ ...W1 }));
  refused.backend.wait = async () => {
    throw new BackendError('wait: wakeAt must be in the future', 400);
  };
  await runWorker(refused.deps, 'w1');
  assert.ok(refused.calls.some((line) => line.includes('did not park the task')));
});

test('events are not handed over once a pause was requested or the task left Running', async () => {
  const paused = setupResumed({ exitCode: 0, signal: null }, true);
  await runWithDeps(paused, async ({ deps, channel, watch }) => {
    deps.files.requestPause('w1');
    spoolEvent(deps, 'ci', '2026-01-01T10:10:00.000Z');
    await sleep(40);
    assert.deepEqual(channel.sent, []);
    assert.equal(await watch.onTurnEnd?.(), undefined);
    assert.equal(deps.watches.events('w1').length, 1);
  });

  const left = setupResumed({ exitCode: 0, signal: null }, true);
  left.backend.runInbox = async () => {
    throw new BackendError('run-inbox: the task is not running', 409);
  };
  await runWithDeps(left, async ({ deps, channel, watch }) => {
    await watch.tick();
    await settle();
    spoolEvent(deps, 'ci', '2026-01-01T10:10:00.000Z');
    await sleep(40);
    assert.deepEqual(channel.sent, []);
    left.backend.tasks[0]!.status = 'running';
    assert.equal(await watch.onTurnEnd?.(), undefined);
    assert.equal(deps.watches.events('w1').length, 1);
  });
});

function titledSetup(writeTitle: WorkerDeps['writeTitle'], result: RunResult = { exitCode: 0, signal: null }) {
  const { deps, backend, calls } = setup(result);
  const subject = backend.tasks[0]!;
  Object.assign(subject, {
    title: '/pj-acme:review https://github.com/acme/app/pull/8',
    input: '/pj-acme:review https://github.com/acme/app/pull/8',
  });
  backend.boardTitleRules.held = { version: 1, rules: [{ pattern: '^/pj-', instruction: 'a title' }] };
  deps.writeTitle = writeTitle;
  return { deps, backend, calls };
}

test('the run starts while the title is still being written, and the worker ends only after it', async () => {
  const order: string[] = [];
  let release: () => void = () => undefined;
  const released = new Promise<void>((done) => (release = done));
  const { deps } = titledSetup(async () => {
    order.push('writer started');
    await released;
    order.push('writer done');
    return { title: 'A title' };
  });
  const run = deps.run;
  deps.run = async (...args) => {
    order.push('run');
    return run(...args);
  };
  let ended = false;
  const worker = runWorker(deps, 'w1').then(() => {
    ended = true;
    order.push('worker ended');
  });
  await settle();
  assert.ok(order.includes('run') && order.includes('writer started'));
  assert.ok(!order.includes('writer done'));
  assert.equal(ended, false);
  release();
  await worker;
  assert.deepEqual(order.slice(-2), ['writer done', 'worker ended']);
});

test('a title writer that rejects leaves the run reported exactly as it is without rules', async () => {
  const plain = setup({ exitCode: 1, signal: null });
  await runWorker(plain.deps, 'w1');
  const titled = titledSetup(
    async () => {
      throw new Error('boom');
    },
    { exitCode: 1, signal: null },
  );
  await runWorker(titled.deps, 'w1');
  assert.deepEqual(titled.backend.writes, plain.backend.writes);
  assert.ok(titled.calls.some((call) => call.includes('title rules failed: boom')));
});
