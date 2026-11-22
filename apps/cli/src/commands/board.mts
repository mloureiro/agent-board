import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { ReportedFailure, UsageError } from '../cli.mts';
import type { Context, LinkingContext } from '../cli.mts';
import { BackendError, isPermanentRefusal } from '../backend/backend.mts';
import type { Config } from '../config/config.mts';
import { isAllowedDir, isDirectory, tryRealpath } from '../config/dirs.mts';
import {
  ContractError,
  formatAnswers,
  formatDuration,
  MACHINE_NAME_RULE,
  MAX_WAIT_MS,
  parseDuration,
  describeRule,
  formatQuestions,
  isPriority,
  isPrUrl,
  prUrlIn,
  isSafeLane,
  isSafeTaskId,
  isSafeWorkdir,
  isStatus,
  parseQuestions,
  PRIORITIES,
  QuestionError,
  runsLeft,
  serializePolish,
  shownLabels,
  STATUSES,
  UNREADABLE_TEXT,
} from '@agent-board/shared';
import type { Note, Priority, Schedule, Status, Task } from '@agent-board/shared';
import { createStyle } from '../output/style.mts';
import { SystemError } from '../setup/system.mts';
import { requireTaskId } from '../task-id.mts';
import { plainLine, plainText } from '../output/terminal.mts';
import type { Style } from '../output/style.mts';
import {
  checkedIcon,
  checkedLabels,
  haikuDuplicateCheck,
  localTime,
  parseScheduleArgs,
  parseStart,
  schedule,
  scheduleAfter,
} from './schedule.mts';
import { resolveScheduleId } from './ids.mts';
import type { Choice, Scheduled, ScheduledAfter, ScheduleFlags } from './schedule.mts';
import { publishWatches } from '../watch/publish.mts';
import { newWatchId } from '../watch/store.mts';
import type { WatchStore } from '../watch/store.mts';

const NOTE_FILE_DIR = '/tmp/';
const NOTE_FILE_MAX_BYTES = 1024 * 1024;

// Long notes come from a file, so a run's allow list can keep every command simple (no heredoc, no pipe). The agent
// can write /tmp, so the file is opened without following a link and checked: it must be inside /tmp, a regular file of at
// most 1 MiB, and have no other hard link (on macOS /tmp is on the volume of the home directory, so a hard link to a secret
// is possible there). A link to a secret is refused.
// Where the open descriptor really points is read from /proc on Linux, which no racing process can fool. Other systems have
// no such view: there the real path is checked against the real /tmp (/private/tmp on macOS) and the descriptor must be the
// file at that path (same device and inode). That is best effort against a process that swaps the path while this runs.
export function readNoteFile(path: string, platform: string = process.platform): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new UsageError(`cannot read the note file ${path}`);
  }
  try {
    if (platform === 'linux') {
      if (!readlinkSync(`/proc/self/fd/${fd}`).startsWith(NOTE_FILE_DIR))
        throw new UsageError(`the note file must be inside ${NOTE_FILE_DIR}`);
    } else {
      let real: string;
      let tmp: string;
      try {
        real = realpathSync(path);
        tmp = `${realpathSync(NOTE_FILE_DIR)}/`;
      } catch {
        throw new UsageError(`cannot read the note file ${path}`);
      }
      if (!real.startsWith(tmp)) throw new UsageError(`the note file must be inside ${NOTE_FILE_DIR}`);
      const opened = fstatSync(fd, { bigint: true });
      const named = statSync(real, { bigint: true });
      if (opened.dev !== named.dev || opened.ino !== named.ino)
        throw new UsageError(`the note file must be inside ${NOTE_FILE_DIR}`);
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > NOTE_FILE_MAX_BYTES)
      throw new UsageError('the note file must be a regular file of at most 1 MiB');
    if (stat.nlink !== 1) throw new UsageError('the note file must not be a hard link to another file');
    return readFileSync(fd, 'utf8').trim();
  } finally {
    closeSync(fd);
  }
}

// "Needs me" and "needs-me" name the same status, so the skill can keep saying the former.
export function parseStatus(name: string): Status {
  const normalised = name.trim().toLowerCase().replaceAll(' ', '-');
  if (!isStatus(normalised)) throw new UsageError(`unknown status "${name}"; use one of ${STATUSES.join(', ')}`);
  return normalised;
}

