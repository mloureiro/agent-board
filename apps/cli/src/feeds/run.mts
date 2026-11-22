import type { Backend, Task } from '@agent-board/shared';
import { BackendError } from '../backend/backend.mts';
import { expandHome } from '../config/config.mts';
import type { DirEntry } from '../config/config.mts';
import { isAllowedDir } from '../config/dirs.mts';
import type { CommandResult, CommandSpec } from '../dispatch/waits.mts';
import { parseScheduleArgs, schedule } from '../commands/schedule.mts';
import { errorText } from '../output/text.mts';
import { MIN_EVERY_MS } from './config.mts';
import type { FeedConfig } from './config.mts';
import { parseItems } from './items.mts';
import type { FeedItem } from './items.mts';
import { HISTORY_LIMIT, zeroCounts } from './store.mts';
import type { FeedControl, FeedRecord, FeedRun, FeedStore } from './store.mts';

export interface FeedRunDeps {
  backend: Backend;
  machine: string;
  dirs: readonly DirEntry[] | undefined;
  store: FeedStore;
  run: (spec: CommandSpec) => Promise<CommandResult>;
  link: (taskId: string) => string;
  now: () => Date;
  log: (line: string) => void;
  signal?: AbortSignal;
}

// `runCommand` keeps this much of stdout; a listing that filled it may have lost its first lines.
const STDOUT_LIMIT = 200_000;
const ERROR_MAX = 300;

const lastLine = (text: string): string => (text.trim().split('\n').at(-1) ?? '').slice(0, ERROR_MAX);

