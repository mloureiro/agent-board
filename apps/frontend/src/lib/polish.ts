import {
  parsePolish,
  POLISH_TITLE_PREFIX,
  polishTask as polishTaskFor,
  type Status,
  type Polish,
} from '@agent-board/shared';
import type { NewTask } from '@agent-board/shared/ui';
import type { BoardTask, ThreadNote } from './trpc';

/** Where a polished prompt can be applied: a task that waits for you. */
const APPLIES_IN: readonly Status[] = ['backlog', 'needs-me'];

type Polishable = Pick<BoardTask, 'status' | 'closed' | 'createdBy' | 'scheduleId' | 'unreadable'>;

/** Only a Backlog task you wrote and can read is polished: the rewrite has to be applied to it as yours. */
export function canPolish(task: Polishable): boolean {
  return (
    task.status === 'backlog' &&
    !task.closed &&
    task.createdBy === 'user' &&
    task.scheduleId === null &&
    task.unreadable.every((field) => field === 'watches')
  );
}

/** The task the "Polish prompt" button queues; the same one `board schedule --polish` makes. */
export function polishTask(target: Pick<BoardTask, 'id' | 'title' | 'priority' | 'machine' | 'workdir'>): NewTask {
  return polishTaskFor(target);
}

/** A task of yours that polishes `parentId` and is not finished yet, so another one would only repeat it. */
export function isOpenPolishOf(
  task: Pick<BoardTask, 'title' | 'createdBy' | 'status' | 'closed' | 'parentId'>,
  parentId: string,
): boolean {
  return (
    task.parentId === parentId &&
    task.createdBy === 'user' &&
    task.title.startsWith(POLISH_TITLE_PREFIX) &&
    task.status !== 'done' &&
    !task.closed
  );
}

export type PolishState = { usable: true; rewrite: Polish; target: BoardTask } | { usable: false; reason: string };

/**
 * Whether a polish note can be applied from the task page of the task that wrote it: it must be a polished prompt for exactly
 * this task's parent, and the parent must still wait for you, as yours.
 */
export function polishState(polish: BoardTask, parent: BoardTask | null, note: ThreadNote): PolishState {
  const rewrite = parsePolish(note.text);
  if (note.author !== 'agent' || rewrite === undefined)
    return { usable: false, reason: 'This is not a polished prompt this browser understands.' };
  if (parent === null || polish.parentId !== parent.id)
    return { usable: false, reason: 'This task has no parent to apply it to.' };
  if (rewrite.target !== parent.id)
    return { usable: false, reason: `It is for task ${rewrite.target}, not for this task’s parent.` };
  if (parent.closed || !APPLIES_IN.includes(parent.status))
    return { usable: false, reason: `“${parent.title}” is no longer in Backlog or Needs me.` };
  if (parent.createdBy !== 'user' || parent.scheduleId !== null)
    return { usable: false, reason: `“${parent.title}” is not a task you wrote, so a prompt cannot be applied to it.` };
  if (parent.unreadable.some((field) => field !== 'watches'))
    return { usable: false, reason: `“${parent.title}” cannot be read, so what it says now could not be kept.` };
  return { usable: true, rewrite, target: parent };
}
