/**
 * One dispatcher tick: sweep stale Running tasks, wake waiting tasks whose time is up, fill free slots from the top of Todo,
 * then drop the logs and session records of finished tasks, unlock their worktrees, and run the checks of waiting tasks that are due.
 * Last, at most every 10 minutes and only where `gh` is installed, it refreshes the PR state of the open tasks.
 * No LLM calls. Add --dry-run to read everything and print every write and process start instead.
 */
import { isBehind, tryUpdate } from '../self/auto-update.mts';
import type { UpdateDeps } from '../self/auto-update.mts';
import { BackendError, isVocabularyRefusal } from '../backend/backend.mts';
import { updateCliHint } from '../backend/contract-check.mts';
import { buildContext, print, skipTickWhileServerOlder } from '../cli.mts';
import type { Context } from '../cli.mts';
import type { MachineUsage, Task } from '@agent-board/shared';
import { promptSkill } from '@agent-board/shared';
import {
  checkOutputBlock,
  decideStale,
  decideWake,
  nextPauseAt,
  notServableHere,
  planPauses,
  planStarts,
} from './decide.mts';
import { neverRun, ownLane, START_MARKER, unreadableForRun, WAKE_MARKER } from '../task-rules.mts';
import { unitName } from '../task-id.mts';
import type { LaneRun } from './decide.mts';
import { syncDirs } from '../config/dirs.mts';
import { realFingerprintDeps, syncCatalog } from '../catalog/catalog.mts';
import { catalogAgents, syncSharedAgents } from '../config/board-agents.mts';
import type { Config } from '../config/config.mts';
import type { CatalogSyncDeps } from '../catalog/catalog.mts';
import { createCatalogStore } from '../catalog/cache.mts';
import { EXIT_GRACE_MS, PROBE_TIMEOUT_MS, probeClaude } from '../catalog/probe.mts';
import { createRunFiles } from '../worker/runtime.mts';
import type { RunFiles } from '../worker/runtime.mts';
import { EXEC_PATH, isCompiledBinary } from '../self/self.mts';
import { realGh, realListenerRestart, selfUpdate } from '../self/self-update.mts';
import { whichOnPath } from '../setup/setup.mts';
import { createWorkerSystem } from '../setup/worker-system.mts';
import type { System } from '../setup/system.mts';
import { readLogTail } from '../worker/logs.mts';
import { createTaskFileStore } from './task-files.mts';
import { createWorktreeLocks } from '../worker/worktree-lock.mts';
import type { WorktreeLocks } from '../worker/worktree-lock.mts';
import type { TaskFileStore } from './task-files.mts';
import { errorText, fence } from '../output/text.mts';
import type { CheckResult, WaitCheck, WaitStore } from './waits.mts';
import { CHECK_TIME_LIMIT_MS, createWaitStore, runCheck, runCommand } from './waits.mts';
import { createUpdateState, updateStateFile } from '../self/update-state.mts';
import { cliVersion, releaseVersion } from '../self/version.mts';
import { defaultLane, getPaths, loadConfig, loadConfigWarnings } from '../config/config.mts';
import { createGitHub } from './github.mts';
import type { GitHub } from './github.mts';
import { createPrRefreshState, prRefreshFile, refreshPrStatesIfDue } from './pr-states.mts';
import type { PrRefreshState } from './pr-states.mts';
import { TICK_LIMIT_S } from './tick.mts';
import {
  buildMachineUsage,
  createUsageStore,
  describeReached,
  earliestReset,
  isBelowPriority,
  reachedWindows,
  usageFile,
} from '../usage/usage.mts';
import type { UsageStore } from '../usage/usage.mts';
import type { WatchRunner } from '../watch/attempt.mts';
import type { WatchStore } from '../watch/store.mts';
import { createWatchStore } from '../watch/store.mts';
import {
  dropReason,
  finishDeadlines,
  nextWatchDue,
  pollWatches,
  undeliveredEvent,
  UNIT_MISSING_WARNING,
  watchesToPoll,
} from '../watch/tick.mts';
import type { DropReason, TickWatchDeps } from '../watch/tick.mts';
import { isBoardStale, publishWatches } from '../watch/publish.mts';
import { handleWatchStops } from '../watch/stops.mts';
import { isRunLive, wakeReason } from '../watch/wake.mts';
import { isProcessAlive } from '../worker/process.mts';
import { applyFeedRequests } from '../feeds/publish.mts';
import { createFeedStore } from '../feeds/store.mts';
import type { FeedStore } from '../feeds/store.mts';

// Below the tick's 110 s limit: a stalled gh must not take the tick down with it.
const PR_REFRESH_GH_TIMEOUT_MS = 30_000;

