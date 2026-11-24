import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_MARKER_KEY } from '../lib/session';
import { LoginPage } from './LoginPage';
import { authConfig, mutations, rawClient, renderAt, trpcFacade, type TestConfig } from './loginTestSupport';

const supported = vi.hoisted(() => ({ current: true }));
const passkey = vi.hoisted(() => ({
  authenticate: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../lib/trpc', () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  useRawTRPCClient: () => rawClient,
  useTRPC: () => trpcFacade,
}));
vi.mock('@simplewebauthn/browser', () => ({ browserSupportsWebAuthn: () => supported.current }));
vi.mock('./webauthn', () => ({
  authenticateWithPasskey: passkey.authenticate,
  createPasskey: passkey.create,
}));

const everything: TestConfig = {
  login: true,
  passkeys: true,
  signup: true,
  oidc: { label: 'Sign in with Authelia' },
  saml: { label: 'Sign in with Acme SSO' },
};

const assign = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  authConfig.current = everything;
  supported.current = true;
  for (const mock of [...Object.values(mutations), passkey.authenticate, passkey.create, assign]) mock.mockReset();
  vi.stubGlobal('location', {
    protocol: 'https:',
    pathname: '/',
    search: '',
    assign,
    href: 'https://board.test/',
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const button = (name: string | RegExp) => screen.findByRole('button', { name });

describe('the sign-in page', () => {
  it('has one button per way the board offers, titled for the board', async () => {
    renderAt(<LoginPage />);
    expect(await screen.findByText('Sign in to Agent Board')).toBeInTheDocument();
    expect(await button('Sign in with a passkey')).toBeEnabled();
    expect(await button('Sign in with Authelia')).toBeEnabled();
    expect(await button('Sign in with Acme SSO')).toBeEnabled();
    expect(await button('Create an account')).toBeInTheDocument();
  });

  it('leaves out what the board does not offer', async () => {
    authConfig.current = { login: true, passkeys: false, signup: false, oidc: { label: 'Company login' }, saml: null };
    renderAt(<LoginPage />);
    expect(await button('Company login')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create an account' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button').map((each) => each.textContent)).toEqual([
      'Company login',
      'Sign in with your browser',
    ]);
  });

  it('shows a label from the server as text, never as markup', async () => {
    authConfig.current = {
      login: true,
      passkeys: false,
      signup: false,
      oidc: { label: '<img src=x onerror=alert(1)><b>Bold</b>' },
      saml: null,
    };
    renderAt(<LoginPage />);
    expect(await button('<img src=x onerror=alert(1)><b>Bold</b>')).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  it('shows a single redirect method as a button and does not follow it on its own', async () => {
    authConfig.current = { login: true, passkeys: false, signup: false, oidc: null, saml: { label: 'SSO' } };
    renderAt(<LoginPage />);
    expect(await button('SSO')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(mutations.samlStart).not.toHaveBeenCalled();
  });

  it('says so when the board has no sign-in', async () => {
    authConfig.current = { login: false };
    renderAt(<LoginPage />);
    expect(await screen.findByText('This board has no sign-in set up.')).toBeInTheDocument();
  });

  it('shows why an earlier sign-in failed', async () => {
    renderAt(<LoginPage failure="The sign-in was refused: access_denied" />);
    expect(await screen.findByText('The sign-in was refused: access_denied')).toBeInTheDocument();
  });

  it('disables the passkey button and says why when the browser has no WebAuthn', async () => {
    supported.current = false;
    renderAt(<LoginPage />);
    expect(await button('Sign in with a passkey')).toBeDisabled();
    expect(screen.getByText('This browser does not support passkeys.')).toBeInTheDocument();
    expect(await button('Sign in with Authelia')).toBeEnabled();
  });
});

describe('signing in with the browser', () => {
  it('is offered below the other methods, whatever the board offers', async () => {
    authConfig.current = { login: true, passkeys: false, signup: false, oidc: null, saml: null };
    renderAt(<LoginPage />);
    expect(await button('Sign in with your browser')).toBeEnabled();
  });

  it('is absent when the board has no sign-in', async () => {
    authConfig.current = { login: false };
    renderAt(<LoginPage />);
    await screen.findByText('This board has no sign-in set up.');
    expect(screen.queryByRole('button', { name: 'Sign in with your browser' })).not.toBeInTheDocument();
  });

  it('is not offered on the approval page a hand-off links to, which keeps the other methods', async () => {
    renderAt(<LoginPage />, '/handoff/f9');
    expect(await button('Sign in with a passkey')).toBeEnabled();
    expect(screen.getAllByRole('button').map((each) => each.textContent)).toEqual([
      'Sign in with a passkey',
      'Sign in with Authelia',
      'Sign in with Acme SSO',
      'Create an account',
    ]);
  });

  it('swaps the methods for the code, and cancelling brings them back and stops checking', async () => {
    mutations.handoffStart.mockResolvedValue({ flow: 'f9', code: 'K7Q-4MD' });
    mutations.handoffFinish.mockResolvedValue({ status: 'pending' });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    renderAt(<LoginPage />);
    await userEvent.click(await button('Sign in with your browser'));
    expect(await screen.findByText('K7Q-4MD')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await button('Sign in with a passkey')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(mutations.handoffFinish).not.toHaveBeenCalled();
  });
});

describe('signing in with a passkey', () => {
  const options = { challenge: 'c' };
  const assertion = { id: 'a', type: 'public-key' };

  it('asks the authenticator and tells the other tabs, then goes to the page first asked for', async () => {
    mutations.loginOptions.mockResolvedValue({ flow: 'f1', options });
    passkey.authenticate.mockResolvedValue(assertion);
    mutations.login.mockResolvedValue({ ok: true });
    const { resetQueries } = renderAt(<LoginPage />, '/t/abc?x=1');
    await userEvent.click(await button('Sign in with a passkey'));
    await waitFor(() => expect(localStorage.getItem(SESSION_MARKER_KEY)).not.toBeNull());
    expect(passkey.authenticate).toHaveBeenCalledWith(options);
    expect(mutations.login).toHaveBeenCalledWith({ flow: 'f1', response: assertion });
    expect(resetQueries).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/t/abc?x=1'));
  });

  it('shows the server’s message in the card when the sign-in is refused', async () => {
    mutations.loginOptions.mockResolvedValue({ flow: 'f1', options });
    passkey.authenticate.mockResolvedValue(assertion);
    mutations.login.mockRejectedValue(new Error('That passkey is not registered.'));
    renderAt(<LoginPage />);
    await userEvent.click(await button('Sign in with a passkey'));
    expect(await screen.findByText('That passkey is not registered.')).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_MARKER_KEY)).toBeNull();
  });

  it.each(['NotAllowedError', 'AbortError'])(
    'says a cancelled prompt (%s) was cancelled, not as a failure',
    async (name) => {
      mutations.loginOptions.mockResolvedValue({ flow: 'f1', options });
      passkey.authenticate.mockRejectedValue(
        Object.assign(new Error('The operation either timed out or was not allowed.'), { name }),
      );
      renderAt(<LoginPage />);
      await userEvent.click(await button('Sign in with a passkey'));
      const note = await screen.findByText('The passkey prompt was cancelled.');
      expect(note).not.toHaveAttribute('role', 'alert');
      expect(screen.queryByText(/timed out/)).not.toBeInTheDocument();
      expect(mutations.login).not.toHaveBeenCalled();
    },
  );
});

describe('creating an account', () => {
  const fill = async (fields: { username: string; token: string; name?: string }) => {
    await userEvent.click(await button('Create an account'));
    await userEvent.type(await screen.findByLabelText('Username'), fields.username);
    await userEvent.type(screen.getByLabelText('Sign-up token'), fields.token);
    if (fields.name) await userEvent.type(screen.getByLabelText(/Passkey name/), fields.name);
  };

  it('registers a passkey for the username with the sign-up token, and signs in', async () => {
    mutations.signupOptions.mockResolvedValue({ flow: 'f2', options: { challenge: 'c' } });
    passkey.create.mockResolvedValue({ id: 'n', type: 'public-key' });
    mutations.signup.mockResolvedValue({ ok: true });
    renderAt(<LoginPage />);
    await fill({ username: ' newbie ', token: 'secret-token', name: 'laptop' });
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(localStorage.getItem(SESSION_MARKER_KEY)).not.toBeNull());
    expect(mutations.signupOptions).toHaveBeenCalledWith({ username: 'newbie', signupToken: 'secret-token' });
    expect(mutations.signup).toHaveBeenCalledWith({
      flow: 'f2',
      response: { id: 'n', type: 'public-key' },
      name: 'laptop',
    });
  });

  it('leaves the passkey name out when none is given', async () => {
    mutations.signupOptions.mockResolvedValue({ flow: 'f2', options: {} });
    passkey.create.mockResolvedValue({ id: 'n' });
    mutations.signup.mockResolvedValue({ ok: true });
    renderAt(<LoginPage />);
    await fill({ username: 'newbie', token: 't' });
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(mutations.signup).toHaveBeenCalled());
    expect(mutations.signup.mock.calls[0]?.[0]).toEqual({ flow: 'f2', response: { id: 'n' } });
  });

  it('needs a username and the token before it goes on', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await button('Create an account'));
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();
  });

  it('shows the server’s refusal in the card, such as a wrong sign-up token', async () => {
    mutations.signupOptions.mockRejectedValue(new Error('The sign-up token is wrong.'));
    renderAt(<LoginPage />);
    await fill({ username: 'newbie', token: 'nope' });
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('The sign-up token is wrong.')).toBeInTheDocument();
    expect(passkey.create).not.toHaveBeenCalled();
  });

  it('says a cancelled prompt was cancelled', async () => {
    mutations.signupOptions.mockResolvedValue({ flow: 'f2', options: {} });
    passkey.create.mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    renderAt(<LoginPage />);
    await fill({ username: 'newbie', token: 't' });
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('The passkey prompt was cancelled.')).toBeInTheDocument();
    expect(mutations.signup).not.toHaveBeenCalled();
  });

  it('is not offered when the board has no open sign-up', async () => {
    authConfig.current = { ...everything, signup: false } as TestConfig;
    renderAt(<LoginPage />);
    await button('Sign in with a passkey');
    expect(screen.queryByRole('button', { name: 'Create an account' })).not.toBeInTheDocument();
  });
});

