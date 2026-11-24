import type { ThreadNote } from '@agent-board/shared/ui';

/**
 * The reply the agent drafted on its latest comment, while it is still the thread's last word: a note of the user after it
 * means the conversation moved on, and an older comment's suggestion is stale.
 */
export function currentSuggestion(thread: ThreadNote[]): string | undefined {
  const index = thread.findLastIndex((note) => note.author === 'agent' && note.kind === 'comment');
  const suggestion = thread[index]?.suggestion;
  if (suggestion === undefined || suggestion.trim() === '') return undefined;
  return thread.slice(index + 1).some((note) => note.author === 'user') ? undefined : suggestion;
}
