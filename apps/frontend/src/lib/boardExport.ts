import {
  EXPORT_FORMAT,
  EXPORT_TABLES,
  EXPORT_VERSION,
  exportHeaderLine,
  exportRowLine,
  type ExportHeader,
  type ExportTable,
  type KeySetup,
} from '@agent-board/shared';
import type { RouterOutputs } from './wire';

export type AccountSummary = RouterOutputs['account']['summary'];

export interface ExportPage {
  rows: Record<string, unknown>[];
  next: string | null;
}

/** Fetches one page of a table as the server stores it; `cursor` is null for the first page. */
export type FetchExportPage = (table: ExportTable, cursor: string | null, signal: AbortSignal) => Promise<ExportPage>;

export interface ExportProgress {
  rows: number;
  total: number;
}

const TRANSCRIPT_TABLES: readonly ExportTable[] = ['transcript_run', 'transcript_event'];

const COUNT_OF_TABLE: Record<ExportTable, keyof AccountSummary> = {
  task: 'tasks',
  schedule: 'schedules',
  note: 'notes',
  task_pr: 'taskPrs',
  machine: 'machines',
  shared_agents: 'sharedAgents',
  link_rules: 'linkRules',
  title_rules: 'titleRules',
  transcript_run: 'transcriptRuns',
  transcript_event: 'transcriptEvents',
};

export const tablesOfExport = (includeTranscripts: boolean): ExportTable[] =>
  EXPORT_TABLES.filter((table) => includeTranscripts || !TRANSCRIPT_TABLES.includes(table));

/** How many rows an export holds at the time of the summary. */
export const exportRowCount = (summary: AccountSummary, includeTranscripts: boolean): number =>
  tablesOfExport(includeTranscripts).reduce((sum, table) => sum + summary[COUNT_OF_TABLE[table]], 0);

/** The name of the file, with anything in the username that a file name should not hold replaced. */
export const exportFileName = (username: string, date: Date): string =>
  `agent-board-${username.replace(/[^A-Za-z0-9._-]/g, '_')}-${date.toISOString().slice(0, 10)}.ndjson`;

export interface BuildExportOptions {
  /** The username of the signed-in account: the envelopes of the file are bound to it. */
  owner: string;
  /** The key slots as the board stores them, which an import asks the old passphrase or recovery key to open. */
  keySetup: KeySetup;
  includeTranscripts: boolean;
  prefs: Record<string, string>;
  fetchPage: FetchExportPage;
  /** From the summary; progress counts rows against it, and rows added while the export runs may pass it. */
  total: number;
  signal: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  now?: Date;
}

/** The whole board as an NDJSON file. Stops with the signal's reason when it is aborted, between pages and during one. */
export async function buildExport(options: BuildExportOptions): Promise<Blob> {
  const {
    owner,
    keySetup,
    includeTranscripts,
    prefs,
    fetchPage,
    total,
    signal,
    onProgress,
    now = new Date(),
  } = options;
  const header: ExportHeader = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    owner,
    keyId: keySetup.keyId,
    keySlots: keySetup.slots,
    transcripts: includeTranscripts,
    prefs,
  };
  const parts: Blob[] = [new Blob([`${exportHeaderLine(header)}\n`])];
  let rows = 0;
  onProgress?.({ rows, total });
  for (const table of tablesOfExport(includeTranscripts)) {
    let cursor: string | null = null;
    do {
      signal.throwIfAborted();
      const page: ExportPage = await fetchPage(table, cursor, signal);
      signal.throwIfAborted();
      // A Blob per page lets the browser keep the file's parts outside the JS heap.
      parts.push(new Blob([page.rows.map((row) => `${exportRowLine(table, row)}\n`).join('')]));
      rows += page.rows.length;
      cursor = page.next;
      onProgress?.({ rows, total });
    } while (cursor !== null);
  }
  return new Blob(parts, { type: 'application/x-ndjson' });
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // The browser starts the download when the click is handled; the address can go after that.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
