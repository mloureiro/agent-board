import {
  ContractError,
  INVALID_VALUE,
  MAX_SCHEDULE_CONCURRENT,
  isCronExpression,
  isEnvelope,
  isPriority,
  isSafeNoteId,
  isSafeTaskId,
  isSessionId,
  openFields,
  openIcon,
  openLabels,
  openMachineCatalog,
  openMachineFeeds,
  parseFeedRequest,
  type MachineFeed,
  openMachineDirs,
  openMachineUsage,
  openNote,
  openSharedAgents,
  openLinkRules,
  isLinkRulesVersion,
  isSharedAgentsVersion,
  openPrs,
  openPreview,
  isWatchId,
  openWatches,
  parseContextEvent,
  parseTranscriptEvent,
  taskLabels,
  transcriptBinding,
  UNREADABLE_TEXT,
  type Answer,
  type Binding,
  type Keys,
  type LinkRule,
  type MachineCatalog,
  type MachineDir,
  type MachineUsage,
  type NoteKind,
  type Opener,
  type PrState,
  type Question,
  type TaskPr,
  type TaskWatch,
  type TranscriptEvent,
  type TranscriptEventView,
  type UnreadableField,
} from '@agent-board/shared';
import { openAs } from './contexts';
import {
  checkNoteShapes,
  isCount,
  checkTaskShapes,
  safeId,
  safeNullableId,
  shownName,
  shownRule,
  type ShownAuthor,
} from './shapes';
import { viewSharedAgents, type SharedAgentView } from './sharedAgents';
import type { RouterOutputs } from './wire';

type WireBoardTask = RouterOutputs['tasks']['get']['task'];
type WireListedTask = RouterOutputs['tasks']['list'][number];
type WireLastNote = NonNullable<WireListedTask['lastNote']>;
type WireThreadNote = RouterOutputs['tasks']['get']['thread'][number];
type WireSchedule = RouterOutputs['schedules']['list'][number];
type WireEvent = RouterOutputs['transcript']['events'][number];
type WireContext = RouterOutputs['transcript']['context'];

interface SealedFields {
  title: string;
  input: string;
  workdir: string | null;
}

export type BoardTask = Omit<
  WireBoardTask,
  keyof SealedFields | 'icon' | 'labels' | 'pr' | 'prState' | 'prs' | 'promptPrState' | 'watches' | 'watchStops'
> &
  SealedFields & {
    icon: string | null;
    // The PRs its agent reported, those that open under their binding as a GitHub PR URL; see `prsOf`.
    prs: TaskPr[];
    promptPrState: PrState | null;
    // What the task's machine watches for it, when the list opens under its binding; null when there is none or it does not open.
    watches: TaskWatch[] | null;
    // How many events of the task wait for its agent, as the machine published it.
    watchEvents: number;
    // The watches you asked to stop that the machine has not acknowledged yet.
    watchStops: string[];
    skillLabels: string[];
    labels: string[];
    unreadable: UnreadableField[];
    // The clear fields the board sent in a shape it does not promise; they are shown as neutral values.
    invalid: string[];
  };

export interface LastNote {
  kind: NoteKind;
  author: ShownAuthor;
  text: string;
  createdAt: string;
  unreadable: boolean;
}

export type ListedTask = BoardTask & { lastNote: LastNote | null; context: ContextReading | null };

export interface ThreadNote {
  id: string;
  text: string;
  createdAt: string;
  author: ShownAuthor;
  kind: NoteKind;
  by: string | null;
  // The text, the questions or the answers could not be opened: never show the note as the user's or the agent's words.
  unreadable: boolean;
  // The board sent several notes with this id, so none of them is shown.
  duplicateId?: boolean;
  questions?: Question[];
  answers?: Answer[];
  questionNoteId?: string;
  // On a comment by the agent: the reply it drafted for you.
  suggestion?: string;
  // Your message to a running agent that no worker has handed over yet.
  pending?: boolean;
  // When a worker handed your message to the running agent.
  deliveredAt?: string;
}

export interface TaskDetail {
  task: BoardTask;
  thread: ThreadNote[];
  followUps: BoardTask[];
  parent: BoardTask | null;
}

export type Schedule = Omit<WireSchedule, keyof SealedFields | 'icon' | 'labels'> &
  SealedFields & {
    icon: string | null;
    labels: string[];
    unreadable: UnreadableField[];
    // The clear fields the board sent in a shape it does not promise; the page shows a placeholder for them.
    invalid: string[];
  };
