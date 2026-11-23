import {
  formatServerEvent,
  isEffort,
  isRecentFirst,
  MAX_TASK_PRS,
  MAX_TASK_WATCHES,
  MAX_WAIT_MS,
  newTaskId,
  PRIORITIES,
  RECENT_FIRST_STATUSES,
  TAKE_BACK_AFTER_MS,
  type ServerEvent,
  type Effort,
  type Heartbeat,
  type Priority,
  type PrState,
  type PrStates,
  type Status,
  type TaskActor,
  type WireNote,
  type WireNoteInput,
  type WireTask,
  type WireTaskDraft,
  type WireTaskPatch,
  type WireWait,
} from '@agent-board/shared';
import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { notes, taskPrs, tasks, type NoteRow, type TaskPrRow, type TaskRow } from '../db/schema';
import { AppError } from './errors';
import { requireSealed } from './sealed';
import { DONE_ARCHIVE_DAYS, daysBefore } from './retention';
import { completeOccurrence, isScheduleFull, occurrenceFinished } from './schedules';
import { edgePosition, getTask, hasStarted, insertTask, lockTask } from './taskRows';

export { getTask };

/** The reported PRs of the tasks, oldest first, by task id. */
export async function listTaskPrs(db: DbOrTx, taskIds: string[]): Promise<Map<string, TaskPrRow[]>> {
  const byTask = new Map<string, TaskPrRow[]>();
  if (taskIds.length === 0) return byTask;
  const rows = await db
    .select()
    .from(taskPrs)
    .where(inArray(taskPrs.taskId, taskIds))
    .orderBy(asc(taskPrs.createdAt), asc(taskPrs.id));
  for (const row of rows) byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row]);
  return byTask;
}

/**
 * How many notes each of the tasks holds, by task id; a task without notes has no entry. It must count what `read-notes` gives:
 * a vocabulary row for a note author or kind has to leave the same notes out here (see `VOCABULARY_FEATURES`).
 */
export async function countTaskNotes(db: DbOrTx, taskIds: string[]): Promise<Map<string, number>> {
  if (taskIds.length === 0) return new Map();
  const rows = await db
    .select({ taskId: notes.taskId, count: count() })
    .from(notes)
    .where(inArray(notes.taskId, taskIds))
    .groupBy(notes.taskId);
  return new Map(rows.map(({ taskId, count: total }) => [taskId, total]));
}

/**
 * `prs` are the task's rows, oldest first. `pr` and `prState` are what a CLI without `task.prs` reads, see `WireTask`.
 * `noteCount` is left out when the caller did not count the notes (the browser does not use it). `held` says the task waits
 * for a free slot of its schedule (`heldTaskIds`).
 */
export function toTask(
  row: TaskRow,
  prs: readonly TaskPrRow[] = [],
  extras: { noteCount?: number; held?: boolean } = {},
): WireTask {
  const { noteCount, held = false } = extras;
  const newest = prs.at(-1);
  return {
    id: row.id,
    title: row.title,
    input: row.input,
    status: row.status,
    priority: row.priority,
    model: row.model,
    effort: isEffort(row.effort) ? row.effort : null,
    requestedLane: row.requestedLane,
    autoDone: row.autoDone,
    closed: row.closed,
    machine: row.machine,
    sessionId: row.sessionId,
    workdir: row.workdir,
    ...(row.agent === null ? {} : { agent: row.agent }),
    icon: row.icon,
    labels: row.labels,
    ...(row.forkOf === null ? {} : { forkOf: row.forkOf }),
    ...(row.movedBy === null ? {} : { movedBy: row.movedBy }),
    pr: newest?.pr ?? null,
    prState: newest === undefined ? row.prState : newest.state,
    prs: prs.map(({ id, pr, state }) => ({ id, pr, state })),
    promptPrState: row.prState,
    watches: row.watches,
    watchStops: row.watchStops,
    next: row.next,
    head: row.head,
    openQuestion: row.openQuestionNoteId !== null,
    createdBy: row.createdBy,
    // Run details describe the current run only.
    lane: row.status === 'running' ? row.lane : null,
    borrowed: row.status === 'running' && row.borrowed,
    lastActiveAt: row.status === 'running' ? row.lastActiveAt : null,
    runStartedAt: row.status === 'running' ? row.runStartedAt : null,
    ...(row.status === 'running' && row.runId !== null ? { run: row.runId } : {}),
    paused: row.pausedAt !== null,
    notBefore: row.notBefore,
    scheduleId: row.scheduleId,
    ...(held ? { held: true as const } : {}),
    wakeAt: row.status === 'waiting' ? row.wakeAt : null,
    waitCheck: row.status === 'waiting' && row.waitCheck,
    woken: row.wokenAt !== null,
    stopRequested: row.status === 'running' && row.stopRequestedAt !== null,
    ...(noteCount === undefined ? {} : { noteCount }),
  };
}

export function toNote(row: NoteRow): WireNote {
  const note: WireNote = {
    id: row.id,
    body: row.body,
    preview: row.preview,
    createdAt: row.createdAt,
    author: row.author,
    kind: row.kind,
  };
  if (row.questions) note.questions = row.questions;
  if (row.answers) note.answers = row.answers;
  if (row.suggestion) note.suggestion = row.suggestion;
  if (row.questionNoteId) note.questionNoteId = row.questionNoteId;
  if (row.pending) note.pending = true;
  if (row.queued) note.queued = true;
  if (row.deliveredAt) note.deliveredAt = row.deliveredAt;
  return note;
}

/**
 * Columns by status, then priority (urgent first), then manual order. In Todo, delayed cards (not yet due) come
 * last, by their start; resumes (answered, replied to, paused) come before the rest: that work is already under way.
 * Waiting, Needs me and Done list the task updated last on top, whatever its priority.
 */
const taskOrder = () => [
  asc(tasks.status),
  desc(sql`case when ${inArray(tasks.status, [...RECENT_FIRST_STATUSES])} then ${tasks.updatedAt} end`),
  sql`case when ${tasks.status} = 'todo' and ${tasks.notBefore} > now() then 1 else 0 end`,
  asc(sql`case when ${tasks.status} = 'todo' and ${tasks.notBefore} > now() then ${tasks.notBefore} end`),
  sql`case when ${tasks.status} = 'todo' and ${tasks.next} = 'resume' then 0 else 1 end`,
  asc(tasks.priority),
  asc(tasks.position),
  asc(tasks.createdAt),
];

/** Every task in column order; closed ones only with `all`. */
export async function listTasks(db: DbOrTx, options: { all?: boolean } = {}): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(options.all ? undefined : eq(tasks.closed, false))
    .orderBy(...taskOrder());
}

/**
 * The newest note of a task, as the board card shows it. `preview` is the note's stored sealed preview, or null for a
 * note without text; for a note by the server it is the event's own plain text, which the author tells apart.
 */
export interface LastNote {
  kind: NoteRow['kind'];
  author: NoteRow['author'];
  preview: string | null;
  createdAt: Date;
}

