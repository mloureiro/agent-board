import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeUpdateState } from '../__tests__/helpers/fakes.mts';
import { fixture } from '../__tests__/helpers/migration.mts';
import { createBackup, listBackups } from './backup.mts';
import { readJournal, writeJournal } from './journal.mts';
import { lockPath } from './lock.mts';
import { readMarker, writeMarker } from './marker.mts';
import { rollback } from './rollback.mts';
import type { RollbackDeps } from './rollback.mts';
import { unitFilesOf } from './units.mts';

const text = (path: string): string => readFileSync(path, 'utf8');

function scenario(
  options: { platform?: string; kind?: 'update' | 'steps' | 'server'; minClient?: number; unreachable?: boolean } = {},
) {
  const platform = options.platform ?? 'linux';
  const f = fixture([], { platform });
  const { deps } = f;
  const { configDir, stateDir } = deps.paths;
  const execPath = join(f.dir, 'bin', 'board');
  mkdirSync(join(f.dir, 'bin'));
  writeFileSync(execPath, 'old binary', { mode: 0o755 });
  const units = unitFilesOf(platform, deps.env, deps.home);
  const unit = units.names[0] ?? 'unit';
  mkdirSync(units.dir, { recursive: true });
  writeFileSync(join(units.dir, unit), 'old unit', { mode: 0o644 });
  writeFileSync(join(configDir, 'config.json'), '{"old":true}\n');
  const backup = createBackup({
    stateDir,
    kind: options.kind ?? 'update',
    from: '0.37.0',
    to: '0.40.0',
    cliApi: 9,
    ...(options.kind === 'steps' ? {} : { binaryPath: execPath }),
    configDir,
    unitFiles: units,
    platform,
    now: f.clock.now,
  });
  writeFileSync(execPath, 'new binary', { mode: 0o755 });
  writeFileSync(join(units.dir, unit), 'new unit');
  writeFileSync(join(configDir, 'config.json'), '{"old":false}\n');
  writeMarker(stateDir, '0.40.0');
  const updateState = fakeUpdateState();
  const calls = { range: [] as string[], restarts: 0, runs: f.runs, confirms: 0 };
  const rollbackDeps: RollbackDeps = {
    paths: deps.paths,
    platform,
    env: deps.env,
    home: deps.home,
    compiled: true,
    execPath,
    uid: 501,
    now: deps.now,
    print: deps.print,
    interactive: false,
    confirm: async () => {
      calls.confirms += 1;
      return f.answers.shift() ?? false;
    },
    serverRange: async (url, token) => {
      calls.range.push(`${url} ${token}`);
      if (options.unreachable) throw new Error('cannot reach https://board.example.com: fetch failed');
      return { version: 12, minClient: options.minClient ?? 9 };
    },
    agentLoaded: async () => true,
    run: deps.run,
    restart: async () => {
      calls.restarts += 1;
      return 'restarted the listener';
    },
    updateState,
  };
  const snapshot = (): string[] => [
    text(execPath),
    text(join(units.dir, unit)),
    text(join(configDir, 'config.json')),
    String(readMarker(stateDir)),
    String(existsSync(join(stateDir, 'migration', 'journal.json'))),
  ];
  return { f, rollbackDeps, backup, execPath, unitPath: join(units.dir, unit), unit, updateState, calls, snapshot };
}

