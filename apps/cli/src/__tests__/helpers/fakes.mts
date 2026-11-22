import type { CatalogEntry, CatalogStore, InitRecord } from '../../catalog/cache.mts';
import type { Config } from '../../config/config.mts';
import type { RunFiles, RunRecord } from '../../worker/runtime.mts';
import type { WorktreeLocks } from '../../worker/worktree-lock.mts';
import type { SessionStore } from '../../worker/sessions.mts';
import type { TaskFile, TaskFileStore } from '../../dispatch/task-files.mts';
import type { UpdateState } from '../../self/update-state.mts';
import type { WaitCheck, WaitStore } from '../../dispatch/waits.mts';
import { BackendError } from '../../backend/backend.mts';
import { withScheduleSettings } from '../../backend/schedule-settings.mts';
import {
  API_VERSION,
  LEGACY_CONTRACT,
  machineCatalogJson,
  machineDirsJson,
  machineUsageJson,
  machineFeedsJson,
  MIN_CLIENT,
  deriveKeys,
  encodeDataKey,
  generateDataKey,
  seal,
  SERVER_FEATURES,
  sealFields,
  sealPr,
  sealWatches,
  taskLabels,
  textBeforeEdit,
} from '@agent-board/shared';
import type { Sealer } from '@agent-board/shared';
import type {
  Backend,
  MachineCatalog,
  MachineDir,
  MachineUsage,
  MachineFeeds,
  SharedAgentsOnBoard,
  Note,
  Schedule,
  Task,
  WireSchedule,
  WireTask,
} from '@agent-board/shared';

export function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `task ${overrides.id}`,
    input: '',
    labels: [],
    status: 'todo',
    priority: 'normal',
    model: null,
    effort: null,
    icon: null,
    requestedLane: null,
    autoDone: false,
    closed: false,
    machine: null,
    sessionId: null,
    workdir: null,
    prs: [],
    promptPrState: null,
    watches: null,
    watchEvents: 0,
    watchStops: [],
    next: 'fresh',
    head: null,
    openQuestion: false,
    createdBy: 'user',
    lane: null,
    borrowed: false,
    lastActiveAt: null,
    runStartedAt: null,
    paused: false,
    notBefore: null,
    scheduleId: null,
    wakeAt: null,
    waitCheck: false,
    woken: false,
    unreadable: [],
    ...overrides,
  };
}

export const CONFIG: Config = {
  machine: 'here',
  lanes: [{ name: 'general', slots: 2, default: true }],
  defaultCwd: '/home/me',
  pauseAfterMinutes: 5,
  inactivityMinutes: 15,
  maxRunHours: 6,
  autoUpdate: 'incompatible',
  agents: {},
  agentErrors: {},
  repos: { 'cosuno/cosuno': '/work/cosuno' },
};

export function schedule(overrides: Partial<Schedule> & { id: string }): Schedule {
  return {
    title: `schedule ${overrides.id}`,
    input: '/sweep',
    priority: 'normal',
    model: null,
    effort: null,
    icon: null,
    requestedLane: null,
    autoDone: false,
    machine: null,
    workdir: null,
    everyMs: 7_200_000,
    cron: null,
    after: null,
    maxConcurrent: null,
    timezone: null,
    anchorAt: new Date('2027-01-01T08:00:00Z'),
    nextRunAt: new Date('2027-01-01T08:00:00Z'),
    remaining: null,
    until: null,
    paused: false,
    ended: false,
    occurrenceTaskId: 'pending',
    createdAt: new Date('2026-11-14T10:00:00Z'),
    unreadable: [],
    ...overrides,
  };
}

export interface FakeBackend extends Backend {
  tasks: Task[];
  schedules: Schedule[];
  notes: Map<string, Note[]>;
  // What the user sent each running task and no worker has acknowledged.
  inboxes: Map<string, { stop: boolean; stopMessage?: string; messages: Note[] }>;
  writes: string[];
  // Claims of these ids are lost, as if another machine got there first.
  lostClaims: string[];
  // The dedupe key of tasks by id. A task listed here is found by exactly that key; any other matches a key that its prompt's
  // first line contains, which is how a task made by a script (key: the PR URL) is found.
  keys: Map<string, string>;
  // The directory list the board holds for this machine, and what its server does with a new one.
  boardDirs: { supported: boolean; held: MachineDir[] | undefined; failure: Error | undefined };
  // The same for the catalogue of skills and models.
  boardCatalog: { supported: boolean; held: MachineCatalog | undefined; failure: Error | undefined };
  // The same for the usage status.
  boardUsage: { supported: boolean; held: MachineUsage | undefined; failure: Error | undefined };
  boardFeeds: {
    supported: boolean;
    held: MachineFeeds | undefined;
    requests: string[];
    failure: Error | undefined;
  };
  // The shared agent definitions the board holds: the document, or a version that does not open; `reported` is the version
  // the `version` answer names, which a lying server can set apart from what it serves.
  boardAgents: {
    supported: boolean;
    held: SharedAgentsOnBoard;
    reported?: number | null;
    // Pushes that fail with 409 before the next one goes through, as if another CLI pushed in between.
    conflicts: number;
  };
}

