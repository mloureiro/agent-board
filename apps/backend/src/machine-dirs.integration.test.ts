import {
  isBlindIndex,
  machineDirsIndex,
  machineDirsJson,
  openMachineDirs,
  SEALED_LIMITS,
  sealMachineDirs,
} from '@agent-board/shared';
import { sql } from 'drizzle-orm';
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

const LIST = [{ path: '/home/me/app' }, { path: '/home/me/lib' }];

/** What the CLI sends for `machine`'s list: the sealed document and the blind index of the same bytes. */
async function body(machine: string, dirs = LIST) {
  return {
    dirs: await sealMachineDirs(sealed.seal, machine, dirs),
    index: await machineDirsIndex(await keysFor(), machine, dirs),
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

describe('set-dirs', () => {
  it('keeps the sealed list and its index on the calling machine, and answers null', async () => {
    const laptop = await machine('laptop');
    const sent = await body('laptop');
    const answer = await laptop('set-dirs', { body: sent });
    expect(answer).toEqual({ status: 200, json: { result: null } });
    const [row] = await rows();
    expect(row).toMatchObject({ dirs: sent.dirs, dirsIndex: sent.index });
    expect(row?.dirsUpdatedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(row)).not.toContain('/home/me');
    const [listed] = await caller(db).machines.list();
    expect(listed).toMatchObject({ name: 'laptop', dirs: sent.dirs, dirsUpdatedAt: row?.dirsUpdatedAt });
    expect(await openMachineDirs(sealed.open, 'laptop', listed?.dirs)).toEqual(LIST);
  });

  it('replaces an earlier list', async () => {
    const laptop = await machine('laptop');
    await laptop('set-dirs', { body: await body('laptop') });
    const second = await body('laptop', [{ path: '/srv/x' }]);
    await laptop('set-dirs', { body: second });
    expect((await rows())[0]).toMatchObject({ dirs: second.dirs, dirsIndex: second.index });
  });

  it('changes the row of the token’s own machine and no other', async () => {
    const laptop = await machine('laptop');
    await machine('desktop');
    await laptop('set-dirs', { body: await body('laptop') });
    const [desktop, mine] = await rows();
    expect(desktop).toMatchObject({ name: 'desktop', dirs: null, dirsIndex: null, dirsUpdatedAt: null });
    expect(mine?.name).toBe('laptop');
    expect(mine?.dirs).not.toBeNull();
  });

  it('takes no machine name from the body', async () => {
    const laptop = await machine('laptop');
    await machine('desktop');
    const answer = await laptop('set-dirs', { machine: 'desktop', body: await body('laptop') });
    expect(answer.status).toBe(200);
    const [desktop] = await rows();
    expect(desktop?.dirs).toBeNull();
  });

  it('is stored for another machine as it comes: the list sealed for laptop does not open as desktop’s', async () => {
    const desktop = await machine('desktop');
    await desktop('set-dirs', { body: await body('laptop') });
    const [row] = await rows();
    expect(await openMachineDirs(sealed.open, 'desktop', row?.dirs)).toBeUndefined();
    expect(await openMachineDirs(sealed.open, 'laptop', row?.dirs)).toEqual(LIST);
  });

  it('refuses what is not a sealed list with a blind index, and stores nothing', async () => {
    const laptop = await machine('laptop');
    const good = await body('laptop');
    const huge = `abe1.${'A'.repeat(Math.ceil((SEALED_LIMITS['machine.dirs'] * 4) / 3) + 100)}`;
    const attempts: [string, unknown][] = [
      ['no body', undefined],
      ['plain text', { dirs: machineDirsJson(LIST), index: good.index }],
      ['no index', { dirs: good.dirs }],
      ['an envelope as the index', { dirs: good.dirs, index: good.dirs }],
      ['no list', { index: good.index }],
      ['an unknown key', { ...good, extra: 1 }],
      ['too long a list', { dirs: huge, index: good.index }],
      ['numbers', { dirs: 1, index: 2 }],
    ];
    for (const [what, payload] of attempts) {
      const answer = await laptop('set-dirs', payload === undefined ? {} : { body: payload });
      expect(answer.status, what).toBe(400);
    }
    expect((await rows())[0]).toMatchObject({ dirs: null, dirsIndex: null, dirsUpdatedAt: null });
  });

  it('sends no change event, where a task write sends one', async () => {
    const laptop = await machine('laptop');
    let events = 0;
    const stop = changes.subscribe('jascha', () => (events += 1));
    await laptop('set-dirs', { body: await body('laptop') });
    await sleep(200);
    expect(events).toBe(0);
    await plainMachine(laptop)('add-task', { body: { title: 'a task' } });
    await sleep(200);
    stop();
    expect(events).toBe(1);
  });
});

describe('the version answer', () => {
  it('carries the index of the calling machine’s list, or null before it sent one', async () => {
    const laptop = await machine('laptop');
    const desktop = await machine('desktop');
    expect((await laptop('version')).json.result.dirsIndex).toBeNull();
    const sent = await body('laptop');
    await laptop('set-dirs', { body: sent });
    const { dirsIndex } = (await laptop('version')).json.result;
    expect(dirsIndex).toBe(sent.index);
    expect(isBlindIndex(dirsIndex)).toBe(true);
    expect((await desktop('version')).json.result.dirsIndex).toBeNull();
  });

  it('names the feature', async () => {
    const laptop = await machine('laptop');
    expect((await laptop('version')).json.result.features).toContain('machine.dirs');
  });
});

describe('revoking and issuing again', () => {
  it('revoke clears the list, and machines.list shows none for a revoked machine', async () => {
    const laptop = await machine('laptop');
    await laptop('set-dirs', { body: await body('laptop') });
    await caller(db).machines.revoke({ name: 'laptop' });
    expect((await rows())[0]).toMatchObject({ dirs: null, dirsIndex: null, dirsUpdatedAt: null });
    expect(await caller(db).machines.list()).toEqual([
      expect.objectContaining({ name: 'laptop', dirs: null, dirsUpdatedAt: null }),
    ]);
    expect((await laptop('set-dirs', { body: await body('laptop') })).status).toBe(401);
  });

  it('a new token for the machine starts without a list', async () => {
    const laptop = await machine('laptop');
    await laptop('set-dirs', { body: await body('laptop') });
    await caller(db).machines.issue({ name: 'laptop' });
    expect((await rows())[0]).toMatchObject({ dirs: null, dirsIndex: null, dirsUpdatedAt: null });
    await expect(admin.execute(sql`select 1 from machine where dirs is not null`)).resolves.toMatchObject({
      rowCount: 0,
    });
  });
});

describe('machines.list', () => {
  it('has no list for a machine that sent none', async () => {
    await machine('laptop');
    expect(await caller(db).machines.list()).toEqual([
      expect.objectContaining({ name: 'laptop', dirs: null, dirsUpdatedAt: null }),
    ]);
  });
});
