/**
 * What the database holds a sealed column to (migration 0014): an `abe1.` envelope, or for a blind index an `abh1.` value, of
 * the shape the encryption module makes. `[.]` rather than an escaped dot keeps the SQL free of backslashes. Only the clients
 * can tell whether a value opens, but plain text cannot get in.
 */
export const ENVELOPE_PATTERN = '^abe1[.][A-Za-z0-9_-]{38,}$';
export const BLIND_INDEX_PATTERN = '^abh1[.][A-Za-z0-9_-]{43}$';

export interface SealedColumn {
  table: string;
  column: string;
  kind: 'envelope' | 'blind-index';
  /** The name of the check constraint of migration 0014. */
  constraint: string;
}

const envelope = (table: string, column: string): SealedColumn => ({
  table,
  column,
  kind: 'envelope',
  constraint: `${table}_${column}_sealed`,
});
const blindIndex = (table: string, column: string): SealedColumn => ({
  table,
  column,
  kind: 'blind-index',
  constraint: `${table}_${column}_blind`,
});

export const SEALED_COLUMNS: readonly SealedColumn[] = [
  envelope('task', 'title'),
  envelope('task', 'input'),
  envelope('task', 'workdir'),
  envelope('task', 'home_workdir'),
  envelope('task', 'agent'),
  envelope('task', 'icon'),
  envelope('task', 'labels'),
  envelope('task', 'watches'),
  envelope('task_pr', 'pr'),
  envelope('machine', 'dirs'),
  blindIndex('machine', 'dirs_index'),
  envelope('machine', 'catalog'),
  blindIndex('machine', 'catalog_index'),
  envelope('machine', 'usage'),
  blindIndex('machine', 'usage_index'),
  envelope('machine', 'sources'),
  blindIndex('machine', 'sources_index'),
  envelope('shared_agents', 'document'),
  envelope('link_rules', 'document'),
  blindIndex('task', 'dedupe_key'),
  blindIndex('task', 'head'),
  envelope('schedule', 'title'),
  envelope('schedule', 'input'),
  envelope('schedule', 'workdir'),
  envelope('schedule', 'agent'),
  envelope('schedule', 'icon'),
  envelope('schedule', 'labels'),
  envelope('note', 'body'),
  envelope('note', 'preview'),
  envelope('note', 'suggestion'),
  envelope('note', 'questions'),
  envelope('note', 'answers'),
  envelope('transcript_event', 'data'),
  envelope('transcript_event', 'output'),
];
