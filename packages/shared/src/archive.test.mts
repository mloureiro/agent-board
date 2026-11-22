import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXPORT_FORMAT,
  EXPORT_TABLES,
  EXPORT_VERSION,
  exportHeaderLine,
  exportRowLine,
  MAX_EXPORT_PREFS,
  parseExportHeader,
  parseExportRowLine,
  resealRow,
} from './archive.mts';
import type { ExportHeader, ExportTable, ResealContext } from './archive.mts';
import { ContractError } from './contract.mts';
import { deriveKeys, generateDataKey, open, seal, wrapDataKey } from './crypto.mts';
import type { Keys } from './crypto.mts';
import { serializePolish } from './polish.mts';
import { linkRulesBinding, linkRulesJson, sealLinkRules } from './linkRules.mts';
import { sealTitleRules, titleRulesBinding, titleRulesJson } from './titleRules.mts';
import { sealSharedAgents, sharedAgentsBinding, sharedAgentsJson } from './sharedAgents.mts';
import type { Question } from './questions.mts';
import {
  agentBinding,
  inputBinding,
  machineCatalogBinding,
  machineDirsBinding,
  machineUsageBinding,
  noteBinding,
  prBinding,
  sealAnswers,
  sealFields,
  sealMachineCatalog,
  sealMachineDirs,
  sealMachineUsage,
  sealNote,
  sealPr,
  sealQuestions,
  sealWatches,
  sealWorkdir,
  titleBinding,
  transcriptBinding,
  watchesBinding,
  workdirOpenBindings,
} from './sealing.mts';
import type { Binding, Opener, RowRef, Sealer } from './sealing.mts';

const dataKey = generateDataKey();
const alice = await deriveKeys(dataKey, 'alice', { index: true });
const bob = await deriveKeys(dataKey, 'bob', { index: true });
const sealer =
  (keys: Keys): Sealer =>
  (binding, text) =>
    seal(keys, binding.field, binding.context, text);
const opener =
  (keys: Keys): Opener =>
  async (binding, value) => {
    try {
      return await open(keys, binding.field, binding.context, value);
    } catch {
      return undefined;
    }
  };
const sealA = sealer(alice);
const openA = opener(alice);
const openB = opener(bob);

const runs = new Map<string, string>();
const ctx: ResealContext = { open: openA, seal: sealer(bob), taskOfRun: (runId) => runs.get(runId) };

const TASK = 'Ab3dEf9x';
const PARENT = 'Pa3dEf9x';
const SCHEDULE = 'Sc3dEf9x';
const OCCURRENCE = 'Oc3dEf9x';
const RUN = 'Ru3dEf9xAb3dEf9x';
const task: RowRef = { kind: 'task', id: TASK, createdBy: 'user', scheduleId: null, forkOf: null };
const schedule: RowRef = { kind: 'schedule', id: SCHEDULE, agent: 'reviewer' };
const occurrence: RowRef = {
  kind: 'task',
  id: OCCURRENCE,
  createdBy: 'user',
  scheduleId: SCHEDULE,
  forkOf: null,
  agent: 'reviewer',
};

/** The column is sealed again for bob under `binding`, with the same text, and no longer opens for alice. */
async function assertMoved(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  column: string,
  binding: Binding,
  plain: string,
) {
  const wire = after[column];
  assert.equal(typeof wire, 'string', column);
  assert.notEqual(wire, before[column], `${column} was not sealed again`);
  assert.equal(await openB(binding, wire as string), plain, column);
  assert.equal(await openA(binding, wire as string), undefined, `${column} still opens for the old owner`);
}

async function reseal(table: ExportTable, row: Record<string, unknown>) {
  const input = structuredClone(row);
  const result = await resealRow(table, row, ctx);
  assert.deepEqual(row, input, 'the input row is not changed');
  return result;
}

