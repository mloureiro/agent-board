/**
 * The machine API, for the CLI on the worker machines: POST /api/machine/<command> with a bearer token.
 * The body carries the command's arguments; the answer is {result} or {error}.
 */
import {
  API_VERSION,
  CLIENT_API_HEADER,
  CLIENT_FEATURES_HEADER,
  CLIENT_VERSION_HEADER,
  ContractError,
  findUnknownVocabulary,
  isRecord,
  isSafeMachineName,
  isSafeRunId,
  isSafeTaskId,
  LEGACY_CONTRACT,
  MIN_CLIENT,
  parseClientApi,
  parseAckMessages,
  parseClientFeatures,
  parseClientVersion,
  parseHeartbeat,
  parseSchedulePatch,
  parseWireAsk,
  parseWireCatalog,
  parseWireDirs,
  parseWireNoteInput,
  parseWirePr,
  parseWirePrRemoval,
  parseWirePrState,
  parseWirePrStates,
  parseWireWatches,
  parseWireWatchStopAck,
  parseWirePromptEdit,
  parseWireScheduleDraft,
  parseWireSetAgents,
  parseWireTitleRuleApply,
  parseWireScheduleEdit,
  parseWireTaskConfig,
  parseWireTaskDraft,
  parseWireTaskPatch,
  parseWireTranscriptBatch,
  parseWireUsage,
  parseWireFeeds,
  parseWireFeedRequestAck,
  parseWireWait,
  TranscriptError,
  SERVER_FEATURES,
  serializeSchedule,
  serializeWireNote,
} from '@agent-board/shared';
import type { VocabularyFeatures, VocabularyItem, WireSchedule, WireScheduleSettings } from '@agent-board/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from './config';
import type { Db, DbOrTx } from './db/client';
import { withOwner } from './db/scope';
import type { Changes } from './services/changes';
import { AppError } from './services/errors';
import { getKeys } from './services/keys';
import {
  machineCatalogIndex,
  machineDirsIndex,
  machineForToken,
  machineUsageIndex,
  machineFeedsState,
  ackFeedRequests,
  recordClient,
  setMachineCatalog,
  setMachineDirs,
  setMachineUsage,
  setMachineFeeds,
} from './services/machines';
import {
  addSchedule,
  editSchedule,
  heldTaskIds,
  listSchedules,
  removeSchedule,
  setPaused,
  toSchedule,
  updateSchedule,
} from './services/schedules';
import type { ScheduleUpdate } from './services/schedules';
import { getSharedAgents, setSharedAgents, sharedAgentsVersion } from './services/sharedAgents';
import { getTitleRules } from './services/titleRules';
import { appendTranscript } from './services/transcripts';
import {
  ackMessages,
  addNote,
  addTask,
  applyTitleRule,
  ask,
  attachSession,
  claimTask,
  configureTask,
  editPrompt,
  failTask,
  getTask,
  heartbeat,
  listTasks,
  pause,
  readNotes,
  runInbox,
  ackWatchStops,
  addPr,
  removePr,
  countTaskNotes,
  listTaskPrs,
  setPr,
  setPrState,
  setPrStates,
  setWatches,
  stopped,
  toNote,
  toTask,
  updateTask,
  wait,
  wake,
} from './services/tasks';

function idOf(body: Record<string, unknown>, what: 'task' | 'schedule'): string {
  const id = body['id'];
  if (typeof id !== 'string' || !isSafeTaskId(id)) throw new AppError('BAD_REQUEST', `a valid ${what} id is required`);
  return id;
}

/** The run a call comes from, when it names one: a worker or agent on a server with `task.run`. */
function runOf(body: Record<string, unknown>): string | undefined {
  const run = body['run'];
  if (run === undefined) return undefined;
  if (!isSafeRunId(run)) throw new AppError('BAD_REQUEST', 'run must be a run id');
  return run;
}

/** Contract and transcript errors are the caller's fault: 400 with the parser's reason. */
function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ContractError || error instanceof TranscriptError)
      throw new AppError('BAD_REQUEST', error.message);
    throw error;
  }
}

