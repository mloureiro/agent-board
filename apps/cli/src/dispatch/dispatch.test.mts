import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { limitTick, runDispatch } from './dispatch.mts';
import type { DispatchDeps } from './dispatch.mts';
import { BackendError } from '../backend/backend.mts';
import type { Fetch } from '../backend/backend.mts';
import { createWebBackend } from '../backend/web-backend.mts';
import { API_VERSION, MIN_SERVER } from '@agent-board/shared';
import type { TaskWatch } from '@agent-board/shared';
import { RETRY_AFTER_FAILURE_MS, RETRY_AFTER_UNPUBLISHED_MS } from '../self/auto-update.mts';
import type { UpdateDeps } from '../self/auto-update.mts';
import type { AutoUpdate, Config } from '../config/config.mts';
import { loadConfig } from '../config/config.mts';
import { parseWorkerUnits, SystemError } from '../setup/system.mts';
import type { System } from '../setup/system.mts';
import { START_MARKER } from '../task-rules.mts';
import {
  CONFIG,
  DATA_KEY,
  fakeBackend,
  fakeCatalogStore,
  fakeRunFiles,
  fakeTaskFiles,
  fakeWorktreeLocks,
  fakeUpdateState,
  fakeWaitStore,
  task,
} from '../__tests__/helpers/fakes.mts';
import type { CheckResult, WaitCheck } from './waits.mts';
import { TASK_FILES_KEEP_MS } from './dispatch.mts';
import type { TaskFile } from './task-files.mts';
import type { FakeBackend } from '../__tests__/helpers/fakes.mts';
import type { ProbeResult } from '../catalog/probe.mts';
import { GitHubError } from './github.mts';
import type { GitHub } from './github.mts';
import { createPrRefreshState, PR_REFRESH_INTERVAL_MS, prRefreshFile } from './pr-states.mts';
import type { PrRefreshState } from './pr-states.mts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createWatchStore } from '../watch/store.mts';
import type { WatchEvent } from '../watch/store.mts';
import { commandDef, commandResult, timerDef } from '../__tests__/helpers/watch.mts';
import { HEARTBEAT_STALE_MS } from '../watch/tick.mts';
import type { WatchRunner } from '../watch/attempt.mts';
import { join } from 'node:path';

const NOW = new Date('2026-01-01T12:00:00Z');

const watchDirs: string[] = [];
after(() => {
  for (const dir of watchDirs) rmSync(dir, { recursive: true, force: true });
});

function fakePrRefreshState(at?: Date): PrRefreshState & { at: Date | undefined } {
  const state = {
    at,
    refreshedAt: () => state.at,
    markRefreshed: (when: Date) => {
      state.at = when;
    },
  };
  return state;
}

function setup(
  tasks: ReturnType<typeof task>[],
  active: string[] = [],
  unitStarts: Record<string, Date> = {},
  {
    checks = {},
    checkResult,
    watchRun,
    alive = [],
    taskFiles: initialFiles = [],
    locks = {},
    ...updating
  }: {
    checks?: Record<string, WaitCheck>;
    taskFiles?: TaskFile[];
    locks?: Record<string, string[]>;
    checkResult?: (check: WaitCheck) => CheckResult;
    // What a watch's command or gh call answers; the default is a failing command.
    watchRun?: WatchRunner;
    // Pids that exist.
    alive?: number[];
    autoUpdate?: AutoUpdate;
    advertised?: string;
    compiled?: boolean;
    retryAfter?: Date;
    fails?: string;
    warnings?: string[];
  } = {},
) {
  const backend: FakeBackend = fakeBackend(tasks);
  const waits = fakeWaitStore(checks);
  const ranChecks: string[] = [];
  const files = fakeRunFiles(() => NOW);
  const started: string[] = [];
  const stopped: string[] = [];
  const logs: string[] = [];
  const system: System = {
    async isActive(unit) {
      return active.includes(unit);
    },
    async startedAt(unit) {
      return unitStarts[unit];
    },
    async activeWorkers() {
      return active.map((unit) => unit.replace('agent-board-', ''));
    },
    async stop(unit) {
      stopped.push(unit);
    },
    async signalWorker() {},
    async startWorker(shortLink) {
      started.push(shortLink);
      return { pid: 42 };
    },
  };
  const updates: string[] = [];
  const state = fakeUpdateState({ deferred: updating.retryAfter });
  const update: UpdateDeps = {
    compiled: updating.compiled ?? true,
    version: '0.5.0',
    advertised: () => updating.advertised,
    state,
    update: async () => {
      updates.push('self-update');
      if (updating.fails !== undefined) throw new SystemError(updating.fails);
      return 'updated';
    },
  };
  const taskFiles = fakeTaskFiles(initialFiles);
  const worktreeLocks = fakeWorktreeLocks(locks);
  const watchDir = mkdtempSync('/tmp/board-dispatch-watches-');
  watchDirs.push(watchDir);
  const watches = createWatchStore(watchDir);
  const ranWatches: string[] = [];
  const deps: DispatchDeps = {
    backend,
    config: { ...CONFIG, autoUpdate: updating.autoUpdate ?? 'incompatible' },
    dryRun: false,
    print: (line) => logs.push(line),
    system,
    files,
    now: () => NOW,
    logTail: () => 'last log line',
    waits,
    taskFiles,
    worktreeLocks,
    watches,
    runWatch: async (job) => {
      ranWatches.push(job.command);
      return (
        (await watchRun?.(job)) ?? { exitCode: 1, timedOut: false, output: 'pending', stdout: '', stderr: 'pending' }
      );
    },
    isAlive: (pid) => alive.includes(pid),
    runCheck: async (check) => {
      ranChecks.push(check.command);
      return checkResult?.(check) ?? { exitCode: 1, timedOut: false, output: 'pending' };
    },
    update,
    configWarnings: () => updating.warnings ?? [],
    prRefresh: { github: undefined, state: fakePrRefreshState() },
  };
  return {
    backend,
    deps,
    started,
    stopped,
    logs,
    files,
    waits,
    taskFiles,
    worktreeLocks,
    ranChecks,
    updates,
    state,
    watches,
    ranWatches,
  };
}

const running = (id: string) => task({ id, status: 'running', input: '/selftest go' });
const todo = (id: string) => task({ id, input: '/selftest go' });

test('starts from the top of Todo up to the cap', async () => {
  const { deps, started, backend } = setup([running('r1'), todo('t1'), todo('t2'), todo('t3')], ['agent-board-r1']);
  await runDispatch(deps);
  assert.deepEqual(started, ['t1']);
  assert.ok(backend.writes.includes('claim t1 by here'));
  assert.ok(
    backend.writes.some((w) => w.startsWith('note t1 (system)') && w.includes(START_MARKER) && w.includes('pid 42')),
  );
});

test('every tick starts with one WARN line per unknown config key', async () => {
  const { deps, logs, started } = setup([todo('t1')], [], {}, { warnings: ['unknown key "lane", ignored'] });
  await runDispatch(deps);
  assert.equal(logs[0], 'WARN config.json: unknown key "lane", ignored');
  assert.deepEqual(started, ['t1']);
});

test('with all slots taken nothing starts', async () => {
  const { deps, started } = setup([running('r1'), running('r2'), todo('t1')], ['agent-board-r1', 'agent-board-r2']);
  await runDispatch(deps);
  assert.deepEqual(started, []);
});

test('a task this machine cannot serve is left in Todo for another machine', async () => {
  const pinned = task({ id: 'pinned', input: '/selftest go', next: 'resume', sessionId: 's', machine: 'there' });
  const elsewhere = task({ id: 'elsewhere', input: 'Find out X', machine: 'there', workdir: '/x' });
  const { deps, started, backend, logs } = setup([pinned, elsewhere, todo('t1')]);
  await runDispatch(deps);
  assert.deepEqual(started, ['t1']);
  assert.ok(!backend.writes.some((w) => w.includes('pinned') || w.includes('elsewhere')));
  assert.ok(logs.some((line) => line.startsWith('SKIP pinned pinned to there')));
  assert.ok(logs.some((line) => line.startsWith('SKIP elsewhere pinned to there')));
});

test('a task that names an agent this machine does not define is skipped, and one it defines is started', async () => {
  const ghost = task({ id: 'ghost', input: 'Review it', agent: 'ghost' });
  const known = task({ id: 'known', input: 'Review it', agent: 'reviewer' });
  const { deps, started, backend, logs } = setup([ghost, known]);
  deps.config = {
    ...CONFIG,
    agents: {
      reviewer: { description: 'd', tools: ['Read'], allowedTools: [], disallowedTools: [], env: [], mcpServers: [] },
    },
  };
  await runDispatch(deps);
  assert.deepEqual(started, ['known']);
  assert.ok(!backend.writes.some((w) => w.includes('ghost')), 'left in Todo, not claimed or failed');
  assert.ok(logs.includes('SKIP ghost no agent ghost defined here'));
});

test('a newer version of the board’s agents is applied before the starts, so a task that names a pushed agent starts in the same tick', async (context) => {
  const dir = mkdtempSync('/tmp/board-dispatch-agents-');
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, '{"machine":"here"}\n');
  const pushed = task({ id: 'pushed', input: 'Review it', agent: 'reviewer' });
  const { deps, started, backend, logs } = setup([pushed]);
  const reviewer = { description: 'd', tools: ['Read'] };
  backend.boardAgents.held = { version: 7, document: { version: 7, agents: { reviewer } } };
  deps.sharedAgents = { configFile, reload: () => ({ ...CONFIG, ...pick(loadConfig(configFile)) }) };
  await runDispatch(deps);
  assert.ok(logs.includes('APPLIED agents v7: 1 agent(s)'));
  assert.deepEqual(started, ['pushed']);
  await runDispatch(deps);
  assert.equal(logs.filter((line) => line.startsWith('APPLIED')).length, 1, 'the same version is not fetched again');
});

// The agents of the config the apply wrote, over the test's config.
const pick = ({ agents, agentErrors, board }: Config) => ({
  agents,
  agentErrors,
  ...(board === undefined ? {} : { board }),
});

test('a task pinned here that names a missing agent is claimed, so its worker can fail it', async () => {
  const pinned = task({ id: 'pin', input: 'Review it', agent: 'ghost', machine: 'here', workdir: '/x' });
  const { deps, started, logs } = setup([pinned]);
  await runDispatch(deps);
  assert.deepEqual(started, ['pin']);
  assert.ok(!logs.some((line) => line.startsWith('SKIP pin')));
});

