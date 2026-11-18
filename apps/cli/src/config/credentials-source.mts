import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ConfigError } from './config-error.mts';
import { loadEnvFile, parseEnv } from './env-file.mts';

export const CREDENTIALS_COMMAND_VARIABLE = 'AGENT_BOARD_CREDENTIALS_COMMAND';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SECRET_PREFIX = /abk1_|abm_/;

export interface CredentialsSource {
  values: Record<string, string>;
  // The command that produced the values, or the env file they were read from.
  from: string;
  viaCommand: boolean;
}

export interface CredentialsOptions {
  timeoutMs?: number;
}

export function credentialsCommandOf(env: Record<string, string | undefined>): string | undefined {
  const value = env[CREDENTIALS_COMMAND_VARIABLE];
  return value === undefined || value === '' ? undefined : value;
}

function firstStderrLine(stderr: string): string {
  const line = stderr.split('\n').find((candidate) => candidate.trim() !== '');
  if (line === undefined) return '';
  return SECRET_PREFIX.test(line) ? '(withheld)' : line.trim();
}

function describeFailure(command: string, status: number | null, stderr: string): string {
  const detail = firstStderrLine(stderr);
  return `${CREDENTIALS_COMMAND_VARIABLE} ${command} exited with code ${status ?? 'unknown'}${detail === '' ? '' : `: ${detail}`}`;
}

export function runCredentialsCommand(command: string, options: CredentialsOptions = {}): Record<string, string> {
  if (!isAbsolute(command)) throw new ConfigError(`${CREDENTIALS_COMMAND_VARIABLE} must be an absolute path`);
  try {
    accessSync(command, constants.X_OK);
  } catch {
    throw new ConfigError(`${CREDENTIALS_COMMAND_VARIABLE} is not an executable file: ${command}`);
  }
  const result = spawnSync(command, [], {
    shell: false,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') throw new ConfigError(`${CREDENTIALS_COMMAND_VARIABLE} ${command} timed out`);
    throw new ConfigError(`${CREDENTIALS_COMMAND_VARIABLE} ${command} could not run${code ? ` (${code})` : ''}`);
  }
  if (result.status !== 0) throw new ConfigError(describeFailure(command, result.status, result.stderr));
  const values = parseEnv(result.stdout);
  for (const name of ['AGENT_BOARD_TOKEN', 'AGENT_BOARD_DATA_KEY']) {
    if (!values[name]) throw new ConfigError(`${CREDENTIALS_COMMAND_VARIABLE} ${command} printed no ${name}`);
  }
  return values;
}

// One source: the command when the variable is set, otherwise <configDir>/env. They are never merged.
export function loadCredentials(
  configDir: string,
  env: Record<string, string | undefined>,
  options: CredentialsOptions = {},
): CredentialsSource {
  const command = credentialsCommandOf(env);
  if (command !== undefined)
    return { values: runCredentialsCommand(command, options), from: command, viaCommand: true };
  const path = join(configDir, 'env');
  return { values: loadEnvFile(path), from: path, viaCommand: false };
}
