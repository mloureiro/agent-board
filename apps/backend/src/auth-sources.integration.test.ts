import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OidcConfig, SamlConfig } from './config';
import { appUsers } from './db/schema';
import { buildServer } from './server';
import { FakeOidcIdp } from './test/fakeOidcIdp';
import { generateSamlKeyPair, requestIdOf, samlResponse, type SamlKeyPair } from './test/fakeSamlIdp';
import { loginConfig, useTestDb } from './test/helpers';
import { pkcePair, rpc } from './test/rpc';
import { SoftwareAuthenticator } from './test/softwareAuthenticator';

// Which sign-in method owns a board's name: the method that created it, or, for a board from before sign-in, the first
// OIDC or SAML sign-in to claim it. A passkey signs in to its owner whatever the source.
const { db, admin } = await useTestDb();
const oidcIdp = new FakeOidcIdp();
const SIGNUP_TOKEN = 'signup-token-0123456789abcdef0123456789';
const SP = 'https://board.example.test/saml/sp';
const ACS = 'http://localhost:5173/api/auth/saml/acs';
const REFUSED = 'This name belongs to an account with a different sign-in method.';

let samlIdp: SamlKeyPair;
beforeAll(async () => {
  samlIdp = generateSamlKeyPair();
  await oidcIdp.start();
});
afterAll(() => oidcIdp.stop());

const open: { close(): Promise<unknown> }[] = [];
afterEach(() => Promise.all(open.splice(0).map((app) => app.close())));

async function serve() {
  const oidc: OidcConfig = {
    issuer: new URL(oidcIdp.issuer),
    clientId: oidcIdp.clientId,
    clientSecret: oidcIdp.clientSecret,
    scopes: 'openid profile email',
    usernameClaim: 'preferred_username',
    groupsClaim: 'groups',
    label: 'Corp',
  };
  const saml: SamlConfig = {
    entryPoint: 'https://idp.example.test/sso',
    idpCert: samlIdp.certificate,
    issuer: SP,
    usernameAttribute: null,
    label: 'Corp SAML',
  };
  const app = await buildServer(loginConfig({ oidc, saml, signupToken: SIGNUP_TOKEN }), db, {
    allowInsecureOidc: true,
  });
  open.push(app);
  return app;
}

type App = Awaited<ReturnType<typeof serve>>;

async function oidcSignIn(app: App, username: string) {
  const { verifier, challenge } = pkcePair();
  const started = await rpc<{ url: string }>(app, 'auth.oidc.start', { challenge });
  const { code, state } = oidcIdp.approve(started.data!.url, { idToken: { preferred_username: username } });
  return rpc(app, 'auth.oidc.finish', { code, state, verifier });
}

async function samlSignIn(app: App, username: string) {
  const { verifier, challenge } = pkcePair();
  const started = await rpc<{ url: string }>(app, 'auth.saml.start', { challenge });
  const response = samlResponse(samlIdp, {
    inResponseTo: requestIdOf(started.data!.url),
    audience: SP,
    acsUrl: ACS,
    nameId: username,
  });
  const acs = await app.inject({
    method: 'POST',
    url: '/api/auth/saml/acs',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ SAMLResponse: response }).toString(),
  });
  const flow = new URL(acs.headers.location ?? '', 'http://localhost').searchParams.get('flow') ?? '';
  return rpc(app, 'auth.saml.finish', { flow, verifier });
}

async function passkeySignup(app: App, username: string, authenticator = new SoftwareAuthenticator()) {
  const started = await rpc<{ flow: string; options: never }>(app, 'auth.passkey.signupOptions', {
    username,
    signupToken: SIGNUP_TOKEN,
  });
  if (started.status !== 200) return { started, done: undefined, authenticator };
  const done = await rpc(app, 'auth.passkey.signup', {
    flow: started.data!.flow,
    response: authenticator.register(started.data!.options),
    name: 'Laptop',
  });
  return { started, done, authenticator };
}

