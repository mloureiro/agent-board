import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareVersions } from '@agent-board/shared';
import {
  assetName,
  checksumOf,
  newestRelease,
  realGh,
  realListenerRestart,
  sweepStaleStagedBinaries,
  sweepStaleUpdateDirs,
  selfUpdate,
} from './self-update.mts';
import type { SelfUpdateDeps } from './self-update.mts';
import { fakeGh, sha256 } from '../__tests__/helpers/gh.mts';
import type { FakeRelease } from '../__tests__/helpers/gh.mts';
import { runBoard } from '../commands/program.mts';

const ASSET = 'board-linux-x64';

function fixture(releases: FakeRelease[], overrides: Partial<SelfUpdateDeps> = {}) {
  const gh = fakeGh(releases);
  const dir = mkdtempSync(join(tmpdir(), 'board-selfupdate-test-'));
  const execPath = join(dir, 'board');
  writeFileSync(execPath, 'old binary', { mode: 0o755 });
  const printed: string[] = [];
  const restarts: string[] = [];
  const deps: SelfUpdateDeps = {
    compiled: true,
    version: '0.3.0',
    execPath,
    platform: 'linux',
    arch: 'x64',
    gh: realGh(gh.env),
    restartListener: async () => {
      restarts.push('restart');
      return undefined;
    },
    print: (line) => printed.push(line),
    ...overrides,
  };
  const clean = (): void => {
    rmSync(gh.dir, { recursive: true });
    rmSync(dir, { recursive: true });
  };
  return { gh, dir, execPath, printed, restarts, deps, clean };
}

test('versions compare numerically, and the newest published cli release wins', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.3.0', '0.3.1'), -1);
  const listing = JSON.stringify([
    { tagName: 'cli-v0.9.0', isDraft: false, isPrerelease: false },
    { tagName: 'cli-v0.10.0', isDraft: false, isPrerelease: false },
    { tagName: 'cli-v0.11.0', isDraft: true, isPrerelease: false },
    { tagName: 'cli-v0.12.0-rc1', isDraft: false, isPrerelease: true },
    { tagName: 'cli-v0.13.0-rc.1', isDraft: false, isPrerelease: false },
    { tagName: 'cli-v1.0', isDraft: false, isPrerelease: false },
    { tagName: 'server-v9.0.0', isDraft: false, isPrerelease: false },
  ]);
  assert.deepEqual(newestRelease(listing), { tag: 'cli-v0.10.0', version: '0.10.0' });
  assert.equal(newestRelease('[]'), undefined);
  assert.throws(() => newestRelease('nope'), /did not return JSON/);
  assert.equal(assetName('linux', 'arm64'), 'board-linux-arm64');
  assert.equal(assetName('darwin', 'arm64'), 'board-darwin-arm64');
  assert.throws(() => assetName('win32', 'x64'), /no released binary/);
  assert.throws(() => assetName('darwin', 'x64'), /no released binary for darwin-x64/);
  assert.equal(
    checksumOf(`${'a'.repeat(64)}  board-linux-x64\n${'b'.repeat(64)} *board-darwin-arm64\n`, 'board-darwin-arm64'),
    'b'.repeat(64),
  );
});

test('in a checkout it says to pull, and touches nothing', async () => {
  const { deps, clean } = fixture([], { compiled: false, version: undefined });
  try {
    await assert.rejects(selfUpdate(deps, {}), /git pull.*pnpm install/);
  } finally {
    clean();
  }
});

test('a missing gh and a gh that is not logged in are named', async () => {
  const missing = fixture([], { gh: realGh({ PATH: '/nonexistent' }) });
  const loggedOut = fixture([{ tag: 'cli-v0.4.0' }]);
  try {
    await assert.rejects(selfUpdate(missing.deps, {}), /gh is not installed/);
    loggedOut.gh.loggedOut();
    await assert.rejects(selfUpdate(loggedOut.deps, {}), /gh is not logged in: run "gh auth login"/);
  } finally {
    missing.clean();
    loggedOut.clean();
  }
});

