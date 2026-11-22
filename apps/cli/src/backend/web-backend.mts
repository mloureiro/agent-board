import {
  isSafeMachineName,
  MACHINE_NAME_RULE,
  isSafeTaskId,
  neededServerFeature,
  parseWireAddScheduleResult,
  parseWireAddTaskResult,
  parseWireEditScheduleResult,
  parseWireWakeResult,
  parseWireFailResult,
  parseWireNotes,
  parseWireRunInbox,
  parseWireSchedule,
  parseWireSchedules,
  parseWireSharedAgents,
  parseWireTask,
  parseWireTasks,
  SERVER_FEATURE_LABELS,
} from '@agent-board/shared';
import type {
  Effort,
  Keys,
  ListOptions,
  SendableFeatures,
  ServerFeature,
  SkippedItem,
  WireBackend,
} from '@agent-board/shared';
import { asBackendError, BackendError, callServer, requireFeature } from './backend.mts';
import type { Fetch, MachineRequest } from './backend.mts';
import { checkDataKey, keyProblemMessage, verifyContract } from './contract-check.mts';
import type { ServerIdentity } from './contract-check.mts';
import type { WebConfig } from './web-config.mts';

export interface WebBackendOptions {
  // Called on the first request, so a command that fails on usage needs no credentials.
  loadConfig: () => WebConfig;
  fetch?: Fetch;
  // Per request; commands that must answer quickly, such as completion, shorten it.
  timeoutMs?: number;
  // Called for each task, note or schedule a list answer leaves out because of an enum value this CLI does not know.
  onSkip?: (skipped: SkippedItem) => void;
  // Which values the CLI sends need a server feature; tests hand in a table, the default is the shared one.
  sendable?: SendableFeatures;
  // Called with a line for a degraded call, such as a suggested reply the server cannot take.
  warn?: (line: string) => void;
  // Told what the board answered to the version check, once per process.
  onServer?: (identity: ServerIdentity) => void;
  // The run this process acts for, if any: a worker once it has read its task, an agent from its environment. Asked per call.
  run?: () => RunScope | undefined;
}

// A run of a task: the calls for `task` that only its run makes carry `run`, so the server refuses them once a later run holds the task.
export interface RunScope {
  task: string;
  run: string;
}

// The board over HTTP with sealed values, and the keys of the board it is connected to.
export interface WebBackend extends WireBackend {
  keys(): Promise<Keys>;
}

interface Connection {
  config: WebConfig;
  keys: Keys;
  features: ReadonlySet<string>;
  dirsIndex: string | null;
  catalogIndex: string | null;
  usageIndex: string | null;
  feedsIndex: string | null;
  feedRequests: string[];
  agentsVersion: number | null;
}

// The server feature each command needs; a command not listed works on every server this CLI accepts.
const COMMAND_FEATURES: Partial<Record<string, ServerFeature>> = {
  'attach-session': 'attach-session',
  wait: 'wait',
  wake: 'wait',
  'set-pr': 'task.pr',
  'set-pr-state': 'task.pr-state',
  'add-pr': 'task.prs',
  'remove-pr': 'task.pr-remove',
  'set-pr-states': 'task.prs',
  'set-watches': 'task.watches',
  'ack-watch-stops': 'task.watches',
  'run-inbox': 'run-inbox',
  'ack-messages': 'run-inbox',
  stopped: 'run-inbox',
  'set-dirs': 'machine.dirs',
  'configure-task': 'task.configure',
  'edit-prompt': 'prompt.edit',
  'edit-schedule': 'prompt.edit',
  'set-catalog': 'machine.catalog',
  'set-usage': 'machine.usage',
  'set-feeds': 'machine.feeds',
  'ack-feed-requests': 'machine.feeds',
  'get-agents': 'agents.shared',
  'set-agents': 'agents.shared',
};

// The commands a run makes for its own task that the server checks against the task's current run (`task.run`).
const RUN_COMMANDS: ReadonlySet<string> = new Set([
  'update-task',
  'ask',
  'heartbeat',
  'pause',
  'fail',
  'wait',
  'run-inbox',
  'ack-messages',
  'stopped',
]);