async function listing(deps: FeedRunDeps, feed: FeedConfig): Promise<FeedItem[] | string> {
  const result = await deps.run({
    command: feed.command,
    cwd: feed.dir,
    timeLimitMs: feed.timeoutMs,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  if (result.timedOut) return `the command took longer than ${Math.round(feed.timeoutMs / 1000)}s`;
  if (result.exitCode !== 0)
    return `the command exited ${result.exitCode ?? 'by a signal'}${result.stderr.trim() === '' ? '' : `: ${lastLine(result.stderr)}`}`;
  if (result.stdout.length >= STDOUT_LIMIT) return 'the command printed more than 200 KB';
  const parsed = parseItems(result.stdout);
  return parsed.ok ? parsed.items : parsed.error;
}

const isWaitingFresh = (task: Task | undefined): boolean => task?.status === 'todo' && task.next === 'fresh';

/**
 * One run of a feed: schedules a task per listed item, then moves to Done the Todo task of every item it scheduled before
 * that is no longer listed. A listing that failed closes nothing. Returns undefined when another process is running it.
 */
export async function runFeed(deps: FeedRunDeps, feed: FeedConfig): Promise<FeedRun | undefined> {
  const { store, backend, log } = deps;
  if (!store.lock(feed.name)) return undefined;
  const startedAt = deps.now().toISOString();
  const before = store.readRecord(feed.name);
  const tasks: Record<string, string> = {};
  const finish = (run: FeedRun, kept: Record<string, string>): FeedRun => {
    store.writeRecord(feed.name, {
      last: run,
      history: [run, ...before.history].slice(0, HISTORY_LIMIT),
      tasks: kept,
    });
    return run;
  };
  try {
    const counts = zeroCounts();
    const listed = await listing(deps, feed);
    if (typeof listed === 'string') {
      log(`FEED ${feed.name} failed: ${listed}`);
      return finish({ startedAt, at: deps.now().toISOString(), ok: false, error: listed, counts }, before.tasks);
    }
    counts.listed = listed.length;
    for (const item of listed) {
      const known = before.tasks[item.key];
      if (known !== undefined) tasks[item.key] = known;
    }
    let error: string | undefined;
    const fail = (item: FeedItem, why: string): void => {
      counts.failed++;
      error ??= `${item.key.slice(0, 80)}: ${why}`.slice(0, ERROR_MAX);
      log(`FEED ${feed.name} ${item.key.slice(0, 80)} failed: ${why}`);
    };
    for (const item of listed) {
      const workdir = item.dir === undefined ? feed.dir : expandHome(item.dir);
      if (!isAllowedDir(deps.dirs, workdir)) {
        fail(item, `${workdir.slice(0, 120)} is not a listed directory on ${deps.machine}`);
        continue;
      }
      try {
        const args = parseScheduleArgs(
          {
            key: `${feed.keyPrefix}${item.key}`,
            title: item.title,
            ...(item.version === undefined ? {} : { version: item.version }),
            ...(feed.agent === undefined ? {} : { agent: feed.agent }),
            ...(feed.lane === undefined ? {} : { lane: feed.lane }),
          },
          [item.prompt],
          deps.now(),
        );
        const scheduled = await schedule(
          {
            backend,
            machine: deps.machine,
            workdir,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            print: () => undefined,
            link: deps.link,
            check: () => Promise.resolve(undefined),
            choose: undefined,
          },
          args,
        );
        if (scheduled === undefined) continue;
        tasks[item.key] = scheduled.task.id;
        const outcome = scheduled.keyed;
        if (outcome?.result === 'created') counts.created++;
        if (outcome?.result === 'requeued') counts.requeued++;
        if (outcome !== undefined && outcome.result !== 'exists')
          log(`FEED ${feed.name} ${outcome.result} ${scheduled.task.id} ${item.key.slice(0, 80)}`);
      } catch (thrown) {
        fail(item, errorText(thrown));
      }
    }
    const gone = Object.entries(before.tasks).filter(([key]) => !listed.some((item) => item.key === key));
    if (gone.length > 0) {
      const open = new Map((await backend.listTasks()).map((task) => [task.id, task]));
      for (const [key, id] of gone) {
        if (!isWaitingFresh(open.get(id))) continue;
        try {
          await backend.updateTask(id, { status: 'done', expect: 'todo' });
          counts.closed++;
          log(`FEED ${feed.name} done ${id}: ${key.slice(0, 80)} is no longer listed`);
        } catch (thrown) {
          if (thrown instanceof BackendError && thrown.status === 409) continue;
          tasks[key] = id;
          log(`FEED ${feed.name} cannot move ${id} to done: ${errorText(thrown)}`);
        }
      }
    }
    return finish(
      {
        startedAt,
        at: deps.now().toISOString(),
        ok: counts.failed === 0,
        ...(error === undefined ? {} : { error }),
        counts,
      },
      tasks,
    );
  } catch (thrown) {
    // Recorded like a failed listing, so the feed waits for its interval instead of trying again on every scan.
    const message = errorText(thrown).slice(0, ERROR_MAX);
    log(`FEED ${feed.name} failed: ${message}`);
    return finish(
      { startedAt, at: deps.now().toISOString(), ok: false, error: message, counts: zeroCounts() },
      { ...before.tasks, ...tasks },
    );
  } finally {
    store.unlock(feed.name);
  }
}

export function runAsked(control: FeedControl, record: FeedRecord): boolean {
  if (control.runRequestedAt === undefined) return false;
  return record.last === undefined || Date.parse(control.runRequestedAt) > Date.parse(record.last.startedAt);
}

/**
 * Whether a feed should run now. A request beats the pause, but a run starts at most once every `MIN_EVERY_MS`; otherwise
 * the feed runs when it never ran or its interval since the last start has passed, and not while paused.
 */
export function isFeedDue(feed: FeedConfig, control: FeedControl, record: FeedRecord, now: Date): boolean {
  const sinceStart = record.last === undefined ? undefined : now.getTime() - Date.parse(record.last.startedAt);
  if (runAsked(control, record) && (sinceStart === undefined || sinceStart >= MIN_EVERY_MS)) return true;
  return !control.paused && (sinceStart === undefined || sinceStart >= feed.everyMs);
}
