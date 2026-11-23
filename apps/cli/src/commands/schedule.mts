// `board schedule [--priority p] [--model m] [--effort e] [--icon i] [--label l]... [--lane l] [--auto-done] [--agent a] [--title t] [--hold | --backlog] [--in <dur> | --at <time>] [--every <dur> | --cron <expr>]
// [--times <n> | --until <time>] [--polish] [--new] [--key <k> [--version <v>]] <prompt...>`: a task from a prompt, written as you
// would type it into Claude Code, bound to this machine and the directory it was scheduled from. Before it creates one, a quick
// Haiku call checks whether an open task already covers it. With `--every` or `--cron` it creates a repeating schedule instead.
// With `--polish` the task goes to Backlog and a child task that polishes its prompt is queued, as the board's "Polish prompt"
// button does. With `--key` the board itself dedupes by the key, and `--version` requeues the task when the version moved:
// what a script that runs `board schedule` again and again needs.
import { execFile } from 'node:child_process';
import {
  AGENT_NAME_RULE,
  ContractError,
  defaultTitle,
  describeRule,
  EFFORTS,
  checkLabels,
  ICON_RULE,
  isAgentName,
  isEffort,
  isEmojiIcon,
  isModelName,
  isPriority,
  isRecord,
  isSafeLane,
  isSafeTaskId,
  MACHINE_NAME_RULE,
  MAX_SCHEDULE_CONCURRENT,
  MAX_SCHEDULE_CRONS,
  MODEL_ALIASES,
  parseDuration,
  parseWhen,
  polishTask,
  PRIORITIES,
} from '@agent-board/shared';
import type { Command } from 'commander';
import type { Backend, DraftStatus, Effort, Priority, Schedule, ScheduleDraft, Task } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { BackendError } from '../backend/backend.mts';
import { plainLine } from '../output/terminal.mts';

export interface ScheduleArgs {
  prompt: string;
  priority: Priority | undefined;
  // The Claude model of the run; undefined is claude's default.
  model: string | undefined;
  // The effort level of the run; undefined is claude's default.
  effort: Effort | undefined;
  icon: string | undefined;
  // The user's labels; undefined is none.
  labels: string[] | undefined;
  // The lane the task asks for; undefined is the default lane of the machine that takes it.
  lane: string | undefined;
  // The agent may move the task to Done itself; false leaves it unset.
  autoDone: boolean;
  // The agent of this machine's config.json the task runs as; undefined runs it by its creator's rules.
  agent: string | undefined;
  title: string | undefined;
  // Waits in Needs me instead of Todo.
  hold: boolean;
  // Parked in Backlog instead of Todo.
  backlog: boolean;
  // Waits in Todo until then (`--in`, `--at`); with a repeat, the first run.
  notBefore: Date | undefined;
  // A repeat: the interval in ms (`--every`), 5-field cron expressions (`--cron`, the first one and the others), or another
  // schedule to run after (`--after`, an id or the start of one) with a delay in ms (`--delay`), ending after `times` runs or at
  // `until`.
  every: number | undefined;
  cron: string | undefined;
  moreCrons: string[];
  after: string | undefined;
  delay: number | undefined;
  // At most this many cards of a repeat under way at once.
  maxConcurrent: number | undefined;
  times: number | undefined;
  until: Date | undefined;
  // Skips the duplicate check.
  forceNew: boolean;
  // Parks it in Backlog and queues a task that polishes its prompt.
  polish: boolean;
  // The board creates one task per key; asking again finds it. `version` is what the task was made for (a PR's head sha).
  key: string | undefined;
  version: string | undefined;
}

// The flags `board schedule` takes before the prompt, as commander hands them over.
export interface ScheduleFlags {
  priority?: string;
  model?: string;
  effort?: string;
  icon?: string;
  // Repeatable: one string per `--label`.
  label?: string[];
  lane?: string;
  autoDone?: boolean;
  agent?: string;
  title?: string;
  hold?: boolean;
  backlog?: boolean;
  new?: boolean;
  polish?: boolean;
  in?: string;
  at?: string;
  every?: string;
  // Repeatable: one string per `--cron`; a caller may also hand over a single one.
  cron?: string | string[];
  after?: string;
  delay?: string;
  maxConcurrent?: string;
  times?: string;
  until?: string;
  key?: string;
  version?: string;
}

export const KEY_MAX = 500;
const VERSION_MAX = 200;

