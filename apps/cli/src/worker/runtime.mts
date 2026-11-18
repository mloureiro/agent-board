// Per-task files of a run on this machine, shared by the dispatcher, the worker and the agent's hook:
//   <task>.run    which lane runs it, whether borrowed, since when (written by the dispatcher at the start)
//   <task>.alive  touched by the hook on every tool call: its mtime is the agent's last sign of life
//   <task>.pause  present while the dispatcher asks the run to give up its slot
//   <task>.shutdown  the deadline (ISO time) of a machine shutdown that asked the worker to end the run
//   <task>.cwd    the agent's working directory at its last tool call (it may have entered a worktree)
//   <task>.agents the definition of the agent the run is, for `claude --agents` (mode 0600)
//   <task>.pgid   the process group of the claude process (written by the worker), which a stop signals as well as the worker's
// and two of the dispatcher's own, not a task's:
//   dispatch.tick  its mtime is when the last dispatch tick started
//   dispatch.next  when something this machine waits for is next due (ISO time), written at the end of a tick; the listener
//                  starts a tick then
// They live in $XDG_RUNTIME_DIR, private to the user, apart from any checkout; without one, in <state dir>/run on macOS.
// On macOS the process supervisor (setup/process-system.mts) also keeps <task>.pid here.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, isSafeWorkdir } from '@agent-board/shared';
import { getPaths } from '../config/config.mts';

export interface RunRecord {
  lane: string;
  borrowed: boolean;
  startedAt: Date;
}

export interface RunFiles {
  dir: string;
  writeRun(taskId: string, record: RunRecord): void;
  readRun(taskId: string): RunRecord | undefined;
  // When the agent last made a tool call; undefined before its first one.
  lastActive(taskId: string): Date | undefined;
  touchAlive(taskId: string, at?: Date): void;
  writeCwd(taskId: string, cwd: string): void;
  lastCwd(taskId: string): string | undefined;
  // Where the agent definition of the task's run is written.
  agentsPath(taskId: string): string;
  writeAgents(taskId: string, content: string): void;
  // The process group claude runs in; undefined before it started or when the file holds anything else.
  writeProcessGroup(taskId: string, pgid: number): void;
  processGroup(taskId: string): number | undefined;
  // The dispatcher's own marker, not a task's: when its last tick started.
  lastDispatchTick(): Date | undefined;
  markDispatchTick(at: Date): void;
  // When the next tick is due, as the last tick saw it; undefined when nothing is waiting or no tick wrote it.
  nextDue(): Date | undefined;
  // Undefined removes it.
  writeNextDue(at: Date | undefined): void;
  requestPause(taskId: string): void;
  // When the pause was asked for; undefined when it was not.
  pauseRequestedAt(taskId: string): Date | undefined;
  requestShutdown(taskId: string, deadline: Date): void;
  shutdownDeadline(taskId: string): Date | undefined;
  // All of the task's files: the run is over.
  clear(taskId: string): void;
}

// macOS has no runtime directory, so without XDG_RUNTIME_DIR the run files go under the state directory (created with
// mode 700, see ensureRunDir). Nothing clears it at reboot: a stale .pid fails its identity check, a stale .run is cleared at the next start.
export function runDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (env['AGENT_BOARD_RUN_DIR']) return env['AGENT_BOARD_RUN_DIR'];
  if (env['XDG_RUNTIME_DIR']) return join(env['XDG_RUNTIME_DIR'], 'agent-board');
  if (platform === 'darwin') return join(getPaths(env).stateDir, 'run');
  return join(`/run/user/${process.getuid?.() ?? 0}`, 'agent-board');
}

// The directory of a dispatch tick's lock. On Linux it is the runtime directory itself, where the timer's unit keeps the
// same file (%t); on macOS it is the run directory, which no other user can write (the shared /tmp must not hold a lock).
export function lockDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (platform === 'darwin') return runDir(env, platform);
  return env['XDG_RUNTIME_DIR'] || '/tmp';
}

export function ensureRunDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function mtime(path: string): Date | undefined {
  return statSync(path, { throwIfNoEntry: false })?.mtime;
}