export interface DispatchDeps extends Context {
  system: System;
  files: RunFiles;
  now: () => Date;
  logTail: (taskId: string) => string;
  waits: WaitStore;
  taskFiles: TaskFileStore;
  worktreeLocks: WorktreeLocks;
  runCheck: (check: WaitCheck) => Promise<CheckResult>;
  // The watches of tasks on this machine (see watch/store.mts), how the tick polls one when the watch unit is not running, and
  // whether a process exists (a worker's `live` marker).
  watches: WatchStore;
  runWatch: WatchRunner;
  isAlive: (pid: number) => boolean;
  update: UpdateDeps;
  // Keys of config.json the CLI ignores (see configWarnings), logged at the start of every tick.
  configWarnings: () => string[];
  // The PR states of open tasks are looked up here at most every 10 minutes; undefined `github`: `gh` is not installed.
  prRefresh: { github: GitHub | undefined; state: PrRefreshState };
  // Where the machine catalogue of skills and models is kept and asked for; undefined: the tick leaves it alone.
  catalog?: Pick<CatalogSyncDeps, 'store' | 'probe' | 'fingerprintDeps'>;
  // The subscription usage this machine's runs reported; undefined: nothing is held back for usage.
  usage?: Pick<UsageStore, 'read'>;
  // Where the board's agent definitions are applied, and how the tick reads its agents again after an apply; undefined: the
  // tick leaves them alone.
  sharedAgents?: { configFile: string; reload: () => Config };
  // Where this machine's feeds are configured and kept; undefined: the tick leaves the board's feed requests alone.
  feeds?: { configFile: string; store: FeedStore };
}

// Ends a wait on the board: the woken task, or undefined when it no longer waited or the call failed.
async function wakeTask(deps: DispatchDeps, task: Task, why: string): Promise<Task | undefined> {
  deps.print(`WAKE ${task.id} ${why.split('\n')[0]}`);
  try {
    const { applied, task: after } = await deps.backend.wake(task.id, `${WAKE_MARKER} ${why}`);
    if (!deps.dryRun) deps.waits.remove(task.id);
    return applied ? after : undefined;
  } catch (error) {
    deps.print(`WARN wake ${task.id} failed: ${errorText(error)}`);
    return undefined;
  }
}

// A check's task that the list does not show may be hidden from this CLI (a value it does not know) rather than gone: only
// the board's 404, or a task that no longer waits or runs here, lets the check go; anything else keeps it.
async function isGone(deps: DispatchDeps, id: string): Promise<boolean> {
  try {
    const task = await deps.backend.getTask(id);
    return !((task.status === 'waiting' || task.status === 'running') && task.machine === deps.config.machine);
  } catch (error) {
    if (error instanceof BackendError && error.fromApi && error.status === 404) return true;
    deps.print(
      isVocabularyRefusal(error)
        ? `KEEP-CHECK ${id} its task uses a value this CLI does not know; ${updateCliHint()}`
        : `KEEP-CHECK ${id} its task could not be read: ${errorText(error)}`,
    );
    return false;
  }
}

const watchDepsOf = (deps: DispatchDeps): TickWatchDeps => ({
  store: deps.watches,
  backend: deps.backend,
  run: deps.runWatch,
  now: deps.now,
  log: deps.print,
  dryRun: deps.dryRun,
});

const publishDepsOf = (deps: DispatchDeps): Parameters<typeof publishWatches>[0] => ({
  store: deps.watches,
  backend: deps.backend,
  now: deps.now,
  log: deps.print,
});

// Why the watches of a task that the list does not show are dropped, or undefined when they stay: only the board's 404, or a
// task that is done or closed, lets them go; a task that cannot be read now keeps them.
async function unlistedDropReason(deps: DispatchDeps, id: string): Promise<DropReason | undefined> {
  try {
    return dropReason(await deps.backend.getTask(id));
  } catch (error) {
    if (error instanceof BackendError && error.fromApi && error.status === 404) return 'gone';
    deps.print(
      isVocabularyRefusal(error)
        ? `KEEP-WATCHES ${id} its task uses a value this CLI does not know; ${updateCliHint()}`
        : `KEEP-WATCHES ${id} its task could not be read: ${errorText(error)}`,
    );
    return undefined;
  }
}

// Watches (and their spool) of a task that is done, closed, in Backlog or gone are of no use to anyone. Running, Waiting, Todo and
// Needs me keep theirs: they survive a question and a pause.
async function dropFinishedWatches(deps: DispatchDeps, listed: Task[], published: Set<string>): Promise<void> {
  const shown = new Map(listed.map((task) => [task.id, task]));
  let lookups = 0;
  for (const id of deps.watches.tasks()) {
    const task = shown.get(id);
    if (task === undefined && lookups >= TASK_FILE_LOOKUPS_PER_TICK) continue;
    if (task === undefined) lookups += 1;
    const reason = task === undefined ? await unlistedDropReason(deps, id) : dropReason(task);
    if (reason === undefined) continue;
    deps.print(`DROP-WATCHES ${id} its task is ${reason}`);
    if (deps.dryRun) continue;
    deps.watches.dropTask(id);
    // The board clears them itself for a task that left; this keeps its copy right when it did not.
    if (reason === 'gone') continue;
    published.add(id);
    await publishWatches(publishDepsOf(deps), id);
  }
}