/** The open or the closed tasks in column order, each with its newest note, in one query. */
export async function listTasksWithLastNote(
  db: DbOrTx,
  options: { closed: boolean },
): Promise<{ row: TaskRow; lastNote: LastNote | null }[]> {
  const latest = db
    .select({
      kind: notes.kind,
      author: notes.author,
      preview: sql<string | null>`case when ${notes.author} = 'server' then ${notes.body} else ${notes.preview} end`.as(
        'preview',
      ),
      createdAt: notes.createdAt,
    })
    .from(notes)
    .where(eq(notes.taskId, tasks.id))
    .orderBy(desc(notes.createdAt), desc(notes.id))
    .limit(1)
    .as('latest');
  const rows = await db
    .select({
      row: tasks,
      lastNote: { kind: latest.kind, author: latest.author, preview: latest.preview, createdAt: latest.createdAt },
    })
    .from(tasks)
    .leftJoinLateral(latest, sql`true`)
    .where(eq(tasks.closed, options.closed))
    .orderBy(...taskOrder());
  return rows.map(({ row, lastNote }) => ({ row, lastNote: lastNote?.kind ? lastNote : null }));
}

/** New task at the bottom of its status. A known dedupe key returns the existing task instead. */
export async function addTask(db: DbOrTx, draft: WireTaskDraft): Promise<{ row: TaskRow; created: boolean }> {
  return db.transaction((tx) => insertTask(tx, draft));
}

export interface ForkRequest {
  /** The new task's id, which its sealed fields are bound to. */
  id: string;
  parentId: string;
  title: string;
  input: string;
  /** The parent's directory, sealed for the new task. */
  workdir: string;
  /** The parent's agent, sealed for the new task; present exactly when the parent has one. */
  agent?: string;
}

/**
 * A new task in Todo whose first run continues a copy of the parent's Claude session, on the parent's machine, with the parent's
 * model, effort and agent. The parent stays as it is. Only the user forks: the prompt is bound to the fork link by the browser, so a
 * server cannot make one up, and a machine's `add-task` has no way to name a parent to fork.
 */
export async function forkTask(db: DbOrTx, request: ForkRequest): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const parent = await getTask(tx, request.parentId);
    if (parent.proposed || parent.createdBy === 'agent')
      throw new AppError('FORBIDDEN', 'An agent proposed this task; start it first.');
    if (parent.createdBy === 'intake' && parent.agent === null)
      throw new AppError(
        'FORBIDDEN',
        'The built-in intake that made this task was removed, and the task names no agent, so a fork would have no rules to run under.',
      );
    if (parent.closed) throw new AppError('CONFLICT', 'A closed task cannot be forked.');
    if (parent.sessionId === null || parent.machine === null)
      throw new AppError('CONFLICT', 'This task has no Claude session on a machine yet, so there is nothing to fork.');
    if ((request.agent === undefined) !== (parent.agent === null))
      throw new AppError('BAD_REQUEST', 'A fork runs as the agent of the task it was forked from, and as no other.');
    const { row } = await insertTask(
      tx,
      {
        id: request.id,
        title: request.title,
        input: request.input,
        status: 'todo',
        createdBy: 'user',
        parentId: parent.id,
        machine: parent.machine,
        workdir: request.workdir,
        ...(parent.model === null ? {} : { model: parent.model }),
        ...(isEffort(parent.effort) ? { effort: parent.effort } : {}),
        ...(parent.requestedLane === null ? {} : { lane: parent.requestedLane }),
        ...(request.agent === undefined ? {} : { agent: request.agent }),
      },
      { forkOf: parent.id },
    );
    return row;
  });
}

type TaskValues = Partial<typeof tasks.$inferInsert>;

interface Transition {
  /** Default: the task's own status. */
  to?: Status;
  /** Default: where it is when the status stays, else the bottom. A number is a position between neighbours. */
  place?: 'top' | 'bottom' | number;
  /** Who makes the change; only a user starts a proposal. */
  by: TaskActor;
  /** The user's start of an agent's proposal: its prompt, sealed again for the creator "user". Nothing else takes a proposal into Todo. */
  start?: { input: string };
  /** Columns on top of what the invariants set; they win. */
  set?: TaskValues;
  /** The user ended the run: pending messages become replies, but the task goes where the user sent it. */
  userStop?: boolean;
}

/** A pause survives the wait in Todo and the claim; the worker clears it, or the task leaving Running another way does. */
function keepsPause(from: Status, to: Status): boolean {
  return (from === 'todo' && (to === 'todo' || to === 'running')) || (from === 'running' && to === 'running');
}

/** Only `wait` takes a task into Waiting: a wait needs its end, and only a running agent knows what it waits for. */
function requireNotIntoWaiting(task: TaskRow, to: Status): void {
  if (to === 'waiting' && task.status !== 'waiting')
    throw new AppError('BAD_REQUEST', 'Only a running agent puts a task in Waiting (board wait).');
}

/**
 * Every status change goes through here, in a transaction that holds the task's lock, so the columns that depend
 * on the status cannot drift apart: the open question (only while it waits in Needs me), the run's start, a proposal
 * (only a user starts it, with its prompt sealed again as theirs), a pause, a start time (only while it waits in Todo), the
 * position.
 */
async function transition(tx: DbOrTx, task: TaskRow, change: Transition): Promise<TaskRow> {
  const leavingRunning = task.status === 'running' && (change.to ?? task.status) !== 'running';
  const handedBack = leavingRunning
    ? await handBackPendingMessages(tx, task, change.to, change.userStop === true)
    : undefined;
  const to = handedBack ? 'todo' : (change.to ?? task.status);
  const moved = to !== task.status;
  if (change.by !== 'user' && moved && task.proposed)
    throw new AppError('FORBIDDEN', 'An agent proposed this task; only you start it.');
  if (task.proposed && to === 'todo' && change.start === undefined)
    throw new AppError('FORBIDDEN', 'An agent proposed this task; start it first.');
  const now = new Date();
  const values: TaskValues = { status: to, updatedAt: now };
  if (moved) values.movedBy = change.by;
  if (to !== 'needs-me') values.openQuestionNoteId = null;
  if (!keepsPause(task.status, to)) values.pausedAt = null;
  // A wait that ends into Todo resumes the session (it is still under way) and tells the agent why; a wake survives the
  // claim like a pause does. A task that leaves Waiting any other way just drops the wait.
  if (task.status === 'waiting' && to === 'todo') {
    values.wokenAt = now;
    values.next = task.sessionId ? 'resume' : 'fresh';
  } else if (!keepsPause(task.status, to)) values.wokenAt = null;
  if (to !== 'waiting') {
    values.wakeAt = null;
    values.waitCheck = false;
  }
  if (change.start !== undefined) {
    values.input = change.start.input;
    values.createdBy = 'user';
    values.proposed = false;
  }
  if (to === 'running' && task.status !== 'running') {
    values.runStartedAt = now;
    values.runId = randomBytes(16).toString('base64url');
    values.lastActiveAt = now;
    values.lane = null;
    values.borrowed = false;
  }
  if (to !== 'running') {
    values.runStartedAt = null;
    values.runId = null;
  }
  if (to !== 'todo') values.notBefore = null;
  if (to === 'done' || to === 'backlog' || change.set?.closed === true) {
    values.watches = null;
    values.watchStops = [];
  }
  if (to !== 'running') {
    values.stopRequestedAt = null;
    values.stopMessageId = null;
    values.inboxRead = false;
  }
  const place = handedBack ? 'top' : (change.place ?? (moved ? 'bottom' : undefined));
  if (typeof place === 'number') values.position = place;
  else if (place !== undefined) values.position = await edgePosition(tx, to, place);
  const [row] = await tx
    .update(tasks)
    .set({ ...values, ...change.set, ...handedBack })
    .where(eq(tasks.id, task.id))
    .returning();
  // A schedule's pending occurrence that leaves Todo, or is closed there, makes room for the next one.
  const leftTodo = task.status === 'todo' && (to !== 'todo' || (row!.closed && !task.closed));
  if (leftTodo && task.scheduleId !== null) await completeOccurrence(tx, task.id, task.scheduleId, now);
  return row!;
}

