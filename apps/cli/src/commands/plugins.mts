import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { ConfigError } from '../config/config.mts';
import { readConfigFile } from '../config/config-file.mts';
import { isDirectory } from '../config/dirs.mts';
import type { GitRunner } from '../config/checkout-repo.mts';
import { plainLine } from '../output/terminal.mts';
import { TRANSFER_TIMEOUT_MS } from '../plugins/git.mts';
import type { Transfer } from '../plugins/git.mts';
import { isCommit, loadMarketplace, readMarketplace } from '../plugins/manifest.mts';
import { isMarketplaceName } from '../plugins/names.mts';
import { hasLocalChanges, localChangesProblem, verifyPin } from '../plugins/pin.mts';
import {
  checkoutDir,
  checkoutsDir,
  ensurePluginsDir,
  pluginsDir,
  readRegistry,
  registryFile,
  writeRegistry,
} from '../plugins/registry.mts';
import type { InstalledMarketplace, PluginPaths, Registry } from '../plugins/registry.mts';
import { checkInstallUrl } from '../plugins/url.mts';

export interface PluginsDeps {
  paths: PluginPaths;
  configFile: string;
  git: GitRunner;
  transfer: Transfer;
  now: () => Date;
  print: (line: string) => void;
}

const DESCRIPTION_CAP = 120;
const LOG_LINES = 20;

const short = (commit: string): string => commit.slice(0, 12);

/** Third-party text for one terminal line: control characters replaced, cut at `max` characters. */
function shown(text: string, max: number): string {
  const line = plainLine(text);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function writableRegistry(deps: PluginsDeps): Registry {
  const { registry, unreadable } = readRegistry(deps.paths);
  if (unreadable !== undefined)
    throw new UsageError(
      `the plugin registry ${registryFile(deps.paths)} is unreadable (${unreadable}); fix or delete it, then install the marketplaces again`,
    );
  return registry;
}

function installedEntry(registry: Registry, name: string): InstalledMarketplace {
  if (!isMarketplaceName(name))
    throw new UsageError(
      `"${shown(name, 40)}" is not a marketplace name (1 to 40 lowercase letters, digits or dashes)`,
    );
  const entry = Object.hasOwn(registry.marketplaces, name) ? registry.marketplaces[name] : undefined;
  if (entry !== undefined) return entry;
  const known = Object.keys(registry.marketplaces);
  throw new UsageError(
    `marketplace ${name} is not installed${known.length === 0 ? ', and no marketplace is installed; add one with board plugins install <git url>' : `; installed: ${known.join(', ')}`}`,
  );
}

interface FeedUse {
  feed: string;
  integration: string;
}

function feedsUsing(configFile: string, marketplace: string): FeedUse[] {
  if (!existsSync(configFile)) return [];
  const feeds = readConfigFile(configFile).raw['feeds'];
  if (!isRecord(feeds)) return [];
  const uses: FeedUse[] = [];
  for (const [feed, entry] of Object.entries(feeds)) {
    const integration = isRecord(entry) ? entry['integration'] : undefined;
    if (typeof integration === 'string' && integration.startsWith(`${marketplace}:`)) uses.push({ feed, integration });
  }
  return uses;
}

function feedsUsingOrNone(configFile: string, marketplace: string): FeedUse[] {
  try {
    return feedsUsing(configFile, marketplace);
  } catch (error) {
    if (error instanceof ConfigError) return [];
    throw error;
  }
}

function headOf(git: GitRunner, dir: string, ref: string): string {
  const commit = git(dir, ['rev-parse', ref]);
  if (commit === undefined || !isCommit(commit)) throw new UsageError(`git failed in ${dir}`);
  return commit;
}

function detach(git: GitRunner, dir: string, commit: string): void {
  if (git(dir, ['checkout', '--quiet', '--detach', commit]) === undefined) throw new UsageError(`git failed in ${dir}`);
}

function removeStaleClones(deps: PluginsDeps): void {
  const dir = pluginsDir(deps.paths);
  const limit = deps.now().getTime() - TRANSFER_TIMEOUT_MS;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('.tmp-')) continue;
    try {
      if (statSync(join(dir, name)).mtimeMs < limit) rmSync(join(dir, name), { recursive: true, force: true });
    } catch {
      continue;
    }
  }
}

