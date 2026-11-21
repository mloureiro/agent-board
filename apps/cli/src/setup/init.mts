import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeDataKey, isSafeMachineName, MACHINE_NAME_RULE } from '@agent-board/shared';
import { checkDataKey, keyProblemMessage } from '../backend/contract-check.mts';
import type { ServerIdentity } from '../backend/contract-check.mts';
import { BackendError } from '../backend/backend.mts';
import { checkBoardUrl, looksLikeMachineToken, webUrlOf } from '../backend/web-config.mts';
import { ConfigError, readSecretFile } from '../config/config.mts';
import { parseEnv } from '../config/env-file.mts';
import exampleConfig from '../../config.example.json' with { type: 'json' };
import { UsageError } from '../cli.mts';
import { errorText } from '../output/text.mts';

export interface InitFlags {
  url?: string;
  tokenFile?: string;
  dataKeyFile?: string;
  machine?: string;
  force?: boolean;
}

// Questions for a person at a terminal; tests answer them without one. `validate` gets the raw input, as clack passes it
// (untrimmed, and before a default is applied), and the answer comes back raw too.
export interface Prompts {
  text: (
    message: string,
    options: { defaultValue?: string; validate: (value: string) => string | undefined },
  ) => Promise<string>;
  secret: (message: string, options: { validate: (value: string) => string | undefined }) => Promise<string>;
  // A yes or no; no is the default.
  confirm?: (message: string) => Promise<boolean>;
}

export interface InitDeps {
  configDir: string;
  interactive: boolean;
  prompts: Prompts;
  hostName: string;
  now: () => Date;
  print: (line: string) => void;
  verifyServer: (config: { url: string; token: string }) => Promise<ServerIdentity>;
}

export interface InitResult {
  written: string[];
  skipped: string[];
  // Files that were backed up before they were replaced.
  backedUp: string[];
}

// Clack is loaded only when a person is asked, so the hook and dispatch never pay for it.
export function clackPrompts(): Prompts {
  const answer = (value: string | symbol): string => {
    if (typeof value !== 'string') throw new UsageError('cancelled; nothing was written');
    return value;
  };
  return {
    text: async (message, { defaultValue, validate }) => {
      const clack = await import('@clack/prompts');
      return answer(
        await clack.text({
          message,
          ...(defaultValue === undefined ? {} : { defaultValue, placeholder: defaultValue }),
          // clack validates the empty input before it applies the default, so the default is what gets validated then.
          validate: (value) => validate(value === undefined || value.trim() === '' ? (defaultValue ?? '') : value),
        }),
      );
    },
    secret: async (message, { validate }) => {
      const clack = await import('@clack/prompts');
      return answer(await clack.password({ message, validate: (value) => validate(value ?? '') }));
    },
    confirm: async (message) => {
      const clack = await import('@clack/prompts');
      const value = await clack.confirm({ message, initialValue: false });
      return value === true;
    },
  };
}

export function urlProblem(url: string): string | undefined {
  try {
    checkBoardUrl(url.trim());
    return undefined;
  } catch (error) {
    return error instanceof ConfigError ? error.message.replace(/^web\.json: /, '') : 'not a URL';
  }
}

export function tokenProblem(token: string): string | undefined {
  return looksLikeMachineToken(token.trim())
    ? undefined
    : "a machine token starts with abm_ (create one on the board's Settings page)";
}

// The data key is checked by what it must be, and never echoed.
export function dataKeyProblem(key: string): string | undefined {
  try {
    decodeDataKey(key.trim());
    return undefined;
  } catch {
    return "a data key is abk1_ and 43 more characters; copy it from the board's Settings page";
  }
}

export function machineProblem(name: string): string | undefined {
  return isSafeMachineName(name.trim()) ? undefined : `use ${MACHINE_NAME_RULE}`;
}