async function passkeyLogin(app: App, authenticator: SoftwareAuthenticator) {
  const { data } = await rpc<{ flow: string; options: never }>(app, 'auth.passkey.loginOptions');
  return rpc(app, 'auth.passkey.login', { flow: data!.flow, response: authenticator.assert(data!.options) });
}

const sourceOf = async (username: string) =>
  (await admin.select({ source: appUsers.source }).from(appUsers).where(eq(appUsers.username, username)))[0]?.source;
const sessionCount = async () => (await admin.execute(sql`select 1 from session`)).rows.length;
const meOf = async (app: App, token: string) =>
  (await rpc<{ username: string }>(app, 'me', undefined, { token, type: 'query' })).data?.username;

describe('a board’s name belongs to the method that created it', () => {
  it('refuses OIDC for a name a passkey sign-up took, and the passkey keeps its board', async () => {
    const app = await serve();
    const { done, authenticator } = await passkeySignup(app, 'alice');
    expect(done?.status).toBe(200);
    expect(await sourceOf('alice')).toBe('passkey');

    const oidc = await oidcSignIn(app, 'alice');
    expect(oidc).toMatchObject({ status: 403, code: 'FORBIDDEN', message: REFUSED });
    expect(oidc.setCookies).toEqual([]);
    expect(await sessionCount()).toBe(1);
    expect(await sourceOf('alice')).toBe('passkey');
    expect((await passkeyLogin(app, authenticator)).status).toBe(200);
  });

  it('refuses a passkey sign-up for a name OIDC created', async () => {
    const app = await serve();
    expect((await oidcSignIn(app, 'alice')).status).toBe(200);
    expect(await sourceOf('alice')).toBe('oidc');
    const { started } = await passkeySignup(app, 'alice');
    expect(started).toMatchObject({ status: 409, code: 'CONFLICT' });
  });

  it('refuses a passkey sign-up whose name OIDC took after the options were issued', async () => {
    const app = await serve();
    const started = await rpc<{ flow: string; options: never }>(app, 'auth.passkey.signupOptions', {
      username: 'carol',
      signupToken: SIGNUP_TOKEN,
    });
    expect((await oidcSignIn(app, 'carol')).status).toBe(200);
    const done = await rpc(app, 'auth.passkey.signup', {
      flow: started.data!.flow,
      response: new SoftwareAuthenticator().register(started.data!.options),
    });
    expect(done.status).toBe(409);
    expect((await admin.execute(sql`select 1 from passkey`)).rows).toHaveLength(0);
    expect(await sourceOf('carol')).toBe('oidc');
  });

  it('lets OIDC and SAML claim a board from before sign-in, and then holds them to it', async () => {
    const app = await serve();
    await admin.insert(appUsers).values([{ username: 'dora' }, { username: 'erin' }]);
    const dora = await oidcSignIn(app, 'dora');
    expect(dora.status).toBe(200);
    expect(await meOf(app, dora.sessionToken!)).toBe('dora');
    expect(await sourceOf('dora')).toBe('oidc');
    const erin = await samlSignIn(app, 'erin');
    expect(erin.status).toBe(200);
    expect(await sourceOf('erin')).toBe('saml');

    expect(await samlSignIn(app, 'dora')).toMatchObject({ status: 403, message: REFUSED });
    expect(await oidcSignIn(app, 'erin')).toMatchObject({ status: 403, message: REFUSED });
  });

  it('signs OIDC and SAML back in to a board they created, and refuses the other of the two', async () => {
    const app = await serve();
    expect((await oidcSignIn(app, 'fred')).status).toBe(200);
    expect((await oidcSignIn(app, 'fred')).status).toBe(200);
    expect(await samlSignIn(app, 'fred')).toMatchObject({ status: 403, code: 'FORBIDDEN', message: REFUSED });
    expect((await samlSignIn(app, 'gina')).status).toBe(200);
    expect((await samlSignIn(app, 'gina')).status).toBe(200);
    expect(await oidcSignIn(app, 'gina')).toMatchObject({ status: 403 });
    expect(await sessionCount()).toBe(4);
  });

  it('claims a board for one method only when two race for it', async () => {
    const app = await serve();
    await admin.insert(appUsers).values({ username: 'hal' });
    const answers = await Promise.all([oidcSignIn(app, 'hal'), samlSignIn(app, 'hal')]);
    expect(answers.map(({ status }) => status).sort()).toEqual([200, 403]);
    expect(await sessionCount()).toBe(1);
  });

  it('signs an OIDC user in with their own passkey, whatever the source', async () => {
    const app = await serve();
    const oidc = await oidcSignIn(app, 'ida');
    const authenticator = new SoftwareAuthenticator();
    const options = await rpc<{ flow: string; options: never }>(app, 'passkeys.registerOptions', undefined, {
      token: oidc.sessionToken!,
    });
    expect(
      (
        await rpc(
          app,
          'passkeys.register',
          { flow: options.data!.flow, response: authenticator.register(options.data!.options), name: 'Phone' },
          { token: oidc.sessionToken! },
        )
      ).status,
    ).toBe(200);
    await admin.execute(sql`delete from session`);

    const login = await passkeyLogin(app, authenticator);
    expect(login.status).toBe(200);
    expect(await meOf(app, login.sessionToken!)).toBe('ida');
    expect(await sourceOf('ida')).toBe('oidc');
  });

  it('leaves a board without login with no source', async () => {
    const app = await buildServer({ ...loginConfig(), auth: { login: false, user: 'dev' } }, db);
    open.push(app);
    expect((await rpc(app, 'me', undefined, { type: 'query' })).status).toBe(200);
    // A query does not create the row (so that a browser still polling after `account.delete` does not bring it back).
    expect(await sourceOf('dev')).toBeUndefined();
    expect((await rpc(app, 'auth.logout')).status).toBe(200);
    expect(await sourceOf('dev')).toBeNull();
  });
});

