// The CLI's end-to-end encryption: the board server stores and returns sealed values it cannot read, and this wrapper
// seals what the rest of the CLI sends and opens what it receives, so `Backend` stays plaintext. The rules of what is sealed
// under which binding live in `packages/shared/src/sealing.mts`, which the browser uses too.
import {
  ContractError,
  dedupeKeyIndex,
  isSafeWorkdir,
  machineCatalogIndex,
  machineDirsIndex,
  machineUsageIndex,
  machineSourcesIndex,
  newTaskId,
  open,
  openFields,
  openIcon,
  openNote,
  openPrs,
  openSharedAgents,
  openWatches,
  headIndex,
  parsePolish,
  QuestionError,
  seal,
  sealChecked,
  sealFields,
  sealIcon,
  sealInput,
  sealMachineCatalog,
  sealMachineDirs,
  sealMachineUsage,
  sealMachineSources,
  sealNote,
  sealPr,
  sealQuestions,
  sealSharedAgents,
  sealWatches,
  sealTitle,
  sealWorkdir,
  taskLabels,
  textBeforeEdit,
  transcriptBinding,
} from '@agent-board/shared';
import type {
  Backend,
  Keys,
  Note,
  Opener,
  PrState,
  PromptEdit,
  Question,
  RowRef,
  Schedule,
  Sealer,
  Task,
  TaskDraft,
  TaskPatch,
  TranscriptBatch,
  TranscriptEvent,
  WireBackend,
  WireNote,
  WireNoteInput,
  WireSchedule,
  WireScheduleEdit,
  WireTask,
  WireTaskDraft,
  WireTaskPr,
  WireTaskPatch,
  WireTranscriptEvent,
} from '@agent-board/shared';
import { BackendError } from './backend.mts';
import { createWebBackend } from './web-backend.mts';
import type { WebBackendOptions } from './web-backend.mts';

const invalid = (command: string, message: string): BackendError => new BackendError(`${command}: ${message}`, 400);

/** What sealing refuses (a text past the board's limit, answers that do not fit) is a usage error naming the command. */
async function checked<T>(command: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ContractError || error instanceof QuestionError) throw invalid(command, error.message);
    throw error;
  }
}

function requireAbsolute(command: string, workdir: string | null | undefined): void {
  if (workdir !== undefined && workdir !== null && !isSafeWorkdir(workdir))
    throw invalid(command, 'workdir must be an absolute path');
}

const sealerFor =
  (keys: Keys): Sealer =>
  (binding, plaintext) =>
    seal(keys, binding.field, binding.context, plaintext);

/** Opens one value; undefined when it cannot be opened under that binding: plain text, another key, another binding, damage. */
const openerFor =
  (keys: Keys): Opener =>
  async (binding, value) => {
    try {
      return await open(keys, binding.field, binding.context, value);
    } catch {
      return undefined;
    }
  };

const taskRef = (task: Pick<WireTask, 'id' | 'createdBy' | 'scheduleId' | 'forkOf'>): RowRef => ({
  kind: 'task',
  id: task.id,
  createdBy: task.createdBy,
  scheduleId: task.scheduleId,
  forkOf: task.forkOf ?? null,
});

// A server without `task.prs` holds one reported PR per task and gives it no id.
const LEGACY_PR_ID = 'legacy';

// The reported PRs of a task; a server without `task.prs` answers the newest one as `pr` and its state as `prState`.
function reportedPrs(wire: WireTask): WireTaskPr[] {
  if (wire.prs !== undefined) return wire.prs;
  return wire.pr === null ? [] : [{ id: LEGACY_PR_ID, pr: wire.pr, state: wire.prState }];
}

// The state of the PR the prompt names; a server without `task.prs` states the prompt's PR only while there is no reported one.
function promptPrState(wire: WireTask): PrState | null {
  if (wire.prs !== undefined) return wire.promptPrState ?? null;
  return wire.pr === null ? wire.prState : null;
}

