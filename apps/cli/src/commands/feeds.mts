import { formatDuration, isRecord } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { ConfigError } from '../config/config.mts';
import type { DirEntry } from '../config/config.mts';
import { readConfigFile, writeConfigFile } from '../config/config-file.mts';
import { isAllowedDir } from '../config/dirs.mts';
import { plainLine } from '../output/terminal.mts';
import { isFeedName, parseFeed, parseFeeds, FEED_NAME_RULE } from '../feeds/config.mts';
import type { FeedConfig } from '../feeds/config.mts';
import { runAsked, runFeed } from '../feeds/run.mts';
import type { FeedRunDeps } from '../feeds/run.mts';
import type { FeedRun } from '../feeds/store.mts';

export interface FeedsDeps {
  configFile: string;
  dirs: readonly DirEntry[] | undefined;
  unitRunning: boolean;
  now: () => Date;
  print: (line: string) => void;
  runDeps: () => FeedRunDeps;
}

const counted = (run: FeedRun): string => {
  const { listed, created, requeued, rescheduled, closed, failed } = run.counts;
  return `${listed} listed, ${created} created, ${requeued} requeued${rescheduled > 0 ? `, ${rescheduled} rescheduled` : ''}, ${closed} closed${failed > 0 ? `, ${failed} failed` : ''}`;
};

export function describeRun(run: FeedRun | undefined): string {
  if (run === undefined) return 'never run';
  const when = new Date(run.at).toLocaleString();
  if (run.invalid === true) return `invalid ${when}: ${plainLine(run.error ?? 'unknown error')}`;
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
    const control = store.readControl(feed.name);
    const record = store.readRecord(feed.name);
    const status = control.paused
      ? 'paused'
      : runAsked(control, record)
        ? 'runs next'
        : `every ${formatDuration(feed.everyMs)}`;
    deps.print(`${feed.name}  ${status}  ${feed.integration} · ${feed.action}  ${describeRun(record.last)}`);
  }
  for (const [name, error] of Object.entries(feedErrors)) deps.print(`${plainLine(name)}  not read: ${error}`);
  if (!deps.unitRunning)
    deps.print(
      'the watch unit is not running, so no feed runs on its timer; run "board setup" or "board restart watch"',
    );
}

export function feedsAdd(deps: FeedsDeps, name: string, text: string): void {
  if (!isFeedName(name)) throw new UsageError(`a feed name must be ${FEED_NAME_RULE}`);
  let entry: unknown;
  try {
    entry = JSON.parse(text);
  } catch {
    throw new UsageError('the feed entry is not valid JSON');
  }
  let feed: FeedConfig;
  try {
    feed = parseFeed(name, entry);
  } catch (error) {
    if (error instanceof ConfigError) throw new UsageError(error.message.replace(/^config: /, ''));
    throw error;
  }
  if (!isAllowedDir(deps.dirs, feed.dir))
    throw new UsageError(`${plainLine(feed.dir)} is not a listed directory; run "board dirs add" there first`);
  const { raw, mode } = readConfigFile(deps.configFile);
  const existing = raw['feeds'] ?? {};
  if (!isRecord(existing)) throw new UsageError('config.json has a feeds key that is not an object; fix it by hand');
  const replaced = Object.hasOwn(existing, name);
  writeConfigFile(deps.configFile, { ...raw, feeds: { ...existing, [name]: entry } }, mode);
  deps.print(
    `${replaced ? 'changed' : 'added'} feed ${name}: ${feed.integration} · ${feed.action} every ${formatDuration(feed.everyMs)} in ${feed.dir}`,
  );
}

export function feedsRemove(deps: FeedsDeps, name: string): void {
  if (!isFeedName(name)) throw new UsageError(`a feed name must be ${FEED_NAME_RULE}`);
  const { raw, mode } = readConfigFile(deps.configFile);
  const existing = raw['feeds'];
  if (!isRecord(existing) || !Object.hasOwn(existing, name))
    throw new UsageError(`no feed "${plainLine(name).slice(0, 40)}" in config.json`);
  const store = deps.runDeps().store;
  if (!store.lock(name)) throw new UsageError(`feed ${name} is running; try again when it ends`);
  try {
    const { [name]: _removed, ...rest } = existing;
    writeConfigFile(deps.configFile, { ...raw, feeds: rest }, mode);
    store.discard(name);
  } finally {
    store.unlock(name);
  }
  deps.print(`removed feed ${name}; the tasks it made stay on the board`);
}

export function feedsSetPaused(deps: FeedsDeps, name: string, paused: boolean): void {
  find(deps, name);
  deps.runDeps().store.updateControl(name, { paused });
  deps.print(`${paused ? 'paused' : 'resumed'} feed ${name}`);
}

/** Runs a feed now, here, and prints what it did. */
export async function feedsRun(deps: FeedsDeps, name: string): Promise<boolean> {
  const feed = find(deps, name);
  const run = await runFeed({ ...deps.runDeps(), log: deps.print }, feed);
  if (run === undefined) {
    deps.print(`feed ${name} is running in another process; nothing done`);
    return true;
  }
  deps.print(`feed ${name} ${describeRun(run)}`);
  return run.ok;
}
