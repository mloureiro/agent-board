// The sources of a machine (`board sources`) as the board shows them: each one's name, timer, pause and last run. Sent as one
// sealed document (`machine.sources`, see sealing.mts); the commands stay on the machine. The browser acts on a source only by
// its opaque id, through a request the machine applies itself, so everything here is display only and shape-checked again
// when it is opened.
import { isRecord } from './guards.mts';

export interface SourceLastRun {
  at: string;
  ok: boolean;
  error?: string;
  listed: number;
  created: number;
  requeued: number;
  closed: number;
  failed: number;
}

export interface MachineSource {
  // Random, made by the machine the first time it sees the source; requests name it.
  id: string;
  name: string;
  everyMs: number;
  paused: boolean;
  // A run was asked for and has not happened yet.
  runNow: boolean;
  // Why config.json's entry cannot be used; such a source does not run.
  problem?: string;
  last?: SourceLastRun;
}

export interface MachineSources {
  sources: MachineSource[];
}

export const SOURCE_ACTIONS = ['pause', 'resume', 'run'] as const;
export type SourceAction = (typeof SOURCE_ACTIONS)[number];

export const MAX_MACHINE_SOURCES = 50;
// Pending requests of one machine: a few per source.
export const MAX_SOURCE_REQUESTS = 3 * MAX_MACHINE_SOURCES;
const MAX_NAME = 40;
const MAX_TEXT = 300;
const MAX_TIME_CHARS = 40;
const COUNTS = ['listed', 'created', 'requeued', 'closed', 'failed'] as const;

export const isSourceId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);

const isSourceAction = (value: string): value is SourceAction => SOURCE_ACTIONS.some((action) => action === value);

/** `pause:<id>` and the like: what the browser asks of a machine, in the clear on the board, naming no source. */
export const sourceRequest = (action: SourceAction, id: string): string => `${action}:${id}`;

export function parseSourceRequest(value: string): { action: SourceAction; id: string } | undefined {
  const [action = '', id, ...rest] = value.split(':');
  return rest.length === 0 && isSourceAction(action) && isSourceId(id) ? { action, id } : undefined;
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

function parseLast(value: unknown): SourceLastRun | undefined {
  if (!isRecord(value)) return undefined;
  const { at, ok, error } = value;
  if (!isText(at, MAX_TIME_CHARS) || Number.isNaN(Date.parse(at)) || typeof ok !== 'boolean') return undefined;
  if (error !== undefined && !isText(error, MAX_TEXT)) return undefined;
  if (!COUNTS.every((name) => isCount(value[name]))) return undefined;
  return {
    at,
    ok,
    ...(error === undefined ? {} : { error }),
    listed: value['listed'] as number,
    created: value['created'] as number,
    requeued: value['requeued'] as number,
    closed: value['closed'] as number,
    failed: value['failed'] as number,
  };
}

function parseSource(value: unknown): MachineSource | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, everyMs, paused, runNow, problem } = value;
  if (!isSourceId(id) || !isText(name, MAX_NAME) || name === '') return undefined;
  if (!isCount(everyMs) || typeof paused !== 'boolean' || typeof runNow !== 'boolean') return undefined;
  if (problem !== undefined && !isText(problem, MAX_TEXT)) return undefined;
  const last = value['last'] === undefined ? undefined : parseLast(value['last']);
  if (value['last'] !== undefined && last === undefined) return undefined;
  return {
    id,
    name,
    everyMs,
    paused,
    runNow,
    ...(problem === undefined ? {} : { problem }),
    ...(last === undefined ? {} : { last }),
  };
}

/**
 * The sources in a decoded document, or undefined when it is unreadable: not an object, `sources` not a list or longer than
 * the cap. A source of the wrong shape is dropped without losing the others, and other keys are ignored.
 */
export function parseMachineSources(json: unknown): MachineSources | undefined {
  if (!isRecord(json) || !Array.isArray(json['sources'])) return undefined;
  const entries: unknown[] = json['sources'];
  if (entries.length > MAX_MACHINE_SOURCES) return undefined;
  return { sources: entries.flatMap((entry) => parseSource(entry) ?? []) };
}

/** The one document the sources are sealed as, and the bytes their blind index is made of: known fields only, in a fixed order. */
export function machineSourcesJson(sources: MachineSources): string {
  return JSON.stringify({
    sources: sources.sources.map(({ id, name, everyMs, paused, runNow, problem, last }) => ({
      id,
      name,
      everyMs,
      paused,
      runNow,
      ...(problem === undefined ? {} : { problem }),
      ...(last === undefined
        ? {}
        : {
            last: {
              at: last.at,
              ok: last.ok,
              ...(last.error === undefined ? {} : { error: last.error }),
              listed: last.listed,
              created: last.created,
              requeued: last.requeued,
              closed: last.closed,
              failed: last.failed,
            },
          }),
    })),
  });
}

/** What is wrong with sources the board would not take, or undefined; the sender checks before it seals. */
export function sourcesProblem(sources: MachineSources): string | undefined {
  if (sources.sources.length > MAX_MACHINE_SOURCES) return `more than ${MAX_MACHINE_SOURCES} sources`;
  const kept = parseMachineSources(JSON.parse(machineSourcesJson(sources)));
  if (kept === undefined || machineSourcesJson(kept) !== machineSourcesJson(sources))
    return 'an entry that is not of its shape: an id, a name, a count, a time or a text';
  return undefined;
}
