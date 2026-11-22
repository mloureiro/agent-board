/**
 * The listener: holds a stream to the board and runs a dispatch tick when it says tasks changed, so a new task starts
 * in about a second instead of at the next timer tick. After every tick it also arms a timer for the moment the tick said
 * something here is next due (a delayed task, the end of a wait, a check), which no event announces. The timer unit stays
 * as the fallback. The stream carries no task data; a tick reads the board as it always does.
 */
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { getPaths } from '../config/config.mts';
import { requireFeature } from '../backend/backend.mts';
import type { Fetch } from '../backend/backend.mts';
import { verifyContract } from '../backend/contract-check.mts';
import { holdEventStream, realTimers } from '../backend/event-stream.mts';
import type { StreamOptions, Timers } from '../backend/event-stream.mts';
import { loadWebConfig } from '../backend/web-config.mts';
import type { WebConfig } from '../backend/web-config.mts';
import { print } from '../cli.mts';
import { selfCommand } from '../self/self.mts';
import { errorText } from '../output/text.mts';
import { groupExists, signalGroup } from '../worker/process.mts';
import { createRunFiles, lockDir } from '../worker/runtime.mts';
import { TICK_GRACE_S, TICK_LIMIT_S, lockFileName } from './tick.mts';

// Exit code of `flock -E 75`: the timer's tick holds the lock.
const LOCKED = 75;
// What `timeout` answered when it stopped a command, and what runLimited answers in its place: TERM, and after the grace period KILL.
const TIMED_OUT = 124;
const KILLED = 137;

export interface TickerOptions {
  // One dispatch tick: its exit code.
  run: () => Promise<number>;
  timers: Timers;
  log: (line: string) => void;
  debounceMs: number;
  retryMs: number;
  // When the last tick said something is next due (ms, on the clock of `timers`); undefined when nothing is.
  nextDue: () => number | undefined;
  // The due timer waits at least this long, so a time that stays in the past cannot start tick after tick.
  dueFloorMs: number;
  // And at most this long: a time further off is read again then.
  dueMaxMs: number;
}

export interface Ticker {
  // A tick right away (after a connect).
  now: () => void;
  // A tick after the debounce (after an event); events inside the window share it.
  soon: () => void;
  // Starts no more ticks; resolves when the one that is running has finished.
  stop: () => Promise<void>;
}

// Ticks never overlap: what arrives during one is a single dirty flag, and one more tick follows.
export function createTicker({
  run,
  timers,
  log,
  debounceMs,
  retryMs,
  nextDue,
  dueFloorMs,
  dueMaxMs,
}: TickerOptions): Ticker {
  let cancelPending: (() => void) | undefined;
  let cancelDue: (() => void) | undefined;
  let running = false;
  let dirty = false;
  let stopped = false;
  let current: Promise<void> | undefined;

  const clearPending = (): void => {
    cancelPending?.();
    cancelPending = undefined;
  };
  const clearDue = (): void => {
    cancelDue?.();
    cancelDue = undefined;
  };
  const tickNow = (): void => {
    if (running) dirty = true;
    else {
      clearPending();
      void start();
    }
  };
  // A tick the timer unit started rewrites the time as well, so it is read again when the timer fires: a later one arms
  // again, anything else (due, or gone with a tick under way) ticks.
  const armDue = (): void => {
    clearDue();
    const at = stopped ? undefined : nextDue();
    if (at === undefined) return;
    cancelDue = timers.after(Math.min(dueMaxMs, Math.max(dueFloorMs, at - timers.now())), () => {
      cancelDue = undefined;
      const again = nextDue();
      if (again !== undefined && again > timers.now()) armDue();
      else tickNow();
    });
  };
  const schedule = (ms: number): void => {
    clearPending();
    cancelPending = timers.after(ms, () => {
      cancelPending = undefined;
      void start();
    });
  };
  function start(): Promise<void> {
    current = tick();
    return current;
  }
  async function tick(): Promise<void> {
    if (stopped) return;
    running = true;
    dirty = false;
    // The tick writes the next due time; it is armed again once the tick is over.
    clearDue();
    const started = timers.now();
    let code: number | undefined;
    try {
      code = await run();
    } catch (error) {
      log(`tick could not start: ${errorText(error)}`);
    }
    running = false;
    if (code === LOCKED) {
      log(`tick: the timer's tick holds the lock, retrying in ${retryMs / 1000} s`);
      schedule(retryMs);
      return;
    }
    if (code === TIMED_OUT || code === KILLED)
      log(`tick: stopped after ${TICK_LIMIT_S} s (exit ${code}), the dispatch hung; the next one starts clean`);
    else if (code !== undefined) log(`tick: exit ${code} after ${((timers.now() - started) / 1000).toFixed(1)} s`);
    if (dirty) void start();
    else armDue();
  }
  return {
    now: tickNow,
    soon() {
      if (running) dirty = true;
      else schedule(debounceMs);
    },
    stop() {
      stopped = true;
      clearPending();
      clearDue();
      return current ?? Promise.resolve();
    },
  };
}

