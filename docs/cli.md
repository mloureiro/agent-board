# `board` command reference

`<task>` is a task id; outside a run it can also be a link to the task on the board or the start of an id (3 to 7 or 9 to 11 characters, unique; an id is 12 characters, or 8 for older tasks, and those lengths are whole ids). A link counts only when it is `<web.json url>/t/<id>`, the form the CLI prints. `--json` prints tasks, threads and schedules as JSON for scripts. `--dry-run` reads everything and prints every write as `DRY ...` instead of doing it. A usage error exits 2, any other failure 1. `dispatch` is `board internal dispatch`, started by the timer; a checkout's wrapper `apps/cli/bin/dispatch` takes its own lock (`$XDG_RUNTIME_DIR/agent-board-dispatch.lock`, the one the unit uses), so a run by hand cannot overlap a timer run. When the lock is held they exit 75 without output.

A file given with `--file` (`comment`, `ask`, `add`) is read only from a regular file in `/tmp` (`/private/tmp` on macOS) with no other hard link, without following a link.

The reference below is generated from the program (`pnpm --filter @agent-board/cli run docs`), as `board help <command>` shows it.

<!-- commands:start -->

```
Usage: board [options] [command]

Work with the agent board from a terminal, and from inside a run: comment on
tasks, move them, schedule new ones.

Options:
  -V, --version              print the version
  --dry-run                  read everything, print every write instead of doing
                             it
  -h, --help                 display help for command

Tasks:
  tasks                      open tasks per status
  show <task>                a task and its thread as markdown
  attach <task>              open a task's Claude session in the terminal or
                             Claude Desktop
  comment <task> [text...]   add a note to a task
  pr <task> <url>            report a pull request for a task, or remove one
  move <task> <status...>    move a task to the bottom of a status
  ask <task>                 ask the user 1-4 questions
  wait <task>                park a running task in Waiting until a time or a
                             check
  watch <task> [command...]  watch something for a task and get told when it
                             happens
  watches <task>             list the open watches of a task
  unwatch <task> <name>      stop a watch of a task
  events                     print the changes on the board as they happen
  add                        propose a follow-up task
  polish <task>              post a polished title and prompt for a task
  task <task> [action...]    show a task's settings, or change its priority,
                             model, effort, lane, auto-done setting, icon,
                             labels, directory or prompt

Scheduling:
  schedule <prompt...>       a task from a prompt, run here on this machine
  schedules [action...]      list, edit, pause, resume or delete repeating
                             schedules
  feeds [action...]          list, add, remove, run or pause the feeds that make
                             this machine's tasks from other tools
  delay <task>               delay a task in Todo, or make it due at once

Setup:
  dirs [action...]           list, add, remove or set up the directories workers
                             may run in on this machine
  plugins [action...]        install, update, remove or list the marketplaces of
                             feed integrations
  config [action...]         show or change this machine's config.json
  agents [action...]         list, show, export, add or remove the agents of
                             this machine, or push one to every machine
  init                       write web.json, env and config.json for this
                             machine
  doctor                     check this machine: config, token, server, worker
                             tools and units
  setup                      install the dispatch timer and the listener:
                             systemd user units, or launchd agents on macOS
  uninstall                  remove the worker units and the installed board
                             from this machine
  restart [unit...]          restart the dispatch timer, the listener and the
                             watch unit
  logs [target]              show the log of a unit or a task on this machine
  self-update                replace this binary with the newest release
  completion <shell>         print a shell completion script
  example [name]             list or print the example files that ship with the
                             CLI
  help [command]             show the help of a command

Run "board help <command>" for the details and examples of one command.
```

## Tasks

### board tasks

```
Usage: board tasks [options]

List the open tasks per status, with their id, priority and title, and when a
delayed task starts. --all adds the closed ones, --status shows one status.

Options:
  --all              closed tasks too
  --status <status>  only this status (backlog, todo, running, waiting,
                     needs-me, done; "Needs me" works too)
  --json             print JSON on stdout instead of text; a value this machine
                     cannot decrypt is null there and named in "unreadable"
                     (text shows "(cannot decrypt: input)" after the task, and
                     "(cannot decrypt this title)" for a title)
  --dry-run          read everything, print every write instead of doing it
  -h, --help         display help for command

Examples:
  board tasks
  board tasks --status needs-me
  board tasks --all --json
```

### board show

```
Usage: board show [options] <task>

Print a task and its thread (input, questions, answers and notes) as markdown. A
resumed run reads this first. With --json, print the task and its notes as JSON.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task        the task: its id, a board task link or the start of its id

Options:
  --json      print JSON on stdout instead of text; a value this machine cannot
              decrypt is null there and named in "unreadable" (text shows
              "(cannot decrypt: input)" after the task, and "(cannot decrypt
              this title)" for a title)
  --dry-run   read everything, print every write instead of doing it
  -h, --help  display help for command

Examples:
  board show Ab3dEf9x
  board show Ab3 --json
```

### board attach

```
Usage: board attach [options] <task>

Run `claude --resume` on the task's session, interactively, in the directory the
session ended in. The board hands the session only to the machine whose token
ran the task, and not while the task runs: the headless run owns the session, so
watch its Transcript on the task page.

Without --fork, the next resume of the task continues the session with what you
did in it. --fork starts a forked session, so the session of the board stays as
it was. The exit status is that of claude. Not available inside a board run.

--desktop opens the session in the Claude Desktop app instead (claude
--desktop), and the command returns once the app has it. Desktop cannot fork a
session, so it cannot be combined with --fork. Leave the Desktop session idle
before the task resumes on the board: both would write to the same session.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task        the task: its id, a board task link or the start of its id

Options:
  --fork      fork the session (claude --fork-session) so the board's session
              stays as it was
  --desktop   open the session in the Claude Desktop app (claude --desktop)
              instead of the terminal
  --dry-run   read everything, print every write instead of doing it
  -h, --help  display help for command

Examples:
  board attach 7sPf438z
  board attach 7sPf --fork
  board attach 7sPf --desktop
```

### board comment

```
Usage: board comment [options] <task> <text...|-|--file <path>>

Add a note to the task's thread. The text is every word after the task, quoted
or not, and is never read as a flag.

`-` reads the text from stdin; `--file <path>` right after the task reads it
from a regular file in /tmp, for long text.

`--suggest <text>` (or `--suggest-file <path>`, a file in /tmp) attaches the
reply you expect the user to send next, which the board offers as a one-click
answer. Give it before the task, because everything after the task is the note;
a note that starts with --suggest or --suggest-file is refused.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task                   the task: its id, a board task link or the start of its
                         id
  text                   the note

Options:
  --suggest <text>       a ready-to-send reply in the user's voice, offered on
                         the board
  --suggest-file <path>  like --suggest, from a regular file in /tmp
  --dry-run              read everything, print every write instead of doing it
  -h, --help             display help for command

Examples:
  board comment Ab3dEf9x "step 3 done"
  board comment Ab3dEf9x tests pass, one flaky
  board comment Ab3dEf9x --file /tmp/review.md
  echo "from a script" | board comment Ab3dEf9x -
  board comment Ab3 looks good
  board comment --suggest "Yes, open the PR." Ab3dEf9x "Ready: tests pass, diff reviewed."
```

### board pr

```
Usage: board pr [options] <task> <url>

Inside a run: after you open a pull request for this task, report its URL. The
board then shows it on the task's card and page, like the pull request of a
review task. A later call adds another pull request to the task; the same URL
twice changes nothing.

--remove takes a reported pull request off the task again, for a URL reported by
mistake. The pull request a review task's prompt names is not a reported one and
stays; a URL the task does not list changes nothing.

The URL must be a GitHub pull request,
https://github.com/<owner>/<repo>/pull/<number>, and nothing else.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task        the task: its id, a board task link or the start of its id
  url         the pull request URL

Options:
  --remove    take the reported pull request off the task instead of adding it
  --dry-run   read everything, print every write instead of doing it
  -h, --help  display help for command

Examples:
  board pr Ab3dEf9x https://github.com/acme/app/pull/17741
  board pr --remove Ab3dEf9x https://github.com/acme/app/pull/17741
```

