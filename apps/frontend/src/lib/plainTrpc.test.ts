import { noteBinding, sealFields, type Keys } from '@agent-board/shared';
import { openAs, sealerFor } from '@agent-board/shared/ui';
import type { AppRouter } from '@agent-board/backend/router';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { observable } from '@trpc/server/observable';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeySetup } from '../crypto/unlocker';
import { createPlainTRPC } from './plainTrpc';

const FAST = { m: 8192, t: 1, p: 1 };
const NOW = '2026-11-14T12:00:00.000Z';

type Handler = (path: string, input: unknown) => unknown;

let keys: Keys;
let handle: ReturnType<typeof vi.fn<Handler>>;
let calls: { path: string; input: unknown }[];
let queryClient: QueryClient;

function plain(withKeys: Keys | null = keys) {
  const link: TRPCLink<AppRouter> = () => {
    return ({ op }) =>
      observable((observer) => {
        calls.push({ path: op.path, input: op.input });
        Promise.resolve()
          .then(() => handle(op.path, op.input))
          .then(
            (data) => {
              observer.next({ result: { data } });
              observer.complete();
            },
            (error: Error) => observer.error(TRPCClientError.from(error)),
          );
      });
  };
  const client = createTRPCClient<AppRouter>({ links: [link] });
  const raw = createTRPCOptionsProxy<AppRouter>({ client, queryClient });
  return { trpc: createPlainTRPC(raw, client, withKeys), raw };
}

const mutate = <V, R>(options: { mutationFn?: unknown }, variables: V): Promise<R> =>
  new MutationObserver<R, Error, V>(queryClient, options as never).mutate(variables);

const wireTask = async (overrides: Record<string, unknown> = {}) => {
  const id = String(overrides['id'] ?? 'task1');
  const { title, input } = await sealFields(
    sealerFor(keys),
    { kind: 'task', id, createdBy: 'user', scheduleId: null, forkOf: null },
    { title: 'Review the PR', input: '/review-pr 17741\n\nplease' },
  );
  return {
    id,
    title,
    input,
    workdir: null,
    status: 'todo',
    priority: 'normal',
    closed: false,
    machine: null,
    sessionId: null,
    next: 'fresh',
    head: null,
    openQuestion: false,
    createdBy: 'user',
    lane: null,
    requestedLane: null,
    effort: null,
    borrowed: false,
    lastActiveAt: null,
    runStartedAt: null,
    paused: false,
    notBefore: null,
    scheduleId: null,
    wakeAt: null,
    waitCheck: false,
    woken: false,
    proposed: false,
    parentId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
};

beforeAll(async () => {
  keys = (await createKeySetup({ owner: 'jascha', passphrase: 'correct horse battery staple', kdf: FAST })).keys;
});

beforeEach(() => {
  calls = [];
  handle = vi.fn<Handler>();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe('the TanStack options over the board', () => {
  it('keys a query as the raw procedure and opens what it fetches', async () => {
    handle.mockResolvedValue([{ ...(await wireTask()), lastNote: null, context: null }]);
    const { trpc, raw } = plain();
    const options = trpc.tasks.list.queryOptions({ closed: true });
    expect(options.queryKey).toEqual(raw.tasks.list.queryKey({ closed: true }));
    const [task] = await queryClient.fetchQuery(options);
    expect(task).toMatchObject({ id: 'task1', title: 'Review the PR' });
    expect(calls).toEqual([{ path: 'tasks.list', input: { closed: true } }]);
  });

  it('keys a mutation as the raw procedure, seals what it sends and opens what it returns', async () => {
    handle.mockResolvedValue(await wireTask());
    const { trpc, raw } = plain();
    const options = trpc.tasks.reply.mutationOptions();
    expect(options.mutationKey).toEqual(raw.tasks.reply.mutationKey());
    const replied = await mutate<{ id: string; message: string; resume: boolean }, { title: string }>(options, {
      id: 'task1',
      message: 'secret',
      resume: false,
    });
    expect(replied.title).toBe('Review the PR');
    const sent = calls[0]?.input as { message: { body: string } };
    expect(await openAs(keys, noteBinding('note.body', 'task1', 'user', 'comment'), sent.message.body)).toBe('secret');
  });

  it('keeps unchanged tasks the same objects between polls', async () => {
    handle.mockImplementation(async () => [{ ...(await wireTask()), lastNote: null, context: null }]);
    const { trpc } = plain();
    const { queryKey } = trpc.tasks.list.queryOptions();
    await queryClient.fetchQuery({ ...trpc.tasks.list.queryOptions(), staleTime: 0 });
    const first = queryClient.getQueryData(queryKey);
    await queryClient.fetchQuery({ ...trpc.tasks.list.queryOptions(), staleTime: 0 });
    expect(queryClient.getQueryData(queryKey)?.[0]).toBe(first?.[0]);
  });

  it('keys a run’s events and a tool’s output by the run alone, and never refetches an output', async () => {
    const { trpc, raw } = plain();
    expect(trpc.transcript.events.queryKey({ taskId: 'task1', runId: 'run1' })).toEqual(
      raw.transcript.events.queryKey({ runId: 'run1' }),
    );
    const output = trpc.transcript.output.queryOptions({ taskId: 'task1', runId: 'run1', seq: 2 });
    expect(output.queryKey).toEqual(raw.transcript.output.queryKey({ runId: 'run1', seq: 2 }));
    expect(output.staleTime).toBe('static');
  });

  it('fails a sealed query and a sealed mutation while locked, and sends nothing', async () => {
    const { trpc } = plain(null);
    await expect(queryClient.fetchQuery(trpc.tasks.list.queryOptions())).rejects.toThrow('The board is locked.');
    await expect(
      mutate(trpc.tasks.reply.mutationOptions(), { id: 'task1', message: 'x', resume: false }),
    ).rejects.toThrow('The board is locked.');
    expect(calls).toEqual([]);
  });
});
