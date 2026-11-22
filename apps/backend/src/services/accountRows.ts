/**
 * What `account.import` accepts per table: the table's columns, checked as strictly as the code paths that normally write
 * them, because the database refuses a violation of its sealed-content checks for the whole batch. A column with a database
 * default or that may be null can be left out of a row; ids, sealed text, positions and timestamps cannot.
 */
import {
  EFFORTS,
  hasControlCharacter,
  isCronExpression,
  isModelName,
  isSafeMachineName,
  isServerEventText,
  isSafeTaskId,
  isSessionId,
  isWatchId,
  MAX_INT32,
  MAX_INTERVAL_MS,
  MAX_OUTPUT_SIZE,
  MAX_SCHEDULE_CONCURRENT,
  MAX_SCHEDULE_CRONS,
  parseBlindIndex,
} from '@agent-board/shared';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { nextRun, noteAuthor, noteKind, prState, taskActor, taskCreator, taskPriority, taskStatus } from '../db/schema';
import { parsedBy, sealed } from '../trpc/inputs';
import { AppError } from './errors';
import { requireRule } from './schedules';

const MIN_TIME = Date.parse('0001-01-01T00:00:00Z');
/** A second short of the end of year 9999: a fraction past it rounds to year 10000 in Postgres, which an export writes with five digits. */
const MAX_TIME = Date.parse('9999-12-31T23:59:59Z');

/**
 * An ISO timestamp within years 1 to 9999 (Postgres refuses year 0000, and a `Date` and the export's cursors hold four-digit
 * years), handed to Postgres as it came: an exported value keeps its microseconds, which a `Date` would drop, and notes
 * written in one millisecond are ordered by them.
 */
const timestamp = z.iso
  .datetime({ offset: true })
  .refine((value) => {
    const time = Date.parse(value);
    return time >= MIN_TIME && time <= MAX_TIME;
  }, 'not a time between the years 1 and 9999')
  .transform((value): SQL => sql`${value}::timestamptz`);
/** Free text in a clear column: Postgres refuses a NUL in text, and a control character has no place in a name or a line. */
const plainText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !hasControlCharacter(value), 'holds a control character');
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().default(null);
const id = z.string().refine(isSafeTaskId, 'not an id');
const machineName = z.string().refine(isSafeMachineName, 'not a safe machine name');
const blindIndex = (what: string) => parsedBy(z.string(), (value) => parseBlindIndex(value, what));
const count = z.number().int().min(0).max(MAX_INT32);

export const TRANSCRIPT_RUN_ID = /^[A-Za-z0-9-]{8,64}$/;

export const taskRowSchema = z.object({
  id,
  title: sealed('title', 'title'),
  input: sealed('input', 'input'),
  status: z.enum(taskStatus.enumValues).default('todo'),
  priority: z.enum(taskPriority.enumValues).default('normal'),
  model: nullable(z.string().refine(isModelName, 'not a model name')),
  effort: nullable(z.enum(EFFORTS)),
  requestedLane: nullable(machineName),
  autoDone: z.boolean().default(false),
  movedBy: nullable(z.enum(taskActor.enumValues)),
  position: z.number().finite(),
  closed: z.boolean().default(false),
  closedAt: nullable(timestamp),
  machine: nullable(machineName),
  sessionId: nullable(z.string().refine(isSessionId, 'not a session id')),
  workdir: nullable(sealed('workdir', 'workdir')),
  homeWorkdir: nullable(sealed('workdir', 'homeWorkdir')),
  agent: nullable(sealed('agent', 'agent')),
  icon: nullable(sealed('icon', 'icon')),
  watches: nullable(sealed('watches', 'watches')),
  watchStops: z.array(z.string().refine(isWatchId, 'not a watch id')).max(256).default([]),
  prState: nullable(z.enum(prState.enumValues)),
  next: z.enum(nextRun.enumValues).default('fresh'),
  lane: nullable(machineName),
  borrowed: z.boolean().default(false),
  lastActiveAt: nullable(timestamp),
  pausedAt: nullable(timestamp),
  notBefore: nullable(timestamp),
  wakeAt: nullable(timestamp),
  waitCheck: z.boolean().default(false),
  wokenAt: nullable(timestamp),
  head: nullable(blindIndex('head')),
  openQuestionNoteId: nullable(id),
  dedupeKey: nullable(blindIndex('dedupeKey')),
  parentId: nullable(id),
  createdBy: z.enum(taskCreator.enumValues).default('user'),
  scheduleId: nullable(id),
  forkOf: nullable(id),
  occurrenceFinishedAt: nullable(timestamp),
  proposed: z.boolean().default(false),
  createdAt: timestamp,
  updatedAt: timestamp,
});

