import type { Keys } from '../index.mts';
import { importBoard, type ImportBatch } from './boardImport.mts';
import {
  openBoardAgents,
  openBoardLinks,
  openBoardTask,
  openBoardTitleRules,
  openCatalogs,
  openContext,
  openEvent,
  openFeeds,
  openListedTasks,
  openMachines,
  openOutput,
  openRuns,
  openSchedule,
  openTaskDetail,
} from './responses.mts';
import {
  sealAnswer,
  sealApply,
  sealConfigure,
  sealEdit,
  sealFork,
  sealLinks,
  sealNewTask,
  sealReply,
  sealScheduleUpdate,
  sealStart,
  sealTitleRulesInput,
} from './requests.mts';

// The fixtures are JSON, so a case's arguments arrive untyped; each entry names the function it calls and nothing else.
const call =
  <A extends unknown[], R>(fn: (keys: Keys, ...args: A) => Promise<R>) =>
  (keys: Keys, args: unknown[]): Promise<R> =>
    fn(keys, ...(args as A));

export type Call = (keys: Keys, args: unknown[]) => Promise<unknown>;

async function importFile(keys: Keys, [lines]: unknown[]): Promise<ImportBatch[]> {
  const batches: ImportBatch[] = [];
  const text = (lines as string[]).map((line) => `${line}\n`).join('');
  await importBoard({
    file: new Blob([text]),
    keys,
    importBatch: async (batch) => {
      batches.push(batch);
      return { inserted: batch.rows.length, existing: 0, invalid: 0, orphaned: 0 };
    },
    restorePrefs: () => undefined,
  });
  return batches;
}

export const sealers: Record<string, Call> = {
  sealNewTask: call(sealNewTask),
  sealReply: call(sealReply),
  sealAnswer: call(sealAnswer),
  sealStart: call(sealStart),
  sealFork: call(sealFork),
  sealEdit: call(sealEdit),
  sealApply: call(sealApply),
  sealConfigure: call(sealConfigure),
  sealScheduleUpdate: call(sealScheduleUpdate),
  sealTitleRulesInput: call(sealTitleRulesInput),
  sealLinks: call(sealLinks),
  importBoard: importFile,
};

export const openers: Record<string, Call> = {
  openBoardTask: call(openBoardTask),
  openListedTasks: call(openListedTasks),
  openTaskDetail: call(openTaskDetail),
  openSchedule: call(openSchedule),
  openMachines: call(openMachines),
  openCatalogs: call(openCatalogs),
  openBoardAgents: call(openBoardAgents),
  openBoardLinks: call(openBoardLinks),
  openBoardTitleRules: call(openBoardTitleRules),
  openEvent: call(openEvent),
  openOutput: call(openOutput),
  openFeeds: call(openFeeds),
  openContext: call(openContext),
  openRuns: (_keys, [wire]) => Promise.resolve(openRuns(wire as Parameters<typeof openRuns>[0])),
};

export const FIXTURES = new URL('../__tests__/fixtures/ui-golden/', import.meta.url);

export const REDACTED = '<sealed>';

export function valueAt(root: unknown, path: string): unknown {
  if (path === '') return root;
  return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root);
}

/** A copy of `root` with the value at each path replaced by a marker, which leaves the clear fields. */
export function redact<T>(root: T, paths: string[]): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(root));
  if (paths.includes('')) return REDACTED;
  for (const path of paths) {
    const keys = path.split('.');
    const last = keys.pop() ?? '';
    (valueAt(copy, keys.join('.')) as Record<string, unknown>)[last] = REDACTED;
  }
  return copy;
}

export interface SealedField {
  at: string;
  field: string;
  context: string;
  plaintext: string;
}

export interface RequestCase {
  name: string;
  sealer: string;
  ids: string[];
  args: unknown[];
  sealed: unknown;
  fields: SealedField[];
  clear: unknown;
}

export interface ResponseCase {
  name: string;
  opener: string;
  args: unknown[];
  opened: unknown;
}

export interface KeyFixture {
  owner: string;
  dataKey: string;
  keyId: string;
  kdf: { m: number; t: number; p: number };
  passphrase: string;
  salt: string;
  wrappingKey: string;
  setup: {
    passphrase: string;
    recoveryKey: string;
    keyId: string;
    keySetup: { keyId: string; slots: unknown[] };
  };
}
