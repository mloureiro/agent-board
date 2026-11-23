import { isRecord } from '@agent-board/shared';
import type { CommandResult, CommandSpec } from '../dispatch/waits.mts';
import { shellQuote } from '../output/text.mts';
import { PROTOCOL } from '../plugins/manifest.mts';
import { isActionName } from '../plugins/names.mts';
import { withoutControls } from '../watch/fence.mts';
import { parseSchema } from './schema.mts';
import type { Schema } from './schema.mts';
import { FIELD_NAME } from './template.mts';

export type Run = (spec: CommandSpec) => Promise<CommandResult>;

export type Outcome = { ok: true; stdout: string } | { ok: false; reason: string };

export interface ActionDescription {
  summary: string | undefined;
  options: Schema;
  fields: string[];
}

export interface Description {
  actions: Record<string, ActionDescription>;
}

export const PROTOCOL_TIMEOUT_MS = 30_000;
export const MAX_FIELDS = 16;
export const REASON_MAX = 200;

// `runCommand` keeps this much of stdout; a listing that filled it may have lost its first lines.
const STDOUT_LIMIT = 200_000;
const SUMMARY_MAX = 300;

const cut = (text: string, max: number): string => Array.from(text).slice(0, max).join('');

/** The first non-empty line of what a program wrote to stderr, as one line of text a terminal and a state file may hold. */
export function firstLine(stderr: string): string {
  const line = stderr.split('\n').find((text) => text.trim() !== '') ?? '';
  return cut(withoutControls(line).trim(), REASON_MAX);
}

function failure(label: string, result: CommandResult, limitMs: number): string | undefined {
  if (result.timedOut) return `${label} took longer than ${Math.round(limitMs / 1000)}s`;
  if (result.exitCode === 0) return undefined;
  const reason = firstLine(result.stderr);
  return `${label} exited ${result.exitCode ?? 'by a signal'}${reason === '' ? '' : `: ${reason}`}`;
}

async function call(
  run: Run,
  program: string,
  words: readonly string[],
  spec: Omit<CommandSpec, 'command'> & { label: string },
): Promise<Outcome> {
  const { label, ...rest } = spec;
  const result = await run({ ...rest, command: [shellQuote(program), ...words].join(' ') });
  const reason = failure(label, result, rest.timeLimitMs ?? PROTOCOL_TIMEOUT_MS);
  if (reason !== undefined) return { ok: false, reason };
  if (result.stdout.length >= STDOUT_LIMIT) return { ok: false, reason: `${label} printed more than 200 KB` };
  return { ok: true, stdout: result.stdout };
}

const notAnAction = (action: string): Outcome => ({ ok: false, reason: `"${cut(action, 40)}" is not an action name` });

/** Runs `describe`: what the integration's actions take and provide, as the text it printed. */
export function describe(program: string, dir: string, run: Run): Promise<Outcome> {
  return call(run, program, ['describe'], { label: 'describe', cwd: dir, timeLimitMs: PROTOCOL_TIMEOUT_MS });
}

/** Runs `check <action>` with the options on stdin: offline, and exit 0 when they are valid. */
export async function check(
  program: string,
  action: string,
  options: unknown,
  dir: string,
  run: Run,
): Promise<Outcome> {
  if (!isActionName(action)) return notAnAction(action);
  return call(run, program, ['check', action], {
    label: `check ${action}`,
    cwd: dir,
    timeLimitMs: PROTOCOL_TIMEOUT_MS,
    stdin: JSON.stringify(options),
  });
}

/** Runs the action with the options on stdin; its stdout is the listing. */
export async function list(
  program: string,
  action: string,
  options: unknown,
  dir: string,
  run: Run,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Outcome> {
  if (!isActionName(action)) return notAnAction(action);
  return call(run, program, [action], {
    label: action,
    cwd: dir,
    timeLimitMs: timeoutMs,
    stdin: JSON.stringify(options),
    ...(signal === undefined ? {} : { signal }),
  });
}

function parseAction(name: string, entry: unknown, ref: string): ActionDescription | string {
  const where = `${ref} describes ${cut(name, 40)}`;
  if (!isRecord(entry)) return `${where} with something that is not an object`;
  const { summary, fields } = entry;
  if (summary !== undefined && (typeof summary !== 'string' || summary.length > SUMMARY_MAX))
    return `${where} with a summary that is not text of at most ${SUMMARY_MAX} characters`;
  const options = parseSchema(entry['options'] ?? { type: 'object' });
  if (typeof options === 'string') return `${where} with options this CLI cannot use: ${options}`;
  const names = fields ?? [];
  if (
    !Array.isArray(names) ||
    names.length > MAX_FIELDS ||
    !names.every((field) => typeof field === 'string' && FIELD_NAME.test(field))
  )
    return `${where} with fields that are not a list of at most ${MAX_FIELDS} names of letters, digits and underscores`;
  return { summary, options, fields: [...new Set<string>(names)] };
}

/** The `describe` answer of the integration `ref`, or the reason it cannot be used. Fails closed on any protocol but this one's. */
export function parseDescription(stdout: string, ref: string): Description | string {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return `${ref} printed a describe answer that is not JSON`;
  }
  if (!isRecord(raw)) return `${ref} printed a describe answer that is not a JSON object`;
  if (raw['protocol'] !== PROTOCOL)
    return `${ref} speaks protocol ${cut(String(raw['protocol']), 20)}; this CLI speaks ${PROTOCOL}`;
  const declared = raw['actions'];
  if (!isRecord(declared)) return `${ref} describes no actions object`;
  const actions: Record<string, ActionDescription> = {};
  for (const [name, entry] of Object.entries(declared)) {
    if (!isActionName(name))
      return `${ref} describes an action named "${cut(name, 40)}", which is not a valid action name`;
    const action = parseAction(name, entry, ref);
    if (typeof action === 'string') return action;
    actions[name] = action;
  }
  return { actions };
}
