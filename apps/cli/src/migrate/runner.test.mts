import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { autoStep, fixture, personStep } from '../__tests__/helpers/migration.mts';
import type { Fixture } from '../__tests__/helpers/migration.mts';
import { readJournal, journalPath } from './journal.mts';
import { readMarker } from './marker.mts';
import { pendingMigration } from './pending.mts';
import { runMigration } from './runner.mts';
import type { MigrationStep } from './steps.mts';

function start(registry: MigrationStep[], overrides?: Parameters<typeof fixture>[1]): Fixture {
  const f = fixture(registry, overrides);
  assert.ok(pendingMigration(f.deps));
  return f;
}

const cleanup = (f: Fixture): void => rmSync(f.dir, { recursive: true });

test('runs every step in order, writes the marker, deletes the journal and restarts once', async () => {
  const order: string[] = [];
  const f = start([
    autoStep('second', '0.39.0', async () => void order.push('second')),
    autoStep('first', '0.38.0', async () => void order.push('first')),
  ]);
  try {
    assert.equal(await runMigration(f.deps, { interactive: false }), 'done');
    assert.deepEqual(order, ['first', 'second']);
    assert.equal(readMarker(f.deps.paths.stateDir), '0.40.0');
    assert.equal(existsSync(journalPath(f.deps.paths.stateDir)), false);
    assert.equal(f.restarts, 1);
    assert.deepEqual(
      f.printed.filter((line) => line.startsWith('✓')),
      ['✓ title of first', '✓ title of second'],
    );
    assert.match(f.printed.at(-1) ?? '', /^migration done; the backup stays at .*steps-0\.37\.0-0\.40\.0$/);
  } finally {
    cleanup(f);
  }
});

test('a failing step stops there and --resume runs it and the rest', async () => {
  const ran: string[] = [];
  let broken = true;
  const f = start([
    autoStep('one', '0.38.0', async () => void ran.push('one')),
    autoStep('two', '0.39.0', async () => {
      if (broken) throw new Error('disk full');
      ran.push('two');
    }),
    autoStep('three', '0.40.0', async () => void ran.push('three')),
  ]);
  try {
    assert.equal(await runMigration(f.deps, { interactive: false }), 'stopped');
    assert.deepEqual(ran, ['one']);
    const stopped = readJournal(f.deps.paths.stateDir);
    assert.deepEqual(stopped?.done, ['one']);
    assert.equal(stopped?.stopped?.id, 'two');
    assert.equal(stopped?.stopped?.reason, 'failed');
    assert.equal(stopped?.stopped?.message, 'disk full');
    assert.ok(f.printed.includes('migration stopped at two (title of two): disk full'));
    assert.equal(readMarker(f.deps.paths.stateDir), undefined);
    assert.equal(f.restarts, 0);

    broken = false;
    assert.equal(await runMigration(f.deps, { interactive: false }), 'done');
    assert.deepEqual(ran, ['one', 'two', 'three']);
    assert.equal(readMarker(f.deps.paths.stateDir), '0.40.0');
  } finally {
    cleanup(f);
  }
});

test('an interactive person step continues when confirmed and stops as needs-person when declined', async () => {
  const f = start([personStep('by-hand', '0.38.0'), autoStep('after', '0.39.0')]);
  try {
    f.answers.push(false);
    assert.equal(await runMigration(f.deps, { interactive: true }), 'stopped');
    assert.ok(f.printed.includes('do by-hand by hand'));
    assert.ok(f.printed.some((line) => /^migration stopped at by-hand .*run "board self-update --resume"/.test(line)));
    assert.equal(readJournal(f.deps.paths.stateDir)?.stopped?.reason, 'needs-person');
    f.answers.push(true);
    assert.equal(await runMigration(f.deps, { interactive: true }), 'done');
    assert.equal(readJournal(f.deps.paths.stateDir), undefined);
  } finally {
    cleanup(f);
  }
});

