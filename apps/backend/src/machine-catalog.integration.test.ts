import {
  isBlindIndex,
  machineCatalogIndex,
  machineCatalogJson,
  openMachineCatalog,
  openMachineDirs,
  SEALED_LIMITS,
  sealMachineCatalog,
  sealMachineDirs,
} from '@agent-board/shared';
import type { MachineCatalog } from '@agent-board/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { machines } from './db/schema';
import { buildServer } from './server';
import { Changes } from './services/changes';
import { plainMachine } from './test/client';
import type { MachineAnswer } from './test/client';
import { caller, testConfig, useTestDb } from './test/helpers';
import { keysFor, sealed } from './test/sealed';

const { db, admin } = await useTestDb();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CATALOG: MachineCatalog = {
  claude: '2.1.326',
  models: [{ value: 'opus', label: 'Opus' }],
  skills: [{ name: 'review-pr', description: 'Review a pull request' }],
  dirs: { '/home/me/app': [{ name: 'deploy' }] },
};

/** What the CLI sends for `machine`'s catalogue: the sealed document and the blind index of the same bytes. */
async function body(machine: string, catalog = CATALOG) {
  return {
    catalog: await sealMachineCatalog(sealed.seal, machine, catalog),
    index: await machineCatalogIndex(await keysFor(), machine, catalog),
  };
}

let changes: Changes;
let app: Awaited<ReturnType<typeof buildServer>>;
beforeEach(async () => {
  changes = new Changes(20);
  app = await buildServer(testConfig, db, { changes });
});

