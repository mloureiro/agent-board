import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  AGENT_NAME_RULE,
  DIR_LABEL_RULE,
  isAgentName,
  isModelName,
  isPriority,
  isRecord,
  isSafeDirLabel,
  isSafeMachineName,
  MACHINE_NAME_RULE,
  PRIORITIES,
  isSafeWorkdir,
  isStringList,
} from '@agent-board/shared';
import type { Priority } from '@agent-board/shared';

import { MAX_IGNORE_CHARS, MAX_IGNORE_PATTERNS, parseIgnorePatterns } from '../watch/shapes.mts';
import { ConfigError } from './config-error.mts';
import { parseAgentDocument } from './agent-document.mts';

export { ConfigError };

// A task that runs as this agent (Claude Code's `--agents` and `--agent`), unattended: only its tools, and only what its
// lists allow. Everything in it is checked when the config loads, since a typo in a deny list must not fail open.
export interface AgentConfig {
  // Claude Code requires one.
  description: string;
  // The agent's system prompt.
  prompt?: string;
  // The tool names the agent has, such as "Read" or "Bash". Rules with arguments belong in allowedTools.
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  // Variables the worker copies from the working directory's .claude/settings.json and settings.local.json into the run.
  env: string[];
  // MCP servers of the working directory's .mcp.json the run gets (with `--mcp-config`).
  mcpServers: string[];
  model?: string;
  // Metadata of a shared definition: its version, and where `board agents add` got it from. Neither changes a run.
  version?: string;
  source?: string;
}

// What the board's agent definitions are on this machine: the version applied last, and the file of each agent of it.
export interface BoardAgents {
  version: number | null;
  // Every name the board holds, the agents that did not parse here included.
  names: string[];
  files: Record<string, string>;
}

// Slots of one kind of work on this machine. A lane runs its own work first (the tasks that name it, `requestedLane`) and
// borrows any other work when it has none; it takes its slot back by pausing borrowed work once its own work waits. The
// default lane owns the tasks that name no lane, or one this machine does not have.
export interface Lane {
  name: string;
  slots: number;
  default: boolean;
  // Where its tasks run when they have no directory of their own and their prompt names no PR of a known repo.
  cwd?: string;
}

// What a machine does when its CLI is behind the board: "incompatible" updates when the board refuses this CLI,
// "always" also when a newer release exists and no worker runs, "never" leaves it to the user.
export const AUTO_UPDATES = ['incompatible', 'always', 'never'] as const;
export type AutoUpdate = (typeof AUTO_UPDATES)[number];
const isAutoUpdate = (value: unknown): value is AutoUpdate => AUTO_UPDATES.some((mode) => mode === value);

// A directory workers may run in, as listed in config.json under `dirs`, with its optional settings.
export interface DirEntry {
  path: string;
  // Shown with the path in the New task form; sent to the board.
  label?: string;
  // `owner/name`: the directory is the checkout of that repository, like a `repos` entry.
  repo?: string;
  // Tasks without a directory of their own run here, like `defaultCwd`.
  default?: true;
  // A lane of this config: its tasks without a directory run here, like the lane's `cwd`.
  lane?: string;
  // Check-name patterns a `board watch --ci` started here leaves out (see isIgnorePattern); stays on this machine.
  ciIgnore?: string[];
}

// The settings of a `dirs` entry, in the order the CLI writes and lists them.
export const DIR_SETTINGS = ['label', 'repo', 'default', 'lane', 'ciIgnore'] as const;
export type DirSetting = (typeof DIR_SETTINGS)[number];

export const MAX_DIRS = 200;

// Thresholds on the Claude subscription's usage. While a window is at or over its threshold, Todo tasks below `priority` are
// not started here. A window without a number is not limited.
export interface UsageLimits {
  fiveHour?: number;
  sevenDay?: number;
  // The lowest priority that still starts while a threshold is reached.
  priority: Priority;
}

export const USAGE_LIMIT_KEYS = ['fiveHour', 'sevenDay', 'priority'] as const;
// `low` is the lowest priority, so holding everything below it would hold nothing.
const HOLD_PRIORITIES: readonly Priority[] = PRIORITIES.filter((priority) => priority !== 'low');

