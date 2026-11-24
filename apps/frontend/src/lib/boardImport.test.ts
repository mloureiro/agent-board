import {
  exportHeaderLine,
  exportRowLine,
  inputBinding,
  newTaskId,
  titleBinding,
  type ExportHeader,
  type ExportTable,
  type KeySlot,
  type Keys,
  type RowRef,
} from '@agent-board/shared';
import { Blob as NodeBlob } from 'node:buffer';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildExport } from './boardExport';
import { importBoard, MAX_BATCH_ROWS, readExportHeader, type BatchResult, type ImportBatch } from './boardImport';
import { createKeySetup, unlockKeys } from '../crypto/unlocker';
import { openAs, sealerFor } from './contexts';

let oldKeys: Keys;
let newKeys: Keys;
let otherKeyId: string;
let slots: KeySlot[];

const FAST = { m: 8192, t: 1, p: 1 };

beforeAll(async () => {
  const created = await createKeySetup({ owner: 'jascha', passphrase: 'correct horse battery staple', kdf: FAST });
  oldKeys = created.keys;
  slots = created.setup.slots;
  newKeys = await unlockKeys({
    owner: 'jschiffer',
    stored: created.setup,
    secret: { kind: 'recovery', recoveryKey: created.recoveryKey },
  });
  otherKeyId = (await createKeySetup({ owner: 'jascha', passphrase: 'another long passphrase', kdf: FAST })).keys.keyId;
});

const header = (overrides: Partial<ExportHeader> = {}): ExportHeader => ({
  format: 'agent-board-export',
  version: 1,
  exportedAt: '2026-11-18T10:00:00.000Z',
  owner: 'jascha',
  keyId: oldKeys.keyId,
  keySlots: slots,
  transcripts: true,
  prefs: {},
  ...overrides,
});

type Entry = [ExportTable, Record<string, unknown>];

/** A file as the browser's `File` presents it: a size and a byte stream. */
const fileOf = (head: ExportHeader | string, entries: Entry[]) => {
  const text = [
    typeof head === 'string' ? head : exportHeaderLine(head),
    ...entries.map(([table, row]) => exportRowLine(table, row)),
  ]
    .map((line) => `${line}\n`)
    .join('');
  return new NodeBlob([text]) as unknown as { size: number; stream(): ReadableStream<Uint8Array> };
};

const accept = (): ((batch: ImportBatch) => Promise<BatchResult>) =>
  vi.fn(async ({ rows }: ImportBatch) => ({ inserted: rows.length, existing: 0, invalid: 0, orphaned: 0 }));

const taskRow = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, ...extra });

async function sealedTask(
  keys: Keys,
  text: string,
): Promise<{ id: string; ref: RowRef; row: Record<string, unknown> }> {
  const id = newTaskId();
  const ref: RowRef = { kind: 'task', id, createdBy: 'user', scheduleId: null, agent: null, forkOf: null };
  const seal = sealerFor(keys);
  return {
    id,
    ref,
    row: {
      id,
      createdBy: 'user',
      scheduleId: null,
      forkOf: null,
      agent: null,
      title: await seal(titleBinding(ref), `title ${text}`),
      input: await seal(inputBinding(ref), `input ${text}`),
    },
  };
}