### board move

```
Usage: board move [options] <task> <status...>

Move a task to the bottom of a status: backlog, todo, running, waiting,
needs-me, done. "Backlog", "Todo", "Running", "Needs me" and "Done" work too.

--expect <status> moves the task only while it is in that status: for a script
that decided from a listing. When the task has moved on it prints a message and
exits 3, writing nothing. It is not available inside a board run.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task               the task: its id, a board task link or the start of its id
  status             the status to move it to

Options:
  --expect <status>  move it only while it is in this status; exit 3 when it is
                     not
  --dry-run          read everything, print every write instead of doing it
  -h, --help         display help for command

Examples:
  board move Ab3dEf9x needs-me
  board move Ab3dEf9x Needs me
  board move Ab3 todo
  board move Ab3dEf9x done --expect todo
```

### board ask

```
Usage: board ask [options] <task>

Ask the user 1-4 questions and move the task to needs-me. The user answers on
the board and the run is resumed with the answers.

The questions are JSON in a regular file in /tmp: {"questions": [{"header",
"question", "multiSelect", "options": [{"label", "description",
"recommended"?}]}]}

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task           the task: its id, a board task link or the start of its id

Options:
  --file <path>  the questions as JSON, in /tmp
  --dry-run      read everything, print every write instead of doing it
  -h, --help     display help for command

Examples:
  board ask Ab3dEf9x --file /tmp/pr-Ab3dEf9x-questions.json
```

### board wait

```
Usage: board wait [options] <task>

Inside a run: the task leaves Running for Waiting and frees its slot, while
something outside (CI, a deploy) takes its time. End your turn after it. The
task goes back to the top of Todo and resumes in its session when the time is
up, or when the check passes.

A timer is --in or --at. A check is --check with a shell command that exits 0
once the wait is over: the dispatcher of this machine runs it in this directory
every --every (default 2m, at least 1m; one attempt may take 45 s), with the env
of your Claude Code settings, and wakes the task when it passes or after
--timeout (default 2h). The command stays on this machine; the board only learns
that the task waits for a check, and until when. A wait lasts at most 7 days.

--reason says what the task waits for; it goes into the thread.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task                  the task: its id, a board task link or the start of its
                        id

Options:
  --in <duration>       wake after this long (30m, 2h, 1d, 1h30m)
  --at <time>           wake then (2027-01-01T12:00, 2027-01-01, 09:30)
  --check <command>     wake once this command exits 0
  --every <duration>    with --check: how often it runs (default 2m)
  --timeout <duration>  with --check: wake anyway after this long (default 2h)
  --reason <text>       what the task waits for, for the thread
  --dry-run             read everything, print every write instead of doing it
  -h, --help            display help for command

Examples:
  board wait Ab3dEf9x --check 'gh pr checks 17741 --required' --reason "CI on #17741"
  board wait Ab3dEf9x --check 'curl -fsS https://staging.example.com/health' --every 5m --timeout 1h
  board wait Ab3dEf9x --in 20m --reason "the deploy settles"
```

### board watch

```
Usage: board watch [options] <task> [command...]

Inside a run: start a watch instead of sleeping or polling. A watch belongs to
the task, lives on its machine, and reports an event that reaches you as a
message: in this run if it is still going, otherwise when the task resumes in
its session. Keep working if there is work; end your turn when there is none,
and the task waits without holding a slot. A task may have several watches.

Give exactly one source. --ci watches the checks of a pull request (the PR is
the argument, or the newest open one you reported with "board pr"; --required
looks at the required checks only; --ignore <name> leaves out the checks of that
name, * standing for any characters and the option repeatable, for a check that
waits for a person and so never finishes on its own, such as an approval gate
like policy-bot or a CI hold job, and the event tells how many were ignored; a
new commit restarts it) and reports when one failed, the PR was merged or
closed, or two looks 30 seconds apart found the same checks all passed (so a
passed answer never comes at once). --pr-review watches the reviews and comments
of a pull request (the same default) every minute and reports the first one that
someone other than the PR's author and this machine's gh user writes after the
watch started, with who wrote it, the review's state and the first lines of its
text. --pr-merged watches the PR itself (the same default) every minute and
reports once it was merged, with the merge commit, or closed without merging. A
command after -- is run every --every (default 30s, at least 15s) in this
directory, with the env of your Claude Code settings, and reports once it exits
0; it needs --name, and it is run once right away. With --stream the command is
started once and kept running: the lines it prints reach you as events (the
lines of about 2 seconds together), and its exit, with the exit code, is the
last event. A stream that prints more than 50 events or 20 KB in 10 minutes is
stopped, so filter the output down to the lines that matter (grep
--line-buffered). After a restart of the watch unit or a reboot the command
starts again from the beginning, and the next event says so. --in or --at is a
timer.

--timeout (default 2h, for --pr-review 1d, for --pr-merged 7d, at most 7 days)
is how long a ci, pr-review, pr-merged or command watch looks, or a stream runs,
before it reports that it timed out. The command stays on this machine. The same
name again replaces the open watch. If the answer is there at once, it is
printed and no watch is stored; a command that cannot run here is refused.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task                  the task: its id, a board task link or the start of its
                        id
  command               after --: the shell command that exits 0 once the wait
                        is over, or with --stream the command whose output is
                        reported

Options:
  --ci [pr]             watch the checks of a PR (URL or number; default: the
                        newest open PR reported for this task)
  --required            with --ci: the required checks only
  --ignore <pattern>    with --ci: leave out the checks with this name, * for
                        any characters ('policy-bot*'); repeatable
  --pr-review [pr]      watch the reviews and comments of a PR (URL or number;
                        default: the newest open PR reported for this task)
  --pr-merged [pr]      watch for the merge or close of a PR (URL or number;
                        default: the newest open PR reported for this task)
  --name <name>         the watch's name (default: ci, review, pr-merged or
                        timer); a command needs one
  --stream              with a command: keep it running and report the lines it
                        prints, until it exits
  --every <duration>    with a command: how often it runs (default 30s, at least
                        15s)
  --timeout <duration>  report a timeout after this long (default 2h, with
                        --pr-review 1d, with --pr-merged 7d; at most 7d)
  --in <duration>       a timer: report after this long (30m, 2h, 1d, 1h30m)
  --at <time>           a timer: report then (2027-01-01T12:00, 2027-01-01,
                        09:30)
  --dry-run             read everything, print every write instead of doing it
  -h, --help            display help for command

Examples:
  board watch Ab3dEf9x --ci
  board watch Ab3dEf9x --ci 17741 --required --timeout 1h
  board watch Ab3dEf9x --ci --ignore 'policy-bot*' --ignore 'hold *'
  board watch Ab3dEf9x --pr-review
  board watch Ab3dEf9x --pr-merged
  board watch Ab3dEf9x --name health --every 1m -- 'curl -fsS https://staging.example.com/health'
  board watch Ab3dEf9x --name deploy-log --stream -- 'kubectl logs -f deploy/api | grep --line-buffered -E "ERROR|rollout complete"'
  board watch Ab3dEf9x --in 30m --name deploy
```

### board watches

```
Usage: board watches [options] <task>

List the open watches of a task on this machine: each one's name and source,
until when it looks, and what its last look said, and how many events the agent
has not been handed yet. With --json, print the list on stdout.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task        the task: its id, a board task link or the start of its id

Options:
  --json      print JSON on stdout instead of text
  --dry-run   read everything, print every write instead of doing it
  -h, --help  display help for command

Examples:
  board watches Ab3dEf9x
  board watches Ab3dEf9x --json
```

### board unwatch

