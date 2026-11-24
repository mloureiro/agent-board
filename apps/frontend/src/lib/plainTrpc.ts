import type { AppRouter } from '@agent-board/backend/router';
import type { Keys, TranscriptEventView } from '@agent-board/shared';
import {
  createPlainBoard,
  type AnswerVariables,
  type ApplyVariables,
  type BoardTransport,
  type ConfigureVariables,
  type EditVariables,
  type ForkVariables,
  type MoveVariables,
  type NewTask,
  type ReplyVariables,
  type SendVariables,
  type SetLinksVariables,
  type SetTitleRulesVariables,
  type StopVariables,
  type UpdateScheduleVariables,
} from '@agent-board/shared/ui';
import { mutationOptions, queryOptions, type QueryKey } from '@tanstack/react-query';
import type { TRPCClient } from '@trpc/client';
import type { useRawTRPC } from './rawTrpc';

export type RawTRPC = ReturnType<typeof useRawTRPC>;
export type RawClient = TRPCClient<AppRouter>;

interface Procedure {
  query(input: unknown, options?: { signal?: AbortSignal | undefined }): Promise<unknown>;
  mutate(input: unknown): Promise<unknown>;
}

/** The board's tRPC client as a `BoardTransport`: a dotted procedure path is the path of the call on the client. */
export function trpcTransport(client: RawClient): BoardTransport {
  // The procedure is found by its runtime path, which the client's types cannot follow from a string.
  const procedure = (path: string): Procedure =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], client) as Procedure;
  return {
    query: (path, input, signal) => procedure(path).query(input, { signal }) as never,
    mutate: (path, input) => procedure(path).mutate(input) as never,
  };
}

// The raw keys carry the wire type of their data; the plaintext facade keeps the keys and changes what the data is.
const plainKey = (key: QueryKey): QueryKey => [...key];

/**
 * The board's tRPC with plaintext in and out, as TanStack Query options over a `PlainBoard`. Procedures that carry nothing
 * sealed are the raw ones. The query keys are the raw ones too, so the cache and its invalidation work as they would without
 * encryption.
 */