test('an up-to-date binary says so; --check reports a newer release and downloads nothing', async () => {
  const same = fixture([{ tag: 'cli-v0.3.0' }]);
  const newer = fixture([{ tag: 'cli-v0.3.0' }, { tag: 'cli-v0.4.0', assets: { [ASSET]: 'new binary' } }]);
  try {
    await selfUpdate(same.deps, {});
    assert.deepEqual(same.printed, ['board 0.3.0 is the newest release']);
    await selfUpdate(newer.deps, { check: true });
    assert.match(newer.printed[0] ?? '', /board 0\.4\.0 is available \(this is 0\.3\.0\)/);
    assert.equal(readFileSync(newer.execPath, 'utf8'), 'old binary');
  } finally {
    same.clean();
    newer.clean();
  }
});

test('an update replaces the binary beside itself with mode 755 and leaves nothing behind', async () => {
  const { deps, execPath, dir, printed, clean } = fixture([
    { tag: 'cli-v0.3.0', assets: { [ASSET]: 'v3' } },
    { tag: 'cli-v0.10.0', assets: { [ASSET]: 'the new binary', 'board-darwin-arm64': 'other' } },
    { tag: 'cli-v0.9.0', assets: { [ASSET]: 'v9' } },
  ]);
  try {
    chmodSync(execPath, 0o700);
    await selfUpdate(deps, {});
    assert.equal(readFileSync(execPath, 'utf8'), 'the new binary');
    assert.equal(statSync(execPath).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(dir), ['board']);
    assert.deepEqual(printed, ['updated board 0.3.0 -> 0.10.0']);
  } finally {
    clean();
  }
});

test('releases are listed and downloaded from mloureiro/agent-board', async () => {
  const { gh, deps, clean } = fixture([{ tag: 'cli-v0.10.0', assets: { [ASSET]: 'the new binary' } }]);
  const releaseCalls: string[][] = [];
  const real = realGh(gh.env);
  try {
    await selfUpdate(
      {
        ...deps,
        gh: (args) => {
          if (args[0] === 'release') releaseCalls.push(args);
          return real(args);
        },
      },
      {},
    );
    assert.deepEqual(
      releaseCalls.map((args) => [args[1], args[args.indexOf('--repo') + 1]]),
      [
        ['list', 'mloureiro/agent-board'],
        ['download', 'mloureiro/agent-board'],
      ],
    );
  } finally {
    clean();
  }
});

test('the listener is restarted after the binary was replaced, and only then', async () => {
  const updated = fixture([{ tag: 'cli-v0.4.0', assets: { [ASSET]: 'new' } }], {
    restartListener: async () => 'restarted the listener',
  });
  const same = fixture([{ tag: 'cli-v0.3.0' }]);
  const checking = fixture([{ tag: 'cli-v0.4.0', assets: { [ASSET]: 'new' } }]);
  const bad = fixture([{ tag: 'cli-v0.4.0', assets: { [ASSET]: 'tampered' }, sums: `${sha256('genuine')}  ${ASSET}` }]);
  try {
    assert.equal(await selfUpdate(updated.deps, {}), 'updated');
    assert.deepEqual(updated.printed, ['updated board 0.3.0 -> 0.4.0', 'restarted the listener']);
    assert.equal(await selfUpdate(same.deps, {}), 'unchanged');
    assert.equal(await selfUpdate(checking.deps, { check: true }), 'unchanged');
    await assert.rejects(selfUpdate(bad.deps, {}));
    assert.deepEqual([...same.restarts, ...checking.restarts, ...bad.restarts], []);
  } finally {
    for (const f of [updated, same, checking, bad]) f.clean();
  }
});

