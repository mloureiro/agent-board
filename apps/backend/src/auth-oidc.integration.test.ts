import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OidcConfig } from './config';
import { buildServer } from './server';
import { FakeOidcIdp, type FakeUser } from './test/fakeOidcIdp';
import { loginConfig, useTestDb } from './test/helpers';
import { pkcePair, rpc } from './test/rpc';

const { db, admin } = await useTestDb();
const idp = new FakeOidcIdp();

beforeAll(() => idp.start());
afterAll(() => idp.stop());

const open: { close(): Promise<unknown> }[] = [];
afterEach(() => Promise.all(open.splice(0).map((app) => app.close())));

async function serve(overrides: { oidc?: Partial<OidcConfig>; allowedGroups?: string[] } = {}) {
  const oidc: OidcConfig = {
    issuer: new URL(idp.issuer),
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    scopes: 'openid profile email',
    usernameClaim: 'preferred_username',
    groupsClaim: 'groups',
    label: 'Corp',
    ...overrides.oidc,
  };
  const app = await buildServer(loginConfig({ oidc, allowedGroups: overrides.allowedGroups ?? [] }), db, {
    allowInsecureOidc: true,
  });
  open.push(app);
  return app;
}

type App = Awaited<ReturnType<typeof serve>>;

/** The browser's side: start, go to the IdP and come back with a code. */
async function signIn(app: App, user: FakeUser, finish: Partial<{ state: string; verifier: string }> = {}) {
  const { verifier, challenge } = pkcePair();
  const started = await rpc<{ url: string }>(app, 'auth.oidc.start', { challenge });
  expect(started.status).toBe(200);
  const { code, state } = idp.approve(started.data!.url, user);
  const input = { code, state: finish.state ?? state, verifier: finish.verifier ?? verifier };
  return {
    started,
    input,
    finish: (override: object = {}) => rpc(app, 'auth.oidc.finish', { ...input, ...override }),
  };
}

const sessionCount = async () => (await admin.execute(sql`select 1 from session`)).rows.length;
const meOf = async (app: App, token: string) =>
  (await rpc<{ username: string }>(app, 'me', undefined, { token, type: 'query' })).data?.username;

