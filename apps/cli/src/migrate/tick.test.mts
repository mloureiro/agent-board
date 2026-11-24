import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { autoStep, fixture, personStep } from '../__tests__/helpers/migration.mts';
import type { Fixture } from '../__tests__/helpers/migration.mts';
import { listBackups } from './backup.mts';
import { readJournal } from './journal.mts';
import { lockPath, takeLock } from './lock.mts';
import { readMarker, writeMarker } from './marker.mts';
import type { MigrationStep } from './steps.mts';
import { runPendingMigration } from './tick.mts';
import type { TickMigrationRun } from './tick.mts';

function tick(registry: MigrationStep[], overrides: Partial<TickMigrationRun> = {}) {
  const f = fixture(registry);
  writeMarker(f.deps.paths.stateDir, '0.37.0');
  const logged: string[] = [];
  const run = (more: Partial<TickMigrationRun> = {}): Promise<Awaited<ReturnType<typeof runPendingMigration>>> =>
    runPendingMigration({
      deps: f.deps,
      activeWorkers: async () => 0,
      tickStart: f.clock.now,
      startWindowMs: 60_000,
      abortAtMs: 95_000,
      dryRun: false,
      log: (line) => logged.push(line),
      ...overrides,
      ...more,
    });
  return { f, logged, run };
}

const cleanup = (f: Fixture): void => rmSync(f.dir, { recursive: true });

test('an empty plan brings the marker up to date and the tick goes on', async () => {
  const { f, logged, run } = tick([]);
  try {
    assert.equal(await run(), 'none');
    assert.equal(readMarker(f.deps.paths.stateDir), '0.40.0');
    assert.deepEqual(logged, []);
    assert.equal(existsSync(join(f.deps.paths.stateDir, 'backups')), false);
    assert.equal(existsSync(lockPath(f.deps.paths.stateDir)), false);
  } finally {
    cleanup(f);
  }
});

test('steps a missing journal needs are backed up without a binary, run, and end the tick', async () => {
  const order: string[] = [];
  const { f, logged, run } = tick([
    autoStep('a', '0.38.0', async () => void order.push('a')),
    autoStep('b', '0.39.0', async () => void order.push('b')),
  ]);
  try {
    assert.equal(await run(), 'ran');
    assert.deepEqual(order, ['a', 'b']);
    assert.deepEqual(logged.slice(0, 2), ['MIGRATION ✓ title of a', 'MIGRATION ✓ title of b']);
    assert.equal(logged.at(-1), 'MIGRATION-DONE');
    assert.equal(listBackups(f.deps.paths.stateDir)[0]?.manifest.kind, 'steps');
    assert.equal(existsSync(join(listBackups(f.deps.paths.stateDir)[0]?.dir ?? '', 'board')), false);
    assert.equal(readJournal(f.deps.paths.stateDir), undefined);
    assert.equal(readMarker(f.deps.paths.stateDir), '0.40.0');
    assert.equal(f.restarts, 1);
    assert.equal(existsSync(lockPath(f.deps.paths.stateDir)), false);
  } finally {
    cleanup(f);
  }
});

test('running workers hold the migration back before anything is written', async () => {
  const { f, logged, run } = tick([autoStep('a', '0.38.0', async () => assert.fail('must not run'))]);
  try {
    assert.equal(await run({ activeWorkers: async () => 2 }), 'waiting');
    assert.deepEqual(logged, ['MIGRATION-WAIT 2 worker(s) running']);
    assert.equal(readJournal(f.deps.paths.stateDir), undefined);
    assert.equal(existsSync(join(f.deps.paths.stateDir, 'backups')), false);
    assert.equal(existsSync(lockPath(f.deps.paths.stateDir)), false);
  } finally {
    cleanup(f);
  }
});

test('a migration another process runs is left alone', async () => {
  const { f, logged, run } = tick([autoStep('a', '0.38.0', async () => assert.fail('must not run'))]);
  try {
    takeLock(f.deps.paths.stateDir, { adoptParent: false, pid: process.ppid });
    assert.equal(await run(), 'waiting');
    assert.match(logged[0] ?? '', /^MIGRATION-RUNNING/);
    assert.equal(readJournal(f.deps.paths.stateDir), undefined);
  } finally {
    cleanup(f);
  }
});

