// Named features, so an additive change never needs a version number: the server answers the capabilities it has, the
// client sends the vocabulary it understands, and each side checks for the one name it needs. See docs/machine-api.md#features.
import { ContractError } from './contract.mts';
import type { NextRun, NoteAuthor, NoteKind, Priority, Status, TaskCreator } from './contract.mts';
import { isRecord } from './guards.mts';

// What a server has: the capabilities the CLI conditionally relies on. The baseline is what every server at API 9
// (main at defd8fe) has, and what a server that answers no `features` key is taken to have.
export const BASELINE_SERVER_FEATURES = ['attach-session', 'events', 'note.polish', 'note.suggestion', 'wait'] as const;

// An additive change to the machine API appends its name here, in the same commit that makes the server do it.
export const ADDED_SERVER_FEATURES = [
  'task.model',
  'task.pr',
  'task.pr-state',
  'task.prs',
  'task.pr-remove',
  'run-inbox',
  'machine.dirs',
  'machine.catalog',
  'machine.usage',
  'task.agent',
  'task.run',
  'task.configure',
  'task.watches',
  'task.note-count',
  'task.fork',
  'task.held',
  'schedule.crons',
  'schedule.max-concurrent',
  'schedule.after',
  'task.auto-done',
  'task.moved-by',
  'prompt.edit',
  'task.lane',
  'schedule.update',
  'agents.shared',
  'task.effort',
  'task.icon',
  'task.labels',
  'machine.sources',
  'transcript.context',
] as const;

export const SERVER_FEATURES = [...BASELINE_SERVER_FEATURES, ...ADDED_SERVER_FEATURES] as const;
export type ServerFeature = (typeof SERVER_FEATURES)[number];

// How a client says what is missing: "the board server does not support <label> yet".
export const SERVER_FEATURE_LABELS: Record<ServerFeature, string> = {
  'attach-session': 'attaching to a task session',
  events: 'the event stream',
  'note.polish': 'polish notes',
  'note.suggestion': 'suggested replies',
  'task.model': 'choosing a model',
  'task.pr': 'reporting a pull request',
  'task.pr-state': 'the state of a task’s pull request',
  'task.prs': 'several pull requests on one task',
  'task.pr-remove': 'removing a reported pull request',
  'run-inbox': 'messages and stop requests for a running task',
  'machine.dirs': 'directory lists',
  'machine.catalog': 'machine catalogues',
  'machine.usage': 'usage status of machines',
  'task.agent': 'running a task as an agent',
  'task.run': 'telling runs of a task apart',
  'task.configure': 'changing a task’s settings',
  'task.watches': 'showing a task’s watches',
  'task.note-count': 'the number of notes of a task',
  'task.fork': 'forking a task',
  'task.held': 'showing that a task waits for a free slot of its schedule',
  'schedule.crons': 'several cron expressions in one schedule',
  'schedule.max-concurrent': 'a limit on how many cards of a schedule run at once',
  'schedule.after': 'a schedule that runs after another',
  'task.auto-done': 'letting the agent move a task to Done',
  'task.moved-by': 'who moved a task',
  'prompt.edit': 'editing a prompt',
  'task.lane': 'choosing the lane a task runs in',
  'schedule.update': 'changing every setting of a schedule',
  'agents.shared': 'agent definitions held on the board',
  'task.effort': 'choosing an effort level',
  'task.icon': 'task icons',
  'task.labels': 'task labels',
  'machine.sources': 'sources on the board',
  'transcript.context': 'context usage in transcripts',
  wait: 'waiting',
};

const MAX_FEATURE_NAME = 64;
const MAX_SERVER_FEATURES = 256;

export function isFeatureName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(value) && value.length <= MAX_FEATURE_NAME;
}

/** The features of a `version` answer: its `features` list, or the baseline for a server that has none. */
export function parseVersionFeatures(value: unknown): ReadonlySet<string> {
  const features = isRecord(value) ? value['features'] : undefined;
  if (features === undefined) return new Set(BASELINE_SERVER_FEATURES);
  if (!Array.isArray(features) || features.length > MAX_SERVER_FEATURES || !features.every(isFeatureName))
    throw new ContractError('version.features must be a list of feature names');
  return new Set(features);
}

