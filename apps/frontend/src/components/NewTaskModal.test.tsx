import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineCatalog, MachineDir } from '@agent-board/shared';
import { LAST_DIRECTORY_KEY } from '../lib/lastDirectory';
import type { Machine } from '@agent-board/shared/ui';
import { NewTaskModal } from './NewTaskModal';

const create = vi.hoisted(() => vi.fn(async (_: unknown) => ({ id: 'new1' })));

const listed = vi.hoisted(() => ({
  machines: [] as unknown[],
  catalogs: [] as unknown[],
  failure: null as Error | null,
  schedules: [] as unknown[],
}));

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({
    tasks: { create: { mutationOptions: () => ({ mutationFn: create }) } },
    schedules: {
      list: { queryOptions: () => ({ queryKey: ['schedules.list'], queryFn: async () => listed.schedules }) },
    },
    machines: {
      list: {
        queryOptions: () => ({
          queryKey: ['machines.list'],
          queryFn: async () => {
            if (listed.failure) throw listed.failure;
            return listed.machines;
          },
        }),
      },
      catalogs: { queryOptions: () => ({ queryKey: ['machines.catalogs'], queryFn: async () => listed.catalogs }) },
    },
  }),
  errorMessage: (error: unknown) => String(error),
}));

vi.mock('./MarkdownEditor', () => ({
  MarkdownEditor: ({
    value,
    onChange,
    skills = [],
  }: {
    value: string;
    onChange: (value: string) => void;
    skills?: readonly { name: string }[];
  }) => (
    <>
      <textarea aria-label="Prompt" value={value} onChange={(event) => onChange(event.currentTarget.value)} />
      <output aria-label="Offered skills">{skills.map(({ name }) => name).join(',')}</output>
    </>
  ),
}));

const FUTURE = '2099-01-01T10:00';

function Path() {
  return <output aria-label="Path">{useLocation().pathname}</output>;
}

async function open(when?: string) {
  render(
    <MemoryRouter>
      <MantineProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <NewTaskModal opened onClose={() => undefined} />
          <Path />
        </QueryClientProvider>
      </MantineProvider>
    </MemoryRouter>,
  );
  await userEvent.type(screen.getByLabelText('Prompt'), '/sweep');
  if (when !== undefined) {
    await userEvent.click(screen.getByRole('combobox', { name: 'When' }));
    await userEvent.click(await screen.findByRole('option', { name: when, hidden: true }));
  }
}

const createButton = () => screen.getByRole('button', { name: 'Create' });
const sent = () => create.mock.calls[0]?.[0];

beforeEach(() => {
  create.mockClear();
  listed.machines = [];
  listed.catalogs = [];
  listed.failure = null;
  listed.schedules = [];
  localStorage.clear();
});

describe('NewTaskModal Agent', () => {
  it('sends none when the field is empty', async () => {
    await open();
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).not.toHaveProperty('agent');
  });

  it('sends the agent as typed, trimmed', async () => {
    await open();
    await userEvent.type(screen.getByLabelText('Agent'), ' reviewer ');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ input: '/sweep', agent: 'reviewer' });
  });

  it('holds back a name that is not an agent name', async () => {
    await open();
    await userEvent.type(screen.getByLabelText('Agent'), 'Not An Agent');
    expect(await screen.findByText(/Use lowercase letters, digits and dashes/)).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
  });

  it('sends the agent of a repeating task too', async () => {
    await open('Repeating');
    await userEvent.type(screen.getByLabelText(/Repeat/), '2h');
    await userEvent.type(screen.getByLabelText('Agent'), 'sweeper');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ agent: 'sweeper', when: { every: 2 * 3_600_000 } });
  });
});