test('an agent that cannot be read is logged as a warning every tick, and the rest of the machine works', async () => {
  const { deps, started, logs } = setup([todo('t1'), task({ id: 'bad', input: 'x', agent: 'broken' })]);
  deps.config = { ...CONFIG, agentErrors: { broken: 'config: agents.broken has no key "tool"' } };
  await runDispatch(deps);
  assert.deepEqual(started, ['t1']);
  assert.ok(logs.some((line) => line.startsWith('WARN config.json: config: agents.broken has no key "tool"')));
  assert.ok(logs.some((line) => line.startsWith('SKIP bad agent broken here cannot be used')));
});

test('a task of the removed intake without an agent is claimed and started, so that its worker fails it', async () => {
  const review = task({
    id: 'rev',
    input: '/review-pr https://github.com/cosuno/cosuno/pull/1 --auto',
    createdBy: 'intake',
  });
  const { deps, started, logs } = setup([review]);
  await runDispatch(deps);
  assert.deepEqual(started, ['rev']);
  assert.ok(!logs.some((line) => line.startsWith('SKIP rev')));
});

test('a claim lost to another machine starts nothing and the next task gets the slot', async () => {
  const { deps, started, backend } = setup([todo('t1'), todo('t2'), todo('t3')]);
  backend.lostClaims.push('t1');
  await runDispatch(deps);
  assert.deepEqual(started, ['t2', 't3']);
});

test("another machine's running task is not swept here", async () => {
  const theirs = task({ id: 'theirs', status: 'running', input: '/selftest go', machine: 'there' });
  const { deps, backend } = setup([theirs]);
  await runDispatch(deps);
  assert.deepEqual(
    backend.writes.filter((write) => !write.startsWith('usage ')),
    [],
  );
});

test('a stale Running task goes to Needs me with the log tail and frees its slot', async () => {
  const { deps, started, backend } = setup([running('dead'), todo('t1')]);
  await runDispatch(deps);
  assert.ok(backend.writes.some((w) => w.startsWith('fail dead:') && w.includes('last log line')));
  assert.ok(backend.writes.some((w) => w.startsWith('fail dead:')));
  assert.deepEqual(started, ['t1']);
});

test('a timed-out active worker is stopped, then reported', async () => {
  const slow = task({
    id: 'slow',
    status: 'running',
    input: '/selftest go',
    runStartedAt: new Date(NOW.getTime() - 7 * 60 * 60_000),
  });
  const { deps, backend, stopped } = setup([slow], ['agent-board-slow']);
  await runDispatch(deps);
  assert.deepEqual(stopped, ['agent-board-slow']);
  assert.ok(backend.writes.some((w) => w.startsWith('fail slow:')));
});

test('a failed start sends the task to Needs me and stops filling slots', async () => {
  const { deps, backend } = setup([todo('t1'), todo('t2')]);
  let calls = 0;
  deps.system = {
    ...deps.system,
    async startWorker() {
      calls++;
      if (calls === 1) throw new Error('unit exists');
      return { pid: undefined };
    },
  };
  await runDispatch(deps);
  assert.equal(calls, 1, 'no further task is started after a failure');
  assert.ok(backend.writes.some((w) => w.includes('could not be started: unit exists')));
});

test('a failed start comment does not send the running task to Needs me', async () => {
  const { deps, backend, started } = setup([todo('t1')]);
  const addNote = backend.addNote.bind(backend);
  backend.addNote = async (id, text) => {
    if (text.startsWith(START_MARKER)) throw new Error('backend down');
    return addNote(id, text);
  };
  await runDispatch(deps);
  assert.deepEqual(started, ['t1']);
  assert.ok(!backend.writes.some((w) => w.includes('needs-me')));
});

test('unknown systemd state starts nothing and changes nothing', async () => {
  const { deps, backend, started } = setup([running('r1'), todo('t1')]);
  deps.system = {
    ...deps.system,
    async isActive() {
      throw new SystemError('bus unreachable');
    },
  };
  await assert.rejects(runDispatch(deps), SystemError);
  assert.deepEqual(started, []);
  assert.deepEqual(backend.writes, []);
});

test("the run is timed from its unit first, and from the task's claim without one", async () => {
  const again = task({
    id: 'again',
    status: 'running',
    input: '/selftest go',
    runStartedAt: new Date(NOW.getTime() - 7 * 60 * 60_000),
  });
  const { deps, backend, stopped } = setup([again], ['agent-board-again'], {
    'agent-board-again': new Date(NOW.getTime() - 5 * 60_000),
  });
  await runDispatch(deps);
  assert.deepEqual(stopped, []);
  assert.deepEqual(
    backend.writes.filter((write) => !write.startsWith('usage ')),
    [],
  );
});

test('the cap counts active units even when fewer tasks sit in Running', async () => {
  const { deps, started } = setup([running('r1'), todo('t1')], ['agent-board-r1', 'agent-board-orphan']);
  await runDispatch(deps);
  assert.deepEqual(started, []);
});

test('a failed listing starts nothing and changes nothing', async () => {
  const { deps, backend, started } = setup([running('r1'), todo('t1')]);
  backend.listTasks = async () => {
    throw new Error('backend list-tasks failed');
  };
  await assert.rejects(runDispatch(deps), /list-tasks failed/);
  assert.deepEqual(started, []);
  assert.deepEqual(backend.writes, []);
});

const LANED = {
  ...CONFIG,
  lanes: [
    { name: 'reviews', slots: 1, default: true },
    { name: 'implement', slots: 1, default: false },
  ],
};
const review = (id: string) => task({ id, input: '/selftest go', requestedLane: 'reviews' });
const impl = (id: string) => task({ id, input: '/implement it', requestedLane: 'implement' });

test('each lane takes its own work, an idle lane borrows, and the lane is written before the unit starts', async () => {
  const { deps, started, files, logs, backend } = setup([review('r1'), review('r2'), review('r3')]);
  deps.config = LANED;
  await runDispatch(deps);
  assert.deepEqual(started, ['r1', 'r2']);
  assert.deepEqual(files.runs.get('r1'), { lane: 'reviews', borrowed: false, startedAt: NOW });
  assert.deepEqual(files.runs.get('r2'), { lane: 'implement', borrowed: true, startedAt: NOW });
  assert.ok(logs.includes('TICK started=2 reviews=1/1 implement=1/1'));
  assert.ok(backend.writes.some((w) => w.startsWith('note r2 (system)') && w.includes('implement lane, borrowed')));
});

test('a task without a lane runs in the default lane, and one asking for a lane this machine lacks says so', async () => {
  const plain = task({ id: 'p1', input: 'do it' });
  const lost = task({ id: 'l1', input: 'do it', requestedLane: 'nowhere' });
  const { deps, files, backend, logs } = setup([plain, lost]);
  deps.config = LANED;
  await runDispatch(deps);
  assert.deepEqual(files.runs.get('p1'), { lane: 'reviews', borrowed: false, startedAt: NOW });
  assert.deepEqual(files.runs.get('l1'), { lane: 'implement', borrowed: true, startedAt: NOW });
  assert.ok(logs.some((line) => line.startsWith('STARTED p1') && !line.includes('no such lane')));
  assert.ok(
    logs.some((line) => line.startsWith('STARTED l1') && line.includes('lane nowhere → reviews (no such lane here)')),
  );
  assert.ok(
    backend.writes.some(
      (w) => w.startsWith('note l1 (system)') && w.includes('lane nowhere → reviews (no such lane here)'),
    ),
  );
});

test('a lane whose own work waits asks its borrowed run to pause, once, after five minutes', async () => {
  const borrowed = task({ id: 'b1', status: 'running', input: '/selftest go', machine: 'here' });
  const { deps, files, logs } = setup([borrowed, review('r0'), impl('i1')], ['agent-board-b1', 'agent-board-r0x']);
  deps.config = LANED;
  files.runs.set('b1', { lane: 'implement', borrowed: true, startedAt: new Date(NOW.getTime() - 6 * 60_000) });
  files.runs.set('r0x', { lane: 'reviews', borrowed: false, startedAt: NOW });
  files.alive.set('b1', NOW);
  await runDispatch(deps);
  assert.ok(files.pauses.has('b1'));
  assert.ok(logs.some((line) => line.startsWith('PAUSE b1 lane=implement')));
  logs.length = 0;
  await runDispatch(deps);
  assert.ok(!logs.some((line) => line.startsWith('PAUSE')), 'a pending pause is not asked again');
});

test('a young borrowed run is not paused yet', async () => {
  const borrowed = task({ id: 'b1', status: 'running', input: '/selftest go', machine: 'here' });
  const { deps, files } = setup([borrowed, impl('i1')], ['agent-board-b1']);
  deps.config = { ...LANED, lanes: [{ name: 'implement', slots: 1, default: true }] };
  files.runs.set('b1', { lane: 'implement', borrowed: true, startedAt: new Date(NOW.getTime() - 2 * 60_000) });
  files.alive.set('b1', NOW);
  await runDispatch(deps);
  assert.equal(files.pauses.size, 0);
});

test('dry run plans pauses and starts but writes no run files', async () => {
  const borrowed = task({ id: 'b1', status: 'running', input: '/selftest go', machine: 'here' });
  const { deps, files, logs } = setup([borrowed, impl('i1'), review('r1')], ['agent-board-b1']);
  deps.config = LANED;
  deps.dryRun = true;
  files.runs.set('b1', { lane: 'implement', borrowed: true, startedAt: new Date(NOW.getTime() - 10 * 60_000) });
  files.alive.set('b1', NOW);
  await runDispatch(deps);
  assert.ok(logs.some((line) => line.startsWith('PAUSE b1')));
  assert.equal(files.pauses.size, 0);
  assert.ok(!files.runs.has('r1'));
});

test('a running task whose agent went quiet is stopped and reported by the sweep', async () => {
  const quiet = task({ id: 'q', status: 'running', input: '/selftest go', machine: 'here' });
  const { deps, files, stopped, backend } = setup([quiet], ['agent-board-q'], {
    'agent-board-q': new Date(NOW.getTime() - 60 * 60_000),
  });
  files.alive.set('q', new Date(NOW.getTime() - 25 * 60_000));
  await runDispatch(deps);
  assert.deepEqual(stopped, ['agent-board-q']);
  assert.ok(backend.writes.some((w) => w.includes('no tool call for 25 minutes')));
});

test('after a gap between ticks (a sleep) a quiet run is left alone, and the tick is marked', async () => {
  const quiet = task({ id: 'q', status: 'running', input: '/selftest go', machine: 'here' });
  const { deps, files, stopped, backend, logs } = setup([quiet], ['agent-board-q'], {
    'agent-board-q': new Date(NOW.getTime() - 5 * 60 * 60_000),
  });
  files.alive.set('q', new Date(NOW.getTime() - 3 * 60 * 60_000));
  files.dispatchTick = new Date(NOW.getTime() - 3 * 60 * 60_000);
  await runDispatch(deps);
  assert.deepEqual(stopped, []);
  assert.ok(!backend.writes.some((w) => w.startsWith('fail q:')));
  assert.ok(logs.some((line) => line.startsWith('NOTE no tick for 180 minutes')));
  assert.equal(files.dispatchTick?.getTime(), NOW.getTime());
  // The next tick has no gap, and a run that is still quiet is swept.
  await runDispatch(deps);
  assert.deepEqual(stopped, ['agent-board-q']);
});

