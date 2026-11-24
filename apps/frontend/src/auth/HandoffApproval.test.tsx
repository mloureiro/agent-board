import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HandoffApproval } from './HandoffApproval';
import { authConfig, mutations, rawClient, renderAt, trpcFacade } from './loginTestSupport';

vi.mock('../lib/trpc', () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  useRawTRPCClient: () => rawClient,
  useRawTRPC: () => trpcFacade,
  useTRPC: () => trpcFacade,
}));
vi.mock('@simplewebauthn/browser', () => ({ browserSupportsWebAuthn: () => true }));

const page = (
  <Routes>
    <Route path="handoff/:flow" element={<HandoffApproval />} />
  </Routes>
);

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  for (const mock of Object.values(mutations)) mock.mockReset();
  authConfig.current = { login: true, passkeys: true, signup: false, oidc: null, saml: null };
  mutations.me.mockResolvedValue({ username: 'ana', keyId: null });
  mutations.handoffDescribe.mockResolvedValue({ code: 'K7Q-4MD' });
});

describe('the approval page', () => {
  it('shows the sign-in page when nobody is signed in, and remembers this page as the way back', async () => {
    mutations.me.mockRejectedValue(
      TRPCClientError.from({
        error: { message: 'Sign in', code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: 401 } },
      }),
    );
    renderAt(page, '/handoff/flow-1');
    expect(await screen.findByText('Sign in to Agent Board')).toBeInTheDocument();
    expect(sessionStorage.getItem('agent-board.login.return')).toBe('/handoff/flow-1');
  });

  it('shows the code and who is approved, and approves only on the click', async () => {
    mutations.handoffApprove.mockResolvedValue({ ok: true });
    renderAt(page, '/handoff/flow-1');
    expect(await screen.findByText('K7Q-4MD')).toBeInTheDocument();
    expect(mutations.handoffDescribe).toHaveBeenCalledWith({ flow: 'flow-1' });
    expect(screen.getByText('ana')).toBeInTheDocument();
    expect(screen.getByText(/Approve only if you started this sign-in/)).toBeInTheDocument();
    expect(mutations.handoffApprove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mutations.handoffApprove).toHaveBeenCalledWith({ flow: 'flow-1' }));
    expect(await screen.findByText('Approved. Go back to the app window; it signs in by itself.')).toBeInTheDocument();
  });

  it('shows the server’s message when the approval is refused and lets the user try again', async () => {
    mutations.handoffApprove.mockRejectedValue(new Error('This sign-in has expired.'));
    renderAt(page, '/handoff/flow-1');
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('This sign-in has expired.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('shows the server’s message when the sign-in is unknown', async () => {
    mutations.handoffDescribe.mockRejectedValue(new Error('This sign-in is unknown or has expired.'));
    renderAt(page, '/handoff/flow-1');
    expect(await screen.findByText('This sign-in is unknown or has expired.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});
