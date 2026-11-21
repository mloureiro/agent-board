import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { ReportedFailure, UsageError } from '../cli.mts';
import { getPaths, loadConfig } from '../config/config.mts';
import { runCommand } from '../dispatch/waits.mts';
import { plainLine } from '../output/terminal.mts';
import { createSourceStore } from '../sources/store.mts';
import { createWatchStore } from '../watch/store.mts';
import { isUnitRunning } from '../watch/tick.mts';
import { isProcessAlive } from '../worker/process.mts';
import { examples, paragraphs, SCHEDULING } from './help-text.mts';
import type { ProgramShared } from './program-shared.mts';
import { sourcesAdd, sourcesList, sourcesRemove, sourcesRun, sourcesSetPaused } from './sources.mts';
import type { SourceAddFlags, SourcesDeps } from './sources.mts';

const ACTIONS = ['list', 'add', 'rm', 'run', 'pause', 'resume'] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (word: string): word is Action => ACTIONS.some((action) => action === word);

export function registerSourcesCommand(shared: ProgramShared): void {
  const { program, options, env, contextOf, notInRun } = shared;
  program
    .command('sources')
    .helpGroup(SCHEDULING)
    .summary("list, add, remove, run or pause the commands that make this machine's tasks from other tools")
    .description(
      paragraphs(
        "A source is a command this machine runs on a timer, such as a script that asks GitHub for the PRs that wait for your review. It prints one JSON object per line, one per item that should have a task: `key`, `title` and `prompt`, and optionally `version` and `dir`. For each item the machine runs `board schedule --key` with the source's key prefix in front of the key, so the board keeps one task per item, and a new `version` sends a task that waits in Needs me or is Done back to Todo. A task of an earlier run whose item is no longer listed, and that still waits in Todo for its first start, is moved to Done.",
        "The watch unit runs every source that is due; `board sources` lists them with their last run. `add <name> --every <dur> -- <command>` writes `sources.<name>` to config.json (the command runs with `bash -c` in --dir, default the current directory, which must be listed in `dirs`); adding a name again replaces it. `rm <name>` removes it; the tasks it made stay. `run <name>` runs it now, here, and exits 1 when the run failed; `--later` leaves it to the watch unit's next look instead. `pause` and `resume` stop and restart its timer.",
        'A listing that fails (an exit other than 0, a time limit, a line that is not a valid item) schedules nothing and closes nothing. The key prefix defaults to `source:<name>:`.',
      ),
    )
    .usage(
      '[options] [list | add <name> --every <dur> -- <command> | rm <name> | run <name> | pause <name> | resume <name>]',
    )
    .argument('[action...]', 'list, add, rm, run, pause or resume, the source name, and for add the command')
    .option('--every <duration>', 'add: how often it runs (at least 1m)')
    .option('--dir <path>', 'add: where the command runs and the tasks are made (default: the current directory)')
    .option('--agent <name>', "add: the agent of this machine's config.json its tasks run as")
    .option('--lane <name>', 'add: the lane its tasks ask for')
    .option('--key-prefix <text>', 'add: put in front of every key (default: source:<name>:)')
    .option('--timeout <duration>', 'add: the longest one run of the command may take (default 2m, at most 30m)')
    .option('--later', "run: leave it to the watch unit's next look")
    .addHelpText(
      'after',
      examples(
        'board sources',
        "board sources add github-reviews --every 10m --agent reviewer -- '~/bin/review-requests acme/app'",
        'board sources run github-reviews',
        'board sources pause github-reviews',
        'board sources rm github-reviews',
      ),
    )
    .action(async (words: string[], flags: SourceAddFlags & { later?: boolean }, command: Command) => {
      const [action = 'list', name, ...rest] = words;
      if (!isAction(action))
        throw new UsageError(
          `sources takes nothing, or ${ACTIONS.join(', ')}: not "${plainLine(action).slice(0, 40)}"`,
        );
      if (action === 'list' && name !== undefined) throw new UsageError('board sources list takes no name');
      if (action !== 'list' && name === undefined) throw new UsageError(`board sources ${action} takes a source name`);
      if (action !== 'add' && rest.length > 0) throw new UsageError(`board sources ${action} takes one name`);
      const addOnly = ['every', 'dir', 'agent', 'lane', 'keyPrefix', 'timeout'] as const;
      if (action !== 'add' && addOnly.some((flag) => flags[flag] !== undefined))
        throw new UsageError('--every, --dir, --agent, --lane, --key-prefix and --timeout belong to add');
      if (flags.later && action !== 'run') throw new UsageError('--later belongs to run');
      if (action !== 'list') notInRun(`board sources ${action} is not available inside a board run`);
      const context = contextOf(command, { strictConfig: true });
      const paths = getPaths(env);
      const stateDir = join(paths.stateDir, 'sources');
      const store = createSourceStore(stateDir, isProcessAlive);
      const deps: SourcesDeps = {
        configFile: paths.configFile,
        cwd: options.cwd ?? realpathSync(process.cwd()),
        dirs: context.config.dirs,
        unitRunning: isUnitRunning(createWatchStore(paths.watchDir), new Date()),
        now: () => new Date(),
        print: context.print,
        runDeps: () => ({
          backend: context.backend,
          machine: context.config.machine,
          dirs: loadConfig(paths.configFile).dirs,
          store,
          run: (spec) => runCommand(spec),
          link: context.taskLink,
          now: () => new Date(),
          log: context.print,
        }),
      };
      const source = name ?? '';
      if (action === 'list') sourcesList(deps);
      else if (action === 'add') sourcesAdd(deps, source, flags, rest.join(' '));
      else if (action === 'rm') sourcesRemove(deps, source, stateDir);
      else if (action === 'pause' || action === 'resume') sourcesSetPaused(deps, source, action === 'pause');
      else if (!(await sourcesRun(deps, source, flags.later === true)))
        throw new ReportedFailure('the source run failed');
    });
}