export interface Config {
  // This machine's name on the board: it claims tasks under it, and a resume runs only on the machine that ran the session.
  machine: string;
  // In config order; exactly one is the default lane.
  lanes: Lane[];
  // Where a task without a directory of its own runs (one created in the UI).
  defaultCwd: string;
  // A borrowed run is paused for its lane's own work only after it has run this long.
  pauseAfterMinutes: number;
  // A run whose agent made no tool call for this long is stopped as stuck.
  inactivityMinutes: number;
  // A run is stopped after this long however busy it is: a guard against runaways.
  maxRunHours: number;
  autoUpdate: AutoUpdate;
  // By name; empty when config.json has no `agents` key.
  agents: Record<string, AgentConfig>;
  // Why an `agents` entry could not be read, by name. One bad agent must not stop the machine's other work, so it is not a
  // config error; a task that names it fails closed, and doctor and dispatch report it.
  agentErrors: Record<string, string>;
  // The agents that come from a file of the agents/ directory, by name: the file's path. The rest are from config.json or the board.
  agentFiles?: Record<string, string>;
  // The agents the board holds for every machine (agents.board/), as this machine last applied them.
  board?: BoardAgents;
  repos: Record<string, string>;
  // Undefined when config.json has no `usageLimits` key: nothing is held back for usage.
  usageLimits?: UsageLimits;
  // The directories workers may run in, in config order; undefined when config.json has no `dirs` key, which is not the
  // same as an empty list: a list that is present will allow only what it names.
  dirs?: DirEntry[];
}

export interface Paths {
  configDir: string;
  configFile: string;
  logDir: string;
  // Per-task records of the Claude sessions this machine started (see sessions.mts).
  sessionDir: string;
  // The checks of waiting tasks this machine runs (see waits.mts).
  waitDir: string;
  // What the machine learned of each directory's skills and models (see catalog/cache.mts).
  catalogDir: string;
  // The watches of tasks on this machine, their event spool and the watch unit's heartbeat (see watch/store.mts).
  watchDir: string;
  // Small state files of the CLI itself, such as when it last offered an update.
  stateDir: string;
}

export function getPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const configDir = env['AGENT_BOARD_CONFIG_DIR'] ?? join(homedir(), '.config', 'agent-board');
  const stateDir =
    env['AGENT_BOARD_STATE_DIR'] ?? join(env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state'), 'agent-board');
  return {
    configDir,
    configFile: join(configDir, 'config.json'),
    logDir: join(stateDir, 'logs'),
    sessionDir: join(stateDir, 'sessions'),
    waitDir: join(stateDir, 'waits'),
    catalogDir: join(stateDir, 'catalog'),
    watchDir: join(stateDir, 'watches'),
    stateDir,
  };
}

export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path;
}

// The path a `dirs` key names: `~` expanded, `.` and `..` and a trailing slash resolved away.
export function dirKeyPath(key: string): string | undefined {
  const expanded = expandHome(key);
  return isSafeWorkdir(expanded) ? resolve(expanded) : undefined;
}

export const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/** What is wrong with `value` as the setting `key` of a directory, or undefined when it is fine. `lanes` are the names the config has. */
export function dirSettingProblem(key: DirSetting, value: unknown, lanes: readonly string[]): string | undefined {
  switch (key) {
    case 'label':
      return typeof value === 'string' && isSafeDirLabel(value) ? undefined : `must be a label of ${DIR_LABEL_RULE}`;
    case 'repo':
      return typeof value === 'string' && REPO_PATTERN.test(value) ? undefined : 'must look like owner/name';
    case 'default':
      return value === true ? undefined : 'must be true (leave the key out for no default)';
    case 'lane':
      return typeof value === 'string' && lanes.includes(value)
        ? undefined
        : `must name a lane of this config (${lanes.join(', ')})`;
    case 'ciIgnore': {
      const patterns = parseIgnorePatterns(value);
      return patterns !== undefined && patterns.length > 0
        ? undefined
        : `must be a list of 1 to ${MAX_IGNORE_PATTERNS} check names (${MAX_IGNORE_CHARS} characters at most, no control characters; * stands for any characters)`;
    }
  }
}

const isDirSetting = (key: string): key is DirSetting => DIR_SETTINGS.some((setting) => setting === key);