test('after a finished migration the config, the units and the binary are the backup, the marker is its from and the hold is set', async () => {
  const s = scenario();
  try {
    assert.equal(await rollback(s.rollbackDeps), 'rolled-back');
    assert.equal(text(s.execPath), 'old binary');
    assert.equal(statSync(s.execPath).mode & 0o777, 0o755);
    assert.equal(text(s.unitPath), 'old unit');
    assert.equal(statSync(s.unitPath).mode & 0o777, 0o644);
    assert.equal(text(join(s.f.deps.paths.configDir, 'config.json')), '{"old":true}\n');
    assert.equal(readMarker(s.f.deps.paths.stateDir), '0.37.0');
    assert.equal(s.updateState.held, '0.40.0');
    assert.equal(s.calls.restarts, 1);
    assert.deepEqual(s.calls.runs, [['systemctl', '--user', 'daemon-reload']]);
    assert.ok(listBackups(s.f.deps.paths.stateDir)[0]?.manifest.rolledBackAt !== null);
    assert.equal(existsSync(lockPath(s.f.deps.paths.stateDir)), false);
    assert.deepEqual(readdirSync(join(s.f.dir, 'bin')), ['board'], 'no staged file is left beside the binary');
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('after a failed migration the journal is gone too', async () => {
  const s = scenario();
  try {
    const { stateDir } = s.f.deps.paths;
    writeJournal(stateDir, {
      version: 1,
      from: '0.37.0',
      to: '0.40.0',
      steps: ['a'],
      done: [],
      stopped: { id: 'a', reason: 'failed', message: 'disk full', at: '2026-11-24T10:16:00.000Z' },
      backup: s.backup.name,
      startedAt: '2026-11-24T10:15:03.000Z',
    });
    assert.equal(await rollback(s.rollbackDeps), 'rolled-back');
    assert.equal(readJournal(stateDir), undefined);
    assert.equal(readMarker(stateDir), '0.37.0');
    assert.equal(text(s.execPath), 'old binary');
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('the board asked for the range is the one in the backup, with the token in the backup', async () => {
  const s = scenario();
  try {
    await rollback(s.rollbackDeps);
    assert.deepEqual(s.calls.range, ['https://board.example.com abm_x']);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a server that no longer serves the old CLI refuses, naming both numbers, and changes nothing', async () => {
  const s = scenario({ minClient: 10 });
  try {
    const before = s.snapshot();
    await assert.rejects(
      rollback(s.rollbackDeps),
      /no longer serves CLI 0\.37\.0 \(API 9, it serves from 10\); nothing was changed/,
    );
    assert.deepEqual(s.snapshot(), before);
    assert.equal(s.updateState.held, undefined);
    assert.equal(s.calls.restarts, 0);
    assert.equal(listBackups(s.f.deps.paths.stateDir)[0]?.manifest.rolledBackAt, null);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a server that cannot be reached refuses and changes nothing', async () => {
  const s = scenario({ unreachable: true });
  try {
    const before = s.snapshot();
    await assert.rejects(
      rollback(s.rollbackDeps),
      /cannot check whether the board at https:\/\/board\.example\.com still serves CLI 0\.37\.0.*nothing was changed/,
    );
    assert.deepEqual(s.snapshot(), before);
    assert.equal(s.updateState.held, undefined);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a backup file that was changed is refused by its checksum and nothing is changed', async () => {
  const s = scenario();
  try {
    const before = s.snapshot();
    writeFileSync(join(s.backup.dir, 'board'), 'tampered', { mode: 0o600 });
    await assert.rejects(rollback(s.rollbackDeps), /cannot be trusted:.*board was changed; nothing was changed/);
    assert.deepEqual(s.snapshot(), before);
    assert.deepEqual(s.calls.range, []);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a backup without a binary is refused with its directory named', async () => {
  const s = scenario({ kind: 'steps' });
  try {
    const before = s.snapshot();
    await assert.rejects(rollback(s.rollbackDeps), (error: Error) => {
      assert.ok(error.message.includes(s.backup.dir), error.message);
      assert.match(error.message, /no binary.*nothing was changed/);
      return true;
    });
    assert.deepEqual(s.snapshot(), before);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a backup of a server move is refused with its directory and the way back named', async () => {
  const s = scenario({ kind: 'server' });
  try {
    const before = s.snapshot();
    await assert.rejects(rollback(s.rollbackDeps), (error: Error) => {
      assert.ok(error.message.includes(s.backup.dir), error.message);
      assert.match(
        error.message,
        /moving to another board.*board self-update --server https:\/\/board\.example\.com.*nothing was changed/,
      );
      return true;
    });
    assert.deepEqual(s.snapshot(), before);
    assert.deepEqual(s.calls.range, []);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a person who declines changes nothing, and one who agrees is shown what is restored', async () => {
  const declined = scenario();
  const agreed = scenario();
  try {
    declined.rollbackDeps.interactive = true;
    const before = declined.snapshot();
    assert.equal(await rollback(declined.rollbackDeps), 'declined');
    assert.deepEqual(declined.snapshot(), before);
    assert.equal(declined.updateState.held, undefined);
    assert.equal(declined.calls.restarts, 0);
    assert.equal(declined.calls.confirms, 1);

    agreed.rollbackDeps.interactive = true;
    agreed.f.answers.push(true);
    assert.equal(await rollback(agreed.rollbackDeps), 'rolled-back');
    assert.ok(agreed.f.printed.some((line) => line.includes(agreed.execPath)));
    assert.equal(text(agreed.execPath), 'old binary');
  } finally {
    rmSync(declined.f.dir, { recursive: true });
    rmSync(agreed.f.dir, { recursive: true });
  }
});

test('a second rollback finds nothing newer to roll back and changes nothing', async () => {
  const s = scenario();
  try {
    await rollback(s.rollbackDeps);
    const before = s.snapshot();
    await assert.rejects(rollback(s.rollbackDeps), /nothing to roll back.*was rolled back at/);
    assert.deepEqual(s.snapshot(), before);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('without any backup it refuses', async () => {
  const s = scenario();
  try {
    rmSync(join(s.f.deps.paths.stateDir, 'backups'), { recursive: true });
    await assert.rejects(rollback(s.rollbackDeps), /no backup to roll back to/);
    assert.equal(text(s.execPath), 'new binary');
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a symlink at a destination is refused and named, before anything is written', async () => {
  const s = scenario();
  try {
    const target = join(s.f.dir, 'elsewhere');
    writeFileSync(target, 'precious');
    const config = join(s.f.deps.paths.configDir, 'config.json');
    rmSync(config);
    symlinkSync(target, config);
    const binaryBefore = text(s.execPath);
    await assert.rejects(rollback(s.rollbackDeps), (error: Error) => {
      assert.ok(error.message.includes(config), error.message);
      assert.match(error.message, /symlink.*nothing was changed/);
      return true;
    });
    assert.equal(text(target), 'precious');
    assert.equal(text(s.execPath), binaryBefore);
    assert.equal(text(s.unitPath), 'new unit');
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a binary that is a symlink is refused', async () => {
  const s = scenario();
  try {
    const real = join(s.f.dir, 'real-board');
    writeFileSync(real, 'new binary', { mode: 0o755 });
    rmSync(s.execPath);
    symlinkSync(real, s.execPath);
    await assert.rejects(rollback(s.rollbackDeps), /symlink.*nothing was changed/);
    assert.equal(text(real), 'new binary');
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a backup made for another binary path or directory is refused', async () => {
  const s = scenario();
  try {
    await assert.rejects(rollback({ ...s.rollbackDeps, execPath: join(s.f.dir, 'bin', 'other') }), /was made for/);
    await assert.rejects(
      rollback({ ...s.rollbackDeps, paths: { ...s.f.deps.paths, configDir: join(s.f.dir, 'elsewhere') } }),
      /other config or unit directories/,
    );
    await assert.rejects(rollback({ ...s.rollbackDeps, compiled: false }), /checkout/);
    assert.equal(text(s.execPath), 'new binary');
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a rollback is refused while another live process holds the lock', async () => {
  const s = scenario();
  try {
    writeFileSync(lockPath(s.f.deps.paths.stateDir), `${JSON.stringify({ pid: process.ppid, startedAt: 'now' })}\n`);
    await assert.rejects(rollback(s.rollbackDeps), /another migration is running/);
    assert.equal(text(s.execPath), 'new binary');
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('on macOS a loaded agent whose plist changed is booted out and in again, and an unloaded one is only written', async () => {
  const loaded = scenario({ platform: 'darwin' });
  const unloaded = scenario({ platform: 'darwin' });
  try {
    loaded.rollbackDeps.agentLoaded = async () => true;
    await rollback(loaded.rollbackDeps);
    assert.equal(text(loaded.unitPath), 'old unit');
    assert.deepEqual(loaded.calls.runs, [
      ['launchctl', 'bootout', `gui/501/de.codeplant.agent-board.${loaded.unit.split('.').at(-2)}`],
      ['launchctl', 'bootstrap', 'gui/501', loaded.unitPath],
    ]);

    unloaded.rollbackDeps.agentLoaded = async () => false;
    await rollback(unloaded.rollbackDeps);
    assert.equal(text(unloaded.unitPath), 'old unit');
    assert.deepEqual(unloaded.calls.runs, []);
  } finally {
    rmSync(loaded.f.dir, { recursive: true });
    rmSync(unloaded.f.dir, { recursive: true });
  }
});

test('a file that cannot be staged leaves the machine as it was and says why', async () => {
  const s = scenario();
  const unitDir = join(s.unitPath, '..');
  try {
    const before = s.snapshot();
    chmodSync(unitDir, 0o555);
    await assert.rejects(rollback(s.rollbackDeps), /cannot write the restored files \(.*\); nothing was changed/);
    chmodSync(unitDir, 0o755);
    assert.deepEqual(s.snapshot(), before);
    assert.deepEqual(readdirSync(join(s.f.dir, 'bin')), ['board']);
    assert.deepEqual(
      readdirSync(s.f.deps.paths.configDir).filter((name) => name.includes('.rollback-')),
      [],
    );
    assert.equal(s.updateState.held, undefined);
  } finally {
    chmodSync(unitDir, 0o755);
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a unit reload that fails still leaves the marker and the journal rolled back', async () => {
  const s = scenario();
  try {
    const { stateDir } = s.f.deps.paths;
    writeJournal(stateDir, {
      version: 1,
      from: '0.37.0',
      to: '0.40.0',
      steps: ['a'],
      done: [],
      backup: s.backup.name,
      startedAt: '2026-11-24T10:15:03.000Z',
    });
    s.rollbackDeps.run = async () => {
      throw new Error('systemctl failed');
    };
    await assert.rejects(rollback(s.rollbackDeps), /systemctl failed/);
    assert.equal(text(s.execPath), 'old binary');
    assert.equal(readMarker(stateDir), '0.37.0');
    assert.equal(readJournal(stateDir), undefined);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});