export interface ListenerOptions extends StreamOptions {
  debounceMs: number;
  retryMs: number;
  dueFloorMs: number;
  dueMaxMs: number;
}

export const LISTENER_OPTIONS: ListenerOptions = {
  idleMs: 60_000,
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
  healthyMs: 30_000,
  debounceMs: 1000,
  retryMs: 5000,
  dueFloorMs: 5000,
  // Node's timers take at most about 24 days; a delayed task may wait months.
  dueMaxMs: 60 * 60_000,
};

export interface ListenerDeps {
  timers: Timers;
  // 0 to 1, for the backoff jitter.
  random: () => number;
  log: (line: string) => void;
  // Aborted on SIGTERM.
  signal: AbortSignal;
  // Checks the contract version with a POST, like every other command; throws on a mismatch.
  verify: () => Promise<Pick<WebConfig, 'url' | 'token'>>;
  fetch: Fetch;
  runTick: () => Promise<number>;
  // What the last tick wrote to the run directory as the next due time (ms).
  nextDue: () => number | undefined;
  options?: Partial<ListenerOptions>;
}

// Runs until `signal` aborts (exit code 0) or the board no longer serves this CLI (1: systemd or launchd restarts it, on new code after an update).
export async function runListener(deps: ListenerDeps): Promise<number> {
  const { timers, log, signal } = deps;
  const options = { ...LISTENER_OPTIONS, ...deps.options };
  const ticker = createTicker({ run: deps.runTick, timers, log, nextDue: deps.nextDue, ...options });
  try {
    const code = await holdEventStream({
      timers,
      random: deps.random,
      log,
      signal,
      verify: deps.verify,
      fetch: deps.fetch,
      options,
      onConnect: () => ticker.now(),
      onTasks: () => ticker.soon(),
    });
    if (code !== 0) return code;
  } finally {
    // A tick between claiming a task and starting its worker must not be cut off: systemd kills what is left once this exits.
    // The listener unit's stop timeout (LISTEN_STOP_TIMEOUT_S) covers a whole tick.
    await ticker.stop();
  }
  log('stopped');
  return 0;
}

// One dispatch tick as the timer's unit runs it, under the same lock; a separate process, so the dispatch code is the code on disk.
// The lock program: flock on Linux, lockf (which ships with macOS) there. Both exit 75 when the lock is held.
export function tickCommand(
  env: Record<string, string | undefined>,
  dispatch: string[],
  platform: string = process.platform,
): string[] {
  const lock = `${lockDir(env, platform)}/${lockFileName('dispatch')}`;
  if (platform === 'darwin') return ['/usr/bin/lockf', '-s', '-t', '0', lock, ...dispatch];
  return ['flock', '-n', '-E', String(LOCKED), lock, ...dispatch];
}

export interface TickLimits {
  limitMs: number;
  graceMs: number;
}

export const TICK_LIMITS: TickLimits = { limitMs: TICK_LIMIT_S * 1000, graceMs: TICK_GRACE_S * 1000 };

// Runs `argv` as the leader of its own process group with the tick's time limit, which is the listener's to enforce (launchd has none, and no
// `timeout` is needed): SIGTERM to the group after `limitMs`, SIGKILL after `graceMs` more. The exit code is what `timeout -k` gave:
// 124 for a command that was stopped, 137 for one that had to be killed, otherwise the command's own.
export function runLimited(argv: string[], { limitMs, graceMs }: TickLimits): Promise<number> {
  const [program = '', ...args] = argv;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'inherit', detached: true });
    let stopped = false;
    let killed = false;
    let killTimer: NodeJS.Timeout | undefined;
    const limitTimer = setTimeout(() => {
      stopped = true;
      signalGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        killed = true;
        signalGroup(child.pid, 'SIGKILL');
      }, graceMs);
    }, limitMs);
    child.once('error', (error) => {
      clearTimeout(limitTimer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(limitTimer);
      clearTimeout(killTimer);
      // What a stopped tick left in its group goes with it.
      if (stopped && child.pid !== undefined && groupExists(child.pid)) signalGroup(child.pid, 'SIGKILL');
      if (killed) return resolve(KILLED);
      if (stopped) return resolve(TIMED_OUT);
      resolve(code ?? (signal === null ? -1 : 128 + (osConstants.signals[signal] ?? 0)));
    });
  });
}

function spawnTick(env: Record<string, string | undefined>): Promise<number> {
  return runLimited(tickCommand(env, selfCommand('internal', 'dispatch')), TICK_LIMITS);
}

export async function listenMain(): Promise<void> {
  const { configDir } = getPaths();
  const stop = new AbortController();
  const files = createRunFiles();
  for (const name of ['SIGTERM', 'SIGINT'] as const) process.once(name, () => stop.abort());
  process.exitCode = await runListener({
    timers: realTimers,
    random: Math.random,
    log: print,
    signal: stop.signal,
    verify: async () => {
      const config = loadWebConfig(configDir);
      requireFeature((await verifyContract(config)).features, 'events');
      return config;
    },
    fetch: (url, init) => fetch(url, init),
    runTick: () => spawnTick(process.env),
    nextDue: () => files.nextDue()?.getTime(),
  });
}