// Nothing is confirmed in a dry run: the DRY lines already say what would happen.
export function confirm(context: Context, line: string): void {
  if (!context.dryRun) context.print(line);
}

export async function comment(
  context: LinkingContext,
  id: string,
  text: string,
  options: { suggestion?: string } = {},
): Promise<void> {
  await context.backend.addNote(id, text, options);
  confirm(context, `commented on ${id}  ${context.taskLink(id)}`);
}

export async function reportPr(context: LinkingContext, id: string, url: string): Promise<void> {
  if (!isPrUrl(url))
    throw new UsageError(
      `"${url.slice(0, 80)}" is not a pull request URL: use https://github.com/<owner>/<repo>/pull/<number>`,
    );
  // The board cannot tell a repeated URL, which it holds sealed.
  const known = (await context.backend.getTask(id)).prs.some((pr) => pr.url === url);
  if (!known) await context.backend.addPr(id, url);
  confirm(context, `reported ${url} for ${id}  ${context.taskLink(id)}`);
}

export async function removePr(context: LinkingContext, id: string, url: string): Promise<void> {
  if (!isPrUrl(url))
    throw new UsageError(
      `"${url.slice(0, 80)}" is not a pull request URL: use https://github.com/<owner>/<repo>/pull/<number>`,
    );
  const task = await context.backend.getTask(id);
  const reported = task.prs.find((pr) => pr.url === url);
  if (reported !== undefined) {
    await context.backend.removePr(id, reported.id);
    confirm(context, `removed ${url} from ${id}  ${context.taskLink(id)}`);
  } else if (prUrlIn(task.input) === url)
    throw new UsageError(
      `${url} is the pull request the prompt of ${id} names, not a reported one, and cannot be removed`,
    );
  else confirm(context, `${url} was not reported for ${id}; nothing changed  ${context.taskLink(id)}`);
}

export interface CommentFlags {
  suggest?: string;
  suggestFile?: string;
}

export interface TasksFlags {
  all?: boolean;
  status?: string;
  json?: boolean;
}

// The tasks `board tasks` lists: the open ones, or every one with --all, of one status with --status.
export async function selectTasks(context: Context, flags: TasksFlags): Promise<Task[]> {
  const status = flags.status === undefined ? undefined : parseStatus(flags.status);
  const found = await context.backend.listTasks({ all: flags.all === true });
  return status === undefined ? found : found.filter((task) => task.status === status);
}

export function formatTasks(found: Task[], flags: TasksFlags, style: Style): string[] {
  const idWidth = Math.max(...found.map((task) => task.id.length), 0);
  const priorityWidth = Math.max(...found.map((task) => task.priority.length), 0);
  const only = flags.status === undefined ? undefined : parseStatus(flags.status);
  return (only ? [only] : STATUSES).flatMap((status) => {
    const inStatus = found.filter((task) => task.status === status);
    return [
      style.bold(`${status} (${inStatus.length})`),
      ...inStatus.map((task) => {
        const shown = shownLabels(task);
        const labels = shown.length > 0 ? `  [${plainLine(shown.join(','))}]` : '';
        const hints = [
          task.notBefore ? `starts ${localTime(task.notBefore)}` : undefined,
          task.held ? 'waits for a free slot of its schedule' : undefined,
          task.wakeAt ? `${task.waitCheck ? 'checks, gives up' : 'wakes'} ${localTime(task.wakeAt)}` : undefined,
          task.closed ? 'closed' : undefined,
          task.unreadable.length > 0 ? `cannot decrypt: ${task.unreadable.join(', ')}` : undefined,
        ].filter((hint) => hint !== undefined);
        return `  ${task.id.padEnd(idWidth)}  ${task.priority.padEnd(priorityWidth)}  ${plainLine(task.title)}${labels}${hints.length > 0 ? style.dim(`  (${hints.join(', ')})`) : ''}`;
      }),
    ];
  });
}

