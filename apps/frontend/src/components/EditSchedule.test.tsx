import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '@agent-board/shared/ui';
import type { Schedule } from '../lib/trpc';
import { createMemoryDraftStorage, draftKeys } from '../test/draftStorage';
import { DraftsProvider } from './DraftsProvider';
import { EditScheduleModal } from './EditSchedule';

type Outcome = 'updated' | 'started' | 'none' | 'removed' | 'created';
const update = vi.hoisted(() => vi.fn(async (_: unknown): Promise<{ pending: Outcome }> => ({ pending: 'updated' })));
const listed = vi.hoisted(() => ({
  machines: [] as unknown[],
  schedules: [] as unknown[],
  catalogs: [] as unknown[],
}));

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({
    schedules: {
      update: { mutationOptions: () => ({ mutationFn: update }) },
      list: { queryOptions: () => ({ queryKey: ['schedules'], queryFn: async () => listed.schedules }) },
    },
    machines: {
      list: { queryOptions: () => ({ queryKey: ['machines'], queryFn: async () => listed.machines }) },
      catalogs: { queryOptions: () => ({ queryKey: ['catalogs'], queryFn: async () => listed.catalogs }) },
    },
  }),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock('./MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) => (
    <textarea aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)} />
  ),
}));

const anchor = new Date('2031-03-04T10:30:00');
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const schedule = (overrides: Partial<Schedule> = {}): Schedule =>
  ({
    id: 'sch1',
    title: 'Nightly',
    input: 'sweep',
    agent: 'reviewer',
    priority: 'high',
    model: null,
    effort: null,
    requestedLane: null,
    autoDone: false,
    machine: 'laptop',
    workdir: '/work/a',
    everyMs: 7_200_000,
    cron: null,
    moreCrons: [],
    timezone: null,
    after: null,
    maxConcurrent: null,
    anchorAt: anchor.toISOString(),
    remaining: null,
    until: null,
    paused: false,
    ended: false,
    occurrenceTaskId: 'card1',
    unreadable: [],
    invalid: [],
    ...overrides,
  }) as unknown as Schedule;

const machine = (name: string, paths: string[]): Machine =>
  ({
    name,
    shown: name,
    dirs: paths.map((path) => ({ path })),
    dirsUnreadable: false,
    revokedAt: null,
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
  }) as Machine;

const open = (row: Schedule) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <EditScheduleModal schedule={row} opened onClose={() => undefined} />
      </QueryClientProvider>
    </MantineProvider>,
  );

const save = () => userEvent.click(screen.getByRole('button', { name: 'Save' }));
const sent = () => update.mock.calls[0]?.[0];
const retype = async (label: string | RegExp, text: string) => {
  const field = await screen.findByLabelText(label);
  await userEvent.clear(field);
  if (text !== '') await userEvent.type(field, text);
};

beforeEach(() => {
  update.mockReset().mockResolvedValue({ pending: 'updated' });
  listed.machines = [machine('laptop', ['/work/a', '/work/b'])];
  listed.schedules = [];
  listed.catalogs = [];
});