// A count the board sent that is not a whole number is null.
export type TranscriptRun = Omit<RouterOutputs['transcript']['runs'][number], 'eventCount'> & {
  eventCount: number | null;
};
// `name` is what the board sent, kept to send back (a token with a name that does not pass the shape check can still be revoked);
// `shown` is what the page may print.
export type Machine = Omit<RouterOutputs['machines']['list'][number], 'dirs' | 'usage'> & {
  shown: string;
  // The directories the machine listed, with the label it gave each, as the user's own text; null when it has no list to
  // offer: none sent, a revoked machine, or a name that does not pass the shape check.
  dirs: MachineDir[] | null;
  // The machine has a list that does not open under its name or is not of its shape, so it offers nothing.
  dirsUnreadable: boolean;
  // The usage status the machine sent, as display only; null when it sent none, is revoked or has a name that does not pass the
  // shape check.
  usage: MachineUsage | null;
  // The machine has a status that does not open under its name or is not of its shape.
  usageUnreadable: boolean;
};
// The skills and models a machine listed, as advice for what the forms offer; null when it has none to offer: one that does not
// open under its name, is not of its shape, or belongs to a name that does not pass the shape check.
export type OpenedCatalog = { name: string; catalog: MachineCatalog | null };

// One envelope always opens to the same text, so the 5 s polls of every task's prompt decrypt only what is new. Transcript
// values are large and opened once on demand, so they are not kept.
const MAX_CACHED = 5_000;
const opened = new WeakMap<Keys, Map<string, Promise<string | undefined>>>();

/** Opens one value; undefined when it cannot be opened: legacy plain text, another key, or damage. */
export function tryOpen(keys: Keys, binding: Binding, value: string): Promise<string | undefined> {
  if (!isEnvelope(value)) return Promise.resolve(undefined);
  const attempt = (): Promise<string | undefined> => openAs(keys, binding, value).catch(() => undefined);
  if (binding.field.startsWith('tr.')) return attempt();
  const cache = opened.get(keys) ?? new Map<string, Promise<string | undefined>>();
  opened.set(keys, cache);
  const id = `${binding.field}\0${binding.context}\0${value}`;
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const pending = attempt();
  cache.set(id, pending);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value ?? id);
  return pending;
}

export const openerFor =
  (keys: Keys): Opener =>
  (binding, value) =>
    tryOpen(keys, binding, value);

export async function openBoardTask(keys: Keys, wire: WireBoardTask): Promise<BoardTask> {
  const { invalid, ...shapes } = checkTaskShapes(wire);
  const row = {
    kind: 'task',
    id: wire.id,
    createdBy: shapes.createdBy,
    scheduleId: shapes.scheduleId,
    forkOf: shapes.forkOf ?? null,
  } as const;
  const [fields, icon, labels, prs, watches] = await Promise.all([
    openFields(openerFor(keys), row, wire),
    openIcon(openerFor(keys), row, wire.icon),
    openLabels(openerFor(keys), row, wire.labels),
    openPrs(openerFor(keys), wire.id, wire.prs ?? []),
    openWatches(openerFor(keys), wire.id, wire.watches),
  ]);
  const { pr: _pr, prState: _prState, prs: _prs, watches: _watches, watchStops, ...rest } = wire;
  return {
    ...rest,
    ...shapes,
    ...fields,
    icon,
    unreadable: watches.unreadable ? [...fields.unreadable, 'watches'] : fields.unreadable,
    prs,
    watches: watches.watches,
    watchEvents: watches.pendingEvents,
    watchStops: Array.isArray(watchStops) ? watchStops.filter(isWatchId) : [],
    promptPrState: wire.promptPrState ?? null,
    skillLabels: taskLabels({ input: fields.input, createdBy: shapes.createdBy }),
    labels,
    invalid,
  };
}

async function openLastNote(keys: Keys, taskId: string, wire: WireLastNote): Promise<LastNote> {
  const shapes = checkNoteShapes({ id: 'last', author: wire.author, kind: wire.kind, by: null });
  if (shapes.author === 'unknown' || !shapes.ok)
    return {
      kind: shapes.kind,
      createdAt: wire.createdAt,
      author: shapes.author,
      text: UNREADABLE_TEXT,
      unreadable: true,
    };
  const { text, unreadable } = await openPreview(openerFor(keys), taskId, {
    author: shapes.author,
    kind: shapes.kind,
    preview: wire.preview,
  });
  return {
    kind: shapes.kind,
    createdAt: wire.createdAt,
    author: shapes.author,
    text: text ?? UNREADABLE_TEXT,
    unreadable,
  };
}

