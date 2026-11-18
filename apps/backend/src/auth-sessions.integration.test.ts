import { eq, sql } from 'drizzle-orm';
import { sessions } from './db/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupAllBoards } from './cleanup';
import { buildServer } from './server';
import { cookieValue, createSession, hashToken, sessionCookie } from './services/auth/sessions';
import { caller, loginConfig, testConfig, useTestDb } from './test/helpers';
import { rpc, SESSION_COOKIE } from './test/rpc';

const { db, admin } = await useTestDb();

const open: { close(): Promise<unknown> }[] = [];
afterEach(() => Promise.all(open.splice(0).map((app) => app.close())));

async function serve(config = loginConfig()) {
  const app = await buildServer(config, db);
  open.push(app);
  const token = (owner: string) => createSession({ root: db, login: config.auth }, owner, 'passkey');
  return { app, token };
}

const sessionRow = async (token: string) =>
  (
    await admin
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)))
  )[0];

describe('sessions', () => {
  it('answers a signed-in call for the session’s owner and 401 for everything else', async () => {
    const { app, token } = await serve();
    const mine = await token('alice');
    expect(await rpc(app, 'me', undefined, { token: mine, type: 'query' })).toMatchObject({
      status: 200,
      data: { username: 'alice' },
    });
    for (const bad of [undefined, `abs_${'x'.repeat(43)}`, 'abs_short', mine.replace('abs_', 'abm_')]) {
      const answer = await rpc(app, 'me', undefined, { ...(bad ? { token: bad } : {}), type: 'query' });
      expect(answer, String(bad)).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    }
  });

  it('reads the session from the cookie only, never from an Authorization header', async () => {
    const { app, token } = await serve();
    const mine = await token('alice');
    const answer = await app.inject({
      method: 'GET',
      url: '/trpc/me',
      headers: { authorization: `Bearer ${mine}` },
    });
    expect(answer.statusCode).toBe(401);
  });

  it('takes the first of two session cookies, and none of another cookie’s name', async () => {
    const { app, token } = await serve();
    const alice = await token('alice');
    const bob = await token('bob');
    const meWith = async (cookie: string) =>
      (await rpc<{ username: string }>(app, 'me', undefined, { cookie, type: 'query' })).data?.username;
    expect(await meWith(`${SESSION_COOKIE}=${alice}; ${SESSION_COOKIE}=${bob}`)).toBe('alice');
    expect(await meWith(`${SESSION_COOKIE}=${bob}; ${SESSION_COOKIE}=${alice}`)).toBe('bob');
    expect(await meWith(`other=1; ${SESSION_COOKIE}=${alice}`)).toBe('alice');
    expect(await meWith(`x-${SESSION_COOKIE}=${alice}`)).toBeUndefined();
    expect(await meWith(`${SESSION_COOKIE}x=${alice}`)).toBeUndefined();
  });

  it('clears a cookie whose session the server does not know, and only then', async () => {
    const { app, token } = await serve();
    const cleared = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    for (const stale of [`abs_${'x'.repeat(43)}`, 'garbage']) {
      const answer = await rpc(app, 'me', undefined, { token: stale, type: 'query' });
      expect(answer.setCookies, stale).toEqual([cleared]);
    }
    expect((await rpc(app, 'me', undefined, { type: 'query' })).setCookies).toEqual([]);
    expect((await rpc(app, 'me', undefined, { token: await token('alice'), type: 'query' })).setCookies).toEqual([]);
  });

  // These exact strings are matched by the regular expression on /trpc in apps/frontend/Caddyfile, which drops every other
  // Set-Cookie. A change here fails that rule too: change the Caddyfile and its tests in the same commit.
  it('writes a hardened cookie, with __Host- and Secure when the board is on https', () => {
    const maxAge = 34_560_000;
    const token = `abs_${'a'.repeat(43)}`;
    expect(sessionCookie({ publicUrl: 'http://localhost:5173' }, token)).toBe(
      `board-session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
    );
    expect(sessionCookie({ publicUrl: 'https://board.example.com' }, token)).toBe(
      `__Host-board-session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Secure`,
    );
    expect(sessionCookie({ publicUrl: 'https://board.example.com' }, null)).toBe(
      '__Host-board-session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    );
    expect(sessionCookie({ publicUrl: 'http://localhost:5173' }, null)).toBe(
      'board-session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    );
    expect(cookieValue(`a=b; __Host-board-session=${token}`, { publicUrl: 'https://board.example.com' })).toBe(token);
    expect(cookieValue(`board-session=${token}`, { publicUrl: 'https://board.example.com' })).toBeNull();
  });

  it('answers auth.config without a session', async () => {
    const { app } = await serve();
    expect(await rpc(app, 'auth.config', undefined, { type: 'query' })).toMatchObject({
      status: 200,
      data: { login: true, passkeys: true, signup: false, oidc: null, saml: null },
    });
  });

  it('stores only the hash of the token', async () => {
    const { token } = await serve();
    const raw = await token('alice');
    const { rows } = await admin.execute<{ token_hash: string }>(sql`select token_hash from session`);
    expect(rows).toEqual([{ token_hash: hashToken(raw) }]);
    expect(raw).toMatch(/^abs_[A-Za-z0-9_-]{43}$/);
  });

  it('refuses an expired session', async () => {
    const { app, token } = await serve();
    const mine = await token('alice');
    await admin.execute(sql`update session set expires_at = now() - interval '1 second'`);
    expect((await rpc(app, 'me', undefined, { token: mine, type: 'query' })).status).toBe(401);
  });

  it('slides the expiry, writing at most once an hour', async () => {
    const { app, token } = await serve(loginConfig({ sessionDays: 10 }));
    const mine = await token('alice');
    const before = await sessionRow(mine);
    // Seen ten minutes ago: no write, however often it is used.
    await admin.execute(sql`update session set last_seen_at = now() - interval '10 minutes'`);
    const recent = await sessionRow(mine);
    await rpc(app, 'me', undefined, { token: mine, type: 'query' });
    expect(await sessionRow(mine)).toEqual(recent);
    // Seen two hours ago, and about to expire: the use pushes the expiry out by the full time.
    await admin.execute(
      sql`update session set last_seen_at = now() - interval '2 hours', expires_at = now() + interval '1 day'`,
    );
    await rpc(app, 'me', undefined, { token: mine, type: 'query' });
    const after = await sessionRow(mine);
    expect(after!.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(after!.expiresAt.getTime() - Date.now()).toBeGreaterThan(9.9 * 24 * 3600_000);
    expect(after!.expiresAt.getTime()).toBeGreaterThan(before!.expiresAt.getTime() - 60_000);
  });

  it('ends with logout, and only that session', async () => {
    const { app, token } = await serve();
    const first = await token('alice');
    const second = await token('alice');
    const out = await rpc(app, 'auth.logout', undefined, { token: first });
    expect(out.status).toBe(200);
    expect(out.setCookies).toEqual([`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`]);
    expect((await rpc(app, 'me', undefined, { token: first, type: 'query' })).status).toBe(401);
    expect((await rpc(app, 'me', undefined, { token: second, type: 'query' })).status).toBe(200);
    expect((await rpc(app, 'auth.logout')).status).toBe(401);
  });

  it('never lets one user’s token read another’s board', async () => {
    const { app, token } = await serve();
    await caller(db, 'bob').machines.issue({ name: 'bobs-laptop' });
    const alice = await token('alice');
    expect(await rpc(app, 'machines.list', undefined, { token: alice, type: 'query' })).toMatchObject({ data: [] });
    const bob = await token('bob');
    const listed = await rpc<{ name: string }[]>(app, 'machines.list', undefined, { token: bob, type: 'query' });
    expect(listed.data?.map(({ name }) => name)).toEqual(['bobs-laptop']);
  });

  it('is not needed for /healthz or reached by the machine API’s own tokens', async () => {
    const { app } = await serve();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const machine = await app.inject({ method: 'POST', url: '/api/machine/list-tasks', payload: {} });
    expect(machine.statusCode).toBe(401);
  });

  it('purges expired sessions and flows with the hourly cleanup', async () => {
    const { token } = await serve();
    await token('alice');
    const stale = await token('alice');
    await admin.execute(
      sql`update session set expires_at = now() - interval '1 second' where token_hash = ${hashToken(stale)}`,
    );
    await admin.execute(
      sql`insert into auth_flow (id, kind, expires_at) values ('old-flow-0123456789', 'oidc', now() - interval '1 second'), ('live-flow-012345678', 'oidc', now() + interval '5 minutes')`,
    );
    const messages: string[] = [];
    await cleanupAllBoards(db, { info: (m) => messages.push(m), error: () => undefined });
    expect((await admin.execute(sql`select 1 from session`)).rows).toHaveLength(1);
    expect((await admin.execute<{ id: string }>(sql`select id from auth_flow`)).rows).toEqual([
      { id: 'live-flow-012345678' },
    ]);
    expect(messages).toContain('purged 2 expired sessions and sign-in flows');
  });
});

describe('a board without login', () => {
  it('is every request’s configured user, whatever it sends', async () => {
    const app = await buildServer({ ...testConfig, auth: { login: false, user: 'solo' } }, db);
    open.push(app);
    expect(await rpc(app, 'me', undefined, { type: 'query' })).toMatchObject({ data: { username: 'solo' } });
    expect(await rpc(app, 'me', undefined, { token: `abs_${'x'.repeat(43)}`, type: 'query' })).toMatchObject({
      data: { username: 'solo' },
    });
    expect(await rpc(app, 'auth.config', undefined, { type: 'query' })).toMatchObject({ data: { login: false } });
    expect((await rpc(app, 'auth.logout')).status).toBe(200);
    expect(await rpc(app, 'auth.passkey.loginOptions')).toMatchObject({ status: 404 });
  });
});
