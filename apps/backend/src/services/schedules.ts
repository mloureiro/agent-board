import {
  MAX_INTERVAL_MS,
  MAX_SCHEDULE_CONCURRENT,
  MAX_SCHEDULE_CRONS,
  isCronExpression,
  isEffort,
  type Effort,
  type Priority,
  type WireSchedule,
  type WireScheduleDraft,
} from '@agent-board/shared';
import { Cron } from 'croner';
import { and, asc, count, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { schedules, tasks, transcriptRuns, type ScheduleRow, type TaskRow } from '../db/schema';
import { AppError } from './errors';
import { requireSealed } from './sealed';
import { edgePosition, hasStarted, insertTask, lockTask } from './taskRows';

const MIN_INTERVAL_MS = 60_000;

/** The part of a schedule that says when it runs. A schedule that runs after another has no times of its own. */
export type Rule = Pick<ScheduleRow, 'everyMs' | 'cron' | 'moreCrons' | 'timezone' | 'anchorAt' | 'until'>;

function cronOf(expression: string, timezone: string | null): Cron {
  return new Cron(expression, { timezone: timezone ?? undefined, paused: true, mode: '5-part' });
}

/** Every cron expression of the rule, the first one first. */
function cronsOf(rule: Pick<Rule, 'cron' | 'moreCrons'>): string[] {
  return rule.cron === null ? [] : [rule.cron, ...rule.moreCrons];
}

/**
 * The first run after `after` (at or after it with `inclusive`): the next point on the interval's grid, or the earliest
 * next match of any cron expression in the rule's time zone. Null when there is none, because `until` or the expression rules it out, or
 * when it lies beyond the dates a Date can hold.
 */
export function nextOccurrence(rule: Rule, after: Date, inclusive: boolean): Date | null {
  const next =
    rule.everyMs === null
      ? nextMatch(rule, after, inclusive)
      : nextOnGrid(rule.anchorAt, rule.everyMs, after, inclusive);
  if (next === null || Number.isNaN(next.getTime())) return null;
  return rule.until !== null && next.getTime() > rule.until.getTime() ? null : next;
}

function nextOnGrid(anchor: Date, everyMs: number, after: Date, inclusive: boolean): Date {
  const steps = (after.getTime() - anchor.getTime()) / everyMs;
  const index = inclusive ? Math.ceil(steps) : Math.floor(steps) + 1;
  return new Date(anchor.getTime() + Math.max(index, 0) * everyMs);
}

function nextMatch(rule: Rule, after: Date, inclusive: boolean): Date | null {
  // croner finds the first match strictly after its argument and works in whole seconds.
  const from = inclusive ? new Date(after.getTime() - 1) : after;
  const matches = cronsOf(rule).flatMap((expression) => cronOf(expression, rule.timezone).nextRun(from) ?? []);
  return matches.reduce<Date | null>((first, match) => (first === null || match < first ? match : first), null);
}

/** One expression as the server checks it: five fields that croner reads. */
function requireCron(expression: string, timezone: string): void {
  if (expression.trim().split(/\s+/).length !== 5)
    throw new AppError(
      'BAD_REQUEST',
      `"${expression.slice(0, 80)}" is not a 5-field cron expression (minute hour day month weekday).`,
    );
  if (!isCronExpression(expression))
    throw new AppError(
      'BAD_REQUEST',
      `"${expression.slice(0, 80)}" is not a cron expression a client can read: single spaces between the fields, only digits, * / , - # ? L W and month and weekday names, at most 100 characters.`,
    );
  try {
    cronOf(expression, timezone);
  } catch (error) {
    throw new AppError(
      'BAD_REQUEST',
      `"${expression.slice(0, 80)}" is not a cron expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export type RuleDraft = Pick<
  WireScheduleDraft,
  'everyMs' | 'cron' | 'moreCrons' | 'timezone' | 'after' | 'maxConcurrent' | 'id'
>;

export function requireRule(draft: RuleDraft): void {
  if (
    draft.maxConcurrent !== undefined &&
    !(draft.maxConcurrent >= 1 && draft.maxConcurrent <= MAX_SCHEDULE_CONCURRENT)
  )
    throw new AppError(
      'BAD_REQUEST',
      `At most ${MAX_SCHEDULE_CONCURRENT} cards of a schedule can run at once, and at least 1.`,
    );
  if (draft.after !== undefined) {
    const { delayMs = 0 } = draft.after;
    if (!(delayMs >= 0 && delayMs <= MAX_INTERVAL_MS))
      throw new AppError('BAD_REQUEST', 'The delay after another schedule must be from 0 to 10 years.');
    if (draft.after.scheduleId === draft.id) throw new AppError('BAD_REQUEST', 'A schedule cannot run after itself.');
    return;
  }
  if (draft.everyMs !== undefined) {
    if (draft.everyMs < MIN_INTERVAL_MS) throw new AppError('BAD_REQUEST', 'An interval must be at least 1 minute.');
    if (draft.everyMs > MAX_INTERVAL_MS) throw new AppError('BAD_REQUEST', 'An interval must be at most 10 years.');
    return;
  }
  const timezone = draft.timezone ?? '';
  const crons = [draft.cron ?? '', ...(draft.moreCrons ?? [])];
  if (crons.length > MAX_SCHEDULE_CRONS)
    throw new AppError('BAD_REQUEST', `A schedule has at most ${MAX_SCHEDULE_CRONS} cron expressions.`);
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new AppError(
      'BAD_REQUEST',
      `"${timezone.slice(0, 60)}" is not a time zone (use a name such as Europe/Berlin).`,
    );
  }
  for (const expression of crons) requireCron(expression, timezone);
  const normalized = crons.map((expression) => expression.trim().split(/\s+/).join(' '));
  const repeated = normalized.find((expression, index) => normalized.indexOf(expression) !== index);
  if (repeated !== undefined)
    throw new AppError('BAD_REQUEST', `The cron expression "${repeated.slice(0, 80)}" is given twice.`);
}

/** A schedule with the start time of its pending occurrence, which only the task knows (a delay changes it). */
export type ScheduleView = ScheduleRow & { pendingNotBefore: Date | null };

export function toSchedule(row: ScheduleView): WireSchedule {
  return {
    id: row.id,
    title: row.title,
    input: row.input,
    priority: row.priority,
    model: row.model,
    effort: isEffort(row.effort) ? row.effort : null,
    requestedLane: row.requestedLane,
    autoDone: row.autoDone,
    machine: row.machine,
    workdir: row.workdir,
    ...(row.agent === null ? {} : { agent: row.agent }),
    icon: row.icon,
    labels: row.labels,
    everyMs: row.everyMs,
    cron: row.cron,
    ...(row.moreCrons.length === 0 ? {} : { moreCrons: row.moreCrons }),
    timezone: row.timezone,
    after: row.afterScheduleId === null ? null : { scheduleId: row.afterScheduleId, delayMs: row.afterDelayMs ?? 0 },
    maxConcurrent: row.maxConcurrent,
    anchorAt: row.anchorAt,
    nextRunAt: row.occurrenceTaskId === null ? null : row.pendingNotBefore,
    remaining: row.remaining,
    until: row.until,
    paused: row.pausedAt !== null,
    ended: row.endedAt !== null,
    occurrenceTaskId: row.occurrenceTaskId,
    createdAt: row.createdAt,
  };
}

function selectViews(db: DbOrTx) {
  return db
    .select({ schedule: schedules, pendingNotBefore: tasks.notBefore })
    .from(schedules)
    .leftJoin(tasks, eq(tasks.id, schedules.occurrenceTaskId));
}

async function viewOf(tx: DbOrTx, id: string): Promise<ScheduleView> {
  const [found] = await selectViews(tx).where(eq(schedules.id, id));
  return { ...found!.schedule, pendingNotBefore: found!.pendingNotBefore };
}

async function lockSchedule(tx: DbOrTx, id: string): Promise<ScheduleRow> {
  const [row] = await tx.select().from(schedules).where(eq(schedules.id, id)).for('update');
  if (!row) throw new AppError('NOT_FOUND', `no schedule ${id.slice(0, 64)}`);
  return row;
}

/** A Todo occurrence of the schedule that starts at `at`, or right away without it; the schedule's pending one. */
async function insertOccurrence(tx: DbOrTx, schedule: ScheduleRow, at: Date | null, now: Date): Promise<TaskRow> {
  const pinned = schedule.machine !== null && schedule.workdir !== null;
  const { row } = await insertTask(
    tx,
    {
      title: schedule.title,
      input: schedule.input,
      ...(schedule.agent === null ? {} : { agent: schedule.agent }),
      ...(schedule.icon === null ? {} : { icon: schedule.icon }),
      ...(schedule.labels === null ? {} : { labels: schedule.labels }),
      status: 'todo',
      priority: schedule.priority,
      ...(schedule.model === null ? {} : { model: schedule.model }),
      ...(isEffort(schedule.effort) ? { effort: schedule.effort } : {}),
      ...(schedule.requestedLane === null ? {} : { lane: schedule.requestedLane }),
      ...(schedule.autoDone ? { autoDone: true } : {}),
      ...(at === null ? {} : { notBefore: at }),
      createdBy: 'user',
      ...(pinned ? { machine: schedule.machine ?? undefined, workdir: schedule.workdir ?? undefined } : {}),
    },
    { scheduleId: schedule.id },
  );
  await tx
    .update(schedules)
    .set({
      occurrenceTaskId: row.id,
      lastOccurrenceAt: at ?? now,
      remaining: schedule.remaining === null ? null : schedule.remaining - 1,
    })
    .where(eq(schedules.id, schedule.id));
  return row;
}

/**
 * Creates the schedule's next occurrence, a Todo task that waits for its run time, and ends the schedule when there is
 * none. The run time is the first rule match after the previous occurrence that is not in the past, so runs missed while
 * nothing claimed the card are skipped. `from` starts the search there instead (a resumed schedule). The caller holds the
 * schedule's lock. A schedule that runs after another makes none here: its occurrences come from `triggerAfter`.
 */
async function materializeNext(
  tx: DbOrTx,
  schedule: ScheduleRow,
  now: Date,
  from?: Date,
): Promise<TaskRow | undefined> {
  const stopped = async (values: Partial<ScheduleRow>) => {
    await tx
      .update(schedules)
      .set({ occurrenceTaskId: null, ...values })
      .where(eq(schedules.id, schedule.id));
    return undefined;
  };
  if (schedule.pausedAt !== null) return stopped({});
  if (schedule.remaining === 0) return stopped({ endedAt: now });
  if (schedule.afterScheduleId !== null) return stopped({});
  const rule: Rule = schedule;
  let at: Date | null;
  if (from !== undefined) at = nextOccurrence(rule, from, true);
  else if (schedule.lastOccurrenceAt === null) at = nextOccurrence(rule, schedule.anchorAt, true);
  else {
    at = nextOccurrence(rule, schedule.lastOccurrenceAt, false);
    if (at !== null && at.getTime() < now.getTime()) at = nextOccurrence(rule, now, true);
  }
  if (at === null) return stopped({ endedAt: now });
  return insertOccurrence(tx, schedule, at, now);
}

/** The pending occurrence `taskId` left Todo (or was closed): creates the next, unless it is no longer the pending one. */
export async function completeOccurrence(tx: DbOrTx, taskId: string, scheduleId: string, now: Date): Promise<void> {
  // A former occurrence must not take the schedule's lock: removeSchedule holds it while it locks the tasks.
  const [current] = await tx
    .select({ occurrenceTaskId: schedules.occurrenceTaskId })
    .from(schedules)
    .where(eq(schedules.id, scheduleId));
  if (current?.occurrenceTaskId !== taskId) return;
  const [schedule] = await tx.select().from(schedules).where(eq(schedules.id, scheduleId)).for('update');
  if (schedule?.occurrenceTaskId === taskId) await materializeNext(tx, schedule, now);
}

/**
 * Creates the schedule and its first occurrence, which waits for the first run. The schedule's id is the client's, because the
 * schedule's sealed fields are bound to it; one that is taken, by anyone, is a conflict. A schedule that runs after another has
 * no occurrence yet: `task` is null, and the upstream must exist and not have ended.
 */
export async function addSchedule(
  db: DbOrTx,
  draft: WireScheduleDraft,
  now: Date = new Date(),
): Promise<{ schedule: ScheduleView; task: TaskRow | null }> {
  requireRule(draft);
  return db.transaction(async (tx) => {
    if (draft.after !== undefined) {
      const [upstream] = await tx.select().from(schedules).where(eq(schedules.id, draft.after.scheduleId)).for('share');
      if (!upstream)
        throw new AppError('BAD_REQUEST', `There is no schedule ${draft.after.scheduleId.slice(0, 64)} to run after.`);
      if (upstream.endedAt !== null)
        throw new AppError('BAD_REQUEST', 'The schedule to run after has ended, so this one would never run.');
    }
    const [inserted] = await tx
      .insert(schedules)
      .values({
        id: draft.id,
        title: draft.title,
        input: draft.input,
        priority: draft.priority ?? 'normal',
        model: draft.model ?? null,
        effort: draft.effort ?? null,
        requestedLane: draft.lane ?? null,
        autoDone: draft.autoDone ?? false,
        machine: draft.machine ?? null,
        workdir: draft.workdir ?? null,
        agent: draft.agent ?? null,
        icon: draft.icon ?? null,
        labels: draft.labels ?? null,
        everyMs: draft.everyMs ?? null,
        cron: draft.cron ?? null,
        moreCrons: draft.moreCrons ?? [],
        timezone: draft.timezone ?? null,
        afterScheduleId: draft.after?.scheduleId ?? null,
        afterDelayMs: draft.after === undefined ? null : (draft.after.delayMs ?? 0),
        maxConcurrent: draft.maxConcurrent ?? null,
        anchorAt: draft.startAt ?? now,
        remaining: draft.times ?? null,
        until: draft.until ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) throw new AppError('CONFLICT', 'that schedule id is already taken');
    if (draft.after !== undefined) return { schedule: await viewOf(tx, inserted.id), task: null };
    const task = await materializeNext(tx, inserted, now);
    if (!task) throw new AppError('BAD_REQUEST', 'The schedule would never run: nothing matches before its end.');
    return { schedule: await viewOf(tx, inserted.id), task };
  });
}

/**
 * A card of the schedule's run finished (Needs me or Done): the schedules that run after it each get an occurrence that starts
 * `delayMs` later, unless they are paused, ended or already have a pending one. Takes the dependents' locks, so the caller
 * holds the card's lock and nothing else of a schedule.
 */
async function triggerAfter(tx: DbOrTx, scheduleId: string, now: Date): Promise<void> {
  const dependents = await tx
    .select({ id: schedules.id })
    .from(schedules)
    .where(and(eq(schedules.afterScheduleId, scheduleId), isNull(schedules.endedAt), isNull(schedules.pausedAt)))
    .orderBy(asc(schedules.id));
  for (const { id } of dependents) {
    const [dependent] = await tx.select().from(schedules).where(eq(schedules.id, id)).for('update');
    if (!dependent || dependent.endedAt !== null || dependent.pausedAt !== null || dependent.occurrenceTaskId !== null)
      continue;
    const at = new Date(now.getTime() + (dependent.afterDelayMs ?? 0));
    if (dependent.remaining === 0 || (dependent.until !== null && at.getTime() > dependent.until.getTime())) {
      await tx.update(schedules).set({ endedAt: now }).where(eq(schedules.id, id));
      continue;
    }
    await insertOccurrence(tx, dependent, dependent.afterDelayMs ? at : null, now);
  }
}

/**
 * The run of an occurrence handed the card back as done work. The first time only, that makes the occurrences of the schedules
 * that run after its schedule; a card that is replied to and finishes again does not trigger them again.
 */
export async function occurrenceFinished(
  tx: DbOrTx,
  task: Pick<TaskRow, 'id' | 'scheduleId' | 'occurrenceFinishedAt'>,
  now: Date,
): Promise<void> {
  if (task.scheduleId === null || task.occurrenceFinishedAt !== null) return;
  await tx.update(tasks).set({ occurrenceFinishedAt: now }).where(eq(tasks.id, task.id));
  await triggerAfter(tx, task.scheduleId, now);
}

/**
 * Whether the schedule's limit of cards under way (Running and Waiting) is used up by cards other than `taskId`, so a claim of
 * that card must be refused. Takes the schedule's lock when there is a limit, so two claims count one after the other. A
 * schedule that is gone, or has no limit, never holds a card.
 */
export async function isScheduleFull(tx: DbOrTx, scheduleId: string, taskId: string): Promise<boolean> {
  const [unlocked] = await tx
    .select({ maxConcurrent: schedules.maxConcurrent })
    .from(schedules)
    .where(eq(schedules.id, scheduleId));
  if (unlocked?.maxConcurrent == null) return false;
  const [locked] = await tx
    .select({ id: schedules.id })
    .from(schedules)
    .where(eq(schedules.id, scheduleId))
    .for('update');
  if (!locked) return false;
  const [underway] = await tx
    .select({ n: count() })
    .from(tasks)
    .where(and(eq(tasks.scheduleId, scheduleId), ne(tasks.id, taskId), inArray(tasks.status, ['running', 'waiting'])));
  return (underway?.n ?? 0) >= unlocked.maxConcurrent;
}

/** The ids of the tasks that wait in Todo for a free slot of their schedule, in one query for the whole list. */
export async function heldTaskIds(
  db: DbOrTx,
  rows: readonly Pick<TaskRow, 'id' | 'status' | 'closed' | 'scheduleId'>[],
): Promise<Set<string>> {
  const waiting = rows.flatMap(({ id, status, closed, scheduleId }) =>
    status === 'todo' && !closed && scheduleId !== null ? [{ id, scheduleId }] : [],
  );
  if (waiting.length === 0) return new Set();
  const full = await db
    .select({ id: schedules.id })
    .from(schedules)
    .where(
      and(
        inArray(schedules.id, [...new Set(waiting.map(({ scheduleId }) => scheduleId))]),
        isNotNull(schedules.maxConcurrent),
        sql`(select count(*) from ${tasks} where ${tasks.scheduleId} = ${schedules.id} and ${tasks.status} in ('running', 'waiting')) >= ${schedules.maxConcurrent}`,
      ),
    );
  const fullIds = new Set(full.map(({ id }) => id));
  return new Set(waiting.filter(({ scheduleId }) => fullIds.has(scheduleId)).map(({ id }) => id));
}

/** Active schedules first, by when the pending card starts (one that is due now leads); paused and ended after. */
export async function listSchedules(db: DbOrTx): Promise<ScheduleView[]> {
  const rows = await selectViews(db).orderBy(
    sql`${schedules.endedAt} is not null`,
    sql`${schedules.pausedAt} is not null`,
    sql`${tasks.notBefore} asc nulls first`,
    asc(schedules.lastOccurrenceAt),
    asc(schedules.createdAt),
  );
  return rows.map(({ schedule, pendingNotBefore }) => ({ ...schedule, pendingNotBefore }));
}

/** Locks the pending occurrence, then the schedule: the order a claim takes them in. */
async function lockWithOccurrence(
  tx: DbOrTx,
  id: string,
): Promise<{ schedule: ScheduleRow; pending: TaskRow | undefined }> {
  const [unlocked] = await tx.select().from(schedules).where(eq(schedules.id, id));
  if (!unlocked) throw new AppError('NOT_FOUND', `no schedule ${id.slice(0, 64)}`);
  const pending =
    unlocked.occurrenceTaskId === null
      ? undefined
      : // Deleted since the read above: the check below turns that into a conflict.
        await lockTask(tx, unlocked.occurrenceTaskId).catch((error: unknown) => {
          if (error instanceof AppError && error.code === 'NOT_FOUND') return undefined;
          throw error;
        });
  const schedule = await lockSchedule(tx, id);
  if (schedule.occurrenceTaskId !== unlocked.occurrenceTaskId)
    throw new AppError('CONFLICT', 'The schedule changed while it was being edited; try again.');
  return { schedule, pending };
}

/** Deletes the pending occurrence when it never ran: waiting in Todo, no session, no run. True when it is gone. */
async function removePending(tx: DbOrTx, pending: TaskRow | undefined): Promise<boolean> {
  if (pending === undefined || pending.status !== 'todo' || pending.sessionId !== null) return false;
  const [runs] = await tx.select({ n: count() }).from(transcriptRuns).where(eq(transcriptRuns.taskId, pending.id));
  if ((runs?.n ?? 0) > 0) return false;
  await tx.delete(tasks).where(eq(tasks.id, pending.id));
  return true;
}

/** Pausing takes the pending occurrence off the board if it never ran; resuming creates the next one, from now. */
export async function setPaused(
  db: DbOrTx,
  id: string,
  paused: boolean,
  now: Date = new Date(),
): Promise<ScheduleView> {
  return db.transaction(async (tx) => {
    const { schedule, pending } = await lockWithOccurrence(tx, id);
    if (schedule.endedAt !== null) throw new AppError('CONFLICT', 'The schedule has ended.');
    if (paused === (schedule.pausedAt !== null)) return viewOf(tx, id);
    if (paused) {
      const removed = await removePending(tx, pending);
      await tx
        .update(schedules)
        .set({
          pausedAt: now,
          ...(removed
            ? { occurrenceTaskId: null, remaining: schedule.remaining === null ? null : schedule.remaining + 1 }
            : {}),
        })
        .where(eq(schedules.id, id));
    } else {
      const resumed = { ...schedule, pausedAt: null };
      await tx.update(schedules).set({ pausedAt: null }).where(eq(schedules.id, id));
      // Never before the start time: the cron path does not clamp to the anchor as the interval grid does.
      const from = schedule.anchorAt.getTime() > now.getTime() ? schedule.anchorAt : now;
      if (resumed.occurrenceTaskId === null) await materializeNext(tx, resumed, now, from);
    }
    return viewOf(tx, id);
  });
}

/** Deletes the schedule and its never-run pending occurrence, unless other schedules run after it. Tasks that ran stay, still naming it: their sealed fields are bound to its id. */
export async function removeSchedule(db: DbOrTx, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const { pending } = await lockWithOccurrence(tx, id);
    const dependents = await tx
      .select({ id: schedules.id })
      .from(schedules)
      .where(eq(schedules.afterScheduleId, id))
      .orderBy(asc(schedules.id));
    if (dependents.length > 0)
      throw new AppError(
        'CONFLICT',
        `Schedules run after this one (${dependents
          .slice(0, 5)
          .map((dependent) => dependent.id)
          .join(', ')}${dependents.length > 5 ? ', …' : ''}); delete those first.`,
      );
    await removePending(tx, pending);
    await tx.delete(schedules).where(eq(schedules.id, id));
  });
}

/**
 * A new title and prompt for the schedule, sealed in the browser under its binding; the next occurrences copy them. The
 * pending card takes them too while it waits in Todo and has not started, so the next run uses them.
 */
export async function editSchedule(
  db: DbOrTx,
  input: { id: string; title: string; input: string },
): Promise<{ schedule: ScheduleView; pending: 'updated' | 'started' | 'none' }> {
  requireSealed(input.title, 'the title');
  requireSealed(input.input, 'the prompt');
  return db.transaction(async (tx) => {
    const { schedule, pending } = await lockWithOccurrence(tx, input.id);
    if (schedule.endedAt !== null) throw new AppError('CONFLICT', 'The schedule has ended.');
    const now = new Date();
    await tx.update(schedules).set({ title: input.title, input: input.input }).where(eq(schedules.id, schedule.id));
    if (pending === undefined) return { schedule: await viewOf(tx, schedule.id), pending: 'none' };
    const editable = pending.status === 'todo' && !pending.closed && !hasStarted(pending);
    if (editable)
      await tx
        .update(tasks)
        .set({ title: input.title, input: input.input, updatedAt: now })
        .where(eq(tasks.id, pending.id));
    return { schedule: await viewOf(tx, schedule.id), pending: editable ? 'updated' : 'started' };
  });
}

export type PendingOutcome = 'updated' | 'started' | 'none' | 'removed' | 'created';

/** Everything of a schedule the user edits, except its id: the update replaces all of it. */
export interface ScheduleUpdate {
  id: string;
  /** `title`, `input`, `agent` and the directory are sealed for the schedule; the first two are bound to the agent. */
  title: string;
  input: string;
  agent?: string;
  place: { machine: string; workdir: string } | null;
  priority: Priority;
  model: string | null;
  /** An effort level, or null for claude's default; absent keeps the schedule's. */
  effort?: Effort | null;
  /** A lane name, or null for the default lane; absent keeps the schedule's. */
  lane?: string | null;
  icon?: string | null;
  labels?: string | null;
  autoDone: boolean;
  rule: Pick<WireScheduleDraft, 'everyMs' | 'cron' | 'moreCrons' | 'timezone' | 'after'>;
  /** The first run of a rule of its own; absent keeps the schedule's. */
  startAt?: Date;
  /** Runs the schedule still has, the pending card included; null is forever. */
  runsLeft: number | null;
  until: Date | null;
  maxConcurrent: number | null;
}

const sameInstant = (a: Date | null, b: Date | null): boolean => a?.getTime() === b?.getTime();

/** Whether the schedule must not run after `upstreamId`, because that one already runs (through others) after it. */
async function requireNoCycle(tx: DbOrTx, scheduleId: string, upstreamId: string): Promise<void> {
  const seen = new Set<string>();
  let current: string | null = upstreamId;
  while (current !== null && !seen.has(current)) {
    if (current === scheduleId)
      throw new AppError(
        'BAD_REQUEST',
        'That would make the schedules run after each other in a circle, so none of them would ever start.',
      );
    seen.add(current);
    const [row]: { afterScheduleId: string | null }[] = await tx
      .select({ afterScheduleId: schedules.afterScheduleId })
      .from(schedules)
      .where(eq(schedules.id, current));
    current = row?.afterScheduleId ?? null;
  }
}

/**
 * Replaces everything the user can set on a schedule, as the browser's Edit schedule form does. The pending card takes the
 * text, agent, directory, priority, model, effort, lane and auto-done while it waits in Todo and has not started, and moves to the new next
 * run when the rule, the first run or the end changed; otherwise the next card takes the change. Moving between a rule of its
 * own and running after another schedule removes or creates the pending card to fit. The caller seals `title`, `input`, `agent`
 * and the directory together, because the first two are bound to the agent.
 */
export async function updateSchedule(
  db: DbOrTx,
  update: ScheduleUpdate,
  now: Date = new Date(),
): Promise<{ schedule: ScheduleView; pending: PendingOutcome }> {
  const { rule, place } = update;
  requireRule({
    id: update.id,
    ...rule,
    ...(update.maxConcurrent === null ? {} : { maxConcurrent: update.maxConcurrent }),
  });
  if (update.runsLeft !== null && update.until !== null)
    throw new AppError('BAD_REQUEST', 'Give a number of runs or an end time, not both.');
  return db.transaction(async (tx) => {
    const { schedule, pending } = await lockWithOccurrence(tx, update.id);
    if (schedule.endedAt !== null) throw new AppError('CONFLICT', 'The schedule has ended.');
    if (rule.after !== undefined) {
      const upstreamId = rule.after.scheduleId;
      const [upstream] = await tx.select().from(schedules).where(eq(schedules.id, upstreamId)).for('share');
      if (!upstream) throw new AppError('BAD_REQUEST', `There is no schedule ${upstreamId.slice(0, 64)} to run after.`);
      if (upstream.endedAt !== null && upstreamId !== schedule.afterScheduleId)
        throw new AppError('BAD_REQUEST', 'The schedule to run after has ended, so this one would never run.');
      await requireNoCycle(tx, schedule.id, upstreamId);
    }
    const wasAfter = schedule.afterScheduleId !== null;
    const ownRule =
      rule.after === undefined
        ? {
            everyMs: rule.everyMs ?? null,
            cron: rule.cron ?? null,
            moreCrons: rule.cron === undefined ? [] : (rule.moreCrons ?? []),
            timezone: rule.cron === undefined ? null : (rule.timezone ?? null),
          }
        : { everyMs: null, cron: null, moreCrons: [], timezone: null };
    const values = {
      title: update.title,
      input: update.input,
      agent: update.agent ?? null,
      icon: update.icon === undefined ? schedule.icon : update.icon,
      labels: update.labels === undefined ? schedule.labels : update.labels,
      machine: place?.machine ?? null,
      workdir: place?.workdir ?? null,
      priority: update.priority,
      model: update.model,
      effort: update.effort === undefined ? schedule.effort : update.effort,
      requestedLane: update.lane === undefined ? schedule.requestedLane : update.lane,
      autoDone: update.autoDone,
      maxConcurrent: update.maxConcurrent,
      until: update.until,
      ...ownRule,
      afterScheduleId: rule.after?.scheduleId ?? null,
      afterDelayMs: rule.after === undefined ? null : (rule.after.delayMs ?? 0),
      anchorAt: rule.after === undefined ? (update.startAt ?? schedule.anchorAt) : schedule.anchorAt,
      remaining: update.runsLeft,
    };
    const merged: ScheduleRow = { ...schedule, ...values };
    const ruleChanged =
      wasAfter ||
      merged.everyMs !== schedule.everyMs ||
      merged.cron !== schedule.cron ||
      merged.timezone !== schedule.timezone ||
      merged.moreCrons.join('\n') !== schedule.moreCrons.join('\n') ||
      !sameInstant(merged.anchorAt, schedule.anchorAt) ||
      !sameInstant(merged.until, schedule.until);
    const from = merged.anchorAt.getTime() > now.getTime() ? merged.anchorAt : now;
    const next = rule.after === undefined && ruleChanged ? nextOccurrence(merged, from, true) : null;
    if (rule.after === undefined && ruleChanged && next === null)
      throw new AppError('BAD_REQUEST', 'The schedule would never run: nothing matches before its end.');

    const editable = pending !== undefined && pending.status === 'todo' && !pending.closed && !hasStarted(pending);
    let outcome: PendingOutcome = pending === undefined ? 'none' : editable ? 'updated' : 'started';
    let occurrenceTaskId = schedule.occurrenceTaskId;
    let lastOccurrenceAt = schedule.lastOccurrenceAt;
    const neverStarted = pending !== undefined && !hasStarted(pending);
    if (rule.after !== undefined && !wasAfter && neverStarted && (await removePending(tx, pending))) {
      occurrenceTaskId = null;
      outcome = 'removed';
    }
    if (editable && occurrenceTaskId !== null) {
      const pinned = place !== null;
      const moves = next !== null;
      if (moves) lastOccurrenceAt = next;
      await tx
        .update(tasks)
        .set({
          title: update.title,
          input: update.input,
          agent: update.agent ?? null,
          icon: update.icon === undefined ? schedule.icon : update.icon,
          labels: update.labels === undefined ? schedule.labels : update.labels,
          priority: update.priority,
          model: update.model,
          effort: update.effort === undefined ? schedule.effort : update.effort,
          requestedLane: update.lane === undefined ? schedule.requestedLane : update.lane,
          autoDone: update.autoDone,
          machine: pinned ? place.machine : null,
          workdir: pinned ? place.workdir : null,
          homeWorkdir: pinned ? place.workdir : null,
          ...(update.priority === pending.priority ? {} : { position: await edgePosition(tx, 'todo', 'bottom') }),
          ...(moves ? { notBefore: next } : {}),
          updatedAt: now,
        })
        .where(eq(tasks.id, pending.id));
    }
    await tx
      .update(schedules)
      .set({ ...values, occurrenceTaskId, lastOccurrenceAt })
      .where(eq(schedules.id, schedule.id));
    if (rule.after === undefined && occurrenceTaskId === null && schedule.pausedAt === null) {
      const created = await materializeNext(tx, { ...merged, occurrenceTaskId, lastOccurrenceAt }, now, from);
      if (created !== undefined) {
        occurrenceTaskId = created.id;
        outcome = 'created';
      }
    }
    const remaining =
      update.runsLeft === null ? null : Math.max(0, update.runsLeft - (occurrenceTaskId === null ? 0 : 1));
    await tx.update(schedules).set({ remaining }).where(eq(schedules.id, schedule.id));
    return { schedule: await viewOf(tx, schedule.id), pending: outcome };
  });
}