export function addScheduleOptions(command: Command): Command {
  return command
    .option('--priority <priority>', `${PRIORITIES.join(', ')} (default normal)`)
    .option(
      '--model <model>',
      `claude model alias or full name, e.g. ${MODEL_ALIASES.map((alias) => alias.value).join(', ')} (default: claude's default)`,
    )
    .option('--effort <level>', `claude effort level: ${EFFORTS.join(', ')} (default: claude's default)`)
    .option('--icon <emoji>', 'one emoji shown at the left of the title on the board card (default: none)')
    .option(
      '--label <label>',
      'a label shown on the board card; repeatable (default: none)',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      '--lane <name>',
      "the lane of the machine that runs the task (default: that machine's default lane; a machine without the lane uses its default one)",
    )
    .option(
      '--auto-done',
      'let the agent move the task to Done itself when it judges every acceptance criterion met (default: it ends in needs-me)',
    )
    .option(
      '--agent <name>',
      "run the task as this agent of this machine's config.json (its tools and lists only, never asking); the board keeps the name sealed",
    )
    .option('--title <title>', "the task's title (default: the prompt's first line)")
    .option('--hold', 'land it in needs-me instead of Todo')
    .option('--backlog', 'park it in backlog instead of Todo')
    .option('--in <duration>', 'keep it in Todo for this long (30m, 2h, 1d, 1h30m); with a repeat, the first run')
    .option(
      '--at <time>',
      'keep it in Todo until then (2027-01-01T12:00, 2027-01-01, 09:30); with a repeat, the first run',
    )
    .option('--every <duration>', 'repeat on a fixed grid from the first run (2h)')
    .option(
      '--cron <expr>',
      'repeat by a 5-field cron expression in this machine\'s time zone ("0 9 * * 1-5"); give it up to 10 times to run when any matches',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      '--after <schedule>',
      "a schedule that runs after another: its task is made when a task of that schedule finishes (the schedule's id or the start of it)",
    )
    .option('--delay <duration>', "with --after: start this long after the other schedule's task finished (10m, 2h)")
    .option(
      '--max-concurrent <n>',
      'with a repeat: at most this many tasks of the schedule running or waiting at once; the next one stays in Todo until a slot is free',
    )
    .option('--times <n>', 'end a repeat after this many runs, the first included')
    .option('--until <time>', 'end a repeat after this time')
    .option('--polish', 'park it in backlog and queue a task that polishes its prompt, as "Polish prompt" on the board')
    .option('--new', 'skip the duplicate check')
    .option(
      '--key <key>',
      'one task per key on the board: a second schedule with the same key finds the first instead of making another, with no duplicate check',
    )
    .option(
      '--version <version>',
      'with --key: what the task was made for (a PR head sha); a task in needs-me or done goes back to Todo when it differs',
    );
}