/**
 * A run that ends while messages the user sent it were never handed over must not lose them, whichever way it ends: the
 * messages stop being pending (they are replies now, which the next resume prompt carries), and a task that would have waited
 * for the user (Needs me, Done) or for something outside (Waiting) goes to the top of Todo to resume with them instead.
 * Returns the columns that override the move, or undefined when it is none of that.
 */
async function handBackPendingMessages(
  tx: DbOrTx,
  task: TaskRow,
  to: Status | undefined,
  userStop: boolean,
): Promise<TaskValues | undefined> {
  const handedOver = await tx
    .update(notes)
    .set({ pending: false })
    .where(and(eq(notes.taskId, task.id), eq(notes.pending, true)))
    .returning({ id: notes.id });
  // A run whose worker never read the inbox (a CLI before 0.9) would not find the message in the resume prompt.
  if (
    userStop ||
    !task.inboxRead ||
    handedOver.length === 0 ||
    (to !== 'needs-me' && to !== 'done' && to !== 'waiting')
  )
    return undefined;
  await systemEvent(tx, task.id, { type: 'late-message' }, null);
  return {
    next: task.sessionId ? 'resume' : 'fresh',
    openQuestionNoteId: null,
    wakeAt: null,
    waitCheck: false,
  };
}

const NOT_AUTO_DONE = 'This task is not set to finish by itself: move it to needs-me, and the user marks it done.';

/**
 * A status or priority change puts the task at the bottom of its new place. With `run` the call comes from that run of the
 * task, which is its agent: it may not touch a later run, it may change the status only while the run still holds the task,
 * and it may move the task to Done only when the task is set to `autoDone`; the move goes to the top of Done. A call without
 * a run comes from a machine's script or terminal and moves the task wherever it names. `by` is the calling machine.
 */
export async function updateTask(
  db: DbOrTx,
  id: string,
  patch: WireTaskPatch,
  by: string,
  run?: string,
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const current = await lockTask(tx, id);
    if (patch.expect !== undefined && patch.expect !== current.status)
      throw new AppError('CONFLICT', `the task is ${current.status}, not ${patch.expect}`);
    if (run !== undefined) {
      const refused = notInRun(current, run, { moves: patch.status !== undefined });
      if (refused) throw new AppError('CONFLICT', refused);
      if (patch.status === 'done' && !current.autoDone) throw new AppError('FORBIDDEN', NOT_AUTO_DONE);
    }
    const set: TaskValues = {};
    if (patch.input !== undefined) set.input = patch.input;
    if (patch.sessionId !== undefined) set.sessionId = patch.sessionId;
    if (patch.workdir !== undefined) set.workdir = patch.workdir;
    if (patch.next !== undefined) set.next = patch.next;
    if (patch.head !== undefined) set.head = patch.head;
    if (patch.notBefore instanceof Date) {
      if ((patch.status ?? current.status) !== 'todo')
        throw new AppError('CONFLICT', 'Only a task in Todo can have a start time.');
      set.notBefore = patch.notBefore;
    } else if (patch.notBefore === null) set.notBefore = null;
    if (patch.priority !== undefined && patch.priority !== current.priority) set.priority = patch.priority;
    if (patch.status !== undefined) requireNotIntoWaiting(current, patch.status);
    // The worker has read the pause and the wake by now; its first update of the run consumes them.
    if (current.status === 'running') {
      set.pausedAt = null;
      set.wokenAt = null;
    }
    const agentDone = run !== undefined && patch.status === 'done';
    let place: Transition['place'];
    if (agentDone) place = 'top';
    else if (set.priority !== undefined) place = 'bottom';
    const row = await transition(tx, current, {
      to: patch.status,
      place,
      by: run === undefined ? 'machine' : 'agent',
      set,
    });
    // Pending messages send the task back to Todo instead, and then nothing was finished.
    if (agentDone && row.status === 'done')
      await systemEvent(tx, id, { type: 'moved', from: 'running', to: 'done' }, by);
    // A run that hands its card back as done work (not one that asks, fails or is stopped) lets the schedules after it start.
    if (current.status === 'running' && (row.status === 'needs-me' || row.status === 'done'))
      await occurrenceFinished(tx, current, row.updatedAt);
    return row;
  });
}

/** The task a machine may attach to: its session lives on that machine and no run owns it. */
export async function attachSession(db: DbOrTx, id: string, machine: string): Promise<TaskRow> {
  const task = await getTask(db, id);
  if (task.status === 'running')
    throw new AppError(
      'CONFLICT',
      'the task is running: its headless run owns the session; watch its Transcript on the task page',
    );
  if (task.sessionId === null) throw new AppError('CONFLICT', 'the task has no session');
  if (task.machine !== machine)
    throw new AppError('FORBIDDEN', `the session lives on ${task.machine ?? 'no machine'}, not on ${machine}`);
  return task;
}

/**
 * Todo to running for `machine`; the lock lets two machines claim at once and only one win.
 * A resume is pinned to the machine that holds its session, a task with its own directory to the machine it was placed on,
 * a proposal (a task that still names an agent as its creator) is not for a worker to start, a delayed task is not due
 * before its start time, and a card of a schedule with a limit waits while other cards of it use all the slots.
 * Undefined when the claim is lost.
 */
export async function claimTask(db: DbOrTx, id: string, machine: string): Promise<TaskRow | undefined> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, id);
    const free =
      task.status === 'todo' &&
      !task.closed &&
      !task.proposed &&
      task.createdBy !== 'agent' &&
      (task.notBefore === null || task.notBefore.getTime() <= Date.now()) &&
      (task.workdir === null || task.machine === null || task.machine === machine) &&
      (task.next === 'fresh' || task.sessionId === null || task.machine === null || task.machine === machine) &&
      (task.scheduleId === null || !(await isScheduleFull(tx, task.scheduleId, task.id)));
    return free ? transition(tx, task, { to: 'running', by: 'machine', set: { machine } }) : undefined;
  });
}

export async function addNote(
  db: DbOrTx,
  taskId: string,
  note: {
    author: NoteRow['author'];
    kind?: NoteRow['kind'];
    body: string;
    preview?: string | null;
    suggestion?: string;
    by: string | null;
    questions?: string;
    answers?: string;
    questionNoteId?: string;
    /** A message to a running agent, waiting for its worker to hand it over. */
    pending?: boolean;
  },
): Promise<NoteRow> {
  // Only the server's own events are plain text; whatever a client wrote must arrive sealed.
  if (note.author !== 'server') requireSealed(note.body, 'the note body');
  requireSealed(note.preview, 'the note preview');
  requireSealed(note.suggestion, 'the suggestion');
  if (note.suggestion !== undefined && (note.author !== 'agent' || (note.kind ?? 'comment') !== 'comment'))
    throw new AppError('BAD_REQUEST', 'Only a comment by the agent can carry a suggestion.');
  requireSealed(note.questions, 'the questions');
  requireSealed(note.answers, 'the answers');
  await getTask(db, taskId);
  const [row] = await db
    .insert(notes)
    .values({
      id: newTaskId(),
      taskId,
      author: note.author,
      kind: note.kind ?? 'comment',
      body: note.body,
      preview: note.preview ?? null,
      suggestion: note.suggestion ?? null,
      by: note.by,
      questions: note.questions ?? null,
      answers: note.answers ?? null,
      questionNoteId: note.questionNoteId ?? null,
      pending: note.pending ?? false,
      queued: note.pending ?? false,
    })
    .returning();
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));
  return row!;
}