describe('importBoard', () => {
  it('sends the rows of a file of the same owner as they are', async () => {
    const task = await sealedTask(oldKeys, 'a');
    const importBatch = accept();
    const totals = await importBoard({ file: fileOf(header(), [['task', task.row]]), keys: oldKeys, importBatch });
    expect(importBatch).toHaveBeenCalledTimes(1);
    expect(importBatch).toHaveBeenCalledWith({ keyId: oldKeys.keyId, table: 'task', rows: [task.row] }, undefined);
    expect(totals).toMatchObject({ inserted: 1, unreadable: 0 });
  });

  it('seals the rows of another owner again, so that they open under the new owner and no longer under the old', async () => {
    const task = await sealedTask(oldKeys, 'b');
    const batches: ImportBatch[] = [];
    await importBoard({
      file: fileOf(header(), [['task', task.row]]),
      keys: newKeys,
      importBatch: async (batch) => {
        batches.push(batch);
        return { inserted: 1, existing: 0, invalid: 0, orphaned: 0 };
      },
    });
    const sent = batches[0]?.rows[0] as { title: string; input: string; id: string };
    expect(sent.id).toBe(task.id);
    expect(sent.title).not.toBe(task.row['title']);
    expect(await openAs(newKeys, titleBinding(task.ref), sent.title)).toBe('title b');
    expect(await openAs(newKeys, inputBinding(task.ref), sent.input)).toBe('input b');
    await expect(openAs(oldKeys, titleBinding(task.ref), sent.title)).rejects.toThrow();
  });

  it('copies a value that does not open and counts it', async () => {
    const task = await sealedTask(oldKeys, 'c');
    const damaged = { ...task.row, title: 'v1.notanenvelope' };
    const batches: ImportBatch[] = [];
    const totals = await importBoard({
      file: fileOf(header(), [['task', damaged]]),
      keys: newKeys,
      importBatch: async (batch) => {
        batches.push(batch);
        return { inserted: 1, existing: 0, invalid: 0, orphaned: 0 };
      },
    });
    expect((batches[0]?.rows[0] as { title: string }).title).toBe('v1.notanenvelope');
    expect(totals.unreadable).toBe(1);
  });

  it('batches by rows', async () => {
    const entries: Entry[] = Array.from({ length: MAX_BATCH_ROWS + 5 }, (_, index) => ['task', taskRow(`t${index}`)]);
    const importBatch = accept();
    await importBoard({ file: fileOf(header(), entries), keys: oldKeys, importBatch });
    expect(vi.mocked(importBatch).mock.calls.map(([batch]) => batch.rows.length)).toEqual([MAX_BATCH_ROWS, 5]);
  });

  it('batches by size, and starts a new batch for each table', async () => {
    const big = 'x'.repeat(1_500_000);
    const entries: Entry[] = [
      ['task', taskRow('a', { pad: big })],
      ['task', taskRow('b', { pad: big })],
      ['task', taskRow('c', { pad: big })],
      ['note', { id: 'n1' }],
    ];
    const importBatch = accept();
    await importBoard({ file: fileOf(header(), entries), keys: oldKeys, importBatch });
    expect(vi.mocked(importBatch).mock.calls.map(([batch]) => [batch.table, batch.rows.length])).toEqual([
      ['task', 2],
      ['task', 1],
      ['note', 1],
    ]);
  });

  it('refuses a file whose tables come out of order', async () => {
    const importBatch = accept();
    const entries: Entry[] = [
      ['note', { id: 'n1' }],
      ['task', taskRow('a')],
    ];
    await expect(importBoard({ file: fileOf(header(), entries), keys: oldKeys, importBatch })).rejects.toThrow(
      /out of order/,
    );
    expect(importBatch).not.toHaveBeenCalledWith(expect.objectContaining({ table: 'task' }), undefined);
  });

  it('refuses a file of another key before sending anything', async () => {
    const importBatch = accept();
    await expect(
      importBoard({
        file: fileOf(header({ keyId: otherKeyId }), [['task', taskRow('a')]]),
        keys: oldKeys,
        importBatch,
      }),
    ).rejects.toThrow(/another key/);
    expect(importBatch).not.toHaveBeenCalled();
  });

  it('adds up what the board answered for each batch', async () => {
    const entries: Entry[] = [
      ['task', taskRow('a')],
      ['note', { id: 'n1' }],
    ];
    const answers = [
      { inserted: 1, existing: 2, invalid: 3, orphaned: 4 },
      { inserted: 10, existing: 20, invalid: 30, orphaned: 40 },
    ];
    const totals = await importBoard({
      file: fileOf(header(), entries),
      keys: oldKeys,
      importBatch: async () => answers.shift() ?? { inserted: 0, existing: 0, invalid: 0, orphaned: 0 },
    });
    expect(totals).toEqual({ inserted: 11, existing: 22, invalid: 33, orphaned: 44, unreadable: 0 });
  });

  it('gives the parser’s message for a bad header', async () => {
    await expect(
      importBoard({ file: fileOf('{"format":"something else"}', []), keys: oldKeys, importBatch: accept() }),
    ).rejects.toThrow('This is not a board export.');
    await expect(readExportHeader(fileOf('not json', []))).rejects.toThrow(/not valid JSON/);
  });

  it('restores the preferences it knows after the last batch, and no others', async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
    await importBoard({
      file: fileOf(header({ prefs: { 'agent-board.desktopNotifications': 'on', 'something.else': 'x' } }), [
        ['task', taskRow('a')],
      ]),
      keys: oldKeys,
      importBatch: accept(),
      storage,
    });
    expect([...data.entries()]).toEqual([['agent-board.desktopNotifications', 'on']]);
  });

  it('does not restore preferences when the import is cancelled', async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: () => null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: () => {},
    };
    const controller = new AbortController();
    await expect(
      importBoard({
        file: fileOf(header({ prefs: { 'agent-board.desktopNotifications': 'on' } }), [['task', taskRow('a')]]),
        keys: oldKeys,
        signal: controller.signal,
        importBatch: async () => {
          controller.abort();
          return { inserted: 1, existing: 0, invalid: 0, orphaned: 0 };
        },
        storage,
      }),
    ).rejects.toBeDefined();
    expect(data.size).toBe(0);
  });

  it('reads back a file made by the export code', async () => {
    const task = await sealedTask(oldKeys, 'd');
    const blob = await buildExport({
      owner: 'jascha',
      keySetup: { keyId: oldKeys.keyId, slots },
      includeTranscripts: false,
      prefs: {},
      total: 1,
      signal: new AbortController().signal,
      fetchPage: async (table) => ({ rows: table === 'task' ? [task.row] : [], next: null }),
    });
    const importBatch = accept();
    const onProgress = vi.fn();
    const file = new NodeBlob([await blob.text()]) as unknown as { size: number; stream(): ReadableStream<Uint8Array> };
    const totals = await importBoard({ file, keys: oldKeys, importBatch, onProgress });
    expect(totals.inserted).toBe(1);
    expect(onProgress.mock.calls.at(-1)).toEqual([{ bytesRead: file.size, size: file.size }]);
  });
});