```
Usage: board unwatch [options] <task> <name>

Stop the open watch of that name on a task on this machine. It reports nothing.
"board watches" lists the names.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task        the task: its id, a board task link or the start of its id
  name        the name of the watch

Options:
  --dry-run   read everything, print every write instead of doing it
  -h, --help  display help for command

Examples:
  board unwatch Ab3dEf9x ci
```

### board events

```
Usage: board events [options]

Print one line per change on your board, as it happens, until interrupted: a
script can read them with `board events --json | while read -r line; do ...;
done`. The first look at the board prints nothing; only what changes after it
does.

The types: created (a new task, or a closed one reopened; its earlier notes are
not reported), moved (the status changed: from, to, actor), changed (title,
priority, model, agent, machine, openQuestion, notBefore, wakeAt, prs or
promptPrState changed: fields), closed, removed (deleted), and note (a new note
in a task's thread; its text is null in JSON when this machine cannot decrypt
it). Changes between two looks at the board are joined: a task that went todo,
running, needs-me meanwhile prints one move from todo to needs-me.

--status keeps the events of tasks that are in one of the statuses after the
change, so everything that enters Needs me is `--type moved --status needs-me`.
--task, --status, --type and --actor can be given more than once. The filters
only choose what is printed.

A moved event carries the actor that made the task's last status change: user
(you, in the browser), agent (the task's own run: it asked a question, waits, or
moves its task itself, for example to Done when the task allows it) or machine
(a CLI outside a run: a worker claiming or ending a run, a script, a terminal).
Changes between two looks are joined, so the actor is the one of the last move.
--actor keeps only moved events of those actors; other events and moves whose
actor the board does not say are dropped. It needs a board that says who moved a
task.

With --json each line is one JSON object: {"type", "at", "task", "from"?, "to"?,
"actor"?, "fields"?, "note"?}. `task` is the task as `board tasks --json` shows
it, plus its "url"; `at` is when this CLI saw the change. Connection messages go
to stderr. The command reads with this machine's token and data key, so titles
and notes are plain text here and nowhere else. It ends on Ctrl-C (exit 0), when
the pipe it writes to closes, and with 1 when the board refuses the token or the
CLI. It is not available inside a board run.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Options:
  --task <task>      only this task; repeatable (the task: its id, a board task
                     link or the start of its id)
  --status <status>  only tasks in this status after the change; repeatable
                     (backlog, todo, running, waiting, needs-me, done)
  --type <type>      only this type of event; repeatable (created, moved,
                     changed, closed, removed, note)
  --actor <actor>    only moves made by this actor; repeatable (user, agent,
                     machine)
  --machine <name>   only tasks of this machine
  --json             print one JSON object per line on stdout instead of text
  -h, --help         display help for command

Examples:
  board events
  board events --type moved --status needs-me
  board events --type moved --status done --actor agent
  board events --task Ab3 --type note
  board events --json --machine laptop
```

### board add

```
Usage: board add [options]

Propose a follow-up task; the file is its prompt. It waits in backlog until the
user starts it, and runs on this machine: with --parent in the directory of the
parent when it has one here, else in this directory. With --json, print {"id",
"url"} on stdout.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Options:
  --title <title>        the task's title
  --file <path>          the prompt, a regular file in /tmp
  --parent <task>        the task this follows from (the task: its id, a board
                         task link or the start of its id)
  --priority <priority>  urgent, high, normal or low (default normal)
  --lane <name>          the lane the task asks for once you start it (default:
                         the default lane; it does not inherit this run's lane)
  --icon <emoji>         one emoji shown at the left of the title on the board
                         card (default: none)
  --label <label>        a label shown on the board card; repeatable (default:
                         none)
  --here                 run in this directory instead of the parent's
  --json                 print JSON on stdout instead of text
  --dry-run              read everything, print every write instead of doing it
  -h, --help             display help for command

Examples:
  board add --title "Fix the flaky test" --file /tmp/prompt.md --parent Ab3dEf9x
  board add --title "Review the fix" --file /tmp/prompt.md --lane reviews
  board add --title "Bump the CLI" --file /tmp/prompt.md --icon 📦
  board add --title "Fix the login form" --file /tmp/prompt.md --label bug --label ui
```

### board polish

```
Usage: board polish [options] <task>

Post a polished title and prompt for <task>, a backlog task, on the thread of
the task this run is for. It changes nothing: the user reads it on the board and
applies it, which seals the text as theirs. The file is the new prompt, a
regular file in /tmp. Only available inside a board run.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task             the task: its id, a board task link or the start of its id

Options:
  --title <title>  the polished title, one line
  --file <path>    the polished prompt, a regular file in /tmp
  --dry-run        read everything, print every write instead of doing it
  -h, --help       display help for command

Examples:
  board polish Ab3dEf9x --title "Fix the export" --file /tmp/prompt.md
```

### board task

```
Usage: board task [options] <task> [set <key> <value> | unset <key>]

Without an action, print a task's settings: status, priority, model, effort, the
lane it asks for, whether the agent may mark it done, its icon, its labels,
agent, who made it, the machine it is pinned to and its directory, when it
starts, its schedule, the task it was forked from, whether its next run resumes
a session, and its PR. With --json, print the task as `board tasks --json` does.

`set priority <urgent|high|normal|low>` and `set model <alias or model id>`
change the setting, `unset model` goes back to claude's default model. `set
effort <low|medium|high|xhigh|max>` and `unset effort` do the same for claude's
effort level. A model or an effort applies from the next run on; a run in
progress keeps its own.

`set lane <name>` makes the task ask for that lane of the machine that runs it,
`unset lane` for the default lane. A machine without a lane of that name runs
the task in its default lane. A running task keeps its lane until its next
start, so the change is refused while it runs.

`set auto-done on` lets the agent move the task to Done itself when it judges
that every acceptance criterion is met and nothing is left for you; `set
auto-done off` (or `unset auto-done`) keeps the move to Done yours, and the
agent ends in Needs me. It applies at once, also to a run in progress: an agent
that tries to finish a task set to off is refused and moves it to Needs me
instead.

`set icon <emoji>` shows one emoji at the left of the title on the board card,
`unset icon` removes it. It applies at once, in any status, and nothing else
reads it: the board applies no icon by itself.

`set labels <label...>` gives the task these labels, each word one label (quote
a label with spaces), and replaces the ones it had; `unset labels` removes them
all. The board card shows them as badges. They apply at once, in any status, and
nothing reads them to decide how a task runs.

`set dir [path]` pins the task to this machine and the directory (default: the
current one; a path is relative to it and `~` expands). `unset dir` removes the
directory and the pin: any machine takes the task, in its default directory.
Claude Code keeps a session under its working directory and cannot resume it
from another one, so changing the directory drops the task's session: the next
run starts fresh there and reads the thread. A running or waiting task is
refused: stop it first. With a `dirs` list on this machine, the directory must
be listed (`board dirs add`).

`set prompt <text...>` changes the title and prompt of a task you created that
no worker has claimed yet and that waits in Todo or Backlog; the old title and
prompt stay in a note on the task. The text is every word after `prompt`, `-`
reads it from stdin and `--file <path>` from a regular file in /tmp, for long
text. `--title <title>` sets the title too; without it the title stays. A card
of a repeating schedule is edited through its schedule (`board schedules edit`),
and a task a worker started has its prompt in its thread: reply with `board
comment`. Start a prompt that begins with dashes after `--`.

On a card of a repeating schedule a change applies to that card only: the next
occurrence takes its priority, model, effort, auto-done setting, icon, labels,
machine and directory from the schedule again, which the command says. `set dir`
needs this machine's config.json, since it pins the task to the machine's name.

`set` and `unset` are not available inside a board run: only you change where a
task runs, in which lane, with what, and whether its agent may mark it done, and
what it says. Viewing works there.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task             the task: its id, a board task link or the start of its id
  action           set
                   priority|model|effort|lane|auto-done|icon|labels|dir|prompt
                   <value>, or unset model|effort|lane|auto-done|icon|labels|dir

Options:
  --title <title>  with set prompt: the new title (default: keep the current
                   one)
  --file <path>    with set prompt: the prompt from a regular file in /tmp
  --json           print JSON on stdout instead of text; a value this machine
                   cannot decrypt is null there and named in "unreadable" (text
                   shows "(cannot decrypt: input)" after the task, and "(cannot
                   decrypt this title)" for a title)
  --dry-run        read everything, print every write instead of doing it
  -h, --help       display help for command

Examples:
  board task Ab3dEf9x
  board task Ab3 --json
  board task Ab3 set priority high
  board task Ab3 set model opus
  board task Ab3 unset model
  board task Ab3 set effort high
  board task Ab3 set lane reviews
  board task Ab3 unset lane
  board task Ab3 set auto-done on
  board task Ab3 unset auto-done
  board task Ab3 set icon 🚀
  board task Ab3 unset icon
  board task Ab3 set labels bug "needs review"
  board task Ab3 unset labels
  board task Ab3 set dir
  board task Ab3 set dir ~/workspace/agent-board
  board task Ab3 unset dir
  board task Ab3 set prompt Find out why the bidder export is slow
  board task Ab3 set prompt --title "Slow export" --file /tmp/prompt.md
  echo "new prompt" | board task Ab3 set prompt -
```