// The flags are the board's own; the words after them are the prompt, flags included (`--auto`).
export function parseScheduleArgs(flags: ScheduleFlags, words: string[], now: Date = new Date()): ScheduleArgs {
  const hold = flags.hold === true;
  const polish = flags.polish === true;
  // A polished prompt can only be applied to a Backlog task.
  const backlog = flags.backlog === true || polish;
  const { in: delay, at, every, times, until } = flags;
  const crons = [flags.cron ?? []].flat().map((expression) => expression.trim());
  const cron = crons[0];
  if (flags.after !== undefined) {
    const conflicts = [
      every !== undefined && '--every',
      crons.length > 0 && '--cron',
      delay !== undefined && '--in',
      at !== undefined && '--at',
      hold && '--hold',
      flags.backlog === true && '--backlog',
      flags.key !== undefined && '--key',
      polish && '--polish',
    ].filter((flag) => flag !== false);
    if (conflicts.length > 0)
      throw new UsageError(
        `--after makes a schedule that waits for another one; it cannot be combined with ${conflicts.join(', ')}`,
      );
  }
  if (flags.delay !== undefined && flags.after === undefined) throw new UsageError('--delay belongs to --after');
  if (polish) {
    const conflicts = [
      hold && '--hold',
      delay !== undefined && '--in',
      at !== undefined && '--at',
      every !== undefined && '--every',
      crons.length > 0 && '--cron',
      times !== undefined && '--times',
      until !== undefined && '--until',
    ].filter((flag) => flag !== false);
    if (conflicts.length > 0)
      throw new UsageError(
        `--polish parks the task in Backlog, where its polished prompt is applied; it cannot be combined with ${conflicts.join(', ')}`,
      );
  }
  const result: ScheduleArgs = {
    prompt: '',
    priority: undefined,
    model: undefined,
    effort: undefined,
    icon: undefined,
    labels: undefined,
    lane: undefined,
    autoDone: flags.autoDone === true,
    agent: undefined,
    title: flags.title?.trim(),
    hold,
    backlog,
    notBefore: undefined,
    every: undefined,
    cron,
    moreCrons: crons.slice(1),
    after: undefined,
    delay: undefined,
    maxConcurrent: undefined,
    times: undefined,
    until: undefined,
    forceNew: flags.new === true,
    polish,
    key: undefined,
    version: undefined,
  };
  if (flags.priority !== undefined) result.priority = checkedPriority(flags.priority);
  if (flags.model !== undefined) result.model = checkedModel(flags.model);
  if (flags.effort !== undefined) result.effort = checkedEffort(flags.effort);
  if (flags.icon !== undefined) result.icon = checkedIcon(flags.icon);
  if (flags.label !== undefined) result.labels = checkedLabels(flags.label);
  if (flags.lane !== undefined) result.lane = checkedLane(flags.lane);
  if (flags.agent !== undefined) result.agent = checkedAgent(flags.agent);
  if (hold && backlog) throw new UsageError('--hold and --backlog cannot be combined');
  if (delay !== undefined && at !== undefined) throw new UsageError('--in and --at cannot be combined');
  if ((delay !== undefined || at !== undefined) && (hold || backlog))
    throw new UsageError('--in and --at queue the task in Todo; they cannot be combined with --hold or --backlog');
  if (every !== undefined && cron !== undefined) throw new UsageError('--every and --cron cannot be combined');
  const repeats = every !== undefined || cron !== undefined || flags.after !== undefined;
  if (!repeats && (times !== undefined || until !== undefined))
    throw new UsageError('--times and --until end a repeat; add --every, --cron or --after');
  if (!repeats && flags.maxConcurrent !== undefined)
    throw new UsageError('--max-concurrent limits a repeat; add --every, --cron or --after');
  if (repeats && (hold || backlog))
    throw new UsageError('--every and --cron queue tasks in Todo; they cannot be combined with --hold or --backlog');
  if (times !== undefined && until !== undefined) throw new UsageError('--times and --until cannot be combined');
  result.notBefore = parseStart({ delay, at }, now);
  if (every !== undefined) result.every = parseInterval(every);
  checkCrons(crons);
  if (flags.after !== undefined) result.after = checkedAfter(flags.after);
  if (flags.delay !== undefined) result.delay = parseInterval(flags.delay);
  if (flags.maxConcurrent !== undefined) result.maxConcurrent = parseMaxConcurrent(flags.maxConcurrent);
  if (times !== undefined) result.times = parseTimes(times);
  result.until = parseStart({ at: until }, now);
  if (result.until !== undefined && result.until.getTime() < (result.notBefore ?? now).getTime())
    throw new UsageError('--until is before the first run');
  parseKeyFlags(flags, result, { hold, backlog });
  result.prompt = words.join(' ').trim();
  if (result.prompt === '') throw new UsageError('a prompt is required');
  return result;
}

export function checkedPriority(value: string): Priority {
  if (!isPriority(value))
    throw new UsageError(`unknown priority "${value.slice(0, 20)}"; use one of ${PRIORITIES.join(', ')}`);
  return value;
}

export function checkedModel(value: string): string {
  if (!isModelName(value))
    throw new UsageError(
      `"${value.slice(0, 70)}" is not a model name (a claude alias such as opus, or a full name such as claude-opus-5-5)`,
    );
  return value;
}

export function checkedEffort(value: string): Effort {
  if (!isEffort(value))
    throw new UsageError(`unknown effort "${value.slice(0, 20)}"; use one of ${EFFORTS.join(', ')}`);
  return value;
}

export function checkedIcon(value: string): string {
  if (!isEmojiIcon(value)) throw new UsageError(`"${plainLine(value).slice(0, 20)}" is not an icon: give ${ICON_RULE}`);
  return value;
}

/** The labels of `--label` or `set labels`, checked, trimmed and without repeats. */
export function checkedLabels(values: readonly string[]): string[] {
  try {
    return checkLabels(values);
  } catch (error) {
    if (error instanceof ContractError) throw new UsageError(plainLine(error.message));
    throw error;
  }
}
export function checkedLane(value: string): string {
  if (!isSafeLane(value)) throw new UsageError(`"${value.slice(0, 40)}" is not a lane name (${MACHINE_NAME_RULE})`);
  return value;
}

