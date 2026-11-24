import { deriveKeys, openFields, openIcon, openLabels, type RowRef } from '../index.mts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openerFor } from './responses.mts';
import { InputError, sealConfigure, sealNewTask } from './requests.mts';

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
    assert.partialDeepStrictEqual(sealed, { id: 'task0001', place: { machine: 'deskwork' } });
    assert.equal(await opened({ kind: 'task', forkOf: null, ...task }, sealed.place?.workdir), '/home/me/code');
    assert.equal(await opened({ kind: 'task', forkOf: null, ...task, id: 'task0002' }, sealed.place?.workdir), null);
  });

  it('seals the directory of an agent’s proposal the same way', async () => {
    const task = { id: 'task0001', createdBy: 'agent', scheduleId: null } as const;
    const sealed = await sealConfigure(keys, { task, place });
    assert.equal(await opened({ kind: 'task', forkOf: null, ...task }, sealed.place?.workdir), '/home/me/code');
  });

  it('seals the directory of a schedule’s occurrence for both its task and its schedule', async () => {
    const task = { id: 'task0001', createdBy: 'user', scheduleId: 'sched001' } as const;
    const sealed = await sealConfigure(keys, { task, place });
    assert.equal(await opened({ kind: 'task', forkOf: null, ...task }, sealed.place?.workdir), '/home/me/code');
    assert.equal(
      await opened({ kind: 'task', forkOf: null, ...task, scheduleId: 'sched002' }, sealed.place?.workdir),
      null,
    );
    assert.equal(await opened({ kind: 'task', forkOf: null, ...task, scheduleId: null }, sealed.place?.workdir), null);
  });

  it('seals a trimmed title for the row so that the page opens it, and refuses an empty one', async () => {
    const task = { id: 'task0001', createdBy: 'agent', scheduleId: null } as const;
    const sealed = await sealConfigure(keys, { task, title: '  Renamed \n' });
    assert.deepEqual(Object.keys(sealed), ['id', 'title']);
    const row: RowRef = { kind: 'task', forkOf: null, ...task };
    assert.equal((await openFields(openerFor(keys), row, { title: sealed.title!, input: '' })).title, 'Renamed');
    await assert.rejects(sealConfigure(keys, { task, title: '   ' }), InputError);
  });

  it('refuses a title for a schedule’s occurrence, whose title is bound to the schedule', async () => {
    const task = { id: 'task0001', createdBy: 'user', scheduleId: 'sched001' } as const;
    await assert.rejects(sealConfigure(keys, { task, title: 'This sweep' }), InputError);
  });

  it('sends only what changes: a model alone, no directory, or both', async () => {
    const task = { id: 'task0001', createdBy: 'user', scheduleId: null } as const;
    assert.deepEqual(await sealConfigure(keys, { task, model: 'opus' }), { id: 'task0001', model: 'opus' });
    assert.deepEqual(await sealConfigure(keys, { task, model: null }), { id: 'task0001', model: null });
    assert.deepEqual(await sealConfigure(keys, { task, effort: 'xhigh' }), { id: 'task0001', effort: 'xhigh' });
    assert.deepEqual(await sealConfigure(keys, { task, effort: null }), { id: 'task0001', effort: null });
    assert.deepEqual(await sealConfigure(keys, { task, autoDone: false }), { id: 'task0001', autoDone: false });
    assert.deepEqual(await sealConfigure(keys, { task, place: null }), { id: 'task0001', place: null });
    assert.partialDeepStrictEqual(await sealConfigure(keys, { task, model: 'haiku', place }), {
      model: 'haiku',
      place: { machine: 'deskwork' },
    });
  });
});

describe('the icon', () => {
  it('is sealed for the task, and a schedule’s for its occurrences, so the page opens it', async () => {
    const task = { id: 'task0001', createdBy: 'user', scheduleId: null } as const;
    const sealed = await sealConfigure(keys, { task, icon: '🚀' });
    assert.match(sealed.icon ?? '', /^abe1\./);
    assert.equal(await openIcon(openerFor(keys), { kind: 'task', forkOf: null, ...task }, sealed.icon), '🚀');
    assert.deepEqual(await sealConfigure(keys, { task, icon: null }), { id: 'task0001', icon: null });
    await assert.rejects(sealConfigure(keys, { task, icon: 'rocket' }), /an icon must be one emoji/);

    const repeat = await sealNewTask(keys, { input: '/sweep', icon: '🧹', when: { every: 3_600_000 } });
    const occurrence: RowRef = { kind: 'task', id: 'occ00001', createdBy: 'user', scheduleId: repeat.id, forkOf: null };
    assert.equal(await openIcon(openerFor(keys), occurrence, repeat.icon), '🧹');
    assert.ok(!('icon' in (await sealNewTask(keys, { input: '/sweep' }))));
  });
});

describe('the labels', () => {
  it('are sealed for the task, a schedule’s for its occurrences, and an empty list clears them', async () => {
    const task = { id: 'task0001', createdBy: 'user', scheduleId: null } as const;
    const row: RowRef = { kind: 'task', forkOf: null, ...task };
    const sealed = await sealConfigure(keys, { task, labels: ['bug', ' ui ', 'Bug'] });
    assert.match(sealed.labels ?? '', /^abe1\./);
    assert.deepEqual(await openLabels(openerFor(keys), row, sealed.labels), ['bug', 'ui']);
    assert.deepEqual(await sealConfigure(keys, { task, labels: [] }), { id: 'task0001', labels: null });
    await assert.rejects(sealConfigure(keys, { task, labels: ['-x'] }), InputError);

    const repeat = await sealNewTask(keys, { input: '/sweep', labels: ['chore'], when: { every: 3_600_000 } });
    const occurrence: RowRef = { kind: 'task', id: 'occ00001', createdBy: 'user', scheduleId: repeat.id, forkOf: null };
    assert.deepEqual(await openLabels(openerFor(keys), occurrence, repeat.labels), ['chore']);
    assert.ok(!('labels' in (await sealNewTask(keys, { input: '/sweep', labels: [] }))));
  });
});