describe('NewTaskModal When', () => {
  it.each([
    ['Now', 'now'],
    ['Backlog', 'backlog'],
    ['Needs me', 'hold'],
  ])('sends %s as the plain keyword', async (label, when) => {
    await open(label);
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ input: '/sweep', when });
  });

  it('starts the next task at Now again', async () => {
    await open('Backlog');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'When' })).toHaveValue('Now'));
  });

  it('sends Later with the chosen start time', async () => {
    await open('Later');
    expect(createButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: FUTURE } });
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ when: { at: new Date(FUTURE) } });
  });

  it('refuses a Later start time in the past', async () => {
    await open('Later');
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '2020-01-01T10:00' } });
    expect(await screen.findByText('Pick a time in the future')).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
  });

  it('sends a repeating interval with its first run and number of runs', async () => {
    await open('Repeating');
    expect(createButton()).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Repeat/), '2h');
    fireEvent.change(screen.getByLabelText('First run'), { target: { value: FUTURE } });
    await userEvent.type(screen.getByLabelText('Number of runs'), '3');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ when: { every: 2 * 3_600_000, at: new Date(FUTURE), times: 3 } });
  });

  it('sends a repeating cron rule in the local time zone, starting now by default', async () => {
    await open('Repeating');
    await userEvent.type(screen.getByLabelText(/Repeat/), '0 9 * * 1-5');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    const { when } = sent() as { when: Record<string, unknown> };
    expect(when).toEqual({ cron: '0 9 * * 1-5', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });

  it('refuses a past first run and a number of runs below 1', async () => {
    await open('Repeating');
    await userEvent.type(screen.getByLabelText(/Repeat/), '2h');
    fireEvent.change(screen.getByLabelText('First run'), { target: { value: '2020-01-01T10:00' } });
    expect(await screen.findByText('Pick a time in the future')).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('First run'), { target: { value: '' } });
    await userEvent.type(screen.getByLabelText('Number of runs'), '0');
    expect(await screen.findByText('A whole number, 1 or more')).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });
});

const cronZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

describe('NewTaskModal repeating with several cron expressions', () => {
  it('offers more rows only for a cron expression, and sends the first as the rule and the others as more', async () => {
    await open('Repeating');
    expect(screen.queryByRole('button', { name: 'Add cron expression' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Repeat/), '2h');
    expect(screen.queryByRole('button', { name: 'Add cron expression' })).not.toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText(/Repeat/));
    await userEvent.type(screen.getByLabelText(/Repeat/), '0 9 * * 5#1');
    await userEvent.click(screen.getByRole('button', { name: 'Add cron expression' }));
    await userEvent.type(screen.getByLabelText('Cron expression 2'), '0 9 * * 5#3');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect((sent() as { when: unknown }).when).toEqual({
      cron: '0 9 * * 5#1',
      moreCrons: ['0 9 * * 5#3'],
      timezone: cronZone(),
    });
  });

  it('removes a row, and sends a single expression without more', async () => {
    await open('Repeating');
    await userEvent.type(screen.getByLabelText(/Repeat/), '0 9 * * 5#1');
    await userEvent.click(screen.getByRole('button', { name: 'Add cron expression' }));
    await userEvent.type(screen.getByLabelText('Cron expression 2'), '0 9 * * 5#3');
    await userEvent.click(screen.getByRole('button', { name: 'Remove cron expression 2' }));
    expect(screen.queryByLabelText('Cron expression 2')).not.toBeInTheDocument();
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect((sent() as { when: unknown }).when).toEqual({ cron: '0 9 * * 5#1', timezone: cronZone() });
  });

  it('stops offering rows at ten', async () => {
    await open('Repeating');
    await userEvent.type(screen.getByLabelText(/Repeat/), '0 0 * * *');
    for (let row = 1; row < 10; row += 1)
      await userEvent.click(screen.getByRole('button', { name: 'Add cron expression' }));
    expect(screen.getByLabelText('Cron expression 10')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add cron expression' })).not.toBeInTheDocument();
  });

  it('holds back a repeated expression and a row that is not cron', async () => {
    await open('Repeating');
    await userEvent.type(screen.getByLabelText(/Repeat/), '0 9 * * *');
    await userEvent.click(screen.getByRole('button', { name: 'Add cron expression' }));
    await userEvent.type(screen.getByLabelText('Cron expression 2'), '0 9 * * *');
    expect(await screen.findByText('A cron expression is given twice')).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Cron expression 2'));
    await userEvent.type(screen.getByLabelText('Cron expression 2'), 'often');
    expect(await screen.findByText(/does not have 5 cron fields/)).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
  });
});

describe('NewTaskModal repeating with a limit', () => {
  it('sends no limit by default', async () => {
    await open('Repeating');
    await userEvent.type(screen.getByLabelText(/Repeat/), '2h');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect((sent() as { when: object }).when).not.toHaveProperty('maxConcurrent');
  });

  it('sends the number given as maxConcurrent', async () => {
    await open('Repeating');
    await userEvent.type(screen.getByLabelText(/Repeat/), '2h');
    await userEvent.type(screen.getByLabelText('At most at once'), '2');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ when: { every: 7_200_000, maxConcurrent: 2 } });
  });

  it('refuses a limit above 100', async () => {
    await open('Repeating');
    await userEvent.type(screen.getByLabelText(/Repeat/), '2h');
    fireEvent.change(screen.getByLabelText('At most at once'), { target: { value: '101' } });
    await waitFor(() => expect(createButton()).toBeDisabled());
  });
});