test('the first tick, or one two minutes after the last, sweeps a quiet run as always', async () => {
  for (const last of [undefined, new Date(NOW.getTime() - 2 * 60_000)]) {
    const quiet = task({ id: 'q', status: 'running', input: '/selftest go', machine: 'here' });
    const { deps, files, stopped } = setup([quiet], ['agent-board-q'], {
      'agent-board-q': new Date(NOW.getTime() - 5 * 60 * 60_000),
    });
    files.alive.set('q', new Date(NOW.getTime() - 3 * 60 * 60_000));
    files.dispatchTick = last;
    await runDispatch(deps);
    assert.deepEqual(stopped, ['agent-board-q']);
  }
});

test('a dry run does not mark the tick', async () => {
  const { deps, files } = setup([]);
  deps.dryRun = true;
  await runDispatch(deps);
  assert.equal(files.dispatchTick, undefined);
});

test('the in-process time limit calls its handler once the limit is up, and not when cancelled', async () => {
  let fired = 0;
  const cancel = limitTick(20, () => void (fired += 1));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fired, 1);
  const cancelled = limitTick(20, () => void (fired += 1));
  cancelled();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fired, 1);
  cancel();
});

test('a todo task whose last worker is still stopping is not started again', async () => {
  const { deps, started, backend, logs } = setup([todo('t1'), todo('t2')], ['agent-board-t1']);
  await runDispatch(deps);
  assert.deepEqual(started, ['t2']);
  assert.ok(logs.includes('SKIP t1 its last worker is still stopping'));
  assert.ok(!backend.writes.some((w) => w.includes('t1')));
});

test('a task that is not due yet is left alone: no claim, no log line', async () => {
  const waiting = task({ id: 'w1', input: '/selftest go', notBefore: new Date(NOW.getTime() + 60_000) });
  const due = task({ id: 'd1', input: '/selftest go', notBefore: new Date(NOW.getTime() - 60_000) });
  const waitingThere = task({
    id: 'w2',
    input: '/selftest go',
    machine: 'there',
    workdir: '/x',
    notBefore: new Date(NOW.getTime() + 60_000),
  });
  const { deps, started, backend, logs } = setup([waiting, waitingThere, due, todo('t1')]);
  await runDispatch(deps);
  assert.deepEqual(started, ['d1', 't1']);
  assert.ok(!backend.writes.some((w) => w.includes('w1')));
  assert.ok(!logs.some((line) => line.includes('w1') || line.includes('w2')));
});

test('a task its schedule holds for a free slot is left alone: no claim, no log line, the others start', async () => {
  const held = task({ id: 'h1', input: '/selftest go', scheduleId: 'sch', held: true });
  const { deps, started, backend, logs } = setup([held, todo('t1')]);
  await runDispatch(deps);
  assert.deepEqual(started, ['t1']);
  assert.ok(!backend.writes.some((w) => w.includes('h1')));
  assert.ok(!logs.some((line) => line.includes('h1')));
});

test('a task whose prompt or directory cannot be decrypted is never claimed or started; an unreadable title alone is fine', async () => {
  const { deps, started, backend, logs } = setup([
    task({ id: 'u1', input: '', unreadable: ['input'] }),
    task({ id: 'u2', input: '/selftest go', unreadable: ['workdir'] }),
    task({ id: 'u3', input: '/selftest go', unreadable: ['title'] }),
  ]);
  await runDispatch(deps);
  assert.deepEqual(started, ['u3']);
  assert.ok(!backend.writes.some((w) => w.startsWith('claim u1') || w.startsWith('claim u2')));
  assert.ok(logs.includes('SKIP u1 cannot decrypt its input'));
  assert.ok(logs.includes('SKIP u2 cannot decrypt its workdir'));
});

test('a task that still names an agent as its creator is never started, whatever status the board shows (unstarted proposal)', async () => {
  const proposal = task({ id: 'prop', input: 'rm -rf the world', createdBy: 'agent' });
  const { deps, started, backend, logs } = setup([proposal, todo('t1')]);
  await runDispatch(deps);
  assert.deepEqual(started, ['t1']);
  assert.ok(!backend.writes.some((w) => w.includes('claim prop')));
  assert.ok(logs.some((line) => line.startsWith('SKIP prop proposed by an agent')));
});

const MIN = 60_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const waitingTask = (id: string, overrides: Partial<ReturnType<typeof task>> = {}) =>
  task({
    id,
    status: 'waiting',
    machine: 'here',
    sessionId: '11111111-2222-3333-4444-555555555555',
    input: '/selftest go',
    ...overrides,
  });
const check = (overrides: Partial<WaitCheck> = {}): WaitCheck => ({
  command: 'gh pr checks 1',
  cwd: '/work/cosuno',
  everyMs: 2 * MIN,
  createdAt: at(-10 * MIN),
  ...overrides,
});

test('a timer whose time is up wakes the task, which starts in the same tick', async () => {
  const { deps, backend, started } = setup([waitingTask('w1', { wakeAt: at(-MIN) })]);
  await runDispatch(deps);
  assert.ok(backend.writes.some((w) => w.startsWith('wake w1: agent-board: wait over: its time ran out.')));
  assert.deepEqual(started, ['w1']);
});

test('a timer that still runs, or a wait on another machine, is left alone', async () => {
  const { deps, backend, ranChecks } = setup([
    waitingTask('w1', { wakeAt: at(MIN) }),
    waitingTask('w2', { wakeAt: at(-MIN), machine: 'other' }),
  ]);
  await runDispatch(deps);
  assert.equal(backend.writes.filter((w) => w.startsWith('wake')).length, 0);
  assert.deepEqual(ranChecks, []);
});

test('a due check that passes wakes the task with the end of its output', async () => {
  const { deps, backend, waits, ranChecks } = setup(
    [waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check() }, checkResult: () => ({ exitCode: 0, timedOut: false, output: 'all green\n' }) },
  );
  await runDispatch(deps);
  assert.deepEqual(ranChecks, ['gh pr checks 1']);
  const wake = backend.writes.find((w) => w.startsWith('wake w1:'));
  assert.ok(wake?.includes('its check passed.') && wake.includes('all green'), wake);
  assert.equal(waits.read('w1'), undefined);
});

test('a check that fails is kept with its result, and not run again before --every', async () => {
  const first = setup(
    [waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check() } },
  );
  await runDispatch(first.deps);
  const kept = first.waits.read('w1');
  assert.equal(kept?.lastExit, 1);
  assert.equal(kept?.lastOutput, 'pending');
  assert.equal(kept?.lastCheckAt?.getTime(), NOW.getTime());
  assert.equal(first.backend.writes.filter((w) => w.startsWith('wake')).length, 0);

  const second = setup(
    [waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check({ lastCheckAt: at(-MIN) }) } },
  );
  await runDispatch(second.deps);
  assert.deepEqual(second.ranChecks, []);
});

test('a check past its timeout wakes the task with what its last attempt said', async () => {
  const { deps, backend, ranChecks } = setup(
    [waitingTask('w1', { wakeAt: at(-MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check({ lastCheckAt: at(-2 * MIN), lastExit: 8, lastOutput: 'still running' }) } },
  );
  await runDispatch(deps);
  assert.deepEqual(ranChecks, []);
  const wake = backend.writes.find((w) => w.startsWith('wake w1:'));
  assert.ok(wake?.includes('did not pass before its timeout') && wake.includes('exit code 8'), wake);
  assert.ok(wake?.includes('still running'));
});

test('checks wait for the next tick when the tick has too little time left for them', async () => {
  let now = NOW;
  const { deps, ranChecks, logs } = setup(
    [waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check() } },
  );
  // The board was slow: listing took a minute.
  const listTasks = deps.backend.listTasks.bind(deps.backend);
  deps.backend.listTasks = async (options) => {
    const tasks = await listTasks(options);
    now = at(MIN);
    return tasks;
  };
  await runDispatch({ ...deps, now: () => now });
  assert.deepEqual(ranChecks, []);
  assert.ok(logs.some((line) => line.startsWith('DEFER-CHECKS 1')));
});

test('the next due time is the first delayed Todo task this machine could serve', async () => {
  const later = task({ id: 'w1', input: '/selftest go', notBefore: at(10 * MIN) });
  const sooner = task({ id: 'w2', input: '/selftest go', notBefore: at(3 * MIN) });
  const elsewhere = task({ id: 'w3', input: '/selftest go', machine: 'there', workdir: '/x', notBefore: at(MIN) });
  const proposal = task({ id: 'w4', input: 'x', createdBy: 'agent', notBefore: at(MIN) });
  const { deps, files, logs } = setup([later, sooner, elsewhere, proposal]);
  await runDispatch(deps);
  assert.equal(files.next?.getTime(), at(3 * MIN).getTime());
  assert.ok(logs.includes(`TICK started=0 general=0/2 next=${at(3 * MIN).toISOString()}`), logs.join('\n'));
});

test('the next due time counts the end of a wait here, not one on another machine', async () => {
  const { deps, files } = setup([
    waitingTask('w1', { wakeAt: at(10 * MIN) }),
    waitingTask('w2', { wakeAt: at(MIN), machine: 'other' }),
  ]);
  await runDispatch(deps);
  assert.equal(files.next?.getTime(), at(10 * MIN).getTime());
});

test('a check that failed is due again --every after it ran', async () => {
  const { deps, files } = setup(
    [waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check({ everyMs: 5 * MIN }) } },
  );
  await runDispatch(deps);
  assert.equal(files.next?.getTime(), at(5 * MIN).getTime());
});

test('a check not due yet counts from its last attempt; one that passed counts no more', async () => {
  const waiting = setup(
    [waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check({ lastCheckAt: at(-MIN) }) } },
  );
  await runDispatch(waiting.deps);
  assert.equal(waiting.files.next?.getTime(), at(MIN).getTime());

  const passed = setup(
    [waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })],
    [],
    {},
    { checks: { w1: check() }, checkResult: () => ({ exitCode: 0, timedOut: false, output: '' }) },
  );
  await runDispatch(passed.deps);
  assert.equal(passed.files.next, undefined);
});

test('a borrowed run counts the moment it may be paused, while its lane has own work waiting', async () => {
  const borrowed = task({ id: 'b1', status: 'running', input: '/selftest go', machine: 'here' });
  const { deps, files } = setup([borrowed, impl('i1')], ['agent-board-b1']);
  deps.config = { ...LANED, lanes: [{ name: 'implement', slots: 1, default: true }] };
  files.runs.set('b1', { lane: 'implement', borrowed: true, startedAt: at(-2 * MIN) });
  files.alive.set('b1', NOW);
  await runDispatch(deps);
  assert.equal(files.pauses.size, 0);
  assert.equal(files.next?.getTime(), at(3 * MIN).getTime());
});

