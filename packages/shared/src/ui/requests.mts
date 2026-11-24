import {
  AGENT_NAME_RULE,
  ContractError,
  defaultTitle,
  isAgentName,
  newTaskId,
  open,
  previousText,
  QuestionError,
  seal,
  sealAnswers,
  sealFields,
  sealIcon,
  sealLabels,
  sealInput,
  sealLinkRules,
  sealTitleRules,
  sealNote,
  sealTitle,
  sealWorkdir,
  textBeforeEdit,
  type Answer,
  type Binding,
  type Effort,
  type Keys,
  type LinkRule,
  type Priority,
  type Question,
  type RowRef,
  type Sealer,
  type Status,
  type TitleRule,
  type Polish,
  type TaskCreator,
  type UnreadableField,
} from '../index.mts';
import type { UiInputs } from './wire.mts';

export class InputError extends Error {}

type CreateInput = UiInputs['tasks.create'];
type NoteInput = UiInputs['tasks.reply']['message'];

export interface NewTask {
  title?: string;
  input: string;
  priority?: Priority;
  /** An alias or full name; absent is claude's default. */
  model?: string;
  /** An effort level; absent is claude's default. */
  effort?: Effort;
  /** The lane of the machine that runs it; absent is the machine's default lane. */
  lane?: string;
  /** The agent may move the task, or each occurrence of a repeat, to Done itself; absent is off. */
  autoDone?: boolean;
  when?: CreateInput['when'];
  parentId?: string;
  /** The machine and directory it runs in (every occurrence of a repeat), instead of the default directory of whichever machine takes it. */
  place?: { machine: string; workdir: string };
  /** The agent of the machine's config.json the task, or each occurrence of a repeat, runs as; absent runs it by its creator's rules. */
  agent?: string;
  icon?: string;
  labels?: string[];
}

/** What the shared sealing refuses (a text past the board's limit, answers that do not fit) is something to tell the user. */
async function checked<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ContractError || error instanceof QuestionError) throw new InputError(error.message);
    throw error;
  }
}

const isRepeat = (when: CreateInput['when']): boolean =>
  typeof when === 'object' && ('every' in when || 'cron' in when || 'after' in when);

export async function sealNewTask(keys: Keys, task: NewTask): Promise<CreateInput> {
  const input = task.input.trim();
  if (input === '') throw new InputError('Write a prompt first');
  const title = (task.title ?? '').trim() || defaultTitle(input);
  // The id is the task's, or the schedule's for a repeat (its occurrences are the server's): the fields are bound to it.
  const id = newTaskId();
  const agent = task.agent ?? null;
  const row: RowRef = isRepeat(task.when)
    ? { kind: 'schedule', id, agent }
    : { kind: 'task', id, createdBy: 'user', scheduleId: null, agent, forkOf: null };
  const workdir = task.place?.workdir;
  const sealed = await checked(() => sealFields(sealerFor(keys), row, { title, input, workdir }));
  const { icon, labels } = task;
  const sealedLabels = labels === undefined ? null : await checked(() => sealLabels(sealerFor(keys), row, labels));
  return {
    id,
    title: sealed.title,
    input: sealed.input,
    ...(sealed.agent === undefined ? {} : { agent: sealed.agent }),
    ...(icon === undefined ? {} : { icon: await checked(() => sealIcon(sealerFor(keys), row, icon)) }),
    ...(sealedLabels === null ? {} : { labels: sealedLabels }),
    ...(task.priority === undefined ? {} : { priority: task.priority }),
    ...(task.model === undefined ? {} : { model: task.model }),
    ...(task.effort === undefined ? {} : { effort: task.effort }),
    ...(task.lane === undefined ? {} : { lane: task.lane }),
    ...(task.autoDone === undefined ? {} : { autoDone: task.autoDone }),
    ...(task.when === undefined ? {} : { when: task.when }),
    ...(task.parentId === undefined ? {} : { parentId: task.parentId }),
    ...(task.place === undefined || sealed.workdir === undefined
      ? {}
      : { place: { machine: task.place.machine, workdir: sealed.workdir } }),
  };
}

