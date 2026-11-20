import {
  defaultTitle,
  newTaskId,
  noteBinding,
  openFields,
  openNote,
  runsLeft,
  openPreview,
  sealAnswers,
  sealFields,
  sealInput,
  sealNote,
  sealQuestions,
  sealTitle,
  sealWorkdir,
  transcriptBinding,
  type Answer,
  type Effort,
  type NoteKind,
  type Question,
  type RowRef,
} from '@agent-board/shared';
import type { Db } from '../db/client';
import { caller } from './helpers';
import { sealerFor, type Sealing } from './sealed';

type Raw = ReturnType<typeof caller>;
type ScheduleUpdateInput = Parameters<Raw['schedules']['update']>[0];
/** What a test changes about a schedule; the rest stays. A null `agent` clears it, a null `place` clears machine and directory. */
type ScheduleChanges = Partial<
  Pick<
    ScheduleUpdateInput,
    'priority' | 'model' | 'autoDone' | 'repeat' | 'at' | 'runsLeft' | 'until' | 'maxConcurrent'
  > & {
    title: string;
    input: string;
    agent: string | null;
    place: { machine: string; workdir: string } | null;
    /** A lane name, or null for the default lane; left out it keeps the schedule's. */
    lane: string | null;
    /** An effort level, or null for claude's default; left out it keeps the schedule's. */
    effort: Effort | null;
  }
>;
// Machine API bodies and answers are untyped JSON.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MachineAnswer = { status: number; json: { result?: any; error?: string } };
export type MachineCall = (command: string, body?: Json) => Promise<MachineAnswer>;

const isEnvelope = (value: unknown): value is string => typeof value === 'string' && value.startsWith('abe1.');

const taskRowOf = (task: Json): RowRef => ({
  kind: 'task',
  id: task['id'],
  createdBy: task['createdBy'],
  scheduleId: task['scheduleId'],
  forkOf: task['forkOf'] ?? null,
});

/** Opens the title, input and directory of a row, or throws: a test that reads something it cannot open has found a bug. */
async function openRow<T extends Json>(row: T, ref: RowRef, sealing: Sealing): Promise<T> {
  if (!isEnvelope(row['title'])) return row;
  const fields = await openFields(sealing.open, ref, {
    title: row['title'],
    input: row['input'],
    workdir: row['workdir'],
    agent: row['agent'],
  });
  if (fields.unreadable.length > 0)
    throw new Error(`${ref.kind} ${ref.id}: cannot open ${fields.unreadable.join(', ')}`);
  return {
    ...row,
    title: fields.title,
    input: fields.input,
    workdir: fields.workdir,
    ...(fields.agent === null ? {} : { agent: fields.agent }),
  };
}

/** Opens the sealed fields of any task, schedule or note found in a machine API result. */
async function openDeep(value: unknown, sealing: Sealing, taskId: string): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => openDeep(item, sealing, taskId)));
  if (typeof value !== 'object' || value === null) return value;
  let out: Json = {};
  for (const [key, item] of Object.entries(value)) out[key] = await openDeep(item, sealing, taskId);
  if ('createdBy' in out && 'scheduleId' in out && 'status' in out) out = await openRow(out, taskRowOf(out), sealing);
  else if ('everyMs' in out && 'anchorAt' in out)
    out = await openRow(out, { kind: 'schedule', id: out['id'] }, sealing);
  else if (typeof out['body'] === 'string' && typeof out['kind'] === 'string' && typeof out['author'] === 'string') {
    const note = await openNote(sealing.open, taskId, out as Parameters<typeof openNote>[2]);
    if (note.unreadable) throw new Error(`note ${out['id']}: cannot open it`);
    out = { ...out, ...note };
  }
  return out;
}