const header: ExportHeader = {
  format: EXPORT_FORMAT,
  version: EXPORT_VERSION,
  exportedAt: '2026-11-18T10:00:00.000Z',
  owner: 'alice',
  keyId: alice.keyId,
  keySlots: [
    {
      kind: 'passphrase',
      kdf: 'argon2id',
      m: 65536,
      t: 3,
      p: 1,
      salt: 'A'.repeat(22),
      wrapped: await wrapDataKey(generateDataKey(), dataKey),
    },
  ],
  transcripts: true,
  prefs: { theme: 'dark' },
};

const rejectsHeader = (value: unknown, pattern: RegExp) =>
  assert.throws(
    () => parseExportHeader(typeof value === 'string' ? value : JSON.stringify(value)),
    (error) => error instanceof ContractError && pattern.test(error.message),
  );

test('a header survives a round trip as one line', () => {
  const line = exportHeaderLine(header);
  assert.ok(!line.includes('\n'));
  assert.deepEqual(parseExportHeader(line), header);
});

test('a header without prefs has none', () => {
  const { prefs: _prefs, ...without } = header;
  assert.deepEqual(parseExportHeader(JSON.stringify(without)).prefs, {});
});

test('a header is refused for the wrong format, a newer version, a bad key, bad slots, too many prefs and a bad owner', () => {
  rejectsHeader('not json', /not valid JSON/);
  rejectsHeader([], /not a board export/);
  rejectsHeader({ ...header, format: 'other' }, /not a board export/);
  rejectsHeader({ ...header, version: 'one' }, /not a board export/);
  rejectsHeader({ ...header, version: 2 }, /newer version of the board \(format version 2\)/);
  rejectsHeader({ ...header, keyId: 'XYZ' }, /keyId/);
  rejectsHeader({ ...header, keySlots: [] }, /slots/);
  rejectsHeader({ ...header, keySlots: [{ kind: 'recovery', wrapped: 'abw1.x' }] }, /wrapped|slots/);
  rejectsHeader({ ...header, owner: '' }, /username/);
  rejectsHeader({ ...header, owner: 'a\0b' }, /username/);
  rejectsHeader({ ...header, owner: 'a'.repeat(257) }, /username/);
  rejectsHeader({ ...header, exportedAt: 'yesterday' }, /time/);
  rejectsHeader({ ...header, transcripts: 'yes' }, /transcripts/);
  rejectsHeader({ ...header, extra: 1 }, /unknown key/);
  rejectsHeader({ ...header, prefs: { a: 1 } }, /preference/);
  rejectsHeader({ ...header, prefs: { a: 'x'.repeat(5000) } }, /preference/);
  const many = Object.fromEntries(Array.from({ length: MAX_EXPORT_PREFS + 1 }, (_, i) => [`k${i}`, 'v']));
  rejectsHeader({ ...header, prefs: many }, /more than 50 preferences/);
});

test('a row line survives a round trip, for every table', () => {
  for (const table of EXPORT_TABLES) {
    const row = { id: 'x', text: 'two\nlines', n: 3, nothing: null };
    const line = exportRowLine(table, row);
    assert.ok(!line.includes('\n'));
    assert.deepEqual(parseExportRowLine(line), { table, row });
  }
});

test('a row line is refused for an unknown table, a row that is not an object and any other shape', () => {
  const bad = (line: string, pattern: RegExp) =>
    assert.throws(
      () => parseExportRowLine(line),
      (error) => error instanceof ContractError && pattern.test(error.message),
    );
  bad('{"table":"app_user","row":{}}', /table/);
  bad('{"table":"task","row":[]}', /not an object/);
  bad('{"table":"task","row":"x"}', /not an object/);
  bad('{"table":"task"}', /not an object/);
  bad('{"table":"task","row":{},"x":1}', /unknown key/);
  bad('[]', /not a row/);
  bad('{', /not valid JSON/);
});