describe('removing the last passkey', () => {
  async function addPasskey(app: App, token: string, name: string) {
    const authenticator = new SoftwareAuthenticator();
    const { data } = await rpc<{ flow: string; options: never }>(app, 'passkeys.registerOptions', undefined, { token });
    await rpc(
      app,
      'passkeys.register',
      { flow: data!.flow, response: authenticator.register(data!.options), name },
      { token },
    );
    return authenticator;
  }

  it('is refused for a user whose board a passkey created, until another one is added', async () => {
    const app = await serve();
    const { done, authenticator } = await passkeySignup(app, 'jo');
    const token = done!.sessionToken!;
    const refused = await rpc(app, 'passkeys.remove', { id: authenticator.id }, { token });
    expect(refused).toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(refused.message).toMatch(/only way to sign in/);
    expect((await admin.execute(sql`select 1 from passkey`)).rows).toHaveLength(1);

    const second = await addPasskey(app, token, 'Phone');
    expect((await rpc(app, 'passkeys.remove', { id: authenticator.id }, { token })).status).toBe(200);
    expect((await rpc(app, 'passkeys.remove', { id: second.id }, { token })).status).toBe(409);
    expect((await admin.execute(sql`select 1 from passkey`)).rows).toHaveLength(1);
  });

  it('is allowed for a user who has another way in', async () => {
    const app = await serve();
    const oidc = await oidcSignIn(app, 'kim');
    const only = await addPasskey(app, oidc.sessionToken!, 'Phone');
    expect((await rpc(app, 'passkeys.remove', { id: only.id }, { token: oidc.sessionToken! })).status).toBe(200);

    await admin.insert(appUsers).values({ username: 'lee' });
    const saml = await samlSignIn(app, 'lee');
    const mine = await addPasskey(app, saml.sessionToken!, 'Phone');
    expect((await rpc(app, 'passkeys.remove', { id: mine.id }, { token: saml.sessionToken! })).status).toBe(200);
  });
});