/**
 * The agent's question: a question note, and the task waits in needs-me for the answer. Only the machine whose run holds the
 * task may ask: a stale agent (its run taken back, the task finished or run elsewhere) must not pull the task into Needs me.
 */
export async function ask(
  db: DbOrTx,
  taskId: string,
  asked: { body: string; questions: string },
  by: string,
  run?: string,
): Promise<NoteRow> {
  return db.transaction(async (tx) => {
    const current = await lockTask(tx, taskId);
    // Answering a question starts the task as the user, so a proposal cannot ask one.
    if (current.proposed) throw new AppError('FORBIDDEN', 'An agent proposed this task; only you start it.');
    const refused = notHeldBy(current, by, 'running', { run });
    if (refused) throw new AppError('CONFLICT', refused);
    const note = await addNote(tx, taskId, {
      author: 'agent',
      kind: 'question',
      body: asked.body,
      by,
      questions: asked.questions,
    });
    await transition(tx, current, { to: 'needs-me', by: 'agent', set: { openQuestionNoteId: note.id } });
    return note;
  });
}

export async function readNotes(db: DbOrTx, taskId: string): Promise<NoteRow[]> {
  await getTask(db, taskId);
  return db.select().from(notes).where(eq(notes.taskId, taskId)).orderBy(asc(notes.createdAt), asc(notes.id));
}

function requireNotRunning(task: TaskRow): void {
  if (task.status === 'running') throw new AppError('CONFLICT', 'The task is running. Wait until it reports back.');
}

/**
 * The user's answer to the open question. The server cannot read questions or answers, so it only checks that the
 * question note is the task's open one; the client checked the answers against the questions. The task goes to the top of
 * Todo and the next run resumes the agent's session with the answers.
 */
export async function answer(
  db: DbOrTx,
  input: { taskId: string; questionNoteId: string; answers: string; message: WireNoteInput; by: string },
): Promise<TaskRow> {
  requireSealed(input.answers, 'the answers');
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    requireNotRunning(task);
    if (task.openQuestionNoteId !== input.questionNoteId)
      throw new AppError('CONFLICT', 'This question was already answered or replaced.');
    const [question] = await tx
      .select({ id: notes.id, questions: notes.questions })
      .from(notes)
      .where(and(eq(notes.id, input.questionNoteId), eq(notes.taskId, task.id), eq(notes.kind, 'question')));
    if (!question?.questions) throw new AppError('NOT_FOUND', 'The question is gone.');
    await addNote(tx, task.id, {
      author: 'user',
      kind: 'answer',
      body: input.message.body,
      preview: input.message.preview ?? null,
      by: input.by,
      answers: input.answers,
      questionNoteId: question.id,
    });
    return continueTask(tx, task);
  });
}

/**
 * The user drops the open question without an answer. The task stays in Needs me where it is, and nothing is written to
 * the thread: a question note that is no longer the open one and has no answer reads as dismissed.
 */
export async function dismissQuestion(db: DbOrTx, input: { taskId: string; questionNoteId: string }): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    if (task.openQuestionNoteId !== input.questionNoteId)
      throw new AppError('CONFLICT', 'This question was already answered or replaced.');
    return transition(tx, task, { by: 'user', set: { openQuestionNoteId: null } });
  });
}

/** A user comment; with `resume` it also sends the task back to the agent. */
export async function reply(
  db: DbOrTx,
  input: { taskId: string; message: WireNoteInput; resume: boolean; by: string },
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    if (input.resume) requireNotRunning(task);
    await addNote(tx, task.id, {
      author: 'user',
      kind: 'comment',
      body: input.message.body,
      preview: input.message.preview ?? null,
      by: input.by,
    });
    return input.resume ? continueTask(tx, task) : getTask(tx, task.id);
  });
}

/**
 * The user's message. A running agent gets it without being interrupted: it waits as a pending note until the worker hands
 * it over (`runInbox`). In any other status it is "Send & continue": a reply that sends the task back to the agent.
 */
export async function send(
  db: DbOrTx,
  input: { taskId: string; message: WireNoteInput; by: string },
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    if (task.status !== 'running') return reply(tx, { ...input, resume: true });
    await addNote(tx, task.id, {
      author: 'user',
      kind: 'comment',
      body: input.message.body,
      preview: input.message.preview ?? null,
      by: input.by,
      pending: true,
    });
    return task;
  });
}

/**
 * The user's stop. A running task is asked to end its run, with an optional message that follows the interruption; the
 * worker acts on it. A resume that no worker has picked up yet, or a wait, is simply taken off the agent's hands.
 */
export async function stop(
  db: DbOrTx,
  input: { taskId: string; message?: WireNoteInput | undefined; by: string },
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    if (task.status === 'running') {
      const message =
        input.message === undefined
          ? undefined
          : await addNote(tx, task.id, {
              author: 'user',
              kind: 'comment',
              body: input.message.body,
              preview: input.message.preview ?? null,
              by: input.by,
              pending: true,
            });
      const [row] = await tx
        .update(tasks)
        .set({ stopRequestedAt: new Date(), stopMessageId: message?.id ?? null, updatedAt: new Date() })
        .where(eq(tasks.id, task.id))
        .returning();
      return row!;
    }
    if (task.status === 'todo' && task.next === 'resume' && !task.closed) {
      await systemEvent(tx, task.id, { type: 'moved', from: 'todo', to: 'needs-me' }, input.by);
      return transition(tx, task, { to: 'needs-me', by: 'user' });
    }
    if (task.status === 'waiting') {
      await systemEvent(tx, task.id, { type: 'moved', from: 'waiting', to: 'backlog' }, input.by);
      return transition(tx, task, { to: 'backlog', by: 'user' });
    }
    throw new AppError(
      'CONFLICT',
      `The task is ${task.status}; only a running, waiting or answered task can be stopped.`,
    );
  });
}

/**
 * Back to the agent: top of Todo, because the user is waiting on it. With a session it resumes there,
 * on the machine that holds it; without one the next run starts fresh and reads the thread.
 */
async function continueTask(tx: DbOrTx, task: TaskRow): Promise<TaskRow> {
  return transition(tx, task, {
    to: 'todo',
    place: 'top',
    by: 'user',
    set: { next: task.sessionId ? 'resume' : 'fresh', closed: false, closedAt: null },
  });
}

/** An event the server writes itself, in plain text: it must never repeat anything the client sealed. */
async function systemEvent(tx: DbOrTx, taskId: string, event: ServerEvent, by: string | null): Promise<void> {
  await addNote(tx, taskId, { author: 'server', kind: 'event', body: formatServerEvent(event), by });
}

/** A system event the client wrote, sealed like any other client text. */
async function clientEvent(tx: DbOrTx, taskId: string, note: WireNoteInput, by: string): Promise<void> {
  await addNote(tx, taskId, { author: 'system', kind: 'event', body: note.body, preview: note.preview ?? null, by });
}

export async function markDone(db: DbOrTx, taskId: string, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    requireNotRunning(task);
    await systemEvent(tx, taskId, { type: 'done' }, by);
    return transition(tx, task, { to: 'done', place: 'top', by: 'user' });
  });
}

