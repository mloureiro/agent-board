// How board content is sealed and opened, for the CLI and the browser alike. The server keeps no key and reads nothing, so
// what a client acts on or shows as trusted is exactly what a client of the user sealed *for that purpose*: every sealed
// value is bound, through the context of its envelope, to the row it belongs to. The table of (field, context) rules is in
// docs/encryption.md; this module is its one implementation.
//
//   field          context
//   title          <origin>
//   input          <origin>:<creator>, then :fork:<parentId> for a fork, then :agent:<name> with an agent
//   agent          <origin> (the name of the agent the task runs as)
//   icon           <origin> (the emoji the user chose for the card)
//   labels         <origin> (the labels the user gave the task, one JSON list)
//   workdir        <origin>, or for a scheduled task also task:<id>:schedule:<scheduleId> (the worker's rewrite)
//   pr             task:<id>:agent (a PR URL the task's agent reported; every PR of the task has this binding)
//   watches        task:<id>:agent (the watches of the task the machine's CLI runs for it, one JSON document)
//   machine.dirs   machine:<name> (the directory list the machine's CLI sends, one JSON document)
//   machine.catalog machine:<name> (the skills and models the machine's CLI found, one JSON document)
//   machine.usage  machine:<name> (the usage limits, readings and held tasks the machine's CLI found, one JSON document)
//   machine.sources machine:<name> (the sources the machine's CLI runs: names, timers and last runs, one JSON document)
//   agents.shared  agents:v<version> (every agent definition the user pushed to the board, one JSON document; see sharedAgents.mts)
//   links          links:v<version> (the link rules the user set in the browser, one JSON document; see linkRules.mts)
//   note.*         note:<taskId>:<author>:<kind>
//   tr.*           <taskId>:<runId>:<seq>
//
// An agent's name is in the context of the input as well as sealed on its own, so a board that drops or swaps the agent field
// leaves a prompt that opens under no binding: the task is unreadable and never runs unrestricted. A row without an agent
// has the context it always had. The task a fork was made from is in the context the same way, before the agent: a board that
// adds, drops or swaps `fork_of` leaves a prompt that opens under no binding, so the task never runs, and a fork never runs as
// anything but what it was made as.
//
// <origin> is task:<id> for a task, schedule:<id> for a schedule and for a task that is an occurrence of one (the server
// copies the schedule's ciphertext into it); <creator> is who made the task: user, agent, or intake (a task of the removed built-in intake).
//
// The plumbing stays with the callers: `Sealer` and `Opener` seal and open one value (the browser memoises opening), and
// everything here is the rules around them. A value that does not open under exactly its binding is unreadable, and an
// unreadable value is never replaced by a looser reading.
import { catalogProblem, machineCatalogJson, parseMachineCatalog } from './catalog.mts';
import type { MachineCatalog } from './catalog.mts';
import { machineUsageJson, parseMachineUsage, usageProblem } from './machineUsage.mts';
import type { MachineUsage } from './machineUsage.mts';
import { machineSourcesJson, parseMachineSources, sourcesProblem } from './machineSources.mts';
import type { MachineSources } from './machineSources.mts';
import {
  AGENT_NAME_RULE,
  checkSealedSize,
  ContractError,
  DIR_LABEL_RULE,
  checkLabels,
  ICON_RULE,
  isAgentName,
  isEmojiIcon,
  isSafeDirLabel,
  isSafeTaskId,
  isSafeWorkdir,
  NOTE_SUGGESTION_CHARS,
  notePreview,
  UNREADABLE_TITLE,
} from './contract.mts';
import type {
  MachineDir,
  NoteKind,
  TaskCreator,
  TaskPr,
  UnreadableField,
  WireNoteAuthor,
  WireNoteInput,
  WireTaskPr,
} from './contract.mts';
import { blindIndex } from './crypto.mts';
import type { Field, Keys } from './crypto.mts';
import { isServerEventText } from './events.mts';
import { isRecord } from './guards.mts';
import { isPrUrl } from './prompt.mts';
import { parseAnswers, parseQuestions, QuestionError } from './questions.mts';
import type { Answer, Question } from './questions.mts';
import { parseTaskWatches, taskWatchesJson } from './watches.mts';
import type { TaskWatch, TaskWatchDocument } from './watches.mts';