// A value this machine could not decrypt is `null` in JSON and listed in `unreadable`: the placeholder the CLI shows in
// text must not pass for what the user wrote.
export function taskJson(task: Task): Omit<Task, 'title' | 'input'> & { title: string | null; input: string | null } {
  return {
    ...task,
    title: task.unreadable.includes('title') ? null : task.title,
    input: task.unreadable.includes('input') ? null : task.input,
  };
}

export function scheduleJson(
  schedule: Schedule,
): Omit<Schedule, 'title' | 'input'> & { title: string | null; input: string | null } {
  return {
    ...schedule,
    title: schedule.unreadable.includes('title') ? null : schedule.title,
    input: schedule.unreadable.includes('input') ? null : schedule.input,
  };
}

export function noteJson(note: Note): Omit<Note, 'text'> & { text: string | null } {
  return { ...note, text: note.unreadable ? null : note.text };
}

export async function tasks(context: Context, flags: TasksFlags = {}): Promise<void> {
  const found = await selectTasks(context, flags);
  for (const line of formatTasks(found, flags, createStyle(context.color === true))) context.print(line);
}

export async function ask(context: LinkingContext, id: string, path: string): Promise<void> {
  let questions;
  try {
    questions = parseQuestions(JSON.parse(readNoteFile(path)));
  } catch (error) {
    if (error instanceof SyntaxError) throw new UsageError(`the question file is not valid JSON: ${path}`);
    if (error instanceof QuestionError) throw new UsageError(`the question file: ${error.message}`);
    throw error;
  }
  try {
    await context.backend.ask(id, questions);
  } catch (error) {
    // The task is not running on this machine: the run that would ask was taken back or has ended, and asking again cannot help.
    if (error instanceof BackendError && error.fromApi && error.status === 409)
      throw new UsageError(
        `${id} cannot take a question: ${error.message}. The board takes questions only from the run that holds the task, so nothing was asked. If you are that run, it was taken back or has ended: do not ask again, end your turn.`,
      );
    throw error;
  }
  const count = `${questions.length} question${questions.length > 1 ? 's' : ''}`;
  confirm(context, `asked ${count} on ${id}, now in needs-me  ${context.taskLink(id)}`);
}

export function renderThread(task: Task, notes: Note[]): string {
  const lines = [
    `# ${task.title}`,
    '',
    `status: ${task.status} · priority: ${task.priority} · labels: ${plainLine(shownLabels(task).join(', ')) || '-'}`,
    ...(task.agent == null ? [] : [`agent: ${task.agent}`]),
    ...(task.forkOf === undefined ? [] : [`fork of: ${task.forkOf}`]),
    ...task.prs.map((pr) => `pr: ${pr.url}`),
    ...(task.sessionId ? [`session: ${task.sessionId} · ${task.machine ?? '-'}:${task.workdir ?? '-'}`] : []),
    '',
    '## Input',
    '',
    task.unreadable.includes('input') ? UNREADABLE_TEXT : task.input.trim() || '(empty)',
    '',
    '## Thread',
  ];
  for (const note of [...notes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    // The server's own events are plain text from a fixed list, shown as the server's and not as a note of the thread.
    if (note.author === 'server') {
      lines.push('', `### from the board server, not board content · ${note.createdAt.toISOString()}`, '');
      lines.push(note.unreadable ? UNREADABLE_TEXT : note.text.trim());
      continue;
    }
    lines.push('', `### ${note.author} ${note.kind} · ${note.createdAt.toISOString()}`, '');
    if (note.kind === 'question' && note.questions) lines.push(formatQuestions(note.questions));
    if (note.kind === 'answer' && !note.unreadable) lines.push(formatAnswers(note.questions, note.answers ?? []));
    if (note.unreadable) lines.push(UNREADABLE_TEXT);
    else if (note.text.trim() !== '') lines.push(note.text.trim());
  }
  // The thread is text from the board's writers, questions and answers included.
  return plainText(lines.join('\n'));
}

export async function readThread(context: Context, id: string): Promise<{ task: Task; notes: Note[] }> {
  const [task, notes] = await Promise.all([context.backend.getTask(id), context.backend.readNotes(id)]);
  return { task, notes };
}

export async function show(context: Context, id: string): Promise<void> {
  const { task, notes } = await readThread(context, id);
  context.print(renderThread(task, notes));
}

// Runs a program with the terminal and resolves with its exit status; tests replace it.
export type Spawner = (command: string, args: string[], options: { cwd: string }) => Promise<number>;

export const spawnInteractive: Spawner = (command, args, { cwd }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'ENOENT'
          ? new SystemError(`${command} is not on the PATH: install Claude Code to attach to a session`)
          : error,
      ),
    );
    child.on('close', (code, signal) => resolve(code ?? 128 + (signal ? (osConstants.signals[signal] ?? 0) : 0)));
  });

