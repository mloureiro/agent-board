import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QuestionPanel } from './QuestionPanel';

const questions = [
  {
    header: 'Null sort',
    question: 'Blocking?',
    multiSelect: false,
    options: [
      { label: 'Blocking', description: 'keep it', recommended: true },
      { label: 'Nit', description: 'downgrade' },
    ],
  },
  {
    header: 'Follow-ups',
    question: 'Which ones?',
    multiSelect: true,
    options: [
      { label: 'Audit', description: '' },
      { label: 'Fixtures', description: '' },
    ],
  },
];

const renderPanel = (onSubmit = vi.fn(), onDismiss = vi.fn()) => {
  render(
    <MantineProvider>
      <ModalsProvider>
        <QuestionPanel
          questions={questions}
          submitting={false}
          onSubmit={onSubmit}
          onDismiss={onDismiss}
          dismissing={false}
        />
      </ModalsProvider>
    </MantineProvider>,
  );
  return onSubmit;
};

describe('QuestionPanel', () => {
  it('preselects the recommended option and sends with an empty multi-select', async () => {
    const onSubmit = renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /Answer & continue/ }));
    expect(onSubmit).toHaveBeenCalledWith(questions, [{ selected: ['Blocking'] }, { selected: [] }], '');
  });

  it('number keys pick in the active question, which moves on after a single choice', async () => {
    const onSubmit = renderPanel();
    await userEvent.keyboard('2');
    await userEvent.keyboard('1');
    await userEvent.keyboard('2');
    await userEvent.click(screen.getByRole('button', { name: /Answer & continue/ }));
    expect(onSubmit).toHaveBeenCalledWith(questions, [{ selected: ['Nit'] }, { selected: ['Audit', 'Fixtures'] }], '');
  });

  it('number keys and mod+Enter do nothing while a drawer or modal is open', async () => {
    const onSubmit = renderPanel();
    const overlay = document.body.appendChild(document.createElement('div'));
    overlay.setAttribute('role', 'dialog');
    await userEvent.keyboard('2');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit).not.toHaveBeenCalled();
    overlay.remove();
    await userEvent.click(screen.getByRole('button', { name: /Answer & continue/ }));
    expect(onSubmit.mock.calls[0]?.[1][0]).toEqual({ selected: ['Blocking'] });
  });

  it('focusing the Other field keeps the single choice', async () => {
    const onSubmit = renderPanel();
    await userEvent.click(screen.getAllByPlaceholderText(/Other…/)[0]!);
    await userEvent.click(screen.getByRole('button', { name: /Answer & continue/ }));
    expect(onSubmit.mock.calls[0]?.[1][0]).toEqual({ selected: ['Blocking'] });
  });

  it('typing in the Other field drops the single choice', async () => {
    const onSubmit = renderPanel();
    await userEvent.type(screen.getAllByPlaceholderText(/Other…/)[0]!, 'neither, ask the author');
    expect(screen.queryByRole('button', { name: 'None of these' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Answer & continue/ }));
    expect(onSubmit.mock.calls[0]?.[1][0]).toEqual({ selected: [], other: 'neither, ask the author' });
  });

  it('an option picked after typing goes with the Other text', async () => {
    const onSubmit = renderPanel();
    const other = screen.getAllByPlaceholderText(/Other…/)[0]!;
    await userEvent.type(other, 'only if');
    await userEvent.click(screen.getByText('Nit'));
    await userEvent.type(other, ' cheap');
    await userEvent.click(screen.getByRole('button', { name: /Answer & continue/ }));
    expect(onSubmit.mock.calls[0]?.[1][0]).toEqual({ selected: ['Nit'], other: 'only if cheap' });
  });

  it('typing in the Other field keeps the multi-select picks', async () => {
    const onSubmit = renderPanel();
    await userEvent.click(screen.getByText('Audit'));
    await userEvent.type(screen.getAllByPlaceholderText(/Other…/)[1]!, 'and the docs');
    await userEvent.click(screen.getByRole('button', { name: /Answer & continue/ }));
    expect(onSubmit.mock.calls[0]?.[1][1]).toEqual({ selected: ['Audit'], other: 'and the docs' });
  });

  it('Enter in the Other text adds a line and mod+Enter there sends', async () => {
    const onSubmit = renderPanel();
    await userEvent.type(screen.getAllByPlaceholderText(/Other…/)[0]!, 'first{Enter}second');
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit.mock.calls[0]?.[1][0]).toEqual({ selected: [], other: 'first\nsecond' });
  });

  it('None of these drops the single choice, so the Other text is the whole answer', async () => {
    const onSubmit = renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'None of these' }));
    const send = screen.getByRole('button', { name: /Answer & continue/ });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getAllByPlaceholderText(/Other…/)[0]!, 'neither, ask the author');
    await userEvent.click(send);
    expect(onSubmit.mock.calls[0]?.[1][0]).toEqual({ selected: [], other: 'neither, ask the author' });
  });

  it('picking the chosen single option again drops it', async () => {
    const onSubmit = renderPanel();
    await userEvent.keyboard('1');
    expect(screen.getByRole('button', { name: /Answer & continue/ })).toBeDisabled();
    await userEvent.keyboard('2');
    await userEvent.click(screen.getByRole('button', { name: /Answer & continue/ }));
    expect(onSubmit.mock.calls[0]?.[1][0]).toEqual({ selected: ['Nit'] });
  });

  it('dismisses the questions only after the user confirms', async () => {
    const onDismiss = vi.fn();
    const onSubmit = renderPanel(vi.fn(), onDismiss);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss questions' }));
    expect(await screen.findByText('Dismiss the questions?')).toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dismiss questions' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not dismiss when the user cancels the confirmation', async () => {
    const onDismiss = vi.fn();
    renderPanel(vi.fn(), onDismiss);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss questions' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Dismiss the questions?')).not.toBeInTheDocument());
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('offers the dismissal also when the question changed', async () => {
    const onDismiss = vi.fn();
    const view = render(
      <MantineProvider>
        <ModalsProvider>
          <QuestionPanel
            questions={questions}
            submitting={false}
            onSubmit={vi.fn()}
            onDismiss={onDismiss}
            dismissing={false}
          />
        </ModalsProvider>
      </MantineProvider>,
    );
    view.rerender(
      <MantineProvider>
        <ModalsProvider>
          <QuestionPanel
            questions={questions.slice(0, 1)}
            submitting={false}
            onSubmit={vi.fn()}
            onDismiss={onDismiss}
            dismissing={false}
          />
        </ModalsProvider>
      </MantineProvider>,
    );
    expect(screen.getByText('The question changed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss questions' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Dismiss questions' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });
});
