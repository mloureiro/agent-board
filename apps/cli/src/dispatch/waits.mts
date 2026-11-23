// The checks of waiting tasks on this machine. `board wait --check` writes one; the dispatcher runs it every `everyMs` until it
// passes, then wakes the task. The command never goes to the board: the board only knows that the task waits for a check and
// until when, so nothing on the board can make this machine run a command.
//   <state dir>/waits/<task>.json
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord, isSafeTaskId, isSafeWorkdir } from '@agent-board/shared';
import { getPaths } from '../config/config.mts';
import { readSettingsEnv } from '../worker/settings-env.mts';
import { requireTaskId } from '../task-id.mts';
import { errorText } from '../output/text.mts';

export interface WaitCheck {
  // A shell command (bash -c); exit 0 means the wait is over.
  command: string;
  // Where it runs: the agent's directory when it started the wait.
  cwd: string;
  // Whose `.claude` settings give it their `env`: the directory the run started in, whose settings Claude Code loaded (it does
  // not load others on a `cd`). Absent: `cwd`.
  settingsDir?: string;
  everyMs: number;
  createdAt: Date;
  // The last attempt, if any: when, its exit code (null: killed or timed out) and the end of its output.
  lastCheckAt?: Date;
  lastExit?: number | null;
  lastOutput?: string;
}

export interface WaitStore {
  write(taskId: string, check: WaitCheck): void;
  read(taskId: string): WaitCheck | undefined;
  remove(taskId: string): void;
  // Task ids with a check here.
  list(): string[];
}

export function createWaitStore(dir: string = getPaths().waitDir): WaitStore {
  const file = (taskId: string): string => {
    requireTaskId(taskId);
    return join(dir, `${taskId}.json`);
  };
  return {
    write(taskId, check) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        file(taskId),
        JSON.stringify({
          ...check,
          createdAt: check.createdAt.toISOString(),
          lastCheckAt: check.lastCheckAt?.toISOString(),
        }),
        { mode: 0o600 },
      );
    },
    read(taskId) {
      try {
        return parseWaitCheck(JSON.parse(readFileSync(file(taskId), 'utf8')));
      } catch {
        return undefined;
      }
    },
    remove(taskId) {
      rmSync(file(taskId), { force: true });
    },
    list() {
      try {
        return readdirSync(dir)
          .filter((name) => name.endsWith('.json'))
          .map((name) => name.slice(0, -'.json'.length))
          .filter((id) => isSafeTaskId(id));
      } catch {
        return [];
      }
    },
  };
}

function parseWaitCheck(raw: unknown): WaitCheck | undefined {
  if (!isRecord(raw)) return undefined;
  const { command, cwd, settingsDir, everyMs, createdAt, lastCheckAt, lastExit, lastOutput } = raw;
  if (typeof command !== 'string' || command.trim() === '') return undefined;
  if (typeof cwd !== 'string' || !isSafeWorkdir(cwd)) return undefined;
  if (typeof everyMs !== 'number' || !Number.isFinite(everyMs) || everyMs <= 0) return undefined;
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return undefined;
  const check: WaitCheck = { command, cwd, everyMs, createdAt: new Date(createdAt) };
  if (typeof settingsDir === 'string' && isSafeWorkdir(settingsDir)) check.settingsDir = settingsDir;
  if (typeof lastCheckAt === 'string' && !Number.isNaN(Date.parse(lastCheckAt)))
    check.lastCheckAt = new Date(lastCheckAt);
  if (typeof lastExit === 'number' || lastExit === null) check.lastExit = lastExit;
  if (typeof lastOutput === 'string') check.lastOutput = lastOutput;
  return check;
}

export interface CheckResult {
  // null: killed, or stopped after the time limit.
  exitCode: number | null;
  timedOut: boolean;
  // The end of stdout and stderr together.
  output: string;
}

export interface CommandResult extends CheckResult {
  // The end of each stream alone, for a command whose stdout is data (`gh ... --json`).
  stdout: string;
  stderr: string;
}

// One attempt may take this long; the dispatcher's tick has 110 seconds in all and leaves the checks to the next tick when
// fewer remain.
export const CHECK_TIME_LIMIT_MS = 45_000;
const OUTPUT_KEEP_CHARS = 2000;
// A `gh pr checks --json` list of a big PR is longer than an output worth keeping.
const STREAM_KEEP_CHARS = 200_000;

export interface CommandSpec {
  command: string;
  cwd: string;
  // See WaitCheck.
  settingsDir?: string;
  timeLimitMs?: number;
  // Text the child reads on stdin, which is then closed; absent, the child reads end of input at once.
  stdin?: string;
  // Replaces the PATH of this process's environment; the settings `env` still goes on top.
  path?: string;
  // Aborting kills the process group at once; the result is the one of a killed command.
  signal?: AbortSignal;
}

/**
 * Runs a shell command as the agent would have: in its directory, with the `env` of the user's and the run's Claude Code
 * settings on top of this environment (tokens such as GH_TOKEN or CIRCLECI_TOKEN usually live there). After the time limit its
 * whole process group is killed.
 */
export function runCommand(spec: CommandSpec, home: string = homedir()): Promise<CommandResult> {
  const { command, cwd, settingsDir, timeLimitMs = CHECK_TIME_LIMIT_MS, signal, stdin, path } = spec;
  const env = {
    ...process.env,
    ...(path === undefined ? {} : { PATH: path }),
    ...readSettingsEnv(home),
    ...readSettingsEnv(settingsDir ?? cwd),
  };
  return new Promise((resolve) => {
    let output = '';
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const finish = (exitCode: number | null, extra = ''): CommandResult => ({
      exitCode,
      timedOut,
      output: `${output}${extra}`.slice(-OUTPUT_KEEP_CHARS),
      stdout,
      stderr: `${stderr}${extra}`.slice(-STREAM_KEEP_CHARS),
    });
    let child;
    try {
      child = spawn('bash', ['-c', command], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      output = errorText(error);
      stderr = output;
      resolve(finish(null));
      return;
    }
    // A child that exits without reading closes the pipe; that is its answer, not an error of ours.
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
    const killGroup = (): void => {
      // The whole process group: a check that started children must not leave them behind.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeLimitMs);
    const onAbort = (): void => killGroup();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const settle = (result: CommandResult): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-OUTPUT_KEEP_CHARS);
      stdout = (stdout + text).slice(-STREAM_KEEP_CHARS);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-OUTPUT_KEEP_CHARS);
      stderr = (stderr + text).slice(-STREAM_KEEP_CHARS);
    });
    child.on('error', (error) => settle(finish(null, error.message)));
    child.on('close', (code) => settle(finish(timedOut ? null : code)));
  });
}

/** `runCommand` for a stored check, whose time limit is a parameter. */
export async function runCheck(
  check: WaitCheck,
  home: string = homedir(),
  timeLimitMs: number = CHECK_TIME_LIMIT_MS,
): Promise<CheckResult> {
  const { exitCode, timedOut, output } = await runCommand(
    {
      command: check.command,
      cwd: check.cwd,
      timeLimitMs,
      ...(check.settingsDir === undefined ? {} : { settingsDir: check.settingsDir }),
    },
    home,
  );
  return { exitCode, timedOut, output };
}
