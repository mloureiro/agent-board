import { UsageError } from '../cli.mts';
import { runGit } from '../config/checkout-repo.mts';
import { getPaths } from '../config/config.mts';
import { plainLine } from '../output/terminal.mts';
import { runTransfer } from '../plugins/git.mts';
import { examples, paragraphs, SETUP } from './help-text.mts';
import type { ProgramShared } from './program-shared.mts';
import { pluginsInstall, pluginsList, pluginsRemove, pluginsUpdate } from './plugins.mts';
import type { PluginsDeps } from './plugins.mts';

const ACTIONS = ['list', 'install', 'update', 'remove'] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (word: string): word is Action => ACTIONS.some((action) => action === word);

export function registerPluginsCommand(shared: ProgramShared): void {
  const { program, env, out, notInRun } = shared;
  program
    .command('plugins')
    .helpGroup(SETUP)
    .summary('install, update, remove or list the marketplaces of feed integrations')
    .description(
      paragraphs(
        'A marketplace is a git repository that lists integrations, programs a feed runs to read another tool such as GitHub. `install <url>` clones it under the state directory and pins the commit it was at; a feed then names an integration as `<marketplace>:<integration>`. The code of a marketplace runs with your authority, so install only repositories you trust.',
        'The pin is the commit you installed. Only `update <name>` moves it: it fetches the default branch of the marketplace, checks it, moves the pin and prints the commits you accept. Nothing else fetches, and no timer does. A checkout that is at another commit than its pin, or whose tracked files were edited, is not used until you run `update` or discard the edits.',
        '`remove <name>` deletes the checkout and the entry, and refuses while a feed in config.json names the marketplace. `list` shows each marketplace with its pin state and integrations. Install, update and remove are not available inside a board run.',
      ),
    )
    .usage('[list | install <url> | update <name> | remove <name>]')
    .argument('[action...]', 'list, install, update or remove, then the git URL (install) or the marketplace name')
    .addHelpText(
      'after',
      examples(
        'board plugins install https://github.com/mloureiro/agent-board-plugins',
        'board plugins list',
        'board plugins update mloureiro',
        'board plugins remove mloureiro',
      ),
    )
    .action((words: string[]) => {
      const [action = 'list', argument, ...rest] = words;
      if (!isAction(action))
        throw new UsageError(
          `plugins takes nothing, or ${ACTIONS.join(', ')}: not "${plainLine(action).slice(0, 40)}"`,
        );
      if (action === 'list' && argument !== undefined) throw new UsageError('board plugins list takes no argument');
      if (action !== 'list' && argument === undefined)
        throw new UsageError(
          `board plugins ${action} takes ${action === 'install' ? 'a git URL' : 'a marketplace name'}`,
        );
      if (rest.length > 0) throw new UsageError(`board plugins ${action} takes one argument`);
      if (action !== 'list') notInRun(`board plugins ${action} is not available inside a board run`);
      const paths = getPaths(env);
      const deps: PluginsDeps = {
        paths,
        configFile: paths.configFile,
        git: runGit,
        transfer: runTransfer,
        now: () => new Date(),
        print: out,
      };
      const value = argument ?? '';
      if (action === 'list') pluginsList(deps);
      else if (action === 'install') pluginsInstall(deps, value);
      else if (action === 'update') pluginsUpdate(deps, value);
      else pluginsRemove(deps, value);
    });
}