function parseDirs(raw: unknown, lanes: readonly string[]): DirEntry[] | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new ConfigError('config: dirs must be an object keyed by directory');
  if (Object.keys(raw).length > MAX_DIRS) throw new ConfigError(`config: dirs lists more than ${MAX_DIRS} directories`);
  const seen = new Map<string, string>();
  const entries = Object.entries(raw).map(([key, settings]): DirEntry => {
    const shown = JSON.stringify(key.slice(0, 100));
    const path = dirKeyPath(key);
    if (path === undefined) throw new ConfigError(`config: dirs key ${shown} must be an absolute path (or ~/...)`);
    if (!isRecord(settings)) throw new ConfigError(`config: dirs[${shown}] must be an object`);
    const unknown = Object.keys(settings).find((name) => !isDirSetting(name));
    if (unknown !== undefined)
      throw new ConfigError(
        `config: dirs[${shown}] has no setting "${unknown.slice(0, 40)}" (it takes ${DIR_SETTINGS.join(', ')})`,
      );
    const other = seen.get(path);
    if (other !== undefined)
      throw new ConfigError(
        `config: dirs lists ${shown} and ${JSON.stringify(other.slice(0, 100))}, the same directory`,
      );
    seen.set(path, key);
    const entry: DirEntry = { path };
    for (const setting of DIR_SETTINGS) {
      const value = settings[setting];
      if (value === undefined) continue;
      const problem = dirSettingProblem(setting, typeof value === 'string' ? value.trim() : value, lanes);
      if (problem !== undefined) throw new ConfigError(`config: dirs[${shown}].${setting} ${problem}`);
      if (setting === 'default') entry.default = true;
      else if (setting === 'ciIgnore') entry.ciIgnore = parseIgnorePatterns(value) ?? [];
      else entry[setting] = String(value).trim();
    }
    return entry;
  });
  for (const setting of ['repo', 'default', 'lane'] as const) {
    const owners = new Map<string, DirEntry>();
    for (const entry of entries) {
      const value = entry[setting];
      if (value === undefined) continue;
      const name = String(value);
      const first = owners.get(name);
      if (first !== undefined)
        throw new ConfigError(
          setting === 'default'
            ? `config: dirs[${JSON.stringify(first.path)}] and dirs[${JSON.stringify(entry.path)}] are both the default directory; one directory has it`
            : `config: dirs[${JSON.stringify(first.path)}] and dirs[${JSON.stringify(entry.path)}] both set ${setting} "${name.slice(0, 80)}"; one directory has it`,
        );
      owners.set(name, entry);
    }
  }
  return entries;
}

function positiveInt(obj: Record<string, unknown>, key: string, where: string, fallback: number): number {
  if (!(key in obj)) return fallback;
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(`config: ${where}${key} must be a positive integer`);
  }
  return value;
}

function parseUsageLimits(raw: unknown): UsageLimits | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new ConfigError('config: usageLimits must be an object');
  const percent = (key: 'fiveHour' | 'sevenDay'): number | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100)
      throw new ConfigError(`config: usageLimits.${key} must be a whole percent from 1 to 100`);
    return value;
  };
  const priority = raw['priority'] ?? 'urgent';
  if (priority === 'low')
    throw new ConfigError(
      'config: usageLimits.priority must not be low: low is the lowest priority, so nothing would be held. Use urgent, high or normal',
    );
  if (typeof priority !== 'string' || !isPriority(priority) || !HOLD_PRIORITIES.includes(priority))
    throw new ConfigError(`config: usageLimits.priority must be one of ${HOLD_PRIORITIES.join(', ')}`);
  const fiveHour = percent('fiveHour');
  const sevenDay = percent('sevenDay');
  return {
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(sevenDay === undefined ? {} : { sevenDay }),
    priority,
  };
}

export const DEFAULT_LANES: Lane[] = [{ name: 'general', slots: 3, default: true }];

/** The lane of `lanes` that owns tasks naming no lane; a config has exactly one. */
export function defaultLane(lanes: readonly Lane[]): Lane {
  return lanes.find((lane) => lane.default) ?? lanes[0] ?? DEFAULT_LANES[0]!;
}

const hasLegacyWildcard = (entry: unknown): boolean =>
  isRecord(entry) && Array.isArray(entry['skills']) && entry['skills'].includes('*');

// Which lane is the default: the one marked `default`. With none marked, the lane with a legacy "*" in its `skills` is the
// default, else the first lane, so a config of the earlier release keeps loading and one can move the mark between lanes.
function defaultLaneName(entries: [string, Record<string, unknown>][]): string {
  const marked = entries.filter(([, entry]) => entry['default'] === true).map(([name]) => name);
  if (marked.length > 1)
    throw new ConfigError(`config: lanes ${marked.join(', ')} are all marked default; exactly one lane is`);
  if (marked[0] !== undefined) return marked[0];
  const wildcard = entries.filter(([, entry]) => hasLegacyWildcard(entry)).map(([name]) => name);
  if (wildcard.length > 1)
    throw new ConfigError(`config: "*" is in lanes ${wildcard.join(', ')}; mark exactly one lane default instead`);
  return wildcard[0] ?? entries[0]![0];
}

