// A run's context window usage, read from Claude Code's stream-json output. `usage`, `modelUsage` and the window figures
// are undocumented stream fields, so every reader here answers "no reading" for a shape it does not know.
import type { ContextEvent } from './transcript.mts';
import { isRecord } from './guards.mts';

export const MAX_CONTEXT_TOKENS = 10_000_000;
const MAX_MODEL_CHARS = 256;

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isTokens = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_CONTEXT_TOKENS;

export function usedTokensOf(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const input = usage['input_tokens'];
  const output = usage['output_tokens'];
  if (!isCount(input) || !isCount(output)) return undefined;
  let total = input + output;
  for (const field of ['cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const value = usage[field];
    if (value === undefined) continue;
    if (!isCount(value)) return undefined;
    total += value;
  }
  return isTokens(total) ? total : undefined;
}

export function modelWindowsOf(result: Record<string, unknown>): Record<string, number> {
  const usage = result['modelUsage'];
  const windows: Record<string, number> = {};
  if (!isRecord(usage)) return windows;
  for (const [model, entry] of Object.entries(usage)) {
    const window = isRecord(entry) ? entry['contextWindow'] : undefined;
    if (isTokens(window)) windows[model] = window;
  }
  return windows;
}

export function contextWindowsIn(line: string): Record<string, number> | undefined {
  if (!line.includes('"modelUsage"')) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(event) || event['type'] !== 'result') return undefined;
  const windows = modelWindowsOf(event);
  return Object.keys(windows).length > 0 ? windows : undefined;
}

export function parseAutoCompactPct(value: string | undefined): number | null {
  if (value === undefined || !/^\d+(\.\d+)?$/.test(value)) return null;
  const pct = Number(value);
  return pct >= 1 && pct <= 100 ? pct : null;
}

export function parseContextEvent(value: unknown): ContextEvent | undefined {
  if (!isRecord(value) || value['kind'] !== 'context') return undefined;
  const { seq, at, model, used } = value;
  const parent = value['parent'] ?? null;
  const window = value['window'] ?? null;
  const threshold = value['threshold'] ?? null;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return undefined;
  if (typeof at !== 'string' || (parent !== null && typeof parent !== 'string')) return undefined;
  if (typeof model !== 'string' || model.length > MAX_MODEL_CHARS) return undefined;
  if (!isTokens(used) || (window !== null && !isTokens(window))) return undefined;
  if (threshold !== null && (typeof threshold !== 'number' || !(threshold >= 1 && threshold <= 100))) return undefined;
  return { seq, at, parent, kind: 'context', used, window, threshold, model };
}
