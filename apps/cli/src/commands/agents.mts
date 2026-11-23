// `board agents`: list, show, export, add and remove the agents of this machine. An agent definition is a permission
// grant (what a restricted run may do here), so `add` shows all of it and asks before it writes.
import { readFileSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { AGENT_NAME_RULE, broadRule, deadAllowTools, isAgentName, isRecord, looksSecret } from '@agent-board/shared';
import type { Backend, SharedAgentsDocument } from '@agent-board/shared';
import { BackendError } from '../backend/backend.mts';
import { UsageError } from '../cli.mts';
import { readTextFile } from './read-text-file.mts';
import { agentDocument, parseAgentDocument, renderAgentDocument, writeAgentFile } from '../config/agent-document.mts';
export { agentDocument, writeAgentFile };
import type { AgentFormat } from '../config/agent-document.mts';
import { fetchAgentText, parseAgentUrl } from '../config/agent-fetch.mts';
import type { FetchOptions } from '../config/agent-fetch.mts';
import {
  agentHashOf,
  applySharedAgents,
  boardEntry,
  logApplied,
  parseBoardEntry,
  removeLocal,
  replacedFiles,
} from '../config/board-agents.mts';
import { agentFileName, agentsDirOf, ConfigError, expandHome, loadConfig, parseAgent } from '../config/config.mts';
import type { AgentConfig, Config } from '../config/config.mts';
import { plainLine, plainText } from '../output/terminal.mts';
import { errorText } from '../output/text.mts';
import { pluginPlaceholders } from '../worker/plan.mts';
import { resolvePluginPath } from '../worker/plugins.mts';
import { rewriteConfigFile } from './dirs.mts';
import { exampleNames, exampleText } from './example.mts';

export interface AgentsDeps {
  configFile: string;
  cwd: string;
  home: string;
  dryRun: boolean;
  print: (line: string) => void;
  // Raw output: a document, written as it is.
  write: (text: string) => void;
  readStdin: () => Promise<string>;
  // Asks a person at a terminal; undefined when there is none, so only --yes can confirm.
  confirm: ((question: string) => Promise<boolean>) | undefined;
  fetch?: FetchOptions;
  // The board, for push and rm --board; the other actions work without one.
  backend?: Pick<Backend, 'sharedAgentsVersion' | 'getSharedAgents' | 'setSharedAgents'>;
  now?: () => Date;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading what this machine has

function machineAgents(deps: Pick<AgentsDeps, 'configFile'>): Config {
  return loadConfig(deps.configFile, { optionalConfig: true });
}

// Whether the agent of this name is the board's, as this machine last applied it.
const isBoardAgent = (config: Config, name: string): boolean => config.board?.names.includes(name) ?? false;

// Where an agent is defined: the board (with the version applied), its agents/ file, or config.json.
const whereOf = (config: Config, name: string): string => {
  if (isBoardAgent(config, name)) return `board v${config.board?.version ?? '?'}`;
  const file = config.agentFiles?.[name];
  return file === undefined ? 'config.json' : `agents/${basename(file)}`;
};

/** The short form of an agent's hash that `board agents` prints; the catalogue and --json carry all of it. */
export const shortHash = (hash: string): string => hash.slice(0, 12);

/** The plugin placeholders of an agent's rules, each with its root here or the reason it does not resolve. */
export function pluginRoots(
  agent: Pick<AgentConfig, 'allowedTools' | 'disallowedTools'>,
  home: string,
): { placeholder: string; root?: string; problem?: string }[] {
  return pluginPlaceholders([...agent.allowedTools, ...agent.disallowedTools]).map((placeholder) => {
    try {
      return { placeholder, root: resolvePluginPath(placeholder, join(home, '.claude', 'plugins')) };
    } catch (error) {
      return { placeholder, problem: errorText(error) };
    }
  });
}

// Why a defined agent cannot run here, or undefined when it can.
function unusable(config: Config, name: string, home: string): string | undefined {
  const problem = config.agentErrors[name];
  if (problem !== undefined) return problem;
  const agent = config.agents[name];
  if (agent === undefined) return 'not defined';
  const missing = pluginRoots(agent, home).find((plugin) => plugin.problem !== undefined);
  return missing === undefined ? undefined : `{${missing.placeholder}} does not resolve (${missing.problem})`;
}

export interface AgentRow {
  name: string;
  from: string;
  tools: string[];
  allowed: number;
  denied: number;
  version?: string;
  source?: string;
  // The hash of the run-relevant keys; absent for an agent that does not parse.
  hash?: string;
  // The local definitions an apply moved aside for this board agent, until they are deleted.
  replaced?: string[];
  usable: boolean;
  problem?: string;
}

export function agentRows(config: Config, home: string, replaced: Record<string, string[]> = {}): AgentRow[] {
  const names = [...new Set([...Object.keys(config.agents), ...Object.keys(config.agentErrors)])].sort();
  return names.map((name) => {
    const agent = Object.hasOwn(config.agents, name) ? config.agents[name] : undefined;
    const problem = unusable(config, name, home);
    const moved = isBoardAgent(config, name) ? replaced[name] : undefined;
    return {
      name,
      from: whereOf(config, name),
      ...(agent === undefined ? {} : { hash: agentHashOf(agent) }),
      ...(moved === undefined ? {} : { replaced: moved }),
      tools: agent?.tools ?? [],
      allowed: agent?.allowedTools.length ?? 0,
      denied: agent?.disallowedTools.length ?? 0,
      ...(agent?.version === undefined ? {} : { version: agent.version }),
      ...(agent?.source === undefined ? {} : { source: agent.source }),
      usable: problem === undefined,
      ...(problem === undefined ? {} : { problem }),
    };
  });
}

export function agentsList(deps: AgentsDeps, json: boolean): void {
  const rows = agentRows(machineAgents(deps), deps.home, replacedFiles(deps.configFile));
  if (json) {
    deps.write(`${JSON.stringify({ agents: rows }, null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    deps.print('no agents are defined on this machine.');
    deps.print('"board agents add example:reviewer" adds the shipped reviewer; "board help agents" says more.');
    return;
  }
  for (const row of rows) {
    const head = `${plainLine(row.name)}${row.version === undefined ? '' : ` ${plainLine(row.version)}`}`;
    const from = `${row.from}${row.replaced === undefined ? '' : ', replaced a local definition'}`;
    const hash = row.hash === undefined ? '' : `  ${shortHash(row.hash)}`;
    deps.print(
      `${head}  ${row.usable ? 'usable' : `NOT USABLE: ${plainLine(row.problem ?? '')}`}  (${plainLine(from)})${hash}`,
    );
    if (row.tools.length > 0)
      deps.print(
        `  tools ${row.tools.length}: ${plainLine(row.tools.join(', '))}; allow ${row.allowed}, deny ${row.denied}`,
      );
    if (row.source !== undefined) deps.print(`  source: ${plainLine(row.source)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Documents

function definedAgent(config: Config, name: string): AgentConfig {
  const agent = Object.hasOwn(config.agents, name) ? config.agents[name] : undefined;
  if (agent !== undefined) return agent;
  const problem = config.agentErrors[name];
  if (problem !== undefined) throw new UsageError(`agent ${plainLine(name)} cannot be read: ${plainLine(problem)}`);
  const known = Object.keys(config.agents).sort();
  throw new UsageError(
    `no agent "${plainLine(name).slice(0, 40)}" here; ${known.length === 0 ? 'none is defined' : `the agents are ${known.join(', ')}`}`,
  );
}

/** `show` prints where the agent came from as well; `export` leaves that out, since it is this machine's history. */
export function agentsShow(deps: AgentsDeps, name: string, format: AgentFormat, { withSource = true } = {}): void {
  const agent = definedAgent(machineAgents(deps), name);
  deps.write(renderAgentDocument(agentDocument(name, agent, { withSource }), format));
}

// ---------------------------------------------------------------------------------------------------------------------
// What a definition grants

/** Every line a person must see before the agent is written: what it may do, flagged where it is broad. */
export function grantSummary(name: string, agent: AgentConfig, home: string): { lines: string[]; warnings: string[] } {
  const lines: string[] = [];
  const warnings: string[] = [];
  const line = (text: string): number => lines.push(plainLine(text));
  line(`agent ${name}${agent.version === undefined ? '' : ` ${agent.version}`}: ${agent.description}`);
  if (agent.source !== undefined) line(`  source: ${agent.source}`);
  if (agent.model !== undefined) line(`  model: ${agent.model}`);
  line(`  tools (${agent.tools.length}): ${agent.tools.join(', ')}`);
  line(`  allowedTools (${agent.allowedTools.length}):`);
  for (const rule of agent.allowedTools) {
    const broad = broadRule(rule);
    line(`    ${broad === undefined ? '  ' : '! '}${rule}${broad === undefined ? '' : `   <- broad: ${broad}`}`);
    if (broad !== undefined) warnings.push(`allow rule ${rule}: ${broad}`);
  }
  line(`  disallowedTools (${agent.disallowedTools.length}):${agent.disallowedTools.length === 0 ? ' none' : ''}`);
  for (const rule of agent.disallowedTools) line(`      ${rule}`);
  if (agent.disallowedTools.length === 0)
    warnings.push('the deny list is empty: nothing is denied beyond what the allow rules leave out');
  line(
    `  env, copied from the working directory's settings (${agent.env.length}):${agent.env.length === 0 ? ' none' : ''}`,
  );
  for (const variable of agent.env) {
    const secret = looksSecret(variable);
    line(`    ${secret ? '! ' : '  '}${variable}${secret ? '   <- looks like a secret' : ''}`);
    if (secret) warnings.push(`env ${variable} looks like a secret: the run gets its value`);
  }
  line(
    `  mcpServers, from the working directory's .mcp.json: ${agent.mcpServers.length === 0 ? 'none' : agent.mcpServers.join(', ')}`,
  );
  for (const plugin of pluginRoots(agent, home)) {
    if (plugin.root !== undefined) line(`  {${plugin.placeholder}} resolves to ${plugin.root}`);
    else {
      line(`  {${plugin.placeholder}} does not resolve here: ${plugin.problem ?? ''}`);
      warnings.push(
        `{${plugin.placeholder}} does not resolve (${plugin.problem ?? ''}): a run as ${name} fails until it does`,
      );
    }
  }
  const dead = deadAllowTools(agent);
  if (dead.length > 0) warnings.push(`allowedTools has rules for ${dead.join(', ')}, which tools leaves out`);
  return { lines, warnings: warnings.map(plainLine) };
}

// ---------------------------------------------------------------------------------------------------------------------
// add

export interface AddFlags {
  name?: string;
  replace?: boolean;
  yes?: boolean;
}

// The text of a definition, and what to record as its source.
async function readSource(deps: AgentsDeps, from: string): Promise<{ text: string; source: string; stem?: string }> {
  if (from === '-') return { text: await deps.readStdin(), source: 'stdin' };
  if (from.startsWith('example:')) {
    const example = from.slice('example:'.length);
    const text = exampleText(`agents/${example}.yaml`);
    if (text === undefined) {
      const known = exampleNames()
        .filter((file) => file.startsWith('agents/'))
        .map((file) => `example:${file.slice('agents/'.length).replace(/\.yaml$/, '')}`);
      throw new UsageError(`no example agent "${plainLine(example).slice(0, 40)}"; there are ${known.join(', ')}`);
    }
    return { text, source: from, stem: example };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(from)) {
    const { url, sha256 } = parseAgentUrl(from);
    const text = await fetchAgentText(url, sha256, deps.fetch);
    return { text, source: url.href, stem: agentFileName(basename(url.pathname)) };
  }
  const path = resolve(deps.cwd, expandHome(from));
  const text = readTextFile(path);
  return { text, source: path, stem: agentFileName(basename(path)) };
}

// The whole definition and every grant it makes, flagged where broad: what a person reads before it is written or pushed.
function showDefinition(
  deps: Pick<AgentsDeps, 'print' | 'home'>,
  name: string,
  agent: AgentConfig,
  rendered: string,
  heading: string,
  where: string,
): void {
  deps.print(heading);
  deps.print('');
  for (const row of plainText(rendered).trimEnd().split('\n')) deps.print(`  ${row}`);
  deps.print('');
  const { lines, warnings } = grantSummary(name, agent, deps.home);
  deps.print(`What a run as this agent may do ${where}:`);
  for (const row of lines) deps.print(row);
  if (warnings.length > 0) {
    deps.print('');
    deps.print(`Check these (${warnings.length}):`);
    for (const warning of warnings) deps.print(`  ! ${warning}`);
  }
  deps.print('');
}

// The definition a file, stdin, URL or example holds, under the name --name, its `name` or its file name give it.
async function readDefinition(
  deps: AgentsDeps,
  from: string,
  flags: { name?: string },
): Promise<{ name: string; agent: AgentConfig }> {
  const { text, source, stem } = await readSource(deps, from);
  const label = source === 'stdin' ? 'the definition on stdin' : plainLine(source).slice(0, 200);
  const document = parseAgentDocument(text, label);
  if (!isRecord(document)) throw new ConfigError(`${label} must hold a mapping of the agent's keys`);
  const { name: written, source: _theirs, ...entry } = document;
  if (written !== undefined && (typeof written !== 'string' || !isAgentName(written)))
    throw new ConfigError(`${label}: name must be ${AGENT_NAME_RULE}`);
  const name = flags.name ?? (typeof written === 'string' ? written : undefined) ?? stem;
  if (name === undefined) throw new UsageError(`${label} has no name; give it one with --name`);
  if (!isAgentName(name))
    throw new UsageError(`the agent name "${plainLine(name).slice(0, 40)}" must be ${AGENT_NAME_RULE}`);
  // The source is where this machine got the file, never what the file says about itself.
  return { name, agent: parseAgent(name, { ...entry, source }, label) };
}

export async function agentsAdd(deps: AgentsDeps, from: string, flags: AddFlags): Promise<void> {
  const { name, agent } = await readDefinition(deps, from, flags);
  const config = machineAgents(deps);
  if (isBoardAgent(config, name))
    throw new ConfigError(
      `agent ${name} is held on the board for every machine; change it with board agents push, or add this one under another --name`,
    );
  const defined = Object.hasOwn(config.agents, name) || Object.hasOwn(config.agentErrors, name);
  const inFile = Object.hasOwn(config.agentFiles ?? {}, name);
  if (defined && !inFile)
    throw new ConfigError(
      `agent ${name} is defined in config.json; remove it there (board agents rm ${name}) or add this one under another --name`,
    );
  if (defined && !flags.replace)
    throw new ConfigError(`agent ${name} exists (${whereOf(config, name)}); --replace overwrites it`);

  const rendered = renderAgentDocument(agentDocument(name, agent), 'yaml');
  showDefinition(deps, name, agent, rendered, 'The definition, as it would be written:', 'on this machine');
  const dir = agentsDirOf(deps.configFile);
  const target = join(dir, `${name}.yaml`);
  const action = `${defined ? 'replace' : 'write'} ${target}`;
  if (deps.dryRun) {
    deps.print(`DRY ${action}`);
    return;
  }
  if (!flags.yes) {
    if (deps.confirm === undefined)
      throw new ConfigError(
        'nothing was written: confirm at a terminal, or pass --yes once you have read the definition',
      );
    if (!(await deps.confirm(`${defined ? 'Replace' : 'Add'} agent ${name}?`))) {
      deps.print('nothing was written.');
      return;
    }
  }
  writeAgentFile(dir, name, rendered);
  deps.print(`${defined ? 'replaced' : 'added'} agent ${name}: ${target}`);
  deps.print(`tasks that name it run as it on this machine: board schedule --agent ${name} "<prompt>"`);
}

// ---------------------------------------------------------------------------------------------------------------------
// rm

export function agentsRemove(deps: AgentsDeps, name: string): void {
  const config = machineAgents(deps);
  if (isBoardAgent(config, name))
    throw new UsageError(
      `agent ${name} is held on the board; board agents rm --board ${name} takes it off every machine`,
    );
  const file = config.agentFiles?.[name];
  const inConfig = (() => {
    try {
      const raw: unknown = JSON.parse(readFileSync(deps.configFile, 'utf8'));
      return isRecord(raw) && isRecord(raw['agents']) && Object.hasOwn(raw['agents'], name);
    } catch {
      return false;
    }
  })();
  if (file === undefined && !inConfig) definedAgent(config, name);
  if (file !== undefined) {
    if (deps.dryRun) deps.print(`DRY remove ${file}`);
    else {
      rmSync(file, { force: true });
      deps.print(`removed agent ${name}: ${file}`);
    }
  }
  if (inConfig) {
    if (deps.dryRun) deps.print(`DRY remove agents.${name} from ${deps.configFile}`);
    else {
      rewriteConfigFile(deps.configFile, ({ raw }) => {
        const agents = isRecord(raw['agents']) ? { ...raw['agents'] } : {};
        delete agents[name];
        return { ...raw, agents };
      });
      deps.print(`removed agents.${name} from ${deps.configFile}`);
    }
  }
  deps.print(`tasks that name ${name} no longer run on this machine.`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The board's agents: push and rm --board

const isConflict = (error: unknown): boolean => error instanceof BackendError && error.fromApi && error.status === 409;

function boardOf(deps: AgentsDeps): NonNullable<AgentsDeps['backend']> {
  if (deps.backend === undefined) throw new UsageError('this needs the board, and no board is set up here');
  return deps.backend;
}

// The board's document as it is now, to change one entry of: an empty one when it holds none.
async function currentDocument(deps: AgentsDeps): Promise<SharedAgentsDocument & { held: number }> {
  const backend = boardOf(deps);
  if ((await backend.sharedAgentsVersion()) === 'unsupported')
    throw new UsageError(
      'the board server does not support agent definitions held on the board yet; update the board server',
    );
  const onBoard = await backend.getSharedAgents();
  if (onBoard === null) return { version: 0, agents: {}, held: 0 };
  if ('unreadable' in onBoard)
    throw new ConfigError(
      `the board's agents v${onBoard.version} do not open with this machine's data key; nothing was pushed, since a push replaces all of them`,
    );
  return { ...onBoard.document, held: onBoard.version };
}

// Sends `change` of the board's document as its next version; on a conflict fetches again and, when `confirmAgain` agrees,
// tries once more. Returns the document the board now holds.
async function pushChange(
  deps: AgentsDeps,
  first: SharedAgentsDocument & { held: number },
  change: (agents: SharedAgentsDocument['agents']) => SharedAgentsDocument['agents'],
  confirmAgain: (before: SharedAgentsDocument, now: SharedAgentsDocument) => Promise<boolean>,
): Promise<SharedAgentsDocument | undefined> {
  const backend = boardOf(deps);
  let base = first;
  for (let attempt = 0; ; attempt++) {
    const document = { version: base.held + 1, agents: change({ ...base.agents }) };
    try {
      await backend.setSharedAgents(document, base.held);
      return document;
    } catch (error) {
      if (!isConflict(error) || attempt > 0) throw error;
    }
    const now = await currentDocument(deps);
    if (!(await confirmAgain(base, now))) return undefined;
    base = now;
  }
}

const sameEntry = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// Brings this machine's agents.board/ to the document it just pushed, as the next tick would.
async function applyHere(deps: AgentsDeps, document: SharedAgentsDocument): Promise<void> {
  const applied = await applySharedAgents(
    { configFile: deps.configFile, now: deps.now ?? (() => new Date()) },
    document,
  );
  logApplied(deps.print, applied);
}

export interface PushFlags {
  name?: string;
  yes?: boolean;
}

/**
 * Puts one agent on the board for every machine: an agent this machine defines (by name) or a definition from a file, stdin,
 * URL or example. Shows all of it and asks first, like `add`; then the agent is the board's here too: its local file or
 * config.json entry goes, since the board copy holds the same definition.
 */
export async function agentsPush(deps: AgentsDeps, from: string, flags: PushFlags): Promise<void> {
  const config = machineAgents(deps);
  const local =
    isAgentName(from) &&
    flags.name === undefined &&
    !isBoardAgent(config, from) &&
    (Object.hasOwn(config.agents, from) || Object.hasOwn(config.agentErrors, from));
  if (isAgentName(from) && flags.name === undefined && isBoardAgent(config, from))
    throw new UsageError(
      `agent ${from} is on the board already; to change it, export it (board agents export ${from} > ${from}.yaml), edit the file and push the file`,
    );
  const { name, agent } = local
    ? { name: from, agent: definedAgent(config, from) }
    : await readDefinition(deps, from, flags);
  const entry = boardEntry(name, agent);
  // What every machine will have: the strict parser of a board entry must take it as it is.
  parseBoardEntry(name, entry, 1);

  const first = await currentDocument(deps);
  const before = first.agents[name];
  if (before !== undefined && sameEntry(before, entry)) {
    deps.print(`the board's agents v${first.held} already hold this definition of ${name}.`);
  } else {
    showDefinition(
      deps,
      name,
      agent,
      renderAgentDocument(agentDocument(name, agent, { withSource: false }), 'yaml'),
      `The definition, as every machine of yours will have it:`,
      'on every machine of yours, once it applies the board on its next tick',
    );
    if (Object.hasOwn(config.agents, name) && !local && !isBoardAgent(config, name))
      deps.print(`This machine's own ${name} (${whereOf(config, name)}) will be moved to agents.replaced/.`);
    const action = `${before === undefined ? 'add' : 'replace'} ${name} in the board's agents (v${first.held + 1})`;
    if (deps.dryRun) {
      deps.print(`DRY ${action}`);
      return;
    }
    if (!flags.yes) {
      if (deps.confirm === undefined)
        throw new ConfigError(
          'nothing was pushed: confirm at a terminal, or pass --yes once you have read the definition',
        );
      if (!(await deps.confirm(`${before === undefined ? 'Push' : 'Replace'} agent ${name} on every machine?`))) {
        deps.print('nothing was pushed.');
        return;
      }
    }
    const pushed = await pushChange(
      deps,
      first,
      (agents) => ({ ...agents, [name]: entry }),
      async (was, now) => {
        if (sameEntry(was.agents[name], now.agents[name])) return true;
        const theirs = now.agents[name];
        deps.print(`Another push changed ${name} on the board meanwhile (now v${now.version}).`);
        if (theirs !== undefined) {
          try {
            const shown = parseBoardEntry(name, theirs, now.version);
            const { lines } = grantSummary(name, shown, deps.home);
            deps.print('It now grants:');
            for (const row of lines) deps.print(row);
          } catch (error) {
            deps.print(`It now holds a definition this CLI cannot read: ${errorText(error)}`);
          }
        }
        if (flags.yes || deps.confirm === undefined) return flags.yes === true;
        return deps.confirm(`Replace it with yours on every machine?`);
      },
    );
    if (pushed === undefined) {
      deps.print('nothing was pushed.');
      return;
    }
    deps.print(
      `pushed agent ${name}: the board's agents are v${pushed.version}; every machine applies them on its next tick.`,
    );
    if (local) removeLocal(deps.configFile, name);
    await applyHere(deps, pushed);
    return;
  }
  if (deps.dryRun) return;
  if (local) {
    removeLocal(deps.configFile, name);
    await applyHere(deps, first);
  }
}

/** Takes one agent off the board; every machine drops its copy on its next tick. */
export async function agentsRemoveFromBoard(deps: AgentsDeps, name: string): Promise<void> {
  const first = await currentDocument(deps);
  if (!Object.hasOwn(first.agents, name))
    throw new UsageError(
      `the board holds no agent "${plainLine(name).slice(0, 40)}"${first.held === 0 ? '' : ` (v${first.held} has ${Object.keys(first.agents).sort().join(', ') || 'none'})`}`,
    );
  if (deps.dryRun) {
    deps.print(`DRY remove ${name} from the board's agents (v${first.held + 1})`);
    return;
  }
  const pushed = await pushChange(
    deps,
    first,
    (agents) => Object.fromEntries(Object.entries(agents).filter(([other]) => other !== name)),
    async () => true,
  );
  if (pushed === undefined) return;
  deps.print(`removed agent ${name} from the board: v${pushed.version}; every machine drops it on its next tick.`);
  await applyHere(deps, pushed);
}
