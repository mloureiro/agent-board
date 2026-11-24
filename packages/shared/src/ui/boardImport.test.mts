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
} from '../index.mts';
import assert from 'node:assert/strict';
import { before, describe, it, mock } from 'node:test';
import { testArgon2id } from './argon2idForTests.mts';
import {
  importBoard as sendBoard,
  MAX_BATCH_ROWS,
  readExportHeader,
  type ImportBatch,
  type ImportOptions,
} from './boardImport.mts';
import { createUnlocker } from './keySlots.mts';
import { openAs, sealerFor } from './requests.mts';

const { createKeySetup, unlockKeys } = createUnlocker(testArgon2id);

const ignorePrefs = (): void => undefined;
const importBoard = (options: Omit<ImportOptions, 'restorePrefs'> & Partial<Pick<ImportOptions, 'restorePrefs'>>) =>
  sendBoard({ restorePrefs: ignorePrefs, ...options });

let oldKeys: Keys;
let newKeys: Keys;
let otherKeyId: string;
let slots: KeySlot[];

const FAST = { m: 8192, t: 1, p: 1 };

before(async () => {
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
  return new Blob([text]);
};

const accept = () =>
  mock.fn(async ({ rows }: ImportBatch) => ({ inserted: rows.length, existing: 0, invalid: 0, orphaned: 0 }));

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
    assert.deepEqual(
      importBatch.mock.calls.map(({ arguments: args }) => args),
      [[{ keyId: oldKeys.keyId, table: 'task', rows: [task.row] }, undefined]],
    );
    assert.partialDeepStrictEqual(totals, { inserted: 1, unreadable: 0 });
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
    assert.equal(sent.id, task.id);
    assert.notEqual(sent.title, task.row['title']);
    assert.equal(await openAs(newKeys, titleBinding(task.ref), sent.title), 'title b');
    assert.equal(await openAs(newKeys, inputBinding(task.ref), sent.input), 'input b');
    await assert.rejects(openAs(oldKeys, titleBinding(task.ref), sent.title));
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
    assert.equal((batches[0]?.rows[0] as { title: string }).title, 'v1.notanenvelope');
    assert.equal(totals.unreadable, 1);
  });

  it('batches by rows', async () => {
    const entries: Entry[] = Array.from({ length: MAX_BATCH_ROWS + 5 }, (_, index) => ['task', taskRow(`t${index}`)]);
    const importBatch = accept();
    await importBoard({ file: fileOf(header(), entries), keys: oldKeys, importBatch });
    assert.deepEqual(
      importBatch.mock.calls.map(({ arguments: [batch] }) => batch.rows.length),
      [MAX_BATCH_ROWS, 5],
    );
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
    assert.deepEqual(
      importBatch.mock.calls.map(({ arguments: [batch] }) => [batch.table, batch.rows.length]),
      [
        ['task', 2],
        ['task', 1],
        ['note', 1],
      ],
    );
  });

  it('refuses a file whose tables come out of order', async () => {
    const importBatch = accept();
    const entries: Entry[] = [
      ['note', { id: 'n1' }],
      ['task', taskRow('a')],
    ];
    await assert.rejects(importBoard({ file: fileOf(header(), entries), keys: oldKeys, importBatch }), /out of order/);
    assert.ok(importBatch.mock.calls.every(({ arguments: [batch] }) => batch.table !== 'task'));
  });

  it('refuses a file of another key before sending anything', async () => {
    const importBatch = accept();
    await assert.rejects(
      importBoard({
        file: fileOf(header({ keyId: otherKeyId }), [['task', taskRow('a')]]),
        keys: oldKeys,
        importBatch,
      }),
      /another key/,
    );
    assert.equal(importBatch.mock.callCount(), 0);
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
    assert.deepEqual(totals, { inserted: 11, existing: 22, invalid: 33, orphaned: 44, unreadable: 0 });
  });

  it('gives the parser’s message for a bad header', async () => {
    await assert.rejects(
      importBoard({
        file: fileOf('{"format":"something else"}', []),
        keys: oldKeys,
        importBatch: accept(),
      }),
      /This is not a board export\./,
    );
    await assert.rejects(readExportHeader(fileOf('not json', [])), /not valid JSON/);
  });

  it('hands the preferences of the file over after the last batch', async () => {
    const events: string[] = [];
    await importBoard({
      file: fileOf(header({ prefs: { 'agent-board.desktopNotifications': 'on' } }), [['task', taskRow('a')]]),
      keys: oldKeys,
      importBatch: async () => {
        events.push('batch');
        return { inserted: 1, existing: 0, invalid: 0, orphaned: 0 };
      },
      restorePrefs: (prefs) => events.push(JSON.stringify(prefs)),
    });
    assert.deepEqual(events, ['batch', '{"agent-board.desktopNotifications":"on"}']);
  });

  it('does not restore preferences when the import is cancelled', async () => {
    const restorePrefs = mock.fn();
    const controller = new AbortController();
    await assert.rejects(
      importBoard({
        file: fileOf(header({ prefs: { 'agent-board.desktopNotifications': 'on' } }), [['task', taskRow('a')]]),
        keys: oldKeys,
        signal: controller.signal,
        importBatch: async () => {
          controller.abort();
          return { inserted: 1, existing: 0, invalid: 0, orphaned: 0 };
        },
        restorePrefs,
      }),
    );
    assert.equal(restorePrefs.mock.callCount(), 0);
  });
});
