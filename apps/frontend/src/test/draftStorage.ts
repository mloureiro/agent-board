import type { DraftStorage } from '../lib/drafts';

export interface MemoryDraftStorage extends DraftStorage {
  entries: Map<string, string>;
}

/** An in-memory `DraftStorage`; `entries` is what a test seeds and inspects. */
export function createMemoryDraftStorage(seed: Record<string, string> = {}): MemoryDraftStorage {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

export const draftKeys = (storage: MemoryDraftStorage): string[] =>
  [...storage.entries.keys()].filter((key) => key.startsWith('agent-board.draft/'));
