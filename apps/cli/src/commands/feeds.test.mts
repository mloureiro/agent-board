import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { UsageError } from '../cli.mts';
import { CONFIG, fakeBackend, linkTo } from '../__tests__/helpers/fakes.mts';
import { tempDir } from '../__tests__/helpers/watch.mts';
import type { CommandResult, CommandSpec } from '../dispatch/waits.mts';
import { VALID_MANIFEST, makeMarketplace } from '../__tests__/helpers/marketplace.mts';
import { runBoard } from './program.mts';
import { createFeedStore } from '../feeds/store.mts';
import { createFeedUpdates } from '../feeds/updates.mts';
import { feedsAdd, feedsList, feedsRemove, feedsSetPaused } from './feeds.mts';
import type { FeedsDeps } from './feeds.mts';

const NOW = new Date('2026-11-21T12:00:00Z');
const GH = {
  integration: 'acme:github',
  action: 'list',
  every: '10m',
  dir: '/work',
  prompts: { new: 'n', update: 'u' },
};

const DESCRIBE = JSON.stringify({
  protocol: 1,
  actions: { list: { options: { type: 'object', properties: { q: { type: 'string' } } }, fields: ['url'] } },
});
const OK = { exitCode: 0, timedOut: false, output: '', stdout: '', stderr: '' };
const behaviour = { doctor: { ...OK } as typeof OK, check: { ...OK } as typeof OK };

function answer(spec: CommandSpec): CommandResult {
  const verb = spec.command.split(' ')[1];
  if (verb === 'describe') return { ...OK, stdout: DESCRIBE };
  if (verb === 'doctor') return behaviour.doctor;
  if (verb === 'check') return behaviour.check;
  return OK;
}

function setup(isAlive: (pid: number) => boolean = () => false) {
  const dir = tempDir('board-feeds-cmd-');
  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ machine: 'laptop', feeds: { gh: GH } }));
  const stateDir = join(dir, 'feeds');
  const store = createFeedStore(stateDir, isAlive);
  const printed: string[] = [];
  const deps: FeedsDeps = {
    configFile,
    dirs: undefined,
    unitRunning: true,
    now: () => NOW,
    print: (line) => printed.push(line),
    runDeps: () => ({
      backend: fakeBackend([]),
      machine: 'laptop',
      dirs: undefined,
      repos: {},
      store,
      updates: createFeedUpdates(join(stateDir, 'updates')),
      resolve: (ref) => (ref === 'acme:github' ? { program: '/p/run', commit: 'c' } : { problem: `no ${ref}` }),
      run: async (spec) => answer(spec),
      link: (id) => id,
      now: () => NOW,
      log: () => undefined,
    }),
  };
  return { dir, stateDir, store, printed, deps };
}

test('rm refuses while the lock is held and leaves the config and the state alone', () => {
  const { stateDir, store, deps } = setup(() => true);
  store.updateControl('gh', {});
  writeFileSync(join(stateDir, 'gh.lock'), '4000000');
  assert.throws(
    () => feedsRemove(deps, 'gh'),
    (error) => error instanceof UsageError && /is running/.test(error.message),
  );
  assert.match(readFileSync(deps.configFile, 'utf8'), /"gh"/);
  assert.equal(existsSync(join(stateDir, 'gh.control.json')), true);
});

test('rm removes the config entry, the control file, the record and the lock', () => {
  const { stateDir, store, deps } = setup();
  store.updateControl('gh', { paused: true });
  store.writeRecord('gh', { history: [], tasks: { a: 'T1' } });
  feedsRemove(deps, 'gh');
  assert.doesNotMatch(readFileSync(deps.configFile, 'utf8'), /"gh"/);
  for (const file of ['gh.json', 'gh.control.json', 'gh.lock']) assert.equal(existsSync(join(stateDir, file)), false);
});

test('rm checks the name before it touches a path', () => {
  const { deps } = setup();
  assert.throws(() => feedsRemove(deps, '../gh'), UsageError);
});

