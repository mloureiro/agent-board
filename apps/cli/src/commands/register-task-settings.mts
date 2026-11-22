import { realpathSync } from 'node:fs';
import { Command } from 'commander';
import { EFFORTS, MODEL_ALIASES, PRIORITIES } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { plainLine } from '../output/terminal.mts';
import { taskJson } from './board.mts';
import { examples, ID_NOTE, paragraphs, TASK_ARGUMENT, TASKS } from './help-text.mts';
import type { ProgramShared } from './program-shared.mts';
import {
  setAutoDone,
  setDirectory,
  setLane,
  setEffort,
  setIcon,
  setLabels,
  setModel,
  setPrompt,
  setPriority,
  showSettings,
} from './task-settings.mts';
import type { TaskSettingsDeps } from './task-settings.mts';

interface TaskFlags {
  json?: boolean;
  title?: string;
  file?: string;
}

export function registerTaskSettingsCommand(shared: ProgramShared): void {
  const { program, options, writeJson, contextOf, taskIdOf, jsonOptionReadable, dryRunOption, notInRun, textOf } =
    shared;
  dryRunOption(
    jsonOptionReadable(
      program
        .command('task')
        .helpGroup(TASKS)
        .summary(
          "show a task's settings, or change its priority, model, effort, lane, auto-done setting, icon, labels, directory or prompt",
        )
        .description(
          paragraphs(
            "Without an action, print a task's settings: status, priority, model, effort, the lane it asks for, whether the agent may mark it done, its icon, its labels, agent, who made it, the machine it is pinned to and its directory, when it starts, its schedule, the task it was forked from, whether its next run resumes a session, and its PR. With --json, print the task as `board tasks --json` does.",
            `\`set priority <${PRIORITIES.join('|')}>\` and \`set model <alias or model id>\` change the setting, \`unset model\` goes back to claude's default model. \`set effort <${EFFORTS.join('|')}>\` and \`unset effort\` do the same for claude's effort level. A model or an effort applies from the next run on; a run in progress keeps its own.`,
            '`set lane <name>` makes the task ask for that lane of the machine that runs it, `unset lane` for the default lane. A machine without a lane of that name runs the task in its default lane. A running task keeps its lane until its next start, so the change is refused while it runs.',
            '`set auto-done on` lets the agent move the task to Done itself when it judges that every acceptance criterion is met and nothing is left for you; `set auto-done off` (or `unset auto-done`) keeps the move to Done yours, and the agent ends in Needs me. It applies at once, also to a run in progress: an agent that tries to finish a task set to off is refused and moves it to Needs me instead.',
            '`set icon <emoji>` shows one emoji at the left of the title on the board card, `unset icon` removes it. It applies at once, in any status, and nothing else reads it: the board applies no icon by itself.',
            '`set labels <label...>` gives the task these labels, each word one label (quote a label with spaces), and replaces the ones it had; `unset labels` removes them all. The board card shows them as badges. They apply at once, in any status, and nothing reads them to decide how a task runs.',
            "`set dir [path]` pins the task to this machine and the directory (default: the current one; a path is relative to it and `~` expands). `unset dir` removes the directory and the pin: any machine takes the task, in its default directory. Claude Code keeps a session under its working directory and cannot resume it from another one, so changing the directory drops the task's session: the next run starts fresh there and reads the thread. A running or waiting task is refused: stop it first. With a `dirs` list on this machine, the directory must be listed (`board dirs add`).",
            '`set prompt <text...>` changes the title and prompt of a task you created that no worker has claimed yet and that waits in Todo or Backlog; the old title and prompt stay in a note on the task. The text is every word after `prompt`, `-` reads it from stdin and `--file <path>` from a regular file in /tmp, for long text. `--title <title>` sets the title too; without it the title stays. A card of a repeating schedule is edited through its schedule (`board schedules edit`), and a task a worker started has its prompt in its thread: reply with `board comment`. Start a prompt that begins with dashes after `--`.',
            "On a card of a repeating schedule a change applies to that card only: the next occurrence takes its priority, model, effort, auto-done setting, icon, labels, machine and directory from the schedule again, which the command says. `set dir` needs this machine's config.json, since it pins the task to the machine's name.",
            '`set` and `unset` are not available inside a board run: only you change where a task runs, in which lane, with what, and whether its agent may mark it done, and what it says. Viewing works there.',
            ID_NOTE,
          ),
        )
        .usage('[options] <task> [set <key> <value> | unset <key>]')
        .argument('<task>', TASK_ARGUMENT)
        .argument(
          '[action...]',
          'set priority|model|effort|lane|auto-done|icon|labels|dir|prompt <value>, or unset model|effort|lane|auto-done|icon|labels|dir',
        )
        .option('--title <title>', 'with set prompt: the new title (default: keep the current one)')
        .option('--file <path>', 'with set prompt: the prompt from a regular file in /tmp')
        .addHelpText(
          'after',
          examples(
            'board task Ab3dEf9x',
            'board task Ab3 --json',
            'board task Ab3 set priority high',
            `board task Ab3 set model ${MODEL_ALIASES[1].value}`,
            'board task Ab3 unset model',
            `board task Ab3 set effort ${EFFORTS[2]}`,
            'board task Ab3 set lane reviews',
            'board task Ab3 unset lane',
            'board task Ab3 set auto-done on',
            'board task Ab3 unset auto-done',
            'board task Ab3 set icon 🚀',
            'board task Ab3 unset icon',
            'board task Ab3 set labels bug "needs review"',
            'board task Ab3 unset labels',
            'board task Ab3 set dir',
            'board task Ab3 set dir ~/workspace/agent-board',
            'board task Ab3 unset dir',
            'board task Ab3 set prompt Find out why the bidder export is slow',
            'board task Ab3 set prompt --title "Slow export" --file /tmp/prompt.md',
            'echo "new prompt" | board task Ab3 set prompt -',
          ),
        ),
    ),
  ).action(async (arg: string, words: string[], flags: TaskFlags, command: Command) => {
    const [action, key, ...rest] = words;
    if (action !== undefined && action !== 'set' && action !== 'unset')
      throw new UsageError(`task takes nothing, or set or unset: not "${plainLine(action).slice(0, 40)}"`);
    if ((flags.title !== undefined || flags.file !== undefined) && !(action === 'set' && key === 'prompt'))
      throw new UsageError('--title and --file belong to board task <task> set prompt');
    if (action !== undefined && flags.json) throw new UsageError('--json only prints the settings of a task');
    if (action !== undefined) notInRun(`board task ${action} is not available inside a board run`);
    const context = contextOf(command, { json: flags.json === true, strictConfig: action === 'set' && key === 'dir' });
    const deps: TaskSettingsDeps = {
      backend: context.backend,
      machine: context.config.machine,
      dirs: context.config.dirs,
      cwd: options.cwd ?? realpathSync(process.cwd()),
      dryRun: context.dryRun,
      print: context.print,
    };
    if (action === undefined) {
      const id = await taskIdOf(context, arg);
      if (!flags.json) return void (await showSettings(deps, id));
      return writeJson(taskJson(await context.backend.getTask(id)));
    }
    if (
      key !== 'priority' &&
      key !== 'model' &&
      key !== 'effort' &&
      key !== 'lane' &&
      key !== 'auto-done' &&
      key !== 'icon' &&
      key !== 'labels' &&
      key !== 'dir' &&
      key !== 'prompt'
    )
      throw new UsageError(
        `board task ${action} takes priority, model, effort, lane, auto-done, icon, labels, dir or prompt`,
      );
    const id = await taskIdOf(context, arg);
    if (action === 'unset') {
      if (rest.length > 0) throw new UsageError(`board task unset ${key} takes nothing more`);
      if (key === 'priority') throw new UsageError('a task always has a priority; set one of ' + PRIORITIES.join(', '));
      if (key === 'prompt') throw new UsageError('a task always has a prompt; set a new one');
      if (key === 'auto-done') return setAutoDone(deps, id, 'off');
      if (key === 'lane') return setLane(deps, id, undefined);
      if (key === 'effort') return setEffort(deps, id, undefined);
      if (key === 'icon') return setIcon(deps, id, undefined);
      if (key === 'labels') return setLabels(deps, id, []);
      return key === 'model' ? setModel(deps, id, undefined) : setDirectory(deps, id, null);
    }
    if (key === 'prompt') {
      if (flags.file !== undefined && rest.length > 0)
        throw new UsageError('give the prompt as words or with --file, not both');
      const text = await textOf(flags.file === undefined ? rest : ['--file', flags.file]);
      return setPrompt(deps, id, { text, ...(flags.title === undefined ? {} : { title: flags.title }) });
    }
    if (key === 'dir') {
      if (rest.length > 1) throw new UsageError('board task set dir takes one path');
      return setDirectory(deps, id, rest[0]);
    }
    if (key === 'labels') {
      if (rest.length === 0)
        throw new UsageError('board task set labels takes one or more labels; unset labels removes them');
      return setLabels(deps, id, rest);
    }
    const [value] = rest;
    if (value === undefined || rest.length > 1) throw new UsageError(`board task set ${key} takes one value`);
    if (key === 'auto-done') return setAutoDone(deps, id, value);
    if (key === 'lane') return setLane(deps, id, value);
    if (key === 'effort') return setEffort(deps, id, value);
    if (key === 'icon') return setIcon(deps, id, value);
    return key === 'priority' ? setPriority(deps, id, value) : setModel(deps, id, value);
  });
}
