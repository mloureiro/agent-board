import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../__tests__/helpers/migration.mts';
import type { Fixture } from '../__tests__/helpers/migration.mts';
import { createBackup, listBackups, pruneBackups, verifyBackup } from './backup.mts';
import type { BackupInput } from './backup.mts';

const mode = (path: string): number => statSync(path).mode & 0o777;

function input(f: Fixture, overrides: Partial<BackupInput> = {}): BackupInput {
  const unitDir = join(f.dir, 'units');
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'agent-board-listen.service'), '[Unit]\n');
  return {
    stateDir: f.deps.paths.stateDir,
    kind: 'steps',
    from: '0.37.0',
    to: '0.40.0',
    cliApi: 9,
    configDir: f.deps.paths.configDir,
    unitFiles: { dir: unitDir, names: ['agent-board-listen.service', 'agent-board-missing.service'] },
    platform: 'linux',
    now: new Date('2026-11-24T10:15:03.456Z'),
    ...overrides,
  };
}

test('a backup is private, holds the config and the existing unit files, and names itself by time, kind and versions', () => {
  const f = fixture([]);
  try {
    mkdirSync(join(f.deps.paths.configDir, 'sub'));
    symlinkSync(join(f.deps.paths.configDir, 'env'), join(f.deps.paths.configDir, 'link'));
    const entry = createBackup(input(f));
    assert.equal(entry.name, '2026-11-24T10-15-03Z-steps-0.37.0-0.40.0');
    assert.equal(mode(join(f.deps.paths.stateDir, 'backups')), 0o700);
    assert.equal(mode(entry.dir), 0o700);
    assert.equal(mode(join(entry.dir, 'manifest.json')), 0o600);
    assert.equal(mode(join(entry.dir, 'config', 'env')), 0o600);
    assert.deepEqual(entry.manifest.files.map((file) => file.path).sort(), [
      'config/env',
      'config/web.json',
      'units/agent-board-listen.service',
    ]);
    assert.equal(entry.manifest.files.find((file) => file.path === 'config/env')?.mode, 0o600);
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});

test('a backup of kind update keeps the binary with its original mode', () => {
  const f = fixture([]);
  try {
    const binary = join(f.dir, 'board');
    writeFileSync(binary, 'binary');
    chmodSync(binary, 0o755);
    const entry = createBackup(input(f, { kind: 'update', binaryPath: binary }));
    assert.equal(mode(join(entry.dir, 'board')), 0o600);
    assert.equal(entry.manifest.files.find((file) => file.path === 'board')?.mode, 0o755);
    assert.equal(entry.manifest.binaryPath, binary);
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});

test('a backups root that is a symlink is refused and nothing is written through it', () => {
  const f = fixture([]);
  try {
    const elsewhere = join(f.dir, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(f.deps.paths.stateDir, { recursive: true });
    symlinkSync(elsewhere, join(f.deps.paths.stateDir, 'backups'));
    assert.throws(() => createBackup(input(f)), /not a plain directory/);
    assert.deepEqual(readdirSync(elsewhere), []);
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});

test('verification passes for an untouched backup and fails once a file changed or went missing', () => {
  const f = fixture([]);
  try {
    const entry = createBackup(input(f));
    assert.equal(verifyBackup(entry.dir).ok, true);
    writeFileSync(join(entry.dir, 'config', 'env'), 'AGENT_BOARD_TOKEN=other\n');
    const changed = verifyBackup(entry.dir);
    assert.equal(changed.ok, false);
    assert.match(changed.ok ? '' : changed.problem, /config\/env was changed/);
    rmSync(join(entry.dir, 'config', 'web.json'));
    assert.equal(verifyBackup(entry.dir).ok, false);
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});

test('a manifest that names a path outside the backup does not verify', () => {
  const f = fixture([]);
  try {
    const entry = createBackup(input(f));
    const manifest = join(entry.dir, 'manifest.json');
    const raw = JSON.parse(readFileSync(manifest, 'utf8')) as { files: { path: string }[] };
    raw.files[0]!.path = '../../../etc/passwd';
    writeFileSync(manifest, JSON.stringify(raw));
    assert.equal(verifyBackup(entry.dir).ok, false);
    assert.deepEqual(listBackups(f.deps.paths.stateDir), []);
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});

test('pruning keeps the three newest backups and never a protected one', () => {
  const f = fixture([]);
  try {
    const names = ['01', '02', '03', '04', '05'].map(
      (day) => createBackup(input(f, { now: new Date(`2026-11-${day}T10:00:00Z`) })).name,
    );
    const removed = pruneBackups(f.deps.paths.stateDir, 3, [names[0]!]);
    assert.deepEqual(removed, [names[1]]);
    assert.deepEqual(
      listBackups(f.deps.paths.stateDir).map((entry) => entry.name),
      [names[4], names[3], names[2], names[0]],
    );
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});
