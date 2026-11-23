import { isRecord } from '@agent-board/shared';
import { REPO_PATTERN } from '../config/config.mts';
import { MAX_FIELDS } from './integration.mts';
import { FIELD_NAME, oneLine } from './template.mts';

export interface FeedItem {
  key: string;
  title: string;
  version?: string;
  dir?: string;
  repo?: string;
  notBefore?: string;
  fields?: Record<string, string>;
}

export const MAX_FEED_ITEMS = 200;
export const MAX_FIELD_VALUE = 2000;
export const TITLE_MAX = 200;

const ITEM_FIELDS = ['key', 'title', 'version', 'dir', 'repo', 'notBefore', 'fields'] as const;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export type ParsedItems = { ok: true; items: FeedItem[] } | { ok: false; error: string };

function fieldValues(value: unknown, line: number): Record<string, string> | string {
  if (!isRecord(value)) return `line ${line}: fields must be an object of text values`;
  const entries = Object.entries(value);
  if (entries.length > MAX_FIELDS) return `line ${line}: fields has more than ${MAX_FIELDS} entries`;
  const fields: Record<string, string> = {};
  for (const [name, text] of entries) {
    if (!FIELD_NAME.test(name)) return `line ${line}: "${name.slice(0, 40)}" is not a field name`;
    if (typeof text !== 'string') return `line ${line}: field ${name} must be text`;
    if (text.length > MAX_FIELD_VALUE)
      return `line ${line}: field ${name} is longer than ${MAX_FIELD_VALUE} characters`;
    fields[name] = text;
  }
  return fields;
}

function item(value: unknown, line: number): FeedItem | string {
  if (!isRecord(value)) return `line ${line} is not a JSON object`;
  if (Object.hasOwn(value, 'prompt'))
    return `line ${line} sends a prompt: prompts come from the feed's prompts.new and prompts.update`;
  const unknown = Object.keys(value).find((field) => !ITEM_FIELDS.some((known) => known === field));
  if (unknown !== undefined)
    return `line ${line} has no field "${unknown.slice(0, 40)}" (it takes ${ITEM_FIELDS.join(', ')})`;
  const { key, title, version, dir, repo, notBefore } = value;
  if (typeof key !== 'string' || key.trim() === '') return `line ${line} has no key`;
  const cleanTitle = typeof title === 'string' ? Array.from(oneLine(title)).slice(0, TITLE_MAX).join('').trim() : '';
  if (cleanTitle === '') return `line ${line} has no title`;
  if (version !== undefined && typeof version !== 'string') return `line ${line}: version must be text`;
  if (dir !== undefined && typeof dir !== 'string') return `line ${line}: dir must be a path`;
  if (repo !== undefined && (typeof repo !== 'string' || !REPO_PATTERN.test(repo)))
    return `line ${line}: repo must look like owner/name`;
  if (
    notBefore !== undefined &&
    (typeof notBefore !== 'string' || !ISO_TIME.test(notBefore) || Number.isNaN(Date.parse(notBefore)))
  )
    return `line ${line}: notBefore must be an ISO time such as 2026-11-23T10:00:00Z`;
  const fields = value['fields'] === undefined ? undefined : fieldValues(value['fields'], line);
  if (typeof fields === 'string') return fields;
  return {
    key,
    title: cleanTitle,
    ...(version === undefined ? {} : { version }),
    ...(dir === undefined ? {} : { dir }),
    ...(repo === undefined ? {} : { repo }),
    ...(notBefore === undefined ? {} : { notBefore }),
    ...(fields === undefined ? {} : { fields }),
  };
}

/** The first field of the item that the action did not declare in `describe`, or undefined. */
export const undeclaredField = (feedItem: FeedItem, declared: readonly string[]): string | undefined =>
  Object.keys(feedItem.fields ?? {}).find((name) => !declared.includes(name));

/** The items of an integration's stdout, one JSON object per line; empty lines are skipped. Any bad line fails the whole listing. */
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