// The stop requests of the user for the tasks on this machine, after the watches of finished tasks are dropped.
async function stopWatches(deps: DispatchDeps, tasks: Task[], published: Set<string>): Promise<void> {
  for (const task of tasks) {
    if (task.machine !== deps.config.machine || task.watchStops.length === 0) continue;
    published.add(task.id);
    await handleWatchStops({ ...watchDepsOf(deps), backend: deps.backend }, task);
  }
}

// The board's list of a task's watches goes stale when this machine went down between changing the store and publishing. A task
// here whose list on the board is not the store's is published again, once per tick; `published` are the tasks this tick has
// told the board about already, whose listed copy is older than that.
async function republishStaleWatches(deps: DispatchDeps, tasks: Task[], published: Set<string>): Promise<void> {
  for (const task of tasks) {
    if (task.machine !== deps.config.machine || published.has(task.id)) continue;
    if (!isBoardStale(deps.watches, task, deps.now())) continue;
    deps.print(`${deps.dryRun ? 'DRY ' : ''}REPUBLISH-WATCHES ${task.id} the board's list is not this machine's`);
    if (deps.dryRun) continue;
    published.add(task.id);
    await publishWatches(publishDepsOf(deps), task.id);
  }
}

/**
 * Waits whose time is up, or whose check is gone, end now, before the slots are filled: the woken tasks are Todo again and can
 * start in this tick. Returns the tasks with the woken ones replaced, and the waiting tasks whose check is due.
 */
async function wakeDue(deps: DispatchDeps, tasks: Task[]): Promise<{ tasks: Task[]; checks: Task[] }> {
  const { config, waits } = deps;
  const waiting = tasks.filter((task) => task.status === 'waiting' && task.machine === config.machine);
  // A check whose task no longer waits here is left over: the user moved the card, or the task was closed. One whose task is
  // still running may be about to wait (`board wait` stores the check first), so it stays.
  const keep = new Set(
    tasks
      .filter((task) => (task.status === 'waiting' || task.status === 'running') && task.machine === config.machine)
      .map((task) => task.id),
  );
  for (const id of waits.list()) {
    if (keep.has(id) || !(await isGone(deps, id))) continue;
    deps.print(`DROP-CHECK ${id} its task no longer waits here`);
    if (!deps.dryRun) waits.remove(id);
  }
  const published = new Set<string>();
  try {
    await dropFinishedWatches(deps, tasks, published);
  } catch (error) {
    deps.print(`WARN dropping the watches of finished tasks failed: ${errorText(error)}`);
  }
  await stopWatches(deps, tasks, published);
  await republishStaleWatches(deps, tasks, published);
  const checks: Task[] = [];
  const replaced = new Map<string, Task>();
  for (const task of waiting) {
    const held = deps.watches.list(task.id).defs.length > 0 || deps.watches.events(task.id).length > 0;
    // A timeout is an event the resume prompt carries, so a task whose time ran out gets it before it is woken.
    if (held && task.wakeAt !== null && task.wakeAt.getTime() <= deps.now().getTime()) {
      const ended = await finishDeadlines(watchDepsOf(deps), task.id);
      if (ended.length > 0) await publishWatches(publishDepsOf(deps), task.id);
    }
    const event = isRunLive(deps.watches, task.id, deps.isAlive) ? undefined : undeliveredEvent(deps.watches, task.id);
    const decision = decideWake({
      task,
      check: waits.read(task.id),
      machine: config.machine,
      now: deps.now(),
      watches: held,
      ...(event === undefined ? {} : { event }),
    });
    if (decision.kind === 'check') checks.push(task);
    if (decision.kind === 'wake' || decision.kind === 'timeout') {
      const after = await wakeTask(deps, task, decision.why);
      if (after) replaced.set(task.id, after);
    }
  }
  return { tasks: tasks.map((task) => replaced.get(task.id) ?? task), checks };
}

// A finished task's log and session record are kept this long after they last changed: the log for the user to read, the
// record so a task moved back from Done can still be resumed.
export const TASK_FILES_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
// Tasks the list does not show are looked up one by one; a machine with a long history clears them over a few ticks.
const TASK_FILE_LOOKUPS_PER_TICK = 20;

// Whether a task the list does not show is finished: closed, done, or gone from the board. A task the board hides from this
// CLI, or one that cannot be read now, is not.
async function isFinished(deps: DispatchDeps, id: string): Promise<boolean> {
  try {
    const task = await deps.backend.getTask(id);
    return task.closed || task.status === 'done';
  } catch (error) {
    return error instanceof BackendError && error.fromApi && error.status === 404;
  }
}

/**
 * Drops the logs and session records of tasks that are done, closed or gone, once the files are older than TASK_FILES_KEEP_MS.
 * Every other task keeps its files: one in Running, Waiting or Todo may resume its session, and one in Needs me or Backlog may
 * be sent back to Todo. The files of a task whose worker still runs here are kept whatever the board says.
 */
