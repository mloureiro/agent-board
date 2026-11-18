import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SamlConfig } from './config';
import { buildServer } from './server';
import {
  generateSamlKeyPair,
  requestIdOf,
  samlResponse,
  type FakeResponse,
  type SamlKeyPair,
} from './test/fakeSamlIdp';
import { loginConfig, useTestDb } from './test/helpers';
import { pkcePair, rpc } from './test/rpc';

const { db, admin } = await useTestDb();

const PUBLIC_URL = 'http://localhost:5173';
const ACS = `${PUBLIC_URL}/api/auth/saml/acs`;
const SP = 'https://board.example.test/saml/sp';

let idp: SamlKeyPair;
let other: SamlKeyPair;
beforeAll(() => {
  idp = generateSamlKeyPair();
  other = generateSamlKeyPair();
});

const open: { close(): Promise<unknown> }[] = [];
afterEach(() => Promise.all(open.splice(0).map((app) => app.close())));

async function serve(overrides: Partial<SamlConfig> = {}) {
  const saml: SamlConfig = {
    entryPoint: 'https://idp.example.test/sso',
    idpCert: idp.certificate,
    issuer: SP,
    usernameAttribute: null,
    label: 'Corp SSO',
    ...overrides,
  };
  const app = await buildServer(loginConfig({ saml }), db);
  open.push(app);
  return app;
}

type App = Awaited<ReturnType<typeof serve>>;

