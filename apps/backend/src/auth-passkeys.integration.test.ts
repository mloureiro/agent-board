import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from './server';
import { createSession } from './services/auth/sessions';
import { loginConfig, useTestDb } from './test/helpers';
import { rpc } from './test/rpc';
import { SoftwareAuthenticator } from './test/softwareAuthenticator';

const { db, admin } = await useTestDb();

const SIGNUP_TOKEN = 'signup-token-0123456789abcdef0123456789';

const open: { close(): Promise<unknown> }[] = [];
afterEach(() => Promise.all(open.splice(0).map((app) => app.close())));

async function serve(overrides: Parameters<typeof loginConfig>[0] = {}) {
  const config = loginConfig(overrides);
  const app = await buildServer(config, db);
  open.push(app);
  return { app, session: (owner: string) => createSession({ root: db, login: config.auth }, owner, 'passkey') };
}

type App = Awaited<ReturnType<typeof serve>>['app'];

interface Options {
  flow: string;
  options: {
    challenge: string;
    rp?: { id: string };
    user?: { id: string };
    excludeCredentials?: { id: string }[];
    allowCredentials?: unknown[];
    userVerification?: string;
    authenticatorSelection?: { residentKey: string; userVerification: string };
  };
}

async function register(app: App, token: string, authenticator: SoftwareAuthenticator, name = 'Laptop') {
  const { data } = await rpc<Options>(app, 'passkeys.registerOptions', undefined, { token });
  return rpc(
    app,
    'passkeys.register',
    { flow: data!.flow, response: authenticator.register(data!.options), name },
    { token },
  );
}

const loginOptions = async (app: App) => (await rpc<Options>(app, 'auth.passkey.loginOptions')).data!;
const meOf = async (app: App, token: string) =>
  (await rpc<{ username: string }>(app, 'me', undefined, { token, type: 'query' })).data?.username;
const sessionCount = async () => (await admin.execute(sql`select 1 from session`)).rows.length;