describe('NewTaskModal repeating after another schedule', () => {
  const upstream = (id: string, title: string, ended = false) => ({ id, title, ended });
  const chooseAfter = async (title: string) => {
    await userEvent.click(screen.getByRole('combobox', { name: 'Run after' }));
    await userEvent.click(await screen.findByRole('option', { name: title, hidden: true }));
  };

  it('offers the schedules that have not ended, by title, and sends the choice with its delay', async () => {
    listed.schedules = [upstream('up1', 'Build'), upstream('up2', 'Old', true)];
    await open('Repeating');
    await userEvent.click(screen.getByRole('combobox', { name: 'Run after' }));
    expect(await screen.findByRole('option', { name: 'Build', hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Old', hidden: true })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'Build', hidden: true }));
    expect(screen.queryByLabelText(/^Repeat/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('First run')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Delay'), '10m');
    await userEvent.type(screen.getByLabelText('Number of runs'), '3');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect((sent() as { when: unknown }).when).toEqual({ after: { scheduleId: 'up1', delayMs: 600_000 }, times: 3 });
  });

  it('is not held back by a past first run that the choice hid', async () => {
    listed.schedules = [upstream('up1', 'Build')];
    await open('Repeating');
    await userEvent.type(screen.getByLabelText(/Repeat/), '2h');
    fireEvent.change(screen.getByLabelText('First run'), { target: { value: '2020-01-01T10:00' } });
    expect(createButton()).toBeDisabled();
    await chooseAfter('Build');
    await waitFor(() => expect(createButton()).toBeEnabled());
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect((sent() as { when: unknown }).when).toEqual({ after: { scheduleId: 'up1', delayMs: 0 } });
  });

  it('sends no delay as none, refuses one that is not a duration, and goes to the Schedules page after', async () => {
    listed.schedules = [upstream('up1', 'Build')];
    create.mockResolvedValueOnce(null as never);
    await open('Repeating');
    await chooseAfter('Build');
    await userEvent.type(screen.getByLabelText('Delay'), 'soon');
    expect(await screen.findByText(/A duration such as 10m/)).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Delay'));
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect((sent() as { when: unknown }).when).toEqual({ after: { scheduleId: 'up1', delayMs: 0 } });
    await waitFor(() => expect(screen.getByLabelText('Path')).toHaveTextContent('/schedules'));
  });
});

describe('NewTaskModal model', () => {
  it('sends no model by default', async () => {
    await open();
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).not.toHaveProperty('model');
  });

  it('sends the chosen alias', async () => {
    await open();
    await userEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Opus', hidden: true }));
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ model: 'opus', when: 'now' });
  });
});

describe('NewTaskModal effort', () => {
  it('sends no effort by default', async () => {
    await open();
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).not.toHaveProperty('effort');
  });

  it('sends the chosen level', async () => {
    await open();
    await userEvent.click(screen.getByRole('combobox', { name: 'Effort' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Extra high', hidden: true }));
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ effort: 'xhigh', when: 'now' });
  });
});

describe('NewTaskModal lane', () => {
  it('sends no lane by default, and does not say that the prompt picks the lane', async () => {
    await open();
    expect(screen.queryByText(/picks the lane/)).not.toBeInTheDocument();
    expect(screen.getByText(/The Lane field below sets the lane it runs in/)).toBeInTheDocument();
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).not.toHaveProperty('lane');
  });

  it('offers the lanes the machines published and sends the chosen one', async () => {
    listed.catalogs = [
      { name: 'laptop', catalog: { models: [], skills: [], dirs: {}, lanes: ['general', 'reviews'] } },
      { name: 'desktop', catalog: { models: [], skills: [], dirs: {}, lanes: ['general', 'docs'] } },
    ];
    await open();
    await userEvent.click(screen.getByRole('combobox', { name: 'Lane' }));
    expect(await screen.findByRole('option', { name: 'Default lane', hidden: true })).toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: 'general', hidden: true })).toHaveLength(1);
    await userEvent.click(screen.getByRole('option', { name: 'docs', hidden: true }));
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ lane: 'docs', when: 'now' });
  });
});