function parseLanes(raw: unknown): Lane[] {
  if (raw === undefined) return DEFAULT_LANES;
  if (!isRecord(raw) || Object.keys(raw).length === 0)
    throw new ConfigError('config: lanes must be an object with at least one lane');
  const entries = Object.entries(raw).map(([name, entry]): [string, Record<string, unknown>] => {
    if (!isSafeMachineName(name))
      throw new ConfigError(`config: lane name "${name.slice(0, 40)}" must be ${MACHINE_NAME_RULE}`);
    if (!isRecord(entry)) throw new ConfigError(`config: lanes.${name} must be an object`);
    if ('default' in entry && typeof entry['default'] !== 'boolean')
      throw new ConfigError(`config: lanes.${name}.default must be true or false`);
    return [name, entry];
  });
  const defaultName = defaultLaneName(entries);
  return entries.map(([name, entry]): Lane => {
    const where = `lanes.${name}.`;
    const cwd = entry['cwd'];
    if (cwd !== undefined && (typeof cwd !== 'string' || !expandHome(cwd).startsWith('/')))
      throw new ConfigError(`config: ${where}cwd must be an absolute path (or ~/...)`);
    return {
      name,
      slots: positiveInt(entry, 'slots', where, 1),
      default: name === defaultName,
      ...(cwd === undefined ? {} : { cwd: expandHome(cwd) }),
    };
  });
}

// The keys of one `agents` entry. Unlike the rest of config.json an unknown one is an error: a misspelt deny list would
// leave the agent with no deny list.
export const AGENT_KEYS = [
  'description',
  'prompt',
  'tools',
  'allowedTools',
  'disallowedTools',
  'mcpServers',
  'env',
  'model',
  'version',
  'source',
] as const;

// A tool name, not a rule: arguments (`Bash(git status)`) belong in allowedTools.
const isToolName = (tool: string): boolean => /^[A-Za-z][A-Za-z0-9_:.*-]*$/.test(tool);

/**
 * One agent definition, checked strictly. `file` names the agents/ file it came from, for the messages; without it the
 * definition is `agents.<name>` of config.json.
 */
export function parseAgent(name: string, entry: unknown, file?: string): AgentConfig {
  const at = (key: string): string => (file === undefined ? `config: agents.${name}.${key}` : `${file}: ${key}`);
  const whole = file ?? `config: agents.${name}`;
  if (!isRecord(entry)) throw new ConfigError(`${whole} must be an object`);
  for (const key of Object.keys(entry)) {
    if (AGENT_KEYS.some((known) => known === key)) continue;
    const near = nearestKey(key, AGENT_KEYS);
    throw new ConfigError(
      `${whole} has no key "${key.slice(0, 40)}"${near === undefined ? `; it takes ${AGENT_KEYS.join(', ')}` : `; did you mean "${near}"?`}`,
    );
  }
  const description = entry['description'];
  if (typeof description !== 'string' || description.trim() === '')
    throw new ConfigError(`${at('description')} must be a non-empty string`);
  const prompt = entry['prompt'];
  if (prompt !== undefined && typeof prompt !== 'string') throw new ConfigError(`${at('prompt')} must be a string`);
  const model = entry['model'];
  if (model !== undefined && (typeof model !== 'string' || !isModelName(model)))
    throw new ConfigError(`${at('model')} must be a model name`);
  const metadata: Pick<AgentConfig, 'version' | 'source'> = {};
  for (const key of ['version', 'source'] as const) {
    const value = entry[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 2000 || [...value].some((char) => char < ' ' || char === '\x7f'))
      throw new ConfigError(`${at(key)} must be one line of text`);
    metadata[key] = value;
  }
  const list = (key: string): string[] => {
    const value = entry[key] ?? [];
    if (!isStringList(value)) throw new ConfigError(`${at(key)} must be a list of strings`);
    return value;
  };
  const tools = list('tools');
  if (tools.length === 0) throw new ConfigError(`${at('tools')} must be a non-empty list of tool names`);
  const badTool = tools.find((tool) => !isToolName(tool));
  if (badTool !== undefined)
    throw new ConfigError(
      `${at('tools')} names "${badTool.slice(0, 40)}", which is not a tool name; rules with arguments belong in allowedTools`,
    );
  const allowedTools = list('allowedTools');
  const disallowedTools = list('disallowedTools');
  const badRule = [...allowedTools, ...disallowedTools].find((rule) => rule.trim() === '' || rule.startsWith('-'));
  if (badRule !== undefined)
    throw new ConfigError(`${at('allowedTools')} and disallowedTools take tool rules, not "${badRule.slice(0, 40)}"`);
  const mcpServers = list('mcpServers');
  if (mcpServers.some((server) => server.trim() === '')) throw new ConfigError(`${at('mcpServers')} must name servers`);
  const env = list('env');
  const badName = env.find((variable) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable));
  if (badName !== undefined)
    throw new ConfigError(`${at('env')} names "${badName.slice(0, 40)}", which is not a variable name`);
  return {
    description,
    ...(prompt === undefined ? {} : { prompt }),
    tools,
    allowedTools,
    disallowedTools,
    env,
    mcpServers,
    ...(model === undefined ? {} : { model }),
    ...metadata,
  };
}