test('a borrowed run paused in this tick, or one whose lane has nothing waiting, counts nothing', async () => {
  const borrowed = task({ id: 'b1', status: 'running', input: '/selftest go', machine: 'here' });
  const young = task({ id: 'b2', status: 'running', input: '/selftest go', machine: 'here' });
  const { deps, files } = setup([borrowed, young, impl('i1')], ['agent-board-b1', 'agent-board-b2']);
  deps.config = { ...LANED, lanes: [{ name: 'implement', slots: 2, default: true }] };
  files.runs.set('b1', { lane: 'implement', borrowed: true, startedAt: at(-6 * MIN) });
  files.runs.set('b2', { lane: 'implement', borrowed: true, startedAt: at(-MIN) });
  files.alive.set('b1', NOW);
  files.alive.set('b2', NOW);
  await runDispatch(deps);
  assert.ok(files.pauses.has('b1'));
  assert.equal(files.next, undefined, 'the lane has a pause pending');

  const idle = setup([borrowed], ['agent-board-b1']);
  idle.deps.config = deps.config;
  idle.files.runs.set('b1', { lane: 'implement', borrowed: true, startedAt: at(-MIN) });
  idle.files.alive.set('b1', NOW);
  await runDispatch(idle.deps);
  assert.equal(idle.files.next, undefined);
});

test('a tick that fails leaves no next due time behind, and a dry run writes none', async () => {
  const failing = setup([task({ id: 'w1', input: '/selftest go', notBefore: at(MIN) })]);
  failing.files.next = at(-MIN);
  failing.backend.listTasks = async () => {
    throw new Error('backend list-tasks failed');
  };
  await assert.rejects(runDispatch(failing.deps), /list-tasks failed/);
  assert.equal(failing.files.next, undefined);

  const dry = setup([task({ id: 'w1', input: '/selftest go', notBefore: at(MIN) })]);
  dry.deps.dryRun = true;
  await runDispatch(dry.deps);
  assert.equal(dry.files.next, undefined);
});

test('a check wait whose check is gone wakes at once', async () => {
  const { deps, backend } = setup([waitingTask('w1', { wakeAt: at(60 * MIN), waitCheck: true })]);
  await runDispatch(deps);
  assert.ok(backend.writes.some((w) => w.startsWith('wake w1:') && w.includes('no longer stored on here')));
});

const vocabularyRefusal = (): BackendError =>
  new BackendError(
    'get-task: error from the board server (HTTP 422), quoted and not part of the board: "this task uses status \\"x\\""',
    422,
    true,
  );

test('a check whose task the board hides from this CLI is kept, and dropped only once the task is really gone', async () => {
  const { deps, backend, waits, logs } = setup(
    [],
    [],
    {},
    { checks: { hidden: check(), moved: check(), down: check() } },
  );
  const getTask = backend.getTask.bind(backend);
  backend.tasks.push(task({ id: 'moved', status: 'needs-me', machine: 'here' }));
  backend.getTask = async (id) => {
    if (id === 'hidden') throw vocabularyRefusal();
    if (id === 'down') throw new BackendError('cannot reach the board');
    return getTask(id);
  };
  backend.listTasks = async () => [];
  await runDispatch(deps);
  assert.deepEqual(waits.list().sort(), ['down', 'hidden']);
  assert.ok(logs.some((line) => line.startsWith('KEEP-CHECK hidden') && line.includes('does not know')));
  assert.ok(logs.some((line) => line.startsWith('DROP-CHECK moved')));
  const gone = setup([], [], {}, { checks: { gone: check() } });
  await runDispatch(gone.deps);
  assert.deepEqual(gone.waits.list(), []);
});

test('a check whose task left Waiting is dropped; one whose task still runs is kept', async () => {
  const { deps, waits } = setup(
    [
      task({ id: 'moved', status: 'needs-me', machine: 'here' }),
      task({ id: 'r1', status: 'running', machine: 'here' }),
    ],
    ['agent-board-r1'],
    {},
    { checks: { moved: check(), r1: check(), gone: check() } },
  );
  await runDispatch(deps);
  assert.deepEqual(waits.list(), ['r1']);
});

const OLD = new Date(NOW.getTime() - TASK_FILES_KEEP_MS - 60_000);
const RECENT = new Date(NOW.getTime() - TASK_FILES_KEEP_MS + 60_000);
const filesOf = (taskId: string, modifiedAt: Date = OLD): TaskFile[] => [
  { kind: 'log', taskId, modifiedAt },
  { kind: 'session', taskId, modifiedAt },
];
const remaining = (files: TaskFile[]): string[] => files.map((file) => `${file.kind} ${file.taskId}`).sort();

test('old logs and session records of done, closed and deleted tasks are dropped; recent ones stay', async () => {
  const { deps, taskFiles, logs } = setup(
    [
      task({ id: 'done', status: 'done' }),
      task({ id: 'closed', status: 'needs-me', closed: true }),
      task({ id: 'fresh', status: 'done' }),
    ],
    [],
    {},
    { taskFiles: [...filesOf('done'), ...filesOf('closed'), ...filesOf('deleted'), ...filesOf('fresh', RECENT)] },
  );
  await runDispatch(deps);
  assert.deepEqual(remaining(taskFiles.files), ['log fresh', 'session fresh']);
  assert.ok(logs.includes('DROP-LOG done its task is finished'));
  assert.ok(logs.includes('DROP-SESSION closed its task is finished'));
  assert.ok(logs.includes('DROP-SESSION deleted its task is finished'));
});

test('the files of a task that may still run, or whose worker still runs here, stay however old', async () => {
  const { deps, taskFiles, logs } = setup(
    [
      task({ id: 'resume', status: 'todo', next: 'resume', sessionId: 's', machine: 'there' }),
      task({ id: 'waiting', status: 'waiting', machine: 'here' }),
      task({ id: 'running', status: 'running', machine: 'here' }),
      task({ id: 'needs', status: 'needs-me' }),
      task({ id: 'stopping', status: 'done' }),
    ],
    ['agent-board-running', 'agent-board-stopping'],
    {},
    {
      taskFiles: ['resume', 'waiting', 'running', 'needs', 'stopping', 'hidden', 'down'].flatMap((id) => filesOf(id)),
    },
  );
  const getTask = deps.backend.getTask.bind(deps.backend);
  deps.backend.getTask = async (id) => {
    if (id === 'hidden') throw vocabularyRefusal();
    if (id === 'down') throw new BackendError('cannot reach the board');
    return getTask(id);
  };
  await runDispatch(deps);
  assert.equal(taskFiles.files.length, 14);
  assert.ok(!logs.some((line) => line.startsWith('DROP-')));
});

test('a dry run prints the files it would drop and removes none', async () => {
  const { deps, taskFiles, logs } = setup(
    [task({ id: 'done', status: 'done' })],
    [],
    {},
    { taskFiles: filesOf('done') },
  );
  await runDispatch({ ...deps, dryRun: true });
  assert.equal(taskFiles.files.length, 2);
  assert.ok(logs.includes('DROP-LOG done its task is finished'));
  assert.ok(logs.includes('DROP-SESSION done its task is finished'));
});

test('the worktrees of done, closed and deleted tasks are unlocked; those of tasks that may still run stay locked', async () => {
  const { deps, worktreeLocks, logs } = setup(
    [
      task({ id: 'done', status: 'done' }),
      task({ id: 'closed', status: 'needs-me', closed: true }),
      task({ id: 'needs', status: 'needs-me' }),
      task({ id: 'stopping', status: 'done' }),
    ],
    ['agent-board-stopping'],
    {},
    {
      locks: Object.fromEntries(
        ['done', 'closed', 'deleted', 'needs', 'stopping', 'hidden', 'down'].map((id) => [id, [`/wt/${id}`]]),
      ),
    },
  );
  const getTask = deps.backend.getTask.bind(deps.backend);
  deps.backend.getTask = async (id) => {
    if (id === 'hidden') throw vocabularyRefusal();
    if (id === 'down') throw new BackendError('cannot reach the board');
    return getTask(id);
  };
  await runDispatch(deps);
  assert.deepEqual(worktreeLocks.tasks().sort(), ['down', 'hidden', 'needs', 'stopping']);
  assert.ok(logs.includes('UNLOCK done unlocked the worktree /wt/done'));
  assert.ok(logs.includes('UNLOCK deleted unlocked the worktree /wt/deleted'));
});

test('a dry run prints the worktrees it would unlock and unlocks none', async () => {
  const { deps, worktreeLocks, logs } = setup(
    [task({ id: 'done', status: 'done' })],
    [],
    {},
    { locks: { done: ['/wt/done'] } },
  );
  await runDispatch({ ...deps, dryRun: true });
  assert.deepEqual(worktreeLocks.tasks(), ['done']);
  assert.ok(logs.includes('DRY unlock the worktrees of done: its task is finished'));
});

const tooOld = (backend: FakeBackend): void => {
  backend.listTasks = async () => {
    const error = new BackendError('this CLI is older than the board server', undefined);
    error.contractMismatch = 'cli-older';
    throw error;
  };
};

test('a CLI the board refuses as too old updates itself and ends the tick without failing', async () => {
  const { deps, backend, updates, started, logs, state } = setup([todo('t1')], [], {}, { autoUpdate: 'incompatible' });
  tooOld(backend);
  await runDispatch(deps);
  assert.deepEqual(updates, ['self-update']);
  assert.deepEqual(started, []);
  assert.ok(logs.some((line) => line.startsWith('UPDATING this CLI is too old')));
  assert.equal(state.deferred, undefined);
});

test('the real version check of a server that moved on makes the dispatcher update, and one that is merely older does not', async () => {
  const answering =
    (api: { version: number; minClient: number }): Fetch =>
    async () =>
      new Response(JSON.stringify({ result: { contract: 9, owner: 'alice', keyId: null, api } }));
  const listingVia = (backend: FakeBackend, api: { version: number; minClient: number }): void => {
    const web = createWebBackend({
      loadConfig: () => ({ url: 'https://board.test', token: 'abm_x', dataKey: DATA_KEY }),
      fetch: answering(api),
    });
    backend.listTasks = () => web.listTasks().then(() => []);
  };
  const newer = setup([], [], {}, {});
  listingVia(newer.backend, { version: API_VERSION + 1, minClient: API_VERSION + 1 });
  await runDispatch(newer.deps);
  assert.deepEqual(newer.updates, ['self-update']);
  const older = setup([], [], {}, {});
  listingVia(older.backend, { version: MIN_SERVER - 1, minClient: 1 });
  await assert.rejects(runDispatch(older.deps), /the board server is older than this CLI/);
  assert.deepEqual(older.updates, []);
});

