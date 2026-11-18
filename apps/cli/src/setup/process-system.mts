/**
 * The worker supervisor for a system without systemd (macOS): each run is a detached `board internal worker <id>`
 * process, tracked by files in the run directory.
 *   <task>.pid    {pid, startedAt} of the worker, written by startWorker
 *   <task>.pgid   the agent's process group, written by the worker (see RunFiles)
 * A pid alone proves nothing (it can be reused), so a worker counts as running only while the process with that pid has
 * a command line that ends in `internal worker <id>`, the same identity test parseWorkerUnits applies to a unit.
 */
import { execFile, spawn } from 'node:child_process';
import { closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isRecord, isSafeTaskId } from '@agent-board/shared';
import { requireTaskId, UNIT_PREFIX } from '../task-id.mts';
import { selfCommand } from '../self/self.mts';
import { openLog } from '../worker/logs.mts';
import { groupExists, isProcessAlive, signalGroup } from '../worker/process.mts';
import { createRunFiles, ensureRunDir, runDir } from '../worker/runtime.mts';
import { SystemError } from './system.mts';
import type { System } from './system.mts';

const exec = promisify(execFile);

const PID_SUFFIX = '.pid';
const DEFAULT_GRACE_MS = 10_000;
const POLL_MS = 100;

// What a transient systemd unit would get from `--setenv`, plus the variables a login session has that a unit's manager
// provides on its own: the worker and its agent need them, and nothing else of the dispatcher's environment.
const PASSED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'SSH_AUTH_SOCK',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'AGENT_BOARD_CONFIG_DIR',
  'AGENT_BOARD_STATE_DIR',
  'AGENT_BOARD_RUN_DIR',
  'AGENT_BOARD_CREDENTIALS_COMMAND',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
];

export interface ProcessSystemOptions {
  dryRun: boolean;
  print: (line: string) => void;
  // Where the .pid files live; default: the run directory.
  dir?: string;
  env?: NodeJS.ProcessEnv;
  // How long a stopped group has to end after SIGTERM before it gets SIGKILL.
  graceMs?: number;
  // The command that runs a worker; default: this CLI's `internal worker <id>`.
  command?: (taskId: string) => string[];
  // The file descriptor the worker's output goes to; default: the task's log.
  openLog?: (taskId: string) => number;
}

interface PidRecord {
  pid: number;
  startedAt: Date;
}

// Whether a command line is that of a worker for this task: `<program> [<script>] internal worker <id>`.
export function isWorkerCommand(command: string, taskId: string): boolean {
  return command.trim().endsWith(` internal worker ${taskId}`);
}

// The task id of a unit name startWorker's callers use (agent-board-<id>).
export function taskIdOfUnit(unit: string): string {
  if (!unit.startsWith(UNIT_PREFIX)) throw new SystemError(`"${unit.slice(0, 40)}" is not a worker unit`);
  const taskId = unit.slice(UNIT_PREFIX.length);
  requireTaskId(taskId, SystemError);
  return taskId;
}