function parseAgents(raw: unknown): Pick<Config, 'agents' | 'agentErrors'> {
  const agents: Record<string, AgentConfig> = {};
  const agentErrors: Record<string, string> = {};
  if (raw === undefined) return { agents, agentErrors };
  if (!isRecord(raw)) throw new ConfigError('config: agents must be an object keyed by agent name');
  for (const [name, entry] of Object.entries(raw)) {
    try {
      if (!isAgentName(name))
        throw new ConfigError(`config: agent name "${name.slice(0, 40)}" must be ${AGENT_NAME_RULE}`);
      agents[name] = parseAgent(name, entry);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      agentErrors[name] = error.message;
    }
  }
  return { agents, agentErrors };
}

// The directory beside config.json that holds one agent definition per file: `<name>.yaml`, `<name>.yml` or `<name>.json`.
export const agentsDirOf = (configFile: string): string => join(dirname(configFile), 'agents');

const AGENT_FILE = /^(.*)\.(ya?ml|json)$/;

/** The name an agents/ file defines, or undefined for a file that is not a definition (a temp file, a README). */
export function agentFileName(file: string): string | undefined {
  if (file.startsWith('.')) return undefined;
  return AGENT_FILE.exec(file)?.[1];
}

/** The agent of one agents/ file, checked like a config.json entry; its `name`, when it has one, must be the file's. */
export function parseAgentFile(name: string, text: string, label: string): AgentConfig {
  const document = parseAgentDocument(text, label);
  if (!isRecord(document)) throw new ConfigError(`${label} must hold a mapping of the agent's keys`);
  const { name: written, ...entry } = document;
  if (written !== undefined && written !== name)
    throw new ConfigError(
      `${label} names the agent "${String(written).slice(0, 40)}", but the file is for "${name}"; rename one of them`,
    );
  return parseAgent(name, entry, label);
}

/**
 * The agents of the agents/ directory: every definition in it, the reasons the rest cannot be used, and which file each
 * came from. A missing directory has none. A file others may write to is refused: whoever can change it decides what an
 * agent's run may do.
 */
export function readAgentsDir(
  dir: string,
  prefix = 'agents',
  ignore: readonly string[] = [],
): Required<Pick<Config, 'agents' | 'agentErrors' | 'agentFiles'>> {
  const result = { agents: {}, agentErrors: {}, agentFiles: {} } as Required<
    Pick<Config, 'agents' | 'agentErrors' | 'agentFiles'>
  >;
  let files: string[];
  try {
    files = readdirSync(dir).sort();
  } catch {
    return result;
  }
  for (const file of files) {
    const name = agentFileName(file);
    if (name === undefined || ignore.includes(file)) continue;
    const path = join(dir, file);
    const label = `${prefix}/${file}`;
    try {
      if (!isAgentName(name)) throw new ConfigError(`${label}: the agent name must be ${AGENT_NAME_RULE}`);
      const other = result.agentFiles[name];
      if (other !== undefined)
        throw new ConfigError(`${prefix}/ has two files for ${name}: ${other.split('/').pop()} and ${file}; keep one`);
      result.agentFiles[name] = path;
      const stat = statSync(path);
      if (!stat.isFile()) throw new ConfigError(`${label} is not a file`);
      if ((stat.mode & 0o022) !== 0)
        throw new ConfigError(
          `${label} may be written by others (mode ${(stat.mode & 0o777).toString(8)}); chmod 600 it`,
        );
      result.agents[name] = parseAgentFile(name, readFileSync(path, 'utf8'), label);
    } catch (error) {
      if (!(error instanceof ConfigError)) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown error';
        result.agentErrors[name] = `cannot read ${label} (${code})`;
      } else result.agentErrors[name] = error.message;
      delete result.agents[name];
    }
  }
  return result;
}

/**
 * The config with the agents of the agents/ directory added. A name both define is unusable: which of two definitions a
 * task runs under must not depend on load order.
 */
