import type { ComboboxItem, ComboboxItemGroup } from '@mantine/core';
import { RECENT_MS } from './clientStatus';
import type { Machine } from '@agent-board/shared/ui';
import { ago } from './time';

export interface DirectoryChoice {
  /** Encodes machine and path together, so the same path on two machines stays two options. */
  value: string;
  machine: string;
  path: string;
  label?: string;
}

export interface DirectoryChoices {
  groups: ComboboxItemGroup<ComboboxItem>[];
  choices: DirectoryChoice[];
  /** The shown names of the machines whose list could not be read. */
  unreadable: string[];
}

const seenAt = ({ lastSeenAt }: Machine): number => (lastSeenAt === null ? -Infinity : new Date(lastSeenAt).getTime());

function groupLabel(machine: Machine, now: number): string {
  if (machine.lastSeenAt === null) return `${machine.shown} · never seen`;
  return now - seenAt(machine) < RECENT_MS ? machine.shown : `${machine.shown} · last seen ${ago(machine.lastSeenAt)}`;
}

/**
 * The directories the New task form offers: one group per machine that has a readable list, the most recently seen first.
 * An option reads `<label> — <path>` when the directory has a label, so a search matches either; its value stays the path.
 */
export function directoryChoices(machines: readonly Machine[], now: number): DirectoryChoices {
  const listing = machines
    .filter(({ dirs }) => dirs !== null && dirs.length > 0)
    .sort((a, b) => seenAt(b) - seenAt(a) || a.shown.localeCompare(b.shown));
  const choices = listing.flatMap((machine) =>
    (machine.dirs ?? []).map(({ path, label }) => ({
      value: JSON.stringify([machine.name, path]),
      machine: machine.name,
      path,
      ...(label === undefined ? {} : { label }),
    })),
  );
  const groups = listing.map((machine) => ({
    group: groupLabel(machine, now),
    items: choices
      .filter(({ machine: name }) => name === machine.name)
      .map(({ value, path, label }) => ({ value, label: label === undefined ? path : `${label} — ${path}` })),
  }));
  return {
    groups,
    choices,
    unreadable: machines.filter(({ dirsUnreadable }) => dirsUnreadable).map(({ shown }) => shown),
  };
}

const segments = (path: string): string[] => path.split('/').filter((segment) => segment !== '');

export const isWithin = (path: string, dir: string): boolean => {
  const below = segments(path);
  return segments(dir).every((segment, index) => below[index] === segment);
};

/**
 * The machine a task's directory is not listed on: it has a readable directory list and `workdir` is neither a listed
 * directory nor below one. Advice only: the browser cannot resolve symlinks, which the worker does before it checks.
 */
export function unlistedMachine(
  task: { machine: string | null; workdir: string | null },
  machines: readonly Machine[],
): string | undefined {
  if (task.machine === null || task.workdir === null) return undefined;
  const { workdir } = task;
  const found = machines.find(({ name }) => name === task.machine);
  if (found?.dirs == null || found.dirs.length === 0) return undefined;
  return found.dirs.some(({ path }) => isWithin(workdir, path)) ? undefined : found.shown;
}

/**
 * Whether choosing `choice` (undefined: no directory) changes nothing for the task. Choosing none is a change while the task
 * is still pinned to a machine, since it removes the pin.
 */
export function isCurrentPlace(
  task: { machine: string | null; workdir: string | null },
  choice: Pick<DirectoryChoice, 'machine' | 'path'> | undefined,
): boolean {
  if (choice === undefined) return task.workdir === null && task.machine === null;
  return task.machine === choice.machine && task.workdir === choice.path;
}
