import { execFile } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { Argument, Option } from 'commander';
import { ReportedFailure, UsageError } from '../cli.mts';
import { verifyContract } from '../backend/contract-check.mts';
import { completionModel, renderCompletion, SHELLS } from './completion.mts';
import type { Shell } from './completion.mts';
import { getPaths } from '../config/config.mts';
import { formatResult, hasFailure, realDoctorDeps, realLaunchdDoctorDeps, runChecks } from '../setup/doctor.mts';
import type { CheckResult, DoctorDeps } from '../setup/doctor.mts';
import { clackPrompts, init } from '../setup/init.mts';
import type { InitFlags } from '../setup/init.mts';
import { EXEC_PATH, isCompiledBinary } from '../self/self.mts';
import { resumeMigration } from '../migrate/resume.mts';
import { realGh, realListenerRestart, selfUpdate } from '../self/self-update.mts';
import type { SelfUpdateFlags } from '../self/self-update.mts';
import { releaseOf } from '../migrate/deps.mts';
import { cliVersion, releaseVersion } from '../self/version.mts';
import { installedBoardPath, realSetupDeps, setup, unitDirectory, whichOnPath } from '../setup/setup.mts';
import { uninstall } from '../setup/uninstall.mts';
import type { UninstallFlags } from '../setup/uninstall.mts';
import { DEFAULT_LINES, restartUnits, runInherited, showLogs, WORKER_UNITS } from '../setup/units.mts';
import type { LogsFlags, WorkerUnit } from '../setup/units.mts';
import type { SetupDeps, SetupFlags } from '../setup/setup.mts';
import { createWorkerSystem } from '../setup/worker-system.mts';
import { runDir } from '../worker/runtime.mts';
import { plainLine } from '../output/terminal.mts';
import { exampleNames, exampleText } from './example.mts';
import { examples, paragraphs, SETUP } from './help-text.mts';
import { realMigrationDeps } from './migration-deps.mts';
import type { ProgramShared } from './program-shared.mts';