async function openTask(keys: Keys, wire: WireTask): Promise<Task> {
  const opener = openerFor(keys);
  const [{ title, input, workdir, agent, unreadable }, icon, prs, opened] = await Promise.all([
    openFields(opener, taskRef(wire), wire),
    openIcon(opener, taskRef(wire), wire.icon),
    openPrs(opener, wire.id, reportedPrs(wire)),
    openWatches(opener, wire.id, wire.watches),
  ]);
  const { pr: _pr, prState: _prState, prs: _prs, watches: _watches, watchStops, ...rest } = wire;
  return {
    ...rest,
    title,
    input,
    workdir,
    agent,
    icon,
    prs,
    promptPrState: promptPrState(wire),
    watches: opened.watches,
    watchEvents: opened.pendingEvents,
    watchStops: watchStops ?? [],
    labels: taskLabels({ input, createdBy: wire.createdBy }),
    unreadable: opened.unreadable ? [...unreadable, 'watches'] : unreadable,
  };
}

async function openSchedule(keys: Keys, wire: WireSchedule): Promise<Schedule> {
  const row: RowRef = { kind: 'schedule', id: wire.id };
  const opener = openerFor(keys);
  const [fields, icon] = await Promise.all([openFields(opener, row, wire), openIcon(opener, row, wire.icon)]);
  return { ...wire, ...fields, icon };
}

/**
 * Opens a thread note by the shared rules: a server event only for one of its fixed texts and kept as author "server"; any
 * other note only under its own author and kind. One that cannot be opened comes back `unreadable` with no text, so it is
 * never taken for what the user wrote.
 */
async function openThreadNote(keys: Keys, taskId: string, wire: WireNote): Promise<Note> {
  const opened = await openNote(openerFor(keys), taskId, wire);
  return {
    id: wire.id,
    createdAt: wire.createdAt,
    kind: wire.kind,
    ...opened,
    ...(wire.questionNoteId !== undefined ? { questionNoteId: wire.questionNoteId } : {}),
    ...(wire.pending === undefined ? {} : { pending: wire.pending }),
    ...(wire.queued === undefined ? {} : { queued: wire.queued }),
    ...(wire.deliveredAt === undefined ? {} : { deliveredAt: wire.deliveredAt }),
  };
}

/** The new title and prompt of an edit, trimmed; neither may be empty. */
function edited(command: string, edit: PromptEdit): PromptEdit {
  const title = edit.title.trim();
  const input = edit.input.trim();
  if (title === '') throw invalid(command, 'the title must not be empty');
  if (input === '') throw invalid(command, 'the prompt must not be empty');
  return { title, input };
}

