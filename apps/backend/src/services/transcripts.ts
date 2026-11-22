import { TRANSCRIPT_PAGE_SIZE, type WireTranscriptBatch, type WireTranscriptEventView } from '@agent-board/shared';
import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { tasks, transcriptEvents, transcriptRuns } from '../db/schema';
import { AppError } from './errors';
import { DONE_TRANSCRIPT_DAYS, daysBefore, TRANSCRIPT_RETENTION_DAYS } from './retention';
import { getTask } from './tasks';

/** Stores a batch; a retried batch (same run and seq) changes nothing. */
export async function appendTranscript(
  db: DbOrTx,
  taskId: string,
  machine: string,
  batch: WireTranscriptBatch,
): Promise<void> {
  await getTask(db, taskId);
  await db.transaction(async (tx) => {
    const last = batch.events.at(-1)?.at;
    await tx
      .insert(transcriptRuns)
      .values({
        id: batch.runId,
        taskId,
        machine,
        sessionId: batch.sessionId,
        resumed: batch.resumed,
        startedAt: new Date(batch.startedAt),
        lastEventAt: last ? new Date(last) : new Date(batch.startedAt),
      })
      .onConflictDoNothing();
    // Read after the insert: a resent batch can wait here for the first one's commit and then find its own run.
    const [run] = await tx.select().from(transcriptRuns).where(eq(transcriptRuns.id, batch.runId));
    if (!run) throw new AppError('CONFLICT', 'the run id is already taken');
    if (run.taskId !== taskId) throw new AppError('BAD_REQUEST', 'the run belongs to another task');
    if (batch.events.length === 0) return;
    const inserted = await tx
      .insert(transcriptEvents)
      .values(
        batch.events.map((event) => ({
          runId: batch.runId,
          seq: event.seq,
          at: new Date(event.at),
          kind: event.kind,
          parent: event.parent,
          data: event.data,
          output: event.output ?? null,
          outputSize: event.outputSize ?? null,
        })),
      )
      .onConflictDoNothing()
      .returning({ seq: transcriptEvents.seq, kind: transcriptEvents.kind });
    await tx
      .update(transcriptRuns)
      .set({
        eventCount: sql`${transcriptRuns.eventCount} + ${inserted.filter((row) => row.kind !== 'context').length}`,
        ...(last
          ? { lastEventAt: sql`greatest(${transcriptRuns.lastEventAt}, ${new Date(last).toISOString()}::timestamptz)` }
          : {}),
      })
      .where(eq(transcriptRuns.id, batch.runId));
  });
}

export async function listRuns(db: DbOrTx, taskId: string) {
  return db
    .select({
      id: transcriptRuns.id,
      machine: transcriptRuns.machine,
      sessionId: transcriptRuns.sessionId,
      resumed: transcriptRuns.resumed,
      startedAt: transcriptRuns.startedAt,
      lastEventAt: transcriptRuns.lastEventAt,
      eventCount: transcriptRuns.eventCount,
    })
    .from(transcriptRuns)
    .where(eq(transcriptRuns.taskId, taskId))
    .orderBy(desc(transcriptRuns.startedAt));
}

/** Events after `afterSeq`, without tool output: a result says how long its output is instead. `data` is still sealed. */
export async function listEvents(
  db: DbOrTx,
  runId: string,
  afterSeq: number,
  limit = TRANSCRIPT_PAGE_SIZE,
): Promise<WireTranscriptEventView[]> {
  return db
    .select({
      seq: transcriptEvents.seq,
      at: transcriptEvents.at,
      kind: transcriptEvents.kind,
      parent: transcriptEvents.parent,
      data: transcriptEvents.data,
      outputSize: transcriptEvents.outputSize,
    })
    .from(transcriptEvents)
    .where(
      and(eq(transcriptEvents.runId, runId), gt(transcriptEvents.seq, afterSeq), ne(transcriptEvents.kind, 'context')),
    )
    .orderBy(asc(transcriptEvents.seq))
    .limit(limit);
}

export async function latestContext(
  db: DbOrTx,
  taskId: string,
): Promise<{ runId: string; seq: number; at: Date; data: string } | null> {
  const newestRun = db
    .select({ id: transcriptRuns.id })
    .from(transcriptRuns)
    .where(eq(transcriptRuns.taskId, taskId))
    .orderBy(desc(transcriptRuns.startedAt))
    .limit(1);
  const [row] = await db
    .select({
      runId: transcriptEvents.runId,
      seq: transcriptEvents.seq,
      at: transcriptEvents.at,
      data: transcriptEvents.data,
    })
    .from(transcriptEvents)
    .where(and(eq(transcriptEvents.runId, newestRun), eq(transcriptEvents.kind, 'context')))
    .orderBy(desc(transcriptEvents.seq))
    .limit(1);
  return row ?? null;
}

export async function latestContexts(
  db: DbOrTx,
  taskIds: string[],
): Promise<Map<string, { runId: string; seq: number; at: Date; data: string }>> {
  if (taskIds.length === 0) return new Map();
  const newest = db
    .selectDistinctOn([transcriptRuns.taskId], { taskId: transcriptRuns.taskId, runId: transcriptRuns.id })
    .from(transcriptRuns)
    .where(inArray(transcriptRuns.taskId, taskIds))
    .orderBy(transcriptRuns.taskId, desc(transcriptRuns.startedAt))
    .as('newest');
  const latest = db
    .select({ seq: transcriptEvents.seq, at: transcriptEvents.at, data: transcriptEvents.data })
    .from(transcriptEvents)
    .where(and(eq(transcriptEvents.runId, newest.runId), eq(transcriptEvents.kind, 'context')))
    .orderBy(desc(transcriptEvents.seq))
    .limit(1)
    .as('latest');
  const rows = await db
    .select({ taskId: newest.taskId, runId: newest.runId, seq: latest.seq, at: latest.at, data: latest.data })
    .from(newest)
    .innerJoinLateral(latest, sql`true`);
  return new Map(rows.map(({ taskId, ...context }) => [taskId, context]));
}

/** A tool result's sealed output; null for an event without one. */
export async function eventOutput(db: DbOrTx, runId: string, seq: number): Promise<string | null> {
  const [row] = await db
    .select({ output: transcriptEvents.output })
    .from(transcriptEvents)
    .where(and(eq(transcriptEvents.runId, runId), eq(transcriptEvents.seq, seq)));
  if (!row) throw new AppError('NOT_FOUND', 'no such event');
  return row.output;
}

/** Deletes the transcripts of tasks closed more than the retention ago, and of open tasks untouched in Done for longer. Returns how many runs went. */
export async function deleteOldTranscripts(db: DbOrTx, now: Date = new Date()): Promise<number> {
  const cutoff = daysBefore(now, TRANSCRIPT_RETENTION_DAYS);
  const doneCutoff = daysBefore(now, DONE_TRANSCRIPT_DAYS);
  // A task closed before closedAt existed counts from its last change.
  const old = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      or(
        and(eq(tasks.closed, true), lt(sql`coalesce(${tasks.closedAt}, ${tasks.updatedAt})`, cutoff)),
        and(eq(tasks.status, 'done'), eq(tasks.closed, false), lt(tasks.updatedAt, doneCutoff)),
      ),
    );
  const gone = await db
    .delete(transcriptRuns)
    .where(inArray(transcriptRuns.taskId, old))
    .returning({ id: transcriptRuns.id });
  return gone.length;
}