export async function sealComment(keys: Keys, taskId: string, text: string): Promise<NoteInput> {
  return checked(() => sealNote(sealerFor(keys), { taskId, author: 'user', kind: 'comment' }, text));
}

export async function sealReply(keys: Keys, taskId: string, message: string): Promise<NoteInput> {
  const text = message.trim();
  if (text === '') throw new InputError('Write something first.');
  return sealComment(keys, taskId, text);
}

/**
 * The answers checked against `questions`, then sealed together with them, so that what the agent is told comes from the answer
 * alone. `questions` are exactly the ones the panel showed (opened from the question note on screen), never ones fetched again
 * at submit time, which the board could have changed in between.
 */
export async function sealAnswer(
  keys: Keys,
  options: { id: string; questionNoteId: string; questions: Question[]; answers: Answer[]; message: string },
): Promise<UiInputs['tasks.answer']> {
  const { id, questionNoteId, questions, message } = options;
  const text = message.trim();
  return {
    id,
    questionNoteId,
    answers: await checked(() => sealAnswers(sealerFor(keys), id, questions, options.answers)),
    message: await checked(() => sealNote(sealerFor(keys), { taskId: id, author: 'user', kind: 'answer' }, text)),
  };
}

/** What starting an agent's proposal needs of the proposal as the page shows it. */
export interface Proposal {
  id: string;
  status: Status;
  input: string;
  createdBy: TaskCreator;
  scheduleId: string | null;
  /** An agent's proposal never carries one; a proposal that does is not started here. */
  agent?: string | null;
  unreadable: UnreadableField[];
}

/**
 * A move starts a proposal only when an agent's task enters Todo from another column. One already in Todo was put there by the
 * board (a proposal never waits in Todo), so reordering it must not seal its prompt as the user's.
 */
export function startsProposal(task: Pick<Proposal, 'createdBy' | 'status'>, to: Status): boolean {
  return task.createdBy === 'agent' && task.status !== 'todo' && to === 'todo';
}

/**
 * Starting a proposal is the user's sealed act: its prompt, as the page showed it, sealed again for the creator "user", which is
 * the only thing a worker runs with the user's permissions. Throws when the prompt could not be read, since sealing the
 * placeholder would start something else.
 */
export async function sealStart(keys: Keys, proposal: Proposal): Promise<string> {
  if (proposal.createdBy !== 'agent') throw new InputError('Only a task an agent proposed is started this way.');
  if (proposal.agent)
    throw new InputError('This proposal names an agent, which a proposal never does, so it cannot be started here.');
  if (proposal.unreadable.includes('input'))
    throw new InputError('This proposal’s prompt cannot be read, so it cannot be started here.');
  const row: RowRef = {
    kind: 'task',
    id: proposal.id,
    createdBy: 'user',
    scheduleId: proposal.scheduleId,
    forkOf: null,
  };
  return checked(() => sealInput(sealerFor(keys), row, proposal.input));
}

/** What applying a polished prompt needs of the task it is for, as the page shows it. */
export interface PolishApplyTarget {
  id: string;
  title: string;
  input: string;
  createdBy: TaskCreator;
  /** The agent the task runs as, null for none: its prompt is sealed under it too, so it must be stated. */
  agent: string | null;
  /** The task it was forked from, if it is a fork: its prompt is sealed under the link too. */
  forkOf?: string;
  unreadable: UnreadableField[];
}

/**
 * Applying a polished prompt is the user's sealed act: the polished title and prompt, sealed as the task's own and the user's, and
 * the old ones, sealed as a note of the user's. Throws when the old text could not be read, since it could not be kept.
 */
