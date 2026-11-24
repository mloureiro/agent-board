import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppLayout } from './AppLayout';

vi.mock('./crypto/KeyContext', () => ({ useLock: () => undefined }));
vi.mock('./auth/useSignOut', () => ({ useSignOut: () => null }));
vi.mock('./components/useDesktopNotifications', () => ({ useDesktopNotifications: () => undefined }));
vi.mock('./lib/trpc', () => ({
  useTRPC: () => ({
    tasks: { create: { mutationOptions: () => ({ mutationFn: async () => ({ id: 'new1' }) }) } },
    schedules: { list: { queryOptions: () => ({ queryKey: ['schedules.list'], queryFn: async () => [] }) } },
    machines: {
      list: { queryOptions: () => ({ queryKey: ['machines.list'], queryFn: async () => [] }) },
      catalogs: { queryOptions: () => ({ queryKey: ['machines.catalogs'], queryFn: async () => [] }) },
    },
  }),
  errorMessage: String,
}));
vi.mock('./components/MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Prompt" value={value} onChange={(event) => onChange(event.currentTarget.value)} />
  ),
}));

const user = userEvent.setup({ delay: null });

describe('AppLayout New task', () => {
  it('keeps the prompt typed in the form while moving to another page and back', async () => {
    render(
      <MemoryRouter initialEntries={['/one']}>
        <MantineProvider>
          <QueryClientProvider client={new QueryClient()}>
            <Routes>
              <Route element={<AppLayout />}>
                <Route path="one" element={<Link to="/two">go two</Link>} />
                <Route path="two" element={<Link to="/one">go one</Link>} />
              </Route>
            </Routes>
          </QueryClientProvider>
        </MantineProvider>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: 'half a task' } });
    await user.keyboard('{Escape}');
    await user.click(screen.getByText('go two'));
    await user.click(screen.getByText('go one'));
    await user.click(screen.getByRole('button', { name: 'New task' }));
    expect(await screen.findByLabelText('Prompt')).toHaveValue('half a task');
  });
});
