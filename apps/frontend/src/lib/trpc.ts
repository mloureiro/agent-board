import type { AppRouter } from '@agent-board/backend/router';
import { notifications } from '@mantine/notifications';
import { MutationCache, QueryCache, QueryClient, type QueryKey } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client';
import { useMemo } from 'react';
import { useKeys } from '../crypto/KeyContext';
import { createPlainTRPC, type PlainTRPC } from './plainTrpc';
import { uiGuardLink } from './uiGuard';
import { useRawTRPC, useRawTRPCClient } from './rawTrpc';
import { isUnauthorized } from './unauthorized';

export type {
  BoardTask,
  LastNote,
  ListedTask,
  OpenedSchedule as Schedule,
  TaskDetail,
  ThreadNote,
} from '@agent-board/shared/ui';
export type { RouterInputs, RouterOutputs } from './wire';
export { TRPCProvider, useRawTRPC, useRawTRPCClient } from './rawTrpc';

/** The board's tRPC with plaintext in and out: what it fetches is opened and what it sends is sealed with the unlocked keys. */
export function useTRPC(): PlainTRPC {
  const raw = useRawTRPC();
  const client = useRawTRPCClient();
  const keys = useKeys();
  return useMemo(() => createPlainTRPC(raw, client, keys), [raw, client, keys]);
}

export const errorMessage = (err: unknown): string => {
  if (err instanceof TRPCClientError) {
    const issues = (err.data as { zodIssues?: { message: string }[] } | undefined)?.zodIssues;
    if (issues?.length) return issues.map((i) => i.message).join(', ');
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
};

/** Workers change the board from elsewhere, so open views poll. */
export const POLL_MS = 5_000;

const isMeQuery = (queryKey: QueryKey): boolean => {
  const path = queryKey[0];
  return Array.isArray(path) && path[0] === 'me';
};

export function createClients() {
  // A session that ends while the app is open: whatever call finds out asks `me` again, which sends the app to the sign-in
  // page. `me` itself is left out, or its own refusal would ask again forever.
  const sessionEnded = (error: unknown): void => {
    if (isUnauthorized(error))
      void queryClient.invalidateQueries({ predicate: (query) => isMeQuery(query.queryKey) }, { cancelRefetch: false });
  };
  const queryClient: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 2_000,
        refetchOnWindowFocus: true,
        retry: (failures, error) => failures < 1 && !isUnauthorized(error),
      },
    },
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (!isMeQuery(query.queryKey)) sessionEnded(error);
      },
    }),
    // Every write may change the board, the task page and the cards' last note, so refetch what is on screen. Not awaited:
    // a returned promise holds every mutation's own onSuccess until all active queries have refetched.
    mutationCache: new MutationCache({
      onSuccess: () => void queryClient.invalidateQueries(),
      onError: (err) => {
        if (isUnauthorized(err)) sessionEnded(err);
        else notifications.show({ color: 'red', title: 'Failed', message: errorMessage(err) });
      },
    }),
  });
  const trpcClient = createTRPCClient<AppRouter>({
    links: [uiGuardLink, httpBatchLink({ url: '/trpc' })],
  });
  return { queryClient, trpcClient };
}