## Scheduling

### board schedule

```
Usage: board schedule [options] <prompt...>

Make a task of the prompt, written as you would type it into Claude Code, bound
to this machine and this directory. Prints its URL. A quick Haiku call first
checks whether an open task already covers it; --new skips that.

--auto-done lets the agent move the task to Done itself when it judges that
every acceptance criterion is met and nothing is left for you; without it the
task ends in Needs me. A repeating schedule hands the setting to each task it
makes. `board task <id> set auto-done on|off` changes it later.

The flags come first; everything from the first other word on is the prompt,
flags included (`--auto` below goes to the skill). To start the prompt with
dashes, put -- before it.

--in or --at keeps the task in Todo until then. --every or --cron makes a
repeating schedule instead, starting at --in/--at (default now), for --times
runs or until --until, else forever.

--polish parks the task in Backlog and queues a second task, "Polish prompt:
<title>", that asks an agent to turn the prompt into a complete plan, as the
Polish prompt button on the board does. Apply the result from that task's page.
It cannot be combined with --hold, --in, --at or a repeat.

--key <key> is for scripts that run `board schedule` again and again: the board
keeps one task per key (the key itself never leaves this machine), so a second
call finds the first instead of making another, and the duplicate check is
skipped. It cannot be combined with a repeat, --polish, --hold or --backlog. It
prints `created`, `exists`, `requeued` or `rescheduled`, the task id and URL,
and for exists the reason in parentheses, and exits 0 for all of them. A task
that was closed is `exists (closed)` and never made again.

With --version <v> (a PR head sha, say) the task remembers what it was made for.
When it differs and the task waits in Needs me or is Done, the task goes back to
Todo with a note "New version" (`requeued`). With --in or --at, a task that
waits in Todo for a fresh start moves its start time to the new one, whatever
--version says (`rescheduled`; the same --at again changes nothing, and --in
sets a new wait each time), and a new task or a requeue starts then. Otherwise
it is `exists` with the reason same-version, no-version (no --version given),
busy (Todo, Running, Waiting or Backlog), changed (the task moved while this
ran) or other-agent (it runs as another --agent than this call names, which
cannot be changed later).

With --json, print {"id", "url"} of the task on stdout (and "polishId",
"polishUrl" with --polish; "result", "status" and "reason" with --key);
everything else goes to stderr. Not available inside a board run: there, propose
follow-up work with `board add`.

Arguments:
  prompt                 what the task should do

Options:
  --priority <priority>  urgent, high, normal, low (default normal)
  --model <model>        claude model alias or full name, e.g. fable, opus,
                         sonnet, haiku (default: claude's default)
  --effort <level>       claude effort level: low, medium, high, xhigh, max
                         (default: claude's default)
  --icon <emoji>         one emoji shown at the left of the title on the board
                         card (default: none)
  --label <label>        a label shown on the board card; repeatable (default:
                         none)
  --lane <name>          the lane of the machine that runs the task (default:
                         that machine's default lane; a machine without the lane
                         uses its default one)
  --auto-done            let the agent move the task to Done itself when it
                         judges every acceptance criterion met (default: it ends
                         in needs-me)
  --agent <name>         run the task as this agent of this machine's
                         config.json (its tools and lists only, never asking);
                         the board keeps the name sealed
  --title <title>        the task's title (default: the prompt's first line)
  --hold                 land it in needs-me instead of Todo
  --backlog              park it in backlog instead of Todo
  --in <duration>        keep it in Todo for this long (30m, 2h, 1d, 1h30m);
                         with a repeat, the first run
  --at <time>            keep it in Todo until then (2027-01-01T12:00,
                         2027-01-01, 09:30); with a repeat, the first run
  --every <duration>     repeat on a fixed grid from the first run (2h)
  --cron <expr>          repeat by a 5-field cron expression in this machine's
                         time zone ("0 9 * * 1-5"); give it up to 10 times to
                         run when any matches
  --after <schedule>     a schedule that runs after another: its task is made
                         when a task of that schedule finishes (the schedule's
                         id or the start of it)
  --delay <duration>     with --after: start this long after the other
                         schedule's task finished (10m, 2h)
  --max-concurrent <n>   with a repeat: at most this many tasks of the schedule
                         running or waiting at once; the next one stays in Todo
                         until a slot is free
  --times <n>            end a repeat after this many runs, the first included
  --until <time>         end a repeat after this time
  --polish               park it in backlog and queue a task that polishes its
                         prompt, as "Polish prompt" on the board
  --new                  skip the duplicate check
  --key <key>            one task per key on the board: a second schedule with
                         the same key finds the first instead of making another,
                         with no duplicate check
  --version <version>    with --key: what the task was made for (a PR head sha);
                         a task in needs-me or done goes back to Todo when it
                         differs
  --dry-run              read everything, print every write instead of doing it
  --json                 print JSON on stdout instead of text
  -h, --help             display help for command

Examples:
  board schedule /review-pr 17741
  board schedule --priority high /review-pr acme/app#17741 --auto
  board schedule --auto-done "Bump the patch version of every package and open a PR"
  board schedule --model opus "Find out why the bidder export is slow and propose a fix"
  board schedule --label bug --label export "Find out why the bidder export is slow"
  board schedule "Find out why the bidder export is slow and propose a fix"
  board schedule --in 2h /review-pr 17741
  board schedule --at 09:00 /grill the plan in docs/x.md
  board schedule --every 2h --times 5 /sweep the stale branches
  board schedule --cron "0 9 * * 1-5" /review-pr --auto
  board schedule --cron "0 9 * * 5#1" --cron "0 9 * * 5#3" /sprint report
  board schedule --every 1h --max-concurrent 2 /sweep the stale branches
  board schedule --after s1b2c3d4 --delay 10m /deploy the release
  board schedule --polish "bidder export should include postal codes"
  board schedule --hold -- --weird prompt
  board schedule --json /review-pr 17741
  board schedule --agent reviewer --key https://github.com/o/r/pull/7 --version 3f9c2ab --json /review-pr https://github.com/o/r/pull/7 --auto
```

### board schedules