type MachineIdentity = NonNullable<Awaited<ReturnType<typeof machineForToken>>>;

declare module 'fastify' {
  interface FastifyRequest {
    /** The machine behind the bearer token of a /api/machine/* request, set before the body is read. */
    machineAuth: { identity: MachineIdentity; token: string } | null;
  }
}

/** Plenty for every command but `transcript`: the largest sealed fields (a task's input, a note's body) are about 1 MiB as envelopes. */
const MACHINE_BODY_LIMIT = 2 * 1024 * 1024;
/** A transcript batch can carry a few large tool results. */
const TRANSCRIPT_BODY_LIMIT = 16 * 1024 * 1024;

/** A schedule that runs after another is not for a CLI that did not announce `schedule.after`: its parser reads one of everyMs and cron. */
function isHiddenSchedule(schedule: Pick<WireSchedule, 'after'>, clientFeatures: ReadonlySet<string>): boolean {
  return schedule.after !== null && !clientFeatures.has('schedule.after');
}

/** What a client that sent these features can be shown: an item with an enum value it has no feature for is left out. */
function knownTo(clientFeatures: ReadonlySet<string>, vocabulary: VocabularyFeatures | undefined) {
  const unknownTo = (item: VocabularyItem) => findUnknownVocabulary(item, clientFeatures, vocabulary);
  return {
    /** A list of schedules also leaves out those that run after another, for a client that cannot parse them. */
    onlySchedules: (items: WireSchedule[]): WireSchedule[] =>
      items.filter((item) => unknownTo(item) === undefined && !isHiddenSchedule(item, clientFeatures)),
    /** A single schedule the client cannot read is a refusal, like `one`. */
    oneSchedule: (item: WireSchedule): WireSchedule => {
      if (isHiddenSchedule(item, clientFeatures))
        throw new AppError(
          'UNPROCESSABLE',
          'this schedule runs after another schedule, which this CLI does not know; update the CLI',
        );
      return item;
    },
    /** A list leaves out what the client cannot read. */
    only: <T extends VocabularyItem>(items: T[]): T[] => items.filter((item) => unknownTo(item) === undefined),
    /** A single object the client cannot read is a refusal, and the write behind it rolls back with the request. */
    one: <T extends VocabularyItem>(item: T, what: 'task' | 'schedule'): T => {
      const unknown = unknownTo(item);
      if (unknown !== undefined)
        throw new AppError(
          'UNPROCESSABLE',
          `this ${what} uses ${unknown.field} ${JSON.stringify(unknown.value)}, which this CLI does not know; update the CLI`,
        );
      return item;
    },
  };
}

