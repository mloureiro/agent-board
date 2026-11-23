import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeDataKey, machineCatalogIndex, machineDirsIndex } from '@agent-board/shared';
import { DATA_KEY, fakeCatalogStore, KEYS, OWNER, SERVER_API, SERVER_HAS } from '../__tests__/helpers/fakes.mts';
import { BackendError } from '../backend/backend.mts';
import { formatResult, hasFailure, runChecks } from './doctor.mts';
import type { CheckResult, DoctorDeps } from './doctor.mts';
import type { CommandResult, CommandSpec } from '../dispatch/waits.mts';
import { renderAgents } from './launchd.mts';
import { renderUnits } from './setup.mts';

const CONFIG_DIR = '/home/me/.config/agent-board';
const UNIT_DIR = '/home/me/.config/systemd/user';
const AGENTS_DIR = '/Users/me/Library/LaunchAgents';
const TOKEN = 'abm_secretsecretsecret';
const KEY_TEXT = encodeDataKey(DATA_KEY);

function machine(
  files: Record<string, { text: string; mode?: number }>,
  overrides: Partial<DoctorDeps> = {},
): DoctorDeps {
  const dirs = new Set([CONFIG_DIR, UNIT_DIR]);
  const present = new Set([...Object.keys(files), ...dirs]);
  return {
    configDir: CONFIG_DIR,
    unitDir: UNIT_DIR,
    nodeVersion: '24.1.0',
    readText: (path) => files[path]?.text,
    mode: (path) => (path in files ? (files[path]?.mode ?? 0o644) : undefined),
    exists: (path) => present.has(path),
    isDirectory: (path) => dirs.has(path),
    realpath: (path) => (dirs.has(path) ? path : undefined),
    which: (program) => `/usr/bin/${program}`,
    whichInUnits: (program) => `/usr/bin/${program}`,
    home: '/home/me',
    platform: 'linux',
    launchd: {
      agentsDir: AGENTS_DIR,
      uid: 501,
      runDir: '/home/me/.local/state/agent-board/run',
      loaded: async () => true,
      writable: () => true,
    },
    systemctl: async () => 0,
    verifyServer: async () => ({ owner: OWNER, keyId: KEYS.keyId, api: SERVER_API, features: SERVER_HAS }),
    catalogStore: fakeCatalogStore(),
    usageStore: { read: () => ({}) },
    now: () => new Date('2026-11-17T12:00:00Z'),
    runCommand: async () => ({ exitCode: 0, timedOut: false, output: '', stdout: '', stderr: '' }),
    plugins: {
      read: () => ({ registry: { marketplaces: {} } }),
      verify: () => undefined,
      resolve: () => ({ problem: 'no marketplace is installed' }),
    },
    ...overrides,
  };
}

const GOOD = {
  [`${CONFIG_DIR}/web.json`]: { text: '{"url": "https://board.example.com"}' },
  [`${CONFIG_DIR}/env`]: { text: `AGENT_BOARD_TOKEN=${TOKEN}\nAGENT_BOARD_DATA_KEY=${KEY_TEXT}\n`, mode: 0o100600 },
  [`${CONFIG_DIR}/config.json`]: { text: '{"machine": "box"}' },
};

const levels = (results: CheckResult[]): Record<string, string> =>
  Object.fromEntries(results.map((result) => [result.name, result.level]));

function unitFiles(command: string[]): Record<string, { text: string }> {
  return Object.fromEntries(
    renderUnits({ flock: '/usr/bin/flock', command: () => command }).map((unit) => [
      `${UNIT_DIR}/${unit.file}`,
      { text: unit.text },
    ]),
  );
}

test('a worker machine in order passes every check', async () => {
  const results = await runChecks(
    machine(
      { ...GOOD, ...unitFiles(['/usr/bin/node', '/opt/board/main.mts', 'internal', 'dispatch']) },
      {
        exists: (path) => !path.includes('intake'),
      },
    ),
  );
  assert.ok(
    results.every((result) => result.level === 'ok'),
    results
      .filter((r) => r.level !== 'ok')
      .map(formatResult)
      .join('\n'),
  );
  assert.equal(hasFailure(results), false);
});

test('a board-only machine has warnings, not failures, for config.json, tools and units', async () => {
  const { [`${CONFIG_DIR}/config.json`]: _config, ...boardOnly } = GOOD;
  const results = await runChecks(machine(boardOnly, { which: () => undefined, whichInUnits: () => undefined }));
  const found = levels(results);
  assert.equal(found['config.json'], 'warn');
  assert.equal(found['tool claude'], 'warn');
  assert.equal(found['units'], 'warn');
  assert.equal(hasFailure(results), false);
});

test('nothing set up fails with a hint for each missing piece', async () => {
  const results = await runChecks({ ...machine({}), isDirectory: () => false });
  const found = levels(results);
  assert.equal(found['config dir'], 'fail');
  assert.equal(found['web.json'], 'fail');
  assert.equal(found['env'], 'fail');
  assert.ok(results.filter((result) => result.level === 'fail').every((result) => result.hint?.includes('board init')));
  assert.equal(
    results.some((result) => result.name === 'server'),
    false,
    'no server check without credentials',
  );
});

test('the env file must be mode 600 or 400, and the token is never printed', async () => {
  const wide = await runChecks(
    machine({ ...GOOD, [`${CONFIG_DIR}/env`]: { text: `AGENT_BOARD_TOKEN=${TOKEN}`, mode: 0o100644 } }),
  );
  assert.equal(levels(wide)['env mode'], 'fail');
  assert.ok(wide.find((result) => result.name === 'env mode')?.hint?.startsWith('chmod 600'));
  const noToken = await runChecks(machine({ ...GOOD, [`${CONFIG_DIR}/env`]: { text: 'OTHER=1\n', mode: 0o100600 } }));
  assert.equal(levels(noToken)['token'], 'fail');
  const all = [...wide, ...(await runChecks(machine(GOOD)))].map(formatResult).join('\n');
  assert.ok(!all.includes(TOKEN));
});

test('the server check tells unreachable, unauthorised and a contract mismatch apart', async () => {
  const run = async (error: Error): Promise<CheckResult | undefined> =>
    (
      await runChecks(
        machine(GOOD, {
          verifyServer: async () => {
            throw error;
          },
        }),
      )
    ).find((result) => result.name === 'server');
  const unauthorised = await run(new BackendError('version: bad token', 401, true));
  assert.match(unauthorised?.message ?? '', /refused the token/);
  const serverOlder = await run(
    Object.assign(
      new BackendError('the board server is older than this CLI: it speaks API 4, the CLI needs 7 or newer'),
      {
        contractMismatch: 'server-older' as const,
      },
    ),
  );
  assert.match(serverOlder?.hint ?? '', /update the board server/);
  const cliOlder = await run(
    Object.assign(
      new BackendError('this CLI is older than the board server: it speaks API 7, the server serves clients from 8'),
      {
        contractMismatch: 'cli-older' as const,
      },
    ),
  );
  assert.match(cliOlder?.hint ?? '', /update this CLI: "board self-update"/);
  // Words the server wrote must not pick the hint.
  const quoted = await run(
    new BackendError(
      'get-task: error from the board server (HTTP 500): "this CLI is older than the board server"',
      500,
      true,
    ),
  );
  assert.match(quoted?.hint ?? '', /check the URL/);
  const unreachable = await run(new BackendError('cannot reach https://board.example.com: fetch failed'));
  assert.match(unreachable?.hint ?? '', /check the URL/);
  assert.equal(levels(await runChecks(machine(GOOD)))['server'], 'ok');
});

