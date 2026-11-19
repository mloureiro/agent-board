import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { isRecord } from '@agent-board/shared';
import { closeLog, openLog } from './logs.mts';
import type { Invocation, Supervision } from './plan.mts';

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  // Set when the watch stopped the run.
  stopped?: Exclude<Supervision, { kind: 'continue' }>;
}

// The worker's way to a running agent: its stdin.
export interface RunChannel {
  // Hands the agent a user message, which it takes up at its next tool boundary. False when stdin was closed already: nothing
  // was written.
  send: (text: string) => boolean;
  // Stops what the agent is doing at once; its session stays resumable, and a message sent after the interrupt carries the run on.
  interrupt: () => void;
  // Closes stdin: the agent exits once its turn is over. Nothing can be sent after that.
  end: () => void;
  // Interrupt, end, and kill the process if it is still there after the kill grace: what a stop decision does.
  stop: () => void;
  // Ends the agent's process group at once (SIGTERM, then SIGKILL after a grace), for an agent that outlives its closed stdin
  // with background work. False when the agent has already exited: nothing was signalled.
  kill: () => boolean;
  readonly open: boolean;
}

// Called every `everyMs` while the process runs; a stop decision interrupts it and closes its stdin, and kills it (SIGTERM, then
// SIGKILL) if it is still there `killGraceMs` later. A tick decides from the clock and the run's own files alone: the calls
// to the board it starts (liveness, transcript, inbox) run on their own, so a board that is slow, down or hostile cannot hold
// the run's limits back.
export interface Watch {
  everyMs: number;
  // Default: 30 seconds.
  killGraceMs?: number;
  // Called once the process runs, with the channel to it.
  start?: (channel: RunChannel) => void;
  // Called when the process has started, with its process group (it leads one).
  spawned?: (pgid: number) => void;
  tick: () => Promise<Supervision>;
  // Called when the agent's turn ends, with stdin still open: a string is sent as its next message and the run goes on;
  // undefined (or a failure) closes stdin, and the agent exits. Not called after an interrupt that was carried on with a message.
  onTurnEnd?: () => Promise<string | undefined>;
  // Called once the message `onTurnEnd` returned was written to the agent. It is not when the run ended meanwhile.
  turnMessageSent?: () => void;
}

// How long a stopped process has to exit on its own before it is killed.
const KILL_GRACE_MS = 30_000;
// How long what a finished run left in its process group has to end after SIGTERM before it is killed.
const GROUP_GRACE_MS = 10_000;
const GROUP_POLL_MS = 100;

// EPERM: the process exists but is not ours to signal.
function existsAfterKill(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
}

export const isProcessAlive = (pid: number): boolean => existsAfterKill(pid);
export const groupExists = (pgid: number): boolean => existsAfterKill(-pgid);

// Signals a whole process group; one that is gone is no error.
export function signalGroup(pgid: number | undefined, signal: NodeJS.Signals): void {
  try {
    if (pgid !== undefined) process.kill(-pgid, signal);
  } catch {
    // already gone
  }
}

// A user message as `claude --input-format stream-json` reads it.
const userMessageLine = (text: string): string =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;

const interruptLine = (): string =>
  `${JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })}\n`;

// Whether a line of the agent's output is the end of a turn.
function isResultLine(line: string): boolean {
  if (!line.includes('"result"')) return false;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) && parsed['type'] === 'result';
  } catch {
    return false;
  }
}