/** Start over: a new session in the directory the task was created with (the machine's default one when it had none). */
export async function rerunFresh(db: DbOrTx, taskId: string, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    requireNotRunning(task);
    await systemEvent(tx, taskId, { type: 'rerun' }, by);
    return transition(tx, task, {
      to: 'todo',
      place: 'bottom',
      by: 'user',
      // A fresh run is not a resume after a wait, even when it comes out of Waiting.
      set: {
        next: 'fresh',
        sessionId: null,
        workdir: task.homeWorkdir,
        closed: false,
        closedAt: null,
        wokenAt: null,
        watches: null,
        watchStops: [],
      },
    });
  });
}

/** Closing takes a task out of the workflow; it stays readable and can be reopened. */
export async function setClosed(db: DbOrTx, taskId: string, closed: boolean, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (closed) requireNotRunning(task);
    await systemEvent(tx, taskId, { type: closed ? 'closed' : 'reopened' }, by);
    return closeOrReopen(tx, task, closed);
  });
}

function closeOrReopen(tx: DbOrTx, task: TaskRow, closed: boolean): Promise<TaskRow> {
  return transition(tx, task, {
    by: 'user',
    set: { closed, closedAt: closed ? new Date() : null },
  });
}

/**
 * Closes what has sat untouched in Done for the archive period. Returns how many tasks it closed.
 * Tasks of the removed intake and tasks with a dedupe key stay open: a closed task reads as "never again" to whoever asks for that key,
 * which would block a re-requested review.
 */
export async function archiveStaleDone(db: DbOrTx, now: Date = new Date()): Promise<number> {
  const cutoff = daysBefore(now, DONE_ARCHIVE_DAYS);
  const stale = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'done'),
        eq(tasks.closed, false),
        ne(tasks.createdBy, 'intake'),
        isNull(tasks.dedupeKey),
        lt(tasks.updatedAt, cutoff),
      ),
    );
  let closed = 0;
  for (const { id } of stale) {
    await db.transaction(async (tx) => {
      // Someone may have touched it since the listing.
      const task = await lockTask(tx, id);
      if (
        task.status !== 'done' ||
        task.closed ||
        task.createdBy === 'intake' ||
        task.dedupeKey !== null ||
        task.updatedAt >= cutoff
      )
        return;
      await systemEvent(tx, id, { type: 'archived', days: DONE_ARCHIVE_DAYS }, null);
      await closeOrReopen(tx, task, true);
      closed += 1;
    });
  }
  return closed;
}

/**
 * Drag and drop: into `status`, between `afterId` (above) and `beforeId` (below), or at the bottom.
 * Nobody but a worker moves a task into or out of Running. An agent's proposal enters Todo only with `startInput`, its prompt
 * sealed again as the user's: the board stores it and takes the proposal's creator to be the user's from then on.
 */
export async function moveTask(
  db: DbOrTx,
  input: { taskId: string; status: Status; beforeId?: string; afterId?: string; startInput?: string; by: string },
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    if (task.status === 'running' && input.status !== 'running')
      throw new AppError('CONFLICT', 'The task is running. Wait until it reports back.');
    if (task.status !== 'running' && input.status === 'running')
      throw new AppError('BAD_REQUEST', 'Only a worker moves a task to Running.');
    requireNotIntoWaiting(task, input.status);
    const neighbour = async (id: string | undefined) => {
      if (id === undefined) return undefined;
      const [row] = await tx
        .select({ position: tasks.position, priority: tasks.priority })
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.status, input.status), ne(tasks.id, task.id)));
      return row;
    };
    // A column sorted by recency has no place to drop into, so a drop there takes no neighbour's priority either.
    const placed = !isRecentFirst(input.status);
    const above = placed ? await neighbour(input.afterId) : undefined;
    const below = placed ? await neighbour(input.beforeId) : undefined;
    // Columns sort by priority first, so a card dropped among tasks of another priority takes theirs.
    const priority = droppedPriority(task.priority, above?.priority, below?.priority);
    const upper = above?.priority === priority ? above.position : undefined;
    const lower = below?.priority === priority ? below.position : undefined;
    let position: number;
    if (upper !== undefined && lower !== undefined) position = (upper + lower) / 2;
    else if (lower !== undefined) position = lower - 1;
    else if (upper !== undefined) position = upper + 1;
    else position = await edgePosition(tx, input.status, 'bottom');
    if (task.status !== input.status) {
      await systemEvent(tx, task.id, { type: 'moved', from: task.status, to: input.status }, input.by);
    }
    if (task.priority !== priority) {
      await systemEvent(tx, task.id, { type: 'priority', from: task.priority, to: priority }, input.by);
    }
    // Into Todo it behaves like "Send & continue" without a reply: it drops the open question, and a task with a session keeps
    // its `next` (a resume with nothing to say starts fresh).
    let start: { input: string } | undefined;
    if (task.proposed && input.status === 'todo') {
      if (input.startInput === undefined)
        throw new AppError('BAD_REQUEST', 'Starting an agent’s proposal needs its prompt sealed again as yours.');
      requireSealed(input.startInput, 'the prompt');
      start = { input: input.startInput };
    }
    return transition(tx, task, {
      to: input.status,
      place: position,
      by: 'user',
      set: { priority },
      ...(start && { start }),
    });
  });
}

/**
 * The user's apply of an agent's polished title and prompt to one of their own tasks that waits (Backlog or Needs me): the new
 * title and prompt sealed as theirs, and a note of theirs holding the old text, in one transaction. `polishId` is the task that
 * made the polish note, a child of this one; it is marked done unless it is still running (its run reports back on its own).
 * A schedule's occurrence is refused: its prompt is bound to the schedule.
 */
export async function applyPolish(
  db: DbOrTx,
  input: { taskId: string; polishId: string; title: string; input: string; previous: WireNoteInput; by: string },
): Promise<TaskRow> {
  requireSealed(input.title, 'the title');
  requireSealed(input.input, 'the prompt');
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    if (task.createdBy !== 'user' || task.proposed)
      throw new AppError('FORBIDDEN', 'Only a task you created takes a polished prompt.');
    if (task.scheduleId !== null)
      throw new AppError('CONFLICT', 'A scheduled occurrence takes its prompt from its schedule.');
    if (task.closed || (task.status !== 'backlog' && task.status !== 'needs-me'))
      throw new AppError('CONFLICT', 'A polished prompt can only be applied to a task in Backlog or Needs me.');
    const polish = await lockTask(tx, input.polishId);
    if (polish.parentId !== task.id)
      throw new AppError('BAD_REQUEST', 'The polished prompt was not made for this task.');
    await addNote(tx, task.id, {
      author: 'user',
      kind: 'event',
      body: input.previous.body,
      preview: input.previous.preview ?? null,
      by: input.by,
    });
    if (polish.status !== 'running' && polish.status !== 'done') await markDone(tx, polish.id, input.by);
    const [row] = await tx
      .update(tasks)
      .set({ title: input.title, input: input.input, updatedAt: new Date() })
      .where(eq(tasks.id, task.id))
      .returning();
    return row!;
  });
}

/**
 * A new title and prompt, sealed in the browser as the user's, for a task of the user's that no worker has claimed yet,
 * in Todo or Backlog. The old text goes into a note of the user's (`previous`) so nothing is lost. A schedule's occurrence
 * is refused: its prompt is sealed under the schedule, so an edit of the card could be replayed as the schedule's.
 */