test('a config.json that does not parse is a failure, a missing Node 24 too', async () => {
  const broken = await runChecks(machine({ ...GOOD, [`${CONFIG_DIR}/config.json`]: { text: '{ nope' } }));
  assert.equal(levels(broken)['config.json'], 'fail');
  const old = await runChecks(machine(GOOD, { nodeVersion: '22.3.0' }));
  assert.equal(levels(old)['node'], 'fail');
  const bun = await runChecks(machine(GOOD, { nodeVersion: undefined }));
  assert.equal('node' in levels(bun), false);
});

test('an unknown key in config.json is a warning with the nearest known key; the machine line stays', async () => {
  const results = await runChecks(
    machine({ ...GOOD, [`${CONFIG_DIR}/config.json`]: { text: '{"machine": "box", "inactivityMinuts": 60}' } }),
  );
  const config = results.filter((result) => result.name === 'config.json');
  assert.deepEqual(
    config.map((result) => [result.level, result.message]),
    [
      ['ok', 'machine box'],
      ['warn', 'unknown key "inactivityMinuts", ignored; did you mean "inactivityMinutes"?'],
    ],
  );
  assert.equal(hasFailure(results), false);
});

test('a dirs setting over a different old path is a warning that says the setting counts', async () => {
  const text = '{"machine": "box", "defaultCwd": "/old", "dirs": {"/srv/a": {"default": true}}}';
  const results = await runChecks(machine({ ...GOOD, [`${CONFIG_DIR}/config.json`]: { text } }));
  const warned = results.filter((result) => result.name === 'config.json' && result.level === 'warn');
  assert.deepEqual(
    warned.map((result) => result.message),
    ['defaultCwd is overridden by dirs["/srv/a"].default'],
  );
  assert.match(warned[0]?.hint ?? '', /the directory setting is the one that counts/);
});

test('a lane that still has skills is a warning that says to set default instead, and the config still loads', async () => {
  const text =
    '{"machine": "box", "lanes": {"reviews": {"skills": ["review-pr"], "slots": 2}, "general": {"skills": ["*"]}}}';
  const results = await runChecks(machine({ ...GOOD, [`${CONFIG_DIR}/config.json`]: { text } }));
  const config = results.filter((result) => result.name === 'config.json');
  assert.deepEqual(
    config.map((result) => [result.level, result.message]),
    [
      ['ok', 'machine box'],
      [
        'warn',
        'lanes.reviews.skills is ignored: a task\'s lane is set with --lane, and the lane for every other task is the one marked "default": true',
      ],
      [
        'warn',
        'lanes.general.skills is ignored: a task\'s lane is set with --lane, and the lane for every other task is the one marked "default": true',
      ],
    ],
  );
  assert.match(config[1]?.hint ?? '', /set "default": true/);
  assert.equal(hasFailure(results), false);
});

test('on a system that is neither Linux nor macOS the worker checks are left out and one line says so', async () => {
  const results = await runChecks(
    machine(GOOD, { platform: 'freebsd', whichInUnits: () => undefined, exists: (path) => path in GOOD }),
  );
  const worker = results.filter((result) => /^(tool|unit|agent|worker)/.test(result.name));
  assert.deepEqual(
    worker.map((result) => [result.name, result.level]),
    [['worker', 'ok']],
  );
  assert.match(worker[0]?.message ?? '', /needs Linux with systemd or macOS, and this is freebsd/);
  assert.equal(hasFailure(results), false);
});

test('with units installed a missing tool or a vanished program fails; a disabled timer only warns', async () => {
  const units = unitFiles(['/usr/bin/node', '/opt/board/main.mts', 'internal', 'dispatch']);
  const present = new Set([
    ...Object.keys(GOOD),
    ...Object.keys(units),
    CONFIG_DIR,
    UNIT_DIR,
    '/usr/bin/flock',
    '/usr/bin/node',
  ]);
  const results = await runChecks(
    machine(
      { ...GOOD, ...units },
      {
        exists: (path) => present.has(path),
        which: (program) => (program === 'gh' ? undefined : `/usr/bin/${program}`),
        whichInUnits: (program) => (program === 'gh' ? undefined : `/usr/bin/${program}`),
        systemctl: async (args) => (args.includes('is-enabled') ? 1 : 0),
      },
    ),
  );
  const found = levels(results);
  assert.equal(found['tool gh'], 'fail');
  assert.equal(found['agent-board-dispatch.service command'], 'fail');
  assert.match(
    results.find((result) => result.name === 'agent-board-dispatch.service command')?.message ?? '',
    /\/opt\/board\/main\.mts/,
  );
  assert.equal(found['agent-board-dispatch.timer state'], 'warn');
  assert.ok(hasFailure(results));
});

test('a missing unit file of an installed pair is a failure', async () => {
  const units = unitFiles(['/usr/bin/node', '/opt/board/main.mts', 'internal', 'dispatch']);
  delete units[`${UNIT_DIR}/agent-board-dispatch.timer`];
  const results = await runChecks(machine({ ...GOOD, ...units }));
  const missing = results.find((result) => result.name === 'unit agent-board-dispatch.timer');
  assert.equal(missing?.level, 'fail');
});

test('the listener unit is checked like the timers, but a missing or stopped one only warns', async () => {
  const units = unitFiles(['/usr/bin/node', '/opt/board/main.mts', 'internal', 'dispatch']);
  const listen = `${UNIT_DIR}/agent-board-listen.service`;
  const listener = (results: CheckResult[]) => results.filter((result) => result.name.includes('agent-board-listen'));

  const missing = listener(await runChecks(machine({ ...GOOD, ...units }, { exists: (path) => path !== listen })));
  assert.deepEqual(levels(missing), { 'unit agent-board-listen.service': 'warn' });
  assert.match(missing[0]?.hint ?? '', /board setup/);

  const running = await runChecks(machine({ ...GOOD, ...units }, { exists: () => true }));
  assert.deepEqual(levels(listener(running)), {
    'unit agent-board-listen.service': 'ok',
    'agent-board-listen.service command': 'ok',
    'agent-board-listen.service state': 'ok',
  });

  const stopped = await runChecks(
    machine(
      { ...GOOD, ...units },
      { exists: () => true, systemctl: async (args) => (args.at(-1) === 'agent-board-listen.service' ? 1 : 0) },
    ),
  );
  assert.equal(levels(stopped)['agent-board-listen.service state'], 'warn');
  assert.equal(hasFailure(stopped), false);

  const vanished = await runChecks(machine({ ...GOOD, ...units }, { exists: (path) => path !== '/usr/bin/node' }));
  assert.equal(levels(vanished)['agent-board-listen.service command'], 'fail');
});

