import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './server';
import { caller, testConfig, useTestDb } from './test/helpers';

const { db } = await useTestDb();

type Server = Awaited<ReturnType<typeof buildServer>>;
let app: Server;
let url: string;

beforeEach(async () => {
  app = await buildServer(testConfig, db);
  url = await app.listen({ port: 0, host: '127.0.0.1' });
});
afterEach(() => app.close());

const signedIn = { 'remote-user': 'jascha', 'remote-groups': 'admins' };

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
      const res = await fetch(`${url}${path}`, { method: 'POST', headers: signedIn, body: form });
      expect(res.status).toBe(415);
      expect(await isRevoked()).toBe(false);
    },
  );

  it('refuses urlencoded, plain text and typeless writes too', async () => {
    await issueToken();
    for (const type of ['application/x-www-form-urlencoded', 'text/plain', undefined]) {
      const res = await fetch(`${url}/trpc/machines.revoke`, {
        method: 'POST',
        headers: { ...signedIn, ...(type ? { 'content-type': type } : {}) },
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
      headers: { ...signedIn, 'content-type': 'application/json; charset=utf-8' },
      body: '{"name":"laptop"}',
    });
    expect(res.status).toBe(200);
    expect(await isRevoked()).toBe(true);
  });
});
