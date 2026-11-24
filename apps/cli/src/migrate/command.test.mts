import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { autoStep, fixture } from '../__tests__/helpers/migration.mts';
import { UsageError } from '../cli.mts';
import { runBoard } from '../commands/program.mts';
import { readMarker, writeMarker } from './marker.mts';

test('board self-update --resume with nothing pending says so', async () => {
  const f = fixture([]);
  const out: string[] = [];
  try {
    await runBoard(['self-update', '--resume'], {
      env: f.deps.env,
      writeOut: (text) => out.push(text),
      version: '0.40.0',
      interactive: false,
      platform: 'linux',
      migrationSteps: [],
    });
    assert.equal(out.join(''), 'nothing to resume\n');
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});

test('board self-update --resume runs the pending steps and restarts the listener', async () => {
  const f = fixture([]);
  const out: string[] = [];
  const ran: string[] = [];
  try {
    writeMarker(f.deps.paths.stateDir, '0.38.0');
    await runBoard(['self-update', '--resume'], {
      env: f.deps.env,
      writeOut: (text) => out.push(text),
      version: '0.40.0',
      interactive: false,
      platform: 'linux',
      migrationSteps: [autoStep('a', '0.39.0', async () => void ran.push('a'))],
      restartListener: async () => 'restarted the listener',
    });
    assert.deepEqual(ran, ['a']);
    assert.equal(readMarker(f.deps.paths.stateDir), '0.40.0');
    assert.match(out.join(''), /✓ title of a\nrestarted the listener\nmigration done; the backup stays at /);
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});

test('board self-update --resume exits non-zero when a step fails', async () => {
  const f = fixture([]);
  try {
    writeMarker(f.deps.paths.stateDir, '0.38.0');
    await assert.rejects(
      runBoard(['self-update', '--resume'], {
        env: f.deps.env,
        writeOut: () => undefined,
        version: '0.40.0',
        interactive: false,
        platform: 'linux',
        migrationSteps: [
          autoStep('a', '0.39.0', async () => {
            throw new Error('boom');
          }),
        ],
      }),
      /migration stopped/,
    );
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});

test('board self-update --resume with --check is a usage error', async () => {
  const f = fixture([]);
  try {
    await assert.rejects(
      runBoard(['self-update', '--resume', '--check'], { env: f.deps.env, writeOut: () => undefined }),
      UsageError,
    );
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});

test('board internal migration-plan prints the steps this binary would apply against the marker', async () => {
  const f = fixture([]);
  const out: string[] = [];
  try {
    writeMarker(f.deps.paths.stateDir, '0.38.0');
    await runBoard(['internal', 'migration-plan', '--json'], {
      env: f.deps.env,
      writeOut: (text) => out.push(text),
      version: '0.40.0',
      migrationSteps: [autoStep('old', '0.38.0'), autoStep('new', '0.39.0')],
    });
    assert.deepEqual(JSON.parse(out.join('')), {
      from: '0.38.0',
      to: '0.40.0',
      steps: [{ id: 'new', since: '0.39.0', title: 'title of new', kind: 'auto' }],
    });
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});

test('board self-update --rollback cannot be combined with --check or --resume', async () => {
  const f = fixture([]);
  try {
    for (const other of ['--check', '--resume'])
      await assert.rejects(
        runBoard(['self-update', '--rollback', other], {
          env: f.deps.env,
          writeOut: () => undefined,
          version: '0.40.0',
          interactive: false,
          platform: 'linux',
        }),
        UsageError,
      );
  } finally {
    rmSync(f.dir, { recursive: true });
  }
});