export async function editPrompt(
  db: DbOrTx,
  input: { taskId: string; title: string; input: string; previous: WireNoteInput; by: string },
): Promise<TaskRow> {
  requireSealed(input.title, 'the title');
  requireSealed(input.input, 'the prompt');
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    if (task.createdBy !== 'user' || task.proposed)
      throw new AppError('FORBIDDEN', 'Only a task you created has a prompt you can edit.');
    if (task.scheduleId !== null)
      throw new AppError(
        'CONFLICT',
        'A scheduled occurrence takes its prompt from its schedule; edit it on the Schedules page.',
      );
    if (hasStarted(task))
      throw new AppError('CONFLICT', 'The task has started; its prompt is in its thread now. Reply to it instead.');
    if (task.closed || (task.status !== 'todo' && task.status !== 'backlog'))
      throw new AppError('CONFLICT', 'The prompt can only be edited while the task waits in Todo or Backlog.');
    await addNote(tx, task.id, {
      author: 'user',
      kind: 'event',
      body: input.previous.body,
      preview: input.previous.preview ?? null,
      by: input.by,
    });
    const [row] = await tx
      .update(tasks)
      .set({ title: input.title, input: input.input, updatedAt: new Date() })
      .where(eq(tasks.id, task.id))
      .returning();
    return row!;
  });
}

/**
 * The priority of a card dropped between `above` and `below`: its own when it fits there (equal to a
 * neighbour, or between theirs), else the neighbour's above it, else the one below. Without neighbours it keeps its own.
 */
export function droppedPriority(own: Priority, above: Priority | undefined, below: Priority | undefined): Priority {
  const rank = (p: Priority) => PRIORITIES.indexOf(p);
  const fitsAbove = above === undefined || rank(above) <= rank(own);
  const fitsBelow = below === undefined || rank(own) <= rank(below);
  if (fitsAbove && fitsBelow) return own;
  return above ?? below ?? own;
}

/** A new priority from the UI: the task goes to the bottom of its new band. */
export async function setPriority(db: DbOrTx, taskId: string, priority: Priority, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.priority === priority) return task;
    await systemEvent(tx, taskId, { type: 'priority', from: task.priority, to: priority }, by);
    return transition(tx, task, { place: 'bottom', by: 'user', set: { priority } });
  });
}

export interface TaskConfig {
  priority?: Priority | undefined;
  model?: string | null | undefined;
  effort?: Effort | null | undefined;
  lane?: string | null | undefined;
  autoDone?: boolean | undefined;
  icon?: string | null | undefined;
  labels?: string | null | undefined;
  place?: { machine: string; workdir: string } | null | undefined;
  title?: string | undefined;
}

/**
 * The user's edit of a task's settings, in one step. A priority works as `setPriority`. A model or an effort applies from the next run. An icon or labels apply at once, in any status. A lane is refused while the task runs, which keeps the lane it started in. `autoDone` and a sealed `title` apply at once, in any status; a title is refused on a schedule's occurrence. A
 * new place (the machine and the sealed directory, or null for none) replaces the directory the task was created with and
 * drops the session: Claude Code keeps a session under its working directory, so it cannot be resumed from another one, and
 * the next run starts fresh there and reads the thread. A running or waiting task keeps its place, since a run holds it.
 */
export async function configureTask(db: DbOrTx, taskId: string, config: TaskConfig, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    const { priority, model, effort, lane, autoDone, icon, labels, place, title } = config;
    if (title !== undefined) {
      requireSealed(title, 'the title');
      if (task.scheduleId !== null)
        throw new AppError(
          'CONFLICT',
          'A scheduled occurrence takes its title from its schedule; rename it on the Schedules page.',
        );
    }
    if (lane !== undefined && task.status === 'running')
      throw new AppError('CONFLICT', 'The task is running: it keeps its lane until its next start.');
    if (place !== undefined) {
      if (task.status === 'running' || task.status === 'waiting')
        throw new AppError('CONFLICT', `The task is ${task.status}. Stop it first, then move it.`);
      if (place !== null) requireSealed(place.workdir, 'the directory');
    }
    const set: TaskValues = {};
    if (model !== undefined) set.model = model;
    if (effort !== undefined) set.effort = effort;
    if (lane !== undefined) set.requestedLane = lane;
    if (autoDone !== undefined) set.autoDone = autoDone;
    if (icon !== undefined) set.icon = icon;
    if (labels !== undefined) set.labels = labels;
    if (title !== undefined) set.title = title;
    if (place !== undefined) {
      const workdir = place?.workdir ?? null;
      // A pause or a wake belongs to the session that is gone, and so do the watches the old machine ran for it.
      Object.assign(set, {
        machine: place?.machine ?? null,
        workdir,
        homeWorkdir: workdir,
        sessionId: null,
        next: 'fresh',
        pausedAt: null,
        wokenAt: null,
        watches: null,
        watchStops: [],
      } satisfies TaskValues);
    }
    const priorityChanged = priority !== undefined && priority !== task.priority;
    if (priorityChanged) {
      await systemEvent(tx, taskId, { type: 'priority', from: task.priority, to: priority }, by);
      set.priority = priority;
    }
    return transition(tx, task, { place: priorityChanged ? 'bottom' : undefined, by: 'user', set });
  });
}

export interface TitleRuleChange {
  icon?: string | undefined;
  labels?: string | undefined;
  title?: string | undefined;
  expectTitle?: string | undefined;
}

/**
 * What a title rule gave a run's own task, sealed: the icon only while the task has none, the labels only while it has none,
 * the title only while it is still exactly the envelope `expectTitle` (the one the caller found to be the default), so a
 * rename, an icon or labels the user set meanwhile stay. Says which parts were stored. A schedule's occurrence takes both from its schedule and is refused. A run
 * that ended may still apply, since a short run can end before a title is written; a later run of the task refuses an earlier
 * one. No note is written, as for a rename, and the status and position stay.
 */
export async function applyTitleRule(
  db: DbOrTx,
  taskId: string,
  change: TitleRuleChange,
  run: string,
): Promise<{ icon: boolean; labels: boolean; title: boolean }> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.scheduleId !== null)
      throw new AppError(
        'CONFLICT',
        'A scheduled occurrence takes its title and icon from its schedule; rename it on the Schedules page.',
      );
    const refused = notInRun(task, run, { moves: false });
    if (refused) throw new AppError('CONFLICT', refused);
    const set: TaskValues = {};
    const icon = change.icon !== undefined && task.icon === null;
    const labels = change.labels !== undefined && task.labels === null;
    const title = change.title !== undefined && change.expectTitle === task.title;
    if (icon) set.icon = change.icon!;
    if (labels) set.labels = change.labels!;
    if (title) set.title = change.title!;
    if (icon || labels || title)
      await tx
        .update(tasks)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
    return { icon, labels, title };
  });
}

/** Sets or clears (null) the start time of a Todo task. */
export async function setNotBefore(db: DbOrTx, taskId: string, notBefore: Date | null, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.status !== 'todo') throw new AppError('CONFLICT', `The task is ${task.status}, not in Todo.`);
    await systemEvent(
      tx,
      taskId,
      notBefore === null ? { type: 'start-cleared' } : { type: 'start-set', at: notBefore },
      by,
    );
    return transition(tx, task, { by: 'user', set: { notBefore } });
  });
}

