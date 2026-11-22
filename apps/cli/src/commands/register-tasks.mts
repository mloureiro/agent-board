import { realpathSync } from 'node:fs';
import { Command } from 'commander';
import {
  attach,
  add,
  ask,
  comment,
  move,
  MoveRefused,
  removePr,
  reportPr,
  parseStatus,
  readNoteFile,
  readThread,
  noteJson,
  selectTasks,
  taskJson,
  show,
  polish,
  tasks,
  wait,
  DEFAULT_CHECK_EVERY,
  DEFAULT_CHECK_TIMEOUT,
} from './board.mts';
import type { AddFlags, AttachFlags, CommentFlags, PolishFlags, TasksFlags, WaitFlags } from './board.mts';
import { CHECK_TIME_LIMIT_MS, runCommand } from '../dispatch/waits.mts';
import { publishWatches } from '../watch/publish.mts';
import type { WatchStore } from '../watch/store.mts';
import { createWatchStore } from '../watch/store.mts';
import { collect, runEventsCommand } from './events.mts';
import type { EventsFlags } from './events.mts';
import { TASK_ACTORS } from '@agent-board/shared';
import { EVENT_TYPES } from '../events/diff.mts';
import { ReportedFailure, UsageError } from '../cli.mts';
import {
  DEFAULT_WATCH_EVERY,
  DEFAULT_PR_MERGED_TIMEOUT,
  DEFAULT_REVIEW_TIMEOUT,
  DEFAULT_WATCH_TIMEOUT,
  formatWatches,
  readWatches,
  unwatch,
  watch,
  watchesJson,
} from './watch.mts';
import type { WatchFlags } from './watch.mts';
import { examples, ID_NOTE, paragraphs, STATUS_LIST, TASK_ARGUMENT, TASKS } from './help-text.mts';
import type { ProgramShared } from './program-shared.mts';

