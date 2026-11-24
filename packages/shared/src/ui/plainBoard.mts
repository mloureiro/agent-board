import {
  parseKeySetup,
  type Answer,
  type Keys,
  type LinkRule,
  type Polish,
  type Question,
  type Status,
  type TitleRule,
  type TranscriptEventView,
} from '../index.mts';
import type { UiMutationPath, UiQueryPath } from './procedures.mts';
import {
  sealAnswer,
  sealApply,
  sealConfigure,
  sealEdit,
  sealFork,
  sealLinks,
  sealNewTask,
  sealReply,
  sealScheduleUpdate,
  sealStart,
  sealTitleRulesInput,
  startsProposal,
  type Configuration,
  type ConfigureTarget,
  type EditTarget,
  type ForkSource,
  type NewTask,
  type PolishApplyTarget,
  type Proposal,
  type ScheduleUpdate,
} from './requests.mts';
import {
  openBoardAgents,
  openBoardLinks,
  openBoardTask,
  openBoardTitleRules,
  openCatalogs,
  openContext,
  openEvents,
  openFeeds,
  openListedTasks,
  openMachines,
  openOutput,
  openRuns,
  openSchedule,
  openSchedules,
  openTaskDetail,
} from './responses.mts';
import { parseMe } from './shapes.mts';
import type { UiInputs, UiOutputs } from './wire.mts';

/** How a UI reaches the board: one call per procedure, carrying only what the server may see. */
export interface BoardTransport {
  query<P extends UiQueryPath>(path: P, input: UiInputs[P], signal?: AbortSignal): Promise<UiOutputs[P]>;
  mutate<P extends UiMutationPath>(path: P, input: UiInputs[P]): Promise<UiOutputs[P]>;
}

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
  /** Sent after the interruption (Stop & send). */
  message?: string | undefined;
}

export interface AnswerVariables {
  id: string;
  questionNoteId: string;
  /** The questions the panel showed, which the answers are checked against and sealed with. */
  questions: Question[];
  answers: Answer[];
  message: string;
}

export interface MoveVariables {
  id: string;
  status: Status;
  beforeId?: string | undefined;
  afterId?: string | undefined;
  /** The task as the page shows it. An agent's proposal moved into Todo is started, which seals its prompt again as the user's. */
  task?: Proposal | undefined;
}

export interface ApplyVariables {
  /** The task that made the polish note: marked done once it is applied. */
  polishId: string;
  /** The task the polished prompt is for, as the page shows it; what it says now is kept in a note. */
  target: PolishApplyTarget;
  rewrite: Pick<Polish, 'title' | 'prompt'>;
}

export interface EditVariables {
  /** The task as the page shows it; what it says now is kept in a note. */
  target: EditTarget;
  title: string;
  input: string;
}

export interface SetLinksVariables {
  rules: LinkRule[];
  /** The version the page loaded (0: none saved yet); the save is refused when the board holds another by now. */
  expectedVersion: number;
}

export interface SetTitleRulesVariables {
  rules: TitleRule[];
  /** The version the page loaded (0: none saved yet); the save is refused when the board holds another by now. */
  expectedVersion: number;
}

export type UpdateScheduleVariables = ScheduleUpdate;

export type ConfigureVariables = Configuration & {
  /** The task as the page shows it: a new directory is sealed under its row. */
  task: ConfigureTarget;
};

export interface ForkVariables {
  /** The task to fork, as the page shows it: its agent and directory are sealed again for the new task. */
  parent: ForkSource;
  title: string;
  input: string;
}

export interface EventsRequest {
  taskId: string;
  runId: string;
  afterSeq: number;
}

export interface OutputRequest {
  taskId: string;
  runId: string;
  seq: number;
}

export type PassQuery<P extends UiQueryPath> = undefined extends UiInputs[P]
  ? (input?: UiInputs[P], signal?: AbortSignal) => Promise<UiOutputs[P]>
  : (input: UiInputs[P], signal?: AbortSignal) => Promise<UiOutputs[P]>;

export type PassMutation<P extends UiMutationPath> = undefined extends UiInputs[P]
  ? (input?: UiInputs[P]) => Promise<UiOutputs[P]>
  : (input: UiInputs[P]) => Promise<UiOutputs[P]>;

export type PlainBoard = ReturnType<typeof createPlainBoard>;

/**
 * The board with plaintext in and out. Each call seals what it sends and opens what it gets back with the keys; a call
 * that needs them while the board is locked throws. It holds no state of its own.
 */
