import type { AppRouter } from '@agent-board/backend/router';
import {
  parseKeySetup,
  type Answer,
  type Keys,
  type LinkRule,
  type Question,
  type Polish,
  type TranscriptEventView,
} from '@agent-board/shared';
import { mutationOptions, queryOptions, type QueryKey } from '@tanstack/react-query';
import type { TRPCClient } from '@trpc/client';
import {
  openBoardAgents,
  openBoardLinks,
  openBoardTask,
  openEvents,
  openListedTasks,
  openCatalogs,
  openFeeds,
  openMachines,
  openOutput,
  openRuns,
  openSchedule,
  openSchedules,
  openTaskDetail,
} from './opening';
import type { useRawTRPC } from './rawTrpc';
import {
  sealAnswer,
  sealApply,
  sealConfigure,
  sealFork,
  sealLinks,
  sealEdit,
  sealNewTask,
  sealReply,
  sealScheduleUpdate,
  sealStart,
  startsProposal,
  type Configuration,
  type ConfigureTarget,
  type ForkSource,
  type EditTarget,
  type NewTask,
  type ScheduleUpdate,
  type PolishTarget,
  type Proposal,
} from './sealing';
import { parseMe } from './shapes';

export type RawTRPC = ReturnType<typeof useRawTRPC>;
export type RawClient = TRPCClient<AppRouter>;
type RawMoveInput = Parameters<RawClient['tasks']['move']['mutate']>[0];

export interface ReplyVariables {
  id: string;
  message: string;
  resume: boolean;
}

export interface SendVariables {
  id: string;
  message: string;
}

export interface StopVariables {
  id: string;
  // Sent after the interruption (Stop & send).
  message?: string | undefined;
}

export interface AnswerVariables {
  id: string;
  questionNoteId: string;
  // The questions the panel showed, which the answers are checked against and sealed with.
  questions: Question[];
  answers: Answer[];
  message: string;
}

export interface MoveVariables {
  id: string;
  status: RawMoveInput['status'];
  beforeId?: string | undefined;
  afterId?: string | undefined;
  // The task as the page shows it. An agent's proposal moved into Todo is started, which seals its prompt again as the user's.
  task?: Proposal | undefined;
}

export interface ApplyVariables {
  // The task that made the polish note: marked done once it is applied.
  polishId: string;
  // The task the polished prompt is for, as the page shows it; what it says now is kept in a note.
  target: PolishTarget;
  rewrite: Pick<Polish, 'title' | 'prompt'>;
}

export interface EditVariables {
  // The task as the page shows it; what it says now is kept in a note.
  target: EditTarget;
  title: string;
  input: string;
}

export interface SetLinksVariables {
  rules: LinkRule[];
  /** The version the page loaded (0: none saved yet); the save is refused when the board holds another by now. */
  expectedVersion: number;
}

export type UpdateScheduleVariables = ScheduleUpdate;

export type ConfigureVariables = Configuration & {
  // The task as the page shows it: a new directory is sealed under its row.
  task: ConfigureTarget;
};

export interface ForkVariables {
  /** The task to fork, as the page shows it: its agent and directory are sealed again for the new task. */
  parent: ForkSource;
  title: string;
  input: string;
}

export type { NewTask };

// The raw keys carry the wire type of their data; the plaintext facade keeps the keys and changes what the data is.
const plainKey = (key: QueryKey): QueryKey => [...key];

/**
 * The board's tRPC with plaintext in and out: queries open what they fetch, mutations seal what they send. Procedures
 * that carry nothing sealed are the raw ones. The query keys are the raw ones too, so the cache and its invalidation work
 * as they would without encryption.
 */
