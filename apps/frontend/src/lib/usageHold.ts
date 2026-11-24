import type { MachineUsageWindow, Priority } from '@agent-board/shared';
import { clock } from './time';
import type { Machine } from '@agent-board/shared/ui';

/** The dispatcher ticks at least every 2 minutes; a machine not seen for longer says nothing about the board's tasks any more. */
export const HOLD_FRESH_MS = 10 * 60_000;

const WINDOW_LABELS: Record<MachineUsageWindow, string> = { fiveHour: '5-hour', sevenDay: '7-day' };

export interface HoldWindow {
  window: MachineUsageWindow;
  percent: number;
  threshold: number;
  resetsAt: Date;
}

/** What a machine holds back for usage: the windows still over their threshold, and the priority from which tasks still start. */
export interface ActiveHold {
  priority: Priority;
  windows: HoldWindow[];
  // The latest reset among the windows: the machine holds while any window is reached.
  until: Date;
}

type StatusOf = Pick<Machine, 'usage'>;
type SeenMachine = Pick<Machine, 'revokedAt' | 'usageUpdatedAt'>;

/**
 * The windows of a status that are at or over their threshold and have not reset yet; undefined when there are none or the
 * machine has no limits. A window the status names as reached without a threshold or a reading is not shown, as it could not be
 * described.
 */
export function activeHold({ usage }: StatusOf, now: number): ActiveHold | undefined {
  if (usage?.limits === undefined) return undefined;
  const { limits } = usage;
  const windows = usage.reached.flatMap((window): HoldWindow[] => {
    const threshold = limits[window];
    const reading = usage.windows[window];
    if (threshold === undefined || reading === undefined) return [];
    const resetsAt = new Date(reading.resetsAt);
    return resetsAt.getTime() > now ? [{ window, percent: reading.percent, threshold, resetsAt }] : [];
  });
  const [first, ...rest] = windows;
  if (first === undefined) return undefined;
  const until = rest.reduce((latest, { resetsAt }) => (resetsAt > latest ? resetsAt : latest), first.resetsAt);
  return { priority: limits.priority, windows, until };
}

/** Whether what a machine said still counts: it is not revoked and sent its status within `HOLD_FRESH_MS`. */
export function isFresh({ revokedAt, usageUpdatedAt }: SeenMachine, now: number): boolean {
  return revokedAt === null && usageUpdatedAt !== null && now - new Date(usageUpdatedAt).getTime() <= HOLD_FRESH_MS;
}

export interface HoldingMachine {
  name: string;
  hold: ActiveHold;
}

export interface TaskHold {
  // The earliest `until` of the machines that hold the task: once one releases it, it can start.
  until: Date;
  machines: HoldingMachine[];
}

/**
 * Why a Todo task has not started for usage, or undefined when it is not held. A fresh machine that could serve it holds it, and
 * no fresh machine could serve it and does not: one that can still run it makes it wait, not held.
 */
export function heldTask(
  task: { id: string; status: string },
  machines: readonly Pick<Machine, 'shown' | 'revokedAt' | 'usageUpdatedAt' | 'usage'>[],
  now: number,
): TaskHold | undefined {
  if (task.status !== 'todo') return undefined;
  const fresh = machines.flatMap((machine) =>
    machine.usage !== null && isFresh(machine, now) ? [{ ...machine, usage: machine.usage }] : [],
  );
  if (fresh.some(({ usage }) => usage.open.includes(task.id))) return undefined;
  const holding = fresh.flatMap(({ shown, usage }): HoldingMachine[] => {
    const hold = usage.held.includes(task.id) ? activeHold({ usage }, now) : undefined;
    return hold === undefined ? [] : [{ name: shown, hold }];
  });
  const [first, ...rest] = holding;
  if (first === undefined) return undefined;
  const until = rest.reduce((earliest, { hold }) => (hold.until < earliest ? hold.until : earliest), first.hold.until);
  return { until, machines: holding };
}

export const describeHoldWindow = ({ window, percent, threshold }: HoldWindow): string =>
  `${WINDOW_LABELS[window]} usage ${percent}% (limit ${threshold}%)`;

/** "laptop holds tasks below urgent: 5-hour usage 85% (limit 80%) until 14:05" */
export function describeHolding({ name, hold }: HoldingMachine, now: number): string {
  return `${name} holds tasks below ${hold.priority}: ${hold.windows.map(describeHoldWindow).join('; ')} until ${clock(hold.until, now)}`;
}

/** The readings of a status that have not reset yet as "5-hour 85% · 7-day 40%"; empty when it has none. */
export function describeReadings({ usage }: StatusOf, now: number): string {
  if (usage === null) return '';
  return (Object.keys(WINDOW_LABELS) as MachineUsageWindow[])
    .flatMap((window) => {
      const reading = usage.windows[window];
      return reading === undefined || new Date(reading.resetsAt).getTime() <= now
        ? []
        : [`${WINDOW_LABELS[window]} ${reading.percent}%`];
    })
    .join(' · ');
}

/** When each window of a status that has not reset yet resets, as "5-hour resets 14:05; 7-day resets 18 Nov, 09:00". */
export function describeResets({ usage }: StatusOf, now: number): string {
  if (usage === null) return '';
  return (Object.keys(WINDOW_LABELS) as MachineUsageWindow[])
    .flatMap((window) => {
      const reading = usage.windows[window];
      return reading === undefined || new Date(reading.resetsAt).getTime() <= now
        ? []
        : [`${WINDOW_LABELS[window]} resets ${clock(reading.resetsAt, now)}`];
    })
    .join('; ');
}

/** The limits of a status as "5-hour 80% · 7-day 50% · below urgent"; empty without limits. */
export function describeLimits({ usage }: StatusOf): string {
  const limits = usage?.limits;
  if (limits === undefined) return '';
  const thresholds = (Object.keys(WINDOW_LABELS) as MachineUsageWindow[]).flatMap((window) => {
    const threshold = limits[window];
    return threshold === undefined ? [] : [`${WINDOW_LABELS[window]} ${threshold}%`];
  });
  return [...thresholds, `holds below ${limits.priority}`].join(' · ');
}
