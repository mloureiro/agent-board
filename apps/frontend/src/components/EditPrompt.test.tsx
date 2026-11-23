import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardTask } from '../lib/trpc';
import { createMemoryDraftStorage, draftKeys } from '../test/draftStorage';
import { DraftsProvider } from './DraftsProvider';
import { EditTaskPrompt } from './EditPrompt';

const editTask = vi.hoisted(() => vi.fn(async (_: unknown) => ({})));

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({
    tasks: { edit: { mutationOptions: () => ({ mutationFn: editTask }) } },
  }),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock('./MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) => (
    <textarea aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)} />
  ),
}));

const task = (overrides: Partial<BoardTask> = {}): BoardTask =>
  ({
    id: 'task0001',
    status: 'todo',
    proposed: false,
    closed: false,
    started: false,
    title: 'Old title',
    input: 'Old prompt',
    createdBy: 'user',
    scheduleId: null,
    agent: 'reviewer',
    unreadable: [],
    ...overrides,
  }) as BoardTask;

function renderWith(ui: React.ReactNode) {
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {ui}
      </QueryClientProvider>
    </MantineProvider>,
  );
}

const retype = async (label: string, text: string) => {
  const field = await screen.findByLabelText(label);
  await userEvent.clear(field);
  await userEvent.type(field, text);
};

beforeEach(() => {
  editTask.mockReset().mockResolvedValue({});
});

describe('EditTaskPrompt', () => {
  it('opens the editor with the title and prompt filled in and saves nothing until they change', async () => {
    renderWith(<EditTaskPrompt task={task()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit prompt' }));
    expect(await screen.findByLabelText('Title')).toHaveValue('Old title');
    expect(screen.getByLabelText('Prompt')).toHaveValue('Old prompt');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('sends the task as the page shows it, with its agent, and the new text', async () => {
    renderWith(<EditTaskPrompt task={task()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit prompt' }));
    await retype('Prompt', 'New prompt');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(editTask).toHaveBeenCalled());
    expect(editTask.mock.calls[0]?.[0]).toMatchObject({
      target: { id: 'task0001', agent: 'reviewer', scheduleId: null },
      title: 'Old title',
      input: 'New prompt',
    });
    await waitFor(() => expect(screen.queryByLabelText('Prompt')).not.toBeInTheDocument());
  });

  it('shows the server’s refusal in the editor and keeps what was typed', async () => {
    editTask.mockRejectedValue(
      new Error('The task has already run; its prompt is in its thread now. Reply to it instead.'),
    );
    renderWith(<EditTaskPrompt task={task()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit prompt' }));
    await retype('Prompt', 'New prompt');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/already run/)).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).toHaveValue('New prompt');
  });

  it('stays open with the draft when the task is claimed meanwhile, and shows the refusal on save', async () => {
    editTask.mockRejectedValue(
      new Error('The task has started; its prompt is in its thread now. Reply to it instead.'),
    );
    const view = (started: boolean) => (
      <MantineProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <EditTaskPrompt task={task({ started, status: started ? 'running' : 'todo' })} />
        </QueryClientProvider>
      </MantineProvider>
    );
    const { rerender } = render(view(false));
    await userEvent.click(screen.getByRole('button', { name: 'Edit prompt' }));
    await retype('Prompt', 'my draft');
    rerender(view(true));
    expect(screen.getByLabelText('Prompt')).toHaveValue('my draft');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/The task has started/)).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).toHaveValue('my draft');
  });

  it('shows no button for a task that cannot be edited', () => {
    renderWith(<EditTaskPrompt task={task({ started: true })} />);
    expect(screen.queryByRole('button', { name: 'Edit prompt' })).not.toBeInTheDocument();
  });
});

describe('EditTaskPrompt unsent text', () => {
  const identity = { username: 'jascha', keyId: 'k1' };
  const view = (row: BoardTask, storage: ReturnType<typeof createMemoryDraftStorage>) => (
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DraftsProvider identity={identity} storage={storage}>
          <EditTaskPrompt task={row} />
        </DraftsProvider>
      </QueryClientProvider>
    </MantineProvider>
  );
  const edit = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Edit prompt' }));
    return screen.findByLabelText('Prompt');
  };

  it('is restored after the editor is closed and reopened', async () => {
    const storage = createMemoryDraftStorage();
    render(view(task(), storage));
    await edit();
    await retype('Prompt', 'half a rewrite');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByLabelText('Prompt')).not.toBeInTheDocument());
    expect(await edit()).toHaveValue('half a rewrite');
  });

  it('is dropped when the task’s prompt changed meanwhile, also after a reload', async () => {
    const storage = createMemoryDraftStorage();
    const first = render(view(task(), storage));
    await edit();
    await retype('Prompt', 'half a rewrite');
    first.unmount();
    render(view(task({ input: 'Changed elsewhere' }), storage));
    expect(await edit()).toHaveValue('Changed elsewhere');
  });

  it('is dropped by Cancel', async () => {
    const storage = createMemoryDraftStorage();
    render(view(task(), storage));
    await edit();
    await retype('Prompt', 'half a rewrite');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(draftKeys(storage)).toHaveLength(0);
  });
});