/** A machine API caller for a freshly issued token of `name`. */
async function machine(name: string) {
  const { token } = await caller(db).machines.issue({ name });
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

const rows = () => admin.select().from(machines).orderBy(machines.name);

describe('set-catalog', () => {
  it('keeps the sealed catalogue and its index on the calling machine, and answers null', async () => {
    const laptop = await machine('laptop');
    const sent = await body('laptop');
    const answer = await laptop('set-catalog', { body: sent });
    expect(answer).toEqual({ status: 200, json: { result: null } });
    const [row] = await rows();
    expect(row).toMatchObject({ catalog: sent.catalog, catalogIndex: sent.index, dirs: null });
    expect(row?.catalogUpdatedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(row)).not.toContain('review-pr');
    const [listed] = await caller(db).machines.catalogs();
    expect(listed).toEqual({ name: 'laptop', catalog: sent.catalog, catalogUpdatedAt: row?.catalogUpdatedAt });
    expect(await openMachineCatalog(sealed.open, 'laptop', listed?.catalog)).toEqual(CATALOG);
    expect(JSON.stringify(await caller(db).machines.list())).not.toContain(sent.catalog);
  });

  it('replaces an earlier catalogue', async () => {
    const laptop = await machine('laptop');
    await laptop('set-catalog', { body: await body('laptop') });
    const second = await body('laptop', { ...CATALOG, skills: [] });
    await laptop('set-catalog', { body: second });
    expect((await rows())[0]).toMatchObject({ catalog: second.catalog, catalogIndex: second.index });
  });

  it('changes the row of the token’s own machine and no other', async () => {
    const laptop = await machine('laptop');
    await machine('desktop');
    await laptop('set-catalog', { body: await body('laptop') });
    const [desktop, mine] = await rows();
    expect(desktop).toMatchObject({ name: 'desktop', catalog: null, catalogIndex: null, catalogUpdatedAt: null });
    expect(mine?.catalog).not.toBeNull();
  });

  it('takes no machine name from the body', async () => {
    const laptop = await machine('laptop');
    await machine('desktop');
    const answer = await laptop('set-catalog', { machine: 'desktop', body: await body('laptop') });
    expect(answer.status).toBe(200);
    const [desktop] = await rows();
    expect(desktop?.catalog).toBeNull();
  });

  it('is stored as it comes: a catalogue sealed for laptop does not open as desktop’s, nor as a directory list', async () => {
    const desktop = await machine('desktop');
    await desktop('set-catalog', { body: await body('laptop') });
    const [row] = await rows();
    expect(await openMachineCatalog(sealed.open, 'desktop', row?.catalog)).toBeUndefined();
    expect(await openMachineDirs(sealed.open, 'laptop', row?.catalog)).toBeUndefined();
    expect(await openMachineCatalog(sealed.open, 'laptop', row?.catalog)).toEqual(CATALOG);
  });

  it('a directory list does not open as a catalogue', async () => {
    const laptop = await machine('laptop');
    await laptop('set-catalog', {
      body: { ...(await body('laptop')), catalog: await sealMachineDirs(sealed.seal, 'laptop', []) },
    });
    const [row] = await rows();
    expect(await openMachineCatalog(sealed.open, 'laptop', row?.catalog)).toBeUndefined();
  });

  it('refuses what is not a sealed catalogue with a blind index, and stores nothing', async () => {
    const laptop = await machine('laptop');
    const good = await body('laptop');
    const huge = `abe1.${'A'.repeat(Math.ceil((SEALED_LIMITS['machine.catalog'] * 4) / 3) + 100)}`;
    const attempts: [string, unknown][] = [
      ['no body', undefined],
      ['plain text', { catalog: machineCatalogJson(CATALOG), index: good.index }],
      ['no index', { catalog: good.catalog }],
      ['an envelope as the index', { catalog: good.catalog, index: good.catalog }],
      ['no catalogue', { index: good.index }],
      ['an unknown key', { ...good, extra: 1 }],
      ['too long a catalogue', { catalog: huge, index: good.index }],
      ['numbers', { catalog: 1, index: 2 }],
    ];
    for (const [what, payload] of attempts) {
      const answer = await laptop('set-catalog', payload === undefined ? {} : { body: payload });
      expect(answer.status, what).toBe(400);
    }
    expect((await rows())[0]).toMatchObject({ catalog: null, catalogIndex: null, catalogUpdatedAt: null });
  });

  it('sends no change event, where a task write sends one', async () => {
    const laptop = await machine('laptop');
    let events = 0;
    const stop = changes.subscribe('jascha', () => (events += 1));
    await laptop('set-catalog', { body: await body('laptop') });
    await sleep(200);
    expect(events).toBe(0);
    await plainMachine(laptop)('add-task', { body: { title: 'a task' } });
    await sleep(200);
    stop();
    expect(events).toBe(1);
  });
});

describe('the version answer', () => {
  it('carries the index of the calling machine’s catalogue, or null before it sent one', async () => {
    const laptop = await machine('laptop');
    const desktop = await machine('desktop');
    expect((await laptop('version')).json.result.catalogIndex).toBeNull();
    const sent = await body('laptop');
    await laptop('set-catalog', { body: sent });
    const { catalogIndex } = (await laptop('version')).json.result;
    expect(catalogIndex).toBe(sent.index);
    expect(isBlindIndex(catalogIndex)).toBe(true);
    expect((await desktop('version')).json.result.catalogIndex).toBeNull();
  });

  it('names the feature', async () => {
    const laptop = await machine('laptop');
    expect((await laptop('version')).json.result.features).toContain('machine.catalog');
  });
});

describe('revoking and issuing again', () => {
  it('revoke clears the catalogue, and machines.catalogs lists none for a revoked machine', async () => {
    const laptop = await machine('laptop');
    await laptop('set-catalog', { body: await body('laptop') });
    await caller(db).machines.revoke({ name: 'laptop' });
    expect((await rows())[0]).toMatchObject({ catalog: null, catalogIndex: null, catalogUpdatedAt: null });
    expect(await caller(db).machines.catalogs()).toEqual([]);
    expect((await laptop('set-catalog', { body: await body('laptop') })).status).toBe(401);
  });

  it('a new token for the machine starts without a catalogue', async () => {
    const laptop = await machine('laptop');
    await laptop('set-catalog', { body: await body('laptop') });
    await caller(db).machines.issue({ name: 'laptop' });
    expect((await rows())[0]).toMatchObject({ catalog: null, catalogIndex: null, catalogUpdatedAt: null });
  });
});

describe('machines.catalogs', () => {
  it('lists only the machines that sent a catalogue, by name', async () => {
    await machine('zebra');
    const laptop = await machine('laptop');
    const desktop = await machine('desktop');
    expect(await caller(db).machines.catalogs()).toEqual([]);
    await laptop('set-catalog', { body: await body('laptop') });
    await desktop('set-catalog', { body: await body('desktop') });
    expect((await caller(db).machines.catalogs()).map((m) => m.name)).toEqual(['desktop', 'laptop']);
  });

  it('is not part of machines.list', async () => {
    const laptop = await machine('laptop');
    await laptop('set-catalog', { body: await body('laptop') });
    const [listed] = await caller(db).machines.list();
    expect(listed).not.toHaveProperty('catalog');
    expect(listed).not.toHaveProperty('catalogUpdatedAt');
  });
});
