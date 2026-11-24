import { type KeySetup } from '@agent-board/shared';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeySetup, unlockKeys } from './unlocker';
import { UnlockScreen } from './UnlockScreen';

const replaceSlots = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const stored = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({
    keys: {
      get: { queryOptions: () => ({ queryKey: ['keys'], queryFn: async () => stored.current }) },
      replaceSlots: { mutationOptions: () => ({ mutationFn: replaceSlots }) },
    },
  }),
  errorMessage: String,
}));

const PASSPHRASE = 'correct horse battery staple';
const NEW_PASSPHRASE = 'a different long passphrase';
const FAST = { m: 8192, t: 1, p: 1 };
let setup: KeySetup;
let recoveryKey: string;

function renderUnlock(onUnlocked = vi.fn(async () => undefined)) {
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <UnlockScreen owner="jascha" kdf={FAST} onUnlocked={onUnlocked} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return onUnlocked;
}

beforeAll(async () => {
  ({ setup, recoveryKey } = await createKeySetup({ owner: 'jascha', passphrase: PASSPHRASE, kdf: FAST }));
});

beforeEach(() => {
  replaceSlots.mockClear();
  stored.current = setup;
});

describe('UnlockScreen', () => {
  it('unlocks with the passphrase', async () => {
    const onUnlocked = renderUnlock();
    await userEvent.type(await screen.findByLabelText('Passphrase', { selector: 'input' }), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(expect.objectContaining({ keyId: setup.keyId })));
    expect(replaceSlots).not.toHaveBeenCalled();
  });

  it('says only that the passphrase is wrong', async () => {
    const onUnlocked = renderUnlock();
    await userEvent.type(await screen.findByLabelText('Passphrase', { selector: 'input' }), 'not the passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('Wrong passphrase or recovery key.')).toBeInTheDocument();
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it('opens with the recovery key only together with a new passphrase, and keeps the recovery slot', async () => {
    const onUnlocked = renderUnlock();
    await userEvent.click(await screen.findByRole('button', { name: 'Use my recovery key' }));
    await userEvent.type(screen.getByLabelText('Recovery key'), recoveryKey);
    expect(screen.getByRole('button', { name: 'Unlock with the recovery key' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('New passphrase', { selector: 'input' }), NEW_PASSPHRASE);
    await userEvent.type(screen.getByLabelText('New passphrase again', { selector: 'input' }), NEW_PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Unlock with the recovery key' }));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    const sent = replaceSlots.mock.calls[0]?.[0] as KeySetup;
    expect(sent.keyId).toBe(setup.keyId);
    expect(sent.slots[1]).toEqual(setup.slots[1]);
    expect(sent.slots[0]).not.toEqual(setup.slots[0]);
    const again = await unlockKeys({
      owner: 'jascha',
      stored: sent,
      secret: { kind: 'passphrase', passphrase: NEW_PASSPHRASE },
    });
    expect(again.keyId).toBe(setup.keyId);
  });

  it('does not touch the board when the recovery key is wrong', async () => {
    const onUnlocked = renderUnlock();
    await userEvent.click(await screen.findByRole('button', { name: 'Use my recovery key' }));
    const other = await createKeySetup({ owner: 'jascha', passphrase: PASSPHRASE, kdf: FAST });
    await userEvent.type(screen.getByLabelText('Recovery key'), other.recoveryKey);
    await userEvent.type(screen.getByLabelText('New passphrase', { selector: 'input' }), NEW_PASSPHRASE);
    await userEvent.type(screen.getByLabelText('New passphrase again', { selector: 'input' }), NEW_PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Unlock with the recovery key' }));
    expect(await screen.findByText('Wrong passphrase or recovery key.')).toBeInTheDocument();
    expect(replaceSlots).not.toHaveBeenCalled();
    expect(onUnlocked).not.toHaveBeenCalled();
  });
});