describe('OIDC sign-in', () => {
  it('lists the provider’s label in auth.config', async () => {
    const app = await serve();
    expect((await rpc(app, 'auth.config', undefined, { type: 'query' })).data).toMatchObject({
      oidc: { label: 'Corp' },
    });
  });

  it('sends the browser to the IdP with PKCE, a state and a nonce, and signs it in on return', async () => {
    const app = await serve();
    const { started, finish } = await signIn(app, { idToken: { preferred_username: 'Alice' } });
    const params = new URL(started.data!.url).searchParams;
    expect(started.data!.url.startsWith(`${idp.issuer}/authorize?`)).toBe(true);
    expect(Object.fromEntries(params)).toMatchObject({
      response_type: 'code',
      client_id: idp.clientId,
      redirect_uri: 'http://localhost:5173/login/oidc',
      scope: 'openid profile email',
      code_challenge_method: 'S256',
    });
    expect(params.get('state')).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(params.get('nonce')).toBeTruthy();
    const done = await finish();
    expect(done.status).toBe(200);
    expect(await meOf(app, done.sessionToken!)).toBe('alice');
  });

  it('takes the username and groups from the userinfo endpoint when the ID token has none', async () => {
    const app = await serve({ allowedGroups: ['admins'] });
    const { finish } = await signIn(app, { userinfo: { preferred_username: 'bea', groups: ['admins', 'x'] } });
    expect(await meOf(app, (await finish()).sessionToken!)).toBe('bea');
  });

  it('prefers the ID token’s value where both have one', async () => {
    const app = await serve();
    const { finish } = await signIn(app, {
      idToken: { preferred_username: 'from-token' },
      userinfo: { preferred_username: 'from-userinfo' },
    });
    expect(await meOf(app, (await finish()).sessionToken!)).toBe('from-token');
  });

  it('reads the claims the operator names', async () => {
    const app = await serve({ oidc: { usernameClaim: 'email' } });
    const { finish } = await signIn(app, { idToken: { email: 'Cy@Example.com', preferred_username: 'other' } });
    expect(await meOf(app, (await finish()).sessionToken!)).toBe('cy@example.com');
  });

  it('refuses a state it did not issue', async () => {
    const app = await serve();
    const { finish } = await signIn(app, { idToken: { preferred_username: 'alice' } }, { state: 'x'.repeat(32) });
    expect(await finish()).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(await sessionCount()).toBe(0);
  });

  it('refuses another browser’s verifier, and the flow is gone afterwards', async () => {
    const app = await serve();
    const { finish, input } = await signIn(app, { idToken: { preferred_username: 'alice' } });
    expect(await finish({ verifier: pkcePair().verifier })).toMatchObject({ status: 401 });
    expect(await finish({ verifier: input.verifier })).toMatchObject({ status: 401 });
    expect(await sessionCount()).toBe(0);
  });

  it('accepts a flow once', async () => {
    const app = await serve();
    const { finish } = await signIn(app, { idToken: { preferred_username: 'alice' } });
    expect((await finish()).status).toBe(200);
    expect((await finish()).status).toBe(401);
    expect(await sessionCount()).toBe(1);
  });

  it('refuses an expired flow', async () => {
    const app = await serve();
    const { finish } = await signIn(app, { idToken: { preferred_username: 'alice' } });
    await admin.execute(sql`update auth_flow set expires_at = now() - interval '1 second'`);
    expect((await finish()).status).toBe(401);
  });

  it('refuses an ID token for another request’s nonce', async () => {
    const app = await serve();
    const { finish } = await signIn(app, { idToken: { preferred_username: 'alice' }, nonce: 'someone-elses' });
    expect(await finish()).toMatchObject({ status: 401, message: 'Sign-in failed.' });
    expect(await sessionCount()).toBe(0);
  });

  it('refuses a user outside the allowed groups, and takes a group list as a string too', async () => {
    const app = await serve({ allowedGroups: ['admins'] });
    const outsider = await signIn(app, { idToken: { preferred_username: 'alice', groups: ['family'] } });
    expect(await outsider.finish()).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    const noGroups = await signIn(app, { idToken: { preferred_username: 'alice' } });
    expect((await noGroups.finish()).status).toBe(403);
    const insider = await signIn(app, { idToken: { preferred_username: 'alice', groups: 'family, admins' } });
    expect((await insider.finish()).status).toBe(200);
  });

  it('splits a group string on commas only, so a group with a space is one group', async () => {
    const app = await serve({ allowedGroups: ['Admins'] });
    const lookalike = await signIn(app, { idToken: { preferred_username: 'alice', groups: 'Domain Admins' } });
    expect(await lookalike.finish()).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    const spaced = await signIn(app, { idToken: { preferred_username: 'alice', groups: 'Domain Admins, Admins' } });
    expect((await spaced.finish()).status).toBe(200);
    const whole = await serve({ allowedGroups: ['Domain Admins'] });
    const exact = await signIn(whole, { idToken: { preferred_username: 'bea', groups: 'Domain Admins' } });
    expect((await exact.finish()).status).toBe(200);
  });

  it('does not check groups when none are configured', async () => {
    const app = await serve();
    const { finish } = await signIn(app, { idToken: { preferred_username: 'alice', groups: ['family'] } });
    expect((await finish()).status).toBe(200);
  });

  it('refuses a name that is not a usable user name', async () => {
    const app = await serve();
    for (const bad of ['', 'two words', 42, 'x'.repeat(129)]) {
      const { finish } = await signIn(app, { idToken: { preferred_username: bad } });
      expect((await finish()).status, String(bad)).toBe(401);
    }
    const missing = await signIn(app, { idToken: {} });
    expect((await missing.finish()).status).toBe(401);
  });

  it('is not offered when OIDC is not configured', async () => {
    const app = await buildServer(loginConfig(), db);
    open.push(app);
    expect((await rpc(app, 'auth.oidc.start', { challenge: pkcePair().challenge })).status).toBe(404);
  });
});
