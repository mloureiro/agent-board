// A run's transcript: Claude Code's `--output-format stream-json` events, condensed to what a person reads when
// they want to know why the agent did something. The worker sends them to the board in batches while the run goes on.
import { ContractError, isSessionId, MAX_INT32, MAX_OUTPUT_SIZE, parseSealed } from './contract.mts';
import { isRecord, isStringList } from './guards.mts';

interface EventBase {
  // Order within the run, from 0.
  seq: number;
  at: string;
  // The Agent call a subagent's event belongs to; null for the main agent.
  parent: string | null;
}

export type TranscriptEvent = EventBase &
  (
    | { kind: 'text'; text: string }
    // Claude Code passes thinking on without its text; what is left is that it happened and roughly how long it was.
    | { kind: 'thinking'; text: string; tokens: number | null }
    | { kind: 'tool_use'; toolUseId: string; name: string; input: unknown }
    | { kind: 'tool_result'; toolUseId: string; isError: boolean; output: string }
    | {
        kind: 'result';
        text: string;
        isError: boolean;
        turns: number | null;
        durationMs: number | null;
        costUsd: number | null;
        denials: string[];
      }
    | { kind: 'note'; text: string }
  );

export type ContextEvent = EventBase & {
  kind: 'context';
  used: number;
  window: number | null;
  threshold: number | null;
  model: string;
};

export type RunEvent = TranscriptEvent | ContextEvent;

// An event without its position: one member of the union per kind.
export type TranscriptEventBody = TranscriptEvent extends infer E
  ? E extends TranscriptEvent
    ? Omit<E, keyof EventBase>
    : never
  : never;

export type RunEventBody = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, keyof EventBase> : never) : never;

// An event as the board lists it: a tool result without its output, with the output's length instead.
export type TranscriptEventView = TranscriptEvent extends infer E
  ? E extends TranscriptEvent
    ? Omit<E, 'output'> & { outputSize: number | null }
    : never
  : never;

// An event as the board stores it: its position, time and kind in the clear, the rest sealed.
export interface WireTranscriptEvent {
  seq: number;
  at: string;
  kind: RunEvent['kind'];
  parent: string | null;
  // Sealed ("tr.data", context `<taskId>:<runId>:<seq>`): the JSON of the whole event but its output.
  data: string;
  // A tool result's output, sealed ("tr.output", same context); absent on every other event.
  output?: string | null;
  // The output's length in characters, counted by the client: the server cannot read the output.
  outputSize?: number | null;
}

// An event as the board lists it: `data` is still sealed.
export interface WireTranscriptEventView {
  seq: number;
  at: Date;
  kind: string;
  parent: string | null;
  data: string;
  outputSize: number | null;
}

export interface WireTranscriptBatch {
  runId: string;
  startedAt: string;
  sessionId: string | null;
  resumed: boolean;
  events: WireTranscriptEvent[];
}

export interface TranscriptBatch {
  // One per worker run; a resume or a re-run is a new run.
  runId: string;
  startedAt: string;
  sessionId: string | null;
  resumed: boolean;
  events: RunEvent[];
}

// A tool result past this is cut, with a note; the full one stays in the session file on the machine.
export const MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_INPUT_CHARS = 64 * 1024;
// The agent's own words, a note and a result text are cut like a tool input; a denial and an id are short by nature.
export const MAX_TEXT_CHARS = 64 * 1024;
const MAX_DENIAL_CHARS = 2 * 1024;
const MAX_DENIALS = 20;
const MAX_ID_CHARS = 256;

export class TranscriptError extends Error {}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… cut at ${max} of ${text.length} characters`;
}

function capInput(input: unknown): unknown {
  const json = JSON.stringify(input ?? null);
  return json.length <= MAX_INPUT_CHARS ? input : { truncated: cap(json, MAX_INPUT_CHARS) };
}

// A tool result's content is a string or a list of blocks.
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content);
  return content
    .map((block) =>
      isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string'
        ? block['text']
        : isRecord(block) && block['type'] === 'image'
          ? '[image]'
          : JSON.stringify(block),
    )
    .join('\n');
}

// A tool use id as the board accepts it for an event's `parent`; anything else is dropped rather than refused.
const PARENT_ID = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_ID_CHARS}}$`);
const isParentId = (id: string): boolean => PARENT_ID.test(id);
const capId = (id: string | null): string | null => {
  const capped = id?.slice(0, MAX_ID_CHARS) ?? null;
  return capped !== null && isParentId(capped) ? capped : null;
};

