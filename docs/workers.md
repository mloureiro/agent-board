# Worker machines

How a worker machine picks tasks, runs them and reports back.

## Two machines

Every worker machine runs its own timers and its own listener against the same board. Its name is the `machine` key of its `config.json`, by default the host name. Each machine holds its own event stream, so a change reaches all of them at once.

- **Claims are atomic.** When two machines claim a task at once, the server lets one win. The other moves on to the next task.
- **A machine skips what it cannot serve**, so another one can take it. That is a task scheduled on another machine (its directory is there), a resume whose session lives on another machine, or a task that names an agent this machine does not define.
- **A machine sweeps only its own running tasks.** The worker unit lives where the task was claimed. When that machine is off, you can take the task back from the task page once its agent has been quiet for 20 minutes.
- **A script with a key may run on both.** The board keeps one task per key of `board schedule --key`, so two machines that run the github-reviews script make each task once. See [Scripts](usage.md#scripts).

Tasks only move while a machine with the right setup is on.

## Lanes

A machine splits its parallel runs into lanes, in its `config.json`. A task names the lane it wants; the prompt does not decide it.

```json
"lanes": {
  "reviews": { "slots": 2 },
  "general": { "slots": 3, "default": true }
}
```

Exactly one lane is the `default`. Without `lanes`, a machine runs one lane, `general`, with three slots, and it is the default. A config that marks no lane takes the first lane as the default, and one that marks two is refused.

- **The task names its lane.** You set it in the New task form, the lane picker on the task page or the schedule editor, or with `board schedule --lane <name>`, `board add --lane <name>` and `board task <task> set lane <name>`. A recurring schedule gives its lane to every occurrence. A task made by an agent's `board add` does not inherit the lane of the task that made it: it asks for none unless `--lane` says so. The lane is routing like the priority, so the board keeps it in clear. Its name has the shape of a machine name (`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`), and the worker checks it again before it uses it.
- **Own work first.** A task belongs to the lane it names, when this machine has a lane of that name. A task that names none, or one this machine lacks, belongs to the default lane. The dispatcher says so when it starts one that fell back (`lane reviews → general (no such lane here)` in the log and the start note), so a lane that exists only on one machine still works on the others. A lane with a free slot takes the first Todo task of its own. Resumes come first (answered, replied to or paused), then the rest by priority.
- **A running task keeps its lane.** The lane can be changed while the task is not running. The board refuses a change while it runs, and the run goes on in the lane it started in. A new start (a resume, a re-run) takes the lane the task names then.
- **Borrowing.** A lane with nothing of its own borrows the first task any other lane would run, so idle slots do not wait. The run is marked borrowed.
- **Taking the slot back.** A full lane may have its own work waiting while it runs borrowed work. Once a borrowed run has gone on for `pauseAfterMinutes` (default 5), the dispatcher asks the newest such run to pause, one per lane at a time. Lane bias beats priority, so a borrowed urgent run gives way to its lane's own low task. An urgent task only has guaranteed room in its own lane.

### Pausing

Pausing is cooperative. The dispatcher drops a pause flag. The worker sees it on its next 15-second tick and writes a message to the agent's stdin that tells it to post a one-line status and end its turn. Nothing is refused, so the session stays clean and the agent finishes the step it is on.

When the turn ends, the worker notes "Paused on <machine>: …" and puts the task back in Todo, ahead of new work. It resumes in its session on the same machine. The resumed run is told it was paused and checks its state before it goes on.

A turn that has not ended 2 minutes after the message is interrupted (see [Talking to a running agent](#talking-to-a-running-agent)), and the task is paused all the same.

### A lane's directory

A lane may name a `cwd`. Its tasks run there when they have no directory of their own (see [Where a task runs](#where-a-task-runs)). A task's lane for this is the one it owns, the lane it names or the default one, not the lane that borrowed it:

```json
"reviews": { "slots": 2, "cwd": "~/workspace/acme/app" }
```

With that, a task from the New task form with the lane `reviews` runs in the checkout and gets its settings. You can set the same from the directory's side with `board dirs set lane reviews ~/workspace/acme/app` (see [Config](setup.md#config)). That setting wins over the lane's `cwd`, and one directory serves one lane.

## Usage limits

A machine can stop starting low-priority work while its Claude subscription is nearly used up. The `usageLimits` key of its `config.json` (see [Config](setup.md#config)) sets thresholds on the 5-hour and the 7-day usage:

```json
"usageLimits": { "fiveHour": 80, "sevenDay": 90, "priority": "urgent" }
```

While the last known usage of a window is at or over its threshold, the dispatcher does not claim Todo tasks below `priority`. The default is `urgent`, so only urgent tasks still start. Without the key nothing is held, and a window without a number is not limited.

- **What is held.** Todo tasks below `priority`, resumes included, since they use quota too. They stay in Todo. To run one anyway, raise its priority.
- **What is not held.** Runs that are going go on. Nothing is stopped or paused. Held tasks do not count as waiting work, so a lane does not pause a borrowed run for a task that will not start.
- **When it ends.** A reading stops counting once its window has reset. The dispatcher starts a tick at the earliest reset of the windows that held something. A reading whose reset is more than 8 days off is not believed.
- **Where to see it.** The dispatcher logs one `HOLD <n> task(s) below <priority>: 5-hour usage 85% (limit 80%, resets <time>)` line per tick, naming every reached window, and adds `held=<n>` to the `TICK` line. `board doctor` shows the thresholds, the last reading per window with the time it was seen, and whether work is held now.

### Where the number comes from

`claude -p --output-format stream-json` prints `rate_limit_event` lines in every run. The worker keeps the newest reading per window in `usage.json` of the state directory. This is not a documented interface (checked against Claude Code 2.1.326), and a line of any other shape counts as no reading. That has limits:

- Usage from outside the board, such as your own terminal sessions or another machine on the same account, is only seen when the next run here reports it. Until then a tick may still fill every free slot past the threshold.
- A machine that runs on an API key gets no such events and is never held.
- Before the first run reports a reading, nothing is held.

### On the board

At the end of each tick the machine builds its usage status and sends it to the board, sealed as `machine.usage`. The status holds:

- its limits and the last reading per window as a whole percent,
- the windows over their threshold,
- the ids of the Todo tasks it could serve and held back,
- the ids of the Todo tasks it could serve and did not hold (started, or waiting for a slot).

Machines without `usageLimits` send it too, because their list of open tasks tells the browser which tasks are not held. A dry run only prints. The dispatcher logs `USAGE sent` only when the status changed or tasks are held.

The browser turns this into a `Held until <time>` badge on a Todo card and a usage line per machine in Settings › Machines (see [Usage limits on the board](usage.md#usage-limits)). Two rules decide what shows:

- **A task counts as held only when no machine can still run it.** If one machine holds it and another lists it as open, the task is waiting for a slot there, and no badge shows.
- **Only fresh machines count.** A status counts for 10 minutes after the board last received it, and never for a revoked machine. The dispatcher ticks at least every 2 minutes, so a machine that is off, or whose dispatcher is failing, neither holds nor opens tasks.

## Liveness and limits

Every run starts with a PreToolUse hook that Claude Code calls before each tool call. The hook touches a heartbeat file and records the agent's working directory. It makes no network call and never fails a tool call.

The worker checks the heartbeat every 15 seconds:

- **No tool call for `inactivityMinutes`** (default 15). The run is interrupted as stuck, and the task goes to `needs-me` with the end of the log. Claude Code caps a foreground Bash call at ten minutes, so a long command does not trip it.
- **A run longer than `maxRunHours`** (default 6). The run is interrupted, however busy. This guards against an agent that loops on tool calls.

While the agent is active, the worker passes the heartbeat and the lane on to the board every 15 seconds. A running card counts the seconds since ("active 12s ago", then "active 1m 5s ago"). It turns amber after 5 quiet minutes and red after 10. The card also shows its lane, with a "borrowed" badge when it runs in another lane's slot. A task that waits in Todo or Backlog shows the lane it asks for as a small badge.

### How a run is stopped

Every stop is an interrupt first. The worker sends `claude` an interrupt on stdin, which ends what the agent is doing at once and keeps the session resumable. Then it closes stdin so the process exits. Only a process that is still there 30 seconds after the interrupt is killed, with SIGTERM and then SIGKILL.

### Run files

The heartbeat, pause flag, lane and working directory of a run live in `$XDG_RUNTIME_DIR/agent-board/`, private to your user. An agent's run also keeps the agent's definition there (`<task>.agents`). `AGENT_BOARD_RUN_DIR` overrides the directory. On macOS, without an `XDG_RUNTIME_DIR`, it is `~/.local/state/agent-board/run` (mode 700), where the process supervisor keeps its pid files too.

### Sleep

If the clock jumps because the machine slept, the worker moves the heartbeat up to the wake, so the sleep does not count as time without a tool call. The dispatcher's sweep does not count quiet time on a tick that follows a gap of more than 10 minutes.

## Talking to a running agent

The worker starts `claude -p` with `--input-format stream-json` and keeps its stdin open for the whole run. The prompt is the first user message, written as a JSON line. The worker writes three more things to stdin:

- **A pause message**, when the dispatcher wants the slot back (see [Lanes](#lanes)).
- **Your messages.** **Send** on a running task stores a pending note on the board (see [Ask and resume](usage.md#ask-and-resume)). The worker reads the task's run inbox on every 15-second tick and whenever the board's event stream says tasks changed, so a message usually arrives within seconds. It writes the notes to stdin as user messages and acknowledges them. Claude Code takes a user message up at its next tool boundary, so the agent is not interrupted. The note then shows **Delivered** in the thread.
- **An interrupt**, for **Stop**, **Stop & send** and the limits above. Plain Stop ends the run, and the task goes to Needs me with "Stopped by you.". With Stop & send the worker interrupts, writes your message after it, and the run carries on in the same session.

A message that was not handed over when the run ended is not lost. The task goes to the top of Todo to resume in its session with the message, and a note in the thread says so. If you stop the run or take the task back instead, the message becomes an ordinary reply that the next **Send & continue** carries.

## Watches

A watch (`board watch`, see [Waiting](usage.md#waiting)) is a file on the task's machine, `<state dir>/watches/<task>/watch-<name>.json`.

### The watch unit

`agent-board-watch.service` (a launchd agent on macOS) polls the watches. `board setup` writes it and `board setup --enable` starts it.

- It rescans the directory every 2 seconds, so `board watch` only has to write a file. It attempts each watch on the watch's own timer (`--every`, 30 seconds for `--ci`, or 60 seconds for `--pr-review` and `--pr-merged`). An attempt may take 2 minutes.
- It writes an event to `<state dir>/watches/<task>/event-<time>-<name>.json` and posts it to the thread as an agent comment.
- It wakes the task when an event is not handed over and the task has no live run. A worker marks its task as live with `<task>/live` while it runs. When the wake does not apply, because the task is in Needs me, paused in Todo or still running, the event stays for the next resume. If the worker's run goes away while an event waits, the unit tries the wake once more. That covers an event that fires between the worker's decision to park and its exit.
- It keeps all state on disk. `board self-update` restarts it as it restarts the listener, and a reboot loses nothing but the output of running [streams](#streams).
- Finishing a watch is a rename of its file. Whichever process renames it first (the unit, the dispatch tick or `board unwatch`) writes the event, so no event is written twice.

### The worker's side

- Every 2 seconds the worker looks for events of its task. It hands them to the agent on stdin as one user message and deletes the files it handed over.
- At the end of a turn it looks again. If an event is pending and the task still runs, the worker sends it as the next message and the run goes on.
- Once the task has left Running (the agent asked with `board ask`) or a pause was requested, the worker hands nothing more over. The events wait for the next resume.
- A run that ends with watches open and the task still running is parked. The worker moves the task to Waiting itself, until the earliest timeout, and the thread gets "Waiting for watches: …".
- A resume builds its prompt from the event files and deletes them at the agent's first output. The task log records how long the resume took from the event, from the wake and from the worker's start.
- A fresh run (**Re-run fresh**) drops the task's watches first.

### Publishing and stops

The board shows a task's watches and lets the user stop one (see [What the board shows of watches](usage.md#what-the-board-shows-of-watches)). The CLI publishes the list with `set-watches`, sealed as the task's `watches` (see [Encryption](encryption.md)).

- **What is published.** For each watch its name, kind, a label (`CI #116 · required`, `review #116`, `merge of #116`, `command, every 30s`, `timer`), a one-line status, its deadline and the time of its last look. The status is the CI summary, how many reviews and comments a review watch has seen, `still open` for a merge, `exit 1 at 10:47` or `not run yet` for a command, `streaming, 3 events` or `starting` for a stream (label `stream`), or `fires at 14:20` for a timer (`fires at 14:20:40` when that was less than ten minutes away at the time of publishing). The document also holds how many undelivered events of the task wait in the spool, once. The command and what it printed are never in it. An empty list is sent as `null`.
- **When.**
  - `board watch`, `board unwatch` and `board wait --check` publish after they changed the store.
  - The watch unit publishes at once when an event or a finished watch changes the list. For a changed status it publishes at most every 15 seconds per task. An unchanged state goes again after 5 minutes, so the time of the last look does not freeze.
  - The dispatch tick publishes `null` when it drops the watches of a finished task, and after it acted on stops.
  - The dispatch tick also publishes a task of its machine whose list on the board is not the one in the store, at most once per tick. The list counts as different when the board shows watches and the machine holds none, when the watches differ in id, name, kind, label or deadline, when the number of waiting events differs, or when the list cannot be opened. A status that lags does not count: the watch unit publishes it. This repairs a list that went stale because the machine went down between changing its store and publishing. The tick logs `REPUBLISH-WATCHES <task>`.
  - The worker publishes when it hands events over, which changes how many wait.
- **Failures.** A server without the `task.watches` feature gets nothing: the CLI logs one line per process and goes on. Any other failure is logged, and the next publish sends the whole list again.
- **Stop.** The board lists the ids the user stopped in `watchStops` of the task, and its event stream wakes the listener, so the tick acts within seconds. For each id of a task on this machine the tick:
  1. claims the matching watch, so no event comes from its source,
  2. writes a spool event of kind `stopped` with the text `Watch "<name>" was stopped by the user.`,
  3. posts the usual thread note and logs `STOP-WATCH <task> <name>`.

  The event follows the rules of any other: a worker hands it to the agent, and a parked task wakes, also when other watches stay open. An id with no local watch (already finished or removed) is acknowledged without an event.

- **Acknowledgement.** The tick sends `ack-watch-stops` with every id it handled, so none comes back, then publishes the list. If the acknowledgement fails, the next tick sends it again and writes no second event, because the watch is gone.

### Streams

A stream watch (`board watch --stream`) is the one watch that is not polled. The unit keeps its command running and reports what it prints.

- **Start.** The scan that finds a stream without a process in this unit starts its command with `bash -c`, in a process group of its own, with the directory and `env` of a command watch. It logs `STREAM <task> <name> started`. The watch file counts the starts and the events (`starts`, `events`).
- **Events.** Each scan (every 2 seconds) writes the lines that arrived since the last one as one event: a spool file, a thread note and a wake, as for any event. The watch stays open. While the note of one event is still on its way to the board, the next lines wait, so a slow board makes larger events and not a queue.
- **Exit.** The command's exit is the last event, with the lines not yet reported and the exit code or signal, and ends the watch by the usual claim.
- **Flood.** The unit counts events and bytes over 10 minutes. From 25 events on it collects lines for 10 seconds per event. At more than 50 events, or the moment the output passes 20 KB, it kills the process group and ends the watch with a `stopped` event that carries the notice and the last lines.
- **Restart.** A running command lives only in the unit's memory. A unit that starts finds the watch with `starts` above 0 and no process, starts the command again from the beginning and logs `started again from the beginning`. The next event of that watch starts with a line that says so. Stopping the unit kills the commands and writes no event.
- **End from outside.** `board unwatch`, Stop on the board, the timeout, a replaced watch and a dropped task take the watch file away. The next scan kills the command of a watch that is gone and logs `STREAM <task> <name> stopped: its watch is gone`.
- **On the board.** The status is `streaming, N events`. No line of output is published.

The dispatch tick cannot run a stream. Without the unit it only ends a stream at its timeout, and `board watch --stream` refuses to start one while the unit's heartbeat is stale.

### Without the watch unit

On a machine where the unit does not run, usually because `board setup` was not rerun after an update, the dispatch tick polls the due watches with 45 seconds per attempt. It logs `WARN watches on this machine are polled by the dispatch tick: the watch unit is not running; run "board setup --enable"`.

The tick polls only when the unit's heartbeat (`<state dir>/watches/.heartbeat`) is older than 30 seconds, so the two never run the same attempt. Whatever the heartbeat says, the tick also:

- finishes the timeouts of a waiting task whose `wakeAt` has passed, then wakes it,
- wakes a waiting task that has an event and no live run,
- drops the watches of a task that is Done, closed, in Backlog or gone.

## Transcripts

Every run records what it did. The worker starts `claude -p` with `--output-format stream-json --verbose` and condenses each event:

- the agent's text,
- each tool call with its input, and each tool result,
- subagent calls, tagged with their Agent call,
- notes such as the model and directory,
- the result, with turns, time, cost and refused tool calls.

It writes a readable line per event to the local log. It sends the events to the board with every 15-second check and once more when the run ends. A batch the board refuses is sent again with the next.

What waits for a board that is down is bounded at 20,000 events and 32 MB of JSON. Past either, the worker empties the oldest tool outputs first, then drops the oldest events, and a note in the transcript says how many.

### On the board

**Transcript** on a task page, or the terminal icon on a card, opens the runs, newest first, live while one runs. Tool calls are one line each, and a Bash call with a description shows the description with its command under it. A click shows the input and loads the output. A tool result over 256 KB is cut with a note, and the full one stays in the session file on the machine. Claude Code passes thinking on without its text, so a thinking block shows as a marker with its token estimate.

The board loads a run's events in pages of 2000, and afterwards only those after the last one it has. Long runs show in full, and a live run costs one small request per poll.

### Context usage

The worker also reads how full the agent's context window is, and sends it as a `context` event the board never lists in the transcript. Only the main agent counts: a subagent has its own context.

- **The figure** is the input, cache read, cache creation and output tokens of the main agent's latest assistant message. A message that streams as several lines replaces its earlier reading. After a compaction the next message's figure is smaller, and that is what shows.
- **The window** comes from the run's own result (`modelUsage`) once it has one. Before that it comes from `context-windows.json` in the state directory, which every finished run fills with the windows its result reported. A model this machine has never finished a run with shows only the used tokens until that run ends.
- **The auto-compact threshold** is drawn only when `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is set to a percentage from 1 to 100. The worker looks at its own environment, the variables the run is given, the user settings `env` (`~/.claude/settings.json`) and, for a run that loads the checkout's settings, the checkout's `env`, and the last one that sets it wins. Managed settings and `--settings` files are not seen, and then no marker is drawn. Claude Code applies the percentage to its effective window and never above 13,000 tokens short of it, so a value near 100 puts the marker slightly right of where compaction starts, and so does a smaller window set with `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or `--autocompact`.
- **A server without the `transcript.context` feature** gets no context events.

The stream fields this reads (`usage`, `modelUsage`, `parent_tool_use_id`) are not documented by Claude Code. They were checked against Claude Code 2.1.302, and a shape the worker does not know counts as no reading.

### What they hold and how long

Transcripts can hold whatever the agent saw: file contents, `gh` output, now and then an environment value. The worker seals each event, and each tool output separately, before it sends it, so the server stores only ciphertext.

The server checks hourly and deletes transcripts:

- 14 days after a task is closed,
- 28 days after the last change of an open task in Done. That covers tasks with a key, such as a script's reviews, which are never closed automatically.

A task without a key that sits untouched in Done is closed after 7 days.

## Where a task runs

A task is bound to a directory on the machine that ran it.

### A fresh run

A fresh run starts in the task's own directory. That is where it was scheduled from with `board schedule`, the directory chosen in the New task form, or where the proposing agent worked. A [fork](usage.md#forking-a-task) has its parent's directory as its own, as the parent had it when it was forked, and the first run starts there. The directory must be a listed one, as for any task.

A task without a directory of its own starts in the first of these that applies:

1. the checkout of the PR its prompt names (`repos`),
2. its lane's `cwd`,
3. `defaultCwd`.

Each of the three can also come from the `dirs` list. A directory with `repo` is that repository's checkout, one with `lane` is that lane's `cwd`, and the one with `default` is `defaultCwd`. A setting in `dirs` wins over the matching key. `board dirs add` sets `repo` for a directory that is the top level of a GitHub checkout, so the checkouts you list serve the PRs of their repository without a `repos` entry.

The directory matters beyond the files. Claude Code loads a checkout's `.claude/settings*.json` only when it starts there, and that is where a project's tokens and endpoints usually live. The task's `workdir` is set to the start directory.

### A resume

The hook records the agent's working directory on every tool call. When a run ends somewhere else, typically in a worktree the agent entered with `/worktree` (`EnterWorktree`), the worker stores that as the task's `workdir`.

A resume after an answer, a reply, a pause or a feed's update of the item starts `claude --resume` in the `workdir`, so the session continues in the worktree it left. The resume is pinned to the same machine, where that directory exists. Claude Code (2.1.323) also restores a session's worktree when it is resumed from the original directory. The `workdir` makes the board independent of that and shows the directory on the task page.

### Re-run fresh

**Re-run fresh** forgets the session and sets the `workdir` back to the directory the task was created with, which keeps the task pinned to its machine. The server keeps that directory separately and replaces it only when you change the task's directory, so a worker's rewrite cannot lose it. A task created without a directory starts where a task without a directory starts. With a `dirs` list, the original directory has to be listed too.

### The task locks its worktree

When the task's directory is a linked git worktree, the worker runs `git worktree lock --reason "agent-board task <id>"` on it as the run starts, and again for the worktree the session ended in. The hook does the same as soon as the agent enters a worktree during the run.

- A cleanup of merged branches with `git worktree remove` then refuses with that reason. It takes `-f -f` or `git worktree unlock` to remove the worktree. `git worktree prune` leaves it alone.
- The lock stays while the task is open, in any column, so a reply days later still finds its worktree.
- At the end of each run the worker unlocks the worktrees the task held that are not its `workdir` any more, such as one the agent only passed through, or the old one after Re-run fresh.
- The dispatcher unlocks the rest once the task is done, closed or deleted. A task moved back out of Done locks its worktree again at its next run.
- A worktree someone else locked is left as it is.

The machine keeps the list of worktrees a task locked in `<state dir>/worktree-locks/<task>.json`. A lock left over, for example after that file was deleted, comes off with `git worktree unlock <path>`.

### A resume whose directory is gone

The usual cause is a worktree removed while its task was still open. Claude Code resumes a session by id from any directory, so the worker continues the same session in the git checkout that held the worktree. It takes the nearest parent directory with a `.git`, for example `/repo` for `/repo/.claude/worktrees/feat-x`, and the task's `workdir` becomes that checkout. Nothing is recreated at the old path.

The agent's prompt starts with a notice:

- The old directory is gone, and whatever was not committed and pushed in it is lost.
- Before changing files, it should recreate its worktree on its branch the way the repository's CLAUDE.md says, and check that the branch still has its last commits.
- Its next comment should say which commit it continues from. When the branch is gone as well, it should ask you how to go on.

A system note on the task records the move.

The task goes to `needs-me` with the reason instead when no git checkout exists above the directory, or when that checkout is not a listed directory (`board dirs add` in it allows it). A fresh run in a gone directory still fails with the path, because only a resume has a session worth keeping.

### The list of directories

`board dirs` keeps a per-machine list of the directories workers may run in. It is the `dirs` key of the machine's `config.json` (see [Config](setup.md#config)). Without the key nothing is limited. Once the key exists, even as `{}`, a run starts only in a listed directory, and an empty list allows nothing.

An entry's settings (`repo`, `default`, `lane`) only say where tasks run. They change nothing about what is allowed.

**What counts as listed**

- A directory is allowed when it is a listed one or below one, matched by path segment. `/work/app` allows `/work/app/sub` and not `/work/app2`.
- A worktree inside a listed checkout (`.claude/worktrees/...`) counts. A worktree folder outside it needs its own entry.
- The real path decides. A symlink inside a listed directory that points elsewhere does not pass, and a listed symlink counts through its target.

**Where it is checked**

- The worker checks every start, after it checked that the directory exists. That covers a task with its own directory, a task in `defaultCwd` or its lane's `cwd`, and a resume in the stored `workdir`.
- A directory outside the list ends the task in `needs-me` with the path and the way out: `board dirs add` in it on that machine, then **Re-run fresh** or **Send & continue**.
- A running task is not stopped when the list changes.
- `board schedule` refuses with a usage error in an unlisted directory. `board add` with `--parent` inherits the parent's directory only when it is allowed. Otherwise it takes the current directory, then `AGENT_BOARD_START_DIR`, the directory the run started in, and refuses only when that is not allowed either.
- The dispatcher does not look at the list. It claims a task whose directory is not listed and the worker fails it, so the task shows in Needs me instead of sitting in Todo.
- `board attach` and command watches are not limited. They stay on the machine.
- `board doctor` fails for a `defaultCwd`, lane `cwd` or `repos` checkout that no entry covers, since tasks routed there stop. `board dirs add --from-config` lists them.

**A run that ends outside the list.** When the agent entered a worktree elsewhere or went to `/tmp`, the worker does not store that directory as the `workdir`, because the next resume would refuse it. The task keeps the directory it started in. A system note says where the agent ended and that the next resume starts in the start directory.

**The board gets a copy, as advice.** A machine with a `dirs` key sends its list to the board, sealed, so the New task form's Working directory field can offer it. The copy holds the listed directories that exist, each with its `label` when it has one. `repo`, `default` and `lane` stay on the machine.

- The machine sends it from a dispatch tick when the list changed, and from `board dirs add`, `rm`, `set` and `unset`. An unchanged list sends nothing.
- If the board cannot be reached, `add` and `rm` still succeed and warn, and the next tick sends the list.
- The copy never reaches a path, an argument or a decision on any machine. The worker reads only its own `config.json`.
- `board doctor` says whether the board has the current list.

### Lanes from the earlier release

A lane with a `skills` list still loads for one release, and the lists are ignored. If no lane has `default`, the lane whose `skills` include `*` becomes the default (the first lane, when none has it, as for any config that marks no lane). A config with both `skills` and `default` loads as well. `board doctor` and the dispatch log warn about every `skills` key and say to set `default` instead. [Upgrading](setup.md#upgrading) has the steps.

### Skills and models on the board

Each machine tells the board which skills (slash commands) and which Claude models it has, and the names of its lanes, sealed. The browser uses this catalogue to complete `/skill` in a prompt or a reply, to offer the machine's models and to fill the Lane field. The catalogue is advice. No CLI reads it back, no worker relies on it, and a machine without it works.

**How it asks.** The dispatcher starts `claude -p` with stream-json input and output and `--strict-mcp-config` in a directory, sends one `initialize` control request and no prompt, reads the answer and ends the process.

- No model is called, so it costs no tokens, and no session is written. No MCP server is started.
- It does run the `SessionStart` hooks of the user's and the directory's settings, as any start of `claude` does.
- A probe has 30 seconds, then it is killed with its process group.
- This is the request the Agent SDK uses to start a session, not a documented CLI interface (checked against Claude Code 2.1.326). An answer of any other shape counts as no answer.
- A failed probe is a `WARN` line and leaves the old catalogue in place. That directory is not tried again for an hour unless its fingerprint changed.

**Which directories.** The listed directories that exist. A machine without a `dirs` key uses the directories its config routes work to (`defaultCwd`, lane `cwd`s, `repos` checkouts). Each is asked once, at most 20.

**When.** A tick asks in at most one directory, after it has started its tasks and run its checks, so a probe never holds a start back. A tick with too little time left for a probe sends what is cached. A machine with several directories is complete after as many ticks. A directory is asked again when:

- it was never asked,
- its fingerprint changed. The fingerprint is the `mtime` of the `claude` program, of `~/.claude/plugins/installed_plugins.json`, `~/.claude/settings.json` and `~/.claude/skills`, and of the directory's `.claude/skills` and `.claude/settings.json`,
- a run in or below that directory reported other skills than the last probe saw. The worker reads them from the `system/init` event every run starts with. A run restricted to an agent reports none.

The results are files under `<state dir>/catalog/`, one per directory.

**What goes in.**

- The commands `claude` lists that have a safe skill name. Commands `claude` marks as its own, such as `/compact` and `/clear`, are left out unless a run on this machine reported them as skills. MCP prompts and anything else with a space in its name are never in.
- A skill keeps its name, a description of at most 200 characters and an argument hint of at most 100, each on one line. Its aliases and agents are not sent.
- The models are those `claude` offers except `default`, with their display name and description.
- `skills` holds the skills every probed directory has. Each directory lists those only it has, so a project's own skills show only for it.
- `lanes` holds the names of the machine's lanes in config order, at most 20 (a lane beyond that is not offered). The New task form, the task page's lane picker and the schedule editor offer the union over every machine, or the chosen machine's. The list is advice: a task may name any lane, and a machine without it uses its default lane.

**Sending.** After the probe, the dispatcher composes one document from every directory asked so far. It sends the document when it differs from the one the board holds, and nothing until one directory has an answer.

The document also says what the machine has of the agents: the version of the [board's agents](#agents-on-the-board) it applied, the hash of every agent it has, wherever defined, and the names whose local definition an apply moved aside. A change there sends the document again.

- The board takes at most 256 KiB for a sealed catalogue. A larger document is cut before it is sent: first the descriptions and hints of the skills of single directories, then those of the common skills, then the lists themselves. The log says once what was left out.
- A failed send costs the tick one log line at most.
- `--dry-run` starts no probe and prints `DRY probe claude in <dir>` and `DRY set-catalog`.
- `board doctor` says how many skills and models were sent, whether the document was cut, and whether the board's copy is current.

## What a worker may do

There is no sandbox. A worker runs `claude` as you, with your home directory, your SSH agent and your `gh` login.

The [list of directories](#the-list-of-directories) is not a sandbox either. It decides where a run may start, and so whose `.claude/settings*.json` it loads. A repository you did not list does not get to hand a run its allow rules, tokens or hooks. The agent can still `cd` anywhere, and an agent in `auto` mode can edit `config.json`, the list included.

How much a run may do depends on who made the task.

### Tasks you made

Tasks from `board schedule`, the New task form, and agent proposals once you start them run as if you ran the prompt in your terminal. They get all your settings (user, project, local) and `--permission-mode auto`, Claude Code's classifier mode that lets safe actions through and refuses risky ones. Headless, a refusal cannot become a prompt. It shows in the log and usually in the agent's report.

### Tasks that name an agent

Tasks from `board schedule --agent`, the **Agent** field of the New task form, or the github-reviews script run as that agent (see [Agents](#agents)), unattended. That fits PR text nobody chose to read, so they get less:

- `--permission-mode dontAsk`, with only the agent's `allowedTools` allowed and its `disallowedTools` denied on top,
- `--setting-sources user`, which keeps a checkout's own `.claude/settings*.json`, with its allow rules and tokens, out of the run.

The shipped `reviewer` (`board agents add example:reviewer`, also `agents.reviewer` in `apps/cli/examples/config.reviews.json`) shows the shape:

- It allows reading, `gh` and `git` reads, the pr-review plugin's scripts, CircleCI through the engineering plugin's `cci.sh` and a few Shortcut reads.
- Of the board it allows `board comment`, `ask`, `add`, `show`, `move <task> needs-me`, and `board watch` with `--ci` or `--in`. It cannot `board schedule` or start work.
- It cannot push, merge or approve.
- Its `env` hands it `CIRCLECI_TOKEN` and `SHORTCUT_API_TOKEN` from the checkout's settings, and nothing else from there.

Adapt the lists to your project before you use it. Think about what an allowed command can reach. A review that a PR's text turns against you can read whatever the allowed commands reach, and could put it into the pending draft, which you see before submitting, or onto the board.

A task of the removed built-in intake (`createdBy` is `intake`) that names no agent never runs. A worker that claims it fails it with a note that tells you to close it or create it again with `board schedule --agent <name>`.

### What every run gets

Every run has these in its environment:

| Variable                               | Value                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_BOARD_TASK`                     | The task's id.                                                                                                                                       |
| `AGENT_BOARD_RUN`                      | The board's id of this run. The agent's `board` sends it with its calls for its own task, so the board refuses them once a later run holds the task. |
| `AGENT_BOARD_START_DIR`                | The directory the run started in. A command watch takes its `env` from that directory's settings.                                                    |
| `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` | `0`, so print mode waits for background subagents instead of stopping them 10 minutes after the last turn.                                           |

The board's rules also tell the agent not to end its turn while background work runs.

While `AGENT_BOARD_TASK` is set, these commands refuse to run: `board schedule`, the changes of `board schedules`, the changes of `board dirs` and `board config`, `board task set` and `unset` (which includes `set auto-done`), and `board agents add` and `rm`. An agent proposes follow-up work with `board add` instead, and the proposal waits in Backlog until you press **Start**.

### Allow rules for `board`

A config that allows `Bash(board *)` covers `board schedule` and `board move <task> todo`. Narrow it to the rules in `apps/cli/examples/config.reviews.json`:

- allow `board comment *`, `board ask *`, `board add *`, `board show *`, `board move * needs-me`, and `board watch` with `--ci` or `--in`,
- for a task whose agent may mark it done (see [auto-done](usage.md#letting-the-agent-mark-a-task-done)), also allow `board move * done`. An agent whose rules allow only `board move * needs-me` is refused when it runs `board move <task> done`,
- deny `Bash(board schedule *)`, `Bash(board schedules *)`, `Bash(board dirs *)`, `Bash(board agents *)` and `Bash(board internal *)`.

The board checks the setting itself when a run moves its task to Done, so the allow rule alone does not let an agent finish a task that has auto-done off. `board dirs` and `board agents` refuse their changes inside a run anyway. The deny rules keep an agent from even trying.

### Command watches

A command watch (`board watch <task> --name <name> -- '<command>'`, with `--every` or `--stream`, and `board wait --check`) runs later, from the watch unit or the dispatcher, outside Claude Code. Claude Code's permission rules and the auto-mode classifier see the command only as part of the `board watch` or `board wait` call.

So do not allow `Bash(board watch *)` or `Bash(board wait *)` by rule in a run that is not an agent's, or the command skips the classifier. An agent's run may allow `board watch`: the CLI refuses a command watch there, polled or streamed, and `--ci`, `--pr-review`, `--pr-merged` and timers run no command of the agent's choosing.

### Not a security boundary

Permission rules match the text of a call. They keep an agent on its task, but they are not a security boundary. A PR or story whose text turns the agent against you reaches whatever the run allows and whatever those commands can reach.

A dedicated OS user for the workers, with its own checkouts and a narrowly scoped GitHub token, would make that a boundary. It is not set up yet.

## Agents

An agent is a named set of tools and rules on the machine. It is an entry under `agents` in the machine's `config.json`, a file `<name>.yaml` in the `agents` directory beside it (see [Sharing and importing agents](#sharing-and-importing-agents)), or a definition the board holds for every machine of yours (see [Agents on the board](#agents-on-the-board)). A task that names one runs as that agent, with only what the agent allows, whoever made the task.

You choose the agent with `board schedule --agent <name>` or the **Agent** field of the New task form (see [Choosing an agent](usage.md#choosing-an-agent)). A repeating schedule hands its agent to every occurrence.

The task holds the name as a sealed `agent` field. The board server stores and returns it but cannot read, change or drop it without making the task unreadable (see [Encryption](encryption.md#encryption)). The task holds the name only, never a definition or its version: a task, and every occurrence of a schedule, runs as the definition the machine has when the run starts.

```json
"agents": {
  "reviewer": {
    "description": "Reviews a PR and stages the findings.",
    "prompt": "You review pull requests.",
    "tools": ["Read", "Grep", "Bash"],
    "allowedTools": ["Bash(gh pr view *)", "Bash(board comment *)"],
    "disallowedTools": ["Bash(git push *)"],
    "mcpServers": ["shortcut"],
    "env": ["SHORTCUT_API_TOKEN"],
    "model": "opus"
  }
}
```

### The definition

The name is lowercase letters, digits and dashes, at most 32 characters.

| Key                 | Required | Meaning                                                                                                                      |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `description`       | yes      | What the agent is for.                                                                                                       |
| `tools`             | yes      | Tool names only: `Read`, `Bash`, `mcp__shortcut__get_story`. A pattern such as `Bash(git status)` belongs in `allowedTools`. |
| `prompt`            | no       | The agent's system prompt.                                                                                                   |
| `allowedTools`      | no       | The allow rules. In `dontAsk` mode, whatever they do not allow is refused.                                                   |
| `disallowedTools`   | no       | Deny rules on top.                                                                                                           |
| `mcpServers`        | no       | Names of servers the worker copies from the working directory's `.mcp.json`.                                                 |
| `env`               | no       | Names of variables the worker copies from the working directory's `.claude/settings*.json`.                                  |
| `model`             | no       | The model the agent runs on.                                                                                                 |
| `version`, `source` | no       | They describe the definition, such as where `board agents add` got it, and change nothing about a run.                       |

The worker copies `env` and `mcpServers` only after the directory has passed the [list of directories](#the-list-of-directories).

**Agents are read strictly.** Elsewhere in `config.json` an unknown key is ignored with a warning. Inside an agent, an unknown key or a wrong type makes that agent unusable, because a misspelt `disallowedTool` must not leave the agent without a deny list. Only that agent is lost. The machine's other work goes on, a task that names the agent fails closed, the dispatcher logs a warning on every tick and `board doctor` fails.

### Limits of the agent field

- A proposal made from an agent's run carries no agent. Once you start it, it runs in `auto` like any task of yours.
- `board attach` resumes an agent's task with your own settings.
- The commands that are refused inside a run rely on `AGENT_BOARD_TASK`. Only the agent's own lists stop a command from unsetting it.
- The name is the only link to the definition. Machines that each define an agent of the same name in `config.json` or `agents/` must define it the same way. An agent pushed to the board is the same on every machine that applied it; `board agents` shows a hash of each definition, so you can compare.

### Sharing and importing agents

An agent can live in a file of its own, `~/.config/agent-board/agents/<name>.yaml` (or `.yml` or `.json`). The directory is beside `config.json`, so `AGENT_BOARD_CONFIG_DIR` moves it too. The file holds the same keys as a `config.json` entry, plus an optional `name`, which must match the file name. YAML is read as YAML 1.2, with aliases and duplicate keys refused.

Everything that reads the config reads the directory as well, with the same strictness. Each of these makes the agent unusable:

- a file with an unknown key,
- a `name` that is not its file's,
- two files for one name,
- a file that is group or world writable,
- a name that both `config.json` and a file define, so the definition a task gets never depends on load order.

Other files, such as a README or a hidden temp file, are ignored.

`board agents` manages both places (see [the CLI reference](cli.md)):

```sh
board agents                                   # each agent: tools, allow and deny counts, where it is defined, source, usable here or why not
board agents show reviewer                     # one agent as YAML (--json for JSON)
board agents export reviewer > reviewer.yaml   # the same without this machine's source, to share
board agents add example:reviewer              # the reviewer that ships with the CLI
board agents add ./reviewer.yaml --name strict # a file; - reads stdin
board agents add https://example.com/reviewer.yaml#sha256=<hex>
board agents rm reviewer                       # the file, or the config.json entry
```

**`add` shows what it grants.** An agent definition is a permission grant. It decides what a run may do on this machine, whoever made the task. So `add` prints the whole definition as it will be written, and then every tool, allow rule and deny rule, the `env` names it copies and the MCP servers. It flags:

- broad allow rules: a bare `Bash`, `Edit`, `Write`, `Read` or `WebFetch`, `Bash(*)`, a `Bash` rule that starts with `*`, one that runs a shell, an interpreter, `curl`, `ssh` or `sudo`, `Bash(board *)`, a rule for a whole tree such as `Read(~/**)`, and every tool of an MCP server,
- `env` names that look like secrets, such as `TOKEN`, `SECRET`, `PASSWORD` or `KEY`,
- an empty deny list,
- allow rules for tools that `tools` leaves out,
- plugin placeholders such as `{pr-review}` that do not resolve here. A run as the agent fails until they do.

It writes `agents/<name>.yaml` (mode 600, the directory mode 700) only after you confirm at a terminal, or with `--yes`. A definition read from stdin needs `--yes`, since there is no terminal left to ask on. `--dry-run` prints all of it and writes nothing.

**The details.**

- The name is `--name`, else the document's `name`, else the file name.
- An agent that exists needs `--replace`. One defined in `config.json` is never replaced by a file. Remove it with `board agents rm` first, or add the file under another name.
- The `source` written into the file is where `add` read it: the path, the URL, `example:<name>` or `stdin`. A `source` in the document itself is ignored.
- A URL must be `https://`, without a user name or password. The fetch gives up after 15 seconds and at 256 KB. It follows at most 3 redirects, each only to https on the same host.
- A `#sha256=<hex>` fragment pins the file's SHA-256, and `add` refuses a file whose hash differs.
- Nothing fetches the URL again. Run `add --replace` with it to take a newer version.
- `example:<name>` reads `apps/cli/examples/agents/<name>.yaml`, built into the CLI. `board example agents/reviewer.yaml` prints it.
- `rm` removes the file, or the entry from `config.json`, keeping every other key and the file's mode. A task that names the agent then does not run on this machine any more.
- `add` refuses a name the board holds; push the new definition instead, or add it under another name.
- `add`, `push` and `rm` are refused inside a board run.

An agent added with `add` stays on its machine. To give every machine the same agent, push it to the board.

### Agents on the board

The board can hold agent definitions for every machine of yours. Any of your CLIs puts one there, and every machine applies it and its later versions itself, on its next dispatch tick.

```sh
board agents push reviewer        # put this machine's reviewer on the board: shows every grant, asks, then pushes
board agents push ./reviewer.yaml # the same from a file (also -, an https URL or example:<name>, read as add reads them)
board agents                      # each agent with where it came from: config.json, agents/<file> or board v<n>, and its hash
board agents rm --board reviewer  # take it off the board; every machine drops its copy on its next tick
```

**`push` shows what it grants.** It reads the definition as `add` does, through the same strict parser, and prints the same definition and grant summary, with the same flags. It pushes only after you confirm at a terminal, or with `--yes`. `--dry-run` prints all of it and pushes nothing. `push` is refused inside a board run, like `add` and `rm`.

There is no `push --all`: you move agents to the board one at a time. To change a board agent, `board agents export <name> > <name>.yaml`, edit the file and push the file.

**How it is held.** All your agents on the board are one sealed document with a version that goes up with every push. The board cannot read it, and it cannot hand an old document out as a newer one (see [Encryption](encryption.md#the-agents-on-the-board)). A push fetches the document, changes its one entry and sends it back as the next version. The server takes it only while its version is still the one the push started from. If another push came first, `push` fetches again and retries once; when that other push changed the same agent, it shows what the board holds now and asks again. `rm --board` works the same way.

**How a machine applies it.**

1. The `version` answer every tick starts with names the board's version. A tick where it is not newer than the one applied here costs nothing more.
2. When it is newer, the tick fetches the document, opens it under that version and reads every entry with the strict parser of an agent file.
3. It writes each agent to `~/.config/agent-board/agents.board/<name>.yaml` (mode 600, the directory mode 700), deletes the files of agents the document no longer has, and records the version and each agent's hash in `agents.board/state.json`. The dispatcher logs `APPLIED agents v<n>`.
4. The apply runs before the tick decides what to start, so a task that names a newly pushed agent can start in the same tick.

Everything that reads agents reads `agents.board/` alongside `config.json` and `agents/`. `board agents` shows a board agent as `board v<n>` and its `source` as `board`. Do not edit the files: the next apply writes them again.

**The board wins a name.** When the board holds a name that `config.json` or `agents/` also defines, the apply moves the machine's own definition aside in the same step, also when the two are the same:

- an `agents/<name>.yaml` file moves to `~/.config/agent-board/agents.replaced/<name>.<time>.yaml` (mode 600, the directory mode 700), which nothing reads;
- a `config.json` entry is written there too and removed from `config.json` as `board agents rm` removes it, keeping every other key and the file's mode.

The dispatcher logs `REPLACED <name>: local definition moved to <path>`. `board agents` shows the agent as `board v<n>, replaced a local definition` until you delete the moved file, and `board doctor` lists the moved files. A file you drop into `agents/` under a board name later is moved aside on the next tick. To get a moved definition back, add it under another name: `board agents add ~/.config/agent-board/agents.replaced/<file> --name <other>`. Under its old name the next tick would move it aside again.

After a push, the agent is the board's on the pushing machine too: `push` takes the machine's own file or `config.json` entry away, since the board copy holds the same definition.

**What fails, and how.**

- An entry that does not parse (a newer CLI may have pushed a key this one does not know) makes that one agent unusable on this machine and leaves the others. Its local definition is moved aside all the same.
- A local definition the apply cannot move (a read-only `config.json`, say) makes that agent unusable here until you move it yourself, so the definition a task gets never depends on load order. `board doctor` says why.
- A document that does not open under the version the board names, or one older than the version applied here, changes nothing: the machine keeps what it has, the dispatcher logs a warning and `board doctor` reports it.
- A board that holds no document, or deletes it, takes nothing away: the machines keep their copies. To take an agent off every machine, push a document without it (`rm --board`).
- A CLI from before shared agents ignores them and runs only its local agents. A task that names a board agent waits in Todo for a machine that has it, as for any name a machine lacks.

**Drift.** Each agent's hash is the SHA-256 of the keys that decide what a run may do (`description`, `prompt`, `model`, `tools`, `allowedTools`, `disallowedTools`, `env`, `mcpServers`) as canonical JSON. `version` and `source` are left out. `board agents` shows the first 12 hex digits, and `--json` all of them. `board doctor` warns, and does not fail, when this machine applied an older version than the board holds, when the last look at the board changed nothing, and when local definitions were moved aside. Each machine's [catalogue](#skills-and-models-on-the-board) carries the version it applied, the hash of every agent it has and the names whose local definition it replaced.

**In the browser.** **Settings › Agents** (`/settings/agents`) shows the board's definitions and changes nothing: it has no edit and no push, and changes go through `board agents push` and `rm --board`. The browser opens the document with your key and shows:

- the version and when it was pushed;
- each definition: its description, `version` and `source`, model, every list (`tools`, `allowedTools`, `disallowedTools`, `env`, `mcpServers`), the prompt, the hash's first 12 hex digits, and the definition as pushed;
- the flags `push` prints, in the same words: broad allow rules, an empty deny list, env variables that look like secrets, and allow rules for tools that `tools` leaves out. A key of the wrong shape, which every machine refuses, shows in red;
- per machine, from its catalogue: the version it applied (marked `behind` when older than the board's) and the agents whose local definition it replaced;
- per agent and machine: `runs this definition` when the machine reports the same hash as the browser computes, `runs another definition` with the machine's hash, `does not have it`, or, for a CLI from before shared agents, that the machine does not report its agents.

A document that does not open under the version the board names shows as unreadable, as it is to the machines. A revoked machine has no catalogue and is not listed. The page refreshes every few seconds; a machine's catalogue changes when it sends a new one.

**The limit.** Before, an agent's definition changed on a machine only when you read and confirmed it there. Now a push from any one machine reaches all of them within a tick, without a reading on each. A push needs the data key, and `board agents push` is refused inside a run, but the data key sits in `~/.config/agent-board/env` on every worker machine. A run in `auto` mode that reads it can seal and push a definition with broader grants, and every machine applies it. Such a run could always rewrite the agent files of its own machine; the new reach is every other machine. This is accepted, without a signing key or a per-machine switch (see [Design decisions](architecture.md#design-decisions)).

### An agent's run

The run is

```text
claude -p --tools=<tools> --agents=<file> --agent=<name> --permission-mode dontAsk --setting-sources user --allowedTools … --disallowedTools …
```

in the working directory the task would run in anyway.

- `<file>` is a private copy (mode 600) of the agent's `description`, `prompt`, `tools` and `model`. The worker writes it to `$XDG_RUNTIME_DIR/agent-board/<task>.agents` and removes it when the run ends. Claude Code runs the main thread as that agent.
- `--tools` holds the agent's `tools` without the MCP ones, so the built-in tools are withheld even if Claude Code fails to load the agent.
- `tools` limits the tool names only. With `Bash` in `tools` and no `dontAsk`, the agent could run any command. The command-level rules take effect because `--permission-mode dontAsk` refuses whatever `allowedTools` does not allow.
- `--setting-sources user` keeps a checkout's own settings out.
- The lists expand `~/` and plugin placeholders as [described below](#rule-expansion).

A tool the agent needs and does not allow shows up as a failed run, and the log says what was denied. Add it to the agent's `allowedTools`.

**Board rules.** An agent's run gets reduced board rules: watches only with `--ci`, `--pr-review`, `--pr-merged` and timers, and no opening PRs. It has `AGENT_BOARD_RESTRICTED=1` in its environment, which the agent's `env` cannot override. A command watch (`board watch -- '<command>'`, `board wait --check`) refuses while it is set, because it would run any command outside the agent's list. Inside any run, `board watch`, `board watches` and `board unwatch` act only on the run's own task.

**Subagents.** An agent with `Agent` in its `tools` can start subagents, and they stay inside the run's limits (checked against Claude Code 2.1.325). A subagent gets only the tools in `--tools`, inherits `dontAsk` mode and both lists, and a subagent's own `permissionMode: bypassPermissions` does not take effect. Two things to know:

- The Agent tool's list of subagent types still shows each type's own tools, so an agent may say it can reach tools it cannot.
- A subagent or skill that runs a shell command on load (a `` !`…` `` line) needs that command in `allowedTools`, or it fails to start.

### It fails closed

- A task whose `agent` cannot be opened never runs unrestricted. That is a name the server dropped or replaced, or one sealed for another task. The dispatcher skips it and the worker refuses it, like any task with an unreadable prompt.
- A machine that does not define the agent leaves the task in Todo for another machine. The dispatcher logs `SKIP <id> no agent <name> defined here`.
- If the task is pinned to this machine, by a resume or its own directory, the machine claims it. The worker then fails it with a system note and starts nothing.
- A plugin placeholder that does not resolve fails the run the same way.
- `board doctor` checks each agent: that its plugins resolve, and that no allow rule is for a tool its `tools` leave out.

## How a task runs

A fresh run is

```text
claude -p --session-id=<new uuid> --input-format stream-json --append-system-prompt "<the board's rules>" --settings '<hook>' <permissions>
```

in the task's directory (see [Where a task runs](#where-a-task-runs)).

- The prompt is the task's `input`, as written. It goes to `claude` on stdin, never as an argument.
- The hook is the [heartbeat hook](#liveness-and-limits).
- `--input-format stream-json` keeps stdin open for [messages, pauses and interrupts](#talking-to-a-running-agent).
- A task that names a model adds `--model=<model>` as one argument, on a fresh run and on a resume. Without one, `claude` uses its own default. A name that does not have the shape of a model name refuses the run.
- A task that names an effort level adds `--effort=<level>` as one argument in the same way. A value that is not one of `low`, `medium`, `high`, `xhigh` or `max` refuses the run.

A resumed run is `claude -p --resume=<session>` with the same flags and your reply on stdin (see [Ask and resume](usage.md#ask-and-resume)).

The first run of a [fork](usage.md#forking-a-task) is

```text
claude -p --resume=<parent's session> --fork-session --session-id=<new uuid> <the same flags>
```

Claude Code copies the parent's session into a new one with the given id and leaves the parent's as it is. It works from any directory. The worker takes the parent from the board (`forkOf`) and blocks the run unless the parent has a session that this machine started for it. The cases are a parent that is gone, has none or ran elsewhere, and the reason goes to the task, which waits in Needs me. The new id is recorded as the fork's own session, as for a fresh run, so the next run is a plain resume.

- The prompt on stdin is a notice, then `Your task:` and the instructions. The notice says that the conversation was forked from the parent (its id and title), that the agent now runs as the fork's task id and must use it for every `board` command, and that the directory and its branch belong to the parent, so it must not commit, switch branches or change files there and makes its own worktree instead. The parent's title is shown on one line and cut.
- A start-over of a fork forks again: Re-run fresh does it, and so does a run that wants to resume with nothing to say to the session.

### The board's rules

The appended rules tell the agent:

- its task id,
- to report with `board comment`,
- to ask with `board ask` instead of AskUserQuestion,
- to finish with `board move <task> needs-me`, or, when the task has [auto-done](usage.md#letting-the-agent-mark-a-task-done) on, with `board move <task> done` once it has checked that every acceptance criterion is met and nothing is left for you; in every other case, and when in doubt, it still moves the task to Needs me,
- to wait for CI and the like with a watch (`board watch`),
- how to propose follow-ups.

Outside an agent's run they also set how far the agent goes alone:

- **What it does without asking.** Steps that are easy to undo and stay on the machine: editing files, tests, local branches, worktrees and commits.
- **What it asks before.** Steps that are hard to undo or that other people see, unless the prompt asked for them: force-pushing, deleting branches or data, merging, deploying, posting to Slack, Shortcut, email or someone else's PR.
- **Code changes end in a PR.** A prompt to implement, fix or change code counts as the request to commit and push. The agent works on a new branch, in a new worktree if the checkout holds changes that are not its own. It pushes, opens a PR with `gh pr create`, and starts CI when the repository's CLAUDE.md or skills say CI has to be started or approved by hand. It waits for CI with `board watch <task> --ci` and links the PR in its final comment.
- **PRs are reported.** Right after opening a PR the agent runs `board pr <task> <url>`, and it reports every PR it opens or works on for the task that way. The board then shows them on the task's card and page (see [Ask and resume](usage.md#ask-and-resume)).
- A task that asks only for a plan, an investigation or a review opens no PR.

The rules are passed to every run, a resume included, so each run's rules state the auto-done setting as it is when the run starts. When you switch it off while a run goes on, the board refuses that run's move to Done.

The rules only ask. `--permission-mode auto` can still refuse a push or `gh pr create`, and the refusal shows in the log.

### Rule expansion

In an agent's rules, `Bash(` rules expand two things when the worker starts:

- `~/` becomes your home directory.
- `{<plugin>}`, such as `{pr-review}` or `{engineering}`, becomes the root Claude Code gives the one installed `<plugin>@*` as `${CLAUDE_PLUGIN_ROOT}`. `{<plugin>@<marketplace>}` names the marketplace.

A plugin that is not installed, or is installed from several marketplaces, is an error, and the task goes to `needs-me` with the reason.

The root depends on how the marketplace was added. For a marketplace added as a directory (`~/.claude/plugins/known_marketplaces.json`), it is the plugin's `source` in the marketplace's `.claude-plugin/marketplace.json`, because Claude Code loads the plugin from the checkout and not from the cache copy. Otherwise it is the `installPath` in `~/.claude/plugins/installed_plugins.json`.

A rule must not start with `*` before a script path. A leading `*` matches any command that merely contains the path.

`Read(...)` rules are passed on unchanged. They take `~/` themselves.

### Title rules

When a run starts, the worker applies the [title rules](usage.md#title-rules) the board holds to a task that still has its default title: the first line of its prompt, cut at 100 characters. It never touches a task whose title was typed or renamed, and it skips the cards of a repeating schedule, whose title is the schedule's. It runs on every start, a resume included, and a title it stored once stops later attempts.

- **Order.** The worker reads the board's rules and takes the first whose pattern matches the whole prompt. It sets the rule's icon at once, only if the task has none. It then asks Haiku for a title beside the run and stores the answer when it is still the default title that is there. The run does not wait for either, and the worker process ends only after Haiku's call has.
- **The call.** The worker runs Claude Code in the run's directory, so `gh pr view 8` finds the repository there:

  ```text
  claude -p --model haiku --output-format json --json-schema '{"type":"object","properties":{"title":{"type":"string","maxLength":100}},"required":["title"]}' --tools=Bash --allowedTools 'Bash(gh pr view:*)' 'Bash(gh issue view:*)' --permission-mode dontAsk --setting-sources user --strict-mcp-config
  ```

  The rule's instruction and the prompt go to `claude` on stdin, each in a fence, and never in an argument. The environment passes on without any `AGENT_BOARD_*` variable. The call has two minutes.

- **What it may run.** Only `gh pr view` and `gh issue view`. `--setting-sources user` still loads your own `~/.claude/settings.json`, so an allow rule of yours there applies to this call too. That is the limit [Not a security boundary](#not-a-security-boundary) states.
- **The shape check.** The answer is untrusted, because a PR's text can steer the model. The worker stores it only as a title, and only when it has one line, no control character, 1 to 100 characters and is not the default title. A title that passes can still be misleading.
- **The log.** The task's log gets `title rule <n> matches`, then `icon set` or `icon kept: the task has one`, then `title set` or `title kept: it changed meanwhile`. Other lines are `title not written: <reason>` (the check or the call failed), `the board has no title rules` and `the title rules cannot be decrypted with this machine's data key`. No match writes nothing.

A failure changes neither the title nor the run. The next start tries again.

## How it decides

### The dispatcher, per tick

1. **Sweep.** For each task in `running` claimed by this machine, the tick asks whether its worker is running. On Linux that is `systemctl --user is-active agent-board-<task>`. On macOS it checks that the pid in the run directory's `<task>.pid` is alive and its command line ends in `internal worker <task>`. A task whose worker is gone moves to `needs-me` with the log tail. So does one whose worker failed to enforce the [limits](#liveness-and-limits) for five minutes past them, and its unit is stopped. If `systemctl` gives no known state, or the backend fails, the tick stops before starting anything and exits non-zero.
2. **Wake.** For each task in `waiting` that this machine ran, a wait whose `wakeAt` has passed is woken with the reason, so it can start in this tick. A waiting task with a watch event and no live run is woken too. The tick drops the watches of tasks that are Done, closed, in Backlog or gone.
3. **Plan and start.** The tick skips a task this machine cannot serve (see [Two machines](#two-machines)), a proposal you have not started, a task it cannot decrypt, a delayed task that is not due, and a task the board marks `held` because its schedule's [limit](usage.md#limiting-a-schedule) is used up (the board refuses its claim too). While a [usage limit](#usage-limits) is reached, it also leaves out tasks below the limit's priority. It plans the rest into [lanes](#lanes), own work first (the lane a task names, else the default one), then borrowing. It claims each start, writes its lane to the run directory and starts the worker. On Linux that is `systemd-run --user --collect --unit agent-board-<task>`. On macOS it is a detached `board internal worker <task>` process with its output in the task log. A start note names the machine, lane and PID. A lost claim hands its slot to the next task. The first failed start ends the tick's starting.
4. **Pause.** Lanes whose own work still waits ask one borrowed run each to pause.
5. **Poll.** When the watch unit is not running, the tick polls the due watches (see [Without the watch unit](#without-the-watch-unit)). It also runs the checks that an older `board wait --check` stored in `<state dir>/waits/`, side by side, 45 seconds each at most. A check that exits 0 wakes its task with the end of its output.
6. **Next.** The tick works out when this machine next has something to do that no event announces (see [The next tick](#the-next-tick)).
7. **PR state.** Last, at most every 10 minutes and only where `gh` is installed, the tick refreshes the [PR state](#pr-state) of the open tasks. It never fails the tick. A problem is one `WARN PR states not refreshed` line.

The dispatcher makes no tasks from GitHub. The github-reviews script does (see [Scripts](usage.md#scripts)).

### The next tick

The tick writes the time to `dispatch.next` in the run directory, next to `dispatch.tick`, and logs it as `next=<time>` on its `TICK` line. It is the earliest of:

- the start time of a delayed Todo task this machine could serve,
- the `wakeAt` of a wait here,
- the next attempt of each stored check here,
- the moment a borrowed run reaches `pauseAfterMinutes` in a full lane whose own work waits,
- the earliest reset of the windows that held a task back for [usage](#usage-limits).

With nothing due, the tick removes the file. The start of every tick removes it too, so a tick that stops early leaves no stale time behind.

The listener reads `dispatch.next` after each of its ticks and arms a one-shot timer for it. A delayed task, the end of a wait, a check or a take-back then starts its tick on time instead of up to 2 minutes late.

- Each tick cancels the timer and arms it again.
- When the timer fires, the listener reads the file again, because a tick the timer unit started rewrites it too. A later time arms the timer again. Anything else starts a tick.
- The timer waits at least 5 seconds, so a time that stays in the past cannot start tick after tick. It waits at most an hour, then reads the file again.
- A change on the board that moves one of these times sends the `tasks` event, and the tick that follows arms the timer again.

The 2-minute timer unit stays as the fallback for a listener that is down.

### The worker, per task

Before anything starts, a directory that does not exist, or that a `dirs` list does not allow, ends the task in `needs-me` with the reason (see [Where a task runs](#where-a-task-runs)).

**Resume.** A task resumes its session when it has `next: resume`, a session, and a user reply, a pause or a wake since the agent last spoke. The prompt is the reply, with "you were paused" or "your wait is over: <why>" where that applies. When the reply answers none of the agent's last questions because you dismissed them, the lead line says so: "The user dismissed your questions on board task <id> without answering them, and replied:". The worker resumes only a session this machine started for the task. For any other session it refuses the run with the reason.

**Fresh.** Anything else starts a new session. The worker records the id on this machine and stores it on the task once the run is about to start. It clears the id again if the process cannot be spawned. The prompt is the task's prompt. When the thread already holds notes by you or the agent, the prompt is followed by what you wrote since the previous run started and a line that tells the agent to read the thread with `board show <task>`.

Either way `next` goes back to `fresh`. The worker also refuses a run that would hand the agent a note of yours that cannot be decrypted.

### PR state

The dispatcher refreshes the PR state shown on the board. It covers every task that is not closed or done and has PRs: the one its prompt names and every one its agent reported.

- It asks GitHub with one `gh api graphql` query for up to 50 PRs.
- It writes a task once, with only the PRs whose state differs from the stored one. The log shows `PRSTATE <task> <state> …` per task and `PRSTATES changed=<n>`.
- A PR that GitHub gives no answer for, because it was deleted or you have no access, is logged as `WARN no state for <url>` and keeps its state.
- A failed query, or one that takes longer than 30 seconds, is logged as `WARN PR states not refreshed` and does not fail the tick.

The lookup runs at most once per 10 minutes per machine. The machine keeps the time of the last one in `pr-refresh.json` in the state directory and writes it before the query, so a failing `gh` is not tried again on every tick. A tick does nothing, and logs nothing, when `gh` is not on `PATH` or no open task has a PR. `--dry-run` runs the queries, prints the writes, and does not write the time.

The board uses the state to show a merged or closed PR on the card and to offer **Move merged to Done** (see [Ask and resume](usage.md#ask-and-resume)).