async function pruneTaskFiles(deps: DispatchDeps, listed: Task[], activeWorkers: string[]): Promise<void> {
  const cutoff = deps.now().getTime() - TASK_FILES_KEEP_MS;
  const old = deps.taskFiles.list().filter((file) => file.modifiedAt.getTime() < cutoff);
  const shown = new Map(listed.map((task) => [task.id, task]));
  let lookups = 0;
  for (const id of new Set(old.map((file) => file.taskId))) {
    if (activeWorkers.includes(id)) continue;
    const task = shown.get(id);
    if (task === undefined && lookups >= TASK_FILE_LOOKUPS_PER_TICK) continue;
    if (task === undefined) lookups += 1;
    if (!(task === undefined ? await isFinished(deps, id) : task.status === 'done')) continue;
    for (const file of old.filter((candidate) => candidate.taskId === id)) {
      deps.print(`DROP-${file.kind.toUpperCase()} ${id} its task is finished`);
      if (!deps.dryRun) deps.taskFiles.remove(file);
    }
  }
}

/**
 * Unlocks the worktrees that tasks locked here (see worktree-lock.mts) once the task is done, closed or gone from the board. A
 * task in any other column may still be resumed in its worktree, and one whose worker runs here keeps its locks whatever the
 * board says.
 */
async function releaseWorktrees(deps: DispatchDeps, listed: Task[], activeWorkers: string[]): Promise<void> {
  const shown = new Map(listed.map((task) => [task.id, task]));
  let lookups = 0;
  for (const id of deps.worktreeLocks.tasks()) {
    if (activeWorkers.includes(id)) continue;
    const task = shown.get(id);
    if (task === undefined && lookups >= TASK_FILE_LOOKUPS_PER_TICK) continue;
    if (task === undefined) lookups += 1;
    if (!(task === undefined ? await isFinished(deps, id) : task.closed || task.status === 'done')) continue;
    if (deps.dryRun) {
      deps.print(`DRY unlock the worktrees of ${id}: its task is finished`);
      continue;
    }
    for (const line of deps.worktreeLocks.release(id)) deps.print(`UNLOCK ${id} ${line}`);
  }
}

// The tick is stopped after its limit, and the check processes would outlive it: they run in their own process group.
export const TICK_LIMIT_MS = TICK_LIMIT_S * 1000;
const TICK_MARGIN_MS = 10_000;
// What `timeout` exits with when it stopped a command.
const TICK_TIMED_OUT = 124;
// Ticks come every 2 minutes at the least; a longer gap since the last one means the machine slept or was off.
const TICK_GAP_MS = 10 * 60_000;

// The in-process backstop of the tick's time limit, for a tick no `timeout` or unit limit watches (launchd has none):
// calls `onLimit` after `limitMs` unless the returned function cancels it first. It does not keep the process alive.
export function limitTick(limitMs: number, onLimit: () => void): () => void {
  const timer = setTimeout(onLimit, limitMs);
  timer.unref();
  return () => clearTimeout(timer);
}

// The due checks, side by side; a check that passes wakes its task, any other result is kept for the next attempt. Checks that
// would not finish before the tick's limit wait for the next tick.
async function runChecks(deps: DispatchDeps, checks: Task[], tickStart: Date): Promise<void> {
  if (checks.length === 0) return;
  const left = TICK_LIMIT_MS - TICK_MARGIN_MS - (deps.now().getTime() - tickStart.getTime());
  if (left < CHECK_TIME_LIMIT_MS) {
    deps.print(`DEFER-CHECKS ${checks.length}: the tick has ${Math.max(0, Math.round(left / 1000))} s left`);
    return;
  }
  await Promise.all(
    checks.map(async (task) => {
      const check = deps.waits.read(task.id);
      if (check === undefined) return;
      if (deps.dryRun) {
        deps.print(`DRY check ${task.id} in ${check.cwd}`);
        return;
      }
      const at = deps.now();
      const result = await deps.runCheck(check);
      if (result.exitCode === 0) {
        await wakeTask(deps, task, `its check passed.${checkOutputBlock(result.output)}`);
        return;
      }
      deps.print(`CHECK ${task.id} ${result.timedOut ? 'too slow' : `exit ${result.exitCode ?? 'killed'}`}`);
      // The task may have been woken or moved meanwhile; then the file is gone and stays gone.
      if (deps.waits.read(task.id) === undefined) return;
      deps.waits.write(task.id, { ...check, lastCheckAt: at, lastExit: result.exitCode, lastOutput: result.output });
    }),
  );
}

// With no watch unit running, the tick polls the due watches and finishes the ones whose time is up, then wakes the waiting tasks
// that got an event. Returns whether it polled: only then are the watches' times the tick's own to come back for.
async function pollWatchesInstead(deps: DispatchDeps, tasks: Task[], tickStart: Date): Promise<boolean> {
  const defs = watchesToPoll(deps.watches, deps.now());
  if (defs === undefined) return false;
  deps.print(UNIT_MISSING_WARNING);
  const timeLeftMs = TICK_LIMIT_MS - TICK_MARGIN_MS - (deps.now().getTime() - tickStart.getTime());
  const got = await pollWatches(watchDepsOf(deps), defs, { timeLeftMs });
  for (const id of got) {
    await publishWatches(publishDepsOf(deps), id);
    const task = tasks.find((candidate) => candidate.id === id);
    const name = undeliveredEvent(deps.watches, id);
    if (task?.status !== 'waiting' || task.machine !== deps.config.machine || name === undefined) continue;
    if (!isRunLive(deps.watches, id, deps.isAlive)) await wakeTask(deps, task, wakeReason(name));
  }
  return true;
}

