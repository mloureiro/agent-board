// The file "export my board" writes and "import" reads, and how an import into another account re-seals it. The file holds
// the database rows as they are, ciphertext included, so an import into the same username puts them back unchanged. Every
// sealed value is bound to its owner (the username) through the additional data of its envelope, so into another username the
// browser opens each envelope under the old owner and seals the same plaintext again under the new one, with the same field
// and context. Nothing is sealed under a different binding, and a value that does not open stays as it is, unreadable.
//
// NDJSON, UTF-8: the first line is the header, every other line one row, in the order of `EXPORT_TABLES`.
//
//   {"format":"agent-board-export","version":1,"exportedAt":…,"owner":…,"keyId":…,"keySlots":[…],"transcripts":true,"prefs":{…}}
//   {"table":"task","row":{…}}
//
// A row is the database row by its property names (camelCase, as in the server's schema) without `owner`, timestamps as ISO
// strings. This module reads only the clear columns a binding needs; the server checks the rest when it takes the row.
import {
  ContractError,
  hasControlCharacter,
  isAgentName,
  isNoteKind,
  isSafeMachineName,
  isSafeTaskId,
  isTaskCreator,
  isSharedAgentsVersion,
  isTitleRulesVersion,
  isWireNoteAuthor,
  rejectUnknownKeys,
} from './contract.mts';
import { isRecord } from './guards.mts';
import { parseKeyId, parseKeySlots } from './keys.mts';
import type { KeySlot } from './keys.mts';
import {
  agentBinding,
  iconBinding,
  labelsBinding,
  inputBinding,
  machineCatalogBinding,
  machineDirsBinding,
  machineUsageBinding,
  machineFeedsBinding,
  noteBinding,
  prBinding,
  titleBinding,
  transcriptBinding,
  watchesBinding,
  workdirOpenBindings,
} from './sealing.mts';
import type { Binding, Opener, RowRef, Sealer } from './sealing.mts';
import { isLinkRulesVersion, linkRulesBinding } from './linkRules.mts';
import { titleRulesBinding } from './titleRules.mts';
import { sharedAgentsBinding } from './sharedAgents.mts';

export const EXPORT_FORMAT = 'agent-board-export';
export const EXPORT_VERSION = 1;

/** The tables of a file, in the order their rows appear and must be imported: a row never comes before the row it belongs to. */
export const EXPORT_TABLES = [
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
export type ExportTable = (typeof EXPORT_TABLES)[number];

export const MAX_EXPORT_PREFS = 50;
export const MAX_EXPORT_PREF_KEY_CHARS = 128;
export const MAX_EXPORT_PREF_VALUE_CHARS = 4096;
const MAX_OWNER_CHARS = 256;
const MAX_TIME_CHARS = 64;

export interface ExportHeader {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  /** ISO time. */
  exportedAt: string;
  /** The username the envelopes of the file are bound to. */
  owner: string;
  /** The key the envelopes are sealed with, and the slots that wrap it, so an import can ask for the old passphrase. */
  keyId: string;
  keySlots: KeySlot[];
  /** Whether the transcript tables are in the file. */
  transcripts: boolean;
  /** Browser preferences, which live outside the database. */
  prefs: Record<string, string>;
}

export const exportHeaderLine = (header: ExportHeader): string => JSON.stringify(header);

export const exportRowLine = (table: ExportTable, row: Record<string, unknown>): string =>
  JSON.stringify({ table, row });

function parseJsonLine(line: string, what: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new ContractError(`${what} is not valid JSON.`);
  }
}

function parsePrefs(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ContractError('The preferences in this export are not a list of settings.');
  const entries = Object.entries(value);
  if (entries.length > MAX_EXPORT_PREFS)
    throw new ContractError(`This export holds more than ${MAX_EXPORT_PREFS} preferences.`);
  const prefs: Record<string, string> = {};
  for (const [key, text] of entries) {
    if (typeof text !== 'string' || key.length > MAX_EXPORT_PREF_KEY_CHARS || text.length > MAX_EXPORT_PREF_VALUE_CHARS)
      throw new ContractError(`The preference "${key.slice(0, 40)}" in this export is not a short text.`);
    prefs[key] = text;
  }
  return prefs;
}

