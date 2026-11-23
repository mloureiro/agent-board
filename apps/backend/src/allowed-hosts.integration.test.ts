import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from './server';
import { testConfig, useTestDb } from './test/helpers';

const { db } = useTestDb();

const guarded = { ...testConfig, auth: { login: false as const, user: 'me' }, allowedHosts: ['127.0.0.1:4785'] };

type Server = Awaited<ReturnType<typeof buildServer>>;
const apps: Server[] = [];
afterEach(() => Promise.all(apps.splice(0).map((app) => app.close())));

async function get(config: typeof testConfig, url: string, headers: Record<string, string | undefined>) {
  const app = await buildServer(config, db);
  apps.push(app);
  return app.inject({ method: 'GET', url, headers });
}

describe('allowed hosts', () => {
  it('answers a listed Host', async () => {
    expect((await get(guarded, '/trpc/me', { host: '127.0.0.1:4785' })).statusCode).toBe(200);
  });

  it('refuses an unlisted Host with 421', async () => {
    const res = await get(guarded, '/trpc/me', { host: 'evil.test:4785' });
    expect(res.statusCode).toBe(421);
    expect(res.json()).toEqual({ error: 'unknown host' });
  });

  it('refuses a request without a Host', async () => {
    const app = await buildServer(guarded, db);
    apps.push(app);
    const port = Number(new URL(await app.listen({ port: 0, host: '127.0.0.1' })).port);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.write('GET /trpc/me HTTP/1.0\r\n\r\n'));
      let received = '';
      socket.on('data', (chunk) => (received += chunk));
      socket.on('end', () => resolve(received));
      socket.on('error', reject);
    });
    expect(reply.split('\r\n')[0]).toContain('421');
  });

  it('goes by the Host header, not X-Forwarded-Host', async () => {
    const spoofed = await get(guarded, '/trpc/me', { host: '127.0.0.1:4785', 'x-forwarded-host': 'evil.test' });
    expect(spoofed.statusCode).toBe(200);
    const reversed = await get(guarded, '/trpc/me', { host: 'evil.test', 'x-forwarded-host': '127.0.0.1:4785' });
    expect(reversed.statusCode).toBe(421);
  });

  it('leaves /healthz open to any Host', async () => {
    expect((await get(guarded, '/healthz', { host: 'evil.test' })).statusCode).toBe(200);
  });

  it('checks nothing when the setting is absent', async () => {
    expect((await get(testConfig, '/trpc/me', { host: 'evil.test' })).statusCode).toBe(200);
  });
});
