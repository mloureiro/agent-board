# Encryption

Board content is end-to-end encrypted. The server stores and returns ciphertext it cannot read. The clients (the CLI and the browser) seal what they send and open what they receive, with a data key that belongs to the user.

## What the server sees

The operator of the server and database sees:

- ids, statuses, priorities and positions
- the model, the effort level and the lane a task names
- machine and lane names, session ids and usernames
- timestamps, activity timing and schedule rules
- the state of each of a task's pull requests (open, merged or closed), without which PR it is
- field lengths
- for a task's watches: that its machine published a list, the size of its ciphertext, and which watch ids you asked to stop
- which sealed values are equal, through blind indexes of a script's key (a PR URL, say) and of the PR head. The same key or head gives the same value, but neither can be searched for.
- for each machine's directory list, catalogue and usage status: that the machine sent one, the size of its ciphertext, when it last changed, and whether a new one differs from the old (a blind index)

The operator does not see what a task, a note or a transcript says.

The board does not store a PR's head sha. Only a script that schedules with `--version` compares heads, so the board keeps `abh1.` plus an HMAC of the sha, and the value cannot be used to find the PR.

## The goal

The goal is stronger than secrecy. **A worker, and the browser, only acts on, or shows as trusted, text that the user's own clients sealed for exactly that purpose.**

The operator can read, swap, replay and forge anything in the database and in API replies, but holds no key. Every sealed value is an AES-256-GCM envelope whose additional data names the user, the field and a context. That binds the value to the row and the role it was sealed for. The user is the board's user name, which the sign-in gives (a passkey, the identity provider's claim, or `NO_LOGIN_USER`), so a user who signs in under a different name opens nothing of the old board.

`packages/shared/src/sealing.mts` is the one definition of these rules. The CLI and the browser both use it.

## Sealing contexts

