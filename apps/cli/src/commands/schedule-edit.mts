// `board schedules edit <id> [text...] [--title t] [--priority p] [--model m] [--effort e] [--icon i] [--label l]... [--lane l] [--auto-done on|off] [--agent a] [--dir d]
// [--every d | --cron e | --after s [--delay d]] [--in d | --at t] [--times n | --until t | --forever] [--max-concurrent n]`:
// the prompt and every setting of a schedule, the ones the browser's Edit schedule form changes. What a flag leaves out stays
// as the schedule has it, and a new repeat replaces the old one.
import { isDeepStrictEqual } from 'node:util';
import { defaultTitle, describeRule, runsLeft } from '@agent-board/shared';
import type {
  Effort,
  PendingCardOutcome,
  Priority,
  Schedule,
  ScheduleRepeat,
  ScheduleSettings,
} from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import type { Context } from '../cli.mts';
import { plainLine } from '../output/terminal.mts';
import { confirm, requireLocalAgent } from './board.mts';
import { resolveScheduleId } from './ids.mts';
import {
  checkCrons,
  checkedAfter,
  checkedAgent,
  checkedLane,
  checkedEffort,
  checkedIcon,
  checkedLabels,
  checkedModel,
  checkedPriority,
  localTime,
  parseInterval,
  parseMaxConcurrent,
  parseStart,
  parseTimes,
} from './schedule.mts';
import { chosenDirectory } from './task-settings.mts';

// The flags of `board schedules edit`, as commander hands them over.
export interface ScheduleEditFlags {
  priority?: string;
  model?: string;
  effort?: string;
  icon?: string;
  // Repeatable: one string per `--label`; `none` alone removes them.
  label?: string[];
  lane?: string;
  autoDone?: string;
  agent?: string;
  dir?: string;
  every?: string;
  // Repeatable: one string per `--cron`; a caller may also hand over a single one.
  cron?: string | string[];
  after?: string;
  delay?: string;
  in?: string;
  at?: string;
  times?: string;
  until?: string;
  forever?: boolean;
  maxConcurrent?: string;
}

// What the flags ask for, checked for shape. A missing key leaves the setting as it is; null clears it (`none`, `default`).
export interface ScheduleChanges {
  priority?: Priority;
  model?: string | null;
  // null for claude's default effort.
  effort?: Effort | null;
  icon?: string | null;
  // The whole new list; empty removes them.
  labels?: string[];
  // null for the default lane.
  lane?: string | null;
  autoDone?: boolean;
  agent?: string | null;
  // The directory as typed; null for none.
  dir?: string | null;
  // A new repeat. `after` is the schedule as typed, an id or the start of one.
  repeat?: { every: number } | { crons: string[] } | { after: string };
  delay?: number;
  startAt?: Date;
  runsLeft?: number | null;
  until?: Date | null;
  maxConcurrent?: number | null;
}

const NONE = 'none';
const PENDING_CARD_LINES: Record<PendingCardOutcome, string> = {
  updated: 'The pending card was updated too',
  started: 'The pending card has already started; the change applies from the next run',
  none: 'The schedule has no pending card; its next run takes the change',
  removed: 'The pending card was removed; the next one is made when a card of the schedule it runs after finishes',
  created: "A card now waits for the schedule's next run",
};

// Every setting flag by name: a fixed list, so another option of the command (`--dry-run`, `--json`) never counts as one.
const SETTING_FLAGS = [
  'priority',
  'model',
  'effort',
  'icon',
  'label',
  'lane',
  'autoDone',
  'agent',
  'dir',
  'every',
  'cron',
  'after',
  'delay',
  'in',
  'at',
  'times',
  'until',
  'forever',
  'maxConcurrent',
] as const satisfies readonly (keyof ScheduleEditFlags)[];

/** Whether `flags` change a setting beyond title and prompt. */
export function changesSettings(flags: ScheduleEditFlags): boolean {
  return SETTING_FLAGS.some((key) => flags[key] !== undefined && flags[key] !== false);
}

function onOff(value: string): boolean {
  if (value !== 'on' && value !== 'off')
    throw new UsageError(`--auto-done takes on or off; got "${value.slice(0, 20)}"`);
  return value === 'on';
}

function conflictBetween(flags: [flag: string, given: boolean][], what: string): void {
  const given = flags.filter(([, isGiven]) => isGiven).map(([flag]) => flag);
  if (given.length > 1) throw new UsageError(`${given.join(', ')} cannot be combined: ${what}`);
}

