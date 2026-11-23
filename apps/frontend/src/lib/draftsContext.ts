import { createContext, useContext, useState } from 'react';
import type { DraftSlot, DraftStore } from './drafts';

export const DraftsContext = createContext<DraftStore | null>(null);

export const useDraftStore = (): DraftStore | null => useContext(DraftsContext);

/**
 * `useState` whose value is backed up in the tab's storage, for an input that must survive leaving its page. The store is read
 * once per slot key; only the setter writes. Without a store (outside the provider, or from a modal opened above it) it is plain state.
 */
export function useDraftIn<T>(store: DraftStore | null, slot: DraftSlot<T>): [T, (value: T) => void, () => void] {
  const restore = (): { key: string; value: T } => ({ key: slot.key, value: store?.read(slot) ?? slot.initial });
  const [held, setHeld] = useState(restore);
  let current = held;
  if (held.key !== slot.key) {
    current = restore();
    setHeld(current);
  }
  const set = (value: T): void => {
    setHeld({ key: slot.key, value });
    store?.write(slot, value);
  };
  const clear = (): void => {
    setHeld({ key: slot.key, value: slot.initial });
    store?.clear(slot.key);
  };
  return [current.value, set, clear];
}

export const useDraft = <T>(slot: DraftSlot<T>): [T, (value: T) => void, () => void] =>
  useDraftIn(useDraftStore(), slot);