// Applies a newer version of the board's agent definitions; returns the config with the agents as they are now, or undefined
// when nothing changed. A server that cannot hold them or a failure costs one line at most, and the tick goes on with what it has.
async function applyBoardAgents(deps: DispatchDeps): Promise<Config | undefined> {
  const { sharedAgents } = deps;
  if (sharedAgents === undefined) return undefined;
  try {
    const result = await syncSharedAgents({
      backend: deps.backend,
      configFile: sharedAgents.configFile,
      now: deps.now,
      dryRun: deps.dryRun,
      log: deps.print,
      print: deps.print,
    });
    return result === 'applied' ? sharedAgents.reload() : undefined;
  } catch (error) {
    deps.print(`WARN applying the board's agents failed: ${errorText(error)}`);
    return undefined;
  }
}

// Tells the board this machine's directory list when it changed; a server that cannot hold one or a failure costs one line at most.
async function sendDirs({ backend, config, print: log }: DispatchDeps): Promise<void> {
  try {
    const sync = await syncDirs({ backend, config });
    if (sync.result === 'sent') log(`DIRS sent ${sync.count} directories to the board`);
  } catch (error) {
    log(`WARN sending the directory list failed: ${errorText(error)}`);
  }
}

// Probes at most one directory for its skills and models, then tells the board this machine's catalogue when it changed; a
// server that cannot hold one or a failure costs one line at most. A tick with less time left than a probe can take only
// sends what is cached.
async function sendCatalog(deps: DispatchDeps, tickStart: Date): Promise<void> {
  const { backend, config, catalog, now, dryRun, print: log } = deps;
  if (catalog === undefined) return;
  const left = TICK_LIMIT_MS - TICK_MARGIN_MS - (now().getTime() - tickStart.getTime());
  const skipProbe = left < PROBE_TIMEOUT_MS + EXIT_GRACE_MS;
  try {
    const agents =
      deps.sharedAgents === undefined ? undefined : catalogAgents(deps.sharedAgents.configFile, config.agents);
    const sync = await syncCatalog({
      ...catalog,
      backend,
      config,
      now,
      dryRun,
      log,
      skipProbe,
      ...(agents === undefined ? {} : { agents }),
    });
    if (sync.result === 'sent') log(`CATALOG sent ${sync.skills} skills and ${sync.models} models to the board`);
  } catch (error) {
    log(`WARN sending the skill catalogue failed: ${errorText(error)}`);
  }
}

// Tells the board why this machine holds tasks back, and which Todo tasks it could serve and does not hold, on every tick.
// A server that cannot hold it or a failure costs one line at most.
async function sendUsage({ backend, config, dryRun, print: log }: DispatchDeps, status: MachineUsage): Promise<void> {
  try {
    const onBoard = await backend.checkUsage(config.machine, status);
    if (onBoard === 'unsupported') return;
    // Every tick, so the board sees that this dispatcher is running; the log keeps to what changed or what is held.
    await backend.setUsage(config.machine, status);
    if (!dryRun && (onBoard === 'stale' || status.held.length > 0))
      log(`USAGE sent ${status.held.length} held and ${status.open.length} open`);
  } catch (error) {
    log(`WARN sending the usage status failed: ${errorText(error)}`);
  }
}

/**
 * When this machine next has something to do that no event announces: a wait here ends or its check is due again. A check that
 * never ran, or that this tick put off, is due now. A wait whose time is up was woken in this tick or its wake failed; the
 * timer's tick retries that, so it does not count.
 */
function nextWaitDue({ config, waits, watches, now }: DispatchDeps, tasks: Task[]): Date[] {
  const at = now().getTime();
  const times: Date[] = [];
  for (const task of tasks) {
    if (task.status !== 'waiting' || task.machine !== config.machine) continue;
    const check = task.waitCheck ? waits.read(task.id) : undefined;
    // Gone: the check passed and woke the task in this tick, or a wake that failed is the timer's to retry. Watches stand in for
    // a stored check.
    if (task.waitCheck && check === undefined && watches.list(task.id).defs.length === 0) continue;
    if (task.wakeAt !== null && task.wakeAt.getTime() > at) times.push(task.wakeAt);
    if (check !== undefined) times.push(new Date((check.lastCheckAt?.getTime() ?? at) + check.everyMs));
  }
  return times;
}

function earliest(times: Date[]): Date | undefined {
  return times.reduce<Date | undefined>((first, at) => (first === undefined || at < first ? at : first), undefined);
}

const updateRun = ({ update, now, print: log, dryRun }: DispatchDeps) => ({ ...update, now, log, dryRun });