export function createPlainBoard(transport: BoardTransport, keys: Keys | null) {
  const need = (): Keys => {
    if (keys === null) throw new Error('The board is locked.');
    return keys;
  };
  // TypeScript cannot resolve the conditional call type for a path that is still a type parameter.
  const query = <P extends UiQueryPath>(path: P) =>
    ((input: UiInputs[P], signal?: AbortSignal) => transport.query(path, input, signal)) as PassQuery<P>;
  const mutation = <P extends UiMutationPath>(path: P) =>
    ((input: UiInputs[P]) => transport.mutate(path, input)) as PassMutation<P>;

  return {
    me: async (signal?: AbortSignal) => parseMe(await transport.query('me', undefined, signal)),
    revision: query('revision'),
    auth: { config: query('auth.config') },
    passkeys: {
      list: query('passkeys.list'),
      registerOptions: mutation('passkeys.registerOptions'),
      register: mutation('passkeys.register'),
      rename: mutation('passkeys.rename'),
      remove: mutation('passkeys.remove'),
    },
    keys: {
      setup: mutation('keys.setup'),
      replaceSlots: mutation('keys.replaceSlots'),
      get: async (signal?: AbortSignal) => {
        const stored = await transport.query('keys.get', undefined, signal);
        return stored === null ? null : parseKeySetup(stored);
      },
    },
    machines: {
      issue: mutation('machines.issue'),
      revoke: mutation('machines.revoke'),
      advertisedCli: query('machines.advertisedCli'),
      list: async (signal?: AbortSignal) =>
        openMachines(need(), await transport.query('machines.list', undefined, signal)),
      catalogs: async (signal?: AbortSignal) =>
        openCatalogs(need(), await transport.query('machines.catalogs', undefined, signal)),
    },
    feeds: {
      request: mutation('feeds.request'),
      list: async (signal?: AbortSignal) => openFeeds(need(), await transport.query('feeds.list', undefined, signal)),
    },
    agents: {
      shared: async (signal?: AbortSignal) =>
        openBoardAgents(need(), await transport.query('agents.shared', undefined, signal)),
    },
    links: {
      get: async (signal?: AbortSignal) =>
        openBoardLinks(need(), await transport.query('links.get', undefined, signal)),
      set: async ({ rules, expectedVersion }: SetLinksVariables) =>
        transport.mutate('links.set', await sealLinks(need(), rules, expectedVersion)),
    },
    titleRules: {
      get: async (signal?: AbortSignal) =>
        openBoardTitleRules(need(), await transport.query('titleRules.get', undefined, signal)),
      set: async ({ rules, expectedVersion }: SetTitleRulesVariables) =>
        transport.mutate('titleRules.set', await sealTitleRulesInput(need(), rules, expectedVersion)),
    },
    tasks: {
      done: mutation('tasks.done'),
      rerun: mutation('tasks.rerun'),
      setPriority: mutation('tasks.setPriority'),
      setNotBefore: mutation('tasks.setNotBefore'),
      takeBack: mutation('tasks.takeBack'),
      dismissQuestion: mutation('tasks.dismissQuestion'),
      wakeNow: mutation('tasks.wakeNow'),
      setClosed: mutation('tasks.setClosed'),
      removePr: mutation('tasks.removePr'),
      stopWatch: mutation('tasks.stopWatch'),
      move: async ({ task, ...variables }: MoveVariables) => {
        const starts = task !== undefined && startsProposal(task, variables.status);
        return transport.mutate('tasks.move', {
          ...variables,
          ...(starts ? { startInput: await sealStart(need(), task) } : {}),
        });
      },
      list: async (input?: UiInputs['tasks.list'], signal?: AbortSignal) =>
        openListedTasks(need(), await transport.query('tasks.list', input, signal)),
      get: async (input: UiInputs['tasks.get'], signal?: AbortSignal) =>
        openTaskDetail(need(), await transport.query('tasks.get', input, signal)),
      create: async (task: NewTask) => {
        const created = await transport.mutate('tasks.create', await sealNewTask(need(), task));
        return created === null ? null : openBoardTask(need(), created);
      },
      fork: async (variables: ForkVariables) =>
        openBoardTask(need(), await transport.mutate('tasks.fork', await sealFork(need(), variables))),
      configure: async (variables: ConfigureVariables) =>
        openBoardTask(need(), await transport.mutate('tasks.configure', await sealConfigure(need(), variables))),
      applyPolish: async (variables: ApplyVariables) =>
        openBoardTask(need(), await transport.mutate('tasks.applyPolish', await sealApply(need(), variables))),
      edit: async (variables: EditVariables) =>
        openBoardTask(need(), await transport.mutate('tasks.edit', await sealEdit(need(), variables))),
      reply: async ({ id, message, resume }: ReplyVariables) =>
        openBoardTask(
          need(),
          await transport.mutate('tasks.reply', { id, message: await sealReply(need(), id, message), resume }),
        ),
      send: async ({ id, message }: SendVariables) =>
        openBoardTask(
          need(),
          await transport.mutate('tasks.send', { id, message: await sealReply(need(), id, message) }),
        ),
      stop: async ({ id, message }: StopVariables) =>
        openBoardTask(
          need(),
          await transport.mutate('tasks.stop', {
            id,
            ...(message === undefined ? {} : { message: await sealReply(need(), id, message) }),
          }),
        ),
      answer: async (variables: AnswerVariables) =>
        openBoardTask(need(), await transport.mutate('tasks.answer', await sealAnswer(need(), variables))),
    },
    schedules: {
      remove: mutation('schedules.remove'),
      list: async (signal?: AbortSignal) =>
        openSchedules(need(), await transport.query('schedules.list', undefined, signal)),
      update: async (variables: UpdateScheduleVariables) => {
        const { schedule, pending } = await transport.mutate(
          'schedules.update',
          await sealScheduleUpdate(need(), variables),
        );
        return { schedule: await openSchedule(need(), schedule), pending };
      },
      setPaused: async (variables: UiInputs['schedules.setPaused']) =>
        openSchedule(need(), await transport.mutate('schedules.setPaused', variables)),
    },
    transcript: {
      runs: async (input: UiInputs['transcript.runs'], signal?: AbortSignal) =>
        openRuns(await transport.query('transcript.runs', input, signal)),
      context: async (input: UiInputs['transcript.context'], signal?: AbortSignal) =>
        openContext(need(), input.id, await transport.query('transcript.context', input, signal)),
      events: async ({ taskId, ...input }: EventsRequest, signal?: AbortSignal): Promise<TranscriptEventView[]> =>
        openEvents(need(), { taskId, runId: input.runId }, await transport.query('transcript.events', input, signal)),
      output: async ({ taskId, ...input }: OutputRequest, signal?: AbortSignal) =>
        openOutput(
          need(),
          { taskId, runId: input.runId },
          input.seq,
          await transport.query('transcript.output', input, signal),
        ),
    },
  };
}