export async function openListedTasks(keys: Keys, wire: WireListedTask[]): Promise<ListedTask[]> {
  return Promise.all(
    wire.map(async ({ lastNote, context, ...task }) => {
      const [opened, note, reading] = await Promise.all([
        openBoardTask(keys, task),
        lastNote === null ? null : openLastNote(keys, task.id, lastNote),
        openContext(keys, task.id, context),
      ]);
      return { ...opened, lastNote: note, context: reading === 'unreadable' ? null : reading };
    }),
  );
}

async function openThreadNote(
  keys: Keys,
  taskId: string,
  wire: WireThreadNote,
  duplicate: boolean,
): Promise<ThreadNote> {
  const shapes = checkNoteShapes(wire);
  const base = { id: shapes.id, createdAt: wire.createdAt, kind: shapes.kind, by: shapes.by };
  const unreadable = { ...base, author: shapes.author, text: '', unreadable: true };
  if (duplicate) return { ...unreadable, duplicateId: true };
  if (!shapes.ok || shapes.author === 'unknown') return unreadable;
  const opened = await openNote(openerFor(keys), taskId, { ...wire, author: shapes.author, kind: shapes.kind });
  const questionNoteId =
    wire.questionNoteId !== undefined && isSafeNoteId(wire.questionNoteId)
      ? { questionNoteId: wire.questionNoteId }
      : {};
  const delivery = {
    ...(wire.pending === true ? { pending: true } : {}),
    ...(typeof wire.deliveredAt === 'string' && !Number.isNaN(Date.parse(wire.deliveredAt))
      ? { deliveredAt: wire.deliveredAt }
      : {}),
  };
  return { ...base, ...opened, ...questionNoteId, ...delivery };
}

/**
 * A thread as it is shown. Notes of one id are one note, so a board that sends the same id twice (to put an earlier question
 * where the open one is, say) gets none of them shown: every note with a repeated id is unreadable.
 */
export async function openThread(keys: Keys, taskId: string, wire: WireThreadNote[]): Promise<ThreadNote[]> {
  const counts = new Map<string, number>();
  for (const note of wire) counts.set(note.id, (counts.get(note.id) ?? 0) + 1);
  return Promise.all(wire.map((note) => openThreadNote(keys, taskId, note, (counts.get(note.id) ?? 0) > 1)));
}

export async function openTaskDetail(keys: Keys, wire: RouterOutputs['tasks']['get']): Promise<TaskDetail> {
  const [task, thread, followUps, parent] = await Promise.all([
    openBoardTask(keys, wire.task),
    openThread(keys, wire.task.id, wire.thread),
    Promise.all(wire.followUps.map((followUp) => openBoardTask(keys, followUp))),
    wire.parent === null ? null : openBoardTask(keys, wire.parent),
  ]);
  return { task, thread, followUps, parent };
}

export async function openSchedule(keys: Keys, wire: WireSchedule): Promise<Schedule> {
  const id = safeId(wire.id, 'schedule id');
  const [fields, icon, labels] = await Promise.all([
    openFields(openerFor(keys), { kind: 'schedule', id }, wire),
    openIcon(openerFor(keys), { kind: 'schedule', id }, wire.icon),
    openLabels(openerFor(keys), { kind: 'schedule', id }, wire.labels),
  ]);
  const remainingOk = wire.remaining === null || isCount(wire.remaining);
  const everyOk = wire.everyMs === null || (isCount(wire.everyMs) && wire.everyMs > 0);
  const moreCrons = (wire.moreCrons ?? []).filter(isCronExpression);
  const moreCronsOk = moreCrons.length === (wire.moreCrons ?? []).length;
  const afterOk = wire.after === null || (isSafeTaskId(wire.after.scheduleId) && isCount(wire.after.delayMs));
  const limitOk =
    wire.maxConcurrent === null ||
    (isCount(wire.maxConcurrent) && wire.maxConcurrent >= 1 && wire.maxConcurrent <= MAX_SCHEDULE_CONCURRENT);
  return {
    ...wire,
    ...fields,
    icon,
    labels,
    id,
    priority: isPriority(wire.priority) ? wire.priority : 'normal',
    machine: shownName(wire.machine),
    requestedLane: shownName(wire.requestedLane),
    ...shownRule(wire),
    remaining: remainingOk ? wire.remaining : null,
    everyMs: everyOk ? wire.everyMs : null,
    moreCrons,
    after: afterOk ? wire.after : { scheduleId: INVALID_VALUE, delayMs: 0 },
    maxConcurrent: limitOk ? wire.maxConcurrent : null,
    invalid: [
      ...(remainingOk ? [] : ['remaining']),
      ...(everyOk ? [] : ['everyMs']),
      ...(moreCronsOk ? [] : ['moreCrons']),
      ...(afterOk ? [] : ['after']),
      ...(limitOk ? [] : ['maxConcurrent']),
    ],
    occurrenceTaskId: safeNullableId(wire.occurrenceTaskId, 'occurrence id'),
  };
}