export function withAgentsDir(config: Config, dir: string): Config {
  const found = readAgentsDir(dir);
  const agents = { ...config.agents };
  const agentErrors = { ...config.agentErrors };
  for (const [name, path] of Object.entries(found.agentFiles)) {
    if (Object.hasOwn(agents, name) || Object.hasOwn(config.agentErrors, name)) {
      delete agents[name];
      agentErrors[name] =
        `${name} is defined both in config.json and in agents/${path.split('/').pop()}; remove one of them`;
      continue;
    }
    const agent = found.agents[name];
    if (agent !== undefined) agents[name] = agent;
    const problem = found.agentErrors[name];
    if (problem !== undefined) agentErrors[name] = problem;
  }
  for (const [name, problem] of Object.entries(found.agentErrors))
    if (!Object.hasOwn(found.agentFiles, name)) agentErrors[name] = problem;
  return { ...config, agents, agentErrors, agentFiles: found.agentFiles };
}

// The directory beside config.json that holds the board's agent definitions as this machine applied them, one file each, and
// state.json with the version and hashes; only the apply writes it.
export const boardAgentsDirOf = (configFile: string): string => join(dirname(configFile), 'agents.board');

// Where an apply moves a local definition that the board's replaces. Nothing reads it.
export const replacedAgentsDirOf = (configFile: string): string => join(dirname(configFile), 'agents.replaced');

export interface BoardAgentsState {
  // The version of the board's document applied last; null before the first.
  version: number | null;
  // `agentHash` of each agent of that version that this machine can run, by name.
  hashes: Record<string, string>;
  // The entries of that version that did not parse, by name, and why: those agents are unusable here.
  errors: Record<string, string>;
  // The local definitions an apply could not move aside, by name, and why: those agents are unusable here.
  unmoved: Record<string, string>;
  // Why the last look at the board changed nothing although it had a newer version; absent once one applies.
  problem?: string;
}

export const BOARD_STATE_FILE = 'state.json';

export const EMPTY_BOARD_STATE: BoardAgentsState = { version: null, hashes: {}, errors: {}, unmoved: {} };

const stringRecord = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : {};

/** state.json of agents.board/; a missing or damaged one is the state of a machine that applied nothing. */
export function readBoardAgentsState(dir: string): BoardAgentsState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, BOARD_STATE_FILE), 'utf8'));
  } catch {
    return { ...EMPTY_BOARD_STATE };
  }
  if (!isRecord(raw)) return { ...EMPTY_BOARD_STATE };
  const version = raw['version'];
  const problem = raw['problem'];
  return {
    version: typeof version === 'number' && Number.isInteger(version) && version >= 1 ? version : null,
    hashes: stringRecord(raw['hashes']),
    errors: stringRecord(raw['errors']),
    unmoved: stringRecord(raw['unmoved']),
    ...(typeof problem === 'string' ? { problem } : {}),
  };
}

/**
 * The config with the board's agents added. The board wins a name: the apply moves the machine's own definition aside, so a
 * name defined here as well is one whose move failed, and it is unusable until that is fixed: which of two definitions a task
 * runs under must not depend on load order.
 */
export function withBoardAgents(config: Config, configFile: string): Config {
  const dir = boardAgentsDirOf(configFile);
  const state = readBoardAgentsState(dir);
  const found = readAgentsDir(dir, 'agents.board', [BOARD_STATE_FILE]);
  const agents = { ...config.agents };
  const agentErrors = { ...config.agentErrors };
  const names = new Set([...Object.keys(found.agentFiles), ...Object.keys(state.errors)]);
  for (const name of names) {
    if (Object.hasOwn(agents, name) || Object.hasOwn(agentErrors, name)) {
      const where =
        config.agentFiles?.[name] === undefined ? 'config.json' : `agents/${config.agentFiles[name].split('/').pop()}`;
      delete agents[name];
      agentErrors[name] =
        `${name} is on the board and also defined in ${where}, which the last apply could not move aside${state.unmoved[name] === undefined ? '' : ` (${state.unmoved[name]})`}; move or remove it`;
      continue;
    }
    const problem = state.errors[name] ?? found.agentErrors[name];
    const agent = found.agents[name];
    if (problem !== undefined) agentErrors[name] = problem;
    else if (agent !== undefined) agents[name] = agent;
  }
  for (const [name, problem] of Object.entries(found.agentErrors))
    if (!names.has(name) && !Object.hasOwn(agents, name)) agentErrors[name] = problem;
  return {
    ...config,
    agents,
    agentErrors,
    board: { version: state.version, names: [...names].sort(), files: found.agentFiles },
  };
}

