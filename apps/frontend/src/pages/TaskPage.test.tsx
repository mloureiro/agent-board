import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { BoardTask } from '../lib/trpc';
import { TaskPage } from './TaskPage';

vi.mock('../lib/trpc', () => {
  const idle = { mutationOptions: () => ({ mutationFn: async () => null }) };
  return {
    POLL_MS: 60_000,
    errorMessage: () => 'error',
    useTRPC: () => ({
      tasks: {
        get: { queryOptions: ({ id }: { id: string }) => ({ queryKey: ['tasks.get', id] }) },
        setPriority: idle,
        configure: idle,
        removePr: idle,
        stopWatch: idle,
        answer: idle,
        dismissQuestion: idle,
        reply: idle,
        send: idle,
        stop: idle,
        done: idle,
        rerun: idle,
        setClosed: idle,
        move: idle,
        create: idle,
        takeBack: idle,
        setNotBefore: idle,
        wakeNow: idle,
        applyPolish: idle,
        fork: idle,
        edit: idle,
      },
      schedules: { list: { queryOptions: () => ({ queryKey: ['schedules.list'] }) } },
      machines: {
        list: { queryOptions: () => ({ queryKey: ['machines.list'], queryFn: async () => [] }) },
        catalogs: { queryOptions: () => ({ queryKey: ['machines.catalogs'], queryFn: async () => [] }) },
      },
      transcript: {
        runs: { queryOptions: ({ id }: { id: string }) => ({ queryKey: ['transcript.runs', id] }) },
        events: { queryKey: (input: unknown) => ['transcript.events', input] },
      },
    }),
  };
});