```
Usage: board schedules [options] [pause|resume|rm <id> | edit <id> [text...|-|--file <path>]]

Without arguments, list the repeating schedules: id, rule, next run, runs left,
paused or ended, the limit if it has one, title; --json prints them as JSON.

`pause <id>` drops the waiting run and stops the schedule, `resume <id>` makes
the next run, `rm <id>` deletes the schedule and its waiting run.

`edit <id> [text...]` changes the schedule's prompt: the text is every word
after the id, `-` reads it from stdin and `--file <path>` from a regular file in
/tmp, for long text; without any text the prompt stays. `--title <title>` sets
the title too; without it the title stays. Every later run takes the new text.
The waiting run takes it too while it is in Todo and no worker has claimed it,
and the command says which of three happened. Runs that already started keep
what they had, and the old text is not kept. An ended schedule is refused.

The other flags of `edit` change the settings of the schedule, all that the Edit
schedule dialog on the board changes; what you leave out stays as it is.
--priority, --model and --effort (`default` for claude's default), --lane <name>
(`default` for the default lane of the machine that runs it), --auto-done
on|off, --icon <emoji> (`none` for no icon), --label <label> (repeatable: the
labels given replace the old ones; `--label none` removes them) and --agent (an
agent of this machine's config.json, or `none`). --dir <path> pins the schedule
to this machine and that directory (listed in `board dirs`; `none`: no machine
and no directory), as `board task <id> set dir` does for a task.

The repeat: --every <duration>, --cron <expr> (up to 10 times, in this machine's
time zone) or --after <schedule> with --delay <duration>; the one you give
replaces the old repeat. --in or --at moves the first run of a schedule that has
a rule of its own. The end: --times <n> runs left (the waiting one included),
--until <time> or --forever; give one. --max-concurrent <n|none> limits how many
tasks of the schedule run at once. Switching to --after removes the waiting
task, and switching back makes one. These flags need a board server that has
them; the command says when it has not.

Changing a schedule is not available inside a board run. The id can be the start
of it (3 to 7 or 9 to 11 characters; 8 and 12 are whole ids) outside a run.

Arguments:
  action                 pause, resume, rm or edit, and the schedule id

Options:
  --title <title>        with edit: the new title (default: keep the current
                         one)
  --file <path>          with edit: the prompt from a regular file in /tmp
  --priority <priority>  with edit: urgent, high, normal, low
  --model <model>        with edit: a claude model alias or full name, or
                         default for claude's default
  --effort <level>       with edit: low, medium, high, xhigh, max, or default
                         for claude's default effort
  --icon <emoji>         with edit: one emoji for the cards of the schedule, or
                         none for no icon
  --label <label>        with edit: a label for the cards of the schedule;
                         repeatable, replaces the old ones; none removes them
  --lane <name>          with edit: the lane of the machine that runs the tasks,
                         or default for that machine's default lane
  --auto-done <on|off>   with edit: let the agent move the tasks to Done itself
  --agent <name>         with edit: run as this agent of this machine's
                         config.json, or none
  --dir <path>           with edit: run on this machine in this directory (a
                         listed one), or none for no directory
  --every <duration>     with edit: repeat on a fixed grid (2h)
  --cron <expr>          with edit: repeat by a 5-field cron expression in this
                         machine's time zone; give it up to 10 times
  --after <schedule>     with edit: run after another schedule (its id or the
                         start of it)
  --delay <duration>     with edit: start this long after the other schedule's
                         task finished (10m, 2h)
  --in <duration>        with edit: the first run, after this long (30m, 2h, 1d)
  --at <time>            with edit: the first run, then (2027-01-01T12:00,
                         2027-01-01, 09:30)
  --times <n>            with edit: runs left, the waiting one included
  --until <time>         with edit: end after this time
  --forever              with edit: no end: clears --times and --until
  --max-concurrent <n>   with edit: at most this many tasks running or waiting
                         at once, or none
  --json                 print JSON on stdout instead of text; a value this
                         machine cannot decrypt is null there and named in
                         "unreadable" (text shows "(cannot decrypt: input)"
                         after the task, and "(cannot decrypt this title)" for a
                         title)
  --dry-run              read everything, print every write instead of doing it
  -h, --help             display help for command

Examples:
  board schedules
  board schedules --json
  board schedules pause s1b2c3d4
  board schedules rm s1b
  board schedules edit s1b2c3d4 /sweep the stale branches and the stale worktrees
  board schedules edit s1b --title "Nightly sweep" --file /tmp/prompt.md
  board schedules edit s1b2c3d4 --priority high --model opus --auto-done on
  board schedules edit s1b2c3d4 --lane review
  board schedules edit s1b2c3d4 --icon 🧹
  board schedules edit s1b2c3d4 --label chore --label nightly
  board schedules edit s1b2c3d4 --every 6h --times 10
  board schedules edit s1b2c3d4 --cron "0 9 * * 1-5" --until 2027-06-30
  board schedules edit s1b2c3d4 --after s9z8y7x6 --delay 10m --forever
  board schedules edit s1b2c3d4 --dir ~/workspace/agent-board --agent reviewer
  board schedules edit s1b2c3d4 --dir none --agent none --max-concurrent none
```

### board feeds

```
Usage: board feeds [options] [list | add <name> <file | -> | rm <name> | run <name> | pause <name> | resume <name>]

A feed asks an integration, a program of an installed plugin marketplace (see
`board plugins`), for the items that should have a task, on a timer this machine
runs. Its entry in config.json names the `integration`
(`<marketplace>:<integration>`), the `action` to run, the `options` that action
takes, how often it runs (`every`), the listed directory it runs in (`dir`),
optionally an `agent`, a `lane` and a `timeout`, and the `prompts` its tasks
start from: `new` for a task that is made, `update` for one whose item changed.
A prompt takes placeholders such as `{url}` from the fields the item carries.
For each item the machine makes the task of the key `feed:<name>:<item key>`, so
the board keeps one task per item. A task of an earlier run whose item is no
longer listed, and that still waits in Todo for its first start, is moved to
Done.

The watch unit runs every feed that is due; `board feeds` lists them with their
last run. `add <name> <file | ->` reads the entry as JSON from a file or from
stdin and validates it as a run would (the plugin, the action, the options, the
prompts and the check of the integration) and only then writes `feeds.<name>` to
config.json; adding a name again replaces it. It then runs the `doctor` of the
integration and warns when a prerequisite is missing, such as a login; the feed
stays added. `rm <name>` removes it; the tasks it made stay. `run <name>` runs
it now, here, and exits 1 when the run failed. `pause` and `resume` stop and
restart its timer.

Before every run the feed is validated: the plugin must be installed and at the
commit that was installed, the action must exist, the options must fit what the
integration describes, the prompts may use only the fields it provides, and its
own check must pass. A feed that does not validate is reported and never runs. A
listing that fails (an exit other than 0, a time limit, a line that is not a
valid item) schedules nothing and closes nothing. Each item carries a `key`, a
`title` and a `version`, and the fields its action declares; the full contract,
with the entry format, is in docs/plugins.md.

Arguments:
  action      list, add, rm, run, pause or resume, the feed name, and for add
              the file of its entry

Options:
  -h, --help  display help for command

Examples:
  board feeds
  board plugins install <repository URL>
  board feeds add gh-reviews ./gh-reviews.json
  board feeds run gh-reviews
  board feeds pause gh-reviews
  board feeds rm gh-reviews
```

### board delay

```
Usage: board delay [options] <task>

Delay a task in Todo until then, or with --now make it due at once. Give exactly
one of --in, --at and --now.

<task> can be the full id, a link to the task on this board (as the CLI prints
it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but
not exactly 8, which counts as a whole older id; an exact-case match wins, else
case does not matter; it must be unique). Inside a board run only the full id is
accepted.

Arguments:
  task             the task: its id, a board task link or the start of its id

Options:
  --in <duration>  start after this long (30m, 2h, 1d, 1h30m)
  --at <time>      start then (2027-01-01T12:00, 2027-01-01, 09:30)
  --now            clear the delay: due at once
  --dry-run        read everything, print every write instead of doing it
  -h, --help       display help for command

Examples:
  board delay Ab3dEf9x --in 1d
  board delay Ab3 --at 09:00
  board delay Ab3dEf9x --now
```

## Setup

### board dirs