export function createRunFiles(dir: string = runDir()): RunFiles {
  const path = (taskId: string, kind: 'run' | 'alive' | 'pause' | 'shutdown' | 'cwd' | 'agents' | 'pgid'): string =>
    join(dir, `${taskId}.${kind}`);
  const ensureDir = (): void => ensureRunDir(dir);
  return {
    dir,
    writeRun(taskId, record) {
      ensureDir();
      writeFileSync(path(taskId, 'run'), JSON.stringify({ ...record, startedAt: record.startedAt.toISOString() }), {
        mode: 0o600,
      });
    },
    readRun(taskId) {
      try {
        const raw: unknown = JSON.parse(readFileSync(path(taskId, 'run'), 'utf8'));
        if (
          !isRecord(raw) ||
          typeof raw['lane'] !== 'string' ||
          typeof raw['borrowed'] !== 'boolean' ||
          typeof raw['startedAt'] !== 'string'
        )
          return undefined;
        return { lane: raw['lane'], borrowed: raw['borrowed'], startedAt: new Date(raw['startedAt']) };
      } catch {
        return undefined;
      }
    },
    lastActive: (taskId) => mtime(path(taskId, 'alive')),
    touchAlive(taskId, at = new Date()) {
      ensureDir();
      const file = path(taskId, 'alive');
      try {
        utimesSync(file, at, at);
      } catch {
        writeFileSync(file, '', { mode: 0o600 });
        utimesSync(file, at, at);
      }
    },
    writeCwd(taskId, cwd) {
      ensureDir();
      writeFileSync(path(taskId, 'cwd'), cwd, { mode: 0o600 });
    },
    lastCwd(taskId) {
      try {
        const cwd = readFileSync(path(taskId, 'cwd'), 'utf8').trim();
        return isSafeWorkdir(cwd) ? cwd : undefined;
      } catch {
        return undefined;
      }
    },
    agentsPath: (taskId) => path(taskId, 'agents'),
    writeAgents(taskId, content) {
      ensureDir();
      writeFileSync(path(taskId, 'agents'), content, { mode: 0o600 });
    },
    writeProcessGroup(taskId, pgid) {
      ensureDir();
      writeFileSync(path(taskId, 'pgid'), String(pgid), { mode: 0o600 });
    },
    processGroup(taskId) {
      try {
        const pgid = Number(readFileSync(path(taskId, 'pgid'), 'utf8').trim());
        return Number.isInteger(pgid) && pgid > 1 ? pgid : undefined;
      } catch {
        return undefined;
      }
    },
    lastDispatchTick: () => mtime(join(dir, 'dispatch.tick')),
    markDispatchTick(at) {
      ensureDir();
      const file = join(dir, 'dispatch.tick');
      writeFileSync(file, '', { mode: 0o600 });
      utimesSync(file, at, at);
    },
    nextDue() {
      try {
        const at = new Date(readFileSync(join(dir, 'dispatch.next'), 'utf8').trim());
        return Number.isNaN(at.getTime()) ? undefined : at;
      } catch {
        return undefined;
      }
    },
    writeNextDue(at) {
      const file = join(dir, 'dispatch.next');
      if (at === undefined) {
        rmSync(file, { force: true });
        return;
      }
      ensureDir();
      // The listener reads it at any time: it sees the old file or the new one, never half of one.
      const temp = `${file}.${process.pid}`;
      writeFileSync(temp, at.toISOString(), { mode: 0o600 });
      renameSync(temp, file);
    },
    requestPause(taskId) {
      ensureDir();
      writeFileSync(path(taskId, 'pause'), '', { mode: 0o600, flag: 'wx' });
    },
    pauseRequestedAt: (taskId) => mtime(path(taskId, 'pause')),
    requestShutdown(taskId, deadline) {
      ensureDir();
      writeFileSync(path(taskId, 'shutdown'), deadline.toISOString(), { mode: 0o600 });
    },
    shutdownDeadline(taskId) {
      try {
        const deadline = new Date(readFileSync(path(taskId, 'shutdown'), 'utf8').trim());
        return Number.isNaN(deadline.getTime()) ? undefined : deadline;
      } catch {
        return undefined;
      }
    },
    clear(taskId) {
      for (const kind of ['run', 'alive', 'pause', 'shutdown', 'cwd', 'agents', 'pgid'] as const)
        rmSync(path(taskId, kind), { force: true });
    },
  };
}
