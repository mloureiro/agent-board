import {
  EFFORTS,
  isModelName,
  isSafeLane,
  isSafeMachineName,
  isSafeTaskId,
  isSourceId,
  isWatchId,
  parseKeyId,
  parseKeySlots,
  PRIORITIES,
  SOURCE_ACTIONS,
  STATUSES,
  type WireNote,
  type WireScheduleDraft,
  type WireTask,
  MAX_INT32,
  MAX_INTERVAL_MS,
  MAX_SCHEDULE_CONCURRENT,
  MAX_SCHEDULE_CRONS,
} from '@agent-board/shared';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db/client';
import { tasks, type NoteRow, type TaskRow } from '../db/schema';
import { ACCOUNT_TABLES, deleteAccount, exportPage, importRows, summarize } from '../services/account';
import { getKeys, replaceSlots, setupKeys } from '../services/keys';
import { getLinkRules, setLinkRules } from '../services/linkRules';
import { getTitleRules, setTitleRules } from '../services/titleRules';
import {
  issueToken,
  listMachineCatalogs,
  listMachines,
  listMachineSources,
  requestSource,
  revokeMachine,
} from '../services/machines';
import { sharedAgentsForBrowser } from '../services/sharedAgents';
import {
  addSchedule,
  heldTaskIds,
  listSchedules,
  removeSchedule,
  setPaused,
  toSchedule,
  updateSchedule,
} from '../services/schedules';
import { hasStarted } from '../services/taskRows';
import { eventOutput, latestContext, listEvents, listRuns } from '../services/transcripts';
import {
  addTask,
  answer,
  applyPolish,
  configureTask,
  dismissQuestion,
  forkTask,
  editPrompt,
  getTask,
  listTasksWithLastNote,
  type LastNote,
  markDone,
  moveTask,
  readNotes,
  rerunFresh,
  removePr,
  reply,
  send,
  setClosed,
  setNotBefore,
  setPriority,
  stop,
  stopWatch,
  takeBack,
  toNote,
  listTaskPrs,
  toTask,
  wakeNow,
} from '../services/tasks';
import { authRouter, passkeysRouter } from './auth';
import { parsedBy, sealed } from './inputs';
import { procedure, router } from './trpc';

const id = z.string().refine(isSafeTaskId, 'not a task id');
const status = z.enum(STATUSES);
const priority = z.enum(PRIORITIES);
const model = z.string().refine(isModelName, 'not a model name');
const effort = z.enum(EFFORTS);
const lane = z.string().refine(isSafeLane, 'not a lane name');
const repeatEnd = {
  times: z.number().int().positive().max(MAX_INT32).optional(),
  until: z.coerce.date().optional(),
  maxConcurrent: z.number().int().min(1).max(MAX_SCHEDULE_CONCURRENT).optional(),
};
const intervalRule = { every: z.number().int().min(60_000).max(MAX_INTERVAL_MS) };
const cronRule = {
  cron: z.string().trim().min(1),
  moreCrons: z
    .array(z.string().trim().min(1))
    .max(MAX_SCHEDULE_CRONS - 1)
    .optional(),
  timezone: z.string().trim().min(1),
};
/**
 * A repeat: an interval in ms, a cron expression with its time zone (and up to nine more), or a schedule to run after, with a
 * delay; `at` is the first run of the first two.
 */
const repeat = z
  .union([
    z.object({ ...intervalRule, at: z.coerce.date().optional(), ...repeatEnd }),
    z.object({ ...cronRule, at: z.coerce.date().optional(), ...repeatEnd }),
    z.object({
      after: z.object({ scheduleId: id, delayMs: z.number().int().min(0).max(MAX_INTERVAL_MS).default(0) }),
      ...repeatEnd,
    }),
  ])
  .refine(
    (when) => when.times === undefined || when.until === undefined,
    'Give a number of runs or an end time, not both',
  );
