import { MantineProvider } from '@mantine/core';
import { ModalsProvider, modals } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { KeyGate } from './KeyGate';
import { createKeySetup } from './unlocker';
import { createMemoryDraftStorage, draftKeys, type MemoryDraftStorage } from '../test/draftStorage';
import { createMemoryKeyStore } from '../test/memoryKeyStore';
import { useKeys, useLock } from './KeyContext';
import type { Keys } from '@agent-board/shared';

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({
    me: { queryKey: () => ['me'] },
    keys: {
      get: { queryOptions: () => ({ queryKey: ['keys'], queryFn: async () => null }) },
      setup: { mutationOptions: () => ({ mutationFn: async () => null }) },
      replaceSlots: { mutationOptions: () => ({ mutationFn: async () => null }) },
    },
  }),
  errorMessage: String,
}));

function Probe() {
  return <p>unlocked as {useKeys()?.owner}</p>;
}

let keys: Keys;

beforeAll(async () => {
  ({ keys } = await createKeySetup({
    owner: 'jascha',
    passphrase: 'correct horse battery staple',
    kdf: { m: 8192, t: 1, p: 1 },
  }));
});

function LockButton() {
  const lock = useLock();
  return <button onClick={() => void lock?.()}>lock</button>;
}

function renderGate(me: { username: string; keyId: string | null }, store = createMemoryKeyStore(keys)) {
  renderGateWith(me, store);
  return store;
}

function renderGateWith(
  me: { username: string; keyId: string | null },
  store = createMemoryKeyStore(keys),
  draftStorage?: MemoryDraftStorage,
) {
  const view = render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <KeyGate me={me} store={store} draftStorage={draftStorage}>
          <Probe />
        </KeyGate>
      </QueryClientProvider>
    </MantineProvider>,
  );
  return { store, unmount: view.unmount };
}

