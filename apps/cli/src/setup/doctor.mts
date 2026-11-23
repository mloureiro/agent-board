import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BackendError } from '../backend/backend.mts';
import { checkDataKey, verifyContract } from '../backend/contract-check.mts';
import type { ServerIdentity } from '../backend/contract-check.mts';
import { looksLikeMachineToken, webUrlOf } from '../backend/web-config.mts';
import type { WebConfig } from '../backend/web-config.mts';
import {
  ConfigError,
  configWarnings,
  getPaths,
  isIgnoredSkillsWarning,
  isOverrideWarning,
  isSafeMode,
  parseConfig,
  readBoardAgentsState,
  boardAgentsDirOf,
  withAgentsDir,
  withBoardAgents,
  REMOVED_INTAKE,
} from '../config/config.mts';
import { catalogAgents, replacedFiles } from '../config/board-agents.mts';
import type { Config } from '../config/config.mts';
import { plainLine } from '../output/terminal.mts';
import {
  API_VERSION,
  decodeDataKey,
  machineCatalogIndex,
  machineDirsIndex,
  SERVER_FEATURE_LABELS,
  SERVER_FEATURES,
} from '@agent-board/shared';
import type { Keys } from '@agent-board/shared';
import { runGit } from '../config/checkout-repo.mts';
import { runCommand } from '../dispatch/waits.mts';
import type { CommandResult, CommandSpec } from '../dispatch/waits.mts';
import { feedProblemText, feedsBeyondCap, parseFeeds } from '../feeds/config.mts';
import { doctor } from '../feeds/integration.mts';
import { validateFeed } from '../feeds/validate.mts';
import { verifyPin } from '../plugins/pin.mts';
import { checkoutDir, readRegistry } from '../plugins/registry.mts';
import type { RegistryRead } from '../plugins/registry.mts';
import { resolveIntegration } from '../plugins/resolve.mts';
import type { Resolved } from '../plugins/resolve.mts';
import { pluginPlaceholders } from '../worker/plan.mts';
import { catalogDirs, composeCatalog } from '../catalog/catalog.mts';
import { createCatalogStore } from '../catalog/cache.mts';
import type { CatalogStore } from '../catalog/cache.mts';
import { dirsToSend, isAllowedDir, isDirectory, routedDirs, UNCOVERED_HINT } from '../config/dirs.mts';
import { CREDENTIALS_COMMAND_VARIABLE, runCredentialsCommand } from '../config/credentials-source.mts';
import { parseEnv } from '../config/env-file.mts';
import { runDir } from '../worker/runtime.mts';
import {
  createUsageStore,
  describeReached,
  earliestReset,
  reachedWindows,
  usageFile,
  USAGE_WINDOWS,
  WINDOW_LABELS,
} from '../usage/usage.mts';
import type { UsageStore } from '../usage/usage.mts';
import {
  LISTEN_SERVICE,
  WATCH_SERVICE,
  parseExecStart,
  REMOVED_UNIT_FILES,
  UNIT_NAMES,
  UNIT_PATH,
  whichOnPath,
} from './setup.mts';
import {
  AGENT_NAMES,
  agentFile,
  agentLabel,
  agentPath,
  bootstrapCommand,
  isAgentLoaded,
  launchAgentsDirectory,
  parseProgramArguments,
} from './launchd.mts';
import type { AgentName } from './launchd.mts';
import { errorText, shellQuote } from '../output/text.mts';
import { PluginError, resolvePluginRoot } from '../worker/plugins.mts';
import type { PluginFiles } from '../worker/plugins.mts';

export type Level = 'ok' | 'fail' | 'warn';

export interface CheckResult {
  name: string;
  level: Level;
  message: string;
  // How to fix it; set for a failure or a warning.
  hint?: string;
}

// Everything a check touches, so the checks run in tests without the machine.
export interface DoctorDeps {
  configDir: string;
  unitDir: string;
  // AGENT_BOARD_CREDENTIALS_COMMAND when set: the credentials come from it and not from the env file.
  credentialsCommand?: string;
  runCredentials?: (command: string) => Record<string, string>;
  // The version of Node this runs on; undefined on another runtime.
  nodeVersion: string | undefined;
  readText: (path: string) => string | undefined;
  mode: (path: string) => number | undefined;
  exists: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  // The real path of an existing path; undefined when it is not there.
  realpath: (path: string) => string | undefined;
  // Where a program is on the shell's PATH, and where on the PATH the units run with.
  which: (program: string) => string | undefined;
  whichInUnits: (program: string) => string | undefined;
  home: string;
  // process.platform: only a Linux or a macOS machine can be a worker.
  platform: string;
  launchd: LaunchdDoctorDeps;
  // A read-only systemctl call: its exit code.
  systemctl: (args: string[]) => Promise<number>;
  verifyServer: (config: Pick<WebConfig, 'url' | 'token'>) => Promise<ServerIdentity>;
  // What this machine learned of its directories' skills and models.
  catalogStore: CatalogStore;
  // The subscription usage this machine's runs reported.
  usageStore: Pick<UsageStore, 'read'>;
  now: () => Date;
  // Runs a program of an integration; a `path` in the spec replaces PATH.
  runCommand: (spec: CommandSpec) => Promise<CommandResult>;
  // The installed plugin marketplaces: the registry, why a checkout is not at its pinned commit, and an integration's program.
  plugins: {
    read: () => RegistryRead;
    verify: (name: string, commit: string) => string | undefined;
    resolve: (ref: string) => Resolved;
  };
}