describe('NewTaskModal auto-done', () => {
  it('sends no setting by default', async () => {
    await open();
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).not.toHaveProperty('autoDone');
  });

  it('sends autoDone when the box is checked', async () => {
    await open();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Agent may mark it done' }));
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ autoDone: true, when: 'now' });
  });
});

const HOUR = 3_600_000;
const machine = (name: string, dirs: (string | MachineDir)[] | null, extra: Partial<Machine> = {}): Machine =>
  ({
    name,
    shown: name,
    dirs: dirs?.map((dir) => (typeof dir === 'string' ? { path: dir } : dir)) ?? null,
    dirsUnreadable: false,
    revokedAt: null,
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    ...extra,
  }) as Machine;

const directory = () => screen.getByRole('combobox', { name: 'Working directory' });
const pick = async (path: string, group?: string) => {
  await userEvent.click(directory());
  const options = await screen.findAllByRole('option', { name: path, hidden: true });
  const target =
    group === undefined
      ? options[0]
      : options.find((option) => option.closest('[data-combobox-option]')?.parentElement?.textContent?.includes(group));
  await userEvent.click(target ?? options[0]!);
};

describe('NewTaskModal working directory', () => {
  it('is disabled with a hint when no machine has listed a directory', async () => {
    listed.machines = [machine('laptop', null), machine('desktop', [])];
    await open();
    await waitFor(() => expect(directory()).toBeDisabled());
    expect(screen.getByText(/No machine has listed a directory yet/)).toBeInTheDocument();
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).not.toHaveProperty('place');
  });

  it('shows the error of a failed load without blocking the form', async () => {
    listed.failure = new Error('machines are down');
    await open();
    expect(await screen.findByText(/machines are down/)).toBeInTheDocument();
    expect(directory()).toBeDisabled();
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
  });

  it('sends the machine and directory that was picked', async () => {
    listed.machines = [machine('laptop', ['/work/a', '/work/b'])];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await pick('/work/b');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ place: { machine: 'laptop', workdir: '/work/b' } });
  });

  it('shows a label with its path, finds a directory by either, and still sends the path', async () => {
    listed.machines = [machine('laptop', [{ path: '/work/a', label: 'Board' }, '/work/b'])];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await userEvent.click(directory());
    expect(await screen.findByRole('option', { name: 'Board — /work/a', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '/work/b', hidden: true })).toBeInTheDocument();
    await userEvent.type(directory(), 'boar');
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: '/work/b', hidden: true })).not.toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('option', { name: 'Board — /work/a', hidden: true }));
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ place: { machine: 'laptop', workdir: '/work/a' } });
  });

  it('renders a label as plain text', async () => {
    listed.machines = [machine('laptop', [{ path: '/work/a', label: '<b>bold</b>' }])];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await userEvent.click(directory());
    expect(await screen.findByRole('option', { name: '<b>bold</b> — /work/a', hidden: true })).toBeInTheDocument();
  });

  it('sends no place when the field stays empty', async () => {
    listed.machines = [machine('laptop', ['/work/a'])];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent()).not.toHaveProperty('place');
  });

  it('keeps the same path on two machines apart and sends the machine picked', async () => {
    listed.machines = [machine('laptop', ['/work/app']), machine('desktop', ['/work/app'])];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await userEvent.click(directory());
    expect(await screen.findAllByRole('option', { name: '/work/app', hidden: true })).toHaveLength(2);
    await pick('/work/app', 'desktop');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ place: { machine: 'desktop', workdir: '/work/app' } });
  });

  it('orders groups by last seen and labels a machine not seen for a day', async () => {
    listed.machines = [
      machine('old', ['/o'], { lastSeenAt: new Date(Date.now() - 49 * HOUR).toISOString() }),
      machine('never', ['/n'], { lastSeenAt: null }),
      machine('fresh', ['/f']),
    ];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await userEvent.click(directory());
    const labels = (await screen.findAllByText(/^(fresh|old|never)/, { selector: '.mantine-Select-groupLabel' })).map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(['fresh', 'old · last seen 2 days ago', 'never · never seen']);
  });

  it('hides revoked machines', async () => {
    listed.machines = [
      machine('gone', ['/g'], { revokedAt: new Date().toISOString(), dirs: null }),
      machine('laptop', ['/l']),
    ];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await userEvent.click(directory());
    expect(await screen.findByRole('option', { name: '/l', hidden: true })).toBeInTheDocument();
    expect(screen.queryByText('gone')).not.toBeInTheDocument();
  });

  it('says which machine has a list it could not read', async () => {
    listed.machines = [machine('laptop', ['/l']), machine('desktop', null, { dirsUnreadable: true })];
    await open();
    expect(await screen.findByText('The directory list of desktop could not be read.')).toBeInTheDocument();
    expect(directory()).toBeEnabled();
  });

  it('stays enabled and sends the place for a repeating schedule', async () => {
    listed.machines = [machine('laptop', ['/work/a'])];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await pick('/work/a');
    await userEvent.click(screen.getByRole('combobox', { name: 'When' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Repeating', hidden: true }));
    expect(directory()).toBeEnabled();
    await userEvent.type(screen.getByLabelText(/Repeat/), '2h');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ when: { every: 7_200_000 }, place: { machine: 'laptop', workdir: '/work/a' } });
  });
});