describe('signing in through an identity provider', () => {
  it.each([
    ['Sign in with Authelia', 'oidc', mutations.oidcStart],
    ['Sign in with Acme SSO', 'saml', mutations.samlStart],
  ] as const)(
    '%s keeps a verifier, sends its challenge, and follows the address it is given',
    async (label, method, start) => {
      start.mockResolvedValue({ url: 'https://idp.example/authorize?state=s' });
      renderAt(<LoginPage />, '/t/abc');
      await userEvent.click(await button(label));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://idp.example/authorize?state=s'));
      const verifier = sessionStorage.getItem(`agent-board.login.${method}.verifier`);
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const { challenge } = start.mock.calls[0]?.[0] as { challenge: string };
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier ?? ''));
      expect(challenge).toBe(Buffer.from(digest).toString('base64url'));
      expect(sessionStorage.getItem('agent-board.login.return')).toBe('/t/abc');
    },
  );

  it.each(['javascript:alert(1)', 'data:text/html,x', 'http://idp.example/authorize', '//idp.example/x', 'not a url'])(
    'refuses to follow %s',
    async (url) => {
      mutations.oidcStart.mockResolvedValue({ url });
      renderAt(<LoginPage />);
      await userEvent.click(await button('Sign in with Authelia'));
      expect(
        await screen.findByText('The board sent a sign-in address the browser will not open.'),
      ).toBeInTheDocument();
      expect(assign).not.toHaveBeenCalled();
      expect(sessionStorage.getItem('agent-board.login.oidc.verifier')).toBeNull();
    },
  );

  it('follows an http address when the page itself is http, for local development', async () => {
    vi.stubGlobal('location', { protocol: 'http:', pathname: '/', search: '', assign, href: 'http://localhost:5173/' });
    mutations.oidcStart.mockResolvedValue({ url: 'http://localhost:9000/authorize' });
    renderAt(<LoginPage />);
    await userEvent.click(await button('Sign in with Authelia'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://localhost:9000/authorize'));
  });

  it('shows the server’s message when the flow cannot start', async () => {
    mutations.samlStart.mockRejectedValue(new Error('SAML sign-in is not set up.'));
    renderAt(<LoginPage />);
    await userEvent.click(await button('Sign in with Acme SSO'));
    expect(await screen.findByText('SAML sign-in is not set up.')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});