/**
 * The agent of a running task made a tool call. A task that stopped running in between, or that runs on another machine
 * now (taken back and claimed again), or in another run than `run`, is left alone.
 */
export async function heartbeat(
  db: DbOrTx,
  taskId: string,
  beat: Heartbeat,
  machine: string,
  run?: string,
): Promise<void> {
  const updated = await db
    .update(tasks)
    .set({ lane: beat.lane, borrowed: beat.borrowed, lastActiveAt: new Date() })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.status, 'running'),
        eq(tasks.machine, machine),
        run === undefined ? undefined : eq(tasks.runId, run),
      ),
    )
    .returning({ id: tasks.id });
  // A beat for a run that ended or moved is ignored; only an unknown task is an error.
  if (updated.length === 0) await getTask(db, taskId);
}

/**
 * Why `machine` may not report for the task's run or wait, or undefined when it may: the task is not `status` (or is closed,
 * where that counts), another machine holds it, or, with `run`, another run does. A worker or agent whose run was taken
 * back and claimed again, here or elsewhere, must not touch the new run; it gets the answer it would get had the task left
 * `status`.
 */
function notHeldBy(
  task: TaskRow,
  machine: string,
  status: 'running' | 'waiting',
  { closedCounts = true, run }: { closedCounts?: boolean; run?: string | undefined } = {},
): string | undefined {
  if (task.status !== status) return `the task is ${task.status}, not ${status}`;
  if (closedCounts && task.closed) return `the task is closed, not ${status}`;
  if (task.machine !== machine) return `the task is ${status} on ${task.machine ?? 'no machine'}, not on ${machine}`;
  if (run !== undefined && task.runId !== run) return `the task is ${status} in a later run, not in this one`;
  return undefined;
}

/**
 * Why `run` may not change the task, or undefined when it may. A task that left Running is still the run's to finish its
 * bookkeeping on (the directory it ended in), but not one that runs again in a later run. A status change (`moves`) needs
 * the run to hold the task: an agent left over from an earlier run must not move the task under the user or a later run.
 */
function notInRun(task: TaskRow, run: string, { moves }: { moves: boolean }): string | undefined {
  if (task.status === 'running' && task.runId !== run) return 'the task is running in a later run, not in this one';
  if (moves && task.status !== 'running') return `the task is ${task.status}, no longer running in this run`;
  return undefined;
}

/** Adds a pull request the task's agent reported, sealed. The server cannot tell whether it repeats one; the CLI checks. */
export async function addPr(db: DbOrTx, taskId: string, pr: string): Promise<void> {
  requireSealed(pr, 'the pull request');
  await db.transaction(async (tx) => {
    await lockTask(tx, taskId);
    const held = await tx.$count(taskPrs, eq(taskPrs.taskId, taskId));
    if (held >= MAX_TASK_PRS)
      throw new AppError('BAD_REQUEST', `the task already has ${MAX_TASK_PRS} pull requests, the most the board keeps`);
    await tx.insert(taskPrs).values({ id: newTaskId(), taskId, pr });
    await tx.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));
  });
}

/** Takes a reported PR off the task. An id that is not one of the task's rows changes nothing, so a retry is safe. */
export async function removePr(db: DbOrTx, taskId: string, prId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockTask(tx, taskId);
    const removed = await tx
      .delete(taskPrs)
      .where(and(eq(taskPrs.taskId, taskId), eq(taskPrs.id, prId)))
      .returning({ id: taskPrs.id });
    if (removed.length > 0) await tx.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));
  });
}

/** What a CLI without `task.prs` does to report a PR: the task's PRs become this one, whose state is unknown. */
export async function setPr(db: DbOrTx, taskId: string, pr: string): Promise<void> {
  requireSealed(pr, 'the pull request');
  await db.transaction(async (tx) => {
    await lockTask(tx, taskId);
    await tx.delete(taskPrs).where(eq(taskPrs.taskId, taskId));
    await tx.insert(taskPrs).values({ id: newTaskId(), taskId, pr });
    await tx.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));
  });
}

/** The task of `machine`, whatever its status: only the machine that runs a task's watches may publish them or acknowledge stops. */
function requireMachineOf(task: TaskRow, machine: string): void {
  if (task.machine !== machine)
    throw new AppError('CONFLICT', `the task belongs to ${task.machine ?? 'no machine'}, not to ${machine}`);
}

/** Stores the sealed watches the task's machine runs for it, or clears them (`null`). Changes nothing else, not even `updatedAt`. */
export async function setWatches(db: DbOrTx, taskId: string, watches: string | null, by: string): Promise<void> {
  if (watches !== null) requireSealed(watches, 'the watches');
  await db.transaction(async (tx) => {
    requireMachineOf(await lockTask(tx, taskId), by);
    await tx.update(tasks).set({ watches }).where(eq(tasks.id, taskId));
  });
}

/** The machine has acted on these stop requests: they stop being pending. An id that is not pending changes nothing. */
export async function ackWatchStops(db: DbOrTx, taskId: string, ids: readonly string[], by: string): Promise<void> {
  await db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    requireMachineOf(task, by);
    const watchStops = task.watchStops.filter((id) => !ids.includes(id));
    if (watchStops.length !== task.watchStops.length)
      await tx.update(tasks).set({ watchStops }).where(eq(tasks.id, taskId));
  });
}

/**
 * The user's Stop of one watch: its id waits in `watchStops` until the task's machine acknowledges it, which its listener does
 * on the next tick. Needs a task that has a machine and is not done or closed; an id that already waits changes nothing.
 */
export async function stopWatch(db: DbOrTx, taskId: string, watchId: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.machine === null) throw new AppError('CONFLICT', 'The task has no machine that runs watches.');
    if (task.status === 'done' || task.closed) throw new AppError('CONFLICT', 'The task is done or closed.');
    if (task.watchStops.includes(watchId)) return task;
    if (task.watchStops.length >= MAX_TASK_WATCHES)
      throw new AppError('BAD_REQUEST', `${MAX_TASK_WATCHES} stop requests already wait for the machine`);
    const [row] = await tx
      .update(tasks)
      .set({ watchStops: [...task.watchStops, watchId] })
      .where(eq(tasks.id, taskId))
      .returning();
    return row!;
  });
}

/**
 * GitHub's state of the PR the prompt names and of reported ones, from a worker's dispatcher. A row id that is not the
 * task's is ignored. Changes nothing else, not even `updatedAt`.
 */
export async function setPrStates(db: DbOrTx, taskId: string, states: PrStates): Promise<void> {
  await db.transaction(async (tx) => {
    await getTask(tx, taskId);
    if (states.prompt !== undefined) await tx.update(tasks).set({ prState: states.prompt }).where(eq(tasks.id, taskId));
    for (const { id, state } of states.prs ?? [])
      await tx
        .update(taskPrs)
        .set({ state })
        .where(and(eq(taskPrs.taskId, taskId), eq(taskPrs.id, id)));
  });
}

/** What a CLI without `task.prs` does to record GitHub's state: of the newest reported PR when there is one, else of the prompt's. */
export async function setPrState(db: DbOrTx, taskId: string, state: PrState): Promise<void> {
  await db.transaction(async (tx) => {
    await getTask(tx, taskId);
    const [newest] = await tx
      .select({ id: taskPrs.id })
      .from(taskPrs)
      .where(eq(taskPrs.taskId, taskId))
      .orderBy(desc(taskPrs.createdAt), desc(taskPrs.id))
      .limit(1);
    if (newest === undefined) await tx.update(tasks).set({ prState: state }).where(eq(tasks.id, taskId));
    else await tx.update(taskPrs).set({ state }).where(eq(taskPrs.id, newest.id));
  });
}

