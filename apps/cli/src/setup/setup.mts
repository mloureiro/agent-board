import { execFile } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { TOOL_UNIT_NAMES } from '@agent-board/shared';
import { EXEC_PATH, isCompiledBinary, selfCommand } from '../self/self.mts';
import { getPaths } from '../config/config.mts';
import { ensureRunDir, runDir } from '../worker/runtime.mts';
import {
  agentLabel,
  agentTarget,
  bootstrapCommand,
  isAgentLoaded,
  launchAgentsDirectory,
  passedEnv,
  renderAgents,
} from './launchd.mts';
import type { LaunchdSetupDeps } from './launchd.mts';
import { SystemError } from './system.mts';
import { DISPATCH_UNIT, LISTEN_UNIT, WATCH_UNIT, lockArgv, workerPath } from './worker-units.mts';

const exec = promisify(execFile);

// The PATH of the units: what the worker finds `claude`, `gh` and `systemd-run` on, whatever the shell's PATH is. %h is the home directory.
export const UNIT_PATH = workerPath('linux', '%h');

// Every unit name must be in TOOL_UNIT_NAMES, which keeps it from being a task id and so a worker unit's name.
type ToolUnitName = (typeof TOOL_UNIT_NAMES)[number];
export const UNIT_NAMES = ['dispatch'] as const satisfies readonly ToolUnitName[];
export type UnitName = (typeof UNIT_NAMES)[number];

// The files of the removed built-in intake, which setup deletes.
export const REMOVED_UNIT_FILES = ['agent-board-intake.service', 'agent-board-intake.timer'];
const REMOVED_TIMER = 'agent-board-intake.timer';

// The listener is a service without a timer: it holds the board's event stream and starts dispatch ticks.
const LISTEN_NAME: ToolUnitName = 'listen';
export const LISTEN_SERVICE = `agent-board-${LISTEN_NAME}.service`;

// The watch unit runs the machine's watches (`board watch`); like the listener it is a service without a timer.
const WATCH_NAME: ToolUnitName = 'watch';
export const WATCH_SERVICE = `agent-board-${WATCH_NAME}.service`;

// The services that keep running code until they are restarted.
export const LONG_RUNNING_SERVICES = [LISTEN_SERVICE, WATCH_SERVICE];

// Exit 75 is `flock -E 75`: another tick holds the lock, which is not a failure.
const systemdInterval = (seconds: number): string => (seconds % 60 === 0 ? `${seconds / 60}min` : `${seconds}s`);

const UNITS: Record<UnitName, { description: string; timerDescription: string; accuracy: string }> = {
  dispatch: {
    description: 'agent-board dispatcher: one tick',
    timerDescription: 'agent-board dispatcher every 2 minutes',
    accuracy: '10s',
  },
};