export async function sealApply(
  keys: Keys,
  options: { polishId: string; target: PolishApplyTarget; rewrite: Pick<Polish, 'title' | 'prompt'> },
): Promise<UiInputs['tasks.applyPolish']> {
  const { polishId, target, rewrite } = options;
  if (target.createdBy !== 'user') throw new InputError('Only a task you created takes a polished prompt.');
  // The watches are only shown, so a list that does not open leaves the task readable.
  if (target.unreadable.some((field) => field !== 'watches'))
    throw new InputError('This task cannot be read, so what it says now could not be kept.');
  const row: RowRef = {
    kind: 'task',
    id: target.id,
    createdBy: 'user',
    scheduleId: null,
    agent: target.agent,
    forkOf: target.forkOf ?? null,
  };
  const seal = sealerFor(keys);
  return {
    id: target.id,
    polishId,
    title: await checked(() => sealTitle(seal, row, rewrite.title)),
    input: await checked(() => sealInput(seal, row, rewrite.prompt)),
    previous: await checked(() =>
      sealNote(seal, { taskId: target.id, author: 'user', kind: 'event' }, previousText(target)),
    ),
  };
}

/** The task whose settings change, as the page shows it: its directory is sealed under its own row. */
export interface ConfigureTarget {
  id: string;
  createdBy: TaskCreator;
  scheduleId: string | null;
  forkOf?: string;
}

/** The settings to change; absent leaves one alone. A null model or effort is claude's default, a null place is no directory and no machine. */
export interface Configuration {
  model?: string | null;
  effort?: Effort | null;
  /** A lane name, or null for the machine's default lane. */
  lane?: string | null;
  autoDone?: boolean;
  icon?: string | null;
  /** The whole new list; empty removes them. */
  labels?: string[];
  place?: { machine: string; workdir: string } | null;
  title?: string;
}

/** A new directory is sealed as the user's under the row's own binding, the one the page opens it under; a schedule's occurrence is bound to both. */
export async function sealConfigure(
  keys: Keys,
  options: { task: ConfigureTarget } & Configuration,
): Promise<UiInputs['tasks.configure']> {
  const { task, model, effort, lane, autoDone, icon, labels, place } = options;
  const title = options.title?.trim();
  if (title === '') throw new InputError('Write a title first.');
  if (title !== undefined && task.scheduleId !== null)
    throw new InputError('This card is a run of a schedule; rename it on the Schedules page.');
  const row: RowRef = {
    kind: 'task',
    id: task.id,
    createdBy: task.createdBy,
    scheduleId: task.scheduleId,
    forkOf: task.forkOf ?? null,
  };
  return {
    id: task.id,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(lane === undefined ? {} : { lane }),
    ...(autoDone === undefined ? {} : { autoDone }),
    ...(icon === undefined
      ? {}
      : { icon: icon === null ? null : await checked(() => sealIcon(sealerFor(keys), row, icon)) }),
    ...(labels === undefined ? {} : { labels: await checked(() => sealLabels(sealerFor(keys), row, labels)) }),
    ...(title === undefined ? {} : { title: await checked(() => sealTitle(sealerFor(keys), row, title)) }),
    ...(place === undefined
      ? {}
      : {
          place:
            place === null
              ? null
              : {
                  machine: place.machine,
                  workdir: await checked(() => sealWorkdir(sealerFor(keys), row, place.workdir)),
                },
        }),
  };
}

/** What forking a task needs of it as the page shows it. */
export interface ForkSource {
  id: string;
  status: Status;
  closed: boolean;
  createdBy: TaskCreator;
  machine: string | null;
  sessionId: string | null;
  workdir: string | null;
  /** The agent it runs as, which the fork keeps. */
  agent?: string | null;
  unreadable: UnreadableField[];
}

/** Whether the task page offers Fork: a task with a Claude session on a machine, that is not closed and not an agent's proposal. */
export function canFork(task: Pick<ForkSource, 'sessionId' | 'machine' | 'closed' | 'createdBy' | 'agent'>): boolean {
  return (
    task.sessionId !== null &&
    task.machine !== null &&
    !task.closed &&
    task.createdBy !== 'agent' &&
    !isAgentlessIntake(task)
  );
}

