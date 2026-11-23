import { join } from 'node:path';
import type { GitRunner } from '../config/checkout-repo.mts';
import { readMarketplace } from './manifest.mts';
import { parseIntegrationRef } from './names.mts';
import { verifyPin } from './pin.mts';
import { checkoutDir, readRegistry } from './registry.mts';
import type { PluginPaths } from './registry.mts';

export interface ResolveDeps {
  paths: PluginPaths;
  git: GitRunner;
}

export type Resolved = { program: string; commit: string } | { problem: string };

/** The program of `<marketplace>:<integration>` at the pinned commit, or why it cannot be used. Nothing is kept between calls. */
export function resolveIntegration(ref: string, deps: ResolveDeps): Resolved {
  const parsed = parseIntegrationRef(ref);
  if (parsed === undefined)
    return { problem: 'an integration is named <marketplace>:<integration>, in lowercase letters, digits and dashes' };
  const { marketplace: name, integration } = parsed;
  const { registry, unreadable } = readRegistry(deps.paths);
  if (unreadable !== undefined) return { problem: `the plugin registry is unreadable: ${unreadable}` };
  const entry = Object.hasOwn(registry.marketplaces, name) ? registry.marketplaces[name] : undefined;
  if (entry === undefined)
    return { problem: `marketplace ${name} is not installed; board plugins install <its repository URL>` };
  const dir = checkoutDir(deps.paths, name);
  const pin = verifyPin({ name, commit: entry.commit }, dir, deps.git);
  if (pin !== undefined) return { problem: pin };
  const manifest = readMarketplace(deps.git, dir, entry.commit);
  if (typeof manifest === 'string') return { problem: manifest };
  const feed = Object.hasOwn(manifest.feeds, integration) ? manifest.feeds[integration] : undefined;
  if (feed === undefined) {
    const known = Object.keys(manifest.feeds);
    return {
      problem: `${name} has no integration ${integration} (${known.length === 0 ? 'it has none' : `it has: ${known.join(', ')}`})`,
    };
  }
  return { program: join(dir, feed.program), commit: entry.commit };
}
