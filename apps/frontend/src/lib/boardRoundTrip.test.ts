import { inputBinding, newTaskId, titleBinding, type RowRef } from '@agent-board/shared';
import { importBoard, sealerFor, type ExportSource, type ImportBatch } from '@agent-board/shared/ui';
import { Blob as NodeBlob } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { createKeySetup } from '../crypto/unlocker';
import { buildExport } from './boardExport';
import { restoreBoardPrefs } from './boardPrefs';

const FAST = { m: 8192, t: 1, p: 1 };

describe('a board export read back by the import', () => {
  it('sends the rows of a file made by the export code and restores the preferences it knows', async () => {
    const { keys, setup } = await createKeySetup({
      owner: 'jascha',
      passphrase: 'correct horse battery staple',
      kdf: FAST,
    });
    const id = newTaskId();
    const ref: RowRef = { kind: 'task', id, createdBy: 'user', scheduleId: null, agent: null, forkOf: null };
    const seal = sealerFor(keys);
    const row = {
      id,
      createdBy: 'user',
      scheduleId: null,
      forkOf: null,
      agent: null,
      title: await seal(titleBinding(ref), 'title d'),
      input: await seal(inputBinding(ref), 'input d'),
    };
    const blob = await buildExport({
      owner: 'jascha',
      keySetup: setup,
      includeTranscripts: false,
      prefs: { 'agent-board.desktopNotifications': 'on', 'something.else': 'x' },
      total: 1,
      signal: new AbortController().signal,
      fetchPage: async (table) => ({ rows: table === 'task' ? [row] : [], next: null }),
    });
    const importBatch = vi.fn(async ({ rows }: ImportBatch) => ({
      inserted: rows.length,
      existing: 0,
      invalid: 0,
      orphaned: 0,
    }));
    const onProgress = vi.fn();
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };

    const file = new NodeBlob([await blob.text()]) as unknown as ExportSource;
    const totals = await importBoard({
      file,
      keys,
      importBatch,
      onProgress,
      restorePrefs: (prefs) => restoreBoardPrefs(prefs, storage),
    });

    expect(totals.inserted).toBe(1);
    expect(importBatch).toHaveBeenCalledWith({ keyId: keys.keyId, table: 'task', rows: [row] }, undefined);
    expect(onProgress.mock.calls.at(-1)).toEqual([{ bytesRead: file.size, size: file.size }]);
    expect([...data.entries()]).toEqual([['agent-board.desktopNotifications', 'on']]);
  });
});