test('a lock left by a tick that was killed is replaced and the migration goes on', async () => {
  const { f, run } = tick([autoStep('a', '0.38.0')]);
  try {
    takeLock(f.deps.paths.stateDir, { adoptParent: false, pid: 2 ** 22 + 5, alive: () => true });
    assert.equal(await run(), 'ran');
    assert.equal(readMarker(f.deps.paths.stateDir), '0.40.0');
  } finally {
    cleanup(f);
  }
});

test('a failed step is logged and not tried again by the next tick', async () => {
  let runs = 0;
  const { f, logged, run } = tick([
    autoStep('a', '0.38.0', async () => {
      runs += 1;
      throw new Error('disk full');
    }),
  ]);
  try {
    assert.equal(await run(), 'stopped');
    assert.ok(logged.includes('MIGRATION-FAILED a: disk full; run "board self-update --resume"'));
    logged.length = 0;
    assert.equal(await run(), 'stopped');
    assert.deepEqual(logged, ['MIGRATION-FAILED a: disk full; run "board self-update --resume"']);
    assert.equal(runs, 1);
    assert.equal(existsSync(lockPath(f.deps.paths.stateDir)), false);
  } finally {
    cleanup(f);
  }
});

test('a step that needs a person blocks the tick until its check passes', async () => {
  let done = false;
  const { f, logged, run } = tick([personStep('by-hand', '0.38.0', async () => done), autoStep('after', '0.39.0')]);
  try {
    assert.equal(await run(), 'stopped');
    assert.ok(logged.includes('MIGRATION-BLOCKED by-hand: do by-hand by hand; run "board self-update --resume"'));
    done = true;
    assert.equal(await run(), 'ran');
    assert.equal(readMarker(f.deps.paths.stateDir), '0.40.0');
  } finally {
    cleanup(f);
  }
});

test('a tick that runs out of time stops before the next step, and the next tick continues from it', async () => {
  const order: string[] = [];
  const { f, logged, run } = tick([
    autoStep('a', '0.38.0', async () => {
      order.push('a');
      f.clock.now = new Date(f.clock.now.getTime() + 61_000);
    }),
    autoStep('b', '0.39.0', async () => void order.push('b')),
  ]);
  try {
    const started = f.clock.now;
    assert.equal(await run({ tickStart: started }), 'ran');
    assert.deepEqual(order, ['a']);
    assert.ok(logged.some((line) => line.startsWith('MIGRATION-OUT-OF-TIME')));
    assert.deepEqual(readJournal(f.deps.paths.stateDir)?.done, ['a']);
    assert.equal(readMarker(f.deps.paths.stateDir), '0.37.0');
    assert.equal(await run({ tickStart: f.clock.now }), 'ran');
    assert.deepEqual(order, ['a', 'b']);
    assert.equal(readMarker(f.deps.paths.stateDir), '0.40.0');
    assert.equal(listBackups(f.deps.paths.stateDir).length, 1);
  } finally {
    cleanup(f);
  }
});

test('a step is aborted once the tick is close to its limit', async () => {
  let aborted: boolean | undefined;
  const { f, run } = tick([
    autoStep('a', '0.38.0', async (context) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      aborted = context.signal.aborted;
    }),
  ]);
  try {
    await run({ abortAtMs: 0 });
    assert.equal(aborted, true);
  } finally {
    cleanup(f);
  }
});

test('a dry run says how many steps it would run and changes nothing', async () => {
  const { f, logged, run } = tick([autoStep('a', '0.38.0'), autoStep('b', '0.39.0')]);
  try {
    assert.equal(await run({ dryRun: true }), 'waiting');
    assert.deepEqual(logged, ['DRY migration 2 step(s)']);
    assert.deepEqual(readdirSync(f.deps.paths.stateDir).sort(), ['migration']);
    assert.equal(readMarker(f.deps.paths.stateDir), '0.37.0');
    assert.equal(f.restarts, 0);
  } finally {
    cleanup(f);
  }
});
