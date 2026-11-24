// The agent definitions the board holds for every machine (`agents.shared`), on this machine: the dispatch tick fetches a newer
// version and applies it to agents.board/, and `board agents push` and `rm --board` apply what they pushed. The board wins a
// name: a definition of the same name in config.json or agents/ is moved to agents.replaced/, never deleted, so a machine
// never holds two definitions of one name. See "Shared agents" in docs/workers.md.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentHashInput, isRecord } from '@agent-board/shared';
import type { Backend, CatalogAgents, SharedAgentsDocument } from '@agent-board/shared';
import { errorText } from '../output/text.mts';
import { agentDocument, renderAgentDocument, writeAgentFile } from './agent-document.mts';
import { readConfigFile, writeConfigFile } from './config-file.mts';
import {
  agentFileName,
  agentsDirOf,
  BOARD_STATE_FILE,
  boardAgentsDirOf,
  ConfigError,
  parseAgent,
  readBoardAgentsState,
  replacedAgentsDirOf,
} from './config.mts';
import type { AgentConfig, BoardAgentsState } from './config.mts';

// What a machine records as the source of an agent it has from the board; the document itself holds none.
export const BOARD_SOURCE = 'board';

/** SHA-256 of the agent's run-relevant keys (`agentHashInput`), the same on every machine and in the browser. */
export const agentHashOf = (agent: AgentConfig): string =>
  createHash('sha256')
    .update(agentHashInput({ ...agent }))
    .digest('hex');

/** One entry of the document, read like an agent file: the strict parser, and neither `source` nor another `name`. */
export function parseBoardEntry(name: string, entry: unknown, version: number): AgentConfig {
  const label = `the board's agents v${version}: ${name}`;
  if (!isRecord(entry)) throw new ConfigError(`${label} must hold a mapping of the agent's keys`);
  const { name: written, source, ...rest } = entry;
  if (written !== undefined && written !== name)
    throw new ConfigError(`${label} names the agent "${String(written).slice(0, 40)}"`);
  if (source !== undefined) throw new ConfigError(`${label}: source is not kept on the board`);
  return parseAgent(name, rest, label);
}

/** An agent as the document holds it: the keys of its file without `name` and `source`. */
export function boardEntry(name: string, agent: AgentConfig): Record<string, unknown> {
  const { name: _name, source: _source, ...entry } = agentDocument(name, agent, { withSource: false });
  return entry;
}

/** The time in a moved file's name, sortable and free of characters a file name should not hold. */
const stamp = (at: Date): string =>
  at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