export function checkedAgent(value: string): string {
  if (!isAgentName(value)) throw new UsageError(`"${value.slice(0, 40)}" is not an agent name (${AGENT_NAME_RULE})`);
  return value;
}

// The `--cron` expressions (trimmed): each of 5 fields, at most the schedule's limit, none twice.
export function checkCrons(crons: string[]): void {
  for (const expression of crons)
    if (expression.split(/\s+/).length !== 5)
      throw new UsageError(
        `--cron takes 5 fields (minute hour day month weekday), such as "0 9 * * 1-5"; got "${expression.slice(0, 60)}"`,
      );
  if (crons.length > MAX_SCHEDULE_CRONS)
    throw new UsageError(`--cron can be given at most ${MAX_SCHEDULE_CRONS} times`);
  const normalized = crons.map((expression) => expression.split(/\s+/).join(' '));
  const repeated = normalized.find((expression, index) => normalized.indexOf(expression) !== index);
  if (repeated !== undefined) throw new UsageError(`--cron "${repeated.slice(0, 60)}" is given twice`);
}

// The schedule `--after` names, as typed: an id or the start of one.
export function checkedAfter(value: string): string {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(value))
    throw new UsageError(`--after takes the id of a schedule or the start of it; got "${value.slice(0, 40)}"`);
  return value;
}

export function parseMaxConcurrent(text: string): number {
  const limit = Number(text);
  if (!/^[1-9]\d{0,2}$/.test(text) || limit > MAX_SCHEDULE_CONCURRENT)
    throw new UsageError(
      `--max-concurrent takes a whole number from 1 to ${MAX_SCHEDULE_CONCURRENT}; got "${text.slice(0, 20)}"`,
    );
  return limit;
}

export function parseTimes(text: string): number {
  if (!/^[1-9]\d{0,5}$/.test(text))
    throw new UsageError(`--times takes a positive whole number; got "${text.slice(0, 20)}"`);
  return Number(text);
}

function checkedText(flag: string, value: string, max: number): string {
  if (value.trim() === '') throw new UsageError(`${flag} must not be empty`);
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) throw new UsageError(`${flag} must not contain control characters`);
  if (value.length > max) throw new UsageError(`${flag} is longer than ${max} characters`);
  return value;
}

// `--key` and `--version`: the key is used as given, so the same text from any machine finds the same task.
function parseKeyFlags(flags: ScheduleFlags, result: ScheduleArgs, other: { hold: boolean; backlog: boolean }): void {
  if (flags.key === undefined) {
    if (flags.version !== undefined) throw new UsageError('--version belongs to --key: add --key');
    return;
  }
  const conflicts = [
    result.every !== undefined && '--every',
    result.cron !== undefined && '--cron',
    result.polish && '--polish',
    other.hold && '--hold',
    other.backlog && '--backlog',
  ].filter((flag) => flag !== false);
  if (conflicts.length > 0)
    throw new UsageError(
      `--key makes or finds one task in Todo, and requeues it into Todo; it cannot be combined with ${conflicts.join(', ')}`,
    );
  result.key = checkedText('--key', flags.key, KEY_MAX);
  if (flags.version !== undefined) result.version = checkedText('--version', flags.version, VERSION_MAX);
}

// The time a delayed task starts, from `--in` or `--at`; undefined when neither is given.
export function parseStart(
  flags: { delay?: string | undefined; at?: string | undefined },
  now: Date,
): Date | undefined {
  try {
    if (flags.delay !== undefined) return new Date(now.getTime() + parseDuration(flags.delay));
    return flags.at === undefined ? undefined : parseWhen(flags.at, now);
  } catch (error) {
    if (error instanceof ContractError) throw new UsageError(error.message);
    throw error;
  }
}

export function parseInterval(text: string): number {
  try {
    return parseDuration(text);
  } catch (error) {
    if (error instanceof ContractError) throw new UsageError(error.message);
    throw error;
  }
}

function startStatus(args: Pick<ScheduleArgs, 'hold' | 'backlog'>): DraftStatus {
  if (args.hold) return 'needs-me';
  return args.backlog ? 'backlog' : 'todo';
}

// 2027-01-01 12:00 in the caller's time zone.
export function localTime(date: Date): string {
  return date.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
}

export interface Duplicate {
  taskId: string;
  reason: string;
}