export function createPlainTRPC(raw: RawTRPC, client: RawClient, keys: Keys | null) {
  const board = createPlainBoard(trpcTransport(client), keys);
  return {
    me: {
      queryKey: raw.me.queryKey,
      queryOptions: () =>
        queryOptions({
          queryKey: plainKey(raw.me.queryKey()),
          queryFn: ({ signal }) => board.me(signal),
        }),
    },
    revision: raw.revision,
    auth: {
      config: raw.auth.config,
    },
    passkeys: {
      list: raw.passkeys.list,
      registerOptions: raw.passkeys.registerOptions,
      register: raw.passkeys.register,
      rename: raw.passkeys.rename,
      remove: raw.passkeys.remove,
    },
    keys: {
      setup: raw.keys.setup,
      replaceSlots: raw.keys.replaceSlots,
      get: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.keys.get.queryKey()),
            queryFn: ({ signal }) => board.keys.get(signal),
          }),
      },
    },
    machines: {
      issue: raw.machines.issue,
      revoke: raw.machines.revoke,
      advertisedCli: raw.machines.advertisedCli,
      list: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.machines.list.queryKey()),
            queryFn: ({ signal }) => board.machines.list(signal),
          }),
      },
      catalogs: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.machines.catalogs.queryKey()),
            queryFn: ({ signal }) => board.machines.catalogs(signal),
          }),
      },
    },
    feeds: {
      request: raw.feeds.request,
      list: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.feeds.list.queryKey()),
            queryFn: ({ signal }) => board.feeds.list(signal),
          }),
      },
    },
    agents: {
      shared: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.agents.shared.queryKey()),
            queryFn: ({ signal }) => board.agents.shared(signal),
          }),
      },
    },
    links: {
      get: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.links.get.queryKey()),
            queryFn: ({ signal }) => board.links.get(signal),
          }),
      },
      set: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.links.set.mutationKey(),
            mutationFn: (variables: SetLinksVariables) => board.links.set(variables),
          }),
      },
    },
    titleRules: {
      get: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.titleRules.get.queryKey()),
            queryFn: ({ signal }) => board.titleRules.get(signal),
          }),
      },
      set: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.titleRules.set.mutationKey(),
            mutationFn: (variables: SetTitleRulesVariables) => board.titleRules.set(variables),
          }),
      },
    },
    tasks: {
      done: raw.tasks.done,
      rerun: raw.tasks.rerun,
      setPriority: raw.tasks.setPriority,
      setNotBefore: raw.tasks.setNotBefore,
      takeBack: raw.tasks.takeBack,
      dismissQuestion: raw.tasks.dismissQuestion,
      wakeNow: raw.tasks.wakeNow,
      setClosed: raw.tasks.setClosed,
      removePr: raw.tasks.removePr,
      stopWatch: raw.tasks.stopWatch,
      move: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.move.mutationKey(),
            mutationFn: (variables: MoveVariables) => board.tasks.move(variables),
          }),
      },
      list: {
        queryOptions: (input?: { closed?: boolean }) =>
          queryOptions({
            queryKey: plainKey(raw.tasks.list.queryKey(input)),
            queryFn: ({ signal }) => board.tasks.list(input, signal),
          }),
      },
      get: {
        queryOptions: (input: { id: string }) =>
          queryOptions({
            queryKey: plainKey(raw.tasks.get.queryKey(input)),
            queryFn: ({ signal }) => board.tasks.get(input, signal),
          }),
      },
      create: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.create.mutationKey(),
            mutationFn: (task: NewTask) => board.tasks.create(task),
          }),
      },
      fork: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.fork.mutationKey(),
            mutationFn: (variables: ForkVariables) => board.tasks.fork(variables),
          }),
      },
      configure: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.configure.mutationKey(),
            mutationFn: (variables: ConfigureVariables) => board.tasks.configure(variables),
          }),
      },
      applyPolish: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.applyPolish.mutationKey(),
            mutationFn: (variables: ApplyVariables) => board.tasks.applyPolish(variables),
          }),
      },
      edit: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.edit.mutationKey(),
            mutationFn: (variables: EditVariables) => board.tasks.edit(variables),
          }),
      },
      reply: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.reply.mutationKey(),
            mutationFn: (variables: ReplyVariables) => board.tasks.reply(variables),
          }),
      },
      send: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.send.mutationKey(),
            mutationFn: (variables: SendVariables) => board.tasks.send(variables),
          }),
      },
      stop: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.stop.mutationKey(),
            mutationFn: (variables: StopVariables) => board.tasks.stop(variables),
          }),
      },
      answer: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.answer.mutationKey(),
            mutationFn: (variables: AnswerVariables) => board.tasks.answer(variables),
          }),
      },
    },
    schedules: {
      remove: raw.schedules.remove,
      list: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.schedules.list.queryKey()),
            queryFn: ({ signal }) => board.schedules.list(signal),
          }),
      },
      update: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.schedules.update.mutationKey(),
            mutationFn: (variables: UpdateScheduleVariables) => board.schedules.update(variables),
          }),
      },
      setPaused: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.schedules.setPaused.mutationKey(),
            mutationFn: (variables: { id: string; paused: boolean }) => board.schedules.setPaused(variables),
          }),
      },
    },
    transcript: {
      runs: {
        queryOptions: (input: { id: string }) =>
          queryOptions({
            queryKey: plainKey(raw.transcript.runs.queryKey(input)),
            queryFn: ({ signal }) => board.transcript.runs(input, signal),
          }),
      },
      context: {
        queryOptions: (input: { id: string }) =>
          queryOptions({
            queryKey: plainKey(raw.transcript.context.queryKey(input)),
            queryFn: ({ signal }) => board.transcript.context(input, signal),
          }),
      },
      events: {
        queryKey: (input: { taskId: string; runId: string }): QueryKey =>
          plainKey(raw.transcript.events.queryKey({ runId: input.runId })),
        // The drawer keeps a run's events in one cache entry and extends it a page at a time, so pages are fetched directly.
        fetchPage: (
          input: { taskId: string; runId: string; afterSeq: number },
          signal?: AbortSignal,
        ): Promise<TranscriptEventView[]> => board.transcript.events(input, signal),
      },
      output: {
        queryOptions: (input: { taskId: string; runId: string; seq: number }) =>
          queryOptions({
            queryKey: plainKey(raw.transcript.output.queryKey({ runId: input.runId, seq: input.seq })),
            queryFn: ({ signal }) => board.transcript.output(input, signal),
            // A tool's output never changes, and it can be large: not even an invalidation fetches it again.
            staleTime: 'static',
          }),
      },
    },
  };
}

export type PlainTRPC = ReturnType<typeof createPlainTRPC>;