function writeState(dir: string, state: BoardAgentsState): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, BOARD_STATE_FILE);
  const temp = join(dir, `.state.tmp-${process.pid}`);
  try {
    rmSync(temp, { force: true });
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Forgets the version applied last, so the next look applies whatever version the board names; the agents on disk stay. */
export function forgetAppliedVersion(configFile: string): void {
  const dir = boardAgentsDirOf(configFile);
  writeState(dir, { ...readBoardAgentsState(dir), version: null });
}

/** The files of agents/ that define `name`. */
function localFiles(configFile: string, name: string): string[] {
  const dir = agentsDirOf(configFile);
  try {
    return readdirSync(dir)
      .filter((file) => agentFileName(file) === name)
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
}

/** The entry config.json has under `agents.<name>`, if any; a config.json that does not read has none. */
function configEntry(configFile: string, name: string): unknown {
  try {
    const { raw } = readConfigFile(configFile);
    const agents = raw['agents'];
    return isRecord(agents) && Object.hasOwn(agents, name) ? agents[name] : undefined;
  } catch {
    return undefined;
  }
}

/** Every file an apply moved aside, by agent name: what `board agents` and doctor show until the user deletes them. */
export function replacedFiles(configFile: string): Record<string, string[]> {
  const dir = replacedAgentsDirOf(configFile);
  const byName: Record<string, string[]> = {};
  let files: string[];
  try {
    files = readdirSync(dir).sort();
  } catch {
    return byName;
  }
  for (const file of files) {
    const name = /^([a-z0-9][a-z0-9-]*)\.\d{8}T\d{6}Z(?:-\d+)?\.(?:ya?ml|json)$/.exec(file)?.[1];
    if (name !== undefined) (byName[name] ??= []).push(join(dir, file));
  }
  return byName;
}

// A free name in agents.replaced/ for the definition of `name` moved at `at`.
function replacedTarget(configFile: string, name: string, at: Date, extension: string): string {
  const dir = replacedAgentsDirOf(configFile);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const base = `${name}.${stamp(at)}`;
  let target = join(dir, `${base}.${extension}`);
  for (let n = 2; existsSync(target); n++) target = join(dir, `${base}-${n}.${extension}`);
  return target;
}

export interface Moved {
  name: string;
  path: string;
}

/**
 * Moves this machine's own definition of `name` aside: an agents/ file is renamed into agents.replaced/, a config.json entry is
 * written there and taken out of config.json (every other key and the file's mode stay). Returns the moved files; throws when
 * one could not be moved, leaving what was not moved where it was.
 */
export function moveLocalAside(configFile: string, name: string, at: Date): Moved[] {
  const moved: Moved[] = [];
  for (const file of localFiles(configFile, name)) {
    const target = replacedTarget(configFile, name, at, file.split('.').pop() ?? 'yaml');
    renameSync(file, target);
    chmodSync(target, 0o600);
    moved.push({ name, path: target });
  }
  const entry = configEntry(configFile, name);
  if (entry !== undefined) {
    const target = replacedTarget(configFile, name, at, 'yaml');
    const document = isRecord(entry) ? { name, ...entry } : { name, definition: entry };
    writeFileSync(target, renderAgentDocument(document, 'yaml'), { mode: 0o600, flag: 'wx' });
    try {
      const { raw, mode } = readConfigFile(configFile);
      const agents = isRecord(raw['agents']) ? { ...raw['agents'] } : {};
      delete agents[name];
      writeConfigFile(configFile, { ...raw, agents }, mode);
    } catch (error) {
      rmSync(target, { force: true });
      throw error;
    }
    moved.push({ name, path: target });
  }
  return moved;
}

/** Takes this machine's own definition of `name` out, after a push put the same definition on the board. */
export function removeLocal(configFile: string, name: string): void {
  for (const file of localFiles(configFile, name)) rmSync(file, { force: true });
  if (configEntry(configFile, name) === undefined) return;
  const { raw, mode } = readConfigFile(configFile);
  const agents = isRecord(raw['agents']) ? { ...raw['agents'] } : {};
  delete agents[name];
  writeConfigFile(configFile, { ...raw, agents }, mode);
}

/** Moves every local definition of the board's `names` aside: what was moved, and the names whose move failed and why. */
function settleLocal(
  configFile: string,
  names: readonly string[],
  at: Date,
): { replaced: Moved[]; unmoved: Record<string, string> } {
  const replaced: Moved[] = [];
  const unmoved: Record<string, string> = {};
  for (const name of names) {
    try {
      replaced.push(...moveLocalAside(configFile, name, at));
    } catch (error) {
      unmoved[name] = errorText(error);
    }
  }
  return { replaced, unmoved };
}

/** Whether config.json or agents/ defines `name` here. */
export const definedLocally = (configFile: string, name: string): boolean =>
  localFiles(configFile, name).length > 0 || configEntry(configFile, name) !== undefined;

export interface Applied {
  version: number;
  written: string[];
  removed: string[];
  replaced: Moved[];
  // Entries that did not parse, and local definitions that could not be moved aside, by name.
  errors: Record<string, string>;
  unmoved: Record<string, string>;
}

export interface ApplyDeps {
  configFile: string;
  now: () => Date;
  dryRun?: boolean;
  print?: (line: string) => void;
}

/**
 * Makes agents.board/ hold exactly the agents of `document`: writes each one that parses (mode 600, beside a temp file),
 * deletes the files of agents it no longer has, moves a local definition of a board name aside, and records the version and
 * each agent's hash in state.json. An entry that does not parse makes that agent unusable here and leaves the others.
 */
export async function applySharedAgents(deps: ApplyDeps, document: SharedAgentsDocument): Promise<Applied> {
  const dir = boardAgentsDirOf(deps.configFile);
  const at = deps.now();
  const result: Applied = {
    version: document.version,
    written: [],
    removed: [],
    replaced: [],
    errors: {},
    unmoved: {},
  };
  const parsed: Record<string, AgentConfig> = {};
  for (const [name, entry] of Object.entries(document.agents)) {
    try {
      parsed[name] = parseBoardEntry(name, entry, document.version);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      result.errors[name] = error.message;
    }
  }
  const names = Object.keys(document.agents).sort();
  if (deps.dryRun) {
    for (const name of names) {
      if (definedLocally(deps.configFile, name))
        deps.print?.(`DRY move the local definition of ${name} to ${replacedAgentsDirOf(deps.configFile)}`);
      if (parsed[name] !== undefined) deps.print?.(`DRY write ${join(dir, `${name}.yaml`)}`);
    }
    return result;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settled = settleLocal(deps.configFile, names, at);
  result.replaced.push(...settled.replaced);
  Object.assign(result.unmoved, settled.unmoved);
  const hashes: Record<string, string> = {};
  for (const name of names) {
    const agent = parsed[name];
    if (agent === undefined) {
      for (const file of [`${name}.yaml`, `${name}.yml`, `${name}.json`]) rmSync(join(dir, file), { force: true });
      continue;
    }
    const text = renderAgentDocument(agentDocument(name, { ...agent, source: BOARD_SOURCE }), 'yaml');
    writeAgentFile(dir, name, text);
    hashes[name] = agentHashOf(agent);
    result.written.push(name);
  }
  chmodSync(dir, 0o700);
  for (const file of readdirSync(dir)) {
    const name = agentFileName(file);
    if (name === undefined || file === BOARD_STATE_FILE || Object.hasOwn(document.agents, name)) continue;
    rmSync(join(dir, file), { force: true });
    result.removed.push(name);
  }
  writeState(dir, { version: document.version, hashes, errors: result.errors, unmoved: result.unmoved });
  return result;
}

/** Records why the last look at the board changed nothing, for doctor; the applied version and agents stay. */
function recordProblem(configFile: string, problem: string | undefined): void {
  const dir = boardAgentsDirOf(configFile);
  const state = readBoardAgentsState(dir);
  if (state.problem === problem) return;
  const { problem: _old, ...rest } = state;
  if (state.version === null && problem === undefined) return;
  writeState(dir, problem === undefined ? rest : { ...rest, problem });
}

export interface SyncDeps extends ApplyDeps {
  backend: Pick<Backend, 'sharedAgentsVersion' | 'getSharedAgents'>;
  log: (line: string) => void;
}

export type SyncResult = 'unsupported' | 'none' | 'current' | 'applied' | 'kept';

/**
 * Between versions: a local definition of a board name (a file dropped into agents/ by hand, an entry added to config.json)
 * is moved aside on the next tick, as an apply would. Returns whether anything changed.
 */
export function settleBoardNames(deps: SyncDeps): boolean {
  const dir = boardAgentsDirOf(deps.configFile);
  const state = readBoardAgentsState(dir);
  const names = [...Object.keys(state.hashes), ...Object.keys(state.errors)]
    .filter((name) => definedLocally(deps.configFile, name))
    .sort();
  if (names.length === 0) {
    if (Object.keys(state.unmoved).length > 0 && !deps.dryRun) writeState(dir, { ...state, unmoved: {} });
    return false;
  }
  if (deps.dryRun) {
    for (const name of names)
      deps.log(`DRY move the local definition of ${name} to ${replacedAgentsDirOf(deps.configFile)}`);
    return false;
  }
  const { replaced, unmoved } = settleLocal(deps.configFile, names, deps.now());
  for (const { name, path } of replaced) deps.log(`REPLACED ${name}: local definition moved to ${path}`);
  for (const [name, reason] of Object.entries(unmoved))
    deps.log(`WARN ${name}: the local definition could not be moved aside (${reason}); the agent is unusable here`);
  writeState(dir, { ...state, unmoved });
  return replaced.length > 0;
}

/** Logs what an apply did: the version, and every local definition it moved aside or could not. */
export function logApplied(log: (line: string) => void, applied: Applied): void {
  log(
    `APPLIED agents v${applied.version}: ${applied.written.length} agent(s)${applied.removed.length > 0 ? `, removed ${applied.removed.join(', ')}` : ''}`,
  );
  for (const { name, path } of applied.replaced) log(`REPLACED ${name}: local definition moved to ${path}`);
  for (const [name, reason] of Object.entries(applied.unmoved))
    log(`WARN ${name}: the local definition could not be moved aside (${reason}); the agent is unusable here`);
  for (const [name, reason] of Object.entries(applied.errors))
    log(`WARN ${name}: ${reason}; the agent is unusable here`);
}

/**
 * The tick's look at the board's agents: nothing when the `version` answer names no newer version than the one applied, else
 * fetch, open under that version and apply. A document that does not open, or is older than the applied one, changes nothing:
 * the machine keeps what it has, logs a warning and records it for doctor.
 */
export async function syncSharedAgents(deps: SyncDeps): Promise<SyncResult> {
  const onBoard = await deps.backend.sharedAgentsVersion();
  if (onBoard === 'unsupported') return 'unsupported';
  if (onBoard === null) return settleBoardNames(deps) ? 'applied' : 'none';
  const applied = readBoardAgentsState(boardAgentsDirOf(deps.configFile)).version;
  if (applied !== null && onBoard <= applied) {
    if (onBoard < applied)
      deps.log(`WARN the board names agents v${onBoard}, older than v${applied} applied here; keeping v${applied}`);
    return settleBoardNames(deps) ? 'applied' : 'current';
  }
  const keep = (problem: string): SyncResult => {
    deps.log(`WARN ${problem}; keeping ${applied === null ? 'the local agents' : `agents v${applied}`}`);
    if (!deps.dryRun) recordProblem(deps.configFile, problem);
    return 'kept';
  };
  const fetched = await deps.backend.getSharedAgents();
  if (fetched === null) return keep(`the board names agents v${onBoard} but serves none`);
  if ('unreadable' in fetched) return keep(`the board's agents v${fetched.version} do not open under that version`);
  if (applied !== null && fetched.version <= applied)
    return keep(`the board serves agents v${fetched.version}, not newer than v${applied} applied here`);
  const result = await applySharedAgents(deps, fetched.document);
  if (!deps.dryRun) logApplied(deps.log, result);
  return 'applied';
}

/** The agents part of this machine's catalogue: the version applied and the hash of every agent it has, wherever defined. */
export function catalogAgents(configFile: string, agents: Record<string, AgentConfig>): CatalogAgents {
  const state = readBoardAgentsState(boardAgentsDirOf(configFile));
  const hashes: Record<string, string> = {};
  for (const name of Object.keys(agents).sort()) {
    const agent = agents[name];
    if (agent !== undefined) hashes[name] = agentHashOf(agent);
  }
  return { version: state.version, hashes, replaced: Object.keys(replacedFiles(configFile)).sort() };
}