| Field                        | Context                                                                                      | Written by                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`                      | `<origin>`                                                                                   | the client that makes the task or schedule                                                                                                      |
| `input`                      | `<origin>:<creator>`, then for a fork `:fork:<parentId>`, then with an agent `:agent:<name>` | the same client, which states the creator, the fork parent and the agent itself                                                                 |
| `agent`                      | `<origin>`                                                                                   | the same client. The value is the agent's name.                                                                                                 |
| `icon`                       | `<origin>`                                                                                   | the user's browser or CLI. The value is one emoji, shown on the card and never acted on.                                                        |
| `labels`                     | `<origin>`                                                                                   | the user's browser or CLI. The value is a JSON list of labels, shown on the card and never acted on.                                            |
| `workdir`                    | `<origin>`, for an occurrence also `task:<id>:schedule:<scheduleId>`                         | the same client, and the worker when it rewrites an occurrence's directory                                                                      |
| `workdir` (home)             | none of its own                                                                              | the server copies the `workdir` envelope, see [A task keeps the directory it was created with](#a-task-keeps-the-directory-it-was-created-with) |
| `pr`                         | `task:<id>:agent`                                                                            | the agent's CLI (`board pr`), once for each PR                                                                                                  |
| `watches`                    | `task:<id>:agent`                                                                            | the machine's CLI (`board watch`, the watch unit, dispatch), one document for all the task's watches                                            |
| `machine.dirs`               | `machine:<name>`                                                                             | the machine's CLI (`board dirs`, dispatch)                                                                                                      |
| `machine.catalog`            | `machine:<name>`                                                                             | the machine's CLI (dispatch)                                                                                                                    |
| `machine.usage`              | `machine:<name>`                                                                             | the machine's CLI (dispatch)                                                                                                                    |
| `machine.sources`            | `machine:<name>`                                                                             | the machine's CLI (dispatch, the watch unit)                                                                                                    |
| `agents.shared`              | `agents:v<version>`                                                                          | the user's CLI (`board agents push`, `board agents rm --board`), outside a board run, one document for all the agents on the board              |
| `links`                      | `links:v<version>`                                                                           | the user's browser (Settings › Links), one document for all the link rules                                                                      |
| `titles`                     | `titles:v<version>`                                                                          | the user's browser (Settings › Titles), one document for all the title rules; read by the browser and every machine's CLI                       |
| `note.body`, `note.preview`  | `note:<taskId>:<author>:<kind>`                                                              | the client of that author                                                                                                                       |
| `note.suggestion`            | `note:<taskId>:agent:comment`                                                                | the agent's CLI                                                                                                                                 |
| `note.questions`             | `note:<taskId>:agent:question`                                                               | the agent's CLI                                                                                                                                 |
| `note.body` of a polish note | `note:<taskId>:agent:polish`                                                                 | the agent's CLI (`board polish`)                                                                                                                |
| `note.answers`               | `note:<taskId>:user:answer`                                                                  | the user's browser                                                                                                                              |
| `tr.data`, `tr.output`       | `<taskId>:<runId>:<seq>`                                                                     | the worker                                                                                                                                      |

- The sealed `tr.data` of a `context` event is `{"seq","at","parent","kind":"context","used","window","threshold","model"}`: the tokens in the main agent's context, the model's window in tokens or `null`, the auto-compact threshold as a percentage of the window or `null`, and the model id. The server sees only the kind.
- `<origin>` is `task:<id>` for a task. It is `schedule:<id>` for a schedule and for a task that is an occurrence of one. The server copies the schedule's ciphertext into each occurrence, so the occurrence opens against its schedule's id.
- `<creator>` is `user`, `agent` or `intake`. `intake` exists only on tasks of the removed built-in intake. An occurrence's creator is `user`.
- An `icon` that does not open, or opens as anything but one emoji, shows as no icon. It is not listed in a task's `unreadable` fields and never stops a task from running.
- `labels` that do not open, or open as anything but a JSON list of valid labels (`isLabel`, at most 16, no repeats), show as no labels. They are not listed in a task's `unreadable` fields and never stop a task from running.
- `<parentId>` is the task a fork was made from (`fork_of`). Only a task of the user's has one; a schedule and its occurrences never do.
- In `pr`, `watches` and in a polish note, `<id>` and `<taskId>` are the task the agent runs. The sealed text of a polish note is `{"target", "title", "prompt"}`, where `target` is the task it polishes.
- The four machine documents are one JSON document each:
  - `machine.dirs` is `{"dirs":[{"path":…,"label":…}]}`, with `label` only when the directory has one.
  - `machine.catalog` is `{"claude":…,"models":[…],"skills":[…],"dirs":{…},"lanes":[…]}`, with `lanes` only when the machine has some: the names of its lanes.
  - `machine.usage` is `{"limits":…,"windows":{…},"reached":[…],"held":[…],"open":[…]}`.
  - `machine.sources` is `{"sources":[{"id":…,"name":…,"everyMs":…,"paused":…,"runNow":…,"problem":…,"last":{…}}]}`, with `problem` and `last` only when there is one. The commands are not in it.
- `agents.shared` is `{"version":…,"agents":{"<name>":{…}}}`, see [The agents on the board](#the-agents-on-the-board). Its `<version>` is the clear version the server keeps beside it, and the document says the same version inside.
- `links` is `{"version":…,"rules":[{"pattern":…,"url":…,"flags":…}]}`, with `flags` (`i`) only on a case-insensitive rule, see [The link rules](#the-link-rules). Its `<version>` works as that of `agents.shared`.
- `titles` is `{"version":…,"rules":[{"pattern":…,"flags":…,"icon":…,"instruction":…}]}`, with `flags` (`i`), `icon` and `instruction` only where the rule sets them, see [The title rules](#the-title-rules). Its `<version>` works as that of `agents.shared`.

Clients choose the ids of the tasks and schedules they make, because the fields are sealed against them. An id is 12 random characters, and a collision is a 409 whoever holds the id.

A value that does not open under exactly its binding is **unreadable**. Nothing falls back to a looser reading.

## What the bindings stop

### Replay across rows

A prompt, title or directory sealed for one task or schedule does not open on another. A prompt of one row with the directory of another is unreadable. So the server cannot run a replaced prompt, another task's prompt, or prompt A in directory B.

### Occurrences

Naming a schedule on a task opens only what the user sealed for that schedule: its own prompt in its own directory. The worker may later rewrite the directory for that occurrence. It seals the new one with the schedule's id too, so a task cannot lend its directory to a schedule's prompt.

`task.schedule_id` is a plain reference, not a foreign key. It stays when the schedule is deleted, so old occurrences keep opening. A task that loses it, or gets another, is unreadable.

### Permission mode

`createdBy` is a clear value, and it decides how a task without an agent runs:

- A task of the user's runs in `--permission-mode auto`.
- An agent's proposal does not run.
- A task of the removed intake does not run without an agent.

So the creator is part of the `input` context. A prompt sealed as intake's does not open on a task the server relabelled as the user's, which would otherwise run in `auto`. The reverse fails the same way.

A writer states the creator itself (`patch.seal.createdBy` for a requeue) and never takes it from the board.

### Starting a proposal and applying a polish

An agent never writes a prompt that a worker runs. Both ways an agent's text becomes a prompt go through the user's browser.

**Starting a proposal.** `board add` seals the proposal's prompt for the creator `agent`. Nothing runs a task whose creator is still `agent`: the dispatcher skips it and the worker refuses it, whatever status the board shows. When the user presses Start, or drags the card into Todo, the browser shows the prompt and seals it again for the creator `user`. The board stores that prompt and sets `createdBy` to `user`.

- The title and the directory stay as they were. Their bindings (`<origin>`) name no creator.
- A proposal's parent is a link for the breadcrumb and the follow-up list. It is in no binding, and starting does not touch it. The board can attach a proposal to any parent without changing what runs.
- A board that skips the re-seal gains nothing. It can serve a proposal as Todo, but the prompt opens only as an agent's. A prompt it relabels as the user's, with the sealed value it already holds, opens as nobody's.

The server keeps the same order for an honest board:

- Whatever status an agent names, its `add-task` lands in `backlog`.
- The machine API cannot move a proposal. `claim-task` loses on one, and `ask` refuses one, because answering a question would start it.
- A move into Todo without the prompt sealed again is a 400.
- Send & continue, Re-run fresh and Reopen leave a proposal a proposal.
- No CLI command starts a proposal. `board move <task> todo` is refused for it.

**Applying a polish.** `board polish` posts a `polish` note on the agent's own task and changes no task. When the user presses Apply, the browser seals three values:

- the new title, for `task:<id>`
- the new prompt, for `task:<id>:user`
- a `user` event note on the target task that holds the old title and prompt. It is an `event`, so the worker never hands it to a later run as something the user wrote.

`tasks.applyPolish` stores all three in one transaction, and marks the polish task done unless its run still goes on. It refuses:

- a task an agent created, or a proposal
- an occurrence of a schedule, which takes its prompt from the schedule
- a closed task, or one that is not in Backlog or Needs me
- a polish task that is not the task's child

**Editing a prompt.** `tasks.edit` and `schedules.update` are the same kind of act without an agent behind it: the user rewrites a prompt in the browser, or with `board task set prompt` and `board schedules edit` on a machine. The bindings are the ones in the table. A task's new title and prompt are sealed for its own row, and the prompt for the agent the row names. `tasks.edit` also stores a `user` event note with the old text. It refuses a task an agent created, a proposal, an occurrence of a schedule, a closed task, one outside Todo and Backlog, and one a worker ever claimed. `schedules.update` (the browser's Edit schedule, which sets every property of a schedule, not only the text) stores the schedule's ciphertext as it is, and copies it into the pending card, which has the same binding. The browser seals the title, prompt, directory and agent together under the schedule, since a new agent changes the context of the title and prompt; the machine API's `edit-schedule` keeps the agent when it takes only a title and prompt, and with `settings` (the CLI's `board schedules edit` with a setting flag) seals all four together under the new agent, as the browser does. An occurrence is refused because its sealed values are bound to the schedule: an edit of one card could be replayed as the schedule's prompt for every later run, as with a polish. The CLI seals the same way, outside a board run only (both commands are refused inside one), and the machine API takes the commands `edit-prompt` and `edit-schedule`. `edit-prompt` is the only place where the machine API accepts a `user` note: `add-note` still refuses that author. The server cannot tell the user's CLI from a process that holds the machine's token, so keeping a run's agent out of it is the CLI's refusal, not the server's (an agent that reads the data key can seal as any creator, as listed under [What the server can still do](#what-the-server-can-still-do)). The server checks state and stores ciphertext; it never writes a prompt.

**Renaming a task.** `tasks.configure` with `title` stores a title the browser sealed under the row's `title` binding, in any status and for any creator, with no note. The binding names no creator, so renaming an agent's proposal makes nothing of it the user's. An occurrence is refused, as in `tasks.edit`: its title is bound to the schedule, so a rename of one card could be replayed as the schedule's title.

### Dropped or swapped agent

A task that names an agent runs as that agent, under the agent's own tool lists. A task without one runs under its creator's rules. A hostile server could return `agent: null` to lift the restrictions, or give the task the name of a more permissive agent.

**The mechanism.** The name is sealed twice:

- on its own as `agent`, bound to `<origin>`
- inside the context of `input`: `<origin>:<creator>:agent:<name>`

A client opens the agent first and then the prompt under that name. When the server dropped, nulled or swapped the agent, the prompt opens under no binding, the task is unreadable, and the worker never starts it. The same holds when:

- the agent does not open, or its name does not match `^[a-z0-9][a-z0-9-]{0,31}$`. `unreadable` then names `agent` and the prompt.
- the server adds an agent to a task made without one.

For a task without an agent the context is `<origin>:<creator>`.

The `agent` envelope is bound to the origin and not to the creator, because the creator is already in the prompt's context. For a schedule it is bound to the schedule, and the server copies it unchanged into each occurrence along with the prompt.

A CLI that does not know the field computes the prompt's context without the name. It cannot open the prompt, and its dispatcher and worker skip the task (see [Upgrading](setup.md#upgrading)).

**What a writer must state.**

- Whoever seals a new prompt for a task must state the agent: `patch.seal.agent` is required, with `null` for none. This applies to the browser's Polish prompt and Edit prompt, `board task set prompt`, a requeue by `board schedule --key`, and `update-task` with `seal.agent`. A prompt is never sealed without an agent by omission, and a prompt sealed under the wrong name does not open.
- Nothing changes the agent of an existing task or schedule. The name is written once, when the row is made.
- An agent's proposal never carries an agent. The server refuses a draft with both `agent` and `createdBy: agent`, and the browser will not start a proposal that has one.

**Limits of the agent field.**

- A proposal made from a restricted agent's run carries no agent. Once the user starts it, it runs in `auto` like any task of the user's. That is the user's decision.
- `board attach` resumes an agent's task in an interactive session with the user's own settings.
- `board schedule` and the other commands refused inside a run rely on `AGENT_BOARD_TASK` being set. What stops an agent from running `env -u AGENT_BOARD_TASK board schedule` is that agent's own tool lists.
- The name is the only link to the agent's definition, which lives on each machine. Machines that should behave alike must define agents of the same name the same way.

### Forks

A fork is a task whose first run continues a copy of another task's Claude session, with the user's instructions as its prompt (see [Forking a task](usage.md#forking-a-task)). The link to the parent, `fork_of`, is a clear column, so the server could move it. The prompt is therefore bound to it, in the same way as the agent.

**The mechanism.** The browser seals the instructions under `<origin>:<creator>:fork:<parentId>`. With an agent the order is fixed, link first: `<origin>:<creator>:fork:<parentId>:agent:<name>`. A client opens the prompt under the `forkOf` the board shows. When the board added, dropped or swapped `forkOf`, the prompt opens under no binding, the task is unreadable, and the worker never starts it.

What that stops:

- **A dropped link.** The instructions were written for a conversation that holds the parent's context. Run without it, in the parent's directory, they would do something else than the user meant.
- **An added link.** A task of the user's would continue another task's conversation, with everything that conversation knows and holds in its context. The user asked for nothing of the kind.
- **A swapped link.** The instructions would continue a different conversation than the one the user forked.
- **A made-up fork.** A prompt can only be sealed for a fork by a client that holds the key. The server cannot turn a task into a fork, and nothing an agent sends can: `add-task` takes no `forkOf`, and an agent's draft is sealed for the creator `agent`.

A fork keeps the restrictions of its parent. The browser seals the parent's agent name for the new task, and the context above carries it, so a fork never lifts an agent's tool lists. The board also refuses a fork that names an agent the parent lacks, or none where the parent has one.

**What the worker still checks.** The link only says which task the user forked from. The session to copy is the parent's, as the board names it in the clear, and it is held to the rule of [Session ids from the server](#session-ids-from-the-server): the worker continues it only when this machine started it for that parent task. The worker also refuses a parent the board answers with that is not the task the link names. A fork whose parent is gone, has no session or ran elsewhere is blocked and goes to Needs me with the reason. The copy gets a new session id that the worker records for the fork, so the fork resumes its own session from then on.

**What a writer must state.**

- Whoever seals a new prompt for a fork must state the link: `patch.seal.forkOf` is required, with `null` for none, and the browser's Polish prompt passes it on. A prompt sealed without the link of a fork does not open.
- Nothing changes the link of an existing task. It is written once, when the fork is made.

**Limits.**

- A CLI that does not know the field computes the prompt's context without the link. It cannot open the prompt, so it never runs a fork: its dispatcher logs `SKIP <id> cannot decrypt its input` and the task waits in Todo. Update the CLI of the machine (see [Upgrading](setup.md#forking-a-task-cli-0250)).
- The user's instructions and the parent's title reach the agent. The title is the user's own text and is shown to the agent on one line, cut.
- The copy holds what the parent's conversation held, including what the parent read of untrusted text. That is what forking is for, and it runs under the same agent or settings as the parent.

### Relabelled notes

A note is bound to its author and kind. An agent note, which can quote an untrusted PR or a log tail, cannot be served back as "the user replied". A system note cannot be served as an agent's.

Only the pairs a client writes exist: an agent's comment, question or polish note, a system event, and a user's comment, answer or event.

### Forged server events

The server's own events are the only plain-text bodies. A client accepts a plain body only when it is one of the fixed texts of `packages/shared/src/events.mts`:

- `Marked done.`
- `Queued for a fresh run.`
- `Closed.`
- `Reopened.`
- `Closed after <n> days in Done.`
- `Moved from <status> to <status>.`
- `Priority <priority> → <priority>.`
- `Start time cleared.`
- `Start time set to <ISO time>.`
- `Wait ended by you.`
- `Your message reached the agent after its run ended; resuming with it.`
- `Taken back from <machine or "its worker">: no sign of life for 20 minutes.`

The server writes them with the same module. Clients show them as `server` events, never as `system` ones.

### Re-attached answers

The browser seals the questions it showed together with the answers in one envelope, `{"questions": [...], "answers": [...]}`, and checks them against each other. What the agent is told comes from that envelope alone.

- `questionNoteId` is only the server's pairing for display. The browser shows an answer with a question only when the questions inside the answer are the question's own.
- The questions in the envelope are the ones the panel froze when it mounted for that open question. The browser does not fetch the thread again when you press the button, and the panel does not follow the polls.
- A question note is immutable. When the board later serves other questions under the same note id, the panel does not swap them in. It replaces the form with a notice that the question changed, drops your picks and sends nothing. It shows the changed questions, with fresh picks, only when you ask for them.
- Notes of one id are one note. When a thread holds the same note id twice, every note with that id shows as unreadable.

### Session ids from the server

A session id is a UUID or nothing. The worker resumes only the session this machine started for the task's newest fresh run. A fork's first run copies the parent's session under the same rule: it must be the one this machine started for the parent task. The record is `<state dir>/sessions/<task>` and holds one id.

Any other id blocks the run with a message that points to Re-run fresh. That covers the board's id, an agent's, and one that Re-run fresh abandoned on this machine. The worker does not start fresh by itself, because that would run a prompt again that may already have done its work.

The record is per machine. So "a session that a fresh run abandoned is never resumed" holds only on the machine that ran the fresh run. The board chooses the machine a resume is pinned to, so it can still send an older session to another machine that recorded it. That machine resumes it, with the reply it is handed.

A worker could drop its record when the sealed start notes (`agent-board: started <time> (<skill>, <machine>, …)`) show a newer run on another machine. That is not built. The board can withhold or replay notes, so it would only help when the board cooperates.

### Clear values that reach a command

The prompt reaches `claude` on stdin, never as an argument. A sealed prompt or a reply can start with `-`, or look like `--mcp-config=…`, and still cannot be read as an option.

Three kinds of clear value become arguments, one argument each:

- the session id, as `--resume=<uuid>`; for a fork also the parent's, as `--resume=<uuid>`, and the copy's own as `--session-id=<uuid>`
- a task's model, as `--model=<name>`, held to `isModelName`, so it never starts with `-`
- a task's effort, as `--effort=<level>`, held to `isEffort`: one of five fixed words

Every other clear value that reaches an argument, a path, a unit name, an environment variable or a shell is checked to a tight shape when it is parsed. That covers ids, machine and lane names, a schedule's cron expression and time zone, note ids, the key id and the user name. The sealed directory is checked after opening: an absolute path without control characters.

### Links and other server text that reaches the agent

The CLI builds every task link itself, from the `url` in its own `web.json` and the task id. A task has no `url` on the wire, and the board sends no link.

Every other clear string the board sends is one of the following. Nothing else in a run's text comes from the board.

| Clear value                                                          | Where it reaches the agent                                         | What it is held to                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| task and schedule ids, note and run ids                              | argv, unit names, `board tasks`, `board show` ids, the run's rules | `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (not `dispatch` or `intake`)                                    |
| status, priority, `next`, creator, author, kind                      | `board tasks`, `board show` headers                                | members of a fixed list                                                                            |
| machine and lane names                                               | dispatch's log (`pinned to <name>`), `board tasks`                 | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`                                                                |
| session id                                                           | `--resume=<id>`, the message of a blocked run                      | a UUID this machine recorded for the task                                                          |
| times (`notBefore`, `createdAt`, `nextRunAt`, ...)                   | `board tasks`, `board show`, `board schedules`                     | parsed to a date, printed by the CLI                                                               |
| a schedule's cron expression and time zone                           | `board schedules`, the confirmation of `board schedule`            | five fields of digits, cron symbols and month and day abbreviations; a zone name the runtime knows |
| a task's or schedule's model                                         | `--model=<name>`, `board show`                                     | `^[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,63}$`                                                           |
| a task's or schedule's effort                                        | `--effort=<level>`, `board show`                                   | one of `low`, `medium`, `high`, `xhigh`, `max`                                                     |
| key id                                                               | the message when a machine holds another key                       | 16 lower-case hex characters                                                                       |
| a server event's text                                                | `board show`                                                       | one of the fixed texts, printed under `from the board server, not board content`                   |
| the reason of a refusal, and what a parser quotes of a refused value | the error of a `board` command, the hook's answer to the agent     | JSON-quoted, one line, at most 200 (refusal) or 40 (parser) characters, marked as the server's     |