test('an interactive person step whose check still fails stops as needs-person', async () => {
  const f = start([personStep('by-hand', '0.38.0', async () => false)]);
  try {
    f.answers.push(true);
    assert.equal(await runMigration(f.deps, { interactive: true }), 'stopped');
    assert.equal(readJournal(f.deps.paths.stateDir)?.stopped?.reason, 'needs-person');
    assert.ok(f.printed.includes('by-hand is not done yet: its check still fails'));
    assert.ok(f.printed.some((line) => /^migration stopped at by-hand .*run "board self-update --resume"/.test(line)));
  } finally {
    cleanup(f);
  }
});

test('a person step without a terminal stops with the instruction, and continues once its check passes', async () => {
  let done = false;
  const f = start([personStep('by-hand', '0.38.0', async () => done), autoStep('after', '0.39.0')]);
  try {
    assert.equal(await runMigration(f.deps, { interactive: false }), 'stopped');
    assert.ok(f.printed.includes('do by-hand by hand'));
    assert.ok(f.printed.some((line) => line.includes('board self-update --resume')));
    assert.equal(readJournal(f.deps.paths.stateDir)?.stopped?.id, 'by-hand');
    done = true;
    assert.equal(await runMigration(f.deps, { interactive: false }), 'done');
  } finally {
    cleanup(f);
  }
});

test('a person step without a check and without a terminal always stops', async () => {
  const f = start([personStep('by-hand', '0.38.0')]);
  try {
    assert.equal(await runMigration(f.deps, { interactive: false }), 'stopped');
    assert.equal(await runMigration(f.deps, { interactive: false }), 'stopped');
  } finally {
    cleanup(f);
  }
});

test('a deadline that has passed returns out-of-time before the next step and leaves the journal', async () => {
  const ran: string[] = [];
  const f = start([
    autoStep('one', '0.38.0', async () => {
      ran.push('one');
      f.clock.now = new Date(f.clock.now.getTime() + 61_000);
    }),
    autoStep('two', '0.39.0', async () => void ran.push('two')),
  ]);
  try {
    const deadline = f.clock.now.getTime() + 60_000;
    assert.equal(await runMigration(f.deps, { interactive: false, deadline }), 'out-of-time');
    assert.deepEqual(ran, ['one']);
    const journal = readJournal(f.deps.paths.stateDir);
    assert.deepEqual(journal?.done, ['one']);
    assert.equal(journal?.stopped, undefined);
  } finally {
    cleanup(f);
  }
});

test('a step that reports unitsChanged triggers one daemon-reload on Linux and none elsewhere', async () => {
  const changed = async (): Promise<{ unitsChanged: true }> => ({ unitsChanged: true });
  const linux = start([autoStep('a', '0.38.0', changed), autoStep('b', '0.39.0', changed)]);
  const mac = start([autoStep('a', '0.38.0', changed)], { platform: 'darwin' });
  try {
    await runMigration(linux.deps, { interactive: false });
    assert.deepEqual(linux.runs, [['systemctl', '--user', 'daemon-reload']]);
    await runMigration(mac.deps, { interactive: false });
    assert.deepEqual(mac.runs, []);
  } finally {
    cleanup(linux);
    cleanup(mac);
  }
});

test('a daemon-reload is still owed when a later step stops the run', async () => {
  const f = start([
    autoStep('a', '0.38.0', async () => ({ unitsChanged: true })),
    autoStep('b', '0.39.0', async () => {
      throw new Error('nope');
    }),
  ]);
  try {
    assert.equal(await runMigration(f.deps, { interactive: false }), 'stopped');
    assert.deepEqual(f.runs, [['systemctl', '--user', 'daemon-reload']]);
  } finally {
    cleanup(f);
  }
});

test('a journal naming a step this binary does not have stops as failed', async () => {
  const f = start([autoStep('known', '0.38.0')]);
  try {
    const other = fixture([], { paths: f.deps.paths });
    assert.equal(await runMigration(other.deps, { interactive: false }), 'stopped');
    assert.equal(readJournal(f.deps.paths.stateDir)?.stopped?.reason, 'failed');
    rmSync(other.dir, { recursive: true });
  } finally {
    cleanup(f);
  }
});
