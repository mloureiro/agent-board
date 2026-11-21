import { isAgentName, isRecord, parseDuration } from '@agent-board/shared';
import { ConfigError, expandHome } from '../config/config.mts';
import { readConfigFile } from '../config/config-file.mts';

// A command this machine runs on its own timer, whose output lists the items that should each have a task (see items.mts).
export interface SourceConfig {
  name: string;
  // Run with `bash -c` in `dir`, like a command watch.
  command: string;
  everyMs: number;
  // Where the command runs, and where an item without a `dir` of its own makes its task.
  dir: string;
  // Put in front of every item's key, so two sources that list the same thing keep apart tasks.
  keyPrefix: string;
  agent?: string;
  lane?: string;
  timeoutMs: number;
}

export const SOURCE_KEYS = ['command', 'every', 'dir', 'keyPrefix', 'agent', 'lane', 'timeout'] as const;

export const SOURCE_NAME_RULE = '1 to 40 letters, digits, dots, dashes or underscores, starting with a letter or digit';
export const isSourceName = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name);

export const MIN_EVERY_MS = 60_000;
export const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_KEY_PREFIX = 100;

function duration(value: unknown, where: string): number {
  if (typeof value !== 'string') throw new ConfigError(`config: ${where} must be a duration such as 10m`);
  try {
    return parseDuration(value);
  } catch (error) {
    throw new ConfigError(`config: ${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseSource(name: string, entry: unknown): SourceConfig {
  const where = `sources.${name}`;
  if (!isRecord(entry)) throw new ConfigError(`config: ${where} must be an object`);
  const unknown = Object.keys(entry).find((key) => !SOURCE_KEYS.some((known) => known === key));
  if (unknown !== undefined)
    throw new ConfigError(
      `config: ${where} has no setting "${unknown.slice(0, 40)}" (it takes ${SOURCE_KEYS.join(', ')})`,
    );
  const { command, dir, keyPrefix, agent, lane } = entry;
  if (typeof command !== 'string' || command.trim() === '')
    throw new ConfigError(`config: ${where}.command must be a shell command`);
  const everyMs = duration(entry['every'], `${where}.every`);
  if (everyMs < MIN_EVERY_MS) throw new ConfigError(`config: ${where}.every must be at least 1m`);
  if (typeof dir !== 'string' || !expandHome(dir).startsWith('/'))
    throw new ConfigError(`config: ${where}.dir must be an absolute path (or ~/...)`);
  if (keyPrefix !== undefined && (typeof keyPrefix !== 'string' || keyPrefix.length > MAX_KEY_PREFIX))
    throw new ConfigError(`config: ${where}.keyPrefix must be text of at most ${MAX_KEY_PREFIX} characters`);
  if (agent !== undefined && (typeof agent !== 'string' || !isAgentName(agent)))
    throw new ConfigError(`config: ${where}.agent must be the name of an agent`);
  if (lane !== undefined && (typeof lane !== 'string' || lane === ''))
    throw new ConfigError(`config: ${where}.lane must be the name of a lane`);
  const timeoutMs =
    entry['timeout'] === undefined ? DEFAULT_TIMEOUT_MS : duration(entry['timeout'], `${where}.timeout`);
  if (timeoutMs > MAX_TIMEOUT_MS) throw new ConfigError(`config: ${where}.timeout must be at most 30m`);
  return {
    name,
    command,
    everyMs,
    dir: expandHome(dir),
    keyPrefix: keyPrefix ?? `source:${name}:`,
    ...(agent === undefined ? {} : { agent }),
    ...(lane === undefined ? {} : { lane }),
    timeoutMs,
  };
}

// One bad source must not stop the others, nor the machine's other work: its error is kept by name, like a bad agent's.
export function parseSources(raw: unknown): { sources: SourceConfig[]; sourceErrors: Record<string, string> } {
  const sources: SourceConfig[] = [];
  const sourceErrors: Record<string, string> = {};
  if (raw === undefined) return { sources, sourceErrors };
  if (!isRecord(raw)) throw new ConfigError('config: sources must be an object keyed by source name');
  for (const [name, entry] of Object.entries(raw)) {
    try {
      if (!isSourceName(name))
        throw new ConfigError(`config: source name "${name.slice(0, 40)}" must be ${SOURCE_NAME_RULE}`);
      sources.push(parseSource(name, entry));
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      sourceErrors[name] = error.message;
    }
  }
  return { sources, sourceErrors };
}

// Read on every use, not once per process: the watch unit runs for days, and `board sources add` must not need a restart.
export function loadSources(configFile: string): { sources: SourceConfig[]; sourceErrors: Record<string, string> } {
  return parseSources(readConfigFile(configFile).raw['sources']);
}
