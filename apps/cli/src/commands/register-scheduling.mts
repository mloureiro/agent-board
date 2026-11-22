import { realpathSync } from 'node:fs';
import { Command } from 'commander';
import { delay, scheduleCommand, schedules, scheduleJson } from './board.mts';
import type { DelayFlags } from './board.mts';
import { EFFORTS, PRIORITIES } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { resolveScheduleId } from './ids.mts';
import { changesSettings, editSchedule } from './schedule-edit.mts';
import type { ScheduleEditFlags } from './schedule-edit.mts';
import { addScheduleOptions } from './schedule.mts';
import type { ScheduleFlags } from './schedule.mts';
import { examples, ID_NOTE, paragraphs, SCHEDULING, TASK_ARGUMENT } from './help-text.mts';
import type { ProgramShared } from './program-shared.mts';

type ScheduleCommandFlags = ScheduleEditFlags & { json?: boolean; title?: string; file?: string; dryRun?: boolean };

export function registerScheduleCommands(shared: ProgramShared): void {
  const {
    program,
    options,
    argv,
    inRun,
    contextOf,
    writeJson,
    jsonOption,
    jsonOptionReadable,
    dryRunOption,
    notInRun,
    textOf,
  } = shared;
  const schedule = program
    .command('schedule')
    .helpGroup(SCHEDULING)
    .summary('a task from a prompt, run here on this machine')
    .description(
      paragraphs(
        'Make a task of the prompt, written as you would type it into Claude Code, bound to this machine and this directory. Prints its URL. A quick Haiku call first checks whether an open task already covers it; --new skips that.',
        '--auto-done lets the agent move the task to Done itself when it judges that every acceptance criterion is met and nothing is left for you; without it the task ends in Needs me. A repeating schedule hands the setting to each task it makes. `board task <id> set auto-done on|off` changes it later.',
        'The flags come first; everything from the first other word on is the prompt, flags included (`--auto` below goes to the skill). To start the prompt with dashes, put -- before it.',
        '--in or --at keeps the task in Todo until then. --every or --cron makes a repeating schedule instead, starting at --in/--at (default now), for --times runs or until --until, else forever.',
        '--polish parks the task in Backlog and queues a second task, "Polish prompt: <title>", that asks an agent to turn the prompt into a complete plan, as the Polish prompt button on the board does. Apply the result from that task\'s page. It cannot be combined with --hold, --in, --at or a repeat.',
        '--key <key> is for scripts that run `board schedule` again and again: the board keeps one task per key (the key itself never leaves this machine), so a second call finds the first instead of making another, and the duplicate check is skipped. It cannot be combined with a repeat, --polish, --hold or --backlog. It prints `created`, `exists`, `requeued` or `rescheduled`, the task id and URL, and for exists the reason in parentheses, and exits 0 for all of them. A task that was closed is `exists (closed)` and never made again.',
        'With --version <v> (a PR head sha, say) the task remembers what it was made for. When it differs and the task waits in Needs me or is Done, the task goes back to Todo with a note "New version" (`requeued`). With --in or --at, a task that waits in Todo for a fresh start moves its start time to the new one, whatever --version says (`rescheduled`; the same --at again changes nothing, and --in sets a new wait each time), and a new task or a requeue starts then. Otherwise it is `exists` with the reason same-version, no-version (no --version given), busy (Todo, Running, Waiting or Backlog), changed (the task moved while this ran) or other-agent (it runs as another --agent than this call names, which cannot be changed later).',
        'With --json, print {"id", "url"} of the task on stdout (and "polishId", "polishUrl" with --polish; "result", "status" and "reason" with --key); everything else goes to stderr. Not available inside a board run: there, propose follow-up work with `board add`.',
      ),
    )
    .usage('[options] <prompt...>')
    .argument('<prompt...>', 'what the task should do')
    .passThroughOptions();
  jsonOption(addScheduleOptions(schedule).option('--dry-run', 'read everything, print every write instead of doing it'))
    .addHelpText(
      'after',
      examples(
        'board schedule /review-pr 17741',
        'board schedule --priority high /review-pr acme/app#17741 --auto',
        'board schedule --auto-done "Bump the patch version of every package and open a PR"',
        'board schedule --model opus "Find out why the bidder export is slow and propose a fix"',
        'board schedule --label bug --label export "Find out why the bidder export is slow"',
        'board schedule "Find out why the bidder export is slow and propose a fix"',
        'board schedule --in 2h /review-pr 17741',
        'board schedule --at 09:00 /grill the plan in docs/x.md',
        'board schedule --every 2h --times 5 /sweep the stale branches',
        'board schedule --cron "0 9 * * 1-5" /review-pr --auto',
        'board schedule --cron "0 9 * * 5#1" --cron "0 9 * * 5#3" /sprint report',
        'board schedule --every 1h --max-concurrent 2 /sweep the stale branches',
        'board schedule --after s1b2c3d4 --delay 10m /deploy the release',
        'board schedule --polish "bidder export should include postal codes"',
        'board schedule --hold -- --weird prompt',
        'board schedule --json /review-pr 17741',
        'board schedule --agent reviewer --key https://github.com/o/r/pull/7 --version 3f9c2ab --json /review-pr https://github.com/o/r/pull/7 --auto',
      ),
    )
    .action(async (words: string[], flags: ScheduleFlags & { json?: boolean }, command: Command) => {
      notInRun('board schedule is not available inside a board run; use `board add` to propose follow-up work');
      // Commander drops a `--`, so the raw arguments tell whether the person wrote one before a prompt that ends in --dry-run.
      const afterCommand = argv.slice(argv.indexOf('schedule') + 1);
      if (words.at(-1) === '--dry-run' && !afterCommand.includes('--'))
        throw new UsageError(
          'the prompt ends in --dry-run: put --dry-run before the prompt (board schedule --dry-run <prompt...>), or put -- before a prompt that really ends in it',
        );
      const context = contextOf(command, { strictConfig: true, json: flags.json === true });
      const scheduled = await scheduleCommand(context, flags, words, options.cwd ?? realpathSync(process.cwd()));
      if (flags.json) {
        if (scheduled === undefined) return writeJson(null);
        if (!('task' in scheduled)) return writeJson({ scheduleId: scheduled.schedule.id });
        const { task, polish, keyed } = scheduled;
        writeJson({
          id: task.id,
          url: context.taskLink(task.id),
          ...(keyed
            ? { result: keyed.result, status: task.status, ...('reason' in keyed ? { reason: keyed.reason } : {}) }
            : {}),
          ...(task.scheduleId ? { scheduleId: task.scheduleId } : {}),
          ...(polish ? { polishId: polish.id, polishUrl: context.taskLink(polish.id) } : {}),
        });
      }
    });

  dryRunOption(
    jsonOptionReadable(
      program
        .command('schedules')
        .helpGroup(SCHEDULING)
        .summary('list, edit, pause, resume or delete repeating schedules')
        .description(
          paragraphs(
            'Without arguments, list the repeating schedules: id, rule, next run, runs left, paused or ended, the limit if it has one, title; --json prints them as JSON.',
            '`pause <id>` drops the waiting run and stops the schedule, `resume <id>` makes the next run, `rm <id>` deletes the schedule and its waiting run.',
            "`edit <id> [text...]` changes the schedule's prompt: the text is every word after the id, `-` reads it from stdin and `--file <path>` from a regular file in /tmp, for long text; without any text the prompt stays. `--title <title>` sets the title too; without it the title stays. Every later run takes the new text. The waiting run takes it too while it is in Todo and no worker has claimed it, and the command says which of three happened. Runs that already started keep what they had, and the old text is not kept. An ended schedule is refused.",
            "The other flags of `edit` change the settings of the schedule, all that the Edit schedule dialog on the board changes; what you leave out stays as it is. --priority, --model and --effort (`default` for claude's default), --lane <name> (`default` for the default lane of the machine that runs it), --auto-done on|off, --icon <emoji> (`none` for no icon), --label <label> (repeatable: the labels given replace the old ones; `--label none` removes them) and --agent (an agent of this machine's config.json, or `none`). --dir <path> pins the schedule to this machine and that directory (listed in `board dirs`; `none`: no machine and no directory), as `board task <id> set dir` does for a task.",
            "The repeat: --every <duration>, --cron <expr> (up to 10 times, in this machine's time zone) or --after <schedule> with --delay <duration>; the one you give replaces the old repeat. --in or --at moves the first run of a schedule that has a rule of its own. The end: --times <n> runs left (the waiting one included), --until <time> or --forever; give one. --max-concurrent <n|none> limits how many tasks of the schedule run at once. Switching to --after removes the waiting task, and switching back makes one. These flags need a board server that has them; the command says when it has not.",
            'Changing a schedule is not available inside a board run. The id can be the start of it (3 to 7 or 9 to 11 characters; 8 and 12 are whole ids) outside a run.',
          ),
        )
        .usage('[options] [pause|resume|rm <id> | edit <id> [text...|-|--file <path>]]')
        .argument('[action...]', 'pause, resume, rm or edit, and the schedule id')
        .option('--title <title>', 'with edit: the new title (default: keep the current one)')
        .option('--file <path>', 'with edit: the prompt from a regular file in /tmp')
        .option('--priority <priority>', `with edit: ${PRIORITIES.join(', ')}`)
        .option('--model <model>', "with edit: a claude model alias or full name, or default for claude's default")
        .option('--effort <level>', `with edit: ${EFFORTS.join(', ')}, or default for claude's default effort`)
        .option('--icon <emoji>', 'with edit: one emoji for the cards of the schedule, or none for no icon')
        .option(
          '--label <label>',
          'with edit: a label for the cards of the schedule; repeatable, replaces the old ones; none removes them',
          (value: string, previous: string[] = []) => [...previous, value],
        )
        .option(
          '--lane <name>',
          "with edit: the lane of the machine that runs the tasks, or default for that machine's default lane",
        )
        .option('--auto-done <on|off>', 'with edit: let the agent move the tasks to Done itself')
        .option('--agent <name>', "with edit: run as this agent of this machine's config.json, or none")
        .option(
          '--dir <path>',
          'with edit: run on this machine in this directory (a listed one), or none for no directory',
        )
        .option('--every <duration>', 'with edit: repeat on a fixed grid (2h)')
        .option(
          '--cron <expr>',
          "with edit: repeat by a 5-field cron expression in this machine's time zone; give it up to 10 times",
          (value: string, previous: string[] = []) => [...previous, value],
        )
        .option('--after <schedule>', 'with edit: run after another schedule (its id or the start of it)')
        .option('--delay <duration>', "with edit: start this long after the other schedule's task finished (10m, 2h)")
        .option('--in <duration>', 'with edit: the first run, after this long (30m, 2h, 1d)')
        .option('--at <time>', 'with edit: the first run, then (2027-01-01T12:00, 2027-01-01, 09:30)')
        .option('--times <n>', 'with edit: runs left, the waiting one included')
        .option('--until <time>', 'with edit: end after this time')
        .option('--forever', 'with edit: no end: clears --times and --until')
        .option('--max-concurrent <n>', 'with edit: at most this many tasks running or waiting at once, or none')
        .addHelpText(
          'after',
          examples(
            'board schedules',
            'board schedules --json',
            'board schedules pause s1b2c3d4',
            'board schedules rm s1b',
            'board schedules edit s1b2c3d4 /sweep the stale branches and the stale worktrees',
            'board schedules edit s1b --title "Nightly sweep" --file /tmp/prompt.md',
            'board schedules edit s1b2c3d4 --priority high --model opus --auto-done on',
            'board schedules edit s1b2c3d4 --lane review',
            'board schedules edit s1b2c3d4 --icon 🧹',
            'board schedules edit s1b2c3d4 --label chore --label nightly',
            'board schedules edit s1b2c3d4 --every 6h --times 10',
            'board schedules edit s1b2c3d4 --cron "0 9 * * 1-5" --until 2027-06-30',
            'board schedules edit s1b2c3d4 --after s9z8y7x6 --delay 10m --forever',
            'board schedules edit s1b2c3d4 --dir ~/workspace/agent-board --agent reviewer',
            'board schedules edit s1b2c3d4 --dir none --agent none --max-concurrent none',
          ),
        ),
    ),
  ).action(async (words: string[], flags: ScheduleCommandFlags, command: Command) => {
    if (words.length > 0) notInRun('board schedules changes are not available inside a board run');
    const { json, title, file, dryRun: _dryRun, ...settings } = flags;
    const [action, arg, ...rest] = words;
    if (action !== 'edit' && (title !== undefined || file !== undefined || changesSettings(settings)))
      throw new UsageError('--title, --file and the setting flags belong to board schedules edit');
    const context = contextOf(command, {
      json: json === true,
      strictConfig: settings.dir !== undefined || settings.agent !== undefined,
    });
    if (json) {
      if (words.length > 0) throw new UsageError('--json only prints the list of schedules');
      return writeJson((await context.backend.listSchedules()).map(scheduleJson));
    }
    const changes = action === 'pause' || action === 'resume' || action === 'rm' || action === 'edit';
    const id = arg === undefined || !changes ? undefined : await resolveScheduleId(context.backend, arg, { inRun });
    if (action === 'edit' && id !== undefined) {
      if (file !== undefined && rest.length > 0)
        throw new UsageError('give the prompt as words or with --file, not both');
      const text =
        file === undefined && rest.length === 0
          ? undefined
          : await textOf(file === undefined ? rest : ['--file', file]);
      return editSchedule(context, id, {
        flags: settings,
        cwd: options.cwd ?? realpathSync(process.cwd()),
        ...(text === undefined ? {} : { text }),
        ...(title === undefined ? {} : { title }),
      });
    }
    return schedules(context, id === undefined ? words : [action ?? '', id, ...rest]);
  });
}

export function registerDelayCommand(shared: ProgramShared): void {
  const { program, contextOf, taskIdOf, dryRunOption } = shared;
  dryRunOption(
    program
      .command('delay')
      .helpGroup(SCHEDULING)
      .summary('delay a task in Todo, or make it due at once')
      .description(
        paragraphs(
          'Delay a task in Todo until then, or with --now make it due at once. Give exactly one of --in, --at and --now.',
          ID_NOTE,
        ),
      )
      .argument('<task>', TASK_ARGUMENT)
      .option('--in <duration>', 'start after this long (30m, 2h, 1d, 1h30m)')
      .option('--at <time>', 'start then (2027-01-01T12:00, 2027-01-01, 09:30)')
      .option('--now', 'clear the delay: due at once')
      .addHelpText(
        'after',
        examples('board delay Ab3dEf9x --in 1d', 'board delay Ab3 --at 09:00', 'board delay Ab3dEf9x --now'),
      ),
  ).action(async (arg: string, flags: DelayFlags, command: Command) => {
    const context = contextOf(command);
    await delay(context, await taskIdOf(context, arg), flags);
  });
}