// Asks whether an open task already covers the prompt; undefined when none does, or when the check could not run.
export type DuplicateCheck = (prompt: string, workdir: string, open: Task[]) => Promise<Duplicate | undefined>;

const DUPLICATE_SCHEMA = {
  type: 'object',
  properties: { duplicate: { type: 'boolean' }, taskId: { type: ['string', 'null'] }, reason: { type: 'string' } },
  required: ['duplicate', 'taskId', 'reason'],
};

export function duplicateQuestion(prompt: string, workdir: string, open: Task[]): string {
  const tasks = open.map((task) => ({
    id: task.id,
    title: task.title,
    prompt: task.input.slice(0, 600),
    status: task.status,
    directory: task.workdir,
  }));
  return [
    'A user is about to schedule a task for a coding agent. Decide whether one of the open tasks already covers the same work,',
    'so that scheduling it again would duplicate it. Same PR, same story, or the same question in other words counts; related',
    'but different work does not. Answer duplicate=false when unsure.',
    '',
    `New task, scheduled in ${workdir}:`,
    prompt,
    '',
    'Open tasks:',
    JSON.stringify(tasks, null, 1),
  ].join('\n');
}

export function parseDuplicateAnswer(stdout: string, open: Task[]): Duplicate | undefined {
  const outer: unknown = JSON.parse(stdout);
  const answer = isRecord(outer) ? outer['structured_output'] : undefined;
  if (!isRecord(answer) || answer['duplicate'] !== true || typeof answer['taskId'] !== 'string') return undefined;
  const taskId = answer['taskId'];
  // Only a task that is really open; the model may name something else.
  if (!open.some((task) => task.id === taskId)) return undefined;
  return { taskId, reason: typeof answer['reason'] === 'string' ? answer['reason'] : '' };
}

