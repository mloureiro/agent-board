import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../lib/opening';
import type { BoardTask } from '../lib/trpc';
import { AutoDoneSetting, EffortPicker, LanePicker, ModelPicker, TitleSetting, WorkdirSetting } from './TaskSettings';

const configure = vi.hoisted(() => vi.fn(async (_: unknown) => ({})));
const listed = vi.hoisted(() => ({
  paths: ['/work/app', '/work/other'],
  models: [] as { value: string; label: string }[],
  lanes: ['general', 'reviews'],
}));

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({
    tasks: { configure: { mutationOptions: () => ({ mutationFn: configure }) } },
    machines: {
      catalogs: {
        queryOptions: () => ({
          queryKey: ['machines.catalogs'],
          queryFn: async () => [
            { name: 'laptop', catalog: { models: listed.models, skills: [], dirs: {}, lanes: listed.lanes } },
          ],
        }),
      },
      list: {
        queryOptions: () => ({
          queryKey: ['machines.list'],
          queryFn: async () => [
            {
              name: 'laptop',
              shown: 'Laptop',
              dirs: listed.paths.map((path) => ({ path })),
              dirsUnreadable: false,
              revokedAt: null,
              lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
            } as Machine,
          ],
        }),
      },
    },
  }),
  errorMessage: (error: unknown) => String(error),
}));

const task = (extra: Partial<BoardTask> = {}): BoardTask =>
  ({
    id: 'task0001',
    status: 'needs-me',
    createdBy: 'user',
    scheduleId: null,
    machine: 'laptop',
    workdir: '/work/app',
    sessionId: null,
    model: null,
    effort: null,
    autoDone: false,
    unreadable: [],
    ...extra,
  }) as BoardTask;

function renderWith(ui: React.ReactNode): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider>
      <ModalsProvider>
        <QueryClientProvider client={client}>{ui}</QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>,
  );
  return client;
}

const sent = () => configure.mock.calls[0]?.[0];
const openEditor = async () => userEvent.click(screen.getByRole('button', { name: 'Change the working directory' }));
const pick = async (path: string) => {
  await userEvent.click(await screen.findByRole('combobox', { name: 'Working directory' }));
  await userEvent.click((await screen.findAllByRole('option', { name: path, hidden: true }))[0]!);
};
const save = () => screen.findByRole('button', { name: 'Save' });

beforeEach(() => {
  configure.mockClear();
  listed.paths = ['/work/app', '/work/other'];
  listed.models = [];
});

