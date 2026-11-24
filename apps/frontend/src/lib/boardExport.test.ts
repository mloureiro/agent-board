import {
  EXPORT_TABLES,
  parseExportHeader,
  parseExportRowLine,
  type ExportTable,
  type KeySetup,
} from '@agent-board/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createKeySetup } from '../crypto/unlocker';
import { buildExport, exportFileName, exportRowCount, tablesOfExport, type FetchExportPage } from './boardExport';

const FAST = { m: 8192, t: 1, p: 1 };
let SETUP: KeySetup;

beforeAll(async () => {
  ({ setup: SETUP } = await createKeySetup({ owner: 'jascha', passphrase: 'correct horse battery staple', kdf: FAST }));
});
const NOW = new Date('2026-11-18T10:00:00.000Z');

/** Two pages per table: `a-1`, `a-2` and then `b-1`. */
const pager = (): FetchExportPage =>
  vi.fn(async (table: ExportTable, cursor: string | null) =>
    cursor === null
      ? { rows: [{ id: `${table}-1` }, { id: `${table}-2` }], next: 'more' }
      : { rows: [{ id: `${table}-3` }], next: null },
  );

async function lines(blob: Blob): Promise<string[]> {
  return (await blob.text()).split('\n').filter((line) => line !== '');
}

const base = {
  owner: 'jascha',
  get keySetup() {
    return SETUP;
  },
  prefs: { 'agent-board.desktopNotifications': 'on' },
  total: 24,
  signal: new AbortController().signal,
  now: NOW,
};

describe('buildExport', () => {
  it('writes the header and then every table in order, page by page', async () => {
    const fetchPage = pager();
    const blob = await buildExport({ ...base, includeTranscripts: true, fetchPage });
    const [headerLine, ...rows] = await lines(blob);
    const header = parseExportHeader(headerLine ?? '');
    expect(header).toMatchObject({
      owner: 'jascha',
      keyId: SETUP.keyId,
      keySlots: SETUP.slots,
      transcripts: true,
      exportedAt: NOW.toISOString(),
      prefs: base.prefs,
    });
    const parsed = rows.map(parseExportRowLine);
    expect(parsed).toHaveLength(30);
    expect([...new Set(parsed.map(({ table }) => table))]).toEqual([...EXPORT_TABLES]);
    expect(parsed.slice(0, 3).map(({ row }) => row['id'])).toEqual(['task-1', 'task-2', 'task-3']);
    expect(fetchPage).toHaveBeenCalledWith('task', 'more', base.signal);
  });

  it('leaves the transcript tables out and says so when transcripts are unchecked', async () => {
    const fetchPage = pager();
    const blob = await buildExport({ ...base, includeTranscripts: false, fetchPage });
    const [headerLine, ...rows] = await lines(blob);
    expect(parseExportHeader(headerLine ?? '').transcripts).toBe(false);
    expect(rows.map((line) => parseExportRowLine(line).table)).not.toContain('transcript_event');
    expect(fetchPage).not.toHaveBeenCalledWith('transcript_run', expect.anything(), expect.anything());
  });

  it('reports rows so far against the total', async () => {
    const onProgress = vi.fn();
    await buildExport({ ...base, includeTranscripts: false, fetchPage: pager(), onProgress });
    expect(onProgress.mock.calls[0]).toEqual([{ rows: 0, total: 24 }]);
    expect(onProgress.mock.calls.at(-1)).toEqual([{ rows: 24, total: 24 }]);
  });

  it('stops when cancelled and fetches nothing more', async () => {
    const controller = new AbortController();
    const fetchPage: FetchExportPage = vi.fn(async () => {
      controller.abort();
      return { rows: [{ id: 'x' }], next: 'more' };
    });
    await expect(
      buildExport({ ...base, includeTranscripts: true, fetchPage, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

describe('export counts and names', () => {
  const summary = {
    tasks: 1,
    schedules: 2,
    notes: 3,
    taskPrs: 4,
    machines: 5,
    sharedAgents: 1,
    linkRules: 1,
    titleRules: 0,
    transcriptRuns: 6,
    transcriptEvents: 7,
    running: 0,
  };

  it('counts the transcript rows only when they are exported', () => {
    expect(exportRowCount(summary, true)).toBe(30);
    expect(exportRowCount(summary, false)).toBe(17);
    expect(tablesOfExport(false)).not.toContain('transcript_run');
  });

  it('names the file after the user and the day, with unsafe characters replaced', () => {
    expect(exportFileName('jascha', NOW)).toBe('agent-board-jascha-2026-11-18.ndjson');
    expect(exportFileName('a/b c', NOW)).toBe('agent-board-a_b_c-2026-11-18.ndjson');
  });
});
