import { MAX_HISTORY_RUNS, isSafeWorkdir } from '@agent-board/shared';
import type { Backend, FeedTaskOutcome, Task } from '@agent-board/shared';
import { BackendError } from '../backend/backend.mts';
import { expandHome } from '../config/config.mts';
import type { DirEntry } from '../config/config.mts';
import { isAllowedDir } from '../config/dirs.mts';
import type { CommandResult, CommandSpec } from '../dispatch/waits.mts';
import { KEY_MAX, parseScheduleArgs, scheduleKeyed } from '../commands/schedule.mts';
import { errorText } from '../output/text.mts';
import type { Resolved } from '../plugins/resolve.mts';
import { MIN_EVERY_MS } from './config.mts';
import type { FeedConfig } from './config.mts';
import { list } from './integration.mts';
import { parseItems, undeclaredField } from './items.mts';
import type { FeedItem } from './items.mts';
import { LAST_TASKS_LIMIT, zeroCounts } from './store.mts';
import type { FeedControl, FeedRecord, FeedRun, FeedStore } from './store.mts';
import { oneLine, render } from './template.mts';
import type { FeedUpdates } from './updates.mts';
import { validateFeed } from './validate.mts';

export interface FeedRunDeps {
  backend: Backend;
  machine: string;
  dirs: readonly DirEntry[] | undefined;
  repos: Readonly<Record<string, string>>;
  store: FeedStore;
  updates: FeedUpdates;
  run: (spec: CommandSpec) => Promise<CommandResult>;
  resolve: (ref: string) => Resolved;
  link: (taskId: string) => string;
  now: () => Date;
  log: (line: string) => void;
  signal?: AbortSignal;
}

const ERROR_MAX = 300;

const isWaitingFresh = (task: Task | undefined): boolean => task?.status === 'todo' && task.next === 'fresh';

function workdirOf(feed: FeedConfig, item: FeedItem, repos: Readonly<Record<string, string>>): string {
  if (item.dir !== undefined) return expandHome(item.dir);
  if (item.repo !== undefined && Object.hasOwn(repos, item.repo)) return repos[item.repo] ?? feed.dir;
  return feed.dir;
}

/**
 * One run of a feed: validates it, schedules a task per listed item, then moves to Done the Todo task of every item it
 * scheduled before that is no longer listed. A feed that does not validate, or a listing that failed, schedules and closes
 * nothing. Returns undefined when another process is running it.
 */