export function pluginsInstall(deps: PluginsDeps, url: string): void {
  const reason = checkInstallUrl(url);
  if (reason !== undefined) throw new UsageError(reason);
  const registry = writableRegistry(deps);
  ensurePluginsDir(deps.paths);
  removeStaleClones(deps);
  const temp = join(pluginsDir(deps.paths), `.tmp-${randomBytes(6).toString('hex')}`);
  let placed: string | undefined;
  try {
    if (!deps.transfer.clone(url, temp)) throw new UsageError(`git could not clone ${shown(url, 200)}`);
    const commit = headOf(deps.git, temp, 'HEAD');
    const marketplace = loadMarketplace(deps.git, temp, commit);
    if (typeof marketplace === 'string')
      throw new UsageError(`${shown(url, 200)} is not a usable marketplace: ${shown(marketplace, 200)}`);
    const { name } = marketplace;
    const taken = Object.hasOwn(registry.marketplaces, name) ? registry.marketplaces[name] : undefined;
    if (taken !== undefined)
      throw new UsageError(
        `marketplace ${name} is installed from ${shown(taken.url, 200)}; run board plugins update ${name}, or remove it first`,
      );
    const dest = checkoutDir(deps.paths, name);
    if (existsSync(dest))
      throw new UsageError(`${dest} exists but is not a registered marketplace; delete it, then install again`);
    detach(deps.git, temp, commit);
    mkdirSync(checkoutsDir(deps.paths), { recursive: true, mode: 0o700 });
    renameSync(temp, dest);
    placed = dest;
    const at = deps.now().toISOString();
    writeRegistry(deps.paths, {
      marketplaces: { ...registry.marketplaces, [name]: { url, commit, installedAt: at, updatedAt: at } },
    });
    placed = undefined;
    deps.print(`installed marketplace ${name} at ${short(commit)} from ${shown(url, 200)}`);
    const keys = Object.keys(marketplace.feeds);
    for (const key of keys) {
      const description = marketplace.feeds[key]?.description;
      deps.print(`${name}:${key}${description === undefined ? '' : `  ${shown(description, DESCRIPTION_CAP)}`}`);
    }
    deps.print(
      keys[0] === undefined
        ? 'the marketplace lists no integrations'
        : `a feed names an integration in its integration key, e.g. ${name}:${keys[0]}`,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
    if (placed !== undefined) rmSync(placed, { recursive: true, force: true });
  }
}

function printLog(deps: PluginsDeps, dir: string, from: string, to: string): void {
  const log = deps.git(dir, ['log', '--oneline', '--no-decorate', `${from}..${to}`]);
  if (log === undefined || log === '') return;
  const lines = log.split('\n');
  for (const line of lines.slice(0, LOG_LINES)) deps.print(`  ${shown(line, DESCRIPTION_CAP)}`);
  if (lines.length > LOG_LINES) deps.print(`  … and ${lines.length - LOG_LINES} more`);
}

export function pluginsUpdate(deps: PluginsDeps, name: string): void {
  const registry = writableRegistry(deps);
  const entry = installedEntry(registry, name);
  const dir = checkoutDir(deps.paths, name);
  if (!isDirectory(dir))
    throw new UsageError(
      `the checkout ${dir} of marketplace ${name} is missing; remove it with board plugins remove ${name} and install it again`,
    );
  const changed = hasLocalChanges(dir, deps.git);
  if (changed === undefined) throw new UsageError(`git failed in ${dir}`);
  if (changed) throw new UsageError(localChangesProblem(name, dir));
  if (!deps.transfer.fetch(dir))
    throw new UsageError(`git could not fetch marketplace ${name} from ${shown(entry.url, 200)}`);
  const next = headOf(deps.git, dir, 'FETCH_HEAD');
  if (next === entry.commit) {
    deps.print(`${name} is at ${short(next)}, the latest`);
    return;
  }
  const marketplace = loadMarketplace(deps.git, dir, next);
  if (typeof marketplace === 'string')
    throw new UsageError(
      `marketplace ${name} at ${short(next)} is not usable: ${shown(marketplace, 200)}; the pin stays at ${short(entry.commit)}`,
    );
  if (marketplace.name !== name)
    throw new UsageError(
      `the marketplace now calls itself ${shown(marketplace.name, 40)}; remove ${name} and install it again`,
    );
  const dropped = feedsUsingOrNone(deps.configFile, name).filter(
    (use) => !Object.hasOwn(marketplace.feeds, use.integration.slice(name.length + 1)),
  );
  detach(deps.git, dir, next);
  writeRegistry(deps.paths, {
    marketplaces: { ...registry.marketplaces, [name]: { ...entry, commit: next, updatedAt: deps.now().toISOString() } },
  });
  deps.print(`${name}: ${short(entry.commit)} → ${short(next)}`);
  printLog(deps, dir, entry.commit, next);
  for (const use of dropped)
    deps.print(
      `warning: feed ${shown(use.feed, 40)} names ${shown(use.integration, 80)}, which this marketplace no longer has; it stops running until fixed`,
    );
}

export function pluginsRemove(deps: PluginsDeps, name: string): void {
  const registry = writableRegistry(deps);
  installedEntry(registry, name);
  const uses = feedsUsing(deps.configFile, name);
  if (uses.length > 0)
    throw new UsageError(
      `feeds ${uses.map((use) => shown(use.feed, 40)).join(', ')} use ${name}; remove them first (board feeds rm <feed>)`,
    );
  const dir = checkoutDir(deps.paths, name);
  if (isDirectory(dir)) {
    const changed = hasLocalChanges(dir, deps.git);
    if (changed === undefined) throw new UsageError(`git failed in ${dir}`);
    if (changed) throw new UsageError(localChangesProblem(name, dir));
  }
  const rest = Object.fromEntries(Object.entries(registry.marketplaces).filter(([key]) => key !== name));
  writeRegistry(deps.paths, { marketplaces: rest });
  rmSync(dir, { recursive: true, force: true });
  deps.print(`removed marketplace ${name}`);
}

export function pluginsList(deps: PluginsDeps): void {
  const { registry, unreadable } = readRegistry(deps.paths);
  if (unreadable !== undefined)
    deps.print(`the plugin registry ${registryFile(deps.paths)} is unreadable (${unreadable}); treating it as empty`);
  const names = Object.keys(registry.marketplaces);
  if (names.length === 0) {
    deps.print('no marketplaces installed; add one with "board plugins install <git url>"');
    return;
  }
  for (const name of names) {
    const entry = registry.marketplaces[name];
    if (entry === undefined) continue;
    const dir = checkoutDir(deps.paths, name);
    deps.print(
      `${name}  ${shown(entry.url, 200)}  at ${short(entry.commit)}  installed ${entry.installedAt.slice(0, 10)}, updated ${entry.updatedAt.slice(0, 10)}`,
    );
    const problem = verifyPin({ name, commit: entry.commit }, dir, deps.git);
    if (problem !== undefined) {
      deps.print(`  ${shown(problem, 300)}`);
      continue;
    }
    deps.print('  ok');
    const marketplace = readMarketplace(deps.git, dir, entry.commit);
    if (typeof marketplace === 'string') {
      deps.print(`  ${shown(marketplace, 300)}`);
      continue;
    }
    const uses = feedsUsingOrNone(deps.configFile, name);
    for (const [key, feed] of Object.entries(marketplace.feeds)) {
      const users = uses.filter((use) => use.integration === `${name}:${key}`).map((use) => shown(use.feed, 40));
      deps.print(
        `  ${name}:${key}   ${shown(feed.program, 200)}${feed.description === undefined ? '' : `   ${shown(feed.description, DESCRIPTION_CAP)}`}${users.length > 0 ? `   used by ${users.join(', ')}` : ''}`,
      );
    }
  }
}
