import {
  EXPORT_TABLES,
  parseExportHeader,
  parseExportRowLine,
  resealRow,
  type ExportHeader,
  type ExportTable,
  type Keys,
} from '../index.mts';
import { sealerFor } from './requests.mts';
import { openerFor } from './responses.mts';

/** What an import reads of a file: a `File` is one. */
export interface ExportSource {
  size: number;
  stream(): ReadableStream<Uint8Array>;
}

export interface ImportBatch {
  keyId: string;
  table: ExportTable;
  rows: Record<string, unknown>[];
}

export interface BatchResult {
  inserted: number;
  existing: number;
  invalid: number;
  orphaned: number;
}

export interface ImportTotals extends BatchResult {
  /** Values that did not open under the file's owner and were copied as they are. */
  unreadable: number;
}

export interface ImportProgress {
  bytesRead: number;
  size: number;
}

/** A rule of the file that this browser checks before sending the rows it is about to refuse. */
export class ImportFileError extends Error {}

/** The server takes 16 MB per request and a transcript event can be 1 MB, so a batch stays well below that. */
export const MAX_BATCH_ROWS = 1000;
export const MAX_BATCH_CHARS = 4 * 1024 * 1024;

interface Line {
  text: string;
  bytesRead: number;
}

/** The lines of a file, read as a stream, so that a file of hundreds of megabytes is never in memory at once. */
async function* readLines(source: ExportSource, signal?: AbortSignal): AsyncGenerator<Line> {
  const reader = source.stream().getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let bytesRead = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.length;
      const lines = (pending + decoder.decode(value, { stream: true })).split('\n');
      pending = lines.pop() ?? '';
      for (const text of lines) if (text.trim() !== '') yield { text, bytesRead };
    }
    pending += decoder.decode();
    if (pending.trim() !== '') yield { text: pending, bytesRead };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The header of a file, from its first line; the rest of the file is not read. */
export async function readExportHeader(source: ExportSource): Promise<ExportHeader> {
  for await (const { text } of readLines(source)) return parseExportHeader(text);
  throw new ImportFileError('This file is empty.');
}

export interface ImportOptions {
  file: ExportSource;
  /** The keys this browser seals with. The file's key id must be theirs, and its owner may differ from `keys.owner`. */
  keys: Keys;
  /** Sends one batch to the board. */
  importBatch: (batch: ImportBatch, signal: AbortSignal | undefined) => Promise<BatchResult>;
  signal?: AbortSignal;
  onProgress?: (progress: ImportProgress) => void;
  /** Puts the preferences of the file where the UI keeps its own, after the last batch. */
  restorePrefs: (prefs: ExportHeader['prefs']) => void;
}

const tableRank = (table: ExportTable): number => EXPORT_TABLES.indexOf(table);

const taskIdOfRun = (row: Record<string, unknown>): [string, string] | undefined => {
  const { id, taskId } = row;
  return typeof id === 'string' && typeof taskId === 'string' ? [id, taskId] : undefined;
};

/**
 * Sends the rows of a file in its order, a table at a time, and restores the preferences after the last batch. A file of
 * another owner is opened under that owner and sealed again under this browser's keys; a file of another key is refused
 * before anything is sent. Stops with the signal's reason when it is aborted: batches already sent stay on the board, and
 * sending the file again skips them.
 */
export async function importBoard(options: ImportOptions): Promise<ImportTotals> {
  const { file, keys, importBatch, signal, onProgress, restorePrefs } = options;
  const totals: ImportTotals = { inserted: 0, existing: 0, invalid: 0, orphaned: 0, unreadable: 0 };
  const taskOfRun = new Map<string, string>();
  let header: ExportHeader | undefined;
  let open: ReturnType<typeof openerFor> | undefined;
  let table: ExportTable | undefined;
  let batch: Record<string, unknown>[] = [];
  let batchChars = 0;

  const flush = async (): Promise<void> => {
    if (table === undefined || batch.length === 0) return;
    const rows = batch;
    batch = [];
    batchChars = 0;
    signal?.throwIfAborted();
    const result = await importBatch({ keyId: keys.keyId, table, rows }, signal);
    totals.inserted += result.inserted;
    totals.existing += result.existing;
    totals.invalid += result.invalid;
    totals.orphaned += result.orphaned;
  };

  for await (const { text, bytesRead } of readLines(file, signal)) {
    if (header === undefined) {
      header = parseExportHeader(text);
      if (header.keyId !== keys.keyId)
        throw new ImportFileError('This file was made with another key than the one this board uses.');
      if (header.owner !== keys.owner) open = openerFor({ ...keys, owner: header.owner });
      onProgress?.({ bytesRead, size: file.size });
      continue;
    }
    const parsed = parseExportRowLine(text);
    if (table !== undefined && tableRank(parsed.table) < tableRank(table))
      throw new ImportFileError(
        `This file is out of order: a ${parsed.table} row comes after a ${table} row. Export it again.`,
      );
    if (parsed.table !== table) {
      await flush();
      table = parsed.table;
    }
    let row = parsed.row;
    if (parsed.table === 'transcript_run') {
      const link = taskIdOfRun(row);
      if (link !== undefined) taskOfRun.set(...link);
    }
    if (open !== undefined) {
      const resealed = await resealRow(parsed.table, row, {
        open,
        seal: sealerFor(keys),
        taskOfRun: (runId) => taskOfRun.get(runId),
      });
      row = resealed.row;
      totals.unreadable += resealed.unreadable.length;
    }
    const chars = text.length;
    if (batch.length >= MAX_BATCH_ROWS || (batch.length > 0 && batchChars + chars > MAX_BATCH_CHARS)) await flush();
    batch.push(row);
    batchChars += chars;
    onProgress?.({ bytesRead, size: file.size });
  }
  if (header === undefined) throw new ImportFileError('This file is empty.');
  await flush();
  signal?.throwIfAborted();
  restorePrefs(header.prefs);
  onProgress?.({ bytesRead: file.size, size: file.size });
  return totals;
}
