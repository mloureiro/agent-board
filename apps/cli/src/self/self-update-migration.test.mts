import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeGh } from '../__tests__/helpers/gh.mts';
import { fixture as migrationFixture } from '../__tests__/helpers/migration.mts';
import { ReportedFailure } from '../cli.mts';
import { listBackups } from '../migrate/backup.mts';
import { readJournal, writeJournal } from '../migrate/journal.mts';
import { lockPath } from '../migrate/lock.mts';
import { parsePlan, realPlanOf } from '../migrate/plan-output.mts';
import type { Plan } from '../migrate/plan-output.mts';
import { realGh, selfUpdate } from './self-update.mts';
import type { SelfUpdateDeps, UpdateMigration } from './self-update.mts';

const ASSET = 'board-linux-x64';
const STEPS: Plan = {
  from: '0.37.0',
  to: '0.4.0',
  steps: [
    { id: 'one', since: '0.4.0', title: 'Rewrite the units', kind: 'auto' },
    { id: 'two', since: '0.4.0', title: 'Move the feed folder', kind: 'person' },
  ],
};
const EMPTY: Plan = { from: '0.3.0', to: '0.4.0', steps: [] };

interface Options {
  plan?: Plan | (() => Promise<Plan>);
  migration?: Partial<UpdateMigration>;
  asset?: string;
}

function setup(options: Options = {}) {
  const gh = fakeGh([{ tag: 'cli-v0.4.0', assets: { [ASSET]: options.asset ?? 'new binary' } }]);
  const state = migrationFixture([]);
  const dir = mkdtempSync(join(tmpdir(), 'board-selfupdate-migration-'));
  const execPath = join(dir, 'board');
  writeFileSync(execPath, 'old binary', { mode: 0o755 });
  const calls = { planOf: [] as string[], confirm: 0, handOff: 0, restarts: 0, activeWorkers: 0 };
  const printed: string[] = [];
  const plan = options.plan ?? STEPS;
  const migration: UpdateMigration = {
    planOf: async (staged) => {
      calls.planOf.push(staged);
      return typeof plan === 'function' ? plan() : plan;
    },
    state: state.deps,
    interactive: true,
    confirm: async () => {
      calls.confirm += 1;
      return state.answers.shift() ?? false;
    },
    activeWorkers: async () => {
      calls.activeWorkers += 1;
      return 0;
    },
    context: 'command',
    handOff: async () => {
      calls.handOff += 1;
      return 0;
    },
    ...options.migration,
  };
  const deps: SelfUpdateDeps = {
    compiled: true,
    version: '0.3.0',
    execPath,
    platform: 'linux',
    arch: 'x64',
    gh: realGh(gh.env),
    restartListener: async () => {
      calls.restarts += 1;
      return undefined;
    },
    print: (line) => printed.push(line),
    migration,
  };
  const stateDir = state.deps.paths.stateDir;
  const clean = (): void => {
    rmSync(gh.dir, { recursive: true });
    rmSync(dir, { recursive: true });
    rmSync(state.dir, { recursive: true });
  };
  return { deps, dir, execPath, printed, calls, state, stateDir, clean };
}

const binary = (execPath: string): string => readFileSync(execPath, 'utf8');

test('an update whose plan is empty behaves as before: replaced, restarted, no backup', async () => {
  const f = setup({ plan: EMPTY });
  try {
    assert.equal(await selfUpdate(f.deps, {}), 'updated');
    assert.deepEqual(f.printed, ['updated board 0.3.0 -> 0.4.0']);
    assert.equal(binary(f.execPath), 'new binary');
    assert.deepEqual(readdirSync(f.dir), ['board']);
    assert.equal(f.calls.restarts, 1);
    assert.equal(f.calls.confirm + f.calls.handOff + f.calls.activeWorkers, 0);
    assert.equal(existsSync(join(f.stateDir, 'backups')), false);
    assert.equal(existsSync(join(f.stateDir, 'migration')), false);
    assert.equal(f.calls.planOf.length, 1);
  } finally {
    f.clean();
  }
});

test('a terminal with workers running refuses before any prompt and changes nothing', async () => {
  const f = setup({ migration: { activeWorkers: async () => 2 } });
  try {
    await assert.rejects(selfUpdate(f.deps, {}), ReportedFailure);
    assert.deepEqual(f.printed, ['2 worker(s) running; run board self-update again once they end']);
    assert.equal(f.calls.confirm, 0);
    assert.equal(binary(f.execPath), 'old binary');
    assert.deepEqual(readdirSync(f.dir), ['board']);
    assert.equal(existsSync(join(f.stateDir, 'backups')), false);
    assert.equal(readJournal(f.stateDir), undefined);
    assert.equal(f.calls.handOff + f.calls.restarts, 0);
  } finally {
    f.clean();
  }
});

