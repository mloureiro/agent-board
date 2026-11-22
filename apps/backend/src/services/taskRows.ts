import { DEFAULT_PRIORITY, isDraftStatus, newTaskId, type Status, type WireTaskDraft } from '@agent-board/shared';
import { eq, max, min } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { tasks, type TaskRow } from '../db/schema';
import { AppError } from './errors';

/** A position below every task of the status (`bottom`) or above all of them (`top`). */
export async function edgePosition(db: DbOrTx, status: Status, edge: 'top' | 'bottom'): Promise<number> {
  const [row] = await db
    .select({ low: min(tasks.position), high: max(tasks.position) })
    .from(tasks)
    .where(eq(tasks.status, status));
  if (edge === 'top') return row?.low == null ? 0 : row.low - 1;
  return row?.high == null ? 0 : row.high + 1;
}

export async function getTask(db: DbOrTx, id: string): Promise<TaskRow> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!row) throw new AppError('NOT_FOUND', `no task ${id.slice(0, 64)}`);
  return row;
}

/**
 * New task at the bottom of its status, or at the top for a fork, which the user started by hand. A known dedupe key returns the
 * existing task instead. The id is the caller's (a client seals the task's fields against it, the server makes one for a
 * schedule's occurrence); one that is taken, by anyone, is a conflict. `extra` is what no draft of a machine can set.
 */
export async function insertTask(
  tx: DbOrTx,
  draft: Omit<WireTaskDraft, 'id'> & { id?: string },
  extra: { scheduleId?: string; forkOf?: string } = {},
): Promise<{ row: TaskRow; created: boolean }> {
  // A follow-up is as pressing as the task it came from, unless its creator says otherwise.
  const parent = draft.parentId === undefined ? undefined : await getTask(tx, draft.parentId);
  const proposed = draft.createdBy === 'agent';
  // A proposal waits in Backlog for the user whatever status the agent named.
  const status = proposed ? 'backlog' : (draft.status ?? 'todo');
  if (draft.notBefore !== undefined && status !== 'todo')
    throw new AppError('BAD_REQUEST', 'Only a task in Todo can have a start time.');
  // Running and Waiting need a run behind them and Done a close; their own commands are the only way in.
  if (!isDraftStatus(status)) throw new AppError('BAD_REQUEST', 'A new task starts in Backlog, Todo or Needs me.');
  const [row] = await tx
    .insert(tasks)
    .values({
      id: draft.id ?? newTaskId(),
      title: draft.title,
      input: draft.input,
      machine: draft.machine ?? null,
      workdir: draft.workdir ?? null,
      homeWorkdir: draft.workdir ?? null,
      agent: draft.agent ?? null,
      icon: draft.icon ?? null,
      labels: draft.labels ?? null,
      head: draft.head ?? null,
      notBefore: draft.notBefore ?? null,
      scheduleId: extra.scheduleId ?? null,
      forkOf: extra.forkOf ?? null,
      status,
      priority: draft.priority ?? parent?.priority ?? DEFAULT_PRIORITY,
      model: draft.model ?? null,
      effort: draft.effort ?? null,
      requestedLane: draft.lane ?? null,
      autoDone: draft.autoDone ?? false,
      position: await edgePosition(tx, status, extra.forkOf === undefined ? 'bottom' : 'top'),
      dedupeKey: draft.dedupeKey ?? null,
      parentId: draft.parentId ?? null,
      createdBy: draft.createdBy ?? 'user',
      proposed,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { row, created: true };
  // Nothing was inserted: the dedupe key is known, or the id is taken. A taken id reads the same whoever holds it.
  const [existing] =
    draft.dedupeKey === undefined ? [] : await tx.select().from(tasks).where(eq(tasks.dedupeKey, draft.dedupeKey));
  if (!existing) throw new AppError('CONFLICT', 'that task id is already taken');
  return { row: existing, created: false };
}

/**
 * Whether a worker ever claimed the task. A claim sets `lastActiveAt` (kept after the run, unlike the run's own columns),
 * and a session means a run reported back, so the board's transcript rows and a re-run fresh cannot hide a run.
 */
export function hasStarted(row: Pick<TaskRow, 'lastActiveAt' | 'sessionId'>): boolean {
  return row.lastActiveAt !== null || row.sessionId !== null;
}

export async function lockTask(tx: DbOrTx, id: string): Promise<TaskRow> {
  const [row] = await tx.select().from(tasks).where(eq(tasks.id, id)).for('update');
  if (!row) throw new AppError('NOT_FOUND', `no task ${id.slice(0, 64)}`);
  return row;
}
