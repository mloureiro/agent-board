import {
  exportHeaderLine,
  exportRowLine,
  inputBinding,
  newTaskId,
  titleBinding,
  type KeySetup,
  type Keys,
  type RowRef,
} from '@agent-board/shared';
import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Blob as NodeBlob } from 'node:buffer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAs, sealerFor } from '@agent-board/shared/ui';
import { createKeySetup } from './unlocker';
import { SetupScreen } from './SetupScreen';

const setupKey = vi.hoisted(() => vi.fn(async (_: unknown) => null));
const importRows = vi.hoisted(() => vi.fn());

vi.mock('../lib/trpc', () => ({
  useTRPC: () => ({}),
  useRawTRPCClient: () => ({ keys: { setup: { mutate: setupKey } }, account: { import: { mutate: importRows } } }),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

const PASSPHRASE = 'correct horse battery staple';
const FAST = { m: 8192, t: 1, p: 1 };
let exported: KeySetup;
let recoveryKey: string;
let taskRow: Record<string, unknown>;
let taskRef: RowRef;
let file: File;

beforeAll(async () => {
  const created = await createKeySetup({ owner: 'oldname', passphrase: PASSPHRASE, kdf: FAST });
  exported = created.setup;
  recoveryKey = created.recoveryKey;
  const id = newTaskId();
  taskRef = { kind: 'task', id, createdBy: 'user', scheduleId: null, agent: null, forkOf: null };
  const seal = sealerFor(created.keys);
  taskRow = {
    id,
    createdBy: 'user',
    scheduleId: null,
    forkOf: null,
    agent: null,
    title: await seal(titleBinding(taskRef), 'my title'),
    input: await seal(inputBinding(taskRef), 'my prompt'),
  };
  const text = [
    exportHeaderLine({
      format: 'agent-board-export',
      version: 1,
      exportedAt: '2026-11-18T10:00:00.000Z',
      owner: 'oldname',
      keyId: exported.keyId,
      keySlots: exported.slots,
      transcripts: true,
      prefs: {},
    }),
    exportRowLine('task', taskRow),
  ]
    .map((line) => `${line}\n`)
    .join('');
  // jsdom's File has no stream(); the browser's has.
  file = new File([text], 'export.ndjson');
  Object.defineProperty(file, 'stream', { value: () => new NodeBlob([text]).stream() });
});

beforeEach(() => {
  setupKey.mockClear();
  importRows.mockReset();
  importRows.mockImplementation(async ({ rows }: { rows: unknown[] }) => ({
    inserted: rows.length,
    existing: 0,
    invalid: 0,
    orphaned: 0,
  }));
});

async function openFile(onComplete = vi.fn(async (_keys: Keys) => undefined)) {
  render(
    <MantineProvider>
      <SetupScreen owner="jschiffer" kdf={FAST} onComplete={onComplete} />
    </MantineProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Import a board export instead' }));
  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('no file input');
  await userEvent.upload(input, file);
  await screen.findByText(/By user/);
  return onComplete;
}

describe('setting up from an export', () => {
  it('shows what the file is and what importing it means before asking for anything', async () => {
    await openFile();
    expect(screen.getByText('oldname')).toBeInTheDocument();
    expect(screen.getByText(exported.keyId)).toBeInTheDocument();
    expect(screen.getByText('With transcripts')).toBeInTheDocument();
    expect(screen.getByText(/encrypted again for/)).toBeInTheDocument();
    expect(screen.getByText(/Only import a file you exported yourself/)).toBeInTheDocument();
    expect(screen.getByText(/Tasks in Todo will start on those machines/)).toBeInTheDocument();
  });

  it('writes nothing when the passphrase is wrong', async () => {
    await openFile();
    await userEvent.type(screen.getByLabelText('Passphrase of the export'), 'not the passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Set up with this key and import' }));
    expect(await screen.findByText('Wrong passphrase or recovery key.')).toBeInTheDocument();
    expect(setupKey).not.toHaveBeenCalled();
    expect(importRows).not.toHaveBeenCalled();
  });

  it('sets up with the slots of the file, imports the rows sealed for this username, and then completes', async () => {
    const onComplete = await openFile();
    await userEvent.type(screen.getByLabelText('Passphrase of the export'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Set up with this key and import' }));

    expect(await screen.findByText('Import finished')).toBeInTheDocument();
    expect(setupKey).toHaveBeenCalledWith({ keyId: exported.keyId, slots: exported.slots });
    expect(importRows).toHaveBeenCalledTimes(1);
    expect(setupKey.mock.invocationCallOrder[0]).toBeLessThan(importRows.mock.invocationCallOrder[0] ?? 0);
    expect(onComplete).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Continue to the board' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    const keys = onComplete.mock.calls[0]?.[0];
    expect(keys).toMatchObject({ owner: 'jschiffer', keyId: exported.keyId });
    const sent = importRows.mock.calls[0]?.[0] as { table: string; rows: { title: string }[] };
    expect(sent.table).toBe('task');
    expect(keys && (await openAs(keys, titleBinding(taskRef), sent.rows[0]?.title ?? ''))).toBe('my title');
  });

  it('says the old account holds the rows when nothing was added because they exist and the file is of another username', async () => {
    importRows.mockImplementation(async ({ rows }: { rows: unknown[] }) => ({
      inserted: 0,
      existing: rows.length,
      invalid: 0,
      orphaned: 0,
    }));
    await openFile();
    await userEvent.type(screen.getByLabelText('Passphrase of the export'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Set up with this key and import' }));
    expect(await screen.findByText('Import finished')).toBeInTheDocument();
    expect(screen.getByText(/already on this board or held by another account on this server/)).toBeInTheDocument();
    expect(screen.getByText(/probably still holds these rows/)).toBeInTheDocument();
    expect(screen.getByText('oldname', { selector: 'strong' })).toBeInTheDocument();
  });

  it('opens the file with its recovery key as well', async () => {
    await openFile();
    await userEvent.click(screen.getByRole('button', { name: 'Use the recovery key' }));
    await userEvent.type(screen.getByLabelText('Recovery key of the export'), recoveryKey);
    await userEvent.click(screen.getByRole('button', { name: 'Set up with this key and import' }));
    expect(await screen.findByText('Import finished')).toBeInTheDocument();
    expect(setupKey).toHaveBeenCalledTimes(1);
  });

  it('keeps the key and says to import again from Settings when the import fails', async () => {
    importRows.mockRejectedValue(new Error('Server said no'));
    const onComplete = await openFile();
    await userEvent.type(screen.getByLabelText('Passphrase of the export'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Set up with this key and import' }));
    expect(await screen.findByText(/Server said no/)).toBeInTheDocument();
    expect(screen.getByText(/import the file again/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue to the board' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });
});
