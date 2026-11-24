import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createDraftStore } from '../lib/drafts';
import type { Proposal } from '@agent-board/shared/ui';
import { createMemoryDraftStorage } from '../test/draftStorage';
import { confirmStart } from './confirmStart';

const proposal: Proposal = {
  id: 'prop0001',
  status: 'backlog',
  input: 'the agent’s prompt',
  createdBy: 'agent',
  scheduleId: null,
  unreadable: [],
};

describe('confirmStart', () => {
  it('shows the prompt as edited when the confirmation is closed and opened again', async () => {
    const store = createDraftStore({ username: 'jascha', keyId: 'k1' }, createMemoryDraftStorage());
    render(
      <MantineProvider>
        <ModalsProvider>
          <p>page</p>
        </ModalsProvider>
      </MantineProvider>,
    );
    const open = () =>
      act(() => {
        confirmStart(proposal, store, () => undefined);
      });
    open();
    const prompt = await screen.findByTestId('proposal-prompt');
    expect(prompt).toHaveValue('the agent’s prompt');
    await userEvent.type(prompt, ' plus mine');

    const close = document.querySelector<HTMLElement>('.mantine-Modal-close');
    await userEvent.click(close!);
    await waitFor(() => expect(screen.queryByTestId('proposal-prompt')).not.toBeInTheDocument());

    open();
    expect(await screen.findByTestId('proposal-prompt')).toHaveValue('the agent’s prompt plus mine');
  });
});
