/**
 * Moving a whole board out of the server and back in, and deleting it. The content is sealed, so none of this opens or
 * seals anything: it pages rows out as stored and writes rows back, and the only judgement is whether a row is well formed.
 */
import { eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';
import { PgTimestamp, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type { DbOrTx } from '../db/client';
import {
  appUsers,
  linkRules,
  titleRules,
  machines,
  notes,
  schedules,
  sharedAgents,
  taskPrs,
  tasks,
  transcriptEvents,
  transcriptRuns,
} from '../db/schema';
import { AppError } from './errors';
import {
  linkRulesRowSchema,
  titleRulesRowSchema,
  machineRowSchema,
  noteRowSchema,
  scheduleRowSchema,
  sharedAgentsRowSchema,
  taskPrRowSchema,
  taskRowSchema,
  transcriptEventRowSchema,
  transcriptRunRowSchema,
} from './accountRows';
import { getKeys } from './keys';

/** In the order an import needs them: a row can only be placed once what it points at is on the board. */
export const ACCOUNT_TABLES = [
  'task',
  'schedule',
  'note',
  'task_pr',
  'machine',
  'shared_agents',
  'link_rules',
  'title_rules',
  'transcript_run',
  'transcript_event',
] as const;
export type AccountTable = (typeof ACCOUNT_TABLES)[number];

export interface AccountSummary {
  tasks: number;
  schedules: number;
  notes: number;
  taskPrs: number;
  machines: number;
  sharedAgents: number;
  linkRules: number;
  titleRules: number;
  transcriptRuns: number;
  transcriptEvents: number;
  running: number;
}

/** What the browser needs to say what an export holds, and what a delete takes with it. */
export async function summarize(db: DbOrTx): Promise<AccountSummary> {
  const total = (table: PgTable) => sql<number>`(select count(*) from ${table})::int`;
  const [row] = await db
    .select({
      tasks: total(tasks),
      schedules: total(schedules),
      notes: total(notes),
      taskPrs: total(taskPrs),
      machines: total(machines),
      sharedAgents: total(sharedAgents),
      linkRules: total(linkRules),
      titleRules: total(titleRules),
      transcriptRuns: total(transcriptRuns),
      transcriptEvents: total(transcriptEvents),
      running: sql<number>`(select count(*) from ${tasks} where ${tasks.status} = 'running')::int`,
    })
    .from(sql`(select 1) as one`);
  return row!;
}

type KeyKind = 'timestamp' | 'text' | 'int';

interface ExportSpec {
  table: PgTable;
  /** The total order, as the output property of each column; a page ends at one of these and the next starts after it. */
  order: { property: string; column: PgColumn; kind: KeyKind }[];
}

const by = (property: string, column: PgColumn, kind: KeyKind) => ({ property, column, kind });

/** A parent task is created before its child, so ordering tasks by creation puts parents first. */
const EXPORT_SPECS: Record<AccountTable, ExportSpec> = {
  task: { table: tasks, order: [by('createdAt', tasks.createdAt, 'timestamp'), by('id', tasks.id, 'text')] },
  schedule: {
    table: schedules,
    order: [by('createdAt', schedules.createdAt, 'timestamp'), by('id', schedules.id, 'text')],
  },
  note: { table: notes, order: [by('createdAt', notes.createdAt, 'timestamp'), by('id', notes.id, 'text')] },
  task_pr: { table: taskPrs, order: [by('createdAt', taskPrs.createdAt, 'timestamp'), by('id', taskPrs.id, 'text')] },
  machine: { table: machines, order: [by('name', machines.name, 'text')] },
  shared_agents: { table: sharedAgents, order: [by('version', sharedAgents.version, 'int')] },
  link_rules: { table: linkRules, order: [by('version', linkRules.version, 'int')] },
  title_rules: { table: titleRules, order: [by('version', titleRules.version, 'int')] },
  transcript_run: {
    table: transcriptRuns,
    order: [by('startedAt', transcriptRuns.startedAt, 'timestamp'), by('id', transcriptRuns.id, 'text')],
  },
  transcript_event: {
    table: transcriptEvents,
    order: [by('runId', transcriptEvents.runId, 'text'), by('seq', transcriptEvents.seq, 'int')],
  },
};

export interface PageLimits {
  maxRows: number;
  maxBytes: number;
}

/** Transcript events carry large sealed outputs, so a page is bounded by its size as well as its row count. */
export const PAGE_LIMITS: PageLimits = { maxRows: 500, maxBytes: 4 * 1024 * 1024 };
/** Rows read at a time, so that a page of large rows never holds much more than `maxBytes` in memory. */
const CHUNK_ROWS = 25;

export interface ExportPage {
  rows: Record<string, unknown>[];
  next: string | null;
}

/** A timestamp as ISO text with microseconds: a `Date` keeps milliseconds, which would make a cursor repeat or skip rows. */
const MICRO_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function selectionOf(table: PgTable): Record<string, PgColumn | SQL> {
  return Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([property]) => property !== 'owner')
      .map(([property, column]) => [
        property,
        column instanceof PgTimestamp
          ? sql<string | null>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
          : column,
      ]),
  );
}