describe('NewTaskModal last working directory', () => {
  const stored = () => localStorage.getItem(LAST_DIRECTORY_KEY);

  it('remembers the machine and directory of the task it created', async () => {
    listed.machines = [machine('laptop', ['/work/a']), machine('desktop', ['/work/a'])];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await pick('/work/a', 'desktop');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    await waitFor(() => expect(stored()).toBe(JSON.stringify(['desktop', '/work/a'])));
  });

  it('opens with the remembered directory and sends it', async () => {
    localStorage.setItem(LAST_DIRECTORY_KEY, JSON.stringify(['laptop', '/work/b']));
    listed.machines = [machine('laptop', ['/work/a', '/work/b'])];
    await open();
    await waitFor(() => expect(directory()).toHaveValue('/work/b'));
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ place: { machine: 'laptop', workdir: '/work/b' } });
  });

  it('sends no place for a remembered directory no machine lists any more, and forgets it', async () => {
    localStorage.setItem(LAST_DIRECTORY_KEY, JSON.stringify(['laptop', '/gone']));
    listed.machines = [machine('laptop', ['/work/a'])];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    expect(directory()).toHaveValue('');
    expect(directory().closest('.mantine-Input-wrapper')?.querySelector('.mantine-InputClearButton-root')).toBeNull();
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).not.toHaveProperty('place');
    await waitFor(() => expect(stored()).toBeNull());
  });
});

