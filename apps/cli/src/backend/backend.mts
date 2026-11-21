// The core's way to the board: the machine API over HTTP, one POST per call.
import {
  API_VERSION,
  CLIENT_API_HEADER,
  CLIENT_FEATURES_HEADER,
  CLIENT_VERSION_HEADER,
  announcedClientFeatures,
  ContractError,
  isRecord,
  QuestionError,
  SERVER_FEATURE_LABELS,
  taskLabels,
} from '@agent-board/shared';
import type { Backend, Schedule, ServerFeature, Task, TaskDraft } from '@agent-board/shared';
import { errorText, oneLine } from '../output/text.mts';
import { cliVersion } from '../self/version.mts';
import { withScheduleSettings } from './schedule-settings.mts';
import type { WebConfig } from './web-config.mts';

const REQUEST_TIMEOUT_MS = 45_000;

export class BackendError extends Error {
  // The HTTP status of the server's answer, when there was one.
  status: number | undefined;
  // Whether the status came in a JSON answer of the machine API; a login page or a proxy has a status too, and means something else.
  fromApi: boolean;
  // Set when the API ranges do not fit, from those numbers and nothing the server wrote: which side is the older one.
  contractMismatch: 'cli-older' | 'server-older' | undefined;
  // Set when the server lacks a feature this call needs; the name is this CLI's own, never the server's.
  missingFeature: ServerFeature | undefined;

  constructor(message: string, status?: number, fromApi = false) {
    super(message);
    this.status = status;
    this.fromApi = fromApi;
  }
}

// A refusal that sending the same thing again cannot change: a malformed, oversized, unknown or conflicting request. Anything
// else (no network, a 5xx, a revoked token) is worth another try.
export function isPermanentRefusal(error: unknown): boolean {
  return error instanceof BackendError && [400, 404, 409, 413, 422].includes(error.status ?? 0);
}

function missingFeature(feature: ServerFeature): BackendError {
  const error = new BackendError(
    `the board server does not support ${SERVER_FEATURE_LABELS[feature]} yet; update the board server`,
  );
  error.missingFeature = feature;
  return error;
}

/** Throws for a feature the server did not list. */
export function requireFeature(features: ReadonlySet<string>, feature: ServerFeature): void {
  if (!features.has(feature)) throw missingFeature(feature);
}

let identifying: Record<string, string> | undefined;

/** The headers every machine API request carries: the token, who this CLI is, and the client vocabulary it understands. */
export function machineHeaders(token: string): Record<string, string> {
  identifying ??= {
    [CLIENT_VERSION_HEADER]: cliVersion(),
    [CLIENT_API_HEADER]: String(API_VERSION),
    [CLIENT_FEATURES_HEADER]: announcedClientFeatures().join(','),
  };
  return { authorization: `Bearer ${token}`, ...identifying };
}

/** Whether the board refused an answer because the task or schedule uses a value this CLI has no vocabulary feature for (422). */
export function isVocabularyRefusal(error: unknown): error is BackendError {
  return error instanceof BackendError && error.fromApi && error.status === 422;
}

