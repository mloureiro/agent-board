import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isSafeTaskId } from '@agent-board/shared';
import { requireTaskId, unitName } from '../task-id.mts';
import { selfCommand } from '../self/self.mts';

// How the system runs `systemctl` and `systemd-run`: resolves with stdout, rejects like `execFile` does (the error carries
// `stdout` when the command printed something before it failed).
export type RunCommand = (file: string, args: string[]) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);
const runCommand: RunCommand = (file, args) => execFileAsync(file, args);

export class SystemError extends Error {}

export interface System {
  isActive(unit: string): Promise<boolean>;
  // When the unit last became active; undefined if it is not loaded.
  startedAt(unit: string): Promise<Date | undefined>;
  // Task ids of the worker units that are running now.
  activeWorkers(): Promise<string[]>;
  stop(unit: string): Promise<void>;
  signalWorker(unit: string, signal: 'SIGUSR2'): Promise<void>;
  startWorker(taskId: string): Promise<{ pid: number | undefined }>;
}

const LIVE_STATES = ['active', 'activating', 'reloading', 'deactivating', 'refreshing'];
const GONE_STATES = ['inactive', 'failed'];

// Only a state systemd names counts as an answer. A broken bus or a missing binary prints nothing known,
// and must not read as "the unit is gone".
export function parseUnitState(stdout: string): boolean {
  const state = stdout.trim();
  if (LIVE_STATES.includes(state)) return true;
  if (GONE_STATES.includes(state)) return false;
  throw new SystemError(`systemctl gave no known unit state (got "${state.slice(0, 40)}")`);
}

// A worker unit is one startWorker made: systemd-run gives it the command line as its description, which ends in
// `internal worker <id>` for the same id the unit is named after. Any other agent-board-* unit (the tool's own, or
// one the user made) is not a worker and must not take a lane slot.
export function parseWorkerUnits(stdout: string): string[] {
  const taskIds: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*[●*]?\s*agent-board-([^\s.]+)\.service\s.*\sinternal worker (\S+)\s*$/.exec(line);
    if (match === null) continue;
    const [, id, describedId] = match;
    if (id === undefined || id !== describedId || !isSafeTaskId(id)) continue;
    taskIds.push(id);
  }
  return taskIds;
}

// `systemctl --timestamp=unix` prints "@<seconds>", or an empty value for a unit that never started.
export function parseUnixTimestamp(stdout: string): Date | undefined {
  const seconds = /^@(\d+)$/.exec(stdout.trim())?.[1];
  if (seconds === undefined || Number(seconds) === 0) return undefined;
  return new Date(Number(seconds) * 1000);
}

async function systemctl(run: RunCommand, args: string[]): Promise<string> {
  try {
    return (await run('systemctl', ['--user', ...args])).stdout;
  } catch (error) {
    // is-active exits non-zero for a unit that is not running but still prints its state.
    if (
      typeof error === 'object' &&
      error !== null &&
      'stdout' in error &&
      typeof error.stdout === 'string' &&
      error.stdout.trim() !== ''
    ) {
      return error.stdout;
    }
    throw new SystemError(
      `systemctl --user ${args[0]} failed: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`,
    );
  }
}

export function createSystem(input: { dryRun: boolean; print: (line: string) => void; run?: RunCommand }): System {
  const run = input.run ?? runCommand;
  return {
    async isActive(unit) {
      return parseUnitState(await systemctl(run, ['is-active', unit]));
    },
    async startedAt(unit) {
      return parseUnixTimestamp(
        await systemctl(run, ['--timestamp=unix', 'show', '--property=ActiveEnterTimestamp', '--value', unit]),
      );
    },
    async activeWorkers() {
      return parseWorkerUnits(
        await systemctl(run, [
          'list-units',
          'agent-board-*',
          '--type=service',
          '--state=active,activating,reloading,deactivating',
          '--plain',
          '--full',
          '--no-legend',
          '--no-pager',
        ]),
      );
    },
    async stop(unit) {
      if (input.dryRun) return input.print(`DRY systemctl --user stop ${unit}`);
      await run('systemctl', ['--user', 'stop', unit]).catch(() => undefined);
    },
    async signalWorker(unit, signal) {
      if (input.dryRun) return input.print(`DRY systemctl --user kill --kill-whom=main --signal=${signal} ${unit}`);
      // The agent runs in the unit's cgroup: the default `--kill-whom=all` would signal it too.
      await run('systemctl', ['--user', 'kill', '--kill-whom=main', `--signal=${signal}`, unit]).catch(() => undefined);
    },
    async startWorker(taskId) {
      // The id becomes a unit name and an argument, so only the safe shape goes in, whoever named it.
      requireTaskId(taskId, SystemError);
      const unit = unitName(taskId);
      // A transient unit does not inherit this environment, so pass on what the worker needs.
      const args = ['--user', '--quiet', '--collect', `--unit=${unit}`, '--setenv=PATH', '--setenv=HOME'];
      for (const name of [
        'AGENT_BOARD_CONFIG_DIR',
        'AGENT_BOARD_STATE_DIR',
        'AGENT_BOARD_RUN_DIR',
        'AGENT_BOARD_CREDENTIALS_COMMAND',
        'XDG_STATE_HOME',
        'XDG_RUNTIME_DIR',
      ]) {
        if (process.env[name]) args.push(`--setenv=${name}`);
      }
      args.push('--', ...selfCommand('internal', 'worker', taskId));
      if (input.dryRun) {
        input.print(`DRY systemd-run ${args.join(' ')}`);
        return { pid: undefined };
      }
      await run('systemd-run', args);
      const { stdout } = await run('systemctl', ['--user', 'show', '--property=MainPID', '--value', unit]).catch(
        () => ({
          stdout: '',
        }),
      );
      const pid = Number(stdout.trim());
      return { pid: pid > 0 ? pid : undefined };
    },
  };
}