describe('EditScheduleModal', () => {
  it('opens with every value of the schedule and sends them all back unchanged', async () => {
    open(schedule({ remaining: 4, maxConcurrent: 2, model: 'opus', effort: 'xhigh', autoDone: true }));
    expect(await screen.findByLabelText('Title')).toHaveValue('Nightly');
    expect(screen.getByLabelText('Prompt')).toHaveValue('sweep');
    expect(screen.getByLabelText('Agent')).toHaveValue('reviewer');
    expect(screen.getByLabelText(/Repeat/)).toHaveValue('2h');
    expect(screen.getByLabelText('Number of runs')).toHaveValue('5');
    expect(screen.getByLabelText('At most at once')).toHaveValue('2');
    expect(screen.getByLabelText('Agent may mark it done')).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Working directory' })).toHaveValue('/work/a');
    await save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(sent()).toEqual({
      id: 'sch1',
      title: 'Nightly',
      input: 'sweep',
      agent: 'reviewer',
      place: { machine: 'laptop', workdir: '/work/a' },
      priority: 'high',
      model: 'opus',
      effort: 'xhigh',
      lane: null,
      autoDone: true,
      repeat: { everyMs: 7_200_000 },
      runsLeft: 5,
      until: null,
      maxConcurrent: 2,
      unreadable: [],
    });
  });

  it('offers the lanes the machines published, keeps the schedule’s own, and sends the changed one', async () => {
    listed.catalogs = [
      { name: 'laptop', catalog: { models: [], skills: [], dirs: {}, lanes: ['general', 'reviews'] } },
    ];
    open(schedule({ requestedLane: 'docs' }));
    expect(await screen.findByRole('combobox', { name: 'Lane' })).toHaveValue('docs');
    await userEvent.click(screen.getByRole('combobox', { name: 'Lane' }));
    await userEvent.click(await screen.findByRole('option', { name: 'reviews', hidden: true }));
    await save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(sent()).toMatchObject({ lane: 'reviews' });
  });

  it('sends no lane when the default lane is picked for a schedule that had one', async () => {
    open(schedule({ requestedLane: 'docs' }));
    await userEvent.click(await screen.findByRole('combobox', { name: 'Lane' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Default lane', hidden: true }));
    await save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(sent()).toMatchObject({ lane: null });
  });

  it('selects the schedule’s directory even when no machine lists it', async () => {
    listed.machines = [machine('desktop', ['/other'])];
    open(schedule());
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Working directory' })).toHaveValue('/work/a'));
    await save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(sent()).toMatchObject({ place: { machine: 'laptop', workdir: '/work/a' } });
  });

  it('sends no directory, agent or model for a schedule that had none, and the first run only when it changed', async () => {
    open(schedule({ machine: null, workdir: null, agent: undefined }));
    await save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(sent()).toMatchObject({ place: null, agent: null, model: null, effort: null });
    expect(sent()).not.toHaveProperty('at');
  });

  it('sends the edited text, rule, first run, number of runs and limit', async () => {
    open(schedule());
    await retype('Title', 'Mornings');
    await retype('Prompt', 'sweep harder');
    await retype('Agent', '');
    await retype(/Repeat/, '0 9 * * 1-5');
    await retype('First run', '2032-01-02T08:15');
    await retype('Number of runs', '3');
    await retype('At most at once', '2');
    await save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(sent()).toMatchObject({
      title: 'Mornings',
      input: 'sweep harder',
      agent: null,
      repeat: { cron: '0 9 * * 1-5', timezone },
      runsLeft: 3,
      maxConcurrent: 2,
    });
    expect((sent() as { at: Date }).at).toEqual(new Date('2032-01-02T08:15'));
  });

  it('opens every cron expression as a row, and saves added and removed ones', async () => {
    open(schedule({ everyMs: null, cron: '0 9 * * 5#1', moreCrons: ['0 9 * * 5#3'], timezone }));
    expect(await screen.findByLabelText(/Repeat/)).toHaveValue('0 9 * * 5#1');
    expect(screen.getByLabelText('Cron expression 2')).toHaveValue('0 9 * * 5#3');
    expect(screen.queryByText(/The schedule was set in/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add cron expression' }));
    await userEvent.type(screen.getByLabelText('Cron expression 3'), '0 9 * * 1');
    await userEvent.click(screen.getByRole('button', { name: 'Remove cron expression 2' }));
    await save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(sent()).toMatchObject({ repeat: { cron: '0 9 * * 5#1', moreCrons: ['0 9 * * 1'], timezone } });
  });

  it('mentions a stored time zone that differs, and holds back a rule it cannot read', async () => {
    open(schedule({ everyMs: null, cron: '0 9 * * 1-5', timezone: 'Pacific/Auckland' }));
    expect(await screen.findByText(/The schedule was set in Pacific\/Auckland/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Repeat/), ' 5');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('switches to running after another schedule, with a delay, and offers neither itself nor its dependents', async () => {
    listed.schedules = [
      schedule(),
      schedule({ id: 'up1', title: 'Build' }),
      schedule({ id: 'dep1', title: 'Deploy', everyMs: null, after: { scheduleId: 'sch1', delayMs: 0 } }),
      schedule({ id: 'dep2', title: 'Notify', everyMs: null, after: { scheduleId: 'dep1', delayMs: 0 } }),
      schedule({ id: 'old1', title: 'Finished', ended: true }),
    ];
    open(schedule());
    await userEvent.click(await screen.findByRole('combobox', { name: 'Run after' }));
    expect(await screen.findByRole('option', { name: 'Build', hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Deploy', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Notify', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Finished', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Nightly', hidden: true })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'Build', hidden: true }));
    expect(screen.queryByLabelText(/Repeat/)).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Delay'), '10m');
    await save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(sent()).toMatchObject({ repeat: { after: { scheduleId: 'up1', delayMs: 600_000 } } });
    expect(sent()).not.toHaveProperty('at');
  });

  it('opens a schedule that runs after another with its upstream and delay, and can return to a rule of its own', async () => {
    listed.schedules = [schedule({ id: 'up1', title: 'Build' })];
    open(schedule({ everyMs: null, after: { scheduleId: 'up1', delayMs: 3_600_000 } }));
    expect(await screen.findByLabelText('Delay')).toHaveValue('1h');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Run after' })).toHaveValue('Build'));
    const clear = screen
      .getByRole('combobox', { name: 'Run after' })
      .closest('.mantine-Input-wrapper')
      ?.querySelector('.mantine-InputClearButton-root');
    expect(clear).not.toBeNull();
    await userEvent.click(clear!);
    await retype(/Repeat/, '1d');
    await save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(sent()).toMatchObject({ repeat: { everyMs: 86_400_000 } });
  });

  it('keeps the end time', async () => {
    const until = '2032-05-06T00:00:00.000Z';
    open(schedule({ until }));
    expect(await screen.findByText(/The end time stays/)).toBeInTheDocument();
    await save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(sent()).toMatchObject({ until: new Date(until), runsLeft: null });
  });

  it('replaces the end time when a number of runs is given', async () => {
    open(schedule({ until: '2032-05-06T00:00:00.000Z' }));
    await retype('Number of runs', '2');
    await save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(sent()).toMatchObject({ until: null, runsLeft: 2 });
  });

  it.each([
    ['updated', 'The pending card was updated too.'],
    ['started', 'The pending card has already started; the change applies from the next run.'],
    ['none', 'The schedule has no pending card; its next run takes the change.'],
    ['removed', /The pending card was removed/],
    ['created', /A card now waits/],
  ] as const)('says what happened to the pending card: %s', async (pending, text) => {
    update.mockResolvedValue({ pending });
    open(schedule());
    await screen.findByLabelText('Title');
    await save();
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('shows the server’s refusal and keeps what was typed', async () => {
    update.mockRejectedValue(new Error('The schedule has ended.'));
    open(schedule());
    await retype('Prompt', 'x');
    await save();
    expect(await screen.findByText('The schedule has ended.')).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).toHaveValue('x');
  });

  it('holds back an empty prompt and a bad agent name', async () => {
    open(schedule());
    await retype('Prompt', '');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await retype('Prompt', 'x');
    await retype('Agent', 'Not An Agent');
    expect(await screen.findByText(/Use lowercase letters/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('EditScheduleModal unsent text', () => {
  const identity = { username: 'jascha', keyId: 'k1' };
  const reopen = (row: Schedule, storage: ReturnType<typeof createMemoryDraftStorage>) =>
    render(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <DraftsProvider identity={identity} storage={storage}>
            <EditScheduleModal schedule={row} opened onClose={() => undefined} />
          </DraftsProvider>
        </QueryClientProvider>
      </MantineProvider>,
    );

  it('restores the title and prompt after a remount, and Cancel drops them', async () => {
    const storage = createMemoryDraftStorage();
    reopen(schedule(), storage).unmount();
    const first = reopen(schedule(), storage);
    await retype('Prompt', 'sweep harder');
    await retype('Title', 'Weekly');
    first.unmount();
    reopen(schedule(), storage);
    expect(await screen.findByLabelText('Prompt')).toHaveValue('sweep harder');
    expect(screen.getByLabelText('Title')).toHaveValue('Weekly');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(draftKeys(storage)).toHaveLength(0);
  });
});
