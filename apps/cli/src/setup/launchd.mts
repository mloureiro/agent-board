/**
 * The launchd side of `board setup` on macOS: three user agents in ~/Library/LaunchAgents.
 *   de.codeplant.agent-board.dispatch  a dispatch tick every 2 minutes, under the same lock as the listener's ticks
 *   de.codeplant.agent-board.listen    the listener, kept alive
 *   de.codeplant.agent-board.watch     the watch unit, kept alive
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { shellQuote } from '../output/text.mts';
import { SystemError } from './system.mts';
import { DISPATCH_UNIT, LISTEN_UNIT, WATCH_UNIT, lockArgv, workerPath } from './worker-units.mts';

const exec = promisify(execFile);

export const AGENT_LABEL_PREFIX = 'de.codeplant.agent-board';
export const AGENT_NAMES = ['dispatch', 'listen', 'watch'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const agentLabel = (name: AgentName): string => `${AGENT_LABEL_PREFIX}.${name}`;
export const agentFile = (name: AgentName): string => `${agentLabel(name)}.plist`;

export function agentPath(home: string): string {
  return workerPath('darwin', home);
}

// The variables of the shell that ran setup which move the CLI's files; a job would not see them otherwise.
export const PASSED_ENV = [
  'AGENT_BOARD_CONFIG_DIR',
  'AGENT_BOARD_STATE_DIR',
  'AGENT_BOARD_RUN_DIR',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
] as const;

export function launchAgentsDirectory(home: string): string {
  return join(home, 'Library', 'LaunchAgents');
}

// The launchd logs sit in the log directory with a dot in the name, which no task id has, so they are never taken for a
// task's log (see TaskFileStore).
export function agentLog(logDir: string, name: AgentName): string {
  return join(logDir, `launchd.${name}.log`);
}

// Text for an XML 1.0 element. A control character other than a tab or line break cannot be written at all.
export function xmlEscape(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(text))
    throw new SystemError(`cannot put a control character in a plist: ${JSON.stringify(text.slice(0, 40))}`);
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const string = (text: string): string => `<string>${xmlEscape(text)}</string>`;

export interface AgentFile {
  name: AgentName;
  file: string;
  text: string;
}

export interface LaunchdRenderInput {
  home: string;
  // The absolute path of lockf.
  lockf: string;
  // The directory of the dispatch lock.
  lockDir: string;
  logDir: string;
  // The command that runs `internal <name>`.
  command: (name: AgentName) => string[];
  // The names of PASSED_ENV that are set in the shell that runs setup, with their values.
  env?: Record<string, string>;
}

export function renderAgents({ home, lockf, lockDir, logDir, command, env = {} }: LaunchdRenderInput): AgentFile[] {
  const variables = { PATH: agentPath(home), ...env };
  const key = (name: string, value: string): string => `\t<key>${name}</key>\n\t${value}`;
  const render = (name: AgentName, program: string[], extra: string[]): AgentFile => ({
    name,
    file: agentFile(name),
    text: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      key('Label', string(agentLabel(name))),
      key('ProgramArguments', `<array>\n${program.map((arg) => `\t\t${string(arg)}`).join('\n')}\n\t</array>`),
      ...extra,
      // Whatever the job started (a worker) must outlive it: launchd would kill the group when the job ends otherwise.
      key('AbandonProcessGroup', '<true/>'),
      key(
        'EnvironmentVariables',
        `<dict>\n${Object.entries(variables)
          .map(([variable, value]) => `\t\t<key>${xmlEscape(variable)}</key>\n\t\t${string(value)}`)
          .join('\n')}\n\t</dict>`,
      ),
      key('StandardOutPath', string(agentLog(logDir, name))),
      key('StandardErrorPath', string(agentLog(logDir, name))),
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  });
  // lockf -s -t 0 exits 75 when the lock is held, like `flock -E 75`: another tick holds it, which is not a failure.
  const dispatch = render(
    'dispatch',
    [...lockArgv('darwin', lockf, `${lockDir}/${DISPATCH_UNIT.lockFile}`), ...command('dispatch')],
    [key('StartInterval', `<integer>${DISPATCH_UNIT.everySeconds}</integer>`), key('RunAtLoad', '<true/>')],
  );
  // The listener exits when the board no longer serves this CLI, until it is updated: launchd restarts it every 10 s.
  // ExitTimeOut: a stop waits for the tick that runs, which may take its limit and grace.
  const listen = render('listen', command('listen'), [
    key('KeepAlive', '<true/>'),
    key('RunAtLoad', '<true/>'),
    key('ThrottleInterval', `<integer>${LISTEN_UNIT.restartDelaySeconds}</integer>`),
    key('ExitTimeOut', `<integer>${LISTEN_UNIT.stopTimeoutSeconds}</integer>`),
  ]);
  const watch = render('watch', command('watch'), [
    key('KeepAlive', '<true/>'),
    key('RunAtLoad', '<true/>'),
    key('ThrottleInterval', `<integer>${WATCH_UNIT.restartDelaySeconds}</integer>`),
  ]);
  return [dispatch, listen, watch];
}

// The ProgramArguments of a plist this module wrote, as launchd reads them.
export function parseProgramArguments(plist: string): string[] | undefined {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  if (array === undefined) return undefined;
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) =>
    (match[1] ?? '')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&amp;', '&'),
  );
}

export const agentTarget = (uid: number, name: AgentName): string => `gui/${uid}/${agentLabel(name)}`;

// The command to load an agent by hand.
export function bootstrapCommand(uid: number, plistPath: string): string {
  return `launchctl bootstrap gui/${uid} ${shellQuote(plistPath)}`;
}

// The exit code of a read-only launchctl call.
export async function launchctlCode(args: string[]): Promise<number> {
  try {
    await exec('launchctl', args);
    return 0;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number'
      ? error.code
      : 1;
  }
}

// Whether launchd has loaded the agent: `launchctl print` finds it. A user can switch background items off in Login Items,
// which unloads them.
export async function isAgentLoaded(uid: number, name: AgentName): Promise<boolean> {
  return (await launchctlCode(['print', agentTarget(uid, name)])) === 0;
}

// The variables of PASSED_ENV that `env` sets.
export function passedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    PASSED_ENV.flatMap((name) => {
      const value = env[name];
      return value ? [[name, value]] : [];
    }),
  );
}

export interface LaunchdSetupDeps {
  home: string;
  // ~/Library/LaunchAgents
  agentsDir: string;
  logDir: string;
  // Where the dispatch lock lives: the run directory.
  runDir: string;
  uid: number;
  // What passedEnv found.
  env: Record<string, string>;
  loaded: (name: AgentName) => Promise<boolean>;
}
