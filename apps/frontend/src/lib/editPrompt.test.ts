import { describe, expect, it } from 'vitest';
import { canEditPrompt } from './editPrompt';
import type { BoardTask } from '@agent-board/shared/ui';

const task = (overrides: Partial<BoardTask> = {}): Parameters<typeof canEditPrompt>[0] => ({
  createdBy: 'user',
  scheduleId: null,
  proposed: false,
  closed: false,
  status: 'backlog',
  started: false,
  unreadable: [],
  ...overrides,
});

describe('canEditPrompt', () => {
  it('is true for a task of yours waiting in Todo or Backlog that never started', () => {
    expect(canEditPrompt(task({ status: 'backlog' }))).toBe(true);
    expect(canEditPrompt(task({ status: 'todo' }))).toBe(true);
  });

  it('is false once a worker claimed it, whatever it is doing now', () => {
    expect(canEditPrompt(task({ status: 'todo', started: true }))).toBe(false);
    expect(canEditPrompt(task({ status: 'backlog', started: true }))).toBe(false);
  });

  it.each(['needs-me', 'running', 'waiting', 'done'] as const)('is false in %s', (status) => {
    expect(canEditPrompt(task({ status }))).toBe(false);
  });

  it('is false for a closed task, an agent’s task and a proposal', () => {
    expect(canEditPrompt(task({ closed: true }))).toBe(false);
    expect(canEditPrompt(task({ createdBy: 'agent' }))).toBe(false);
    expect(canEditPrompt(task({ proposed: true }))).toBe(false);
  });

  it('is false for a schedule’s card, which is edited through its schedule', () => {
    expect(canEditPrompt(task({ scheduleId: 'sched001', status: 'todo' }))).toBe(false);
  });

  it('is false when something of the task cannot be read, except its watches', () => {
    expect(canEditPrompt(task({ unreadable: ['input'] }))).toBe(false);
    expect(canEditPrompt(task({ unreadable: ['agent'] }))).toBe(false);
    expect(canEditPrompt(task({ unreadable: ['watches'] }))).toBe(true);
  });
});