export async function runFeed(deps: FeedRunDeps, feed: FeedConfig): Promise<FeedRun | undefined> {
  const { store, backend, log } = deps;
  if (!store.lock(feed.name)) return undefined;
  const startedAt = deps.now().toISOString();
  const before = store.readRecord(feed.name);
  const tasks: Record<string, string> = {};
  const finish = (run: FeedRun, kept: Record<string, string>): FeedRun => {
    const { tasks: _tasks, ...summary } = run;
    store.writeRecord(feed.name, {
      last: { ...run, tasks: run.tasks ?? [] },
      history: [summary, ...before.history].slice(0, MAX_HISTORY_RUNS),
      tasks: kept,
    });
    return run;
  };
  try {
    const counts = zeroCounts();
    const validated = await validateFeed(feed, { resolve: deps.resolve, run: deps.run });
    if (!validated.ok) {
      log(`FEED ${feed.name} is invalid: ${validated.reason}`);
      return finish(
        { startedAt, at: deps.now().toISOString(), ok: false, invalid: true, error: validated.reason, counts },
        before.tasks,
      );
    }
    const listed = await listing(deps, feed, validated.program);
    if (typeof listed === 'string') {
      log(`FEED ${feed.name} failed: ${listed}`);
      return finish({ startedAt, at: deps.now().toISOString(), ok: false, error: listed, counts }, before.tasks);
    }
    counts.listed = listed.length;
    for (const item of listed) {
      const known = before.tasks[item.key];
      if (known !== undefined) tasks[item.key] = known;
    }
    const changed: FeedTaskOutcome[] = [];
    const note = (id: string, outcome: FeedTaskOutcome['outcome']): void => {
      if (changed.length < LAST_TASKS_LIMIT) changed.push({ id, outcome });
    };
    let error: string | undefined;
    const fail = (item: FeedItem, why: string): void => {
      counts.failed++;
      error ??= oneLine(`${item.key.slice(0, 80)}: ${why}`, ERROR_MAX);
      log(`FEED ${feed.name} ${oneLine(item.key.slice(0, 80), ERROR_MAX)} failed: ${oneLine(why, ERROR_MAX)}`);
    };
    for (const item of listed) {
      const key = `feed:${feed.name}:${item.key}`;
      if (key.length > KEY_MAX) {
        fail(item, `its key is longer than ${KEY_MAX} characters with the feed's prefix`);
        continue;
      }
      const undeclared = undeclaredField(item, validated.fields);
      if (undeclared !== undefined) {
        fail(item, `field ${undeclared} was not declared by ${feed.integration} ${feed.action}`);
        continue;
      }
      const values = {
        key: item.key,
        title: item.title,
        ...(item.version === undefined ? {} : { version: item.version }),
        ...item.fields,
      };
      const prompt = render(feed.prompts.new, values);
      if (!prompt.ok) {
        fail(item, `it has no field ${prompt.missing}`);
        continue;
      }
      const update = render(feed.prompts.update, values);
      if (!update.ok) {
        fail(item, `it has no field ${update.missing}`);
        continue;
      }
      const workdir = workdirOf(feed, item, deps.repos);
      if (!isSafeWorkdir(workdir) || !isAllowedDir(deps.dirs, workdir)) {
        fail(item, `${workdir.slice(0, 120)} is not a listed directory on ${deps.machine}`);
        continue;
      }
      try {
        const args = parseScheduleArgs(
          {
            key,
            title: item.title,
            ...(item.version === undefined ? {} : { version: item.version }),
            ...(feed.agent === undefined ? {} : { agent: feed.agent }),
            ...(feed.lane === undefined ? {} : { lane: feed.lane }),
          },
          [prompt.text],
          deps.now(),
        );
        if (item.notBefore !== undefined) args.notBefore = new Date(item.notBefore);
        const scheduled = await scheduleKeyed(
          { backend, machine: deps.machine, workdir, print: () => undefined, link: deps.link },
          args,
          key,
          {
            prompt: update.text,
            spool: {
              put: (taskId, text) => deps.updates.put(taskId, text, feed.name),
              drop: deps.updates.drop,
            },
          },
        );
        tasks[item.key] = scheduled.task.id;
        const outcome = scheduled.keyed;
        if (outcome === undefined || outcome.result === 'exists') continue;
        counts[outcome.result]++;
        note(scheduled.task.id, outcome.result);
        log(`FEED ${feed.name} ${outcome.result} ${scheduled.task.id} ${oneLine(item.key.slice(0, 80), ERROR_MAX)}`);
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
          note(id, 'closed');
          log(`FEED ${feed.name} done ${id}: ${oneLine(key.slice(0, 80), ERROR_MAX)} is no longer listed`);
        } catch (thrown) {
          if (thrown instanceof BackendError && thrown.status === 409) continue;
          tasks[key] = id;
          log(`FEED ${feed.name} cannot move ${id} to done: ${oneLine(errorText(thrown), ERROR_MAX)}`);
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
        tasks: changed,
      },
      tasks,
    );
  } catch (thrown) {
    // Recorded like a failed listing, so the feed waits for its interval instead of trying again on every scan.
    const message = oneLine(errorText(thrown), ERROR_MAX);
    log(`FEED ${feed.name} failed: ${message}`);
    return finish(
      { startedAt, at: deps.now().toISOString(), ok: false, error: message, counts: zeroCounts() },
      { ...before.tasks, ...tasks },
    );
  } finally {
    store.unlock(feed.name);
  }
}

async function listing(deps: FeedRunDeps, feed: FeedConfig, program: string): Promise<FeedItem[] | string> {
  const result = await list(program, feed.action, feed.options, feed.dir, deps.run, feed.timeoutMs, deps.signal);
  if (!result.ok) return oneLine(result.reason, ERROR_MAX);
  const parsed = parseItems(result.stdout);
  return parsed.ok ? parsed.items : oneLine(parsed.error, ERROR_MAX);
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