async function handleMachineCall(
  db: DbOrTx,
  config: Config,
  identity: MachineIdentity,
  command: string,
  body: Record<string, unknown>,
  client: { features: ReadonlySet<string>; vocabulary?: VocabularyFeatures } = { features: new Set() },
): Promise<unknown> {
  const machine = identity.name;
  const visible = knownTo(client.features, client.vocabulary);
  const task = async (row: Parameters<typeof toTask>[0]) =>
    visible.one(
      toTask(row, (await listTaskPrs(db, [row.id])).get(row.id), {
        noteCount: (await countTaskNotes(db, [row.id])).get(row.id) ?? 0,
        held: (await heldTaskIds(db, [row])).has(row.id),
      }),
      'task',
    );
  const schedule = (row: Parameters<typeof toSchedule>[0]) =>
    visible.oneSchedule(visible.one(toSchedule(row), 'schedule'));
  switch (command) {
    case 'version':
      return {
        // A CLI up to 0.7.0 compares this exactly: once a break raises MIN_CLIENT above it, it must stop those CLIs too.
        contract: Math.max(LEGACY_CONTRACT, MIN_CLIENT),
        owner: identity.owner,
        keyId: (await getKeys(db))?.keyId ?? null,
        api: { version: API_VERSION, minClient: MIN_CLIENT },
        features: SERVER_FEATURES,
        dirsIndex: await machineDirsIndex(db, machine),
        catalogIndex: await machineCatalogIndex(db, machine),
        usageIndex: await machineUsageIndex(db, machine),
        ...(await machineFeedsState(db, machine).then(({ index, requests }) => ({
          feedsIndex: index,
          feedRequests: requests,
        }))),
        agentsVersion: await sharedAgentsVersion(db),
        ...(config.cliVersion === null ? {} : { cli: config.cliVersion }),
      };
    case 'list-tasks': {
      const rows = await listTasks(db, { all: body['all'] === true });
      const prs = await listTaskPrs(
        db,
        rows.map(({ id }) => id),
      );
      const noteCounts = await countTaskNotes(
        db,
        rows.map(({ id }) => id),
      );
      const held = await heldTaskIds(db, rows);
      return visible.only(
        rows.map((row) =>
          toTask(row, prs.get(row.id), { noteCount: noteCounts.get(row.id) ?? 0, held: held.has(row.id) }),
        ),
      );
    }
    case 'get-task':
      return task(await getTask(db, idOf(body, 'task')));
    case 'attach-session':
      return task(await attachSession(db, idOf(body, 'task'), machine));
    case 'add-task': {
      const draft = parsed(() => parseWireTaskDraft(body['body']));
      const { row, created } = await addTask(db, draft);
      return { task: await task(row), created };
    }
    case 'update-task':
      return task(
        await updateTask(
          db,
          idOf(body, 'task'),
          parsed(() => parseWireTaskPatch(body['body'])),
          machine,
          runOf(body),
        ),
      );
    case 'configure-task': {
      const { place, ...config } = parsed(() => parseWireTaskConfig(body['body']));
      // A machine pins a task to itself only: the token names the machine, never the body.
      const pinned = place === undefined ? {} : { place: place === null ? null : { machine, workdir: place.workdir } };
      return task(await configureTask(db, idOf(body, 'task'), { ...config, ...pinned }, machine));
    }
    // The one place a machine stores a note of the user's: the user's own CLI edits a prompt, and refuses to inside a run.
    case 'edit-prompt': {
      const edit = parsed(() => parseWirePromptEdit(body['body']));
      return task(await editPrompt(db, { taskId: idOf(body, 'task'), ...edit, by: machine }));
    }
    case 'claim-task': {
      const id = idOf(body, 'task');
      const asMachine = body['machine'];
      if (typeof asMachine !== 'string' || !isSafeMachineName(asMachine))
        throw new AppError('BAD_REQUEST', 'machine is required');
      // A token claims for its own machine only.
      if (asMachine !== machine) throw new AppError('FORBIDDEN', `this token belongs to ${machine}, not ${asMachine}`);
      const row = await claimTask(db, id, machine);
      if (!row) throw new AppError('CONFLICT', 'the task is not free for this machine');
      return task(row);
    }
    case 'add-note': {
      const note = parsed(() => parseWireNoteInput(body['body'], 'note', { allowSuggestion: true }));
      const author = body['author'] === 'system' ? 'system' : 'agent';
      const kind = body['kind'] ?? 'comment';
      if (kind !== 'comment' && kind !== 'polish') throw new AppError('BAD_REQUEST', 'kind must be comment or polish');
      if (kind === 'polish' && author !== 'agent')
        throw new AppError('BAD_REQUEST', 'only an agent writes a polish note');
      await addNote(db, idOf(body, 'task'), {
        author,
        kind: author === 'system' ? 'event' : kind,
        body: note.body,
        preview: note.preview ?? null,
        ...(note.suggestion === undefined ? {} : { suggestion: note.suggestion }),
        by: machine,
      });
      return null;
    }
    case 'set-pr': {
      const { pr } = parsed(() => parseWirePr(body['body']));
      await setPr(db, idOf(body, 'task'), pr);
      return null;
    }
    case 'add-pr': {
      const { pr } = parsed(() => parseWirePr(body['body']));
      await addPr(db, idOf(body, 'task'), pr);
      return null;
    }
    case 'remove-pr': {
      const { pr } = parsed(() => parseWirePrRemoval(body['body']));
      await removePr(db, idOf(body, 'task'), pr);
      return null;
    }
    case 'set-pr-states': {
      const states = parsed(() => parseWirePrStates(body['body']));
      await setPrStates(db, idOf(body, 'task'), states);
      return null;
    }
    case 'set-pr-state': {
      const { prState } = parsed(() => parseWirePrState(body['body']));
      await setPrState(db, idOf(body, 'task'), prState);
      return null;
    }
    case 'set-watches': {
      const { watches } = parsed(() => parseWireWatches(body['body']));
      await setWatches(db, idOf(body, 'task'), watches, machine);
      return null;
    }
    case 'ack-watch-stops': {
      const { ids } = parsed(() => parseWireWatchStopAck(body['body']));
      await ackWatchStops(db, idOf(body, 'task'), ids, machine);
      return null;
    }
    case 'set-dirs':
      await setMachineDirs(
        db,
        machine,
        parsed(() => parseWireDirs(body['body'])),
      );
      return null;
    case 'set-catalog':
      await setMachineCatalog(
        db,
        machine,
        parsed(() => parseWireCatalog(body['body'])),
      );
      return null;
    case 'set-usage':
      await setMachineUsage(
        db,
        machine,
        parsed(() => parseWireUsage(body['body'])),
      );
      return null;
    case 'set-feeds':
      await setMachineFeeds(
        db,
        machine,
        parsed(() => parseWireFeeds(body['body'])),
      );
      return null;
    case 'ack-feed-requests':
      await ackFeedRequests(db, machine, parsed(() => parseWireFeedRequestAck(body['body'])).requests);
      return null;
    case 'get-title-rules': {
      const stored = await getTitleRules(db);
      return stored === null ? null : { version: stored.version, document: stored.document };
    }
    case 'apply-title-rule': {
      const run = runOf(body);
      if (run === undefined) throw new AppError('BAD_REQUEST', 'run is required');
      const change = parsed(() => parseWireTitleRuleApply(body['body']));
      return applyTitleRule(db, idOf(body, 'task'), change, run);
    }
    case 'get-agents':
      return getSharedAgents(db);
    case 'set-agents':
      await setSharedAgents(
        db,
        parsed(() => parseWireSetAgents(body['body'])),
      );
      return null;
    case 'ask': {
      const asked = parsed(() => parseWireAsk(body['body']));
      await ask(db, idOf(body, 'task'), asked, machine, runOf(body));
      return null;
    }
    case 'heartbeat':
      await heartbeat(
        db,
        idOf(body, 'task'),
        parsed(() => parseHeartbeat(body['body'])),
        machine,
        runOf(body),
      );
      return null;
    case 'pause': {
      const note = parsed(() => parseWireNoteInput(body['body'], 'pause note'));
      return task(await pause(db, idOf(body, 'task'), note, machine, runOf(body)));
    }
    case 'fail': {
      const note = parsed(() => parseWireNoteInput(body['body'], 'fail note'));
      const { applied, row } = await failTask(db, idOf(body, 'task'), note, machine, runOf(body));
      return { applied, task: await task(row) };
    }
    case 'wait': {
      const request = parsed(() => parseWireWait(body['body']));
      return task(await wait(db, idOf(body, 'task'), request, machine, { run: runOf(body) }));
    }
    case 'wake': {
      const note = parsed(() => parseWireNoteInput(body['body'], 'wake note'));
      const { applied, row } = await wake(db, idOf(body, 'task'), note, machine);
      return { applied, task: await task(row) };
    }
    case 'run-inbox': {
      const inbox = await runInbox(db, idOf(body, 'task'), machine, runOf(body));
      return {
        stop: inbox.stop,
        ...(inbox.stopMessage === undefined ? {} : { stopMessage: inbox.stopMessage }),
        messages: visible.only(inbox.messages.map(toNote)).map(serializeWireNote),
      };
    }
    case 'ack-messages': {
      const ack = parsed(() => parseAckMessages(body['body']));
      await ackMessages(db, idOf(body, 'task'), { ids: ack.ids, stop: ack.stop === true }, machine, runOf(body));
      return null;
    }
    case 'stopped': {
      const note = parsed(() => parseWireNoteInput(body['body'], 'stopped note'));
      return task(await stopped(db, idOf(body, 'task'), note, machine, runOf(body)));
    }
    case 'transcript':
      await appendTranscript(
        db,
        idOf(body, 'task'),
        machine,
        parsed(() => parseWireTranscriptBatch(body['body'])),
      );
      return null;
    case 'read-notes':
      return visible.only((await readNotes(db, idOf(body, 'task'))).map(toNote)).map(serializeWireNote);
    case 'add-schedule': {
      const draft = parsed(() => parseWireScheduleDraft(body['body']));
      const { schedule: created, task: pending } = await addSchedule(db, draft);
      return { schedule: serializeSchedule(schedule(created)), task: pending === null ? null : await task(pending) };
    }
    case 'list-schedules':
      return visible.onlySchedules((await listSchedules(db)).map(toSchedule)).map(serializeSchedule);
    case 'update-schedule': {
      const { paused } = parsed(() => parseSchedulePatch(body['body']));
      return serializeSchedule(schedule(await setPaused(db, idOf(body, 'schedule'), paused)));
    }
    case 'edit-schedule': {
      const { settings, ...edit } = parsed(() => parseWireScheduleEdit(body['body']));
      const id = idOf(body, 'schedule');
      const { schedule: edited, pending } =
        settings === undefined
          ? await editSchedule(db, { id, ...edit })
          : await updateSchedule(db, { id, ...edit, ...updateOf(settings) });
      return { schedule: serializeSchedule(schedule(edited)), pending };
    }
    case 'remove-schedule':
      await removeSchedule(db, idOf(body, 'schedule'));
      return null;
    default:
      throw new AppError('NOT_FOUND', `unknown command ${command.slice(0, 40)}`);
  }
}

