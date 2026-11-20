import { deriveKeys, openFields, openIcon, type RowRef } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { openerFor } from './opening';
import { InputError, sealConfigure, sealNewTask } from './sealing';

const keys = await deriveKeys(
  Uint8Array.from({ length: 32 }, (_, i) => i),
  'alice',
  { index: true },
);

const place = { machine: 'deskwork', workdir: '/home/me/code' };

/** What the task page does with the sealed directory: opens it for the row it comes from. */
async function opened(row: RowRef, workdir: string | undefined): Promise<string | null> {
  const fields = await openFields(openerFor(keys), row, { title: '', input: '', workdir });
  return fields.unreadable.includes('workdir') ? null : fields.workdir;
}

describe('sealConfigure', () => {
  it('seals the directory of a plain task so that the page opens it', async () => {
    const task = { id: 'task0001', createdBy: 'user', scheduleId: null } as const;
    const sealed = await sealConfigure(keys, { task, place });
    expect(sealed).toMatchObject({ id: 'task0001', place: { machine: 'deskwork' } });
    expect(await opened({ kind: 'task', forkOf: null, ...task }, sealed.place?.workdir)).toBe('/home/me/code');
    expect(await opened({ kind: 'task', forkOf: null, ...task, id: 'task0002' }, sealed.place?.workdir)).toBeNull();
  });

  it('seals the directory of an agent’s proposal the same way', async () => {
    const task = { id: 'task0001', createdBy: 'agent', scheduleId: null } as const;
    const sealed = await sealConfigure(keys, { task, place });
    expect(await opened({ kind: 'task', forkOf: null, ...task }, sealed.place?.workdir)).toBe('/home/me/code');
  });

  it('seals the directory of a schedule’s occurrence for both its task and its schedule', async () => {
    const task = { id: 'task0001', createdBy: 'user', scheduleId: 'sched001' } as const;
    const sealed = await sealConfigure(keys, { task, place });
    expect(await opened({ kind: 'task', forkOf: null, ...task }, sealed.place?.workdir)).toBe('/home/me/code');
    expect(
      await opened({ kind: 'task', forkOf: null, ...task, scheduleId: 'sched002' }, sealed.place?.workdir),
    ).toBeNull();
    expect(await opened({ kind: 'task', forkOf: null, ...task, scheduleId: null }, sealed.place?.workdir)).toBeNull();
  });

  it('seals a trimmed title for the row so that the page opens it, and refuses an empty one', async () => {
    const task = { id: 'task0001', createdBy: 'agent', scheduleId: null } as const;
    const sealed = await sealConfigure(keys, { task, title: '  Renamed \n' });
    expect(Object.keys(sealed)).toEqual(['id', 'title']);
    const row: RowRef = { kind: 'task', forkOf: null, ...task };
    expect((await openFields(openerFor(keys), row, { title: sealed.title!, input: '' })).title).toBe('Renamed');
    await expect(sealConfigure(keys, { task, title: '   ' })).rejects.toThrow(InputError);
  });

  it('refuses a title for a schedule’s occurrence, whose title is bound to the schedule', async () => {
    const task = { id: 'task0001', createdBy: 'user', scheduleId: 'sched001' } as const;
    await expect(sealConfigure(keys, { task, title: 'This sweep' })).rejects.toThrow(InputError);
  });

  it('sends only what changes: a model alone, no directory, or both', async () => {
    const task = { id: 'task0001', createdBy: 'user', scheduleId: null } as const;
    expect(await sealConfigure(keys, { task, model: 'opus' })).toEqual({ id: 'task0001', model: 'opus' });
    expect(await sealConfigure(keys, { task, model: null })).toEqual({ id: 'task0001', model: null });
    expect(await sealConfigure(keys, { task, effort: 'xhigh' })).toEqual({ id: 'task0001', effort: 'xhigh' });
    expect(await sealConfigure(keys, { task, effort: null })).toEqual({ id: 'task0001', effort: null });
    expect(await sealConfigure(keys, { task, autoDone: false })).toEqual({ id: 'task0001', autoDone: false });
    expect(await sealConfigure(keys, { task, place: null })).toEqual({ id: 'task0001', place: null });
    expect(await sealConfigure(keys, { task, model: 'haiku', place })).toMatchObject({
      model: 'haiku',
      place: { machine: 'deskwork' },
    });
  });
});

describe('the icon', () => {
  it('is sealed for the task, and a schedule’s for its occurrences, so the page opens it', async () => {
    const task = { id: 'task0001', createdBy: 'user', scheduleId: null } as const;
    const sealed = await sealConfigure(keys, { task, icon: '🚀' });
    expect(sealed.icon).toMatch(/^abe1\./);
    expect(await openIcon(openerFor(keys), { kind: 'task', forkOf: null, ...task }, sealed.icon)).toBe('🚀');
    expect(await sealConfigure(keys, { task, icon: null })).toEqual({ id: 'task0001', icon: null });
    await expect(sealConfigure(keys, { task, icon: 'rocket' })).rejects.toThrow('an icon must be one emoji');

    const repeat = await sealNewTask(keys, { input: '/sweep', icon: '🧹', when: { every: 3_600_000 } });
    const occurrence: RowRef = { kind: 'task', id: 'occ00001', createdBy: 'user', scheduleId: repeat.id, forkOf: null };
    expect(await openIcon(openerFor(keys), occurrence, repeat.icon)).toBe('🧹');
    expect(await sealNewTask(keys, { input: '/sweep' })).not.toHaveProperty('icon');
  });
});