export interface AttachFlags {
  fork?: boolean;
  desktop?: boolean;
}

// Opens the task's Claude session interactively, where it lives. The board decides who may: only the machine whose token
// ran the task gets the session. A non-zero status of claude is the command's own.
export async function attach(
  context: Context,
  id: string,
  flags: AttachFlags = {},
  spawnClaude: Spawner = spawnInteractive,
): Promise<void> {
  if (flags.desktop && flags.fork) throw new UsageError('--desktop and --fork cannot be combined');
  const { sessionId, workdir } = await context.backend.attachSession(id).catch((error: unknown) => {
    if (error instanceof BackendError && error.fromApi && (error.status === 409 || error.status === 403))
      throw new UsageError(error.message);
    throw error;
  });
  if (!workdir || !isDirectory(workdir))
    throw new UsageError(
      workdir
        ? `the directory of ${id} is not there: ${plainLine(workdir)}`
        : `the directory of ${id} is unknown: it could not be read`,
    );
  const args = [
    ...(flags.desktop ? ['--desktop'] : []),
    '--resume',
    sessionId,
    ...(flags.fork ? ['--fork-session'] : []),
  ];
  if (context.dryRun) {
    context.print(`DRY claude ${args.join(' ')}  (in ${plainLine(workdir)})`);
    return;
  }
  const exitCode = await spawnClaude('claude', args, { cwd: workdir });
  if (exitCode !== 0) throw new ReportedFailure(`claude exited with code ${exitCode}`, exitCode);
}

export interface AddFlags {
  title?: string;
  file?: string;
  parent?: string;
  priority?: string;
  lane?: string;
  icon?: string;
  label?: string[];
  // Propose in the working directory instead of the parent's.
  here?: boolean;
}

export function parseAddFlags(flags: AddFlags): {
  title: string;
  file: string;
  parent: string | undefined;
  priority: Priority | undefined;
  lane: string | undefined;
  icon: string | undefined;
  labels: string[] | undefined;
} {
  const title = flags.title?.trim();
  const { file, parent, priority, lane } = flags;
  const icon = flags.icon === undefined ? undefined : checkedIcon(flags.icon);
  const labels = flags.label === undefined ? undefined : checkedLabels(flags.label);
  if (!title) throw new UsageError('--title needs a title');
  if (!file) throw new UsageError('--file is required');
  if (parent !== undefined) requireTaskId(parent, UsageError);
  if (priority !== undefined && !isPriority(priority))
    throw new UsageError(`unknown priority "${priority.slice(0, 20)}"; use one of ${PRIORITIES.join(', ')}`);
  if (lane !== undefined && !isSafeLane(lane))
    throw new UsageError(`"${lane.slice(0, 40)}" is not a lane name (${MACHINE_NAME_RULE})`);
  return { title, file, parent, priority, lane, icon, labels };
}

/**
 * The directory a proposal is sealed with. With a `dirs` list, an agent that moved on from where its run started (a
 * worktree outside every listed directory, /tmp) proposes in the directory the run started in, if that is allowed.
 */
export function proposalDir(config: Config, { cwd, startDir }: { cwd: string; startDir?: string }): string {
  if (isAllowedDir(config.dirs, cwd)) return cwd;
  const start = startDir !== undefined && isSafeWorkdir(startDir) ? tryRealpath(startDir) : undefined;
  if (start !== undefined && isAllowedDir(config.dirs, start)) return start;
  throw new UsageError(
    `${plainLine(cwd)} is not a listed directory on ${config.machine}, and neither is the directory this run started in: a proposal needs one. Run "board dirs add" in the directory the task belongs in, or run board add from a listed directory.`,
  );
}