export interface Binding {
  field: Field;
  context: string;
}

/** Seals one value under its binding. */
export type Sealer = (binding: Binding, plaintext: string) => Promise<string>;

/** Opens one value under its binding; undefined when it cannot be opened: plain text, another key, another binding, damage. */
export type Opener = (binding: Binding, value: string) => Promise<string | undefined>;

/** `agent` is the name of the agent the row runs as, when it has one; `forkOf` the id of the task a task was forked from. */
export type RowRef =
  | {
      kind: 'task';
      id: string;
      createdBy: TaskCreator;
      scheduleId: string | null;
      agent?: string | null;
      forkOf: string | null;
    }
  | { kind: 'schedule'; id: string; agent?: string | null };

// The creator an occurrence has: the server makes it as the user's.
const SCHEDULE_CREATOR: TaskCreator = 'user';

function origin(row: RowRef): string {
  if (row.kind === 'schedule') return `schedule:${row.id}`;
  return row.scheduleId === null ? `task:${row.id}` : `schedule:${row.scheduleId}`;
}

const creatorOf = (row: RowRef): TaskCreator => (row.kind === 'schedule' ? SCHEDULE_CREATOR : row.createdBy);

export const titleBinding = (row: RowRef): Binding => ({ field: 'title', context: origin(row) });

/** The agent name a row is sealed with, or null; a name that is not an agent's cannot be sealed. */
function agentOf(row: RowRef): string | null {
  const name = row.agent ?? null;
  if (name !== null && !isAgentName(name)) throw new ContractError(`an agent name must be ${AGENT_NAME_RULE}`);
  return name;
}

/** The task a row was forked from, or null; an id that is not a task's cannot be sealed, and a schedule or an occurrence is never a fork. */
function forkOf(row: RowRef): string | null {
  const parent = row.kind === 'task' ? row.forkOf : null;
  if (parent === null) return null;
  if (!isSafeTaskId(parent)) throw new ContractError('the task a fork was made from must be a task id');
  if (row.kind === 'task' && row.scheduleId !== null)
    throw new ContractError('an occurrence of a schedule cannot be a fork');
  return parent;
}

export function inputBinding(row: RowRef): Binding {
  const agent = agentOf(row);
  const parent = forkOf(row);
  const creator = `${origin(row)}:${creatorOf(row)}`;
  const context = parent === null ? creator : `${creator}:fork:${parent}`;
  return { field: 'input', context: agent === null ? context : `${context}:agent:${agent}` };
}

/** The agent's name is bound to the row's origin, so a schedule's name is the one its occurrences open. */
export const agentBinding = (row: RowRef): Binding => ({ field: 'agent', context: origin(row) });

/** The icon is bound to the row's origin like the agent, so a schedule's icon is the one its occurrences open. */
export const iconBinding = (row: RowRef): Binding => ({ field: 'icon', context: origin(row) });

export async function sealIcon(seal: Sealer, row: RowRef, icon: string): Promise<string> {
  if (!isEmojiIcon(icon)) throw new ContractError(`an icon must be ${ICON_RULE}`);
  return sealChecked(seal, iconBinding(row), icon, 'the icon');
}

/** The icon of a task or schedule, or null when there is none or what opens is not one emoji. Display only, never acted on. */
export async function openIcon(open: Opener, row: RowRef, wire: string | null | undefined): Promise<string | null> {
  if (wire === null || wire === undefined) return null;
  const icon = await open(iconBinding(row), wire);
  return icon !== undefined && isEmojiIcon(icon) ? icon : null;
}

/** The labels are bound to the row's origin like the icon, so a schedule's labels are the ones its occurrences open. */
export const labelsBinding = (row: RowRef): Binding => ({ field: 'labels', context: origin(row) });

/** The labels as one sealed JSON list, checked by `checkLabels`; null when none are left, which the board stores as no labels. */
export async function sealLabels(seal: Sealer, row: RowRef, labels: readonly string[]): Promise<string | null> {
  const checked = checkLabels(labels);
  if (checked.length === 0) return null;
  return sealChecked(seal, labelsBinding(row), JSON.stringify(checked), 'the labels');
}

