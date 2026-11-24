import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from './server';
import { createSession, type SessionMethod } from './services/auth/sessions';
import { loginConfig, testConfig, useTestDb } from './test/helpers';
import { pkcePair, rpc } from './test/rpc';

const { db, admin } = useTestDb();

const EXPIRED = 'This sign-in has expired. Start again.';

const open: { close(): Promise<unknown> }[] = [];
afterEach(() => Promise.all(open.splice(0).map((app) => app.close())));

async function serve() {
  const app = await buildServer(loginConfig(), db);
  open.push(app);
  return app;
}

type App = Awaited<ReturnType<typeof serve>>;

const browserOf = (owner: string, method: SessionMethod = 'passkey') =>
  createSession({ root: db, login: { sessionDays: 30 } }, owner, method);

async function startFlow(app: App) {
  const { verifier, challenge } = pkcePair();
  const started = await rpc<{ flow: string; code: string }>(app, 'auth.handoff.start', { challenge });
  expect(started.status).toBe(200);
  return { ...started.data!, verifier };
}

const sessions = async () =>
  (await admin.execute<{ method: string }>(sql`select method from session order by created_at`)).rows;
const meOf = async (app: App, token: string) =>
  (await rpc<{ username: string }>(app, 'me', undefined, { token, type: 'query' })).data?.username;
const expire = (flow: string) =>
  admin.execute(sql`update auth_flow set expires_at = now() - interval '1 minute' where id = ${flow}`);

describe('hand-off sign-in', () => {
  it('starts with a flow id and a code the signed-in browser sees too', async () => {
    const app = await serve();
    const token = await browserOf('alice');
    const { flow, code } = await startFlow(app);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const described = await rpc(app, 'auth.handoff.describe', { flow }, { token, type: 'query' });
    expect(described.data).toEqual({ code });
  });

  it('answers pending before approval, sets no cookie and keeps the flow usable', async () => {
    const app = await serve();
    const token = await browserOf('alice');
    const { flow, verifier } = await startFlow(app);
    const early = await rpc(app, 'auth.handoff.finish', { flow, verifier });
    expect(early.data).toEqual({ status: 'pending' });
    expect(early.setCookies).toEqual([]);
    expect((await rpc(app, 'auth.handoff.approve', { flow }, { token })).data).toEqual({ ok: true });
    expect((await rpc(app, 'auth.handoff.finish', { flow, verifier })).data).toEqual({ status: 'signed-in' });
  });

  it('refuses describe and approve without a session', async () => {
    const app = await serve();
    const { flow } = await startFlow(app);
    expect((await rpc(app, 'auth.handoff.describe', { flow }, { type: 'query' })).status).toBe(401);
    expect((await rpc(app, 'auth.handoff.approve', { flow })).status).toBe(401);
  });

  it.each(['passkey', 'oidc', 'saml'] as const)(
    'signs the window in as a separate %s session once approved',
    async (method) => {
      const app = await serve();
      const token = await browserOf('carol', method);
      const { flow, verifier } = await startFlow(app);
      await rpc(app, 'auth.handoff.approve', { flow }, { token });
      const done = await rpc(app, 'auth.handoff.finish', { flow, verifier });
      expect(done.data).toEqual({ status: 'signed-in' });
      expect(done.sessionToken).toBeDefined();
      expect(JSON.stringify(done.data)).not.toContain(done.sessionToken);
      expect(done.sessionToken).not.toBe(token);
      expect(await meOf(app, done.sessionToken!)).toBe('carol');
      expect(await sessions()).toEqual([{ method }, { method }]);
    },
  );

  it('keeps the flow usable after a wrong verifier', async () => {
    const app = await serve();
    const token = await browserOf('alice');
    const { flow, verifier } = await startFlow(app);
    await rpc(app, 'auth.handoff.approve', { flow }, { token });
    const wrong = await rpc(app, 'auth.handoff.finish', { flow, verifier: pkcePair().verifier });
    expect(wrong.status).toBe(401);
    expect(wrong.message).toBe(EXPIRED);
    expect((await rpc(app, 'auth.handoff.finish', { flow, verifier })).data).toEqual({ status: 'signed-in' });
  });

  it('signs in once: a second finish answers the expiry message', async () => {
    const app = await serve();
    const token = await browserOf('alice');
    const { flow, verifier } = await startFlow(app);
    await rpc(app, 'auth.handoff.approve', { flow }, { token });
    await rpc(app, 'auth.handoff.finish', { flow, verifier });
    const again = await rpc(app, 'auth.handoff.finish', { flow, verifier });
    expect(again.message).toBe(EXPIRED);
    expect(again.setCookies).toEqual([]);
  });

  it('approves once: a second approval answers NOT_FOUND with the expiry message', async () => {
    const app = await serve();
    const alice = await browserOf('alice');
    const bob = await browserOf('bob');
    const { flow, verifier } = await startFlow(app);
    await rpc(app, 'auth.handoff.approve', { flow }, { token: alice });
    const second = await rpc(app, 'auth.handoff.approve', { flow }, { token: bob });
    expect(second.code).toBe('NOT_FOUND');
    expect(second.message).toBe(EXPIRED);
    const done = await rpc(app, 'auth.handoff.finish', { flow, verifier });
    expect(await meOf(app, done.sessionToken!)).toBe('alice');
    const described = await rpc(app, 'auth.handoff.describe', { flow }, { token: alice, type: 'query' });
    expect(described.message).toBe(EXPIRED);
  });

  it('refuses describe, approve and finish once an unapproved flow has expired', async () => {
    const app = await serve();
    const token = await browserOf('alice');
    const { flow, verifier } = await startFlow(app);
    await expire(flow);
    const answers = [
      await rpc(app, 'auth.handoff.describe', { flow }, { token, type: 'query' }),
      await rpc(app, 'auth.handoff.approve', { flow }, { token }),
      await rpc(app, 'auth.handoff.finish', { flow, verifier }),
    ];
    expect(answers.map((answer) => answer.message)).toEqual([EXPIRED, EXPIRED, EXPIRED]);
  });

  it('refuses finish once an approved flow has expired', async () => {
    const app = await serve();
    const token = await browserOf('alice');
    const { flow, verifier } = await startFlow(app);
    await rpc(app, 'auth.handoff.approve', { flow }, { token });
    await expire(flow);
    const done = await rpc(app, 'auth.handoff.finish', { flow, verifier });
    expect(done.message).toBe(EXPIRED);
    expect(done.setCookies).toEqual([]);
  });

  it('refuses to approve or describe a flow of another kind', async () => {
    const app = await serve();
    const token = await browserOf('alice');
    const id = 'saml-flow-id-0123456789abcdef';
    await admin.execute(
      sql`insert into auth_flow (id, kind, expires_at) values (${id}, 'saml', now() + interval '5 minutes')`,
    );
    expect((await rpc(app, 'auth.handoff.approve', { flow: id }, { token })).code).toBe('NOT_FOUND');
    expect((await rpc(app, 'auth.handoff.describe', { flow: id }, { token, type: 'query' })).code).toBe('NOT_FOUND');
  });

  it('is refused on a board without login', async () => {
    const app = await buildServer(testConfig, db);
    open.push(app);
    const answer = await rpc(app, 'auth.handoff.start', { challenge: pkcePair().challenge });
    expect(answer.code).toBe('NOT_FOUND');
  });
});
