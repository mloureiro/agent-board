import { describe, expect, it } from 'vitest';
import type { Machine } from '@agent-board/shared/ui';
import { isCurrentPlace, unlistedMachine } from './workingDirectories';

const laptop = (dirs: string[] | null): Machine =>
  ({ name: 'laptop', shown: 'Laptop', dirs: dirs === null ? null : dirs.map((path) => ({ path })) }) as Machine;

describe('unlistedMachine', () => {
  const task = (workdir: string | null, machine: string | null = 'laptop') => ({ machine, workdir });

  it('is silent for a listed directory and for anything below one, by whole segments', () => {
    const machines = [laptop(['/work/app'])];
    expect(unlistedMachine(task('/work/app'), machines)).toBeUndefined();
    expect(unlistedMachine(task('/work/app/'), machines)).toBeUndefined();
    expect(unlistedMachine(task('/work/app/.claude/worktrees/x'), machines)).toBeUndefined();
  });

  it('names the machine when the directory is neither listed nor below a listed one', () => {
    const machines = [laptop(['/work/app'])];
    expect(unlistedMachine(task('/work/application'), machines)).toBe('Laptop');
    expect(unlistedMachine(task('/work'), machines)).toBe('Laptop');
  });

  it('is silent without a directory, a machine, or a readable list to compare with', () => {
    expect(unlistedMachine(task(null), [laptop(['/a'])])).toBeUndefined();
    expect(unlistedMachine(task('/x', null), [laptop(['/a'])])).toBeUndefined();
    expect(unlistedMachine(task('/x'), [laptop(null)])).toBeUndefined();
    expect(unlistedMachine(task('/x'), [laptop([])])).toBeUndefined();
    expect(unlistedMachine(task('/x', 'other'), [laptop(['/a'])])).toBeUndefined();
  });
});

describe('isCurrentPlace', () => {
  it('is true for the machine and directory the task already has', () => {
    expect(isCurrentPlace({ machine: 'laptop', workdir: '/work/app' }, { machine: 'laptop', path: '/work/app' })).toBe(
      true,
    );
  });

  it('is false for the same path on another machine and for another path', () => {
    const task = { machine: 'laptop', workdir: '/work/app' };
    expect(isCurrentPlace(task, { machine: 'desk', path: '/work/app' })).toBe(false);
    expect(isCurrentPlace(task, { machine: 'laptop', path: '/work/other' })).toBe(false);
  });

  it('treats no directory as current only for a task with neither a directory nor a machine', () => {
    expect(isCurrentPlace({ machine: null, workdir: null }, undefined)).toBe(true);
    expect(isCurrentPlace({ machine: 'laptop', workdir: null }, undefined)).toBe(false);
    expect(isCurrentPlace({ machine: 'laptop', workdir: '/work/app' }, undefined)).toBe(false);
  });
});
