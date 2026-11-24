import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ReportedFailure } from '../cli.mts';
import { runBoard } from '../commands/program.mts';
import { setup } from './setup.mts';
import type { SetupDeps } from './setup.mts';
import { uninstall } from './uninstall.mts';
import type { UninstallDeps } from './uninstall.mts';

function fixture(platform: 'linux' | 'darwin', options: { loaded?: boolean; home?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'board-uninstall-test-'));
  const printed: string[] = [];
  const calls: string[] = [];
  const failing: { on?: string } = {};
  const setupDeps: SetupDeps = {
    unitDir: join(dir, 'systemd', 'user'),
    launchd: {
      home: options.home ?? '/Users/me',
      agentsDir: join(dir, 'LaunchAgents'),
      logDir: join(dir, 'state', 'logs'),
      runDir: join(dir, 'state', 'run'),
      uid: 501,
      env: {},
      loaded: async () => options.loaded ?? false,
    },
    platform,
    which: (program) => `/usr/bin/${program}`,
    command: (name) => ['/opt/board', 'internal', name],
    run: async (program, args) => {
      const line = [program, ...args].join(' ');
      calls.push(line);
      if (failing.on !== undefined && line.includes(failing.on)) throw new Error('Input/output error');
    },
    print: (line) => printed.push(line),
  };
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'board-binary'), '');
  symlinkSync(join(dir, 'board-binary'), join(bin, 'board'));
  const optionalDirs = [join(dir, 'config'), join(dir, 'state'), join(dir, 'run')];
  for (const optional of optionalDirs) mkdirSync(optional, { recursive: true });
  writeFileSync(join(dir, 'config', 'env'), 'AGENT_BOARD_TOKEN=x\n');
  const deps: UninstallDeps = { setup: setupDeps, installedBoard: join(bin, 'board'), optionalDirs };
  return { dir, printed, calls, deps, failing };
}