test('a plain task is sealed again, and its clear columns, blind indexes and other columns are copied', async () => {
  const sealed = await sealFields(sealA, task, { title: 'Fix it', input: 'Please fix', workdir: '/home/a/repo' });
  const watches = await sealWatches(sealA, TASK, [], 0);
  const row = {
    id: TASK,
    createdBy: 'user',
    scheduleId: null,
    forkOf: null,
    ...sealed,
    homeWorkdir: sealed.workdir,
    watches,
    agent: null,
    dedupeKey: 'abh1.' + 'A'.repeat(43),
    head: null,
    status: 'todo',
    createdAt: '2026-11-18T10:00:00.000Z',
  };
  const { row: out, unreadable } = await reseal('task', row);
  assert.deepEqual(unreadable, []);
  await assertMoved(row, out, 'title', titleBinding(task), 'Fix it');
  await assertMoved(row, out, 'input', inputBinding(task), 'Please fix');
  await assertMoved(row, out, 'workdir', workdirOpenBindings(task)[0]!, '/home/a/repo');
  await assertMoved(row, out, 'homeWorkdir', workdirOpenBindings(task)[0]!, '/home/a/repo');
  await assertMoved(row, out, 'watches', watchesBinding(TASK), '{"watches":[],"pendingEvents":0}');
  assert.deepEqual(
    { ...out, title: 0, input: 0, workdir: 0, homeWorkdir: 0, watches: 0 },
    { ...row, title: 0, input: 0, workdir: 0, homeWorkdir: 0, watches: 0 },
  );
});

test('a task with an agent keeps its agent in the context of its input', async () => {
  const ref: RowRef = { ...task, agent: 'reviewer' };
  const sealed = await sealFields(sealA, ref, { title: 'T', input: 'Prompt' });
  const row = { id: TASK, createdBy: 'user', scheduleId: null, forkOf: null, ...sealed, workdir: null };
  const { row: out, unreadable } = await reseal('task', row);
  assert.deepEqual(unreadable, []);
  await assertMoved(row, out, 'agent', agentBinding(ref), 'reviewer');
  await assertMoved(row, out, 'input', inputBinding(ref), 'Prompt');
  assert.equal(out['workdir'], null);
});

test('a fork opens under its fork link and agent, and an agent of the intake or the agent creator is kept', async () => {
  const ref: RowRef = { ...task, createdBy: 'agent', forkOf: PARENT, agent: 'reviewer' };
  const sealed = await sealFields(sealA, ref, { title: 'T', input: 'Continue' });
  const row = { id: TASK, createdBy: 'agent', scheduleId: null, forkOf: PARENT, ...sealed };
  const { row: out, unreadable } = await reseal('task', row);
  assert.deepEqual(unreadable, []);
  await assertMoved(row, out, 'input', inputBinding(ref), 'Continue');
  await assertMoved(row, out, 'agent', agentBinding(ref), 'reviewer');
});

test('an occurrence re-seals its schedule’s directory under the schedule and its own rewrite under its own binding', async () => {
  const fromSchedule = await sealFields(sealA, schedule, { title: 'Daily', input: 'Do it', workdir: '/home/a/repo' });
  const rewrite = await sealWorkdir(sealA, occurrence, '/home/a/worktree');
  const base = {
    id: OCCURRENCE,
    createdBy: 'user',
    scheduleId: SCHEDULE,
    forkOf: null,
    title: fromSchedule.title,
    input: fromSchedule.input,
    agent: fromSchedule.agent,
  };
  const copied = { ...base, workdir: fromSchedule.workdir, homeWorkdir: fromSchedule.workdir };
  const rewritten = { ...base, workdir: rewrite, homeWorkdir: fromSchedule.workdir };
  const [scheduleBinding, ownBinding] = workdirOpenBindings(occurrence) as [Binding, Binding];

  const first = await reseal('task', copied);
  assert.deepEqual(first.unreadable, []);
  await assertMoved(copied, first.row, 'title', titleBinding(occurrence), 'Daily');
  await assertMoved(copied, first.row, 'input', inputBinding(occurrence), 'Do it');
  await assertMoved(copied, first.row, 'workdir', scheduleBinding, '/home/a/repo');

  const second = await reseal('task', rewritten);
  assert.deepEqual(second.unreadable, []);
  await assertMoved(rewritten, second.row, 'workdir', ownBinding, '/home/a/worktree');
  assert.equal(await openB(scheduleBinding, second.row['workdir'] as string), undefined);
  await assertMoved(rewritten, second.row, 'homeWorkdir', scheduleBinding, '/home/a/repo');
});

