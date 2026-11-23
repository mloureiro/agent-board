import { join } from 'node:path';
import { Command } from 'commander';
import { readStdin, ReportedFailure, UsageError } from '../cli.mts';
import { runGit } from '../config/checkout-repo.mts';
import { getPaths, loadConfig } from '../config/config.mts';
import { runCommand } from '../dispatch/waits.mts';
import { plainLine } from '../output/terminal.mts';
import { createFeedStore } from '../feeds/store.mts';
import { createFeedUpdates } from '../feeds/updates.mts';
import { resolveIntegration } from '../plugins/resolve.mts';
import { createWatchStore } from '../watch/store.mts';
import { isUnitRunning } from '../watch/tick.mts';
import { isProcessAlive } from '../worker/process.mts';
import { examples, paragraphs, SCHEDULING } from './help-text.mts';
import type { ProgramShared } from './program-shared.mts';
import { readTextFile } from './read-text-file.mts';
import { feedsAdd, feedsList, feedsRemove, feedsRun, feedsSetPaused } from './feeds.mts';
import type { FeedsDeps } from './feeds.mts';

const ACTIONS = ['list', 'add', 'rm', 'run', 'pause', 'resume'] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (word: string): word is Action => ACTIONS.some((action) => action === word);

export function registerFeedsCommand(shared: ProgramShared): void {
  const { program, options, env, contextOf, notInRun } = shared;
  program
    .command('feeds')
    .helpGroup(SCHEDULING)
    .summary("list, add, remove, run or pause the feeds that make this machine's tasks from other tools")
    .description(
      paragraphs(
        'A feed asks an integration, a program of an installed plugin marketplace (see `board plugins`), for the items that should have a task, on a timer this machine runs. Its entry in config.json names the `integration` (`<marketplace>:<integration>`), the `action` to run, the `options` that action takes, how often it runs (`every`), the listed directory it runs in (`dir`), optionally an `agent`, a `lane` and a `timeout`, and the `prompts` its tasks start from: `new` for a task that is made, `update` for one whose item changed. A prompt takes placeholders such as `{url}` from the fields the item carries. For each item the machine makes the task of the key `feed:<name>:<item key>`, so the board keeps one task per item. A task of an earlier run whose item is no longer listed, and that still waits in Todo for its first start, is moved to Done.',
        'The watch unit runs every feed that is due; `board feeds` lists them with their last run. `add <name> <file | ->` reads the entry as JSON from a file or from stdin and validates it as a run would (the plugin, the action, the options, the prompts and the check of the integration) and only then writes `feeds.<name>` to config.json; adding a name again replaces it. It then runs the `doctor` of the integration and warns when a prerequisite is missing, such as a login; the feed stays added. `rm <name>` removes it; the tasks it made stay. `run <name>` runs it now, here, and exits 1 when the run failed. `pause` and `resume` stop and restart its timer.',
        'Before every run the feed is validated: the plugin must be installed and at the commit that was installed, the action must exist, the options must fit what the integration describes, the prompts may use only the fields it provides, and its own check must pass. A feed that does not validate is reported and never runs. A listing that fails (an exit other than 0, a time limit, a line that is not a valid item) schedules nothing and closes nothing. Each item carries a `key`, a `title` and a `version`, and the fields its action declares; the full contract, with the entry format, is in docs/plugins.md.',
      ),
    )
    .usage('[options] [list | add <name> <file | -> | rm <name> | run <name> | pause <name> | resume <name>]')
    .argument('[action...]', 'list, add, rm, run, pause or resume, the feed name, and for add the file of its entry')
    .addHelpText(
      'after',
      examples(
        'board feeds',
        'board plugins install <repository URL>',
        'board feeds add gh-reviews ./gh-reviews.json',
        'board feeds run gh-reviews',
        'board feeds pause gh-reviews',
        'board feeds rm gh-reviews',
      ),
    )
    .action(async (words: string[], _flags: unknown, command: Command) => {
      const [action = 'list', name, ...rest] = words;
      if (!isAction(action))
        throw new UsageError(`feeds takes nothing, or ${ACTIONS.join(', ')}: not "${plainLine(action).slice(0, 40)}"`);
      if (action === 'list' && name !== undefined) throw new UsageError('board feeds list takes no name');
      if (action !== 'list' && name === undefined) throw new UsageError(`board feeds ${action} takes a feed name`);
      if (action !== 'add' && rest.length > 0) throw new UsageError(`board feeds ${action} takes one name`);
      if (action === 'add' && rest.length !== 1)
        throw new UsageError('board feeds add takes a name and the file of its entry, or - for stdin');
      if (action !== 'list') notInRun(`board feeds ${action} is not available inside a board run`);
      const context = contextOf(command, { strictConfig: true });
      const paths = getPaths(env);
      const store = createFeedStore(join(paths.stateDir, 'feeds'), isProcessAlive);
      const config = loadConfig(paths.configFile);
      const deps: FeedsDeps = {
        configFile: paths.configFile,
        dirs: context.config.dirs,
        unitRunning: isUnitRunning(createWatchStore(paths.watchDir), new Date()),
        now: () => new Date(),
        print: context.print,
        runDeps: () => ({
          backend: context.backend,
          machine: context.config.machine,
          dirs: config.dirs,
          repos: config.repos,
          store,
          updates: createFeedUpdates(join(paths.stateDir, 'feeds', 'updates')),
          run: (spec) => runCommand(spec),
          resolve: (ref) => resolveIntegration(ref, { paths, git: runGit }),
          link: context.taskLink,
          now: () => new Date(),
          log: context.print,
        }),
      };
      const feed = name ?? '';
      if (action === 'list') feedsList(deps);
      else if (action === 'add')
        await feedsAdd(
          deps,
          feed,
          rest[0] === '-' ? await (options.readStdin ?? readStdin)() : readTextFile(rest[0] ?? ''),
        );
      else if (action === 'rm') feedsRemove(deps, feed);
      else if (action === 'pause' || action === 'resume') feedsSetPaused(deps, feed, action === 'pause');
      else if (!(await feedsRun(deps, feed))) throw new ReportedFailure('the feed run failed');
    });
}
