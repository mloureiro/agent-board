// What the board server sends in the clear is checked here, with the same validators the CLI's wire parsers use, before the
// browser shows it: a value that is not of the shape the contract allows for its field is replaced by a neutral one and named
// in `invalid`, never shown. Ids that routes and bindings are built from cannot be replaced, so a bad one refuses the reply.
import {
  ContractError,
  INVALID_VALUE,
  isBlindIndex,
  isCronExpression,
  isEffort,
  isKeyId,
  isModelName,
  isNextRun,
  isNoteKind,
  isPriority,
  isSafeLane,
  isSafeMachineName,
  isSafeNoteId,
  isSafeTaskId,
  isSessionId,
  isStatus,
  isTaskCreator,
  isTimeZoneName,
  isWireNoteAuthor,
  hasControlCharacter,
  type Effort,
  type NextRun,
  type NoteKind,
  type Priority,
  type Status,
  type TaskCreator,
  type WireNoteAuthor,
} from '../index.mts';

/** The author of a note whose author the board did not name properly. */
export const UNKNOWN_AUTHOR = 'unknown';
export type ShownAuthor = WireNoteAuthor | typeof UNKNOWN_AUTHOR;

/** Neutral stand-ins for the closed sets: the least a value of that kind can mean. */
const NEUTRAL_STATUS: Status = 'needs-me';
const NEUTRAL_PRIORITY: Priority = 'normal';
const NEUTRAL_NEXT: NextRun = 'fresh';
// A task of a creator the board did not name properly must never look like one the user made.
const NEUTRAL_CREATOR: TaskCreator = 'agent';

interface Checked<T> {
  value: T;
  invalid: boolean;
}

/** `value` when it passes `is`, else the neutral stand-in. */
function guarded<T>(value: unknown, is: (candidate: unknown) => candidate is T, neutral: T): Checked<T> {
  return is(value) ? { value, invalid: false } : { value: neutral, invalid: true };
}

const checked = <T,>(ok: boolean, value: T, neutral: T): Checked<T> => ({ value: ok ? value : neutral, invalid: !ok });

export function safeId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !isSafeTaskId(value)) throw new ContractError(`The board sent an invalid ${what}.`);
  return value;
}

export function safeNullableId(value: unknown, what: string): string | null {
  return value === null || value === undefined ? null : safeId(value, what);
}

/** A machine or lane name, or a placeholder. */
export function shownName(value: string | null): string | null {
  return value === null || isSafeMachineName(value) ? value : INVALID_VALUE;
}

export interface TaskShapes {
  status: Status;
  priority: Priority;
  next: NextRun;
  createdBy: TaskCreator;
  model: string | null;
  effort: Effort | null;
  machine: string | null;
  lane: string | null;
  /** The lane the user asked for; the lane it runs in is `lane`. */
  requestedLane: string | null;
  sessionId: string | null;
  head: string | null;
  scheduleId: string | null;
  parentId: string | null;
  /** The task this one was forked from; absent for any other task. */
  forkOf?: string;
  // The fields that did not have the shape the board promises, for the page to say so.
  invalid: string[];
}