test('a schedule is sealed again', async () => {
  const sealed = await sealFields(sealA, schedule, { title: 'Daily', input: 'Do it', workdir: '/srv/x' });
  const row = { id: SCHEDULE, ...sealed, everyMs: 3600000, cron: null };
  const { row: out, unreadable } = await reseal('schedule', row);
  assert.deepEqual(unreadable, []);
  await assertMoved(row, out, 'title', titleBinding(schedule), 'Daily');
  await assertMoved(row, out, 'input', inputBinding(schedule), 'Do it');
  await assertMoved(row, out, 'workdir', workdirOpenBindings(schedule)[0]!, '/srv/x');
  await assertMoved(row, out, 'agent', agentBinding(schedule), 'reviewer');
  assert.equal(out['everyMs'], 3600000);
});

const questions: Question[] = [
  {
    header: 'Scope',
    question: 'Review the migration too?',
    multiSelect: false,
    options: [
      { label: 'Yes', description: 'Include it' },
      { label: 'No', description: 'Skip it' },
    ],
  },
];

test('every kind of note is sealed again under its own author and kind', async () => {
  const note = (author: 'agent' | 'user' | 'system', kind: 'comment' | 'question' | 'answer' | 'event' | 'polish') => ({
    id: `n-${author}-${kind}`,
    taskId: TASK,
    author,
    kind,
    questionNoteId: null,
    createdAt: '2026-11-18T10:00:00.000Z',
  });
  const cases: [string, Record<string, unknown>, [string, Binding['field'], string][]][] = [];

  const comment = await sealNote(sealA, { taskId: TASK, author: 'agent', kind: 'comment' }, 'Done.', {
    suggestion: 'Ship it',
  });
  cases.push([
    'agent comment',
    { ...note('agent', 'comment'), ...comment },
    [
      ['body', 'note.body', 'Done.'],
      ['preview', 'note.preview', 'Done.'],
      ['suggestion', 'note.suggestion', 'Ship it'],
    ],
  ]);

  const question = await sealQuestions(sealA, TASK, questions);
  cases.push([
    'question',
    { ...note('agent', 'question'), ...question, preview: null },
    [
      ['body', 'note.body', ''],
      ['questions', 'note.questions', JSON.stringify(questions)],
    ],
  ]);

  const answers = await sealAnswers(sealA, TASK, questions, [{ selected: ['Yes'] }]);
  const answerNote = await sealNote(sealA, { taskId: TASK, author: 'user', kind: 'answer' }, 'Yes');
  cases.push([
    'answer',
    { ...note('user', 'answer'), ...answerNote, answers },
    [
      ['body', 'note.body', 'Yes'],
      ['preview', 'note.preview', 'Yes'],
      ['answers', 'note.answers', JSON.stringify({ questions, answers: [{ selected: ['Yes'] }] })],
    ],
  ]);

  const polishText = serializePolish({ target: PARENT, title: 'A title', prompt: 'A better prompt' });
  const polish = await sealNote(sealA, { taskId: TASK, author: 'agent', kind: 'polish' }, polishText, {
    previewSource: 'A better prompt',
  });
  cases.push([
    'polish',
    { ...note('agent', 'polish'), ...polish },
    [
      ['body', 'note.body', polishText],
      ['preview', 'note.preview', 'A better prompt'],
    ],
  ]);

  for (const [author, text] of [
    ['system', 'Woke up.'],
    ['user', 'Edited the prompt.'],
  ] as const) {
    const event = await sealNote(sealA, { taskId: TASK, author, kind: 'event' }, text);
    cases.push([
      `${author} event`,
      { ...note(author, 'event'), ...event },
      [
        ['body', 'note.body', text],
        ['preview', 'note.preview', text],
      ],
    ]);
  }

  const userComment = await sealNote(sealA, { taskId: TASK, author: 'user', kind: 'comment' }, 'Thanks');
  cases.push([
    'user comment',
    { ...note('user', 'comment'), ...userComment },
    [
      ['body', 'note.body', 'Thanks'],
      ['preview', 'note.preview', 'Thanks'],
    ],
  ]);

  for (const [name, row, columns] of cases) {
    const { row: out, unreadable } = await reseal('note', row);
    assert.deepEqual(unreadable, [], name);
    for (const [column, field, plain] of columns) {
      const author = row['author'] as 'agent' | 'user' | 'system';
      const binding = noteBinding(field as Parameters<typeof noteBinding>[0], TASK, author, row['kind'] as never);
      await assertMoved(row, out, column, binding, plain);
    }
  }
});

