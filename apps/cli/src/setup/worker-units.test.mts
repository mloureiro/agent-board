import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvedWorkerUnits } from './worker-units.mts';
import type { ResolvedWorkerUnits } from './worker-units.mts';

const command = (name: string): string[] => ['/opt/board/board', 'internal', name];

const PASSED = [
  'AGENT_BOARD_CONFIG_DIR',
  'AGENT_BOARD_STATE_DIR',
  'AGENT_BOARD_RUN_DIR',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
];

const expected = (platform: string, path: string, lock: string[], lockPath: string): ResolvedWorkerUnits => ({
  schema: 1,
  platform,
  path,
  passedVariables: PASSED,
  units: [
    {
      name: 'dispatch',
      kind: 'tick',
      program: lock[0] ?? '',
      args: [...lock.slice(1), lockPath, '/opt/board/board', 'internal', 'dispatch'],
      everySeconds: 120,
      limitSeconds: 110,
      graceSeconds: 10,
      lockHeldExitCode: 75,
    },
    {
      name: 'listen',
      kind: 'service',
      program: '/opt/board/board',
      args: ['internal', 'listen'],
      restartDelaySeconds: 10,
      stopTimeoutSeconds: 130,
    },
    {
      name: 'watch',
      kind: 'service',
      program: '/opt/board/board',
      args: ['internal', 'watch'],
      restartDelaySeconds: 5,
    },
  ],
});

const LOCKF = ['/usr/bin/lockf', '-s', '-t', '0'];
const FLOCK = ['flock', '-n', '-E', '75'];
const DARWIN_PATH = '/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const LINUX_PATH = '/home/me/.local/bin:/usr/local/bin:/usr/bin:/bin';

const cases: { name: string; env: Record<string, string>; platform: string; want: ResolvedWorkerUnits }[] = [
  {
    name: 'darwin with AGENT_BOARD_RUN_DIR',
    env: { HOME: '/Users/me', AGENT_BOARD_RUN_DIR: '/r' },
    platform: 'darwin',
    want: expected('darwin', DARWIN_PATH, LOCKF, '/r/agent-board-dispatch.lock'),
  },
  {
    name: 'darwin without it, the run directory is under the state directory',
    env: { HOME: '/Users/me', AGENT_BOARD_STATE_DIR: '/state' },
    platform: 'darwin',
    want: expected('darwin', DARWIN_PATH, LOCKF, '/state/run/agent-board-dispatch.lock'),
  },
  {
    name: 'linux with XDG_RUNTIME_DIR',
    env: { HOME: '/home/me', XDG_RUNTIME_DIR: '/run/user/1000' },
    platform: 'linux',
    want: expected('linux', LINUX_PATH, FLOCK, '/run/user/1000/agent-board-dispatch.lock'),
  },
  {
    name: 'linux without it, the lock is in /tmp',
    env: { HOME: '/home/me' },
    platform: 'linux',
    want: expected('linux', LINUX_PATH, FLOCK, '/tmp/agent-board-dispatch.lock'),
  },
];

for (const { name, env, platform, want } of cases)
  test(`resolvedWorkerUnits: ${name}`, () => {
    assert.deepEqual(resolvedWorkerUnits(env, platform, command), want);
  });