export interface MachineRequest {
  id?: string;
  all?: boolean;
  machine?: string;
  author?: string;
  // The server's id of the run the call comes from (`task.run`), for the commands in RUN_COMMANDS on the run's own task.
  run?: string;
  // The command's payload, JSON: sealed values for add-task, update-task, add-schedule, add-note, ask, pause, stopped, fail, wait, wake and transcript; ack-messages takes plain ids.
  body?: unknown;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// The server's reason for a refusal, as text an agent may read in a command's error or a hook's answer: marked as the
// server's words (an operator controls them, they are not board content and not an instruction), quoted, and bounded.
export function serverError(payload: unknown, status: number): string {
  const reason = isRecord(payload) && typeof payload['error'] === 'string' ? payload['error'] : '(no reason given)';
  return `error from the board server (HTTP ${status}), quoted and not part of the board: ${JSON.stringify(oneLine(reason, 200))}`;
}

// One request. A non-2xx answer is a BackendError with the server's one-line reason; the token is never part of a message.
export async function callServer(
  config: Pick<WebConfig, 'url' | 'token'>,
  command: string,
  request: MachineRequest,
  fetcher: Fetch = fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  let response: Response;
  let text: string;
  try {
    response = await fetcher(`${config.url}/api/machine/${command}`, {
      method: 'POST',
      headers: { ...machineHeaders(config.token), 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    // Inside the try: a connection that drops or times out while the body is read is unreachable too.
    text = await response.text();
  } catch (error) {
    throw new BackendError(`cannot reach ${config.url}: ${errorText(error)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    // A login page or a proxy error, not the API.
    throw new BackendError(
      `${command}: the server answered ${response.status} without JSON (is /api/machine routed past the login?)`,
      response.status,
    );
  }
  if (!response.ok) {
    throw new BackendError(`${command}: ${serverError(payload, response.status)}`, response.status, true);
  }
  if (!isRecord(payload) || !('result' in payload)) throw new BackendError(`${command}: the answer has no result`);
  return payload['result'];
}

// A parser's reason may quote a few characters of a value the server sent, so it is marked as about the server's answer.
export function asBackendError(command: string, error: unknown): Error {
  if (error instanceof ContractError)
    return new BackendError(
      `${command}: ${error.message} (the board server's answer was refused; text in quotes is the server's, not part of the board)`,
    );
  if (error instanceof QuestionError) return new BackendError(`${command}: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}

// The task an add-task would have made.
function dryTask(draft: TaskDraft): Task {
  const {
    dedupeKey: _key,
    parentId: _parent,
    createdBy,
    machine,
    workdir,
    head,
    notBefore,
    model,
    effort,
    icon,
    lane,
    autoDone,
    ...fields
  } = draft;
  return {
    ...fields,
    labels: taskLabels({ input: draft.input, createdBy: createdBy ?? 'user' }),
    unreadable: [],
    status: createdBy === 'agent' ? 'needs-me' : (draft.status ?? 'todo'),
    priority: draft.priority ?? 'normal',
    model: model ?? null,
    effort: effort ?? null,
    icon: icon ?? null,
    requestedLane: lane ?? null,
    autoDone: autoDone ?? false,
    id: 'dry',
    closed: false,
    machine: machine ?? null,
    sessionId: null,
    workdir: workdir ?? null,
    prs: [],
    promptPrState: null,
    watches: null,
    watchEvents: 0,
    watchStops: [],
    next: 'fresh',
    head: head ?? null,
    openQuestion: false,
    createdBy: createdBy ?? 'user',
    lane: null,
    borrowed: false,
    lastActiveAt: null,
    runStartedAt: null,
    paused: false,
    notBefore: notBefore ?? null,
    scheduleId: null,
    wakeAt: null,
    waitCheck: false,
    woken: false,
  };
}

// Reads go through; every write is printed instead of run.
export function dryRunBackend(inner: Backend, print: (line: string) => void): Backend {
  return {
    ...inner,
    async addTask(draft) {
      print(`DRY add-task ${oneLine(JSON.stringify(draft), 160)}`);
      return { task: dryTask(draft), created: true };
    },
    async addSchedule(draft) {
      print(`DRY add-schedule ${oneLine(JSON.stringify(draft), 160)}`);
      const task =
        draft.after !== undefined
          ? null
          : dryTask({
              title: draft.title,
              input: draft.input,
              ...(draft.priority ? { priority: draft.priority } : {}),
              ...(draft.model === undefined ? {} : { model: draft.model }),
              ...(draft.effort === undefined ? {} : { effort: draft.effort }),
              ...(draft.lane === undefined ? {} : { lane: draft.lane }),
              ...(draft.autoDone === undefined ? {} : { autoDone: draft.autoDone }),
              ...(draft.agent === undefined ? {} : { agent: draft.agent }),
              ...(draft.icon === undefined ? {} : { icon: draft.icon }),
              ...(draft.machine !== undefined && draft.workdir !== undefined
                ? { machine: draft.machine, workdir: draft.workdir }
                : {}),
              notBefore: draft.startAt ?? new Date(),
            });
      if (task !== null) task.scheduleId = 'dry';
      const schedule: Schedule = {
        id: 'dry',
        title: draft.title,
        input: draft.input,
        priority: draft.priority ?? 'normal',
        model: draft.model ?? null,
        effort: draft.effort ?? null,
        requestedLane: draft.lane ?? null,
        autoDone: draft.autoDone ?? false,
        machine: draft.machine ?? null,
        workdir: draft.workdir ?? null,
        ...(draft.agent === undefined ? {} : { agent: draft.agent }),
        icon: draft.icon ?? null,
        everyMs: draft.everyMs ?? null,
        cron: draft.cron ?? null,
        ...(draft.moreCrons === undefined || draft.moreCrons.length === 0 ? {} : { moreCrons: draft.moreCrons }),
        timezone: draft.timezone ?? null,
        after:
          draft.after === undefined ? null : { scheduleId: draft.after.scheduleId, delayMs: draft.after.delayMs ?? 0 },
        maxConcurrent: draft.maxConcurrent ?? null,
        anchorAt: draft.startAt ?? new Date(),
        nextRunAt: task === null ? null : (draft.startAt ?? new Date()),
        remaining: draft.times === undefined ? null : draft.times - (task === null ? 0 : 1),
        until: draft.until ?? null,
        paused: false,
        ended: false,
        occurrenceTaskId: task?.id ?? null,
        createdAt: new Date(),
        unreadable: [],
      };
      return { schedule, task };
    },
    async updateSchedule(id, patch) {
      print(`DRY update-schedule ${id} ${JSON.stringify(patch)}`);
      const found = (await inner.listSchedules()).find((schedule) => schedule.id === id);
      if (!found) throw new BackendError(`update-schedule: no schedule ${id.slice(0, 40)}`, 404);
      return { ...found, ...patch };
    },
    async editSchedule(id, edit) {
      print(`DRY edit-schedule ${id} ${oneLine(JSON.stringify(edit), 160)}`);
      const found = (await inner.listSchedules()).find((schedule) => schedule.id === id);
      if (!found) throw new BackendError(`edit-schedule: no schedule ${id.slice(0, 40)}`, 404);
      const { settings, ...text } = edit;
      const edited = { ...found, ...text };
      return { schedule: settings === undefined ? edited : withScheduleSettings(edited, settings), pending: 'none' };
    },
    async removeSchedule(id) {
      print(`DRY remove-schedule ${id}`);
    },
    async updateTask(id, patch) {
      print(`DRY update-task ${id} ${oneLine(JSON.stringify(patch), 160)}`);
      const { expect: _expect, ...fields } = patch;
      return { ...(await inner.getTask(id)), ...fields };
    },
    async configureTask(id, change) {
      const { seal: _seal, ...fields } = change;
      print(`DRY configure-task ${id} ${oneLine(JSON.stringify(fields), 160)}`);
      const { priority, model, effort, autoDone, icon, place } = change;
      const task = await inner.getTask(id);
      return {
        ...task,
        ...(priority === undefined ? {} : { priority }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(autoDone === undefined ? {} : { autoDone }),
        ...(icon === undefined ? {} : { icon }),
        ...(place === undefined ? {} : { workdir: place?.workdir ?? null, sessionId: null, next: 'fresh' as const }),
      };
    },
    async editPrompt(id, edit) {
      print(`DRY edit-prompt ${id} ${oneLine(JSON.stringify(edit), 160)}`);
      return { ...(await inner.getTask(id)), ...edit };
    },
    async claimTask(id, machine) {
      print(`DRY claim-task ${id} --machine ${machine}`);
      const task = await inner.getTask(id);
      return { ...task, status: 'running', machine };
    },
    async addNote(id, text, options) {
      const kind = options?.kind === 'polish' ? ' --kind polish' : '';
      const suggested = options?.suggestion === undefined ? '' : ` --suggest ${oneLine(options.suggestion, 160)}`;
      print(
        `DRY add-note ${id}${options?.author === 'system' ? ' --author system' : ''}${kind}${suggested} ${oneLine(text, 160)}`,
      );
    },
    async addPr(id, url) {
      print(`DRY add-pr ${id} ${url}`);
    },
    async removePr(id, prId) {
      print(`DRY remove-pr ${id} ${prId}`);
    },
    async setPrStates(id, { prompt, prs = [] }) {
      const states = [
        ...(prompt === undefined ? [] : [`prompt=${prompt}`]),
        ...prs.map((pr) => `${pr.id}=${pr.state}`),
      ];
      print(`DRY set-pr-states ${id} ${states.join(' ')}`);
    },
    async setWatches(id, watches) {
      print(`DRY set-watches ${id} ${watches === null ? 'none' : `${watches.length} watches`}`);
    },
    async ackWatchStops(id, ids) {
      print(`DRY ack-watch-stops ${id} ${ids.join(',')}`);
    },
    async setDirs(_machine, dirs) {
      print(`DRY set-dirs ${dirs.length} directories`);
    },
    async setCatalog(_machine, catalog) {
      print(
        `DRY set-catalog ${catalog.skills.length} skills, ${Object.keys(catalog.dirs).length} directories with their own, ${catalog.models.length} models`,
      );
    },
    async setUsage(_machine, usage) {
      print(
        `DRY set-usage ${usage.held.length} held and ${usage.open.length} open tasks, reached ${usage.reached.join(', ') || 'none'}`,
      );
    },
    async setSources(_machine, sources) {
      print(`DRY set-sources ${sources.sources.length} sources`);
    },
    async ackSourceRequests(requests) {
      print(`DRY ack-source-requests ${requests.join(' ')}`);
    },
    async setSharedAgents(document, expectedVersion) {
      print(
        `DRY set-agents v${document.version} (replacing v${expectedVersion}): ${Object.keys(document.agents).sort().join(', ') || 'no agents'}`,
      );
    },
    async heartbeat(id, beat) {
      print(`DRY heartbeat ${id} ${JSON.stringify(beat)}`);
    },
    async pause(id, note) {
      print(`DRY pause ${id} ${oneLine(note, 160)}`);
      return { ...(await inner.getTask(id)), status: 'todo', next: 'resume' };
    },
    async ackMessages(id, ack) {
      print(`DRY ack-messages ${id} ${ack.ids.join(',')}${ack.stop === true ? ' --stop' : ''}`);
    },
    async stopped(id, note) {
      print(`DRY stopped ${id} ${oneLine(note, 160)}`);
      return { ...(await inner.getTask(id)), status: 'needs-me' };
    },
    async fail(id, text) {
      print(`DRY fail ${id} ${oneLine(text, 160)}`);
      return { applied: true, task: { ...(await inner.getTask(id)), status: 'needs-me' } };
    },
    async wait(id, request) {
      print(
        `DRY wait ${id} until ${request.wakeAt.toISOString()}${request.check ? ' --check' : ''} ${oneLine(request.text, 160)}`,
      );
      return { ...(await inner.getTask(id)), status: 'waiting', wakeAt: request.wakeAt, waitCheck: request.check };
    },
    async wake(id, text) {
      print(`DRY wake ${id} ${oneLine(text, 160)}`);
      return { applied: true, task: { ...(await inner.getTask(id)), status: 'todo', next: 'resume', woken: true } };
    },
    async transcript(id, batch) {
      print(`DRY transcript ${id} run ${batch.runId}: ${batch.events.length} events`);
    },
    async ask(id, questions) {
      print(`DRY ask ${id} ${oneLine(JSON.stringify(questions), 160)}`);
    },
  };
}