/** `Backend` over a `WireBackend`: seals on the way out, opens on the way in. `keys` may be resolved on first use. */
export function sealingBackend(inner: WireBackend, keys: Keys | (() => Promise<Keys>)): Backend {
  let resolved: Promise<Keys> | undefined;
  const getKeys = (): Promise<Keys> => (resolved ??= typeof keys === 'function' ? keys() : Promise.resolve(keys));
  const sealer: Sealer = async (binding, plaintext) => sealerFor(await getKeys())(binding, plaintext);

  const noteInput = async (
    command: string,
    taskId: string,
    author: 'agent' | 'system',
    text: string,
    kind: 'comment' | 'polish' = 'comment',
    options: { suggestion?: string } = {},
  ): Promise<WireNoteInput> => {
    if (text.trim() === '') throw invalid(command, 'note text is empty');
    if (kind === 'polish' && author !== 'agent') throw invalid(command, 'only an agent writes a polish note');
    const noteKind = author === 'agent' ? kind : 'event';
    const previewSource = kind === 'polish' ? (parsePolish(text)?.prompt ?? text) : text;
    return checked(command, () =>
      sealNote(sealer, { taskId, author, kind: noteKind }, text, { ...options, previewSource }),
    );
  };

  const sealDraft = async (draft: TaskDraft): Promise<WireTaskDraft> => {
    const title = draft.title.trim();
    if (title === '') throw invalid('add-task', 'draft.title must not be empty');
    requireAbsolute('add-task', draft.workdir);
    const { dedupeKey, workdir, head, agent, icon, id: chosen, ...rest } = draft;
    const id = chosen ?? newTaskId();
    const row: RowRef = {
      kind: 'task',
      id,
      createdBy: draft.createdBy ?? 'user',
      scheduleId: null,
      agent: agent ?? null,
      forkOf: null,
    };
    const sealed = await checked('add-task', () => sealFields(sealer, row, { title, input: draft.input, workdir }));
    const sealedIcon = icon === undefined ? undefined : await checked('add-task', () => sealIcon(sealer, row, icon));
    const keysNow = await getKeys();
    return {
      ...rest,
      id,
      ...sealed,
      ...(sealedIcon === undefined ? {} : { icon: sealedIcon }),
      ...(dedupeKey === undefined ? {} : { dedupeKey: await dedupeKeyIndex(keysNow, dedupeKey) }),
      ...(head === undefined ? {} : { head: await headIndex(keysNow, head) }),
    };
  };

  const sealPatch = async (id: string, patch: TaskPatch): Promise<WireTaskPatch> => {
    requireAbsolute('update-task', patch.workdir);
    const { input, workdir, head, seal: writer, ...rest } = patch;
    const needsRow = input !== undefined || (workdir !== undefined && workdir !== null);
    if (needsRow && writer === undefined)
      throw invalid('update-task', 'sealing an input or a directory needs the task creator and schedule (patch.seal)');
    if (input !== undefined && writer?.agent === undefined)
      throw invalid('update-task', 'sealing an input needs the task agent, or null for none (patch.seal.agent)');
    const row: RowRef = {
      kind: 'task',
      id,
      createdBy: writer?.createdBy ?? 'user',
      scheduleId: writer?.scheduleId ?? null,
      agent: writer?.agent ?? null,
      forkOf: writer?.forkOf ?? null,
    };
    const sealed = await checked('update-task', async () => ({
      ...(input === undefined ? {} : { input: await sealInput(sealer, row, input) }),
      ...(workdir === undefined || workdir === null ? {} : { workdir: await sealWorkdir(sealer, row, workdir) }),
    }));
    return {
      ...rest,
      ...sealed,
      ...(workdir === null ? { workdir: null } : {}),
      ...(head === undefined ? {} : { head: head === null ? null : await headIndex(await getKeys(), head) }),
    };
  };

  const sealEvent = async (taskId: string, runId: string, event: TranscriptEvent): Promise<WireTranscriptEvent> => {
    const { seq, at, kind, parent } = event;
    const dataBinding = transcriptBinding('tr.data', taskId, runId, seq);
    if (event.kind !== 'tool_result')
      return {
        seq,
        at,
        kind,
        parent,
        data: await sealChecked(sealer, dataBinding, JSON.stringify(event), `event ${seq}`),
      };
    const { output, ...rest } = event;
    return {
      seq,
      at,
      kind,
      parent,
      data: await sealChecked(sealer, dataBinding, JSON.stringify(rest), `event ${seq}`),
      output: await sealChecked(
        sealer,
        transcriptBinding('tr.output', taskId, runId, seq),
        output,
        `the output of event ${seq}`,
      ),
      outputSize: output.length,
    };
  };

  const opened = async <T, R>(wire: T, open: (keys: Keys, value: T) => Promise<R>): Promise<R> =>
    open(await getKeys(), wire);
  const openedAll = async <T, R>(wire: T[], open: (keys: Keys, value: T) => Promise<R>): Promise<R[]> => {
    const resolvedKeys = await getKeys();
    return Promise.all(wire.map((value) => open(resolvedKeys, value)));
  };

  return {
    listTasks: async (options) => openedAll(await inner.listTasks(options), openTask),
    getTask: async (id) => opened(await inner.getTask(id), openTask),
    async attachSession(id) {
      const { sessionId, workdir } = await opened(await inner.attachSession(id), openTask);
      if (sessionId === null) throw invalid('attach-session', 'the answer has no session');
      return { sessionId, workdir };
    },
    async addTask(draft) {
      const { task, created } = await inner.addTask(await sealDraft(draft));
      return { task: await opened(task, openTask), created };
    },
    async updateTask(id, patch) {
      return opened(await inner.updateTask(id, await sealPatch(id, patch)), openTask);
    },
    async configureTask(id, change) {
      const { place, icon, seal: writer, ...rest } = change;
      requireAbsolute('configure-task', place?.workdir);
      if (writer === undefined && ((place !== undefined && place !== null) || (icon !== undefined && icon !== null)))
        throw invalid(
          'configure-task',
          'sealing a directory or an icon needs the task creator and schedule (change.seal)',
        );
      const row: RowRef = {
        kind: 'task',
        id,
        createdBy: writer?.createdBy ?? 'user',
        scheduleId: writer?.scheduleId ?? null,
        agent: writer?.agent ?? null,
        forkOf: writer?.forkOf ?? null,
      };
      const sealed = await checked('configure-task', async () => ({
        ...(place === undefined
          ? {}
          : { place: place === null ? null : { workdir: await sealWorkdir(sealer, row, place.workdir) } }),
        ...(icon === undefined ? {} : { icon: icon === null ? null : await sealIcon(sealer, row, icon) }),
      }));
      return opened(await inner.configureTask(id, { ...rest, ...sealed }), openTask);
    },
    // The user's edit of a prompt: sealed as the user, as the browser does, under the row the server holds now.
    async editPrompt(id, edit) {
      const { title, input } = edited('edit-prompt', edit);
      const current = await opened(await inner.getTask(id), openTask);
      if (current.createdBy !== 'user')
        throw invalid('edit-prompt', 'only a task you created has a prompt you can edit');
      if (current.scheduleId !== null)
        throw invalid('edit-prompt', 'this card is the next run of a schedule; edit the schedule instead');
      if (current.unreadable.some((field) => field !== 'watches'))
        throw invalid('edit-prompt', 'this task cannot be read, so what it says now could not be kept');
      const row: RowRef = {
        kind: 'task',
        id,
        createdBy: 'user',
        scheduleId: null,
        agent: current.agent ?? null,
        forkOf: current.forkOf ?? null,
      };
      const wire = await checked('edit-prompt', async () => ({
        title: await sealTitle(sealer, row, title),
        input: await sealInput(sealer, row, input),
        previous: await sealNote(sealer, { taskId: id, author: 'user', kind: 'event' }, textBeforeEdit(current)),
      }));
      return opened(await inner.editPrompt(id, wire), openTask);
    },
    async claimTask(id, machine) {
      const claimed = await inner.claimTask(id, machine);
      return claimed === undefined ? undefined : opened(claimed, openTask);
    },
    addNote: async (id, text, { author = 'agent', kind = 'comment', suggestion } = {}) =>
      inner.addNote(
        id,
        await noteInput('add-note', id, author, text, kind, suggestion === undefined ? {} : { suggestion }),
        { author, kind },
      ),
    async ask(id, questions: Question[]) {
      await inner.ask(id, await checked('ask', () => sealQuestions(sealer, id, questions)));
    },
    heartbeat: (id, beat) => inner.heartbeat(id, beat),
    async addPr(id, url) {
      await inner.addPr(id, { pr: await checked('add-pr', () => sealPr(sealer, id, url)) });
    },
    removePr: (id, prId) => inner.removePr(id, { pr: prId }),
    setPrStates: (id, states) => inner.setPrStates(id, states),
    async setWatches(id, watches, pendingEvents) {
      await inner.setWatches(id, {
        watches:
          watches === null ? null : await checked('set-watches', () => sealWatches(sealer, id, watches, pendingEvents)),
      });
    },
    ackWatchStops: (id, ids) => inner.ackWatchStops(id, { ids: [...ids] }),
    async checkDirs(machine, dirs) {
      const { supported, index } = await inner.dirsState();
      if (!supported) return 'unsupported';
      return index === (await machineDirsIndex(await getKeys(), machine, dirs)) ? 'current' : 'stale';
    },
    async setDirs(machine, dirs) {
      const sealed = await checked('set-dirs', () => sealMachineDirs(sealer, machine, dirs));
      await inner.setDirs({ dirs: sealed, index: await machineDirsIndex(await getKeys(), machine, dirs) });
    },
    async checkCatalog(machine, catalog) {
      const { supported, index } = await inner.catalogState();
      if (!supported) return 'unsupported';
      return index === (await machineCatalogIndex(await getKeys(), machine, catalog)) ? 'current' : 'stale';
    },
    async setCatalog(machine, catalog) {
      const sealed = await checked('set-catalog', () => sealMachineCatalog(sealer, machine, catalog));
      await inner.setCatalog({ catalog: sealed, index: await machineCatalogIndex(await getKeys(), machine, catalog) });
    },
    async checkUsage(machine, usage) {
      const { supported, index } = await inner.usageState();
      if (!supported) return 'unsupported';
      return index === (await machineUsageIndex(await getKeys(), machine, usage)) ? 'current' : 'stale';
    },
    async setUsage(machine, usage) {
      const sealed = await checked('set-usage', () => sealMachineUsage(sealer, machine, usage));
      await inner.setUsage({ usage: sealed, index: await machineUsageIndex(await getKeys(), machine, usage) });
    },
    async checkSources(machine, sources) {
      const { supported, index } = await inner.sourcesState();
      if (!supported) return 'unsupported';
      return index === (await machineSourcesIndex(await getKeys(), machine, sources)) ? 'current' : 'stale';
    },
    async setSources(machine, sources) {
      const sealed = await checked('set-sources', () => sealMachineSources(sealer, machine, sources));
      await inner.setSources({ sources: sealed, index: await machineSourcesIndex(await getKeys(), machine, sources) });
    },
    async sourceRequests() {
      const { supported, requests } = await inner.sourcesState();
      return supported ? requests : [];
    },
    async ackSourceRequests(requests) {
      await inner.ackSourceRequests({ requests: [...requests] });
    },
    async sharedAgentsVersion() {
      const { supported, version } = await inner.agentsState();
      return supported ? version : 'unsupported';
    },
    async getSharedAgents() {
      const wire = await inner.getAgents();
      if (wire === null) return null;
      const document = await openSharedAgents(openerFor(await getKeys()), wire.version, wire.document);
      return document === undefined ? { version: wire.version, unreadable: true } : { version: wire.version, document };
    },
    async setSharedAgents(document, expectedVersion) {
      if (document.version !== expectedVersion + 1)
        throw invalid('set-agents', 'the version must be one more than the version it replaces');
      const sealed = await checked('set-agents', () => sealSharedAgents(sealer, document));
      await inner.setAgents({ document: sealed, version: document.version, expectedVersion });
    },
    async pause(id, note) {
      return opened(await inner.pause(id, await noteInput('pause', id, 'system', note.trim())), openTask);
    },
    async fail(id, text) {
      const { applied, task } = await inner.fail(id, await noteInput('fail', id, 'system', text.trim()));
      return { applied, task: await opened(task, openTask) };
    },
    async wait(id, { text, wakeAt, check }) {
      const note = await noteInput('wait', id, 'agent', text.trim());
      return opened(await inner.wait(id, { ...note, wakeAt, check }), openTask);
    },
    async wake(id, text) {
      const { applied, task } = await inner.wake(id, await noteInput('wake', id, 'system', text.trim()));
      return { applied, task: await opened(task, openTask) };
    },
    async runInbox(id) {
      const { stop, stopMessage, messages } = await inner.runInbox(id);
      const resolvedKeys = await getKeys();
      return {
        stop,
        ...(stopMessage === undefined ? {} : { stopMessage }),
        messages: await Promise.all(messages.map((note) => openThreadNote(resolvedKeys, id, note))),
      };
    },
    ackMessages: (id, ack) => inner.ackMessages(id, ack),
    async stopped(id, text) {
      return opened(await inner.stopped(id, await noteInput('stopped', id, 'system', text.trim())), openTask);
    },
    async transcript(id, batch: TranscriptBatch) {
      const events = await checked('transcript', () =>
        Promise.all(batch.events.map((event) => sealEvent(id, batch.runId, event))),
      );
      await inner.transcript(id, { ...batch, events });
    },
    async readNotes(id) {
      const wire = await inner.readNotes(id);
      const resolvedKeys = await getKeys();
      return Promise.all(wire.map((note) => openThreadNote(resolvedKeys, id, note)));
    },
    async addSchedule(draft) {
      const title = draft.title.trim();
      if (title === '') throw invalid('add-schedule', 'schedule draft.title must not be empty');
      if (draft.input.trim() === '') throw invalid('add-schedule', 'schedule draft.input must not be empty');
      requireAbsolute('add-schedule', draft.workdir);
      const { workdir, agent, icon, id: chosen, ...rest } = draft;
      const id = chosen ?? newTaskId();
      const row: RowRef = { kind: 'schedule', id, agent: agent ?? null };
      const sealed = await checked('add-schedule', async () => ({
        ...(await sealFields(sealer, row, { title, input: draft.input, workdir })),
        ...(icon === undefined ? {} : { icon: await sealIcon(sealer, row, icon) }),
      }));
      const { schedule, task } = await inner.addSchedule({ ...rest, id, ...sealed });
      return {
        schedule: await opened(schedule, openSchedule),
        task: task === null ? null : await opened(task, openTask),
      };
    },
    listSchedules: async () => openedAll(await inner.listSchedules(), openSchedule),
    updateSchedule: async (id, patch) => opened(await inner.updateSchedule(id, patch), openSchedule),
    async editSchedule(id, edit) {
      const { title, input } = edited('edit-schedule', edit);
      const { settings } = edit;
      requireAbsolute('edit-schedule', settings?.place?.workdir);
      const found = await openedAll(await inner.listSchedules(), openSchedule);
      const current = found.find((schedule) => schedule.id === id);
      if (current === undefined) throw new BackendError(`edit-schedule: no schedule ${id.slice(0, 40)}`, 404);
      if (current.unreadable.length > 0)
        throw invalid('edit-schedule', 'this schedule cannot be read, so it is not edited here');
      const wire = await checked('edit-schedule', async (): Promise<WireScheduleEdit> => {
        if (settings === undefined) {
          const row: RowRef = { kind: 'schedule', id, agent: current.agent ?? null };
          return { title: await sealTitle(sealer, row, title), input: await sealInput(sealer, row, input) };
        }
        const { agent, place, icon, ...rest } = settings;
        const row: RowRef = { kind: 'schedule', id, agent: agent ?? null };
        const sealed = await sealFields(sealer, row, { title, input, workdir: place?.workdir });
        return {
          title: sealed.title,
          input: sealed.input,
          settings: {
            ...rest,
            ...(sealed.agent === undefined ? {} : { agent: sealed.agent }),
            ...(icon === undefined ? {} : { icon: icon === null ? null : await sealIcon(sealer, row, icon) }),
            place:
              place === null || sealed.workdir === undefined
                ? null
                : { machine: place.machine, workdir: sealed.workdir },
          },
        };
      });
      const result = await inner.editSchedule(id, wire);
      return { schedule: await opened(result.schedule, openSchedule), pending: result.pending };
    },
    removeSchedule: (id) => inner.removeSchedule(id),
    indexHead: async (sha) => headIndex(await getKeys(), sha),
  };
}

/** The board over HTTP, sealed with the data key from the credentials file. */
export function createSealedBackend(options: WebBackendOptions): Backend {
  const web = createWebBackend(options);
  return sealingBackend(web, () => web.keys());
}