```
Usage: board dirs [options] [list | add [path] | rm [path] | set <key> <value> [path] | unset <key> [path]]

Manage the `dirs` list of this machine's config.json: the directories workers
may run in. Without a `dirs` key nothing is limited; once the key exists, even
as `{}`, workers run only in a listed directory or one below it. Without
arguments (or with `list`), print the entries, marking one whose directory is
gone as missing. `add [path]` lists the real path of a directory (default: the
current one); `rm [path]` unlists one. `set <key> <value> [path]` and `unset
<key> [path]` change one setting of a listed directory (below). A path is
relative to the current directory.

`add` refuses `/` and a path that is not a directory, warns about the home
directory (it allows everything below it), and notes when a parent is already
listed. When the directory is the top level of a git checkout (not a
subdirectory, not a linked worktree) whose remote is a GitHub repository, `add`
also sets its `repo` from the remote of the upstream of the current branch, else
`origin`; it leaves `repo` unset, with a note, when another entry has that repo
or `repos` maps it to another path, and `--no-repo` skips this. Adding a listed
directory again sets or corrects its `repo` the same way (and keeps every other
setting); when git gives no repo it leaves an existing `repo` alone and says it
could not confirm it, and `--no-repo` leaves `repo` as it is. `add
--from-config` lists the directories the config already routes to: `defaultCwd`,
every lane `cwd` and every `repos` checkout that exists, skipping those a listed
directory covers and never listing `/` or the home directory.

`rm` asks the board for open tasks and schedules of this machine that run in the
directory and in no other listed one, and refuses while there are any, and when
the board cannot be reached; --force removes it anyway and needs no board. The
list is enforced as soon as it exists, even empty: a worker refuses to start a
task outside it, a run that ends outside it keeps the directory it started in,
and `board schedule` and `board add` refuse (`board add` falls back to the
directory the run started in) outside it. `add`, `rm`, `set` and `unset` rewrite
the `dirs` key of config.json and nothing else (the settings of the other
entries stay as they are), and are not available inside a board run.

A listed directory can carry five settings. `label` (1 to 64 characters) is a
short name the New task form shows with the path, and the only setting the board
is sent. `repo` (owner/name) makes the directory the checkout of that
repository, like a `repos` entry. `default` (the value is `true`) makes it the
directory of tasks that have none, like `defaultCwd`; one directory has it.
`lane` (a lane of this config) makes it the directory of that lane's tasks
without one, like the lane's `cwd`; one directory per lane. A setting wins over
the old key it stands for (`repos`, `defaultCwd`, a lane `cwd`), and `set`
refuses one that another directory has: `unset` it there first. `list` shows
each entry's settings; `rm` says which of repo, default and lane go with the
entry. `ciIgnore` is a comma-separated list of check names (up to 20, `*` for
any characters, no comma in a name) that `board watch --ci` leaves out when it
starts in this directory or one below it, such as an approval gate
(`policy-bot*`) or a CI hold job; it stays on this machine, and `board watch`
merges it with its own --ignore at the start of a watch. `set` replaces the
whole list.

The board gets a copy of the list, for the New task form to offer: the listed
directories that exist, sent by `add`, `rm`, `set` and `unset` and by every
dispatch tick when it changed, each with its label. The copy is advice; workers
read only this machine's config.json. If the board cannot be reached, they still
succeed, warn, and leave it to the next dispatch tick.

Arguments:
  action         list, add, rm, set or unset, and a path, or a setting and its
                 value

Options:
  --from-config  add: list the directories the config already routes to
  --no-repo      add: do not set the repo of a GitHub checkout
  --force        rm: remove although work of this machine still runs there, or
                 the board cannot be checked
  --dry-run      read everything, print every write instead of doing it
  -h, --help     display help for command

Examples:
  board dirs
  board dirs add
  board dirs add ~/workspace/agent-board
  board dirs add --from-config
  board dirs add --no-repo ~/workspace/scratch
  board dirs rm ~/workspace/old
  board dirs rm --force ~/workspace/gone
  board dirs set label Board
  board dirs set repo acme/board ~/workspace/agent-board
  board dirs set default true
  board dirs set lane reviews ~/workspace/reviews
  board dirs set ciIgnore 'policy-bot*,hold *' ~/workspace/acme/app
  board dirs unset label
```

### board plugins

```
Usage: board plugins [list | install <url> | update <name> | remove <name>]

A marketplace is a git repository that lists integrations, programs a feed runs
to read another tool such as GitHub. `install <url>` clones it under the state
directory and pins the commit it was at; a feed then names an integration as
`<marketplace>:<integration>`. The code of a marketplace runs with your
authority, so install only repositories you trust.

The pin is the commit you installed. Only `update <name>` moves it: it fetches
the default branch of the marketplace, checks it, moves the pin and prints the
commits you accept. Nothing else fetches, and no timer does. A checkout that is
at another commit than its pin, or whose tracked files were edited, is not used
until you run `update` or discard the edits.

`remove <name>` deletes the checkout and the entry, and refuses while a feed in
config.json names the marketplace. `list` shows each marketplace with its pin
state and integrations. Install, update and remove are not available inside a
board run.

Arguments:
  action      list, install, update or remove, then the git URL (install) or the
              marketplace name

Options:
  -h, --help  display help for command

Examples:
  board plugins install https://github.com/mloureiro/agent-board-plugins
  board plugins list
  board plugins update mloureiro
  board plugins remove mloureiro
```

### board config

```
Usage: board config [options] [show | get <key> | set <key> <value> | unset <key> | edit | path]

View and edit this machine's config.json (`AGENT_BOARD_CONFIG_DIR` changes where
it is) without a text editor. Without arguments (or with `show`), print the path
of the file and the settings as the CLI reads them, a value that comes from a
default marked `(default)`, the lanes, repos and agents (an agent that cannot be
loaded with its error), the size of the `dirs` list, and then every warning
about the file (a key the CLI ignores, a `dirs` setting that overrides an older
key). `show --json` prints the file as JSON. `path` prints the path alone.

`get <key>` prints the value in the file at a dotted key (`machine`,
`lanes.reviews.slots`, `agents.reviewer.tools`): a string bare, anything else as
JSON. A key the file leaves out prints its default when it has one (`machine`,
`defaultCwd`, `pauseAfterMinutes`, `inactivityMinutes`, `maxRunHours`,
`autoUpdate`, `lanes`) and is an error otherwise. A name that holds dots (a
lane, a `dirs` path, `owner/name.js` under `repos`) is read as the document has
it.

`set <key> <value>` takes the value as JSON when it is JSON (`3`, `true`,
`["Read","Bash"]`, `{"slots":2}`) and as a string otherwise (write `'"123"'` for
the string 123), and creates the objects on the way. The whole resulting file is
checked before anything is written, and the change is refused, with the file
left as it is, when the config would not load, when it would add an agent that
cannot be loaded, when the key is not one the CLI reads (the error names the
nearest key), or when a directory the config routes work to (`defaultCwd`, the
`cwd` of a lane, a `repos` checkout) would newly not be a directory or not be
covered by `dirs`. Setting one lane in a file that has no `lanes` key writes the
default lane out too. A change to `dirs` that drops a listed directory warns
that work still pinned to it stops in Needs me (`board dirs rm` checks for
that). `unset <key>` removes a key so its default applies again, with the same
check. Setting what is already there writes nothing. The file is rewritten as
JSON with 2 spaces and keeps its key order and mode, and a config.json that is a
link is changed where it points. `--dry-run` shows what would be written. The
entries of `dirs` are changed with `board dirs`; `set` and `unset` refuse a key
below `dirs`.

`edit` opens the file in $VISUAL, else $EDITOR (run through the shell the way
git runs its editor, so a command line with arguments or quotes such as `code
-w` or `emacsclient -a ""` works; there is no default), on a copy beside it, and
replaces the file only when the result is JSON the CLI can load. An unknown key,
an agent that cannot be loaded or a route that is not a directory or not in
`dirs` is a warning there, since you wrote it by hand. If the result is not
valid, the file stays as it was and the message names the copy with your edits.
It needs a terminal. `set`, `unset` and `edit` are not available inside a board
run: the file holds the rules runs work under.

After a change the CLI sends a changed `dirs` list to the board (a failure is a
warning), warns when `machine` changed (the board names a machine by its token),
and says that the change applies from the next dispatch tick. A run that is
already going keeps the settings it started with, except `maxRunHours`,
`inactivityMinutes` and `pauseAfterMinutes`: the dispatcher reads those from the
file on each tick and applies them to runs already going (a run past a lowered
`maxRunHours` is stopped then).

Arguments:
  action      show, get, set, unset, edit or path, and a key and its value

Options:
  --dry-run   read everything, print every write instead of doing it
  --json      print JSON on stdout instead of text
  -h, --help  display help for command

Examples:
  board config
  board config get lanes.reviews.slots
  board config set pauseAfterMinutes 10
  board config set agents.reviewer.tools '["Read","Bash"]'
  board config set lanes.reviews '{"slots":2}'
  board config --dry-run unset maxRunHours
  board config edit
```