export async function openSchedules(keys: Keys, wire: WireSchedule[]): Promise<Schedule[]> {
  return Promise.all(wire.map((schedule) => openSchedule(keys, schedule)));
}

/** The runs of a task: ids are what the events are asked for, so a bad one refuses the reply; a machine name or session that is not of its shape shows as neutral. */
export function openRuns(wire: RouterOutputs['transcript']['runs']): TranscriptRun[] {
  return wire.map((run) => {
    if (!isSafeNoteId(run.id)) throw new ContractError('The board sent a run id that is not an id.');
    return {
      ...run,
      machine: shownName(run.machine) ?? INVALID_VALUE,
      eventCount: isCount(run.eventCount) ? run.eventCount : null,
      sessionId: run.sessionId !== null && isSessionId(run.sessionId) ? run.sessionId : null,
    };
  });
}

export async function openMachines(keys: Keys, wire: RouterOutputs['machines']['list']): Promise<Machine[]> {
  return Promise.all(
    wire.map(async ({ dirs: sealed, usage: sealedUsage, ...machine }) => {
      const shown = shownName(machine.name) ?? INVALID_VALUE;
      const offers = machine.revokedAt === null && shown !== INVALID_VALUE && sealed !== null && sealed !== undefined;
      const opened = offers ? await openMachineDirs(openerFor(keys), machine.name, sealed) : undefined;
      const reports =
        machine.revokedAt === null && shown !== INVALID_VALUE && sealedUsage !== null && sealedUsage !== undefined;
      const usage = reports ? await openMachineUsage(openerFor(keys), machine.name, sealedUsage) : undefined;
      return {
        ...machine,
        shown,
        dirs: opened ?? null,
        dirsUnreadable: offers && opened === undefined,
        usage: usage ?? null,
        usageUnreadable: reports && usage === undefined,
      };
    }),
  );
}

export async function openCatalogs(keys: Keys, wire: RouterOutputs['machines']['catalogs']): Promise<OpenedCatalog[]> {
  return Promise.all(
    wire.map(async ({ name, catalog: sealed }) => ({
      name,
      catalog:
        shownName(name) === INVALID_VALUE || sealed === null
          ? null
          : ((await openMachineCatalog(openerFor(keys), name, sealed)) ?? null),
    })),
  );
}

/** The board's agent definitions as the Agents page shows them; `agents` is null when the document does not open. */
export interface BoardAgents {
  version: number;
  pushedAt: string;
  agents: SharedAgentView[] | null;
}

/** Null when no agent was ever pushed; a version or time of the wrong shape leaves the document unopened. */
export async function openBoardAgents(
  keys: Keys,
  wire: RouterOutputs['agents']['shared'],
): Promise<BoardAgents | null> {
  if (wire === null) return null;
  const { version, document, pushedAt } = wire;
  const opened = isSharedAgentsVersion(version)
    ? await openSharedAgents(openerFor(keys), version, document)
    : undefined;
  return {
    version: isSharedAgentsVersion(version) ? version : 0,
    pushedAt: typeof pushedAt === 'string' ? pushedAt : '',
    agents: opened === undefined ? null : await viewSharedAgents(opened.agents),
  };
}

/** The user's link rules: `rules` is null when the document does not open, which leaves every text without links. */
export interface BoardLinks {
  version: number;
  updatedAt: string;
  rules: LinkRule[] | null;
}

