import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from './config';
import { buildServer } from './server';
import { testConfig, useTestDb } from './test/helpers';

const { db } = await useTestDb();

const SECRET = 'proxy-secret-0123456789abcdef0123456789';
const remote = { 'remote-user': 'jascha', 'remote-groups': 'admins' };

const open: { close(): Promise<unknown> }[] = [];
afterEach(() => Promise.all(open.splice(0).map((app) => app.close())));

async function serve(options: Partial<Config> = { proxySecret: SECRET }) {
  const app = await buildServer({ ...testConfig, ...options }, db);
  open.push(app);
  const me = async (headers: Record<string, string>) =>
    (await app.inject({ method: 'GET', url: '/trpc/me', headers })).statusCode;
  return { app, me };
}

describe('the proxy secret', () => {
  it('accepts Remote-* with the secret', async () => {
    const { me } = await serve();
    expect(await me({ ...remote, 'board-proxy-secret': SECRET })).toBe(200);
  });

  it('refuses Remote-* without the secret or with a wrong one', async () => {
    const { me } = await serve();
    expect(await me(remote)).toBe(403);
    expect(await me({ ...remote, 'board-proxy-secret': '' })).toBe(403);
    expect(await me({ ...remote, 'board-proxy-secret': `${SECRET.slice(0, -1)}x` })).toBe(403);
    expect(await me({ ...remote, 'board-proxy-secret': SECRET.slice(0, -1) })).toBe(403);
    expect(await me({ ...remote, 'board-proxy-secret': `${SECRET}x` })).toBe(403);
  });

  it('refuses the secret without a user in an allowed group', async () => {
    const { me } = await serve();
    expect(await me({ 'board-proxy-secret': SECRET })).toBe(403);
    expect(await me({ 'remote-user': 'x', 'remote-groups': 'family-tree', 'board-proxy-secret': SECRET })).toBe(403);
  });

  it('leaves /healthz and the machine API to their own checks', async () => {
    const { app } = await serve();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const machine = await app.inject({ method: 'POST', url: '/api/machine/list-tasks', payload: {} });
    expect(machine.statusCode).toBe(401);
  });

  it('is not checked when unset', async () => {
    const { me } = await serve({ proxySecret: null });
    expect(await me(remote)).toBe(200);
  });

  it('yields to DEV_AUTH_USER', async () => {
    const { me } = await serve({ proxySecret: SECRET, devAuthUser: 'alice' });
    expect(await me({})).toBe(200);
  });
});
