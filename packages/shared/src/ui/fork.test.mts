import { deriveKeys, open } from '../index.mts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canFork, forkProblem, InputError, sealFork, type ForkSource } from './requests.mts';

const keys = await deriveKeys(
  Uint8Array.from({ length: 32 }, (_, i) => i),
  'alice',
  { index: true },
);

const parent: ForkSource = {
  id: 'parent01',
  status: 'needs-me',
  closed: false,
  createdBy: 'user',
  machine: 'laptop',
  sessionId: '11111111-1111-4111-8111-111111111111',
  workdir: '/work/app',
  agent: null,
  unreadable: [],
};

describe('sealFork', () => {
  it('seals the instructions for the new task and its fork link, and the directory and title for the new task', async () => {
    const sealed = await sealFork(keys, { parent, title: ' Flaky test ', input: ' look into it ' });
    assert.equal(sealed.parentId, 'parent01');
    assert.notEqual(sealed.id, 'parent01');
    assert.equal(await open(keys, 'title', `task:${sealed.id}`, sealed.title), 'Flaky test');
    assert.equal(await open(keys, 'input', `task:${sealed.id}:user:fork:parent01`, sealed.input), 'look into it');
    assert.equal(await open(keys, 'workdir', `task:${sealed.id}`, sealed.workdir), '/work/app');
    assert.ok(!('agent' in sealed));
  });

  it('does not open as a task that is no fork, or as a fork of another task', async () => {
    const sealed = await sealFork(keys, { parent, title: 't', input: 'go' });
    await assert.rejects(open(keys, 'input', `task:${sealed.id}:user`, sealed.input));
    await assert.rejects(open(keys, 'input', `task:${sealed.id}:user:fork:other01`, sealed.input));
  });

  it('keeps the agent of the parent: sealed for the new task, and part of the context of the prompt after the link', async () => {
    const sealed = await sealFork(keys, { parent: { ...parent, agent: 'reviewer' }, title: 't', input: 'go' });
    assert.equal(await open(keys, 'agent', `task:${sealed.id}`, sealed.agent ?? ''), 'reviewer');
    assert.equal(await open(keys, 'input', `task:${sealed.id}:user:fork:parent01:agent:reviewer`, sealed.input), 'go');
  });

  it('takes a title from the instructions when it is empty, and needs instructions', async () => {
    const sealed = await sealFork(keys, { parent, title: ' ', input: 'look into it\nmore' });
    assert.equal(await open(keys, 'title', `task:${sealed.id}`, sealed.title), 'look into it');
    await assert.rejects(sealFork(keys, { parent, title: 't', input: '  ' }), InputError);
  });

  it('refuses what cannot be forked', async () => {
    for (const bad of [
      { createdBy: 'agent' as const },
      { createdBy: 'intake' as const, agent: null },
      { closed: true },
      { sessionId: null },
      { machine: null },
      { workdir: null },
      { unreadable: ['agent' as const] },
      { unreadable: ['workdir' as const] },
    ])
      await assert.rejects(sealFork(keys, { parent: { ...parent, ...bad }, title: 't', input: 'go' }), InputError);
  });
});

describe('canFork', () => {
  it('is a task with a session on a machine that is open and not an agent’s proposal', () => {
    assert.equal(canFork(parent), true);
    assert.match(forkProblem({ ...parent, workdir: null }) ?? '', /directory or agent/);
    for (const bad of [
      { sessionId: null },
      { machine: null },
      { closed: true },
      { createdBy: 'agent' as const },
      { createdBy: 'intake' as const },
    ])
      assert.equal(canFork({ ...parent, ...bad }), false);
    assert.equal(canFork({ ...parent, createdBy: 'intake', agent: 'reviewer' }), true);
    assert.equal(forkProblem(parent), undefined);
  });
});