/**
 * The parent's directory on this machine, for a proposal that follows from it; undefined when it has none here. The run's
 * own task is where its run started (AGENT_BOARD_START_DIR), which the worker stored as its `workdir`; another task is
 * read from the board. A directory that is gone, unsafe or not allowed here is not inherited.
 */
async function parentDir(
  context: LinkingContext,
  parent: string,
  where: { startDir?: string; runTask?: string },
): Promise<string | undefined> {
  let dir: string | null | undefined;
  if (parent === where.runTask && where.startDir !== undefined) dir = where.startDir;
  else {
    try {
      const task = await context.backend.getTask(parent);
      // A directory of another machine means nothing here; an unreadable one is null.
      if (task.machine === context.config.machine) dir = task.workdir;
    } catch (error) {
      if (error instanceof BackendError && error.fromApi) return undefined;
      throw error;
    }
  }
  if (dir === null || dir === undefined || !isSafeWorkdir(dir)) return undefined;
  const real = tryRealpath(dir);
  if (real === undefined || !isDirectory(real) || !isAllowedDir(context.config.dirs, real)) return undefined;
  return real;
}

// The board puts a proposal in Backlog itself, so no status is sent.
export async function add(
  context: LinkingContext,
  flags: AddFlags,
  // `cwd`: the real path of the working directory; `startDir`: AGENT_BOARD_START_DIR, where the run started;
  // `runTask`: AGENT_BOARD_TASK, the task of the run that proposes.
  where: { cwd: string; startDir?: string; runTask?: string },
): Promise<Task> {
  const { title, file, parent, priority, lane, icon, labels } = parseAddFlags(flags);
  // A follow-up runs where its parent does, unless --here asks for this directory.
  const inherited = parent === undefined || flags.here === true ? undefined : await parentDir(context, parent, where);
  const workdir = inherited ?? proposalDir(context.config, where);
  // An agent proposes; the user starts it. A prompt-injected run must not queue work by itself. It runs on this machine.
  const draft = {
    title,
    input: readNoteFile(file),
    createdBy: 'agent' as const,
    machine: context.config.machine,
    workdir,
    ...(parent ? { parentId: parent } : {}),
    ...(priority ? { priority } : {}),
    ...(lane === undefined ? {} : { lane }),
    ...(icon === undefined ? {} : { icon }),
    ...(labels === undefined ? {} : { labels }),
  };
  const { task } = await context.backend.addTask(draft);
  confirm(context, `proposed ${task.id} ${context.taskLink(task.id)}`);
  return task;
}

export interface PolishFlags {
  title?: string;
  file?: string;
}

/**
 * An agent's polished title and prompt for a backlog task, posted on the task this run is for. It changes nothing: the
 * user applies it in the browser, which seals the text as theirs.
 */
export async function polish(context: LinkingContext, run: string, target: string, flags: PolishFlags): Promise<void> {
  if (!isSafeTaskId(run)) throw new UsageError('AGENT_BOARD_TASK is not a task id');
  if (target === run) throw new UsageError('a task cannot post a polished prompt for itself; name the task to polish');
  if (!flags.title?.trim()) throw new UsageError('--title needs a title');
  if (!flags.file) throw new UsageError('--file is required');
  let text: string;
  try {
    text = serializePolish({ target, title: flags.title, prompt: readNoteFile(flags.file) });
  } catch (error) {
    if (error instanceof ContractError) throw new UsageError(error.message);
    throw error;
  }
  await context.backend.addNote(run, text, { kind: 'polish' });
  confirm(context, `posted a polished prompt for ${target} on ${run}  ${context.taskLink(run)}`);
}

// `board move --expect` found the task in another status: nothing was written.
export class MoveRefused extends Error {}

