import type { Keys } from '@agent-board/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { importBoard, type ExportSource, type ImportProgress, type ImportTotals } from '@agent-board/shared/ui';
import { restoreBoardPrefs } from '../lib/boardPrefs';
import { errorMessage, useRawTRPCClient } from '../lib/trpc';

export type ImportRun =
  | { status: 'idle' }
  | { status: 'running'; progress: ImportProgress }
  | { status: 'done'; totals: ImportTotals }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

export interface ImportRunner {
  run: ImportRun;
  /** Resolves to the totals, or to undefined when the import failed or was cancelled (`run` says which). */
  start: (file: ExportSource, keys: Keys) => Promise<ImportTotals | undefined>;
  cancel: () => void;
  reset: () => void;
}

/** One import of an export file into the signed-in account, sent through the raw client because rows move sealed. */
export function useImportRun(): ImportRunner {
  const client = useRawTRPCClient();
  const [run, setRun] = useState<ImportRun>({ status: 'idle' });
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const start = useCallback(
    async (file: ExportSource, keys: Keys) => {
      const own = new AbortController();
      controller.current = own;
      setRun({ status: 'running', progress: { bytesRead: 0, size: file.size } });
      try {
        const totals = await importBoard({
          file,
          keys,
          signal: own.signal,
          importBatch: (batch, signal) => client.account.import.mutate(batch, { signal }),
          onProgress: (progress) => setRun({ status: 'running', progress }),
          restorePrefs: (prefs) => restoreBoardPrefs(prefs),
        });
        setRun({ status: 'done', totals });
        return totals;
      } catch (error) {
        setRun(own.signal.aborted ? { status: 'cancelled' } : { status: 'failed', message: errorMessage(error) });
        return undefined;
      }
    },
    [client],
  );
  const cancel = useCallback(() => controller.current?.abort(), []);
  const reset = useCallback(() => setRun({ status: 'idle' }), []);
  return useMemo(() => ({ run, start, cancel, reset }), [run, start, cancel, reset]);
}