describe('TitleSetting', () => {
  const rename = () => userEvent.click(screen.getByRole('button', { name: 'Rename the task' }));

  it('sends the new title on Enter and shows the title again', async () => {
    renderWith(<TitleSetting task={task({ title: 'Old title', status: 'running' })} />);
    await rename();
    const input = screen.getByRole('textbox', { name: 'Title' });
    await userEvent.clear(input);
    await userEvent.type(input, 'New title{Enter}');
    await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({ task: { id: 'task0001' }, title: 'New title' });
    expect(await screen.findByRole('button', { name: 'Rename the task' })).toBeInTheDocument();
  });

  it('sends nothing for an unchanged or empty title, and Escape keeps the old one', async () => {
    renderWith(<TitleSetting task={task({ title: 'Old title' })} />);
    await rename();
    expect(await save()).toBeDisabled();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Title' }));
    expect(await save()).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), '{Escape}');
    expect(screen.getByRole('heading', { name: 'Old title' })).toBeInTheDocument();
    expect(configure).not.toHaveBeenCalled();
  });

  it('offers no rename on a card of a schedule', () => {
    renderWith(<TitleSetting task={task({ title: 'Sweep', scheduleId: 'sched001' })} />);
    expect(screen.getByRole('heading', { name: 'Sweep' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename the task' })).not.toBeInTheDocument();
  });

  it('starts empty for a title that cannot be read', async () => {
    renderWith(<TitleSetting task={task({ title: '(cannot decrypt)', unreadable: ['title'] })} />);
    await rename();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
  });
});

describe('ModelPicker', () => {
  it('shows a full model name that is not an alias and sends the alias picked', async () => {
    renderWith(<ModelPicker task={task({ model: 'claude-opus-5-5' })} />);
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('claude-opus-5-5');
    await userEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Sonnet', hidden: true }));
    await waitFor(() => expect(configure).toHaveBeenCalled());
    expect(sent()).toMatchObject({ model: 'sonnet' });
  });

  it("offers the models the task's machine listed instead of the aliases", async () => {
    listed.models = [{ value: 'claude-opus-5-5', label: 'Opus 5.5' }];
    renderWith(<ModelPicker task={task({ model: 'sonnet' })} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    expect(await screen.findByRole('option', { name: 'Opus 5.5', hidden: true })).toBeInTheDocument();
    expect(screen.getAllByRole('option', { hidden: true }).map((option) => option.textContent)).toEqual([
      'Default',
      'Sonnet',
      'Opus 5.5',
    ]);
  });

  it('sends null for Default', async () => {
    renderWith(<ModelPicker task={task({ model: 'opus' })} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Default', hidden: true }));
    await waitFor(() => expect(configure).toHaveBeenCalled());
    expect(sent()).toMatchObject({ model: null });
  });
});

describe('EffortPicker', () => {
  it('shows the level of the task, and sends the level picked', async () => {
    renderWith(<EffortPicker task={task({ effort: 'high' })} />);
    expect(screen.getByRole('combobox', { name: 'Effort' })).toHaveValue('High');
    await userEvent.click(screen.getByRole('combobox', { name: 'Effort' }));
    expect(screen.getAllByRole('option', { hidden: true }).map((option) => option.textContent)).toEqual([
      'Default',
      'Low',
      'Medium',
      'High',
      'Extra high',
      'Max',
    ]);
    await userEvent.click(await screen.findByRole('option', { name: 'Extra high', hidden: true }));
    await waitFor(() => expect(configure).toHaveBeenCalled());
    expect(sent()).toMatchObject({ effort: 'xhigh' });
  });

  it('sends null for Default', async () => {
    renderWith(<EffortPicker task={task({ effort: 'max' })} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Effort' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Default', hidden: true }));
    await waitFor(() => expect(configure).toHaveBeenCalled());
    expect(sent()).toMatchObject({ effort: null });
  });
});

describe('AutoDoneSetting', () => {
  it('shows the setting and sends the opposite when it is switched, in any status', async () => {
    renderWith(<AutoDoneSetting task={task({ status: 'running' })} />);
    const toggle = screen.getByRole('switch', { name: /Agent may mark it done/ });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(configure).toHaveBeenCalled());
    expect(sent()).toMatchObject({ autoDone: true });
  });

  it('shows it on and switches it off', async () => {
    renderWith(<AutoDoneSetting task={task({ autoDone: true })} />);
    const toggle = screen.getByRole('switch', { name: /Agent may mark it done/ });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(configure).toHaveBeenCalled());
    expect(sent()).toMatchObject({ autoDone: false });
  });

  it('says that a schedule’s card takes the setting from its schedule for the next occurrence', () => {
    renderWith(<AutoDoneSetting task={task({ scheduleId: 'sched001' })} />);
    expect(screen.getByText(/the next occurrence takes its settings from the schedule/)).toBeInTheDocument();
  });
});