// The enum fields of the wire whose values a client may not know yet.
export interface Vocabulary {
  status: Status;
  priority: Priority;
  next: NextRun;
  createdBy: TaskCreator;
  author: NoteAuthor | 'server';
  kind: NoteKind;
}

// Enum value -> the client feature that understands it. Only values added after the baseline appear here: every client
// from 0.7.0 on knows today's. Adding a value to an enum means adding its row, and the server then withholds the value
// from a client that did not send the feature. The first row waits until every machine runs CLI 0.8.0 or newer (0.7.0
// cannot handle the 422 for a task it cannot read), or it comes with a raised MIN_CLIENT. A row for a note author or kind
// must also make the server's `noteCount` (`countTaskNotes`) leave out the notes `read-notes` leaves out.
export type VocabularyFeatures = { [Field in keyof Vocabulary]?: Partial<Record<Vocabulary[Field], string>> };
export const VOCABULARY_FEATURES: VocabularyFeatures = {};

/** Every client feature this build understands: what the CLI sends in `X-Board-Features`. */
export function clientVocabulary(table: VocabularyFeatures = VOCABULARY_FEATURES): string[] {
  return [...new Set(Object.values(table).flatMap((values) => Object.values(values)))].sort();
}

// What a client can read beyond enum values: a capability of this build whose absence the server must hide from. The CLI sends
// these with the vocabulary features. `schedule.after`: a schedule with an `after` rule, which a CLI before it cannot parse.
export const CLIENT_CAPABILITIES = ['schedule.after'] as const;

/** Every feature this build announces in `X-Board-Features`: the capabilities and the vocabulary. */
export function announcedClientFeatures(
  table: VocabularyFeatures = VOCABULARY_FEATURES,
  capabilities: readonly string[] = CLIENT_CAPABILITIES,
): string[] {
  return [...new Set([...capabilities, ...clientVocabulary(table)])].sort();
}

export const CLIENT_FEATURES_HEADER = 'x-board-features';

const MAX_HEADER_CHARS = 1024;
const MAX_HEADER_FEATURES = 64;

/** The client features a request header names. Lenient: it is capped, junk is ignored, and it never fails the request. */
export function parseClientFeatures(header: string | string[] | undefined): ReadonlySet<string> {
  const text = Array.isArray(header) ? header.join(',') : (header ?? '');
  return new Set(
    text
      .slice(0, MAX_HEADER_CHARS)
      .split(',')
      .map((name) => name.trim())
      .filter(isFeatureName)
      .slice(0, MAX_HEADER_FEATURES),
  );
}

export interface UnknownVocabulary {
  field: keyof Vocabulary;
  value: string;
  feature: string;
}

export type VocabularyItem = Partial<Record<keyof Vocabulary, unknown>>;

/** The first enum value of `item` that needs a client feature `known` lacks. */
export function findUnknownVocabulary(
  item: VocabularyItem,
  known: ReadonlySet<string>,
  table: VocabularyFeatures = VOCABULARY_FEATURES,
): UnknownVocabulary | undefined {
  for (const [field, features] of Object.entries(table) as [keyof Vocabulary, Record<string, string | undefined>][]) {
    const value = item[field];
    const feature = typeof value === 'string' && Object.hasOwn(features, value) ? features[value] : undefined;
    if (typeof value === 'string' && feature !== undefined && !known.has(feature)) return { field, value, feature };
  }
  return undefined;
}

// Enum values the CLI can send (`board move`, `--priority`) that only a server with a feature accepts. Same rule as the
// vocabulary, the other way round: the CLI sends such a value only when the server's `features` names the feature.
export type SendableFeatures = {
  status?: Partial<Record<Status, ServerFeature>>;
  priority?: Partial<Record<Priority, ServerFeature>>;
};
export const SENDABLE_SERVER_FEATURES: SendableFeatures = {};

/** The server feature that `values` needs, if any. */
export function neededServerFeature(
  values: { status?: Status | undefined; priority?: Priority | undefined },
  table: SendableFeatures = SENDABLE_SERVER_FEATURES,
): ServerFeature | undefined {
  const { status, priority } = values;
  return (
    (status === undefined ? undefined : table.status?.[status]) ??
    (priority === undefined ? undefined : table.priority?.[priority])
  );
}