test('a machine without systemctl has no listener to restart, and that is no failure', async () => {
  const saved = process.env['PATH'];
  try {
    process.env['PATH'] = '/nonexistent';
    assert.equal(await realListenerRestart({ block: true, platform: 'linux' })(), undefined);
  } finally {
    process.env['PATH'] = saved;
  }
});

test('a download that does not match SHA256SUMS is refused, and so is a missing entry', async () => {
  const bad = fixture([{ tag: 'cli-v0.4.0', assets: { [ASSET]: 'tampered' }, sums: `${sha256('genuine')}  ${ASSET}` }]);
  const unlisted = fixture([{ tag: 'cli-v0.4.0', assets: { [ASSET]: 'x' }, sums: `${sha256('x')}  other-file` }]);
  try {
    await assert.rejects(selfUpdate(bad.deps, {}), /does not match SHA256SUMS; nothing was replaced/);
    assert.equal(readFileSync(bad.execPath, 'utf8'), 'old binary');
    await assert.rejects(selfUpdate(unlisted.deps, {}), /does not list board-linux-x64/);
    assert.equal(readFileSync(unlisted.execPath, 'utf8'), 'old binary');
  } finally {
    bad.clean();
    unlisted.clean();
  }
});

test('board self-update is refused inside a run, and in a checkout says to pull', async () => {
  await assert.rejects(
    runBoard(['self-update'], { env: { AGENT_BOARD_TASK: 'Zt0Test1' } }),
    /not available inside a board run/,
  );
  await assert.rejects(runBoard(['self-update', '--check'], { env: {} }), /git pull/);
});

test('the staging file beside the binary has an unpredictable name and is gone afterwards', async () => {
  const { deps, dir, clean } = fixture([
    { tag: 'cli-v0.3.0', assets: { [ASSET]: 'v3' } },
    { tag: 'cli-v0.4.0', assets: { [ASSET]: 'the new binary' } },
  ]);
  try {
    // A planted file of the old predictable name must not matter.
    writeFileSync(join(dir, `.board-update-${process.pid}`), 'planted');
    await selfUpdate(deps, {});
    assert.deepEqual(readdirSync(dir).sort(), ['.board-update-' + process.pid, 'board']);
    assert.equal(readFileSync(join(dir, `.board-update-${process.pid}`), 'utf8'), 'planted');
  } finally {
    clean();
  }
});

function fakeBin(script: string): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'board-fakebin-test-'));
  for (const [name, body] of Object.entries({ [script.split(':')[0] ?? '']: script.split(':').slice(1).join(':') })) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  return { dir, env: { PATH: `${dir}:/usr/bin:/bin` } };
}

test('both the listener and the watch unit are try-restarted, and each failure is named', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-fakebin-test-'));
  const log = join(dir, 'calls.log');
  const saved = process.env['PATH'];
  try {
    writeFileSync(join(dir, 'systemctl'), `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`, { mode: 0o755 });
    process.env['PATH'] = `${dir}:${saved ?? ''}`;
    assert.equal(
      await realListenerRestart({ block: true, platform: 'linux' })(),
      'restarted agent-board-listen.service if it was running, to run the new code\nrestarted agent-board-watch.service if it was running, to run the new code',
    );
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').sort(), [
      '--user try-restart agent-board-listen.service',
      '--user try-restart agent-board-watch.service',
    ]);
    writeFileSync(
      join(dir, 'systemctl'),
      '#!/bin/sh\n[ "$3" = agent-board-watch.service ] && { echo boom >&2; exit 1; }\nexit 0\n',
      { mode: 0o755 },
    );
    assert.match(
      (await realListenerRestart({ block: true, platform: 'linux' })()) ?? '',
      /could not restart agent-board-watch\.service \(boom\); run "systemctl --user restart agent-board-watch"/,
    );
  } finally {
    process.env['PATH'] = saved;
    rmSync(dir, { recursive: true });
  }
});