function parseFirstLine(input: string): string {
  return input.split('\n')[0]?.trim() ?? '';
}

let noteCounter = 0;

// A note as the backend returns it; `author` defaults to the agent.
export function note(text: string, createdAt: Date, overrides: Partial<Note> = {}): Note {
  noteCounter++;
  return { id: `n${noteCounter}`, text, createdAt, author: 'agent', kind: 'comment', unreadable: false, ...overrides };
}

// In-memory task store; the array order is the priority. Every write lands in `writes` as a short string, so tests assert on what was done.
// As the board's `toTask` shows a task: only a running task has a run start.
function asBoardShows(task: Task): Task {
  return { ...task, runStartedAt: task.status === 'running' ? task.runStartedAt : null };
}

export function fakeBackend(tasks: Task[]): FakeBackend {
  const state: FakeBackend = {
    tasks,
    schedules: [],
    notes: new Map(),
    inboxes: new Map(),
    writes: [],
    lostClaims: [],
    keys: new Map(),
    boardDirs: { supported: true, held: undefined, failure: undefined },
    boardCatalog: { supported: true, held: undefined, failure: undefined },
    boardUsage: { supported: true, held: undefined, failure: undefined },
    boardFeeds: { supported: true, held: undefined, requests: [], failure: undefined },
    boardAgents: { supported: true, held: null, conflicts: 0 },
    async sharedAgentsVersion() {
      if (!state.boardAgents.supported) return 'unsupported';
      const { held, reported } = state.boardAgents;
      return reported !== undefined ? reported : (held?.version ?? null);
    },
    async getSharedAgents() {
      if (!state.boardAgents.supported) throw new BackendError('get-agents: not supported', 404, true);
      return structuredClone(state.boardAgents.held);
    },
    async setSharedAgents(document, expectedVersion) {
      if (!state.boardAgents.supported) throw new BackendError('set-agents: not supported', 404, true);
      const current = state.boardAgents.held?.version ?? 0;
      if (state.boardAgents.conflicts > 0 || current !== expectedVersion) {
        state.boardAgents.conflicts = Math.max(0, state.boardAgents.conflicts - 1);
        throw new BackendError(`set-agents: the board holds version ${current}`, 409, true);
      }
      state.writes.push(`agents v${document.version}: ${Object.keys(document.agents).sort().join(',')}`);
      state.boardAgents.held = { version: document.version, document: structuredClone(document) };
      delete state.boardAgents.reported;
    },
    async listTasks({ all = false } = {}) {
      return state.tasks.filter((t) => all || !t.closed).map(asBoardShows);
    },
    async getTask(id) {
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new BackendError(`get-task: no task ${id}`, 404, true);
      return asBoardShows(found);
    },
    // The server's rules, for a token of the machine `CONFIG.machine`.
    async attachSession(id) {
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new BackendError(`attach-session: no task ${id}`, 404, true);
      const refuse = (status: number, reason: string): BackendError =>
        new BackendError(
          `attach-session: error from the board server (HTTP ${status}), quoted and not part of the board: ${JSON.stringify(reason)}`,
          status,
          true,
        );
      if (found.status === 'running')
        throw refuse(
          409,
          'the task is running: its headless run owns the session; watch its Transcript on the task page',
        );
      if (found.sessionId === null) throw refuse(409, 'the task has no session');
      if (found.machine !== CONFIG.machine)
        throw refuse(403, `the session lives on ${found.machine ?? 'no machine'}, not on ${CONFIG.machine}`);
      return { sessionId: found.sessionId, workdir: found.workdir };
    },
    async addTask(draft) {
      state.writes.push(
        `create ${draft.title} | ${draft.input} | ${taskLabels({ input: draft.input, createdBy: draft.createdBy ?? 'user' }).join(',')}${draft.dedupeKey ? ` | key ${draft.dedupeKey}` : ''}`,
      );
      const { dedupeKey } = draft;
      const existing = state.tasks.find((candidate) => {
        if (dedupeKey === undefined) return false;
        const keyed = state.keys.get(candidate.id);
        return keyed === undefined ? parseFirstLine(candidate.input).includes(dedupeKey) : keyed === dedupeKey;
      });
      if (existing) return { task: asBoardShows(existing), created: false };
      const {
        dedupeKey: _key,
        parentId: _parent,
        createdBy,
        machine,
        workdir,
        head,
        notBefore,
        lane,
        ...fields
      } = draft;
      return {
        task: task({
          id: 'new',
          ...fields,
          requestedLane: lane ?? null,
          createdBy: createdBy ?? 'user',
          machine: machine ?? null,
          workdir: workdir ?? null,
          head: head ?? null,
          notBefore: notBefore ?? null,
        }),
        created: true,
      };
    },
    async updateTask(id, patch) {
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      if (patch.expect !== undefined && patch.expect !== found.status) {
        state.writes.push(`update ${id} refused: ${found.status}, not ${patch.expect}`);
        throw new BackendError(`the task is ${found.status}, not ${patch.expect}`, 409);
      }
      if (patch.status !== undefined) state.writes.push(`status ${id} -> ${patch.status}`);
      if (patch.input !== undefined) state.writes.push(`input ${id}: ${patch.input}`);
      if (patch.sessionId !== undefined) state.writes.push(`session ${id}: ${patch.sessionId}`);
      if (patch.next !== undefined) state.writes.push(`next ${id}: ${patch.next}`);
      if (patch.workdir !== undefined) state.writes.push(`workdir ${id}: ${patch.workdir}`);
      if (patch.notBefore !== undefined)
        state.writes.push(`notBefore ${id}: ${patch.notBefore?.toISOString() ?? 'cleared'}`);
      const { expect: _expect, ...fields } = patch;
      Object.assign(found, fields);
      return { ...found };
    },
    // The server's rules, for a token of the machine `CONFIG.machine`: a new place drops the session and pins to this machine.
    async configureTask(id, change) {
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new BackendError(`configure-task: no task ${id}`, 404, true);
      const { priority, model, effort, lane, autoDone, icon, place } = change;
      if (lane !== undefined && found.status === 'running') {
        state.writes.push(`configure ${id} refused: running`);
        throw new BackendError('the task is running: it keeps its lane until its next start.', 409, true);
      }
      if (place !== undefined && (found.status === 'running' || found.status === 'waiting')) {
        state.writes.push(`configure ${id} refused: ${found.status}`);
        throw new BackendError(`the task is ${found.status}. Stop it first, then move it.`, 409, true);
      }
      if (priority !== undefined) state.writes.push(`priority ${id}: ${priority}`);
      if (model !== undefined) state.writes.push(`model ${id}: ${model ?? 'default'}`);
      if (effort !== undefined) state.writes.push(`effort ${id}: ${effort ?? 'default'}`);
      if (icon !== undefined) state.writes.push(`icon ${id}: ${icon ?? 'none'}`);
      if (lane !== undefined) state.writes.push(`lane ${id}: ${lane ?? 'default'}`);
      if (autoDone !== undefined) state.writes.push(`auto-done ${id}: ${autoDone ? 'on' : 'off'}`);
      if (place !== undefined) state.writes.push(`place ${id}: ${place === null ? 'none' : place.workdir}`);
      Object.assign(found, {
        ...(priority === undefined ? {} : { priority }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(icon === undefined ? {} : { icon }),
        ...(lane === undefined ? {} : { requestedLane: lane }),
        ...(autoDone === undefined ? {} : { autoDone }),
        ...(place === undefined
          ? {}
          : {
              machine: place === null ? null : CONFIG.machine,
              workdir: place?.workdir ?? null,
              sessionId: null,
              next: 'fresh',
              paused: false,
              woken: false,
            }),
      });
      return { ...found };
    },
    // The server's rules for the user's edit of a prompt, minus the sealing: the old text lands in a note of the user's.
    async editPrompt(id, edit) {
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new BackendError(`edit-prompt: no task ${id}`, 404, true);
      const refusal =
        found.createdBy !== 'user'
          ? 'only a task you created has a prompt you can edit'
          : found.scheduleId !== null
            ? 'a scheduled occurrence takes its prompt from its schedule'
            : found.lastActiveAt !== null || found.sessionId !== null
              ? 'the task has started'
              : found.closed || (found.status !== 'todo' && found.status !== 'backlog')
                ? 'the prompt can only be edited while the task waits in Todo or Backlog'
                : undefined;
      if (refusal !== undefined) {
        state.writes.push(`edit-prompt ${id} refused: ${refusal}`);
        throw new BackendError(refusal, 409, true);
      }
      state.writes.push(`edit-prompt ${id}: ${edit.title} | ${edit.input}`);
      state.notes.set(id, [
        ...(state.notes.get(id) ?? []),
        {
          id: `edit-${(state.notes.get(id) ?? []).length}`,
          createdAt: new Date(),
          kind: 'event',
          author: 'user',
          text: textBeforeEdit(found),
          unreadable: false,
        },
      ]);
      Object.assign(found, edit);
      return { ...found };
    },
    async claimTask(id, machine) {
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      const pinned =
        found.machine !== null &&
        found.machine !== machine &&
        (found.workdir !== null || (found.next === 'resume' && found.sessionId !== null));
      const waiting = found.notBefore !== null && found.notBefore.getTime() > Date.now();
      if (found.status !== 'todo' || pinned || waiting || state.lostClaims.includes(id)) {
        state.writes.push(`claim ${id} lost`);
        return undefined;
      }
      state.writes.push(`claim ${id} by ${machine}`);
      Object.assign(found, { status: 'running', machine, notBefore: null });
      return { ...found };
    },
    async addNote(id, text, options) {
      const tag = options?.author === 'system' ? ' (system)' : options?.kind === 'polish' ? ' (polish)' : '';
      const suggested = options?.suggestion === undefined ? '' : ` [suggest: ${options.suggestion}]`;
      state.writes.push(`note ${id}${tag}: ${text}${suggested}`);
    },
    async transcript(id, batch) {
      state.writes.push(`transcript ${id} ${batch.runId} ${batch.events.map((e) => e.kind).join(',')}`);
    },
    async addPr(id, url) {
      state.writes.push(`pr ${id} ${url}`);
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new BackendError(`add-pr: no task ${id}`, 404, true);
      found.prs.push({ id: `pr${found.prs.length + 1}`, url, state: null });
    },
    async removePr(id, prId) {
      state.writes.push(`remove-pr ${id} ${prId}`);
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new BackendError(`remove-pr: no task ${id}`, 404, true);
      found.prs = found.prs.filter((pr) => pr.id !== prId);
    },
    async setPrStates(id, { prompt, prs = [] }) {
      const written = [
        ...(prompt === undefined ? [] : [`prompt=${prompt}`]),
        ...prs.map((pr) => `${pr.id}=${pr.state}`),
      ];
      state.writes.push(`prStates ${id} ${written.join(' ')}`);
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new BackendError(`set-pr-states: no task ${id}`, 404, true);
      if (prompt !== undefined) found.promptPrState = prompt;
      for (const { id: rowId, state: prState } of prs) {
        const row = found.prs.find((pr) => pr.id === rowId);
        if (row) row.state = prState;
      }
    },
    async setWatches(id, watches, pendingEvents) {
      state.writes.push(`watches ${id} ${watches === null ? 'null' : JSON.stringify(watches)}`);
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new BackendError(`set-watches: no task ${id}`, 404, true);
      found.watches = watches === null ? null : [...watches];
      found.watchEvents = pendingEvents;
    },
    async ackWatchStops(id, ids) {
      state.writes.push(`ackWatchStops ${id} ${ids.join(',')}`);
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new BackendError(`ack-watch-stops: no task ${id}`, 404, true);
      found.watchStops = found.watchStops.filter((stop) => !ids.includes(stop));
    },
    async checkDirs(_machine, dirs) {
      if (state.boardDirs.failure) throw state.boardDirs.failure;
      if (!state.boardDirs.supported) return 'unsupported';
      const { held } = state.boardDirs;
      return held !== undefined && machineDirsJson(held) === machineDirsJson(dirs) ? 'current' : 'stale';
    },
    async setDirs(machine, dirs) {
      if (state.boardDirs.failure) throw state.boardDirs.failure;
      state.writes.push(
        `dirs ${machine}: ${dirs.map(({ path, label }) => (label === undefined ? path : `${path}=${label}`)).join(',')}`,
      );
      state.boardDirs.held = dirs.map((entry) => ({ ...entry }));
    },
    async checkCatalog(_machine, catalog) {
      if (state.boardCatalog.failure) throw state.boardCatalog.failure;
      if (!state.boardCatalog.supported) return 'unsupported';
      const { held } = state.boardCatalog;
      return held !== undefined && machineCatalogJson(held) === machineCatalogJson(catalog) ? 'current' : 'stale';
    },
    async setCatalog(machine, catalog) {
      if (state.boardCatalog.failure) throw state.boardCatalog.failure;
      state.writes.push(
        `catalog ${machine}: ${catalog.skills.length} skills, ${Object.keys(catalog.dirs).length} directories, ${catalog.models.length} models`,
      );
      state.boardCatalog.held = structuredClone(catalog);
    },
    async checkUsage(_machine, usage) {
      if (state.boardUsage.failure) throw state.boardUsage.failure;
      if (!state.boardUsage.supported) return 'unsupported';
      const { held } = state.boardUsage;
      return held !== undefined && machineUsageJson(held) === machineUsageJson(usage) ? 'current' : 'stale';
    },
    async setUsage(machine, usage) {
      if (state.boardUsage.failure) throw state.boardUsage.failure;
      state.writes.push(`usage ${machine}: ${usage.held.length} held, ${usage.open.length} open`);
      state.boardUsage.held = structuredClone(usage);
    },
    async checkFeeds(_machine, feeds) {
      if (state.boardFeeds.failure) throw state.boardFeeds.failure;
      if (!state.boardFeeds.supported) return 'unsupported';
      const { held } = state.boardFeeds;
      return held !== undefined && machineFeedsJson(held) === machineFeedsJson(feeds) ? 'current' : 'stale';
    },
    async setFeeds(machine, feeds) {
      if (state.boardFeeds.failure) throw state.boardFeeds.failure;
      state.writes.push(`feeds ${machine}: ${feeds.feeds.map(({ name }) => name).join(',') || 'none'}`);
      state.boardFeeds.held = structuredClone(feeds);
    },
    async feedRequests() {
      return state.boardFeeds.supported ? [...state.boardFeeds.requests] : [];
    },
    async ackFeedRequests(requests) {
      state.writes.push(`ack feeds ${requests.join(' ')}`);
      state.boardFeeds.requests = state.boardFeeds.requests.filter((request) => !requests.includes(request));
    },
    async heartbeat(id, beat) {
      state.writes.push(`heartbeat ${id} ${beat.lane}${beat.borrowed ? ' borrowed' : ''}`);
    },
    async pause(id, note) {
      state.writes.push(`pause ${id}: ${note}`);
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      Object.assign(found, { status: 'todo', next: found.sessionId ? 'resume' : 'fresh' });
      return { ...found };
    },
    async fail(id, text) {
      state.writes.push(`fail ${id}: ${text}`);
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      const applied = found.status === 'running' && !found.closed;
      if (applied) Object.assign(found, { status: 'needs-me' });
      return { applied, task: { ...found } };
    },
    async wait(id, request) {
      state.writes.push(
        `wait ${id} until ${request.wakeAt.toISOString()}${request.check ? ' check' : ''}: ${request.text}`,
      );
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      if (found.status !== 'running') throw new BackendError(`wait: the task is ${found.status}, not running`, 409);
      Object.assign(found, {
        status: 'waiting',
        wakeAt: request.wakeAt,
        waitCheck: request.check,
        next: found.sessionId ? 'resume' : 'fresh',
      });
      return { ...found };
    },
    async wake(id, text) {
      state.writes.push(`wake ${id}: ${text}`);
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      const applied = found.status === 'waiting' && !found.closed;
      if (applied)
        Object.assign(found, {
          status: 'todo',
          next: found.sessionId ? 'resume' : 'fresh',
          woken: true,
          wakeAt: null,
          waitCheck: false,
        });
      return { applied, task: { ...found } };
    },
    async ask(id, questions) {
      state.writes.push(`ask ${id}: ${questions.map((q) => q.header).join(', ')}`);
      const found = state.tasks.find((t) => t.id === id);
      if (found) Object.assign(found, { status: 'needs-me', openQuestion: true });
    },
    async runInbox(id) {
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new BackendError(`run-inbox: no task ${id}`, 404, true);
      if (found.status !== 'running') throw new BackendError(`run-inbox: the task is ${found.status}`, 409, true);
      const inbox = state.inboxes.get(id) ?? { stop: false, messages: [] };
      return { ...inbox, messages: [...inbox.messages] };
    },
    async ackMessages(id, ack) {
      state.writes.push(`ack ${id}: ${ack.ids.join(',')}${ack.stop === true ? ' stop' : ''}`);
      const inbox = state.inboxes.get(id) ?? { stop: false, messages: [] };
      state.inboxes.set(id, {
        stop: ack.stop === true ? false : inbox.stop,
        ...(ack.stop === true || inbox.stopMessage === undefined ? {} : { stopMessage: inbox.stopMessage }),
        messages: inbox.messages.filter((message) => !ack.ids.includes(message.id)),
      });
    },
    async stopped(id, text) {
      state.writes.push(`stopped ${id}: ${text}`);
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      if (found.status === 'running') Object.assign(found, { status: 'needs-me' });
      return { ...found };
    },
    async readNotes(id) {
      return state.notes.get(id) ?? [];
    },
    async addSchedule(draft) {
      state.writes.push(
        `add-schedule ${draft.title} | ${draft.input} | ${draft.everyMs ?? (draft.after ? 'after' : `${draft.cron} ${draft.timezone}`)}` +
          `${draft.startAt ? ` | start ${draft.startAt.toISOString()}` : ''}${draft.times ? ` | times ${draft.times}` : ''}` +
          `${draft.until ? ` | until ${draft.until.toISOString()}` : ''}${draft.machine ? ` | ${draft.machine}:${draft.workdir}` : ''}` +
          `${draft.model ? ` | model ${draft.model}` : ''}${draft.effort ? ` | effort ${draft.effort}` : ''}${draft.icon ? ` | icon ${draft.icon}` : ''}${draft.lane ? ` | lane ${draft.lane}` : ''}${draft.agent ? ` | agent ${draft.agent}` : ''}${draft.autoDone ? ' | auto-done' : ''}` +
          `${draft.moreCrons ? ` | more ${draft.moreCrons.join(' ; ')}` : ''}` +
          `${draft.after ? ` | after ${draft.after.scheduleId} +${draft.after.delayMs ?? 0}` : ''}` +
          `${draft.maxConcurrent ? ` | max ${draft.maxConcurrent}` : ''}`,
      );
      const pending = draft.after
        ? null
        : task({
            id: 'pending',
            title: draft.title,
            input: draft.input,
            model: draft.model ?? null,
            effort: draft.effort ?? null,
            icon: draft.icon ?? null,
            requestedLane: draft.lane ?? null,
            autoDone: draft.autoDone ?? false,
            agent: draft.agent ?? null,
            machine: draft.machine ?? null,
            workdir: draft.workdir ?? null,
            notBefore: draft.startAt ?? new Date('2027-01-01T08:00:00Z'),
            scheduleId: 'sched',
          });
      const added = schedule({
        id: 'sched',
        title: draft.title,
        input: draft.input,
        model: draft.model ?? null,
        effort: draft.effort ?? null,
        icon: draft.icon ?? null,
        requestedLane: draft.lane ?? null,
        autoDone: draft.autoDone ?? false,
        agent: draft.agent ?? null,
        everyMs: draft.everyMs ?? null,
        cron: draft.cron ?? null,
        ...(draft.moreCrons ? { moreCrons: draft.moreCrons } : {}),
        timezone: draft.timezone ?? null,
        after: draft.after ? { scheduleId: draft.after.scheduleId, delayMs: draft.after.delayMs ?? 0 } : null,
        maxConcurrent: draft.maxConcurrent ?? null,
        nextRunAt: pending?.notBefore ?? null,
        occurrenceTaskId: pending?.id ?? null,
        remaining: draft.times === undefined ? null : draft.times - (pending === null ? 0 : 1),
      });
      state.schedules.push(added);
      return { schedule: added, task: pending };
    },
    async listSchedules() {
      return state.schedules.map((s) => ({ ...s }));
    },
    async updateSchedule(id, patch) {
      state.writes.push(`${patch.paused ? 'pause' : 'resume'}-schedule ${id}`);
      const found = state.schedules.find((s) => s.id === id);
      if (!found) throw new BackendError(`no schedule ${id}`, 404);
      Object.assign(found, patch);
      return { ...found };
    },
    async editSchedule(id, edit) {
      const found = state.schedules.find((s) => s.id === id);
      if (!found) throw new BackendError(`no schedule ${id}`, 404);
      if (found.ended) throw new BackendError('The schedule has ended.', 409);
      const { settings, ...text } = edit;
      state.writes.push(`edit-schedule ${id}: ${edit.title} | ${edit.input}`);
      if (settings !== undefined) state.writes.push(`edit-schedule ${id} settings: ${JSON.stringify(settings)}`);
      const wasAfter = found.after !== null;
      Object.assign(found, text, settings === undefined ? {} : withScheduleSettings(found, settings));
      const card = state.tasks.find((t) => t.id === found.occurrenceTaskId);
      if (settings !== undefined && 'after' in settings.repeat && !wasAfter && card !== undefined) {
        state.tasks = state.tasks.filter((t) => t !== card);
        found.occurrenceTaskId = null;
        return { schedule: { ...found }, pending: 'removed' };
      }
      if (settings !== undefined && !('after' in settings.repeat) && wasAfter && card === undefined) {
        found.occurrenceTaskId = `${found.id}-next`;
        return { schedule: { ...found }, pending: 'created' };
      }
      if (card === undefined) return { schedule: { ...found }, pending: 'none' };
      const editable = card.status === 'todo' && !card.closed && card.lastActiveAt === null && card.sessionId === null;
      if (editable) Object.assign(card, text);
      return { schedule: { ...found }, pending: editable ? 'updated' : 'started' };
    },
    async removeSchedule(id) {
      state.writes.push(`remove-schedule ${id}`);
      state.schedules = state.schedules.filter((s) => s.id !== id);
    },
    // The fake keeps heads as they are, so a test reads them as written.
    async indexHead(sha) {
      return sha;
    },
  };
  return state;
}

export interface FakeRunFiles extends RunFiles {
  runs: Map<string, RunRecord>;
  alive: Map<string, Date>;
  pauses: Map<string, Date>;
  cwds: Map<string, string>;
  agents: Map<string, string>;
  groups: Map<string, number>;
  dispatchTick: Date | undefined;
  next: Date | undefined;
}

// RunFiles in memory.
export function fakeRunFiles(now: () => Date = () => new Date()): FakeRunFiles {
  const files: FakeRunFiles = {
    dir: '/run/test/agent-board',
    runs: new Map(),
    alive: new Map(),
    pauses: new Map(),
    cwds: new Map(),
    agents: new Map(),
    groups: new Map(),
    dispatchTick: undefined,
    next: undefined,
    writeRun: (id, record) => void files.runs.set(id, record),
    readRun: (id) => files.runs.get(id),
    lastActive: (id) => files.alive.get(id),
    touchAlive: (id, at = now()) => void files.alive.set(id, at),
    writeCwd: (id, cwd) => void files.cwds.set(id, cwd),
    lastCwd: (id) => files.cwds.get(id),
    agentsPath: (id) => `/run/test/agent-board/${id}.agents`,
    writeAgents: (id, content) => void files.agents.set(id, content),
    writeProcessGroup: (id, pgid) => void files.groups.set(id, pgid),
    processGroup: (id) => files.groups.get(id),
    lastDispatchTick: () => files.dispatchTick,
    markDispatchTick: (at) => void (files.dispatchTick = at),
    nextDue: () => files.next,
    writeNextDue: (at) => void (files.next = at),
    requestPause: (id) => void files.pauses.set(id, now()),
    pauseRequestedAt: (id) => files.pauses.get(id),
    clear(id) {
      files.runs.delete(id);
      files.alive.delete(id);
      files.pauses.delete(id);
      files.cwds.delete(id);
      files.agents.delete(id);
      files.groups.delete(id);
    },
  };
  return files;
}

// A data key for the tests' board, and the owner the "server" reports.
export const OWNER = 'alice';
export const DATA_KEY = generateDataKey();
export const KEYS = await deriveKeys(DATA_KEY, OWNER, { index: true });

const seals: Sealer = async ({ field, context }, text) => seal(KEYS, field, context, text);

// A task as the server stores it: title, input and workdir sealed with the test key, for the task's own row (an occurrence's
// for its schedule).
export async function wireTask(overrides: Partial<Task> & { id: string }): Promise<WireTask> {
  const {
    labels: _labels,
    unreadable: _unreadable,
    title,
    input,
    workdir,
    agent,
    prs,
    watches,
    watchEvents,
    ...rest
  } = task(overrides);
  const sealed = await sealFields(
    seals,
    {
      kind: 'task',
      id: rest.id,
      createdBy: rest.createdBy,
      scheduleId: rest.scheduleId,
      agent: agent ?? null,
      forkOf: rest.forkOf ?? null,
    },
    { title, input, workdir: workdir ?? undefined },
  );
  const wirePrs = await Promise.all(
    prs.map(async ({ id, url, state }) => ({ id, pr: await sealPr(seals, rest.id, url), state })),
  );
  const newest = wirePrs.at(-1);
  const { promptPrState, ...others } = rest;
  return {
    ...others,
    ...sealed,
    workdir: sealed.workdir ?? null,
    pr: newest?.pr ?? null,
    prState: newest === undefined ? promptPrState : newest.state,
    prs: wirePrs,
    promptPrState,
    watches: watches === null ? null : await sealWatches(seals, rest.id, watches, watchEvents),
  };
}

export async function wireSchedule(overrides: Partial<Schedule> & { id: string }): Promise<WireSchedule> {
  const { unreadable: _unreadable, title, input, workdir, agent, ...rest } = schedule(overrides);
  const sealed = await sealFields(
    seals,
    { kind: 'schedule', id: rest.id, agent: agent ?? null },
    { title, input, workdir: workdir ?? undefined },
  );
  return { ...rest, ...sealed, workdir: sealed.workdir ?? null };
}

// The logs and session records of tasks on this machine, in memory.
export function fakeTaskFiles(initial: TaskFile[] = []): TaskFileStore & { files: TaskFile[] } {
  const files = [...initial];
  return {
    files,
    list: () => [...files],
    remove: ({ kind, taskId }) => {
      const at = files.findIndex((file) => file.kind === kind && file.taskId === taskId);
      if (at >= 0) files.splice(at, 1);
    },
  };
}

// Worktree locks in memory: every directory counts as a linked worktree of its own. `held` maps a task to its directories.
export function fakeWorktreeLocks(
  initial: Record<string, string[]> = {},
): WorktreeLocks & { held: Map<string, string[]>; calls: string[] } {
  const held = new Map(Object.entries(initial).map(([id, dirs]) => [id, [...dirs]]));
  const calls: string[] = [];
  return {
    held,
    calls,
    hold(taskId, dir) {
      calls.push(`hold ${taskId} ${dir}`);
      const dirs = held.get(taskId) ?? [];
      if (dirs.includes(dir)) return undefined;
      held.set(taskId, [...dirs, dir]);
      return `locked the worktree ${dir} for this task`;
    },
    release(taskId, keep) {
      calls.push(`release ${taskId}${keep === undefined ? '' : ` ${keep}`}`);
      const dirs = held.get(taskId) ?? [];
      const left = dirs.filter((dir) => dir === keep);
      if (left.length > 0) held.set(taskId, left);
      else held.delete(taskId);
      return dirs.filter((dir) => dir !== keep).map((dir) => `unlocked the worktree ${dir}`);
    },
    tasks: () => [...held.keys()],
  };
}

// The sessions a worker has started, in memory.
export interface FakeSessions extends SessionStore {
  recorded: [string, string][];
}

export function fakeSessions(known: [string, string][] = []): FakeSessions {
  const recorded = [...known];
  return {
    recorded,
    has: (taskId, sessionId) => recorded.some(([id, session]) => id === taskId && session === sessionId.toLowerCase()),
    record: (taskId, sessionId) => {
      for (let index = recorded.length - 1; index >= 0; index -= 1)
        if (recorded[index]?.[0] === taskId) recorded.splice(index, 1);
      recorded.push([taskId, sessionId.toLowerCase()]);
    },
  };
}

// The credentials file of a machine that holds the test board's data key.
export const ENV_FILE = `AGENT_BOARD_TOKEN=abm_secret\nAGENT_BOARD_DATA_KEY=${encodeDataKey(DATA_KEY)}\n`;

// What the test board's `version` answers.
export const VERSION_ANSWER = {
  contract: LEGACY_CONTRACT,
  owner: OWNER,
  keyId: KEYS.keyId,
  api: { version: API_VERSION, minClient: MIN_CLIENT },
  features: [...SERVER_FEATURES],
};

// What verifying the test board returns: whose board it is, and the API range it speaks.
export const SERVER_API = { version: API_VERSION, minClient: MIN_CLIENT };
export const SERVER_HAS = new Set<string>(SERVER_FEATURES);

export const SESSION = '11111111-1111-4111-8111-111111111111';
export const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';

// A task's link as the CLI builds it from the board URL of its own web.json.
export const linkTo = (id: string): string => `https://board.test/t/${id}`;

// What the machine learned of its directories' skills and models, in memory.
export function fakeCatalogStore(): CatalogStore & {
  entries: Map<string, CatalogEntry>;
  inits: Map<string, InitRecord>;
} {
  const entries = new Map<string, CatalogEntry>();
  const inits = new Map<string, InitRecord>();
  return {
    entries,
    inits,
    read: (dir) => entries.get(dir),
    write: (entry) => void entries.set(entry.path, structuredClone(entry)),
    readInit: (dir) => inits.get(dir),
    writeInit: (dir, record) => void inits.set(dir, structuredClone(record)),
    initSkills: () => new Set([...inits.values()].flatMap(({ skills }) => skills)),
  };
}

// The checks of waiting tasks, in memory.
export function fakeWaitStore(initial: Record<string, WaitCheck> = {}): WaitStore & { checks: Map<string, WaitCheck> } {
  const checks = new Map(Object.entries(initial));
  return {
    checks,
    write: (taskId, check) => void checks.set(taskId, { ...check }),
    read: (taskId) => {
      const check = checks.get(taskId);
      return check === undefined ? undefined : { ...check };
    },
    remove: (taskId) => void checks.delete(taskId),
    list: () => [...checks.keys()],
  };
}

// The GitHub half that looks up PR states, for a test that is about something else: it knows no PR.
export const NO_PR_STATES = { prStates: async () => ({ states: new Map(), unreadable: [] }) };

// What the CLI remembers about updates, in memory: when the hint was last shown and until when no self-update is tried.
export function fakeUpdateState(
  initial: { shown?: Date; deferred?: Date } = {},
): UpdateState & { shown: Date | undefined; deferred: Date | undefined } {
  const state = {
    shown: initial.shown,
    deferred: initial.deferred,
    hintShownAt: () => state.shown,
    markHintShown: (at: Date) => {
      state.shown = at;
    },
    retryAfter: () => state.deferred,
    deferUpdateUntil: (at: Date) => {
      state.deferred = at;
    },
    clearDeferral: () => {
      state.deferred = undefined;
    },
  };
  return state;
}