test('the plain body of a server event is never touched', async () => {
  const row = {
    id: 'n1',
    taskId: TASK,
    author: 'server',
    kind: 'event',
    body: 'Marked done.',
    preview: 'Marked done.',
  };
  const { row: out, unreadable } = await reseal('note', row);
  assert.deepEqual(out, row);
  assert.deepEqual(unreadable, []);
});

test('a reported pull request is sealed again under its task', async () => {
  const url = 'https://github.com/acme/repo/pull/7';
  const row = { id: 'pr1', taskId: TASK, pr: await sealPr(sealA, TASK, url), state: 'open' };
  const { row: out, unreadable } = await reseal('task_pr', row);
  assert.deepEqual(unreadable, []);
  await assertMoved(row, out, 'pr', prBinding(TASK), url);
  assert.equal(out['state'], 'open');
});

test('the three documents of a machine are sealed again and their blind indexes copied', async () => {
  const name = 'laptop.home';
  const dirs = [{ path: '/home/a/repo', label: 'repo' }];
  const catalog = { models: [], skills: [], dirs: {} };
  const usage = { windows: {}, reached: [], held: [], open: [] };
  const row = {
    name,
    tokenHash: 'ff',
    dirs: await sealMachineDirs(sealA, name, dirs),
    dirsIndex: 'abh1.' + 'D'.repeat(43),
    catalog: await sealMachineCatalog(sealA, name, catalog),
    catalogIndex: 'abh1.' + 'C'.repeat(43),
    usage: await sealMachineUsage(sealA, name, usage),
    usageIndex: 'abh1.' + 'U'.repeat(43),
    lastSeenAt: null,
  };
  const { row: out, unreadable } = await reseal('machine', row);
  assert.deepEqual(unreadable, []);
  await assertMoved(row, out, 'dirs', machineDirsBinding(name), JSON.stringify({ dirs }));
  await assertMoved(row, out, 'catalog', machineCatalogBinding(name), JSON.stringify(catalog));
  await assertMoved(row, out, 'usage', machineUsageBinding(name), JSON.stringify(usage));
  assert.equal(out['dirsIndex'], row.dirsIndex);
  assert.equal(out['catalogIndex'], row.catalogIndex);
  assert.equal(out['usageIndex'], row.usageIndex);
});

test('a machine whose name is not a machine name has unreadable documents', async () => {
  const row = { name: 'bad name', dirs: await sealMachineDirs(sealA, 'laptop', []) };
  const { row: out, unreadable } = await reseal('machine', row);
  assert.deepEqual(unreadable, ['dirs']);
  assert.deepEqual(out, row);
});

test('the shared agents are sealed again under the version of the row; another version leaves them unreadable', async () => {
  const document = { version: 4, agents: { reviewer: { description: 'Reviews', tools: ['Read'] } } };
  const row = { version: 4, document: await sealSharedAgents(sealA, document), pushedAt: '2026-11-18T10:00:00Z' };
  const { row: out, unreadable } = await reseal('shared_agents', row);
  assert.deepEqual(unreadable, []);
  await assertMoved(row, out, 'document', sharedAgentsBinding(4), sharedAgentsJson(document));
  assert.equal(out['version'], 4);
  const relabelled = await reseal('shared_agents', { ...row, version: 5 });
  assert.deepEqual(relabelled.unreadable, ['document']);
  assert.deepEqual((await reseal('shared_agents', { ...row, version: 'four' })).unreadable, ['document']);
});

