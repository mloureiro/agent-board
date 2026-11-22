import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { ReportedFailure, UsageError } from '../cli.mts';
import { getPaths, loadConfig } from '../config/config.mts';
import { runCommand } from '../dispatch/waits.mts';
import { plainLine } from '../output/terminal.mts';
import { createFeedStore } from '../feeds/store.mts';
import { createWatchStore } from '../watch/store.mts';
import { isUnitRunning } from '../watch/tick.mts';
import { isProcessAlive } from '../worker/process.mts';
import { examples, paragraphs, SCHEDULING } from './help-text.mts';
import type { ProgramShared } from './program-shared.mts';
import { feedsAdd, feedsList, feedsRemove, feedsRun, feedsSetPaused } from './feeds.mts';
import type { FeedAddFlags, FeedsDeps } from './feeds.mts';

const ACTIONS = ['list', 'add', 'rm', 'run', 'pause', 'resume'] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (word: string): word is Action => ACTIONS.some((action) => action === word);

export function registerFeedsCommand(shared: ProgramShared): void {
  const { program, options, env, contextOf, notInRun } = shared;
  program
    .command('feeds')
    .helpGroup(SCHEDULING)
    .summary("list, add, remove, run or pause the commands that make this machine's tasks from other tools")
    .description(
      paragraphs(
        "A feed is a command this machine runs on a timer, such as a script that asks GitHub for the PRs that wait for your review. It prints one JSON object per line, one per item that should have a task: `key`, `title` and `prompt`, and optionally `version` and `dir`. For each item the machine runs `board schedule --key` with the feed's key prefix in front of the key, so the board keeps one task per item, and a new `version` sends a task that waits in Needs me or is Done back to Todo. A task of an earlier run whose item is no longer listed, and that still waits in Todo for its first start, is moved to Done.",
        'The watch unit runs every feed that is due; `board feeds` lists them with their last run. `add <name> --every <dur> -- <command>` writes `feeds.<name>` to config.json (the command runs with `bash -c` in --dir, default the current directory, which must be listed in `dirs`); adding a name again replaces it. `rm <name>` removes it; the tasks it made stay. `run <name>` runs it now, here, and exits 1 when the run failed. `pause` and `resume` stop and restart its timer.',
        'A listing that fails (an exit other than 0, a time limit, a line that is not a valid item) schedules nothing and closes nothing. The key prefix defaults to `feed:<name>:`.',
      ),
    )
    .usage(
      '[options] [list | add <name> --every <dur> -- <command> | rm <name> | run <name> | pause <name> | resume <name>]',
    )
    .argument('[action...]', 'list, add, rm, run, pause or resume, the feed name, and for add the command')
    .option('--every <duration>', 'add: how often it runs (at least 1m)')
    .option('--dir <path>', 'add: where the command runs and the tasks are made (default: the current directory)')
    .option('--agent <name>', "add: the agent of this machine's config.json its tasks run as")
    .option('--lane <name>', 'add: the lane its tasks ask for')
    .option('--key-prefix <text>', 'add: put in front of every key (default: feed:<name>:)')
    .option('--timeout <duration>', 'add: the longest one run of the command may take (default 2m, at most 30m)')
    .addHelpText(
      'after',
      examples(
        'board feeds',
        "board feeds add github-reviews --every 10m --agent reviewer -- '~/bin/review-requests acme/app'",
        'board feeds run github-reviews',
        'board feeds pause github-reviews',
        'board feeds rm github-reviews',
      ),
    )
    .action(async (words: string[], flags: FeedAddFlags, command: Command) => {
      const [action = 'list', name, ...rest] = words;
      if (!isAction(action))
        throw new UsageError(`feeds takes nothing, or ${ACTIONS.join(', ')}: not "${plainLine(action).slice(0, 40)}"`);
      if (action === 'list' && name !== undefined) throw new UsageError('board feeds list takes no name');
      if (action !== 'list' && name === undefined) throw new UsageError(`board feeds ${action} takes a feed name`);
      if (action !== 'add' && rest.length > 0) throw new UsageError(`board feeds ${action} takes one name`);
      const addOnly = ['every', 'dir', 'agent', 'lane', 'keyPrefix', 'timeout'] as const;
      if (action !== 'add' && addOnly.some((flag) => flags[flag] !== undefined))
        throw new UsageError('--every, --dir, --agent, --lane, --key-prefix and --timeout belong to add');
      if (action !== 'list') notInRun(`board feeds ${action} is not available inside a board run`);
      const context = contextOf(command, { strictConfig: true });
      const paths = getPaths(env);
      const store = createFeedStore(join(paths.stateDir, 'feeds'), isProcessAlive);
      const deps: FeedsDeps = {
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
      const feed = name ?? '';
      if (action === 'list') feedsList(deps);
      else if (action === 'add') feedsAdd(deps, feed, flags, rest.join(' '));
      else if (action === 'rm') feedsRemove(deps, feed);
      else if (action === 'pause' || action === 'resume') feedsSetPaused(deps, feed, action === 'pause');
      else if (!(await feedsRun(deps, feed))) throw new ReportedFailure('the feed run failed');
    });
}
