import { Command, CommanderError } from 'commander';
import { API_VERSION } from '@agent-board/shared';
import { readNoteFile } from './board.mts';
import { buildContext, readStdin, runScopeFromEnv, UsageError } from '../cli.mts';
import type { Context, LinkingContext } from '../cli.mts';
import { getPaths } from '../config/config.mts';
import { resolveTaskId } from './ids.mts';
import { cliVersion } from '../self/version.mts';
import { updateHint } from '../self/update-hint.mts';
import { createUpdateState, updateStateFile } from '../self/update-state.mts';
import { SETUP } from './help-text.mts';
import type { ProgramOptions, ProgramShared } from './program-shared.mts';
import { registerConfigCommand } from './register-config.mts';
import { registerAgentsCommand } from './register-agents.mts';
import { registerDirsCommand } from './register-dirs.mts';
import { registerFeedsCommand } from './register-feeds.mts';
import { registerInternalCommands } from './register-internal.mts';
import { registerDelayCommand, registerScheduleCommands } from './register-scheduling.mts';
import { registerSetupCommands } from './register-setup.mts';
import { registerTaskCommands } from './register-tasks.mts';
import { registerTaskSettingsCommand } from './register-task-settings.mts';

// `comment <task> [text...]` in the overview, without commander's `[options]` and without the long usage of `comment`.
function overviewTerm(command: Command): string {
  const args = command.registeredArguments.map((arg) => {
    const name = `${arg.name()}${arg.variadic ? '...' : ''}`;
    return arg.required ? `<${name}>` : `[${name}]`;
  });
  return [command.name(), ...args].join(' ');
}

export function buildProgram(options: ProgramOptions = {}): Command {
  const env = options.env ?? process.env;
  const argv = options.argv ?? [];
  const stdin = options.readStdin ?? readStdin;
  const buildContextOf = options.context ?? buildContext;
  // The context of the command that runs: it knows what the board advertised.
  let lastContext: Context | undefined;
  // Inside a board run, the calls for the run's own task name the run.
  const run = runScopeFromEnv(env);
  const makeContext: typeof buildContextOf = (dryRun, contextOptions) =>
    (lastContext = buildContextOf(dryRun, run === undefined ? contextOptions : { run: () => run, ...contextOptions }));
  const writeOut = options.writeOut ?? ((text: string) => void process.stdout.write(text));
  const writeErr = options.writeErr ?? ((text: string) => void process.stderr.write(text));

  const program = new Command('board')
    .enablePositionalOptions()
    .exitOverride()
    .showSuggestionAfterError()
    .configureOutput({ writeOut, writeErr, outputError: () => undefined })
    .configureHelp({ subcommandTerm: overviewTerm })
    .version(`board ${options.version ?? cliVersion()} (api ${API_VERSION})`, '-V, --version', 'print the version')
    .option('--dry-run', 'read everything, print every write instead of doing it')
    .description(
      'Work with the agent board from a terminal, and from inside a run: comment on tasks, move them, schedule new ones.',
    )
    .addHelpText('after', '\nRun "board help <command>" for the details and examples of one command.\n');

  const out = (line: string): void => writeOut(`${line}\n`);
  // `strictConfig`: the command binds work to this machine's name, which needs a config.json to mean anything.
  // `json`: stdout holds the JSON document alone, so every other line goes to stderr.
  const contextOf = (
    command: Command,
    {
      strictConfig = false,
      json = false,
      timeoutMs,
    }: { strictConfig?: boolean; json?: boolean; timeoutMs?: number } = {},
  ): LinkingContext => {
    const dryRun =
      program.opts<{ dryRun?: boolean }>().dryRun === true || command.opts<{ dryRun?: boolean }>().dryRun === true;
    return makeContext(dryRun, {
      optionalConfig: !strictConfig,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(json ? { print: (line: string) => writeErr(`${line}\n`) } : {}),
    });
  };
  const writeJson = (value: unknown): void => writeOut(`${JSON.stringify(value, null, 2)}\n`);
  const inRun = Boolean(env['AGENT_BOARD_TASK']);
  const taskIdOf = (context: LinkingContext, arg: string): Promise<string> =>
    resolveTaskId(context.backend, arg, {
      inRun,
      // The same source as every link the CLI prints.
      boardLinkPrefix: () => context.taskLink('a').slice(0, -1),
    });
  // `readable`: the command lists tasks, notes or schedules, whose values this machine may be unable to decrypt.
  const jsonOptionReadable = (command: Command): Command => jsonOption(command, { readable: true });
  const jsonOption = (command: Command, { readable = false } = {}): Command =>
    command.option(
      '--json',
      readable
        ? 'print JSON on stdout instead of text; a value this machine cannot decrypt is null there and named in "unreadable" (text shows "(cannot decrypt: input)" after the task, and "(cannot decrypt this title)" for a title)'
        : 'print JSON on stdout instead of text',
    );
  // On the old parser a trailing --dry-run meant a dry run; doing the real thing silently would be the wrong direction.
  const refuseDryRunInText = (words: string[], usage: string): void => {
    if (words[0] === '--dry-run' || words.at(-1) === '--dry-run')
      throw new UsageError(`--dry-run goes before the text, not at its start or end: ${usage}`);
  };
  // A run's agent works on untrusted text; a task it schedules would run with the user's full permissions.
  const notInRun = (message: string): void => {
    if (env['AGENT_BOARD_TASK']) throw new UsageError(message);
  };
  // The text of `comment`: the words as written, or stdin for `-`, or a file for `--file <path>`.
  const textOf = async (words: string[]): Promise<string> => {
    if (words[0] === '--file') {
      if (words.length !== 2) throw new UsageError('--file takes one path');
      return readNoteFile(words[1] ?? '');
    }
    const text = words.join(' ');
    const resolved = text === '-' ? (await stdin()).trim() : text;
    if (!resolved) throw new UsageError('the text is missing');
    return resolved;
  };
  const dryRunOption = (command: Command): Command =>
    command.option('--dry-run', 'read everything, print every write instead of doing it');
  const shared: ProgramShared = {
    program,
    options,
    env,
    argv,
    inRun,
    writeOut,
    writeErr,
    out,
    makeContext,
    contextOf,
    writeJson,
    taskIdOf,
    jsonOption,
    jsonOptionReadable,
    dryRunOption,
    refuseDryRunInText,
    notInRun,
    textOf,
  };
  registerTaskCommands(shared);
  registerTaskSettingsCommand(shared);
  registerScheduleCommands(shared);
  registerDirsCommand(shared);
  registerFeedsCommand(shared);
  registerConfigCommand(shared);
  registerAgentsCommand(shared);
  registerDelayCommand(shared);
  registerSetupCommands(shared);

  // A person at a terminal hears of a newer CLI; nothing internal, and nothing inside a run, ever does.
  program.hook('postAction', (_program, action) => {
    if (commandPath(action)[0] === 'internal') return;
    const state = options.updateState ?? createUpdateState(updateStateFile(getPaths(env).stateDir));
    const now = options.now?.() ?? new Date();
    const line = updateHint({
      advertised: lastContext?.serverCli?.(),
      version: options.version ?? cliVersion(),
      state,
      now,
      interactive: (options.stderrIsTty ?? process.stderr.isTTY === true) && !inRun,
    });
    if (line === undefined) return;
    writeErr(`${line}\n`);
    state.markHintShown(now);
  });

  registerInternalCommands(shared);

  program.commandsGroup(SETUP).helpCommand('help [command]', 'show the help of a command');
  return program;
}