test('with autoUpdate never a too-old CLI does not update and the tick fails as before', async () => {
  const { deps, backend, updates } = setup([], [], {}, { autoUpdate: 'never' });
  tooOld(backend);
  await assert.rejects(runDispatch(deps), /older than the board server/);
  assert.deepEqual(updates, []);
});

test('a checkout never updates itself: it says so and the tick fails', async () => {
  const { deps, backend, updates, logs } = setup([], [], {}, { compiled: false });
  tooOld(backend);
  await assert.rejects(runDispatch(deps), /older than the board server/);
  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.startsWith('UPDATE-NEEDED') && line.includes('git pull')));
});

test('a failed update is logged, ends the tick quietly and is not tried again for an hour', async () => {
  const { deps, backend, updates, logs, state } = setup(
    [],
    [],
    {},
    { fails: 'gh is not logged in: run "gh auth login"' },
  );
  tooOld(backend);
  await runDispatch(deps);
  assert.deepEqual(updates, ['self-update']);
  assert.ok(logs.some((line) => line.startsWith('UPDATE-FAILED gh is not logged in')));
  assert.deepEqual(state.deferred, new Date(NOW.getTime() + RETRY_AFTER_FAILURE_MS));

  const soon = setup([], [], {}, { retryAfter: new Date(NOW.getTime() + 60_000) });
  tooOld(soon.backend);
  await runDispatch(soon.deps);
  assert.deepEqual(soon.updates, []);
  assert.ok(soon.logs.some((line) => line.startsWith('UPDATE-SKIPPED')));

  const later = setup([], [], {}, { retryAfter: NOW });
  tooOld(later.backend);
  await runDispatch(later.deps);
  assert.deepEqual(later.updates, ['self-update']);
});

test('the attempt is recorded before it starts, so a tick killed midway does not start over', async () => {
  const { deps, backend, state } = setup([], [], {}, {});
  tooOld(backend);
  let during: Date | undefined;
  deps.update.update = async () => {
    during = state.deferred;
    throw new Error('the tick was killed here');
  };
  await runDispatch(deps);
  assert.deepEqual(during, new Date(NOW.getTime() + RETRY_AFTER_FAILURE_MS));
});

test('an advertised release that is not published yet is retried in five minutes, not an hour', async () => {
  const { deps, backend, state, logs } = setup([], [], {}, {});
  tooOld(backend);
  deps.update.update = async () => 'unchanged';
  await runDispatch(deps);
  assert.ok(logs.some((line) => line.includes('no newer release is published yet')));
  assert.deepEqual(state.deferred, new Date(NOW.getTime() + RETRY_AFTER_UNPUBLISHED_MS));
});

test('a tick that fails for another reason is not an update', async () => {
  const { deps, backend, updates } = setup([]);
  backend.listTasks = async () => {
    throw new BackendError('cannot reach the board');
  };
  await assert.rejects(runDispatch(deps), /cannot reach/);
  assert.deepEqual(updates, []);
});

test('with autoUpdate always a newer release updates an idle machine and ends the tick', async () => {
  const { deps, updates, started } = setup([todo('t1')], [], {}, { autoUpdate: 'always', advertised: '0.6.0' });
  await runDispatch(deps);
  assert.deepEqual(updates, ['self-update']);
  assert.deepEqual(started, []);
});

test('with autoUpdate always a newer release waits while workers run, and the tick goes on', async () => {
  const { deps, updates, logs } = setup(
    [running('r1')],
    ['agent-board-r1'],
    {},
    { autoUpdate: 'always', advertised: '0.6.0' },
  );
  await runDispatch(deps);
  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.startsWith('UPDATE-WAIT') && line.includes('1 worker')));
  assert.ok(logs.some((line) => line.startsWith('TICK')));
});

test('a newer release is left alone by incompatible, and an equal or unknown one by always', async () => {
  const incompatible = setup([], [], {}, { autoUpdate: 'incompatible', advertised: '0.9.0' });
  await runDispatch(incompatible.deps);
  const equal = setup([], [], {}, { autoUpdate: 'always', advertised: '0.5.0' });
  await runDispatch(equal.deps);
  const unknown = setup([], [], {}, { autoUpdate: 'always' });
  await runDispatch(unknown.deps);
  assert.deepEqual([...incompatible.updates, ...equal.updates, ...unknown.updates], []);
});

test('a failed update under always does not stop the tick, and a dry run never updates', async () => {
  const failing = setup(
    [todo('t1')],
    [],
    {},
    { autoUpdate: 'always', advertised: '0.6.0', fails: 'gh is not installed' },
  );
  await runDispatch(failing.deps);
  assert.deepEqual(failing.started, ['t1']);
  const dry = setup([], [], {}, { autoUpdate: 'always', advertised: '0.6.0' });
  dry.deps.dryRun = true;
  await runDispatch(dry.deps);
  assert.deepEqual(dry.updates, []);
  assert.ok(dry.logs.some((line) => line.startsWith('DRY self-update')));
});

test('the listener and foreign agent-board units are not workers: they neither wait an update out nor take a lane slot', async () => {
  const listing = [
    'agent-board-listen.service loaded active running agent-board listener',
    'agent-board-dispatch.service loaded active running agent-board dispatcher: one tick',
    'agent-board-foo.service loaded active running a unit the user made',
  ].join('\n');
  const { deps, updates } = setup([], [], {}, { autoUpdate: 'always', advertised: '0.6.0' });
  deps.system.activeWorkers = async () => parseWorkerUnits(listing);
  await runDispatch(deps);
  assert.deepEqual(updates, ['self-update']);
});

const listed = { ...CONFIG, dirs: [{ path: tmpdir() }, { path: '/does/not/exist/for/sure' }] };

test('a tick sends the directory list when the board lacks it or has an older one, and logs it once', async () => {
  const { deps, backend, logs } = setup([]);
  deps.config = listed;
  await runDispatch(deps);
  assert.deepEqual(
    backend.writes.filter((w) => w.startsWith('dirs ')),
    [`dirs here: ${tmpdir()}`],
  );
  assert.ok(logs.includes('DIRS sent 1 directories to the board'));
  await runDispatch(deps);
  assert.equal(backend.writes.filter((w) => w.startsWith('dirs ')).length, 1);
  assert.equal(logs.filter((line) => line.startsWith('DIRS')).length, 1, 'unchanged logs nothing');
  deps.config = { ...CONFIG, dirs: [] };
  await runDispatch(deps);
  assert.ok(logs.includes('DIRS sent 0 directories to the board'));
});

test('a tick without a dirs key, or on a server without directory lists, sends and logs nothing about them', async () => {
  const plain = setup([todo('t1')]);
  await runDispatch(plain.deps);
  assert.ok(!plain.backend.writes.some((w) => w.startsWith('dirs ')));
  const old = setup([todo('t1')]);
  old.deps.config = listed;
  old.backend.boardDirs.supported = false;
  await runDispatch(old.deps);
  assert.ok(!old.backend.writes.some((w) => w.startsWith('dirs ')));
  assert.ok(!old.logs.some((line) => /dirs|DIRS/i.test(line)));
  assert.deepEqual(old.started, ['t1']);
});

test('a failure to send the directory list costs one WARN line, and the tick goes on', async () => {
  const { deps, backend, logs, started } = setup([todo('t1')]);
  deps.config = listed;
  backend.boardDirs.failure = new BackendError('set-dirs: the server answered 502 without JSON', 502);
  await runDispatch(deps);
  assert.equal(logs.filter((line) => line.includes('directory list')).length, 1);
  assert.ok(logs.includes('WARN sending the directory list failed: set-dirs: the server answered 502 without JSON'));
  assert.deepEqual(started, ['t1']);
  assert.ok(logs.some((line) => line.startsWith('TICK ')));
});

function withCatalog(tasks: ReturnType<typeof task>[], result: ProbeResult | undefined) {
  const made = setup(tasks);
  const store = fakeCatalogStore();
  const probes: string[] = [];
  made.deps.config = listed;
  made.deps.catalog = {
    store,
    probe: async (dir) => {
      probes.push(dir);
      return result;
    },
    fingerprintDeps: () => ({ claude: '/usr/bin/claude', mtime: () => 1, claudeDir: '/home/me/.claude' }),
  };
  return { ...made, store, probes };
}

const FOUND: ProbeResult = {
  claude: '2.1.326',
  models: [{ value: 'opus', label: 'Opus' }],
  commands: [{ name: 'review', builtin: false }],
};

test('a tick probes the machine’s directory, sends the catalogue once, and logs it', async () => {
  const { deps, backend, logs, probes, started } = withCatalog([todo('t1')], FOUND);
  await runDispatch(deps);
  assert.deepEqual(probes, [tmpdir()]);
  assert.deepEqual(
    backend.writes.filter((w) => w.startsWith('catalog ')),
    ['catalog here: 1 skills, 0 directories, 1 models'],
  );
  assert.ok(logs.includes('CATALOG sent 1 skills and 1 models to the board'));
  await runDispatch(deps);
  assert.equal(backend.writes.filter((w) => w.startsWith('catalog ')).length, 1);
  assert.deepEqual(probes, [tmpdir()], 'nothing was stale the second time');
  assert.deepEqual(started, ['t1']);
});

test('the probe runs after the tasks start', async () => {
  const { deps, store, started } = withCatalog([todo('t1')], FOUND);
  const startsAtProbe: number[] = [];
  const probe = deps.catalog?.probe;
  assert.ok(probe);
  deps.catalog = {
    store,
    fingerprintDeps: () => ({ claude: '/usr/bin/claude', mtime: () => 1, claudeDir: '/home/me/.claude' }),
    probe: async (dir) => {
      startsAtProbe.push(started.length);
      return probe(dir);
    },
  };
  await runDispatch(deps);
  assert.deepEqual(startsAtProbe, [1]);
});

test('a tick with too little time left for a probe skips it and still sends the cached catalogue', async () => {
  const { deps, backend, logs, probes, store } = withCatalog([todo('t1')], FOUND);
  await runDispatch(deps);
  assert.deepEqual(probes, [tmpdir()]);
  backend.boardCatalog.held = undefined;
  deps.catalog = {
    store,
    probe: async (dir) => {
      probes.push(dir);
      return FOUND;
    },
    // Another mtime: the cached probe is stale now.
    fingerprintDeps: () => ({ claude: '/usr/bin/claude', mtime: () => 2, claudeDir: '/home/me/.claude' }),
  };
  let now = NOW;
  const listTasks = backend.listTasks.bind(backend);
  backend.listTasks = async (options) => {
    const tasks = await listTasks(options);
    now = new Date(NOW.getTime() + 80_000);
    return tasks;
  };
  await runDispatch({ ...deps, now: () => now });
  assert.deepEqual(probes, [tmpdir()], 'no second probe');
  assert.equal(backend.writes.filter((w) => w.startsWith('catalog ')).length, 2);
  assert.equal(logs.filter((line) => line.startsWith('CATALOG sent')).length, 2);
});