describe('registering a passkey while signed in', () => {
  it('asks for a resident, user-verified credential bound to the user, and stores it', async () => {
    const { app, session } = await serve();
    const token = await session('alice');
    const { data } = await rpc<Options>(app, 'passkeys.registerOptions', undefined, { token });
    expect(data!.options.rp).toMatchObject({ id: 'localhost' });
    expect(data!.options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(data!.options.user!.id).toBe(createHash('sha256').update('agent-board-user:alice').digest('base64url'));
    expect(data!.options.excludeCredentials).toEqual([]);

    const authenticator = new SoftwareAuthenticator();
    expect((await register(app, token, authenticator, '  Work laptop ')).status).toBe(200);
    const listed = await rpc<{ id: string; name: string; lastUsedAt: string | null }[]>(
      app,
      'passkeys.list',
      undefined,
      { token, type: 'query' },
    );
    expect(listed.data).toMatchObject([{ id: authenticator.id, name: 'Work laptop', lastUsedAt: null }]);

    const again = await rpc<Options>(app, 'passkeys.registerOptions', undefined, { token });
    expect(again.data!.options.excludeCredentials).toMatchObject([{ id: authenticator.id }]);
  });

  it('needs a signed-in user', async () => {
    const { app } = await serve();
    for (const path of [
      'passkeys.registerOptions',
      'passkeys.list',
      'passkeys.register',
      'passkeys.rename',
      'passkeys.remove',
    ]) {
      expect(
        (await rpc(app, path, undefined, { type: path === 'passkeys.list' ? 'query' : 'mutation' })).status,
        path,
      ).toBe(401);
    }
  });

  it('refuses a response for another challenge, origin or flow, and a flow of another user', async () => {
    const { app, session } = await serve();
    const alice = await session('alice');
    const bob = await session('bob');
    const authenticator = new SoftwareAuthenticator();
    const mint = async (token = alice) =>
      (await rpc<Options>(app, 'passkeys.registerOptions', undefined, { token })).data!;

    const first = await mint();
    expect(
      (
        await rpc(
          app,
          'passkeys.register',
          { flow: first.flow, response: authenticator.register(first.options, { challenge: 'AAAA' }), name: 'x' },
          { token: alice },
        )
      ).status,
    ).toBe(400);
    const second = await mint();
    expect(
      (
        await rpc(
          app,
          'passkeys.register',
          {
            flow: second.flow,
            response: authenticator.register(second.options, { origin: 'https://evil.example' }),
            name: 'x',
          },
          { token: alice },
        )
      ).status,
    ).toBe(400);
    const third = await mint();
    expect(
      (
        await rpc(
          app,
          'passkeys.register',
          { flow: third.flow, response: authenticator.register(third.options), name: 'x' },
          { token: bob },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await rpc(
          app,
          'passkeys.register',
          { flow: 'nope', response: authenticator.register(third.options), name: 'x' },
          { token: alice },
        )
      ).status,
    ).toBe(401);
    expect((await rpc(app, 'passkeys.list', undefined, { token: alice, type: 'query' })).data).toEqual([]);
  });

  it('accepts a registration once', async () => {
    const { app, session } = await serve();
    const token = await session('alice');
    const authenticator = new SoftwareAuthenticator();
    const { data } = await rpc<Options>(app, 'passkeys.registerOptions', undefined, { token });
    const body = { flow: data!.flow, response: authenticator.register(data!.options), name: 'x' };
    expect((await rpc(app, 'passkeys.register', body, { token })).status).toBe(200);
    expect((await rpc(app, 'passkeys.register', body, { token })).status).toBe(401);
  });

  it('keeps device names to a line of at most 60 characters', async () => {
    const { app, session } = await serve();
    const token = await session('alice');
    expect((await register(app, token, new SoftwareAuthenticator(), 'x'.repeat(61))).status).toBe(400);
    expect((await register(app, token, new SoftwareAuthenticator(), '   ')).status).toBe(400);
    expect((await register(app, token, new SoftwareAuthenticator(), 'x'.repeat(60))).status).toBe(200);
  });
});

describe('managing passkeys', () => {
  it('renames and removes only the user’s own', async () => {
    const { app, session } = await serve();
    const alice = await session('alice');
    const bob = await session('bob');
    const mine = new SoftwareAuthenticator();
    const his = new SoftwareAuthenticator();
    await register(app, alice, mine);
    await register(app, bob, his);

    expect((await rpc(app, 'passkeys.rename', { id: mine.id, name: 'Phone' }, { token: alice })).status).toBe(200);
    expect((await rpc(app, 'passkeys.rename', { id: his.id, name: 'Mine now' }, { token: alice })).status).toBe(404);
    expect((await rpc(app, 'passkeys.rename', { id: mine.id, name: '' }, { token: alice })).status).toBe(400);
    expect((await rpc(app, 'passkeys.remove', { id: his.id }, { token: alice })).status).toBe(404);
    expect((await rpc(app, 'passkeys.list', undefined, { token: alice, type: 'query' })).data).toMatchObject([
      { name: 'Phone' },
    ]);
    expect((await rpc(app, 'passkeys.list', undefined, { token: bob, type: 'query' })).data).toMatchObject([
      { name: 'Laptop' },
    ]);

    expect((await rpc(app, 'passkeys.remove', { id: mine.id }, { token: alice })).status).toBe(200);
    expect((await rpc(app, 'passkeys.list', undefined, { token: alice, type: 'query' })).data).toEqual([]);
    // A removed passkey signs nobody in.
    const options = await loginOptions(app);
    const login = await rpc(app, 'auth.passkey.login', { flow: options.flow, response: mine.assert(options.options) });
    expect(login.status).toBe(401);
  });
});

describe('signing in with a passkey', () => {
  async function registered(owner = 'alice') {
    const served = await serve();
    const authenticator = new SoftwareAuthenticator();
    await register(served.app, await served.session(owner), authenticator);
    await admin.execute(sql`delete from session`);
    return { ...served, authenticator };
  }

  it('asks for a discoverable, user-verified credential and signs the owner in', async () => {
    const { app, authenticator } = await registered();
    const options = await loginOptions(app);
    expect(options.options.rp?.id ?? (options.options as { rpId?: string }).rpId).toBe('localhost');
    expect(options.options.allowCredentials ?? []).toEqual([]);
    expect(options.options.userVerification).toBe('required');
    const login = await rpc(app, 'auth.passkey.login', {
      flow: options.flow,
      response: authenticator.assert(options.options),
    });
    expect(login.status).toBe(200);
    expect(login.data).toEqual({ ok: true });
    expect(login.setCookies).toEqual([
      `board-session=${login.sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${400 * 24 * 60 * 60}`,
    ]);
    expect(await meOf(app, login.sessionToken!)).toBe('alice');
    const { rows } = await admin.execute<{ counter: string; last_used_at: Date | null }>(
      sql`select counter, last_used_at from passkey`,
    );
    expect(rows[0]?.counter).toBe('1');
    expect(rows[0]?.last_used_at).not.toBeNull();
  });

  it('refuses a signature over another challenge, or from another origin', async () => {
    const { app, authenticator } = await registered();
    const first = await loginOptions(app);
    const wrongChallenge = await rpc(app, 'auth.passkey.login', {
      flow: first.flow,
      response: authenticator.assert(first.options, { challenge: 'AAAAAAAA' }),
    });
    expect(wrongChallenge).toMatchObject({ status: 401, message: 'Sign-in failed.' });
    const second = await loginOptions(app);
    const wrongOrigin = await rpc(app, 'auth.passkey.login', {
      flow: second.flow,
      response: authenticator.assert(second.options, { origin: 'https://evil.example' }),
    });
    expect(wrongOrigin.status).toBe(401);
    expect(await sessionCount()).toBe(0);
  });

  it('refuses a credential the board does not know', async () => {
    const { app } = await registered();
    const options = await loginOptions(app);
    const stranger = new SoftwareAuthenticator();
    expect(
      (await rpc(app, 'auth.passkey.login', { flow: options.flow, response: stranger.assert(options.options) })).status,
    ).toBe(401);
  });

  it('accepts a flow once', async () => {
    const { app, authenticator } = await registered();
    const options = await loginOptions(app);
    const body = { flow: options.flow, response: authenticator.assert(options.options) };
    expect((await rpc(app, 'auth.passkey.login', body)).status).toBe(200);
    expect((await rpc(app, 'auth.passkey.login', body)).status).toBe(401);
    expect(await sessionCount()).toBe(1);
  });

  it('sets no cookie for a refused sign-in', async () => {
    const { app } = await registered();
    const options = await loginOptions(app);
    const stranger = new SoftwareAuthenticator();
    const refused = await rpc(app, 'auth.passkey.login', {
      flow: options.flow,
      response: stranger.assert(options.options),
    });
    expect(refused.status).toBe(401);
    expect(refused.setCookies).toEqual([]);
  });

  it('replaces a stale cookie with the new one, and still sets it when the call is batched', async () => {
    const { app, authenticator } = await registered();
    const options = await loginOptions(app);
    const answer = await app.inject({
      method: 'POST',
      url: '/trpc/auth.passkey.login,auth.passkey.loginOptions?batch=1',
      headers: { 'content-type': 'application/json', cookie: `board-session=abs_${'x'.repeat(43)}` },
      payload: JSON.stringify({
        '0': { flow: options.flow, response: authenticator.assert(options.options) },
        '1': null,
      }),
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject([
      { result: { data: { ok: true } } },
      { result: { data: { flow: expect.any(String) } } },
    ]);
    const cookies = [answer.headers['set-cookie'] ?? []].flat();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^board-session=abs_[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  });

  it('refuses a flow that expired, or a made-up one', async () => {
    const { app, authenticator } = await registered();
    const options = await loginOptions(app);
    await admin.execute(sql`update auth_flow set expires_at = now() - interval '1 second'`);
    expect(
      (await rpc(app, 'auth.passkey.login', { flow: options.flow, response: authenticator.assert(options.options) }))
        .status,
    ).toBe(401);
    expect(
      (await rpc(app, 'auth.passkey.login', { flow: 'x', response: authenticator.assert(options.options) })).status,
    ).toBe(401);
  });

  it('refuses a counter that did not advance', async () => {
    const { app, authenticator } = await registered();
    const login = async (counter: number) => {
      const options = await loginOptions(app);
      return rpc(app, 'auth.passkey.login', {
        flow: options.flow,
        response: authenticator.assert(options.options, { counter }),
      });
    };
    expect((await login(5)).status).toBe(200);
    expect((await login(3)).status).toBe(401);
    expect((await login(5)).status).toBe(401);
    expect((await login(6)).status).toBe(200);
  });

  it('is not offered when passkeys are off', async () => {
    const { app } = await serve({
      passkeys: false,
      saml: {
        entryPoint: 'https://idp.example.test/sso',
        idpCert: 'x',
        issuer: 'x',
        usernameAttribute: null,
        label: 'SSO',
      },
    });
    expect((await rpc(app, 'auth.passkey.loginOptions')).status).toBe(404);
    expect((await rpc(app, 'auth.config', undefined, { type: 'query' })).data).toMatchObject({
      passkeys: false,
      signup: false,
    });
  });
});

describe('signing up with a passkey', () => {
  async function open_() {
    const served = await serve({ signupToken: SIGNUP_TOKEN });
    const options = (username: string, signupToken = SIGNUP_TOKEN) =>
      rpc<Options>(served.app, 'auth.passkey.signupOptions', { username, signupToken });
    return { ...served, options };
  }

  it('is advertised only with a token configured', async () => {
    const { app } = await open_();
    expect((await rpc(app, 'auth.config', undefined, { type: 'query' })).data).toMatchObject({ signup: true });
    const closed = await serve();
    expect((await rpc(closed.app, 'auth.config', undefined, { type: 'query' })).data).toMatchObject({ signup: false });
    expect(
      await rpc(closed.app, 'auth.passkey.signupOptions', { username: 'new', signupToken: SIGNUP_TOKEN }),
    ).toMatchObject({ status: 403 });
  });

  it('creates the account with its first passkey and signs it in', async () => {
    const { app, options } = await open_();
    const started = await options(' New.User ');
    expect(started.status).toBe(200);
    const authenticator = new SoftwareAuthenticator();
    const done = await rpc(app, 'auth.passkey.signup', {
      flow: started.data!.flow,
      response: authenticator.register(started.data!.options),
      name: 'Phone',
    });
    expect(done.status).toBe(200);
    expect(await meOf(app, done.sessionToken!)).toBe('new.user');
    expect(
      (await rpc(app, 'passkeys.list', undefined, { token: done.sessionToken!, type: 'query' })).data,
    ).toMatchObject([{ name: 'Phone' }]);
    const login = await loginOptions(app);
    expect(
      (await rpc(app, 'auth.passkey.login', { flow: login.flow, response: authenticator.assert(login.options) }))
        .status,
    ).toBe(200);
  });

  it('answers a wrong token the same for a name that is taken and one that is not', async () => {
    const { app, options, session } = await open_();
    await session('taken');
    const free = await options('free', 'wrong-token');
    const taken = await options('taken', 'wrong-token');
    expect(free).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect({ ...taken, data: undefined }).toEqual({ ...free, data: undefined });
    expect(taken.message).toBe(free.message);
    // Only a caller with the token learns the name is gone.
    expect(await options('taken')).toMatchObject({ status: 409 });
    expect(await rpc(app, 'auth.passkey.signupOptions', { username: 'free', signupToken: '' })).toMatchObject({
      status: 403,
    });
  });

  it('keeps sign-up names to the tighter rule', async () => {
    const { options } = await open_();
    for (const bad of ['', '-lead', 'has space', 'UPPER ok? no', 'x'.repeat(65), 'sla/sh', 'tab\tname']) {
      expect((await options(bad)).status, bad).toBe(400);
    }
    expect((await options('a@b.example-1_2')).status).toBe(200);
  });

  it('refuses a name taken between the options and the finish, and a replayed flow', async () => {
    const { app, options, session } = await open_();
    const started = await options('racer');
    await session('racer');
    const authenticator = new SoftwareAuthenticator();
    const body = { flow: started.data!.flow, response: authenticator.register(started.data!.options) };
    expect(await rpc(app, 'auth.passkey.signup', body)).toMatchObject({ status: 409 });
    expect((await rpc(app, 'auth.passkey.signup', body)).status).toBe(401);
    expect((await admin.execute(sql`select 1 from passkey`)).rows).toHaveLength(0);
  });

  it('refuses a response for another challenge', async () => {
    const { app, options } = await open_();
    const started = await options('someone');
    const authenticator = new SoftwareAuthenticator();
    const done = await rpc(app, 'auth.passkey.signup', {
      flow: started.data!.flow,
      response: authenticator.register(started.data!.options, { challenge: 'AAAA' }),
    });
    expect(done.status).toBe(401);
    expect((await admin.execute(sql`select 1 from app_user`)).rows).toHaveLength(0);
  });
});
