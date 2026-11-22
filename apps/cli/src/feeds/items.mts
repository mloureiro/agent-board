import { isRecord } from '@agent-board/shared';

// One thing a feed says should have a task: the line an adapter prints for it.
export interface FeedItem {
  key: string;
  title: string;
  prompt: string;
  version?: string;
  // A directory of this machine's `dirs` list the task runs in, instead of the feed's own.
  dir?: string;
}

export const MAX_FEED_ITEMS = 200;

const ITEM_FIELDS = ['key', 'title', 'prompt', 'version', 'dir'] as const;

export type ParsedItems = { ok: true; items: FeedItem[] } | { ok: false; error: string };

function item(value: unknown, line: number): FeedItem | string {
  if (!isRecord(value)) return `line ${line} is not a JSON object`;
  const unknown = Object.keys(value).find((field) => !ITEM_FIELDS.some((known) => known === field));
  if (unknown !== undefined)
    return `line ${line} has no field "${unknown.slice(0, 40)}" (it takes ${ITEM_FIELDS.join(', ')})`;
  const { key, title, prompt, version, dir } = value;
  for (const [field, text] of [
    ['key', key],
    ['title', title],
    ['prompt', prompt],
  ] as const)
    if (typeof text !== 'string' || text.trim() === '') return `line ${line} has no ${field}`;
  if (version !== undefined && typeof version !== 'string') return `line ${line}: version must be text`;
  if (dir !== undefined && typeof dir !== 'string') return `line ${line}: dir must be a path`;
  return {
    key: key as string,
    title: title as string,
    prompt: prompt as string,
    ...(version === undefined ? {} : { version }),
    ...(dir === undefined ? {} : { dir }),
  };
}

/** The items of an adapter's stdout, one JSON object per line; empty lines are skipped. Any bad line fails the whole listing. */
export function parseItems(stdout: string): ParsedItems {
  const items: FeedItem[] = [];
  const keys = new Set<string>();
  const lines = stdout.split('\n');
  for (const [index, text] of lines.entries()) {
    if (text.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, error: `line ${index + 1} is not JSON` };
    }
    const parsed = item(value, index + 1);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    if (keys.has(parsed.key)) return { ok: false, error: `line ${index + 1} repeats the key of an earlier line` };
    keys.add(parsed.key);
    items.push(parsed);
    if (items.length > MAX_FEED_ITEMS) return { ok: false, error: `more than ${MAX_FEED_ITEMS} items` };
  }
  return { ok: true, items };
}