/** The header line of an export; throws a `ContractError` whose message says what is wrong with the file. */
export function parseExportHeader(line: string): ExportHeader {
  const obj = parseJsonLine(line, 'The first line of this file');
  if (!isRecord(obj) || obj['format'] !== EXPORT_FORMAT) throw new ContractError('This is not a board export.');
  const version = obj['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    throw new ContractError('This is not a board export.');
  if (version > EXPORT_VERSION)
    throw new ContractError(`This export was made by a newer version of the board (format version ${version}).`);
  rejectUnknownKeys(
    obj,
    ['format', 'version', 'exportedAt', 'owner', 'keyId', 'keySlots', 'transcripts', 'prefs'],
    'The export header',
  );
  const { exportedAt, owner, transcripts } = obj;
  if (typeof exportedAt !== 'string' || exportedAt.length > MAX_TIME_CHARS || Number.isNaN(Date.parse(exportedAt)))
    throw new ContractError('The export header has no valid time of export.');
  if (typeof owner !== 'string' || owner === '' || owner.length > MAX_OWNER_CHARS || hasControlCharacter(owner))
    throw new ContractError('The export header has no valid username.');
  if (typeof transcripts !== 'boolean')
    throw new ContractError('The export header does not say whether it has transcripts.');
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt,
    owner,
    keyId: parseKeyId(obj['keyId']),
    keySlots: parseKeySlots(obj['keySlots']),
    transcripts,
    prefs: parsePrefs(obj['prefs']),
  };
}

const isExportTable = (value: unknown): value is ExportTable => EXPORT_TABLES.some((table) => table === value);

/** One row line of an export; throws a `ContractError` for a table the board does not have or a row that is not an object. */
export function parseExportRowLine(line: string): { table: ExportTable; row: Record<string, unknown> } {
  const obj = parseJsonLine(line, 'A line of this export');
  if (!isRecord(obj)) throw new ContractError('A line of this export is not a row.');
  rejectUnknownKeys(obj, ['table', 'row'], 'A row of this export');
  const { table, row } = obj;
  if (!isExportTable(table))
    throw new ContractError('This export holds a table this version of the board does not know.');
  if (!isRecord(row)) throw new ContractError(`A ${table} row of this export is not an object.`);
  return { table, row };
}

export interface ResealContext {
  /** Opens under the OLD owner. */
  open: Opener;
  /** Seals under the NEW owner. */
  seal: Sealer;
  /** The task a transcript run belongs to, from the transcript_run rows seen earlier in the file. */
  taskOfRun: (runId: string) => string | undefined;
}

export interface ResealedRow {
  row: Record<string, unknown>;
  /** The sealed columns that did not open; they are left as they were. */
  unreadable: string[];
}

/**
 * The bindings each sealed column of a row may open under; a column with none (or without an entry) cannot be opened. More
 * than one is for a directory only, which re-seals under the binding it opened with.
 */
type Plan = Record<string, Binding[]>;

/** The sealed (envelope) columns of each table, which a re-seal opens; the server's `SEALED_COLUMNS` must list the same ones. */
export const SEALED_ROW_COLUMNS: Record<ExportTable, readonly string[]> = {
  task: ['title', 'input', 'workdir', 'homeWorkdir', 'agent', 'icon', 'labels', 'watches'],
  schedule: ['title', 'input', 'workdir', 'agent', 'icon', 'labels'],
  note: ['body', 'preview', 'suggestion', 'questions', 'answers'],
  task_pr: ['pr'],
  machine: ['dirs', 'catalog', 'usage', 'feeds'],
  shared_agents: ['document'],
  link_rules: ['document'],
  title_rules: ['document'],
  transcript_run: [],
  transcript_event: ['data', 'output'],
};

/** A binding of a row whose clear columns have the wrong shape cannot be made; that leaves the column unreadable. */
function bindingsOf(make: () => Binding[]): Binding[] {
  try {
    return make();
  } catch (error) {
    if (error instanceof ContractError) return [];
    throw error;
  }
}

const textOrNull = (value: unknown): string | null | undefined =>
  value === null || value === undefined ? null : typeof value === 'string' ? value : undefined;

function taskRef(row: Record<string, unknown>): Extract<RowRef, { kind: 'task' }> | undefined {
  const { id, createdBy } = row;
  const scheduleId = textOrNull(row['scheduleId']);
  const forkOf = textOrNull(row['forkOf']);
  if (typeof id !== 'string' || !isSafeTaskId(id) || !isTaskCreator(createdBy)) return undefined;
  if (scheduleId === undefined || forkOf === undefined) return undefined;
  if (scheduleId !== null && !isSafeTaskId(scheduleId)) return undefined;
  return { kind: 'task', id, createdBy, scheduleId, forkOf };
}

/** Title, input, directories, agent, icon and labels: the columns tasks and schedules share, bound to the row's origin. */
async function contentPlan(ctx: ResealContext, row: Record<string, unknown>, ref: RowRef | undefined): Promise<Plan> {
  if (ref === undefined) return {};
  const agentWire = textOrNull(row['agent']);
  if (agentWire === undefined) return {};
  const plan: Plan = {
    title: bindingsOf(() => [titleBinding(ref)]),
    icon: [iconBinding(ref)],
    labels: [labelsBinding(ref)],
    workdir: bindingsOf(() => workdirOpenBindings(ref)),
    homeWorkdir: bindingsOf(() => workdirOpenBindings(ref)),
  };
  // The agent's name is in the context of the input, so an agent that does not open leaves the input without a binding too.
  const name = agentWire === null ? null : await ctx.open(agentBinding(ref), agentWire);
  if (name !== undefined && (name === null || isAgentName(name))) {
    plan['agent'] = [agentBinding(ref)];
    plan['input'] = bindingsOf(() => [inputBinding({ ...ref, agent: name })]);
  }
  return plan;
}

