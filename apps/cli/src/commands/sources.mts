import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { formatDuration, isRecord } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { ConfigError, expandHome } from '../config/config.mts';
import type { DirEntry } from '../config/config.mts';
import { readConfigFile, writeConfigFile } from '../config/config-file.mts';
import { isAllowedDir } from '../config/dirs.mts';
import { plainLine } from '../output/terminal.mts';
import { isSourceName, parseSource, parseSources, SOURCE_NAME_RULE } from '../sources/config.mts';
import type { SourceConfig } from '../sources/config.mts';
import { runSource } from '../sources/run.mts';
import type { SourceRunDeps } from '../sources/run.mts';
import type { SourceRun } from '../sources/store.mts';

export interface SourcesDeps {
  configFile: string;
  cwd: string;
  dirs: readonly DirEntry[] | undefined;
  // Whether the watch unit, which runs the sources, has touched its heartbeat lately.
  unitRunning: boolean;
  now: () => Date;
  print: (line: string) => void;
  runDeps: () => SourceRunDeps;
}

export interface SourceAddFlags {
  every?: string;
  dir?: string;
  agent?: string;
  lane?: string;
  keyPrefix?: string;
  timeout?: string;
}

const counted = (run: SourceRun): string => {
  const { listed, created, requeued, closed, failed } = run.counts;
  return `${listed} listed, ${created} created, ${requeued} requeued, ${closed} closed${failed > 0 ? `, ${failed} failed` : ''}`;
};

export function describeRun(run: SourceRun | undefined): string {
  if (run === undefined) return 'never run';
  const when = new Date(run.at).toLocaleString();
  return run.ok
    ? `ran ${when}: ${counted(run)}`
    : `failed ${when}: ${plainLine(run.error ?? 'unknown error')}${run.counts.listed > 0 ? ` (${counted(run)})` : ''}`;
}

function loaded(deps: SourcesDeps): ReturnType<typeof parseSources> {
  return parseSources(readConfigFile(deps.configFile).raw['sources']);
}

function find(deps: SourcesDeps, name: string): SourceConfig {
  const { sources, sourceErrors } = loaded(deps);
  const source = sources.find((entry) => entry.name === name);
  if (source !== undefined) return source;
  const broken = sourceErrors[name];
  if (broken !== undefined) throw new UsageError(broken);
  const known = sources.map((entry) => entry.name);
  throw new UsageError(
    `no source "${plainLine(name).slice(0, 40)}" in config.json; ${known.length === 0 ? 'there are none' : `there are ${known.join(', ')}`}`,
  );
}

export function sourcesList(deps: SourcesDeps): void {
  const { sources, sourceErrors } = loaded(deps);
  const store = deps.runDeps().store;
  if (sources.length === 0 && Object.keys(sourceErrors).length === 0) {
    deps.print('no sources; add one with "board sources add"');
    return;
  }
  for (const source of sources) {
    const state = store.read(source.name);
    const status = state.paused ? 'paused' : state.runNow ? 'runs next' : `every ${formatDuration(source.everyMs)}`;
    deps.print(`${source.name}  ${status}  ${describeRun(state.last)}`);
  }
  for (const [name, error] of Object.entries(sourceErrors)) deps.print(`${plainLine(name)}  not read: ${error}`);
  if (!deps.unitRunning)
    deps.print(
      'the watch unit is not running, so no source runs on its timer; run "board setup" or "board restart watch"',
    );
}

export function sourcesAdd(deps: SourcesDeps, name: string, flags: SourceAddFlags, command: string): void {
  if (!isSourceName(name)) throw new UsageError(`a source name must be ${SOURCE_NAME_RULE}`);
  if (flags.every === undefined) throw new UsageError('board sources add needs --every, such as --every 10m');
  if (command.trim() === '') throw new UsageError('board sources add needs the command after --');
  const dir = flags.dir === undefined ? deps.cwd : expandHome(flags.dir);
  if (!isAllowedDir(deps.dirs, dir))
    throw new UsageError(`${plainLine(dir)} is not a listed directory; run "board dirs add" there first`);
  const entry = {
    command,
    every: flags.every,
    dir,
    ...(flags.keyPrefix === undefined ? {} : { keyPrefix: flags.keyPrefix }),
    ...(flags.agent === undefined ? {} : { agent: flags.agent }),
    ...(flags.lane === undefined ? {} : { lane: flags.lane }),
    ...(flags.timeout === undefined ? {} : { timeout: flags.timeout }),
  };
  try {
    parseSource(name, entry);
  } catch (error) {
    if (error instanceof ConfigError) throw new UsageError(error.message.replace(/^config: /, ''));
    throw error;
  }
  const { raw, mode } = readConfigFile(deps.configFile);
  const existing = raw['sources'] ?? {};
  if (!isRecord(existing)) throw new UsageError('config.json has a sources key that is not an object; fix it by hand');
  const replaced = Object.hasOwn(existing, name);
  writeConfigFile(deps.configFile, { ...raw, sources: { ...existing, [name]: entry } }, mode);
  deps.print(`${replaced ? 'changed' : 'added'} source ${name}: every ${flags.every} in ${dir}`);
}

export function sourcesRemove(deps: SourcesDeps, name: string, stateDir: string): void {
  const { raw, mode } = readConfigFile(deps.configFile);
  const existing = raw['sources'];
  if (!isRecord(existing) || !Object.hasOwn(existing, name))
    throw new UsageError(`no source "${plainLine(name).slice(0, 40)}" in config.json`);
  const { [name]: _removed, ...rest } = existing;
  writeConfigFile(deps.configFile, { ...raw, sources: rest }, mode);
  rmSync(join(stateDir, `${name}.json`), { force: true });
  deps.print(`removed source ${name}; the tasks it made stay on the board`);
}

export function sourcesSetPaused(deps: SourcesDeps, name: string, paused: boolean): void {
  find(deps, name);
  const store = deps.runDeps().store;
  store.write(name, { ...store.read(name), paused });
  deps.print(`${paused ? 'paused' : 'resumed'} source ${name}`);
}

/** Runs a source now, here, and prints what it did; `later` leaves the run to the watch unit's next look instead. */
export async function sourcesRun(deps: SourcesDeps, name: string, later: boolean): Promise<boolean> {
  const source = find(deps, name);
  const runDeps = deps.runDeps();
  if (later) {
    runDeps.store.write(name, { ...runDeps.store.read(name), runNow: true });
    deps.print(`source ${name} runs on the watch unit's next look`);
    return true;
  }
  const run = await runSource({ ...runDeps, log: deps.print }, source);
  if (run === undefined) {
    deps.print(`source ${name} is running in another process; nothing done`);
    return true;
  }
  deps.print(`source ${name} ${describeRun(run)}`);
  return run.ok;
}