// `announce` tells the person waiting that the check is running; it is not called when there is nothing to compare with.
export function haikuDuplicateCheck(warn: (line: string) => void, announce?: (line: string) => void): DuplicateCheck {
  return async (prompt, workdir, open) => {
    if (open.length === 0) return undefined;
    announce?.('checking for duplicates…');
    const args = [
      '-p',
      '--model',
      'haiku',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(DUPLICATE_SCHEMA),
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      'user',
    ];
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          'claude',
          args,
          { timeout: 60_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
          (error, out) => (error ? reject(error) : resolve(out)),
        );
        child.stdin?.end(duplicateQuestion(prompt, workdir, open));
      });
      return parseDuplicateAnswer(stdout, open);
    } catch (error) {
      warn(`duplicate check skipped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      return undefined;
    }
  };
}

export type Choice = 'requeue' | 'new' | 'abort';

export interface ScheduleDeps {
  backend: Backend;
  machine: string;
  workdir: string;
  // The IANA zone a cron expression is read in.
  timezone: string;
  print: (line: string) => void;
  // Where the line that confirms a write goes; unset means print. A dry run confirms nothing.
  confirm?: (line: string) => void;
  // The link to a task, built from this machine's own board URL.
  link: (taskId: string) => string;
  check: DuplicateCheck;
  // Asks in the terminal; undefined when there is none (a script), which creates the task with a warning.
  choose: ((duplicate: Duplicate, task: Task) => Promise<Choice>) | undefined;
}

function ruleDraft(
  deps: ScheduleDeps,
  args: ScheduleArgs,
): Pick<ScheduleDraft, 'everyMs' | 'cron' | 'moreCrons' | 'timezone' | 'after'> {
  if (args.after !== undefined) {
    if (!isSafeTaskId(args.after)) throw new UsageError('--after takes the id of a schedule');
    return { after: { scheduleId: args.after, ...(args.delay === undefined ? {} : { delayMs: args.delay }) } };
  }
  if (args.every !== undefined) return { everyMs: args.every };
  return {
    cron: args.cron ?? '',
    ...(args.moreCrons.length === 0 ? {} : { moreCrons: args.moreCrons }),
    timezone: deps.timezone,
  };
}

async function addRepeat(deps: ScheduleDeps, args: ScheduleArgs): Promise<{ schedule: Schedule; task: Task | null }> {
  const added = await deps.backend.addSchedule({
    title: args.title || defaultTitle(args.prompt),
    input: args.prompt,
    machine: deps.machine,
    workdir: deps.workdir,
    ...(args.priority ? { priority: args.priority } : {}),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
    ...(args.icon === undefined ? {} : { icon: args.icon }),
    ...(args.labels === undefined ? {} : { labels: args.labels }),
    ...(args.lane === undefined ? {} : { lane: args.lane }),
    ...(args.autoDone ? { autoDone: true } : {}),
    ...(args.agent === undefined ? {} : { agent: args.agent }),
    ...ruleDraft(deps, args),
    ...(args.maxConcurrent === undefined ? {} : { maxConcurrent: args.maxConcurrent }),
    ...(args.notBefore ? { startAt: args.notBefore } : {}),
    ...(args.times ? { times: args.times } : {}),
    ...(args.until ? { until: args.until } : {}),
  });
  const end = args.times ? `, ${args.times} runs` : args.until ? `, until ${localTime(args.until)}` : '';
  const limit = added.schedule.maxConcurrent === null ? '' : `, at most ${added.schedule.maxConcurrent} at once`;
  const first =
    added.task === null
      ? '; its first task is made when a task of that schedule finishes'
      : `; first run ${localTime(added.task.notBefore ?? new Date())} ${deps.link(added.task.id)}`;
  (deps.confirm ?? deps.print)(
    `scheduled repeat ${added.schedule.id}: ${describeRule(added.schedule)}${end}${limit}${first}`,
  );
  return added;
}

// A recurring prompt resembles its own earlier runs, so a repeat skips the duplicate check.
async function scheduleRepeat(deps: ScheduleDeps, args: ScheduleArgs): Promise<Task> {
  const { task } = await addRepeat(deps, args);
  if (task === null) throw new BackendError('the board made no first task for a repeat that has a start time');
  return task;
}

/** A schedule that runs after another: it has no task until a task of the other one finishes. */
export async function scheduleAfter(deps: ScheduleDeps, args: ScheduleArgs): Promise<Schedule> {
  return (await addRepeat(deps, args)).schedule;
}

// Why `--key` found a task and left it as it is.
export type ExistsReason = 'closed' | 'same-version' | 'no-version' | 'busy' | 'other-agent' | 'changed';

export type KeyedOutcome =
  { result: 'created' | 'requeued' | 'rescheduled' } | { result: 'exists'; reason: ExistsReason };

// What `--after` makes: a schedule and no task yet.
export interface ScheduledAfter {
  schedule: Schedule;
}

export interface Scheduled {
  task: Task;
  // With `--key`: what became of the task.
  keyed?: KeyedOutcome;
  // The task that polishes `task`'s prompt (`--polish`).
  polish?: Task;
}

// A task that waits for the user, or finished, goes back to Todo for a new version; one in any other status is busy with the old.
const REQUEUEABLE: readonly Task['status'][] = ['needs-me', 'done'];

// Finds or creates the task of the key; a new version requeues one that waits in Needs me or is Done, and a start time moves the wait of one in Todo.
export type KeyedDeps = Pick<ScheduleDeps, 'backend' | 'machine' | 'workdir' | 'print' | 'confirm' | 'link'>;

// What a feed hands a requeue: the text the resumed session is told, and where the worker that resumes it finds the text.
export interface KeyedUpdate {
  prompt: string;
  spool: { put: (taskId: string, prompt: string) => void; drop: (taskId: string) => void };
}

export async function scheduleKeyed(
  deps: KeyedDeps,
  args: ScheduleArgs,
  key: string,
  update?: KeyedUpdate,
): Promise<Scheduled> {
  const { backend } = deps;
  const { task, created } = await backend.addTask({
    title: args.title || defaultTitle(args.prompt),
    input: args.prompt,
    status: 'todo',
    dedupeKey: key,
    createdBy: 'user',
    machine: deps.machine,
    workdir: deps.workdir,
    ...(args.priority ? { priority: args.priority } : {}),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
    ...(args.icon === undefined ? {} : { icon: args.icon }),
    ...(args.labels === undefined ? {} : { labels: args.labels }),
    ...(args.lane === undefined ? {} : { lane: args.lane }),
    ...(args.autoDone ? { autoDone: true } : {}),
    ...(args.agent === undefined ? {} : { agent: args.agent }),
    ...(args.version === undefined ? {} : { head: args.version }),
    ...(args.notBefore ? { notBefore: args.notBefore } : {}),
  });
  const say = (verb: string, shown: Task, reason?: ExistsReason): void =>
    (deps.confirm ?? deps.print)(
      `${verb} ${shown.id} ${deps.link(shown.id)}${reason ? ` (${reason})` : ''}${verb !== 'exists' && args.notBefore ? `, starts ${localTime(args.notBefore)}` : ''}`,
    );
  const exists = (shown: Task, reason: ExistsReason): Scheduled => {
    say('exists', shown, reason);
    return { task: shown, keyed: { result: 'exists', reason } };
  };
  if (created) {
    say('created', task);
    return { task, keyed: { result: 'created' } };
  }
  if (task.closed) return exists(task, 'closed');
  // The agent is written once; a task of another agent (or none) would run the new version under the wrong rules.
  const isOtherAgent = task.unreadable.includes('agent') || (task.agent ?? null) !== (args.agent ?? null);
  if (args.notBefore && task.status === 'todo' && task.next === 'fresh' && !isOtherAgent) {
    const versionChanged = args.version !== undefined && task.head !== (await backend.indexHead(args.version));
    let moved: Task;
    try {
      moved = await backend.updateTask(task.id, {
        notBefore: args.notBefore,
        ...(versionChanged ? { head: args.version } : {}),
        expect: 'todo',
      });
    } catch (error) {
      if (error instanceof BackendError && error.status === 409) return exists(task, 'changed');
      throw error;
    }
    if (versionChanged)
      await backend.addNote(task.id, `New version ${args.version}. Starts ${localTime(args.notBefore)}.`, {
        author: 'system',
      });
    say('rescheduled', moved);
    return { task: moved, keyed: { result: 'rescheduled' } };
  }
  if (args.version === undefined) return exists(task, 'no-version');
  if (task.head !== null && task.head === (await backend.indexHead(args.version))) return exists(task, 'same-version');
  if (!REQUEUEABLE.includes(task.status)) return exists(task, 'busy');
  if (isOtherAgent) return exists(task, 'other-agent');
  const resumeWith = update !== undefined && task.sessionId !== null ? update : undefined;
  let requeued: Task;
  try {
    // The prompt is spooled first: a worker that claims the task the moment it is in Todo must find it.
    resumeWith?.spool.put(task.id, resumeWith.prompt);
    // One atomic update, and only if the task is still as it was read: a head changed without the move would leave it behind.
    requeued = await backend.updateTask(task.id, {
      status: 'todo',
      head: args.version,
      next: resumeWith === undefined ? 'fresh' : 'resume',
      ...(args.notBefore ? { notBefore: args.notBefore } : {}),
      expect: task.status,
    });
  } catch (error) {
    resumeWith?.spool.drop(task.id);
    if (error instanceof BackendError && error.status === 409) return exists(task, 'changed');
    throw error;
  }
  await backend.addNote(
    task.id,
    resumeWith === undefined
      ? `New version ${args.version}. Queued again${args.notBefore ? `, starts ${localTime(args.notBefore)}` : ''}.`
      : `New version ${args.version}. Queued again to resume its session${args.notBefore ? `, starts ${localTime(args.notBefore)}` : ''}.\n\n${resumeWith.prompt}`,
    { author: 'system' },
  );
  say('requeued', requeued);
  return { task: requeued, keyed: { result: 'requeued' } };
}

export async function schedule(deps: ScheduleDeps, args: ScheduleArgs): Promise<Scheduled | undefined> {
  const { backend } = deps;
  if (args.key !== undefined) return scheduleKeyed(deps, args, args.key);
  if (args.every !== undefined || args.cron !== undefined) return { task: await scheduleRepeat(deps, args) };
  let warning: string | undefined;
  if (!args.forceNew) {
    // A task this machine cannot read says nothing to the check, and the model must not see its placeholder.
    // A task that runs as another agent (or as none) is not the same work, so it is never a duplicate of this one.
    const open = (await backend.listTasks()).filter(
      (task) =>
        task.status !== 'done' &&
        task.unreadable.every((field) => field === 'watches') &&
        (task.agent ?? null) === (args.agent ?? null),
    );
    const duplicate = await deps.check(args.prompt, deps.workdir, open);
    const existing = duplicate === undefined ? undefined : open.find((task) => task.id === duplicate.taskId);
    if (duplicate && existing) {
      deps.print(
        `Looks like ${existing.id} (${existing.status}) "${plainLine(existing.title)}" covers this: ${plainLine(duplicate.reason)}`,
      );
      const choice = deps.choose ? await deps.choose(duplicate, existing) : 'new';
      if (choice === 'abort') {
        deps.print('nothing scheduled');
        return undefined;
      }
      if (choice === 'requeue') {
        // The existing task's prompt is not the one just typed; polishing it stays a click on the board.
        if (args.polish) deps.print(`no polish queued for ${existing.id}; queue one with "Polish prompt" on the board`);
        if (args.model !== undefined && args.model !== existing.model)
          deps.print(
            `${existing.id} keeps its model (${existing.model ?? 'the default'}); --model applies only to a new task`,
          );
        if (args.effort !== undefined && args.effort !== existing.effort)
          deps.print(
            `${existing.id} keeps its effort (${existing.effort ?? 'the default'}); --effort applies only to a new task`,
          );
        if (args.icon !== undefined && args.icon !== existing.icon)
          deps.print(
            `${existing.id} keeps its icon (${existing.icon ?? 'none'}); --icon applies only to a new task: use \`board task ${existing.id} set icon ${args.icon}\``,
          );
        if (args.labels !== undefined && args.labels.join('\n') !== existing.labels.join('\n'))
          deps.print(
            `${existing.id} keeps its labels (${plainLine(existing.labels.join(', ')) || 'none'}); --label applies only to a new task: use \`board task ${existing.id} set labels\``,
          );
        if (args.lane !== undefined && args.lane !== existing.requestedLane)
          deps.print(
            `${existing.id} keeps its lane (${existing.requestedLane ?? 'the default'}); --lane applies only to a new task: use \`board task ${existing.id} set lane ${args.lane}\``,
          );
        if (args.autoDone && !existing.autoDone)
          deps.print(
            `${existing.id} keeps its auto-done setting (off); --auto-done applies only to a new task: use \`board task ${existing.id} set auto-done on\``,
          );
        if (existing.status === 'todo' && args.notBefore) {
          const delayed = await backend.updateTask(existing.id, { notBefore: args.notBefore, expect: 'todo' });
          (deps.confirm ?? deps.print)(
            `${existing.id} is already queued, now starts ${localTime(args.notBefore)}: ${deps.link(delayed.id)}`,
          );
          return { task: delayed };
        }
        if (existing.status === 'todo' || existing.status === 'running') {
          const note = args.notBefore ? '; the start time was not applied' : '';
          (deps.confirm ?? deps.print)(
            `${existing.id} is already ${existing.status === 'todo' ? 'queued' : 'running'}${note}: ${deps.link(existing.id)}`,
          );
          return { task: existing };
        }
        const requeued = await backend.updateTask(existing.id, {
          status: startStatus(args),
          next: 'fresh',
          ...(args.notBefore ? { notBefore: args.notBefore } : {}),
        });
        await backend.addNote(existing.id, `Scheduled again from ${deps.machine}:${deps.workdir}.`, {
          author: 'system',
        });
        (deps.confirm ?? deps.print)(
          `requeued ${requeued.id} ${deps.link(requeued.id)}${requeued.notBefore ? `, starts ${localTime(requeued.notBefore)}` : ''}`,
        );
        return { task: requeued };
      }
      if (!deps.choose) warning = `Possibly a duplicate of ${existing.id} ("${existing.title}"): ${duplicate.reason}`;
    }
  }
  const { task } = await backend.addTask({
    title: args.title || defaultTitle(args.prompt),
    input: args.prompt,
    status: startStatus(args),
    ...(args.notBefore ? { notBefore: args.notBefore } : {}),
    createdBy: 'user',
    machine: deps.machine,
    workdir: deps.workdir,
    ...(args.priority ? { priority: args.priority } : {}),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
    ...(args.icon === undefined ? {} : { icon: args.icon }),
    ...(args.labels === undefined ? {} : { labels: args.labels }),
    ...(args.lane === undefined ? {} : { lane: args.lane }),
    ...(args.autoDone ? { autoDone: true } : {}),
    ...(args.agent === undefined ? {} : { agent: args.agent }),
  });
  if (warning) await backend.addNote(task.id, warning, { author: 'system' });
  (deps.confirm ?? deps.print)(
    `scheduled ${task.id} ${deps.link(task.id)}${task.notBefore ? `, starts ${localTime(task.notBefore)}` : ''}`,
  );
  if (!args.polish) return { task };
  const { place, ...draft } = polishTask(task);
  const { task: polish } = await backend.addTask({
    ...draft,
    createdBy: 'user',
    ...(place ? { machine: place.machine, workdir: place.workdir } : {}),
  });
  (deps.confirm ?? deps.print)(`queued polish ${polish.id} ${deps.link(polish.id)}`);
  return { task, polish };
}