export async function move(
  context: LinkingContext,
  id: string,
  status: Status,
  options: { expect?: Status } = {},
): Promise<void> {
  if (status === 'waiting')
    throw new UsageError(`a wait needs its end: use "board wait ${id} --in <dur>" or "--check '<command>'" instead`);
  try {
    await context.backend.updateTask(id, {
      status,
      ...(options.expect === undefined ? {} : { expect: options.expect }),
    });
  } catch (error) {
    if (options.expect !== undefined && error instanceof BackendError && error.status === 409)
      throw new MoveRefused(`${id} is not in ${options.expect} any more; nothing was moved`);
    // Only a run's own task is checked against its run: this run was taken back or has ended, and moving again cannot help.
    if (error instanceof BackendError && error.fromApi && error.status === 409)
      throw new UsageError(
        `${id} was not moved: ${error.message}. From inside a run the board moves the run's task only while that run holds it. If you are that run, it was taken back or has ended: do not move it again, end your turn.`,
      );
    // The board's own reason: this task is not set to finish by itself, or it is a proposal.
    if (error instanceof BackendError && error.fromApi && error.status === 403 && status === 'done')
      throw new UsageError(`${id} was not moved: ${error.message}`);
    if (error instanceof BackendError && error.status === 403)
      throw new UsageError(`${id} is a proposal: only the user can start it. Leave it in Backlog.`);
    throw error;
  }
  confirm(context, `moved ${id} to ${status}  ${context.taskLink(id)}`);
}

export interface DelayFlags {
  in?: string;
  at?: string;
  now?: boolean;
}

// The start time to set, or null to clear it; exactly one of the three flags.
export function parseDelayFlags(flags: DelayFlags, now: Date = new Date()): Date | null {
  const { in: delayText, at, now: dueNow } = flags;
  if ([delayText, at, dueNow].filter((flag) => flag !== undefined && flag !== false).length !== 1)
    throw new UsageError('give exactly one of --in, --at or --now');
  if (dueNow) return null;
  const start = parseStart(delayText === undefined ? { at } : { delay: delayText }, now);
  if (start === undefined) throw new UsageError('give exactly one of --in, --at or --now');
  return start;
}

export async function delay(context: Context, id: string, flags: DelayFlags): Promise<void> {
  const notBefore = parseDelayFlags(flags);
  await context.backend.updateTask(id, { notBefore, expect: 'todo' });
  confirm(context, notBefore === null ? `${id} is due now` : `${id} starts ${localTime(notBefore)}`);
}

export interface WaitFlags {
  in?: string;
  at?: string;
  check?: string;
  every?: string;
  timeout?: string;
  reason?: string;
}

export const DEFAULT_CHECK_EVERY = '2m';
export const DEFAULT_CHECK_TIMEOUT = '2h';
// A check every minute at most: the dispatcher ticks every two minutes, the listener in between.
const MIN_CHECK_EVERY_MS = 60_000;

export interface WaitPlan {
  wakeAt: Date;
  check?: { command: string; everyMs: number };
}

// The end of the wait, and the check that may end it early; a timer is --in or --at, a check is --check with --every and --timeout.
export function parseWaitFlags(flags: WaitFlags, now: Date = new Date()): WaitPlan {
  const { in: inText, at, check, every, timeout } = flags;
  const ends = [inText, at, check].filter((flag) => flag !== undefined);
  if (ends.length !== 1) throw new UsageError('give exactly one of --in, --at or --check');
  const duration = (text: string, flag: string): number => {
    try {
      return parseDuration(text);
    } catch (error) {
      if (error instanceof ContractError) throw new UsageError(`${flag}: ${error.message}`);
      throw error;
    }
  };
  let plan: WaitPlan;
  if (check === undefined) {
    if (every !== undefined || timeout !== undefined) throw new UsageError('--every and --timeout go with --check');
    plan = { wakeAt: parseStart(inText === undefined ? { at } : { delay: inText }, now) ?? now };
  } else {
    if (check.trim() === '') throw new UsageError('--check needs a command');
    const everyMs = duration(every ?? DEFAULT_CHECK_EVERY, '--every');
    if (everyMs < MIN_CHECK_EVERY_MS) throw new UsageError('--every must be at least 1m');
    plan = {
      wakeAt: new Date(now.getTime() + duration(timeout ?? DEFAULT_CHECK_TIMEOUT, '--timeout')),
      check: { command: check, everyMs },
    };
  }
  if (plan.wakeAt.getTime() - now.getTime() > MAX_WAIT_MS)
    throw new UsageError(`a wait may last at most ${formatDuration(MAX_WAIT_MS)}`);
  return plan;
}