export function registerTaskCommands(shared: ProgramShared): void {
  const {
    program,
    options,
    env,
    writeOut,
    writeErr,
    contextOf,
    writeJson,
    taskIdOf,
    jsonOption,
    jsonOptionReadable,
    dryRunOption,
    refuseDryRunInText,
    notInRun,
    textOf,
  } = shared;
  const watchStore = (): WatchStore => options.watches ?? createWatchStore();
  dryRunOption(
    jsonOptionReadable(
      program
        .command('tasks')
        .helpGroup(TASKS)
        .summary('open tasks per status')
        .description(
          'List the open tasks per status, with their id, priority and title, and when a delayed task starts. --all adds the closed ones, --status shows one status.',
        )
        .option('--all', 'closed tasks too')
        .option('--status <status>', `only this status (${STATUS_LIST}; "Needs me" works too)`)
        .addHelpText('after', examples('board tasks', 'board tasks --status needs-me', 'board tasks --all --json')),
    ),
  ).action(async (flags: TasksFlags, command: Command) => {
    const context = contextOf(command, { json: flags.json === true });
    if (flags.json) writeJson((await selectTasks(context, flags)).map(taskJson));
    else await tasks(context, flags);
  });

  dryRunOption(
    jsonOptionReadable(
      program
        .command('show')
        .helpGroup(TASKS)
        .summary('a task and its thread as markdown')
        .description(
          paragraphs(
            'Print a task and its thread (input, questions, answers and notes) as markdown. A resumed run reads this first. With --json, print the task and its notes as JSON.',
            ID_NOTE,
          ),
        )
        .argument('<task>', TASK_ARGUMENT)
        .addHelpText('after', examples('board show Ab3dEf9x', 'board show Ab3 --json')),
    ),
  ).action(async (arg: string, flags: { json?: boolean }, command: Command) => {
    const context = contextOf(command, { json: flags.json === true });
    const id = await taskIdOf(context, arg);
    if (!flags.json) return show(context, id);
    const { task, notes } = await readThread(context, id);
    writeJson({ task: taskJson(task), notes: notes.map(noteJson) });
  });

  dryRunOption(
    program
      .command('attach')
      .helpGroup(TASKS)
      .summary("open a task's Claude session in the terminal or Claude Desktop")
      .description(
        paragraphs(
          "Run `claude --resume` on the task's session, interactively, in the directory the session ended in. The board hands the session only to the machine whose token ran the task, and not while the task runs: the headless run owns the session, so watch its Transcript on the task page.",
          'Without --fork, the next resume of the task continues the session with what you did in it. --fork starts a forked session, so the session of the board stays as it was. The exit status is that of claude. Not available inside a board run.',
          '--desktop opens the session in the Claude Desktop app instead (claude --desktop), and the command returns once the app has it. Desktop cannot fork a session, so it cannot be combined with --fork. Leave the Desktop session idle before the task resumes on the board: both would write to the same session.',
          ID_NOTE,
        ),
      )
      .argument('<task>', TASK_ARGUMENT)
      .option('--fork', "fork the session (claude --fork-session) so the board's session stays as it was")
      .option('--desktop', 'open the session in the Claude Desktop app (claude --desktop) instead of the terminal')
      .addHelpText(
        'after',
        examples('board attach 7sPf438z', 'board attach 7sPf --fork', 'board attach 7sPf --desktop'),
      ),
  ).action(async (arg: string, flags: AttachFlags, command: Command) => {
    notInRun('board attach is not available inside a board run');
    const context = contextOf(command);
    await attach(context, await taskIdOf(context, arg), flags, options.spawnClaude);
  });

  dryRunOption(
    program
      .command('comment')
      .helpGroup(TASKS)
      .summary('add a note to a task')
      .description(
        paragraphs(
          "Add a note to the task's thread. The text is every word after the task, quoted or not, and is never read as a flag.",
          '`-` reads the text from stdin; `--file <path>` right after the task reads it from a regular file in /tmp, for long text.',
          '`--suggest <text>` (or `--suggest-file <path>`, a file in /tmp) attaches the reply you expect the user to send next, which the board offers as a one-click answer. Give it before the task, because everything after the task is the note; a note that starts with --suggest or --suggest-file is refused.',
          ID_NOTE,
        ),
      )
      .usage('[options] <task> <text...|-|--file <path>>')
      .argument('<task>', TASK_ARGUMENT)
      .argument('[text...]', 'the note')
      .option('--suggest <text>', "a ready-to-send reply in the user's voice, offered on the board")
      .option('--suggest-file <path>', 'like --suggest, from a regular file in /tmp')
      .passThroughOptions()
      .addHelpText(
        'after',
        examples(
          'board comment Ab3dEf9x "step 3 done"',
          'board comment Ab3dEf9x tests pass, one flaky',
          'board comment Ab3dEf9x --file /tmp/review.md',
          'echo "from a script" | board comment Ab3dEf9x -',
          'board comment Ab3 looks good',
          'board comment --suggest "Yes, open the PR." Ab3dEf9x "Ready: tests pass, diff reviewed."',
        ),
      ),
  ).action(async (arg: string, words: string[], flags: CommentFlags, command: Command) => {
    refuseDryRunInText(words, 'board comment --dry-run <task> <text...>');
    const misplaced = /^(--suggest(?:-file)?)(?:=|$)/.exec(words[0] ?? '')?.[1];
    if (misplaced !== undefined)
      throw new UsageError(
        `${misplaced} goes before the task: board comment ${misplaced} "<${misplaced === '--suggest' ? 'reply' : 'path'}>" <task> <text...>`,
      );
    if (flags.suggest !== undefined && flags.suggestFile !== undefined)
      throw new UsageError('give --suggest or --suggest-file, not both');
    const text = await textOf(words);
    const suggestion = flags.suggestFile === undefined ? flags.suggest : readNoteFile(flags.suggestFile);
    const context = contextOf(command);
    await comment(context, await taskIdOf(context, arg), text, suggestion === undefined ? {} : { suggestion });
  });

  dryRunOption(
    program
      .command('pr')
      .helpGroup(TASKS)
      .summary('report a pull request for a task, or remove one')
      .description(
        paragraphs(
          "Inside a run: after you open a pull request for this task, report its URL. The board then shows it on the task's card and page, like the pull request of a review task. A later call adds another pull request to the task; the same URL twice changes nothing.",
          "--remove takes a reported pull request off the task again, for a URL reported by mistake. The pull request a review task's prompt names is not a reported one and stays; a URL the task does not list changes nothing.",
          'The URL must be a GitHub pull request, https://github.com/<owner>/<repo>/pull/<number>, and nothing else.',
          ID_NOTE,
        ),
      )
      .argument('<task>', TASK_ARGUMENT)
      .argument('<url>', 'the pull request URL')
      .option('--remove', 'take the reported pull request off the task instead of adding it')
      .addHelpText(
        'after',
        examples(
          'board pr Ab3dEf9x https://github.com/acme/app/pull/17741',
          'board pr --remove Ab3dEf9x https://github.com/acme/app/pull/17741',
        ),
      ),
  ).action(async (arg: string, url: string, flags: { remove?: boolean }, command: Command) => {
    const context = contextOf(command);
    const id = await taskIdOf(context, arg);
    if (flags.remove === true) await removePr(context, id, url);
    else await reportPr(context, id, url);
  });

  dryRunOption(
    program
      .command('move')
      .helpGroup(TASKS)
      .summary('move a task to the bottom of a status')
      .description(
        paragraphs(
          `Move a task to the bottom of a status: ${STATUS_LIST}. "Backlog", "Todo", "Running", "Needs me" and "Done" work too.`,
          '--expect <status> moves the task only while it is in that status: for a script that decided from a listing. When the task has moved on it prints a message and exits 3, writing nothing. It is not available inside a board run.',
          ID_NOTE,
        ),
      )
      .argument('<task>', TASK_ARGUMENT)
      .argument('<status...>', 'the status to move it to')
      .option('--expect <status>', 'move it only while it is in this status; exit 3 when it is not')
      .addHelpText(
        'after',
        examples(
          'board move Ab3dEf9x needs-me',
          'board move Ab3dEf9x Needs me',
          'board move Ab3 todo',
          'board move Ab3dEf9x done --expect todo',
        ),
      ),
  ).action(async (arg: string, status: string[], flags: { expect?: string }, command: Command) => {
    if (flags.expect !== undefined)
      notInRun(
        'board move --expect is not available inside a board run; a restricted run moves a task only to needs-me',
      );
    const target = parseStatus(status.join(' '));
    const expect = flags.expect === undefined ? undefined : parseStatus(flags.expect);
    const context = contextOf(command);
    try {
      const id = await taskIdOf(context, arg);
      await move(context, id, target, expect === undefined ? {} : { expect });
      // The agent is done with its task: what it watched for no longer matters. A user's move leaves the watches.
      if (target === 'needs-me' && env['AGENT_BOARD_TASK'] === id && !context.dryRun) {
        const store = watchStore();
        store.dropTask(id);
        await publishWatches(
          { store, backend: context.backend, now: options.now ?? (() => new Date()), log: context.print },
          id,
        );
      }
    } catch (error) {
      if (!(error instanceof MoveRefused)) throw error;
      writeErr(`board: ${error.message}\n`);
      throw new ReportedFailure(error.message, 3);
    }
  });

  dryRunOption(
    program
      .command('ask')
      .helpGroup(TASKS)
      .summary('ask the user 1-4 questions')
      .description(
        paragraphs(
          'Ask the user 1-4 questions and move the task to needs-me. The user answers on the board and the run is resumed with the answers.',
          'The questions are JSON in a regular file in /tmp: {"questions": [{"header", "question", "multiSelect", "options": [{"label", "description", "recommended"?}]}]}',
          ID_NOTE,
        ),
      )
      .argument('<task>', TASK_ARGUMENT)
      .requiredOption('--file <path>', 'the questions as JSON, in /tmp')
      .addHelpText('after', examples('board ask Ab3dEf9x --file /tmp/pr-Ab3dEf9x-questions.json')),
  ).action(async (arg: string, flags: { file: string }, command: Command) => {
    const context = contextOf(command);
    await ask(context, await taskIdOf(context, arg), flags.file);
  });

  dryRunOption(
    program
      .command('wait')
      .helpGroup(TASKS)
      .summary('park a running task in Waiting until a time or a check')
      .description(
        paragraphs(
          'Inside a run: the task leaves Running for Waiting and frees its slot, while something outside (CI, a deploy) takes its time. End your turn after it. The task goes back to the top of Todo and resumes in its session when the time is up, or when the check passes.',
          `A timer is --in or --at. A check is --check with a shell command that exits 0 once the wait is over: the dispatcher of this machine runs it in this directory every --every (default ${DEFAULT_CHECK_EVERY}, at least 1m; one attempt may take ${CHECK_TIME_LIMIT_MS / 1000} s), with the env of your Claude Code settings, and wakes the task when it passes or after --timeout (default ${DEFAULT_CHECK_TIMEOUT}). The command stays on this machine; the board only learns that the task waits for a check, and until when. A wait lasts at most 7 days.`,
          '--reason says what the task waits for; it goes into the thread.',
          ID_NOTE,
        ),
      )
      .argument('<task>', TASK_ARGUMENT)
      .option('--in <duration>', 'wake after this long (30m, 2h, 1d, 1h30m)')
      .option('--at <time>', 'wake then (2027-01-01T12:00, 2027-01-01, 09:30)')
      .option('--check <command>', 'wake once this command exits 0')
      .option('--every <duration>', `with --check: how often it runs (default ${DEFAULT_CHECK_EVERY})`)
      .option('--timeout <duration>', `with --check: wake anyway after this long (default ${DEFAULT_CHECK_TIMEOUT})`)
      .option('--reason <text>', 'what the task waits for, for the thread')
      .addHelpText(
        'after',
        examples(
          `board wait Ab3dEf9x --check 'gh pr checks 17741 --required' --reason "CI on #17741"`,
          `board wait Ab3dEf9x --check 'curl -fsS https://staging.example.com/health' --every 5m --timeout 1h`,
          'board wait Ab3dEf9x --in 20m --reason "the deploy settles"',
        ),
      ),
  ).action(async (arg: string, flags: WaitFlags, command: Command) => {
    const context = contextOf(command, { strictConfig: flags.check !== undefined });
    await wait(context, await taskIdOf(context, arg), flags, {
      watches: watchStore(),
      cwd: options.cwd ?? realpathSync(process.cwd()),
      restricted: env['AGENT_BOARD_RESTRICTED'] === '1',
      ...(env['AGENT_BOARD_START_DIR'] ? { settingsDir: env['AGENT_BOARD_START_DIR'] } : {}),
      ...(options.now ? { now: options.now() } : {}),
    });
  });

  const watchDeps = (): Parameters<typeof watch>[4] => ({
    watches: watchStore(),
    run: options.watchRunner ?? ((job) => runCommand(job)),
    cwd: options.cwd ?? realpathSync(process.cwd()),
    restricted: env['AGENT_BOARD_RESTRICTED'] === '1',
    ...(env['AGENT_BOARD_TASK'] ? { ownTask: env['AGENT_BOARD_TASK'] } : {}),
    ...(env['AGENT_BOARD_START_DIR'] ? { settingsDir: env['AGENT_BOARD_START_DIR'] } : {}),
    ...(options.now ? { now: options.now() } : {}),
  });

  dryRunOption(
    program
      .command('watch')
      .helpGroup(TASKS)
      .summary('watch something for a task and get told when it happens')
      .description(
        paragraphs(
          'Inside a run: start a watch instead of sleeping or polling. A watch belongs to the task, lives on its machine, and reports an event that reaches you as a message: in this run if it is still going, otherwise when the task resumes in its session. Keep working if there is work; end your turn when there is none, and the task waits without holding a slot. A task may have several watches.',
          `Give exactly one source. --ci watches the checks of a pull request (the PR is the argument, or the newest open one you reported with "board pr"; --required looks at the required checks only; --ignore <name> leaves out the checks of that name, * standing for any characters and the option repeatable, for a check that waits for a person and so never finishes on its own, such as an approval gate like policy-bot or a CI hold job, and the event tells how many were ignored; a new commit restarts it) and reports when one failed, the PR was merged or closed, or two looks 30 seconds apart found the same checks all passed (so a passed answer never comes at once). --pr-review watches the reviews and comments of a pull request (the same default) every minute and reports the first one that someone other than the PR's author and this machine's gh user writes after the watch started, with who wrote it, the review's state and the first lines of its text. --pr-merged watches the PR itself (the same default) every minute and reports once it was merged, with the merge commit, or closed without merging. A command after -- is run every --every (default ${DEFAULT_WATCH_EVERY}, at least 15s) in this directory, with the env of your Claude Code settings, and reports once it exits 0; it needs --name, and it is run once right away. With --stream the command is started once and kept running: the lines it prints reach you as events (the lines of about 2 seconds together), and its exit, with the exit code, is the last event. A stream that prints more than 50 events or 20 KB in 10 minutes is stopped, so filter the output down to the lines that matter (grep --line-buffered). After a restart of the watch unit or a reboot the command starts again from the beginning, and the next event says so. --in or --at is a timer.`,
          `--timeout (default ${DEFAULT_WATCH_TIMEOUT}, for --pr-review ${DEFAULT_REVIEW_TIMEOUT}, for --pr-merged ${DEFAULT_PR_MERGED_TIMEOUT}, at most 7 days) is how long a ci, pr-review, pr-merged or command watch looks, or a stream runs, before it reports that it timed out. The command stays on this machine. The same name again replaces the open watch. If the answer is there at once, it is printed and no watch is stored; a command that cannot run here is refused.`,
          ID_NOTE,
        ),
      )
      .argument('<task>', TASK_ARGUMENT)
      .argument(
        '[command...]',
        'after --: the shell command that exits 0 once the wait is over, or with --stream the command whose output is reported',
      )
      .option(
        '--ci [pr]',
        'watch the checks of a PR (URL or number; default: the newest open PR reported for this task)',
      )
      .option('--required', 'with --ci: the required checks only')
      .option(
        '--ignore <pattern>',
        "with --ci: leave out the checks with this name, * for any characters ('policy-bot*'); repeatable",
        (pattern: string, patterns: string[] = []) => [...patterns, pattern],
      )
      .option(
        '--pr-review [pr]',
        'watch the reviews and comments of a PR (URL or number; default: the newest open PR reported for this task)',
      )
      .option(
        '--pr-merged [pr]',
        'watch for the merge or close of a PR (URL or number; default: the newest open PR reported for this task)',
      )
      .option('--name <name>', "the watch's name (default: ci, review, pr-merged or timer); a command needs one")
      .option('--stream', 'with a command: keep it running and report the lines it prints, until it exits')
      .option('--every <duration>', `with a command: how often it runs (default ${DEFAULT_WATCH_EVERY}, at least 15s)`)
      .option(
        '--timeout <duration>',
        `report a timeout after this long (default ${DEFAULT_WATCH_TIMEOUT}, with --pr-review ${DEFAULT_REVIEW_TIMEOUT}, with --pr-merged ${DEFAULT_PR_MERGED_TIMEOUT}; at most 7d)`,
      )
      .option('--in <duration>', 'a timer: report after this long (30m, 2h, 1d, 1h30m)')
      .option('--at <time>', 'a timer: report then (2027-01-01T12:00, 2027-01-01, 09:30)')
      .addHelpText(
        'after',
        examples(
          'board watch Ab3dEf9x --ci',
          'board watch Ab3dEf9x --ci 17741 --required --timeout 1h',
          `board watch Ab3dEf9x --ci --ignore 'policy-bot*' --ignore 'hold *'`,
          'board watch Ab3dEf9x --pr-review',
          'board watch Ab3dEf9x --pr-merged',
          `board watch Ab3dEf9x --name health --every 1m -- 'curl -fsS https://staging.example.com/health'`,
          `board watch Ab3dEf9x --name deploy-log --stream -- 'kubectl logs -f deploy/api | grep --line-buffered -E "ERROR|rollout complete"'`,
          'board watch Ab3dEf9x --in 30m --name deploy',
        ),
      ),
  ).action(async (arg: string, words: string[], flags: WatchFlags, command: Command) => {
    const context = contextOf(command, { strictConfig: true });
    await watch(context, await taskIdOf(context, arg), flags, words, watchDeps());
  });

  dryRunOption(
    jsonOption(
      program
        .command('watches')
        .helpGroup(TASKS)
        .summary('list the open watches of a task')
        .description(
          paragraphs(
            "List the open watches of a task on this machine: each one's name and source, until when it looks, and what its last look said, and how many events the agent has not been handed yet. With --json, print the list on stdout.",
            ID_NOTE,
          ),
        )
        .argument('<task>', TASK_ARGUMENT)
        .addHelpText('after', examples('board watches Ab3dEf9x', 'board watches Ab3dEf9x --json')),
    ),
  ).action(async (arg: string, flags: { json?: boolean }, command: Command) => {
    const context = contextOf(command, { strictConfig: true, json: flags.json === true });
    const id = await taskIdOf(context, arg);
    const open = await readWatches(context, id, watchStore(), env['AGENT_BOARD_TASK']);
    if (flags.json) writeJson(watchesJson(open));
    else for (const line of formatWatches(id, open)) context.print(line);
  });

  dryRunOption(
    program
      .command('unwatch')
      .helpGroup(TASKS)
      .summary('stop a watch of a task')
      .description(
        paragraphs(
          'Stop the open watch of that name on a task on this machine. It reports nothing. "board watches" lists the names.',
          ID_NOTE,
        ),
      )
      .argument('<task>', TASK_ARGUMENT)
      .argument('<name>', 'the name of the watch')
      .addHelpText('after', examples('board unwatch Ab3dEf9x ci')),
  ).action(async (arg: string, name: string, _flags: unknown, command: Command) => {
    const context = contextOf(command, { strictConfig: true });
    await unwatch(context, await taskIdOf(context, arg), name, {
      watches: watchStore(),
      ...(env['AGENT_BOARD_TASK'] ? { ownTask: env['AGENT_BOARD_TASK'] } : {}),
    });
  });
  program
    .command('events')
    .helpGroup(TASKS)
    .summary('print the changes on the board as they happen')
    .description(
      paragraphs(
        'Print one line per change on your board, as it happens, until interrupted: a script can read them with `board events --json | while read -r line; do ...; done`. The first look at the board prints nothing; only what changes after it does.',
        `The types: created (a new task, or a closed one reopened; its earlier notes are not reported), moved (the status changed: from, to, actor), changed (title, priority, model, agent, machine, openQuestion, notBefore, wakeAt, prs or promptPrState changed: fields), closed, removed (deleted), and note (a new note in a task's thread; its text is null in JSON when this machine cannot decrypt it). Changes between two looks at the board are joined: a task that went todo, running, needs-me meanwhile prints one move from todo to needs-me.`,
        '--status keeps the events of tasks that are in one of the statuses after the change, so everything that enters Needs me is `--type moved --status needs-me`. --task, --status, --type and --actor can be given more than once. The filters only choose what is printed.',
        `A moved event carries the actor that made the task's last status change: user (you, in the browser), agent (the task's own run: it asked a question, waits, or moves its task itself, for example to Done when the task allows it) or machine (a CLI outside a run: a worker claiming or ending a run, a script, a terminal). Changes between two looks are joined, so the actor is the one of the last move. --actor keeps only moved events of those actors; other events and moves whose actor the board does not say are dropped. It needs a board that says who moved a task.`,
        'With --json each line is one JSON object: {"type", "at", "task", "from"?, "to"?, "actor"?, "fields"?, "note"?}. `task` is the task as `board tasks --json` shows it, plus its "url"; `at` is when this CLI saw the change. Connection messages go to stderr. The command reads with this machine\'s token and data key, so titles and notes are plain text here and nowhere else. It ends on Ctrl-C (exit 0), when the pipe it writes to closes, and with 1 when the board refuses the token or the CLI. It is not available inside a board run.',
        ID_NOTE,
      ),
    )
    .option('--task <task>', `only this task; repeatable (${TASK_ARGUMENT})`, collect)
    .option('--status <status>', `only tasks in this status after the change; repeatable (${STATUS_LIST})`, collect)
    .option('--type <type>', `only this type of event; repeatable (${EVENT_TYPES.join(', ')})`, collect)
    .option('--actor <actor>', `only moves made by this actor; repeatable (${TASK_ACTORS.join(', ')})`, collect)
    .option('--machine <name>', 'only tasks of this machine')
    .option('--json', 'print one JSON object per line on stdout instead of text')
    .addHelpText(
      'after',
      examples(
        'board events',
        'board events --type moved --status needs-me',
        'board events --type moved --status done --actor agent',
        'board events --task Ab3 --type note',
        'board events --json --machine laptop',
      ),
    )
    .action(async (flags: EventsFlags, command: Command) => {
      notInRun('board events is not available inside a board run: it never ends');
      const context = contextOf(command);
      await runEventsCommand({
        flags,
        context,
        resolveTask: (arg) => taskIdOf(context, arg),
        env,
        writeOut,
        writeErr,
        overrides: options.eventsDeps ?? {},
        now: options.now,
        ...(options.eventsStdout === undefined ? {} : { stdout: options.eventsStdout }),
      });
    });

  dryRunOption(
    jsonOption(
      program
        .command('add')
        .helpGroup(TASKS)
        .summary('propose a follow-up task')
        .description(
          paragraphs(
            'Propose a follow-up task; the file is its prompt. It waits in backlog until the user starts it, and runs on this machine: with --parent in the directory of the parent when it has one here, else in this directory. With --json, print {"id", "url"} on stdout.',
            ID_NOTE,
          ),
        )
        .requiredOption('--title <title>', "the task's title")
        .requiredOption('--file <path>', 'the prompt, a regular file in /tmp')
        .option('--parent <task>', `the task this follows from (${TASK_ARGUMENT})`)
        .option('--priority <priority>', 'urgent, high, normal or low (default normal)')
        .option(
          '--lane <name>',
          "the lane the task asks for once you start it (default: the default lane; it does not inherit this run's lane)",
        )
        .option('--icon <emoji>', 'one emoji shown at the left of the title on the board card (default: none)')
        .option('--label <label>', 'a label shown on the board card; repeatable (default: none)', collect)
        .option('--here', "run in this directory instead of the parent's")
        .addHelpText(
          'after',
          examples(
            'board add --title "Fix the flaky test" --file /tmp/prompt.md --parent Ab3dEf9x',
            'board add --title "Review the fix" --file /tmp/prompt.md --lane reviews',
            'board add --title "Bump the CLI" --file /tmp/prompt.md --icon 📦',
            'board add --title "Fix the login form" --file /tmp/prompt.md --label bug --label ui',
          ),
        ),
    ),
  ).action(async (flags: AddFlags & { json?: boolean }, command: Command) => {
    const context = contextOf(command, { strictConfig: true, json: flags.json === true });
    const parent = flags.parent === undefined ? undefined : await taskIdOf(context, flags.parent);
    const startDir = env['AGENT_BOARD_START_DIR'];
    const runTask = env['AGENT_BOARD_TASK'];
    const task = await add(
      context,
      { ...flags, ...(parent === undefined ? {} : { parent }) },
      {
        cwd: options.cwd ?? realpathSync(process.cwd()),
        ...(startDir ? { startDir } : {}),
        ...(runTask ? { runTask } : {}),
      },
    );
    if (flags.json) writeJson({ id: task.id, url: context.taskLink(task.id) });
  });

  dryRunOption(
    program
      .command('polish')
      .helpGroup(TASKS)
      .summary('post a polished title and prompt for a task')
      .description(
        paragraphs(
          'Post a polished title and prompt for <task>, a backlog task, on the thread of the task this run is for. It changes nothing: the user reads it on the board and applies it, which seals the text as theirs. The file is the new prompt, a regular file in /tmp. Only available inside a board run.',
          ID_NOTE,
        ),
      )
      .argument('<task>', TASK_ARGUMENT)
      .requiredOption('--title <title>', 'the polished title, one line')
      .requiredOption('--file <path>', 'the polished prompt, a regular file in /tmp')
      .addHelpText('after', examples('board polish Ab3dEf9x --title "Fix the export" --file /tmp/prompt.md')),
  ).action(async (arg: string, flags: PolishFlags, command: Command) => {
    const run = env['AGENT_BOARD_TASK'];
    if (!run) throw new UsageError('board polish only works inside a board run: it posts on the task the run is for');
    const context = contextOf(command, { strictConfig: true });
    await polish(context, run, await taskIdOf(context, arg), flags);
  });
}