// What the macOS worker checks touch.
export interface LaunchdDoctorDeps {
  // ~/Library/LaunchAgents
  agentsDir: string;
  uid: number;
  // The run directory.
  runDir: string;
  // Whether launchd has loaded the agent (`launchctl print` finds it).
  loaded: (name: AgentName) => Promise<boolean>;
  // Whether files can be made in the directory, or in the nearest directory above it that exists.
  writable: (dir: string) => boolean;
}

type Credentials = { token?: string; dataKey?: Uint8Array; results: CheckResult[] };

type Check = (deps: DoctorDeps, credentials: Credentials) => CheckResult[] | Promise<CheckResult[]>;

const ok = (name: string, message: string): CheckResult => ({ name, level: 'ok', message });
const problem = (name: string, level: 'fail' | 'warn', message: string, hint: string): CheckResult => ({
  name,
  level,
  message,
  hint,
});

// Whether a file can be made in `dir`, or in the nearest directory above it that exists (the run directory is made on first use).
function isWritable(dir: string): boolean {
  let at = dir;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  try {
    accessSync(at, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function realLaunchdDoctorDeps(env: Record<string, string | undefined>, home: string): LaunchdDoctorDeps {
  const uid = process.getuid?.() ?? 0;
  return {
    agentsDir: launchAgentsDirectory(home),
    uid,
    runDir: runDir(env, 'darwin'),
    loaded: (name) => isAgentLoaded(uid, name),
    writable: isWritable,
  };
}

export function realDoctorDeps(
  configDir: string,
  unitDir: string,
  systemctl: DoctorDeps['systemctl'],
  which: DoctorDeps['which'],
  home: string,
  launchd: DoctorDeps['launchd'],
  whichInUnits: DoctorDeps['whichInUnits'] = (program) =>
    whichOnPath(program, process.platform === 'darwin' ? agentPath(home) : unitPath(home)),
): DoctorDeps {
  return {
    home,
    launchd,
    platform: process.platform,
    whichInUnits,
    configDir,
    unitDir,
    nodeVersion: process.versions['bun'] ? undefined : process.versions.node,
    readText: (file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    },
    mode: (file) => statSync(file, { throwIfNoEntry: false })?.mode,
    exists: (file) => existsSync(file),
    isDirectory,
    realpath: (file) => {
      try {
        return realpathSync(file);
      } catch {
        return undefined;
      }
    },
    which,
    systemctl,
    verifyServer: (config) => verifyContract(config),
    catalogStore: createCatalogStore(),
    usageStore: createUsageStore(usageFile(getPaths().stateDir)),
    now: () => new Date(),
    runCommand: (spec) => runCommand(spec),
    plugins: {
      read: () => readRegistry(getPaths()),
      verify: (name, commit) => verifyPin({ name, commit }, checkoutDir(getPaths(), name), runGit),
      resolve: (ref) => resolveIntegration(ref, { paths: getPaths(), git: runGit }),
    },
  };
}

const checkNode: Check = ({ nodeVersion }) => {
  if (nodeVersion === undefined) return [];
  const major = Number(nodeVersion.split('.')[0]);
  return [
    major >= 24
      ? ok('node', `Node ${nodeVersion}`)
      : problem(
          'node',
          'fail',
          `Node ${nodeVersion} is too old`,
          'install Node 24 or newer (NODE=/path/to/node apps/cli/install.sh)',
        ),
  ];
};

const checkConfigDir: Check = ({ configDir, isDirectory }) => [
  isDirectory(configDir)
    ? ok('config dir', configDir)
    : problem('config dir', 'fail', `${configDir} does not exist`, 'run "board init"'),
];

function readWebUrl({ configDir, readText }: DoctorDeps): { url?: string; result: CheckResult } {
  const path = join(configDir, 'web.json');
  const text = readText(path);
  if (text === undefined) return { result: problem('web.json', 'fail', `${path} is missing`, 'run "board init"') };
  try {
    const url = webUrlOf(JSON.parse(text));
    return { url, result: ok('web.json', url) };
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : 'is not valid JSON';
    return { result: problem('web.json', 'fail', `${path}: ${message}`, 'run "board init --force" to write it again') };
  }
}

const checkWeb: Check = (deps) => [readWebUrl(deps).result];

function readCredentials(deps: DoctorDeps): Credentials {
  const { configDir, readText, mode, credentialsCommand } = deps;
  if (credentialsCommand !== undefined) {
    let values: Record<string, string>;
    try {
      values = (deps.runCredentials ?? runCredentialsCommand)(credentialsCommand);
    } catch (error) {
      return {
        results: [
          problem(
            'credentials',
            'fail',
            error instanceof ConfigError ? error.message : `${credentialsCommand} could not be run`,
            `fix the command, or unset ${CREDENTIALS_COMMAND_VARIABLE} to use the env file`,
          ),
        ],
      };
    }
    return checkValues(
      values,
      `the output of ${credentialsCommand}`,
      [ok('credentials', `from ${credentialsCommand}`)],
      credentialsCommand,
    );
  }
  const path = join(configDir, 'env');
  const text = readText(path);
  if (text === undefined)
    return {
      results: [
        problem(
          'env',
          'fail',
          `${path} is missing`,
          'run "board init" (the token comes from the board\'s Settings page)',
        ),
      ],
    };
  const results: CheckResult[] = [];
  const fileMode = mode(path) ?? 0;
  if (isSafeMode(fileMode)) results.push(ok('env mode', (fileMode & 0o777).toString(8)));
  else
    results.push(
      problem(
        'env mode',
        'fail',
        `${path} has mode ${(fileMode & 0o777).toString(8)}; the CLI refuses it`,
        `chmod 600 ${path}`,
      ),
    );
  return checkValues(parseEnv(text), 'env', results, undefined);
}

function checkValues(
  values: Record<string, string>,
  source: string,
  results: CheckResult[],
  command: string | undefined,
): Credentials {
  const fixCommand = `fix what ${command ?? ''} prints, or unset ${CREDENTIALS_COMMAND_VARIABLE} to use the env file`;
  const token = values['AGENT_BOARD_TOKEN'];
  if (!token) {
    results.push(
      problem(
        'token',
        'fail',
        `AGENT_BOARD_TOKEN is not set in ${source}`,
        command === undefined
          ? 'run "board init": it sees the env without a token and asks for the token only'
          : fixCommand,
      ),
    );
  } else {
    results.push(
      looksLikeMachineToken(token)
        ? ok('token', 'present')
        : problem(
            'token',
            'warn',
            'the token does not start with abm_',
            command === undefined
              ? "create a machine token on the board's Settings page"
              : `create a machine token on the board's Settings page and store it where ${command} reads it`,
          ),
    );
  }
  // The key is never printed, nor part of any message.
  const encodedKey = values['AGENT_BOARD_DATA_KEY'];
  let dataKey: Uint8Array | undefined;
  if (!encodedKey) {
    results.push(
      problem(
        'data key',
        'fail',
        `AGENT_BOARD_DATA_KEY is not set in ${source}`,
        command === undefined
          ? 'copy the data key from the board\'s Settings page and run "board init": it sees the env without a key and asks for the key only'
          : fixCommand,
      ),
    );
  } else {
    try {
      dataKey = decodeDataKey(encodedKey);
      results.push(ok('data key', 'present and well-formed'));
    } catch {
      results.push(
        problem(
          'data key',
          'fail',
          'AGENT_BOARD_DATA_KEY is not a data key (abk1_ and 43 more characters)',
          command === undefined
            ? 'copy it again from the board\'s Settings page and run "board init --force": it keeps the URL and the token unless you give them again, and asks for the key'
            : fixCommand,
        ),
      );
    }
  }
  return { ...(token ? { token } : {}), ...(dataKey ? { dataKey } : {}), results };
}

const checkEnv: Check = (_deps, credentials) => credentials.results;

const quoted = (text: string): string => shellQuote(plainLine(text));

const unitPath = (home: string): string => UNIT_PATH.replaceAll('%h', () => home);

// A server that lacks a feature still works; only the commands that need it refuse.
const missingFeatureChecks = (features: ReadonlySet<string>): CheckResult[] => {
  const lacking = SERVER_FEATURES.filter((feature) => !features.has(feature));
  return lacking.length === 0
    ? []
    : [
        problem(
          'server features',
          'warn',
          `the board server does not support ${lacking.map((feature) => SERVER_FEATURE_LABELS[feature]).join(', ')} yet`,
          'update the board server; until then the commands that need it refuse',
        ),
      ];
};

// The config of this machine, or undefined when it is missing or does not parse (the config.json check says why).
function readParsedConfig(deps: DoctorDeps): Config | undefined {
  const text = deps.readText(join(deps.configDir, 'config.json'));
  try {
    return parseConfig(text === undefined ? undefined : JSON.parse(text));
  } catch {
    return undefined;
  }
}

// Whether the board holds the current directory list of this machine, for a machine with a `dirs` key and a server that can hold one.
async function dirsOnBoardChecks(deps: DoctorDeps, identity: ServerIdentity, keys: Keys): Promise<CheckResult[]> {
  if (!identity.features.has('machine.dirs')) return [];
  const config = readParsedConfig(deps);
  if (config?.dirs === undefined) return [];
  const index = await machineDirsIndex(keys, config.machine, dirsToSend(config.dirs, deps.isDirectory));
  return [
    index === identity.dirsIndex
      ? ok('dirs on board', 'the board has the current list')
      : problem(
          'dirs on board',
          'warn',
          'the board does not have the current list yet',
          'the next dispatch tick sends it; "board dirs add" or "board dirs rm" send it at once',
        ),
  ];
}

// Whether the board holds the current catalogue of skills and models, as far as this machine has probed: the dispatcher asks
// claude in one directory per tick, so a machine with several directories is complete after as many ticks.
async function catalogOnBoardChecks(deps: DoctorDeps, identity: ServerIdentity, keys: Keys): Promise<CheckResult[]> {
  if (!identity.features.has('machine.catalog')) return [];
  const config = readParsedConfig(deps);
  if (config === undefined) return [];
  const entries = catalogDirs(config, deps.isDirectory).flatMap((dir) => {
    const entry = deps.catalogStore.read(dir);
    return entry?.result ? [{ ...entry, result: entry.result }] : [];
  });
  let trimmed = false;
  const composed = composeCatalog(entries, deps.catalogStore.initSkills(), () => (trimmed = true));
  // The dispatcher sends the agents part with it, so the index is of both.
  const configFile = join(deps.configDir, 'config.json');
  const catalog =
    composed === undefined
      ? undefined
      : {
          ...composed,
          agents: catalogAgents(
            configFile,
            withBoardAgents(withAgentsDir(config, join(deps.configDir, 'agents')), configFile).agents,
          ),
        };
  if (catalog === undefined)
    return [ok('catalog on board', 'nothing probed yet: the next dispatch tick asks claude for its skills and models')];
  const count = `${catalog.skills.length + Object.values(catalog.dirs).reduce((sum, list) => sum + list.length, 0)} skills, ${catalog.models.length} models${trimmed ? ', cut to fit the size limit' : ''}`;
  return [
    (await machineCatalogIndex(keys, config.machine, catalog)) === identity.catalogIndex
      ? ok('catalog on board', `the board has the current catalogue (${count})`)
      : problem(
          'catalog on board',
          'warn',
          `the board does not have the current catalogue yet (${count})`,
          'the next dispatch tick sends it',
        ),
  ];
}

const checkServer: Check = async (deps, { token, dataKey }) => {
  const { url } = readWebUrl(deps);
  if (url === undefined || token === undefined) return [];
  try {
    const identity = await deps.verifyServer({ url, token });
    const results = [
      ok(
        'server',
        `${url} answers, api ${API_VERSION}, server api ${identity.api.version} (serves clients from ${identity.api.minClient})`,
      ),
      ...missingFeatureChecks(identity.features),
    ];
    // A board without a key cannot be matched, whatever env holds: say so first, with the way out.
    if (identity.keyId === null)
      return [
        ...results,
        problem(
          'board key',
          'fail',
          'the board has no data key yet',
          'set up encryption in the browser first, then copy the key from the Settings page and run "board init"',
        ),
      ];
    if (dataKey === undefined) return results;
    // The board's key and this machine's: derived for the board's owner, compared by id, neither ever printed.
    const checked = await checkDataKey(dataKey, identity);
    if ('keys' in checked)
      return [
        ...results,
        ok('board key', `the board's data key is id ${checked.keys.keyId}, and this machine holds it`),
        ...(await dirsOnBoardChecks(deps, identity, checked.keys)),
        ...(await catalogOnBoardChecks(deps, identity, checked.keys)),
        ...boardAgentsVersionChecks(deps, identity),
      ];
    return [
      ...results,
      problem(
        'board key',
        'fail',
        checked.problem === 'board-has-no-key'
          ? 'the board has no data key yet'
          : `this machine holds a different data key (id ${checked.mine}) than the board's (id ${checked.boards})`,
        'copy the current key from the board\'s Settings page and run "board init --force": it keeps the URL and the token unless you give them again, and asks for the key',
      ),
    ];
  } catch (error) {
    const message = errorText(error);
    // Only the API's own answer says the token is refused; a login page or proxy with a 401 is something else.
    if (error instanceof BackendError && error.fromApi && (error.status === 401 || error.status === 403))
      return [
        problem(
          'server',
          'fail',
          `${url} refused the token`,
          'create a new machine token on the board\'s Settings page and run "board init --force": it keeps the URL and the data key unless you give them again, and asks for the token',
        ),
      ];
    // Which update hint to show comes from the two API numbers, never from text the server wrote.
    if (error instanceof BackendError && error.contractMismatch !== undefined)
      return [
        problem(
          'server',
          'fail',
          message,
          error.contractMismatch === 'server-older'
            ? "update the board server to this CLI's API version"
            : 'update this CLI: "board self-update" for a binary; "git pull" and "pnpm install" in the checkout for a checkout',
        ),
      ];
    return [problem('server', 'fail', message, 'check the URL in web.json and that the board is up')];
  }
};

// Where Claude Code keeps its plugin lists, under the home directory doctor was given.
function readPluginFiles(deps: DoctorDeps): PluginFiles | undefined {
  const readJson = (file: string): unknown => {
    const text = deps.readText(file);
    try {
      return text === undefined ? undefined : JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const installedPlugins = readJson(join(deps.home, '.claude', 'plugins', 'installed_plugins.json'));
  if (installedPlugins === undefined) return undefined;
  return {
    installedPlugins,
    knownMarketplaces: readJson(join(deps.home, '.claude', 'plugins', 'known_marketplaces.json')),
    marketplaceManifest: (root) => readJson(join(root, '.claude-plugin', 'marketplace.json')),
    dirExists: deps.isDirectory,
  };
}

// The tool an allow rule is for: "Bash" for `Bash(git status)`. MCP rules name servers and patterns, which `tools` may cover
// in ways not worth guessing at.
const ruleTool = (rule: string): string => rule.split('(')[0] ?? rule;

// A plugin placeholder in rules that does not resolve fails every run those rules govern.
function checkPlugins(
  name: string,
  owner: string,
  lists: { allowedTools: string[]; disallowedTools: string[] },
  pluginFiles: PluginFiles | undefined,
): CheckResult[] {
  return pluginPlaceholders([...lists.allowedTools, ...lists.disallowedTools]).flatMap((placeholder) => {
    try {
      if (pluginFiles === undefined) throw new PluginError('cannot read ~/.claude/plugins/installed_plugins.json');
      resolvePluginRoot(placeholder, pluginFiles);
      return [];
    } catch (error) {
      return [
        problem(
          name,
          'warn',
          `its rules name {${placeholder}}, which does not resolve (${errorText(error)}), so a run as ${owner} fails`,
          'install the plugin, or name its marketplace as {plugin@marketplace}',
        ),
      ];
    }
  });
}

// What the last applies of the board's agents left to look at: a look at the board that changed nothing, and the local
// definitions they moved aside. Warnings only: the machine runs what it has.
function checkBoardAgents(configFile: string): CheckResult[] {
  const state = readBoardAgentsState(boardAgentsDirOf(configFile));
  const results: CheckResult[] = [];
  if (state.problem !== undefined)
    results.push(
      problem(
        "board's agents",
        'warn',
        plainLine(state.problem),
        'the dispatcher log says more; the machine keeps the agents it applied last',
      ),
    );
  const moved = Object.values(replacedFiles(configFile)).flat();
  if (moved.length > 0)
    results.push(
      problem(
        'agents.replaced',
        'warn',
        `the board's agents replaced local definitions, kept in ${moved.map((file) => plainLine(file)).join(', ')}`,
        'delete them once you do not need them; "board agents add <file> --name <other>" restores one under another name',
      ),
    );
  return results;
}

// Whether this machine applied the version of the board's agents the board holds; a server that hides a newer one is not seen.
function boardAgentsVersionChecks(deps: DoctorDeps, identity: ServerIdentity): CheckResult[] {
  if (!identity.features.has('agents.shared') || identity.agentsVersion === undefined) return [];
  const applied = readBoardAgentsState(boardAgentsDirOf(join(deps.configDir, 'config.json'))).version;
  if (applied !== null && applied >= identity.agentsVersion)
    return [ok("board's agents", `this machine applied v${applied}, the version the board holds`)];
  return [
    problem(
      "board's agents",
      'warn',
      `the board holds agents v${identity.agentsVersion}, this machine applied ${applied === null ? 'none' : `v${applied}`}`,
      'the next dispatch tick applies them; if it does not, the dispatcher log says why',
    ),
  ];
}

// What would make an agent's run fail or its rules dead letters: an agent that cannot be read, a plugin it names that does not
// resolve, an allow rule for a tool its `tools` leave out.
function checkAgents(config: Config, deps: DoctorDeps): CheckResult[] {
  const entries = Object.entries(config.agents);
  const results = [
    ...Object.entries(config.agentErrors).map(([name, reason]) =>
      problem(
        `agent ${plainLine(name.slice(0, 40))}`,
        'fail',
        `${reason}; tasks that name it are not run`,
        config.board?.names.includes(name) === true
          ? `the board's definition holds a key this CLI does not know ("board self-update"), or push a fixed one with "board agents push"; a local definition that could not be moved aside must be moved or removed by hand`
          : Object.hasOwn(config.agentFiles ?? {}, name)
            ? `fix the file, or remove it with "board agents rm ${plainLine(name.slice(0, 40))}"`
            : 'fix the agent in config.json',
      ),
    ),
    ...(entries.length === 0 ? [] : [ok('agents', entries.map(([name]) => name).join(', '))]),
  ];
  const pluginFiles = readPluginFiles(deps);
  for (const [name, agent] of entries) {
    results.push(...checkPlugins(`agent ${name}`, name, agent, pluginFiles));
    const dead = [
      ...new Set(
        agent.allowedTools.map(ruleTool).filter((tool) => !tool.startsWith('mcp__') && !agent.tools.includes(tool)),
      ),
    ];
    if (dead.length > 0)
      results.push(
        problem(
          `agent ${name}`,
          'warn',
          `allowedTools has rules for ${dead.join(', ')}, which tools leaves out: the agent does not have ${dead.length === 1 ? 'that tool' : 'those tools'}`,
          `add ${dead.length === 1 ? 'it' : 'them'} to agents.${name}.tools`,
        ),
      );
  }
  return results;
}

const checkConfig: Check = (deps) => {
  const { configDir, readText } = deps;
  const path = join(configDir, 'config.json');
  const text = readText(path);
  if (text === undefined)
    return [
      problem(
        'config.json',
        'warn',
        `${path} is missing; only a worker machine needs it`,
        'run "board init" on a worker machine',
      ),
    ];
  try {
    const raw: unknown = JSON.parse(text);
    const config = withBoardAgents(withAgentsDir(parseConfig(raw), join(configDir, 'agents')), path);
    return [
      ok('config.json', `machine ${config.machine}`),
      ...checkAgents(config, deps),
      ...checkBoardAgents(path),
      ...configWarnings(raw).map((warning) =>
        warning === REMOVED_INTAKE
          ? problem('config.json', 'fail', warning, 'delete the intake key from config.json')
          : problem(
              'config.json',
              'warn',
              warning,
              isOverrideWarning(warning)
                ? 'the directory setting is the one that counts: remove the old key, or make both name the same directory'
                : isIgnoredSkillsWarning(warning)
                  ? 'set "default": true on the lane every other task should use, then remove the skills lists; pass --lane <name> where a script relied on the skill prefix'
                  : 'fix or remove the key: the CLI does not read it, so its setting keeps the default',
            ),
      ),
    ];
  } catch (error) {
    const message = error instanceof SyntaxError ? 'is not valid JSON' : errorText(error);
    return [
      problem(
        'config.json',
        'fail',
        `${path}: ${message}`,
        'fix the file; "board init --force" does not replace it, config.example.json shows the shape',
      ),
    ];
  }
};

// The list of directories workers may run in. Tasks routed to a directory outside it stop in Needs me, so that is a failure.
const checkDirs: Check = (deps) => {
  const text = deps.readText(join(deps.configDir, 'config.json'));
  let config: Config;
  try {
    config = parseConfig(text === undefined ? undefined : JSON.parse(text));
  } catch {
    return [];
  }
  const { dirs } = config;
  if (dirs === undefined) return [ok('dirs', 'not set: workers are not limited to directories')];
  const results = [ok('dirs', `${dirs.length} listed`)];
  for (const { path } of dirs)
    if (!deps.isDirectory(path))
      results.push(
        problem(
          'dirs',
          'warn',
          `${plainLine(path)} is listed but is not a directory`,
          `"board dirs rm ${quoted(path)}"`,
        ),
      );
  for (const { label, path } of routedDirs(config)) {
    const real = deps.realpath(path) ?? path;
    if (!isAllowedDir(dirs, path, (file) => deps.realpath(file) ?? file))
      results.push(
        problem(
          'dirs',
          'fail',
          `${label} ${plainLine(path)} is in no listed directory: ${UNCOVERED_HINT}`,
          `"board dirs add ${quoted(real)}", or "board dirs add --from-config"`,
        ),
      );
  }
  return results;
};

// The usage thresholds, the last reading of each limited window and whether work is held back right now. Nothing here can
// fail: a missing reading only means no run here has reported one yet.
const checkUsageLimits: Check = (deps) => {
  const limits = readParsedConfig(deps)?.usageLimits;
  if (limits === undefined) return [];
  const usage = deps.usageStore.read();
  const now = deps.now();
  const limited = USAGE_WINDOWS.filter((window) => limits[window] !== undefined);
  const parts = limited.map((window) => {
    const label = `${WINDOW_LABELS[window]} limit ${limits[window]}%`;
    const stored = usage[window];
    if (stored === undefined) return `${label}, no reading yet (the first run here reports one)`;
    const percent = Math.round(stored.utilization * 100);
    const over = new Date(stored.resetsAt) <= now ? ', window since reset, so void' : '';
    return `${label}, last reading ${percent}% seen ${stored.seenAt}${over}`;
  });
  const reached = reachedWindows({ limits, usage, now });
  const reset = earliestReset(reached);
  const held =
    reset === undefined
      ? `tasks below ${limits.priority} are not held now`
      : `tasks below ${limits.priority} are held now until ${reset.toISOString()} (${describeReached(reached)})`;
  return [ok('usage limits', `${parts.length === 0 ? 'no window limited' : parts.join('; ')}; ${held}`)];
};

// Absolute paths in a unit's ExecStart that are not systemd specifiers must still exist: a moved checkout or a removed Node breaks the unit quietly.
function checkCommand(deps: DoctorDeps, service: string): CheckResult[] {
  const text = deps.readText(join(deps.unitDir, service));
  const args = text === undefined ? undefined : parseExecStart(text);
  if (args === undefined) return [];
  // %h is the home directory; what is left with a % (the lock in %t) is not a program.
  const paths = args
    .map((arg) => arg.replaceAll('%h', () => deps.home))
    .filter((arg) => arg.startsWith('/') && !arg.includes('%'));
  const missing = paths.filter((path) => !deps.exists(path));
  return [
    missing.length === 0
      ? ok(`${service} command`, 'its programs exist')
      : problem(
          `${service} command`,
          'fail',
          `${missing.join(', ')} no longer exists`,
          'run "board setup" again from the installed CLI',
        ),
  ];
}

const TOOLS = ['claude', 'gh', 'flock', 'systemd-run', 'systemctl'];
const MAC_TOOLS = ['claude', 'gh', 'lockf'];

function installedUnits(deps: DoctorDeps): string[] {
  return [
    ...UNIT_NAMES.flatMap((name) => [`agent-board-${name}.service`, `agent-board-${name}.timer`]),
    LISTEN_SERVICE,
    WATCH_SERVICE,
  ].filter((file) => deps.exists(join(deps.unitDir, file)));
}

// The worker's tools and services exist only on Linux (systemd) and macOS (launchd), so on another system their checks would
// only send the user after programs it does not have.
const notAWorker = (platform: string): CheckResult =>
  ok(
    'worker',
    `not checked: a worker needs Linux with systemd or macOS, and this is ${platform}. The board commands work here, except ask, add, polish and setup`,
  );

// Under these folders of the home directory macOS lets a background job read only with the user's consent (TCC), which nobody
// is there to give: a checkout in one fails the run.
const PROTECTED_FOLDERS = ['Documents', 'Desktop', 'Downloads', 'Library/Mobile Documents'];

function protectedFolderOf(path: string, home: string): string | undefined {
  return PROTECTED_FOLDERS.find((folder) => path === `${home}/${folder}` || path.startsWith(`${home}/${folder}/`));
}

// Directories config.json names that a background job on macOS cannot read.
function checkProtectedFolders(deps: DoctorDeps): CheckResult[] {
  const text = deps.readText(join(deps.configDir, 'config.json'));
  let config: Config;
  try {
    config = parseConfig(text === undefined ? undefined : JSON.parse(text));
  } catch {
    return [];
  }
  const named = [...(config.dirs ?? []).map(({ path }) => ({ label: 'dirs', path })), ...routedDirs(config)];
  return named.flatMap(({ label, path }) => {
    const folder = protectedFolderOf(path, deps.home) ?? protectedFolderOf(deps.realpath(path) ?? path, deps.home);
    return folder === undefined
      ? []
      : [
          problem(
            'folders',
            'warn',
            `${label} ${plainLine(path)} is under ~/${folder}, where macOS blocks background jobs (TCC)`,
            'keep checkouts outside ~/Documents, ~/Desktop, ~/Downloads and iCloud Drive, or give the board binary Full Disk Access in System Settings > Privacy & Security',
          ),
        ];
  });
}

// A launch agent's absolute program paths must still exist; the lock file is made on the first tick.
function checkAgentCommand(deps: DoctorDeps, name: AgentName): CheckResult[] {
  const text = deps.readText(join(deps.launchd.agentsDir, agentFile(name)));
  const args = text === undefined ? undefined : parseProgramArguments(text);
  if (args === undefined) return [];
  const missing = args.filter((arg) => arg.startsWith('/') && !arg.endsWith('.lock') && !deps.exists(arg));
  return [
    missing.length === 0
      ? ok(`${agentFile(name)} command`, 'its programs exist')
      : problem(
          `${agentFile(name)} command`,
          'fail',
          `${missing.join(', ')} no longer exists`,
          'run "board setup" again from the installed CLI',
        ),
  ];
}

// A macOS worker machine: its tools, the launch agents, the run directory and the folders it can read. Like Linux, a warning
// on a machine that installed no agent and a failure on one that did.
async function checkMacWorker(deps: DoctorDeps): Promise<CheckResult[]> {
  const { launchd } = deps;
  const installed = AGENT_NAMES.filter((name) => deps.exists(join(launchd.agentsDir, agentFile(name))));
  const level = installed.length > 0 ? 'fail' : 'warn';
  const results: CheckResult[] = [];
  for (const tool of MAC_TOOLS) {
    const found = deps.whichInUnits(tool);
    const onShell = deps.which(tool);
    if (found === undefined && onShell !== undefined)
      results.push(
        problem(
          `tool ${tool}`,
          level,
          `${tool} is at ${onShell}, on your shell's PATH but not on the agents' (${agentPath(deps.home)})`,
          `link it into ~/.local/bin (ln -s ${onShell} ~/.local/bin/${tool}), then run "board doctor" again`,
        ),
      );
    else
      results.push(
        found
          ? ok(`tool ${tool}`, found)
          : problem(
              `tool ${tool}`,
              level,
              `${tool} is not on PATH`,
              `install ${tool} and make it visible to the launch agents`,
            ),
      );
  }
  results.push(
    launchd.writable(launchd.runDir)
      ? ok('run directory', launchd.runDir)
      : problem(
          'run directory',
          level,
          `${launchd.runDir} cannot be written`,
          'make it writable, or set AGENT_BOARD_RUN_DIR',
        ),
  );
  if (installed.length === 0)
    results.push(
      problem(
        'launchd agents',
        'warn',
        'no agent-board launch agent is installed',
        'run "board setup" on a worker machine',
      ),
    );
  for (const name of AGENT_NAMES) {
    const file = agentFile(name);
    const path = join(launchd.agentsDir, file);
    if (!installed.includes(name)) {
      // The listener only adds speed to the timer's ticks, and the watch unit to the tick's own polling.
      if (installed.length > 0)
        results.push(
          problem(`launchd ${file}`, name === 'dispatch' ? 'fail' : 'warn', `${path} is missing`, 'run "board setup"'),
        );
      continue;
    }
    results.push(ok(`launchd ${file}`, 'installed'), ...checkAgentCommand(deps, name));
    results.push(
      (await launchd.loaded(name))
        ? ok(`${agentLabel(name)} state`, 'loaded')
        : problem(
            `${agentLabel(name)} state`,
            'warn',
            'not loaded (setup was not run with --enable, or background items are switched off in System Settings > General > Login Items)',
            bootstrapCommand(launchd.uid, path),
          ),
    );
  }
  results.push(...checkProtectedFolders(deps));
  return results;
}

// A worker machine's tools and units: a warning on a machine that has installed no unit, a failure on one that has.
const checkWorker: Check = async (deps) => {
  if (deps.platform === 'darwin') return checkMacWorker(deps);
  if (deps.platform !== 'linux') return [notAWorker(deps.platform)];
  const installed = installedUnits(deps);
  const level = installed.length > 0 ? 'fail' : 'warn';
  const results: CheckResult[] = [];
  for (const tool of TOOLS) {
    const found = deps.whichInUnits(tool);
    const onShell = deps.which(tool);
    if (found === undefined && onShell !== undefined)
      results.push(
        problem(
          `tool ${tool}`,
          level,
          `${tool} is at ${onShell}, on your shell's PATH but not on the units' (${unitPath(deps.home)})`,
          `link it into ~/.local/bin (ln -s ${onShell} ~/.local/bin/${tool}), then run "board doctor" again`,
        ),
      );
    else
      results.push(
        found
          ? ok(`tool ${tool}`, found)
          : problem(
              `tool ${tool}`,
              level,
              `${tool} is not on PATH`,
              `install ${tool} and make it visible to the user systemd units`,
            ),
      );
  }
  const leftover = REMOVED_UNIT_FILES.filter((file) => deps.exists(join(deps.unitDir, file)));
  if (leftover.length > 0)
    results.push(
      problem(
        'unit agent-board-intake',
        'warn',
        `${leftover.join(' and ')} ${leftover.length === 1 ? 'is' : 'are'} installed, but the built-in intake was removed and nothing runs it`,
        'run "board setup": it disables the timer and deletes the files',
      ),
    );
  if (installed.length === 0) {
    results.push(problem('units', 'warn', 'no agent-board unit is installed', 'run "board setup" on a worker machine'));
    return results;
  }
  for (const name of UNIT_NAMES) {
    const service = `agent-board-${name}.service`;
    const timer = `agent-board-${name}.timer`;
    for (const file of [service, timer]) {
      if (!installed.includes(file))
        results.push(problem(`unit ${file}`, 'fail', `${join(deps.unitDir, file)} is missing`, 'run "board setup"'));
      else results.push(ok(`unit ${file}`, 'installed'));
    }
    results.push(...checkCommand(deps, service));
    if (installed.includes(timer)) {
      const enabled = (await deps.systemctl(['--user', 'is-enabled', timer])) === 0;
      const active = (await deps.systemctl(['--user', 'is-active', timer])) === 0;
      results.push(
        enabled && active
          ? ok(`${timer} state`, 'enabled and active')
          : problem(
              `${timer} state`,
              'warn',
              `${enabled ? 'enabled' : 'not enabled'}, ${active ? 'active' : 'not active'}`,
              `systemctl --user enable --now ${timer}`,
            ),
      );
    }
  }
  results.push(
    ...(await checkService(deps, installed, LISTEN_SERVICE, 'new tasks wait for the next timer tick')),
    ...(await checkService(
      deps,
      installed,
      WATCH_SERVICE,
      'the dispatch tick polls the watches, and their events reach a task only when it is woken',
    )),
  );
  return results;
};

// The listener and the watch unit are additions to the timers, which do the same work every 2 minutes: a missing or stopped one
// only warns. `whenMissing` says what the machine does without it.
async function checkService(
  deps: DoctorDeps,
  installed: string[],
  service: string,
  whenMissing: string,
): Promise<CheckResult[]> {
  if (!installed.includes(service))
    return [problem(`unit ${service}`, 'warn', `not installed: ${whenMissing}`, 'run "board setup" to install it')];
  const enabled = (await deps.systemctl(['--user', 'is-enabled', service])) === 0;
  const active = (await deps.systemctl(['--user', 'is-active', service])) === 0;
  return [
    ok(`unit ${service}`, 'installed'),
    ...checkCommand(deps, service),
    enabled && active
      ? ok(`${service} state`, 'enabled and active')
      : problem(
          `${service} state`,
          'warn',
          `${enabled ? 'enabled' : 'not enabled'}, ${active ? 'active' : 'not active'}`,
          `systemctl --user enable --now ${service}`,
        ),
  ];
}

const unitsPath = ({ platform, home }: DoctorDeps): string =>
  platform === 'darwin' ? agentPath(home) : unitPath(home);

const FEED_HINT = "fix the entry in config.json, or run the program's describe to see what it takes";

const checkPluginsAndFeeds: Check = async (deps) => {
  const { registry, unreadable } = deps.plugins.read();
  const marketplaces = Object.entries(registry.marketplaces);
  const text = deps.readText(join(deps.configDir, 'config.json'));
  let feedsRaw: unknown;
  try {
    feedsRaw = text === undefined ? undefined : (JSON.parse(text) as { feeds?: unknown } | null)?.feeds;
  } catch {
    feedsRaw = undefined;
  }
  const parsed = ((): ReturnType<typeof parseFeeds> => {
    try {
      return parseFeeds(feedsRaw);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      return { feeds: [], feedErrors: { feeds: error.message } };
    }
  })();
  const results: CheckResult[] = [];
  if (unreadable !== undefined)
    results.push(
      problem('plugins', 'fail', `the plugin registry is unreadable: ${unreadable}`, 'run "board plugins list"'),
    );
  for (const [name, entry] of marketplaces) {
    const reason = deps.plugins.verify(name, entry.commit);
    results.push(
      reason === undefined
        ? ok(`plugins.${name}`, `${name} at ${entry.commit.slice(0, 12)}`)
        : problem(`plugins.${name}`, 'fail', plainLine(reason), `run "board plugins update ${name}"`),
    );
  }
  if (marketplaces.length > 0 && deps.whichInUnits('git') === undefined)
    results.push(
      problem(
        'git',
        'warn',
        `git is not on the units' PATH (${unitsPath(deps)})`,
        'install git where the units can find it; the pin check of every feed needs it',
      ),
    );
  const beyond = feedsBeyondCap(parsed.feeds.length + Object.keys(parsed.feedErrors).length);
  if (beyond !== undefined) results.push(problem('feeds', 'warn', beyond, 'remove a feed with "board feeds remove"'));
  for (const [name, message] of Object.entries(parsed.feedErrors))
    results.push(problem(`feeds.${plainLine(name)}`, 'fail', plainLine(feedProblemText(message)), FEED_HINT));
  const programs = new Map<string, { program: string; dir: string }>();
  for (const feed of parsed.feeds) {
    const validated = await validateFeed(feed, { resolve: deps.plugins.resolve, run: deps.runCommand });
    if (!validated.ok) {
      results.push(problem(`feeds.${feed.name}`, 'fail', validated.reason, FEED_HINT));
      continue;
    }
    results.push(ok(`feeds.${feed.name}`, `${feed.integration} · ${feed.action}`));
    if (!programs.has(feed.integration)) programs.set(feed.integration, { program: validated.program, dir: feed.dir });
  }
  for (const [ref, { program, dir }] of programs) {
    const answer = await doctor(program, dir, deps.runCommand, unitsPath(deps));
    results.push(
      answer.ok
        ? ok(`integrations.${ref}`, answer.summary ?? 'ready')
        : problem(
            `integrations.${ref}`,
            'fail',
            answer.reason,
            "the watch unit runs feeds with this PATH: the program's interpreter (its shebang) and the tools it calls must be found on it, for example through a link in ~/.local/bin",
          ),
    );
  }
  return results;
};

const CHECKS: Check[] = [
  checkNode,
  checkConfigDir,
  checkWeb,
  checkEnv,
  checkServer,
  checkConfig,
  checkDirs,
  checkUsageLimits,
  checkPluginsAndFeeds,
  checkWorker,
];

export async function runChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const credentials = readCredentials(deps);
  for (const check of CHECKS) results.push(...(await check(deps, credentials)));
  return results;
}

const MARKS: Record<Level, string> = { ok: '✓', fail: '✗', warn: '!' };

export function formatResult(result: CheckResult): string {
  const hint = result.hint === undefined ? '' : `\n    → ${result.hint}`;
  return `${MARKS[result.level]} ${result.name}: ${result.message}${hint}`;
}

export function hasFailure(results: CheckResult[]): boolean {
  return results.some((result) => result.level === 'fail');
}
