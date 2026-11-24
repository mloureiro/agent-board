import type { EventEmitter } from 'node:events';
import type { Command } from 'commander';
import type { ContextOptions, LinkingContext } from '../cli.mts';
import type { Plan } from '../migrate/plan-output.mts';
import type { RollbackDeps } from '../migrate/rollback.mts';
import type { MigrationStep } from '../migrate/steps.mts';
import type { SelfUpdateDeps } from '../self/self-update.mts';
import type { UpdateState } from '../self/update-state.mts';
import type { DoctorDeps } from '../setup/doctor.mts';
import type { Prompts } from '../setup/init.mts';
import type { SetupDeps } from '../setup/setup.mts';
import type { RunInherited } from '../setup/units.mts';
import type { EventsDeps } from '../events/run.mts';
import type { Spawner } from './board.mts';
import type { WatchRunner } from '../watch/attempt.mts';
import type { WatchStore } from '../watch/store.mts';

export interface ProgramOptions {
  env?: Record<string, string | undefined>;
  // The context of a command; tests hand over a fake backend.
  context?: (dryRun: boolean, options: ContextOptions) => LinkingContext;
  readStdin?: () => Promise<string>;
  // Starts claude for `attach`; tests must not launch the real one.
  spawnClaude?: Spawner;
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
  version?: string;
  // The machine under the setup commands; tests replace what would touch it.
  prompts?: Prompts;
  interactive?: boolean;
  hostName?: string;
  now?: () => Date;
  which?: SetupDeps['which'];
  platform?: string;
  // Runs a systemctl call that changes something (daemon-reload, enable).
  runSystem?: SetupDeps['run'];
  // The exit code of a read-only systemctl call.
  systemctlCode?: DoctorDeps['systemctl'];
  // Runs journalctl or tail on the terminal for `board logs`: its argv, resolving with the exit code (undefined when it did not start).
  runInherited?: RunInherited;
  verifyServer?: DoctorDeps['verifyServer'];
  // Whether launchd has loaded an agent (macOS).
  agentLoaded?: DoctorDeps['launchd']['loaded'];
  // Runs `gh` for self-update.
  gh?: (args: string[]) => Promise<string>;
  // Restarts the listener after self-update replaced the binary.
  restartListener?: SelfUpdateDeps['restartListener'];
  // What `board self-update` asks of the downloaded binary, and how it hands over to the new one after a migration was recorded.
  planOf?: (staged: string) => Promise<Plan>;
  handOff?: () => Promise<number>;
  // The API range of the board at a URL, for `board self-update --rollback`.
  serverRange?: RollbackDeps['serverRange'];
  // The migration steps `board self-update --resume` and `board internal migration-plan` use instead of the built-in registry.
  migrationSteps?: readonly MigrationStep[];
  // The command line being run, set by runBoard.
  argv?: string[];
  // Where `board watch` and `board wait --check` store their watches, how they run a command, and the directory it runs in.
  watches?: WatchStore;
  watchRunner?: WatchRunner;
  cwd?: string;
  // The home directory, which `board dirs` warns about.
  home?: string;
  // Runs the editor of `board config edit` with the terminal: its command line, the file last. Returns the exit status, or undefined when it did not start.
  runEditor?: (argv: string[]) => number | undefined;
  // Whether stderr is a terminal, the only place the update hint is shown.
  stderrIsTty?: boolean;
  // What `board events` talks to; tests replace the version check, the clock and the signals.
  // Where `board events` listens for write errors; tests hand over an emitter.
  eventsStdout?: Pick<EventEmitter, 'on' | 'off'>;
  eventsDeps?: Partial<Pick<EventsDeps, 'verify' | 'fetch' | 'timers' | 'random' | 'signal' | 'options'>>;
  // Where the update hint remembers when it was last shown.
  updateState?: UpdateState;
}

// What buildProgram builds once and hands to every command group.
export interface ProgramShared {
  program: Command;
  options: ProgramOptions;
  env: Record<string, string | undefined>;
  argv: string[];
  inRun: boolean;
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
  out: (line: string) => void;
  makeContext: (dryRun: boolean, options: ContextOptions) => LinkingContext;
  contextOf: (
    command: Command,
    flags?: { strictConfig?: boolean; json?: boolean; timeoutMs?: number },
  ) => LinkingContext;
  writeJson: (value: unknown) => void;
  taskIdOf: (context: LinkingContext, arg: string) => Promise<string>;
  jsonOption: (command: Command, flags?: { readable?: boolean }) => Command;
  jsonOptionReadable: (command: Command) => Command;
  dryRunOption: (command: Command) => Command;
  refuseDryRunInText: (words: string[], usage: string) => void;
  notInRun: (message: string) => void;
  textOf: (words: string[]) => Promise<string>;
}