const keyId = parsedBy(z.unknown(), parseKeyId);
const keySlots = parsedBy(z.unknown(), parseKeySlots);
/** A note's sealed text and, optionally, the sealed start of it for the board card. */
const noteInput = z.object({
  body: sealed('note.body', 'message'),
  preview: sealed('note.preview', 'preview').nullish(),
});
/** A machine name as the worker checks it: it reaches argv and unit names there, so the board takes no other shape. */
const machineName = z.string().refine(isSafeMachineName, 'not a safe machine name');
function ruleOf(
  when: z.output<typeof repeat>,
): Pick<WireScheduleDraft, 'everyMs' | 'cron' | 'moreCrons' | 'timezone' | 'after'> {
  if ('every' in when) return { everyMs: when.every };
  if ('cron' in when)
    return {
      cron: when.cron,
      ...(when.moreCrons?.length ? { moreCrons: when.moreCrons } : {}),
      timezone: when.timezone,
    };
  return { after: when.after };
}
const createStatus = { now: 'todo', backlog: 'backlog', hold: 'needs-me' } as const;

/** What the board needs of a task beyond the contract's fields. `title`, `input` and `workdir` are still sealed. */
export interface WireBoardTask extends WireTask {
  proposed: boolean;
  /** A worker claimed the task at some point; until then its prompt can still be edited. */
  started: boolean;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A note of a thread; `body`, `preview`, `questions` and `answers` are sealed, except the body of a note by the server. */
export interface WireThreadNote extends WireNote {
  by: string | null;
}

export type { LastNote };

function toBoardTask(row: TaskRow, prs: Parameters<typeof toTask>[1], held = false): WireBoardTask {
  return {
    ...toTask(row, prs, { held }),
    proposed: row.proposed,
    started: hasStarted(row),
    parentId: row.parentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function boardTasks(db: DbOrTx, rows: TaskRow[]): Promise<WireBoardTask[]> {
  const prs = await listTaskPrs(
    db,
    rows.map(({ id }) => id),
  );
  const held = await heldTaskIds(db, rows);
  return rows.map((row) => toBoardTask(row, prs.get(row.id), held.has(row.id)));
}

async function boardTask(db: DbOrTx, row: TaskRow): Promise<WireBoardTask> {
  return toBoardTask(row, (await listTaskPrs(db, [row.id])).get(row.id), (await heldTaskIds(db, [row])).has(row.id));
}

const threadNote = (row: NoteRow): WireThreadNote => ({ ...toNote(row), by: row.by });

const tasksRouter = router({
  /** Each task with its newest note, for the board cards. */
  list: procedure
    .input(z.object({ closed: z.boolean().default(false) }).default({ closed: false }))
    .query(async ({ ctx, input }) => {
      const rows = await listTasksWithLastNote(ctx.db, { closed: input.closed });
      const prs = await listTaskPrs(
        ctx.db,
        rows.map(({ row }) => row.id),
      );
      const held = await heldTaskIds(
        ctx.db,
        rows.map(({ row }) => row),
      );
      return rows.map(({ row, lastNote }) => ({ ...toBoardTask(row, prs.get(row.id), held.has(row.id)), lastNote }));
    }),

  get: procedure.input(z.object({ id })).query(async ({ ctx, input }) => {
    const row = await getTask(ctx.db, input.id);
    const thread = (await readNotes(ctx.db, input.id)).map(threadNote);
    const related = await ctx.db.select().from(tasks).where(eq(tasks.parentId, input.id)).orderBy(asc(tasks.createdAt));
    const parent = row.parentId ? await getTask(ctx.db, row.parentId) : null;
    return {
      task: await boardTask(ctx.db, row),
      thread,
      followUps: await boardTasks(ctx.db, related),
      parent: parent ? await boardTask(ctx.db, parent) : null,
    };
  }),

  /**
   * A sealed prompt with its sealed title; it runs in the default directory of whichever machine takes it, or, with `place`,
   * only on that machine and in that sealed directory (a polish task runs where its Backlog task would; a repeating task's
   * occurrences all do). `id` is the task's, or the schedule's when `when` repeats (its occurrences get ids of the server's):
   * the fields are sealed against it.
   */
  create: procedure
    .input(
      z.object({
        id,
        title: sealed('title', 'title'),
        input: sealed('input', 'input'),
        priority: priority.default('normal'),
        /** The Claude model of its runs; absent is claude's default. */
        model: model.optional(),
        /** The effort level of its runs; absent is claude's default. */
        effort: effort.optional(),
        /** The lane of the machine that should run the task, or each occurrence of its schedule; absent is the default lane. */
        lane: lane.optional(),
        /** The agent may move the task, or each occurrence of its schedule, to Done itself; absent is off. */
        autoDone: z.boolean().optional(),
        /** The task this one follows from, which must be on the board. */
        parentId: id.optional(),
        when: z.union([repeat, z.enum(['now', 'backlog', 'hold']), z.object({ at: z.coerce.date() })]).default('now'),
        /** The machine and the sealed directory the task runs in, or its schedule's occurrences (sealed for the schedule). */
        place: z.object({ machine: machineName, workdir: sealed('workdir', 'directory') }).optional(),
        /** The sealed name of the agent the task, or each occurrence of its schedule, runs as; the prompt is sealed under it too. */
        agent: sealed('agent', 'agent').optional(),
        icon: sealed('icon', 'icon').optional(),
        labels: sealed('labels', 'labels').optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { title, when, place, agent, icon, labels } = input;
      if (typeof when === 'object' && ('every' in when || 'cron' in when || 'after' in when)) {
        const { task } = await addSchedule(ctx.db, {
          id: input.id,
          title,
          input: input.input,
          priority: input.priority,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          ...(input.lane === undefined ? {} : { lane: input.lane }),
          ...(input.autoDone === undefined ? {} : { autoDone: input.autoDone }),
          ...(place === undefined ? {} : { machine: place.machine, workdir: place.workdir }),
          ...(agent === undefined ? {} : { agent }),
          ...(icon === undefined ? {} : { icon }),
          ...(labels === undefined ? {} : { labels }),
          ...ruleOf(when),
          ...('at' in when && when.at ? { startAt: when.at } : {}),
          ...(when.times ? { times: when.times } : {}),
          ...(when.until ? { until: when.until } : {}),
          ...(when.maxConcurrent ? { maxConcurrent: when.maxConcurrent } : {}),
        });
        return task === null ? null : boardTask(ctx.db, task);
      }
      const { row } = await addTask(ctx.db, {
        id: input.id,
        title,
        input: input.input,
        priority: input.priority,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.lane === undefined ? {} : { lane: input.lane }),
        ...(input.autoDone === undefined ? {} : { autoDone: input.autoDone }),
        status: typeof when === 'string' ? createStatus[when] : 'todo',
        notBefore: typeof when === 'string' ? undefined : when.at,
        createdBy: 'user',
        ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
        ...(place === undefined ? {} : { machine: place.machine, workdir: place.workdir }),
        ...(agent === undefined ? {} : { agent }),
        ...(icon === undefined ? {} : { icon }),
        ...(labels === undefined ? {} : { labels }),
      });
      return boardTask(ctx.db, row);
    }),

  /**
   * A new task, in Todo, that continues a copy of the session of `parentId` with its own prompt. The server takes the machine, the
   * model and the priority from the parent; the browser seals the prompt for the fork link, and the parent's directory and agent
   * for the new task.
   */
  fork: procedure
    .input(
      z.object({
        id,
        parentId: id,
        title: sealed('title', 'title'),
        input: sealed('input', 'input'),
        workdir: sealed('workdir', 'directory'),
        agent: sealed('agent', 'agent').optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      boardTask(
        ctx.db,
        await forkTask(ctx.db, {
          id: input.id,
          parentId: input.parentId,
          title: input.title,
          input: input.input,
          workdir: input.workdir,
          ...(input.agent === undefined ? {} : { agent: input.agent }),
        }),
      ),
    ),

  answer: procedure
    .input(
      z.object({
        id,
        questionNoteId: z.string().min(1),
        answers: sealed('note.answers', 'answers'),
        message: noteInput,
      }),
    )
    .mutation(async ({ ctx, input }) =>
      boardTask(
        ctx.db,
        await answer(ctx.db, {
          taskId: input.id,
          questionNoteId: input.questionNoteId,
          answers: input.answers,
          message: input.message,
          by: ctx.username,
        }),
      ),
    ),

  dismissQuestion: procedure
    .input(z.object({ id, questionNoteId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) =>
      boardTask(ctx.db, await dismissQuestion(ctx.db, { taskId: input.id, questionNoteId: input.questionNoteId })),
    ),

  reply: procedure
    .input(z.object({ id, message: noteInput, resume: z.boolean() }))
    .mutation(async ({ ctx, input }) =>
      boardTask(
        ctx.db,
        await reply(ctx.db, { taskId: input.id, message: input.message, resume: input.resume, by: ctx.username }),
      ),
    ),

  /**
   * "Send": a sealed message to the agent. On a running task it reaches the agent without interrupting it; in any other
   * status it is "Send & continue".
   */
  send: procedure
    .input(z.object({ id, message: noteInput }))
    .mutation(async ({ ctx, input }) =>
      boardTask(ctx.db, await send(ctx.db, { taskId: input.id, message: input.message, by: ctx.username })),
    ),

  /**
   * "Stop" (and "Stop & send" with `message`, a sealed message that follows the interruption): a running task's run is
   * interrupted; an answered task that has not started again goes to Needs me, and a waiting one to Backlog.
   */
  stop: procedure
    .input(z.object({ id, message: noteInput.optional() }))
    .mutation(async ({ ctx, input }) =>
      boardTask(ctx.db, await stop(ctx.db, { taskId: input.id, message: input.message, by: ctx.username })),
    ),

  /**
   * Applies an agent's polished title and prompt (sealed again as the user's) to the task `id`, keeps the old text in a note
   * of the user's (`previous`), and marks the polishing task `polishId` done.
   */
  applyPolish: procedure
    .input(
      z.object({
        id,
        polishId: id,
        title: sealed('title', 'title'),
        input: sealed('input', 'prompt'),
        previous: noteInput,
      }),
    )
    .mutation(async ({ ctx, input }) =>
      boardTask(
        ctx.db,
        await applyPolish(ctx.db, {
          taskId: input.id,
          polishId: input.polishId,
          title: input.title,
          input: input.input,
          previous: input.previous,
          by: ctx.username,
        }),
      ),
    ),

  /**
   * A new title and prompt (sealed as the user's) for a task of the user's that has not started, in Todo or Backlog; the
   * old text stays in a note of the user's (`previous`).
   */
  edit: procedure
    .input(z.object({ id, title: sealed('title', 'title'), input: sealed('input', 'prompt'), previous: noteInput }))
    .mutation(async ({ ctx, input }) =>
      boardTask(
        ctx.db,
        await editPrompt(ctx.db, {
          taskId: input.id,
          title: input.title,
          input: input.input,
          previous: input.previous,
          by: ctx.username,
        }),
      ),
    ),

  done: procedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => boardTask(ctx.db, await markDone(ctx.db, input.id, ctx.username))),

  rerun: procedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => boardTask(ctx.db, await rerunFresh(ctx.db, input.id, ctx.username))),

  setPriority: procedure
    .input(z.object({ id, priority }))
    .mutation(async ({ ctx, input }) =>
      boardTask(ctx.db, await setPriority(ctx.db, input.id, input.priority, ctx.username)),
    ),

  /**
   * Changes a task's settings after creation. A `place` pins it to the machine and the sealed directory (null: none) and drops
   * its session, so the next run starts fresh there; a running or waiting task is refused with CONFLICT. A model or an effort applies from the next run on; a lane is refused (CONFLICT) while the task runs; `autoDone` and a sealed `title` apply at once, in any status; a title is refused (CONFLICT) on a schedule's occurrence.
   */
  configure: procedure
    .input(
      z
        .object({
          id,
          priority: priority.optional(),
          model: model.nullable().optional(),
          effort: effort.nullable().optional(),
          lane: lane.nullable().optional(),
          autoDone: z.boolean().optional(),
          icon: sealed('icon', 'icon').nullable().optional(),
          labels: sealed('labels', 'labels').nullable().optional(),
          place: z
            .object({ machine: machineName, workdir: sealed('workdir', 'directory') })
            .nullable()
            .optional(),
          title: sealed('title', 'title').optional(),
        })
        .refine(
          ({ priority: p, model: m, effort: e, lane: l, autoDone, icon, labels, place, title }) =>
            p !== undefined ||
            m !== undefined ||
            e !== undefined ||
            l !== undefined ||
            autoDone !== undefined ||
            icon !== undefined ||
            labels !== undefined ||
            place !== undefined ||
            title !== undefined,
          'change at least one of priority, model, effort, lane, autoDone, icon, labels, place and title',
        ),
    )
    .mutation(async ({ ctx, input: { id: taskId, ...config } }) =>
      boardTask(ctx.db, await configureTask(ctx.db, taskId, config, ctx.username)),
    ),

  /** Delays a Todo task until `notBefore`; null makes it claimable now. */
  setNotBefore: procedure
    .input(z.object({ id, notBefore: z.coerce.date().nullable() }))
    .mutation(async ({ ctx, input }) =>
      boardTask(ctx.db, await setNotBefore(ctx.db, input.id, input.notBefore, ctx.username)),
    ),

  /** Ends a wait early: the task resumes next in its session. */
  wakeNow: procedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => boardTask(ctx.db, await wakeNow(ctx.db, input.id, ctx.username))),

  /** A running task whose agent has been quiet too long: its worker is gone, so the task goes to Needs me. */
  takeBack: procedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => boardTask(ctx.db, await takeBack(ctx.db, input.id, ctx.username))),

  /** Takes a reported PR off the task. It deletes a row and seals nothing, so the browser may do it. */
  removePr: procedure.input(z.object({ id, prId: id })).mutation(async ({ ctx, input }) => {
    await removePr(ctx.db, input.id, input.prId);
    return boardTask(ctx.db, await getTask(ctx.db, input.id));
  }),

  /** Asks the task's machine to stop one of its watches; it acts on the next tick and tells the agent. Sends nothing sealed. */
  stopWatch: procedure
    .input(z.object({ id, watchId: z.string().refine(isWatchId, 'not a watch id') }))
    .mutation(async ({ ctx, input }) => boardTask(ctx.db, await stopWatch(ctx.db, input.id, input.watchId))),

  setClosed: procedure
    .input(z.object({ id, closed: z.boolean() }))
    .mutation(async ({ ctx, input }) =>
      boardTask(ctx.db, await setClosed(ctx.db, input.id, input.closed, ctx.username)),
    ),

  move: procedure
    .input(
      z.object({
        id,
        status,
        beforeId: id.optional(),
        afterId: id.optional(),
        /** Into Todo, an agent's proposal needs its prompt sealed again as the user's. */
        startInput: sealed('input', 'prompt').optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      boardTask(
        ctx.db,
        await moveTask(ctx.db, {
          taskId: input.id,
          status: input.status,
          beforeId: input.beforeId,
          afterId: input.afterId,
          startInput: input.startInput,
          by: ctx.username,
        }),
      ),
    ),
});

const schedulesRouter = router({
  list: procedure.query(async ({ ctx }) => (await listSchedules(ctx.db)).map(toSchedule)),
  setPaused: procedure
    .input(z.object({ id, paused: z.boolean() }))
    .mutation(async ({ ctx, input }) => toSchedule(await setPaused(ctx.db, input.id, input.paused))),
  /**
   * Replaces everything the user sets on a schedule. `title`, `input`, `agent` and the directory are sealed together under the
   * schedule (the first two are bound to the agent); an absent `agent` is none, and a null `place` is no machine and directory.
   * `at` is the first run of a rule of its own, absent keeps it; `runsLeft` counts the pending card, null is forever.
   */
  update: procedure
    .input(
      z
        .object({
          id,
          title: sealed('title', 'title'),
          input: sealed('input', 'prompt'),
          agent: sealed('agent', 'agent').optional(),
          place: z.object({ machine: machineName, workdir: sealed('workdir', 'directory') }).nullable(),
          priority,
          model: model.nullable(),
          /** An effort level, or null for claude's default; absent keeps the schedule's. */
          effort: effort.nullable().optional(),
          /** A lane name, or null for the default lane; absent keeps the schedule's. */
          lane: lane.nullable().optional(),
          icon: sealed('icon', 'icon').nullable().optional(),
          labels: sealed('labels', 'labels').nullable().optional(),
          autoDone: z.boolean(),
          repeat: z.union([
            z.object({ everyMs: intervalRule.every }),
            z.object(cronRule),
            z.object({
              after: z.object({ scheduleId: id, delayMs: z.number().int().min(0).max(MAX_INTERVAL_MS) }),
            }),
          ]),
          at: z.coerce.date().optional(),
          runsLeft: z.number().int().positive().max(MAX_INT32).nullable(),
          until: z.coerce.date().nullable(),
          maxConcurrent: z.number().int().min(1).max(MAX_SCHEDULE_CONCURRENT).nullable(),
        })
        .refine(
          (edit) => edit.runsLeft === null || edit.until === null,
          'Give a number of runs or an end time, not both',
        ),
    )
    .mutation(async ({ ctx, input }) => {
      const { schedule, pending } = await updateSchedule(ctx.db, {
        id: input.id,
        title: input.title,
        input: input.input,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        place: input.place,
        priority: input.priority,
        model: input.model,
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.lane === undefined ? {} : { lane: input.lane }),
        ...(input.icon === undefined ? {} : { icon: input.icon }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        autoDone: input.autoDone,
        rule: 'everyMs' in input.repeat ? { everyMs: input.repeat.everyMs } : ruleOf(input.repeat),
        ...(input.at === undefined ? {} : { startAt: input.at }),
        runsLeft: input.runsLeft,
        until: input.until,
        maxConcurrent: input.maxConcurrent,
      });
      return { schedule: toSchedule(schedule), pending };
    }),
  remove: procedure.input(z.object({ id })).mutation(({ ctx, input }) => removeSchedule(ctx.db, input.id)),
});

const machinesRouter = router({
  list: procedure.query(({ ctx }) => listMachines(ctx.db, ctx.config.cliVersion)),
  /** The sealed skills and models each machine sent, for the forms that complete `/skill` and offer models; not polled. */
  catalogs: procedure.query(({ ctx }) => listMachineCatalogs(ctx.db)),
  /** The newest CLI release this server knows of, x.y.z, or null. */
  advertisedCli: procedure.query(({ ctx }) => ctx.config.cliVersion),
  /** Returns the token once; only its hash is stored. */
  issue: procedure
    .input(z.object({ name: z.string().min(1).max(256) }))
    .mutation(async ({ ctx, input }) => ({ token: await issueToken(ctx.db, input.name) })),
  // Any name: a token issued before names were restricted must stay revocable, whatever its name.
  revoke: procedure
    .input(z.object({ name: z.string().min(1).max(256) }))
    .mutation(async ({ ctx, input }) => revokeMachine(ctx.db, input.name)),
});

const sourcesRouter = router({
  /** The sealed sources and pending requests of every machine that sent sources. */
  list: procedure.query(({ ctx }) => listMachineSources(ctx.db)),
  /** Pause, resume or run one source now; the machine applies it on its next dispatch tick, which this mutation starts. */
  request: procedure
    .input(
      z.object({
        machine: z.string().min(1).max(256),
        action: z.enum(SOURCE_ACTIONS),
        id: z.string().refine(isSourceId, 'not a source id'),
      }),
    )
    .mutation(({ ctx, input }) => requestSource(ctx.db, input.machine, { action: input.action, id: input.id })),
});

const agentsRouter = router({
  /**
   * The agent definitions pushed for every machine: the sealed document, its version and when it was pushed, or null. Read
   * only: the CLI's `board agents push` is the one writer.
   */
  shared: procedure.query(({ ctx }) => sharedAgentsForBrowser(ctx.db)),
});

const linksRouter = router({
  /** The sealed link rules with their version and when they were saved, or null before the first save. */
  get: procedure.query(({ ctx }) => getLinkRules(ctx.db)),
  /** Stores the next version while the board's is still `expectedVersion` (0: none); CONFLICT when another save came first. */
  set: procedure
    .input(
      z
        .object({
          document: sealed('links', 'links'),
          version: z.number().int().min(1).max(MAX_INT32),
          expectedVersion: z.number().int().min(0).lt(MAX_INT32),
        })
        .refine(({ version, expectedVersion }) => version === expectedVersion + 1, {
          message: 'version must be expectedVersion + 1',
        }),
    )
    .mutation(({ ctx, input }) => setLinkRules(ctx.db, input)),
});

const titleRulesRouter = router({
  /** The sealed title rules with their version and when they were saved, or null before the first save. */
  get: procedure.query(({ ctx }) => getTitleRules(ctx.db)),
  /** Stores the next version while the board's is still `expectedVersion` (0: none); CONFLICT when another save came first. */
  set: procedure
    .input(
      z
        .object({
          document: sealed('titles', 'titles'),
          version: z.number().int().min(1).max(MAX_INT32),
          expectedVersion: z.number().int().min(0).lt(MAX_INT32),
        })
        .refine(({ version, expectedVersion }) => version === expectedVersion + 1, {
          message: 'version must be expectedVersion + 1',
        }),
    )
    .mutation(({ ctx, input }) => setTitleRules(ctx.db, input)),
});

const transcriptRouter = router({
  /** A task's runs, newest first. */
  runs: procedure.input(z.object({ id })).query(({ ctx, input }) => listRuns(ctx.db, input.id)),
  /** A run's events after `afterSeq`, without tool output; poll with the last seq seen. */
  events: procedure
    .input(z.object({ runId: z.string().min(1), afterSeq: z.number().int().default(-1) }))
    .query(({ ctx, input }) => listEvents(ctx.db, input.runId, input.afterSeq)),
  context: procedure.input(z.object({ id })).query(({ ctx, input }) => latestContext(ctx.db, input.id)),
  /** One tool result's output, when someone opens it. */
  output: procedure
    .input(z.object({ runId: z.string().min(1), seq: z.number().int() }))
    .query(({ ctx, input }) => eventOutput(ctx.db, input.runId, input.seq)),
});

const keysRouter = router({
  /** The key id and the wrapped copies of the data key, or null before setup. The server cannot open them. */
  get: procedure.query(({ ctx }) => getKeys(ctx.db)),
  setup: procedure.input(z.object({ keyId, slots: keySlots })).mutation(({ ctx, input }) => setupKeys(ctx.db, input)),
  replaceSlots: procedure
    .input(z.object({ keyId, slots: keySlots }))
    .mutation(({ ctx, input }) => replaceSlots(ctx.db, input)),
});

const accountRouter = router({
  /** What the board holds, for the export and the delete confirmation. */
  summary: procedure.query(({ ctx }) => summarize(ctx.db)),
  /** One page of a table as stored (sealed fields stay sealed, dates are ISO text, `owner` is left out); page on with `next`. */
  export: procedure
    .input(z.object({ table: z.enum(ACCOUNT_TABLES), cursor: z.string().max(1024).nullable().default(null) }))
    .query(({ ctx, input }) => exportPage(ctx.db, input.table, input.cursor)),
  /**
   * Writes rows of an export into this board, only under the key the export was made with. Import `task` before `schedule`,
   * `note`, `task_pr` and `transcript_run`, and `transcript_run` before `transcript_event`: a row whose task or run is not
   * there yet is skipped as orphaned.
   */
  import: procedure
    .input(z.object({ keyId, table: z.enum(ACCOUNT_TABLES), rows: z.array(z.unknown()).max(1000) }))
    .mutation(({ ctx, input }) => importRows(ctx.db, input)),
  /** Deletes the user and everything of theirs; `username` must be typed as the confirmation. */
  delete: procedure
    .input(z.object({ username: z.string() }))
    .mutation(({ ctx, input }) => deleteAccount(ctx.db, { username: ctx.username, confirm: input.username })),
});

export const appRouter = router({
  account: accountRouter,
  transcript: transcriptRouter,
  auth: authRouter,
  passkeys: passkeysRouter,
  me: procedure.query(async ({ ctx }) => ({ username: ctx.username, keyId: (await getKeys(ctx.db))?.keyId ?? null })),
  /** The commit the server was built from, shown at the bottom of the settings page. */
  revision: procedure.query(({ ctx }) => ctx.config.revision),
  keys: keysRouter,
  tasks: tasksRouter,
  schedules: schedulesRouter,
  machines: machinesRouter,
  sources: sourcesRouter,
  agents: agentsRouter,
  links: linksRouter,
  titleRules: titleRulesRouter,
});

export type AppRouter = typeof appRouter;