### board agents

```
Usage: board agents [options] [list | show <name> | export <name> | add <file|-|url|example:name> | push <name|file|-|url|example:name> | rm [--board] <name>]

Manage the agents of this machine: the named sets of tools and rules a task runs
as when it names one (see Agents in docs/workers.md). An agent is defined either
under `agents` in config.json or as a file `<name>.yaml` (or `.yml`, `.json`) in
the `agents` directory beside it; both are checked the same strict way, and a
name defined in both places is unusable.

Without arguments (or with `list`), print each agent with its tools, how many
allow and deny rules it has, where it is defined, where it came from, and
whether it is usable here (a definition that does not parse, or a plugin
placeholder such as `{pr-review}` that does not resolve, is not). `show <name>`
prints one agent as a YAML document (`--json` for JSON), the same shape `add`
reads; `export <name>` prints the same without the `source` this machine
recorded, to share it.

`add <file | - | https-url | example:name>` reads a definition (YAML or JSON:
the keys of a config.json agent plus `name` and `version`) from a file, from
stdin, from an https URL or from an example that ships with the CLI, and writes
it to `agents/<name>.yaml` (mode 600). The name is `--name`, else the document's
`name`, else the file name. An agent definition decides what a run may do on
this machine, so `add` first prints the whole definition and every tool, allow
rule, deny rule, env variable and MCP server it grants, flags broad rules
(`Bash`, `Bash(*)`, a rule that runs a shell or `curl`, `Read` of a whole tree),
env names that look like secrets and an empty deny list, says whether its plugin
placeholders resolve, and writes only after you confirm at a terminal or pass
`--yes`. An agent that exists needs `--replace`; one defined in config.json is
not replaced.

A URL must be https; the fetch takes at most 15 seconds and 256 KB, and follows
a redirect only to https on the same host. `#sha256=<hex>` at the end of the URL
pins the file: `add` refuses one whose sha256 differs. The URL is recorded as
the agent's `source`; nothing updates it later, so run `add --replace` again to
take a newer version.

`push <name | file | - | https-url | example:name>` puts one agent on the board
for every machine of yours: an agent this machine defines, or a definition read
the way `add` reads one. It prints the same definition and grant summary, and
pushes only after you confirm at a terminal or pass `--yes`. Every machine
applies the board's agents on its next dispatch tick: it writes them to
`agents.board/` beside config.json and moves its own definition of the same name
to `agents.replaced/` (the board wins a name; nothing is deleted). After a push
the agent is the board's on this machine too: its agents/ file or config.json
entry goes. The board holds all agents as one sealed document whose version goes
up with every push; a push that finds another push came first fetches again and
retries once.

`rm <name>` removes the agent's file, or its entry in config.json (the rest of
the file stays as it is). `rm --board <name>` takes an agent off the board, and
every machine drops its copy on its next tick. `add` refuses a name the board
holds. `add`, `push` and `rm` are not available inside a board run.