async function sealDraft(body: Json, sealing: Sealing, row: (id: string) => RowRef): Promise<Json> {
  const { labels: _labels, ...rest } = body;
  const out: Json = { ...rest };
  const id: string = rest['id'] ?? newTaskId();
  const agent = typeof rest['agent'] === 'string' ? rest['agent'] : null;
  if (typeof rest['title'] === 'string') {
    Object.assign(
      out,
      await sealFields(
        sealing.seal,
        { ...row(id), agent },
        {
          title: rest['title'],
          input: rest['input'] ?? '',
          workdir: typeof rest['workdir'] === 'string' ? rest['workdir'] : undefined,
        },
      ),
      { id },
    );
    if (typeof rest['agent'] !== 'string') delete out['agent'];
  }
  if (typeof rest['dedupeKey'] === 'string') out['dedupeKey'] = await sealing.blind(rest['dedupeKey']);
  if (typeof rest['head'] === 'string') out['head'] = await sealing.headIndex(rest['head']);
  return out;
}

async function sealRequest(command: string, request: Json, sealing: Sealing, raw: MachineCall): Promise<Json> {
  const id = String(request['id'] ?? '');
  const body = request['body'];
  const note = (author: 'agent' | 'system', kind: NoteKind, text: string) =>
    sealNote(sealing.seal, { taskId: id, author, kind }, text);
  switch (command) {
    case 'add-task':
      return {
        ...request,
        body: await sealDraft(body, sealing, (taskId) => ({
          kind: 'task',
          id: taskId,
          createdBy: body['createdBy'] ?? 'user',
          scheduleId: null,
          forkOf: null,
        })),
      };
    case 'add-schedule':
      return {
        ...request,
        body: await sealDraft(body, sealing, (scheduleId) => ({ kind: 'schedule', id: scheduleId })),
      };
    case 'update-task': {
      const patch: Json = { ...body };
      if (typeof patch['input'] === 'string' || typeof patch['workdir'] === 'string') {
        const wire = (await raw('get-task', { id })).json.result;
        const row = { ...taskRowOf(wire), agent: (await openFields(sealing.open, taskRowOf(wire), wire)).agent };
        if (typeof patch['input'] === 'string') patch['input'] = await sealInput(sealing.seal, row, patch['input']);
        if (typeof patch['workdir'] === 'string')
          patch['workdir'] = await sealWorkdir(sealing.seal, row, patch['workdir']);
      }
      if (typeof patch['head'] === 'string') patch['head'] = await sealing.headIndex(patch['head']);
      return { ...request, body: patch };
    }
    case 'configure-task': {
      // The directory in plaintext, sealed as the CLI does it: under the binding of the row it lands on.
      if (typeof body?.place?.workdir !== 'string') return request;
      const wire = (await raw('get-task', { id })).json.result;
      if (wire === undefined) return request;
      const workdir = await sealWorkdir(sealing.seal, taskRowOf(wire), body.place.workdir);
      return { ...request, body: { ...body, place: { ...body.place, workdir } } };
    }
    case 'edit-prompt': {
      // The user's edit, sealed as the CLI does it: the new text under the task's row, the old text as a note of the user's.
      if (typeof body?.input !== 'string') return request;
      const wire = (await raw('get-task', { id })).json.result;
      if (wire === undefined) return request;
      const before = await openFields(sealing.open, taskRowOf(wire), wire);
      const row = { ...taskRowOf(wire), agent: before.agent };
      return {
        ...request,
        body: {
          title: await sealTitle(sealing.seal, row, body.title),
          input: await sealInput(sealing.seal, row, body.input),
          previous: await sealNote(sealing.seal, { taskId: id, author: 'user', kind: 'event' }, body.previous),
        },
      };
    }
    case 'edit-schedule': {
      if (typeof body?.input !== 'string') return request;
      const schedule = (await raw('list-schedules')).json.result?.find((found: Json) => found['id'] === id);
      if (schedule === undefined) return request;
      if (body.settings !== undefined) {
        // Settings in plaintext: title, prompt, agent and directory are sealed together under the new agent.
        const { agent, place, ...rest } = body.settings;
        const sealed = await sealFields(
          sealing.seal,
          { kind: 'schedule', id, agent: agent ?? null },
          { title: body.title, input: body.input, workdir: place?.workdir },
        );
        return {
          ...request,
          body: {
            title: sealed.title,
            input: sealed.input,
            settings: {
              ...rest,
              ...(sealed.agent === undefined ? {} : { agent: sealed.agent }),
              ...(place === undefined
                ? {}
                : { place: place === null ? null : { machine: place.machine, workdir: sealed.workdir } }),
            },
          },
        };
      }
      const row: RowRef = {
        kind: 'schedule',
        id,
        agent: (await openFields(sealing.open, { kind: 'schedule', id }, schedule)).agent,
      };
      return {
        ...request,
        body: {
          title: await sealTitle(sealing.seal, row, body.title),
          input: await sealInput(sealing.seal, row, body.input),
        },
      };
    }
    case 'add-note':
      return typeof body === 'string'
        ? {
            ...request,
            body:
              request['author'] === 'system'
                ? await note('system', 'event', body)
                : await note('agent', request['kind'] === 'polish' ? 'polish' : 'comment', body),
          }
        : request;
    case 'wait':
      // `body.text` is the agent's comment, sealed; the rest goes as it is.
      if (typeof body?.text !== 'string') return request;
      return {
        ...request,
        body: {
          ...(await note('agent', 'comment', body.text)),
          wakeAt: body.wakeAt,
          check: body.check ?? false,
        },
      };
    case 'pause':
    case 'stopped':
    case 'fail':
    case 'wake':
      return typeof body === 'string' ? { ...request, body: await note('system', 'event', body) } : request;
    case 'ask': {
      const questions: Question[] = Array.isArray(body) ? body : body.questions;
      return { ...request, body: await sealQuestions(sealing.seal, id, questions) };
    }
    case 'transcript': {
      const events = await Promise.all(
        (body.events as Json[]).map(async ({ output, ...event }) => {
          const data = await sealing.seal(
            transcriptBinding('tr.data', id, body.runId, event['seq']),
            JSON.stringify(event),
          );
          const wire = { seq: event['seq'], at: event['at'], kind: event['kind'], parent: event['parent'], data };
          if (event['kind'] !== 'tool_result') return wire;
          return {
            ...wire,
            output: await sealing.seal(transcriptBinding('tr.output', id, body.runId, event['seq']), output ?? ''),
            outputSize: (output ?? '').length,
          };
        }),
      );
      return { ...request, body: { ...body, events } };
    }
    default:
      return request;
  }
}