/**
 * The rule columns as `addSchedule` checks them (interval bounds, cron expressions and time zone, the delay, the limit), and
 * the shape the database holds a schedule to: exactly one of an interval, a cron expression and an upstream schedule, a
 * delay with an upstream and only then, and a time zone with a cron expression and only then.
 */
const scheduleRowShape = z.object({
  id,
  title: sealed('title', 'title'),
  input: sealed('input', 'input'),
  priority: z.enum(taskPriority.enumValues).default('normal'),
  model: nullable(z.string().refine(isModelName, 'not a model name')),
  effort: nullable(z.enum(EFFORTS)),
  requestedLane: nullable(machineName),
  autoDone: z.boolean().default(false),
  machine: nullable(machineName),
  workdir: nullable(sealed('workdir', 'workdir')),
  agent: nullable(sealed('agent', 'agent')),
  icon: nullable(sealed('icon', 'icon')),
  everyMs: nullable(z.number().int().positive().max(MAX_INTERVAL_MS)),
  cron: nullable(plainText(256)),
  moreCrons: z
    .array(plainText(256).refine(isCronExpression, 'not a cron expression'))
    .max(MAX_SCHEDULE_CRONS - 1)
    .default([]),
  timezone: nullable(plainText(256)),
  afterScheduleId: nullable(id),
  afterDelayMs: nullable(z.number().int().min(0).max(MAX_INTERVAL_MS)),
  maxConcurrent: nullable(z.number().int().min(1).max(MAX_SCHEDULE_CONCURRENT)),
  anchorAt: timestamp,
  lastOccurrenceAt: nullable(timestamp),
  remaining: nullable(count),
  until: nullable(timestamp),
  pausedAt: nullable(timestamp),
  endedAt: nullable(timestamp),
  occurrenceTaskId: nullable(id),
  createdAt: timestamp,
});

export const scheduleRowSchema = scheduleRowShape.superRefine((row, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const rules = [row.everyMs, row.cron, row.afterScheduleId].filter((rule) => rule !== null).length;
  if (rules !== 1)
    return fail('a schedule needs exactly one of an interval, a cron expression and a schedule to run after');
  if ((row.afterScheduleId === null) !== (row.afterDelayMs === null))
    return fail('a delay goes with a schedule to run after');
  if ((row.cron === null) !== (row.timezone === null)) return fail('a time zone goes with a cron expression');
  if (row.cron === null && row.moreCrons.length > 0) return fail('more cron expressions go with a cron expression');
  try {
    requireRule({
      id: row.id,
      ...(row.everyMs === null ? {} : { everyMs: row.everyMs }),
      ...(row.cron === null ? {} : { cron: row.cron, timezone: row.timezone ?? '', moreCrons: row.moreCrons }),
      ...(row.afterScheduleId === null
        ? {}
        : { after: { scheduleId: row.afterScheduleId, delayMs: row.afterDelayMs ?? 0 } }),
      ...(row.maxConcurrent === null ? {} : { maxConcurrent: row.maxConcurrent }),
    });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    fail(error.message);
  }
});