test('the watch unit is checked like the listener, and a missing or stopped one only warns', async () => {
  const units = unitFiles(['/usr/bin/node', '/opt/board/main.mts', 'internal', 'dispatch']);
  const watch = `${UNIT_DIR}/agent-board-watch.service`;
  const watcher = (results: CheckResult[]) => results.filter((result) => result.name.includes('agent-board-watch'));

  const missing = watcher(await runChecks(machine({ ...GOOD, ...units }, { exists: (path) => path !== watch })));
  assert.deepEqual(levels(missing), { 'unit agent-board-watch.service': 'warn' });
  assert.match(missing[0]?.hint ?? '', /board setup/);

  const running = await runChecks(machine({ ...GOOD, ...units }, { exists: () => true }));
  assert.deepEqual(levels(watcher(running)), {
    'unit agent-board-watch.service': 'ok',
    'agent-board-watch.service command': 'ok',
    'agent-board-watch.service state': 'ok',
  });

  const stopped = await runChecks(
    machine(
      { ...GOOD, ...units },
      { exists: () => true, systemctl: async (args) => (args.at(-1) === 'agent-board-watch.service' ? 1 : 0) },
    ),
  );
  assert.equal(levels(stopped)['agent-board-watch.service state'], 'warn');
  assert.equal(levels(stopped)['agent-board-listen.service state'], 'ok');
  assert.equal(hasFailure(stopped), false);

  const vanished = await runChecks(machine({ ...GOOD, ...units }, { exists: (path) => path !== '/usr/bin/node' }));
  assert.equal(levels(vanished)['agent-board-watch.service command'], 'fail');
});

test('a result prints as one line with its hint under it', () => {
  assert.equal(formatResult({ name: 'x', level: 'ok', message: 'fine' }), '✓ x: fine');
  assert.equal(formatResult({ name: 'x', level: 'fail', message: 'bad', hint: 'fix it' }), '✗ x: bad\n    → fix it');
  assert.equal(formatResult({ name: 'x', level: 'warn', message: 'hm' }), '! x: hm');
});

test('a 401 or 404 that is not the API answering (a login proxy) is not "refused" or "older"', async () => {
  const run = async (error: Error): Promise<CheckResult | undefined> =>
    (
      await runChecks(
        machine(GOOD, {
          verifyServer: async () => {
            throw error;
          },
        }),
      )
    ).find((result) => result.name === 'server');
  const proxy401 = await run(
    new BackendError('version: the server answered 401 without JSON (is /api/machine routed past the login?)', 401),
  );
  assert.doesNotMatch(proxy401?.message ?? '', /refused the token/);
  assert.match(proxy401?.message ?? '', /without JSON/);
  const proxy404 = await run(
    new BackendError('version: the server answered 404 without JSON (is /api/machine routed past the login?)', 404),
  );
  assert.match(proxy404?.message ?? '', /without JSON/);
  assert.match(proxy404?.hint ?? '', /check the URL/);
});

// The unit file of the checkout that shipped before `board setup` (apps/cli/systemd/agent-board-dispatch.service at 6e89da6^).
const OLD_UNIT = `[Unit]
Description=agent-board dispatcher: one tick

[Service]
Type=oneshot
# bin/_node finds Node; PATH is for flock, gh, claude and systemd-run.
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
# bin/dispatch takes the lock itself; exit 75 means another tick holds it, which is not a failure.
ExecStart=%h/workspace/agent-board/apps/cli/bin/dispatch
SuccessExitStatus=75
TimeoutStartSec=110
`;

test('an old-style unit whose %h path no longer exists fails, and passes while the checkout is there', async () => {
  const oldUnits = {
    [`${UNIT_DIR}/agent-board-dispatch.service`]: { text: OLD_UNIT },
    [`${UNIT_DIR}/agent-board-dispatch.timer`]: { text: '[Timer]\n' },
  };
  const gone = await runChecks(machine({ ...GOOD, ...oldUnits }));
  const failed = gone.find((result) => result.name === 'agent-board-dispatch.service command');
  assert.equal(failed?.level, 'fail');
  assert.match(failed?.message ?? '', /\/home\/me\/workspace\/agent-board\/apps\/cli\/bin\/dispatch no longer exists/);
  const present = new Set([
    ...Object.keys(GOOD),
    ...Object.keys(oldUnits),
    CONFIG_DIR,
    UNIT_DIR,
    '/home/me/workspace/agent-board/apps/cli/bin/dispatch',
  ]);
  const there = await runChecks(machine({ ...GOOD, ...oldUnits }, { exists: (path) => present.has(path) }));
  assert.equal(levels(there)['agent-board-dispatch.service command'], 'ok');
});