/** The schedule update `settings` ask for, the way the browser's Edit schedule form asks for it. */
function updateOf(settings: WireScheduleSettings): Omit<ScheduleUpdate, 'id' | 'title' | 'input'> {
  const { agent, place, repeat, at, ...rest } = settings;
  return {
    ...rest,
    ...(agent === undefined ? {} : { agent }),
    place,
    rule: repeat,
    ...(at === undefined ? {} : { startAt: at }),
  };
}

/** Whether an `apply-title-rule` answer says a part was stored. */
function storedAny(result: unknown): boolean {
  return isRecord(result) && (result['icon'] === true || result['labels'] === true || result['title'] === true);
}

/** The commands that change what dispatch decides; heartbeats and transcripts arrive every 15 s per running task and do not. */
const DISPATCH_WRITES = new Set([
  'add-task',
  'update-task',
  'configure-task',
  'edit-prompt',
  'claim-task',
  'add-note',
  'set-pr',
  'add-pr',
  'remove-pr',
  'ask',
  'pause',
  'stopped',
  'fail',
  'wait',
  'wake',
  'add-schedule',
  'update-schedule',
  'edit-schedule',
  'remove-schedule',
  // Every machine applies a pushed document on its next tick; this makes that tick now.
  'set-agents',
]);

/** The commands that leave what a view shows as it was: they only read, or arrive every 15 s per running task as a liveness sign. Every other command notifies the views. */
const VIEW_SILENT_COMMANDS = new Set([
  'version',
  'list-tasks',
  'get-task',
  'get-title-rules',
  'get-agents',
  'read-notes',
  'list-schedules',
  'heartbeat',
  'run-inbox',
]);

