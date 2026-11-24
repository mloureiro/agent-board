import type { Keys } from '@agent-board/shared';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeySetup } from '../crypto/unlocker';
import { KeyProvider } from '../crypto/KeyProvider';
import { createMemoryKeyStore } from '../test/memoryKeyStore';
import { AccountDeletedProvider } from './AccountDeletedProvider';
import { DeleteAccountModal } from './DeleteAccountModal';

const deleteAccount = vi.hoisted(() => vi.fn(async (_: { username: string }) => null));

vi.mock('../lib/trpc', () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  useRawTRPCClient: () => ({ account: { delete: { mutate: deleteAccount } } }),
}));

const SUMMARY = {
  tasks: 12,
  schedules: 2,
  notes: 40,
  taskPrs: 3,
  machines: 2,
  sharedAgents: 1,
  linkRules: 1,
  titleRules: 0,
  transcriptRuns: 7,
  transcriptEvents: 900,
  running: 0,
};
let keys: Keys;
const polled = vi.fn(async () => 'polled');

beforeAll(async () => {
  ({ keys } = await createKeySetup({
    owner: 'jascha',
    passphrase: 'correct horse battery staple',
    kdf: { m: 8192, t: 1, p: 1 },
  }));
});

beforeEach(() => {
  deleteAccount.mockClear();
  polled.mockClear();
  localStorage.setItem('agent-board.desktopNotifications', 'on');
});

function Poller() {
  useQuery({ queryKey: ['poll'], queryFn: polled, refetchInterval: 20 });
  return <p>the board</p>;
}

function renderModal(summary = SUMMARY) {
  const store = createMemoryKeyStore(keys);
  const queryClient = new QueryClient();
  render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <AccountDeletedProvider>
          <KeyProvider keys={keys} lock={() => store.clear()}>
            <Poller />
            <DeleteAccountModal username="jascha" summary={summary} onClose={() => {}} />
          </KeyProvider>
        </AccountDeletedProvider>
      </QueryClientProvider>
    </MantineProvider>,
  );
  return { store, queryClient };
}

describe('DeleteAccountModal', () => {
  it('says what goes and what stays', () => {
    renderModal();
    expect(screen.getByText('12 tasks')).toBeInTheDocument();
    expect(screen.getByText('2 machines, with their tokens')).toBeInTheDocument();
    expect(screen.getByText(/7 transcripts \(900 events\)/)).toBeInTheDocument();
    expect(screen.getByText(/Export your data first/)).toBeInTheDocument();
    expect(screen.getByText(/Your sign-in/)).toBeInTheDocument();
    expect(screen.getByText(/database backups/)).toBeInTheDocument();
    expect(screen.queryByText(/keep going on their machines/)).not.toBeInTheDocument();
  });

  it('warns about runs in progress', () => {
    renderModal({ ...SUMMARY, running: 2 });
    expect(screen.getByText(/2 tasks are running/)).toBeInTheDocument();
    expect(screen.getByText(/keep going on their machines but can no longer report/)).toBeInTheDocument();
  });

  it('keeps the button disabled until the username is typed exactly', async () => {
    renderModal();
    const button = screen.getByRole('button', { name: 'Delete everything' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Type/), 'jasch');
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Type/), 'a');
    expect(button).toBeEnabled();
  });

  it('deletes, clears the keys and preferences, and leaves a screen that asks the board nothing', async () => {
    const { store, queryClient } = renderModal();
    await waitFor(() => expect(polled).toHaveBeenCalled());
    await userEvent.type(screen.getByLabelText(/Type/), 'jascha');
    await userEvent.click(screen.getByRole('button', { name: 'Delete everything' }));

    expect(await screen.findByText('Your account and its data are deleted')).toBeInTheDocument();
    expect(deleteAccount).toHaveBeenCalledWith({ username: 'jascha' });
    expect(screen.queryByText('the board')).not.toBeInTheDocument();
    await waitFor(async () => expect(await store.load()).toBeUndefined());
    expect(localStorage.getItem('agent-board.desktopNotifications')).toBeNull();
    await waitFor(() => expect(queryClient.getQueryCache().getAll()).toHaveLength(0));

    const calls = polled.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(polled.mock.calls.length).toBe(calls);
  });

  it('shows the board’s refusal and keeps everything when the delete fails', async () => {
    deleteAccount.mockRejectedValueOnce(new Error('Not now'));
    const { store } = renderModal();
    await userEvent.type(screen.getByLabelText(/Type/), 'jascha');
    await userEvent.click(screen.getByRole('button', { name: 'Delete everything' }));
    expect(await screen.findByText('Not now')).toBeInTheDocument();
    expect(await store.load()).toBeDefined();
    expect(screen.queryByText('Your account and its data are deleted')).not.toBeInTheDocument();
  });
});