test('a tool on the shell PATH but not on the units PATH is a failure that says where it is', async () => {
  const units = unitFiles(['/usr/bin/node', '/opt/board/main.mts', 'internal', 'dispatch']);
  const results = await runChecks(
    machine(
      { ...GOOD, ...units },
      {
        which: (program) => (program === 'claude' ? '/home/me/.nvm/bin/claude' : `/usr/bin/${program}`),
        whichInUnits: (program) => (program === 'claude' ? undefined : `/usr/bin/${program}`),
      },
    ),
  );
  const claude = results.find((result) => result.name === 'tool claude');
  assert.equal(claude?.level, 'fail');
  assert.match(
    claude?.message ?? '',
    /\/home\/me\/\.nvm\/bin\/claude, on your shell's PATH but not on the units' \(\/home\/me\/\.local\/bin:/,
  );
  assert.match(claude?.hint ?? '', /ln -s \/home\/me\/\.nvm\/bin\/claude ~\/\.local\/bin\/claude/);
});

const envWith = (text: string) => ({ [`${CONFIG_DIR}/env`]: { text, mode: 0o100600 } });

test('the data key must be set and well-formed, and is never printed', async () => {
  const missing = await runChecks(machine({ ...GOOD, ...envWith(`AGENT_BOARD_TOKEN=${TOKEN}\n`) }));
  const missingKey = missing.find((result) => result.name === 'data key');
  assert.equal(missingKey?.level, 'fail');
  assert.match(missingKey?.hint ?? '', /Settings page.*board init/);
  assert.equal(
    missing.some((result) => result.name === 'board key'),
    false,
    'no key to compare',
  );
  const damaged = `${KEY_TEXT}-damaged`;
  const malformed = await runChecks(
    machine({ ...GOOD, ...envWith(`AGENT_BOARD_TOKEN=${TOKEN}\nAGENT_BOARD_DATA_KEY=${damaged}\n`) }),
  );
  assert.equal(malformed.find((result) => result.name === 'data key')?.level, 'fail');
  const printed = [...missing, ...malformed, ...(await runChecks(machine(GOOD)))].map(formatResult).join('\n');
  assert.ok(!printed.includes(KEY_TEXT) && !printed.includes(damaged));
});

test('the board has a key and this machine holds the same one, or the check fails with the way out', async () => {
  const ok = await runChecks(machine(GOOD));
  assert.equal(ok.find((result) => result.name === 'board key')?.level, 'ok');
  assert.match(ok.find((result) => result.name === 'board key')?.message ?? '', new RegExp(`id ${KEYS.keyId}`));

  const noKey = await runChecks(
    machine(GOOD, { verifyServer: async () => ({ owner: OWNER, keyId: null, api: SERVER_API, features: SERVER_HAS }) }),
  );
  const board = noKey.find((result) => result.name === 'board key');
  assert.equal(board?.level, 'fail');
  assert.match(board?.hint ?? '', /set up encryption in the browser first/);

  const other = '0123456789abcdef';
  const different = await runChecks(
    machine(GOOD, {
      verifyServer: async () => ({ owner: OWNER, keyId: other, api: SERVER_API, features: SERVER_HAS }),
    }),
  );
  const mismatch = different.find((result) => result.name === 'board key');
  assert.equal(mismatch?.level, 'fail');
  assert.match(
    mismatch?.message ?? '',
    new RegExp(`different data key \\(id ${KEYS.keyId}\\) than the board's \\(id ${other}\\)`),
  );
  assert.match(mismatch?.hint ?? '', /copy the current key from the board's Settings page/);
  assert.ok(!formatResult(mismatch as CheckResult).includes(KEY_TEXT));
  assert.ok(hasFailure(different));
});

test('a board with no key yet says so even when env has no key either, and the hints fit each case', async () => {
  const results = await runChecks(
    machine(
      { ...GOOD, ...envWith(`AGENT_BOARD_TOKEN=${TOKEN}\n`) },
      { verifyServer: async () => ({ owner: OWNER, keyId: null, api: SERVER_API, features: SERVER_HAS }) },
    ),
  );
  const board = results.find((result) => result.name === 'board key');
  assert.equal(board?.level, 'fail');
  assert.match(board?.hint ?? '', /set up encryption in the browser first/);
  assert.match(results.find((result) => result.name === 'data key')?.hint ?? '', /asks for the key only/);
  const noToken = await runChecks(machine({ ...GOOD, ...envWith(`AGENT_BOARD_DATA_KEY=${KEY_TEXT}\n`) }));
  assert.match(noToken.find((result) => result.name === 'token')?.hint ?? '', /asks for the token only/);
  const other = await runChecks(
    machine(GOOD, {
      verifyServer: async () => ({ owner: OWNER, keyId: '0123456789abcdef', api: SERVER_API, features: SERVER_HAS }),
    }),
  );
  assert.match(
    other.find((result) => result.name === 'board key')?.hint ?? '',
    /board init --force": it keeps the URL and the token/,
  );
});

const WORKER = ['/usr/bin/node', '/opt/board/main.mts', 'internal', 'dispatch'];

test('installed units of the removed intake warn that board setup deletes them, and are not checked as units', async () => {
  const files = { ...GOOD, ...unitFiles(WORKER) };
  const results = await runChecks(machine(files, { exists: () => true }));
  const found = results.find((result) => result.name === 'unit agent-board-intake');
  assert.equal(found?.level, 'warn');
  assert.match(found?.message ?? '', /agent-board-intake\.service and agent-board-intake\.timer are installed/);
  assert.match(found?.hint ?? '', /board setup/);
  assert.equal(hasFailure(results), false);
  assert.ok(
    results.every((result) => !result.name.includes('intake.timer') && !result.name.includes('intake.service')),
  );
  const clean = await runChecks(
    machine({ ...GOOD, ...unitFiles(WORKER) }, { exists: (path) => !path.includes('intake') }),
  );
  assert.ok(clean.every((result) => !result.name.includes('intake')));
});

test('an intake key in config.json fails the check and names the replacement, whatever it holds', async () => {
  for (const intake of [{}, { agent: 'reviewer' }, { prompt: 'no url' }, 3]) {
    const results = await runChecks(
      machine({ ...GOOD, [`${CONFIG_DIR}/config.json`]: { text: JSON.stringify({ machine: 'box', intake }) } }),
    );
    const failed = results.filter((result) => result.name === 'config.json' && result.level === 'fail');
    assert.equal(failed.length, 1, JSON.stringify(intake));
    assert.equal(
      failed[0]?.message,
      "the built-in intake was removed: run the github-reviews script (board example github-reviews.sh) with your own timer; move intake's lists to agents.<name>",
    );
    assert.match(failed[0]?.hint ?? '', /delete the intake key/);
    assert.ok(hasFailure(results));
  }
  const clean = await runChecks(machine({ ...GOOD }));
  assert.ok(!hasFailure(clean) || clean.every((result) => result.name !== 'config.json' || result.level === 'ok'));
});

test('doctor checks gh on a worker machine', async () => {
  const results = await runChecks(
    machine(
      { ...GOOD, ...unitFiles(WORKER) },
      {
        exists: (path) => !path.includes('intake'),
        whichInUnits: (program) => (program === 'gh' ? undefined : `/usr/bin/${program}`),
      },
    ),
  );
  assert.equal(levels(results)['tool gh'], 'fail');
});

const withConfig = (config: unknown): Record<string, { text: string; mode?: number }> => ({
  ...GOOD,
  [`${CONFIG_DIR}/config.json`]: { text: JSON.stringify(config) },
});

const dirsResults = (results: CheckResult[]): CheckResult[] => results.filter((result) => result.name === 'dirs');

test('a config without a dirs key reports it as not set, and nothing warns', async () => {
  const results = dirsResults(await runChecks(machine(GOOD)));
  assert.deepEqual(
    results.map((result) => [result.level, result.message]),
    [['ok', 'not set: workers are not limited to directories']],
  );
});

test('the dirs list is counted, and a listed directory that is gone or a route no entry covers fails', async () => {
  const files = withConfig({
    machine: 'box',
    defaultCwd: '/work/app/sub',
    lanes: { general: { default: true, cwd: '/work/lane' } },
    repos: { 'a/b': '/work/repo', 'a/c': '/work/appx' },
    dirs: { '/work/app': {}, '/work/gone': {} },
  });
  const present = new Set(['/work/app', '/work/app/sub', '/work/lane', '/work/repo', '/work/appx']);
  const results = dirsResults(
    await runChecks(
      machine(files, {
        isDirectory: (path) => present.has(path) || path === CONFIG_DIR || path === UNIT_DIR,
        realpath: (path) => (path === '/work/repo' ? '/data/repo' : present.has(path) ? path : undefined),
      }),
    ),
  );
  assert.equal(results[0]?.message, '2 listed');
  const problems = results.slice(1).map((result) => [result.level, result.message]);
  assert.deepEqual(problems, [
    ['warn', '/work/gone is listed but is not a directory'],
    ['fail', 'lane general cwd /work/lane is in no listed directory: tasks routed there stop in Needs me'],
    ['fail', 'repos a/b /work/repo is in no listed directory: tasks routed there stop in Needs me'],
    ['fail', 'repos a/c /work/appx is in no listed directory: tasks routed there stop in Needs me'],
  ]);
  assert.match(results[2]?.hint ?? '', /board dirs add '\/work\/lane'/);
  assert.match(results[3]?.hint ?? '', /board dirs add '\/data\/repo'/, 'the hint names the real path');
});

test('an empty dirs list is counted and fails for every route', async () => {
  const results = dirsResults(await runChecks(machine(withConfig({ machine: 'box', dirs: {} }))));
  assert.equal(results[0]?.message, '0 listed');
  assert.equal(results[1]?.level, 'fail');
  assert.match(results[1]?.message ?? '', /defaultCwd .* is in no listed directory/);
});

test('a listed symlink to a route covers it, and a route that is a symlink out of the list does not', async () => {
  const files = withConfig({
    machine: 'box',
    defaultCwd: '/work/app',
    repos: { 'a/b': '/work/app/link' },
    dirs: { '/work/app': {} },
  });
  const results = dirsResults(
    await runChecks(
      machine(files, {
        isDirectory: (path) => path.startsWith('/work') || path === CONFIG_DIR || path === UNIT_DIR,
        realpath: (path) => (path === '/work/app/link' ? '/elsewhere' : path),
      }),
    ),
  );
  assert.deepEqual(
    results.map((result) => result.level),
    ['ok', 'fail'],
  );
  assert.match(results[1]?.message ?? '', /repos a\/b \/work\/app\/link is in no listed directory/);
});

test('a config that does not parse leaves the dirs section to the config.json check', async () => {
  assert.deepEqual(dirsResults(await runChecks(machine(withConfig({ machine: 'box', dirs: 'x' })))), []);
});

const dirsOnBoard = (results: CheckResult[]): CheckResult[] =>
  results.filter((result) => result.name === 'dirs on board');

test('doctor says whether the board has the current directory list, comparing indexes and asking nothing more', async () => {
  const files = withConfig({ machine: 'box', dirs: { '/home/me/.config/agent-board': {}, '/work/gone': {} } });
  const index = await machineDirsIndex(KEYS, 'box', [{ path: '/home/me/.config/agent-board' }]);
  const serving = (dirsIndex?: string): Partial<DoctorDeps> => ({
    verifyServer: async () => ({
      owner: OWNER,
      keyId: KEYS.keyId,
      api: SERVER_API,
      features: SERVER_HAS,
      ...(dirsIndex === undefined ? {} : { dirsIndex }),
    }),
  });
  const current = dirsOnBoard(await runChecks(machine(files, serving(index))));
  assert.deepEqual(
    current.map(({ level, message }) => [level, message]),
    [['ok', 'the board has the current list']],
  );
  const behind = dirsOnBoard(await runChecks(machine(files, serving())));
  assert.deepEqual(
    behind.map(({ level }) => level),
    ['warn'],
  );
  assert.match(behind[0]?.hint ?? '', /next dispatch tick/);
  assert.deepEqual(dirsOnBoard(await runChecks(machine(GOOD, serving()))), [], 'no dirs key, nothing to compare');
  const lacking = machine(files, {
    verifyServer: async () => ({ owner: OWNER, keyId: KEYS.keyId, api: SERVER_API, features: new Set(['events']) }),
  });
  const results = await runChecks(lacking);
  assert.deepEqual(dirsOnBoard(results), []);
  assert.match(results.find(({ name }) => name === 'server features')?.message ?? '', /directory lists/);
});

const catalogOnBoard = (results: CheckResult[]): CheckResult[] =>
  results.filter((result) => result.name === 'catalog on board');

test('doctor says whether the board has the catalogue this machine probed, and nothing is probed yet on a fresh one', async () => {
  const files = withConfig({ machine: 'box', dirs: { '/home/me/.config/agent-board': {} } });
  const result = {
    claude: '2.1.326',
    models: [{ value: 'opus', label: 'Opus' }],
    commands: [{ name: 'review', builtin: false }],
  };
  // With the agents part the dispatcher sends: none applied and none defined here.
  const catalog = {
    claude: '2.1.326',
    models: result.models,
    skills: [{ name: 'review' }],
    dirs: {},
    agents: { version: null, hashes: {}, replaced: [] },
  };
  const serving = (catalogIndex?: string): Partial<DoctorDeps> => ({
    verifyServer: async () => ({
      owner: OWNER,
      keyId: KEYS.keyId,
      api: SERVER_API,
      features: SERVER_HAS,
      ...(catalogIndex === undefined ? {} : { catalogIndex }),
    }),
  });
  const fresh = catalogOnBoard(await runChecks(machine(files, serving())));
  assert.deepEqual(
    fresh.map(({ level }) => level),
    ['ok'],
  );
  assert.match(fresh[0]?.message ?? '', /nothing probed yet/);
  const catalogStore = fakeCatalogStore();
  catalogStore.write({
    path: '/home/me/.config/agent-board',
    fingerprint: 'fp',
    probedAt: '2026-11-17T10:00:00.000Z',
    probedForInit: null,
    result,
  });
  const current = catalogOnBoard(
    await runChecks(machine(files, { ...serving(await machineCatalogIndex(KEYS, 'box', catalog)), catalogStore })),
  );
  assert.deepEqual(
    current.map(({ level, message }) => [level, message]),
    [['ok', 'the board has the current catalogue (1 skills, 1 models)']],
  );
  const behind = catalogOnBoard(await runChecks(machine(files, { ...serving(), catalogStore })));
  assert.deepEqual(
    behind.map(({ level }) => level),
    ['warn'],
  );
  assert.match(behind[0]?.message ?? '', /does not have the current catalogue yet \(1 skills, 1 models\)/);
  assert.match(behind[0]?.hint ?? '', /next dispatch tick/);
  const lacking = machine(files, {
    catalogStore,
    verifyServer: async () => ({ owner: OWNER, keyId: KEYS.keyId, api: SERVER_API, features: new Set(['events']) }),
  });
  const results = await runChecks(lacking);
  assert.deepEqual(catalogOnBoard(results), []);
  assert.match(results.find(({ name }) => name === 'server features')?.message ?? '', /machine catalogues/);
});

const PLUGINS = '/home/me/.claude/plugins';
const agentsConfig = (agents: unknown, plugins?: unknown) => ({
  ...GOOD,
  [`${CONFIG_DIR}/config.json`]: { text: JSON.stringify({ machine: 'box', agents }) },
  ...(plugins === undefined ? {} : { [`${PLUGINS}/installed_plugins.json`]: { text: JSON.stringify(plugins) } }),
});
const agent = (override: Record<string, unknown> = {}) => ({
  description: 'Reviews.',
  tools: ['Read', 'Bash'],
  allowedTools: ['Read', 'Bash(gh pr view *)'],
  ...override,
});
const agentResults = async (files: ReturnType<typeof agentsConfig>) =>
  (await runChecks(machine(files))).filter((result) => result.name === 'agents' || result.name.startsWith('agent '));

test('doctor lists the agents of a config that resolves and finds nothing to say about them', async () => {
  const results = await agentResults(agentsConfig({ reviewer: agent(), 'other-1': agent() }));
  assert.deepEqual(
    results.map((result) => [result.name, result.level, result.message]),
    [['agents', 'ok', 'reviewer, other-1']],
  );
});

test('an agent that cannot be read is a failure naming it and its key, and the rest of config.json still loads', async () => {
  const results = await runChecks(
    machine(agentsConfig({ reviewer: agent({ disallowedTool: ['Bash(rm *)'] }), ok1: agent() })),
  );
  const broken = results.find((result) => result.name === 'agent reviewer');
  assert.equal(broken?.level, 'fail');
  assert.match(broken?.message ?? '', /agents\.reviewer has no key "disallowedTool"; did you mean "disallowedTools"\?/);
  assert.equal(results.find((result) => result.name === 'config.json')?.level, 'ok');
  assert.equal(results.find((result) => result.name === 'agents')?.message, 'ok1');
  assert.equal(hasFailure(results), true);
});

test('an allow rule for a tool the agent does not have is a warning naming the tool', async () => {
  const results = await agentResults(
    agentsConfig({
      reviewer: agent({
        tools: ['Read'],
        allowedTools: ['Read', 'Bash(gh pr view *)', 'Edit(//tmp/x)', 'mcp__shortcut__get_story'],
      }),
    }),
  );
  const warning = results.find((result) => result.level === 'warn');
  assert.equal(warning?.name, 'agent reviewer');
  assert.match(warning?.message ?? '', /allowedTools has rules for Bash, Edit, which tools leaves out/);
  assert.equal(warning?.hint, 'add them to agents.reviewer.tools');
  assert.equal(hasFailure(results), false);
});

test("an agent's plugin placeholder that does not resolve is a warning: unreadable list, not installed, several marketplaces", async () => {
  const withPlugin = { reviewer: agent({ allowedTools: ['Bash({pr-review}/x.sh *)'] }) };
  const warn = async (plugins?: unknown) =>
    (await agentResults(agentsConfig(withPlugin, plugins))).filter((result) => result.level === 'warn');
  assert.deepEqual(await warn({ plugins: { 'pr-review@ccc': [{ installPath: '/p' }] } }), []);
  assert.match(
    (await warn())[0]?.message ?? '',
    /\{pr-review\}.*cannot read .*installed_plugins\.json.*a run as reviewer fails/,
  );
  assert.match((await warn({ plugins: {} }))[0]?.message ?? '', /plugin pr-review is not installed/);
  assert.match(
    (await warn({ plugins: { 'pr-review@a': [{ installPath: '/a' }], 'pr-review@b': [{ installPath: '/b' }] } }))[0]
      ?.message ?? '',
    /several marketplaces \(pr-review@a, pr-review@b\)/,
  );
  const named = { reviewer: agent({ allowedTools: ['Bash({pr-review@b}/x.sh *)'] }) };
  const files = agentsConfig(named, {
    plugins: { 'pr-review@a': [{ installPath: '/a' }], 'pr-review@b': [{ installPath: '/b' }] },
  });
  assert.deepEqual(
    (await agentResults(files)).filter((result) => result.level === 'warn'),
    [],
  );
});

const MAC_HOME = '/Users/me';
const MAC_CONFIG = `${MAC_HOME}/.config/agent-board`;
const RUN_DIR = `${MAC_HOME}/.local/state/agent-board/run`;
const DISPATCH_PLIST = 'de.codeplant.agent-board.dispatch.plist';
const LISTEN_PLIST = 'de.codeplant.agent-board.listen.plist';
const WATCH_PLIST = 'de.codeplant.agent-board.watch.plist';

function agentFiles(): Record<string, { text: string }> {
  return Object.fromEntries(
    renderAgents({
      home: MAC_HOME,
      lockf: '/usr/bin/lockf',
      lockDir: RUN_DIR,
      logDir: `${MAC_HOME}/.local/state/agent-board/logs`,
      command: (name) => ['/usr/local/bin/board', 'internal', name],
    }).map((agent) => [`${AGENTS_DIR}/${agent.file}`, { text: agent.text }]),
  );
}

const macLaunchd = (overrides: Partial<DoctorDeps['launchd']> = {}): DoctorDeps['launchd'] => ({
  agentsDir: AGENTS_DIR,
  uid: 501,
  runDir: RUN_DIR,
  loaded: async () => true,
  writable: () => true,
  ...overrides,
});

// A macOS machine with web.json, env and a config.json in its home, and the programs of the agents.
function mac(
  agents: Record<string, { text: string }>,
  config: object = { machine: 'mac' },
  overrides: Partial<DoctorDeps> = {},
): DoctorDeps {
  const files: Record<string, { text: string; mode?: number }> = {
    [`${MAC_CONFIG}/web.json`]: GOOD[`${CONFIG_DIR}/web.json`],
    [`${MAC_CONFIG}/env`]: GOOD[`${CONFIG_DIR}/env`],
    [`${MAC_CONFIG}/config.json`]: { text: JSON.stringify(config) },
    ...agents,
  };
  const present = new Set([...Object.keys(files), MAC_CONFIG, '/usr/local/bin/board', '/usr/bin/lockf']);
  return machine(files, {
    platform: 'darwin',
    home: MAC_HOME,
    configDir: MAC_CONFIG,
    launchd: macLaunchd(),
    exists: (path) => present.has(path),
    isDirectory: (path) => path === MAC_CONFIG,
    ...overrides,
  });
}

const macChecks = (results: CheckResult[]): CheckResult[] =>
  results.filter((result) => /^(tool|launchd|de\.|run directory|folders)|plist/.test(result.name));

test('a macOS worker machine in order passes every check', async () => {
  const worker = macChecks(await runChecks(mac(agentFiles())));
  assert.deepEqual(
    worker.map((result) => result.name),
    [
      'tool claude',
      'tool gh',
      'tool lockf',
      'run directory',
      `launchd ${DISPATCH_PLIST}`,
      `${DISPATCH_PLIST} command`,
      'de.codeplant.agent-board.dispatch state',
      `launchd ${LISTEN_PLIST}`,
      `${LISTEN_PLIST} command`,
      'de.codeplant.agent-board.listen state',
      `launchd ${WATCH_PLIST}`,
      `${WATCH_PLIST} command`,
      'de.codeplant.agent-board.watch state',
    ],
  );
  assert.ok(
    worker.every((result) => result.level === 'ok'),
    worker.map(formatResult).join('\n'),
  );
});

test('a macOS machine with no agent warns, and with one installed a missing tool or agent fails', async () => {
  const none = levels(await runChecks(mac({}, undefined, { whichInUnits: () => undefined, which: () => undefined })));
  assert.equal(none['tool lockf'], 'warn');
  assert.equal(none['launchd agents'], 'warn');
  const [dispatch] = Object.entries(agentFiles());
  const listenerMissing = levels(
    await runChecks(
      mac(Object.fromEntries(dispatch ? [dispatch] : []), undefined, {
        whichInUnits: (tool) => (tool === 'gh' ? undefined : `/usr/bin/${tool}`),
      }),
    ),
  );
  assert.equal(listenerMissing['tool gh'], 'fail');
  assert.equal(listenerMissing[`launchd ${LISTEN_PLIST}`], 'warn', 'the listener only adds speed to the timer');
  assert.equal(listenerMissing[`launchd ${WATCH_PLIST}`], 'warn', 'the tick polls the watches without the watch agent');
});

test('a macOS agent whose program is gone fails', async () => {
  const base = mac(agentFiles());
  const results = await runChecks({ ...base, exists: (path) => path !== '/usr/local/bin/board' && base.exists(path) });
  assert.equal(levels(results)[`${DISPATCH_PLIST} command`], 'fail');
  assert.equal(levels(results)[`${LISTEN_PLIST} command`], 'fail');
  assert.equal(levels(results)[`${WATCH_PLIST} command`], 'fail');
});

test('a macOS agent that launchd has not loaded warns with the bootstrap line; an unwritable run directory fails', async () => {
  const results = await runChecks(
    mac(agentFiles(), undefined, {
      launchd: macLaunchd({ loaded: async (name) => name === 'listen', writable: () => false }),
    }),
  );
  const state = results.find((result) => result.name === 'de.codeplant.agent-board.dispatch state');
  assert.equal(state?.level, 'warn');
  assert.equal(state?.hint, `launchctl bootstrap gui/501 '${AGENTS_DIR}/${DISPATCH_PLIST}'`);
  assert.equal(levels(results)['de.codeplant.agent-board.listen state'], 'ok');
  assert.equal(levels(results)['run directory'], 'fail');
});

test('on macOS checkouts under the protected folders are warned about', async () => {
  const config = {
    machine: 'mac',
    defaultCwd: `${MAC_HOME}/code`,
    dirs: { [`${MAC_HOME}/Documents/work`]: {}, [`${MAC_HOME}/Library/Mobile Documents/x`]: {} },
    repos: { 'acme/app': `${MAC_HOME}/Downloads/app` },
    lanes: { desk: { default: true, slots: 1, cwd: `${MAC_HOME}/Desktop` } },
  };
  const results = await runChecks(mac(agentFiles(), config));
  const folders = results.filter((result) => result.name === 'folders');
  assert.equal(folders.length, 4, folders.map(formatResult).join('\n'));
  assert.ok(folders.every((result) => result.level === 'warn'));
  const fine = await runChecks(mac(agentFiles()));
  assert.equal(
    fine.some((result) => result.name === 'folders'),
    false,
  );
});

const usageResults = (results: CheckResult[]): CheckResult[] =>
  results.filter((result) => result.name === 'usage limits');

test('doctor says nothing about usage limits unless the config sets them', async () => {
  assert.deepEqual(usageResults(await runChecks(machine(GOOD))), []);
});

test('doctor shows the thresholds, that no run has reported usage yet, and that nothing is held', async () => {
  const files = withConfig({ machine: 'box', usageLimits: { fiveHour: 80 } });
  const [result, ...rest] = usageResults(await runChecks(machine(files)));
  assert.deepEqual(rest, []);
  assert.equal(result?.level, 'ok');
  assert.equal(
    result?.message,
    '5-hour limit 80%, no reading yet (the first run here reports one); tasks below urgent are not held now',
  );
});

test('doctor shows the last reading with its time, and what is held until when', async () => {
  const files = withConfig({ machine: 'box', usageLimits: { fiveHour: 80, sevenDay: 90, priority: 'high' } });
  const results = usageResults(
    await runChecks(
      machine(files, {
        usageStore: {
          read: () => ({
            fiveHour: { utilization: 0.85, resetsAt: '2026-11-17T15:00:00.000Z', seenAt: '2026-11-17T11:30:00.000Z' },
            sevenDay: { utilization: 0.95, resetsAt: '2026-11-17T09:00:00.000Z', seenAt: '2026-11-16T20:00:00.000Z' },
          }),
        },
      }),
    ),
  );
  assert.equal(
    results[0]?.message,
    '5-hour limit 80%, last reading 85% seen 2026-11-17T11:30:00.000Z; ' +
      '7-day limit 90%, last reading 95% seen 2026-11-16T20:00:00.000Z, window since reset, so void; ' +
      'tasks below high are held now until 2026-11-17T15:00:00.000Z ' +
      '(5-hour usage 85% (limit 80%, resets 2026-11-17T15:00:00.000Z))',
  );
});

test('doctor warns, and does not fail, when this machine applied an older version of the board’s agents than the board holds', async () => {
  const files = withConfig({ machine: 'box' });
  const serving = (agentsVersion?: number): Partial<DoctorDeps> => ({
    verifyServer: async () => ({
      owner: OWNER,
      keyId: KEYS.keyId,
      api: SERVER_API,
      features: SERVER_HAS,
      ...(agentsVersion === undefined ? {} : { agentsVersion }),
    }),
  });
  const boardAgents = (results: CheckResult[]) => results.filter((result) => result.name === "board's agents");
  assert.deepEqual(boardAgents(await runChecks(machine(files, serving()))), []);
  const behind = boardAgents(await runChecks(machine(files, serving(3))));
  assert.deepEqual(
    behind.map(({ level, message }) => [level, message]),
    [['warn', 'the board holds agents v3, this machine applied none']],
  );
});

const COMMIT = 'a'.repeat(40);
const FEED_ENTRY = {
  integration: 'acme:github',
  action: 'list',
  every: '10m',
  dir: '/work',
  prompts: { new: 'review {url}', update: '{url} changed' },
};
const DESCRIBE = JSON.stringify({ protocol: 1, actions: { list: { options: { type: 'object' }, fields: ['url'] } } });
const done = (extra: Partial<CommandResult> = {}): CommandResult => ({
  exitCode: 0,
  timedOut: false,
  output: '',
  stdout: '',
  stderr: '',
  ...extra,
});

function withPlugins(options: {
  feeds?: Record<string, unknown>;
  pin?: string;
  doctor?: Partial<CommandResult>;
  git?: string | undefined;
  calls?: CommandSpec[];
  platform?: string;
}): DoctorDeps {
  const files = withConfig({ machine: 'box', ...(options.feeds === undefined ? {} : { feeds: options.feeds }) });
  return machine(files, {
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    whichInUnits: (program) => (program === 'git' && 'git' in options ? options.git : `/usr/bin/${program}`),
    plugins: {
      read: () => ({
        registry: {
          marketplaces: { acme: { url: 'u', commit: COMMIT, installedAt: 't', updatedAt: 't' } },
        },
      }),
      verify: (name) => (options.pin === undefined ? undefined : `marketplace ${name} ${options.pin}`),
      resolve: (ref) => (ref === 'acme:github' ? { program: '/p/run', commit: COMMIT } : { problem: `no ${ref}` }),
    },
    runCommand: async (spec) => {
      options.calls?.push(spec);
      const verb = spec.command.split(' ')[1];
      if (verb === 'describe') return done({ stdout: DESCRIBE });
      if (verb === 'doctor') return done(options.doctor ?? { stdout: 'gh is logged in\n' });
      return done();
    },
  });
}

const named = (results: CheckResult[], pattern: RegExp): [string, string, string][] =>
  results.filter((result) => pattern.test(result.name)).map(({ name, level, message }) => [name, level, message]);

test('plugin, feed and integration checks over a pin that holds or moved, a feed valid or not, and an integration doctor that passes or fails', async () => {
  const feeds = { gh: FEED_ENTRY };
  const cases: [string, Parameters<typeof withPlugins>[0], [string, string, string][]][] = [
    [
      'everything in order',
      { feeds },
      [
        ['plugins.acme', 'ok', `acme at ${COMMIT.slice(0, 12)}`],
        ['feeds.gh', 'ok', 'acme:github · list'],
        ['integrations.acme:github', 'ok', 'gh is logged in'],
      ],
    ],
    [
      'the pin moved',
      { feeds, pin: 'is not at its pinned commit' },
      [
        ['plugins.acme', 'fail', 'marketplace acme is not at its pinned commit'],
        ['feeds.gh', 'ok', 'acme:github · list'],
        ['integrations.acme:github', 'ok', 'gh is logged in'],
      ],
    ],
    [
      'a feed that does not validate',
      { feeds: { gh: { ...FEED_ENTRY, action: 'nope' } } },
      [
        ['plugins.acme', 'ok', `acme at ${COMMIT.slice(0, 12)}`],
        ['feeds.gh', 'fail', 'acme:github has no action nope (it has: list)'],
      ],
    ],
    [
      'a feed the config cannot read',
      { feeds: { gh: { ...FEED_ENTRY, every: 'often' } } },
      [
        ['plugins.acme', 'ok', `acme at ${COMMIT.slice(0, 12)}`],
        ['feeds.gh', 'fail', 'feeds.gh.every'],
      ],
    ],
    [
      'an integration doctor that fails',
      { feeds, doctor: { exitCode: 1, stderr: 'gh is not logged in\n' } },
      [
        ['plugins.acme', 'ok', `acme at ${COMMIT.slice(0, 12)}`],
        ['feeds.gh', 'ok', 'acme:github · list'],
        ['integrations.acme:github', 'fail', 'doctor exited 1: gh is not logged in'],
      ],
    ],
    [
      'an integration doctor with no summary',
      { feeds, doctor: { stdout: '' } },
      [
        ['plugins.acme', 'ok', `acme at ${COMMIT.slice(0, 12)}`],
        ['feeds.gh', 'ok', 'acme:github · list'],
        ['integrations.acme:github', 'ok', 'ready'],
      ],
    ],
    [
      'git missing on the units PATH',
      { git: undefined },
      [
        ['plugins.acme', 'ok', `acme at ${COMMIT.slice(0, 12)}`],
        ['git', 'warn', "git is not on the units' PATH (/home/me/.local/bin:/usr/local/bin:/usr/bin:/bin)"],
      ],
    ],
  ];
  for (const [label, options, expected] of cases) {
    const results = await runChecks(withPlugins(options));
    const got = named(results, /^(plugins|git$|feeds|integrations)/);
    assert.equal(got.length, expected.length, label);
    for (const [index, [name, level, message]] of expected.entries()) {
      const actual = got[index];
      assert.deepEqual([actual?.[0], actual?.[1]], [name, level], label);
      assert.ok(actual?.[2].includes(message), `${label}: ${actual?.[2]} should include ${message}`);
    }
  }
});

test('the integration doctor runs once per integration, under the PATH the units run with', async () => {
  const calls: CommandSpec[] = [];
  const feeds = { one: FEED_ENTRY, two: { ...FEED_ENTRY, dir: '/work/two' } };
  await runChecks(withPlugins({ feeds, calls }));
  const doctors = calls.filter((spec) => spec.command.split(' ')[1] === 'doctor');
  assert.equal(doctors.length, 1);
  assert.equal(doctors[0]?.path, '/home/me/.local/bin:/usr/local/bin:/usr/bin:/bin');
  assert.equal(
    calls.filter((spec) => spec.command.split(' ')[1] === 'describe').every((spec) => spec.path === undefined),
    true,
  );
  const mac = await (async () => {
    const macCalls: CommandSpec[] = [];
    await runChecks(withPlugins({ feeds, calls: macCalls, platform: 'darwin' }));
    return macCalls.find((spec) => spec.command.split(' ')[1] === 'doctor');
  })();
  assert.match(mac?.path ?? '', /\/opt\/homebrew\/bin/);
  assert.notEqual(mac?.path, doctors[0]?.path);
});

test('a machine with no marketplace and no feed adds no plugin check', async () => {
  const results = await runChecks(machine(withConfig({ machine: 'box' })));
  assert.deepEqual(named(results, /^(plugins|git$|feeds|integrations)/), []);
});

test('doctor warns when config.json holds more feeds than the board shows', async () => {
  const feeds = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`f${i}`, FEED_ENTRY]));
  const results = await runChecks(withPlugins({ feeds }));
  const warning = results.find((result) => result.name === 'feeds');
  assert.equal(warning?.level, 'warn');
  assert.match(warning?.message ?? '', /31 feeds; .*at most 30/);
});