export function parseScheduleChanges(flags: ScheduleEditFlags, now: Date = new Date()): ScheduleChanges {
  const crons = [flags.cron ?? []].flat().map((expression) => expression.trim());
  conflictBetween(
    [
      ['--every', flags.every !== undefined],
      ['--cron', crons.length > 0],
      ['--after', flags.after !== undefined],
    ],
    'a schedule has one repeat',
  );
  conflictBetween(
    [
      ['--in', flags.in !== undefined],
      ['--at', flags.at !== undefined],
    ],
    'give the first run once',
  );
  conflictBetween(
    [
      ['--times', flags.times !== undefined],
      ['--until', flags.until !== undefined],
      ['--forever', flags.forever === true],
    ],
    'a schedule ends one way',
  );
  // `--delay` alone changes the delay of a schedule that already runs after another; `editSchedule` checks that.
  if (flags.delay !== undefined && (flags.every !== undefined || crons.length > 0))
    throw new UsageError('--delay belongs to --after');
  const changes: ScheduleChanges = {};
  if (flags.priority !== undefined) changes.priority = checkedPriority(flags.priority);
  if (flags.model !== undefined) changes.model = flags.model === 'default' ? null : checkedModel(flags.model);
  if (flags.effort !== undefined) changes.effort = flags.effort === 'default' ? null : checkedEffort(flags.effort);
  if (flags.icon !== undefined) changes.icon = flags.icon === NONE ? null : checkedIcon(flags.icon);
  if (flags.label !== undefined)
    changes.labels = flags.label.length === 1 && flags.label[0] === NONE ? [] : checkedLabels(flags.label);
  if (flags.lane !== undefined) changes.lane = flags.lane === 'default' ? null : checkedLane(flags.lane);
  if (flags.autoDone !== undefined) changes.autoDone = onOff(flags.autoDone);
  if (flags.agent !== undefined) changes.agent = flags.agent === NONE ? null : checkedAgent(flags.agent);
  if (flags.dir !== undefined) {
    if (flags.dir === '') throw new UsageError('--dir takes a path, or none');
    changes.dir = flags.dir === NONE ? null : flags.dir;
  }
  if (flags.every !== undefined) changes.repeat = { every: parseInterval(flags.every) };
  if (crons.length > 0) {
    checkCrons(crons);
    changes.repeat = { crons };
  }
  if (flags.after !== undefined) changes.repeat = { after: checkedAfter(flags.after) };
  if (flags.delay !== undefined) changes.delay = parseInterval(flags.delay);
  const startAt = parseStart({ delay: flags.in, at: flags.at }, now);
  if (startAt !== undefined) changes.startAt = startAt;
  if (flags.times !== undefined) changes.runsLeft = parseTimes(flags.times);
  if (flags.until !== undefined) {
    const until = parseStart({ at: flags.until }, now) ?? null;
    if (until !== null && until.getTime() < (startAt ?? now).getTime())
      throw new UsageError('--until is before the first run');
    changes.until = until;
  }
  if (flags.forever === true) {
    changes.runsLeft = null;
    changes.until = null;
  }
  if (flags.maxConcurrent !== undefined)
    changes.maxConcurrent = flags.maxConcurrent === NONE ? null : parseMaxConcurrent(flags.maxConcurrent);
  return changes;
}

/** The settings the schedule has now, in the shape the board takes them back. */
export function settingsOf(schedule: Schedule): ScheduleSettings {
  const repeat: ScheduleRepeat =
    schedule.everyMs !== null
      ? { everyMs: schedule.everyMs }
      : schedule.after !== null
        ? { after: { scheduleId: schedule.after.scheduleId, delayMs: schedule.after.delayMs } }
        : {
            cron: schedule.cron ?? '',
            ...(schedule.moreCrons?.length ? { moreCrons: schedule.moreCrons } : {}),
            timezone: schedule.timezone ?? '',
          };
  return {
    ...(schedule.agent == null ? {} : { agent: schedule.agent }),
    place:
      schedule.machine !== null && schedule.workdir !== null
        ? { machine: schedule.machine, workdir: schedule.workdir }
        : null,
    priority: schedule.priority,
    model: schedule.model,
    ...(schedule.effort === null ? {} : { effort: schedule.effort }),
    autoDone: schedule.autoDone,
    repeat,
    runsLeft: runsLeft(schedule),
    until: schedule.until,
    maxConcurrent: schedule.maxConcurrent ?? null,
  };
}

interface Resolved {
  // Only a lane, an icon and labels that differ from the schedule's.
  lane?: string | null;
  icon?: string | null;
  labels?: string[];
  place?: ScheduleSettings['place'];
  repeat?: ScheduleRepeat;
}