/**
 * A worker gave up the task's slot for its own lane's work. Back to Todo, ahead of new work (resumes come first),
 * and resumed in its session on the same machine.
 */
export async function pause(
  db: DbOrTx,
  taskId: string,
  note: WireNoteInput,
  by: string,
  run?: string,
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    const refused = notHeldBy(task, by, 'running', { closedCounts: false, run });
    if (refused) throw new AppError('CONFLICT', refused);
    await clientEvent(tx, taskId, note, by);
    return transition(tx, task, {
      to: 'todo',
      place: 'top',
      by: 'machine',
      set: { next: task.sessionId ? 'resume' : 'fresh', pausedAt: new Date() },
    });
  });
}

/**
 * The agent waits for something outside (CI, a deploy): its comment goes into the thread, and the task leaves Running for
 * Waiting, freeing its slot, until `wakeAt` or until a check on its machine passes. Either way it then resumes in its session.
 */
export async function wait(
  db: DbOrTx,
  taskId: string,
  request: WireWait,
  by: string,
  { run, now = new Date() }: { run?: string | undefined; now?: Date } = {},
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    const refused = notHeldBy(task, by, 'running', { run });
    if (refused) throw new AppError('CONFLICT', refused);
    const ahead = request.wakeAt.getTime() - now.getTime();
    if (ahead <= 0) throw new AppError('BAD_REQUEST', 'the end of the wait must lie in the future');
    if (ahead > MAX_WAIT_MS)
      throw new AppError('BAD_REQUEST', `a wait may last at most ${MAX_WAIT_MS / (24 * 60 * 60_000)} days`);
    await addNote(tx, taskId, {
      author: 'agent',
      kind: 'comment',
      body: request.body,
      preview: request.preview ?? null,
      by,
    });
    return transition(tx, task, {
      to: 'waiting',
      by: 'agent',
      set: { wakeAt: request.wakeAt, waitCheck: request.check, next: task.sessionId ? 'resume' : 'fresh' },
    });
  });
}

/** A wait ended (its time ran out, its check passed): while the task still waits, the reason goes into its thread and it resumes next. */
export async function wake(
  db: DbOrTx,
  taskId: string,
  note: WireNoteInput,
  by: string,
): Promise<{ applied: boolean; row: TaskRow }> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (notHeldBy(task, by, 'waiting')) return { applied: false, row: task };
    await clientEvent(tx, taskId, note, by);
    return { applied: true, row: await transition(tx, task, { to: 'todo', place: 'top', by: 'machine' }) };
  });
}

/** The user ends a wait early: the task resumes next, as if its wait had run out. */
export async function wakeNow(db: DbOrTx, taskId: string, by: string): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.status !== 'waiting') throw new AppError('CONFLICT', `The task is ${task.status}, not waiting.`);
    await systemEvent(tx, taskId, { type: 'woken' }, by);
    return transition(tx, task, { to: 'todo', place: 'top', by: 'user' });
  });
}

/** A run failed: while the task still runs, the reason goes into its thread and it waits in Needs me. Otherwise nothing changes. */
export async function failTask(
  db: DbOrTx,
  taskId: string,
  note: WireNoteInput,
  by: string,
  run?: string,
): Promise<{ applied: boolean; row: TaskRow }> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (notHeldBy(task, by, 'running', { run })) return { applied: false, row: task };
    await clientEvent(tx, taskId, note, by);
    return { applied: true, row: await transition(tx, task, { to: 'needs-me', by: 'machine' }) };
  });
}

/**
 * A running task whose agent has been quiet for the limit has lost its worker (the machine is off, the process
 * died): only that machine could end the run, so the user may take the task back, into Needs me.
 */
export async function takeBack(db: DbOrTx, taskId: string, by: string, now: Date = new Date()): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task.status !== 'running') throw new AppError('CONFLICT', 'The task is not running.');
    const quietMs = task.lastActiveAt === null ? Infinity : now.getTime() - task.lastActiveAt.getTime();
    if (quietMs < TAKE_BACK_AFTER_MS)
      throw new AppError(
        'CONFLICT',
        `The agent was active ${Math.floor(quietMs / 60_000)} min ago. A task can be taken back after ${TAKE_BACK_AFTER_MS / 60_000} quiet minutes.`,
      );
    await systemEvent(tx, taskId, { type: 'taken-back', machine: task.machine }, by);
    return transition(tx, task, { to: 'needs-me', by: 'user', userStop: true });
  });
}

/**
 * A running task's worker is `machine` (and, when named, its run is `run`); no other machine or run reads or acknowledges
 * for it. An earlier run on the same machine gets the answer it would get had the task left Running.
 */
function requireRunOf(task: TaskRow, machine: string, run: string | undefined): void {
  if (task.status !== 'running') throw new AppError('CONFLICT', `the task is ${task.status}, not running`);
  if (task.machine !== machine)
    throw new AppError('FORBIDDEN', `the task runs on ${task.machine ?? 'no machine'}, not on ${machine}`);
  if (run !== undefined && task.runId !== run)
    throw new AppError('CONFLICT', 'the task is running in a later run, not in this one');
}

/** What the user sent to the running task: whether to stop, and the messages not yet handed to the agent, oldest first. */
export async function runInbox(
  db: DbOrTx,
  taskId: string,
  machine: string,
  run?: string,
): Promise<{ stop: boolean; stopMessage?: string; messages: NoteRow[] }> {
  // Under the task's lock, so a Stop & send is never seen half written; reading it also marks the run as one that hands messages over.
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    requireRunOf(task, machine, run);
    if (!task.inboxRead) await tx.update(tasks).set({ inboxRead: true }).where(eq(tasks.id, taskId));
    const messages = await tx
      .select()
      .from(notes)
      .where(and(eq(notes.taskId, taskId), eq(notes.pending, true)))
      .orderBy(asc(notes.createdAt), asc(notes.id));
    return {
      stop: task.stopRequestedAt !== null,
      ...(task.stopRequestedAt !== null && task.stopMessageId !== null ? { stopMessage: task.stopMessageId } : {}),
      messages,
    };
  });
}

/** The worker handed these messages to the agent and, with `stop`, acted on the stop request. */
export async function ackMessages(
  db: DbOrTx,
  taskId: string,
  ack: { ids: string[]; stop: boolean },
  machine: string,
  run?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    requireRunOf(task, machine, run);
    if (ack.ids.length > 0)
      await tx
        .update(notes)
        .set({ pending: false, deliveredAt: new Date() })
        .where(and(eq(notes.taskId, taskId), eq(notes.pending, true), inArray(notes.id, ack.ids)));
    if (ack.stop)
      await tx.update(tasks).set({ stopRequestedAt: null, stopMessageId: null }).where(eq(tasks.id, taskId));
  });
}

/**
 * The worker ended the run on the user's request: while the task still runs, the note goes into its thread and the task
 * waits in Needs me, or, with messages that were never handed over, resumes with them.
 */
export async function stopped(
  db: DbOrTx,
  taskId: string,
  note: WireNoteInput,
  by: string,
  run?: string,
): Promise<TaskRow> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    requireRunOf(task, by, run);
    await clientEvent(tx, taskId, note, by);
    return transition(tx, task, { to: 'needs-me', by: 'machine', userStop: true });
  });
}