// The agent's comment on the wait: its reason and when it ends. The check's command stays on this machine.
export function waitText(plan: WaitPlan, reason: string | undefined, machine: string): string {
  const what = reason?.trim() || (plan.check ? 'Waiting for a check.' : 'Waiting.');
  const when = plan.check
    ? `Waiting until a check on ${machine} passes (every ${formatDuration(plan.check.everyMs)}), at most until ${localTime(plan.wakeAt)}.`
    : `Waiting until ${localTime(plan.wakeAt)}.`;
  return `${what}\n\n${when}`;
}

/**
 * A running task waits: the slot frees, and the task resumes in its session once the time is up or the check passes. The
 * check is stored on this machine as a command watch named "wait" before the board hears of the wait, so no tick sees a
 * waiting task without it.
 */
export async function wait(
  context: Context,
  id: string,
  flags: WaitFlags,
  // `settingsDir`: the directory the run started in (AGENT_BOARD_START_DIR), whose settings the check takes its `env` from.
  // `restricted`: the run's AGENT_BOARD_RESTRICTED marker, which the worker sets on this machine for an agent's run.
  deps: { watches: WatchStore; cwd: string; settingsDir?: string; restricted?: boolean; now?: Date },
): Promise<void> {
  const now = deps.now ?? new Date();
  const plan = parseWaitFlags(flags, now);
  let watchId: string | undefined;
  if (plan.check !== undefined) {
    const task = await context.backend.getTask(id);
    if (task.status !== 'running') throw new UsageError(`${id} is ${task.status}: only a running task can wait`);
    // An agent's run allows a fixed list of commands; a check would run any command.
    // A run an older CLI started for the removed intake has its narrow list but no AGENT_BOARD_RESTRICTED.
    if (task.createdBy === 'intake')
      throw new UsageError(`${id} is a task of the removed intake: it may wait with --in or --at only`);
    if (deps.restricted === true)
      throw new UsageError(`${id} runs as an agent with a fixed list of commands: it may wait with --in or --at only`);
    if (task.machine !== context.config.machine)
      throw new UsageError(
        `${id} runs on ${task.machine ?? 'no machine'}, not on ${context.config.machine}: a check runs on the task's machine`,
      );
    if (context.dryRun) context.print(`DRY store check for ${id} in ${deps.cwd}: ${plainLine(plan.check.command)}`);
    else {
      watchId = newWatchId();
      deps.watches.write({
        id: watchId,
        name: 'wait',
        task: id,
        source: {
          kind: 'command',
          command: plan.check.command,
          cwd: deps.cwd,
          ...(deps.settingsDir !== undefined && isSafeWorkdir(deps.settingsDir)
            ? { settingsDir: deps.settingsDir }
            : {}),
        },
        everyMs: plan.check.everyMs,
        createdAt: now.toISOString(),
        deadline: plan.wakeAt.toISOString(),
      });
    }
  }
  try {
    await context.backend.wait(id, {
      text: waitText(plan, flags.reason, context.config.machine),
      wakeAt: plan.wakeAt,
      check: plan.check !== undefined,
    });
  } catch (error) {
    // Only a refusal: after a timeout or a 5xx the board may have taken the wait, and its check must stay. If it did not, the
    // watch stays while the task runs and parks the run when it ends, until its deadline or the task's watches are dropped.
    if (watchId !== undefined && isPermanentRefusal(error)) deps.watches.claim(id, 'wait', watchId)?.done();
    if (error instanceof BackendError && error.status === 409)
      throw new UsageError(`${id} cannot wait: ${error.message}`);
    throw error;
  }
  if (plan.check !== undefined && !context.dryRun)
    await publishWatches({ store: deps.watches, backend: context.backend, now: () => now, log: context.print }, id);
  confirm(
    context,
    plan.check
      ? `${id} waits for its check, at most until ${localTime(plan.wakeAt)}; end your turn now`
      : `${id} waits until ${localTime(plan.wakeAt)}; end your turn now`,
  );
}

// A pending card with no start time is due now.
function nextRun(schedule: Schedule): string {
  if (schedule.nextRunAt) return localTime(schedule.nextRunAt);
  return schedule.occurrenceTaskId ? 'now' : '-';
}