// `ps` exits 1 for a pid that is not there; any other failure (no ps, a broken environment) says nothing about the process and
// throws, so the tick stops instead of clearing the file of a worker that may be running.
async function commandOf(pid: number): Promise<string | undefined> {
  try {
    return (await exec('ps', ['-ww', '-o', 'command=', '-p', String(pid)])).stdout.trim() || undefined;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) return undefined;
    throw new SystemError(`ps failed: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createProcessSystem(options: ProcessSystemOptions): System {
  const { dryRun, print } = options;
  const env = options.env ?? process.env;
  const dir = options.dir ?? runDir(env);
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const pidFile = (taskId: string): string => join(dir, `${taskId}${PID_SUFFIX}`);
  const files = createRunFiles(dir);

  const readRecord = (taskId: string): PidRecord | undefined => {
    try {
      const raw: unknown = JSON.parse(readFileSync(pidFile(taskId), 'utf8'));
      if (!isRecord(raw) || typeof raw['pid'] !== 'number' || typeof raw['startedAt'] !== 'string') return undefined;
      const { pid } = raw;
      const startedAt = new Date(raw['startedAt']);
      return Number.isInteger(pid) && pid > 1 && !Number.isNaN(startedAt.getTime()) ? { pid, startedAt } : undefined;
    } catch {
      return undefined;
    }
  };

  const forget = (taskId: string): void => {
    if (dryRun) return;
    rmSync(pidFile(taskId), { force: true });
    rmSync(join(dir, `${taskId}.pgid`), { force: true });
  };

  // The worker's record while it runs; a record of a gone process or of another command is cleared.
  const running = async (taskId: string): Promise<PidRecord | undefined> => {
    const record = readRecord(taskId);
    if (record === undefined) return undefined;
    const command = isProcessAlive(record.pid) ? await commandOf(record.pid) : undefined;
    if (command !== undefined && isWorkerCommand(command, taskId)) return record;
    forget(taskId);
    return undefined;
  };

  return {
    async isActive(unit) {
      return (await running(taskIdOfUnit(unit))) !== undefined;
    },
    async startedAt(unit) {
      return (await running(taskIdOfUnit(unit)))?.startedAt;
    },
    async activeWorkers() {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      const taskIds = names
        .filter((name) => name.endsWith(PID_SUFFIX))
        .map((name) => name.slice(0, name.length - PID_SUFFIX.length))
        .filter((taskId) => isSafeTaskId(taskId));
      const active = await Promise.all(taskIds.map(async (taskId) => ((await running(taskId)) ? taskId : undefined)));
      return active.filter((taskId) => taskId !== undefined);
    },
    async stop(unit) {
      const taskId = taskIdOfUnit(unit);
      if (dryRun) return print(`DRY stop the process groups of worker ${taskId}`);
      const record = await running(taskId);
      if (record === undefined) return;
      // The worker's own group, and the agent's, which a worker that dies without cleaning up leaves behind. The agent's
      // group is only signalled while the worker is the verified one: a group id recorded by a dead worker may be reused.
      const agent = files.processGroup(taskId);
      const groups = [...new Set([record.pid, ...(agent === undefined ? [] : [agent])])];
      for (const pgid of groups) signalGroup(pgid, 'SIGTERM');
      for (let waited = 0; waited < graceMs && groups.some(groupExists); waited += POLL_MS) await sleep(POLL_MS);
      for (const pgid of groups) if (groupExists(pgid)) signalGroup(pgid, 'SIGKILL');
      forget(taskId);
    },
    async signalWorker(unit, signal) {
      const taskId = taskIdOfUnit(unit);
      if (dryRun) return print(`DRY send ${signal} to worker ${taskId}`);
      const record = await running(taskId);
      if (record === undefined) return;
      try {
        process.kill(record.pid, signal);
      } catch {
        // gone since the identity check
      }
    },
    async startWorker(taskId) {
      // The id becomes a file name and an argument, so only the safe shape goes in, whoever named it.
      requireTaskId(taskId, SystemError);
      const [program, ...args] = (options.command ?? ((id) => selfCommand('internal', 'worker', id)))(taskId);
      if (program === undefined) throw new SystemError('no worker command');
      if (dryRun) {
        print(`DRY spawn detached ${[program, ...args].join(' ')}`);
        return { pid: undefined };
      }
      ensureRunDir(dir);
      rmSync(join(dir, `${taskId}.pgid`), { force: true });
      const passed: NodeJS.ProcessEnv = {};
      for (const name of PASSED_ENV) if (env[name]) passed[name] = env[name];
      const fd = (options.openLog ?? ((id) => openLog(id)))(taskId);
      try {
        const child = spawn(program, args, {
          detached: true,
          stdio: ['ignore', fd, fd],
          env: passed,
          cwd: env['HOME'] || homedir(),
        });
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', (error) => reject(new SystemError(`could not start ${program}: ${error.message}`)));
        });
        const { pid } = child;
        if (pid === undefined) throw new SystemError(`could not start ${program}`);
        child.unref();
        writeFileSync(pidFile(taskId), JSON.stringify({ pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
        return { pid };
      } finally {
        closeSync(fd);
      }
    },
  };
}