/** Null when no rule was ever saved; a version or time of the wrong shape leaves the document unopened. */
export async function openBoardLinks(keys: Keys, wire: RouterOutputs['links']['get']): Promise<BoardLinks | null> {
  if (wire === null) return null;
  const { version, document, updatedAt } = wire;
  const opened = isLinkRulesVersion(version) ? await openLinkRules(openerFor(keys), version, document) : undefined;
  return {
    version: isLinkRulesVersion(version) ? version : 0,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
    rules: opened?.rules ?? null,
  };
}

/** An event that cannot be opened becomes a note saying so, so the rest of the run still reads. */
export async function openEvent(
  keys: Keys,
  run: { taskId: string; runId: string },
  wire: WireEvent,
): Promise<TranscriptEventView> {
  const text = await tryOpen(keys, transcriptBinding('tr.data', run.taskId, run.runId, wire.seq), wire.data);
  let event: TranscriptEvent | undefined;
  try {
    // The sealed JSON is written by whichever worker version ran; one that does not fit this version's shape is unreadable.
    event = text === undefined ? undefined : parseTranscriptEvent(JSON.parse(text));
  } catch {
    // Falls through to the placeholder.
  }
  if (event !== undefined && event.kind === wire.kind && event.seq === wire.seq) {
    const outputSize = isCount(wire.outputSize) ? wire.outputSize : null;
    if (event.kind !== 'tool_result') return { ...event, outputSize };
    const { output: _output, ...rest } = event;
    return { ...rest, outputSize };
  }
  const parent = wire.parent !== null && isSafeNoteId(wire.parent) ? wire.parent : null;
  return { seq: wire.seq, at: wire.at, parent, kind: 'note', text: UNREADABLE_TEXT, outputSize: null };
}

export async function openEvents(
  keys: Keys,
  run: { taskId: string; runId: string },
  wire: WireEvent[],
): Promise<TranscriptEventView[]> {
  return Promise.all(wire.map((event) => openEvent(keys, run, event)));
}

export async function openOutput(
  keys: Keys,
  run: { taskId: string; runId: string },
  seq: number,
  wire: string | null,
): Promise<string> {
  if (wire === null) return '';
  return (await tryOpen(keys, transcriptBinding('tr.output', run.taskId, run.runId, seq), wire)) ?? UNREADABLE_TEXT;
}

/** One machine's feeds as the Feeds page shows them; `feeds` is null when the document does not open. */
export interface OpenedFeeds {
  machine: string;
  feeds: MachineFeed[] | null;
  updatedAt: string | null;
  lastSeenAt: string | null;
  // The pending requests (`pause:<id>` and the like) the machine has not applied yet.
  requests: string[];
}

export async function openFeeds(keys: Keys, wire: RouterOutputs['feeds']['list']): Promise<OpenedFeeds[]> {
  return Promise.all(
    wire.map(async ({ name, feeds: sealed, feedsUpdatedAt, feedRequests, lastSeenAt }) => {
      const shown = shownName(name) ?? INVALID_VALUE;
      const opened =
        shown === INVALID_VALUE || sealed === null ? undefined : await openMachineFeeds(openerFor(keys), name, sealed);
      return {
        machine: shown,
        feeds: opened?.feeds ?? null,
        updatedAt: feedsUpdatedAt,
        lastSeenAt,
        requests: feedRequests.filter((request) => parseFeedRequest(request) !== undefined),
      };
    }),
  );
}

export interface ContextReading {
  used: number;
  window: number | null;
  threshold: number | null;
  model: string;
  at: string;
}

export async function openContext(
  keys: Keys,
  taskId: string,
  wire: WireContext,
): Promise<ContextReading | null | 'unreadable'> {
  if (wire === null) return null;
  if (!isSafeNoteId(wire.runId)) return 'unreadable';
  const text = await tryOpen(keys, transcriptBinding('tr.data', taskId, wire.runId, wire.seq), wire.data);
  let event: ReturnType<typeof parseContextEvent>;
  try {
    event = text === undefined ? undefined : parseContextEvent(JSON.parse(text));
  } catch {
    return 'unreadable';
  }
  if (event === undefined || event.seq !== wire.seq) return 'unreadable';
  const { used, window, threshold, model } = event;
  return { used, window, threshold, model, at: String(wire.at) };
}