test('on Linux uninstall disables and stops every unit, deletes the unit files and the installed board, and keeps user data', async () => {
  const { dir, printed, calls, deps } = fixture('linux');
  try {
    await setup(deps.setup, {});
    writeFileSync(join(deps.setup.unitDir, 'agent-board-intake.timer'), '');
    calls.length = 0;
    await uninstall(deps, {});
    assert.deepEqual(calls, [
      'systemctl --user disable --now agent-board-dispatch.timer',
      'systemctl --user disable --now agent-board-listen.service',
      'systemctl --user disable --now agent-board-watch.service',
      'systemctl --user disable --now agent-board-intake.timer',
      'systemctl --user stop agent-board-dispatch.service',
      'systemctl --user daemon-reload',
    ]);
    assert.deepEqual(readdirSync(deps.setup.unitDir), []);
    assert.equal(existsSync(deps.installedBoard), false);
    assert.ok(existsSync(join(dir, 'board-binary')), 'the link goes, not what it points to');
    for (const optional of deps.optionalDirs) assert.ok(existsSync(optional), `${optional} is kept`);
    assert.ok(printed.some((line) => line.startsWith('kept ') && line.includes('--include-optional')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('on macOS uninstall boots out the loaded agents and deletes the files of all three', async () => {
  const { dir, calls, deps } = fixture('darwin', { loaded: true });
  try {
    await setup(deps.setup, {});
    calls.length = 0;
    await uninstall(deps, {});
    assert.deepEqual(calls, [
      'launchctl bootout gui/501/de.codeplant.agent-board.dispatch',
      'launchctl bootout gui/501/de.codeplant.agent-board.listen',
      'launchctl bootout gui/501/de.codeplant.agent-board.watch',
    ]);
    assert.deepEqual(readdirSync(deps.setup.launchd.agentsDir), []);
    assert.equal(existsSync(deps.installedBoard), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('on macOS an agent that is not loaded is not booted out, and its file is deleted', async () => {
  const { dir, calls, deps } = fixture('darwin');
  try {
    await setup(deps.setup, {});
    calls.length = 0;
    await uninstall(deps, {});
    assert.deepEqual(calls, []);
    assert.deepEqual(readdirSync(deps.setup.launchd.agentsDir), []);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('on macOS a failing bootout keeps that agent file, is printed, and fails the command after the rest ran', async () => {
  const { dir, printed, deps, failing } = fixture('darwin', { loaded: true });
  try {
    await setup(deps.setup, {});
    failing.on = 'agent-board.listen';
    await assert.rejects(uninstall(deps, {}), ReportedFailure);
    assert.deepEqual(readdirSync(deps.setup.launchd.agentsDir), ['de.codeplant.agent-board.listen.plist']);
    assert.ok(printed.some((line) => line.includes('could not stop') && line.includes('Input/output error')));
    assert.ok(existsSync(deps.installedBoard), 'kept so uninstall can run again');
    assert.ok(printed.some((line) => line.startsWith('kept ') && line.includes('run again')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('on Linux a unit file that is not in the unit directory gets no systemctl call', async () => {
  const { dir, calls, deps } = fixture('linux');
  try {
    await setup(deps.setup, {});
    rmSync(join(deps.setup.unitDir, 'agent-board-watch.service'));
    calls.length = 0;
    await uninstall(deps, {});
    assert.ok(calls.every((call) => !call.includes('watch')));
    assert.ok(calls.some((call) => call.includes('listen')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('on Linux a failing systemctl keeps that unit file and fails the command', async () => {
  const { dir, printed, deps, failing } = fixture('linux');
  try {
    await setup(deps.setup, {});
    failing.on = 'agent-board-listen.service';
    await assert.rejects(uninstall(deps, {}), ReportedFailure);
    assert.deepEqual(readdirSync(deps.setup.unitDir), ['agent-board-listen.service']);
    assert.ok(printed.some((line) => line.includes('could not stop agent-board-listen.service')));
    assert.ok(existsSync(deps.installedBoard));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('--include-optional refuses a directory that is the home directory or holds it, and removes the others', async () => {
  const { dir, printed, deps } = fixture('darwin');
  try {
    const home = join(dir, 'config');
    mkdirSync(join(home, 'nested'));
    const refusing = {
      ...deps,
      setup: { ...deps.setup, launchd: { ...deps.setup.launchd, home: join(home, 'nested') } },
    };
    await assert.rejects(uninstall(refusing, { includeOptional: true }), ReportedFailure);
    assert.ok(existsSync(join(dir, 'config', 'env')));
    assert.ok(printed.some((line) => line.startsWith(`refused to remove ${home}`)));
    assert.equal(existsSync(join(dir, 'state')), false);
    assert.equal(existsSync(join(dir, 'run')), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('--include-optional also removes the config, state and run directories', async () => {
  const { dir, printed, deps } = fixture('darwin');
  try {
    await uninstall(deps, { includeOptional: true });
    for (const optional of deps.optionalDirs) assert.equal(existsSync(optional), false, `${optional} is removed`);
    assert.ok(printed.every((line) => !line.startsWith('kept ')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('--dry-run runs nothing and removes nothing, and prints what it would do', async () => {
  const { dir, printed, calls, deps } = fixture('linux');
  try {
    await setup(deps.setup, {});
    calls.length = 0;
    await uninstall(deps, { dryRun: true, includeOptional: true });
    assert.deepEqual(calls, []);
    assert.equal(readdirSync(deps.setup.unitDir).length, 4);
    assert.ok(existsSync(deps.installedBoard));
    for (const optional of deps.optionalDirs) assert.ok(existsSync(optional));
    assert.ok(printed.includes('DRY systemctl --user disable --now agent-board-listen.service'));
    assert.ok(printed.includes(`DRY remove ${deps.installedBoard}`));
    assert.ok(printed.includes(`DRY remove ${join(dir, 'config')}`));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('uninstall needs Linux or macOS', async () => {
  const { dir, deps } = fixture('linux');
  try {
    await assert.rejects(
      uninstall({ ...deps, setup: { ...deps.setup, platform: 'win32' } }, {}),
      /needs Linux with systemd or macOS/,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('board uninstall goes through the command line, takes a leading --dry-run, and is refused inside a run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-uninstall-test-'));
  const calls: string[] = [];
  const env = {
    HOME: join(dir, 'home'),
    AGENT_BOARD_CONFIG_DIR: join(dir, 'cfg'),
    AGENT_BOARD_STATE_DIR: join(dir, 'state'),
    BOARD_INSTALL_DIR: join(dir, 'bin'),
  };
  const options = {
    env,
    writeOut: () => undefined,
    platform: 'darwin',
    which: (program: string) => `/usr/bin/${program}`,
    runSystem: async (program: string, args: string[]) => void calls.push([program, ...args].join(' ')),
    agentLoaded: async () => false,
  };
  try {
    await runBoard(['setup'], options);
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'board'), '');
    mkdirSync(join(dir, 'cfg'));
    await runBoard(['--dry-run', 'uninstall', '--include-optional'], options);
    assert.equal(readdirSync(join(dir, 'home', 'Library', 'LaunchAgents')).length, 3);
    assert.ok(existsSync(join(dir, 'cfg')));
    await runBoard(['uninstall'], options);
    assert.equal(readdirSync(join(dir, 'home', 'Library', 'LaunchAgents')).length, 0);
    assert.equal(existsSync(join(dir, 'bin', 'board')), false);
    assert.ok(existsSync(join(dir, 'cfg')));
    await runBoard(['uninstall', '--include-optional'], options);
    assert.equal(existsSync(join(dir, 'cfg')), false);
    assert.equal(existsSync(join(dir, 'state')), false);
    await assert.rejects(
      runBoard(['uninstall'], { ...options, env: { ...env, AGENT_BOARD_TASK: 'Zt0Test1' } }),
      /not available inside a board run/,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});
