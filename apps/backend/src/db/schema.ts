import type { KeySlot } from '@agent-board/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  primaryKey,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  type AnyPgColumn,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { BLIND_INDEX_PATTERN, ENVELOPE_PATTERN } from './sealedColumns';

export const taskStatus = pgEnum('task_status', ['backlog', 'todo', 'running', 'waiting', 'needs-me', 'done']);
/** Declared highest first, so ordering by the enum puts urgent on top. */
export const taskPriority = pgEnum('task_priority', ['urgent', 'high', 'normal', 'low']);
export const nextRun = pgEnum('next_run', ['fresh', 'resume']);
export const prState = pgEnum('pr_state', ['open', 'merged', 'closed']);
export const taskCreator = pgEnum('task_creator', ['intake', 'user', 'agent']);
/** "server" is the only author whose body is plain text: the events the server writes itself. Every other note body is sealed. */
export const noteAuthor = pgEnum('note_author', ['agent', 'user', 'system', 'server']);
/** Who made a task's last status change: the user in the browser, its agent from inside its run, or a machine (the CLI outside a run). */
export const taskActor = pgEnum('task_actor', ['user', 'agent', 'machine']);
/** How a user signed in: a session's method, and the one that owns a board's name. */
export const sessionMethod = pgEnum('session_method', ['passkey', 'oidc', 'saml']);
export const noteKind = pgEnum('note_kind', ['comment', 'question', 'answer', 'event', 'polish']);

/** A signed-in user; every row below belongs to one, and a request sees only its own (`app.owner`, see db/scope.ts). */
export const appUsers = pgTable(
  'app_user',
  {
    username: text('username').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Fingerprint of the user's data key and its wrapped copies; both stay null until encryption is set up. */
    keyId: text('key_id'),
    keySlots: jsonb('key_slots').$type<KeySlot[]>(),
    /** The sign-in method that created the board, and the only one of OIDC and SAML that signs into it; null for a board from before sign-in. */
    source: sessionMethod('source'),
  },
  (t) => [
    check('app_user_username_not_empty', sql`${t.username} <> ''`),
    check('app_user_key_all_or_nothing', sql`(${t.keyId} is null) = (${t.keySlots} is null)`),
    pgPolicy('tenant', {
      for: 'all',
      to: 'board_app',
      using: sql`username = (select current_setting('app.owner', true))`,
      withCheck: sql`username = (select current_setting('app.owner', true))`,
    }),
  ],
).enableRLS();

/** Defaults to the request's owner, so inserts do not name it. */
const owner = () =>
  text('owner')
    .notNull()
    .references(() => appUsers.username, { onDelete: 'cascade' })
    .default(sql`current_setting('app.owner', true)`);

/** Row-level security for a table with an `owner` column. */
const tenant = () =>
  pgPolicy('tenant', {
    for: 'all',
    to: 'board_app',
    using: sql`owner = (select current_setting('app.owner', true))`,
    withCheck: sql`owner = (select current_setting('app.owner', true))`,
  });

/**
 * A reference that includes the owner, so a row can only point at a row of its own board. Foreign-key checks bypass
 * row-level security, so a plain id reference would accept (and reveal the existence of) another user's row.
 *
 * The `set null` ones are `ON DELETE SET NULL (<the id column>)` in migration 0011: Drizzle cannot write the column
 * list, and a plain SET NULL would also try to null `owner`. drizzle-kit compares schema.ts with its snapshot, not
 * with the database, so the snapshot records `set null` for them and `generate` stays quiet.
 */
const ownerFk = (
  name: string,
  columns: [AnyPgColumn, AnyPgColumn],
  foreignColumns: [AnyPgColumn, AnyPgColumn],
  onDelete: 'set null' | 'cascade' | 'restrict',
) => foreignKey({ name, columns, foreignColumns }).onDelete(onDelete);

const isEnvelope = (column: AnyPgColumn) => sql`${column} ~ ${sql.raw(`'${ENVELOPE_PATTERN}'`)}`;
const isBlindIndex = (column: AnyPgColumn) => sql`${column} ~ ${sql.raw(`'${BLIND_INDEX_PATTERN}'`)}`;

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
/**
 * `now()` is the start of the transaction, so the notes one request writes (a move and its priority change, the hourly
 * cleanup of a board) would share a timestamp and fall back to the random id for their order. The wall clock keeps
 * them in write order.
 */