test('declining the warning changes nothing', async () => {
  const f = setup();
  try {
    f.state.answers.push(false);
    assert.equal(await selfUpdate(f.deps, {}), 'unchanged');
    assert.deepEqual(f.printed, [
      'There are breaking changes, so a migration is needed.',
      '  Rewrite the units',
      '  Move the feed folder (needs you)',
      'nothing changed',
    ]);
    assert.equal(binary(f.execPath), 'old binary');
    assert.deepEqual(readdirSync(f.dir), ['board']);
    assert.equal(existsSync(join(f.stateDir, 'backups')), false);
    assert.equal(existsSync(lockPath(f.stateDir)), false);
    assert.equal(f.calls.handOff, 0);
  } finally {
    f.clean();
  }
});

test('accepting backs up the old binary and config, records the journal, replaces the binary and hands over once', async () => {
  const f = setup();
  try {
    f.state.answers.push(true);
    assert.equal(await selfUpdate(f.deps, {}), 'updated');
    assert.equal(binary(f.execPath), 'new binary');
    const [backup] = listBackups(f.stateDir);
    assert.equal(backup?.manifest.kind, 'update');
    assert.equal(backup?.manifest.from, '0.3.0');
    assert.equal(backup?.manifest.to, '0.4.0');
    assert.equal(backup?.manifest.cliApi, 9);
    assert.equal(readFileSync(join(backup?.dir ?? '', 'board'), 'utf8'), 'old binary');
    assert.ok(backup?.manifest.files.some((file) => file.path === 'config/web.json'));
    assert.ok(backup?.manifest.files.some((file) => file.path === 'config/env'));
    const journal = readJournal(f.stateDir);
    assert.deepEqual(journal?.steps, ['one', 'two']);
    assert.deepEqual(journal?.done, []);
    assert.equal(journal?.backup, backup?.name);
    assert.equal(journal?.from, '0.37.0');
    assert.equal(f.calls.handOff, 1);
    assert.equal(f.calls.restarts, 0);
    assert.equal(existsSync(lockPath(f.stateDir)), false);
    assert.deepEqual(readdirSync(f.dir), ['board']);
  } finally {
    f.clean();
  }
});

test('a command without a terminal goes ahead without asking, and the same effects follow', async () => {
  const f = setup({ migration: { interactive: false, activeWorkers: async () => 3 } });
  try {
    assert.equal(await selfUpdate(f.deps, {}), 'updated');
    assert.equal(f.calls.confirm, 0);
    assert.equal(f.calls.activeWorkers, 0);
    assert.equal(binary(f.execPath), 'new binary');
    assert.equal(listBackups(f.stateDir).length, 1);
    assert.equal(readJournal(f.stateDir)?.steps.length, 2);
    assert.equal(f.calls.handOff, 1);
  } finally {
    f.clean();
  }
});

test('a hand-over that fails makes the command fail with its exit code', async () => {
  const f = setup({ migration: { interactive: false, handOff: async () => 7 } });
  try {
    await assert.rejects(selfUpdate(f.deps, {}), (error) => error instanceof ReportedFailure && error.exitCode === 7);
    assert.equal(binary(f.execPath), 'new binary');
    assert.equal(readJournal(f.stateDir)?.steps.length, 2);
  } finally {
    f.clean();
  }
});

test('a tick restarts the listener without blocking, hands nothing over, leaves the journal for its next run and frees the lock', async () => {
  const f = setup({ migration: { interactive: false, context: 'tick' } });
  try {
    assert.equal(await selfUpdate(f.deps, {}), 'updated');
    assert.equal(f.calls.handOff, 0);
    assert.equal(f.calls.restarts, 1);
    assert.equal(binary(f.execPath), 'new binary');
    assert.equal(readJournal(f.stateDir)?.steps.length, 2);
    assert.equal(existsSync(lockPath(f.stateDir)), false);
  } finally {
    f.clean();
  }
});

test('a plan that cannot be read replaces nothing and leaves nothing behind', async () => {
  const f = setup({
    plan: async () => {
      throw new Error('the new binary could not tell its migration plan');
    },
  });
  try {
    await assert.rejects(selfUpdate(f.deps, {}), /could not tell its migration plan/);
    assert.equal(binary(f.execPath), 'old binary');
    assert.deepEqual(readdirSync(f.dir), ['board']);
    assert.equal(existsSync(join(f.stateDir, 'backups')), false);
  } finally {
    f.clean();
  }
});