// One argument of an ExecStart line: `%` and `$` are systemd's own, and anything unusual goes in double quotes.
export function quoteExecArg(arg: string): string {
  if (/[\n\r]/.test(arg)) throw new SystemError(`cannot put a line break in a unit file: ${JSON.stringify(arg)}`);
  const escaped = arg.replaceAll('%', () => '%%').replaceAll('$', () => '$$');
  if (/^[A-Za-z0-9_@:,./=+-]+$/.test(escaped.replaceAll('%%', () => '').replaceAll('$$', () => ''))) return escaped;
  return `"${escaped.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// The arguments of an ExecStart line, as systemd reads them (the reverse of quoteExecArg; specifiers stay as written).
export function parseExecStart(unit: string): string[] | undefined {
  const line = /^ExecStart=(.*)$/m.exec(unit)?.[1];
  if (line === undefined) return undefined;
  const args: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const match of line.matchAll(pattern)) {
    args.push(
      (match[1]?.replace(/\\(.)/g, '$1') ?? match[2] ?? '').replaceAll('%%', () => '%').replaceAll('$$', () => '$'),
    );
  }
  return args;
}

export interface UnitFile {
  file: string;
  text: string;
}

export interface RenderInput {
  // The absolute path of flock.
  flock: string;
  // The command that runs `internal <name>`.
  command: (name: UnitName | 'listen' | 'watch') => string[];
}

export function renderUnits({ flock, command }: RenderInput): UnitFile[] {
  const timed = UNIT_NAMES.flatMap((name) => {
    const unit = UNITS[name];
    // %t is the runtime directory, where bin/dispatch keeps the same lock file.
    const execStart = [
      // %t is systemd's specifier, so the lock path is the one argument not quoted.
      ...lockArgv('linux', quoteExecArg(flock), `%t/${DISPATCH_UNIT.lockFile}`),
      ...command(name).map(quoteExecArg),
    ].join(' ');
    return [
      {
        file: `agent-board-${name}.service`,
        text: `[Unit]
Description=${unit.description}

[Service]
Type=oneshot
# PATH is for gh, claude and systemd-run.
Environment=PATH=${UNIT_PATH}
# The lock keeps one run at a time, whoever starts it; exit 75 means another run holds it, which is not a failure.
ExecStart=${execStart}
SuccessExitStatus=75
TimeoutStartSec=${DISPATCH_UNIT.limitSeconds}
`,
      },
      {
        file: `agent-board-${name}.timer`,
        text: `[Unit]
Description=${unit.timerDescription}

[Timer]
OnBootSec=${systemdInterval(DISPATCH_UNIT.everySeconds)}
OnUnitActiveSec=${systemdInterval(DISPATCH_UNIT.everySeconds)}
AccuracySec=${unit.accuracy}

[Install]
WantedBy=timers.target
`,
      },
    ];
  });
  const listen: UnitFile = {
    file: LISTEN_SERVICE,
    text: `[Unit]
Description=agent-board listener: dispatch as soon as the board says tasks changed
# The listener exits when the board no longer serves this CLI, until the CLI is updated; systemd must keep restarting it, not give up.
StartLimitIntervalSec=0

[Service]
Type=simple
# PATH is for the gh, claude and systemd-run that the dispatch ticks it starts use.
Environment=PATH=${UNIT_PATH}
ExecStart=${command('listen').map(quoteExecArg).join(' ')}
Restart=always
RestartSec=${LISTEN_UNIT.restartDelaySeconds}
# Stopping signals the listener only; it waits for a running tick, which systemd then no longer cuts off midway.
KillMode=mixed
# Long enough for a tick to reach its limit and grace; systemd's 90 s default would kill one midway.
TimeoutStopSec=${LISTEN_UNIT.stopTimeoutSeconds}

[Install]
WantedBy=default.target
`,
  };
  const watch: UnitFile = {
    file: WATCH_SERVICE,
    text: `[Unit]
Description=agent-board watch unit: runs the watches of this machine's tasks
# systemd must keep restarting it, not give up.
StartLimitIntervalSec=0

[Service]
Type=simple
# PATH is for the gh and the watch commands it runs.
Environment=PATH=${UNIT_PATH}
ExecStart=${command('watch').map(quoteExecArg).join(' ')}
Restart=always
RestartSec=${WATCH_UNIT.restartDelaySeconds}

[Install]
WantedBy=default.target
`,
  };
  return [...timed, listen, watch];
}

export function unitDirectory(env: Record<string, string | undefined>): string {
  return join(env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'systemd', 'user');
}

const ENABLE_UNITS = [...UNIT_NAMES.map((name) => `agent-board-${name}.timer`), ...LONG_RUNNING_SERVICES];

export const ENABLE_COMMAND = `systemctl --user enable --now ${ENABLE_UNITS.join(' ')}`;

export interface SetupFlags {
  enable?: boolean;
  print?: boolean;
  // Install although the tree that runs setup is not the one `board` is installed from.
  force?: boolean;
}

export interface SetupDeps {
  unitDir: string;
  // What macOS setup needs (see setupDarwin).
  launchd: LaunchdSetupDeps;
  platform: string;
  // The absolute path of a program on PATH.
  which: (program: string) => string | undefined;
  command: RenderInput['command'];
  // A sentence when this tree is not the one the installed `board` runs from, else undefined.
  treeProblem?: () => string | undefined;
  // Whether a timer or service is already enabled (a read-only systemctl call), to leave out the hint to enable it.
  unitEnabled?: (unit: string) => Promise<boolean>;
  run: (program: string, args: string[]) => Promise<void>;
  print: (line: string) => void;
}

// The checkout that runs setup against the one `~/.local/bin/board` resolves to: a worktree or scratch copy must not take over the live timers.
export function treeProblem(
  env: Record<string, string | undefined>,
  running: { compiled: boolean; execPath: string } = { compiled: isCompiledBinary(), execPath: EXEC_PATH },
): string | undefined {
  if (running.compiled) {
    // A binary run from the temp directory (a download being tried out) must not become what the timers run.
    const tmp = realpathSync(tmpdir());
    let real = running.execPath;
    try {
      real = realpathSync(running.execPath);
    } catch {
      // A binary that was replaced under us keeps the path it had.
    }
    return real.startsWith(`${tmp}${sep}`)
      ? `this board runs from ${real}, in the temp directory; install it (scripts/install.sh) and run board setup from there`
      : undefined;
  }
  const installed = join(env['BOARD_INSTALL_DIR'] || join(homedir(), '.local', 'bin'), 'board');
  if (!existsSync(installed)) return undefined;
  const installedTree = dirname(dirname(realpathSync(installed)));
  const thisTree = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
  return installedTree === thisTree
    ? undefined
    : `this checkout (${thisTree}) is not the one ${installed} runs (${installedTree})`;
}

export function whichOnPath(program: string, path: string | undefined = process.env['PATH']): string | undefined {
  return (path ?? '')
    .split(':')
    .filter((dir) => dir !== '')
    .map((dir) => join(dir, program))
    .find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

export function realSetupDeps(env: Record<string, string | undefined>, print: (line: string) => void): SetupDeps {
  const home = env['HOME'] || homedir();
  const uid = process.getuid?.() ?? 0;
  return {
    launchd: {
      home,
      agentsDir: launchAgentsDirectory(home),
      logDir: getPaths(env).logDir,
      runDir: runDir(env, 'darwin'),
      uid,
      env: passedEnv(env),
      loaded: (name) => isAgentLoaded(uid, name),
    },
    unitDir: unitDirectory(env),
    platform: process.platform,
    which: (program) => whichOnPath(program, env['PATH']),
    command: (name) => selfCommand('internal', name),
    treeProblem: () => treeProblem(env),
    run: async (program, args) => {
      try {
        await exec(program, args);
      } catch (error) {
        throw new SystemError(
          `${program} ${args.join(' ')} failed: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`,
        );
      }
    },
    print,
  };
}

// What differs, line by line: enough to see why an installed unit is about to change.
function diffNote(file: string, old: string, next: string): string[] {
  const before = old.split('\n');
  const after = next.split('\n');
  return [
    `~ ${file} differs from what setup writes:`,
    ...before.filter((line) => !after.includes(line)).map((line) => `    - ${line}`),
    ...after.filter((line) => !before.includes(line)).map((line) => `    + ${line}`),
  ];
}

// Writes `text` to `path` as a copy unless it is there already; whether it changed.
function installCopy(deps: SetupDeps, path: string, file: string, text: string): boolean {
  let old: string | undefined;
  try {
    old = readFileSync(path, 'utf8');
  } catch {
    old = undefined;
  }
  if (old === text) {
    deps.print(`unchanged ${path}`);
    return false;
  }
  if (old !== undefined) for (const line of diffNote(file, old, text)) deps.print(line);
  // A copy, not a link: `systemctl disable` deletes a unit file that is a symlink. Removed first, so a link is not written through.
  rmSync(path, { force: true });
  writeFileSync(path, text, { mode: 0o644 });
  deps.print(`wrote ${path}`);
  return true;
}

// macOS: two launchd agents in ~/Library/LaunchAgents, written as copies and loaded into the user's gui domain. A loaded
// agent whose file changed is loaded again; with --enable every agent is.
async function setupDarwin(deps: SetupDeps, flags: SetupFlags): Promise<void> {
  const { launchd } = deps;
  const lockf = deps.which('lockf');
  if (lockf === undefined)
    throw new SystemError('lockf is not on PATH (macOS ships /usr/bin/lockf); run board setup again');
  const agents = renderAgents({
    home: launchd.home,
    lockf,
    lockDir: launchd.runDir,
    logDir: launchd.logDir,
    command: deps.command,
    env: launchd.env,
  }).map((agent) => ({ ...agent, path: join(launchd.agentsDir, agent.file) }));
  if (flags.print) {
    for (const agent of agents) deps.print(`# ${agent.path}\n${agent.text}`);
    return;
  }
  const mismatch = deps.treeProblem?.();
  if (mismatch !== undefined) {
    if (!flags.force)
      throw new SystemError(
        `${mismatch}; run board setup from the installed one, or add --force to install these agents anyway`,
      );
    deps.print(`warning: ${mismatch}`);
  }
  mkdirSync(launchd.agentsDir, { recursive: true });
  mkdirSync(launchd.logDir, { recursive: true, mode: 0o700 });
  ensureRunDir(launchd.runDir);
  const changed = agents.map((agent) => installCopy(deps, agent.path, agent.file, agent.text));
  const domain = `gui/${launchd.uid}`;
  const load = async (agent: (typeof agents)[number]): Promise<void> => {
    // Not loaded yet is the usual case, so a failing bootout is nothing to report.
    await deps.run('launchctl', ['bootout', agentTarget(launchd.uid, agent.name)]).catch(() => undefined);
    await deps.run('launchctl', ['bootstrap', domain, agent.path]);
  };
  if (flags.enable) {
    for (const agent of agents) await load(agent);
    deps.print('loaded the dispatch agent, the listener and the watch agent');
    return;
  }
  const loaded = await Promise.all(agents.map((agent) => launchd.loaded(agent.name)));
  for (const [at, agent] of agents.entries()) {
    if (!changed[at] || !loaded[at]) continue;
    await load(agent);
    deps.print(`loaded ${agentLabel(agent.name)} again, to run the new agent file`);
  }
  if (loaded.every(Boolean))
    deps.print(
      `the dispatch, listener and watch agents are loaded already; the next tick runs the new files. To restart the listener and the watch agent: launchctl kickstart -k ${agentTarget(launchd.uid, 'listen')} ${agentTarget(launchd.uid, 'watch')}`,
    );
  else
    deps.print(
      `Load the agents when you are ready:\n${agents
        .filter((_agent, at) => !loaded[at])
        .map((agent) => `  ${bootstrapCommand(launchd.uid, agent.path)}`)
        .join('\n')}`,
    );
}

