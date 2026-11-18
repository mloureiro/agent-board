import {
  isBlindIndex,
  machineCatalogIndex,
  machineUsageIndex,
  machineUsageJson,
  openMachineCatalog,
  openMachineUsage,
  SEALED_LIMITS,
  sealMachineCatalog,
  sealMachineUsage,
} from '@agent-board/shared';
import type { MachineUsage } from '@agent-board/shared';
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

const USAGE: MachineUsage = {
  limits: { fiveHour: 80, priority: 'urgent' },
  windows: { fiveHour: { percent: 85, resetsAt: '2026-11-17T14:05:00.000Z', seenAt: '2026-11-17T12:00:00.000Z' } },
  reached: ['fiveHour'],
  held: ['taskA1'],
  open: ['taskB2'],
};

/** What the CLI sends for `machine`'s usage status: the sealed document and the blind index of the same bytes. */
async function body(machine: string, usage = USAGE) {
  return {
    usage: await sealMachineUsage(sealed.seal, machine, usage),
    index: await machineUsageIndex(await keysFor(), machine, usage),
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

describe('set-usage', () => {
  it('keeps the sealed status and its index on the calling machine, and answers null', async () => {
    const laptop = await machine('laptop');
    const sent = await body('laptop');
    const answer = await laptop('set-usage', { body: sent });
    expect(answer).toEqual({ status: 200, json: { result: null } });
    const [row] = await rows();
    expect(row).toMatchObject({ usage: sent.usage, usageIndex: sent.index, catalog: null });
    expect(row?.usageUpdatedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(row)).not.toContain('taskA1');
    const [listed] = await caller(db).machines.list();
    expect(listed).toMatchObject({ name: 'laptop', usage: sent.usage, usageUpdatedAt: row?.usageUpdatedAt });
    expect(await openMachineUsage(sealed.open, 'laptop', listed?.usage)).toEqual(USAGE);
  });

  it('replaces an earlier status', async () => {
    const laptop = await machine('laptop');
    await laptop('set-usage', { body: await body('laptop') });
    const second = await body('laptop', { ...USAGE, held: [] });
    await laptop('set-usage', { body: second });
    expect((await rows())[0]).toMatchObject({ usage: second.usage, usageIndex: second.index });
  });

  it('changes the row of the token’s own machine and no other', async () => {
    const laptop = await machine('laptop');
    await machine('desktop');
    await laptop('set-usage', { body: await body('laptop') });
    const [desktop, mine] = await rows();
    expect(desktop).toMatchObject({ name: 'desktop', usage: null, usageIndex: null, usageUpdatedAt: null });
    expect(mine?.usage).not.toBeNull();
  });

  it('takes no machine name from the body', async () => {
    const laptop = await machine('laptop');
    await machine('desktop');
    const answer = await laptop('set-usage', { machine: 'desktop', body: await body('laptop') });
    expect(answer.status).toBe(200);
    const [desktop] = await rows();
    expect(desktop?.usage).toBeNull();
  });

  it('is stored as it comes: a status sealed for laptop does not open as desktop’s, nor as a catalogue', async () => {
    const desktop = await machine('desktop');
    await desktop('set-usage', { body: await body('laptop') });
    const [row] = await rows();
    expect(await openMachineUsage(sealed.open, 'desktop', row?.usage)).toBeUndefined();
    expect(await openMachineCatalog(sealed.open, 'laptop', row?.usage)).toBeUndefined();
    expect(await openMachineUsage(sealed.open, 'laptop', row?.usage)).toEqual(USAGE);
  });

  it('a catalogue does not open as a usage status', async () => {
    const laptop = await machine('laptop');
    const catalog = { models: [], skills: [], dirs: {} };
    await laptop('set-usage', {
      body: { ...(await body('laptop')), usage: await sealMachineCatalog(sealed.seal, 'laptop', catalog) },
    });
    const [row] = await rows();
    expect(await openMachineUsage(sealed.open, 'laptop', row?.usage)).toBeUndefined();
    expect(await machineCatalogIndex(await keysFor(), 'laptop', catalog)).not.toBe(row?.usageIndex);
  });

  it('refuses what is not a sealed status with a blind index, and stores nothing', async () => {
    const laptop = await machine('laptop');
    const good = await body('laptop');
    const huge = `abe1.${'A'.repeat(Math.ceil((SEALED_LIMITS['machine.usage'] * 4) / 3) + 100)}`;
    const attempts: [string, unknown][] = [
      ['no body', undefined],
      ['plain text', { usage: machineUsageJson(USAGE), index: good.index }],
      ['no index', { usage: good.usage }],
      ['an envelope as the index', { usage: good.usage, index: good.usage }],
      ['no status', { index: good.index }],
      ['an unknown key', { ...good, extra: 1 }],
      ['too long a status', { usage: huge, index: good.index }],
      ['numbers', { usage: 1, index: 2 }],
    ];
    for (const [what, payload] of attempts) {
      const answer = await laptop('set-usage', payload === undefined ? {} : { body: payload });
      expect(answer.status, what).toBe(400);
    }
    expect((await rows())[0]).toMatchObject({ usage: null, usageIndex: null, usageUpdatedAt: null });
  });

  it('sends no change event, where a task write sends one', async () => {
    const laptop = await machine('laptop');
    let events = 0;
    const stop = changes.subscribe('jascha', () => (events += 1));
    await laptop('set-usage', { body: await body('laptop') });
    await sleep(200);
    expect(events).toBe(0);
    await plainMachine(laptop)('add-task', { body: { title: 'a task' } });
    await sleep(200);
    stop();
    expect(events).toBe(1);
  });
});

describe('the version answer', () => {
  it('carries the index of the calling machine’s status, or null before it sent one', async () => {
    const laptop = await machine('laptop');
    const desktop = await machine('desktop');
    expect((await laptop('version')).json.result.usageIndex).toBeNull();
    const sent = await body('laptop');
    await laptop('set-usage', { body: sent });
    const { usageIndex } = (await laptop('version')).json.result;
    expect(usageIndex).toBe(sent.index);
    expect(isBlindIndex(usageIndex)).toBe(true);
    expect((await desktop('version')).json.result.usageIndex).toBeNull();
  });

  it('names the feature', async () => {
    const laptop = await machine('laptop');
    expect((await laptop('version')).json.result.features).toContain('machine.usage');
  });
});

describe('revoking and issuing again', () => {
  it('revoke clears the status', async () => {
    const laptop = await machine('laptop');
    await laptop('set-usage', { body: await body('laptop') });
    await caller(db).machines.revoke({ name: 'laptop' });
    expect((await rows())[0]).toMatchObject({ usage: null, usageIndex: null, usageUpdatedAt: null });
    expect((await laptop('set-usage', { body: await body('laptop') })).status).toBe(401);
  });

  it('a new token for the machine starts without a status', async () => {
    const laptop = await machine('laptop');
    await laptop('set-usage', { body: await body('laptop') });
    await caller(db).machines.issue({ name: 'laptop' });
    expect((await rows())[0]).toMatchObject({ usage: null, usageIndex: null, usageUpdatedAt: null });
  });
});