const postAcs = (app: App, fields: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/saml/acs',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });

/** The browser starts a flow; the IdP answers (`answer` shapes the response) and the browser posts it to the ACS. */
async function signIn(app: App, answer: Partial<FakeResponse> | ((requestId: string) => Partial<FakeResponse>) = {}) {
  const { verifier, challenge } = pkcePair();
  const started = await rpc<{ url: string }>(app, 'auth.saml.start', { challenge });
  expect(started.status).toBe(200);
  const requestId = requestIdOf(started.data!.url);
  const shaped = typeof answer === 'function' ? answer(requestId) : answer;
  const response = samlResponse(idp, { inResponseTo: requestId, audience: SP, acsUrl: ACS, ...shaped });
  const post = () => postAcs(app, { SAMLResponse: response, RelayState: 'ignored' });
  const finish = (flow: string, override: { verifier?: string } = {}) =>
    rpc(app, 'auth.saml.finish', { flow, verifier: override.verifier ?? verifier });
  return { started, post, finish, verifier };
}

const flowOf = (location: string | undefined): string =>
  new URL(location ?? '', PUBLIC_URL).searchParams.get('flow') ?? '';
const sessionCount = async () => (await admin.execute(sql`select 1 from session`)).rows.length;
const meOf = async (app: App, token: string) =>
  (await rpc<{ username: string }>(app, 'me', undefined, { token, type: 'query' })).data?.username;

describe('SAML sign-in', () => {
  it('lists the provider’s label in auth.config', async () => {
    const app = await serve();
    expect((await rpc(app, 'auth.config', undefined, { type: 'query' })).data).toMatchObject({
      saml: { label: 'Corp SSO' },
    });
  });

  it('starts with a redirect URL carrying a request, and sends nothing but JSON', async () => {
    const app = await serve();
    const started = await rpc<{ url: string }>(app, 'auth.saml.start', { challenge: pkcePair().challenge });
    const url = new URL(started.data!.url);
    expect(url.origin + url.pathname).toBe('https://idp.example.test/sso');
    expect(requestIdOf(started.data!.url)).toMatch(/^_[0-9a-f]{40}$/);
  });

  it('signs in through the ACS and finish', async () => {
    const app = await serve();
    const { post, finish, started } = await signIn(app, { nameId: 'Alice' });
    expect(started.status).toBe(200);
    const acs = await post();
    expect(acs.statusCode).toBe(303);
    expect(acs.headers.location).toMatch(/^\/login\/saml\?flow=[A-Za-z0-9_-]+$/);
    expect(acs.body).toBe('');
    const done = await finish(flowOf(acs.headers.location as string));
    expect(done.status).toBe(200);
    expect(await meOf(app, done.sessionToken!)).toBe('alice');
  });

  it('reads the username from the configured attribute', async () => {
    const app = await serve({ usernameAttribute: 'uid' });
    const { post, finish } = await signIn(app, { nameId: 'opaque-id', attributes: { uid: 'Bea' } });
    const done = await finish(flowOf((await post()).headers.location as string));
    expect(await meOf(app, done.sessionToken!)).toBe('bea');
  });

  it.each([
    ['an unsigned assertion', { unsigned: true }],
    ['an assertion signed with another key', { signWith: undefined }],
    ['another audience', { audience: 'https://elsewhere.example.test' }],
    ['an unknown request id', (requestId: string) => ({ inResponseTo: `${requestId}x` })],
    ['an IdP-initiated response', { inResponseTo: null }],
    ['an expired assertion', { notOnOrAfter: new Date(Date.now() - 10 * 60_000) }],
  ] as const)('refuses %s with a JSON error and no redirect', async (_name, answer) => {
    const app = await serve();
    const shaped =
      typeof answer === 'function' ? answer : { ...answer, ...('signWith' in answer ? { signWith: other } : {}) };
    const { post } = await signIn(app, shaped);
    const acs = await post();
    expect(acs.statusCode).toBe(303);
    expect(acs.headers.location).toBe('/login/saml?error=failed');
    expect(acs.body).toBe('');
    expect(await sessionCount()).toBe(0);
  });

  it('refuses a name that is no usable user name', async () => {
    const app = await serve();
    const { post } = await signIn(app, { nameId: 'two words' });
    const acs = await post();
    expect(acs.statusCode).toBe(303);
    expect(acs.headers.location).toBe('/login/saml?error=no_user');
  });

  it('accepts a response once', async () => {
    const app = await serve();
    const { post } = await signIn(app);
    expect((await post()).statusCode).toBe(303);
    const replay = await post();
    expect(replay.statusCode).toBe(303);
    expect(replay.headers.location).toBe('/login/saml?error=failed');
  });

  it('sends a browser post without a response back as a failure, and answers 413 to a huge one', async () => {
    const app = await serve();
    const missing = await postAcs(app, { RelayState: 'x' });
    expect(missing.statusCode).toBe(303);
    expect(missing.headers.location).toBe('/login/saml?error=failed');
    expect((await postAcs(app, { SAMLResponse: 'x'.repeat(300 * 1024) })).statusCode).toBe(413);
    const json = await app.inject({
      method: 'POST',
      url: '/api/auth/saml/acs',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(json.headers.location).toBe('/login/saml?error=failed');
    expect(await sessionCount()).toBe(0);
  });

  it('hands the sign-in only to the browser that started it', async () => {
    const app = await serve();
    const { post, finish, verifier } = await signIn(app);
    const flow = flowOf((await post()).headers.location as string);
    expect(await finish(flow, { verifier: pkcePair().verifier })).toMatchObject({ status: 401 });
    // The flow is spent by the failed attempt.
    expect(await finish(flow, { verifier })).toMatchObject({ status: 401 });
    expect(await sessionCount()).toBe(0);
  });

  it('does not finish a flow before the IdP answered, or one that is made up', async () => {
    const app = await serve();
    const { finish } = await signIn(app);
    const { rows } = await admin.execute<{ id: string }>(sql`select id from auth_flow`);
    expect((await finish(rows[0]!.id)).status).toBe(401);
    expect((await finish('does-not-exist-0123456789')).status).toBe(401);
    expect((await finish('has spaces and ../ in it')).status).toBe(401);
  });

  it('finishes a flow once', async () => {
    const app = await serve();
    const { post, finish } = await signIn(app);
    const flow = flowOf((await post()).headers.location as string);
    expect((await finish(flow)).status).toBe(200);
    expect((await finish(flow)).status).toBe(401);
  });

  it('has no ACS when SAML is not configured', async () => {
    const app = await buildServer(loginConfig(), db);
    open.push(app);
    expect((await postAcs(app, { SAMLResponse: 'x' })).statusCode).toBe(404);
    expect((await rpc(app, 'auth.saml.start', { challenge: pkcePair().challenge })).status).toBe(404);
  });
});
