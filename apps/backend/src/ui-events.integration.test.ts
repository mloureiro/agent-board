import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { sessions } from './db/schema';
import { buildServer } from './server';
import { createSession, hashToken } from './services/auth/sessions';
import { Changes } from './services/changes';
import { plainMachine } from './test/client';
import { caller, loginConfig, testConfig, useTestDb } from './test/helpers';
import { rpc, SESSION_COOKIE } from './test/rpc';

const { db, admin } = useTestDb();

const DEBOUNCE_MS = 60;
/** Long enough for a debounced event to have arrived, if one was coming. */
const QUIET_MS = 300;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Server = Awaited<ReturnType<typeof buildServer>>;
let app: Server;
let url: string;
let changes: Changes;
const streams: AbortController[] = [];
const servers: Server[] = [];

async function start(config = testConfig, pingMs = 100) {
  changes = new Changes(DEBOUNCE_MS);
  app = await buildServer(config, db, { changes, pingMs });
  servers.push(app);
  url = await app.listen({ port: 0, host: '127.0.0.1' });
}

afterEach(async () => {
  streams.splice(0).forEach((controller) => controller.abort());
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const issue = async (name: string, owner = 'jascha') => (await caller(db, owner).machines.issue({ name })).token;

function machineCalls(token: string) {
  return plainMachine(async (command, body = {}) => {
    const res = await fetch(`${url}/api/machine/${command}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { result?: never; error?: string } };
  });
}

async function openStream(headers: HeadersInit = {}) {
  const controller = new AbortController();
  streams.push(controller);
  const res = await fetch(`${url}/api/ui/events`, { headers, signal: controller.signal });
  let text = '';
  let ended = false;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // Aborted by the test.
    }
    ended = true;
  })();
  const stream = {
    res,
    text: () => text,
    isEnded: () => ended,
    events: () => text.split('event: changed\ndata:\n\n').length - 1,
    waitFor: (done: () => boolean) => vi.waitFor(() => expect(done()).toBe(true), { timeout: 3000, interval: 10 }),
  };
  await stream.waitFor(() => text.includes(': connected'));
  return stream;
}

/** A task the machine has claimed, made before any stream is open so that its own events are over. */
async function claimedTask(token: string): Promise<string> {
  const calls = machineCalls(token);
  const added = await calls('add-task', { body: { title: 't' } });
  const id = added.json.result.task.id;
  await calls('claim-task', { id, machine: 'laptop' });
  await sleep(QUIET_MS);
  return id;
}

describe('GET /api/ui/events', () => {
  it('opens an event stream for the signed-in user and says so at once', async () => {
    await start();
    const stream = await openStream();
    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get('content-type')).toBe('text/event-stream');
    expect(stream.res.headers.get('cache-control')).toBe('no-cache');
    expect(stream.res.headers.get('x-accel-buffering')).toBe('no');
    expect(stream.text().startsWith(': connected\n\n')).toBe(true);
  });

  it('sends one changed event when a UI mutation commits, and none when it fails', async () => {
    await start();
    const id = await claimedTask(await issue('laptop'));
    const stream = await openStream();
    expect((await rpc(app, 'schedules.remove', { id: 'nothing' })).status).not.toBe(200);
    await sleep(QUIET_MS);
    expect(stream.events()).toBe(0);

    expect((await rpc(app, 'tasks.setPriority', { id, priority: 'high' })).status).toBe(200);
    await stream.waitFor(() => stream.events() === 1);
    await sleep(QUIET_MS);
    expect(stream.events()).toBe(1);
  });

  it('sends one event for a machine write and none for a heartbeat, a run inbox read or a read, and nothing but comments, events and empty data', async () => {
    await start();
    const token = await issue('laptop');
    const id = await claimedTask(token);
    const calls = machineCalls(token);
    const stream = await openStream();

    expect((await calls('heartbeat', { id, body: { lane: 'a', borrowed: false } })).status).toBe(200);
    expect((await calls('run-inbox', { id })).status).toBe(200);
    await calls('list-tasks');
    await calls('get-task', { id });
    await calls('version');
    await calls('list-machines');
    await sleep(QUIET_MS);
    expect(stream.events()).toBe(0);

    expect((await calls('add-note', { id, body: 'n' })).status).toBe(200);
    await stream.waitFor(() => stream.events() === 1);
    await sleep(QUIET_MS);
    expect(stream.events()).toBe(1);
    await stream.waitFor(() => stream.text().includes(': ping\n\n'));
    expect(
      stream
        .text()
        .split('\n')
        .every((line) => /^(: .*|event: changed|data:)?$/.test(line)),
    ).toBe(true);
  });

  it("sends nothing for another owner's writes", async () => {
    await start();
    const mine = await openStream();
    await machineCalls(await issue('desk', 'carol'))('add-task', { body: { title: 'carol task' } });
    await sleep(QUIET_MS);
    expect(mine.events()).toBe(0);
  });

  it('stops listening when its client leaves', async () => {
    await start();
    await openStream();
    expect(changes.viewListenerCount('jascha')).toBe(1);
    streams.splice(0).forEach((controller) => controller.abort());
    await vi.waitFor(() => expect(changes.viewListenerCount('jascha')).toBe(0), { timeout: 3000 });
  });

  it('ends the open streams when the server closes', async () => {
    await start();
    const stream = await openStream();
    await app.close();
    await stream.waitFor(() => stream.isEnded());
    expect(changes.viewListenerCount('jascha')).toBe(0);
  });

  describe('on a board with sign-in', () => {
    const config = loginConfig();
    const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });
    const signIn = (owner: string) => createSession({ root: db, login: config.auth }, owner, 'passkey');

    it('refuses a request without a session or with an unknown one, with JSON', async () => {
      await start(config);
      for (const headers of [undefined, cookie(`abs_${'x'.repeat(43)}`)]) {
        const res = await fetch(`${url}/api/ui/events`, { headers });
        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toMatch(/application\/json/);
        expect(await res.json()).toEqual({ error: 'Sign in to use the board.' });
      }
    });

    it('keeps a stream while the session lives and ends it at the next ping once the session is gone', async () => {
      await start(config);
      const token = await signIn('alice');
      const stream = await openStream(cookie(token));
      await stream.waitFor(() => stream.text().includes(': ping\n\n'));
      await sleep(250);
      expect(stream.isEnded()).toBe(false);

      await admin.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
      await stream.waitFor(() => stream.isEnded());
      expect(changes.viewListenerCount('alice')).toBe(0);
    });

    it('ends at once when the account is deleted, before any ping', async () => {
      await start(config, 60_000);
      const token = await signIn('alice');
      const stream = await openStream(cookie(token));
      const other = await openStream(cookie(await signIn('bob')));
      expect(await rpc(app, 'account.delete', { username: 'alice' }, { token })).toMatchObject({ status: 200 });
      await stream.waitFor(() => stream.isEnded());
      expect(changes.viewListenerCount('alice')).toBe(0);
      expect(other.isEnded()).toBe(false);
    });
  });
});