async function removeIntakeUnits(deps: SetupDeps): Promise<void> {
  const leftover = REMOVED_UNIT_FILES.filter((file) => existsSync(join(deps.unitDir, file)));
  if (leftover.length === 0) return;
  // Not enabled or not running is the usual case, so a failing systemctl is nothing to report.
  await deps.run('systemctl', ['--user', 'disable', '--now', REMOVED_TIMER]).catch(() => undefined);
  await deps.run('systemctl', ['--user', 'stop', 'agent-board-intake.service']).catch(() => undefined);
  for (const file of leftover) rmSync(join(deps.unitDir, file), { force: true });
  deps.print(
    `removed ${leftover.map((file) => join(deps.unitDir, file)).join(' and ')}: the built-in intake no longer exists; run the github-reviews script instead`,
  );
}

export async function setup(deps: SetupDeps, flags: SetupFlags): Promise<void> {
  if (deps.platform === 'darwin') return setupDarwin(deps, flags);
  if (deps.platform !== 'linux')
    throw new SystemError(`board setup needs Linux with systemd or macOS; this is ${deps.platform}`);
  const flock = deps.which('flock');
  if (flock === undefined) throw new SystemError('flock is not on PATH; install util-linux and run board setup again');
  const units = renderUnits({ flock, command: deps.command });
  if (flags.print) {
    for (const unit of units) deps.print(`# ${join(deps.unitDir, unit.file)}\n${unit.text}`);
    return;
  }
  const mismatch = deps.treeProblem?.();
  if (mismatch !== undefined) {
    if (!flags.force)
      throw new SystemError(
        `${mismatch}; run board setup from the installed one, or add --force to install these units anyway`,
      );
    deps.print(`warning: ${mismatch}`);
  }
  mkdirSync(deps.unitDir, { recursive: true });
  await removeIntakeUnits(deps);
  const changedServices: string[] = [];
  for (const unit of units) {
    const written = installCopy(deps, join(deps.unitDir, unit.file), unit.file, unit.text);
    if (written && LONG_RUNNING_SERVICES.includes(unit.file)) changedServices.push(unit.file);
  }
  await deps.run('systemctl', ['--user', 'daemon-reload']);
  // A running service keeps the old unit and code until it is restarted; try-restart leaves a stopped one alone.
  for (const service of changedServices) {
    await deps.run('systemctl', ['--user', 'try-restart', service]);
    deps.print(`restarted ${service} if it was running, to run the new unit`);
  }
  if (flags.enable) {
    await deps.run('systemctl', ['--user', 'enable', '--now', ...ENABLE_UNITS]);
    deps.print('enabled and started the dispatch timer, the listener and the watch unit');
  } else {
    const enabled = await Promise.all(ENABLE_UNITS.map((unit) => deps.unitEnabled?.(unit) ?? Promise.resolve(false)));
    if (enabled.every(Boolean))
      deps.print(
        'the timer, the listener and the watch unit are enabled already; the next tick runs the new units, and the listener and the watch unit once they are restarted: systemctl --user restart agent-board-listen agent-board-watch',
      );
    else deps.print(`Enable the timer, the listener and the watch unit when you are ready:\n  ${ENABLE_COMMAND}`);
  }
}