Titles, prompts, directories and notes are the user's own sealed text and are not in this list.

## Advice-only copies

Some values the server holds are copies or display data. None of them reaches a path, an argument or a decision on any machine.

### A task keeps the directory it was created with

The server copies the `workdir` ciphertext a task row is created with into a second column of the same row, `home_workdir`, under the same binding. The row can come from a machine's `add-task`, the browser's form or a schedule's occurrence. Re-run fresh copies it back into `workdir`.

Only the user's change of the task's directory (`board task set dir`, `tasks.configure`) replaces it, with the new directory sealed under the row's `workdir` binding. A worker's rewrite never does.

This gives the server nothing new. It copies a ciphertext between two columns of one row without opening it, and it could already replay an older `workdir` of the same task (see [What the server can still do](#what-the-server-can-still-do)).

A task from before the column existed has a home only when the migration could tell that its `workdir` was still the original (never claimed, no session). The others have none.

### The state of a task's PR is clear on purpose

The board server cannot ask GitHub, because it cannot read the URL. The browser cannot either: it has no token, and a call from it would tell GitHub which PRs you track. So a worker's dispatcher looks the state up with `gh` and writes `open`, `merged` or `closed` for each PR as a plain column. The board can then show a merged PR on its card and offer to clear the Needs me column.

- It reveals that a PR of the task merged or closed, never which. The operator could learn the same from GitHub's own merge activity only by already knowing the repository.
- A board that lies about it can show a wrong icon, or offer **Move merged to Done** for a task whose PR is still open. You undo that by dragging the card back.
- The value is shown only. It reaches no argument, path or agent text.
- A newly reported PR starts with no state.

### The machine documents

Each machine sends the board three sealed documents: its directory list, its catalogue of skills and models, and its usage status. All three follow the same rules.

- **Bound to the machine.** Each is sealed under its own field for `machine:<name>`. A document sealed for one machine does not open as another's, and one kind does not open as another kind.
- **A blind index says whether it changed.** The CLI sends each document with `abh1.` of `<kind>:<machine>:<document>`. The board returns the index in `version`, which is how the CLI knows whether to send again.
- **The operator sees only the envelope.** That a machine sent a document, its size, when, and whether it changed. Nothing of what is in it.
- **Readers shape-check it on opening.** The CLI and the browser both do.
- **Nothing reads it back into a decision.** The copy never reaches a path, argv or a decision on any machine, and no CLI reads one back from the board.
- **A hostile board can withhold a document or serve an older one of the same machine.** That changes only what the browser offers or shows.

| Document          | What it holds                                                                                       | Used for                                                 | Blind index of                 | Index in `version` |
| ----------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------ | ------------------ |
| `machine.dirs`    | the listed directories that exist, each with its label                                              | the New task form's Working directory field              | `dirs:<machine>:<document>`    | `dirsIndex`        |
| `machine.catalog` | the skills and models `claude` reports on the machine, and the names of its lanes                   | completing `/skill` and offering models                  | `catalog:<machine>:<document>` | `catalogIndex`     |
| `machine.usage`   | the usage limits, the last readings, and the ids of Todo tasks the machine held back or could serve | a badge on a task card and a line in Settings › Machines | `usage:<machine>:<document>`   | `usageIndex`       |
| `machine.sources` | the names, timers, pauses and last runs of the machine's sources, each with a random id             | the Sources page                                         | `sources:<machine>:<document>` | `sourcesIndex`     |

**Source requests.** The browser's Pause, Resume and Run now are stored in the clear on the machine row as `<action>:<id>`, where the id is random and names no source. A hostile board can drop, replay or invent one. The worst it does is pause, resume or run one of the user's own sources out of turn: the machine applies it only to a source it has, and a run is what the source's timer would do anyway.

**The directory list.** `board dirs` keeps the list that is enforced in the machine's own `config.json`. The copy is for the form to offer (see [Scheduling](usage.md#scheduling)).

- The document opens only with the exact shape: at most 200 entries, each a safe absolute path with an optional label. A label is 1 to 64 characters without control characters or surrounding space. A label that fails is dropped and the list still opens. Other keys are ignored.
- The form offers a machine's directories only when its list opens under that machine's name and passes the shape check. An unreadable list, a revoked machine, or a machine whose name fails the shape check offers nothing. The form says which machine's list it could not read.
- Picking a directory seals it as the user's own `workdir`. What the form offered is never trusted beyond the choice the user made.
- A label is the user's own text, shown only as plain text beside its path. No other setting of a directory (`repo`, `default`, `lane`) leaves the machine.
- The worker enforces only its own file. The directory a task is sealed with is still checked against the machine's own list when it runs.

**The catalogue.** The CLI asks `claude` on the machine which skills and models it has (see [Skills and models on the board](workers.md#skills-and-models-on-the-board)).

- Everything in it is text from a program's output on the user's machine. It can come from a plugin or a checkout the user does not control. So the CLI cleans it before sealing: one line, no control characters, cut to a length.
- A reader checks it again with `parseMachineCatalog`. A skill name is letters, digits and `_ . : -`. A model name passes `isModelName`. A lane name passes `isSafeLane`, and there are at most 20. A path is a safe absolute one. An entry that fails is dropped and the rest opens. A list over its cap makes the document unreadable.
- The browser shows it as plain text. Picking a skill or a model puts text in a field the user then reviews and seals as their own.

**The usage status.** At the end of a dispatch tick the CLI seals its `usageLimits`, its last usage readings and the task ids (see [Usage limits](workers.md#usage-limits)).

- The operator learns no task id, percentage or limit from it.
- A reader checks it with `parseMachineUsage`. A task id passes `isSafeTaskId`, and numbers and times are in range. An entry that fails is dropped and the rest opens. A list over its cap makes the document unreadable.
- The browser shows it as plain text, in the badge and the Settings › Machines line only.

## Keys in the browser

**A key the board says is gone.** The browser keeps the keys it holds when the board reports no key, another key id or another user. It shows a blocking warning instead of the setup screen. A reset the user did not make looks the same, and would walk them into a second data key while the machines keep the first. The way out of the warning is deliberate: typing a word.

**Setup with no key in the browser.** The warning cannot protect a browser that holds no key at all (after Lock, in a private window, in a new browser) when the board reports none. The setup screen then says that if the board was already in use, setting up again creates a new key that the worker machines do not hold and that cannot read anything stored under the old one. It requires ticking a confirmation that this is a first-time setup.

**Settings.** Settings › Machines and Settings › Encryption show and re-wrap a key only when it is the one the browser is using, whatever the board reports.

**Passphrases.** A passphrase is trimmed and NFKC-normalised in one place before it is checked and hashed, so setup, unlock and change treat it alike.

**Clear values on screen.** Everything the browser shows from the board in the clear goes through the same shape checks as the CLI's wire parsers:

- machine and lane names, who wrote a note, a run's machine
- a schedule's rule, its run count and interval
- a run's event count and a result's output size, which must be whole numbers
- the name the board reports for you in the key warning, shown only when it looks like a login name

A value that fails shows as a neutral placeholder, and the task page says so. The board's own events show as `Board`, apart from the `system` notes of your machines.

### The agents on the board

The board holds the agent definitions the user pushed for every machine (see [Agents on the board](workers.md#agents-on-the-board)) as one sealed document, `agents.shared`, bound to `agents:v<version>`. Unlike the machine documents it is acted on: every machine applies it, and an agent's definition decides what a run as it may do.

- **Only the user's CLI writes it.** `board agents push` and `board agents rm --board` seal it, and both are refused inside a board run. The browser never writes it.
- **One document, not a row per agent.** Agent names are sealed on tasks and must not appear in the clear; rows keyed by name, or by a blind index of it, would show them. All names and definitions are inside one ciphertext, so the server cannot swap one agent's definition for another's, and a push is atomic.
- **The version is in the binding.** The server keeps the version clear so that a tick compares it without opening anything, and a document opens only under the version it was sealed as. A machine never applies a version lower than or equal to the one it has.
- **The operator sees** that the user has shared agents, the version, when it was pushed and the envelope's size. Not how many agents, their names or what they grant.

| The server…                                  | Effect                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| serves an older document                     | Refused: the version is in the binding, and a machine never applies a version lower than the one it has               |
| swaps one agent's definition for another's   | Not possible: all names and definitions are inside one ciphertext                                                     |
| withholds a newer document, or reports none  | Machines keep the version they applied. `board doctor` cannot see a newer version the server hides                    |
| deletes the row                              | Machines keep their copies. Taking an agent off every machine needs a pushed document without it                      |
| reports a higher `agentsVersion` than it has | The document does not open under that version, or is not newer; nothing changes, and the tick and `board doctor` warn |

What this gives up is under [What the server can still do](#what-the-server-can-still-do): any run that reads the data key can push a definition every machine applies.

### The link rules

The link rules (see [Link rules](usage.md#link-rules)) are one sealed document, `links`, bound to `links:v<version>`. Only the browser seals and opens it: no machine, no agent and no CLI command reads or writes it.

- **One document, not a row per rule.** The patterns and URLs often name a tracker and a project, so they stay inside one ciphertext, and a save is atomic.
- **The version is in the binding**, as for the agents on the board. A save is compare-and-set on the clear version (`links.set` with `expectedVersion`; a lost race is a CONFLICT), so two tabs cannot overwrite each other unseen. The server can serve an older document, but it cannot make it open as a newer version.
- **The browser checks the content.** The server checks that the value is an envelope within the size limit. The browser opens the document only when it says the version it is bound to, has at most 50 rules, each with a pattern that compiles and a URL that starts with `https://` or `http://`. Anything else is unreadable and no rule applies.
- **The operator sees** that the user has link rules, the version, when they were saved and the envelope's size. Not how many rules, what they match or where they point.

### The title rules

The title rules are one sealed document, `titles`, bound to `titles:v<version>`. Only the browser writes it. The browser and every machine's CLI read it, which is why it is a document of its own and not part of `links`: the link rules stay unreadable to any machine.

- **One document, not a row per rule.** The patterns and the instructions often name a project or a way of working, so they stay inside one ciphertext, and a save is atomic.
- **The version is in the binding**, as for the link rules. A save is compare-and-set on the clear version (`titleRules.set` with `expectedVersion`; a lost race is a CONFLICT), so two tabs cannot overwrite each other unseen. The server can serve an older document, but it cannot make it open as a newer version.
- **The reader checks the content.** The server checks that the value is an envelope within the size limit. A reader opens the document only when it says the version it is bound to, has at most 50 rules, and every rule passes the same check the Settings page applies: a pattern of at most 300 characters that compiles, an icon that is one emoji, an instruction of at most 2000 characters, and at least an icon or an instruction. Anything else is unreadable and no rule applies.
- **The operator sees** that the user has title rules, the version, when they were saved and the envelope's size. Not how many rules, what they match or what they say.

## The export file

Settings › Account › Your data writes the board to one NDJSON file (see [Your data](usage.md#your-data)). The header is the first line, and every other line is one row of a table. `packages/shared/src/archive.mts` defines the format.

**What is in it.**

- The rows as the server stores them: every sealed column is still an envelope, so the file holds no plaintext of the board. The link rules and the title rules travel as the tables `link_rules` and `title_rules`.
- The wrapped key slots, the passphrase slot and the recovery slot. The data key itself is not in the file.
- The clear columns exactly as the server sees them (see [What the server sees](#what-the-server-sees)): ids, statuses, priorities, times, machine names, blind indexes and the rest.
- The sha256 hashes of the machine tokens, never a token.
- The username the envelopes are bound to, the key id, and the preferences of the browser that exported.

**How secret it is.** As secret as the database, and no more: the database holds the same ciphertext, the same slots and the same hashes. Without the passphrase or the recovery key the file opens nothing. With one of them it opens everything in it, so it is kept like the database backup.

**Import into the same username** sends the rows as they are. The server accepts them only under the key id of the file (the key of the account), and checks every row as it does for any write: the sealed columns, the schedule rules, the clear text columns. A row it would refuse is counted and skipped, and never fails the batch. A test ties the columns the browser re-seals to the sealed columns the database checks, so a new sealed column fails it until the re-seal handles it.

**Import under another username.** Every envelope is bound to its owner through its additional data. The browser opens each sealed column with the old username and its derived keys (the keys do not depend on the username, only the additional data does), and seals the same plaintext again with the same field and context under the new username. Which binding a column opens under is decided by the shared rules, from the clear columns of its row. Nothing is sealed under a binding it did not open with:

- A value that does not open is copied as it is and stays unreadable. The import counts them and says so.
- A column whose clear values do not allow a binding stays unreadable too.
- A server event keeps its plain text, as it has no envelope.

So no value gains a meaning it did not have. The rule "nothing runs unless your own client sealed it as runnable" holds: a prompt that was sealed for the creator `user` stays that and is sealed again as that, and a prompt of an agent or of the board stays one.

**The limit.** The clear columns of a file are not authenticated. A file that someone else changed can do what a hostile server can do (see [What the server can still do](#what-the-server-can-still-do)) and no more:

- reorder rows, change a status, a priority or a time
- add a machine token hash. Whoever holds the token that hashes to it can then read the ciphertext of the account and write rows through the machine API. It cannot make a worker run text that was not sealed as runnable.
- leave rows out

A task that was running arrives in Needs me, because the import cannot know that its run ended. A pending message for a running agent is not imported as pending. The import cannot make a file harmless, so the screen says to import only a file you exported yourself.

## What the server validates

The server refuses a sealed field that is not an envelope (400) or that is longer than its limit (`SEALED_LIMITS`). It checks nothing about what is inside.

So all content validation happens in the client, before sealing and after opening: a non-empty title, an absolute `workdir`, the shape of questions and answers, whether an answer fits its question. The clients also refuse a value that is too long themselves and name the limit. That includes `board comment --file`, `board add --file` and `board polish --file`.

- A task's `dedupeKey` is the blind index (`abh1.…`, an HMAC) of the key a script gave, and `head` is the blind index of `head:<sha>`. The server can keep the key unique per board and nothing else.
- Labels are not stored. `taskLabels` in `packages/shared` derives them from the opened prompt and the creator.
- The database refuses plain text in every sealed column (migration 0014). `apps/backend/src/db/sealedColumns.ts` lists them.

## Previews

A client that writes a note with text also sends `preview`: the first 300 characters of the text, sealed apart. The board cards list every task's newest note without opening threads, and the preview is what they show.

A note without text (a question note, an answer without a message) has none. The card shows a server event's own text when it is one of the fixed ones.

## Suggested replies

A comment by the agent may carry `suggestion` (sealed `note.suggestion`, at most 2000 characters). It is the reply the agent expects the user to send next. `board comment --suggest <text>` or `--suggest-file <path>` seals it. The browser offers it as ghost text and a one-click Send while no note of the user follows it.

Only agent comments can carry one. The server and a database check refuse it on any other note, and a client opens it only there.

A server without the `note.suggestion` feature refuses the key on `add-note`. The CLI then posts the comment without the suggestion and says so.

## The pull request of a task

`board pr <task> <url>` seals the URL of a PR the agent opened as `pr`, bound to the task and to the agent. No other field's ciphertext (a prompt, a note) and no other task's PR opens as this one. The user's own text can never stand in for it.

The CLI refuses anything but `https://github.com/<owner>/<repo>/pull/<number>` before sealing. The browser and the CLI show a value only when it opens under that binding and passes the same check again.

- A server cannot make a card link anywhere but to a GitHub pull request, and it cannot make a PR up.
- It can still drop, repeat or reorder the PRs of a task, or serve again one that was sealed for the task.

The prompt's own PR (a review task) comes first when both exist.

## The watches of a task

The CLI of the machine that runs a task's watches seals what the board shows of them as `watches`, bound to the task and to the agent like a PR. It is one JSON document, `{"watches":[…],"pendingEvents":n}`. Each entry has a `name`, a `kind`, a `label` such as `CI #116`, a one-line `status`, the `deadline` and the last look. `pendingEvents` is how many events wait for the agent.

- The command a watch runs and its output are never in it. They stay on the machine.
- A client shows an entry only when it has exactly that shape and drops one that does not. A list that does not open or parse is unreadable (`watches` in `unreadable`), which never keeps a task from running.
- The server can drop, repeat or serve a stale list, or serve one sealed for the same task again. It cannot make one up.
- What the user asks to stop (`watchStops`) is a list of watch ids in clear. The server learns which of a task's watches the user stopped, not what they are, and the machine acts only on an id it has a watch for.

## Unreadable values

The CLI never crashes a listing on a value it cannot open, and never treats one as a prompt. The cause can be plain text, another key, another row or damage.

- **Tasks and schedules** get `unreadable`: the names of the fields that failed (`title`, `input`, `workdir`, `agent`, `watches`). A workdir that opens to a relative path counts. An unreadable title shows as a placeholder, an unreadable input is empty, an unreadable workdir is `null`.
- **Dispatch** skips a task whose input or workdir is unreadable. The worker refuses to run it and reports why on the task. An unreadable title alone does not stop a run.
- **Notes** that cannot be opened, or whose questions or answers do not parse, are `unreadable` with no text.
- **A run is refused** when it would hand the agent an unreadable note of the user's: the reply a resume carries, or what a fresh run is told the user wrote since the previous run started. Older notes do not matter, so Re-run fresh, which starts after the refused attempt, gets past it.
- `board show` and `board tasks` print `(cannot decrypt …)` instead of text.

The data key is read from `AGENT_BOARD_DATA_KEY`. It is never printed or put into an error.

## What the server can still do

The server relays what the user does, and the user's actions are not signed. A hostile server, or a stolen database login, can therefore:

- decide **when** a task starts, resumes, re-runs, is paused or closed
- decide **on which of the user's machines** it runs (any machine that holds a token) and **in which lane**, by dropping or changing the lane a task asks for (`requestedLane`)
- change a task's priority or position
- choose the model of any run: a review of untrusted PR text on a weaker model, or every task on the most expensive one
- withhold, delay or reorder anything, notes and answers included
- name the sign-in address the browser is sent to. For OIDC and SAML the board's server builds the identity provider's URL, so a hostile server can send you to a look-alike page. The board asks for the passphrase on its own origin only, never on an identity provider's page, so a page that asks for it during a sign-in is not the board
- decide which user name a session belongs to. That gives it nothing it lacks: a browser that holds the keys of another user shows the [key warning](#keys-in-the-browser), and without the key every value stays sealed

It cannot:

- make a worker run text the user's clients did not seal for that task
- run a task with the permissions of another creator
- put its own words in a note or an agent's prompt

It sees everything listed under [What the server sees](#what-the-server-sees). It does not see what an answer, a prompt or a note says, or which PR a task is about.

These limits are inherent to a server that stores ciphertext and cannot sign what the user did:

- **Ciphertext never expires.** The server can run a closed or done task again, and a deleted or paused schedule, as often as it likes. The prompt still opens, and the run is judged as the user's.
- **Replay within one task.** It can replay an older value of a field (an earlier prompt or directory of that task). It can reorder, duplicate or withhold notes, including serving an older reply after a newer question. A note's id, author, kind and task are bound. Its place in the thread is not.
- **Fixed event texts.** It can insert any number of them. `Taken back from <machine>` carries a machine name, at most 64 characters of `[A-Za-z0-9_.-]`.
- **No key rotation.** A passphrase change leaves the old wrapped copy of the key with the server, and the data key is never rotated. A passphrase or a key that has leaked stays leaked, and a recovery key that was kept still opens the board.
- **The key on worker machines.** Every worker machine keeps the raw data key in `~/.config/agent-board/env`, readable by any process of that user, an agent in `auto` mode included. An agent that reads it can seal what it likes, as any creator.
- **Shared agents reach every machine.** With the data key, a run can also seal and push a new version of the [agents on the board](#the-agents-on-the-board) with broader grants, and every machine of the user applies it on its next tick, without a reading on each. `board agents push` is refused inside a run, but that is the CLI's refusal: the server cannot tell a run that holds the key and the machine's token from the user's CLI. A run in `auto` mode could already rewrite the agent files of its own machine; the new reach is every other machine. This is accepted as a known limit, without a signing key or a per-machine switch (see [Design decisions](architecture.md#design-decisions)).
- **Link rules are written by anything that holds the data key.** A run could seal a new version of the [link rules](#the-link-rules) too, and the browser would apply it: text in the board then links to an address the run chose (always `http` or `https`; the browser never makes a `javascript:` link). The rules add no way to run anything, but a pattern with catastrophic backtracking (the user's own typo, or one sealed by anything that holds the key) can freeze the tab that renders markdown; there is no guard against it. The browser opens a link only when you click it.
- **An unlocked browser.** It stays unlocked until Lock, per tab, and its derived keys stay in IndexedDB until then.
- **A dropped directory.** The server can drop a task's directory (`workdir: null`) and withhold the `home_workdir` copy that Re-run fresh restores. The task then runs in the lane's or the default directory of that machine instead of the one the user chose. With a `dirs` list on the machine, that directory must itself be listed, else the run is refused.

## Error text from the server

A `board` command reports a server refusal as:

```text
error from the board server (HTTP <status>), quoted and not part of the board: "<text>"
```

The hook that tells an agent a question could not be put on the board does the same. The text is the server's words, JSON-quoted, on one line, at most 200 characters.

The agent sees it as an error, never as a note, a prompt or an instruction. A client never shows server text as board content. What a parser quotes of a value it refuses is quoted too, and cut at 40 characters.