/** A task of the removed built-in intake that names no agent has no rules to run under, so nothing forks it. */
const isAgentlessIntake = (task: Pick<ForkSource, 'createdBy' | 'agent'>): boolean =>
  task.createdBy === 'intake' && (task.agent ?? null) === null;

/** Why a task cannot be forked, or undefined when it can: only a task with a Claude session on a machine that is not closed or an agent's proposal. */
export function forkProblem(task: ForkSource): string | undefined {
  if (task.createdBy === 'agent') return 'An agent proposed this task; start it first.';
  if (isAgentlessIntake(task))
    return 'The built-in intake that made this task was removed, and the task names no agent, so a fork would have no rules to run under.';
  if (task.closed) return 'A closed task cannot be forked.';
  if (task.sessionId === null || task.machine === null)
    return 'This task has no Claude session on a machine yet, so there is nothing to fork.';
  if (task.workdir === null || task.unreadable.some((field) => field === 'workdir' || field === 'agent'))
    return 'This task’s directory or agent cannot be read, and a fork takes over both.';
  return undefined;
}

/**
 * Forking is the user's sealed act: the instructions are sealed for the new task, its fork link and the parent's agent, and the
 * parent's directory for the new task. The board takes the machine and the model from the parent itself.
 */
export async function sealFork(
  keys: Keys,
  options: { parent: ForkSource; title: string; input: string },
): Promise<UiInputs['tasks.fork']> {
  const { parent } = options;
  const problem = forkProblem(parent);
  if (problem !== undefined || parent.workdir === null) throw new InputError(problem ?? 'This task has no directory.');
  const input = options.input.trim();
  if (input === '') throw new InputError('Write the instructions first');
  const title = options.title.trim() || defaultTitle(input);
  const id = newTaskId();
  const row: RowRef = {
    kind: 'task',
    id,
    createdBy: 'user',
    scheduleId: null,
    agent: parent.agent ?? null,
    forkOf: parent.id,
  };
  const sealed = await checked(() =>
    sealFields(sealerFor(keys), row, { title, input, workdir: parent.workdir ?? undefined }),
  );
  if (sealed.workdir === undefined) throw new InputError('The directory could not be sealed.');
  return {
    id,
    parentId: parent.id,
    title: sealed.title,
    input: sealed.input,
    workdir: sealed.workdir,
    ...(sealed.agent === undefined ? {} : { agent: sealed.agent }),
  };
}

/** The task whose prompt is edited, as the page shows it; a schedule's occurrence is edited through its schedule instead. */
export interface EditTarget {
  id: string;
  title: string;
  input: string;
  createdBy: TaskCreator;
  scheduleId: string | null;
  /** The agent the task runs as, null for none: its prompt is sealed under it too, so it must be stated. */
  agent: string | null;
  /** The task it was forked from, if it is a fork: its prompt is sealed under the link too. */
  forkOf?: string;
  unreadable: UnreadableField[];
}

function editedFields(title: string, input: string): { title: string; input: string } {
  const text = input.trim();
  if (text === '') throw new InputError('Write a prompt first');
  return { title: title.trim() || defaultTitle(text), input: text };
}

/**
 * Editing a task's prompt is the user's sealed act: the new title and prompt sealed under the task's row as the user's, and
 * the old ones as a note of the user's. Throws when the old text could not be read, since it could not be kept.
 */