test('a tick whose probe finds nothing sends nothing, logs a WARN, and still starts the tasks', async () => {
  const { deps, backend, logs, started } = withCatalog([todo('t1')], undefined);
  await runDispatch(deps);
  assert.ok(!backend.writes.some((w) => w.startsWith('catalog ')));
  assert.equal(logs.filter((line) => line.startsWith('WARN asking claude')).length, 1);
  assert.deepEqual(started, ['t1']);
  await runDispatch(deps);
  assert.equal(logs.filter((line) => line.startsWith('WARN asking claude')).length, 1, 'not retried at once');
});

test('a failure to send the catalogue costs one WARN line, and the tick goes on', async () => {
  const { deps, backend, logs, started } = withCatalog([todo('t1')], FOUND);
  backend.boardCatalog.failure = new BackendError('set-catalog: the server answered 502 without JSON', 502);
  await runDispatch(deps);
  assert.ok(
    logs.includes('WARN sending the skill catalogue failed: set-catalog: the server answered 502 without JSON'),
  );
  assert.deepEqual(started, ['t1']);
  assert.ok(logs.some((line) => line.startsWith('TICK ')));
});

test('a tick on a server without catalogues asks nothing more, and a dry tick starts no probe', async () => {
  const old = withCatalog([todo('t1')], FOUND);
  old.backend.boardCatalog.supported = false;
  await runDispatch(old.deps);
  assert.ok(!old.backend.writes.some((w) => w.startsWith('catalog ')));
  assert.ok(!old.logs.some((line) => line.startsWith('CATALOG sent')));
  const dry = withCatalog([todo('t1')], FOUND);
  dry.deps.dryRun = true;
  await runDispatch(dry.deps);
  assert.deepEqual(dry.probes, []);
  assert.ok(dry.logs.includes(`DRY probe claude in ${tmpdir()}`));
});

const PR = 'https://github.com/cosuno/cosuno/pull/5';
const withPr = () => task({ id: 'pr1', status: 'needs-me', input: `/review-pr ${PR} --auto` });

function withGitHub(tasks: ReturnType<typeof task>[], github: Partial<GitHub> | undefined, at?: Date) {
  const setupResult = setup(tasks);
  const asked: string[][] = [];
  const state = fakePrRefreshState(at);
  setupResult.deps.prRefresh = {
    github:
      github === undefined
        ? undefined
        : {
            prStates: async (urls) => {
              asked.push(urls);
              return { states: new Map([[PR, 'merged' as const]]), unreadable: [] };
            },
            ...github,
          },
    state,
  };
  return { ...setupResult, asked, state };
}

test('a tick refreshes the PR state of open tasks and stamps the time', async () => {
  const { deps, backend, logs, asked, state } = withGitHub([withPr()], {});
  await runDispatch(deps);
  assert.deepEqual(asked, [[PR]]);
  assert.ok(backend.writes.includes('prStates pr1 prompt=merged'));
  assert.ok(logs.includes('PRSTATES changed=1'));
  assert.deepEqual(state.at, NOW);
});

test('the PR states are looked up once per 10 minutes', async () => {
  const recent = new Date(NOW.getTime() - PR_REFRESH_INTERVAL_MS + 1000);
  const fresh = withGitHub([withPr()], {}, recent);
  await runDispatch(fresh.deps);
  assert.deepEqual(fresh.asked, []);
  assert.deepEqual(fresh.state.at, recent, 'a skipped tick does not move the time');
  const due = withGitHub([withPr()], {}, new Date(NOW.getTime() - PR_REFRESH_INTERVAL_MS));
  await runDispatch(due.deps);
  assert.deepEqual(due.asked, [[PR]]);
});

test('without gh, or without a PR to look up, nothing is looked up or logged', async () => {
  const noGh = withGitHub([withPr()], undefined);
  await runDispatch(noGh.deps);
  assert.equal(noGh.state.at, undefined);
  assert.ok(!noGh.logs.some((line) => /PR/.test(line)));
  const noPr = withGitHub([todo('t1')], {});
  await runDispatch(noPr.deps);
  assert.deepEqual(noPr.asked, []);
  assert.equal(noPr.state.at, undefined);
});

test('a failing lookup costs one WARN line, never the tick, and is not retried before the interval', async () => {
  const failing = withGitHub([withPr(), todo('t1')], {
    prStates: async () => {
      throw new GitHubError('gh api graphql failed: HTTP 502');
    },
  });
  await runDispatch(failing.deps);
  assert.ok(failing.logs.includes('WARN PR states not refreshed: gh api graphql failed: HTTP 502'));
  assert.deepEqual(failing.started, ['t1']);
  assert.deepEqual(failing.state.at, NOW);
  const crashing = withGitHub([withPr()], {
    prStates: async () => {
      throw new Error('boom');
    },
  });
  await runDispatch(crashing.deps);
  assert.ok(crashing.logs.includes('WARN PR states not refreshed: boom'));
  assert.ok(crashing.logs.some((line) => line.startsWith('TICK ')));
});

test('a dry run looks the states up but stamps nothing', async () => {
  const { deps, state, asked } = withGitHub([withPr()], {});
  deps.dryRun = true;
  await runDispatch(deps);
  assert.deepEqual(asked, [[PR]]);
  assert.equal(state.at, undefined);
});

