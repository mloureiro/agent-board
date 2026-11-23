import type { MachineFeed } from '@agent-board/shared';

export interface FeedStatus {
  label: string;
  color: string;
  detail?: string;
}

const MIN_OVERDUE_MARGIN_MS = 2 * 60_000;

/** The first status that applies to a feed, or undefined for a feed that is running as it should. */
export function feedStatus(feed: MachineFeed, now: number): FeedStatus | undefined {
  const { last } = feed;
  if (feed.problem !== undefined) return { label: 'Not read', color: 'red', detail: feed.problem };
  if (last?.invalid === true) return { label: 'Invalid', color: 'red', ...(last.error ? { detail: last.error } : {}) };
  if (feed.paused) return { label: 'Paused', color: 'yellow' };
  if (feed.runAsked) return { label: 'Run asked for…', color: 'blue' };
  if (
    last !== undefined &&
    now - Date.parse(last.startedAt) > feed.everyMs + Math.max(MIN_OVERDUE_MARGIN_MS, feed.everyMs / 2)
  )
    return { label: 'Overdue', color: 'orange', detail: 'The machine has not run this feed on its timer.' };
  if (last?.ok === false) return { label: 'Failed', color: 'red', ...(last.error ? { detail: last.error } : {}) };
  return undefined;
}