/**
 * Makes a client of a raw machine API call: plaintext in, as the CLI's sealing backend takes it, and plaintext out, through
 * the shared sealing rules the CLI runs. What it cannot seal (a body that is already an object) is sent as it is, so refusals
 * can be tested through it too.
 */
export function plainMachine(raw: MachineCall, owner = 'jascha'): MachineCall {
  const sealing = sealerFor(owner);
  return async (command, request = {}) => {
    const answer = await raw(command, await sealRequest(command, request, sealing, raw));
    if (answer.json.result === undefined) return answer;
    return {
      ...answer,
      json: { ...answer.json, result: await openDeep(answer.json.result, sealing, String(request['id'] ?? '')) },
    };
  };
}

type CreateInput = Omit<Parameters<Raw['tasks']['create']>[0], 'id' | 'title' | 'input' | 'place' | 'agent'> & {
  /** The agent's name in plaintext; it is sealed like the browser seals it. */
  agent?: string;
  id?: string;
  title?: string;
  input: string;
  /** The directory in plaintext; it is sealed like the browser seals it. */
  place?: { machine: string; workdir: string };
};

type ConfigureInput = Omit<Parameters<Raw['tasks']['configure']>[0], 'place' | 'title'> & {
  /** The directory in plaintext; it is sealed like the browser seals it. */
  place?: { machine: string; workdir: string } | null;
  /** The title in plaintext; it is sealed like the browser seals it. */
  title?: string;
};

