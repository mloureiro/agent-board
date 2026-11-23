import { deriveKeys, generateDataKey, sealTitleRules, type Keys, type TitleRule } from '@agent-board/shared';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealerFor } from '../../lib/contexts';
import { openBoardTitleRules } from '../../lib/opening';
import { TitlesSettings } from './TitlesSettings';

const wire = vi.hoisted(() => ({ current: null as unknown }));
const keys = vi.hoisted(() => ({ current: null as unknown }));
const set = vi.hoisted(() => vi.fn(async (_: unknown) => null));

vi.mock('../../lib/trpc', () => ({
  POLL_MS: 5000,
  errorMessage: String,
  useTRPC: () => ({
    titleRules: {
      get: {
        queryOptions: () => ({
          queryKey: ['titleRules', 'get'],
          queryFn: () => openBoardTitleRules(keys.current as Keys, wire.current as never),
        }),
      },
      set: { mutationOptions: () => ({ mutationKey: ['titleRules', 'set'], mutationFn: set }) },
    },
  }),
}));

const REVIEW: TitleRule = { pattern: '^/pj-acme:review\\b', icon: '🔎', instruction: 'The PR number and its title.' };
const ANY_PR: TitleRule = { pattern: 'pull/\\d+', icon: '🔀' };

function renderPage() {
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TitlesSettings />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

async function store(version: number, rules: TitleRule[]) {
  wire.current = {
    version,
    document: await sealTitleRules(sealerFor(keys.current as Keys), { version, rules }),
    updatedAt: '2026-02-01T10:00:00.000Z',
  };
}

beforeAll(async () => {
  keys.current = await deriveKeys(generateDataKey(), 'jascha');
});

beforeEach(() => {
  wire.current = null;
  set.mockClear();
  set.mockImplementation(async () => null);
});

describe('TitlesSettings', () => {
  it('shows the saved rules and the version', async () => {
    await store(2, [REVIEW]);
    renderPage();
    expect(await screen.findByLabelText('Pattern of rule 1')).toHaveValue(REVIEW.pattern);
    expect(screen.getByLabelText('Title instruction of rule 1')).toHaveValue(REVIEW.instruction);
    expect(screen.getByLabelText(/^Icon of rule 1/)).toHaveTextContent('🔎');
    expect(screen.getByText(/Version 2, saved/)).toBeInTheDocument();
  });

  it('says what is wrong with a row and keeps Save off until it works', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    expect(screen.queryByText(/neither/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Pattern of rule 1'), '(');
    expect(screen.getByText('The pattern is not a valid regular expression.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Pattern of rule 1'));
    await user.type(screen.getByLabelText('Pattern of rule 1'), 'pull/\\d+');
    expect(screen.getByText('The rule sets neither an icon nor a title.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(screen.getByLabelText('Title instruction of rule 1'), '   ');
    expect(screen.getByText('The title instruction is empty.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Title instruction of rule 1'));
    await user.type(screen.getByLabelText('Title instruction of rule 1'), 'The PR title.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('saves a sealed document over the version it loaded', async () => {
    const user = userEvent.setup();
    await store(3, [REVIEW]);
    renderPage();
    await user.click(await screen.findByLabelText('Ignore case in rule 1'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]?.[0]).toEqual({ rules: [{ ...REVIEW, flags: 'i' }], expectedVersion: 3 });
  });

  it('removes a rule and saves the rest', async () => {
    const user = userEvent.setup();
    await store(1, [REVIEW, ANY_PR]);
    renderPage();
    await user.click(await screen.findByLabelText('Remove rule 1'));
    expect(screen.getByLabelText('Pattern of rule 1')).toHaveValue(ANY_PR.pattern);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]?.[0]).toEqual({ rules: [ANY_PR], expectedVersion: 1 });
  });

  it('asks to reload when the board holds a newer version', async () => {
    const user = userEvent.setup();
    await store(1, [REVIEW]);
    set.mockImplementation(async () => {
      throw new TRPCClientError('conflict', { result: { error: { data: { code: 'CONFLICT' } } } } as never);
    });
    renderPage();
    await user.type(await screen.findByLabelText('Pattern of rule 1'), 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Reload the page/)).toBeInTheDocument();
  });

  it('says when the saved rules cannot be read, and replaces them on save', async () => {
    const user = userEvent.setup();
    wire.current = { version: 4, document: 'abe1.' + 'A'.repeat(60), updatedAt: '2026-02-01T10:00:00.000Z' };
    renderPage();
    expect(await screen.findByText(/cannot be read with your key/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]?.[0]).toEqual({ rules: [], expectedVersion: 4 });
  });

  describe('Try it', () => {
    it('names the first matching rule, then the one the sample reaches, then none', async () => {
      const user = userEvent.setup();
      await store(1, [REVIEW, ANY_PR]);
      renderPage();
      expect(
        await screen.findByText('Rule 1 matches: icon 🔎, Haiku writes the title from its instruction.'),
      ).toBeInTheDocument();
      const sample = screen.getByLabelText('Try it');
      await user.clear(sample);
      await user.type(sample, 'merge https://github.com/acme/app/pull/8');
      expect(screen.getByText('Rule 2 matches: icon 🔀, no title instruction.')).toBeInTheDocument();
      await user.clear(sample);
      await user.type(sample, 'hello');
      expect(screen.getByText('No rule matches: the task keeps its title and icon.')).toBeInTheDocument();
    });

    it('applies the rules as drafted and skips a rule that does not work', async () => {
      const user = userEvent.setup();
      await store(1, [ANY_PR]);
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Add rule' }));
      await user.type(screen.getByLabelText('Pattern of rule 2'), 'review');
      expect(screen.getByText('Rule 1 matches: icon 🔀, no title instruction.')).toBeInTheDocument();
      await user.type(screen.getByLabelText('Title instruction of rule 2'), 'Title it.');
      await user.click(screen.getByLabelText('Remove rule 1'));
      expect(
        screen.getByText('Rule 1 matches: no icon, Haiku writes the title from its instruction.'),
      ).toBeInTheDocument();
    });
  });
});
