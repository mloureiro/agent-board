import { openSharedAgents, sealSharedAgents } from '@agent-board/shared';
import type { SharedAgentsDocument } from '@agent-board/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { sharedAgents } from './db/schema';
import { buildServer } from './server';
import { Changes } from './services/changes';
import type { MachineAnswer } from './test/client';
import { caller, testConfig, useTestDb } from './test/helpers';
import { sealed, sealerFor } from './test/sealed';

const { db, admin } = await useTestDb();

const REVIEWER = { description: 'Reviews', tools: ['Read'], allowedTools: ['Read'] };

const doc = (
  version: number,
  agents: SharedAgentsDocument['agents'] = { reviewer: REVIEWER },
): SharedAgentsDocument => ({
  version,
  agents,
});

/** What `board agents push` sends: the next version sealed under its own binding. */
async function body(version: number, agents?: SharedAgentsDocument['agents'], seal = sealed.seal) {
  return { document: await sealSharedAgents(seal, doc(version, agents)), version, expectedVersion: version - 1 };
}

let changes: Changes;
let app: Awaited<ReturnType<typeof buildServer>>;
beforeEach(async () => {
  changes = new Changes(20);
  app = await buildServer(testConfig, db, { changes });
});

/** A machine API caller for a freshly issued token of `name`, of `username`'s board. */
async function machine(name: string, username = 'jascha') {
  const { token } = await caller(db, username).machines.issue({ name });
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

const result = (answer: { json: MachineAnswer['json'] }): unknown => (answer.json as { result?: unknown }).result;

describe('get-agents and set-agents', () => {
  it('stores the sealed document per user, names its version in the version answer, and serves it to every machine', async () => {
    const laptop = await machine('laptop');
    const desktop = await machine('desktop');
    expect(result(await laptop('version'))).toMatchObject({
      agentsVersion: null,
      features: expect.arrayContaining(['agents.shared']),
    });
    expect(result(await desktop('get-agents'))).toBeNull();

    const sent = await body(1);
    expect(await laptop('set-agents', { body: sent })).toEqual({ status: 200, json: { result: null } });
    expect(result(await desktop('version'))).toMatchObject({ agentsVersion: 1 });
    const served = result(await desktop('get-agents')) as { version: number; document: string };
    expect(served).toEqual({ version: 1, document: sent.document });
    expect(await openSharedAgents(sealed.open, 1, served.document)).toEqual(doc(1));
    const [row] = await admin.select().from(sharedAgents);
    expect(row).toMatchObject({ owner: 'jascha', version: 1 });
    expect(JSON.stringify(row)).not.toContain('reviewer');
  });

  it('is compare-and-set: a push against a version that moved on is a 409, and the stored one stays', async () => {
    const laptop = await machine('laptop');
    await laptop('set-agents', { body: await body(1) });
    const second = await body(2, { reviewer: REVIEWER, writer: REVIEWER });
    expect((await laptop('set-agents', { body: second })).status).toBe(200);
    // Another CLI fetched version 1 and pushes its change on top of it.
    const late = await laptop('set-agents', { body: await body(2, {}) });
    expect(late.status).toBe(409);
    expect(JSON.stringify(late.json)).toMatch(/holds version 2 of the shared agents, not 1/);
    const first = await laptop('set-agents', { body: await body(1, {}) });
    expect(first.status).toBe(409);
    expect(result(await laptop('get-agents'))).toEqual({ version: 2, document: second.document });
  });

  it('refuses a version that is not expectedVersion + 1, a plain document and unknown keys', async () => {
    const laptop = await machine('laptop');
    const sealedDoc = (await body(1)).document;
    for (const bad of [
      { document: sealedDoc, version: 3, expectedVersion: 1 },
      { document: sealedDoc, version: 1, expectedVersion: -1 },
      { document: JSON.stringify(doc(1)), version: 1, expectedVersion: 0 },
      { document: sealedDoc, version: 1, expectedVersion: 0, agents: {} },
    ])
      expect((await laptop('set-agents', { body: bad })).status).toBe(400);
    expect(await admin.select().from(sharedAgents)).toEqual([]);
  });

  it("keeps each user's document to their own machines", async () => {
    const mine = await machine('laptop');
    const theirs = await machine('laptop', 'other');
    await mine('set-agents', { body: await body(1) });
    expect(result(await theirs('get-agents'))).toBeNull();
    expect(result(await theirs('version'))).toMatchObject({ agentsVersion: null });
    await theirs('set-agents', { body: await body(1, {}, sealerFor('other').seal) });
    expect(result(await mine('version'))).toMatchObject({ agentsVersion: 1 });
    expect((await admin.select().from(sharedAgents)).map(({ owner }) => owner).sort()).toEqual(['jascha', 'other']);
  });

  it('tells the listeners, so every machine applies a push on its next tick', async () => {
    const laptop = await machine('laptop');
    let told = 0;
    changes.subscribe('jascha', () => told++);
    await laptop('set-agents', { body: await body(1) });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(told).toBeGreaterThan(0);
  });
});

describe('the browser read', () => {
  it("serves the user's own document with its version and push time, and null before any push", async () => {
    const laptop = await machine('laptop');
    await machine('laptop', 'other');
    expect(await caller(db).agents.shared()).toBeNull();
    const before = Date.now();
    const sent = await body(1);
    await laptop('set-agents', { body: sent });
    const read = await caller(db).agents.shared();
    expect(read).toMatchObject({ version: 1, document: sent.document });
    expect(read?.pushedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await openSharedAgents(sealed.open, 1, read?.document ?? '')).toEqual(doc(1));
    expect(await caller(db, 'other').agents.shared()).toBeNull();
  });
});
