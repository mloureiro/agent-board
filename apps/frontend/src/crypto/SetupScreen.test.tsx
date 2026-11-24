import { parseKeySetup, type KeySetup } from '@agent-board/shared';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recoveryGroups } from '@agent-board/shared/ui';
import { unlockKeys } from './unlocker';
import { SetupScreen } from './SetupScreen';
const setup = vi.hoisted(() => vi.fn(async (_: unknown) => null));

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({ keys: { setup: { mutationOptions: () => ({ mutationFn: setup }) } } }),
  errorMessage: String,
}));

const PASSPHRASE = 'correct horse battery staple';
const FAST = { m: 8192, t: 1, p: 1 };

function renderSetup(onComplete = vi.fn(async () => undefined)) {
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <SetupScreen owner="jascha" kdf={FAST} onComplete={onComplete} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return onComplete;
}

async function choosePassphrase(passphrase = PASSPHRASE) {
  await userEvent.click(screen.getByRole('checkbox', { name: /first time this board is set up/ }));
  await userEvent.type(screen.getByLabelText('Passphrase', { selector: 'input' }), passphrase);
  await userEvent.type(screen.getByLabelText('Passphrase again', { selector: 'input' }), passphrase);
  await userEvent.click(screen.getByRole('button', { name: 'Create my key' }));
}

beforeEach(() => setup.mockClear());

describe('SetupScreen', () => {
  it('says that a board already in use must not be set up again, and needs a deliberate confirmation of a first-time setup', async () => {
    renderSetup();
    expect(screen.getByText(/If this board was already in use, do not set up again/)).toBeInTheDocument();
    expect(screen.getByText(/worker machines do not hold it/)).toBeInTheDocument();
    expect(screen.getByText(/cannot read anything stored under the old one/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Passphrase', { selector: 'input' }), PASSPHRASE);
    await userEvent.type(screen.getByLabelText('Passphrase again', { selector: 'input' }), PASSPHRASE);
    expect(screen.getByRole('button', { name: 'Create my key' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /first time this board is set up/ }));
    expect(screen.getByRole('button', { name: 'Create my key' })).toBeEnabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /first time this board is set up/ }));
    expect(screen.getByRole('button', { name: 'Create my key' })).toBeDisabled();
  });

  it('refuses a short passphrase and one typed twice differently', async () => {
    renderSetup();
    await userEvent.type(screen.getByLabelText('Passphrase', { selector: 'input' }), 'too short');
    expect(screen.getByText(/at least 14 characters/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create my key' })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Passphrase', { selector: 'input' }));
    await userEvent.type(screen.getByLabelText('Passphrase', { selector: 'input' }), PASSPHRASE);
    await userEvent.type(screen.getByLabelText('Passphrase again', { selector: 'input' }), 'something else entirely');
    expect(screen.getByText('The passphrases differ.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create my key' })).toBeDisabled();
  });

  it('shows the recovery key once, sends nothing until it is confirmed, and stores slots both secrets open', async () => {
    const onComplete = renderSetup();
    await choosePassphrase();
    const shown = (await screen.findByTestId('recovery-key')).textContent ?? '';
    const groups = recoveryGroups(shown);
    expect(groups).toHaveLength(14);
    expect(screen.getByText(/lose both the passphrase and the recovery key/)).toBeInTheDocument();
    expect(setup).not.toHaveBeenCalled();

    const finish = screen.getByRole('button', { name: 'Finish setup' });
    expect(finish).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Group 3'), groups[2] ?? '');
    await userEvent.type(screen.getByLabelText('Group 11'), 'WRONG');
    await userEvent.click(screen.getByRole('checkbox'));
    expect(finish).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Group 11'));
    await userEvent.type(screen.getByLabelText('Group 11'), (groups[10] ?? '').toLowerCase());
    expect(finish).toBeEnabled();
    await userEvent.click(finish);

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    const sent = setup.mock.calls[0]?.[0] as KeySetup;
    expect(parseKeySetup(sent)).toEqual(sent);
    const byPassphrase = await unlockKeys({
      owner: 'jascha',
      stored: sent,
      secret: { kind: 'passphrase', passphrase: PASSPHRASE },
    });
    const byRecovery = await unlockKeys({
      owner: 'jascha',
      stored: sent,
      secret: { kind: 'recovery', recoveryKey: shown },
    });
    expect(byPassphrase.keyId).toBe(sent.keyId);
    expect(byRecovery.keyId).toBe(sent.keyId);
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ keyId: sent.keyId, owner: 'jascha' }));
  });
});