/** The body of a note by the server is plain text and must be one of its fixed event texts; every other body is sealed. */
export const noteRowSchema = z
  .object({
    id,
    taskId: id,
    author: z.enum(noteAuthor.enumValues),
    kind: z.enum(noteKind.enumValues),
    body: z.string(),
    preview: nullable(sealed('note.preview', 'preview')),
    suggestion: nullable(sealed('note.suggestion', 'suggestion')),
    questions: nullable(sealed('note.questions', 'questions')),
    answers: nullable(sealed('note.answers', 'answers')),
    questionNoteId: nullable(id),
    by: nullable(plainText(256)),
    queued: z.boolean().default(false),
    deliveredAt: nullable(timestamp),
    createdAt: timestamp,
  })
  .superRefine((row, ctx) => {
    if (row.author === 'server') {
      if (row.kind !== 'event' || !isServerEventText(row.body))
        ctx.addIssue({ code: 'custom', path: ['body'], message: 'not a text the server writes' });
    } else {
      const checked = sealed('note.body', 'body').safeParse(row.body);
      if (!checked.success) ctx.addIssue({ code: 'custom', path: ['body'], message: 'not a sealed body' });
    }
    if (row.suggestion !== null && !(row.author === 'agent' && row.kind === 'comment'))
      ctx.addIssue({ code: 'custom', path: ['suggestion'], message: 'only a comment by the agent has a suggestion' });
  });

export const taskPrRowSchema = z.object({
  id,
  taskId: id,
  pr: sealed('pr', 'pr'),
  state: nullable(z.enum(prState.enumValues)),
  createdAt: timestamp,
});

export const machineRowSchema = z.object({
  name: machineName,
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/, 'not a sha256 hex digest'),
  createdAt: timestamp,
  lastSeenAt: nullable(timestamp),
  clientVersion: nullable(plainText(64)),
  clientApi: nullable(count),
  revokedAt: nullable(timestamp),
  dirs: nullable(sealed('machine.dirs', 'dirs')),
  dirsIndex: nullable(blindIndex('dirsIndex')),
  dirsUpdatedAt: nullable(timestamp),
  catalog: nullable(sealed('machine.catalog', 'catalog')),
  catalogIndex: nullable(blindIndex('catalogIndex')),
  catalogUpdatedAt: nullable(timestamp),
  usage: nullable(sealed('machine.usage', 'usage')),
  usageIndex: nullable(blindIndex('usageIndex')),
  usageUpdatedAt: nullable(timestamp),
  sources: nullable(sealed('machine.sources', 'sources')),
  sourcesIndex: nullable(blindIndex('sourcesIndex')),
  sourcesUpdatedAt: nullable(timestamp),
});

/** The version is in the binding of the document, so it comes in as it was; a board that has its own keeps it. */
export const sharedAgentsRowSchema = z.object({
  version: z.number().int().min(1).max(MAX_INT32),
  document: sealed('agents.shared', 'document'),
  pushedAt: timestamp,
});

/** The version is in the binding of the document, so it comes in as it was; a board that has its own keeps it. */
export const linkRulesRowSchema = z.object({
  version: z.number().int().min(1).max(MAX_INT32),
  document: sealed('links', 'document'),
  updatedAt: timestamp,
});

export const titleRulesRowSchema = z.object({
  version: z.number().int().min(1).max(MAX_INT32),
  document: sealed('titles', 'document'),
  updatedAt: timestamp,
});

export const transcriptRunRowSchema = z.object({
  id: z.string().regex(TRANSCRIPT_RUN_ID, 'not a run id'),
  taskId: id,
  machine: plainText(256),
  sessionId: nullable(z.string().refine(isSessionId, 'not a session id')),
  resumed: z.boolean().default(false),
  startedAt: timestamp,
  lastEventAt: timestamp,
  eventCount: count.default(0),
});

export const transcriptEventRowSchema = z.object({
  runId: z.string().regex(TRANSCRIPT_RUN_ID, 'not a run id'),
  seq: count,
  at: timestamp,
  kind: z.string().regex(/^[a-z_]{1,32}$/, 'not an event kind'),
  parent: nullable(z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, 'not a tool use id')),
  data: sealed('tr.data', 'data'),
  output: nullable(sealed('tr.output', 'output')),
  outputSize: nullable(z.number().int().min(0).max(MAX_OUTPUT_SIZE)),
});
