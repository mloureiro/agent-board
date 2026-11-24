import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_MARKER_KEY } from '../lib/session';
import { BrowserHandoff } from './BrowserHandoff';
import { mutations, rawClient, renderAt, trpcFacade } from './loginTestSupport';

vi.mock('../lib/trpc', () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  useRawTRPCClient: () => rawClient,
  useTRPC: () => trpcFacade,
}));

const onCancel = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  onCancel.mockReset();
  for (const mock of Object.values(mutations)) mock.mockReset();
  mutations.handoffStart.mockResolvedValue({ flow: 'flow-1', code: 'K7Q-4MD' });
  mutations.handoffFinish.mockResolvedValue({ status: 'pending' });
});
afterEach(() => {
  vi.useRealTimers();
});

const started = async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  renderAt(<BrowserHandoff onCancel={onCancel} />, '/');
  expect(await screen.findByText('K7Q-4MD')).toBeInTheDocument();
};

describe('the window panel', () => {
  it('starts with a 43-character challenge, shows the code and links to the approval page in a new window', async () => {
    await started();
    const challenge = mutations.handoffStart.mock.calls[0]?.[0]?.challenge as string;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const link = screen.getByRole('link', { name: 'Open in your browser' });
    expect(link).toHaveAttribute('href', `${window.location.origin}/handoff/flow-1`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByText('Waiting for approval…')).toBeInTheDocument();
  });

  it('keeps checking while the answer is pending, then signs in and goes to the page first asked for', async () => {
    sessionStorage.setItem('agent-board.login.return', '/t/abc');
    await started();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(mutations.handoffFinish).toHaveBeenCalledTimes(2);
    const verifier = mutations.handoffFinish.mock.calls[0]?.[0]?.verifier as string;
    expect(mutations.handoffFinish).toHaveBeenCalledWith({ flow: 'flow-1', verifier });
    mutations.handoffFinish.mockResolvedValue({ status: 'signed-in' });
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(localStorage.getItem(SESSION_MARKER_KEY)).not.toBeNull();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/t\/abc$/);
    const calls = mutations.handoffFinish.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(mutations.handoffFinish).toHaveBeenCalledTimes(calls);
  });

  it('checks when the window gets focus and when the user asks', async () => {
    await started();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(mutations.handoffFinish).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(mutations.handoffFinish).toHaveBeenCalledTimes(2));
  });

  it('runs one check at a time', async () => {
    await started();
    let release: (value: unknown) => void = () => undefined;
    mutations.handoffFinish.mockReturnValue(new Promise((resolve) => (release = resolve)));
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(mutations.handoffFinish).toHaveBeenCalledTimes(1);
    release({ status: 'pending' });
  });

  it('shows the server’s message, stops checking and offers to start again', async () => {
    await started();
    mutations.handoffFinish.mockRejectedValue(new Error('This sign-in has expired.'));
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('This sign-in has expired.')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(mutations.handoffFinish).toHaveBeenCalledTimes(1);
    mutations.handoffStart.mockResolvedValue({ flow: 'flow-2', code: 'ABC-123' });
    await userEvent.click(screen.getByRole('button', { name: 'Start again' }));
    expect(await screen.findByText('ABC-123')).toBeInTheDocument();
    expect(mutations.handoffStart).toHaveBeenCalledTimes(2);
  });
});
