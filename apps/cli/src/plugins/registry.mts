import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@agent-board/shared';
import { isCommit } from './manifest.mts';
import { isMarketplaceName } from './names.mts';

export interface InstalledMarketplace {
  url: string;
  commit: string;
  installedAt: string;
  updatedAt: string;
}

export interface Registry {
  marketplaces: Record<string, InstalledMarketplace>;
}

export interface PluginPaths {
  stateDir: string;
}

export const pluginsDir = (paths: PluginPaths): string => join(paths.stateDir, 'plugins');
export const registryFile = (paths: PluginPaths): string => join(pluginsDir(paths), 'installed.json');
export const checkoutsDir = (paths: PluginPaths): string => join(pluginsDir(paths), 'marketplaces');
export const checkoutDir = (paths: PluginPaths, name: string): string => join(checkoutsDir(paths), name);

export type RegistryRead = { registry: Registry; unreadable?: undefined } | { registry: Registry; unreadable: string };

function parseEntry(value: unknown): InstalledMarketplace | undefined {
  if (!isRecord(value)) return undefined;
  const { url, commit, installedAt, updatedAt } = value;
  if (typeof url !== 'string' || typeof commit !== 'string' || !isCommit(commit)) return undefined;
  if (typeof installedAt !== 'string' || typeof updatedAt !== 'string') return undefined;
  return { url, commit, installedAt, updatedAt };
}

/** The registry, empty when no file exists; a file that cannot be read or does not parse is empty with the reason in `unreadable`. */
export function readRegistry(paths: PluginPaths): RegistryRead {
  const empty: Registry = { marketplaces: {} };
  let text: string;
  try {
    text = readFileSync(registryFile(paths), 'utf8');
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return missing ? { registry: empty } : { registry: empty, unreadable: 'it cannot be read' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { registry: empty, unreadable: 'it is not valid JSON' };
  }
  const table = isRecord(raw) ? raw['marketplaces'] : undefined;
  if (!isRecord(table)) return { registry: empty, unreadable: 'it has no marketplaces object' };
  const marketplaces: Record<string, InstalledMarketplace> = {};
  for (const [name, value] of Object.entries(table)) {
    const entry = parseEntry(value);
    if (!isMarketplaceName(name) || entry === undefined)
      return { registry: empty, unreadable: 'an entry in it is malformed' };
    marketplaces[name] = entry;
  }
  return { registry: { marketplaces } };
}

export function ensurePluginsDir(paths: PluginPaths): void {
  const dir = pluginsDir(paths);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Writes the registry beside the file and renames it over, mode 600: no reader sees half a file. */
export function writeRegistry(paths: PluginPaths, registry: Registry): void {
  ensurePluginsDir(paths);
  const file = registryFile(paths);
  const temp = `${file}.tmp-${process.pid}`;
  try {
    rmSync(temp, { force: true });
    writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
