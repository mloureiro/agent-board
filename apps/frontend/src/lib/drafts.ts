import type { Question } from '@agent-board/shared';

export const DRAFT_PREFIX = 'agent-board.draft/';

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export interface DraftSlot<T> {
  key: string;
  initial: T;
  base?: string;
  isEmpty: (value: T) => boolean;
  parse: (raw: unknown) => T | undefined;
}

export interface DraftIdentity {
  username: string;
  keyId: string;
}

export interface DraftStore {
  read<T>(slot: DraftSlot<T>): T | undefined;
  write<T>(slot: DraftSlot<T>, value: T): void;
  clear(key: string): void;
  clearIfSent(key: string, sent: string): void;
}

const identityPrefix = ({ username, keyId }: DraftIdentity): string =>
  `${DRAFT_PREFIX}${encodeURIComponent(username)}/${keyId}/`;

/** Runs `work` against the tab's storage; where storage is blocked or full there is nothing to keep, and the input works from its state. */
function withStorage<T>(storage: DraftStorage | undefined, fallback: T, work: (storage: DraftStorage) => T): T {
  try {
    return work(storage ?? window.sessionStorage);
  } catch {
    return fallback;
  }
}

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

interface Entry {
  value: unknown;
  base?: string;
}

function parseEntry(text: string | null): Entry | undefined {
  if (text === null) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || !('value' in raw)) return undefined;
  if (raw['base'] !== undefined && typeof raw['base'] !== 'string') return undefined;
  return raw['base'] === undefined ? { value: raw['value'] } : { value: raw['value'], base: raw['base'] };
}

export function createDraftStore(identity: DraftIdentity, storage?: DraftStorage): DraftStore {
  const prefix = identityPrefix(identity);
  const remove = (key: string): void => withStorage(storage, undefined, (target) => target.removeItem(prefix + key));
  return {
    read<T>(slot: DraftSlot<T>): T | undefined {
      return withStorage<T | undefined>(storage, undefined, (target) => {
        const text = target.getItem(prefix + slot.key);
        if (text === null) return undefined;
        const entry = parseEntry(text);
        const value = entry === undefined ? undefined : slot.parse(entry.value);
        if (entry === undefined || value === undefined || entry.base !== slot.base) {
          target.removeItem(prefix + slot.key);
          return undefined;
        }
        return value;
      });
    },
    write<T>(slot: DraftSlot<T>, value: T): void {
      withStorage(storage, undefined, (target) => {
        if (slot.isEmpty(value)) {
          target.removeItem(prefix + slot.key);
          return;
        }
        const entry: Entry = slot.base === undefined ? { value } : { value, base: slot.base };
        target.setItem(prefix + slot.key, JSON.stringify(entry));
      });
    },
    clear: remove,
    clearIfSent(key: string, sent: string): void {
      withStorage(storage, undefined, (target) => {
        if (parseEntry(target.getItem(prefix + key))?.value === sent) target.removeItem(prefix + key);
      });
    },
  };
}

/** Removes every draft, or every draft except `keep`'s identity. */
export function removeDrafts({ keep, storage }: { keep?: DraftIdentity; storage?: DraftStorage } = {}): void {
  withStorage(storage, undefined, (target) => {
    const kept = keep === undefined ? undefined : identityPrefix(keep);
    const keys: string[] = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key !== null && key.startsWith(DRAFT_PREFIX) && (kept === undefined || !key.startsWith(kept))) keys.push(key);
    }
    for (const key of keys) target.removeItem(key);
  });
}

const isString = (raw: unknown): raw is string => typeof raw === 'string';

const stringSlot = (key: string, base?: string): DraftSlot<string> => ({
  key,
  initial: '',
  ...(base === undefined ? {} : { base }),
  isEmpty: (value) => value.trim() === '',
  parse: (raw) => (isString(raw) ? raw : undefined),
});

export const replySlot = (taskId: string): DraftSlot<string> => stringSlot(`reply:${taskId}`);

export interface TextPair {
  title: string;
  input: string;
}

const parsePair = (raw: unknown): TextPair | undefined =>
  isRecord(raw) && isString(raw['title']) && isString(raw['input'])
    ? { title: raw['title'], input: raw['input'] }
    : undefined;

const pairSlot = (key: string, initial: TextPair, base?: string): DraftSlot<TextPair> => ({
  key,
  initial,
  ...(base === undefined ? {} : { base }),
  isEmpty: (value) => value.title === initial.title && value.input === initial.input,
  parse: parsePair,
});

/** `null` is a closed editor: only an open one is stored. */
export const titleSlot = (task: { id: string; title: string }): DraftSlot<string | null> => ({
  key: `title:${task.id}`,
  initial: null,
  base: task.title,
  isEmpty: (value) => value === null,
  parse: (raw) => (isString(raw) ? raw : undefined),
});

export const promptSlot = (task: { id: string; title: string; input: string }): DraftSlot<TextPair> =>
  pairSlot(`prompt:${task.id}`, { title: task.title, input: task.input }, task.input);

export const forkSlot = (parent: { id: string; title: string }): DraftSlot<TextPair> =>
  pairSlot(`fork:${parent.id}`, { title: `Fork of ${parent.title}`, input: '' });

export const scheduleSlot = (schedule: { id: string; title: string; input: string }): DraftSlot<TextPair> =>
  pairSlot(`schedule:${schedule.id}`, { title: schedule.title, input: schedule.input }, schedule.input);

export const proposalSlot = (proposal: { id: string; input: string }): DraftSlot<string> => ({
  key: `proposal:${proposal.id}`,
  initial: proposal.input,
  base: proposal.input,
  isEmpty: (value) => value === proposal.input,
  parse: (raw) => (isString(raw) ? raw : undefined),
});

export interface AnswerPick {
  selected: string[];
  other: string;
}

export interface AnswerDraft {
  picks: AnswerPick[];
  note: string;
}

export const initialPicks = (questions: Question[]): AnswerPick[] =>
  questions.map((q) => ({ selected: q.options.filter((o) => o.recommended).map((o) => o.label), other: '' }));

const isPick = (raw: unknown): raw is AnswerPick =>
  isRecord(raw) && Array.isArray(raw['selected']) && raw['selected'].every(isString) && isString(raw['other']);

/** 32-bit FNV-1a, as hex: enough to tell one question set from another without storing it. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function answerSlot(
  taskId: string,
  noteId: string,
  round: number,
  questions: Question[],
  handover = '',
): DraftSlot<AnswerDraft> {
  const initial: AnswerDraft = { picks: initialPicks(questions), note: handover };
  const initialJson = JSON.stringify(initial);
  return {
    key: `answer:${taskId}:${noteId}:${round}`,
    initial,
    base: fnv1a(JSON.stringify(questions)),
    isEmpty: (value) => JSON.stringify(value) === initialJson,
    parse: (raw) => {
      if (!isRecord(raw) || !Array.isArray(raw['picks']) || !isString(raw['note'])) return undefined;
      const picks: unknown[] = raw['picks'];
      if (picks.length !== questions.length || !picks.every(isPick)) return undefined;
      return { picks: picks.map(({ selected, other }) => ({ selected, other })), note: raw['note'] };
    },
  };
}
