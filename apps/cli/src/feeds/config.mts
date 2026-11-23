import { isAgentName, isRecord, MAX_MACHINE_FEEDS, parseDuration } from '@agent-board/shared';
import { ConfigError, expandHome } from '../config/config.mts';
import { readConfigFile } from '../config/config-file.mts';
import { isActionName, parseIntegrationRef } from '../plugins/names.mts';

export interface FeedPrompts {
  new: string;
  update: string;
}

export interface FeedConfig {
  name: string;
  integration: string;
  action: string;
  options: Record<string, unknown>;
  everyMs: number;
  dir: string;
  agent?: string;
  lane?: string;
  timeoutMs: number;
  prompts: FeedPrompts;
}

export const FEED_KEYS = [
  'integration',
  'action',
  'options',
  'every',
  'dir',
  'agent',
  'lane',
  'timeout',
  'prompts',
] as const;
const PROMPT_KEYS = ['new', 'update'] as const;

export const FEED_NAME_RULE = '1 to 40 letters, digits, dots, dashes or underscores, starting with a letter or digit';
export const FEED_CAP_RULE = `the board shows at most ${MAX_MACHINE_FEEDS} feeds per machine`;
export const feedsBeyondCap = (count: number): string | undefined =>
  count > MAX_MACHINE_FEEDS
    ? `config.json has ${count} feeds; ${FEED_CAP_RULE}, so the rest are not shown there`
    : undefined;
export const isFeedName = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name);

export const MIN_EVERY_MS = 60_000;
export const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
export const MAX_OPTIONS_BYTES = 16 * 1024;
export const MAX_PROMPT_CHARS = 10_000;

function duration(value: unknown, where: string): number {
  if (typeof value !== 'string') throw new ConfigError(`config: ${where} must be a duration such as 10m`);
  try {
    return parseDuration(value);
  } catch (error) {
    throw new ConfigError(`config: ${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function integration(value: unknown, where: string): string {
  if (typeof value !== 'string')
    throw new ConfigError(`config: ${where}.integration must be <marketplace>:<integration>`);
  if (!value.includes(':'))
    throw new ConfigError(
      `config: ${where}.integration must name the plugin: <marketplace>:<integration>, see board plugins list`,
    );
  if (parseIntegrationRef(value) === undefined)
    throw new ConfigError(
      `config: ${where}.integration must be <marketplace>:<integration>, each 1 to 40 lowercase letters, digits or dashes`,
    );
  return value;
}

function options(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ConfigError(`config: ${where}.options must be an object`);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_OPTIONS_BYTES)
    throw new ConfigError(`config: ${where}.options must be at most ${MAX_OPTIONS_BYTES / 1024} KiB as JSON`);
  return value;
}

function prompts(value: unknown, where: string): FeedPrompts {
  if (!isRecord(value)) throw new ConfigError(`config: ${where}.prompts must be an object with new and update`);
  const unknown = Object.keys(value).find((key) => !PROMPT_KEYS.some((known) => known === key));
  if (unknown !== undefined)
    throw new ConfigError(
      `config: ${where}.prompts has no setting "${unknown.slice(0, 40)}" (it takes ${PROMPT_KEYS.join(', ')})`,
    );
  const text = (key: (typeof PROMPT_KEYS)[number]): string => {
    const prompt = value[key];
    if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > MAX_PROMPT_CHARS)
      throw new ConfigError(`config: ${where}.prompts.${key} must be text of 1 to ${MAX_PROMPT_CHARS} characters`);
    return prompt;
  };
  return { new: text('new'), update: text('update') };
}

export function parseFeed(name: string, entry: unknown): FeedConfig {
  const where = `feeds.${name}`;
  if (!isRecord(entry)) throw new ConfigError(`config: ${where} must be an object`);
  const gone = ['command', 'keyPrefix'].find((key) => Object.hasOwn(entry, key));
  if (gone !== undefined) throw new ConfigError(`config: ${where}.${gone} is gone: feeds take ${FEED_KEYS.join(', ')}`);
  const unknown = Object.keys(entry).find((key) => !FEED_KEYS.some((known) => known === key));
  if (unknown !== undefined)
    throw new ConfigError(
      `config: ${where} has no setting "${unknown.slice(0, 40)}" (it takes ${FEED_KEYS.join(', ')})`,
    );
  const { action, dir, agent, lane } = entry;
  const ref = integration(entry['integration'], where);
  if (typeof action !== 'string' || !isActionName(action))
    throw new ConfigError(
      `config: ${where}.action must be the name of an action: 1 to 64 lowercase letters, digits or dashes`,
    );
  const everyMs = duration(entry['every'], `${where}.every`);
  if (everyMs < MIN_EVERY_MS) throw new ConfigError(`config: ${where}.every must be at least 1m`);
  if (typeof dir !== 'string' || !expandHome(dir).startsWith('/'))
    throw new ConfigError(`config: ${where}.dir must be an absolute path (or ~/...)`);
  if (agent !== undefined && (typeof agent !== 'string' || !isAgentName(agent)))
    throw new ConfigError(`config: ${where}.agent must be the name of an agent`);
  if (lane !== undefined && (typeof lane !== 'string' || lane === ''))
    throw new ConfigError(`config: ${where}.lane must be the name of a lane`);
  const timeoutMs =
    entry['timeout'] === undefined ? DEFAULT_TIMEOUT_MS : duration(entry['timeout'], `${where}.timeout`);
  if (timeoutMs > MAX_TIMEOUT_MS) throw new ConfigError(`config: ${where}.timeout must be at most 30m`);
  return {
    name,
    integration: ref,
    action,
    options: options(entry['options'], where),
    everyMs,
    dir: expandHome(dir),
    ...(agent === undefined ? {} : { agent }),
    ...(lane === undefined ? {} : { lane }),
    timeoutMs,
    prompts: prompts(entry['prompts'], where),
  };
}

// One bad feed must not stop the others, nor the machine's other work: its error is kept by name, like a bad agent's.
export function parseFeeds(raw: unknown): { feeds: FeedConfig[]; feedErrors: Record<string, string> } {
  const feeds: FeedConfig[] = [];
  const feedErrors: Record<string, string> = {};
  if (raw === undefined) return { feeds, feedErrors };
  if (!isRecord(raw)) throw new ConfigError('config: feeds must be an object keyed by feed name');
  for (const [name, entry] of Object.entries(raw)) {
    try {
      if (!isFeedName(name))
        throw new ConfigError(`config: feed name "${name.slice(0, 40)}" must be ${FEED_NAME_RULE}`);
      feeds.push(parseFeed(name, entry));
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      feedErrors[name] = error.message;
    }
  }
  return { feeds, feedErrors };
}

export const feedProblemText = (message: string): string => message.replace(/^config: /, '');

// Read on every use, not once per process: the watch unit runs for days, and `board feeds add` must not need a restart.
export function loadFeeds(configFile: string): { feeds: FeedConfig[]; feedErrors: Record<string, string> } {
  return parseFeeds(readConfigFile(configFile).raw['feeds']);
}