/** The settings after `changes`: everything they leave out stays as in `before`. */
function applyChanges(before: ScheduleSettings, changes: ScheduleChanges, resolved: Resolved): ScheduleSettings {
  const { agent: currentAgent, ...rest } = before;
  const agent = changes.agent === undefined ? currentAgent : (changes.agent ?? undefined);
  const ends =
    changes.runsLeft === undefined && changes.until === undefined
      ? {}
      : { runsLeft: changes.runsLeft ?? null, until: changes.until ?? null };
  return {
    ...rest,
    ...(agent === undefined ? {} : { agent }),
    ...(changes.priority === undefined ? {} : { priority: changes.priority }),
    ...(changes.model === undefined ? {} : { model: changes.model }),
    ...(changes.effort === undefined ? {} : { effort: changes.effort }),
    ...(resolved.lane === undefined ? {} : { lane: resolved.lane }),
    ...(resolved.icon === undefined ? {} : { icon: resolved.icon }),
    ...(resolved.labels === undefined ? {} : { labels: resolved.labels }),
    ...(changes.autoDone === undefined ? {} : { autoDone: changes.autoDone }),
    ...(changes.maxConcurrent === undefined ? {} : { maxConcurrent: changes.maxConcurrent }),
    ...(resolved.place === undefined ? {} : { place: resolved.place }),
    ...(resolved.repeat === undefined ? {} : { repeat: resolved.repeat }),
    ...ends,
  };
}