const encodeCursor = (values: unknown[]): string => Buffer.from(JSON.stringify(values)).toString('base64url');

function decodeCursor(spec: ExportSpec, cursor: string): unknown[] {
  const bad = () => new AppError('BAD_REQUEST', 'The cursor is not one this export gave out');
  let values: unknown;
  try {
    values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (!Array.isArray(values) || values.length !== spec.order.length) throw bad();
  const fits = spec.order.every(({ kind }, index) => {
    const value: unknown = values[index];
    if (kind === 'int') return typeof value === 'number' && Number.isInteger(value) && value >= 0;
    if (typeof value !== 'string') return false;
    return kind === 'timestamp' ? MICRO_ISO.test(value) : value.length > 0 && value.length <= 256;
  });
  if (!fits) throw bad();
  return values;
}

function afterCursor(spec: ExportSpec, values: unknown[]): SQL {
  const casts: Record<KeyKind, string> = { timestamp: 'timestamptz', text: 'text', int: 'integer' };
  const columns = spec.order.map(({ column }) => column);
  const bound = spec.order.map(({ kind }, index) => sql`${values[index]}::${sql.raw(casts[kind])}`);
  return sql`(${sql.join(columns, sql`, `)}) > (${sql.join(bound, sql`, `)})`;
}

/**
 * One page of a table in its total order, after `cursor` (null for the first page). A page is cut at `maxRows` or, once it
 * holds a row, before the row that would take it past `maxBytes` of JSON; `next` is the cursor of its last row, or null when
 * no row follows.
 */
export async function exportPage(
  db: DbOrTx,
  table: AccountTable,
  cursor: string | null,
  limits: PageLimits = PAGE_LIMITS,
): Promise<ExportPage> {
  const spec = EXPORT_SPECS[table];
  const selection = selectionOf(spec.table);
  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  let after = cursor === null ? null : decodeCursor(spec, cursor);
  for (;;) {
    const wanted = Math.min(CHUNK_ROWS, limits.maxRows - rows.length);
    const chunk: Record<string, unknown>[] = await db
      .select(selection)
      .from(spec.table)
      .where(after === null ? undefined : afterCursor(spec, after))
      .orderBy(...spec.order.map(({ column }) => column))
      .limit(wanted + 1);
    for (const row of chunk.slice(0, wanted)) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (rows.length > 0 && bytes + size > limits.maxBytes) return { rows, next: encodeCursor(after ?? []) };
      rows.push(row);
      bytes += size;
      after = spec.order.map(({ property }) => row[property]);
    }
    if (chunk.length <= wanted) return { rows, next: null };
    if (rows.length >= limits.maxRows) return { rows, next: encodeCursor(after ?? []) };
  }
}

export interface ImportResult {
  inserted: number;
  /** Rows the board already had (or that conflicted with a unique value, whoever's it is): left as they are. */
  existing: number;
  /** Rows that are not well formed. */
  invalid: number;
  /** Rows whose task, run or upstream schedule is not on the board. */
  orphaned: number;
}

const outcome = (offered: number, inserted: number, invalid: number, orphaned = 0): ImportResult => ({
  inserted,
  existing: offered - inserted,
  invalid,
  orphaned,
});

function parseRows<S extends z.ZodType>(schema: S, rows: unknown[]): { valid: z.output<S>[]; invalid: number } {
  const valid = rows.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data as z.output<S>] : [];
  });
  return { valid, invalid: rows.length - valid.length };
}

/** Which of `ids` are rows of the signed-in user's board; row-level security hides the rest, so another user's ids read as absent. */
async function presentIds(
  db: DbOrTx,
  table: typeof tasks | typeof schedules | typeof transcriptRuns,
  ids: string[],
): Promise<Set<string>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Set();
  const found = await db.select({ id: table.id }).from(table).where(inArray(table.id, wanted));
  return new Set(found.map(({ id }) => id));
}

const present = <T>(value: T | null): value is T => value !== null;

/** Links each child to its parent where the parent is on the board; the others keep no parent. */
async function linkParents(db: DbOrTx, children: { id: string; parentId: string | null }[]): Promise<void> {
  const linked = children.flatMap(({ id, parentId }) =>
    parentId !== null && parentId !== id ? [{ id, parentId }] : [],
  );
  const parents = await presentIds(
    db,
    tasks,
    linked.map(({ parentId }) => parentId),
  );
  for (const parentId of parents)
    await db
      .update(tasks)
      .set({ parentId })
      .where(
        inArray(
          tasks.id,
          linked.filter((child) => child.parentId === parentId).map(({ id }) => id),
        ),
      );
}

