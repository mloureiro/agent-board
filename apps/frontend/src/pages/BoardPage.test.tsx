import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListedTask } from '../lib/trpc';
import { BacklogPage, BoardPage } from './BoardPage';

const move = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const create = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const done = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const configure = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const listed = vi.hoisted(() => ({ tasks: [] as unknown[], machines: [] as unknown[], failure: null as Error | null }));

vi.mock('../lib/trpc', () => ({
  POLL_MS: 60_000,
  errorMessage: (error: Error) => error.message,
  useTRPC: () => ({
    tasks: {
      list: {
        queryOptions: () => ({
          queryKey: ['tasks.list'],
          queryFn: async () => {
            if (listed.failure) throw listed.failure;
            return listed.tasks;
          },
        }),
      },
      move: { mutationOptions: () => ({ mutationFn: move }) },
      create: { mutationOptions: () => ({ mutationFn: create }) },
      done: { mutationOptions: () => ({ mutationFn: done }) },
      configure: { mutationOptions: () => ({ mutationFn: configure }) },
    },
    machines: {
      list: { queryOptions: () => ({ queryKey: ['machines.list'], queryFn: async () => listed.machines }) },
    },
  }),
}));

const task = (overrides: Partial<ListedTask>): ListedTask =>
  ({
    id: 'p1',
    title: 'proposal',
    input: 'delete everything',
    prs: [],
    promptPrState: null,
    status: 'needs-me',
    priority: 'normal',
    createdBy: 'agent',
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
    proposed: true,
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

function renderBoard(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <MemoryRouter>
      <MantineProvider>
        <ModalsProvider>
          <QueryClientProvider client={client}>
            <BoardPage />
          </QueryClientProvider>
        </ModalsProvider>
      </MantineProvider>
    </MemoryRouter>,
  );
}

const column = (name: string) => screen.getByText(name).closest('.board-column') as HTMLElement;

async function drag(title: string, to: string) {
  const card = (await screen.findByText(title)).closest('a') as HTMLElement;
  const dataTransfer = { effectAllowed: '', dropEffect: '' };
  fireEvent.dragStart(card, { dataTransfer });
  fireEvent.dragOver(column(to), { dataTransfer });
  fireEvent.drop(column(to), { dataTransfer });
}

beforeEach(() => {
  move.mockClear();
  create.mockClear();
  done.mockClear();
  listed.machines = [];
  listed.failure = null;
});

describe('BoardPage loading and errors', () => {
  it('shows why the board did not load instead of empty columns', async () => {
    listed.failure = new Error('a task has an id the browser does not accept');
    renderBoard();
    expect(await screen.findByText(/Could not load the board: a task has an id/)).toBeInTheDocument();
    expect(screen.queryByText('Empty')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing waiting for you')).not.toBeInTheDocument();
  });

  it('shows no empty columns while the board loads', async () => {
    listed.tasks = [];
    renderBoard();
    expect(screen.getByText('Loading the board…')).toBeInTheDocument();
    expect(screen.queryByText('Empty')).not.toBeInTheDocument();
    expect(await screen.findByText('Nothing waiting for you')).toBeInTheDocument();
    expect(screen.queryByText('Loading the board…')).not.toBeInTheDocument();
  });

  it('keeps the cards it has when a poll fails, and says the board is stale', async () => {
    listed.tasks = [task({})];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderBoard(client);
    await screen.findByText('proposal');
    listed.failure = new Error('board is locked');
    await client.refetchQueries({ queryKey: ['tasks.list'] });
    expect(
      await screen.findByText(/Could not refresh the board; showing what loaded last: board is locked/),
    ).toBeInTheDocument();
    expect(screen.getByText('proposal')).toBeInTheDocument();
  });
});

describe('BoardPage drag and drop', () => {
  it('shows the whole prompt before a drag into Todo starts an agent’s proposal, and moves nothing until confirmed', async () => {
    listed.tasks = [task({})];
    renderBoard();
    await drag('proposal', 'Todo');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('proposal-prompt')).toHaveValue('delete everything');
    expect(move).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start as mine' }));
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(move.mock.calls[0]?.[0]).toMatchObject({ id: 'p1', status: 'todo', task: { createdBy: 'agent' } });
  });

  it('starts a dragged proposal with the prompt as the user edited it', async () => {
    listed.tasks = [task({})];
    renderBoard();
    await drag('proposal', 'Todo');
    const dialog = await screen.findByRole('dialog');
    const prompt = within(dialog).getByTestId('proposal-prompt');
    await userEvent.clear(prompt);
    await userEvent.type(prompt, 'list the build directory');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start as mine' }));
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(move.mock.calls[0]?.[0]).toMatchObject({
      id: 'p1',
      status: 'todo',
      task: { input: 'list the build directory' },
    });
  });

  it('does not ask, and does not start anything, when an agent’s task the board put in Todo is reordered there', async () => {
    listed.tasks = [task({ status: 'todo', proposed: false })];
    renderBoard();
    await drag('proposal', 'Todo');
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(move.mock.calls[0]?.[0]).toMatchObject({ task: { status: 'todo' } });
  });

  it('does not ask for a move of the user’s own task into Todo', async () => {
    listed.tasks = [task({ createdBy: 'user', proposed: false, status: 'backlog' })];
    renderBoard();
    await drag('proposal', 'Todo');
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('BoardPage drop position', () => {
  const todo = ['A', 'B', 'C', 'D'].map((id) => task({ id, title: `card ${id}`, status: 'todo', proposed: false }));
  const cardOf = async (title: string) => (await screen.findByText(title)).closest('a') as HTMLElement;
  // jsdom gives every card an empty rect at 0, so clientY 0 is the lower half and -1 the upper half.
  const lowerHalf = { clientY: 0 };

  it('leaves a card in its slot when dropped on the lower half of the card above it', async () => {
    listed.tasks = todo;
    renderBoard();
    const dataTransfer = { effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(await cardOf('card C'), { dataTransfer });
    fireEvent.dragOver(await cardOf('card B'), { dataTransfer, ...lowerHalf });
    fireEvent.drop(await cardOf('card B'), { dataTransfer });
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(move.mock.calls[0]?.[0]).toMatchObject({ id: 'C', beforeId: 'D', afterId: 'B' });
  });

  it('drops at the bottom after the pointer leaves the cards for the empty space below them', async () => {
    listed.tasks = todo;
    renderBoard();
    const dataTransfer = { effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(await cardOf('card A'), { dataTransfer });
    fireEvent.dragOver(await cardOf('card B'), { dataTransfer, clientY: -1 });
    fireEvent.dragOver(column('Todo'), { dataTransfer });
    fireEvent.drop(column('Todo'), { dataTransfer });
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(move.mock.calls[0]?.[0]).toMatchObject({ id: 'A', afterId: 'D' });
    expect(move.mock.calls[0]?.[0]).not.toHaveProperty('beforeId');
  });

  it('moves a card into Done without neighbours, since Done lists the latest on top', async () => {
    listed.tasks = [...todo, task({ id: 'E', title: 'card E', status: 'done', proposed: false })];
    renderBoard();
    const dataTransfer = { effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(await cardOf('card A'), { dataTransfer });
    fireEvent.dragOver(await cardOf('card E'), { dataTransfer, clientY: -1 });
    fireEvent.drop(await cardOf('card E'), { dataTransfer });
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(move.mock.calls[0]?.[0]).toMatchObject({ id: 'A', status: 'done' });
    expect(move.mock.calls[0]?.[0]).not.toHaveProperty('beforeId');
    expect(move.mock.calls[0]?.[0]).not.toHaveProperty('afterId');
  });

  it('moves nothing when a card is dropped back into Needs me', async () => {
    listed.tasks = ['E', 'F'].map((id) => task({ id, title: `card ${id}`, status: 'needs-me', proposed: false }));
    renderBoard();
    const dataTransfer = { effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(await cardOf('card F'), { dataTransfer });
    fireEvent.dragOver(await cardOf('card E'), { dataTransfer, clientY: -1 });
    fireEvent.drop(await cardOf('card E'), { dataTransfer });
    await drag('card E', 'Done');
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(move.mock.calls[0]?.[0]).toMatchObject({ id: 'E', status: 'done' });
  });
});

describe('BoardPage move merged to Done', () => {
  const merged = (id: string, overrides: Partial<ListedTask> = {}) =>
    task({
      id,
      title: `merged ${id}`,
      createdBy: 'user',
      proposed: false,
      prs: [{ id: `r${id}`, url: `https://github.com/acme/app/pull/${id.length}${id}`, state: 'merged' }],
      ...overrides,
    });

  it('moves the merged tasks of Needs me to Done and leaves the others', async () => {
    listed.tasks = [
      merged('m1'),
      merged('m2'),
      merged('m3', { status: 'todo' }),
      merged('m4', { prs: [{ id: 'r4', url: 'https://github.com/acme/app/pull/4', state: 'open' }] }),
      merged('m5', { prs: [] }),
    ];
    renderBoard();
    await userEvent.click(await screen.findByRole('button', { name: /Move merged to Done/ }));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(2));
    expect(done.mock.calls.map(([variables]) => variables)).toEqual([{ id: 'm1' }, { id: 'm2' }]);
  });

  it('leaves out proposals and tasks with an open question', async () => {
    listed.tasks = [merged('m1', { proposed: true }), merged('m2', { openQuestion: true }), merged('m3')];
    renderBoard();
    await userEvent.click(await screen.findByRole('button', { name: 'Move merged to Done (1)' }));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(done.mock.calls[0]?.[0]).toEqual({ id: 'm3' });
  });

  it('is only there while Needs me has a merged PR', async () => {
    listed.tasks = [
      merged('m1', { prs: [{ id: 'r1', url: 'https://github.com/acme/app/pull/1', state: 'closed' }] }),
      merged('m2', { status: 'done' }),
      merged('m3', { prs: [] }),
    ];
    renderBoard();
    await screen.findByText('merged m1');
    expect(screen.queryByRole('button', { name: /Move merged to Done/ })).not.toBeInTheDocument();
  });

  it('counts a review task whose prompt names the PR', async () => {
    listed.tasks = [
      merged('r1', {
        prs: [],
        promptPrState: 'merged',
        input: '/review-pr https://github.com/acme/app/pull/9 --auto',
      }),
    ];
    renderBoard();
    expect(await screen.findByRole('button', { name: 'Move merged to Done (1)' })).toBeInTheDocument();
  });
});

describe('BoardPage layout', () => {
  it('stacks Waiting above Todo in one board cell', async () => {
    listed.tasks = [task({ id: 'w1', title: 'on CI', status: 'waiting' })];
    renderBoard();
    await screen.findByText('on CI');
    const cell = column('Waiting').closest('.board-cell') as HTMLElement;
    expect(cell).toBe(column('Todo').closest('.board-cell'));
    expect(column('Waiting').compareDocumentPosition(column('Todo')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('leaves Waiting out while no task waits', async () => {
    listed.tasks = [];
    renderBoard();
    await screen.findAllByText('Empty');
    expect(screen.queryByText('Waiting')).not.toBeInTheDocument();
    expect(column('Todo')).toBeInTheDocument();
  });
});

describe('BoardPage polish action', () => {
  const backlog = (overrides: Partial<ListedTask>) =>
    task({ id: 'b1', title: 'rough idea', createdBy: 'user', proposed: false, status: 'backlog', ...overrides });

  it('queues a polish task from a backlog card without opening the card', async () => {
    listed.tasks = [backlog({ priority: 'urgent' })];
    renderBoard();
    await userEvent.click(await screen.findByRole('button', { name: 'Polish prompt' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      title: 'Polish prompt: rough idea',
      priority: 'urgent',
      parentId: 'b1',
    });
  });

  it('disables it while a polish task of the card is open', async () => {
    listed.tasks = [
      backlog({}),
      task({
        id: 'c1',
        title: 'Polish prompt: rough idea',
        parentId: 'b1',
        createdBy: 'user',
        proposed: false,
        status: 'todo',
      }),
    ];
    renderBoard();
    expect(await screen.findByRole('button', { name: 'Polish prompt' })).toBeDisabled();
  });

  it('is only on the cards of a task of the user’s in the backlog', async () => {
    listed.tasks = [
      backlog({ id: 'b2', title: 'agent’s', createdBy: 'agent' }),
      task({ id: 'n1', title: 'waiting', createdBy: 'user' }),
    ];
    renderBoard();
    await screen.findByText('waiting');
    expect(screen.queryByRole('button', { name: 'Polish prompt' })).not.toBeInTheDocument();
  });
});

describe('BoardPage banner for machines whose CLI the board refuses', () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const machine = (name: string, overrides: Record<string, unknown> = {}) => ({
    name,
    shown: name,
    revokedAt: null,
    lastSeenAt: hoursAgo(1),
    usage: null,
    clientVersion: '0.4.0',
    clientStatus: 'incompatible',
    ...overrides,
  });

  it('names the machines seen in the last day and links to Settings', async () => {
    listed.tasks = [];
    listed.machines = [
      machine('laptop'),
      machine('workstation'),
      machine('old-box', { lastSeenAt: hoursAgo(30) }),
      machine('revoked-box', { revokedAt: hoursAgo(2) }),
      machine('never-seen', { lastSeenAt: null }),
      machine('fine', { clientStatus: 'current', clientVersion: '0.7.0' }),
    ];
    renderBoard();
    const banner = await screen.findByText(/A machine needs a CLI update/);
    const alert = banner.closest('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('laptop, workstation');
    expect(alert.textContent).not.toMatch(/old-box|revoked-box|never-seen|fine/);
    expect(within(alert).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings/machines');
  });

  it('shows nothing while every machine is compatible', async () => {
    listed.tasks = [];
    listed.machines = [machine('laptop', { clientStatus: 'outdated' }), machine('b', { clientStatus: 'unknown' })];
    renderBoard();
    await screen.findByText('Backlog');
    expect(screen.queryByText(/A machine needs a CLI update/)).not.toBeInTheDocument();
  });
});

describe('BoardPage cards held for usage', () => {
  const minutes = (count: number) => new Date(Date.now() + count * 60_000).toISOString();
  const usage = (held: string[], open: string[]) => ({
    limits: { fiveHour: 80, priority: 'urgent' },
    windows: { fiveHour: { percent: 85, resetsAt: minutes(125), seenAt: minutes(-2) } },
    reached: ['fiveHour'],
    held,
    open,
  });
  const machine = (name: string, status: unknown) => ({
    name,
    shown: name,
    revokedAt: null,
    lastSeenAt: minutes(-1),
    usageUpdatedAt: minutes(-1),
    usage: status,
    clientVersion: '0.7.0',
    clientStatus: 'current',
  });

  it('puts a badge on the Todo task a machine holds back, and on no other', async () => {
    listed.tasks = [
      task({ id: 'h1', title: 'held work', status: 'todo', proposed: false, createdBy: 'user' }),
      task({ id: 'o1', title: 'other work', status: 'todo', proposed: false, createdBy: 'user' }),
    ];
    listed.machines = [machine('laptop', usage(['h1'], ['o1']))];
    renderBoard();
    const card = (await screen.findByText('held work')).closest('a') as HTMLElement;
    expect(await within(card).findByText(/^Held until /)).toBeInTheDocument();
    const other = (await screen.findByText('other work')).closest('a') as HTMLElement;
    expect(within(other).queryByText(/^Held until /)).not.toBeInTheDocument();
  });

  it('shows no badge when another machine could still run the task', async () => {
    listed.tasks = [task({ id: 'h1', title: 'held work', status: 'todo', proposed: false, createdBy: 'user' })];
    listed.machines = [machine('laptop', usage(['h1'], [])), machine('desktop', { ...usage([], ['h1']), reached: [] })];
    renderBoard();
    await screen.findByText('held work');
    expect(screen.queryByText(/^Held until /)).not.toBeInTheDocument();
  });
});

describe('BacklogPage', () => {
  it('lists the backlog tasks only, outside the board grid', async () => {
    listed.tasks = [
      task({ id: 'b1', title: 'parked idea', status: 'backlog', proposed: false }),
      task({ id: 't1', title: 'ready work', status: 'todo', proposed: false }),
    ];
    render(
      <MemoryRouter>
        <MantineProvider>
          <ModalsProvider>
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
              <BacklogPage />
            </QueryClientProvider>
          </ModalsProvider>
        </MantineProvider>
      </MemoryRouter>,
    );
    const card = await screen.findByText('parked idea');
    expect(card.closest('.board')).toBeNull();
    expect(screen.queryByText('ready work')).not.toBeInTheDocument();
    expect(screen.queryByText('Todo')).not.toBeInTheDocument();
  });
});