/** The clear, server-controlled fields of a task, each checked for its shape. */
export function checkTaskShapes(wire: {
  id: string;
  status: unknown;
  priority: unknown;
  next: unknown;
  createdBy: unknown;
  model: string | null;
  effort: unknown;
  machine: string | null;
  lane: string | null;
  requestedLane: string | null;
  sessionId: string | null;
  head: string | null;
  scheduleId: string | null;
  parentId?: string | null;
  forkOf?: string | null;
}): TaskShapes {
  safeId(wire.id, 'task id');
  const status = guarded(wire.status, isStatus, NEUTRAL_STATUS);
  const priority = guarded(wire.priority, isPriority, NEUTRAL_PRIORITY);
  const next = guarded(wire.next, isNextRun, NEUTRAL_NEXT);
  const createdBy = guarded(wire.createdBy, isTaskCreator, NEUTRAL_CREATOR);
  const model = checked(wire.model === null || isModelName(wire.model), wire.model, null);
  const effort = guarded<Effort | null>(
    wire.effort,
    (value): value is Effort | null => value === null || isEffort(value),
    null,
  );
  const machine = checked(wire.machine === null || isSafeMachineName(wire.machine), wire.machine, INVALID_VALUE);
  const lane = checked(wire.lane === null || isSafeLane(wire.lane), wire.lane, INVALID_VALUE);
  const requestedLane = checked(
    wire.requestedLane === null || isSafeLane(wire.requestedLane),
    wire.requestedLane,
    INVALID_VALUE,
  );
  const sessionId = checked(wire.sessionId === null || isSessionId(wire.sessionId), wire.sessionId, null);
  const head = checked(wire.head === null || isBlindIndex(wire.head), wire.head, null);
  const fields: [string, Checked<unknown>][] = [
    ['status', status],
    ['priority', priority],
    ['next', next],
    ['createdBy', createdBy],
    ['model', model],
    ['effort', effort],
    ['machine', machine],
    ['lane', lane],
    ['requestedLane', requestedLane],
    ['sessionId', sessionId],
    ['head', head],
  ];
  return {
    status: status.value,
    priority: priority.value,
    next: next.value,
    createdBy: createdBy.value,
    model: model.value,
    effort: effort.value,
    machine: machine.value,
    lane: lane.value,
    requestedLane: requestedLane.value,
    sessionId: sessionId.value,
    head: head.value,
    scheduleId: safeNullableId(wire.scheduleId, 'schedule id'),
    parentId: safeNullableId(wire.parentId, 'parent id'),
    ...(wire.forkOf == null ? {} : { forkOf: safeId(wire.forkOf, 'fork id') }),
    invalid: fields.filter(([, { invalid }]) => invalid).map(([name]) => name),
  };
}

/** What a note shows of the author, kind and who wrote it, each checked; `ok` is false when any of them is not of its shape. */
export function checkNoteShapes(wire: { id: string; author: unknown; kind: unknown; by: string | null }): {
  id: string;
  author: ShownAuthor;
  kind: NoteKind;
  by: string | null;
  ok: boolean;
} {
  const author = isWireNoteAuthor(wire.author) ? wire.author : undefined;
  const kind = isNoteKind(wire.kind) ? wire.kind : undefined;
  const id = typeof wire.id === 'string' && isSafeNoteId(wire.id) ? wire.id : undefined;
  return {
    id: id ?? INVALID_VALUE,
    author: author ?? UNKNOWN_AUTHOR,
    kind: kind ?? 'comment',
    by: shownName(wire.by),
    ok: author !== undefined && kind !== undefined && id !== undefined,
  };
}

/** The rule of a schedule, as far as it is of its shape. */
export function shownRule(wire: { cron: string | null; timezone: string | null }): {
  cron: string | null;
  timezone: string | null;
} {
  return {
    cron: wire.cron === null || isCronExpression(wire.cron) ? wire.cron : INVALID_VALUE,
    timezone: wire.timezone === null || isTimeZoneName(wire.timezone) ? wire.timezone : INVALID_VALUE,
  };
}

/** A count as the CLI's wire parser reads one: a whole number, zero or more. */
export const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const SHOWN_USER_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

/**
 * The user name the board reports, for a sentence built to resist a board that cannot be trusted: shown only when it looks
 * like a login name, never as free text.
 */
export const shownUserName = (value: string): string | undefined => (SHOWN_USER_NAME.test(value) ? value : undefined);

/** The name the board reports for the signed-in user: one line, as the CLI requires of it. */
export function isUserName(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 256 && !hasControlCharacter(value);
}

export function parseMe(value: { username: unknown; keyId: unknown }): { username: string; keyId: string | null } {
  if (!isUserName(value.username)) throw new ContractError('The board sent a user name this browser does not accept.');
  if (value.keyId !== null && !isKeyId(value.keyId))
    throw new ContractError('The board sent a key id that is not one.');
  return { username: value.username, keyId: value.keyId };
}