test('a systemctl that does not know the listener unit (exit 5) is no failure either', async () => {
  const { dir } = fakeBin('systemctl:exit 5');
  const saved = process.env['PATH'];
  try {
    process.env['PATH'] = `${dir}:${saved ?? ''}`;
    assert.equal(await realListenerRestart({ block: true, platform: 'linux' })(), undefined);
    writeFileSync(join(dir, 'systemctl'), '#!/bin/sh\necho boom >&2\nexit 1\n', { mode: 0o755 });
    assert.match((await realListenerRestart({ block: true, platform: 'linux' })()) ?? '', /could not restart.*boom/);
  } finally {
    process.env['PATH'] = saved;
    rmSync(dir, { recursive: true });
  }
});

// A launchctl that logs its arguments and says whether the listener agent is loaded (`print` exits 0) or not.
function fakeLaunchctl(loaded: boolean, kickstartFails = false): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'board-fakebin-test-'));
  const log = join(dir, 'calls.log');
  const script = [
    '#!/bin/sh',
    `echo "$@" >> ${log}`,
    `[ "$1" = print ] && exit ${loaded ? 0 : 113}`,
    kickstartFails ? 'echo boom >&2; exit 1' : 'exit 0',
  ].join('\n');
  writeFileSync(join(dir, 'launchctl'), script, { mode: 0o755 });
  return { dir, log };
}

test('on macOS the listener is restarted with kickstart -k, only when launchd has it loaded', async () => {
  const saved = process.env['PATH'];
  const loaded = fakeLaunchctl(true);
  const notLoaded = fakeLaunchctl(false);
  const failing = fakeLaunchctl(true, true);
  const target = 'gui/501/de.codeplant.agent-board.listen';
  const watchTarget = 'gui/501/de.codeplant.agent-board.watch';
  try {
    process.env['PATH'] = `${loaded.dir}:${saved ?? ''}`;
    assert.equal(
      await realListenerRestart({ block: true, platform: 'darwin', uid: 501 })(),
      'restarted de.codeplant.agent-board.watch, to run the new code\nrestarted de.codeplant.agent-board.listen, to run the new code',
    );
    assert.equal(
      readFileSync(loaded.log, 'utf8'),
      `print ${watchTarget}\nkickstart -k ${watchTarget}\nprint ${target}\nkickstart -k ${target}\n`,
    );
    process.env['PATH'] = `${notLoaded.dir}:${saved ?? ''}`;
    assert.equal(await realListenerRestart({ block: true, platform: 'darwin', uid: 501 })(), undefined);
    assert.equal(
      readFileSync(notLoaded.log, 'utf8'),
      `print ${watchTarget}\nprint ${target}\n`,
      'no kickstart for an agent that is not loaded',
    );
    process.env['PATH'] = `${failing.dir}:${saved ?? ''}`;
    const failed = (await realListenerRestart({ block: true, platform: 'darwin', uid: 501 })()) ?? '';
    assert.match(
      failed,
      /could not restart .*\(boom\); run "launchctl kickstart -k gui\/501\/de\.codeplant\.agent-board\.listen"/,
    );
    assert.match(failed, /run "launchctl kickstart -k gui\/501\/de\.codeplant\.agent-board\.watch"/);
    process.env['PATH'] = '/nonexistent';
    assert.equal(await realListenerRestart({ block: true, platform: 'darwin', uid: 501 })(), undefined, 'no launchctl');
  } finally {
    process.env['PATH'] = saved;
    for (const { dir } of [loaded, notLoaded, failing]) rmSync(dir, { recursive: true });
  }
});