// Every string of an event is bounded, so that its sealed JSON stays under the board's limit for `tr.data` whatever the
// stream holds: one event past it would be refused for good.
function capBody(body: RunEventBody): RunEventBody {
  switch (body.kind) {
    case 'text':
    case 'note':
      return { ...body, text: cap(body.text, MAX_TEXT_CHARS) };
    case 'thinking':
      return { ...body, text: cap(body.text, MAX_TEXT_CHARS) };
    case 'tool_use':
      return { ...body, toolUseId: body.toolUseId.slice(0, MAX_ID_CHARS), name: body.name.slice(0, MAX_ID_CHARS) };
    case 'tool_result':
      return { ...body, toolUseId: body.toolUseId.slice(0, MAX_ID_CHARS) };
    case 'context':
      return { ...body, model: body.model.slice(0, MAX_ID_CHARS) };
    case 'result':
      return {
        ...body,
        text: cap(body.text, MAX_TEXT_CHARS),
        denials: [
          ...body.denials.slice(0, MAX_DENIALS).map((denial) => cap(denial, MAX_DENIAL_CHARS)),
          ...(body.denials.length > MAX_DENIALS ? [`… and ${body.denials.length - MAX_DENIALS} more denials`] : []),
        ],
      };
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * Turns stream-json lines into transcript events. Keeps the little state the stream needs across lines: the event
 * counter and the last thinking-token estimate, which arrives before the (empty) thinking block it belongs to.
 */
export class StreamCondenser {
  private seq = 0;
  private thinkingTokens: number | null = null;
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /** A note of the worker's own, at the next position: for something that happened to the transcript itself. */
  note(text: string): TranscriptEvent {
    return this.make(null, { kind: 'note', text });
  }

  line(raw: string): RunEvent[] {
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return raw.trim() === '' ? [] : [this.make(null, { kind: 'note', text: raw.trim() })];
    }
    if (!isRecord(event)) return [];
    const parent = typeof event['parent_tool_use_id'] === 'string' ? event['parent_tool_use_id'] : null;
    const type = event['type'];
    const message = isRecord(event['message']) ? event['message'] : undefined;
    const content = Array.isArray(message?.['content']) ? message['content'] : [];

    if (type === 'system') return this.system(event, parent);
    if (type === 'assistant') {
      return content.flatMap((block: unknown): TranscriptEvent[] => {
        if (!isRecord(block)) return [];
        if (block['type'] === 'text' && str(block['text']).trim() !== '')
          return [this.make(parent, { kind: 'text', text: str(block['text']) })];
        if (block['type'] === 'thinking') {
          const tokens = this.thinkingTokens;
          this.thinkingTokens = null;
          return [this.make(parent, { kind: 'thinking', text: str(block['thinking']), tokens })];
        }
        if (block['type'] === 'tool_use')
          return [
            this.make(parent, {
              kind: 'tool_use',
              toolUseId: str(block['id']),
              name: str(block['name']),
              input: capInput(block['input']),
            }),
          ];
        return [];
      });
    }
    if (type === 'user') {
      return content.flatMap((block: unknown): TranscriptEvent[] => {
        if (!isRecord(block) || block['type'] !== 'tool_result') return [];
        return [
          this.make(parent, {
            kind: 'tool_result',
            toolUseId: str(block['tool_use_id']),
            isError: block['is_error'] === true,
            output: cap(resultText(block['content']), MAX_OUTPUT_CHARS),
          }),
        ];
      });
    }
    if (type === 'result') {
      const denials = Array.isArray(event['permission_denials'])
        ? event['permission_denials'].map((denial: unknown) =>
            isRecord(denial)
              ? `${str(denial['tool_name'])} ${JSON.stringify(denial['tool_input'] ?? {})}`.trim()
              : String(denial),
          )
        : [];
      return [
        this.make(parent, {
          kind: 'result',
          text: str(event['result']),
          isError: event['is_error'] === true,
          turns: num(event['num_turns']),
          durationMs: num(event['duration_ms']),
          costUsd: num(event['total_cost_usd']),
          denials,
        }),
      ];
    }
    return [];
  }

  private system(event: Record<string, unknown>, parent: string | null): TranscriptEvent[] {
    const subtype = event['subtype'];
    if (subtype === 'thinking_tokens') {
      this.thinkingTokens = num(event['estimated_tokens']);
      return [];
    }
    if (subtype === 'init' && this.seq === 0) {
      return [
        this.make(parent, {
          kind: 'note',
          text: `Claude Code ${str(event['claude_code_version'])}, ${str(event['model'])}, in ${str(event['cwd'])}`.replace(
            / ,/g,
            ',',
          ),
        }),
      ];
    }
    if (subtype === 'task_notification' && str(event['summary']) !== '') {
      return [
        this.make(str(event['tool_use_id']) || parent, {
          kind: 'note',
          text: `Subagent ${str(event['status']) || 'finished'}: ${str(event['summary'])}`,
        }),
      ];
    }
    return [];
  }

  private make(parent: string | null, body: TranscriptEventBody): TranscriptEvent;
  private make(parent: string | null, body: RunEventBody): RunEvent;
  private make(parent: string | null, body: RunEventBody): RunEvent {
    return {
      seq: this.seq++,
      at: this.now().toISOString(),
      parent: capId(parent),
      ...capBody(body),
    } as RunEvent;
  }
}

// One line for a tool call: what it did, in the terms a person would look for.
export function toolSummary(name: string, input: unknown): string {
  const field = (key: string): string => (isRecord(input) && typeof input[key] === 'string' ? input[key] : '');
  const first = (text: string): string => text.split('\n')[0]?.slice(0, 160) ?? '';
  switch (name) {
    case 'Bash':
      return first(field('command'));
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return field('file_path') || field('notebook_path');
    case 'Grep':
    case 'Glob':
      return `${field('pattern')}${field('path') ? ` in ${field('path')}` : ''}`;
    case 'Agent':
    case 'Task':
      return field('description') || first(field('prompt'));
    case 'Skill':
      return `${field('skill')}${field('args') ? ` ${first(field('args'))}` : ''}`;
    case 'WebFetch':
      return field('url');
    case 'WebSearch':
      return field('query');
    default:
      return first(JSON.stringify(input ?? {})).slice(0, 120);
  }
}

// The line the worker writes to the local log for an event; undefined for events the log does not need.
export function logLine(event: RunEvent): string | undefined {
  const indent = event.parent ? '    ' : '';
  switch (event.kind) {
    case 'text':
      return `${indent}${event.text}`;
    case 'tool_use':
      return `${indent}→ ${event.name}: ${toolSummary(event.name, event.input)}`;
    case 'tool_result':
      return event.isError ? `${indent}✗ ${event.output.split('\n').slice(0, 3).join(' | ').slice(0, 300)}` : undefined;
    case 'result':
      return (
        [event.denials.length > 0 ? `denied: ${event.denials.join('; ')}` : '', event.text]
          .filter(Boolean)
          .join('\n') || undefined
      );
    case 'note':
      return `${indent}· ${event.text}`;
    case 'thinking':
    case 'context':
      return undefined;
  }
}

// The board takes at most this many events in one `transcript` call.
export const MAX_BATCH_EVENTS = 5000;

// The board lists a run's events in pages of this size; a shorter page is the last.
export const TRANSCRIPT_PAGE_SIZE = 2000;

const KINDS = [
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'result',
  'note',
] as const satisfies readonly TranscriptEvent['kind'][];

const WIRE_KINDS = [...KINDS, 'context'] as const satisfies readonly RunEvent['kind'][];

function sealedOrBust(value: unknown, field: 'tr.data' | 'tr.output', what: string): string {
  try {
    return parseSealed(value, field, what);
  } catch (error) {
    throw error instanceof ContractError ? new TranscriptError(error.message) : error;
  }
}

/**
 * An event as sealed by a worker, read back: the decrypted `tr.data` JSON. The worker that sealed it may be older or
 * newer than this code, so every field is checked for its kind; a missing optional number is null and missing denials
 * are none. A tool result's output is sealed apart and absent here, so it reads as ''. Anything else that does not fit
 * is undefined, for the caller to show as unreadable rather than trust.
 */
export function parseTranscriptEvent(value: unknown): TranscriptEvent | undefined {
  if (!isRecord(value)) return undefined;
  const kind = KINDS.find((candidate) => candidate === value['kind']);
  const { seq, at, text, isError } = value;
  const parent = value['parent'] ?? null;
  if (kind === undefined || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return undefined;
  if (typeof at !== 'string' || (parent !== null && typeof parent !== 'string')) return undefined;
  const base = { seq, at, parent };
  switch (kind) {
    case 'text':
    case 'note':
      return typeof text === 'string' ? { ...base, kind, text } : undefined;
    case 'thinking':
      return typeof text === 'string' ? { ...base, kind, text, tokens: num(value['tokens']) } : undefined;
    case 'tool_use': {
      const { toolUseId, name } = value;
      if (typeof toolUseId !== 'string' || typeof name !== 'string') return undefined;
      return { ...base, kind, toolUseId, name, input: value['input'] ?? null };
    }
    case 'tool_result': {
      const { toolUseId, output = '' } = value;
      if (typeof toolUseId !== 'string' || typeof isError !== 'boolean' || typeof output !== 'string') return undefined;
      return { ...base, kind, toolUseId, isError, output };
    }
    case 'result': {
      const denials = value['denials'] ?? [];
      if (typeof text !== 'string' || typeof isError !== 'boolean' || !isStringList(denials)) return undefined;
      return {
        ...base,
        kind,
        text,
        isError,
        turns: num(value['turns']),
        durationMs: num(value['durationMs']),
        costUsd: num(value['costUsd']),
        denials,
      };
    }
  }
}

// Stdin of `transcript` on the server: checked for shape, with the sealed fields being envelopes and nothing about their content.
export function parseWireTranscriptBatch(value: unknown): WireTranscriptBatch {
  if (!isRecord(value)) throw new TranscriptError('transcript batch must be an object');
  const runId = value['runId'];
  if (typeof runId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(runId))
    throw new TranscriptError('transcript runId must be an id');
  const startedAt = value['startedAt'];
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt)))
    throw new TranscriptError('transcript startedAt must be a date');
  const sessionId = value['sessionId'] ?? null;
  if (sessionId !== null && (typeof sessionId !== 'string' || !isSessionId(sessionId)))
    throw new TranscriptError('transcript sessionId must be a UUID or null');
  const rawEvents = value['events'];
  if (!Array.isArray(rawEvents) || rawEvents.length > MAX_BATCH_EVENTS)
    throw new TranscriptError(`transcript events must be a list of at most ${MAX_BATCH_EVENTS}`);
  const events = rawEvents.map((event: unknown): WireTranscriptEvent => {
    if (!isRecord(event)) throw new TranscriptError('transcript event must be an object');
    const kind = WIRE_KINDS.find((candidate) => candidate === event['kind']);
    if (kind === undefined) throw new TranscriptError('transcript event needs a known kind');
    const { seq, at, parent } = event;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > MAX_INT32)
      throw new TranscriptError(`transcript event seq must be an integer from 0 to ${MAX_INT32}`);
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at)))
      throw new TranscriptError('transcript event at must be a date');
    if (parent !== null && (typeof parent !== 'string' || !isParentId(parent)))
      throw new TranscriptError('transcript event parent must be a tool use id or null');
    const data = sealedOrBust(event['data'], 'tr.data', 'transcript event data');
    const base = { seq, at, kind, parent, data };
    if (kind !== 'tool_result') {
      if (event['output'] != null || event['outputSize'] != null)
        throw new TranscriptError('only a tool result carries an output');
      return base;
    }
    const outputSize = event['outputSize'];
    if (
      typeof outputSize !== 'number' ||
      !Number.isInteger(outputSize) ||
      outputSize < 0 ||
      outputSize > MAX_OUTPUT_SIZE
    )
      throw new TranscriptError(`transcript event outputSize must be a whole number up to ${MAX_OUTPUT_SIZE}`);
    return { ...base, output: sealedOrBust(event['output'], 'tr.output', 'transcript event output'), outputSize };
  });
  return { runId, startedAt, sessionId, resumed: value['resumed'] === true, events };
}