/** The labels of a task or schedule; empty when there are none or what opens is not a list of labels. Display only, never acted on. */
export async function openLabels(open: Opener, row: RowRef, wire: string | null | undefined): Promise<string[]> {
  if (wire === null || wire === undefined) return [];
  const text = await open(labelsBinding(row), wire);
  if (text === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.every((label) => typeof label === 'string')) return [];
    const labels = checkLabels(parsed);
    return labels.length === parsed.length ? labels : [];
  } catch {
    return [];
  }
}

/** The binding a new directory is sealed under: an occurrence's own rewrite names its schedule, so it is only an occurrence's. */
export function workdirBinding(row: RowRef): Binding {
  if (row.kind === 'task' && row.scheduleId !== null)
    return { field: 'workdir', context: `task:${row.id}:schedule:${row.scheduleId}` };
  return { field: 'workdir', context: origin(row) };
}

/** The bindings a directory opens under: its own, and for an occurrence also the schedule's (which the server copied). */
export function workdirOpenBindings(row: RowRef): Binding[] {
  if (row.kind === 'task' && row.scheduleId !== null)
    return [{ field: 'workdir', context: origin(row) }, workdirBinding(row)];
  return [workdirBinding(row)];
}

/** The PR URL an agent reports for its task: bound to the task and to the agent, so nothing else's ciphertext opens as one. */
export const prBinding = (taskId: string): Binding => ({ field: 'pr', context: `task:${taskId}:agent` });

/** Seals the PR URL the agent of `taskId` opened; refuses anything that is not a GitHub pull request URL. */
export async function sealPr(seal: Sealer, taskId: string, url: string): Promise<string> {
  if (!isPrUrl(url))
    throw new ContractError('the pull request must be a URL like https://github.com/<owner>/<repo>/pull/<number>');
  return sealChecked(seal, prBinding(taskId), url, 'the pull request');
}

/** The PR URL of a task, or null when there is none or what opens is not a GitHub PR URL. */
export async function openPr(open: Opener, taskId: string, wire: string | null | undefined): Promise<string | null> {
  if (wire === null || wire === undefined) return null;
  const url = await open(prBinding(taskId), wire);
  return url !== undefined && isPrUrl(url) ? url : null;
}

/** The reported PRs of a task, in the order given; a row that does not open as a GitHub PR URL is dropped. */
export async function openPrs(open: Opener, taskId: string, rows: readonly WireTaskPr[]): Promise<TaskPr[]> {
  const opened = await Promise.all(
    rows.map(async ({ id, pr, state }) => {
      const url = await openPr(open, taskId, pr);
      return url === null ? [] : [{ id, url, state }];
    }),
  );
  return opened.flat();
}

/** The watches of a task: bound to the task and to its agent side, like a reported PR, so nothing else's ciphertext opens as them. */
export const watchesBinding = (taskId: string): Binding => ({ field: 'watches', context: `task:${taskId}:agent` });

/** Seals the watches of `taskId`; refuses more than the board shows, an entry of the wrong shape and more than the board takes. */
export async function sealWatches(
  seal: Sealer,
  taskId: string,
  watches: readonly TaskWatch[],
  pendingEvents: number,
): Promise<string> {
  const json = taskWatchesJson(watches, pendingEvents);
  if (parseTaskWatches(JSON.parse(json))?.watches.length !== watches.length)
    throw new ContractError('the watches must be at most 32 entries of the shape the board shows');
  return sealChecked(seal, watchesBinding(taskId), json, 'the watches');
}

export interface OpenedWatches {
  /** The watches the machine published; null for none, and when they could not be opened. */
  watches: TaskWatch[] | null;
  /** How many events of the task wait for the agent, as the machine published it; 0 without a list. */
  pendingEvents: number;
  unreadable: boolean;
}

/**
 * The watches of a task. A task without any (`wire` null) is `{ watches: null, pendingEvents: 0, unreadable: false }`. A value that does not open
 * under exactly the task's binding, or is not `{"watches":[…],"pendingEvents":n}` with at most 32 entries, is unreadable. An entry of the wrong
 * shape is dropped without losing the list. They are shown, never acted on.
 */
