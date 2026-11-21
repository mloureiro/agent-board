import type { Backend, Task } from '@agent-board/shared';
import { BackendError } from '../backend/backend.mts';
import { expandHome } from '../config/config.mts';
import type { DirEntry } from '../config/config.mts';
import { isAllowedDir } from '../config/dirs.mts';
import type { CommandResult, CommandSpec } from '../dispatch/waits.mts';
import { parseScheduleArgs, schedule } from '../commands/schedule.mts';
import { errorText } from '../output/text.mts';
import type { SourceConfig } from './config.mts';
import { parseItems } from './items.mts';
import type { SourceItem } from './items.mts';
import { zeroCounts } from './store.mts';
import type { SourceRun, SourceStore } from './store.mts';

export interface SourceRunDeps {
  backend: Backend;
  machine: string;
  dirs: readonly DirEntry[] | undefined;
  store: SourceStore;
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

async function listing(deps: SourceRunDeps, source: SourceConfig): Promise<SourceItem[] | string> {
  const result = await deps.run({
    command: source.command,
    cwd: source.dir,
    timeLimitMs: source.timeoutMs,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  if (result.timedOut) return `the command took longer than ${Math.round(source.timeoutMs / 1000)}s`;
  if (result.exitCode !== 0)
    return `the command exited ${result.exitCode ?? 'by a signal'}${result.stderr.trim() === '' ? '' : `: ${lastLine(result.stderr)}`}`;
  if (result.stdout.length >= STDOUT_LIMIT) return 'the command printed more than 200 KB';
  const parsed = parseItems(result.stdout);
  return parsed.ok ? parsed.items : parsed.error;
}

// A task waits in Todo for a fresh start: no worker took it, and it was not answered, paused or woken.
const isWaitingFresh = (task: Task | undefined): boolean => task?.status === 'todo' && task.next === 'fresh';

/**
 * One run of a source: schedules a task per listed item, then moves to Done the Todo task of every item it scheduled before
 * that is no longer listed. A listing that failed closes nothing. Returns undefined when another process is running it.
 */
export async function runSource(deps: SourceRunDeps, source: SourceConfig): Promise<SourceRun | undefined> {
  const { store, backend, log } = deps;
  if (!store.lock(source.name)) return undefined;
  try {
    const before = store.read(source.name);
    const counts = zeroCounts();
    const listed = await listing(deps, source);
    if (typeof listed === 'string') {
      const run: SourceRun = { at: deps.now().toISOString(), ok: false, error: listed, counts };
      log(`SOURCE ${source.name} failed: ${listed}`);
      store.write(source.name, { ...store.read(source.name), runNow: false, last: run });
      return run;
    }
    counts.listed = listed.length;
    const tasks: Record<string, string> = {};
    let error: string | undefined;
    const fail = (item: SourceItem, why: string): void => {
      counts.failed++;
      error ??= `${item.key.slice(0, 80)}: ${why}`.slice(0, ERROR_MAX);
      log(`SOURCE ${source.name} ${item.key.slice(0, 80)} failed: ${why}`);
    };
    for (const item of listed) {
      const workdir = item.dir === undefined ? source.dir : expandHome(item.dir);
      if (!isAllowedDir(deps.dirs, workdir)) {
        fail(item, `${workdir.slice(0, 120)} is not a listed directory on ${deps.machine}`);
        continue;
      }
      try {
        const args = parseScheduleArgs(
          {
            key: `${source.keyPrefix}${item.key}`,
            title: item.title,
            ...(item.version === undefined ? {} : { version: item.version }),
            ...(source.agent === undefined ? {} : { agent: source.agent }),
            ...(source.lane === undefined ? {} : { lane: source.lane }),
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
          log(`SOURCE ${source.name} ${outcome.result} ${scheduled.task.id} ${item.key.slice(0, 80)}`);
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
          log(`SOURCE ${source.name} done ${id}: ${key.slice(0, 80)} is no longer listed`);
        } catch (thrown) {
          if (thrown instanceof BackendError && thrown.status === 409) continue;
          // Kept, so the next run tries again.
          tasks[key] = id;
          log(`SOURCE ${source.name} cannot move ${id} to done: ${errorText(thrown)}`);
        }
      }
    }
    const run: SourceRun = {
      at: deps.now().toISOString(),
      ok: counts.failed === 0,
      ...(error === undefined ? {} : { error }),
      counts,
    };
    // Read again: `board sources pause` may have written meanwhile.
    store.write(source.name, { ...store.read(source.name), runNow: false, last: run, tasks });
    return run;
  } catch (thrown) {
    // Recorded like a failed listing, so the source waits for its interval instead of trying again on every scan.
    const run: SourceRun = {
      at: deps.now().toISOString(),
      ok: false,
      error: errorText(thrown).slice(0, ERROR_MAX),
      counts: zeroCounts(),
    };
    log(`SOURCE ${source.name} failed: ${run.error}`);
    store.write(source.name, { ...store.read(source.name), runNow: false, last: run });
    return run;
  } finally {
    store.unlock(source.name);
  }
}

/** Whether a source should run now: asked for, or its interval has passed since the last run, and it is not paused. */
export function isSourceDue(source: SourceConfig, store: SourceStore, now: Date): boolean {
  const state = store.read(source.name);
  if (state.paused) return false;
  if (state.runNow || state.last === undefined) return true;
  return now.getTime() - Date.parse(state.last.at) >= source.everyMs;
}
