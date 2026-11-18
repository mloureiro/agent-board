import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { sql } from 'drizzle-orm';
import { buildServer } from './server';
import { Changes } from './services/changes';
import { plainMachine } from './test/client';
import { caller, testConfig, useTestDb } from './test/helpers';

const { db, admin } = await useTestDb();

const DEBOUNCE_MS = 60;
/** Long enough for a debounced event to have arrived, if one was coming. */
const QUIET_MS = 300;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Server = Awaited<ReturnType<typeof buildServer>>;
let app: Server;
let url: string;
let changes: Changes;
const streams: AbortController[] = [];

beforeEach(async () => {
  changes = new Changes(DEBOUNCE_MS);
  app = await buildServer(testConfig, db, { changes, pingMs: 100 });
  url = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  streams.splice(0).forEach((controller) => controller.abort());
  await app.close();
});

const issue = async (name: string, owner = 'jascha') => (await caller(db, owner).machines.issue({ name })).token;

/** A machine API caller for one token, like the CLI. */
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

async function openStream(token: string) {
  const controller = new AbortController();
  streams.push(controller);
  const res = await fetch(`${url}/api/machine/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
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
  return {
    res,
    text: () => text,
    isEnded: () => ended,
    events: () => text.split('event: tasks\ndata:\n\n').length - 1,
    waitFor: (done: () => boolean) => vi.waitFor(() => expect(done()).toBe(true), { timeout: 3000, interval: 10 }),
  };
}

describe('GET /api/machine/events', () => {
  it('refuses a missing, unknown or revoked token with JSON, before any stream starts', async () => {
    const revoked = await issue('old');
    await caller(db).machines.revoke({ name: 'old' });
    const headers: (HeadersInit | undefined)[] = [
      undefined,
      { authorization: 'Bearer abm_nope' },
      { authorization: `Bearer ${revoked}` },
    ];
    for (const init of headers) {
      const res = await fetch(`${url}/api/machine/events`, { headers: init });
      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      expect(await res.json()).toEqual({ error: 'unknown or revoked machine token' });
    }
  });

  it('opens a stream with the event-stream headers and says so at once', async () => {
    const stream = await openStream(await issue('laptop'));
    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get('content-type')).toBe('text/event-stream');
    expect(stream.res.headers.get('cache-control')).toBe('no-cache');
    expect(stream.res.headers.get('x-accel-buffering')).toBe('no');
    await stream.waitFor(() => stream.text().startsWith(': connected\n\n'));
  });

  it('sends one tasks event, without data, for a burst of writes', async () => {
    const token = await issue('laptop');
    const stream = await openStream(token);
    await stream.waitFor(() => stream.text().includes(': connected'));
    const calls = machineCalls(token);
    // Concurrent requests can finish further apart than the window on a slow runner, which is two bursts. Hold the
    // notifications until every write has answered and send them at once, so this is one burst however slow the
    // requests are. How the window merges calls spread over time is in services/changes.test.ts.
    const held: string[] = [];
    const notify = vi.spyOn(changes, 'notify').mockImplementation((owner) => {
      held.push(owner);
    });
    await Promise.all([1, 2, 3].map((n) => calls('add-task', { body: { title: `t${n}` } })));
    notify.mockRestore();
    expect(held).toEqual(['jascha', 'jascha', 'jascha']);
    held.forEach((owner) => changes.notify(owner));
    await stream.waitFor(() => stream.events() >= 1);
    await sleep(QUIET_MS);
    expect(stream.events()).toBe(1);
    expect(stream.text()).not.toMatch(/data: ./);
  });

  it('sends nothing for a UI mutation that fails', async () => {
    const stream = await openStream(await issue('laptop'));
    await stream.waitFor(() => stream.text().includes(': connected'));
    const ui = { 'remote-user': 'jascha', 'remote-groups': 'admins', 'content-type': 'application/json' };
    const failed = await fetch(`${url}/trpc/schedules.remove`, {
      method: 'POST',
      headers: ui,
      body: JSON.stringify({ id: 'nothing' }),
    });
    expect(failed.ok).toBe(false);
    await sleep(QUIET_MS);
    expect(stream.events()).toBe(0);
  });

  it('sends an event when a UI mutation commits', async () => {
    const token = await issue('laptop');
    const stream = await openStream(token);
    await stream.waitFor(() => stream.text().includes(': connected'));
    const added = await machineCalls(token)('add-task', { body: { title: 't' } });
    await stream.waitFor(() => stream.events() === 1);
    const id = added.json.result.task.id;
    await sleep(QUIET_MS);
    const res = await fetch(`${url}/trpc/tasks.setPriority`, {
      method: 'POST',
      headers: { 'remote-user': 'jascha', 'remote-groups': 'admins', 'content-type': 'application/json' },
      body: JSON.stringify({ id, priority: 'high' }),
    });
    expect(res.ok).toBe(true);
    await stream.waitFor(() => stream.events() === 2);
  });

  it('sends nothing for a heartbeat or a read', async () => {
    const token = await issue('laptop');
    const stream = await openStream(token);
    const calls = machineCalls(token);
    const added = await calls('add-task', { body: { title: 't' } });
    const id = added.json.result.task.id;
    await calls('claim-task', { id, machine: 'laptop' });
    await stream.waitFor(() => stream.events() >= 1);
    await sleep(QUIET_MS);
    const before = stream.events();
    expect((await calls('heartbeat', { id, body: { lane: 'a', borrowed: false } })).status).toBe(200);
    await calls('list-tasks');
    await calls('get-task', { id });
    await calls('version');
    await sleep(QUIET_MS);
    expect(stream.events()).toBe(before);
  });

  it("sends nothing for another owner's writes", async () => {
    const mine = await openStream(await issue('laptop'));
    const carol = await openStream(await issue('laptop', 'carol'));
    await mine.waitFor(() => mine.text().includes(': connected'));
    await carol.waitFor(() => carol.text().includes(': connected'));
    await machineCalls(await issue('desk', 'carol'))('add-task', { body: { title: 'carol task' } });
    await carol.waitFor(() => carol.events() === 1);
    await sleep(QUIET_MS);
    expect(mine.events()).toBe(0);
  });

  it('pings, and ends the stream at the next ping once the token is revoked', async () => {
    const stream = await openStream(await issue('laptop'));
    await stream.waitFor(() => stream.text().includes(': ping\n\n'));
    expect(stream.isEnded()).toBe(false);
    await caller(db).machines.revoke({ name: 'laptop' });
    await stream.waitFor(() => stream.isEnded());
  });

  it('stops a stream when its client leaves, also when it left while the token was being looked up', async () => {
    const token = await issue('laptop');
    const stream = await openStream(token);
    await stream.waitFor(() => stream.text().includes(': connected'));
    expect(changes.listenerCount('jascha')).toBe(1);
    streams.splice(0).forEach((controller) => controller.abort());
    await vi.waitFor(() => expect(changes.listenerCount('jascha')).toBe(0), { timeout: 3000 });

    // The sighting of the token waits for this row lock, so the request is stuck in authentication.
    await admin.transaction(async (tx) => {
      await tx.execute(sql`update machine set name = name where name = 'laptop'`);
      const req = request(`${url}/api/machine/events`, { headers: { authorization: `Bearer ${token}` } });
      req.on('error', () => undefined);
      req.end();
      await sleep(200);
      req.destroy();
      await sleep(200);
    });
    await sleep(300);
    expect(changes.listenerCount('jascha')).toBe(0);
  });

  it('closing the server ends the open streams', async () => {
    const stream = await openStream(await issue('laptop'));
    await stream.waitFor(() => stream.text().includes(': connected'));
    await app.close();
    await stream.waitFor(() => stream.isEnded());
    expect(changes.listenerCount('jascha')).toBe(0);
  });
});
