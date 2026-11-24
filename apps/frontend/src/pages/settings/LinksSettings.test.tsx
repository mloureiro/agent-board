import { deriveKeys, generateDataKey, sealLinkRules, type Keys, type LinkRule } from '@agent-board/shared';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealerFor } from '@agent-board/shared/ui';
import { openBoardLinks } from '@agent-board/shared/ui';
import { LinksSettings } from './LinksSettings';

const wire = vi.hoisted(() => ({ current: null as unknown }));
const keys = vi.hoisted(() => ({ current: null as unknown }));
const set = vi.hoisted(() => vi.fn(async (_: unknown) => null));

vi.mock('../../lib/trpc', () => ({
  POLL_MS: 5000,
  errorMessage: String,
  useTRPC: () => ({
    links: {
      get: {
        queryOptions: () => ({
          queryKey: ['links', 'get'],
          queryFn: () => openBoardLinks(keys.current as Keys, wire.current as never),
        }),
      },
      set: { mutationOptions: () => ({ mutationKey: ['links', 'set'], mutationFn: set }) },
    },
  }),
}));

const STORY: LinkRule = { pattern: 'sc-(\\d+)', url: 'https://app.shortcut.com/acme/story/$1' };

function renderPage() {
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <LinksSettings />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

async function store(version: number, rules: LinkRule[]) {
  wire.current = {
    version,
    document: await sealLinkRules(sealerFor(keys.current as Keys), { version, rules }),
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

describe('LinksSettings', () => {
  it('shows the saved rules and links the try-it text with them', async () => {
    await store(2, [STORY]);
    renderPage();
    expect(await screen.findByLabelText('Pattern of rule 1')).toHaveValue('sc-(\\d+)');
    expect(screen.getByLabelText('URL of rule 1')).toHaveValue(STORY.url);
    expect(screen.getByText(/Version 2, saved/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'sc-72195' })).toHaveAttribute(
      'href',
      'https://app.shortcut.com/acme/story/72195',
    );
  });

  it('starts empty before any save, and saves a first rule over version 0', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('No rules yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    await user.type(screen.getByLabelText('Pattern of rule 1'), 'PR#(\\d+)');
    await user.type(screen.getByLabelText('URL of rule 1'), 'https://github.com/acme/app/pull/$1');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]?.[0]).toEqual({
      rules: [{ pattern: 'PR#(\\d+)', url: 'https://github.com/acme/app/pull/$1' }],
      expectedVersion: 0,
    });
  });

  it('saves a change against the version it loaded', async () => {
    const user = userEvent.setup();
    await store(3, [STORY]);
    renderPage();
    await user.clear(await screen.findByLabelText('URL of rule 1'));
    await user.type(screen.getByLabelText('URL of rule 1'), 'https://app.shortcut.com/acme/s/$1');
    await user.click(screen.getByLabelText('Ignore case'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]?.[0]).toEqual({
      rules: [{ pattern: STORY.pattern, url: 'https://app.shortcut.com/acme/s/$1', flags: 'i' }],
      expectedVersion: 3,
    });
  });

  it('removes a rule', async () => {
    const user = userEvent.setup();
    await store(1, [STORY, { pattern: 'PR#(\\d+)', url: 'https://github.com/acme/app/pull/$1' }]);
    renderPage();
    await user.click(await screen.findByLabelText('Remove rule 1'));
    expect(screen.getByLabelText('Pattern of rule 1')).toHaveValue('PR#(\\d+)');
    expect(screen.queryByLabelText('Pattern of rule 2')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]?.[0]).toMatchObject({ rules: [{ pattern: 'PR#(\\d+)' }], expectedVersion: 1 });
  });

  it('says what is wrong with a pattern or URL and does not save it', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    await user.type(screen.getByLabelText('Pattern of rule 1'), '(');
    await user.type(screen.getByLabelText('URL of rule 1'), 'javascript:alert(1)');
    expect(screen.getByText('The pattern is not a valid regular expression.')).toBeInTheDocument();
    expect(screen.getByText('The URL must start with https:// or http://.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('asks to reload when the board holds a newer version', async () => {
    const user = userEvent.setup();
    await store(1, [STORY]);
    set.mockImplementation(async () => {
      throw new TRPCClientError('conflict', { result: { error: { data: { code: 'CONFLICT' } } } } as never);
    });
    renderPage();
    await user.type(await screen.findByLabelText('Pattern of rule 1'), 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Reload the page/)).toBeInTheDocument();
  });

  it('saves against the version the edits started from, even after the query moved on', async () => {
    const user = userEvent.setup();
    await store(1, [STORY]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MantineProvider>
        <QueryClientProvider client={client}>
          <LinksSettings />
        </QueryClientProvider>
      </MantineProvider>,
    );
    await user.type(await screen.findByLabelText('Pattern of rule 1'), 'x');
    // Another tab saved version 2, and this one refetched.
    await store(2, [STORY, { pattern: 'PR#(\\d+)', url: 'https://github.com/acme/app/pull/$1' }]);
    await client.invalidateQueries({ queryKey: ['links', 'get'] });
    await waitFor(() => expect(client.getQueryData<{ version: number }>(['links', 'get'])?.version).toBe(2));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]?.[0]).toMatchObject({ expectedVersion: 1 });
  });

  it('says when the saved rules cannot be read, and replaces them on save', async () => {
    const user = userEvent.setup();
    wire.current = { version: 4, document: 'abe1.' + 'A'.repeat(60), updatedAt: '2026-02-01T10:00:00.000Z' };
    renderPage();
    expect(await screen.findByText(/cannot be read with your key/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    await user.type(screen.getByLabelText('Pattern of rule 1'), 'a');
    await user.type(screen.getByLabelText('URL of rule 1'), 'https://acme.test/$&');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]?.[0]).toMatchObject({ expectedVersion: 4 });
  });

  it('can save an empty list over rules that cannot be read', async () => {
    const user = userEvent.setup();
    wire.current = { version: 4, document: 'abe1.' + 'A'.repeat(60), updatedAt: '2026-02-01T10:00:00.000Z' };
    renderPage();
    await screen.findByText(/cannot be read with your key/);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]?.[0]).toEqual({ rules: [], expectedVersion: 4 });
  });
});
