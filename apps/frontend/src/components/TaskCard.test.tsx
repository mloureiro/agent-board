import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { PrState, TaskWatch } from '@agent-board/shared';
import type { ListedTask } from '../lib/trpc';
import { clock } from '../lib/time';
import { TaskCard } from './TaskCard';

const task = (overrides: Partial<ListedTask>): ListedTask =>
  ({
    id: 't1',
    title: 'A task',
    input: 'Fix the bug',
    prs: [],
    promptPrState: null,
    status: 'needs-me',
    priority: 'normal',
    createdBy: 'user',
    closed: false,
    openQuestion: false,
    machine: null,
    lane: null,
    requestedLane: null,
    sessionId: null,
    next: 'fresh',
    head: null,
    scheduleId: null,
    wakeAt: null,
    waitCheck: false,
    woken: false,
    parentId: null,
    proposed: false,
    paused: false,
    notBefore: null,
    lastActiveAt: null,
    runStartedAt: null,
    borrowed: false,
    unreadable: [],
    invalid: [],
    skillLabels: [],
    labels: [],
    lastNote: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }) as ListedTask;

const renderCard = (overrides: Partial<ListedTask>) =>
  render(
    <MemoryRouter>
      <MantineProvider>
        <TaskCard
          task={task(overrides)}
          draggable={false}
          dragging={false}
          onDragStart={() => {}}
          onDragEnd={() => {}}
          onDragOver={() => {}}
        />
      </MantineProvider>
    </MemoryRouter>,
  );

const hasPrIcon = (container: HTMLElement) => container.querySelector('.tabler-icon-brand-github') !== null;

const pr = (n: number, state: PrState | null = null) => ({
  id: `r${n}`,
  url: `https://github.com/acme/app/pull/${n}`,
  state,
});

describe('TaskCard pull request icon', () => {
  it('shows for a review task whose prompt names a PR', () => {
    expect(hasPrIcon(renderCard({ input: '/review-pr https://github.com/acme/app/pull/1 --auto' }).container)).toBe(
      true,
    );
  });

  it('shows for a task whose agent reported a PR', () => {
    expect(hasPrIcon(renderCard({ prs: [pr(2)] }).container)).toBe(true);
  });

  it('is not there for a task without a PR', () => {
    expect(hasPrIcon(renderCard({}).container)).toBe(false);
  });
});

describe('TaskCard pull request state', () => {
  it('shows the merge icon for a merged PR instead of the GitHub mark', () => {
    const { container } = renderCard({ prs: [pr(2, 'merged')] });
    expect(screen.getByLabelText('PR merged')).toBeInTheDocument();
    expect(hasPrIcon(container)).toBe(false);
  });

  it('shows the closed icon for a PR closed without a merge', () => {
    const { container } = renderCard({
      input: '/review-pr https://github.com/acme/app/pull/2 --auto',
      promptPrState: 'closed',
    });
    expect(screen.getByLabelText('PR closed')).toBeInTheDocument();
    expect(hasPrIcon(container)).toBe(false);
  });

  it.each(['open', null] as const)('keeps the GitHub mark for a PR that is %s', (state) => {
    const { container } = renderCard({ prs: [pr(2, state)] });
    expect(hasPrIcon(container)).toBe(true);
    expect(screen.queryByLabelText(/^PR (merged|closed)$/)).not.toBeInTheDocument();
  });

  it('shows nothing for a state without a PR', () => {
    renderCard({ promptPrState: 'merged' });
    expect(screen.queryByLabelText('PR merged')).not.toBeInTheDocument();
  });

  it('shows one icon per PR with its own state', () => {
    renderCard({ prs: [pr(1, 'merged'), pr(2, 'closed'), pr(3)] });
    expect(screen.getAllByLabelText(/^PR (merged|closed)$/)).toHaveLength(2);
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });

  it('shows at most three icons and counts the rest', () => {
    renderCard({ prs: [pr(1, 'merged'), pr(2, 'merged'), pr(3, 'merged'), pr(4, 'merged'), pr(5, 'merged')] });
    expect(screen.getAllByLabelText('PR merged')).toHaveLength(3);
    expect(screen.getByText('+2')).toBeInTheDocument();
  });
});

const watch = (overrides: Partial<TaskWatch> = {}): TaskWatch => ({
  id: '0123456789abcdef',
  name: 'ci',
  kind: 'ci',
  label: 'CI #116',
  status: '4 of 7 passed, 3 running',
  deadline: new Date(Date.now() + 3_600_000).toISOString(),
  ...overrides,
});

describe('TaskCard watches', () => {
  it('shows the first watch with its short status on a running task, and counts the rest', () => {
    renderCard({
      status: 'running',
      watches: [watch(), watch({ id: 'fedcba9876543210', name: 'cmd', kind: 'command', label: 'command, every 30s' })],
    });
    expect(screen.getByText('Watching CI #116 · 4/7 +1')).toBeInTheDocument();
  });

  it('replaces the checking countdown of a waiting task and keeps it in the tooltip', () => {
    const wakeAt = new Date(Date.now() + 20 * 60_000 + 30_000).toISOString();
    renderCard({ status: 'waiting', wakeAt, waitCheck: true, machine: 'laptop', watches: [watch()] });
    const badge = screen.getByText('Watching CI #116 · 4/7');
    expect(badge.closest('[title]')?.getAttribute('title')).toContain('Checking · up to 20m');
    expect(screen.queryByText(/^Checking/)).not.toBeInTheDocument();
  });

  it('shows the label alone when the status has no count', () => {
    renderCard({ status: 'running', watches: [watch({ kind: 'timer', label: 'timer', status: 'fires at 14:20' })] });
    expect(screen.getByText('Watching timer')).toBeInTheDocument();
  });

  it('keeps the existing badge when the watches are unreadable, and shows nothing off Running and Waiting', () => {
    const wakeAt = new Date(Date.now() + 20 * 60_000 + 30_000).toISOString();
    const { unmount } = renderCard({ status: 'waiting', wakeAt, waitCheck: true, watches: null });
    expect(screen.getByText('Checking · up to 20m')).toBeInTheDocument();
    unmount();
    renderCard({ status: 'needs-me', watches: [watch()] });
    expect(screen.queryByText(/^Watching/)).not.toBeInTheDocument();
  });

  it('shows watch text as plain text', () => {
    renderCard({ status: 'running', watches: [watch({ label: '<b>bold</b> **x**' })] });
    expect(screen.getByText('Watching <b>bold</b> **x** · 4/7')).toBeInTheDocument();
  });
});