function notePlan(row: Record<string, unknown>): Plan {
  const { taskId, author, kind } = row;
  if (typeof taskId !== 'string' || !isSafeTaskId(taskId) || !isWireNoteAuthor(author) || !isNoteKind(kind)) return {};
  if (author === 'server') return {};
  const fields = {
    body: 'note.body',
    preview: 'note.preview',
    suggestion: 'note.suggestion',
    questions: 'note.questions',
    answers: 'note.answers',
  } as const;
  return Object.fromEntries(
    Object.entries(fields).map(([column, field]) => [column, [noteBinding(field, taskId, author, kind)]]),
  );
}

function transcriptEventPlan(ctx: ResealContext, row: Record<string, unknown>): Plan {
  const { runId, seq } = row;
  if (typeof runId !== 'string' || typeof seq !== 'number' || !Number.isInteger(seq)) return {};
  const taskId = ctx.taskOfRun(runId);
  if (taskId === undefined || !isSafeTaskId(taskId)) return {};
  const fields: Record<string, 'tr.data' | 'tr.output'> = { data: 'tr.data', output: 'tr.output' };
  return Object.fromEntries(
    Object.entries(fields).map(([column, field]) => [column, [transcriptBinding(field, taskId, runId, seq)]]),
  );
}

async function planOf(ctx: ResealContext, table: ExportTable, row: Record<string, unknown>): Promise<Plan> {
  switch (table) {
    case 'task': {
      const ref = taskRef(row);
      const plan = await contentPlan(ctx, row, ref);
      return { ...plan, ...(ref === undefined ? {} : { watches: [watchesBinding(ref.id)] }) };
    }
    case 'schedule': {
      const { id } = row;
      const ref: RowRef | undefined = typeof id === 'string' && isSafeTaskId(id) ? { kind: 'schedule', id } : undefined;
      return contentPlan(ctx, row, ref);
    }
    case 'note':
      return notePlan(row);
    case 'task_pr': {
      const { taskId } = row;
      return typeof taskId === 'string' && isSafeTaskId(taskId) ? { pr: [prBinding(taskId)] } : {};
    }
    case 'machine': {
      const { name } = row;
      if (typeof name !== 'string' || !isSafeMachineName(name)) return {};
      return {
        dirs: [machineDirsBinding(name)],
        catalog: [machineCatalogBinding(name)],
        usage: [machineUsageBinding(name)],
        feeds: [machineFeedsBinding(name)],
      };
    }
    case 'shared_agents': {
      const { version } = row;
      return isSharedAgentsVersion(version) ? { document: [sharedAgentsBinding(version)] } : {};
    }
    case 'link_rules': {
      const { version } = row;
      return isLinkRulesVersion(version) ? { document: [linkRulesBinding(version)] } : {};
    }
    case 'title_rules': {
      const { version } = row;
      return isTitleRulesVersion(version) ? { document: [titleRulesBinding(version)] } : {};
    }
    case 'transcript_run':
      return {};
    case 'transcript_event':
      return transcriptEventPlan(ctx, row);
  }
}

/** The same plaintext under the binding it opened with, or undefined when it opens under none of them. */
async function resealValue(ctx: ResealContext, bindings: Binding[], value: string): Promise<string | undefined> {
  for (const binding of bindings) {
    const text = await ctx.open(binding, value);
    if (text !== undefined) return ctx.seal(binding, text);
  }
  return undefined;
}

/**
 * A copy of `row` with every sealed column that holds a value opened under its exact binding and sealed again with
 * `ctx.seal`, and the columns that did not open in `unreadable`. A clear column a binding needs that is missing or of the
 * wrong shape leaves its columns unreadable. Blind indexes, key slots and every other column are copied.
 */
export async function resealRow(
  table: ExportTable,
  row: Record<string, unknown>,
  ctx: ResealContext,
): Promise<ResealedRow> {
  // The body of a server event is plain text, and nothing else of such a note is sealed.
  if (table === 'note' && row['author'] === 'server') return { row: { ...row }, unreadable: [] };
  const plan = await planOf(ctx, table, row);
  const copy = { ...row };
  const unreadable: string[] = [];
  for (const column of SEALED_ROW_COLUMNS[table]) {
    const value = row[column];
    if (typeof value !== 'string') continue;
    const resealed = await resealValue(ctx, plan[column] ?? [], value);
    if (resealed === undefined) unreadable.push(column);
    else copy[column] = resealed;
  }
  return { row: copy, unreadable };
}
