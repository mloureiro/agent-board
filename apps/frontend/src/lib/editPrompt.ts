import type { BoardTask } from '@agent-board/shared/ui';

/** The prompt of a task of yours can be edited until a worker claims it: waiting in Todo or Backlog, never started, readable. A schedule's card is edited through its schedule. */
export function canEditPrompt(
  task: Pick<BoardTask, 'createdBy' | 'scheduleId' | 'proposed' | 'closed' | 'status' | 'started' | 'unreadable'>,
): boolean {
  return (
    task.createdBy === 'user' &&
    task.scheduleId === null &&
    !task.proposed &&
    !task.closed &&
    (task.status === 'todo' || task.status === 'backlog') &&
    !task.started &&
    task.unreadable.every((field) => field === 'watches')
  );
}