export function createWebBackend(options: WebBackendOptions): WebBackend {
  // Loads the config, checks the API range and the data key once, before the first real call.
  let ready: Promise<Connection> | undefined;
  const connect = (): Promise<Connection> => {
    ready ??= (async () => {
      const config = options.loadConfig();
      const identity = await verifyContract(config, options.fetch, options.timeoutMs);
      options.onServer?.(identity);
      const checked = await checkDataKey(config.dataKey, identity);
      if ('problem' in checked) throw new BackendError(keyProblemMessage(checked));
      return {
        config,
        keys: checked.keys,
        features: identity.features,
        dirsIndex: identity.dirsIndex ?? null,
        catalogIndex: identity.catalogIndex ?? null,
        usageIndex: identity.usageIndex ?? null,
        feedsIndex: identity.feedsIndex ?? null,
        feedRequests: identity.feedRequests ?? [],
        agentsVersion: identity.agentsVersion ?? null,
      };
    })();
    // A failed first call (a server restarting) must not fail every later one of a long-running command.
    ready.catch(() => {
      ready = undefined;
    });
    return ready;
  };

  // Connects, then refuses a command the server lacks the feature for, before anything is sent.
  const connectFor = async (command: string): Promise<Connection> => {
    const connection = await connect();
    const feature = COMMAND_FEATURES[command];
    if (feature !== undefined) requireFeature(connection.features, feature);
    return connection;
  };

  // Refuses to send a status or priority that needs a server feature the server lacks.
  const requireSendable = async (values: Parameters<typeof neededServerFeature>[0]): Promise<void> => {
    const feature = neededServerFeature(values, options.sendable);
    if (feature !== undefined) requireFeature((await connect()).features, feature);
  };

  // Refuses to send a model to a server that would not read it.
  const requireModelSupport = async (draft: { model?: string }): Promise<void> => {
    if (draft.model !== undefined) requireFeature((await connect()).features, 'task.model');
  };

  // Refuses to send an effort level (or its removal) to a server that would reject the key.
  const requireEffortSupport = async (values: { effort?: Effort | null }): Promise<void> => {
    if (values.effort !== undefined) requireFeature((await connect()).features, 'task.effort');
  };

  const requireIconSupport = async (values: { icon?: string | null }): Promise<void> => {
    if (values.icon !== undefined) requireFeature((await connect()).features, 'task.icon');
  };

  const requireLabelsSupport = async (values: { labels?: string | null }): Promise<void> => {
    if (values.labels !== undefined) requireFeature((await connect()).features, 'task.labels');
  };

  // Refuses to send a lane (or its removal) to a server that would reject the key.
  const requireLaneSupport = async (values: { lane?: string | null }): Promise<void> => {
    if (values.lane !== undefined) requireFeature((await connect()).features, 'task.lane');
  };

  // Refuses to send the auto-done setting to a server that would reject the key.
  const requireAutoDoneSupport = async (values: { autoDone?: boolean }): Promise<void> => {
    if (values.autoDone !== undefined) requireFeature((await connect()).features, 'task.auto-done');
  };

  // Refuses to send an agent to a server that would reject the field, or that would not keep it with the task.
  const requireAgentSupport = async (draft: { agent?: string }): Promise<void> => {
    if (draft.agent !== undefined) requireFeature((await connect()).features, 'task.agent');
  };

  // Refuses to send a schedule capability to a server that would not know it.
  const requireScheduleSupport = async (
    draft: Pick<Parameters<WireBackend['addSchedule']>[0], 'moreCrons' | 'maxConcurrent' | 'after'>,
  ): Promise<void> => {
    const needed = [
      ...(draft.moreCrons === undefined ? [] : (['schedule.crons'] as const)),
      ...(draft.maxConcurrent === undefined ? [] : (['schedule.max-concurrent'] as const)),
      ...(draft.after === undefined ? [] : (['schedule.after'] as const)),
    ];
    if (needed.length === 0) return;
    const { features } = await connect();
    for (const feature of needed) requireFeature(features, feature);
  };

  // A call of the run for its own task names the run, when the server can check it.
  const scoped = (command: string, connection: Connection, request: MachineRequest): MachineRequest => {
    const scope = options.run?.();
    if (scope === undefined || request.id !== scope.task || !RUN_COMMANDS.has(command)) return request;
    return connection.features.has('task.run') ? { ...request, run: scope.run } : request;
  };

  const post = async (command: string, request: MachineRequest): Promise<unknown> => {
    const connection = await connectFor(command);
    return callServer(
      connection.config,
      command,
      scoped(command, connection, request),
      options.fetch,
      options.timeoutMs,
    );
  };

  async function call<T>(command: string, request: MachineRequest, parse: (value: unknown) => T): Promise<T> {
    const result = await post(command, request);
    try {
      return parse(result);
    } catch (error) {
      throw asBackendError(command, error);
    }
  }

  const send = async (command: string, request: MachineRequest): Promise<void> => {
    await post(command, request);
  };

  const listOptions: ListOptions = options.onSkip === undefined ? {} : { onSkip: options.onSkip };

  const taskId = (id: string): string => {
    if (!isSafeTaskId(id)) throw new BackendError(`"${id.slice(0, 40)}" is not a valid task id`);
    return id;
  };

  const scheduleId = (id: string): string => {
    if (!isSafeTaskId(id)) throw new BackendError(`"${id.slice(0, 40)}" is not a valid schedule id`);
    return id;
  };

  return {
    keys: async () => (await connect()).keys,
    listTasks: async ({ all = false } = {}) => {
      const tasks = await call('list-tasks', { all }, (value) => parseWireTasks(value, listOptions));
      return all ? tasks : tasks.filter((task) => !task.closed);
    },
    getTask: async (id) => call('get-task', { id: taskId(id) }, parseWireTask),
    attachSession: async (id) => call('attach-session', { id: taskId(id) }, parseWireTask),
    addTask: async (draft) => {
      await requireSendable(draft);
      await requireModelSupport(draft);
      await requireEffortSupport(draft);
      await requireIconSupport(draft);
      await requireLabelsSupport(draft);
      await requireLaneSupport(draft);
      await requireAutoDoneSupport(draft);
      await requireAgentSupport(draft);
      return call('add-task', { body: draft }, parseWireAddTaskResult);
    },
    updateTask: async (id, patch) => {
      const checkedId = taskId(id);
      await requireSendable(patch);
      return call('update-task', { id: checkedId, body: patch }, parseWireTask);
    },
    configureTask: async (id, body) => {
      const checkedId = taskId(id);
      await requireAutoDoneSupport(body);
      await requireEffortSupport(body);
      await requireIconSupport(body);
      await requireLabelsSupport(body);
      await requireLaneSupport(body);
      return call('configure-task', { id: checkedId, body }, parseWireTask);
    },
    editPrompt: async (id, body) => call('edit-prompt', { id: taskId(id), body }, parseWireTask),
    async claimTask(id, machine) {
      if (!isSafeMachineName(machine))
        throw new BackendError(`"${machine.slice(0, 40)}" is not a valid machine name: use ${MACHINE_NAME_RULE}`);
      try {
        return await call('claim-task', { id: taskId(id), machine }, parseWireTask);
      } catch (error) {
        // A lost claim is an answer, not a failure: the caller moves on to the next task. 404: the card was removed
        // (a paused or deleted schedule's occurrence) after the dispatcher listed it.
        if (error instanceof BackendError && (error.status === 409 || error.status === 404)) return undefined;
        throw error;
      }
    },
    async addNote(id, note, { author = 'agent', kind = 'comment' } = {}) {
      const checkedId = taskId(id);
      const { features } = await connect();
      if (kind === 'polish') requireFeature(features, 'note.polish');
      // A reply the agent expects is advice: without the feature the comment goes out alone, and the agent is told.
      const { suggestion, ...plain } = note;
      const unsupported = suggestion !== undefined && !features.has('note.suggestion');
      if (unsupported)
        options.warn?.(
          `the board server does not support ${SERVER_FEATURE_LABELS['note.suggestion']} yet; the comment is posted without it`,
        );
      await send('add-note', {
        id: checkedId,
        author,
        ...(kind === 'comment' ? {} : { kind }),
        body: unsupported ? plain : note,
      });
    },
    ask: async (id, asked) => send('ask', { id: taskId(id), body: asked }),
    heartbeat: async (id, beat) => send('heartbeat', { id: taskId(id), body: beat }),
    async addPr(id, body) {
      const checkedId = taskId(id);
      // A server without `task.prs` holds one reported PR, and `set-pr` replaces it.
      const command = (await connect()).features.has('task.prs') ? 'add-pr' : 'set-pr';
      await send(command, { id: checkedId, body });
    },
    removePr: async (id, body) => send('remove-pr', { id: taskId(id), body }),
    async setPrStates(id, body) {
      const checkedId = taskId(id);
      if ((await connect()).features.has('task.prs')) return send('set-pr-states', { id: checkedId, body });
      // Such a server states one PR per task: the newest reported one, else the prompt's.
      const { pr } = await call('get-task', { id: checkedId }, parseWireTask);
      const prState = pr === null ? body.prompt : body.prs?.at(-1)?.state;
      if (prState !== undefined) await send('set-pr-state', { id: checkedId, body: { prState } });
    },
    setWatches: async (id, body) => send('set-watches', { id: taskId(id), body }),
    ackWatchStops: async (id, body) => send('ack-watch-stops', { id: taskId(id), body }),
    setDirs: async (body) => send('set-dirs', { body }),
    dirsState: async () => {
      const { features, dirsIndex } = await connect();
      return { supported: features.has('machine.dirs'), index: dirsIndex };
    },
    setCatalog: async (body) => send('set-catalog', { body }),
    catalogState: async () => {
      const { features, catalogIndex } = await connect();
      return { supported: features.has('machine.catalog'), index: catalogIndex };
    },
    setUsage: async (body) => send('set-usage', { body }),
    usageState: async () => {
      const { features, usageIndex } = await connect();
      return { supported: features.has('machine.usage'), index: usageIndex };
    },
    setFeeds: async (body) => send('set-feeds', { body }),
    feedsState: async () => {
      const { features, feedsIndex, feedRequests } = await connect();
      return { supported: features.has('machine.feeds'), index: feedsIndex, requests: feedRequests };
    },
    ackFeedRequests: async (body) => send('ack-feed-requests', { body }),
    getAgents: async () => call('get-agents', {}, parseWireSharedAgents),
    setAgents: async (body) => send('set-agents', { body }),
    agentsState: async () => {
      const { features, agentsVersion } = await connect();
      return { supported: features.has('agents.shared'), version: agentsVersion };
    },
    pause: async (id, note) => call('pause', { id: taskId(id), body: note }, parseWireTask),
    fail: async (id, note) => call('fail', { id: taskId(id), body: note }, parseWireFailResult),
    wait: async (id, wait) => call('wait', { id: taskId(id), body: wait }, parseWireTask),
    wake: async (id, note) => call('wake', { id: taskId(id), body: note }, parseWireWakeResult),
    runInbox: async (id) => call('run-inbox', { id: taskId(id) }, parseWireRunInbox),
    ackMessages: async (id, ack) => send('ack-messages', { id: taskId(id), body: ack }),
    stopped: async (id, note) => call('stopped', { id: taskId(id), body: note }, parseWireTask),
    transcript: async (id, batch) => {
      const { features } = await connect();
      const events = features.has('transcript.context')
        ? batch.events
        : batch.events.filter((e) => e.kind !== 'context');
      await send('transcript', { id: taskId(id), body: { ...batch, events } });
    },
    readNotes: async (id) => call('read-notes', { id: taskId(id) }, (value) => parseWireNotes(value, listOptions)),
    addSchedule: async (draft) => {
      await requireSendable(draft);
      await requireModelSupport(draft);
      await requireEffortSupport(draft);
      await requireIconSupport(draft);
      await requireLabelsSupport(draft);
      await requireLaneSupport(draft);
      await requireAutoDoneSupport(draft);
      await requireAgentSupport(draft);
      await requireScheduleSupport(draft);
      return call('add-schedule', { body: draft }, parseWireAddScheduleResult);
    },
    listSchedules: async () => call('list-schedules', {}, (value) => parseWireSchedules(value, listOptions)),
    updateSchedule: async (id, patch) =>
      call('update-schedule', { id: scheduleId(id), body: patch }, parseWireSchedule),
    editSchedule: async (id, body) => {
      if (body.settings !== undefined) {
        requireFeature((await connect()).features, 'schedule.update');
        await requireEffortSupport(body.settings);
        await requireIconSupport(body.settings);
        await requireLabelsSupport(body.settings);
        await requireLaneSupport(body.settings);
      }
      return call('edit-schedule', { id: scheduleId(id), body }, parseWireEditScheduleResult);
    },
    removeSchedule: async (id) => send('remove-schedule', { id: scheduleId(id) }),
  };
}