The list says where each agent comes from (`config.json`, `agents/<file>` or
`board v<n>`, the version of the board's agents this machine applied) and the
first 12 hex digits of its hash: SHA-256 of the keys that decide what a run may
do, the same on every machine for the same definition.

Arguments:
  action         list, show, export, add, push or rm, and a name or a source

Options:
  --json         list, show, export: print JSON instead of text or YAML
  --yaml         show, export: print YAML (the default)
  --name <name>  add, push: the name to add or push the agent under
  --replace      add: overwrite an agent of that name
  -y, --yes      add, push: write without asking (read the definition first)
  --board        rm: take the agent off the board's agents, for every machine
  --dry-run      read everything, print every write instead of doing it
  -h, --help     display help for command

Examples:
  board agents
  board agents show reviewer
  board agents export reviewer > reviewer.yaml
  board agents add example:reviewer
  board agents add ./reviewer.yaml --name reviewer-strict
  board agents add https://example.com/agents/reviewer.yaml#sha256=<hex>
  yq -o json reviewer.yaml | board agents add - --yes
  board agents rm reviewer
  board agents push reviewer
  board agents push ./reviewer.yaml
  board agents rm --board reviewer
```

### board init

```
Usage: board init [options]

Set this machine up for the board: write web.json (the board's URL), env (the
machine token and the data key, mode 600) and, if it is missing, config.json
(from the example, with this machine's name). Then run the checks of `board
doctor`.

Set up encryption in the browser first: init asks for the data key from the
board's Settings page as well as the token. The page offers the env lines to
copy (`AGENT_BOARD_TOKEN=…`, `AGENT_BOARD_DATA_KEY=…`). At a prompt paste one
line: the bare value, or its own line (a prompt takes one line, so the other
line is refused, naming which one it wants); a file or pipe given with
--token-file or --data-key-file may hold both lines. Without flags it asks. For
a script give --url, --token-file and --data-key-file: a secret never goes on
the command line, where it would land in the shell history. A secret file must
be mode 600 or 400 like env, which a pipe is: `printf %s "$TOKEN" | board init
--url … --token-file /dev/stdin --data-key-file ~/key`; only one of the two can
be /dev/stdin. --machine defaults to the host name.

A file that exists is kept unless --force, which copies it to
<name>.bak-<timestamp> first (an env backup is mode 600 at most) and keeps what
you do not give again: the URL, the token, the data key and any other line of
env. An env that has the token but no data key (or the reverse) is completed
without --force: init asks for the missing value only. config.json is never
replaced.

Not available inside a board run.

Options:
  --url <url>             the board's URL (https, or http for localhost)
  --token-file <path>     read the machine token from this file: the bare token
                          or the env line(s) the Settings page offers (mode 600
                          or 400, or a pipe)
  --data-key-file <path>  read the data key from this file: the bare key or the
                          env line(s) the Settings page offers (mode 600 or 400,
                          or a pipe)
  --machine <name>        this machine's name on the board (default: the host
                          name)
  --force                 replace web.json and env after backing them up
  -h, --help              display help for command

Examples:
  board init
  printf %s "$TOKEN" | board init --url https://board.example.com --token-file /dev/stdin --data-key-file ~/key --machine laptop
```

### board doctor

```
Usage: board doctor [options]

Check this machine, read-only, one line per check: ✓ passes, ✗ fails (with a
fix), ! is a warning. Exit 1 if any check fails; warnings alone exit 0. The
token is never printed.

Checks: Node 24+ (checkout only), the config directory, web.json, env (mode 600
or 400, token, data key), the board (reachable, token accepted, API version
range, and whether it has a data key and this machine holds the same one),
config.json, each installed plugin marketplace (still at the commit that was
installed), each feed (it validates) and each integration the feeds use (its own
`doctor`, run with the PATH the units run with), and for a worker machine
claude, gh, flock, systemd-run, systemctl and the installed units with their
timers and the listener (on macOS: claude, gh, lockf, the launchd agents and
whether launchd has loaded them, the run directory, and a warning for a checkout
under ~/Documents, ~/Desktop, ~/Downloads or iCloud Drive, which macOS keeps
background jobs out of). The worker checks only warn on a machine with no unit
or agent installed, and are left out on a system other than Linux and macOS,
where no worker runs.

Options:
  --json      print JSON on stdout instead of text
  -h, --help  display help for command

Examples:
  board doctor
  board doctor --json
```

### board setup

```
Usage: board setup [options]

Install this machine as a worker: write the dispatch service and timer and the
listener service into ~/.config/systemd/user (or $XDG_CONFIG_HOME/systemd/user)
as copies, run `systemctl --user daemon-reload` and print the line that enables
them. The listener holds a stream to the board and starts a dispatch tick within
a second of a change; the timers stay as the fallback. Run it again after moving
the binary or the checkout, or upgrading Node. It needs Linux with systemd and
flock, or macOS.

On macOS it writes two launchd agents, de.codeplant.agent-board.dispatch (every
2 minutes) and de.codeplant.agent-board.listen, into ~/Library/LaunchAgents as
copies, creates the log and run directories and loads the agents that are loaded
already (all of them with --enable) with `launchctl bootout` and `launchctl
bootstrap gui/<uid>`; without --enable it prints the bootstrap lines. The agents
log to launchd.dispatch.log and launchd.listen.log in the log directory.

The services run this CLI the way `board setup` was started: the binary, or the
checkout with its Node. --print shows the units (or agents) and changes nothing;
--enable also enables and starts the timer and the listener (loads the agents).
When an installed unit differs from what it writes, the differing lines are
shown. It refuses unless --force when this checkout is not the one the installed
~/.local/bin/board runs from (a worktree, a scratch copy), or when a binary runs
from the temp directory, so it cannot take over the live timers. Setup also
stops and deletes the timer, service or launchd agent of the removed built-in
intake when it finds one (not with --print). Not available inside a board run.

Options:
  --enable    also enable and start the timer and the listener
  --force     install although this checkout is not the installed one, or the
              binary runs from the temp directory
  --print     print the units and change nothing
  -h, --help  display help for command

Examples:
  board setup
  board setup --print
  board setup --enable
```

### board uninstall

```
Usage: board uninstall [options]

Undo `board setup` and the install: stop, disable and delete the dispatch timer,
the listener and the watch unit (on macOS: boot out and delete the three launchd
agents), and delete the installed board (~/.local/bin/board or
$BOARD_INSTALL_DIR/board: the binary, or the link a checkout install made). A
unit that is not installed or not running is skipped; one that fails to stop
keeps its file, and the installed board stays so the command can be run again;
the command exits 1. With --include-optional, a directory that is the home
directory or holds it is refused. Workers that run keep running until they end.
A checkout itself is never touched.

The config directory (web.json, config.json, and env with the token and the data
key), the state directory (task logs, sessions, watches) and the run directory
are kept, so `install.sh` and `board setup --enable` bring the machine back as
it was. --include-optional removes them too; keep a copy of the data key first
if this machine may need it again. --dry-run prints what would be stopped and
removed and changes nothing. Not available inside a board run.

Options:
  --include-optional  also remove the config, state and run directories
  --dry-run           read everything, print every write instead of doing it
  -h, --help          display help for command

Examples:
  board uninstall --dry-run
  board uninstall
  board uninstall --include-optional
```

### board restart

```
Usage: board restart [options] [unit...]

Restart the worker units of this machine, all three or the ones named:
`systemctl --user restart` on the dispatch timer (which starts its schedule
again; a tick that runs is not stopped), the listener and the watch unit, or on
macOS `launchctl kickstart` of the launchd agents (-k for the listener and the
watch unit; the dispatch agent starts a tick now). Only installed units are
restarted (on macOS, agents launchd has loaded); the others are named with the
line that installs them. Exit 1 when a restart failed or nothing could be
restarted.

Running workers are their own transient units and keep running. Stopping the
listener waits for a dispatch tick that is running, up to 130 s.

Not available inside a board run.

Arguments:
  unit        dispatch, listen or watch (default: all three) (choices:
              "dispatch", "listen", "watch")

Options:
  -h, --help  display help for command

Examples:
  board restart
  board restart listen watch
```

### board logs

```
Usage: board logs [options] [target]

Show the end of the log of the dispatch timer, the listener or the watch unit
(all three together, in time order, when none is named), or of a task. On Linux
the units are read with `journalctl --user`; on macOS with `tail` on
launchd.<unit>.log in the log directory. A task id shows its log file in the log
directory, which exists on the machine that ran the task only; it needs no
network.

--follow keeps printing until Ctrl-C. --lines is how many lines to show from the
end. --since limits the units to a time as journalctl reads it, such as "1 hour
ago" or "2026-01-31 10:00"; it is not available on macOS or for a task log. Exit
status is that of journalctl or tail. Allowed inside a board run.

Arguments:
  target           dispatch, listen, watch or a task id (default: the three
                   units)

Options:
  -f, --follow     keep printing new lines until Ctrl-C
  -n, --lines <n>  how many lines to show from the end (default: "100")
  --since <time>   only the units, from this time on (Linux only), such as "1
                   hour ago"
  -h, --help       display help for command

Examples:
  board logs
  board logs listen -f
  board logs dispatch --since "1 hour ago"
  board logs <task id> -n 50
```

### board self-update

```
Usage: board self-update [options]

Download the newest cli-v* release of mloureiro/agent-board with `gh`, check it
against SHA256SUMS and replace this binary with it, then restart the listener if
it runs (`systemctl --user try-restart`, or `launchctl kickstart -k` on macOS
when launchd has the agent loaded). Running workers keep the old file until they
end. --check only reports whether a newer release exists.

When the release declares migration steps, the update first warns that a
migration is needed and asks (a terminal only; without one it goes on).
Everything is backed up first: the old binary, the config files and the unit
files, in the state directory under backups, of which the 3 newest are kept. The
steps then run through the new binary, one line each, and the listener and watch
unit restart. From a terminal it refuses while workers run. A step that fails or
needs you stops the migration: fix it, then run `board self-update --resume`.

It needs `gh`, logged in. A checkout is updated with `git pull` and `pnpm
install` instead, and says so. Not available inside a board run.

--resume continues a migration that stopped: it runs the steps the journal still
lists, then restarts the listener. It also works on a checkout, and says
`nothing to resume` when nothing is pending. From a terminal it refuses while
workers run.

Options:
  --check     only report whether a newer release exists
  --resume    continue a stopped migration
  -h, --help  display help for command

Examples:
  board self-update --check
  board self-update
  board self-update --resume
```

### board completion

```
Usage: board completion [options] <shell>

Print a completion script for bash, zsh or fish: commands, flags, statuses and
priorities, and the ids of your tasks and schedules (asked from the board, with
a 2 second limit).

Install it once:
  bash: board completion bash > ~/.local/share/bash-completion/completions/board
  zsh:  board completion zsh > "${fpath[1]}/_board"   (a directory on your
fpath)
  fish: board completion fish > ~/.config/fish/completions/board.fish

Arguments:
  shell       bash, zsh or fish (choices: "bash", "zsh", "fish")

Options:
  -h, --help  display help for command

Examples:
  board completion bash
  eval "$(board completion zsh)"
```

### board example

```
Usage: board example [options] [name]

Without a name, list the examples: scripts and config files to start from. With
a name, print that file on stdout, so `board example github-reviews.sh >
~/bin/github-reviews.sh` saves it. The files are built into the CLI, so they
match its version.

The scripts and the timer that runs them are described under Scripts in
docs/usage.md.

Arguments:
  name        the example to print

Options:
  -h, --help  display help for command

Examples:
  board example
  board example github-reviews.sh > github-reviews.sh
```

<!-- commands:end -->
