import { prsOf } from '@agent-board/shared';
import type { BoardTask } from '@agent-board/shared/ui';

/** A task of the user's that asks nothing and has at least one merged PR, every PR of it being merged or closed: it can go to Done. */
export function canMoveMergedToDone(
  task: Pick<BoardTask, 'input' | 'prs' | 'promptPrState' | 'proposed' | 'openQuestion'>,
): boolean {
  if (task.proposed || task.openQuestion) return false;
  const states = prsOf(task).map(({ state }) => state);
  return states.includes('merged') && states.every((state) => state === 'merged' || state === 'closed');
}
