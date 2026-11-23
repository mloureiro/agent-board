import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { SESSION_MARKER_KEY } from './lib/session';

const fetchMe = vi.hoisted(() => vi.fn<() => Promise<{ username: string; keyId: string | null }>>());

vi.mock('./lib/trpc', () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  POLL_MS: 5_000,
  useTRPC: () => ({ me: { queryOptions: () => ({ queryKey: ['me'], queryFn: fetchMe }) } }),
}));

vi.mock('./auth/LoginPage', () => ({ LoginPage: () => <p>the sign-in page</p> }));
vi.mock('./auth/RedirectReturn', () => ({
  RedirectReturn: ({ method }: { method: string }) => <p>finishing {method}</p>,
}));

const refused = () =>
  TRPCClientError.from({
    error: { message: 'Sign in', code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: 401 } },
  });

// Stands in for the unlocked app: state that lives below the gate, like a reply being typed.
vi.mock('./crypto/KeyGate', () => ({
  KeyGate: ({ me }: { me: { username: string } }) => <textarea aria-label={`draft of ${me.username}`} />,
}));

function renderApp(path = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  fetchMe.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

describe('App', () => {
  it('keeps the app and its state when a background refetch of me fails', async () => {
    fetchMe.mockResolvedValueOnce({ username: 'jascha', keyId: 'k1' });
    const queryClient = renderApp();
    await userEvent.type(await screen.findByLabelText('draft of jascha'), 'half a reply');

    fetchMe.mockRejectedValueOnce(new Error('502 Bad Gateway'));
    await queryClient.refetchQueries({ queryKey: ['me'] });

    expect(await screen.findByText('Board unreachable, retrying')).toBeInTheDocument();
    expect(screen.getByLabelText('draft of jascha')).toHaveValue('half a reply');
    expect(screen.queryByText(/No access/)).not.toBeInTheDocument();

    fetchMe.mockResolvedValueOnce({ username: 'jascha', keyId: 'k1' });
    await queryClient.refetchQueries({ queryKey: ['me'] });
    await waitFor(() => expect(screen.queryByText('Board unreachable, retrying')).not.toBeInTheDocument());
    expect(screen.getByLabelText('draft of jascha')).toHaveValue('half a reply');
  });

  it('stops at no access when the first answer is an error', async () => {
    fetchMe.mockRejectedValueOnce(new Error('not allowed on this board'));
    renderApp();
    expect(await screen.findByText('No access: not allowed on this board')).toBeInTheDocument();
    expect(screen.queryByLabelText(/draft of/)).not.toBeInTheDocument();
  });

  it('shows the app to a signed-in user, and the sign-in page to a refused one', async () => {
    fetchMe.mockResolvedValueOnce({ username: 'jascha', keyId: 'k1' });
    renderApp();
    expect(await screen.findByLabelText('draft of jascha')).toBeInTheDocument();
    expect(screen.queryByText('the sign-in page')).not.toBeInTheDocument();
  });

  it('shows the sign-in page when `me` is refused', async () => {
    fetchMe.mockRejectedValueOnce(refused());
    renderApp();
    expect(await screen.findByText('the sign-in page')).toBeInTheDocument();
    expect(screen.queryByText(/No access/)).not.toBeInTheDocument();
  });

  it('does not keep asking while nobody is signed in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMe.mockRejectedValue(refused());
    renderApp();
    expect(await screen.findByText('the sign-in page')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMe).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('moves a session that ends while the app is open to the sign-in page, whatever the last good answer was', async () => {
    fetchMe.mockResolvedValueOnce({ username: 'jascha', keyId: 'k1' });
    const queryClient = renderApp();
    await userEvent.type(await screen.findByLabelText('draft of jascha'), 'half a reply');
    fetchMe.mockRejectedValueOnce(refused());
    await queryClient.refetchQueries({ queryKey: ['me'] });
    expect(await screen.findByText('the sign-in page')).toBeInTheDocument();
    expect(screen.queryByLabelText('draft of jascha')).not.toBeInTheDocument();
    expect(screen.queryByText('Board unreachable, retrying')).not.toBeInTheDocument();
  });

  it('removes every unsent draft when the session has ended', async () => {
    sessionStorage.setItem('agent-board.draft/jascha/k1/reply:t1', '{"value":"half a reply"}');
    sessionStorage.setItem('unrelated', 'x');
    fetchMe.mockRejectedValueOnce(refused());
    renderApp();
    await screen.findByText('the sign-in page');
    expect(sessionStorage.getItem('agent-board.draft/jascha/k1/reply:t1')).toBeNull();
    expect(sessionStorage.getItem('unrelated')).toBe('x');
  });

  it('follows another tab’s sign-in and sign-out', async () => {
    fetchMe.mockRejectedValueOnce(refused());
    renderApp();
    await screen.findByText('the sign-in page');
    fetchMe.mockResolvedValueOnce({ username: 'jascha', keyId: 'k1' });
    window.dispatchEvent(new StorageEvent('storage', { key: SESSION_MARKER_KEY, storageArea: localStorage }));
    expect(await screen.findByLabelText('draft of jascha')).toBeInTheDocument();
    fetchMe.mockRejectedValueOnce(refused());
    window.dispatchEvent(new StorageEvent('storage', { key: SESSION_MARKER_KEY, storageArea: localStorage }));
    expect(await screen.findByText('the sign-in page')).toBeInTheDocument();
  });

  it.each(['oidc', 'saml'])('finishes /login/%s without asking who is signed in', async (method) => {
    renderApp(`/login/${method}`);
    expect(await screen.findByText(`finishing ${method}`)).toBeInTheDocument();
    expect(fetchMe).not.toHaveBeenCalled();
  });
});