function commandPath(command: Command): string[] {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name());
  return names;
}

// The deepest command the arguments name, to show its usage when they are wrong.
function findCommand(program: Command, args: string[]): Command {
  let command = program;
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const next = command.commands.find((candidate) => candidate.name() === arg || candidate.aliases().includes(arg));
    if (!next) break;
    command = next;
    if (command.commands.length === 0) break;
  }
  return command;
}

function usageDetails(command: Command): string[] {
  const path = commandPath(command);
  if (path.length === 0) return ['usage: board <command> [options]', 'Run "board help" for the commands.'];
  const name = path.join(' ');
  return [`usage: board ${name} ${command.usage()}`, `Run "board help ${name}" for the details.`];
}

// Commander's errors and the actions' UsageErrors become one UsageError that carries the command's usage.
function asUsageError(program: Command, args: string[], error: unknown): unknown {
  const command = findCommand(program, args);
  if (error instanceof CommanderError) {
    if (error.exitCode === 0) return undefined;
    if (error.code === 'commander.help') return new UsageError('a command is required', usageDetails(command));
    const details = usageDetails(command);
    if (error.code === 'commander.unknownOption' && command.name() === 'schedule')
      details.unshift('To start the prompt with dashes, put -- before it: board schedule -- --weird prompt');
    return new UsageError(error.message.replace(/^error: /, ''), details);
  }
  if (error instanceof UsageError && error.details.length === 0)
    return new UsageError(error.message, usageDetails(command));
  return error;
}

// A bare `board` shows the overview, and `board help nosuch` is an unknown command like `board nosuch`.
function commandLine(program: Command, argv: string[]): string[] {
  if (argv.every((arg) => arg === '--dry-run')) return [...argv, 'help'];
  const [first, topic] = argv;
  const known = (name: string): boolean => program.commands.some((command) => command.name() === name);
  return first === 'help' && topic !== undefined && !known(topic) ? [topic] : argv;
}

// Runs the command line; throws what `runMain` reports. Help and version output end normally.
export async function runBoard(argv: string[], options: ProgramOptions = {}): Promise<void> {
  const program = buildProgram({ ...options, argv });
  const args = commandLine(program, argv);
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (error) {
    const reported = asUsageError(program, args, error);
    if (reported !== undefined) throw reported;
  }
}