export function createPlainTRPC(raw: RawTRPC, client: RawClient, keys: Keys | null) {
  const need = (): Keys => {
    if (keys === null) throw new Error('The board is locked.');
    return keys;
  };
  return {
    me: {
      queryKey: raw.me.queryKey,
      queryOptions: () =>
        queryOptions({
          queryKey: plainKey(raw.me.queryKey()),
          queryFn: async ({ signal }) => parseMe(await client.me.query(undefined, { signal })),
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
            queryFn: async ({ signal }) => {
              const stored = await client.keys.get.query(undefined, { signal });
              return stored === null ? null : parseKeySetup(stored);
            },
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
            queryFn: async ({ signal }) =>
              openMachines(need(), await client.machines.list.query(undefined, { signal })),
          }),
      },
      catalogs: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.machines.catalogs.queryKey()),
            queryFn: async ({ signal }) =>
              openCatalogs(need(), await client.machines.catalogs.query(undefined, { signal })),
          }),
      },
    },
    feeds: {
      request: raw.feeds.request,
      list: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.feeds.list.queryKey()),
            queryFn: async ({ signal }) => openFeeds(need(), await client.feeds.list.query(undefined, { signal })),
          }),
      },
    },
    agents: {
      shared: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.agents.shared.queryKey()),
            queryFn: async ({ signal }) =>
              openBoardAgents(need(), await client.agents.shared.query(undefined, { signal })),
          }),
      },
    },
    links: {
      get: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.links.get.queryKey()),
            queryFn: async ({ signal }) => openBoardLinks(need(), await client.links.get.query(undefined, { signal })),
          }),
      },
      set: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.links.set.mutationKey(),
            mutationFn: async ({ rules, expectedVersion }: SetLinksVariables) =>
              client.links.set.mutate(await sealLinks(need(), rules, expectedVersion)),
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
            mutationFn: async ({ task, ...variables }: MoveVariables) => {
              const starts = task !== undefined && startsProposal(task, variables.status);
              return client.tasks.move.mutate({
                ...variables,
                ...(starts ? { startInput: await sealStart(need(), task) } : {}),
              });
            },
          }),
      },
      list: {
        queryOptions: (input?: { closed?: boolean }) =>
          queryOptions({
            queryKey: plainKey(raw.tasks.list.queryKey(input)),
            queryFn: async ({ signal }) => openListedTasks(need(), await client.tasks.list.query(input, { signal })),
          }),
      },
      get: {
        queryOptions: (input: { id: string }) =>
          queryOptions({
            queryKey: plainKey(raw.tasks.get.queryKey(input)),
            queryFn: async ({ signal }) => openTaskDetail(need(), await client.tasks.get.query(input, { signal })),
          }),
      },
      create: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.create.mutationKey(),
            mutationFn: async (task: NewTask) => {
              const created = await client.tasks.create.mutate(await sealNewTask(need(), task));
              return created === null ? null : openBoardTask(need(), created);
            },
          }),
      },
      fork: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.fork.mutationKey(),
            mutationFn: async (variables: ForkVariables) =>
              openBoardTask(need(), await client.tasks.fork.mutate(await sealFork(need(), variables))),
          }),
      },
      configure: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.configure.mutationKey(),
            mutationFn: async (variables: ConfigureVariables) =>
              openBoardTask(need(), await client.tasks.configure.mutate(await sealConfigure(need(), variables))),
          }),
      },
      applyPolish: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.applyPolish.mutationKey(),
            mutationFn: async (variables: ApplyVariables) =>
              openBoardTask(need(), await client.tasks.applyPolish.mutate(await sealApply(need(), variables))),
          }),
      },
      edit: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.edit.mutationKey(),
            mutationFn: async (variables: EditVariables) =>
              openBoardTask(need(), await client.tasks.edit.mutate(await sealEdit(need(), variables))),
          }),
      },
      reply: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.reply.mutationKey(),
            mutationFn: async ({ id, message, resume }: ReplyVariables) =>
              openBoardTask(
                need(),
                await client.tasks.reply.mutate({ id, message: await sealReply(need(), id, message), resume }),
              ),
          }),
      },
      send: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.send.mutationKey(),
            mutationFn: async ({ id, message }: SendVariables) =>
              openBoardTask(
                need(),
                await client.tasks.send.mutate({ id, message: await sealReply(need(), id, message) }),
              ),
          }),
      },
      stop: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.stop.mutationKey(),
            mutationFn: async ({ id, message }: StopVariables) =>
              openBoardTask(
                need(),
                await client.tasks.stop.mutate({
                  id,
                  ...(message === undefined ? {} : { message: await sealReply(need(), id, message) }),
                }),
              ),
          }),
      },
      answer: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.answer.mutationKey(),
            mutationFn: async (variables: AnswerVariables) =>
              openBoardTask(need(), await client.tasks.answer.mutate(await sealAnswer(need(), variables))),
          }),
      },
    },
    schedules: {
      remove: raw.schedules.remove,
      list: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.schedules.list.queryKey()),
            queryFn: async ({ signal }) =>
              openSchedules(need(), await client.schedules.list.query(undefined, { signal })),
          }),
      },
      update: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.schedules.update.mutationKey(),
            mutationFn: async (variables: UpdateScheduleVariables) => {
              const { schedule, pending } = await client.schedules.update.mutate(
                await sealScheduleUpdate(need(), variables),
              );
              return { schedule: await openSchedule(need(), schedule), pending };
            },
          }),
      },
      setPaused: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.schedules.setPaused.mutationKey(),
            mutationFn: async (variables: { id: string; paused: boolean }) =>
              openSchedule(need(), await client.schedules.setPaused.mutate(variables)),
          }),
      },
    },
    transcript: {
      runs: {
        queryOptions: (input: { id: string }) =>
          queryOptions({
            queryKey: plainKey(raw.transcript.runs.queryKey(input)),
            queryFn: async ({ signal }) => openRuns(await client.transcript.runs.query(input, { signal })),
          }),
      },
      events: {
        queryKey: (input: { taskId: string; runId: string }): QueryKey =>
          plainKey(raw.transcript.events.queryKey({ runId: input.runId })),
        // The drawer keeps a run's events in one cache entry and extends it a page at a time, so pages are fetched directly.
        fetchPage: async (
          { taskId, ...input }: { taskId: string; runId: string; afterSeq: number },
          signal?: AbortSignal,
        ): Promise<TranscriptEventView[]> =>
          openEvents(need(), { taskId, runId: input.runId }, await client.transcript.events.query(input, { signal })),
      },
      output: {
        queryOptions: ({ taskId, ...input }: { taskId: string; runId: string; seq: number }) =>
          queryOptions({
            queryKey: plainKey(raw.transcript.output.queryKey(input)),
            queryFn: async ({ signal }) =>
              openOutput(
                need(),
                { taskId, runId: input.runId },
                input.seq,
                await client.transcript.output.query(input, { signal }),
              ),
            // A tool's output never changes, and it can be large: not even an invalidation fetches it again.
            staleTime: 'static',
          }),
      },
    },
  };
}

export type PlainTRPC = ReturnType<typeof createPlainTRPC>;