/**
 * Tasks go in without their parent and are linked afterwards: a parent that conflicts with another user's task id is not
 * inserted, and a row pointing at it would fail the whole statement. A task that was running has no run any more, so it
 * arrives in Needs me with what leaving Running clears; the run columns are not read from the row at all.
 */
async function importTasks(db: DbOrTx, rows: unknown[]): Promise<ImportResult> {
  const { valid, invalid } = parseRows(taskRowSchema, rows);
  const seen = new Set<string>();
  const distinct = valid.filter(({ id }) => !seen.has(id) && seen.add(id));
  const settled = distinct.map((row) => ({
    ...row,
    parentId: null,
    ...(row.status === 'running'
      ? {
          status: 'needs-me' as const,
          pausedAt: null,
          notBefore: null,
          wakeAt: null,
          waitCheck: false,
          wokenAt: null,
        }
      : {}),
  }));
  const added =
    settled.length === 0
      ? []
      : await db.insert(tasks).values(settled).onConflictDoNothing().returning({ id: tasks.id });
  const addedIds = new Set(added.map(({ id }) => id));
  await linkParents(
    db,
    distinct.filter(({ id }) => addedIds.has(id)),
  );
  return outcome(valid.length, added.length, invalid);
}

/**
 * A schedule that runs after another goes in once the other is on the board, in rounds: first the rows with a rule of their
 * own, then the rows whose upstream was added or was there already, and so on. A row whose upstream never gets there (not in
 * the file, held by another account, or part of a cycle) is orphaned: it has no rule of its own to fall back on, and it
 * would never run. A schedule whose pending occurrence is not on the board is paused when it was active, so that Resume
 * makes the next occurrence; without that it would sit active with nothing to run.
 */
async function importSchedules(db: DbOrTx, rows: unknown[]): Promise<ImportResult> {
  const { valid, invalid } = parseRows(scheduleRowSchema, rows);
  const onBoard = await presentIds(db, tasks, valid.map(({ occurrenceTaskId }) => occurrenceTaskId).filter(present));
  const settled = valid.map((row) => {
    const lost = row.occurrenceTaskId !== null && !onBoard.has(row.occurrenceTaskId);
    const active = row.pausedAt === null && row.endedAt === null;
    return {
      ...row,
      occurrenceTaskId: lost ? null : row.occurrenceTaskId,
      ...(lost && active ? { pausedAt: sql`now()` } : {}),
    };
  });
  const known = await presentIds(db, schedules, settled.map(({ afterScheduleId }) => afterScheduleId).filter(present));
  let waiting = settled;
  let inserted = 0;
  for (;;) {
    const isReady = ({ afterScheduleId }: (typeof settled)[number]) =>
      afterScheduleId === null || known.has(afterScheduleId);
    const ready = waiting.filter(isReady);
    if (ready.length === 0) break;
    waiting = waiting.filter((row) => !isReady(row));
    const added = await db.insert(schedules).values(ready).onConflictDoNothing().returning({ id: schedules.id });
    inserted += added.length;
    for (const { id: addedId } of added) known.add(addedId);
  }
  return outcome(valid.length - waiting.length, inserted, invalid, waiting.length);
}

/**
 * No note is pending afterwards: a pending note is a message for a running agent, and a run that ends hands such messages
 * back as replies for the next resume (`handBackPendingMessages`). No task runs after an import, so the column is not read.
 */
async function importNotes(db: DbOrTx, rows: unknown[]): Promise<ImportResult> {
  const { valid, invalid } = parseRows(noteRowSchema, rows);
  const onBoard = await presentIds(
    db,
    tasks,
    valid.map(({ taskId }) => taskId),
  );
  const placed = valid.filter(({ taskId }) => onBoard.has(taskId));
  const added =
    placed.length === 0 ? [] : await db.insert(notes).values(placed).onConflictDoNothing().returning({ id: notes.id });
  return outcome(placed.length, added.length, invalid, valid.length - placed.length);
}

async function importTaskPrs(db: DbOrTx, rows: unknown[]): Promise<ImportResult> {
  const { valid, invalid } = parseRows(taskPrRowSchema, rows);
  const onBoard = await presentIds(
    db,
    tasks,
    valid.map(({ taskId }) => taskId),
  );
  const placed = valid.filter(({ taskId }) => onBoard.has(taskId));
  const added =
    placed.length === 0
      ? []
      : await db.insert(taskPrs).values(placed).onConflictDoNothing().returning({ id: taskPrs.id });
  return outcome(placed.length, added.length, invalid, valid.length - placed.length);
}