export interface MachineApiOptions {
  /** How often an open event stream gets a ping and has its token checked again. */
  pingMs: number;
  /** Which client feature each enum value needs; tests hand in a table with a value added after the baseline. */
  vocabulary?: VocabularyFeatures;
}

function bearerToken(req: FastifyRequest): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

/** A header sent once; a repeated one is ignored along with anything malformed. */
function headerValue(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

async function authenticate(db: Db, req: FastifyRequest): Promise<{ identity: MachineIdentity; token: string }> {
  const token = bearerToken(req);
  const identity = token ? await machineForToken(db, token) : null;
  if (!identity) throw new AppError('UNAUTHORIZED', 'unknown or revoked machine token');
  return { identity, token };
}

/** The identity `authenticate` put on the request; a route outside the authenticated scope has none, which is a bug. */
function authOf(req: FastifyRequest): { identity: MachineIdentity; token: string } {
  if (!req.machineAuth) throw new AppError('UNAUTHORIZED', 'unknown or revoked machine token');
  return req.machineAuth;
}

export function registerMachineApi(
  app: FastifyInstance,
  db: Db,
  config: Config,
  changes: Changes,
  { pingMs, vocabulary }: MachineApiOptions,
): void {
  const streams = new Set<() => void>();
  // The server waits for open connections to end before it closes; these never would.
  app.addHook('preClose', async () => {
    streams.forEach((end) => end());
  });
  app.decorateRequest('machineAuth', null);

  // Its own scope under the prefix, so the token check runs in onRequest for every URL and method there, unmatched ones
  // included: before Fastify reads and parses the body, which an unauthenticated caller must not be able to make it buffer.
  void app.register(
    async (machineApp) => {
      machineApp.addHook('onRequest', async (req) => {
        req.machineAuth = await authenticate(db, req);
      });
      machineApp.setNotFoundHandler(async (req) => {
        throw new AppError('NOT_FOUND', `unknown route ${req.method} ${req.url.slice(0, 40)}`);
      });
      registerRoutes(machineApp);
    },
    { prefix: '/api/machine' },
  );

  function registerRoutes(app: FastifyInstance): void {
    /** Server-sent events: a bare `tasks` event means "look at the board again"; it carries no data. */
    app.get('/events', async (req, reply) => {
      const { identity, token } = authOf(req);
      reply.hijack();
      // The client may have left while the token was being looked up; its `close` event is gone by now.
      if (req.raw.destroyed) return;
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');

      const stop = changes.subscribe(identity.owner, () => res.write('event: tasks\ndata:\n\n'));
      // The user deleted their account: the token check would end the stream at the next ping, this ends it now.
      const stopEnd = changes.onEnd(identity.owner, end);
      const ping = setInterval(() => {
        res.write(': ping\n\n');
        // A revoked token must not keep a stream.
        machineForToken(db, token).then(
          (current) => {
            if (!current) end();
          },
          (err: unknown) => app.log.error({ err }, 'machine stream token check failed'),
        );
      }, pingMs);
      function end(): void {
        clearInterval(ping);
        stop();
        stopEnd();
        streams.delete(end);
        res.end();
      }
      streams.add(end);
      req.raw.on('close', end);
    });

    async function serve(req: FastifyRequest, command: string): Promise<{ result: unknown }> {
      const { identity: machine } = authOf(req);
      const body = isRecord(req.body) ? req.body : {};
      const result = await withOwner(db, machine.owner, async (tx) => {
        // Only `version`, which every CLI process sends first: a worker that started before an update keeps sending
        // heartbeats from the old binary, and those must not make the machine look outdated again.
        if (command === 'version')
          await recordClient(tx, machine.name, {
            version: parseClientVersion(headerValue(req, CLIENT_VERSION_HEADER)),
            api: parseClientApi(headerValue(req, CLIENT_API_HEADER)),
          });
        return handleMachineCall(tx, config, machine, command, body, {
          features: parseClientFeatures(req.headers[CLIENT_FEATURES_HEADER]),
          ...(vocabulary === undefined ? {} : { vocabulary }),
        });
      });
      if (command === 'apply-title-rule' ? storedAny(result) : DISPATCH_WRITES.has(command))
        changes.notify(machine.owner);
      if (command === 'apply-title-rule' ? storedAny(result) : !VIEW_SILENT_COMMANDS.has(command))
        changes.notifyViews(machine.owner);
      return { result };
    }

    // `transcript` is its own route so that it alone takes a large body; the others share one route and a small limit.
    app.post('/transcript', { bodyLimit: TRANSCRIPT_BODY_LIMIT }, (req) => serve(req, 'transcript'));
    app.post<{ Params: { command: string } }>('/:command', { bodyLimit: MACHINE_BODY_LIMIT }, (req) =>
      serve(req, req.params.command),
    );
  }
}
