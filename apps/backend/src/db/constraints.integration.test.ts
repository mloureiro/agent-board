import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import { asOwner, useTestDb } from '../test/helpers';
import {
  migrationsBefore,
  removeFolder,
  SCRATCH_MIGRATION_TIMEOUT,
  SCRATCH_TEARDOWN_TIMEOUT,
  scratchDatabases,
} from '../test/scratch';
import { createDb, runMigrations, type Tx } from './client';
import { SEALED_COLUMNS } from './sealedColumns';

const constraintNames = sql.join(
  SEALED_COLUMNS.map(({ constraint }) => sql`${constraint}`),
  sql`, `,
);

const ENVELOPE = `abe1.${'A'.repeat(40)}`;
const BLIND_INDEX = `abh1.${'A'.repeat(43)}`;

/** The check constraint a refused statement names, or undefined when it was accepted. */
async function refusedBy(attempt: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await attempt();
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    return cause?.constraint ?? 'refused for another reason';
  }
  return undefined;
}

describe('the sealed-content constraints (migration 0014)', { timeout: SCRATCH_MIGRATION_TIMEOUT }, () => {
  const scratch = scratchDatabases('constraints');
  const folders: string[] = [];
  const pools: Awaited<ReturnType<typeof createDb>>[] = [];

  /** A connection to a new, empty database. */
  const open = async (): Promise<Awaited<ReturnType<typeof createDb>>> => {
    const connection = await createDb(await scratch.create());
    pools.push(connection);
    return connection;
  };

  afterAll(async () => {
    await Promise.all(pools.splice(0).map(({ pool }) => pool.end()));
    await scratch.dropAll();
    folders.forEach(removeFolder);
  }, SCRATCH_TEARDOWN_TIMEOUT);

  it('passes on an empty database, with every constraint validated', async () => {
    const { db } = await open();
    await runMigrations(db);
    const { rows } = await db.execute<{ conname: string; convalidated: boolean }>(
      sql`select conname, convalidated from pg_constraint where conname in (${constraintNames})`,
    );
    expect(rows).toHaveLength(SEALED_COLUMNS.length);
    expect(rows.every((row) => row.convalidated)).toBe(true);
  });

  it('stops while plain text remains, names the script and the columns, and changes nothing', async () => {
    const before = migrationsBefore('_sealed_content_constraints');
    folders.push(before);
    const { db } = await open();
    await migrate(db, { migrationsFolder: before });
    await db.execute(sql`insert into app_user (username) values ('alice')`);
    await db.execute(
      sql`insert into task (id, owner, title, input, position) values ('t1', 'alice', 'plain', 'plain', 0)`,
    );
    await db.execute(
      sql`insert into note (id, owner, task_id, author, kind, body) values ('n1', 'alice', 't1', 'user', 'comment', 'plain')`,
    );
    const failure = await runMigrations(db).then(
      () => undefined,
      (error: unknown) => error as { cause?: { message?: string } },
    );
    expect(failure?.cause?.message).toMatch(
      /Plain text is still stored in sealed columns: .*note\.body \(1 rows\).*task\.title \(1 rows\).*task\.input \(1 rows\)\. Run the re-encryption script first \(pnpm --filter @agent-board\/backend reencrypt/,
    );
    const { rows } = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_constraint where conname in (${constraintNames})`,
    );
    expect(rows[0]?.n).toBe(0);
    const applied = await db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(applied.rows[0]?.n).toBe(14);
  });
});

const { db, admin } = await useTestDb();

describe('what the application role can store afterwards', () => {
  const clear = () => admin.execute(sql`truncate app_user, note, task, schedule restart identity cascade`);
  const as = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => asOwner(db, 'alice', fn);

  const task = (
    tx: Tx,
    o: {
      title?: string;
      input?: string;
      workdir?: string | null;
      homeWorkdir?: string | null;
      agent?: string | null;
      icon?: string | null;
      labels?: string | null;
      dedupeKey?: string | null;
      head?: string | null;
      watches?: string | null;
    } = {},
  ) =>
    tx.execute(sql`
      insert into task (id, title, input, workdir, home_workdir, agent, icon, labels, dedupe_key, head, watches, position)
      values ('t1', ${o.title ?? ENVELOPE}, ${o.input ?? ENVELOPE}, ${o.workdir ?? null}, ${o.homeWorkdir ?? null}, ${o.agent ?? null}, ${o.icon ?? null}, ${o.labels ?? null}, ${o.dedupeKey ?? null}, ${o.head ?? null}, ${o.watches ?? null}, 0)`);
  const taskPr = async (tx: Tx, o: { pr?: string } = {}) => {
    await task(tx);
    await tx.execute(sql`insert into task_pr (id, task_id, pr) values ('p1', 't1', ${o.pr ?? ENVELOPE})`);
  };
  const schedule = (
    tx: Tx,
    o: {
      title?: string;
      input?: string;
      workdir?: string | null;
      agent?: string | null;
      icon?: string | null;
      labels?: string | null;
    } = {},
  ) =>
    tx.execute(sql`
      insert into schedule (id, title, input, workdir, agent, icon, labels, every_ms, anchor_at)
      values ('s1', ${o.title ?? ENVELOPE}, ${o.input ?? ENVELOPE}, ${o.workdir ?? null}, ${o.agent ?? null}, ${o.icon ?? null}, ${o.labels ?? null}, 1000, now())`);
  const note = async (
    tx: Tx,
    o: {
      author?: string;
      kind?: string;
      body?: string;
      preview?: string | null;
      suggestion?: string | null;
      questions?: string | null;
      answers?: string | null;
    } = {},
  ) => {
    await task(tx);
    await tx.execute(sql`
      insert into note (id, task_id, author, kind, body, preview, suggestion, questions, answers)
      values ('n1', 't1', ${o.author ?? 'agent'}::note_author, ${o.kind ?? 'comment'}::note_kind, ${o.body ?? ENVELOPE},
        ${o.preview ?? null}, ${o.suggestion ?? null}, ${o.questions ?? null}, ${o.answers ?? null})`);
  };
  const event = async (tx: Tx, o: { data?: string; output?: string | null } = {}) => {
    await task(tx);
    await tx.execute(sql`
      insert into transcript_run (id, task_id, machine, started_at, last_event_at) values ('r1', 't1', 'laptop', now(), now())`);
    await tx.execute(sql`
      insert into transcript_event (run_id, seq, at, kind, data, output)
      values ('r1', 0, now(), 'note', ${o.data ?? ENVELOPE}, ${o.output ?? null})`);
  };

  const machine = (
    tx: Tx,
    o: {
      dirs?: string | null;
      dirsIndex?: string | null;
      catalog?: string | null;
      catalogIndex?: string | null;
      usage?: string | null;
      usageIndex?: string | null;
      sources?: string | null;
      sourcesIndex?: string | null;
    } = {},
  ) =>
    tx.execute(sql`
      insert into machine (name, token_hash, dirs, dirs_index, catalog, catalog_index, usage, usage_index, sources, sources_index)
      values ('laptop', 'hash', ${o.dirs ?? null}, ${o.dirsIndex ?? null}, ${o.catalog ?? null}, ${o.catalogIndex ?? null}, ${o.usage ?? null}, ${o.usageIndex ?? null}, ${o.sources ?? null}, ${o.sourcesIndex ?? null})`);

  const sharedAgents = (tx: Tx, document: string) =>
    tx.execute(sql`insert into shared_agents (version, document) values (1, ${document})`);

  const linkRules = (tx: Tx, document: string) =>
    tx.execute(sql`insert into link_rules (version, document) values (1, ${document})`);

  const titleRules = (tx: Tx, document: string) =>
    tx.execute(sql`insert into title_rules (version, document) values (1, ${document})`);

  const plaintextCases: [string, string, (tx: Tx) => Promise<unknown>][] = [
    ['task_title_sealed', 'a plain task title', (tx) => task(tx, { title: 'plain' })],
    ['task_input_sealed', 'a plain prompt', (tx) => task(tx, { input: 'plain' })],
    ['task_input_sealed', 'an empty prompt', (tx) => task(tx, { input: '' })],
    ['task_workdir_sealed', 'a plain directory', (tx) => task(tx, { workdir: '/home/a' })],
    ['task_home_workdir_sealed', 'a plain home directory', (tx) => task(tx, { homeWorkdir: '/home/a' })],
    ['task_agent_sealed', 'a plain agent name', (tx) => task(tx, { agent: 'reviewer' })],
    ['task_icon_sealed', 'a plain icon', (tx) => task(tx, { icon: '🚀' })],
    ['task_labels_sealed', 'plain labels', (tx) => task(tx, { labels: '["bug"]' })],
    ['task_watches_sealed', 'plain watches', (tx) => task(tx, { watches: '{"watches":[]}' })],
    ['schedule_agent_sealed', 'a plain schedule agent name', (tx) => schedule(tx, { agent: 'reviewer' })],
    ['schedule_icon_sealed', 'a plain schedule icon', (tx) => schedule(tx, { icon: '🚀' })],
    ['schedule_labels_sealed', 'plain schedule labels', (tx) => schedule(tx, { labels: '["bug"]' })],
    ['task_pr_pr_sealed', 'a plain PR URL', (tx) => taskPr(tx, { pr: 'https://github.com/o/r/pull/1' })],
    ['task_dedupe_key_blind', 'a plain dedupe key', (tx) => task(tx, { dedupeKey: 'https://github.com/o/r/pull/1' })],
    ['task_head_blind', 'a plain head', (tx) => task(tx, { head: 'abcdef1' })],
    ['task_head_blind', 'an envelope as a head', (tx) => task(tx, { head: ENVELOPE })],
    ['machine_dirs_sealed', 'a plain directory list', (tx) => machine(tx, { dirs: '{"dirs":[]}' })],
    ['machine_dirs_index_blind', 'a plain directory list index', (tx) => machine(tx, { dirsIndex: 'abcdef' })],
    ['machine_dirs_index_blind', 'an envelope as a list index', (tx) => machine(tx, { dirsIndex: ENVELOPE })],
    ['machine_catalog_sealed', 'a plain catalogue', (tx) => machine(tx, { catalog: '{"skills":[]}' })],
    ['machine_catalog_index_blind', 'a plain catalogue index', (tx) => machine(tx, { catalogIndex: 'abcdef' })],
    [
      'machine_catalog_index_blind',
      'an envelope as a catalogue index',
      (tx) => machine(tx, { catalogIndex: ENVELOPE }),
    ],
    ['machine_usage_sealed', 'a plain usage status', (tx) => machine(tx, { usage: '{"windows":{}}' })],
    ['machine_usage_index_blind', 'a plain usage index', (tx) => machine(tx, { usageIndex: 'abcdef' })],
    ['machine_usage_index_blind', 'an envelope as a usage index', (tx) => machine(tx, { usageIndex: ENVELOPE })],
    ['machine_sources_sealed', 'plain sources', (tx) => machine(tx, { sources: '{"sources":[]}' })],
    ['machine_sources_index_blind', 'a plain sources index', (tx) => machine(tx, { sourcesIndex: 'abcdef' })],
    ['shared_agents_document_sealed', 'plain shared agents', (tx) => sharedAgents(tx, '{"version":1,"agents":{}}')],
    ['link_rules_document_sealed', 'plain link rules', (tx) => linkRules(tx, '{"version":1,"rules":[]}')],
    ['title_rules_document_sealed', 'plain title rules', (tx) => titleRules(tx, '{"version":1,"rules":[]}')],
    ['task_title_sealed', 'a too short envelope', (tx) => task(tx, { title: 'abe1.AAAA' })],
    ['task_title_sealed', 'an envelope with a line break', (tx) => task(tx, { title: `${ENVELOPE}\n` })],
    ['schedule_title_sealed', 'a plain schedule title', (tx) => schedule(tx, { title: 'plain' })],
    ['schedule_input_sealed', 'a plain schedule prompt', (tx) => schedule(tx, { input: 'plain' })],
    ['schedule_workdir_sealed', 'a plain schedule directory', (tx) => schedule(tx, { workdir: '/w' })],
    ['note_body_sealed', 'a plain agent comment', (tx) => note(tx, { body: 'plain' })],
    [
      'note_body_sealed',
      'a plain system event',
      (tx) => note(tx, { author: 'system', kind: 'event', body: 'Closed.' }),
    ],
    [
      'note_body_sealed',
      'a plain server comment',
      (tx) => note(tx, { author: 'server', kind: 'comment', body: 'Closed.' }),
    ],
    ['note_body_sealed', 'a plain empty body', (tx) => note(tx, { body: '' })],
    ['note_preview_sealed', 'a plain preview', (tx) => note(tx, { preview: 'plain' })],
    ['note_suggestion_sealed', 'a plain suggestion', (tx) => note(tx, { suggestion: 'Yes, go ahead.' })],
    ['note_questions_sealed', 'plain questions', (tx) => note(tx, { kind: 'question', questions: '[]' })],
    ['note_answers_sealed', 'plain answers', (tx) => note(tx, { author: 'user', kind: 'answer', answers: '[]' })],
    ['transcript_event_data_sealed', 'plain event data', (tx) => event(tx, { data: '{"kind":"note"}' })],
    ['transcript_event_output_sealed', 'a plain tool output', (tx) => event(tx, { output: 'plain' })],
    ['transcript_event_output_sealed', 'an empty tool output', (tx) => event(tx, { output: '' })],
  ];

  it.each(plaintextCases)('refuses (%s): %s', async (constraint, _what, attempt) => {
    expect(await refusedBy(() => as(attempt))).toBe(constraint);
  });

  it('covers every sealed column', () => {
    expect(new Set(plaintextCases.map(([constraint]) => constraint))).toEqual(
      new Set(SEALED_COLUMNS.map((column) => column.constraint)),
    );
  });

  it.each([
    ['a user comment', { author: 'user', kind: 'comment' }],
    ['an agent question', { author: 'agent', kind: 'question', questions: ENVELOPE }],
    ['a system event', { author: 'system', kind: 'event' }],
  ])('refuses a sealed suggestion on %s', async (_what, fields) => {
    expect(await refusedBy(() => as((tx) => note(tx, { ...fields, suggestion: ENVELOPE })))).toBe(
      'note_suggestion_agent_comment',
    );
  });

  it('accepts sealed values, null where a column may be empty, and the server events in plain text', async () => {
    await as(async (tx) => {
      await task(tx, {
        workdir: ENVELOPE,
        homeWorkdir: ENVELOPE,
        agent: ENVELOPE,
        icon: ENVELOPE,
        labels: ENVELOPE,
        dedupeKey: BLIND_INDEX,
        head: BLIND_INDEX,
      });
      await schedule(tx, { workdir: ENVELOPE, agent: ENVELOPE, icon: ENVELOPE, labels: ENVELOPE });
      await tx.execute(sql`insert into task_pr (id, task_id, pr) values ('p1', 't1', ${ENVELOPE})`);
      await machine(tx, {
        dirs: ENVELOPE,
        dirsIndex: BLIND_INDEX,
        catalog: ENVELOPE,
        catalogIndex: BLIND_INDEX,
        usage: ENVELOPE,
        usageIndex: BLIND_INDEX,
      });
      await sharedAgents(tx, ENVELOPE);
      await linkRules(tx, ENVELOPE);
    });
    await clear();
    await as(async (tx) =>
      note(tx, { preview: ENVELOPE, suggestion: ENVELOPE, questions: ENVELOPE, answers: ENVELOPE }),
    );
    await clear();
    await as(async (tx) => note(tx, { author: 'server', kind: 'event', body: 'Marked done.' }));
    await clear();
    await as(async (tx) => event(tx, { output: ENVELOPE }));
  });
});