/** A machine keeps its token hash and revocation, so that its token works after the move. */
async function importMachines(db: DbOrTx, rows: unknown[]): Promise<ImportResult> {
  const { valid, invalid } = parseRows(machineRowSchema, rows);
  const added =
    valid.length === 0
      ? []
      : await db.insert(machines).values(valid).onConflictDoNothing().returning({ name: machines.name });
  return outcome(valid.length, added.length, invalid);
}

/** The user's shared agents, unless the board has its own: the newer of two documents is not this import's to decide. */
async function importSharedAgents(db: DbOrTx, rows: unknown[]): Promise<ImportResult> {
  const { valid, invalid } = parseRows(sharedAgentsRowSchema, rows);
  const [first] = valid;
  const added =
    first === undefined
      ? []
      : await db.insert(sharedAgents).values(first).onConflictDoNothing().returning({ version: sharedAgents.version });
  return outcome(valid.length, added.length, invalid);
}

/** The user's link rules, unless the board has its own: the newer of two documents is not this import's to decide. */
async function importLinkRules(db: DbOrTx, rows: unknown[]): Promise<ImportResult> {
  const { valid, invalid } = parseRows(linkRulesRowSchema, rows);
  const [first] = valid;
  const added =
    first === undefined
      ? []
      : await db.insert(linkRules).values(first).onConflictDoNothing().returning({ version: linkRules.version });
  return outcome(valid.length, added.length, invalid);
}

/** The user's title rules, unless the board has its own, for the same reason as the link rules. */
async function importTitleRules(db: DbOrTx, rows: unknown[]): Promise<ImportResult> {
  const { valid, invalid } = parseRows(titleRulesRowSchema, rows);
  const [first] = valid;
  const added =
    first === undefined
      ? []
      : await db.insert(titleRules).values(first).onConflictDoNothing().returning({ version: titleRules.version });
  return outcome(valid.length, added.length, invalid);
}

async function importTranscriptRuns(db: DbOrTx, rows: unknown[]): Promise<ImportResult> {
  const { valid, invalid } = parseRows(transcriptRunRowSchema, rows);
  const onBoard = await presentIds(
    db,
    tasks,
    valid.map(({ taskId }) => taskId),
  );
  const placed = valid.filter(({ taskId }) => onBoard.has(taskId));
  const added =
    placed.length === 0
      ? []
      : await db.insert(transcriptRuns).values(placed).onConflictDoNothing().returning({ id: transcriptRuns.id });
  return outcome(placed.length, added.length, invalid, valid.length - placed.length);
}

async function importTranscriptEvents(db: DbOrTx, rows: unknown[]): Promise<ImportResult> {
  const { valid, invalid } = parseRows(transcriptEventRowSchema, rows);
  const onBoard = await presentIds(
    db,
    transcriptRuns,
    valid.map(({ runId }) => runId),
  );
  const placed = valid.filter(({ runId }) => onBoard.has(runId));
  const added =
    placed.length === 0
      ? []
      : await db.insert(transcriptEvents).values(placed).onConflictDoNothing().returning({ seq: transcriptEvents.seq });
  return outcome(placed.length, added.length, invalid, valid.length - placed.length);
}

const IMPORTERS: Record<AccountTable, (db: DbOrTx, rows: unknown[]) => Promise<ImportResult>> = {
  task: importTasks,
  schedule: importSchedules,
  note: importNotes,
  task_pr: importTaskPrs,
  machine: importMachines,
  shared_agents: importSharedAgents,
  link_rules: importLinkRules,
  title_rules: importTitleRules,
  transcript_run: importTranscriptRuns,
  transcript_event: importTranscriptEvents,
};

/**
 * Writes the rows of one table of an export under the signed-in user. An export is sealed under the key it was made with, so
 * it is only taken by a board whose key it is; the owner of every row is the signed-in user, whatever the row says. A row
 * that is not well formed, or whose task, run or upstream schedule is not on the board, is counted and skipped, never a failure of the batch.
 */
export async function importRows(
  db: DbOrTx,
  { keyId, table, rows }: { keyId: string; table: AccountTable; rows: unknown[] },
): Promise<ImportResult> {
  const keys = await getKeys(db);
  if (keys === null) throw new AppError('CONFLICT', 'Encryption is not set up yet; set it up before importing');
  if (keys.keyId !== keyId) throw new AppError('CONFLICT', 'The export was made with another key than this board’s');
  return IMPORTERS[table](db, rows);
}

/** Deletes the user, and with the user every row of their board (all of it cascades from `app_user`). */
export async function deleteAccount(
  db: DbOrTx,
  { username, confirm }: { username: string; confirm: string },
): Promise<void> {
  if (confirm !== username) throw new AppError('BAD_REQUEST', 'Type your username to confirm');
  await db.delete(appUsers).where(eq(appUsers.username, username));
}