// `  <id>  every 2h  next 2027-01-01 10:00  3 left  paused  <title>`
export function formatSchedule(schedule: Schedule): string {
  const left = runsLeft(schedule);
  const state = schedule.ended ? 'ended' : schedule.paused ? 'paused' : '-';
  return [
    schedule.id,
    describeRule(schedule),
    `next ${nextRun(schedule)}`,
    left !== null ? `${left} left` : schedule.until ? `until ${localTime(schedule.until)}` : 'forever',
    state,
    ...(schedule.maxConcurrent === null ? [] : [`max ${schedule.maxConcurrent}`]),
    plainLine(schedule.title),
    ...(schedule.unreadable.length > 0 ? [`(cannot decrypt: ${schedule.unreadable.join(', ')})`] : []),
  ].join('  ');
}

export async function schedules(context: Context, args: string[]): Promise<void> {
  const [action, id, ...extra] = args;
  if (action === undefined) {
    const all = await context.backend.listSchedules();
    context.print(createStyle(context.color === true).bold(`schedules (${all.length})`));
    for (const schedule of all) context.print(`  ${formatSchedule(schedule)}`);
    return;
  }
  if ((action !== 'pause' && action !== 'resume' && action !== 'rm') || id === undefined || extra.length > 0)
    throw new UsageError('schedules takes nothing, or pause, resume, rm or edit and a schedule id');
  if (action === 'rm') {
    await context.backend.removeSchedule(id);
    return confirm(context, `removed ${id}`);
  }
  const schedule = await context.backend.updateSchedule(id, { paused: action === 'pause' });
  if (action === 'pause') return confirm(context, `paused ${id}`);
  confirm(context, `resumed ${id}${schedule.nextRunAt ? `, next run ${localTime(schedule.nextRunAt)}` : ''}`);
}

// The question goes to stderr, so a JSON document on stdout stays alone.
async function chooseInTerminal(): Promise<Choice> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const answer = (await terminal.question('[r]equeue it, [n]ew task anyway, [a]bort? ')).trim().toLowerCase();
      if (answer === 'r' || answer === 'requeue') return 'requeue';
      if (answer === 'n' || answer === 'new') return 'new';
      if (answer === 'a' || answer === 'abort' || answer === '') return 'abort';
    }
  } finally {
    terminal.close();
  }
}

// A typo fails here, before the board holds a task that no machine could run.
export function requireLocalAgent(config: Pick<Config, 'agents' | 'agentErrors' | 'machine'>, name: string): void {
  if (Object.hasOwn(config.agents, name)) return;
  const known = Object.keys(config.agents);
  const broken = Object.hasOwn(config.agentErrors, name) ? ` (${config.agentErrors[name]})` : '';
  throw new UsageError(
    `no agents.${name} in config.json on ${config.machine}${broken}; ${known.length === 0 ? 'it defines no agents' : `it defines ${known.join(', ')}`}`,
  );
}

export async function scheduleCommand(
  context: LinkingContext,
  flags: ScheduleFlags,
  words: string[],
  cwd: string,
): Promise<Scheduled | ScheduledAfter | undefined> {
  const parsed = parseScheduleArgs(flags, words);
  const args =
    parsed.after === undefined
      ? parsed
      : { ...parsed, after: await resolveScheduleId(context.backend, parsed.after, { inRun: false }) };
  if (args.agent !== undefined) requireLocalAgent(context.config, args.agent);
  if (!isAllowedDir(context.config.dirs, cwd))
    throw new UsageError(
      `${plainLine(cwd)} is not a listed directory on ${context.config.machine}, so a task scheduled here would stop in Needs me. Run "board dirs add" here first, or schedule from a listed directory.`,
    );
  const deps = {
    backend: context.backend,
    machine: context.config.machine,
    workdir: cwd,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    print: context.print,
    confirm: (line: string) => confirm(context, line),
    link: context.taskLink,
    check: haikuDuplicateCheck(
      context.print,
      process.stderr.isTTY ? (line) => void process.stderr.write(`${line}\n`) : undefined,
    ),
    choose: process.stdin.isTTY && process.stderr.isTTY ? chooseInTerminal : undefined,
  };
  if (args.after !== undefined) return { schedule: await scheduleAfter(deps, args) };
  return schedule(deps, args);
}