export function registerSetupCommands(shared: ProgramShared): void {
  const { program, options, env, inRun, writeOut, out, makeContext, writeJson, jsonOption, dryRunOption, notInRun } =
    shared;
  const systemctlCode: DoctorDeps['systemctl'] =
    options.systemctlCode ??
    ((args) =>
      new Promise<number>((resolve) => {
        execFile('systemctl', args, (error) =>
          resolve(error === null ? 0 : typeof error.code === 'number' ? error.code : 1),
        );
      }));
  const setupDeps = (): SetupDeps => {
    const real = realSetupDeps(env, out);
    return {
      ...real,
      launchd: { ...real.launchd, ...(options.agentLoaded ? { loaded: options.agentLoaded } : {}) },
      ...(options.which ? { which: options.which } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.runSystem ? { run: options.runSystem } : {}),
      unitEnabled: async (unit) => (await systemctlCode(['--user', 'is-enabled', unit])) === 0,
    };
  };
  const doctorDeps = (): DoctorDeps => {
    const { configDir } = getPaths(env);
    const systemctl = systemctlCode;
    const which = options.which ?? ((program: string) => whichOnPath(program, env['PATH']));
    const launchd = realLaunchdDoctorDeps(env, env['HOME'] || homedir());
    return {
      ...realDoctorDeps(
        configDir,
        unitDirectory(env),
        systemctl,
        which,
        homedir(),
        options.agentLoaded ? { ...launchd, loaded: options.agentLoaded } : launchd,
        options.which,
      ),
      ...(options.platform ? { platform: options.platform } : {}),
      verifyServer: options.verifyServer ?? ((config) => verifyContract(config)),
    };
  };
  const reportChecks = (results: CheckResult[], json: boolean): void => {
    if (json) writeJson(results);
    else for (const result of results) out(formatResult(result));
    if (hasFailure(results)) throw new ReportedFailure('a check failed');
  };

  program
    .command('init')
    .helpGroup(SETUP)
    .summary('write web.json, env and config.json for this machine')
    .description(
      paragraphs(
        "Set this machine up for the board: write web.json (the board's URL), env (the machine token and the data key, mode 600) and, if it is missing, config.json (from the example, with this machine's name). Then run the checks of `board doctor`.",
        'Set up encryption in the browser first: init asks for the data key from the board\'s Settings page as well as the token. The page offers the env lines to copy (`AGENT_BOARD_TOKEN=…`, `AGENT_BOARD_DATA_KEY=…`). At a prompt paste one line: the bare value, or its own line (a prompt takes one line, so the other line is refused, naming which one it wants); a file or pipe given with --token-file or --data-key-file may hold both lines. Without flags it asks. For a script give --url, --token-file and --data-key-file: a secret never goes on the command line, where it would land in the shell history. A secret file must be mode 600 or 400 like env, which a pipe is: `printf %s "$TOKEN" | board init --url … --token-file /dev/stdin --data-key-file ~/key`; only one of the two can be /dev/stdin. --machine defaults to the host name.',
        'A file that exists is kept unless --force, which copies it to <name>.bak-<timestamp> first (an env backup is mode 600 at most) and keeps what you do not give again: the URL, the token, the data key and any other line of env. An env that has the token but no data key (or the reverse) is completed without --force: init asks for the missing value only. config.json is never replaced.',
        'Not available inside a board run.',
      ),
    )
    .option('--url <url>', "the board's URL (https, or http for localhost)")
    .option(
      '--token-file <path>',
      'read the machine token from this file: the bare token or the env line(s) the Settings page offers (mode 600 or 400, or a pipe)',
    )
    .option(
      '--data-key-file <path>',
      'read the data key from this file: the bare key or the env line(s) the Settings page offers (mode 600 or 400, or a pipe)',
    )
    .option('--machine <name>', "this machine's name on the board (default: the host name)")
    .option('--force', 'replace web.json and env after backing them up')
    .addHelpText(
      'after',
      examples(
        'board init',
        'printf %s "$TOKEN" | board init --url https://board.example.com --token-file /dev/stdin --data-key-file ~/key --machine laptop',
      ),
    )
    .action(async (flags: InitFlags) => {
      notInRun('board init is not available inside a board run');
      const { configDir, stateDir } = getPaths(env);
      await init(
        {
          configDir,
          stateDir,
          version: releaseOf(options.version ?? cliVersion()),
          interactive: options.interactive ?? process.stdin.isTTY === true,
          prompts: options.prompts ?? clackPrompts(),
          hostName: options.hostName ?? hostname().split('.')[0] ?? 'machine',
          now: options.now ?? (() => new Date()),
          print: out,
        },
        flags,
      );
      out('');
      const deps = doctorDeps();
      const results = await runChecks(deps);
      for (const result of results) out(formatResult(result));
      if (deps.platform === 'linux' || deps.platform === 'darwin') out('\nNext, on a worker machine: board setup');
      if (hasFailure(results)) throw new ReportedFailure('a check failed');
    });

  jsonOption(
    program
      .command('doctor')
      .helpGroup(SETUP)
      .summary('check this machine: config, token, server, worker tools and units')
      .description(
        paragraphs(
          'Check this machine, read-only, one line per check: ✓ passes, ✗ fails (with a fix), ! is a warning. Exit 1 if any check fails; warnings alone exit 0. The token is never printed.',
          'Checks: Node 24+ (checkout only), the config directory, web.json, env (mode 600 or 400, token, data key), the board (reachable, token accepted, API version range, and whether it has a data key and this machine holds the same one), config.json, each installed plugin marketplace (still at the commit that was installed), each feed (it validates) and each integration the feeds use (its own `doctor`, run with the PATH the units run with), and for a worker machine claude, gh, flock, systemd-run, systemctl and the installed units with their timers and the listener (on macOS: claude, gh, lockf, the launchd agents and whether launchd has loaded them, the run directory, and a warning for a checkout under ~/Documents, ~/Desktop, ~/Downloads or iCloud Drive, which macOS keeps background jobs out of). The worker checks only warn on a machine with no unit or agent installed, and are left out on a system other than Linux and macOS, where no worker runs.',
        ),
      )
      .addHelpText('after', examples('board doctor', 'board doctor --json')),
  ).action(async (flags: { json?: boolean }) => {
    reportChecks(await runChecks(doctorDeps()), flags.json === true);
  });

  program
    .command('setup')
    .helpGroup(SETUP)
    .summary('install the dispatch timer and the listener: systemd user units, or launchd agents on macOS')
    .description(
      paragraphs(
        'Install this machine as a worker: write the dispatch service and timer and the listener service into ~/.config/systemd/user (or $XDG_CONFIG_HOME/systemd/user) as copies, run `systemctl --user daemon-reload` and print the line that enables them. The listener holds a stream to the board and starts a dispatch tick within a second of a change; the timers stay as the fallback. Run it again after moving the binary or the checkout, or upgrading Node. It needs Linux with systemd and flock, or macOS.',
        'On macOS it writes two launchd agents, de.codeplant.agent-board.dispatch (every 2 minutes) and de.codeplant.agent-board.listen, into ~/Library/LaunchAgents as copies, creates the log and run directories and loads the agents that are loaded already (all of them with --enable) with `launchctl bootout` and `launchctl bootstrap gui/<uid>`; without --enable it prints the bootstrap lines. The agents log to launchd.dispatch.log and launchd.listen.log in the log directory.',
        'The services run this CLI the way `board setup` was started: the binary, or the checkout with its Node. --print shows the units (or agents) and changes nothing; --enable also enables and starts the timer and the listener (loads the agents). When an installed unit differs from what it writes, the differing lines are shown. It refuses unless --force when this checkout is not the one the installed ~/.local/bin/board runs from (a worktree, a scratch copy), or when a binary runs from the temp directory, so it cannot take over the live timers. Setup also stops and deletes the timer, service or launchd agent of the removed built-in intake when it finds one (not with --print). Not available inside a board run.',
      ),
    )
    .option('--enable', 'also enable and start the timer and the listener')
    .option(
      '--force',
      'install although this checkout is not the installed one, or the binary runs from the temp directory',
    )
    .option('--print', 'print the units and change nothing')
    .addHelpText('after', examples('board setup', 'board setup --print', 'board setup --enable'))
    .action(async (flags: SetupFlags) => {
      notInRun('board setup is not available inside a board run');
      await setup(setupDeps(), flags);
    });

  dryRunOption(
    program
      .command('uninstall')
      .helpGroup(SETUP)
      .summary('remove the worker units and the installed board from this machine')
      .description(
        paragraphs(
          'Undo `board setup` and the install: stop, disable and delete the dispatch timer, the listener and the watch unit (on macOS: boot out and delete the three launchd agents), and delete the installed board (~/.local/bin/board or $BOARD_INSTALL_DIR/board: the binary, or the link a checkout install made). A unit that is not installed or not running is skipped; one that fails to stop keeps its file, and the installed board stays so the command can be run again; the command exits 1. With --include-optional, a directory that is the home directory or holds it is refused. Workers that run keep running until they end. A checkout itself is never touched.',
          'The config directory (web.json, config.json, and env with the token and the data key), the state directory (task logs, sessions, watches) and the run directory are kept, so `install.sh` and `board setup --enable` bring the machine back as it was. --include-optional removes them too; keep a copy of the data key first if this machine may need it again. --dry-run prints what would be stopped and removed and changes nothing. Not available inside a board run.',
        ),
      )
      .option('--include-optional', 'also remove the config, state and run directories')
      .addHelpText(
        'after',
        examples('board uninstall --dry-run', 'board uninstall', 'board uninstall --include-optional'),
      ),
  ).action(async (flags: UninstallFlags) => {
    notInRun('board uninstall is not available inside a board run');
    const deps = setupDeps();
    const paths = getPaths(env);
    await uninstall(
      {
        setup: deps,
        installedBoard: installedBoardPath(env),
        optionalDirs: [paths.configDir, paths.stateDir, runDir(env, deps.platform)],
      },
      { ...flags, dryRun: flags.dryRun === true || program.opts<{ dryRun?: boolean }>().dryRun === true },
    );
  });

  program
    .command('restart')
    .helpGroup(SETUP)
    .summary('restart the dispatch timer, the listener and the watch unit')
    .description(
      paragraphs(
        'Restart the worker units of this machine, all three or the ones named: `systemctl --user restart` on the dispatch timer (which starts its schedule again; a tick that runs is not stopped), the listener and the watch unit, or on macOS `launchctl kickstart` of the launchd agents (-k for the listener and the watch unit; the dispatch agent starts a tick now). Only installed units are restarted (on macOS, agents launchd has loaded); the others are named with the line that installs them. Exit 1 when a restart failed or nothing could be restarted.',
        'Running workers are their own transient units and keep running. Stopping the listener waits for a dispatch tick that is running, up to 130 s.',
        'Not available inside a board run.',
      ),
    )
    .addArgument(new Argument('[unit...]', 'dispatch, listen or watch (default: all three)').choices(WORKER_UNITS))
    .addHelpText('after', examples('board restart', 'board restart listen watch'))
    .action(async (units: WorkerUnit[]) => {
      notInRun('board restart is not available inside a board run');
      await restartUnits(setupDeps(), units);
    });

  program
    .command('logs')
    .helpGroup(SETUP)
    .summary('show the log of a unit or a task on this machine')
    .description(
      paragraphs(
        'Show the end of the log of the dispatch timer, the listener or the watch unit (all three together, in time order, when none is named), or of a task. On Linux the units are read with `journalctl --user`; on macOS with `tail` on launchd.<unit>.log in the log directory. A task id shows its log file in the log directory, which exists on the machine that ran the task only; it needs no network.',
        '--follow keeps printing until Ctrl-C. --lines is how many lines to show from the end. --since limits the units to a time as journalctl reads it, such as "1 hour ago" or "2026-01-31 10:00"; it is not available on macOS or for a task log. Exit status is that of journalctl or tail. Allowed inside a board run.',
      ),
    )
    .argument('[target]', 'dispatch, listen, watch or a task id (default: the three units)')
    .option('-f, --follow', 'keep printing new lines until Ctrl-C')
    .addOption(new Option('-n, --lines <n>', 'how many lines to show from the end').default(DEFAULT_LINES))
    .option('--since <time>', 'only the units, from this time on (Linux only), such as "1 hour ago"')
    .addHelpText(
      'after',
      examples(
        'board logs',
        'board logs listen -f',
        'board logs dispatch --since "1 hour ago"',
        'board logs <task id> -n 50',
      ),
    )
    .action(async (target: string | undefined, flags: LogsFlags) => {
      await showLogs(
        {
          platform: options.platform ?? process.platform,
          logDir: getPaths(env).logDir,
          run: options.runInherited ?? runInherited,
        },
        target,
        flags,
      );
    });

  program
    .command('self-update')
    .helpGroup(SETUP)
    .summary('replace this binary with the newest release')
    .description(
      paragraphs(
        'Download the newest cli-v* release of mloureiro/agent-board with `gh`, check it against SHA256SUMS and replace this binary with it, then restart the listener if it runs (`systemctl --user try-restart`, or `launchctl kickstart -k` on macOS when launchd has the agent loaded). Running workers keep the old file until they end. --check only reports whether a newer release exists.',
        'It needs `gh`, logged in. A checkout is updated with `git pull` and `pnpm install` instead, and says so. Not available inside a board run.',
        '--resume continues a migration that stopped: it runs the steps the journal still lists, then restarts the listener. It also works on a checkout, and says `nothing to resume` when nothing is pending. From a terminal it refuses while workers run.',
      ),
    )
    .option('--check', 'only report whether a newer release exists')
    .option('--resume', 'continue a stopped migration')
    .addHelpText('after', examples('board self-update --check', 'board self-update', 'board self-update --resume'))
    .action(async (flags: SelfUpdateFlags & { resume?: boolean }) => {
      notInRun('board self-update is not available inside a board run');
      if (flags.resume) {
        if (flags.check) throw new UsageError('--resume and --check cannot be used together');
        const platform = options.platform ?? process.platform;
        const result = await resumeMigration(realMigrationDeps(shared), {
          interactive: options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true),
          activeWorkers: async () =>
            (await createWorkerSystem({ dryRun: false, print: out, platform }).activeWorkers()).length,
        });
        if (result === 'nothing') out('nothing to resume');
        if (result === 'stopped') throw new ReportedFailure('migration stopped');
        return;
      }
      await selfUpdate(
        {
          compiled: isCompiledBinary(),
          version: releaseVersion(),
          execPath: EXEC_PATH,
          platform: options.platform ?? process.platform,
          arch: process.arch,
          gh: options.gh ?? realGh(env),
          restartListener:
            options.restartListener ??
            realListenerRestart({ block: true, platform: options.platform ?? process.platform }),
          print: out,
        },
        flags,
      );
    });

  program
    .command('completion')
    .helpGroup(SETUP)
    .summary('print a shell completion script')
    .description(
      paragraphs(
        'Print a completion script for bash, zsh or fish: commands, flags, statuses and priorities, and the ids of your tasks and schedules (asked from the board, with a 2 second limit).',
        'Install it once:\n  bash: board completion bash > ~/.local/share/bash-completion/completions/board\n  zsh:  board completion zsh > "${fpath[1]}/_board"   (a directory on your fpath)\n  fish: board completion fish > ~/.config/fish/completions/board.fish',
      ),
    )
    .addArgument(new Argument('<shell>', 'bash, zsh or fish').choices(SHELLS))
    .addHelpText('after', examples('board completion bash', 'eval "$(board completion zsh)"'))
    .action((shell: Shell) => {
      writeOut(renderCompletion(shell, completionModel(program)));
    });

  program
    .command('example')
    .helpGroup(SETUP)
    .summary('list or print the example files that ship with the CLI')
    .description(
      paragraphs(
        'Without a name, list the examples: scripts and config files to start from. With a name, print that file on stdout, so `board example github-reviews.sh > ~/bin/github-reviews.sh` saves it. The files are built into the CLI, so they match its version.',
        'The scripts and the timer that runs them are described under Scripts in docs/usage.md.',
      ),
    )
    .argument('[name]', 'the example to print')
    .addHelpText('after', examples('board example', 'board example github-reviews.sh > github-reviews.sh'))
    .action((name: string | undefined) => {
      if (name === undefined) return exampleNames().forEach((known) => out(known));
      const text = exampleText(name);
      if (text === undefined)
        throw new UsageError(
          `no example "${plainLine(name).slice(0, 60)}"; the examples are ${exampleNames().join(', ')}`,
        );
      writeOut(text);
    });

  // What a completion script asks for: `id<TAB>title` lines. Any failure, a missing config, no network or a run, prints nothing.
  program
    .command('__complete', { hidden: true })
    .argument('[kind]')
    .allowExcessArguments()
    .action(async (kind: string | undefined) => {
      if (inRun) return;
      const limitMs = 2000;
      try {
        const context = makeContext(false, { optionalConfig: true, timeoutMs: limitMs });
        const lines = async (): Promise<string[]> => {
          const oneLine = (text: string): string => plainLine(text.replace(/\s+/g, ' '));
          if (kind === 'tasks')
            return (await context.backend.listTasks()).map((task) => `${task.id}\t${oneLine(task.title)}`);
          if (kind === 'schedules')
            return (await context.backend.listSchedules()).map((item) => `${item.id}\t${oneLine(item.title)}`);
          return [];
        };
        const timeout = new Promise<string[]>((resolve) => setTimeout(() => resolve([]), limitMs).unref());
        for (const line of await Promise.race([lines().catch(() => []), timeout])) out(line);
      } catch {
        // Completion stays silent: a broken prompt is worse than a missing suggestion.
      }
    });
}