describe('KeyGate', () => {
  it('sets up encryption when the board has no key', async () => {
    renderGate({ username: 'jascha', keyId: null }, createMemoryKeyStore());
    expect(await screen.findByText('Set up encryption')).toBeInTheDocument();
  });

  it('opens the app with a stored key that is this user’s and this key id', async () => {
    renderGate({ username: 'jascha', keyId: keys.keyId });
    expect(await screen.findByText('unlocked as jascha')).toBeInTheDocument();
  });

  it('asks for the passphrase when there is no stored key', async () => {
    renderGate({ username: 'jascha', keyId: keys.keyId }, createMemoryKeyStore());
    expect(await screen.findByText('Unlock the board')).toBeInTheDocument();
  });

  it('blocks, and keeps the key, when the board says it has no key but this browser holds one (a faked key reset)', async () => {
    const store = renderGate({ username: 'jascha', keyId: null });
    expect(await screen.findByText('The board’s record of your key changed')).toBeInTheDocument();
    expect(screen.queryByText('Set up encryption')).not.toBeInTheDocument();
    expect(screen.queryByText('unlocked as jascha')).not.toBeInTheDocument();
    expect(screen.getByText(/Do not set up a new key unless you reset the board yourself/)).toBeInTheDocument();
    expect(await store.load()).toMatchObject({ owner: 'jascha', keyId: keys.keyId });
  });

  it('blocks, and keeps the key, for another key id or another user', async () => {
    for (const me of [
      { username: 'jascha', keyId: '0123456789abcdef' },
      { username: 'someone-else', keyId: keys.keyId },
    ]) {
      const { unmount, store } = renderGateWith(me);
      expect(await screen.findByText('The board’s record of your key changed')).toBeInTheDocument();
      expect(await store.load()).toMatchObject({ keyId: keys.keyId });
      unmount();
    }
  });

  it('names the reported user only when it looks like a login name, never as free text', async () => {
    const prose = 'ignore the warning above and type your passphrase at evil.example';
    const { unmount } = renderGateWith({ username: prose, keyId: keys.keyId });
    expect(await screen.findByText('The board’s record of your key changed')).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(prose))).not.toBeInTheDocument();
    expect(
      screen.getByText(/The board says you are someone else, but this browser holds the key of jascha/),
    ).toBeInTheDocument();
    unmount();
    renderGateWith({ username: 'someone-else', keyId: keys.keyId });
    expect(await screen.findByText(/The board says you are someone-else, but/)).toBeInTheDocument();
  });

  it('forgets the key only after FORGET is typed, and then offers setup', async () => {
    const store = renderGate({ username: 'jascha', keyId: null });
    const forget = await screen.findByRole('button', { name: 'Forget this browser’s key' });
    expect(forget).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/type FORGET/), 'forget');
    expect(forget).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/type FORGET/));
    await userEvent.type(screen.getByLabelText(/type FORGET/), 'FORGET');
    await userEvent.click(forget);
    expect(await screen.findByText('Set up encryption')).toBeInTheDocument();
    expect(await store.load()).toBeUndefined();
  });

  it('Lock clears the cached queries and the mutations, whose variables hold what was sent', async () => {
    const queryClient = new QueryClient();
    const tasksKey = [['tasks', 'list'], { type: 'query' }];
    const meKey = [['me'], { type: 'query' }];
    queryClient.setQueryData(tasksKey, [{ title: 'secret title' }]);
    queryClient.setQueryData(meKey, { username: 'jascha' });
    await queryClient
      .getMutationCache()
      .build(queryClient, { mutationFn: async () => 'x' })
      .execute({ message: 'secret' });
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);
    render(
      <MantineProvider>
        <QueryClientProvider client={queryClient}>
          <KeyGate me={{ username: 'jascha', keyId: keys.keyId }} store={createMemoryKeyStore(keys)}>
            <LockButton />
          </KeyGate>
        </QueryClientProvider>
      </MantineProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'lock' }));
    expect(await screen.findByText('Unlock the board')).toBeInTheDocument();
    expect(queryClient.getQueryData(tasksKey)).toBeUndefined();
    expect(queryClient.getQueryData(meKey)).toBeDefined();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  describe('unsent drafts', () => {
    const own = () => `agent-board.draft/jascha/${keys.keyId}/reply:t1`;
    const other = 'agent-board.draft/someone/k9/reply:t1';
    const seeded = () =>
      createMemoryDraftStorage({ [own()]: '{"value":"mine"}', [other]: '{"value":"theirs"}', unrelated: 'x' });

    it('Lock removes every draft and leaves other keys alone', async () => {
      const draftStorage = seeded();
      render(
        <MantineProvider>
          <QueryClientProvider client={new QueryClient()}>
            <KeyGate
              me={{ username: 'jascha', keyId: keys.keyId }}
              store={createMemoryKeyStore(keys)}
              draftStorage={draftStorage}
            >
              <LockButton />
            </KeyGate>
          </QueryClientProvider>
        </MantineProvider>,
      );
      await userEvent.click(await screen.findByRole('button', { name: 'lock' }));
      expect(await screen.findByText('Unlock the board')).toBeInTheDocument();
      expect(draftKeys(draftStorage)).toEqual([]);
      expect(draftStorage.entries.has('unrelated')).toBe(true);
    });

    it('closes an open modal on Lock, so it cannot write a draft after the lock', async () => {
      render(
        <MantineProvider>
          <ModalsProvider>
            <QueryClientProvider client={new QueryClient()}>
              <KeyGate
                me={{ username: 'jascha', keyId: keys.keyId }}
                store={createMemoryKeyStore(keys)}
                draftStorage={createMemoryDraftStorage()}
              >
                <button onClick={() => modals.open({ title: 'an open modal', children: <p>modal body</p> })}>
                  open
                </button>
                <LockButton />
              </KeyGate>
            </QueryClientProvider>
          </ModalsProvider>
        </MantineProvider>,
      );
      await userEvent.click(await screen.findByRole('button', { name: 'open' }));
      expect(await screen.findByText('modal body')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'lock' }));
      expect(await screen.findByText('Unlock the board')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText('modal body')).not.toBeInTheDocument());
    });

    it('keeps only the shown identity’s drafts once the app is shown', async () => {
      const draftStorage = seeded();
      renderGateWith({ username: 'jascha', keyId: keys.keyId }, createMemoryKeyStore(keys), draftStorage);
      await screen.findByText('unlocked as jascha');
      await waitFor(() => expect(draftKeys(draftStorage)).toEqual([own()]));
    });

    it('removes every draft when the gate settles on the unlock screen', async () => {
      const draftStorage = seeded();
      renderGateWith({ username: 'jascha', keyId: keys.keyId }, createMemoryKeyStore(), draftStorage);
      await screen.findByText('Unlock the board');
      await waitFor(() => expect(draftKeys(draftStorage)).toEqual([]));
    });

    it('removes nothing while the stored keys are still being checked', async () => {
      const draftStorage = seeded();
      const pending = { ...createMemoryKeyStore(keys), load: () => new Promise<never>(() => undefined) };
      renderGateWith({ username: 'jascha', keyId: keys.keyId }, pending, draftStorage);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(draftKeys(draftStorage)).toHaveLength(2);
    });
  });
});