/** Makes a client of a tRPC caller: plaintext in and out, with the sealing the browser does (the same shared rules). */
export function plainUi(db: Db, owner = 'jascha') {
  const raw = caller(db, owner);
  const sealing = sealerFor(owner);

  const openTask = async <T extends { id: string; title: string; input: string; workdir: string | null }>(task: T) =>
    openRow(task, taskRowOf(task), sealing);
  const openSchedule = async <T extends { id: string; title: string; input: string; workdir: string | null }>(
    schedule: T,
  ) => openRow(schedule, { kind: 'schedule', id: schedule.id }, sealing);
  const openThreadNote = async <
    N extends {
      id: string;
      body: string;
      preview: string | null;
      author: 'agent' | 'user' | 'system' | 'server';
      kind: NoteKind;
    },
  >(
    note: N,
    taskId: string,
  ) => {
    const opened = await openNote(sealing.open, taskId, note);
    if (opened.unreadable) throw new Error(`note ${note.id}: cannot open it`);
    return { ...note, ...opened };
  };
  const mutation =
    <I extends { id: string }>(call: (input: I) => ReturnType<Raw['tasks']['done']>) =>
    async (input: I) =>
      openTask(await call(input));

  return {
    raw,
    sealing,
    tasks: {
      list: async (input?: Parameters<Raw['tasks']['list']>[0]) =>
        Promise.all(
          (await raw.tasks.list(input)).map(async ({ lastNote, ...task }) => ({
            ...(await openTask(task)),
            lastNote:
              lastNote === null
                ? null
                : {
                    ...lastNote,
                    text:
                      lastNote.preview === null ? null : ((await openPreviewText(sealing, task.id, lastNote)) ?? null),
                  },
          })),
        ),
      get: async (input: { id: string }) => {
        const { task, thread, followUps, parent } = await raw.tasks.get(input);
        return {
          task: await openTask(task),
          thread: await Promise.all(thread.map((note) => openThreadNote(note, input.id))),
          followUps: await Promise.all(followUps.map(openTask)),
          parent: parent === null ? null : await openTask(parent),
        };
      },
      create: async ({ id: chosen, title, input, place, agent: agentName, ...rest }: CreateInput) => {
        const id = chosen ?? newTaskId();
        const repeats =
          typeof rest.when === 'object' && ('every' in rest.when || 'cron' in rest.when || 'after' in rest.when);
        const agent = agentName ?? null;
        const row: RowRef = repeats
          ? { kind: 'schedule', id, agent }
          : { kind: 'task', id, createdBy: 'user', scheduleId: null, agent, forkOf: null };
        const { workdir, ...fields } = await sealFields(sealing.seal, row, {
          title: title ?? defaultTitle(input),
          input,
          workdir: place?.workdir,
        });
        const placed =
          place === undefined || workdir === undefined ? {} : { place: { machine: place.machine, workdir } };
        const created = await raw.tasks.create({ id, ...fields, ...rest, ...placed });
        if (created === null)
          throw new Error('this schedule has no first task: it waits for the schedule it runs after');
        return openTask(created);
      },
      // As the browser does: the prompt sealed for the fork link, the parent's directory and agent for the new task.
      fork: async ({
        id: chosen,
        parentId,
        title,
        input,
      }: {
        id?: string;
        parentId: string;
        title: string;
        input: string;
      }) => {
        const id = chosen ?? newTaskId();
        const parent = await openTask((await raw.tasks.get({ id: parentId })).task);
        const row: RowRef = {
          kind: 'task',
          id,
          createdBy: 'user',
          scheduleId: null,
          agent: parent.agent ?? null,
          forkOf: parentId,
        };
        if (parent.workdir === null) throw new Error(`task ${parentId} has no directory to fork in`);
        const { workdir, ...fields } = await sealFields(sealing.seal, row, { title, input, workdir: parent.workdir });
        if (workdir === undefined) throw new Error('the directory was not sealed');
        return openTask(await raw.tasks.fork({ id, parentId, ...fields, workdir }));
      },
      answer: async (input: { id: string; questionNoteId: string; answers: Answer[]; message?: string }) => {
        const { thread } = await raw.tasks.get({ id: input.id });
        const asked = thread.find((note) => note.id === input.questionNoteId);
        const questions = asked === undefined ? undefined : (await openNote(sealing.open, input.id, asked)).questions;
        return openTask(
          await raw.tasks.answer({
            id: input.id,
            questionNoteId: input.questionNoteId,
            // An answer to a question that is not there cannot be checked; the server must be the one to refuse it.
            answers:
              questions === undefined
                ? await sealing.seal(
                    noteBinding('note.answers', input.id, 'user', 'answer'),
                    JSON.stringify({ questions: [], answers: input.answers }),
                  )
                : await sealAnswers(sealing.seal, input.id, questions, input.answers),
            message: await sealNote(
              sealing.seal,
              { taskId: input.id, author: 'user', kind: 'answer' },
              input.message ?? '',
            ),
          }),
        );
      },
      dismissQuestion: mutation(raw.tasks.dismissQuestion),
      reply: async (input: { id: string; message: string; resume: boolean }) =>
        openTask(
          await raw.tasks.reply({
            id: input.id,
            message: await sealNote(sealing.seal, { taskId: input.id, author: 'user', kind: 'comment' }, input.message),
            resume: input.resume,
          }),
        ),
      send: async (input: { id: string; message: string }) =>
        openTask(
          await raw.tasks.send({
            id: input.id,
            message: await sealNote(sealing.seal, { taskId: input.id, author: 'user', kind: 'comment' }, input.message),
          }),
        ),
      stop: async (input: { id: string; message?: string }) =>
        openTask(
          await raw.tasks.stop({
            id: input.id,
            ...(input.message === undefined
              ? {}
              : {
                  message: await sealNote(
                    sealing.seal,
                    { taskId: input.id, author: 'user', kind: 'comment' },
                    input.message,
                  ),
                }),
          }),
        ),
      // As the browser does: the polished title and prompt sealed as the task's own and the user's, the old text as a note.
      applyPolish: async (input: { id: string; polishId: string; title: string; input: string; previous: string }) => {
        const row: RowRef = { kind: 'task', id: input.id, createdBy: 'user', scheduleId: null, forkOf: null };
        const fields = await sealFields(sealing.seal, row, { title: input.title, input: input.input });
        return openTask(
          await raw.tasks.applyPolish({
            id: input.id,
            polishId: input.polishId,
            ...fields,
            previous: await sealNote(sealing.seal, { taskId: input.id, author: 'user', kind: 'event' }, input.previous),
          }),
        );
      },
      // As the browser does: the new title and prompt sealed under the row they land on, the old text as a note.
      edit: async (input: { id: string; title: string; input: string; previous: string }) => {
        const { task } = await raw.tasks.get({ id: input.id });
        const row = { ...taskRowOf(task), agent: (await openFields(sealing.open, taskRowOf(task), task)).agent };
        const fields = await sealFields(sealing.seal, row, { title: input.title, input: input.input });
        return openTask(
          await raw.tasks.edit({
            id: input.id,
            title: fields.title,
            input: fields.input,
            previous: await sealNote(sealing.seal, { taskId: input.id, author: 'user', kind: 'event' }, input.previous),
          }),
        );
      },
      done: mutation(raw.tasks.done),
      rerun: mutation(raw.tasks.rerun),
      setPriority: mutation(raw.tasks.setPriority),
      // As the browser does: a new directory sealed for the row it lands on.
      configure: async ({ place, title, ...input }: ConfigureInput) => {
        const { task } = await raw.tasks.get({ id: input.id });
        const workdir =
          place === undefined || place === null
            ? undefined
            : await sealWorkdir(sealing.seal, taskRowOf(task), place.workdir);
        return openTask(
          await raw.tasks.configure({
            ...input,
            ...(title === undefined ? {} : { title: await sealTitle(sealing.seal, taskRowOf(task), title) }),
            ...(place === null ? { place } : {}),
            ...(place === undefined || place === null || workdir === undefined
              ? {}
              : { place: { machine: place.machine, workdir } }),
          }),
        );
      },
      setNotBefore: mutation(raw.tasks.setNotBefore),
      takeBack: mutation(raw.tasks.takeBack),
      wakeNow: mutation(raw.tasks.wakeNow),
      setClosed: mutation(raw.tasks.setClosed),
      removePr: mutation(raw.tasks.removePr),
      // As the browser does: an agent's proposal enters Todo with its prompt sealed again for the creator "user".
      move: async (input: Parameters<Raw['tasks']['move']>[0]) => {
        const { startInput: _given, ...rest } = input;
        const { task } = await raw.tasks.get({ id: input.id });
        if (task.createdBy !== 'agent' || input.status !== 'todo') return openTask(await raw.tasks.move(rest));
        const proposal = await openTask(task);
        const row: RowRef = { kind: 'task', id: task.id, createdBy: 'user', scheduleId: task.scheduleId, forkOf: null };
        const startInput = await sealInput(sealing.seal, row, proposal.input);
        return openTask(await raw.tasks.move({ ...rest, startInput }));
      },
    },
    schedules: {
      list: async () => Promise.all((await raw.schedules.list()).map(openSchedule)),
      setPaused: async (input: { id: string; paused: boolean }) => openSchedule(await raw.schedules.setPaused(input)),
      remove: raw.schedules.remove,
      // As the browser does: title, prompt, directory and agent sealed together under the schedule. What `changes` leaves out stays as it is.
      update: async (changes: ScheduleChanges & { id: string }) => {
        const current = (await Promise.all((await raw.schedules.list()).map(openSchedule))).find(
          ({ id }) => id === changes.id,
        );
        // A schedule that is not there gets a valid edit, so the board's answer is the refusal under test.
        const kept: Required<Omit<ScheduleChanges, 'at' | 'lane' | 'effort'>> =
          current === undefined
            ? {
                title: 'title',
                input: 'input',
                agent: null,
                place: null,
                priority: 'normal' as const,
                model: null,
                autoDone: false,
                repeat: { everyMs: 3_600_000 },
                runsLeft: null,
                until: null,
                maxConcurrent: null,
              }
            : {
                title: current.title,
                input: current.input,
                agent: current.agent ?? null,
                place:
                  current.machine !== null && current.workdir !== null
                    ? { machine: current.machine, workdir: current.workdir }
                    : null,
                priority: current.priority,
                model: current.model,
                autoDone: current.autoDone,
                repeat:
                  current.after !== null
                    ? { after: current.after }
                    : current.everyMs !== null
                      ? { everyMs: current.everyMs }
                      : {
                          cron: current.cron!,
                          ...(current.moreCrons?.length ? { moreCrons: current.moreCrons } : {}),
                          timezone: current.timezone!,
                        },
                runsLeft: runsLeft(current),
                until: current.until,
                maxConcurrent: current.maxConcurrent,
              };
        const { id, at, lane, effort, ...next } = { ...kept, ...changes };
        const fields = await sealFields(
          sealing.seal,
          { kind: 'schedule', id, agent: next.agent },
          { title: next.title, input: next.input, workdir: next.place?.workdir },
        );
        const { schedule, pending } = await raw.schedules.update({
          id,
          title: fields.title,
          input: fields.input,
          ...(fields.agent === undefined ? {} : { agent: fields.agent }),
          place:
            next.place === null || fields.workdir === undefined
              ? null
              : { machine: next.place.machine, workdir: fields.workdir },
          priority: next.priority,
          model: next.model,
          ...(effort === undefined ? {} : { effort }),
          ...(lane === undefined ? {} : { lane }),
          autoDone: next.autoDone,
          repeat: next.repeat,
          ...(at === undefined ? {} : { at }),
          runsLeft: next.runsLeft,
          until: next.until,
          maxConcurrent: next.maxConcurrent,
        });
        return { schedule: await openSchedule(schedule), pending };
      },
    },
    machines: raw.machines,
    keys: raw.keys,
    me: raw.me,
    transcript: {
      runs: raw.transcript.runs,
      events: async ({ taskId, ...input }: { taskId: string; runId: string; afterSeq?: number }) =>
        Promise.all(
          (await raw.transcript.events(input)).map(async ({ data, ...row }) => ({
            ...row,
            ...(JSON.parse(
              await sealing.openStrict(transcriptBinding('tr.data', taskId, input.runId, row.seq), data),
            ) as Record<string, unknown>),
          })),
        ),
      output: async ({ taskId, ...input }: { taskId: string; runId: string; seq: number }) => {
        const output = await raw.transcript.output(input);
        return output === null
          ? null
          : sealing.openStrict(transcriptBinding('tr.output', taskId, input.runId, input.seq), output);
      },
    },
  };
}

async function openPreviewText(
  sealing: Sealing,
  taskId: string,
  note: { author: 'agent' | 'user' | 'system' | 'server'; kind: NoteKind; preview: string | null },
): Promise<string | undefined> {
  return (await openPreview(sealing.open, taskId, note)).text;
}