test('the link rules are sealed again under the version of the row; another version leaves them unreadable', async () => {
  const document = { version: 2, rules: [{ pattern: 'sc-(\\d+)', url: 'https://app.shortcut.com/acme/story/$1' }] };
  const row = { version: 2, document: await sealLinkRules(sealA, document), updatedAt: '2026-11-18T10:00:00Z' };
  const { row: out, unreadable } = await reseal('link_rules', row);
  assert.deepEqual(unreadable, []);
  await assertMoved(row, out, 'document', linkRulesBinding(2), linkRulesJson(document));
  assert.equal(out['version'], 2);
  const relabelled = await reseal('link_rules', { ...row, version: 3 });
  assert.deepEqual(relabelled.unreadable, ['document']);
  assert.deepEqual((await reseal('link_rules', { ...row, version: 'two' })).unreadable, ['document']);
});

test('the title rules are sealed again under the version of the row', async () => {
  const document = { version: 3, rules: [{ pattern: 'review', icon: '🔎', instruction: 'Name the PR.' }] };
  const row = { version: 3, document: await sealTitleRules(sealA, document), updatedAt: '2026-11-18T10:00:00Z' };
  const { row: out, unreadable } = await reseal('title_rules', row);
  assert.deepEqual(unreadable, []);
  await assertMoved(row, out, 'document', titleRulesBinding(3), titleRulesJson(document));
  assert.deepEqual((await reseal('title_rules', { ...row, version: 4 })).unreadable, ['document']);
});

test('a transcript run has nothing to seal', async () => {
  const row = { id: RUN, taskId: TASK, machine: 'laptop', eventCount: 2 };
  assert.deepEqual(await reseal('transcript_run', row), { row, unreadable: [] });
});

test('transcript events are sealed again under their task, run and position, with or without an output', async () => {
  runs.set(RUN, TASK);
  const dataBinding = transcriptBinding('tr.data', TASK, RUN, 4);
  const outputBinding = transcriptBinding('tr.output', TASK, RUN, 4);
  const withOutput = {
    runId: RUN,
    seq: 4,
    kind: 'tool_result',
    data: await sealA(dataBinding, '{"kind":"tool_result"}'),
    output: await sealA(outputBinding, 'ls output'),
    outputSize: 9,
  };
  const first = await reseal('transcript_event', withOutput);
  assert.deepEqual(first.unreadable, []);
  await assertMoved(withOutput, first.row, 'data', dataBinding, '{"kind":"tool_result"}');
  await assertMoved(withOutput, first.row, 'output', outputBinding, 'ls output');

  const withoutOutput = { ...withOutput, output: null, outputSize: null };
  const second = await reseal('transcript_event', withoutOutput);
  assert.deepEqual(second.unreadable, []);
  await assertMoved(withoutOutput, second.row, 'data', dataBinding, '{"kind":"tool_result"}');
  assert.equal(second.row['output'], null);
});

test('a transcript event of an unknown run is unreadable and unchanged', async () => {
  const binding = transcriptBinding('tr.data', TASK, 'Un3dEf9xAb3dEf9x', 0);
  const row = {
    runId: 'Un3dEf9xAb3dEf9x',
    seq: 0,
    data: await sealA(binding, '{}'),
    output: await sealA(transcriptBinding('tr.output', TASK, 'Un3dEf9xAb3dEf9x', 0), 'x'),
  };
  const { row: out, unreadable } = await reseal('transcript_event', row);
  assert.deepEqual(unreadable, ['data', 'output']);
  assert.deepEqual(out, row);
});

test('a column that holds garbage is reported and left as it is, and the rest of the row is sealed again', async () => {
  const sealed = await sealFields(sealA, task, { title: 'T', input: 'P' });
  const row = {
    id: TASK,
    createdBy: 'user',
    scheduleId: null,
    forkOf: null,
    ...sealed,
    workdir: 'abe1.garbage',
    watches: 'plain text',
  };
  const { row: out, unreadable } = await reseal('task', row);
  assert.deepEqual(unreadable, ['workdir', 'watches']);
  assert.equal(out['workdir'], 'abe1.garbage');
  assert.equal(out['watches'], 'plain text');
  await assertMoved(row, out, 'title', titleBinding(task), 'T');
});