test('a plan for another version than the release is refused', async () => {
  const f = setup({ plan: { ...EMPTY, to: '0.9.0' } });
  try {
    await assert.rejects(selfUpdate(f.deps, {}), /says it is 0\.9\.0, not 0\.4\.0/);
    assert.equal(binary(f.execPath), 'old binary');
    assert.deepEqual(readdirSync(f.dir), ['board']);
  } finally {
    f.clean();
  }
});

test('an unfinished migration is finished first', async () => {
  const f = setup();
  try {
    writeJournal(f.stateDir, {
      version: 1,
      from: '0.2.0',
      to: '0.3.0',
      steps: ['old'],
      done: [],
      backup: 'b',
      startedAt: '2026-11-24T10:00:00.000Z',
    });
    await assert.rejects(selfUpdate(f.deps, {}), /run "board self-update --resume" first/);
    assert.equal(binary(f.execPath), 'old binary');
    assert.deepEqual(readdirSync(f.dir), ['board']);
  } finally {
    f.clean();
  }
});

test('a staged binary that answers its plan on stdout is run, and its answer is shape-checked', async () => {
  const answer = JSON.stringify({
    from: '0.37.0',
    to: '0.4.0',
    steps: [{ id: 'one', since: '0.4.0', title: 'Rewrite the units', kind: 'auto' }],
  });
  const good = setup({ asset: `#!/bin/sh\ncat <<'EOF'\n${answer}\nEOF\n` });
  const bad = setup({
    asset: `#!/bin/sh\necho '{"from":"0.37.0","to":"0.4.0","steps":[{"id":"../x","since":"0.4.0","title":"t","kind":"auto"}]}'\n`,
  });
  const failing = setup({ asset: '#!/bin/sh\nexit 3\n' });
  try {
    for (const f of [good, bad, failing])
      f.deps.migration = { ...(f.deps.migration as UpdateMigration), planOf: realPlanOf(process.env) };
    (good.deps.migration as UpdateMigration).interactive = false;
    assert.equal(await selfUpdate(good.deps, {}), 'updated');
    assert.deepEqual(readJournal(good.stateDir)?.steps, ['one']);
    await assert.rejects(selfUpdate(bad.deps, {}), /did not answer its migration plan/);
    assert.equal(binary(bad.execPath), 'old binary');
    assert.deepEqual(readdirSync(bad.dir), ['board']);
    await assert.rejects(selfUpdate(failing.deps, {}), /could not tell its migration plan/);
    assert.equal(binary(failing.execPath), 'old binary');
    assert.deepEqual(readdirSync(failing.dir), ['board']);
  } finally {
    good.clean();
    bad.clean();
    failing.clean();
  }
});

test('a plan answer outside the expected shape is refused', () => {
  const step = { id: 'a-b', since: '0.4.0', title: 'Fine', kind: 'auto' };
  const plan = (patch: Record<string, unknown>): string =>
    JSON.stringify({ from: '0.3.0', to: '0.4.0', steps: [step], ...patch });
  assert.equal(parsePlan(plan({})).steps.length, 1);
  assert.equal(parsePlan(plan({ steps: [] })).steps.length, 0);
  const refused = [
    'nope',
    '[]',
    plan({ from: '0.3' }),
    plan({ to: 'x' }),
    plan({ steps: 'no' }),
    plan({ steps: [{ ...step, id: 'A B' }] }),
    plan({ steps: [{ ...step, since: '1.0' }] }),
    plan({ steps: [{ ...step, kind: 'root' }] }),
    plan({ steps: [{ ...step, title: '' }] }),
    plan({ steps: [{ ...step, title: 'x'.repeat(201) }] }),
    plan({ steps: [{ ...step, title: 'bell\u0007' }] }),
    plan({ steps: [step, step] }),
  ];
  for (const text of refused) assert.throws(() => parsePlan(text), /did not answer its migration plan/, text);
});

test('a journal that appears while the prompt waits is not overwritten and no backup is taken', async () => {
  const f = setup();
  try {
    f.deps.migration = {
      ...(f.deps.migration as UpdateMigration),
      confirm: async () => {
        writeJournal(f.stateDir, {
          version: 1,
          from: '0.37.0',
          to: '0.4.0',
          steps: ['other'],
          done: [],
          backup: 'someone-elses',
          startedAt: '2026-11-24T10:15:03.000Z',
        });
        return true;
      },
    };
    await assert.rejects(selfUpdate(f.deps, {}), /a migration is unfinished/);
    assert.equal(readJournal(f.stateDir)?.backup, 'someone-elses');
    assert.equal(binary(f.execPath), 'old binary');
    assert.equal(existsSync(join(f.stateDir, 'backups')), false);
    assert.equal(existsSync(lockPath(f.stateDir)), false);
  } finally {
    f.clean();
  }
});