test('on macOS a restart that must not block returns at once and kicks the listener on its own', async () => {
  const saved = process.env['PATH'];
  const loaded = fakeLaunchctl(true);
  try {
    process.env['PATH'] = `${loaded.dir}:${saved ?? ''}`;
    assert.match(
      (await realListenerRestart({ block: false, platform: 'darwin', uid: 501 })()) ?? '',
      /^restarting de\.codeplant\.agent-board\.watch.*\nrestarting de\.codeplant\.agent-board\.listen/,
    );
    for (let waited = 0; waited < 3000 && readFileSync(loaded.log, 'utf8').split('kickstart').length < 3; waited += 50)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(readFileSync(loaded.log, 'utf8'), /kickstart -k gui\/501\/de\.codeplant\.agent-board\.listen/);
  } finally {
    process.env['PATH'] = saved;
    rmSync(loaded.dir, { recursive: true });
  }
});

test('a gh call that outlasts its time limit is stopped and named', async () => {
  const { dir, env } = fakeBin('gh:sleep 5');
  try {
    await assert.rejects(realGh(env, 100)(['release', 'download']), /gh release download took longer than 0\.1 s/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('download directories left by a killed update are removed once they are over an hour old', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-sweep-test-'));
  try {
    const old = join(root, 'board-update-old');
    const fresh = join(root, 'board-update-fresh');
    const other = join(root, 'something-else');
    for (const path of [old, fresh, other]) mkdirSync(path);
    const longAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(old, longAgo, longAgo);
    utimesSync(other, longAgo, longAgo);
    sweepStaleUpdateDirs(new Date(), root);
    assert.deepEqual(readdirSync(root).sort(), ['board-update-fresh', 'something-else']);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('staged binaries left by a killed update are removed once they are over an hour old, and nothing else is', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-sweep-test-'));
  try {
    const old = join(root, '.board-update-0123456789abcdef');
    const fresh = join(root, '.board-update-fedcba9876543210');
    const planted = join(root, '.board-update-123');
    const binary = join(root, 'board');
    for (const path of [old, fresh, planted, binary]) writeFileSync(path, 'x');
    const longAgo = new Date(Date.now() - 2 * 3_600_000);
    for (const path of [old, planted, binary]) utimesSync(path, longAgo, longAgo);
    sweepStaleStagedBinaries(root);
    assert.deepEqual(readdirSync(root).sort(), ['.board-update-123', '.board-update-fedcba9876543210', 'board']);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('an update sweeps stale staged binaries and lifts the hold once the binary is replaced, and --check does neither', async () => {
  const { deps, dir, clean } = fixture([{ tag: 'cli-v0.4.0', assets: { [ASSET]: 'new' } }]);
  try {
    const stale = join(dir, '.board-update-0123456789abcdef');
    writeFileSync(stale, 'x');
    const longAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(stale, longAgo, longAgo);
    let lifted = 0;
    const withHold = { ...deps, clearHold: () => (lifted += 1) };
    await selfUpdate(withHold, { check: true });
    assert.equal(lifted, 0);
    assert.deepEqual(readdirSync(dir).sort(), ['.board-update-0123456789abcdef', 'board']);
    await selfUpdate(withHold, {});
    assert.equal(lifted, 1);
    assert.deepEqual(readdirSync(dir), ['board']);
  } finally {
    clean();
  }
});

test('a gh that is not logged in keeps the hold, and a binary that is already the newest lifts it', async () => {
  const f = fixture([{ tag: 'cli-v0.4.0', assets: { [ASSET]: 'new' } }]);
  const same = fixture([{ tag: 'cli-v0.3.0' }]);
  try {
    let lifted = 0;
    f.gh.loggedOut();
    await assert.rejects(selfUpdate({ ...f.deps, clearHold: () => (lifted += 1) }, {}), /gh is not logged in/);
    assert.equal(lifted, 0);
    assert.equal(await selfUpdate({ ...same.deps, clearHold: () => (lifted += 1) }, {}), 'unchanged');
    assert.equal(lifted, 1);
    assert.equal(await selfUpdate({ ...same.deps, clearHold: () => (lifted += 1) }, { check: true }), 'unchanged');
    assert.equal(lifted, 1);
  } finally {
    f.clean();
    same.clean();
  }
});
