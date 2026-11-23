import type { Keys } from '@agent-board/shared';
import { Center, Loader } from '@mantine/core';
import { modals } from '@mantine/modals';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type PropsWithChildren } from 'react';
import { DraftsProvider } from '../components/DraftsProvider';
import { removeDrafts, type DraftStorage } from '../lib/drafts';
import { useTRPC } from '../lib/trpc';
import { createIndexedDbKeyStore, inspectStoredKeys, type KeyStore, type StoredKeysCheck } from './keyStore';
import { KeyChangedScreen } from './KeyChangedScreen';
import { KeyProvider } from './KeyProvider';
import { SetupScreen } from './SetupScreen';
import { UnlockScreen } from './UnlockScreen';

const defaultStore = createIndexedDbKeyStore();

interface Props {
  me: { username: string; keyId: string | null };
  store?: KeyStore;
  draftStorage?: DraftStorage;
}

/** What the gate's own screens read; everything else in the cache is decrypted board content. */
const isBoardQuery = (queryKey: readonly unknown[]): boolean => {
  const path = queryKey[0];
  const root = Array.isArray(path) ? path[0] : undefined;
  return root !== 'me' && root !== 'keys';
};

const dropBoard = (queryClient: QueryClient): void =>
  queryClient.removeQueries({ predicate: (query) => isBoardQuery(query.queryKey) });

/**
 * Between the sign-in and the app: a browser that holds keys the board no longer reports gets a blocking warning, no key yet
 * means setup, no usable key in this browser means unlock, and only then the app, with the keys in context. A stored key counts
 * only when it is this user's and has the board's key id.
 */
export function KeyGate({ me, store = defaultStore, draftStorage, children }: PropsWithChildren<Props>) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const { username, keyId } = me;
  const identity = `${username}\0${keyId ?? ''}`;
  const [loaded, setLoaded] = useState<{ identity: string; check: StoredKeysCheck }>();
  // An import sets the key up first and reads the file after; the board then reports a key, which must not end the import.
  const [importing, setImporting] = useState(false);

  const check = loaded?.identity === identity ? loaded.check : undefined;
  const settled = check !== undefined;
  const showsApp = check?.kind === 'usable' && keyId !== null;

  useEffect(() => {
    if (!settled) return;
    if (showsApp && keyId !== null) removeDrafts({ keep: { username, keyId }, storage: draftStorage });
    else removeDrafts({ storage: draftStorage });
  }, [settled, showsApp, username, keyId, draftStorage]);

  useEffect(() => {
    let current = true;
    void inspectStoredKeys(store, { username, keyId }).then((check) => {
      if (current) setLoaded({ identity, check });
    });
    return () => {
      current = false;
    };
  }, [store, username, keyId, identity]);

  const unlocked = useCallback(
    async (keys: Keys) => {
      await store.save(keys);
      setLoaded({ identity: `${username}\0${keys.keyId}`, check: { kind: 'usable', keys } });
    },
    [store, username],
  );
  const setUp = useCallback(
    async (keys: Keys) => {
      await unlocked(keys);
      setImporting(false);
      await queryClient.invalidateQueries({ queryKey: trpc.me.queryKey() });
    },
    [unlocked, queryClient, trpc],
  );
  // Anything the board's answers were opened into or sent from the keys goes: the cached queries and the mutations (their
  // variables hold the plaintext of what was just sent).
  const dropAll = useCallback((): void => {
    dropBoard(queryClient);
    queryClient.getMutationCache().clear();
    removeDrafts({ storage: draftStorage });
    modals.closeAll();
  }, [queryClient, draftStorage]);
  const lock = useCallback(async () => {
    await store.clear();
    setLoaded({ identity, check: { kind: 'none' } });
    dropAll();
  }, [store, identity, dropAll]);

  if (importing) return <SetupScreen owner={username} onComplete={setUp} onImporting={setImporting} />;
  if (check === undefined)
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  if (check.kind === 'changed') return <KeyChangedScreen held={check.held} reported={me} onForget={lock} />;
  if (keyId === null) return <SetupScreen owner={username} onComplete={setUp} onImporting={setImporting} />;
  if (check.kind === 'none') return <UnlockScreen owner={username} onUnlocked={unlocked} />;
  return (
    <KeyProvider keys={check.keys} lock={lock}>
      <DraftsProvider identity={{ username, keyId }} storage={draftStorage} key={identity}>
        {children}
      </DraftsProvider>
    </KeyProvider>
  );
}