test('a value that is already another owner’s stays unreadable', async () => {
  const bobSealed = await sealFields(sealer(bob), task, { title: 'T', input: 'P' });
  const row = { id: TASK, createdBy: 'user', scheduleId: null, forkOf: null, ...bobSealed };
  const { row: out, unreadable } = await reseal('task', row);
  assert.deepEqual(unreadable, ['title', 'input']);
  assert.deepEqual(out, row);
});

test('a swapped fork link leaves the input unreadable and unchanged, the other columns are sealed again', async () => {
  const ref: RowRef = { ...task, forkOf: PARENT, agent: 'reviewer' };
  const sealed = await sealFields(sealA, ref, { title: 'T', input: 'Continue' });
  const swapped = { id: TASK, createdBy: 'user', scheduleId: null, forkOf: 'Ot3dEf9x', ...sealed };
  const dropped = { ...swapped, forkOf: null };
  for (const row of [swapped, dropped]) {
    const { row: out, unreadable } = await reseal('task', row);
    assert.deepEqual(unreadable, ['input']);
    assert.equal(out['input'], row.input);
    await assertMoved(row, out, 'agent', agentBinding(ref), 'reviewer');
  }
});

test('a swapped agent leaves the agent and the input unreadable and unchanged', async () => {
  const ref: RowRef = { ...task, agent: 'reviewer' };
  const sealed = await sealFields(sealA, ref, { title: 'T', input: 'Prompt' });
  const other = await sealFields(sealA, { ...task, agent: 'builder' }, { title: 'T', input: 'Prompt' });
  const swapped = { id: TASK, createdBy: 'user', scheduleId: null, forkOf: null, ...sealed, agent: other.agent };
  const { row: out, unreadable } = await reseal('task', swapped);
  assert.deepEqual(unreadable, ['input']);
  assert.equal(out['input'], swapped.input);
  const gone = { ...swapped, agent: 'abe1.garbage' };
  const second = await reseal('task', gone);
  assert.deepEqual(second.unreadable, ['input', 'agent']);
  assert.deepEqual({ ...second.row, title: 0 }, { ...gone, title: 0 });
});

test('an agent that opens to something that is not an agent name leaves the agent and the input unreadable', async () => {
  const ref: RowRef = { ...task, agent: 'reviewer' };
  const sealed = await sealFields(sealA, ref, { title: 'T', input: 'Prompt' });
  const agent = await sealA(agentBinding(task), 'Not An Agent!');
  const row = { id: TASK, createdBy: 'user', scheduleId: null, forkOf: null, ...sealed, agent };
  const { row: out, unreadable } = await reseal('task', row);
  assert.deepEqual(unreadable, ['input', 'agent']);
  assert.equal(out['agent'], agent);
});

test('a clear column of the wrong shape makes the sealed columns unreadable instead of throwing', async () => {
  const sealed = await sealFields(sealA, task, { title: 'T', input: 'P' });
  const bad = [
    { id: '../x' },
    { id: 7 },
    { createdBy: 'root' },
    { scheduleId: 3 },
    { scheduleId: 'a b' },
    { forkOf: ['x'] },
  ];
  for (const change of bad) {
    const row = { id: TASK, createdBy: 'user', scheduleId: null, forkOf: null, ...sealed, ...change };
    const { row: out, unreadable } = await reseal('task', row);
    assert.deepEqual(unreadable, ['title', 'input'], JSON.stringify(change));
    assert.deepEqual(out, row);
  }
  const note = {
    taskId: '../x',
    author: 'user',
    kind: 'comment',
    body: (await sealNote(sealA, { taskId: TASK, author: 'user', kind: 'comment' }, 'x')).body,
  };
  assert.deepEqual((await reseal('note', note)).unreadable, ['body']);
  assert.deepEqual((await reseal('note', { ...note, taskId: TASK, kind: 'nonsense' })).unreadable, ['body']);
  assert.deepEqual((await reseal('transcript_event', { runId: RUN, seq: 1.5, data: note.body })).unreadable, ['data']);
});
