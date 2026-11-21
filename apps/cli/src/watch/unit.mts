// The watch unit (`board internal watch`): one long-running process per machine that looks at every watch on its own timer,
// ends the ones whose time has come, and wakes a task whose event nobody is running to receive. Its state is on disk only
// (see store.mts), so a restart loses nothing but the attempts in flight and the commands of stream watches, which it starts again
// from the beginning (see stream.mts). The dispatcher's tick takes the polling over when
// the heartbeat this unit touches goes stale (see tick.mts).
import { isProcessAlive } from '../worker/process.mts';
import { buildContext, print } from '../cli.mts';
import { errorText } from '../output/text.mts';
import { runCommand } from '../dispatch/waits.mts';
import type { Backend } from '@agent-board/shared';
import { attempt, deadlineReport, isPolled, nextAttemptAt, UNIT_ATTEMPT_LIMIT_MS } from './attempt.mts';
import type { WatchRunner } from './attempt.mts';
import { finishWatch, reportEvent } from './finish.mts';
import { createStreamSession, startStream } from './stream.mts';
import type { StreamSession, StreamStarter } from './stream.mts';
import { createWatchStore } from './store.mts';
import type { WatchDef, WatchEvent, WatchStore } from './store.mts';
import { publishWatches, PUBLISH_EVERY_MS, REFRESH_MS } from './publish.mts';
import { forgetWakeTries, isRunLive, tryWake } from './wake.mts';
import { getPaths, loadConfig } from '../config/config.mts';
import { createSourceStore } from '../sources/store.mts';
import { dueSourceJobs } from '../sources/scan.mts';
import type { SourceJob } from '../sources/scan.mts';

export const SCAN_MS = 2000;
// Sources are looked at less often than watches: each look reads config.json and every source's state file.
export const SOURCES_SCAN_MS = 15_000;

export interface UnitDeps {
  store: WatchStore;
  backend: Pick<Backend, 'addNote' | 'wake' | 'setWatches'>;
  run: WatchRunner;
  // Starts the command of a stream watch.
  stream: StreamStarter;
  now: () => Date;
  isAlive: (pid: number) => boolean;
  log: (line: string) => void;
  // The runs of the sources that are due (see sources/scan.mts).
  sources?: (signal: AbortSignal) => SourceJob[];
}

export interface WatchUnit {
  // One pass: touches the heartbeat and starts what is due. The attempts and board calls it starts run on, so a slow command or
  // a slow board does not hold the next pass back.
  scan: () => void;
  // Resolves when everything `scan` started has ended.
  settled: () => Promise<void>;
  // Kills the attempts in flight and the commands of the stream watches, which report nothing more.
  stop: () => void;
}

