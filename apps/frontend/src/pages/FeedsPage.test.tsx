import { deriveKeys, generateDataKey, sealMachineFeeds, type Keys, type MachineFeed } from '@agent-board/shared';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sealerFor } from '../lib/contexts';
import { openFeeds } from '../lib/opening';
import { FeedsPage } from './FeedsPage';

const keys = vi.hoisted(() => ({ current: null as unknown }));
const wire = vi.hoisted(() => ({ current: [] as unknown[] }));
const request = vi.hoisted(() => vi.fn(async (_: unknown) => null));

vi.mock('../lib/trpc', () => ({
  POLL_MS: 5000,
  errorMessage: String,
  useTRPC: () => ({
    feeds: {
      list: {
        queryOptions: () => ({
          queryKey: ['feeds', 'list'],
          queryFn: () => openFeeds(keys.current as Keys, wire.current as never),
        }),
      },
      request: { mutationOptions: () => ({ mutationFn: request }) },
    },
    tasks: {
      list: {
        queryOptions: () => ({
          queryKey: ['tasks', 'list'],
          queryFn: async () => [{ id: 'task0001', title: 'Review PR 17' }],
        }),
      },
    },
  }),
}));

const NOW = Date.now();
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

const FEED: MachineFeed = {
  id: '0123456789abcdef',
  name: 'reviews',
  integration: 'mloureiro:github',
  action: 'list-pull-requests',
  everyMs: 600_000,
  paused: true,
  runAsked: false,
  last: {
    startedAt: iso(60_000),
    at: iso(55_000),
    ok: true,
    listed: 2,
    created: 1,
    requeued: 0,
    rescheduled: 0,
    closed: 0,
    failed: 0,
    tasks: [{ id: 'task0001', outcome: 'created' }],
  },
  history: [],
};

beforeAll(async () => {
  keys.current = await deriveKeys(generateDataKey(), 'jascha');
  wire.current = [
    {
      name: 'laptop',
      feeds: await sealMachineFeeds(sealerFor(keys.current as Keys), 'laptop', { feeds: [FEED] }),
      feedsUpdatedAt: iso(30_000),
      feedRequests: [],
      lastSeenAt: iso(20_000),
    },
  ];
});

describe('Settings › Feeds', () => {
  it('lets a paused feed run once, and links the last run’s task by its title', async () => {
    render(
      <MemoryRouter>
        <MantineProvider>
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <FeedsPage />
          </QueryClientProvider>
        </MantineProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    expect(screen.getByText(/last seen/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request.mock.calls[0]?.[0]).toEqual({ machine: 'laptop', action: 'run', id: FEED.id });

    await userEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(await screen.findByRole('link', { name: 'Review PR 17' })).toHaveAttribute('href', '/t/task0001');
  });
});