const skill = (name: string) => ({ name });
const catalogOf = (parts: Partial<MachineCatalog>): MachineCatalog => ({ models: [], skills: [], dirs: {}, ...parts });
const offeredSkills = () => screen.getByLabelText('Offered skills').textContent;
const modelField = () => screen.getByRole('combobox', { name: 'Model' });

describe('NewTaskModal skills and models of the machines', () => {
  beforeEach(() => {
    listed.machines = [machine('laptop', ['/work/a', '/work/b']), machine('desktop', ['/srv/c'])];
    listed.catalogs = [
      {
        name: 'laptop',
        catalog: catalogOf({
          models: [{ value: 'claude-opus-9', label: 'Opus 9' }],
          skills: [skill('review')],
          dirs: { '/work/a': [skill('deploy')], '/work/b': [skill('lint')] },
        }),
      },
      {
        name: 'desktop',
        catalog: catalogOf({
          models: [
            { value: 'claude-opus-9', label: 'Other label' },
            { value: 'claude-haiku-9', label: 'Haiku 9' },
          ],
          skills: [skill('sweep')],
        }),
      },
    ];
  });

  it('offers the skills of every machine until a directory is chosen', async () => {
    await open();
    await waitFor(() => expect(offeredSkills()).toBe('deploy,lint,review,sweep'));
  });

  it('offers the skills of the machine and directory that was picked', async () => {
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await pick('/work/a');
    expect(offeredSkills()).toBe('deploy,review');
    await pick('/work/b');
    expect(offeredSkills()).toBe('lint,review');
  });

  it('offers the models of every machine, then of the chosen one, labelled as the catalogue says', async () => {
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await userEvent.click(modelField());
    expect(await screen.findByRole('option', { name: 'Haiku 9', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Opus 9', hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Opus', hidden: true })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await pick('/work/a');
    await userEvent.click(modelField());
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: 'Haiku 9', hidden: true })).not.toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('option', { name: 'Opus 9', hidden: true }));
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ model: 'claude-opus-9', place: { machine: 'laptop', workdir: '/work/a' } });
  });

  it('keeps the model that was picked when the new machine does not list it', async () => {
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    await userEvent.click(modelField());
    await userEvent.click(await screen.findByRole('option', { name: 'Haiku 9', hidden: true }));
    await pick('/work/a');
    expect(modelField()).toHaveValue('Haiku 9');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ model: 'claude-haiku-9' });
  });

  it('falls back to the aliases and offers no skills when no machine sent a catalogue', async () => {
    listed.machines = [machine('laptop', ['/work/a'])];
    listed.catalogs = [{ name: 'laptop', catalog: null }];
    await open();
    await waitFor(() => expect(directory()).toBeEnabled());
    expect(offeredSkills()).toBe('');
    await userEvent.click(modelField());
    expect(await screen.findByRole('option', { name: 'Opus', hidden: true })).toBeInTheDocument();
  });
});

describe('NewTaskModal icon', () => {
  it('sends no icon by default', async () => {
    await open();
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).not.toHaveProperty('icon');
  });

  it('sends the emoji picked in front of the title', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add new task icon' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search emoji', hidden: true }), {
      target: { value: 'rocket' },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'rocket', hidden: true }));
    expect(screen.getByRole('button', { name: 'New task icon: rocket. Change it' })).toHaveTextContent('🚀');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ icon: '🚀', when: 'now' });
  });
});

describe('NewTaskModal labels', () => {
  it('sends no labels by default', async () => {
    await open();
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).not.toHaveProperty('labels');
  });

  it('sends the labels typed in the Labels field', async () => {
    await open();
    await userEvent.type(screen.getByRole('combobox', { name: 'Labels' }), 'bug{Enter}ui{Enter}');
    await userEvent.click(createButton());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(sent()).toMatchObject({ labels: ['bug', 'ui'], when: 'now' });
  });
});
