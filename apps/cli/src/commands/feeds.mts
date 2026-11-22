import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { formatDuration, isRecord } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { ConfigError, expandHome } from '../config/config.mts';
import type { DirEntry } from '../config/config.mts';
import { readConfigFile, writeConfigFile } from '../config/config-file.mts';
import { isAllowedDir } from '../config/dirs.mts';
import { plainLine } from '../output/terminal.mts';
import { isFeedName, parseFeed, parseFeeds, FEED_NAME_RULE } from '../feeds/config.mts';
import type { FeedConfig } from '../feeds/config.mts';
import { runFeed } from '../feeds/run.mts';
import type { FeedRunDeps } from '../feeds/run.mts';
import type { FeedRun } from '../feeds/store.mts';

export interface FeedsDeps {
  configFile: string;
  cwd: string;
  dirs: readonly DirEntry[] | undefined;
  // Whether the watch unit, which runs the feeds, has touched its heartbeat lately.
  unitRunning: boolean;
  now: () => Date;
  print: (line: string) => void;
  runDeps: () => FeedRunDeps;
}

export interface FeedAddFlags {
  every?: string;
  dir?: string;
  agent?: string;
  lane?: string;
  keyPrefix?: string;
  timeout?: string;
}

const counted = (run: FeedRun): string => {
  const { listed, created, requeued, closed, failed } = run.counts;
  return `${listed} listed, ${created} created, ${requeued} requeued, ${closed} closed${failed > 0 ? `, ${failed} failed` : ''}`;
};

export function describeRun(run: FeedRun | undefined): string {
  if (run === undefined) return 'never run';
  const when = new Date(run.at).toLocaleString();
  return run.ok
    ? `ran ${when}: ${counted(run)}`
    : `failed ${when}: ${plainLine(run.error ?? 'unknown error')}${run.counts.listed > 0 ? ` (${counted(run)})` : ''}`;
}

function loaded(deps: FeedsDeps): ReturnType<typeof parseFeeds> {
  return parseFeeds(readConfigFile(deps.configFile).raw['feeds']);
}

function find(deps: FeedsDeps, name: string): FeedConfig {
  const { feeds, feedErrors } = loaded(deps);
  const feed = feeds.find((entry) => entry.name === name);
  if (feed !== undefined) return feed;
  const broken = feedErrors[name];
  if (broken !== undefined) throw new UsageError(broken);
  const known = feeds.map((entry) => entry.name);
  throw new UsageError(
    `no feed "${plainLine(name).slice(0, 40)}" in config.json; ${known.length === 0 ? 'there are none' : `there are ${known.join(', ')}`}`,
  );
}

export function feedsList(deps: FeedsDeps): void {
  const { feeds, feedErrors } = loaded(deps);
  const store = deps.runDeps().store;
  if (feeds.length === 0 && Object.keys(feedErrors).length === 0) {
    deps.print('no feeds; add one with "board feeds add"');
    return;
  }
  for (const feed of feeds) {
    const state = store.read(feed.name);
    const status = state.paused ? 'paused' : state.runNow ? 'runs next' : `every ${formatDuration(feed.everyMs)}`;
    deps.print(`${feed.name}  ${status}  ${describeRun(state.last)}`);
  }
  for (const [name, error] of Object.entries(feedErrors)) deps.print(`${plainLine(name)}  not read: ${error}`);
  if (!deps.unitRunning)
    deps.print(
      'the watch unit is not running, so no feed runs on its timer; run "board setup" or "board restart watch"',
    );
}

export function feedsAdd(deps: FeedsDeps, name: string, flags: FeedAddFlags, command: string): void {
  if (!isFeedName(name)) throw new UsageError(`a feed name must be ${FEED_NAME_RULE}`);
  if (flags.every === undefined) throw new UsageError('board feeds add needs --every, such as --every 10m');
  if (command.trim() === '') throw new UsageError('board feeds add needs the command after --');
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
    parseFeed(name, entry);
  } catch (error) {
    if (error instanceof ConfigError) throw new UsageError(error.message.replace(/^config: /, ''));
    throw error;
  }
  const { raw, mode } = readConfigFile(deps.configFile);
  const existing = raw['feeds'] ?? {};
  if (!isRecord(existing)) throw new UsageError('config.json has a feeds key that is not an object; fix it by hand');
  const replaced = Object.hasOwn(existing, name);
  writeConfigFile(deps.configFile, { ...raw, feeds: { ...existing, [name]: entry } }, mode);
  deps.print(`${replaced ? 'changed' : 'added'} feed ${name}: every ${flags.every} in ${dir}`);
}

export function feedsRemove(deps: FeedsDeps, name: string, stateDir: string): void {
  const { raw, mode } = readConfigFile(deps.configFile);
  const existing = raw['feeds'];
  if (!isRecord(existing) || !Object.hasOwn(existing, name))
    throw new UsageError(`no feed "${plainLine(name).slice(0, 40)}" in config.json`);
  const { [name]: _removed, ...rest } = existing;
  writeConfigFile(deps.configFile, { ...raw, feeds: rest }, mode);
  rmSync(join(stateDir, `${name}.json`), { force: true });
  deps.print(`removed feed ${name}; the tasks it made stay on the board`);
}

export function feedsSetPaused(deps: FeedsDeps, name: string, paused: boolean): void {
  find(deps, name);
  const store = deps.runDeps().store;
  store.write(name, { ...store.read(name), paused });
  deps.print(`${paused ? 'paused' : 'resumed'} feed ${name}`);
}

/** Runs a feed now, here, and prints what it did; `later` leaves the run to the watch unit's next look instead. */
export async function feedsRun(deps: FeedsDeps, name: string, later: boolean): Promise<boolean> {
  const feed = find(deps, name);
  const runDeps = deps.runDeps();
  if (later) {
    runDeps.store.write(name, { ...runDeps.store.read(name), runNow: true });
    deps.print(`feed ${name} runs on the watch unit's next look`);
    return true;
  }
  const run = await runFeed({ ...runDeps, log: deps.print }, feed);
  if (run === undefined) {
    deps.print(`feed ${name} is running in another process; nothing done`);
    return true;
  }
  deps.print(`feed ${name} ${describeRun(run)}`);
  return run.ok;
}
