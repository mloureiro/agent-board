import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { machines } from './db/schema';
import { buildServer } from './server';
import type { MachineAnswer } from './test/client';
import { caller, testConfig, useTestDb } from './test/helpers';

const { db, admin } = useTestDb();

let app: Awaited<ReturnType<typeof buildServer>>;
beforeEach(async () => {
  app = await buildServer(testConfig, db);
});

async function machine(name: string, owner = 'jascha') {
  const { token } = await caller(db, owner).machines.issue({ name });
  return async (command: string, payload: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machine/${command}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    return { status: res.statusCode, json: res.json() as MachineAnswer['json'] };
  };
}

describe('list-machines', () => {
  it('lists the machines of the owner by name and marks only the caller as current', async () => {
    const laptop = await machine('laptop');
    await machine('desktop');
    await laptop('version');
    const answer = await laptop('list-machines');
    expect(answer.status).toBe(200);
    expect(answer.json.result).toEqual({
      machines: [
        { name: 'desktop', lastSeenAt: null, current: false },
        { name: 'laptop', lastSeenAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/), current: true },
      ],
    });
  });

  it('leaves out a revoked machine', async () => {
    const laptop = await machine('laptop');
    await machine('desktop');
    await caller(db).machines.revoke({ name: 'desktop' });
    const answer = await laptop('list-machines');
    expect(answer.json.result.machines.map((entry: { name: string }) => entry.name)).toEqual(['laptop']);
    expect((await admin.select().from(machines).where(eq(machines.name, 'desktop')))[0]?.revokedAt).not.toBeNull();
  });

  it('never shows the machine of another owner', async () => {
    const laptop = await machine('laptop');
    await machine('carols-laptop', 'carol');
    const answer = await laptop('list-machines');
    expect(answer.json.result.machines.map((entry: { name: string }) => entry.name)).toEqual(['laptop']);
  });

  it('refuses a request with a key', async () => {
    const laptop = await machine('laptop');
    expect((await laptop('list-machines', { all: true })).status).toBe(400);
  });

  it('is advertised by the version answer', async () => {
    const laptop = await machine('laptop');
    expect((await laptop('version')).json.result.features).toContain('machine.list');
  });
});