export async function runDispatch(given: DispatchDeps): Promise<void> {
  let deps = given;
  const { backend, system, files, print: log } = deps;
  let { config } = deps;
  const tickStart = deps.now();
  // A gap since the last tick is time the whole machine spent asleep: runs were quiet because their agents slept too.
  const previousTick = files.lastDispatchTick();
  const afterGap = previousTick !== undefined && tickStart.getTime() - previousTick.getTime() > TICK_GAP_MS;
  if (!deps.dryRun) {
    files.markDispatchTick(tickStart);
    // Written again at the end; a tick that stops before must not leave the listener a time that is long past.
    files.writeNextDue(undefined);
  }
  for (const warning of deps.configWarnings()) log(`WARN config.json: ${warning}`);
  for (const reason of Object.values(config.agentErrors))
    log(`WARN config.json: ${reason}; tasks that name this agent are not run`);
  let listed: Task[];
  try {
    listed = await backend.listTasks();
  } catch (error) {
    // A board that has moved on refuses this CLI; with the config's leave the dispatcher fetches the CLI that fits.
    if (!(error instanceof BackendError) || error.contractMismatch !== 'cli-older' || config.autoUpdate === 'never')
      throw error;
    const outcome = await tryUpdate(updateRun(deps), 'this CLI is too old for the board');
    // Failing or waiting out a failure ends the tick quietly: it must not alert on every tick.
    if (outcome === 'unavailable') throw error;
    return;
  }
  const advertised = deps.update.advertised();
  if (config.autoUpdate === 'always' && isBehind({ advertised, version: deps.update.version })) {
    const workers = await system.activeWorkers();
    const why = `board ${advertised} is available (this is ${deps.update.version})`;
    // Workers call this binary again (their hook), so it is replaced only while none runs; the next tick looks again.
    if (workers.length > 0) log(`UPDATE-WAIT ${why}; ${workers.length} worker(s) running`);
    else if ((await tryUpdate(updateRun(deps), why)) === 'updated') return;
  }
  // Before anything decides what runs here, so a task that names a newly pushed agent can start in this tick.
  const reloaded = await applyBoardAgents(deps);
  if (reloaded !== undefined) {
    config = reloaded;
    deps = { ...deps, config };
  }
  await sendDirs(deps);
  // The unit of a task lives on the machine that claimed it; another machine's tasks are its own business.
  const running = listed.filter(
    (task) => task.status === 'running' && (task.machine === null || task.machine === config.machine),
  );

  if (afterGap && running.length > 0)
    log(
      `NOTE no tick for ${Math.round((tickStart.getTime() - (previousTick?.getTime() ?? 0)) / 60_000)} minutes: the machine slept, so this sweep does not count quiet time against the runs`,
    );
  for (const task of running) {
    const unit = unitName(task.id);
    const unitActive = await system.isActive(unit);
    // The unit knows when this run began, to the second; the claim is the board's record of it.
    const unitStart = unitActive ? await system.startedAt(unit) : undefined;
    const decision = decideStale({
      unitActive,
      startedAt: unitStart ?? task.runStartedAt ?? undefined,
      lastActive: files.lastActive(task.id),
      now: deps.now(),
      limits: config,
      afterGap,
    });
    if (!decision.stale) continue;
    if (decision.stopUnit) await system.stop(unit);
    if (!deps.dryRun) files.clear(task.id);
    log(`STALE ${task.id} ${decision.reason}`);
    const tail = deps.logTail(task.id);
    await deps.backend.fail(task.id, `${decision.reason}\n\nEnd of the log:\n${fence(tail || '(empty)')}`);
  }

  const { tasks, checks } = await wakeDue(deps, listed);

  // What runs here, per lane: every active worker unit, whatever the board says, with the lane its run file names.
  const activeWorkers = await system.activeWorkers();
  const runs = await Promise.all(
    activeWorkers.map(async (taskId): Promise<LaneRun> => {
      const record = files.readRun(taskId);
      return {
        taskId,
        lane: record?.lane ?? defaultLane(config.lanes).name,
        borrowed: record?.borrowed ?? false,
        startedAt: record?.startedAt ?? (await system.startedAt(unitName(taskId))),
        pauseRequested: files.pauseRequestedAt(taskId) !== undefined,
      };
    }),
  );

  const eligible: Task[] = [];
  // When the delayed Todo tasks this machine could serve come due.
  const delayed: Date[] = [];
  // The backend lists Todo with resumes first, then by priority.
  for (const task of tasks.filter((candidate) => candidate.status === 'todo')) {
    // A task put back in Todo (an answer came while the agent was still ending its turn) must not start twice.
    if (activeWorkers.includes(task.id)) {
      log(`SKIP ${task.id} its last worker is still stopping`);
      continue;
    }
    // An agent's proposal waits for the user, whatever status the board shows. The worker refuses it as well.
    if (neverRun(task) !== undefined) {
      log(`SKIP ${task.id} proposed by an agent, not started by you`);
      continue;
    }
    // A prompt or directory this machine cannot decrypt must never be run as an empty one. The worker refuses it as well.
    const unreadable = unreadableForRun(task);
    if (unreadable.length > 0) {
      log(`SKIP ${task.id} cannot decrypt its ${unreadable.join(' and ')}`);
      continue;
    }
    // Not due yet; the board refuses the claim too, this only saves the attempt every tick. Checked before the SKIP line
    // of notServableHere, so no other machine logs one for every delayed card on every tick.
    if (task.notBefore !== null && task.notBefore > deps.now()) {
      if (notServableHere(task, config.machine, config) === undefined) delayed.push(task.notBefore);
      continue;
    }
    // Its schedule has all its slots in use; the board refuses the claim too, this only saves the attempt every tick.
    if (task.held === true) continue;
    // Another machine may have the checkout, the directory or the session.
    const elsewhere = notServableHere(task, config.machine, config);
    if (elsewhere !== undefined) {
      log(`SKIP ${task.id} ${elsewhere}`);
      continue;
    }
    eligible.push(task);
  }

  // While a configured threshold is reached, work below the limit's priority does not start, resumes included: they use quota
  // too. Held tasks are out of `candidates` for good, so they do not make a lane pause a borrowed run either.
  const storedUsage = deps.usage?.read() ?? {};
  const reached =
    config.usageLimits === undefined
      ? []
      : reachedWindows({ limits: config.usageLimits, usage: storedUsage, now: deps.now() });
  const lowest = config.usageLimits?.priority ?? 'urgent';
  const isHeld = (task: Task): boolean => reached.length > 0 && isBelowPriority(task.priority, lowest);
  const held = eligible.filter(isHeld);
  const candidates = eligible.filter((task) => !isHeld(task));
  if (held.length > 0) log(`HOLD ${held.length} task(s) below ${lowest}: ${describeReached(reached)}`);

  const ownLaneOf = (task: Task): string => ownLane(task, config.lanes).name;
  const started = new Set<string>();
  const tried = new Set<string>();
  // One start at a time, planned again after each: a lost claim hands its slot to the next task.
  for (;;) {
    const open = candidates.filter((candidate) => !tried.has(candidate.id));
    const start = planStarts({ lanes: config.lanes, running: runs, candidates: open, ownLaneOf })[0];
    if (start === undefined) break;
    tried.add(start.taskId);
    const task = open.find((candidate) => candidate.id === start.taskId);
    if (!task) continue;
    const skill = promptSkill(task.input) ?? 'prompt';
    const { name: own, missing } = ownLane(task, config.lanes);
    const fellBack = missing === undefined ? '' : `, lane ${missing} → ${own} (no such lane here)`;
    if ((await backend.claimTask(task.id, config.machine)) === undefined) {
      log(`LOST ${task.id} claimed elsewhere`);
      continue;
    }
    // Written before the unit starts: the worker and the next tick read the lane from it.
    if (!deps.dryRun) {
      files.clear(task.id);
      files.writeRun(task.id, { lane: start.lane, borrowed: start.borrowed, startedAt: deps.now() });
    }
    let pid: number | undefined;
    try {
      ({ pid } = await system.startWorker(task.id));
    } catch (error) {
      const reason = errorText(error);
      log(`START-FAILED ${task.id} ${reason}`);
      if (!deps.dryRun) files.clear(task.id);
      await deps.backend.fail(task.id, `The worker could not be started: ${reason}`);
      // Whatever broke it will break the next start too.
      break;
    }
    started.add(task.id);
    runs.push({
      taskId: task.id,
      lane: start.lane,
      borrowed: start.borrowed,
      startedAt: deps.now(),
      pauseRequested: false,
    });
    log(`STARTED ${task.id} ${skill} lane=${start.lane}${start.borrowed ? ' borrowed' : ''}${fellBack}`);
    const where = `${start.lane} lane${start.borrowed ? ', borrowed' : ''}${fellBack}, unit ${unitName(task.id)}${pid ? `, pid ${pid}` : ''}`;
    await backend
      .addNote(task.id, `${START_MARKER} ${deps.now().toISOString()} (${skill}, ${config.machine}, ${where})`, {
        author: 'system',
      })
      .catch((error: unknown) => {
        log(`WARN start note failed: ${errorText(error)}`);
      });
  }

  // Lanes whose own work still waits take their slots back from borrowed runs.
  const waitingOwn = new Map<string, number>();
  for (const task of candidates) {
    if (started.has(task.id)) continue;
    const lane = ownLaneOf(task);
    waitingOwn.set(lane, (waitingOwn.get(lane) ?? 0) + 1);
  }
  const lanes = { lanes: config.lanes, waitingOwn, pauseAfterMinutes: config.pauseAfterMinutes };
  const paused = new Set<string>();
  for (const run of planPauses({ ...lanes, running: runs, now: deps.now() })) {
    log(`PAUSE ${run.taskId} lane=${run.lane} (its own work waits)`);
    paused.add(run.taskId);
    if (deps.dryRun) continue;
    try {
      files.requestPause(run.taskId);
    } catch (error) {
      log(`WARN pause request failed: ${errorText(error)}`);
    }
  }
  const summary = config.lanes
    .map((lane) => `${lane.name}=${runs.filter((run) => run.lane === lane.name).length}/${lane.slots}`)
    .join(' ');
  try {
    await pruneTaskFiles(deps, listed, activeWorkers);
  } catch (error) {
    log(`WARN dropping old task files failed: ${errorText(error)}`);
  }
  try {
    await releaseWorktrees(deps, listed, activeWorkers);
  } catch (error) {
    log(`WARN unlocking the worktrees of finished tasks failed: ${errorText(error)}`);
  }
  await runChecks(deps, checks, tickStart);
  let polled = false;
  try {
    polled = await pollWatchesInstead(deps, tasks, tickStart);
  } catch (error) {
    log(`WARN polling the watches failed: ${errorText(error)}`);
  }
  // Read after the checks ran: each one that failed is due again `everyMs` from now.
  const pauseAt = nextPauseAt({
    ...lanes,
    running: runs.map((run) => (paused.has(run.taskId) ? { ...run, pauseRequested: true } : run)),
    now: deps.now(),
  });
  const usageReset = held.length > 0 ? earliestReset(reached) : undefined;
  const next = earliest([
    ...delayed,
    ...nextWaitDue(deps, tasks),
    ...(polled ? nextWatchDue(deps.watches.all()) : []),
    ...(pauseAt === undefined ? [] : [pauseAt]),
    ...(usageReset === undefined ? [] : [usageReset]),
  ]);
  if (!deps.dryRun) files.writeNextDue(next);
  log(
    `TICK started=${started.size} ${summary}${checks.length > 0 ? ` checks=${checks.length}` : ''}${held.length > 0 ? ` held=${held.length}` : ''}${next === undefined ? '' : ` next=${next.toISOString()}`}`,
  );
  await sendUsage(
    deps,
    buildMachineUsage({
      limits: config.usageLimits,
      stored: storedUsage,
      reached,
      heldIds: held.map(({ id }) => id),
      openIds: candidates.map(({ id }) => id),
    }),
  );
  // After the starts and the checks, so a probe never holds one back.
  await sendCatalog(deps, tickStart);
  if (deps.feeds !== undefined && !deps.dryRun)
    await applyFeedRequests({ backend, machine: config.machine, log, ...deps.feeds });
  // Last, so a slow or failing GitHub never holds back a start.
  await refreshPrStatesIfDue({ ...deps.prRefresh, backend, now: deps.now, dryRun: deps.dryRun, print: log }, listed);
}

