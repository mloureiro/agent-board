import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeDataKey, isRecord } from '@agent-board/shared';
import { ConfigError } from '../config/config.mts';
import { loadCredentials } from '../config/credentials-source.mts';

const AGENT_BOARD_TOKEN_PREFIX = 'abm_';

export interface WebConfig {
  url: string;
  token: string;
  // The user's data key: it seals and opens everything the board stores. Never printed.
  dataKey: Uint8Array;
}

// The board's URL as web.json and `board init` accept it.
export function checkBoardUrl(url: unknown): string {
  if (typeof url !== 'string' || /\s/.test(url) || !/^https?:\/\/[^/]+/.test(url))
    throw new ConfigError("web.json: url must be the board's http(s) URL");
  // Plain http only to this machine: the token must not cross a network in the clear.
  if (url.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url)) {
    throw new ConfigError('web.json: url must use https unless it is localhost');
  }
  return url.replace(/\/+$/, '');
}

// The board URL in the parsed content of a web.json; a ConfigError when it has none or it is not one.
export function webUrlOf(raw: unknown): string {
  return checkBoardUrl(isRecord(raw) ? raw['url'] : undefined);
}

// A machine token as the board issues them.
export function looksLikeMachineToken(token: string): boolean {
  return token.startsWith(AGENT_BOARD_TOKEN_PREFIX) && !/\s/.test(token);
}

export function parseWebConfig(raw: unknown, env: Record<string, string>): WebConfig {
  if (!isRecord(raw)) throw new ConfigError('web.json: top level must be an object');
  const url = webUrlOf(raw);
  const token = env['AGENT_BOARD_TOKEN'];
  if (!token)
    throw new ConfigError(
      'the credentials file needs AGENT_BOARD_TOKEN (create one on the board\'s Settings page, then run "board init")',
    );
  const encodedKey = env['AGENT_BOARD_DATA_KEY'];
  if (!encodedKey)
    throw new ConfigError(
      'the credentials file needs AGENT_BOARD_DATA_KEY (copy it from the board\'s Settings page, then run "board init")',
    );
  let dataKey: Uint8Array;
  try {
    dataKey = decodeDataKey(encodedKey);
  } catch {
    throw new ConfigError(
      "AGENT_BOARD_DATA_KEY is not a data key (abk1_ and 43 more characters): copy it again from the board's Settings page",
    );
  }
  return { url, token, dataKey };
}

export function loadWebConfig(
  configDir: string,
  env: Record<string, string | undefined> = process.env,
  options: { timeoutMs?: number } = {},
): WebConfig {
  const path = join(configDir, 'web.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(
      error instanceof SyntaxError
        ? `web.json is not valid JSON: ${path}`
        : `web.json missing: ${path} (run "board init")`,
    );
  }
  return parseWebConfig(raw, loadCredentials(configDir, env, options).values);
}
