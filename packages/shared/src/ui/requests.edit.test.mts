import { deriveKeys, openFields, sealFields, textBeforeEdit, type RowRef } from '../index.mts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sealerFor } from './requests.mts';
import { openerFor } from './responses.mts';
import { InputError, sealEdit, sealScheduleUpdate, type EditTarget, type ScheduleUpdate } from './requests.mts';

const keys = await deriveKeys(
  Uint8Array.from({ length: 32 }, (_, i) => i),
  'alice',
  { index: true },
);

const target = (overrides: Partial<EditTarget> = {}): EditTarget => ({
  id: 'task0001',
  title: 'Old title',
  input: 'Old prompt',
  createdBy: 'user',
  scheduleId: null,
  agent: null,
  unreadable: [],
  ...overrides,
});

/** What the board does with the sealed fields: opens them for the row they are on. */
const opened = (row: RowRef, wire: { title: string; input: string; agent?: string }) =>
  openFields(openerFor(keys), row, wire);

describe('sealEdit', () => {
  it('seals the new title and prompt so that the task’s row opens them, and no other row does', async () => {
    const sealed = await sealEdit(keys, { target: target(), title: ' New title ', input: ' New prompt\n' });
    const row: RowRef = { kind: 'task', id: 'task0001', createdBy: 'user', scheduleId: null, forkOf: null };
    assert.partialDeepStrictEqual(await opened(row, sealed), {
      title: 'New title',
      input: 'New prompt',
      unreadable: [],
    });
    assert.deepEqual((await opened({ ...row, id: 'task0002' }, sealed)).unreadable, ['title', 'input']);
  });

  it('keeps the fork link of a fork: the edited prompt opens under it and under no other', async () => {
    const sealed = await sealEdit(keys, { target: target({ forkOf: 'parent01' }), title: 'a', input: 'b' });
    const row: RowRef = { kind: 'task', id: 'task0001', createdBy: 'user', scheduleId: null, forkOf: 'parent01' };
    assert.deepEqual((await opened(row, sealed)).unreadable, []);
    assert.deepEqual((await opened({ ...row, forkOf: null }, sealed)).unreadable, ['input']);
    assert.deepEqual((await opened({ ...row, forkOf: 'parent02' }, sealed)).unreadable, ['input']);
  });

  it('seals the old text as a note of the user’s', async () => {
    const sealed = await sealEdit(keys, { target: target(), title: 'a', input: 'b' });
    assert.match(sealed.previous.body, /^abe1\./);
    assert.equal(textBeforeEdit(target()), 'Prompt before editing\n\nTitle: Old title\n\n```\nOld prompt\n```');
  });

  it('refuses a schedule’s occurrence, which a sealed edit could be replayed on as the schedule’s prompt', async () => {
    await assert.rejects(
      sealEdit(keys, { target: target({ scheduleId: 'sched001' }), title: 'a', input: 'b' }),
      /Schedules page/,
    );
  });

  it('binds the prompt to the agent the task runs as', async () => {
    const sealed = await sealEdit(keys, { target: target({ agent: 'reviewer' }), title: 'a', input: 'b' });
    const row: RowRef = { kind: 'task', id: 'task0001', createdBy: 'user', scheduleId: null, forkOf: null };
    const { agent } = await sealFields(sealerFor(keys), { ...row, agent: 'reviewer' }, { title: '', input: '' });
    assert.partialDeepStrictEqual(await opened(row, { ...sealed, agent }), {
      input: 'b',
      agent: 'reviewer',
      unreadable: [],
    });
    assert.deepEqual((await opened(row, sealed)).unreadable, ['input']);
  });

  it('takes a title from the prompt when the title is blank, and refuses an empty prompt', async () => {
    const sealed = await sealEdit(keys, { target: target(), title: '  ', input: 'Fix the export' });
    const row: RowRef = { kind: 'task', id: 'task0001', createdBy: 'user', scheduleId: null, forkOf: null };
    assert.equal((await opened(row, sealed)).title, 'Fix the export');
    await assert.rejects(sealEdit(keys, { target: target(), title: 't', input: '  ' }), InputError);
  });

  it('refuses a task that is not the user’s or that cannot be read, since the old text could not be kept', async () => {
    await assert.rejects(
      sealEdit(keys, { target: target({ createdBy: 'agent' }), title: 'a', input: 'b' }),
      InputError,
    );
    await assert.rejects(
      sealEdit(keys, { target: target({ unreadable: ['input'] }), title: 'a', input: 'b' }),
      InputError,
    );
  });
});

describe('sealScheduleUpdate', () => {
  const update = (overrides: Partial<ScheduleUpdate> = {}): ScheduleUpdate => ({
    id: 'sched001',
    title: 'Nightly',
    input: 'sweep',
    agent: null,
    place: null,
    priority: 'normal',
    model: null,
    autoDone: false,
    repeat: { everyMs: 3_600_000 },
    runsLeft: null,
    until: null,
    maxConcurrent: null,
    unreadable: [],
    ...overrides,
  });

  it('seals the title, prompt, directory and agent under the schedule, and passes the clear fields on', async () => {
    const sealed = await sealScheduleUpdate(
      keys,
      update({ agent: ' auditor ', place: { machine: 'laptop', workdir: '/work' }, priority: 'high', runsLeft: 3 }),
    );
    assert.partialDeepStrictEqual(sealed, {
      id: 'sched001',
      priority: 'high',
      runsLeft: 3,
      repeat: { everyMs: 3_600_000 },
      place: { machine: 'laptop' },
    });
    assert.ok(!('unreadable' in sealed));
    assert.partialDeepStrictEqual(
      await openFields(
        openerFor(keys),
        { kind: 'schedule', id: 'sched001' },
        { ...sealed, workdir: sealed.place?.workdir },
      ),
      { title: 'Nightly', input: 'sweep', agent: 'auditor', workdir: '/work', unreadable: [] },
    );
    assert.ok((await opened({ kind: 'schedule', id: 'sched002' }, sealed)).unreadable.includes('title'));
  });

  it('seals again under a new agent, which the old one does not open', async () => {
    const withAgent = await sealScheduleUpdate(keys, update({ agent: 'auditor' }));
    const without = await sealScheduleUpdate(keys, update());
    assert.ok(!('agent' in without));
    assert.notEqual(without.input, withAgent.input);
  });

  it('leaves no directory sealed for none', async () => {
    assert.equal((await sealScheduleUpdate(keys, update())).place, null);
  });

  it('refuses an empty prompt, a bad agent name and a schedule that cannot be read', async () => {
    await assert.rejects(sealScheduleUpdate(keys, update({ input: ' ' })), InputError);
    await assert.rejects(sealScheduleUpdate(keys, update({ agent: 'not an agent!' })), InputError);
    await assert.rejects(sealScheduleUpdate(keys, update({ unreadable: ['input'] })), InputError);
  });
});
