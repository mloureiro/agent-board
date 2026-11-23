import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './server';
import { createSession } from './services/auth/sessions';
import { caller, loginConfig, testConfig, useTestDb } from './test/helpers';

const { db } = await useTestDb();

type Server = Awaited<ReturnType<typeof buildServer>>;
let app: Server;
let url: string;

beforeEach(async () => {
  app = await buildServer(testConfig, db);
  url = await app.listen({ port: 0, host: '127.0.0.1' });
});
afterEach(() => app.close());

/** Over a real socket: `inject` does not hand tRPC a multipart body the way a server does. */
describe('writes to /trpc', () => {
  const issueToken = async () => {
    await caller(db, 'jascha').machines.issue({ name: 'laptop' });
  };
  const isRevoked = async () =>
    (await caller(db, 'jascha').machines.list()).find(({ name }) => name === 'laptop')?.revokedAt != null;

  // `%74` is `t`, `%72` is `r`: Fastify routes on the decoded path.
  it.each(['/trpc/machines.revoke', '/%74rpc/machines.revoke', '/t%72pc/machines.revoke'])(
    'refuses a form post to %s, which would otherwise run the mutation',
    async (path) => {
      await issueToken();
      const form = new FormData();
      form.append('0', '{"name":"laptop"}');
      const res = await fetch(`${url}${path}`, { method: 'POST', body: form });
      expect(res.status).toBe(415);
      expect(await isRevoked()).toBe(false);
    },
  );

  it('refuses urlencoded, plain text and typeless writes too', async () => {
    await issueToken();
    for (const type of ['application/x-www-form-urlencoded', 'text/plain', undefined]) {
      const res = await fetch(`${url}/trpc/machines.revoke`, {
        method: 'POST',
        headers: type ? { 'content-type': type } : {},
        body: type ? '{"name":"laptop"}' : undefined,
      });
      expect(res.status).toBe(415);
    }
    expect(await isRevoked()).toBe(false);
  });

  it('still runs a JSON mutation', async () => {
    await issueToken();
    const res = await fetch(`${url}/trpc/machines.revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{"name":"laptop"}',
    });
    expect(res.status).toBe(200);
    expect(await isRevoked()).toBe(true);
  });
});

describe('a board with login', () => {
  const multipart = new FormData();
  multipart.append('0', '{"name":"laptop"}');
  const FORMS: [string, BodyInit, Record<string, string>][] = [
    ['urlencoded', 'name=laptop', { 'content-type': 'application/x-www-form-urlencoded' }],
    ['text/plain', '{"name":"laptop"}', { 'content-type': 'text/plain' }],
    ['multipart', multipart, {}],
  ];

  let secured: Server;
  let base: string;
  let cookie: string;
  beforeEach(async () => {
    const config = loginConfig();
    secured = await buildServer(config, db);
    base = await secured.listen({ port: 0, host: '127.0.0.1' });
    const token = await createSession({ root: db, login: config.auth }, 'jascha', 'passkey');
    cookie = `board-session=${token}`;
    await caller(db, 'jascha').machines.issue({ name: 'laptop' });
  });
  afterEach(() => secured.close());

  const isRevoked = async () =>
    (await caller(db, 'jascha').machines.list()).find(({ name }) => name === 'laptop')?.revokedAt != null;

  it.each(FORMS)(
    'refuses a cross-site %s post to a signed-in mutation, though the browser sends the cookie',
    async (_n, body, headers) => {
      const res = await fetch(`${base}/trpc/machines.revoke`, {
        method: 'POST',
        headers: { ...headers, cookie },
        body,
      });
      expect(res.status).toBe(415);
      expect(await isRevoked()).toBe(false);
    },
  );

  it.each(FORMS)('refuses a %s post to a public sign-in mutation too', async (_n, body, headers) => {
    const res = await fetch(`${base}/trpc/auth.passkey.loginOptions`, { method: 'POST', headers, body });
    expect(res.status).toBe(415);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('runs a JSON mutation with the cookie', async () => {
    const res = await fetch(`${base}/trpc/machines.revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{"name":"laptop"}',
    });
    expect(res.status).toBe(200);
    expect(await isRevoked()).toBe(true);
  });

  it('changes nothing for a GET, which tRPC answers only for queries', async () => {
    const input = encodeURIComponent('{"name":"laptop"}');
    const res = await fetch(`${base}/trpc/machines.revoke?input=${input}`, { headers: { cookie } });
    expect(res.status).toBe(405);
    expect(await isRevoked()).toBe(false);
    const logout = await fetch(`${base}/trpc/auth.logout`, { headers: { cookie } });
    expect(logout.status).toBe(405);
    expect((await fetch(`${base}/trpc/me`, { headers: { cookie } })).status).toBe(200);
  });
});