// A token or key file is a secret like env: refused unless mode 600 or 400, which a pipe (`--token-file /dev/stdin`) is.
function readSecret(path: string, what: string): string {
  try {
    return readSecretFile(path, what).trim();
  } catch (error) {
    throw new UsageError(error instanceof ConfigError ? error.message : `cannot read the ${what} ${path}`);
  }
}

const STDIN_PATHS = ['/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'];

// The values of an env file that is there already; nothing for a missing or unreadable one.
function readEnvValues(path: string): Record<string, string> | undefined {
  try {
    return parseEnv(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

const TOKEN = 'AGENT_BOARD_TOKEN';
const DATA_KEY = 'AGENT_BOARD_DATA_KEY';

interface Pasted {
  token?: string;
  dataKey?: string;
}

// What a pasted text or a file holds: NAME=value lines (the Settings page copies those, one or both), or a bare value,
// which is `own`.
function parsePasted(text: string, own: 'token' | 'dataKey'): Pasted {
  const lines = parseEnv(text);
  const token = lines[TOKEN];
  const dataKey = lines[DATA_KEY];
  if (token !== undefined || dataKey !== undefined)
    return { ...(token === undefined ? {} : { token }), ...(dataKey === undefined ? {} : { dataKey }) };
  const bare = text.trim();
  return bare === '' ? {} : { [own]: bare };
}

// How a path reads once the shell's habits are undone: a leading `export `, quotes and spaces around it.
function normalisedPath(path: string): string {
  return path
    .trim()
    .replace(/^export\s+/, '')
    .replace(/^(["'])(.*)\1$/, '$2')
    .trim();
}

const NAME_OF = { token: TOKEN, dataKey: DATA_KEY } as const;

// What a one-line answer holds for the question asked: its bare value or its own NAME=value line; the other value's line
// is a mistake worth naming (the Settings page copies both lines, and one is pasted at each prompt).
function ownOfAnswer(text: string, field: 'token' | 'dataKey'): { value: string } | { wrongLine: string } {
  const other = field === 'token' ? 'dataKey' : 'token';
  const lines = parseEnv(text);
  if (lines[NAME_OF[field]] !== undefined) return { value: (lines[NAME_OF[field]] ?? '').trim() };
  if (lines[NAME_OF[other]] !== undefined) return { wrongLine: NAME_OF[other] };
  return { value: text.trim() };
}

function wrongLineMessage(wrongLine: string, field: 'token' | 'dataKey'): string {
  return field === 'token'
    ? `that is the ${wrongLine} line; this question wants the machine token (the bare token, or the AGENT_BOARD_TOKEN=… line)`
    : `that is the ${wrongLine} line; this question wants the data key (the bare key, or the AGENT_BOARD_DATA_KEY=… line)`;
}

// A secret typed where a path belongs: refused without echoing it.
function looksLikeSecret(path: string): boolean {
  return /^(abk1_|abm_)/.test(path) || /^AGENT_BOARD_[A-Z_]+=/.test(path);
}

const CARRIES_SECRET = /abk1_|abm_/;

function readWebUrl(path: string): string | undefined {
  try {
    return webUrlOf(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

function backupName(path: string, now: Date): string {
  return `${path}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
}

interface Pending {
  path: string;
  content: string;
  mode: number;
}

function readConfigMachine(path: string): string | undefined {
  try {
    const machine: unknown = (JSON.parse(readFileSync(path, 'utf8')) as { machine?: unknown }).machine;
    return typeof machine === 'string' ? machine : undefined;
  } catch {
    return undefined;
  }
}

// Asks the board before anything is written: the token must be accepted and the data key must be the board's.
async function verifyBoard(deps: InitDeps, url: string, token: string, dataKey: string): Promise<ServerIdentity> {
  let identity: ServerIdentity;
  try {
    identity = await deps.verifyServer({ url, token });
  } catch (error) {
    // Only the API's own answer says the token is refused; a login page or proxy with a 401 is something else.
    if (error instanceof BackendError && error.fromApi && (error.status === 401 || error.status === 403))
      throw new UsageError(
        `${url} refused the token: create a machine token on the board's Settings page and give that one; nothing was written`,
      );
    throw new UsageError(`cannot check the token with ${url}: ${errorText(error)}; nothing was written`);
  }
  const checked = await checkDataKey(decodeDataKey(dataKey), identity);
  if (!('keys' in checked)) throw new UsageError(`${keyProblemMessage(checked)}; nothing was written`);
  return identity;
}

export async function init(deps: InitDeps, flags: InitFlags): Promise<InitResult> {
  const { configDir } = deps;
  const webPath = join(configDir, 'web.json');
  const envPath = join(configDir, 'env');
  const configPath = join(configDir, 'config.json');
  const force = flags.force === true;
  const result: InitResult = { written: [], skipped: [], backedUp: [] };

  // An existing file is kept without --force. config.json holds the user's lanes and repos, so it is always kept.
  const webMissing = !existsSync(webPath);
  // An env that exists is replaced whole with --force; without it only a value it lacks is asked for and added.
  const existingEnv = readEnvValues(envPath);
  const have = { token: existingEnv?.[TOKEN], dataKey: existingEnv?.[DATA_KEY] };
  const missing = { token: !have.token, dataKey: !have.dataKey };
  const writeEnv = force || existingEnv === undefined || missing.token || missing.dataKey;
  const writeConfig = !existsSync(configPath);
  const kept: string[] = [];
  if (!writeEnv) kept.push(`kept ${envPath} (it has both values; --force replaces it after a backup)`);
  if (!writeConfig) kept.push(`kept ${configPath} (config.json is always kept; edit it by hand)`);
  if (!writeEnv) result.skipped.push(envPath);
  if (!writeConfig) result.skipped.push(configPath);

  // Everything is asked and checked before the first file is touched, and each value only when its file will be written.
  const need = (flag: string, what: string): never => {
    throw new UsageError(`${what} is needed and there is no terminal to ask: give ${flag}`);
  };
  const fail = (what: string, problem: string): never => {
    throw new UsageError(`${what}: ${problem}`);
  };
  const files: Pending[] = [];
  let boardUrl = webMissing ? undefined : readWebUrl(webPath);
  if (webMissing || force) {
    // --force keeps the current URL when none is given, as it keeps the secrets.
    const current = webMissing ? undefined : readWebUrl(webPath);
    const given =
      flags.url ??
      (deps.interactive
        ? await deps.prompts.text("The board's URL", {
            ...(current === undefined ? {} : { defaultValue: current }),
            validate: (value) => urlProblem(value.trim() === '' && current !== undefined ? current : value),
          })
        : current === undefined
          ? need('--url', "the board's URL")
          : undefined);
    const url = given === undefined ? undefined : given.trim() === '' && current !== undefined ? current : given.trim();
    if (url !== undefined) {
      const problem = urlProblem(url);
      if (problem) fail(flags.url === undefined ? "the board's URL" : '--url', problem);
    }
    if (url !== undefined) boardUrl = checkBoardUrl(url);
    if (url === undefined || checkBoardUrl(url) === current) {
      result.skipped.push(webPath);
      kept.push(
        `kept ${webPath} (${url === undefined ? 'no --url given' : 'same URL'}; --force keeps the current URL)`,
      );
    } else {
      files.push({ path: webPath, content: `${JSON.stringify({ url: checkBoardUrl(url) }, null, 2)}\n`, mode: 0o644 });
    }
  } else {
    result.skipped.push(webPath);
    kept.push(`kept ${webPath} (it exists; --force replaces it after a backup)`);
  }
  let credentials: { token: string; dataKey: string } | undefined =
    have.token && have.dataKey ? { token: have.token, dataKey: have.dataKey } : undefined;
  if (writeEnv) {
    if (flags.tokenFile !== undefined && flags.tokenFile === flags.dataKeyFile)
      throw new UsageError('--token-file and --data-key-file name the same file; they are two secrets');
    if (
      flags.tokenFile !== undefined &&
      flags.dataKeyFile !== undefined &&
      STDIN_PATHS.includes(flags.tokenFile) &&
      STDIN_PATHS.includes(flags.dataKeyFile)
    )
      throw new UsageError('only one of --token-file and --data-key-file can be /dev/stdin');
    if (!force && existingEnv !== undefined && missing.token !== missing.dataKey)
      deps.print(
        missing.dataKey
          ? `${envPath} has a token and no data key: asking for the data key only`
          : `${envPath} has a data key and no token: asking for the token only`,
      );
    // The board's Settings page copies whole env lines, so a file or an answer may hold either value, as NAME=value or
    // bare, and may hold both: one text then gives both.
    const fromFile = (flag: string, given: string | undefined, what: string, own: 'token' | 'dataKey'): Pasted => {
      if (given === undefined) return {};
      const path = normalisedPath(given);
      if (looksLikeSecret(path)) throw new UsageError(`${flag} takes the path of a file, not the secret itself`);
      // A path that holds a secret somewhere inside it is never echoed, not even in "file missing".
      if (CARRIES_SECRET.test(path))
        throw new UsageError(`${flag}: no such file (the path is not shown: it contains a secret)`);
      return parsePasted(readSecret(path, what), own);
    };
    const tokenFile = fromFile('--token-file', flags.tokenFile, 'token file', 'token');
    const keyFile = fromFile('--data-key-file', flags.dataKeyFile, 'data key file', 'dataKey');
    // A value given for its own flag wins over the same value found in the other file.
    const supplied: Pasted = {
      ...((tokenFile.token ?? keyFile.token) ? { token: tokenFile.token ?? keyFile.token } : {}),
      ...((keyFile.dataKey ?? tokenFile.dataKey) ? { dataKey: keyFile.dataKey ?? tokenFile.dataKey } : {}),
    } as Pasted;
    const resolve = async (options: {
      field: 'token' | 'dataKey';
      flag: string;
      what: string;
      message: string;
      problem: (value: string) => string | undefined;
    }): Promise<{ value: string; fresh: boolean }> => {
      const { field } = options;
      const given = supplied[field];
      if (given !== undefined) return { value: given.trim(), fresh: true };
      const current = have[field];
      // Missing values are asked for; with --force so are the ones that are there, and the current one stays if not given.
      if (!(force || missing[field])) return { value: current ?? '', fresh: false };
      if (!deps.interactive) {
        if (current !== undefined && force) return { value: current, fresh: false };
        return need(options.flag, options.what);
      }
      const keepable = current !== undefined && force;
      // A prompt takes one line: the bare value, or its own NAME=value line as the Settings page offers it.
      const answer = await deps.prompts.secret(
        keepable ? `${options.message} (Enter keeps the current one)` : options.message,
        {
          validate: (value) => {
            if (value.trim() === '' && keepable) return undefined;
            const own = ownOfAnswer(value, field);
            return 'wrongLine' in own ? wrongLineMessage(own.wrongLine, field) : options.problem(own.value);
          },
        },
      );
      if (answer.trim() === '' && keepable) return { value: current, fresh: false };
      const own = ownOfAnswer(answer, field);
      if ('wrongLine' in own)
        throw new UsageError(
          `${field === 'token' ? 'the token' : 'the data key'}: ${wrongLineMessage(own.wrongLine, field)}`,
        );
      return { value: own.value, fresh: true };
    };
    const token = await resolve({
      field: 'token',
      flag: '--token-file',
      what: 'the machine token',
      message: 'Machine token (not shown)',
      problem: tokenProblem,
    });
    if (token.fresh) {
      const problem = tokenProblem(token.value);
      if (problem) fail('the token', problem);
    }
    const dataKey = await resolve({
      field: 'dataKey',
      flag: '--data-key-file',
      what: 'the data key',
      message: "Data key (not shown; copy it from the board's Settings page)",
      problem: dataKeyProblem,
    });
    if (dataKey.fresh) {
      const problem = dataKeyProblem(dataKey.value);
      if (problem) fail('the data key', problem);
    }
    credentials = { token: token.value, dataKey: dataKey.value };
    // Everything else the file held stays too.
    const others = Object.entries(existingEnv ?? {}).filter(([name]) => name !== TOKEN && name !== DATA_KEY);
    const content = [[TOKEN, token.value], [DATA_KEY, dataKey.value], ...others]
      .map(([name, value]) => `${name}=${value}`)
      .join('\n');
    files.push({ path: envPath, content: `${content}\n`, mode: 0o600 });
  }
  // The board is asked before the first file is touched, whenever a file is about to be written.
  const board =
    (writeEnv || writeConfig) && boardUrl !== undefined && credentials !== undefined
      ? await verifyBoard(deps, boardUrl, credentials.token, credentials.dataKey)
      : undefined;
  if (board?.machine !== undefined && flags.machine !== undefined && flags.machine.trim() !== board.machine)
    fail(
      '--machine',
      `the token belongs to the machine ${board.machine}, not ${flags.machine.trim()}; nothing was written`,
    );
  if (!writeConfig && board?.machine !== undefined) {
    const named = readConfigMachine(configPath);
    if (named !== undefined && named !== board.machine)
      deps.print(
        `warning: ${configPath} names the machine ${named}, but the token belongs to ${board.machine}; every claim is refused until config.json says ${board.machine}`,
      );
  }
  if (writeConfig) {
    const fallback = deps.hostName;
    const raw =
      board?.machine ??
      flags.machine ??
      (deps.interactive
        ? await deps.prompts.text('Machine name', {
            defaultValue: fallback,
            validate: (value) => machineProblem(value.trim() === '' ? fallback : value),
          })
        : fallback);
    const machine = raw.trim() === '' ? fallback : raw.trim();
    const problem = machineProblem(machine);
    if (problem) fail('the machine name', problem);
    files.push({
      path: configPath,
      content: `${JSON.stringify({ ...exampleConfig, machine }, null, 2)}\n`,
      mode: 0o644,
    });
  }

  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // Each file is written beside its place with its final mode and renamed over it, so no failure leaves a file missing,
  // and a link in the way (even a dangling one) is replaced, not followed.
  const staged: string[] = [];
  // Every temp file, backups included, is written before the first rename, so a failure up to there changes nothing.
  const renames: { from: string; to: string }[] = [];
  const stage = (to: string, content: string | Buffer, mode: number): void => {
    const from = `${to}.tmp-${process.pid}`;
    staged.push(from);
    rmSync(from, { force: true });
    writeFileSync(from, content, { mode, flag: 'wx' });
    renames.push({ from, to });
  };
  try {
    for (const file of files) {
      const existing = statSync(file.path, { throwIfNoEntry: false });
      if (existing) {
        const backup = backupName(file.path, deps.now());
        // An env backup holds the token and the key: never wider than the file is meant to be.
        stage(backup, readFileSync(file.path), file.path === envPath ? existing.mode & 0o600 : existing.mode & 0o777);
        result.backedUp.push(backup);
      }
      stage(file.path, file.content, file.mode);
    }
    for (const { from, to } of renames) renameSync(from, to);
    result.written.push(...files.map((file) => file.path));
  } finally {
    for (const temp of staged) rmSync(temp, { force: true });
  }

  for (const path of result.written) deps.print(`wrote ${path}`);
  for (const path of result.backedUp) deps.print(`backed up the old file to ${path}`);
  for (const line of kept) deps.print(line);
  return result;
}