test('list shows a paused feed, one a run was asked of, and one waiting for its timer', () => {
  const { store, printed, deps } = setup();
  feedsSetPaused(deps, 'gh', true);
  feedsList(deps);
  assert.match(printed.findLast((line) => line.startsWith('gh ')) ?? '', /^gh {2}paused/);
  feedsSetPaused(deps, 'gh', false);
  store.updateControl('gh', { runRequestedAt: NOW.toISOString() });
  feedsList(deps);
  assert.match(printed.findLast((line) => line.startsWith('gh ')) ?? '', /^gh {2}runs next/);
  store.updateControl('gh', { runRequestedAt: new Date(0).toISOString() });
  store.writeRecord('gh', {
    last: {
      startedAt: NOW.toISOString(),
      at: NOW.toISOString(),
      ok: true,
      counts: { listed: 0, created: 0, requeued: 0, rescheduled: 0, closed: 0, failed: 0 },
    },
    history: [],
    tasks: {},
  });
  feedsList(deps);
  assert.match(printed.findLast((line) => line.startsWith('gh ')) ?? '', /^gh {2}active {2}/);
});

const VALID = { ...GH, options: { q: 'is:open' }, prompts: { new: 'review {url}', update: '{url} changed' } };

test('add writes a feed entry that validates, and replacing a name says so', async () => {
  const { deps, printed } = setup();
  behaviour.doctor = { ...OK, stdout: 'ready' };
  behaviour.check = { ...OK };
  await feedsAdd(deps, 'second', JSON.stringify(VALID));
  await feedsAdd(deps, 'second', JSON.stringify(VALID));
  const written = JSON.parse(readFileSync(deps.configFile, 'utf8')) as { feeds: Record<string, unknown> };
  assert.deepEqual(Object.keys(written.feeds), ['gh', 'second']);
  assert.deepEqual(written.feeds['second'], VALID);
  assert.deepEqual(printed, [
    'added feed second: acme:github · list every 10m in /work',
    'changed feed second: acme:github · list every 10m in /work',
  ]);
});

test('add refuses an entry that is not JSON, one that does not parse, an unlisted directory and one that fails validation, and writes nothing', async () => {
  const { deps, dir } = setup();
  const IN = { ...VALID, dir };
  behaviour.check = { ...OK };
  const before = readFileSync(deps.configFile, 'utf8');
  const listed = { ...deps, dirs: [{ path: dir }] };
  const failingCheck = { ...OK, exitCode: 1, stderr: 'q must not be empty\n' };
  const cases: [string, string, RegExp, typeof OK | undefined][] = [
    ['not JSON', '{', /not valid JSON/, undefined],
    ['a leftover command', JSON.stringify({ ...IN, command: 'x' }), /command is gone/, undefined],
    ['an unlisted directory', JSON.stringify({ ...IN, dir: '/elsewhere' }), /not a listed directory/, undefined],
    ['an unknown action', JSON.stringify({ ...IN, action: 'nope' }), /has no action nope/, undefined],
    ['options the schema refuses', JSON.stringify({ ...IN, options: { q: 5 } }), /q/, undefined],
    [
      'an unknown placeholder',
      JSON.stringify({ ...IN, prompts: { new: '{nope}', update: 'u' } }),
      /\{nope\}/,
      undefined,
    ],
    [
      'an integration that is not installed',
      JSON.stringify({ ...IN, integration: 'other:x' }),
      /no other:x/,
      undefined,
    ],
    ['a check that fails', JSON.stringify(IN), /check list exited 1: q must not be empty/, failingCheck],
  ];
  for (const [label, text, reason, check] of cases) {
    behaviour.check = check ?? { ...OK };
    await assert.rejects(
      () => feedsAdd(listed, 'gh2', text),
      (error) => error instanceof UsageError && reason.test(error.message),
      label,
    );
  }
  assert.equal(readFileSync(deps.configFile, 'utf8'), before);
});

test('add keeps the feed and warns when the doctor of the integration fails', async () => {
  const { deps, printed } = setup();
  behaviour.check = { ...OK };
  behaviour.doctor = { ...OK, exitCode: 1, stderr: 'gh is not logged in\n' };
  await feedsAdd(deps, 'second', JSON.stringify(VALID));
  assert.match(readFileSync(deps.configFile, 'utf8'), /"second"/);
  assert.equal(printed.length, 2);
  assert.equal(printed[1], 'warning: the feed is added; acme:github doctor exited 1: gh is not logged in');
  behaviour.doctor = { ...OK };
});