export async function openWatches(
  open: Opener,
  taskId: string,
  wire: string | null | undefined,
): Promise<OpenedWatches> {
  if (wire === null || wire === undefined) return { watches: null, pendingEvents: 0, unreadable: false };
  const text = await open(watchesBinding(taskId), wire);
  let document: TaskWatchDocument | undefined;
  try {
    document = text === undefined ? undefined : parseTaskWatches(JSON.parse(text));
  } catch {
    document = undefined;
  }
  return document === undefined
    ? { watches: null, pendingEvents: 0, unreadable: true }
    : { ...document, unreadable: false };
}

/** The directory list of a machine: bound to the machine's name, so a list sealed for one machine never opens as another's. */
export const machineDirsBinding = (machine: string): Binding => ({
  field: 'machine.dirs',
  context: `machine:${machine}`,
});

/** The most directories a machine sends; the CLI's config holds no more. */
export const MAX_MACHINE_DIRS = 200;

/** The one document a machine's list is sealed as, and the bytes its blind index is made of. */
export const machineDirsJson = (dirs: readonly MachineDir[]): string =>
  JSON.stringify({ dirs: dirs.map(({ path, label }) => (label === undefined ? { path } : { path, label })) });

/** A machine's `dirs` as the board stores it: the blind index of `dirs:<machine>:<document>`, to tell whether a list changed. */
export const machineDirsIndex = (keys: Keys, machine: string, dirs: readonly MachineDir[]): Promise<string> =>
  blindIndex(keys, `dirs:${machine}:${machineDirsJson(dirs)}`);

/** Seals the directory list of `machine`; refuses more than the board takes, a path that is not a safe absolute one and a label that is not a safe one. */
export async function sealMachineDirs(seal: Sealer, machine: string, dirs: readonly MachineDir[]): Promise<string> {
  if (dirs.length > MAX_MACHINE_DIRS) throw new ContractError(`the list has more than ${MAX_MACHINE_DIRS} directories`);
  if (!dirs.every(({ path }) => isSafeWorkdir(path)))
    throw new ContractError('a listed directory must be an absolute path');
  if (!dirs.every(({ label }) => label === undefined || isSafeDirLabel(label)))
    throw new ContractError(`a directory label must be ${DIR_LABEL_RULE}`);
  return sealChecked(seal, machineDirsBinding(machine), machineDirsJson(dirs), 'the directory list');
}

/**
 * The directories a machine sent, or undefined when the list is unreadable: it does not open under exactly this machine's
 * binding, is not `{"dirs":[{"path":…}]}`, has more than 200 entries or a path that is not a safe absolute one. An entry's
 * `label` is kept when it is a safe one and dropped otherwise, without losing the list. Other keys are ignored, so a later
 * CLI can add some. The list is advice for what a form offers and is never acted on.
 */
export async function openMachineDirs(
  open: Opener,
  machine: string,
  wire: string | null | undefined,
): Promise<MachineDir[] | undefined> {
  if (wire === null || wire === undefined) return undefined;
  const text = await open(machineDirsBinding(machine), wire);
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(json) || !Array.isArray(json['dirs']) || json['dirs'].length > MAX_MACHINE_DIRS) return undefined;
  const entries: unknown[] = json['dirs'];
  const opened: MachineDir[] = [];
  for (const entry of entries) {
    const path = isRecord(entry) ? entry['path'] : undefined;
    if (!isRecord(entry) || typeof path !== 'string' || !isSafeWorkdir(path)) return undefined;
    const label = entry['label'];
    opened.push(typeof label === 'string' && isSafeDirLabel(label) ? { path, label } : { path });
  }
  return opened;
}

/** The catalogue of a machine: bound to the machine's name like its directory list, and to its own field, so neither opens as the other. */
export const machineCatalogBinding = (machine: string): Binding => ({
  field: 'machine.catalog',
  context: `machine:${machine}`,
});

/** A machine's `catalogIndex` as the board stores it: the blind index of `catalog:<machine>:<document>`, to tell whether a catalogue changed. */
export const machineCatalogIndex = (keys: Keys, machine: string, catalog: MachineCatalog): Promise<string> =>
  blindIndex(keys, `catalog:${machine}:${machineCatalogJson(catalog)}`);