export function createWatchUnit(deps: UnitDeps): WatchUnit {
  const { store, backend, now, isAlive, log } = deps;
  const flights = new Map<string, Promise<void>>();
  const abort = new AbortController();
  // Tasks whose worker was running at the last scan.
  const wasLive = new Set<string>();
  const reported = new Set<string>();
  // Tasks whose published state is behind the store, and when each was last published.
  const stale = new Set<string>();
  const publishedAt = new Map<string, number>();
  // The running commands of the stream watches, by the key of their watch.
  const streams = new Map<string, { task: string; name: string; id: string; session: StreamSession }>();
  let sourcesScannedAt = Number.NEGATIVE_INFINITY;

  const publish = async (task: string): Promise<void> => {
    stale.delete(task);
    publishedAt.set(task, now().getTime());
    await publishWatches({ store, backend, now, log }, task);
  };

  const isPublishDue = (task: string): boolean =>
    stale.has(task) && now().getTime() - (publishedAt.get(task) ?? 0) >= PUBLISH_EVERY_MS;

  const launch = (key: string, job: () => Promise<void>): void => {
    if (flights.has(key)) return;
    const flight = job()
      .catch((error: unknown) => log(`WARN ${key} failed: ${errorText(error)}`))
      .finally(() => flights.delete(key));
    flights.set(key, flight);
  };

  const wake = (task: string): Promise<void> =>
    tryWake({ store, backend, now, log, isAlive }, task).then(() => undefined);

  const finish = async (def: WatchDef, report: { kind: WatchEvent['kind']; text: string }): Promise<void> => {
    if ((await finishWatch({ store, backend, now, log }, def, report)) === undefined) return;
    await publish(def.task);
    await wake(def.task);
  };

  const look = async (def: WatchDef): Promise<void> => {
    const result = await attempt(def, now(), {
      run: deps.run,
      timeLimitMs: UNIT_ATTEMPT_LIMIT_MS,
      signal: abort.signal,
    });
    if (abort.signal.aborted) return;
    if (result.kind === 'event') return finish(def, { kind: 'event', text: result.text });
    const summary = result.kind === 'pending' ? result.summary : result.reason;
    if (summary !== def.last?.summary || now().getTime() - (publishedAt.get(def.task) ?? 0) >= REFRESH_MS)
      stale.add(def.task);
    store.update({
      ...(result.kind === 'pending' && result.def ? result.def : def),
      last: { at: now().toISOString(), summary },
    });
    if (isPublishDue(def.task)) await publish(def.task);
  };

  type StreamDef = WatchDef & { source: { kind: 'stream' } };

  // Starts the command of a stream watch that has none in this process: a new watch, or one from before this unit started.
  const startStreamOf = (def: StreamDef, key: string): void => {
    const { source } = def;
    const restarted = source.starts > 0;
    const started: WatchDef = {
      ...def,
      source: { ...source, starts: source.starts + 1 },
      last: { at: now().toISOString(), summary: restarted ? 'started again' : 'started' },
    };
    if (!store.update(started)) return;
    const session = createStreamSession({ now, restarted });
    streams.set(key, { task: def.task, name: def.name, id: def.id, session });
    session.attach(
      deps.stream(
        {
          command: source.command,
          cwd: source.cwd,
          ...(source.settingsDir === undefined ? {} : { settingsDir: source.settingsDir }),
        },
        session,
      ),
    );
    log(`STREAM ${def.task} ${def.name} started${restarted ? ' again from the beginning' : ''}`);
    stale.add(def.task);
  };

  // An event of a stream whose command runs on.
  const reportLines = async (def: StreamDef, text: string): Promise<void> => {
    const counted: WatchDef = {
      ...def,
      source: { ...def.source, events: def.source.events + 1 },
      last: { at: now().toISOString(), summary: 'streaming' },
    };
    // Gone or replaced meanwhile: the next scan kills the command.
    if (!store.update(counted)) return;
    await reportEvent({ store, backend, now, log }, counted, text);
    stale.add(def.task);
    if (isPublishDue(def.task)) await publish(def.task);
    await wake(def.task);
  };

  const scanStream = (def: StreamDef, key: string): void => {
    // A stopped unit starts nothing. And while the event before this one is on its way to the board, the lines wait.
    if (abort.signal.aborted || flights.has(key)) return;
    const running = streams.get(key);
    if (running === undefined) return startStreamOf(def, key);
    const report = running.session.step();
    if (report === undefined) return;
    const { end } = report;
    if (end === undefined) return launch(key, () => reportLines(def, report.text));
    streams.delete(key);
    launch(key, () => finish(def, { kind: end, text: report.text }));
  };

  // Kills the commands whose watch is gone: stopped, timed out, replaced, or dropped with its task.
  const reapStreams = (): void => {
    for (const [key, { task, name, id, session }] of streams) {
      if (store.read(task, name)?.id === id) continue;
      session.kill();
      streams.delete(key);
      log(`STREAM ${task} ${name} stopped: its watch is gone`);
    }
  };

  const scanTask = (task: string): void => {
    const { defs, unreadable } = store.list(task);
    for (const file of unreadable) {
      if (reported.has(`${task}/${file}`)) continue;
      reported.add(`${task}/${file}`);
      log(`WARN ${task}/${file} cannot be read and is skipped`);
    }
    const at = now().getTime();
    for (const def of defs) {
      const key = `${task}/${def.name}/${def.id}`;
      if (at >= Date.parse(def.deadline)) launch(key, () => finish(def, deadlineReport(def)));
      else if (def.source.kind === 'stream') scanStream({ ...def, source: def.source }, key);
      else if (isPolled(def) && at >= nextAttemptAt(def)) launch(key, () => look(def));
    }
    if (isPublishDue(task)) launch(`${task}/publish`, () => publish(task));
    if (isRunLive(store, task, isAlive)) {
      wasLive.add(task);
      return;
    }
    // The worker went away with events pending: a wake tried while it ran did not count.
    if (wasLive.delete(task)) forgetWakeTries(store, task);
    if (store.events(task).some(({ event }) => event.wakeTriedAt === undefined))
      launch(`${task}/wake`, () => wake(task));
  };

  return {
    scan() {
      store.touchHeartbeat(now());
      reapStreams();
      for (const task of store.tasks()) scanTask(task);
      if (deps.sources !== undefined && now().getTime() - sourcesScannedAt >= SOURCES_SCAN_MS) {
        sourcesScannedAt = now().getTime();
        for (const { key, job } of deps.sources(abort.signal)) launch(key, job);
      }
    },
    async settled() {
      while (flights.size > 0) await Promise.all([...flights.values()]);
    },
    stop() {
      abort.abort();
      for (const { session } of streams.values()) session.kill();
      streams.clear();
    },
  };
}

// Waits `ms`, or until `signal` aborts.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Scans every `scanMs` until `signal` aborts, then kills the attempts in flight and waits for them. */
export async function runWatchUnit(
  deps: UnitDeps,
  signal: AbortSignal,
  {
    scanMs = SCAN_MS,
    wait = sleep,
  }: { scanMs?: number; wait?: (ms: number, signal: AbortSignal) => Promise<void> } = {},
): Promise<void> {
  const unit = createWatchUnit(deps);
  deps.log('watch unit started');
  while (!signal.aborted) {
    try {
      unit.scan();
    } catch (error) {
      deps.log(`WARN scan failed: ${errorText(error)}`);
    }
    await wait(scanMs, signal);
  }
  unit.stop();
  await unit.settled();
  deps.log('watch unit stopped');
}

export async function watchUnitMain(): Promise<void> {
  const context = buildContext(false);
  const { backend } = context;
  const stop = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT'] as const) process.once(name, () => stop.abort());
  const { configFile } = getPaths();
  const sourceStore = createSourceStore(undefined, isProcessAlive);
  await runWatchUnit(
    {
      store: createWatchStore(),
      backend,
      run: (job) => runCommand(job),
      stream: (job, sink) => startStream(job, sink),
      now: () => new Date(),
      isAlive: isProcessAlive,
      log: print,
      sources: (signal) =>
        dueSourceJobs(
          {
            backend,
            machine: context.config.machine,
            dirs: loadConfig(configFile).dirs,
            store: sourceStore,
            run: (spec) => runCommand(spec),
            link: context.taskLink,
            now: () => new Date(),
            log: print,
            signal,
          },
          configFile,
        ),
    },
    stop.signal,
  );
}