export function runProcess(
  invocation: Invocation,
  taskId: string,
  env: Record<string, string>,
  watch: Watch,
  onLine: (line: string) => string | undefined = (line) => line,
): Promise<RunResult> {
  const fd = openLog(taskId);
  return new Promise((resolve, reject) => {
    // A new process group, so a stop also ends what the worker started. stdout comes here, line by line; stderr goes
    // straight into the log.
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ['pipe', 'pipe', fd],
      detached: true,
      env: { ...process.env, ...env },
    });
    // A process that exits without reading its stdin must not take the worker down.
    child.stdin?.on('error', () => undefined);
    let ended = false;
    let exited = false;
    let killTimer: NodeJS.Timeout | undefined;
    // An interrupt is out and its turn has not ended yet; `carryOn`: a message was sent after it, so the run goes on.
    let interruptOut = false;
    let carryOn = false;
    const channel: RunChannel = {
      get open() {
        return !ended;
      },
      send(text) {
        if (ended) return false;
        child.stdin?.write(userMessageLine(text));
        if (interruptOut) carryOn = true;
        return true;
      },
      interrupt() {
        if (ended) return;
        child.stdin?.write(interruptLine());
        interruptOut = true;
      },
      end() {
        if (ended) return;
        ended = true;
        child.stdin?.end();
      },
      stop() {
        // The agent is asked to stop first, so that its session ends cleanly and stays resumable.
        channel.interrupt();
        channel.end();
        killTimer ??= setTimeout(terminate, watch.killGraceMs ?? KILL_GRACE_MS);
        killTimer.unref();
      },
      kill() {
        if (exited) return false;
        terminate();
        return true;
      },
    };
    // The prompt goes in on stdin, never in argv, and stdin stays open for what follows.
    child.stdin?.write(userMessageLine(invocation.prompt));
    let buffered = '';
    // `onTurnEnd` is out: a second result line (a user message got its own turn) leaves the answer to it.
    let turnEnding = false;
    const endTurn = async (): Promise<void> => {
      let next: string | undefined;
      try {
        next = await watch.onTurnEnd?.();
      } catch {
        next = undefined;
      }
      // A stop or the end of the process closed the channel meanwhile.
      if (ended) return;
      if (next !== undefined && channel.send(next)) watch.turnMessageSent?.();
      else channel.end();
    };
    const emit = (line: string): void => {
      const text = onLine(line);
      if (text !== undefined) writeSync(fd, `${text}\n`);
      // The turn is over and nothing is waiting to be written: close stdin, and the agent exits.
      if (!isResultLine(line)) return;
      if (interruptOut) {
        interruptOut = false;
        if (carryOn) {
          carryOn = false;
          return;
        }
      }
      if (watch.onTurnEnd === undefined) channel.end();
      else if (!turnEnding) {
        turnEnding = true;
        void endTurn().finally(() => {
          turnEnding = false;
        });
      }
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        emit(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    });
    let stopped: RunResult['stopped'];
    const killGroup = (signal: NodeJS.Signals): void => signalGroup(child.pid, signal);
    const terminate = (): void => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 10_000).unref();
    };
    // The agent is gone, and what it started in its group (a dev server, a watcher) goes with it: SIGTERM, then SIGKILL
    // once the grace is up. A process that started its own session is out of reach.
    const endGroup = async (): Promise<void> => {
      const { pid } = child;
      if (!pid || !groupExists(pid)) return;
      killGroup('SIGTERM');
      for (let waited = 0; waited < GROUP_GRACE_MS && groupExists(pid); waited += GROUP_POLL_MS)
        await new Promise((resolveWait) => setTimeout(resolveWait, GROUP_POLL_MS));
      killGroup('SIGKILL');
    };
    let checking = false;
    const timer = setInterval(() => {
      if (checking || stopped) return;
      checking = true;
      watch
        .tick()
        .then((decision) => {
          if (decision.kind === 'continue' || stopped) return;
          stopped = decision;
          channel.stop();
        })
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    }, watch.everyMs);
    // On a spawn failure both "error" and "close" fire.
    let finished = false;
    const finish = (): boolean => {
      if (finished) return false;
      finished = true;
      clearInterval(timer);
      clearTimeout(killTimer);
      ended = true;
      if (buffered !== '') emit(buffered);
      closeLog(fd);
      return true;
    };
    child.on('error', (error) => {
      if (!finish()) return;
      reject(new Error(`could not start ${invocation.command}: ${error.message}`));
    });
    // As soon as the agent has exited, not when its output closes: what it left may hold the pipe open.
    let ending: Promise<void> | undefined;
    child.on('exit', () => {
      exited = true;
      ending ??= endGroup();
    });
    child.on('close', (exitCode, signal) => {
      if (!finish()) return;
      void (ending ?? endGroup()).then(() => resolve(stopped ? { exitCode, signal, stopped } : { exitCode, signal }));
    });
    if (child.pid) watch.spawned?.(child.pid);
    watch.start?.(channel);
  });
}
