import { SEALED_ROW_COLUMNS } from '@agent-board/shared';
import { getTableColumns, type Column } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { SEALED_COLUMNS } from '../db/sealedColumns';
import {
  linkRules,
  titleRules,
  machines,
  notes,
  schedules,
  sharedAgents,
  taskPrs,
  tasks,
  transcriptEvents,
  transcriptRuns,
} from '../db/schema';
import { ACCOUNT_TABLES, type AccountTable } from './account';
import {
  linkRulesRowSchema,
  titleRulesRowSchema,
  machineRowSchema,
  noteRowSchema,
  scheduleRowSchema,
  sharedAgentsRowSchema,
  taskPrRowSchema,
  taskRowSchema,
  transcriptEventRowSchema,
  transcriptRunRowSchema,
} from './accountRows';

const TABLES: Record<AccountTable, { table: PgTable; schema: z.ZodObject }> = {
  task: { table: tasks, schema: taskRowSchema },
  schedule: { table: schedules, schema: scheduleRowSchema },
  note: { table: notes, schema: noteRowSchema },
  task_pr: { table: taskPrs, schema: taskPrRowSchema },
  machine: { table: machines, schema: machineRowSchema },
  shared_agents: { table: sharedAgents, schema: sharedAgentsRowSchema },
  link_rules: { table: linkRules, schema: linkRulesRowSchema },
  title_rules: { table: titleRules, schema: titleRulesRowSchema },
  transcript_run: { table: transcriptRuns, schema: transcriptRunRowSchema },
  transcript_event: { table: transcriptEvents, schema: transcriptEventRowSchema },
};

/**
 * The columns an import leaves out on purpose, by property name. A column added to a table that is in neither the row schema
 * nor this list fails the test below: decide then whether a file carries it.
 */
const IGNORED: Record<AccountTable, Record<string, string>> = {
  task: {
    owner: 'the signed-in user, whatever the file says',
    // The columns of a run: no run survives a move, and a running task comes in as Needs me.
    runId: 'run',
    runStartedAt: 'run',
    stopRequestedAt: 'run',
    stopMessageId: 'run',
    inboxRead: 'run',
  },
  schedule: { owner: 'the signed-in user, whatever the file says' },
  note: {
    owner: 'the signed-in user, whatever the file says',
    pending: 'a message for a running agent; no task runs after an import',
  },
  task_pr: { owner: 'the signed-in user, whatever the file says' },
  machine: {
    owner: 'the signed-in user, whatever the file says',
    feedRequests: 'a request for the exporting machine, applied or not; no machine acts on an import',
  },
  shared_agents: { owner: 'the signed-in user, whatever the file says' },
  link_rules: { owner: 'the signed-in user, whatever the file says' },
  title_rules: { owner: 'the signed-in user, whatever the file says' },
  transcript_run: { owner: 'the signed-in user, whatever the file says' },
  transcript_event: { owner: 'the signed-in user, whatever the file says' },
};

describe('the import row schemas', () => {
  it.each(ACCOUNT_TABLES)('%s: every column is read or ignored on purpose', (name) => {
    const { table, schema } = TABLES[name];
    const columns = Object.keys(getTableColumns(table));
    const accounted = [...Object.keys(schema.shape), ...Object.keys(IGNORED[name])].sort();
    expect(accounted).toEqual([...columns].sort());
  });
});

const snake = (property: string): string => property.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const nameOf = (column: Column): string => column.name;

describe('the re-seal of an import under another username', () => {
  it.each(ACCOUNT_TABLES)('%s: re-seals exactly the sealed columns the database checks', (name) => {
    const resealed = SEALED_ROW_COLUMNS[name].map(snake).sort();
    const checked = SEALED_COLUMNS.filter(({ table, kind }) => table === name && kind === 'envelope')
      .map(({ column }) => column)
      .sort();
    expect(resealed).toEqual(checked);
    const real = Object.values(getTableColumns(TABLES[name].table)).map(nameOf);
    for (const column of resealed) expect(real).toContain(column);
  });
});