export async function sealEdit(
  keys: Keys,
  options: { target: EditTarget; title: string; input: string },
): Promise<UiInputs['tasks.edit']> {
  const { target } = options;
  if (target.createdBy !== 'user') throw new InputError('Only a task you created has a prompt you can edit.');
  if (target.scheduleId !== null)
    throw new InputError('This card is the next run of a schedule; edit the prompt on the Schedules page.');
  if (target.unreadable.some((field) => field !== 'watches'))
    throw new InputError('This task cannot be read, so what it says now could not be kept.');
  const fields = editedFields(options.title, options.input);
  const row: RowRef = {
    kind: 'task',
    id: target.id,
    createdBy: 'user',
    scheduleId: null,
    agent: target.agent,
    forkOf: target.forkOf ?? null,
  };
  const seal = sealerFor(keys);
  return {
    id: target.id,
    title: await checked(() => sealTitle(seal, row, fields.title)),
    input: await checked(() => sealInput(seal, row, fields.input)),
    previous: await checked(() =>
      sealNote(seal, { taskId: target.id, author: 'user', kind: 'event' }, textBeforeEdit(target)),
    ),
  };
}

type ScheduleUpdateInput = UiInputs['schedules.update'];

/** The schedule's settings as the Edit schedule form holds them: everything the board stores clear is as `schedules.update` takes it. */
export type ScheduleUpdate = Omit<ScheduleUpdateInput, 'title' | 'input' | 'agent' | 'icon' | 'labels' | 'place'> & {
  title: string;
  input: string;
  /** The name of the agent of the machine's config.json; null for none. */
  agent: string | null;
  /** The machine and the directory on it; null for neither. */
  place: { machine: string; workdir: string } | null;
  /** The unreadable fields of the schedule as the page shows it: an edit would overwrite them unseen. */
  unreadable: UnreadableField[];
};

/**
 * Editing a schedule is the user's sealed act: the title, prompt, directory and agent sealed together under the schedule, since
 * the title and prompt are bound to the agent and must be sealed again whenever it changes. The pending card copies them.
 */
export async function sealScheduleUpdate(keys: Keys, update: ScheduleUpdate): Promise<ScheduleUpdateInput> {
  const { title, input, agent, place, unreadable, ...clear } = update;
  if (unreadable.length > 0) throw new InputError('This schedule cannot be read, so it is not edited here.');
  const fields = editedFields(title, input);
  const agentName = agent?.trim() ?? '';
  if (agentName !== '' && !isAgentName(agentName)) throw new InputError(`The agent name must be ${AGENT_NAME_RULE}.`);
  const row: RowRef = { kind: 'schedule', id: update.id, agent: agentName === '' ? null : agentName };
  const sealed = await checked(() => sealFields(sealerFor(keys), row, { ...fields, workdir: place?.workdir }));
  return {
    ...clear,
    title: sealed.title,
    input: sealed.input,
    ...(sealed.agent === undefined ? {} : { agent: sealed.agent }),
    place: place === null || sealed.workdir === undefined ? null : { machine: place.machine, workdir: sealed.workdir },
  };
}

export type TitleRulesInput = UiInputs['titleRules.set'];

/** The next version of the title rules, sealed under its own version, for a save over `expectedVersion` (0: none saved yet). */
export async function sealTitleRulesInput(
  keys: Keys,
  rules: TitleRule[],
  expectedVersion: number,
): Promise<TitleRulesInput> {
  const version = expectedVersion + 1;
  const document = await checked(() => sealTitleRules(sealerFor(keys), { version, rules }));
  return { document, version, expectedVersion };
}

export type LinkRulesInput = UiInputs['links.set'];

/** The next version of the link rules, sealed under its own version, for a save over `expectedVersion` (0: none saved yet). */
export async function sealLinks(keys: Keys, rules: LinkRule[], expectedVersion: number): Promise<LinkRulesInput> {
  const version = expectedVersion + 1;
  const document = await checked(() => sealLinkRules(sealerFor(keys), { version, rules }));
  return { document, version, expectedVersion };
}

// Which (field, context) pair a value is sealed under is decided by the shared sealing rules, which the CLI uses too; this
// only puts the unlocked keys behind it.
export const sealerFor =
  (keys: Keys): Sealer =>
  (binding, plaintext) =>
    seal(keys, binding.field, binding.context, plaintext);

export const openAs = (keys: Keys, { field, context }: Binding, envelope: string): Promise<string> =>
  open(keys, field, context, envelope);