const task = (id: string, title: string): BoardTask =>
  ({
    id,
    title,
    input: 'do it',
    labels: [],
    status: 'needs-me',
    priority: 'normal',
    closed: false,
    machine: null,
    sessionId: 's',
    workdir: null,
    model: null,
    effort: null,
    icon: null,
    autoDone: false,
    prs: [],
    watches: null,
    watchEvents: 0,
    watchStops: [],
    promptPrState: null,
    next: 'resume',
    head: null,
    openQuestion: false,
    createdBy: 'user',
    lane: null,
    requestedLane: null,
    borrowed: false,
    lastActiveAt: null,
    runStartedAt: null,
    paused: false,
    notBefore: null,
    scheduleId: null,
    wakeAt: null,
    waitCheck: false,
    woken: false,
    proposed: false,
    started: true,
    invalid: [],
    unreadable: [],
    parentId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as BoardTask;

describe('TaskPage', () => {
  it('drops the draft of one task when it goes to another that is already in the cache', async () => {
    const a = task('aaaa1111', 'Task A');
    const b = { ...task('bbbb2222', 'Task B'), parentId: a.id };
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(['tasks.get', a.id], { task: a, thread: [], followUps: [b], parent: null });
    client.setQueryData(['tasks.get', b.id], { task: b, thread: [], followUps: [], parent: a });
    render(
      <MemoryRouter initialEntries={[`/t/${a.id}`]}>
        <MantineProvider>
          <ModalsProvider>
            <QueryClientProvider client={client}>
              <Routes>
                <Route path="/t/:id" element={<TaskPage />} />
              </Routes>
            </QueryClientProvider>
          </ModalsProvider>
        </MantineProvider>
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByRole('textbox'), 'only for A');
    await userEvent.click(screen.getByRole('link', { name: 'Task B' }));

    expect(screen.getByRole('heading', { name: 'Task B' })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Send & continue' })).toBeDisabled();
  });

  it('says a card waits for a free slot of its schedule, with the limit', async () => {
    const held = { ...task('aaaa1111', 'Task A'), status: 'todo', scheduleId: 'sch1', held: true } as BoardTask;
    const free = { ...task('bbbb2222', 'Task B'), status: 'todo', scheduleId: 'sch1' } as BoardTask;
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(['schedules.list'], [{ id: 'sch1', maxConcurrent: 3 }]);
    client.setQueryData(['tasks.get', held.id], { task: held, thread: [], followUps: [], parent: null });
    client.setQueryData(['tasks.get', free.id], { task: free, thread: [], followUps: [], parent: null });
    const view = (id: string) => (
      <MemoryRouter initialEntries={[`/t/${id}`]}>
        <MantineProvider>
          <ModalsProvider>
            <QueryClientProvider client={client}>
              <Routes>
                <Route path="/t/:id" element={<TaskPage />} />
              </Routes>
            </QueryClientProvider>
          </ModalsProvider>
        </MantineProvider>
      </MemoryRouter>
    );
    const first = render(view(held.id));
    expect(screen.getByText(/Waits for a free slot: its schedule runs at most 3 at once/)).toBeInTheDocument();
    first.unmount();
    render(view(free.id));
    expect(screen.queryByText(/Waits for a free slot/)).not.toBeInTheDocument();
  });

  it('shows the agent a task runs as, and nothing for a task without one', async () => {
    const withAgent = { ...task('aaaa1111', 'Task A'), agent: 'reviewer' };
    const without = { ...task('bbbb2222', 'Task B'), agent: null };
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(['tasks.get', withAgent.id], { task: withAgent, thread: [], followUps: [], parent: null });
    client.setQueryData(['tasks.get', without.id], { task: without, thread: [], followUps: [], parent: null });
    const view = (id: string) => (
      <MemoryRouter initialEntries={[`/t/${id}`]}>
        <MantineProvider>
          <ModalsProvider>
            <QueryClientProvider client={client}>
              <Routes>
                <Route path="/t/:id" element={<TaskPage />} />
              </Routes>
            </QueryClientProvider>
          </ModalsProvider>
        </MantineProvider>
      </MemoryRouter>
    );
    const first = render(view(withAgent.id));
    expect(screen.getByText('Agent: reviewer')).toBeInTheDocument();
    first.unmount();
    render(view(without.id));
    expect(screen.queryByText(/Agent:/)).not.toBeInTheDocument();
  });

  const page = (tasks: BoardTask[], parent: BoardTask | null = null) => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    for (const one of tasks)
      client.setQueryData(['tasks.get', one.id], { task: one, thread: [], followUps: [], parent });
    render(
      <MemoryRouter initialEntries={[`/t/${tasks[0]?.id}`]}>
        <MantineProvider>
          <ModalsProvider>
            <QueryClientProvider client={client}>
              <Routes>
                <Route path="/t/:id" element={<TaskPage />} />
              </Routes>
            </QueryClientProvider>
          </ModalsProvider>
        </MantineProvider>
      </MemoryRouter>,
    );
  };
  const fork = () => screen.queryByRole('button', { name: 'Fork' });

  it('puts the task title in the document title once the task is loaded', () => {
    page([task('aaaa1111', 'Fix the login redirect')]);
    expect(document.title).toBe('Fix the login redirect · Agent Board');
  });

  it('offers Fork on a task with a session on a machine, and opens the dialog', async () => {
    page([{ ...task('aaaa1111', 'Task A'), machine: 'laptop', workdir: '/work/a' }]);
    await userEvent.click(fork()!);
    expect(await screen.findByRole('dialog', { name: 'Fork this task' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Fork of Task A')).toBeInTheDocument();
  });

  it.each([
    ['has no session', { sessionId: null, machine: 'laptop' }],
    ['has run on no machine', { sessionId: 's', machine: null }],
    ['is closed', { sessionId: 's', machine: 'laptop', closed: true }],
    ['is an agent’s proposal', { sessionId: 's', machine: 'laptop', createdBy: 'agent' as const, proposed: true }],
  ])('offers no Fork on a task that %s', (_name, overrides) => {
    page([{ ...task('aaaa1111', 'Task A'), ...overrides }]);
    expect(fork()).not.toBeInTheDocument();
  });

  it('says which task a fork was forked from, with a link, and nothing for another task', () => {
    const parent = task('pppp1111', 'The parent');
    page([{ ...task('ffff1111', 'The fork'), forkOf: parent.id, parentId: parent.id }], parent);
    expect(screen.getByTestId('forked-from')).toHaveTextContent('Forked from The parent');
    expect(within(screen.getByTestId('forked-from')).getByRole('link', { name: 'The parent' })).toHaveAttribute(
      'href',
      '/t/pppp1111',
    );
  });

  it('names the parent by its id when the board has no such task any more', () => {
    page([{ ...task('ffff1111', 'The fork'), forkOf: 'gone1111' }]);
    expect(screen.getByTestId('forked-from')).toHaveTextContent('Forked from gone1111');
  });
});

describe('TaskPage prompt editing', () => {
  function show(overrides: Partial<BoardTask>) {
    const shown = {
      ...task('aaaa1111', 'Task A'),
      sessionId: null,
      started: false,
      status: 'todo',
      ...overrides,
    } as BoardTask;
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(['tasks.get', shown.id], { task: shown, thread: [], followUps: [], parent: null });
    render(
      <MemoryRouter initialEntries={[`/t/${shown.id}`]}>
        <MantineProvider>
          <ModalsProvider>
            <QueryClientProvider client={client}>
              <Routes>
                <Route path="/t/:id" element={<TaskPage />} />
              </Routes>
            </QueryClientProvider>
          </ModalsProvider>
        </MantineProvider>
      </MemoryRouter>,
    );
  }
  const editButton = () => screen.queryByRole('button', { name: 'Edit prompt' });

  it('offers it on a task of yours that waits in Todo and never started', () => {
    show({});
    expect(editButton()).toBeInTheDocument();
    expect(screen.queryByText(/edit it on the Schedules page/)).not.toBeInTheDocument();
  });

  it('offers it in Backlog too', () => {
    show({ status: 'backlog' });
    expect(editButton()).toBeInTheDocument();
  });

  it('does not offer it once the task started, is running, is closed, or is an agent’s', () => {
    for (const overrides of [
      { started: true },
      { status: 'running' as const },
      { status: 'needs-me' as const },
      { closed: true },
      { createdBy: 'agent' as const },
      { proposed: true, createdBy: 'agent' as const },
      { unreadable: ['input' as const] },
    ]) {
      cleanup();
      show(overrides);
      expect(editButton(), JSON.stringify(overrides)).not.toBeInTheDocument();
    }
  });

  it('does not offer it on a schedule’s card, and points to the Schedules page', () => {
    show({ scheduleId: 'sched001' });
    expect(editButton()).not.toBeInTheDocument();
    expect(screen.getByText(/This card is the next run of a schedule/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit the prompt on the Schedules page' })).toHaveAttribute(
      'href',
      '/schedules',
    );
  });
});