describe('TaskCard hold for usage', () => {
  it('shows the badge of a held task', () => {
    const until = new Date(Date.now() + 60_000);
    render(
      <MemoryRouter>
        <MantineProvider>
          <TaskCard
            task={task({ status: 'todo' })}
            hold={{ until, machines: [] }}
            draggable={false}
            dragging={false}
            onDragStart={() => {}}
            onDragEnd={() => {}}
            onDragOver={() => {}}
          />
        </MantineProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText(`Held until ${clock(until)}`)).toBeInTheDocument();
  });

  it('shows none without a hold', () => {
    renderCard({ status: 'todo' });
    expect(screen.queryByText(/Held until/)).not.toBeInTheDocument();
  });
});

describe('TaskCard icon', () => {
  const renderWithPicker = (overrides: Partial<ListedTask>, onIconChange = vi.fn()) => {
    const rendered = render(
      <MemoryRouter initialEntries={['/']}>
        <MantineProvider>
          <Routes>
            <Route
              path="/"
              element={
                <TaskCard
                  task={task(overrides)}
                  draggable={false}
                  dragging={false}
                  onDragStart={() => {}}
                  onDragEnd={() => {}}
                  onDragOver={() => {}}
                  onIconChange={onIconChange}
                />
              }
            />
            <Route path="/t/:id" element={<p>Task page</p>} />
          </Routes>
        </MantineProvider>
      </MemoryRouter>,
    );
    return { ...rendered, onIconChange };
  };

  it('shows the emoji at the left of the title, before the PR icons', () => {
    const { container } = renderWithPicker({ icon: '🚀', prs: [pr(2)] });
    const trigger = screen.getByRole('button', { name: /^Task icon: .*Change it$/ });
    expect(trigger).toHaveTextContent('🚀');
    const github = container.querySelector('.tabler-icon-brand-github');
    expect(github).not.toBeNull();
    expect(trigger.compareDocumentPosition(github as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(trigger.compareDocumentPosition(screen.getByText('A task')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers an add trigger without an icon, which opens the picker and not the task', async () => {
    renderWithPicker({ icon: null });
    const add = screen.getByRole('button', { name: 'Add task icon' });
    expect(add).toHaveClass('emoji-add');
    await userEvent.click(add);
    expect(screen.queryByText('Task page')).not.toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Search emoji', hidden: true })).toBeInTheDocument();
  });

  it('shows the emoji without a way to change it when the board gives none', () => {
    renderCard({ icon: '🐛' });
    expect(screen.getByRole('img', { name: 'Task icon' })).toHaveTextContent('🐛');
    expect(screen.queryByRole('button', { name: /icon/i })).not.toBeInTheDocument();
  });
});

describe('TaskCard labels', () => {
  const renderWithEditor = (overrides: Partial<ListedTask>, onLabelsChange = vi.fn()) => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <MantineProvider>
          <Routes>
            <Route
              path="/"
              element={
                <TaskCard
                  task={task(overrides)}
                  draggable={false}
                  dragging={false}
                  onDragStart={() => {}}
                  onDragEnd={() => {}}
                  onDragOver={() => {}}
                  onLabelsChange={onLabelsChange}
                  labelSuggestions={[]}
                />
              }
            />
            <Route path="/t/:id" element={<p>Task page</p>} />
          </Routes>
        </MantineProvider>
      </MemoryRouter>,
    );
    return { onLabelsChange };
  };

  it('shows the user’s labels as badges after the derived ones', () => {
    renderCard({ skillLabels: ['review-pr'], labels: ['bug', 'ui'] });
    expect(screen.getByText('review-pr')).toBeInTheDocument();
    expect(screen.getByLabelText('Label bug')).toHaveTextContent('bug');
    expect(screen.getByLabelText('Label ui')).toHaveTextContent('ui');
    expect(screen.queryByRole('button', { name: /labels/i })).not.toBeInTheDocument();
  });

  it('opens the editor without opening the task', async () => {
    renderWithEditor({ labels: ['bug'] });
    const trigger = screen.getByRole('button', { name: 'Edit labels' });
    expect(trigger).toHaveClass('labels-add');
    await userEvent.click(trigger);
    expect(screen.queryByText('Task page')).not.toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: 'Labels', hidden: true })).toBeInTheDocument();
    expect(screen.queryByText('Task page')).not.toBeInTheDocument();
  });

  it('offers to add labels on a card without any', () => {
    renderWithEditor({ labels: [] });
    expect(screen.getByRole('button', { name: 'Add labels' })).toBeInTheDocument();
  });
});