export function parseConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new ConfigError('config: top level must be an object');
  const rawRepos = raw['repos'] ?? {};
  if (!isRecord(rawRepos)) throw new ConfigError('config: repos must be an object');
  const repos: Record<string, string> = {};
  for (const [repo, dir] of Object.entries(rawRepos)) {
    if (!REPO_PATTERN.test(repo)) throw new ConfigError(`config: repos key "${repo}" must look like owner/name`);
    if (typeof dir !== 'string' || dir === '') throw new ConfigError(`config: repos.${repo} must be a directory`);
    repos[repo] = expandHome(dir);
  }

  const defaultCwd = raw['defaultCwd'] ?? '~';
  if (typeof defaultCwd !== 'string' || !expandHome(defaultCwd).startsWith('/'))
    throw new ConfigError('config: defaultCwd must be an absolute path (or ~/...)');
  const machine = raw['machine'] ?? hostname().split('.')[0] ?? '';
  if (typeof machine !== 'string' || !isSafeMachineName(machine)) {
    throw new ConfigError(
      `config: machine must be a name of ${MACHINE_NAME_RULE} (defaults to the host name), not "${String(machine).slice(0, 40)}" (${String(machine).length} characters)`,
    );
  }
  const autoUpdate = 'autoUpdate' in raw ? raw['autoUpdate'] : 'incompatible';
  if (!isAutoUpdate(autoUpdate)) throw new ConfigError(`config: autoUpdate must be one of ${AUTO_UPDATES.join(', ')}`);
  const lanes = parseLanes(raw['lanes']);
  const dirs = parseDirs(
    raw['dirs'],
    lanes.map(({ name }) => name),
  );
  // A setting of a directory wins over the old key it stands for, which every other module goes on reading.
  for (const { path, repo } of dirs ?? []) if (repo !== undefined) repos[repo] = path;
  const usageLimits = parseUsageLimits(raw['usageLimits']);
  const defaultDir = dirs?.find((entry) => entry.default === true);
  return {
    machine,
    lanes: lanes.map((lane) => {
      const dir = dirs?.find((entry) => entry.lane === lane.name);
      return dir === undefined ? lane : { ...lane, cwd: dir.path };
    }),
    defaultCwd: defaultDir?.path ?? expandHome(defaultCwd),
    pauseAfterMinutes: positiveInt(raw, 'pauseAfterMinutes', '', 5),
    inactivityMinutes: positiveInt(raw, 'inactivityMinutes', '', 15),
    maxRunHours: positiveInt(raw, 'maxRunHours', '', 6),
    autoUpdate,
    ...parseAgents(raw['agents']),
    repos,
    ...(usageLimits === undefined ? {} : { usageLimits }),
    ...(dirs === undefined ? {} : { dirs }),
  };
}

// The keys parseConfig reads at each level. Anything else is ignored, so a misspelt key would silently keep its default.
export const TOP_KEYS = [
  'machine',
  'lanes',
  'defaultCwd',
  'pauseAfterMinutes',
  'inactivityMinutes',
  'maxRunHours',
  'autoUpdate',
  'agents',
  'repos',
  'dirs',
  'usageLimits',
  'sources',
] as const;
const LANE_KEYS = ['slots', 'cwd', 'default', 'skills'] as const;

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