test('the PR refresh time is kept in a small file in the state directory, and a broken file reads as never', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-pr-refresh-'));
  try {
    const state = createPrRefreshState(prRefreshFile(join(dir, 'nested')));
    assert.equal(state.refreshedAt(), undefined);
    state.markRefreshed(NOW);
    assert.deepEqual(state.refreshedAt(), NOW);
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, 'not json');
    assert.equal(createPrRefreshState(broken).refreshedAt(), undefined);
    assert.doesNotThrow(() => createPrRefreshState(join(broken, 'x', 'y.json')).markRefreshed(NOW));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

const USAGE_RESET = new Date(NOW.getTime() + 3 * 60 * 60_000);
const usageAt = (utilization: number, resetsAt: Date = USAGE_RESET) => ({
  read: () => ({ fiveHour: { utilization, resetsAt: resetsAt.toISOString(), seenAt: NOW.toISOString() } }),
});
const urgent = (id: string) => task({ id, input: '/selftest go', priority: 'urgent' });
const lowPriority = (id: string, priority: 'high' | 'normal' | 'low' = 'normal') =>
  task({ id, input: '/selftest go', priority });

function limitedSetup(tasks: ReturnType<typeof task>[], utilization = 0.85) {
  const result = setup(tasks);
  result.deps.config = { ...CONFIG, usageLimits: { fiveHour: 80, priority: 'urgent' } };
  result.deps.usage = usageAt(utilization);
  return result;
}

test('over a usage threshold only urgent tasks start, one HOLD line names the window, and the reset is the next time', async () => {
  const { deps, started, logs, files } = limitedSetup([urgent('u1'), lowPriority('n1'), lowPriority('n2', 'high')]);
  await runDispatch(deps);
  assert.deepEqual(started, ['u1']);
  assert.deepEqual(
    logs.filter((line) => line.startsWith('HOLD')),
    [`HOLD 2 task(s) below urgent: 5-hour usage 85% (limit 80%, resets ${USAGE_RESET.toISOString()})`],
  );
  assert.ok(logs.includes(`TICK started=1 general=1/2 held=2 next=${USAGE_RESET.toISOString()}`), logs.join('\n'));
  assert.equal(files.next?.getTime(), USAGE_RESET.getTime());
});

test('a resume of a held task is held too', async () => {
  const resume = task({ id: 'r1', input: '/selftest go', next: 'resume', sessionId: 's1', machine: 'here' });
  const { deps, started, logs } = limitedSetup([resume]);
  await runDispatch(deps);
  assert.deepEqual(started, []);
  assert.ok(logs.some((line) => line.startsWith('HOLD 1 task(s) below urgent')));
});

test('the priority of the limit decides what is held, and a window can name its own reset', async () => {
  const { deps, started, logs } = limitedSetup([
    lowPriority('h1', 'high'),
    lowPriority('n1'),
    lowPriority('l1', 'low'),
  ]);
  deps.config = { ...CONFIG, usageLimits: { fiveHour: 80, sevenDay: 50, priority: 'high' } };
  const later = new Date(NOW.getTime() + 24 * 60 * 60_000);
  deps.usage = {
    read: () => ({
      fiveHour: { utilization: 0.9, resetsAt: USAGE_RESET.toISOString(), seenAt: NOW.toISOString() },
      sevenDay: { utilization: 0.6, resetsAt: later.toISOString(), seenAt: NOW.toISOString() },
    }),
  };
  await runDispatch(deps);
  assert.deepEqual(started, ['h1']);
  const hold = logs.filter((line) => line.startsWith('HOLD'));
  assert.equal(hold.length, 1);
  assert.match(hold[0] ?? '', /^HOLD 2 task\(s\) below high: 5-hour usage 90% .*; 7-day usage 60% \(limit 50%/);
  assert.ok(logs.some((line) => line.includes(`held=2 next=${USAGE_RESET.toISOString()}`)));
});

test('held work does not make a lane pause a borrowed run', async () => {
  const borrowed = task({ id: 'b1', status: 'running', input: '/selftest go', machine: 'here' });
  // Both lanes are full, so without the limit i1 would wait for its lane and b1 would be asked to pause.
  const own = task({ id: 'r0', status: 'running', input: '/selftest go', machine: 'here' });
  const { deps, files, logs } = setup([borrowed, own, impl('i1')], ['agent-board-b1', 'agent-board-r0']);
  deps.config = { ...LANED, usageLimits: { fiveHour: 80, priority: 'urgent' } };
  deps.usage = usageAt(0.85);
  files.runs.set('b1', { lane: 'implement', borrowed: true, startedAt: new Date(NOW.getTime() - 10 * 60_000) });
  files.alive.set('b1', NOW);
  files.runs.set('r0', { lane: 'reviews', borrowed: false, startedAt: NOW });
  files.alive.set('r0', NOW);
  await runDispatch(deps);
  assert.equal(files.pauses.size, 0);
  assert.ok(!logs.some((line) => line.startsWith('PAUSE')));
  assert.ok(logs.some((line) => line.startsWith('HOLD 1')));
});

test('under the threshold, without limits, without a reading or after the reset nothing is held or logged', async () => {
  const cases: [string, (deps: DispatchDeps) => void][] = [
    ['under', (deps) => void (deps.usage = usageAt(0.79))],
    ['no limits', (deps) => void (deps.config = CONFIG)],
    ['no reading', (deps) => void (deps.usage = { read: () => ({}) })],
    ['reset', (deps) => void (deps.usage = usageAt(0.95, NOW))],
    ['no reader', (deps) => void (deps.usage = undefined)],
  ];
  for (const [name, change] of cases) {
    const { deps, started, logs } = limitedSetup([lowPriority('n1')]);
    change(deps);
    await runDispatch(deps);
    assert.deepEqual(started, ['n1'], name);
    assert.ok(!logs.some((line) => line.startsWith('HOLD') || line.includes('held=')), name);
  }
});

test('a reached threshold with nothing below the priority to hold logs nothing and adds no time', async () => {
  const { deps, started, logs, files } = limitedSetup([urgent('u1')]);
  await runDispatch(deps);
  assert.deepEqual(started, ['u1']);
  assert.ok(!logs.some((line) => line.startsWith('HOLD') || line.includes('held=')));
  assert.equal(files.next, undefined);
});

const usageWrites = (writes: string[]): string[] => writes.filter((write) => write.startsWith('usage '));

test('a tick sends the held and the open tasks with the limits and the reading, and logs it', async () => {
  const { deps, backend, logs } = limitedSetup([urgent('u1'), lowPriority('n1'), lowPriority('n2', 'high')]);
  await runDispatch(deps);
  assert.deepEqual(usageWrites(backend.writes), ['usage here: 2 held, 1 open']);
  assert.deepEqual(backend.boardUsage.held, {
    limits: { fiveHour: 80, priority: 'urgent' },
    windows: { fiveHour: { percent: 85, resetsAt: USAGE_RESET.toISOString(), seenAt: NOW.toISOString() } },
    reached: ['fiveHour'],
    held: ['n1', 'n2'],
    open: ['u1'],
  });
  assert.ok(logs.includes('USAGE sent 2 held and 1 open'));
});

test('a machine without limits sends its open tasks, so the board knows they are not held', async () => {
  const { deps, backend } = setup([lowPriority('n1')]);
  await runDispatch(deps);
  assert.deepEqual(backend.boardUsage.held, { windows: {}, reached: [], held: [], open: ['n1'] });
});

test('the status is sent on every tick, and logged only when it changed or tasks are held', async () => {
  const { deps, backend, logs } = limitedSetup([]);
  await runDispatch(deps);
  await runDispatch(deps);
  assert.equal(usageWrites(backend.writes).length, 2);
  assert.equal(logs.filter((line) => line.startsWith('USAGE sent')).length, 1);
  const held = limitedSetup([lowPriority('n1')]);
  await runDispatch(held.deps);
  await runDispatch(held.deps);
  assert.equal(held.logs.filter((line) => line.startsWith('USAGE sent')).length, 2);
});

test('a server without the feature gets nothing, and a dry tick logs no send', async () => {
  const old = limitedSetup([lowPriority('n1')]);
  old.backend.boardUsage.supported = false;
  await runDispatch(old.deps);
  assert.deepEqual(usageWrites(old.backend.writes), []);
  assert.ok(!old.logs.some((line) => line.startsWith('USAGE sent')));
  const dry = limitedSetup([lowPriority('n1')]);
  dry.deps.dryRun = true;
  await runDispatch(dry.deps);
  assert.ok(!dry.logs.some((line) => line.startsWith('USAGE sent')));
});

test('a failure to send the usage status costs one WARN line, and the tick goes on', async () => {
  const { deps, backend, logs, started } = limitedSetup([urgent('u1')]);
  backend.boardUsage.failure = new BackendError('set-usage: the server answered 502 without JSON', 502);
  await runDispatch(deps);
  assert.ok(logs.includes('WARN sending the usage status failed: set-usage: the server answered 502 without JSON'));
  assert.deepEqual(started, ['u1']);
  assert.ok(logs.some((line) => line.startsWith('TICK ')));
});

// Watches of task w1, which waits here; the unit's heartbeat is fresh unless a test says otherwise.
const probe = (overrides: Partial<ReturnType<typeof commandDef>> = {}) =>
  commandDef('probe', {
    task: 'w1',
    createdAt: at(-10 * MIN).toISOString(),
    deadline: at(60 * MIN).toISOString(),
    everyMs: 30_000,
    ...overrides,
  });
const spooled = (overrides: Partial<WatchEvent> = {}): WatchEvent => ({
  id: 'e1e2e3e4e5e6e7e8',
  task: 'w1',
  name: 'health',
  at: at(-MIN).toISOString(),
  kind: 'event',
  text: 'Exit 0.',
  ...overrides,
});
const wakes = (writes: string[]): string[] => writes.filter((write) => write.startsWith('wake'));

test('with a fresh heartbeat the tick attempts no watch and says nothing about the unit', async () => {
  const { deps, watches, ranWatches, logs, files } = setup([
    waitingTask('w1', { wakeAt: at(30 * MIN), waitCheck: true }),
  ]);
  watches.write(probe());
  watches.touchHeartbeat(at(-HEARTBEAT_STALE_MS + 1000));
  await runDispatch(deps);
  assert.deepEqual(ranWatches, []);
  assert.equal(logs.filter((line) => line.includes('watch unit')).length, 0);
  assert.equal(watches.read('w1', 'health')?.last, undefined);
  assert.equal(files.next?.getTime(), at(30 * MIN).getTime());
});

test('with a stale or missing heartbeat the tick polls the due watches, warns once, and comes back when the next one is due', async () => {
  for (const beat of [undefined, at(-HEARTBEAT_STALE_MS - 1000)]) {
    const { deps, watches, ranWatches, logs, files } = setup(
      [waitingTask('w1', { wakeAt: at(90 * MIN), waitCheck: true })],
      [],
      {},
      { watchRun: async () => commandResult(1, 'still down') },
    );
    watches.write(probe());
    watches.write(probe({ name: 'later', last: { at: at(-5_000).toISOString(), summary: 'x' } }));
    if (beat !== undefined) watches.touchHeartbeat(beat);
    await runDispatch(deps);
    assert.deepEqual(ranWatches, ['probe']);
    assert.equal(
      logs.filter((line) => line.startsWith('WARN watches on this machine are polled by the dispatch tick')).length,
      1,
    );
    assert.equal(watches.read('w1', 'health')?.last?.summary, 'exit 1: still down');
    // The next due watch attempt (the one that just ran, 30 s from now) is where the listener looks next.
    assert.equal(files.next?.getTime(), NOW.getTime() + 25_000);
  }
});

test('a watch the tick polls that ends wakes its waiting task in the same tick', async () => {
  const { deps, watches, backend, logs } = setup(
    [waitingTask('w1', { wakeAt: at(90 * MIN), waitCheck: true })],
    [],
    {},
    { watchRun: async () => commandResult(0, 'healthy') },
  );
  watches.write(probe());
  await runDispatch(deps);
  assert.deepEqual(watches.list('w1').defs, []);
  assert.deepEqual(wakes(backend.writes), ['wake w1: agent-board: wait over: watch "health" reported.']);
  assert.ok(backend.writes.some((write) => write.startsWith('note w1: agent-board: watch "health" reported.')));
  assert.ok(logs.some((line) => line.startsWith('EVENT w1 health event')));
  assert.equal(watches.events('w1').length, 1);
});

const WATCH_ID = 'a1b2c3d4e5f60718';

test('a stop the user asked for ends that watch with a stopped event, acknowledges it, publishes the rest and wakes the parked task', async () => {
  const { deps, watches, backend, logs } = setup([
    waitingTask('w1', { wakeAt: at(90 * MIN), waitCheck: true, watchStops: [WATCH_ID] }),
  ]);
  watches.touchHeartbeat(NOW);
  watches.write(probe({ id: WATCH_ID }));
  await runDispatch(deps);
  assert.deepEqual(watches.list('w1').defs, []);
  assert.deepEqual(
    watches.events('w1').map(({ event }) => [event.name, event.kind, event.text]),
    [['health', 'stopped', 'Watch "health" was stopped by the user.']],
  );
  assert.ok(logs.includes('STOP-WATCH w1 health'));
  assert.ok(backend.writes.some((write) => write.startsWith('note w1: agent-board: watch "health" reported.')));
  assert.deepEqual(
    backend.writes.filter((write) => write.startsWith('ackWatchStops') || write.startsWith('watches ')),
    [`ackWatchStops w1 ${WATCH_ID}`, 'watches w1 null'],
  );
  assert.deepEqual(wakes(backend.writes), ['wake w1: agent-board: wait over: watch "health" reported.']);
});

test('a stop for a watch that is gone is acknowledged and writes no event, and a task of another machine is left alone', async () => {
  const { deps, watches, backend, logs } = setup([
    waitingTask('w1', { wakeAt: at(90 * MIN), watchStops: ['0000000000000000'] }),
    waitingTask('w2', { wakeAt: at(90 * MIN), watchStops: [WATCH_ID], machine: 'elsewhere' }),
  ]);
  watches.touchHeartbeat(NOW);
  watches.write(probe({ id: WATCH_ID, task: 'w2' }));
  await runDispatch(deps);
  assert.deepEqual(watches.events('w1'), []);
  assert.ok(logs.includes('STOP-WATCH w1 0000000000000000 no such watch'));
  assert.ok(backend.writes.includes('ackWatchStops w1 0000000000000000'));
  assert.equal(
    backend.writes.some((write) => write.includes('w2') && write.startsWith('ackWatchStops')),
    false,
  );
  assert.equal(watches.list('w2').defs.length, 1);
});

const watchWrites = (writes: string[]) => writes.filter((write) => write.startsWith('watches '));
const shownWatch = (overrides: Partial<TaskWatch> = {}): TaskWatch => ({
  id: WATCH_ID,
  name: 'health',
  kind: 'command',
  label: 'command, every 30s',
  status: 'not run yet',
  deadline: at(60 * MIN).toISOString(),
  ...overrides,
});

test('a task whose board list shows watches this machine no longer holds is published again, once', async () => {
  const { deps, watches, backend, logs } = setup([
    task({ id: 'r1', status: 'running', machine: 'here', watches: [shownWatch()] }),
    task({ id: 'r2', status: 'running', machine: 'elsewhere', watches: [shownWatch()] }),
    task({ id: 'r3', status: 'running', machine: 'here' }),
  ]);
  watches.touchHeartbeat(NOW);
  await runDispatch(deps);
  assert.deepEqual(watchWrites(backend.writes), ['watches r1 null']);
  assert.ok(logs.includes("REPUBLISH-WATCHES r1 the board's list is not this machine's"));
  backend.writes.length = 0;
  await runDispatch(deps);
  assert.deepEqual(watchWrites(backend.writes), []);
});

test('a board list that differs from the open watches is published again, and one that only lags in its state is left', async () => {
  const { deps, watches, backend } = setup([
    task({ id: 'r1', status: 'running', machine: 'here', watches: [shownWatch({ id: '0000000000000000' })] }),
    task({ id: 'r2', status: 'running', machine: 'here' }),
    task({ id: 'r3', status: 'running', machine: 'here', watches: [shownWatch({ status: 'exit 1 at 11:00' })] }),
  ]);
  watches.touchHeartbeat(NOW);
  for (const id of ['r1', 'r2', 'r3'])
    watches.write(probe({ id: WATCH_ID, task: id, last: { at: at(-5_000).toISOString(), summary: 'exit 1: x' } }));
  await runDispatch(deps);
  const sent = watchWrites(backend.writes);
  assert.deepEqual(
    sent.map((write) => write.split(' ')[1]),
    ['r1', 'r2'],
  );
  assert.ok(sent.every((write) => write.includes(`"id":"${WATCH_ID}"`)));
});

test('the tick publishes a task at most once: watches it dropped or stopped are not published a second time', async () => {
  const { deps, watches, backend } = setup([
    task({ id: 'd1', status: 'done', machine: 'here', watches: [shownWatch()] }),
    waitingTask('w1', { wakeAt: at(90 * MIN), watchStops: [WATCH_ID], watches: [shownWatch()] }),
  ]);
  watches.touchHeartbeat(NOW);
  watches.write(probe({ id: WATCH_ID, task: 'd1' }));
  watches.write(probe({ id: WATCH_ID }));
  await runDispatch(deps);
  assert.deepEqual(watchWrites(backend.writes).sort(), ['watches d1 null', 'watches w1 null']);
});

test('a dry run says which stale list it would publish and sends nothing', async () => {
  const { deps, backend, logs } = setup([
    task({ id: 'r1', status: 'running', machine: 'here', watches: [shownWatch()] }),
  ]);
  deps.dryRun = true;
  await runDispatch(deps);
  assert.ok(logs.includes("DRY REPUBLISH-WATCHES r1 the board's list is not this machine's"));
  assert.deepEqual(watchWrites(backend.writes), []);
});

test('a dry run says which watch it would stop and changes nothing', async () => {
  const { deps, watches, backend, logs } = setup([
    task({ id: 'r1', status: 'running', machine: 'here', watchStops: [WATCH_ID] }),
  ]);
  deps.dryRun = true;
  watches.touchHeartbeat(NOW);
  watches.write(probe({ id: WATCH_ID, task: 'r1' }));
  await runDispatch(deps);
  assert.ok(logs.includes('DRY STOP-WATCH r1 health'));
  assert.equal(watches.list('r1').defs.length, 1);
  assert.deepEqual(watches.events('r1'), []);
  assert.deepEqual(
    backend.writes.filter((write) => write.includes('atch')),
    [],
  );
});

test('the tick polls a watch no earlier than its period, and not at all after its deadline', async () => {
  const { deps, watches, ranWatches } = setup([waitingTask('w1', { wakeAt: at(90 * MIN), waitCheck: true })]);
  watches.write(probe({ last: { at: at(-5_000).toISOString(), summary: 'x' } }));
  watches.write(
    probe({ name: 'late', last: { at: at(-60_000).toISOString(), summary: 'x' }, deadline: at(-1000).toISOString() }),
  );
  await runDispatch(deps);
  assert.deepEqual(ranWatches, []);
  assert.equal(watches.events('w1').length, 1);
  assert.equal(watches.events('w1')[0]?.event.kind, 'timeout');
});

test('the tick leaves watches that would not finish before its limit to the next tick', async () => {
  const { deps, watches, ranWatches, logs } = setup([waitingTask('w1', { wakeAt: at(90 * MIN), waitCheck: true })]);
  watches.write(probe());
  let calls = 0;
  deps.now = () => new Date(NOW.getTime() + (calls++ > 0 ? 70_000 : 0));
  await runDispatch(deps);
  assert.deepEqual(ranWatches, []);
  assert.ok(logs.some((line) => line.startsWith('DEFER-WATCHES 1')));
});

test('a waiting task whose wakeAt passed gets its overdue watches finished first, with the unit running or not', async () => {
  const { deps, watches, backend } = setup([waitingTask('w1', { wakeAt: at(-MIN), waitCheck: true })]);
  watches.touchHeartbeat(NOW);
  watches.write(probe({ deadline: at(-MIN).toISOString() }));
  watches.write(timerDef({ task: 'w1', deadline: at(-30_000).toISOString() }));
  watches.write(probe({ name: 'open', deadline: at(60 * MIN).toISOString() }));
  await runDispatch(deps);
  assert.deepEqual(
    watches
      .events('w1')
      .map(({ event }) => [event.name, event.kind])
      .sort(),
    [
      ['health', 'timeout'],
      ['timer', 'event'],
    ],
  );
  assert.deepEqual(
    watches.list('w1').defs.map((def) => def.name),
    ['open'],
  );
  // One wake, and the timeouts were written before it.
  assert.equal(wakes(backend.writes).length, 1);
  assert.ok(
    backend.writes.findIndex((write) => write.startsWith('note')) <
      backend.writes.findIndex((write) => write.startsWith('wake')),
  );
});

test('a watch whose deadline has not passed is left to the unit, even when the task is woken for another reason', async () => {
  const { deps, watches } = setup([waitingTask('w1', { wakeAt: at(-MIN) })]);
  watches.touchHeartbeat(NOW);
  watches.write(probe());
  await runDispatch(deps);
  assert.equal(watches.list('w1').defs.length, 1);
  assert.equal(watches.events('w1').length, 0);
});

test('a check wait with watches here and no wait file sleeps until its wakeAt; with neither it wakes', async () => {
  const held = setup([waitingTask('w1', { wakeAt: at(30 * MIN), waitCheck: true })]);
  held.watches.touchHeartbeat(NOW);
  held.watches.write(probe());
  await runDispatch(held.deps);
  assert.deepEqual(wakes(held.backend.writes), []);

  const over = setup([waitingTask('w1', { wakeAt: at(-MIN), waitCheck: true })]);
  over.watches.touchHeartbeat(NOW);
  over.watches.write(probe());
  await runDispatch(over.deps);
  assert.equal(wakes(over.backend.writes).length, 1);

  const none = setup([waitingTask('w1', { wakeAt: at(30 * MIN), waitCheck: true })]);
  await runDispatch(none.deps);
  assert.ok(none.backend.writes.some((write) => write.startsWith('wake w1:') && write.includes('no longer stored')));
});

test('the tick wakes a waiting task with an event nobody was handed, unless a worker runs for it', async () => {
  const idle = setup([waitingTask('w1', { wakeAt: at(30 * MIN), waitCheck: true })]);
  idle.watches.touchHeartbeat(NOW);
  idle.watches.writeEvent(spooled());
  await runDispatch(idle.deps);
  assert.deepEqual(wakes(idle.backend.writes), ['wake w1: agent-board: wait over: watch "health" reported.']);
  // The event stays: the resumed worker reads it.
  assert.equal(idle.watches.events('w1').length, 1);

  const live = setup([waitingTask('w1', { wakeAt: at(30 * MIN), waitCheck: true })], [], {}, { alive: [4242] });
  live.watches.touchHeartbeat(NOW);
  live.watches.writeEvent(spooled());
  live.watches.markLive('w1', 4242);
  await runDispatch(live.deps);
  assert.deepEqual(wakes(live.backend.writes), []);

  const gone = setup([waitingTask('w1', { wakeAt: at(30 * MIN), waitCheck: true })]);
  gone.watches.touchHeartbeat(NOW);
  gone.watches.writeEvent(spooled());
  gone.watches.markLive('w1', 4242);
  await runDispatch(gone.deps);
  assert.equal(wakes(gone.backend.writes).length, 1);
});

test('the watches of a task that is done, closed, in Backlog or gone are dropped; the others keep theirs', async () => {
  const { deps, watches, logs, backend } = setup(
    [
      task({ id: 'd1', status: 'done' }),
      task({ id: 'b1', status: 'backlog' }),
      task({ id: 'c1', status: 'needs-me', closed: true }),
      task({ id: 't1', status: 'todo', input: '/selftest go', notBefore: at(MIN) }),
      task({ id: 'n1', status: 'needs-me', machine: 'here' }),
      task({ id: 'r1', status: 'running', machine: 'here' }),
      waitingTask('w1', { wakeAt: at(30 * MIN), waitCheck: true }),
    ],
    ['agent-board-r1'],
  );
  watches.touchHeartbeat(NOW);
  for (const id of ['d1', 'b1', 'c1', 't1', 'n1', 'r1', 'w1', 'gone']) {
    watches.write(probe({ task: id }));
    watches.writeEvent(spooled({ task: id, name: 'health' }));
  }
  // The board lists open tasks only: a closed one is looked up.
  const listTasks = deps.backend.listTasks.bind(deps.backend);
  deps.backend.listTasks = async (options) => (await listTasks(options)).filter((listed) => !listed.closed);
  await runDispatch(deps);
  assert.deepEqual(watches.tasks().sort(), ['n1', 'r1', 't1', 'w1']);
  for (const [id, why] of [
    ['d1', 'done'],
    ['b1', 'in Backlog'],
    ['c1', 'closed'],
    ['gone', 'gone'],
  ])
    assert.ok(logs.includes(`DROP-WATCHES ${id} its task is ${why}`), id);
  // The board hears of the empty list for the tasks it still has, and has nothing to hear for a task that is gone. The tasks
  // here that keep their watches, which this board does not show yet, are published too.
  assert.deepEqual(
    backend.writes
      .filter((write) => write.startsWith('watches '))
      .map((write) => write.split(' ').slice(0, 3).join(' ').replace(/ \[.*/, ''))
      .sort(),
    ['watches b1 null', 'watches c1 null', 'watches d1 null', 'watches n1', 'watches r1', 'watches w1'],
  );
});

test('a task the board cannot be asked about keeps its watches; a dry run drops nothing', async () => {
  const hidden = setup([]);
  hidden.watches.write(probe({ task: 'h1' }));
  hidden.backend.getTask = async () => {
    throw new BackendError('cannot reach the board');
  };
  await runDispatch(hidden.deps);
  assert.deepEqual(hidden.watches.tasks(), ['h1']);
  assert.ok(hidden.logs.some((line) => line.startsWith('KEEP-WATCHES h1')));

  const dry = setup([task({ id: 'd1', status: 'done' })]);
  dry.deps.dryRun = true;
  dry.watches.write(probe({ task: 'd1' }));
  await runDispatch(dry.deps);
  assert.deepEqual(dry.watches.tasks(), ['d1']);
  assert.ok(dry.logs.includes('DROP-WATCHES d1 its task is done'));
});