/** Seals the catalogue of `machine`; refuses more than the board takes and an entry that is not of its shape. */
export async function sealMachineCatalog(seal: Sealer, machine: string, catalog: MachineCatalog): Promise<string> {
  const problem = catalogProblem(catalog);
  if (problem !== undefined) throw new ContractError(`the catalogue has ${problem}`);
  return sealChecked(seal, machineCatalogBinding(machine), machineCatalogJson(catalog), 'the catalogue');
}

/**
 * The catalogue a machine sent, or undefined when it is unreadable: it does not open under exactly this machine's binding or
 * is not a catalogue document (`parseMachineCatalog`, which drops an entry of the wrong shape and keeps the rest). Advice for
 * what a form offers, never acted on.
 */
export async function openMachineCatalog(
  open: Opener,
  machine: string,
  wire: string | null | undefined,
): Promise<MachineCatalog | undefined> {
  if (wire === null || wire === undefined) return undefined;
  const text = await open(machineCatalogBinding(machine), wire);
  if (text === undefined) return undefined;
  try {
    return parseMachineCatalog(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** The usage status of a machine: bound to the machine's name and to its own field, so no other document opens as it. */
export const machineUsageBinding = (machine: string): Binding => ({
  field: 'machine.usage',
  context: `machine:${machine}`,
});

/** A machine's `usageIndex` as the board stores it: the blind index of `usage:<machine>:<document>`, to tell whether the status changed. */
export const machineUsageIndex = (keys: Keys, machine: string, usage: MachineUsage): Promise<string> =>
  blindIndex(keys, `usage:${machine}:${machineUsageJson(usage)}`);

/** Seals the usage status of `machine`; refuses more than the board takes and an entry that is not of its shape. */
export async function sealMachineUsage(seal: Sealer, machine: string, usage: MachineUsage): Promise<string> {
  const problem = usageProblem(usage);
  if (problem !== undefined) throw new ContractError(`the usage status has ${problem}`);
  return sealChecked(seal, machineUsageBinding(machine), machineUsageJson(usage), 'the usage status');
}

/**
 * The usage status a machine sent, or undefined when it is unreadable: it does not open under exactly this machine's binding
 * or is not a usage document (`parseMachineUsage`, which drops an entry of the wrong shape and keeps the rest). Display only.
 */
export async function openMachineUsage(
  open: Opener,
  machine: string,
  wire: string | null | undefined,
): Promise<MachineUsage | undefined> {
  if (wire === null || wire === undefined) return undefined;
  const text = await open(machineUsageBinding(machine), wire);
  if (text === undefined) return undefined;
  try {
    return parseMachineUsage(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** The sources of a machine: bound to the machine's name and to their own field, so no other document opens as them. */
export const machineSourcesBinding = (machine: string): Binding => ({
  field: 'machine.sources',
  context: `machine:${machine}`,
});

/** A machine's `sourcesIndex` as the board stores it: the blind index of `sources:<machine>:<document>`, to tell whether they changed. */
export const machineSourcesIndex = (keys: Keys, machine: string, sources: MachineSources): Promise<string> =>
  blindIndex(keys, `sources:${machine}:${machineSourcesJson(sources)}`);

/** Seals the sources of `machine`; refuses more than the board takes and an entry that is not of its shape. */
export async function sealMachineSources(seal: Sealer, machine: string, sources: MachineSources): Promise<string> {
  const problem = sourcesProblem(sources);
  if (problem !== undefined) throw new ContractError(`the sources have ${problem}`);
  return sealChecked(seal, machineSourcesBinding(machine), machineSourcesJson(sources), 'the sources');
}

/** The sources a machine sent, or undefined when they do not open under exactly this machine's binding or are not a sources document. */
export async function openMachineSources(
  open: Opener,
  machine: string,
  wire: string | null | undefined,
): Promise<MachineSources | undefined> {
  if (wire === null || wire === undefined) return undefined;
  const text = await open(machineSourcesBinding(machine), wire);
  if (text === undefined) return undefined;
  try {
    return parseMachineSources(JSON.parse(text));
  } catch {
    return undefined;
  }
}
// A note is bound to its task, its author and its kind, so one author's text can never be served as another's.
export function noteBinding(
  field: 'note.body' | 'note.preview' | 'note.suggestion' | 'note.questions' | 'note.answers',
  taskId: string,
  author: WireNoteAuthor,
  kind: NoteKind,
): Binding {
  return { field, context: `note:${taskId}:${author}:${kind}` };
}

/** The (author, kind) pairs a client writes; a sealed note of any other pair is unreadable. */
const NOTE_PAIRS: Record<Exclude<WireNoteAuthor, 'server'>, readonly NoteKind[]> = {
  agent: ['comment', 'question', 'polish'],
  system: ['event'],
  user: ['comment', 'answer', 'event'],
};

/** A transcript event is bound to its task as well as its run, so the server cannot show one task's run under another. */
export const transcriptBinding = (
  field: 'tr.data' | 'tr.output',
  taskId: string,
  runId: string,
  seq: number,
): Binding => ({
  field,
  context: `${taskId}:${runId}:${seq}`,
});

/** Seals a value, after checking it fits what the board takes for the field; the error names the limit. */
export async function sealChecked(seal: Sealer, binding: Binding, plaintext: string, what: string): Promise<string> {
  checkSealedSize(binding.field, plaintext, what);
  return seal(binding, plaintext);
}

/** A task's `dedupeKey` as the board stores it: the blind index of the key itself (the PR URL, for a review task). */
export const dedupeKeyIndex = (keys: Keys, key: string): Promise<string> => blindIndex(keys, key);

/** A task's `head` as the board stores it: the blind index of `head:<sha>`, which is what a script compares with. */
export const headIndex = (keys: Keys, sha: string): Promise<string> => blindIndex(keys, `head:${sha}`);

export interface SealedFields {
  title: string;
  input: string;
  workdir?: string;
  agent?: string;
}

export const sealTitle = (seal: Sealer, row: RowRef, text: string): Promise<string> =>
  sealChecked(seal, titleBinding(row), text, 'the title');

export const sealInput = async (seal: Sealer, row: RowRef, text: string): Promise<string> =>
  sealChecked(seal, inputBinding(row), text, 'the prompt');

export const sealWorkdir = (seal: Sealer, row: RowRef, text: string): Promise<string> =>
  sealChecked(seal, workdirBinding(row), text, 'the directory');

/** Seals the agent name of `row`, which must have one. */
export async function sealAgent(seal: Sealer, row: RowRef): Promise<string> {
  const agent = agentOf(row);
  if (agent === null) throw new ContractError('the row has no agent to seal');
  return sealChecked(seal, agentBinding(row), agent, 'the agent');
}

/** Seals a row's fields; the agent of `row`, if it has one, is sealed too and is part of the context of the input. */
export async function sealFields(
  seal: Sealer,
  row: RowRef,
  fields: { title: string; input: string; workdir?: string | undefined },
): Promise<SealedFields> {
  return {
    title: await sealTitle(seal, row, fields.title),
    input: await sealInput(seal, row, fields.input),
    ...(fields.workdir === undefined ? {} : { workdir: await sealWorkdir(seal, row, fields.workdir) }),
    ...(agentOf(row) === null ? {} : { agent: await sealAgent(seal, row) }),
  };
}

export async function sealNote(
  seal: Sealer,
  note: { taskId: string; author: Exclude<WireNoteAuthor, 'server'>; kind: NoteKind },
  text: string,
  // `previewSource` is what the preview is cut from, when that is not the note's text itself.
  options: { suggestion?: string; previewSource?: string } = {},
): Promise<WireNoteInput> {
  const { taskId, author, kind } = note;
  const { suggestion, previewSource = text } = options;
  const preview = notePreview(previewSource);
  if (suggestion !== undefined) {
    if (author !== 'agent' || kind !== 'comment')
      throw new ContractError('only a comment by the agent can carry a suggestion');
    if (suggestion.trim() === '') throw new ContractError('the suggestion is empty');
    if (Array.from(suggestion).length > NOTE_SUGGESTION_CHARS)
      throw new ContractError(`the suggestion is too long: at most ${NOTE_SUGGESTION_CHARS} characters`);
  }
  return {
    body: await sealChecked(seal, noteBinding('note.body', taskId, author, kind), text, 'the note'),
    ...(preview === null
      ? {}
      : {
          preview: await sealChecked(seal, noteBinding('note.preview', taskId, author, kind), preview, 'the preview'),
        }),
    ...(suggestion === undefined
      ? {}
      : {
          suggestion: await sealChecked(
            seal,
            noteBinding('note.suggestion', taskId, author, kind),
            suggestion,
            'the suggestion',
          ),
        }),
  };
}

export async function sealQuestions(
  seal: Sealer,
  taskId: string,
  questions: Question[],
): Promise<{ body: string; questions: string }> {
  return {
    body: await sealChecked(seal, noteBinding('note.body', taskId, 'agent', 'question'), '', 'the question'),
    questions: await sealChecked(
      seal,
      noteBinding('note.questions', taskId, 'agent', 'question'),
      JSON.stringify(parseQuestions(questions)),
      'the questions',
    ),
  };
}

/**
 * The user's answers, sealed together with the questions they were shown in one envelope, so that what the agent is later told
 * comes from that envelope alone. Throws a `QuestionError` when the answers do not fit the questions.
 */
export async function sealAnswers(
  seal: Sealer,
  taskId: string,
  questions: Question[],
  answers: Answer[],
): Promise<string> {
  const checked = parseAnswers(questions, answers);
  return sealChecked(
    seal,
    noteBinding('note.answers', taskId, 'user', 'answer'),
    JSON.stringify({ questions, answers: checked }),
    'the answers',
  );
}

export interface OpenedFields {
  title: string;
  input: string;
  workdir: string | null;
  // The agent the task runs as; null for none, and for an unreadable one (see `unreadable`).
  agent: string | null;
  unreadable: UnreadableField[];
}

async function openFirst(open: Opener, bindings: Binding[], value: string): Promise<string | undefined> {
  for (const binding of bindings) {
    const text = await open(binding, value);
    if (text !== undefined) return text;
  }
  return undefined;
}

/** The input under its binding; a row that cannot have one (a fork link that is not a task id, or on an occurrence) has an unreadable input. */
async function openInput(open: Opener, row: RowRef, value: string): Promise<string | undefined> {
  try {
    return await open(inputBinding(row), value);
  } catch (error) {
    if (error instanceof ContractError) return undefined;
    throw error;
  }
}

/**
 * Opens the title, input, directory and agent of a task or schedule. A field that cannot be opened under its binding (or a
 * directory that is not a safe absolute path, or an agent name that is not an agent's) is listed in `unreadable` and replaced:
 * the title by a placeholder, the input by an empty prompt, the directory and the agent by none. A task with an unreadable
 * input, directory or agent must never be run. The input is opened under the agent the wire names, so an unreadable agent
 * leaves it unreadable too, and an input sealed for an agent the wire no longer names does not open at all. `row.agent` is
 * ignored: the wire is the source. `row.forkOf` is a clear value of the wire, so the caller takes it from there, and the input
 * opens only under exactly that fork link.
 */
export async function openFields(
  open: Opener,
  row: RowRef,
  wire: { title: string; input: string; workdir?: string | null | undefined; agent?: string | null | undefined },
): Promise<OpenedFields> {
  const agentText = wire.agent == null ? null : await open(agentBinding(row), wire.agent);
  const agent = agentText != null && isAgentName(agentText) ? agentText : null;
  const agentReadable = wire.agent == null || agent !== null;
  const [title, input, workdir] = await Promise.all([
    open(titleBinding(row), wire.title),
    agentReadable ? openInput(open, { ...row, agent }, wire.input) : undefined,
    wire.workdir == null ? null : openFirst(open, workdirOpenBindings(row), wire.workdir),
  ]);
  const unreadable: UnreadableField[] = [];
  if (title === undefined) unreadable.push('title');
  if (input === undefined) unreadable.push('input');
  const validWorkdir = workdir === undefined || workdir === null || isSafeWorkdir(workdir);
  if (!validWorkdir || workdir === undefined) unreadable.push('workdir');
  if (!agentReadable) unreadable.push('agent');
  return {
    title: title ?? UNREADABLE_TITLE,
    input: input ?? '',
    workdir: workdir !== undefined && validWorkdir ? workdir : null,
    agent,
    unreadable,
  };
}

export interface WireNoteParts {
  author: WireNoteAuthor;
  kind: NoteKind;
  body: string;
  preview: string | null;
  questions?: string | undefined;
  answers?: string | undefined;
  suggestion?: string | undefined;
}

export interface OpenedNote {
  // Empty when `unreadable`.
  text: string;
  author: WireNoteAuthor;
  unreadable: boolean;
  // A question note's questions; an answer note's own copy of the questions it answered.
  questions?: Question[];
  answers?: Answer[];
  // A comment by the agent: the reply it drafted for the user.
  suggestion?: string;
}

async function openJson<T>(
  open: Opener,
  binding: Binding,
  value: string,
  check: (json: unknown) => T,
): Promise<T | undefined> {
  const text = await open(binding, value);
  if (text === undefined) return undefined;
  try {
    return check(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof QuestionError) return undefined;
    throw error;
  }
}

function openAnswerEnvelope(json: unknown): { questions: Question[]; answers: Answer[] } {
  if (typeof json !== 'object' || json === null || !('questions' in json) || !('answers' in json))
    throw new QuestionError('an answer envelope holds the questions and the answers');
  const questions = parseQuestions(json.questions);
  return { questions, answers: parseAnswers(questions, json.answers) };
}

const isKnownPair = (author: WireNoteAuthor, kind: NoteKind): boolean =>
  author !== 'server' && NOTE_PAIRS[author].includes(kind);

/**
 * Opens a thread note. A server event is accepted only for one of the fixed texts (and as author "server"); any other note
 * must be an (author, kind) pair a client writes, and open under its own author and kind, with the questions or answers it
 * needs and nothing else. Otherwise it is unreadable, with no text, and never taken for what anyone wrote.
 */
export async function openNote(open: Opener, taskId: string, wire: WireNoteParts): Promise<OpenedNote> {
  const { author, kind } = wire;
  const unreadable: OpenedNote = { text: '', author, unreadable: true };
  if (author === 'server') {
    const plain = kind === 'event' && wire.questions === undefined && wire.answers === undefined;
    return plain && isServerEventText(wire.body) ? { text: wire.body, author, unreadable: false } : unreadable;
  }
  if (!isKnownPair(author, kind)) return unreadable;
  if ((wire.questions !== undefined) !== (kind === 'question')) return unreadable;
  if ((wire.answers !== undefined) !== (kind === 'answer')) return unreadable;
  if (wire.suggestion !== undefined && (author !== 'agent' || kind !== 'comment')) return unreadable;
  const [text, questions, envelope, suggestion] = await Promise.all([
    open(noteBinding('note.body', taskId, author, kind), wire.body),
    wire.questions === undefined
      ? null
      : openJson(open, noteBinding('note.questions', taskId, author, kind), wire.questions, parseQuestions),
    wire.answers === undefined
      ? null
      : openJson(open, noteBinding('note.answers', taskId, author, kind), wire.answers, openAnswerEnvelope),
    wire.suggestion === undefined ? null : open(noteBinding('note.suggestion', taskId, author, kind), wire.suggestion),
  ]);
  if (text === undefined || questions === undefined || envelope === undefined || suggestion === undefined)
    return unreadable;
  return {
    text,
    author,
    unreadable: false,
    ...(questions ? { questions } : {}),
    ...(envelope ? { questions: envelope.questions, answers: envelope.answers } : {}),
    ...(suggestion === null ? {} : { suggestion }),
  };
}

/**
 * The text a board card shows for the newest note: a server event's own text when it is one of the fixed ones, otherwise the
 * sealed preview opened under the note's binding. An unreadable one has `text` undefined, for the client to put its
 * placeholder there.
 */
export async function openPreview(
  open: Opener,
  taskId: string,
  wire: { author: WireNoteAuthor; kind: NoteKind; preview: string | null },
): Promise<{ text: string | undefined; unreadable: boolean }> {
  const { author, kind, preview } = wire;
  if (author === 'server')
    return kind === 'event' && preview !== null && isServerEventText(preview)
      ? { text: preview, unreadable: false }
      : { text: undefined, unreadable: true };
  if (!isKnownPair(author, kind)) return { text: undefined, unreadable: true };
  if (preview === null) return { text: '', unreadable: false };
  const text = await open(noteBinding('note.preview', taskId, author, kind), preview);
  return { text, unreadable: text === undefined };
}