export async function dispatchMain({ dryRun }: { dryRun: boolean }): Promise<void> {
  const context = buildContext(dryRun);
  const compiled = isCompiledBinary();
  const cancelLimit = limitTick(TICK_LIMIT_MS, () => {
    print(`tick stopped after ${TICK_LIMIT_MS / 1000} s`);
    process.exit(TICK_TIMED_OUT);
  });
  try {
    await skipTickWhileServerOlder(() =>
      runDispatch({
        ...context,
        print,
        update: {
          compiled,
          version: cliVersion(),
          advertised: () => context.serverCli?.(),
          state: createUpdateState(updateStateFile(getPaths().stateDir)),
          update: () =>
            selfUpdate(
              {
                compiled,
                version: releaseVersion(),
                execPath: EXEC_PATH,
                platform: process.platform,
                arch: process.arch,
                // Below the tick's 110 s limit, so a stalled download fails instead of being killed with the tick.
                gh: realGh(process.env, 90_000),
                // The dispatcher runs inside the listener's unit, whose stop waits for it: asking must not wait for the stop.
                restartListener: realListenerRestart({ block: false }),
                print,
              },
              {},
            ),
        },
        system: createWorkerSystem({ dryRun, print }),
        files: createRunFiles(),
        now: () => new Date(),
        logTail: readLogTail,
        waits: createWaitStore(),
        taskFiles: createTaskFileStore(),
        worktreeLocks: createWorktreeLocks(),
        runCheck: (check) => runCheck(check),
        watches: createWatchStore(),
        runWatch: (job) => runCommand(job),
        isAlive: isProcessAlive,
        configWarnings: () => loadConfigWarnings(getPaths().configFile),
        catalog: {
          store: createCatalogStore(),
          probe: (dir) => probeClaude(dir),
          fingerprintDeps: () => realFingerprintDeps(),
        },
        usage: createUsageStore(usageFile(getPaths().stateDir)),
        sharedAgents: { configFile: getPaths().configFile, reload: () => loadConfig(getPaths().configFile) },
        feeds: { configFile: getPaths().configFile, store: createFeedStore(undefined, isProcessAlive) },
        prRefresh: {
          github:
            whichOnPath('gh') === undefined
              ? undefined
              : createGitHub(undefined, { timeoutMs: PR_REFRESH_GH_TIMEOUT_MS }),
          state: createPrRefreshState(prRefreshFile(getPaths().stateDir)),
        },
      }),
    );
  } finally {
    cancelLimit();
  }
}
