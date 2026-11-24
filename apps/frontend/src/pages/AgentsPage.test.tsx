import { agentHash, deriveKeys, generateDataKey, sealSharedAgents, type Keys } from '@agent-board/shared';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealerFor } from '@agent-board/shared/ui';
import { openBoardAgents, type OpenedCatalog } from '@agent-board/shared/ui';
import { AgentsPage } from './AgentsPage';

const wire = vi.hoisted(() => ({ current: null as unknown }));
const catalogs = vi.hoisted(() => ({ current: [] as unknown[] }));
const keys = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../lib/trpc', () => ({
  POLL_MS: 5000,
  errorMessage: String,
  useTRPC: () => ({
    agents: {
      shared: {
        queryOptions: () => ({
          queryKey: ['agents', 'shared'],
          queryFn: () => openBoardAgents(keys.current as Keys, wire.current as never),
        }),
      },
    },
    machines: {
      catalogs: { queryOptions: () => ({ queryKey: ['catalogs'], queryFn: async () => catalogs.current }) },
    },
  }),
}));

const REVIEWER = {
  description: 'Reviews pull requests',
  tools: ['Read', 'Grep'],
  allowedTools: ['Read', 'Bash(curl *)'],
  disallowedTools: [],
  env: ['GITHUB_TOKEN', 'REGION'],
  prompt: 'You review.',
};
const WRITER = {
  description: 'Writes docs',
  tools: ['Edit'],
  allowedTools: ['Edit(docs/**)'],
  disallowedTools: ['Bash'],
};

function renderPage() {
  render(
    <MemoryRouter>
      <MantineProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <AgentsPage />
        </QueryClientProvider>
      </MantineProvider>
    </MemoryRouter>,
  );
}

const catalog = (agents?: { version: number | null; hashes: Record<string, string>; replaced: string[] }) => ({
  models: [],
  skills: [],
  dirs: {},
  ...(agents === undefined ? {} : { agents }),
});

let reviewerHash: string;

beforeAll(async () => {
  keys.current = await deriveKeys(generateDataKey(), 'jascha');
  reviewerHash = await agentHash(REVIEWER);
});

beforeEach(async () => {
  const document = await sealSharedAgents(sealerFor(keys.current as Keys), {
    version: 3,
    agents: { reviewer: REVIEWER, writer: WRITER },
  });
  wire.current = { version: 3, document, pushedAt: new Date(Date.now() - 60_000).toISOString() };
  catalogs.current = [
    { name: 'laptop', catalog: catalog({ version: 3, hashes: { reviewer: reviewerHash }, replaced: ['reviewer'] }) },
    { name: 'desktop', catalog: catalog({ version: 2, hashes: { reviewer: 'c'.repeat(64) }, replaced: [] }) },
    { name: 'old', catalog: catalog() },
  ] satisfies OpenedCatalog[];
});

describe('AgentsPage', () => {
  it('shows each definition with its grants and the flags the CLI prints, and nothing to change it with', async () => {
    renderPage();
    const reviewer = (await screen.findByRole('heading', { name: 'reviewer' })).closest('.mantine-Paper-root');
    expect(reviewer).not.toBeNull();
    const card = within(reviewer as HTMLElement);
    expect(card.getByText('Reviews pull requests')).toBeInTheDocument();
    expect(card.getByText('allow rule Bash(curl *): runs curl, which can run or reach anything')).toBeInTheDocument();
    expect(card.getByText('allow rule Read: reads every file the deny list does not name')).toBeInTheDocument();
    expect(card.getByText(/the deny list is empty/)).toBeInTheDocument();
    expect(card.getByText('env GITHUB_TOKEN looks like a secret: the run gets its value')).toBeInTheDocument();
    expect(card.getByText('allowedTools has rules for Bash, which tools leaves out')).toBeInTheDocument();
    expect(card.queryByText(/env REGION/)).toBeNull();
    expect(card.getByText('You review.')).toBeInTheDocument();
    expect(screen.getByText(/Version 3, pushed .*2 agents/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /push|edit|save|remove|delete/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows which machines run which version and hash, and which replaced a local definition', async () => {
    renderPage();
    const reviewer = within(
      (await screen.findByRole('heading', { name: 'reviewer' })).closest('.mantine-Paper-root') as HTMLElement,
    );
    const row = (machine: string) => within(reviewer.getByText(machine).closest('tr') as HTMLElement);
    expect(row('laptop').getByText('runs this definition')).toBeInTheDocument();
    expect(row('laptop').getByText('replaced a local definition')).toBeInTheDocument();
    expect(row('laptop').getByText(reviewerHash.slice(0, 12))).toBeInTheDocument();
    expect(row('desktop').getByText('runs another definition')).toBeInTheDocument();
    expect(row('desktop').getByText('c'.repeat(12))).toBeInTheDocument();
    expect(row('old').getByText(/does not report its agents/)).toBeInTheDocument();

    const versions = within(
      screen.getByRole('heading', { name: 'Machines' }).closest('.mantine-Paper-root') as HTMLElement,
    );
    expect(within(versions.getByText('laptop').closest('tr') as HTMLElement).getByText('v3')).toBeInTheDocument();
    expect(within(versions.getByText('laptop').closest('tr') as HTMLElement).getByText('reviewer')).toBeInTheDocument();
    expect(
      within(versions.getByText('desktop').closest('tr') as HTMLElement).getByText('v2, behind'),
    ).toBeInTheDocument();
    expect(
      within(versions.getByText('old').closest('tr') as HTMLElement).getByText('not reported'),
    ).toBeInTheDocument();

    const writer = within(
      screen.getByRole('heading', { name: 'writer' }).closest('.mantine-Paper-root') as HTMLElement,
    );
    expect(
      within(writer.getByText('laptop').closest('tr') as HTMLElement).getByText('does not have it'),
    ).toBeInTheDocument();
  });

  it('says so when no agent was pushed', async () => {
    wire.current = null;
    renderPage();
    expect(await screen.findByText('No agent is on the board yet.')).toBeInTheDocument();
  });

  it('says so when the document does not open under its version', async () => {
    wire.current = { ...(wire.current as object), version: 4 };
    renderPage();
    expect(await screen.findByText(/do not open under this version/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'reviewer' })).toBeNull();
  });
});
