// The `env` blocks of a checkout's Claude Code settings: .claude/settings.json, then .claude/settings.local.json on
// top. An agent's run loads only the user's settings, so the worker copies the variables the agent asks for from here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@agent-board/shared';

export function readSettingsEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const file of ['settings.json', 'settings.local.json']) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, '.claude', file), 'utf8'));
    } catch {
      continue;
    }
    const block = isRecord(raw) ? raw['env'] : undefined;
    if (!isRecord(block)) continue;
    for (const [name, value] of Object.entries(block)) if (typeof value === 'string') env[name] = value;
  }
  return env;
}

// The named variables from the checkout's settings, and the names it lacks.
export function pickEnv(
  available: Record<string, string>,
  names: string[],
): { env: Record<string, string>; missing: string[] } {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = available[name];
    if (value === undefined) missing.push(name);
    else env[name] = value;
  }
  return { env, missing };
}

// The named servers from the checkout's .mcp.json, as `--mcp-config` takes them, and the names it lacks. An agent's run
// does not load the settings that switch a checkout's servers on, so the worker hands over the ones the agent may use.
export function readMcpServers(
  dir: string,
  names: string[],
): { config: { mcpServers: Record<string, unknown> }; missing: string[] } {
  let servers: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    if (isRecord(raw) && isRecord(raw['mcpServers'])) servers = raw['mcpServers'];
  } catch {
    // no .mcp.json: every name is missing
  }
  const config: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  const missing: string[] = [];
  for (const name of names) {
    if (Object.hasOwn(servers, name)) config.mcpServers[name] = servers[name];
    else missing.push(name);
  }
  return { config, missing };
}

export function autoCompactSetting(layers: Record<string, string | undefined>[]): string | undefined {
  return layers.map((layer) => layer['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE']).findLast((value) => value !== undefined);
}
