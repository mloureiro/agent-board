import { homedir } from 'node:os';
import { LISTEN_STOP_TIMEOUT_S, TICK_GRACE_S, TICK_LIMIT_S, lockFileName } from '../dispatch/tick.mts';
import { lockDir } from '../worker/runtime.mts';
import { PASSED_ENV } from './launchd.mts';

export const WORKER_UNITS_SCHEMA = 1;

export const DISPATCH_UNIT = {
  name: 'dispatch',
  kind: 'tick',
  everySeconds: 120,
  limitSeconds: TICK_LIMIT_S,
  graceSeconds: TICK_GRACE_S,
  lockFile: lockFileName('dispatch'),
  // `lockf -t 0` and `flock -E 75` both exit 75 when another tick holds the lock.
  lockHeldExitCode: 75,
} as const;

export const LISTEN_UNIT = {
  name: 'listen',
  kind: 'service',
  restartDelaySeconds: 10,
  stopTimeoutSeconds: LISTEN_STOP_TIMEOUT_S,
} as const;

export const WATCH_UNIT = { name: 'watch', kind: 'service', restartDelaySeconds: 5 } as const;

export function lockArgv(platform: string, lockProgram: string, lockPath: string): string[] {
  if (platform === 'darwin') return [lockProgram, '-s', '-t', '0', lockPath];
  return [lockProgram, '-n', '-E', String(DISPATCH_UNIT.lockHeldExitCode), lockPath];
}

// The lock program the listener runs its own ticks under: lockf ships with macOS, flock is on PATH on Linux.
export function tickArgv(env: Record<string, string | undefined>, dispatch: string[], platform: string): string[] {
  const lock = `${lockDir(env, platform)}/${DISPATCH_UNIT.lockFile}`;
  return [...lockArgv(platform, platform === 'darwin' ? '/usr/bin/lockf' : 'flock', lock), ...dispatch];
}

// What a unit finds `claude`, `gh` and `systemd-run` on. launchd gives a job /usr/bin:/bin:/usr/sbin:/sbin and a plist
// expands nothing, so a home directory is written out; systemd expands %h itself.
export function workerPath(platform: string, home: string): string {
  if (platform === 'darwin') {
    return `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  }
  return `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`;
}

export interface TickWorkerUnit {
  name: 'dispatch';
  kind: 'tick';
  program: string;
  args: string[];
  everySeconds: number;
  limitSeconds: number;
  graceSeconds: number;
  lockHeldExitCode: number;
}

export interface ServiceWorkerUnit {
  name: 'listen' | 'watch';
  kind: 'service';
  program: string;
  args: string[];
  restartDelaySeconds: number;
  stopTimeoutSeconds?: number;
}

export interface ResolvedWorkerUnits {
  schema: typeof WORKER_UNITS_SCHEMA;
  platform: string;
  path: string;
  passedVariables: string[];
  units: [TickWorkerUnit, ServiceWorkerUnit, ServiceWorkerUnit];
}

const split = (argv: string[]): { program: string; args: string[] } => {
  const [program = '', ...args] = argv;
  return { program, args };
};

// What `board setup` writes for this platform, resolved from `env` alone: no config, no credentials.
export function resolvedWorkerUnits(
  env: Record<string, string | undefined>,
  platform: string,
  command: (name: 'dispatch' | 'listen' | 'watch') => string[],
): ResolvedWorkerUnits {
  return {
    schema: WORKER_UNITS_SCHEMA,
    platform,
    path: workerPath(platform, env['HOME'] || homedir()),
    passedVariables: [...PASSED_ENV],
    units: [
      {
        name: DISPATCH_UNIT.name,
        kind: DISPATCH_UNIT.kind,
        ...split(tickArgv(env, command('dispatch'), platform)),
        everySeconds: DISPATCH_UNIT.everySeconds,
        limitSeconds: DISPATCH_UNIT.limitSeconds,
        graceSeconds: DISPATCH_UNIT.graceSeconds,
        lockHeldExitCode: DISPATCH_UNIT.lockHeldExitCode,
      },
      {
        name: LISTEN_UNIT.name,
        kind: LISTEN_UNIT.kind,
        ...split(command('listen')),
        restartDelaySeconds: LISTEN_UNIT.restartDelaySeconds,
        stopTimeoutSeconds: LISTEN_UNIT.stopTimeoutSeconds,
      },
      {
        name: WATCH_UNIT.name,
        kind: WATCH_UNIT.kind,
        ...split(command('watch')),
        restartDelaySeconds: WATCH_UNIT.restartDelaySeconds,
      },
    ],
  };
}
