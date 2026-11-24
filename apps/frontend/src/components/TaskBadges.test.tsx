import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clock, stamp } from '../lib/time';
import type { BoardTask } from '../lib/trpc';
import type { TaskHold } from '../lib/usageHold';
import { TaskBadges } from './TaskBadges';

const task = (overrides: Partial<BoardTask>) =>
  ({
    id: 'a',
    status: 'todo',
    priority: 'normal',
    skillLabels: [],
    labels: [],
    next: 'fresh',
    paused: false,
    openQuestion: false,
    proposed: false,
    borrowed: false,
    machine: null,
    lane: null,
    requestedLane: null,
    notBefore: null,
    scheduleId: null,
    wakeAt: null,
    waitCheck: false,
    woken: false,
    ...overrides,
  }) as BoardTask;

const renderBadges = (overrides: Partial<BoardTask>) =>
  render(
    <MantineProvider>
      <TaskBadges task={task(overrides)} />
    </MantineProvider>,
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-01T10:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TaskBadges', () => {
  it('shows Stopping… on a running task with a stop request, and not otherwise', () => {
    const { unmount } = renderBadges({ status: 'running', stopRequested: true });
    expect(screen.getByText('Stopping…')).toBeInTheDocument();
    unmount();
    renderBadges({ status: 'running', stopRequested: false });
    expect(screen.queryByText('Stopping…')).not.toBeInTheDocument();
  });

  it('shows that a task in Todo waits for a free slot of its schedule, and only then', () => {
    const { unmount } = renderBadges({ scheduleId: 'sch1', held: true });
    expect(screen.getByText('Waits for a slot')).toBeInTheDocument();
    unmount();
    renderBadges({ scheduleId: 'sch1' });
    expect(screen.queryByText('Waits for a slot')).not.toBeInTheDocument();
  });

  it('shows the lane a queued task asks for, and not once it runs or when it asks for none', () => {
    const { unmount } = renderBadges({ requestedLane: 'reviews' });
    expect(screen.getByText('reviews')).toBeInTheDocument();
    unmount();
    const running = renderBadges({ status: 'running', machine: 'laptop', lane: 'general', requestedLane: 'reviews' });
    expect(screen.queryByText('reviews')).not.toBeInTheDocument();
    expect(screen.getByText('laptop · general')).toBeInTheDocument();
    running.unmount();
    renderBadges({ requestedLane: null });
    expect(screen.queryByTitle(/The lane it asks for/)).not.toBeInTheDocument();
  });

  it('shows Paused on a task waiting in Todo', () => {
    renderBadges({ paused: true });
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('does not show Paused on a running task: the flag stays true through the claim', () => {
    renderBadges({ status: 'running', paused: true, machine: 'laptop' });
    expect(screen.queryByText('Paused')).not.toBeInTheDocument();
  });

  it('shows when a waiting task starts, with the exact time as its title', () => {
    const notBefore = new Date(Date.now() + 4 * 3_600_000 + 10_000).toISOString();
    renderBadges({ notBefore });
    const badge = screen.getByText('Starts in 4h');
    expect(badge.closest('[title]')).toHaveAttribute('title', stamp(notBefore));
  });

  it('shows when a timer wakes a waiting task, and how long a check may take', () => {
    const wakeAt = new Date(Date.now() + 20 * 60_000 + 10_000).toISOString();
    const { unmount } = renderBadges({ status: 'waiting', wakeAt });
    expect(screen.getByText('Wakes in 20m').closest('[title]')).toHaveAttribute('title', `Wakes ${stamp(wakeAt)}`);
    unmount();
    renderBadges({ status: 'waiting', wakeAt, waitCheck: true, machine: 'laptop' });
    expect(screen.getByText('Checking · up to 20m').closest('[title]')).toHaveAttribute(
      'title',
      `Wakes when its check on laptop passes, at the latest ${stamp(wakeAt)}`,
    );
  });

  it('shows Woken, not Resume, on a task whose wait ended into Todo', () => {
    renderBadges({ next: 'resume', woken: true });
    expect(screen.getByText('Woken')).toBeInTheDocument();
    expect(screen.queryByText('Resume')).not.toBeInTheDocument();
  });

  it('marks a task its agent may finish, and no other', () => {
    renderBadges({ autoDone: true });
    expect(screen.getByText('Auto-done')).toBeInTheDocument();
  });

  it('shows no auto-done badge on a task whose agent ends in Needs me', () => {
    renderBadges({ autoDone: false });
    expect(screen.queryByText('Auto-done')).not.toBeInTheDocument();
  });

  it('marks a task made by a schedule as a repeat', () => {
    renderBadges({ scheduleId: 'sch1' });
    expect(screen.getByText('Repeat')).toBeInTheDocument();
  });

  it('shows no repeat badge on an ordinary task', () => {
    renderBadges({});
    expect(screen.queryByText('Repeat')).not.toBeInTheDocument();
  });

  it('shows no start time once it is due, or off Todo', () => {
    renderBadges({ notBefore: new Date(Date.now() - 1000).toISOString() });
    expect(screen.queryByText(/Starts in/)).not.toBeInTheDocument();
    renderBadges({ status: 'backlog', notBefore: new Date(Date.now() + 3_600_000).toISOString() });
    expect(screen.queryByText(/Starts in/)).not.toBeInTheDocument();
  });
});

describe('TaskBadges hold for usage', () => {
  const hold = (until: Date): TaskHold => ({
    until,
    machines: [
      {
        name: 'laptop',
        hold: {
          priority: 'urgent',
          until,
          windows: [{ window: 'fiveHour', percent: 85, threshold: 80, resetsAt: until }],
        },
      },
    ],
  });
  const renderHeld = (until: Date, overrides: Partial<BoardTask> = {}) =>
    render(
      <MantineProvider>
        <TaskBadges task={task(overrides)} hold={hold(until)} />
      </MantineProvider>,
    );

  it('shows when the hold ends, with the reason per machine as its title', () => {
    const until = new Date(Date.now() + 60_000);
    renderHeld(until);
    const badge = screen.getByText(`Held until ${clock(until)}`);
    expect(badge.closest('[title]')).toHaveAttribute(
      'title',
      `laptop holds tasks below urgent: 5-hour usage 85% (limit 80%) until ${clock(until)}`,
    );
  });

  it('shows the date for another day', () => {
    const until = new Date(Date.now() + 3 * 24 * 3_600_000);
    renderHeld(until);
    expect(screen.getByText(`Held until ${clock(until)}`)).toBeInTheDocument();
    expect(clock(until)).toMatch(/^\d{1,2} \w{3}, \d{2}:\d{2}$/);
  });

  it('shows nothing for a task that is not held', () => {
    renderBadges({});
    expect(screen.queryByText(/Held until/)).not.toBeInTheDocument();
  });
});