// The known key a misspelt one most likely meant, if any is close.
function nearestKey(key: string, known: readonly string[]): string | undefined {
  const [nearest] = known
    .map((name) => ({ name, distance: editDistance(key.toLowerCase(), name.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance);
  return nearest !== undefined && nearest.distance <= Math.max(2, Math.floor(nearest.name.length / 3))
    ? nearest.name
    : undefined;
}

function unknownKeys(obj: Record<string, unknown>, known: readonly string[], where: string): string[] {
  return Object.keys(obj)
    .filter((key) => !known.includes(key))
    .map((key) => {
      const near = nearestKey(key, known);
      const shown = JSON.stringify(`${where}${key}`.slice(0, 80));
      return near === undefined
        ? `unknown key ${shown}, ignored; known here: ${known.join(', ')}`
        : `unknown key ${shown}, ignored; did you mean "${where}${near}"?`;
    });
}

/**
 * What a config that still has an `intake` key is told. The key is ignored and only warns (doctor fails it): an error here would
 * stop dispatch on every machine whose config was written for the old CLI.
 */
export const REMOVED_INTAKE =
  "the built-in intake was removed: run the github-reviews script (board example github-reviews.sh) with your own timer; move intake's lists to agents.<name>";

/** What a lane that still has a `skills` key is told: a task names its lane itself now, and one lane is the default. */
export const IGNORED_LANE_SKILLS = (lane: string): string =>
  `lanes.${lane.slice(0, 40)}.skills is ignored: a task's lane is set with --lane, and the lane for every other task is the one marked "default": true`;

export const isIgnoredSkillsWarning = (warning: string): boolean => warning.includes('.skills is ignored');

const OVERRIDDEN = ' is overridden by ';

export const isOverrideWarning = (warning: string): boolean => warning.includes(OVERRIDDEN);

// A setting of a `dirs` entry that replaces a different path under the old key it stands for: repos, defaultCwd, a lane's cwd.
function overrideWarnings(raw: Record<string, unknown>): string[] {
  const dirs = raw['dirs'];
  if (!isRecord(dirs)) return [];
  const repos = isRecord(raw['repos']) ? raw['repos'] : {};
  const lanes = isRecord(raw['lanes']) ? raw['lanes'] : {};
  return Object.entries(dirs).flatMap(([key, settings]) => {
    const path = dirKeyPath(key);
    if (path === undefined || !isRecord(settings)) return [];
    const shown = JSON.stringify(key.slice(0, 80));
    const elsewhere = (old: unknown): boolean =>
      typeof old === 'string' && old !== '' && resolve(expandHome(old)) !== path;
    const lane = settings['lane'];
    const laneEntry = typeof lane === 'string' ? lanes[lane] : undefined;
    const repo = settings['repo'];
    return [
      ...(typeof repo === 'string' && elsewhere(repos[repo])
        ? [`repos.${repo.slice(0, 80)}${OVERRIDDEN}dirs[${shown}].repo`]
        : []),
      ...(settings['default'] === true && elsewhere(raw['defaultCwd'])
        ? [`defaultCwd${OVERRIDDEN}dirs[${shown}].default`]
        : []),
      ...(typeof lane === 'string' && isRecord(laneEntry) && elsewhere(laneEntry['cwd'])
        ? [`lanes.${lane.slice(0, 40)}.cwd${OVERRIDDEN}dirs[${shown}].lane`]
        : []),
    ];
  });
}

// The keys of a config parseConfig ignores, one line each. Not an error: every machine reads this file, and a key a newer
// or older CLI dropped must not stop its workers; doctor and dispatch print these instead. A `dirs` setting that overrides a
// different path under an old key is listed too.
export function configWarnings(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const { intake: _removed, ...rest } = raw;
  const warnings = unknownKeys(rest, TOP_KEYS, '');
  const lanes = raw['lanes'];
  if (isRecord(lanes))
    for (const [name, entry] of Object.entries(lanes))
      if (isRecord(entry)) {
        warnings.push(...unknownKeys(entry, LANE_KEYS, `lanes.${name.slice(0, 40)}.`));
        if ('skills' in entry) warnings.push(IGNORED_LANE_SKILLS(name));
      }
  const usageLimits = raw['usageLimits'];
  if (isRecord(usageLimits)) warnings.push(...unknownKeys(usageLimits, USAGE_LIMIT_KEYS, 'usageLimits.'));
  if ('intake' in raw) warnings.push(REMOVED_INTAKE);
  warnings.push(...overrideWarnings(raw));
  return warnings;
}

// configWarnings for the file at path; nothing when it is missing or does not parse, which loadConfig reports.
export function loadConfigWarnings(path: string): string[] {
  try {
    return configWarnings(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return [];
  }
}

export function loadConfig(path: string, options: { optionalConfig?: boolean } = {}): Config {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    if (!missing) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown error';
      throw new ConfigError(`cannot read the config file ${path} (${code})`);
    }
    if (options.optionalConfig) return withBoardAgents(withAgentsDir(parseConfig({}), agentsDirOf(path)), path);
    throw new ConfigError(`config file missing: ${path} (run "board init")`);
  }
  try {
    return withBoardAgents(withAgentsDir(parseConfig(JSON.parse(content)), agentsDirOf(path)), path);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ConfigError(`config file is not valid JSON: ${path}`);
    throw error;
  }
}

export function isSafeMode(mode: number): boolean {
  const permissions = mode & 0o777;
  return permissions === 0o600 || permissions === 0o400;
}

// Reads a file that holds a secret, refusing a regular file readable by group or others. A pipe or a terminal (what
// `--token-file /dev/stdin` is) is not a file anyone else can read the secret from, and its mode differs between systems:
// 600 on Linux, 440 on macOS.
export function readSecretFile(path: string, what: string): string {
  let mode: number;
  let isFile: boolean;
  try {
    const stat = statSync(path);
    ({ mode } = stat);
    isFile = stat.isFile();
  } catch {
    throw new ConfigError(`${what} missing: ${path}`);
  }
  if (isFile && !isSafeMode(mode)) {
    throw new ConfigError(`${what} must be mode 600 or 400, is ${(mode & 0o777).toString(8)}: ${path}`);
  }
  return readFileSync(path, 'utf8');
}