test('list shows the integration, action, directory, agent, lane and the task links of the last run', () => {
  const { store, printed, deps } = setup();
  writeFileSync(
    deps.configFile,
    JSON.stringify({
      machine: 'laptop',
      feeds: { gh: { ...GH, agent: 'reviewer', lane: 'slow' }, broken: { ...GH, every: 'x' } },
    }),
  );
  store.writeRecord('gh', {
    last: {
      startedAt: NOW.toISOString(),
      at: NOW.toISOString(),
      ok: true,
      counts: { listed: 2, created: 1, requeued: 1, rescheduled: 0, closed: 0, failed: 0 },
      tasks: [
        { id: 'T1', outcome: 'created' },
        { id: 'T2', outcome: 'requeued' },
      ],
    },
    history: [],
    tasks: {},
  });
  feedsList(deps);
  assert.equal(printed[0], 'gh  active  acme:github · list  every 10m  in /work  agent reviewer  lane slow');
  assert.match(printed[1] ?? '', /^ {2}ran .*: 2 listed, 1 created, 1 requeued, 0 closed$/);
  assert.deepEqual(printed.slice(2, 4), ['    created T1', '    requeued T2']);
  assert.match(printed[4] ?? '', /^broken {2}not read: (?!config:)/);
});

test('list prints an invalid last run as invalid with its reason', () => {
  const { store, printed, deps } = setup();
  store.writeRecord('gh', {
    last: {
      startedAt: NOW.toISOString(),
      at: NOW.toISOString(),
      ok: false,
      invalid: true,
      error: 'marketplace acme is not at its pinned commit',
      counts: { listed: 0, created: 0, requeued: 0, rescheduled: 0, closed: 0, failed: 0 },
    },
    history: [],
    tasks: {},
  });
  feedsList(deps);
  assert.match(printed[1] ?? '', /^ {2}invalid .*: marketplace acme is not at its pinned commit$/);
});

const PROGRAM = `#!/bin/sh
case "$1" in
  describe) cat <<'JSON'
${DESCRIBE}
JSON
  ;;
  doctor) echo "gh is logged in" ;;
  *) ;;
esac
`;

test('add reads the entry from stdin and validates it against an installed marketplace, through the whole command', async () => {
  const root = tempDir('board-feeds-e2e-');
  const source = join(root, 'source');
  makeMarketplace(source, VALID_MANIFEST, { 'feeds/github/run': { content: PROGRAM, mode: 0o755 } });
  const env = {
    AGENT_BOARD_STATE_DIR: join(root, 'state'),
    AGENT_BOARD_CONFIG_DIR: join(root, 'config'),
  };
  mkdirSync(env.AGENT_BOARD_CONFIG_DIR, { recursive: true });
  writeFileSync(join(env.AGENT_BOARD_CONFIG_DIR, 'config.json'), JSON.stringify({ machine: 'laptop' }));
  const written: string[] = [];
  const go = (argv: string[], stdin = '') =>
    runBoard(argv, {
      env,
      context: (dryRun) => ({
        config: CONFIG,
        backend: fakeBackend([]),
        dryRun,
        taskLink: linkTo,
        print: (line) => written.push(`${line}\n`),
      }),
      writeOut: (text) => written.push(text),
      writeErr: (text) => written.push(text),
      readStdin: async () => stdin,
    });
  await go(['plugins', 'install', source]);
  await go(['feeds', 'add', 'gh', '-'], JSON.stringify({ ...VALID, dir: root, integration: 'acme:github' }));
  assert.match(written.join(''), /added feed gh: acme:github · list every 10m/);
  assert.doesNotMatch(written.join(''), /warning/);
  const saved = JSON.parse(readFileSync(join(env.AGENT_BOARD_CONFIG_DIR, 'config.json'), 'utf8')) as {
    feeds: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(saved.feeds), ['gh']);
});

test('add names a file it cannot read instead of reporting an unexpected error', async () => {
  const root = tempDir('board-feeds-missing-');
  const configDir = join(root, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ machine: 'laptop' }));
  const missing = join(root, 'nope.json');
  await assert.rejects(
    runBoard(['feeds', 'add', 'gh', missing], {
      env: { AGENT_BOARD_STATE_DIR: join(root, 'state'), AGENT_BOARD_CONFIG_DIR: configDir },
      context: (dryRun) => ({
        config: CONFIG,
        backend: fakeBackend([]),
        dryRun,
        taskLink: linkTo,
        print: () => undefined,
      }),
      writeOut: () => undefined,
      writeErr: () => undefined,
    }),
    (error) => error instanceof UsageError && error.message === `cannot read ${missing} (ENOENT)`,
  );
});