const writtenAt = () =>
  timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`);

export const tasks = pgTable(
  'task',
  {
    id: text('id').primaryKey(),
    owner: owner(),
    /** `title`, `input` and `workdir` hold sealed envelopes (abe1.…); the server never reads them. */
    title: text('title').notNull(),
    input: text('input').notNull(),
    status: taskStatus('status').notNull().default('todo'),
    priority: taskPriority('priority').notNull().default('normal'),
    /** The Claude model of its runs (a clear choice, not content); null is claude's default. */
    model: text('model'),
    /** The effort level of its runs (a clear choice, not content); null is claude's default. */
    effort: text('effort'),
    /** The lane of a machine the user wants the task to run in (routing, clear like the priority); null is the machine's default lane. */
    requestedLane: text('requested_lane'),
    /** The agent may move the task to Done itself, when it judges every acceptance criterion met (a clear setting, not content). */
    autoDone: boolean('auto_done').notNull().default(false),
    /** Who made the last status change; null for a task that has not changed status since it was created. */
    movedBy: taskActor('moved_by'),
    /** Order within a status and priority: lower is higher up. */
    position: doublePrecision('position').notNull(),
    closed: boolean('closed').notNull().default(false),
    /** When it was closed; its transcripts go 14 days later. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** The machine that claimed the task last. */
    machine: text('machine'),
    sessionId: text('session_id'),
    /** Where the session was when it last stopped, on `machine`. */
    workdir: text('workdir'),
    /** The sealed `workdir` the task was created with, as the same envelope; only the user's change of the task's directory (`configureTask`) updates it, and Re-run fresh restores it into `workdir`. */
    homeWorkdir: text('home_workdir'),
    /** The sealed name of the agent the task runs as; null runs as the user's config says. Written once, at creation. */
    agent: text('agent'),
    icon: text('icon'),
    labels: text('labels'),
    /** The sealed watches the task's machine runs for it (one JSON document); null for none. Cleared when the task goes to Done or Backlog, is closed or re-run fresh. */
    watches: text('watches'),
    /** Ids of watches the user asked to stop that the machine has not acknowledged; clear text, ids only. */
    watchStops: text('watch_stops')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** GitHub's state of the PR the prompt names, as a worker's dispatcher last saw it. Clear on purpose: it says only that some PR of the task merged. */
    prState: prState('pr_state'),
    next: nextRun('next').notNull().default('fresh'),
    /** Reported by the worker while the task runs; stale once it stops running. */
    lane: text('lane'),
    borrowed: boolean('borrowed').notNull().default(false),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    /** When the current run was claimed; null unless running. */
    runStartedAt: timestamp('run_started_at', { withTimezone: true }),
    /** The current run's id, new with every claim; null unless running. A call that names a run is refused for another one. */
    runId: text('run_id'),
    /** When a worker gave up the task's slot; kept through the claim until the run's first update or its end. */
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    /** Todo only: no worker claims the task before this time. Cleared when the task leaves Todo. */
    notBefore: timestamp('not_before', { withTimezone: true }),
    /** Waiting only: the wait ends at this time at the latest. Cleared when the task leaves Waiting. */
    wakeAt: timestamp('wake_at', { withTimezone: true }),
    /** Waiting only: a check on `machine` may end the wait early. */
    waitCheck: boolean('wait_check').notNull().default(false),
    /** When the task's wait ended into Todo; kept through the claim until the run's first update, like `paused_at`. */
    wokenAt: timestamp('woken_at', { withTimezone: true }),
    /** Running only: when the user asked for the run to be interrupted; the worker clears it when it acts on it, and any move out of Running does. */
    stopRequestedAt: timestamp('stop_requested_at', { withTimezone: true }),
    /** Running only: this run's worker has read the run inbox, so it hands messages over; a CLI that never does leaves them to the resume. Cleared when the task leaves Running. */
    inboxRead: boolean('inbox_read').notNull().default(false),
    /** With a stop request: the pending note that goes with it (Stop & send); null for a plain stop. */
    stopMessageId: text('stop_message_id'),
    /** The blind index (abh1.…) of the PR head sha a review task was made for. */
    head: text('head'),
    /** The question note waiting for an answer, if any. */
    openQuestionNoteId: text('open_question_note_id'),
    /** The blind index (abh1.…) of the PR URL; unique per owner. */
    dedupeKey: text('dedupe_key'),
    parentId: text('parent_id'),
    createdBy: taskCreator('created_by').notNull().default('user'),
    /**
     * The schedule this task is an occurrence of. Not a foreign key: the task's sealed fields are bound to this id, so it
     * stays when the schedule is deleted.
     */
    scheduleId: text('schedule_id'),
    /**
     * The task this one was forked from: its first run continues a copy of that task's session. Not a foreign key, like
     * `schedule_id`: the task's prompt is bound to this id, so it stays when the parent is deleted. Only the browser sets it.
     */
    forkOf: text('fork_of'),
    /** When the run of this occurrence first handed the card back as done work (Needs me or Done); the schedules that run after its schedule were triggered then, once. */
    occurrenceFinishedAt: timestamp('occurrence_finished_at', { withTimezone: true }),
    /** Proposed by an agent and not started by the user yet; starting it takes this off and makes `created_by` the user, with the prompt sealed again for that creator. */
    proposed: boolean('proposed').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    check('task_title_sealed', isEnvelope(t.title)),
    check('task_input_sealed', isEnvelope(t.input)),
    check('task_workdir_sealed', isEnvelope(t.workdir)),
    check('task_home_workdir_sealed', isEnvelope(t.homeWorkdir)),
    check('task_agent_sealed', isEnvelope(t.agent)),
    check('task_icon_sealed', isEnvelope(t.icon)),
    check('task_labels_sealed', isEnvelope(t.labels)),
    check('task_watches_sealed', isEnvelope(t.watches)),
    check('task_dedupe_key_blind', isBlindIndex(t.dedupeKey)),
    check('task_head_blind', isBlindIndex(t.head)),
    unique('task_owner_dedupe_key_unique').on(t.owner, t.dedupeKey),
    index('task_status_priority_position_idx').on(t.owner, t.status, t.priority, t.position),
    unique('task_owner_id_unique').on(t.owner, t.id),
    ownerFk('task_parent_fk', [t.owner, t.parentId], [t.owner, t.id], 'set null'),
    tenant(),
  ],
).enableRLS();

/** A rule that keeps exactly one pending occurrence, a Todo task with a start time; see services/schedules.ts. */
export const schedules = pgTable(
  'schedule',
  {
    id: text('id').primaryKey(),
    owner: owner(),
    title: text('title').notNull(),
    input: text('input').notNull(),
    priority: taskPriority('priority').notNull().default('normal'),
    /** The model of every occurrence; null is claude's default. */
    model: text('model'),
    /** The effort of every occurrence; null is claude's default. */
    effort: text('effort'),
    /** The lane every occurrence asks for; null is the machine's default lane. */
    requestedLane: text('requested_lane'),
    /** Whether every occurrence lets the agent move it to Done itself. */
    autoDone: boolean('auto_done').notNull().default(false),
    machine: text('machine'),
    workdir: text('workdir'),
    /** The sealed name of the agent every occurrence runs as; null for none. */
    agent: text('agent'),
    icon: text('icon'),
    labels: text('labels'),
    /** An interval on the grid `anchor_at + k * every_ms`, or a 5-field cron expression in `timezone`. */
    everyMs: bigint('every_ms', { mode: 'number' }),
    cron: text('cron'),
    /** The expressions after the first, read in the same time zone; empty with one expression. */
    moreCrons: text('more_crons')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    timezone: text('timezone'),
    /** Runs after the schedule `after_schedule_id`: an occurrence is made when one of its cards finishes, `after_delay_ms` later. Instead of `every_ms` and `cron`. */
    afterScheduleId: text('after_schedule_id'),
    afterDelayMs: bigint('after_delay_ms', { mode: 'number' }),
    /** At most this many cards of the schedule under way (running or waiting) at once; null: no limit. Enforced when a worker claims a card. */
    maxConcurrent: integer('max_concurrent'),
    anchorAt: timestamp('anchor_at', { withTimezone: true }).notNull(),
    /** The start time of the newest occurrence; the next one lies after it. */
    lastOccurrenceAt: timestamp('last_occurrence_at', { withTimezone: true }),
    /** Occurrences still to create; null: forever. */
    remaining: integer('remaining'),
    until: timestamp('until', { withTimezone: true }),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** The pending occurrence. */
    occurrenceTaskId: text('occurrence_task_id'),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    check('schedule_title_sealed', isEnvelope(t.title)),
    check('schedule_input_sealed', isEnvelope(t.input)),
    check('schedule_workdir_sealed', isEnvelope(t.workdir)),
    check('schedule_agent_sealed', isEnvelope(t.agent)),
    check('schedule_icon_sealed', isEnvelope(t.icon)),
    check('schedule_labels_sealed', isEnvelope(t.labels)),
    check(
      'schedule_one_rule',
      sql`(${t.everyMs} is not null)::int + (${t.cron} is not null)::int + (${t.afterScheduleId} is not null)::int = 1`,
    ),
    check('schedule_after_delay', sql`(${t.afterScheduleId} is null) = (${t.afterDelayMs} is null)`),
    unique('schedule_owner_id_unique').on(t.owner, t.id),
    ownerFk('schedule_occurrence_task_fk', [t.owner, t.occurrenceTaskId], [tasks.owner, tasks.id], 'set null'),
    ownerFk('schedule_after_fk', [t.owner, t.afterScheduleId], [t.owner, t.id], 'restrict'),
    tenant(),
  ],
).enableRLS();

export const notes = pgTable(
  'note',
  {
    id: text('id').primaryKey(),
    owner: owner(),
    taskId: text('task_id').notNull(),
    author: noteAuthor('author').notNull(),
    kind: noteKind('kind').notNull(),
    /** Sealed, except on a note by author "server", whose body is plain text. */
    body: text('body').notNull(),
    /** A sealed start of the text, for the board cards; null for a note without text. */
    preview: text('preview'),
    /** A sealed reply the agent drafted for the user; only on a comment by the agent. */
    suggestion: text('suggestion'),
    /** Sealed JSON. */
    questions: text('questions'),
    answers: text('answers'),
    questionNoteId: text('question_note_id'),
    /** The signed-in user for author "user", the machine for agent and system notes. */
    by: text('by'),
    /** A message the user sent to a running agent that no worker has handed over yet; cleared when the worker acknowledges it or the run ends. */
    pending: boolean('pending').notNull().default(false),
    /** Written to a running agent (Send, Stop & send); never cleared, so a resume can find messages that were never handed over. */
    queued: boolean('queued').notNull().default(false),
    /** When a worker handed the message to the running agent. The resume prompt does not repeat it. */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: writtenAt(),
  },
  (t) => [
    check('note_body_sealed', sql`(${t.author}::text = 'server' and ${t.kind} = 'event') or ${isEnvelope(t.body)}`),
    check('note_preview_sealed', isEnvelope(t.preview)),
    check('note_suggestion_sealed', isEnvelope(t.suggestion)),
    check(
      'note_suggestion_agent_comment',
      sql`${t.suggestion} is null or (${t.author}::text = 'agent' and ${t.kind} = 'comment')`,
    ),
    check('note_questions_sealed', isEnvelope(t.questions)),
    check('note_answers_sealed', isEnvelope(t.answers)),
    index('note_task_created_idx').on(t.taskId, t.createdAt),
    ownerFk('note_task_fk', [t.owner, t.taskId], [tasks.owner, tasks.id], 'cascade'),
    tenant(),
  ],
).enableRLS();

/** A pull request the task's agent reported with `board pr`; a task holds several. The state is GitHub's, as a worker's dispatcher last saw it. */
export const taskPrs = pgTable(
  'task_pr',
  {
    id: text('id').primaryKey(),
    owner: owner(),
    taskId: text('task_id').notNull(),
    /** The sealed URL. */
    pr: text('pr').notNull(),
    state: prState('state'),
    createdAt: writtenAt(),
  },
  (t) => [
    check('task_pr_pr_sealed', isEnvelope(t.pr)),
    index('task_pr_task_created_idx').on(t.taskId, t.createdAt),
    ownerFk('task_pr_task_fk', [t.owner, t.taskId], [tasks.owner, tasks.id], 'cascade'),
    tenant(),
  ],
).enableRLS();

export const machines = pgTable(
  'machine',
  {
    owner: owner(),
    name: text('name').notNull(),
    /** sha256 of the token, hex. */
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /** The CLI version and API level of the machine's last request, from its request headers; null before it sent them. */
    clientVersion: text('client_version'),
    clientApi: integer('client_api'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** The sealed directory list the machine's CLI sent (`machine.dirs`), advice for the New task form; null until it sends one. */
    dirs: text('dirs'),
    /** The blind index of that list, which the machine compares with its own to know whether to send again. */
    dirsIndex: text('dirs_index'),
    dirsUpdatedAt: timestamp('dirs_updated_at', { withTimezone: true }),
    /** The sealed catalogue of skills and models the machine's CLI sent (`machine.catalog`), advice for completion in the browser; null until it sends one. */
    catalog: text('catalog'),
    /** The blind index of that catalogue, which the machine compares with its own to know whether to send again. */
    catalogIndex: text('catalog_index'),
    catalogUpdatedAt: timestamp('catalog_updated_at', { withTimezone: true }),
    /** The sealed usage status the machine's CLI sent (`machine.usage`): limits, readings and held tasks, display only; null until it sends one. */
    usage: text('usage'),
    /** The blind index of that status, which the machine compares with its own to know whether to send again. */
    usageIndex: text('usage_index'),
    usageUpdatedAt: timestamp('usage_updated_at', { withTimezone: true }),
    /** The sealed feeds the machine's CLI runs (`machine.feeds`): names, timers and last runs, display only; null until it sends them. */
    feeds: text('feeds'),
    /** The blind index of those feeds, which the machine compares with its own to know whether to send again. */
    feedsIndex: text('feeds_index'),
    feedsUpdatedAt: timestamp('feeds_updated_at', { withTimezone: true }),
    /** Requests of the user the machine has not acknowledged, each `<action>:<feed id>`; clear text, ids only. */
    feedRequests: text('feed_requests')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.name] }),
    check('machine_dirs_sealed', isEnvelope(t.dirs)),
    check('machine_dirs_index_blind', isBlindIndex(t.dirsIndex)),
    check('machine_catalog_sealed', isEnvelope(t.catalog)),
    check('machine_catalog_index_blind', isBlindIndex(t.catalogIndex)),
    check('machine_usage_sealed', isEnvelope(t.usage)),
    check('machine_usage_index_blind', isBlindIndex(t.usageIndex)),
    check('machine_feeds_sealed', isEnvelope(t.feeds)),
    check('machine_feeds_index_blind', isBlindIndex(t.feedsIndex)),
    tenant(),
  ],
).enableRLS();

/** A signed-in browser. The session token goes to the browser as a cookie; only its sha256 (hex) is stored. */
export const sessions = pgTable(
  'session',
  {
    tokenHash: text('token_hash').primaryKey(),
    owner: owner(),
    method: sessionMethod('method').notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('session_owner_idx').on(t.owner), index('session_expires_idx').on(t.expiresAt), tenant()],
).enableRLS();

/** A WebAuthn credential of a user. The name is a device label the user chose, clear text like a machine name. */
export const passkeys = pgTable(
  'passkey',
  {
    credentialId: text('credential_id').primaryKey(),
    owner: owner(),
    /** The COSE public key, base64url. */
    publicKey: text('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: jsonb('transports').$type<string[]>().notNull().default([]),
    name: text('name').notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    check('passkey_name_length', sql`char_length(${t.name}) between 1 and 60`),
    index('passkey_owner_idx').on(t.owner),
    tenant(),
  ],
).enableRLS();

/**
 * The agent definitions the user pushed for every machine (`board agents push`): one sealed document of all of them per user,
 * bound to its version (`agents.shared`, context `agents:v<version>`). The version is clear so that a machine's tick can tell
 * from the `version` answer whether it has to fetch the document; it only goes up, one per push.
 */
export const sharedAgents = pgTable(
  'shared_agents',
  {
    owner: owner().primaryKey(),
    version: integer('version').notNull(),
    document: text('document').notNull(),
    pushedAt: timestamp('pushed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('shared_agents_document_sealed', isEnvelope(t.document)),
    check('shared_agents_version_positive', sql`${t.version} >= 1`),
    tenant(),
  ],
).enableRLS();

/**
 * The link rules the user set in the browser: one sealed document of all of them per user, bound to its version (`links`,
 * context `links:v<version>`). The version is clear so that a save is compare-and-set; it only goes up, one per save.
 */
export const linkRules = pgTable(
  'link_rules',
  {
    owner: owner().primaryKey(),
    version: integer('version').notNull(),
    document: text('document').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('link_rules_document_sealed', isEnvelope(t.document)),
    check('link_rules_version_positive', sql`${t.version} >= 1`),
    tenant(),
  ],
).enableRLS();

/**
 * The title rules the user set in the browser: one sealed document of all of them per user, bound to its version (`titles`,
 * context `titles:v<version>`), read by the browser and by every machine's CLI. The version is clear so that a save is
 * compare-and-set; it only goes up, one per save.
 */
export const titleRules = pgTable(
  'title_rules',
  {
    owner: owner().primaryKey(),
    version: integer('version').notNull(),
    document: text('document').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('title_rules_document_sealed', isEnvelope(t.document)),
    check('title_rules_version_positive', sql`${t.version} >= 1`),
    tenant(),
  ],
).enableRLS();

export const authFlowKind = pgEnum('auth_flow_kind', [
  'oidc',
  'saml',
  'passkey-login',
  'passkey-register',
  'passkey-signup',
]);

/**
 * State of a sign-in that is under way, which has no user yet and so no tenant policy: the board_app role reads it
 * directly. A flow is single use and lives ten minutes.
 */
export const authFlows = pgTable(
  'auth_flow',
  {
    id: text('id').primaryKey(),
    kind: authFlowKind('kind').notNull(),
    /** For the redirect flows: base64url(sha256(verifier)) of the browser that started it. */
    challenge: text('challenge'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    /** The signed-in user a passkey-register flow belongs to. */
    owner: text('owner').references(() => appUsers.username, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('auth_flow_expires_idx').on(t.expiresAt)],
);

export type TaskRow = typeof tasks.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
export type TaskPrRow = typeof taskPrs.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;

/** One worker run of a task: a fresh start, a resume or a re-run. */
export const transcriptRuns = pgTable(
  'transcript_run',
  {
    id: text('id').primaryKey(),
    owner: owner(),
    taskId: text('task_id').notNull(),
    machine: text('machine').notNull(),
    sessionId: text('session_id'),
    resumed: boolean('resumed').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull(),
    eventCount: integer('event_count').notNull().default(0),
  },
  (t) => [
    index('transcript_run_task_idx').on(t.taskId, t.startedAt),
    unique('transcript_run_owner_id_unique').on(t.owner, t.id),
    ownerFk('transcript_run_task_fk', [t.owner, t.taskId], [tasks.owner, tasks.id], 'cascade'),
    tenant(),
  ],
).enableRLS();

/** A condensed stream-json event. A tool result's output lives in its own column and is loaded only on demand. */
export const transcriptEvents = pgTable(
  'transcript_event',
  {
    owner: owner(),
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    kind: text('kind').notNull(),
    parent: text('parent'),
    /** Sealed JSON of the event without `output`. */
    data: text('data').notNull(),
    output: text('output'),
    outputSize: integer('output_size'),
  },
  (t) => [
    check('transcript_event_data_sealed', isEnvelope(t.data)),
    check('transcript_event_output_sealed', isEnvelope(t.output)),
    // With the owner, so a colliding (run, seq) of another user is not visible as a duplicate-key error.
    primaryKey({ columns: [t.owner, t.runId, t.seq] }),
    ownerFk('transcript_event_run_fk', [t.owner, t.runId], [transcriptRuns.owner, transcriptRuns.id], 'cascade'),
    tenant(),
  ],
).enableRLS();
