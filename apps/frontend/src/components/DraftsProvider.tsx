import { useState, type PropsWithChildren } from 'react';
import { createDraftStore, type DraftIdentity, type DraftStorage } from '../lib/drafts';
import { DraftsContext } from '../lib/draftsContext';

/** Gives the inputs below it the draft store of one user and key. A new identity needs a new provider (`key`). */
export function DraftsProvider({
  identity,
  storage,
  children,
}: PropsWithChildren<{ identity: DraftIdentity; storage?: DraftStorage }>) {
  const [store] = useState(() => createDraftStore(identity, storage));
  return <DraftsContext.Provider value={store}>{children}</DraftsContext.Provider>;
}