describe('WorkdirSetting', () => {
  it('changes the directory without a confirmation when the task has no session', async () => {
    renderWith(<WorkdirSetting task={task()} unlisted={undefined} />);
    await openEditor();
    expect(await save()).toBeDisabled();
    await pick('/work/other');
    await userEvent.click(await save());
    await waitFor(() => expect(configure).toHaveBeenCalled());
    expect(sent()).toMatchObject({ place: { machine: 'laptop', workdir: '/work/other' } });
  });

  it('does nothing for the directory it already has', async () => {
    renderWith(<WorkdirSetting task={task()} unlisted={undefined} />);
    await openEditor();
    await pick('/work/app');
    expect(await save()).toBeDisabled();
  });

  it('confirms first when the task has a session, and drops nothing on cancel', async () => {
    renderWith(<WorkdirSetting task={task({ sessionId: 's1' })} unlisted={undefined} />);
    await openEditor();
    await pick('/work/other');
    await userEvent.click(await save());
    expect(await screen.findByText(/session is dropped/)).toBeInTheDocument();
    expect(configure).not.toHaveBeenCalled();
    await userEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!);
    expect(configure).not.toHaveBeenCalled();
  });

  it('sends the move after the confirmation', async () => {
    renderWith(<WorkdirSetting task={task({ sessionId: 's1' })} unlisted={undefined} />);
    await openEditor();
    await pick('/work/other');
    await userEvent.click(await save());
    await userEvent.click(await screen.findByRole('button', { name: 'Move and drop the session' }));
    await waitFor(() => expect(configure).toHaveBeenCalled());
  });

  it('removes the directory with No directory', async () => {
    renderWith(<WorkdirSetting task={task()} unlisted={undefined} />);
    await openEditor();
    await userEvent.click(await screen.findByRole('button', { name: 'No directory' }));
    await userEvent.click(await save());
    await waitFor(() => expect(configure).toHaveBeenCalled());
    expect(sent()).toMatchObject({ place: null });
  });

  it('states the current directory when the lists do not offer it, instead of the default', async () => {
    renderWith(<WorkdirSetting task={task({ workdir: '/work/app/.claude/worktrees/x' })} unlisted={undefined} />);
    await openEditor();
    expect(await screen.findByPlaceholderText('laptop:/work/app/.claude/worktrees/x')).toBeInTheDocument();
    expect(await save()).toBeDisabled();
  });

  it('has nothing to save when a refetch drops the picked directory', async () => {
    const client = renderWith(<WorkdirSetting task={task()} unlisted={undefined} />);
    await openEditor();
    await pick('/work/other');
    expect(await save()).toBeEnabled();
    listed.paths = ['/work/app'];
    await client.invalidateQueries({ queryKey: ['machines.list'] });
    await waitFor(() => expect(screen.queryByRole('option', { name: '/work/other', hidden: true })).toBeNull());
    expect(await save()).toBeDisabled();
  });

  it('hints that a scheduled card changes alone', async () => {
    renderWith(<WorkdirSetting task={task({ scheduleId: 'sched001' })} unlisted={undefined} />);
    await openEditor();
    expect(await screen.findByText(/belongs to a schedule/)).toBeInTheDocument();
  });

  it.each(['running', 'waiting'] as const)('cannot be changed while the task is %s', (status) => {
    renderWith(<WorkdirSetting task={task({ status })} unlisted={undefined} />);
    expect(screen.getByRole('button', { name: 'Change the working directory' })).toBeDisabled();
  });

  it('keeps the not-listed hint and lets an unreadable directory be replaced', async () => {
    renderWith(<WorkdirSetting task={task()} unlisted="Laptop" />);
    expect(screen.getByText(/laptop:\/work\/app · not listed on Laptop/)).toBeInTheDocument();
  });

  it('can replace a directory that could not be read', async () => {
    renderWith(
      <WorkdirSetting task={task({ workdir: null, machine: null, unreadable: ['workdir'] })} unlisted={undefined} />,
    );
    expect(screen.getByText('Directory cannot be read')).toBeInTheDocument();
    await openEditor();
    await pick('/work/app');
    await userEvent.click(await save());
    await waitFor(() => expect(configure).toHaveBeenCalled());
  });
});

describe('LanePicker', () => {
  it('offers the default lane and the published lanes, and saves the chosen one through configure', async () => {
    renderWith(<LanePicker task={task({ requestedLane: null })} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Lane' }));
    await userEvent.click(await screen.findByRole('option', { name: 'reviews', hidden: true }));
    await waitFor(() => expect(configure).toHaveBeenCalled());
    expect(sent()).toMatchObject({ lane: 'reviews' });
  });

  it('sends null for the default lane', async () => {
    renderWith(<LanePicker task={task({ requestedLane: 'reviews' })} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Lane' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Default lane', hidden: true }));
    await waitFor(() => expect(configure).toHaveBeenCalled());
    expect(sent()).toMatchObject({ lane: null });
  });

  it('is disabled while the task runs', () => {
    renderWith(<LanePicker task={task({ status: 'running', requestedLane: 'reviews' })} />);
    expect(screen.getByRole('combobox', { name: 'Lane' })).toBeDisabled();
  });
});
