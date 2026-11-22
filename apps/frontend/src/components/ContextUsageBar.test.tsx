import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextUsageBar } from './ContextUsageBar';

const fetchContext = vi.hoisted(() => vi.fn());

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({
    transcript: {
      context: {
        queryOptions: ({ id }: { id: string }) => ({ queryKey: ['transcript.context', id], queryFn: fetchContext }),
      },
    },
  }),
}));

const reading = {
  used: 133_600,
  window: 1_000_000,
  threshold: null,
  model: 'claude-opus',
  at: new Date().toISOString(),
};

function renderBar(live = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (isLive: boolean) => (
    <MantineProvider>
      <QueryClientProvider client={client}>
        <ContextUsageBar taskId="task1" live={isLive} />
      </QueryClientProvider>
    </MantineProvider>
  );
  const view = render(ui(live));
  return { rerender: (isLive: boolean) => view.rerender(ui(isLive)) };
}

beforeEach(() => {
  fetchContext.mockReset();
});

describe('ContextUsageBar', () => {
  it('renders nothing while loading and when the run has no reading', async () => {
    fetchContext.mockResolvedValue(null);
    renderBar();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    await vi.waitFor(() => expect(fetchContext).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(/used/)).not.toBeInTheDocument();
  });

  it('says so when the reading cannot be opened', async () => {
    fetchContext.mockResolvedValue('unreadable');
    renderBar();
    expect(await screen.findByText('context reading unreadable')).toBeInTheDocument();
  });

  it('shows the percentage, the figures and the fill of a known window, without a marker', async () => {
    fetchContext.mockResolvedValue(reading);
    renderBar();
    expect(await screen.findByText('13% used · 133.6K / 1M')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '13');
    expect(screen.queryByTitle(/Auto-compact/)).not.toBeInTheDocument();
  });

  it('draws the auto-compact marker only when the run set a threshold', async () => {
    fetchContext.mockResolvedValue({ ...reading, threshold: 80 });
    renderBar();
    expect(await screen.findByTitle('Auto-compact at 80%')).toBeInTheDocument();
  });

  it('shows the used tokens alone when the window is unknown', async () => {
    fetchContext.mockResolvedValue({ ...reading, window: null });
    renderBar();
    expect(await screen.findByText('133.6K used')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('fetches once more when the run ends', async () => {
    fetchContext.mockResolvedValue(reading);
    const bar = renderBar(true);
    await screen.findByText('13% used · 133.6K / 1M');
    expect(fetchContext).toHaveBeenCalledTimes(1);
    bar.rerender(false);
    await vi.waitFor(() => expect(fetchContext).toHaveBeenCalledTimes(2));
  });
});