/** The new repeat of `changes`: the rule they name, or the delay of the rule the schedule already has. */
async function repeatOf(
  context: Context,
  id: string,
  current: Schedule,
  changes: ScheduleChanges,
): Promise<ScheduleRepeat | undefined> {
  const { repeat } = changes;
  if (repeat === undefined) {
    if (changes.delay === undefined) return undefined;
    if (current.after === null) throw new UsageError('--delay belongs to --after');
    return { after: { scheduleId: current.after.scheduleId, delayMs: changes.delay } };
  }
  if ('every' in repeat) return { everyMs: repeat.every };
  if ('crons' in repeat) {
    const [cron = '', ...more] = repeat.crons;
    return {
      cron,
      ...(more.length > 0 ? { moreCrons: more } : {}),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }
  const scheduleId = await resolveScheduleId(context.backend, repeat.after, { inRun: false });
  if (scheduleId === id) throw new UsageError('a schedule cannot run after itself');
  // The same upstream again keeps its delay unless --delay gives a new one.
  const kept = current.after?.scheduleId === scheduleId ? current.after.delayMs : 0;
  return { after: { scheduleId, delayMs: changes.delay ?? kept } };
}

const ruleLine = (repeat: ScheduleRepeat): string =>
  describeRule({
    everyMs: 'everyMs' in repeat ? repeat.everyMs : null,
    cron: 'cron' in repeat ? repeat.cron : null,
    moreCrons: 'cron' in repeat ? (repeat.moreCrons ?? []) : [],
    timezone: 'cron' in repeat ? repeat.timezone : null,
    after: 'after' in repeat ? repeat.after : null,
  });

/** What differs between the settings, one phrase each; the end of a schedule (runs or time) is one phrase. */
function differences(before: ScheduleSettings, after: ScheduleSettings, startAt: Date | undefined): string[] {
  const changed = (key: keyof ScheduleSettings): boolean => !isDeepStrictEqual(before[key], after[key]);
  const endsAt =
    after.runsLeft !== null
      ? `${after.runsLeft} runs left`
      : after.until !== null
        ? `until ${localTime(after.until)}`
        : 'forever';
  return [
    ...(changed('agent') ? [`agent ${plainLine(after.agent ?? NONE)}`] : []),
    ...(changed('place')
      ? [
          after.place === null
            ? 'no directory'
            : `directory ${plainLine(after.place.workdir)} on ${after.place.machine}`,
        ]
      : []),
    ...(changed('priority') ? [`priority ${after.priority}`] : []),
    ...(changed('model') ? [`model ${plainLine(after.model ?? 'default')}`] : []),
    ...((before.effort ?? null) === (after.effort ?? null) ? [] : [`effort ${after.effort ?? 'default'}`]),
    ...(after.lane === undefined ? [] : [`lane ${plainLine(after.lane ?? 'default')}`]),
    ...(after.icon === undefined ? [] : [`icon ${after.icon ?? NONE}`]),
    ...(after.labels === undefined ? [] : [`labels ${plainLine(after.labels.join(', ')) || NONE}`]),
    ...(changed('autoDone') ? [`auto-done ${after.autoDone ? 'on' : 'off'}`] : []),
    ...(changed('repeat') ? [`repeat ${plainLine(ruleLine(after.repeat))}`] : []),
    ...(startAt === undefined ? [] : [`first run ${localTime(startAt)}`]),
    ...(changed('runsLeft') || changed('until') ? [endsAt] : []),
    ...(changed('maxConcurrent')
      ? [after.maxConcurrent === null ? 'no concurrency limit' : `max ${after.maxConcurrent} at once`]
      : []),
  ];
}

export interface ScheduleEditOptions {
  // The new prompt; undefined keeps the current one (a setting or the title changes instead).
  text?: string | undefined;
  // The new title; undefined keeps the current one, an empty one is made from the prompt.
  title?: string | undefined;
  flags: ScheduleEditFlags;
  // Where a relative `--dir` starts.
  cwd: string;
  now?: Date;
}

/**
 * The user's new prompt and title for a schedule, and with setting flags every other setting too. Every later run takes them;
 * the pending card too while it has not started. The old text is not kept.
 */
export async function editSchedule(context: Context, id: string, options: ScheduleEditOptions): Promise<void> {
  const { flags, now = new Date() } = options;
  const changes = parseScheduleChanges(flags, now);
  const hasSettings = changesSettings(flags);
  if (options.text === undefined && options.title === undefined && !hasSettings)
    throw new UsageError('the text is missing: give the new prompt, or a setting to change');
  const text = options.text?.trim();
  if (text === '') throw new UsageError('the prompt is missing');
  const current = (await context.backend.listSchedules()).find((schedule) => schedule.id === id);
  if (current === undefined) throw new UsageError(`no schedule ${plainLine(id).slice(0, 40)}`);
  if (current.ended) throw new UsageError(`${id} has ended; an ended schedule can only be deleted`);
  if (current.unreadable.length > 0) throw new UsageError(`${id} cannot be decrypted here, so it is not edited here`);
  const input = text ?? current.input;
  const title = options.title === undefined ? current.title : options.title.trim() || defaultTitle(input);
  if (!hasSettings) {
    if (title === current.title && input === current.input)
      return context.print(`${id} already has this title and prompt`);
    const { pending } = await context.backend.editSchedule(id, { title, input });
    return confirm(context, `${id} prompt updated. ${PENDING_CARD_LINES[pending]}.`);
  }

  const before = settingsOf(current);
  const place =
    changes.dir === undefined
      ? undefined
      : changes.dir === null
        ? null
        : {
            machine: context.config.machine,
            workdir: chosenDirectory(
              { machine: context.config.machine, dirs: context.config.dirs, cwd: options.cwd },
              changes.dir,
            ),
          };
  const repeat = await repeatOf(context, id, current, changes);
  const lane = changes.lane === current.requestedLane ? undefined : changes.lane;
  const icon = changes.icon === current.icon ? undefined : changes.icon;
  const labels =
    changes.labels === undefined || changes.labels.join('\n') === current.labels.join('\n')
      ? undefined
      : changes.labels;
  const after = applyChanges(before, changes, {
    ...(lane === undefined ? {} : { lane }),
    ...(icon === undefined ? {} : { icon }),
    ...(labels === undefined ? {} : { labels }),
    ...(place === undefined ? {} : { place }),
    ...(repeat === undefined ? {} : { repeat }),
  });
  if (changes.startAt !== undefined && 'after' in after.repeat)
    throw new UsageError(
      '--in and --at set the first run of a schedule with a rule of its own, not one that runs after another',
    );
  if (
    (flags.agent !== undefined || flags.dir !== undefined) &&
    after.agent !== undefined &&
    after.place?.machine === context.config.machine
  )
    requireLocalAgent(context.config, after.agent);
  const startAt =
    changes.startAt !== undefined && changes.startAt.getTime() !== current.anchorAt.getTime()
      ? changes.startAt
      : undefined;
  const settingParts = differences(before, after, startAt);
  const textParts = [...(title === current.title ? [] : ['title']), ...(input === current.input ? [] : ['prompt'])];
  if (settingParts.length === 0 && textParts.length === 0) return context.print(`${id} already has these settings`);
  const { pending } = await context.backend.editSchedule(id, {
    title,
    input,
    settings: { ...after, ...(startAt === undefined ? {} : { at: startAt }) },
  });
  confirm(context, `${id} updated: ${[...textParts, ...settingParts].join(', ')}. ${PENDING_CARD_LINES[pending]}.`);
}
