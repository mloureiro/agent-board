# Machine API

The spec between the CLI and the board, API version 9.

| Side   | Code                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Client | `apps/cli/src/backend/backend.mts` and `web-backend.mts` over HTTP, `contract-check.mts` for the version check, `sealing.mts` for the encryption |
| Server | `apps/backend/src/machine-api.ts`                                                                                                                |
| Shared | `packages/shared/src/contract.mts` (wire types and parsers), `features.mts` (feature names)                                                      |

Nothing else implements it. This document describes the wire, where sealed fields hold envelopes. The CLI's own `Backend` interface in `contract.mts` is the plaintext view of it.

## Requests

```http
POST <url>/api/machine/<command>
Authorization: Bearer <machine token>
```

The JSON body is `{"id"?, "all"?, "machine"?, "author"?, "kind"?, "run"?, "body"?}`:

| Key              | Meaning                                         |
| ---------------- | ----------------------------------------------- |
| `id`             | The task or schedule the command acts on.       |
| `run`            | The run the call comes from, see [Runs](#runs). |
| `body`           | The command's payload, with the sealed values.  |
| `all`, `machine` | Arguments of `list-tasks` and `claim-task`.     |
| `author`, `kind` | Arguments of `add-note`.                        |

The answer is `{"result": ...}` with status 200, or `{"error": "one line"}` with any other status.

- The token names the machine. It never appears in an error message.
- The server checks the token before it reads the body, so a bad or missing token is a 401 whatever the body is.
- A body over 2 MiB is a 413. `transcript` takes up to 16 MiB. The largest sealed field of any other command, a task's input, is about 1 MiB as an envelope.
- The server refuses an unsafe id or machine name with 400 and writes nothing. The CLI refuses it before it sends anything.
- An unknown command is a 404.
- The CLI gives up on a call after 45 seconds.

### Request headers

Every request carries three headers, the event stream's included:

| Header               | Value                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| `X-Board-Client`     | The CLI version, `x.y.z`, or `x.y.z-dev` from a checkout.               |
| `X-Board-Client-Api` | The CLI's `API_VERSION`, an integer.                                    |
| `X-Board-Features`   | The vocabulary features the CLI understands, see [Features](#features). |

The server reads all three leniently and never answers 400 for them. The version must match `^\d+\.\d+\.\d+(-[0-9A-Za-z.]{1,20})?$` in at most 40 characters, and the level is an integer from 1 to 10000. Anything else is ignored.

The server stores version and level on the machine from `version` calls only, and writes only when they changed. A worker that started before an update keeps sending the old headers with its heartbeats, and those must not undo what the machine's next `version` call reported. Settings › Machines and the board's banner judge a machine from the stored values: it is incompatible when its level is below `MIN_CLIENT`. See [Updating the CLI](setup.md#updating-the-cli).

## Versioning

### Version handshake

The CLI sends `version` once per process, before its first other call. The answer:

```json
{
  "contract": 9,
  "owner": "<username>",
  "keyId": "<16 hex>",
  "api": { "version": 9, "minClient": 9 },
  "features": ["<name>"],
  "cli": "<x.y.z>",
  "dirsIndex": "abh1.…",
  "catalogIndex": "abh1.…",
  "usageIndex": "abh1.…",
  "feedsIndex": "abh1.…",
  "feedRequests": ["pause:<16 hex>"],
  "agentsVersion": 4
}
```

| Key                                       | Meaning                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`                                   | The user whose board the token works on. The CLI derives its keys for this user.                                                          |
| `keyId`                                   | The fingerprint of that user's data key, or `null` before they set up encryption.                                                         |
| `api.version`                             | The break level this server speaks, `API_VERSION`.                                                                                        |
| `api.minClient`                           | The oldest client break level it serves, `MIN_CLIENT`.                                                                                    |
| `contract`                                | The legacy number. The server reports `max(LEGACY_CONTRACT, minClient)`.                                                                  |
| `features`                                | What the server can do, see [Features](#features).                                                                                        |
| `cli`                                     | The newest CLI release the server knows of (`CLI_VERSION`). Left out when it knows none.                                                  |
| `dirsIndex`, `catalogIndex`, `usageIndex` | The blind index of the document the calling machine last sent with `set-dirs`, `set-catalog` or `set-usage`, or `null` when it sent none. |
| `agentsVersion`                           | The version of the user's [shared agents](#shared-agents), or `null` when they pushed none.                                               |
| `feedsIndex`                              | The blind index of the feeds the calling machine last sent with `set-feeds`, or `null`.                                                   |
| `feedRequests`                            | The user's requests for the calling machine's feeds that it has not acknowledged, see [`set-feeds`](#set-feeds).                          |

A server without `machine.dirs`, `machine.catalog`, `machine.usage`, `machine.feeds` or `agents.shared` leaves the matching key out. A client reads them leniently: anything that is not a blind index, or a whole number from 1 for `agentsVersion`, counts as `null`, never as an error, and a request that is not `<action>:<feed id>` is dropped.

**The numbers.** `API_VERSION`, `MIN_CLIENT` and `MIN_SERVER` are in `packages/shared/src/contract.mts`. `MIN_SERVER` is the oldest server break level a CLI works with. None of them counts changes. They rise only with a breaking change, never with an additive one (see [Wire rules](#wire-rules)). They start at 9, the contract number that servers and CLIs already had when the range was introduced.

**Reading the answer.** A client reads `api` when it is there. Otherwise it takes `contract` as both `version` and `minClient`. It refuses an `api` whose numbers are not whole numbers or whose `minClient` is above `version`.

**The legacy number.** CLIs up to 0.7.0 compare `contract` exactly. `LEGACY_CONTRACT` stays 9, so `contract` stays 9 until a breaking change raises `minClient` above it. From then on those CLIs stop too, with their own "this CLI is older" message.

**Who stops.**

- The CLI is too old when its `API_VERSION` is below `api.minClient`. It stops with a message saying which side to update (`board self-update` for a binary). The listener exits, systemd restarts it, and dispatch ticks fail.
- The server is too old when `api.version` is below the CLI's `MIN_SERVER`. That is a state of a rollout, so the unattended entry points wait it out. The dispatch tick logs one line and exits 0, without a failure or an alert. The listener logs it once and keeps reconnecting.
- A command typed at a prompt, such as `board tasks`, fails with the message on either side.
- Nothing else stops the CLI.

**After the handshake** the CLI derives its keys for `owner`. It stops when the board has no data key yet (`keyId: null`: set up encryption in the browser first) or when its key's id differs from `keyId`.

`board --version` prints `(api 9)`. `board doctor` shows the CLI's break level, the server's range and the features the server lacks.

### Features

Capabilities and vocabulary have names. An additive change then needs no version number, and two branches never collide on one. The names are in `packages/shared/src/features.mts`.

#### Server features

`features` in the `version` answer lists what the server can do.

| Feature                   | What it adds                                                                                                                                    | Baseline |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `attach-session`          | The `attach-session` command.                                                                                                                   | yes      |
| `events`                  | The event stream.                                                                                                                               | yes      |
| `note.polish`             | Polish notes: `kind: "polish"` on `add-note`.                                                                                                   | yes      |
| `note.suggestion`         | The `suggestion` key of `add-note`.                                                                                                             | yes      |
| `wait`                    | The `wait` and `wake` commands.                                                                                                                 | yes      |
| `task.model`              | The `model` key of `add-task` and `add-schedule`.                                                                                               |          |
| `task.pr`                 | The `set-pr` command and the task's `pr` field.                                                                                                 |          |
| `task.pr-state`           | The `set-pr-state` command and the task's `prState` field.                                                                                      |          |
| `task.prs`                | Several PRs on a task: the `add-pr` and `set-pr-states` commands, and the `prs` and `promptPrState` fields.                                     |          |
| `task.pr-remove`          | The `remove-pr` command.                                                                                                                        |          |
| `run-inbox`               | The `run-inbox`, `ack-messages` and `stopped` commands, and the `stopRequested`, `pending`, `queued` and `deliveredAt` fields.                  |          |
| `machine.dirs`            | The `set-dirs` command and `dirsIndex` in the `version` answer.                                                                                 |          |
| `machine.catalog`         | The `set-catalog` command and `catalogIndex` in the `version` answer.                                                                           |          |
| `machine.usage`           | The `set-usage` command and `usageIndex` in the `version` answer.                                                                               |          |
| `machine.feeds`           | The `set-feeds` and `ack-feed-requests` commands, and `feedsIndex` and `feedRequests` in the `version` answer.                                  |          |
| `transcript.context`      | The `context` event kind in `transcript`, see [`transcript`](#transcript).                                                                      |          |
| `task.agent`              | The sealed `agent` key of `add-task` and `add-schedule`, and of a task and a schedule.                                                          |          |
| `task.run`                | The task's `run` field and the `run` key of a request, see [Runs](#runs).                                                                       |          |
| `task.configure`          | The `configure-task` command.                                                                                                                   |          |
| `task.note-count`         | The task's `noteCount` field.                                                                                                                   |          |
| `task.watches`            | The `set-watches` and `ack-watch-stops` commands, and the `watches` and `watchStops` fields.                                                    |          |
| `task.fork`               | The task's `forkOf` field, see [Forks](#forks).                                                                                                 |          |
| `task.held`               | The task's `held` field, see [State](#state).                                                                                                   |          |
| `schedule.crons`          | The `moreCrons` key of `add-schedule` and of a schedule, see [Schedule](#schedule).                                                             |          |
| `schedule.max-concurrent` | The `maxConcurrent` key of `add-schedule` and of a schedule.                                                                                    |          |
| `schedule.after`          | The `after` key of `add-schedule` and of a schedule, a schedule that runs after another.                                                        |          |
| `task.auto-done`          | The `autoDone` key of `add-task`, `add-schedule` and `configure-task`, and the field of a task and a schedule, see [Auto-done](#auto-done).     |          |
| `task.moved-by`           | The task's `movedBy` field, see [Who moved a task](#who-moved-a-task).                                                                          |          |
| `prompt.edit`             | The `edit-prompt` and `edit-schedule` commands.                                                                                                 |          |
| `task.lane`               | The `lane` key of `add-task`, `add-schedule` and `configure-task`, and the `requestedLane` field of a task and a schedule, see [Lane](#lane).   |          |
| `schedule.update`         | The `settings` key of `edit-schedule`, see [`edit-schedule`](#edit-schedule).                                                                   |          |
| `agents.shared`           | The `get-agents` and `set-agents` commands and `agentsVersion` in the `version` answer, see [Shared agents](#shared-agents).                    |          |
| `task.effort`             | The `effort` key of `add-task`, `add-schedule`, `configure-task` and the `settings` of `edit-schedule`, and the field of a task and a schedule. |          |
| `task.icon`               | The `icon` key of `add-task`, `add-schedule`, `configure-task` and the `settings` of `edit-schedule`, and the field of a task and a schedule.   |          |
| `task.title-rules`        | The `get-title-rules` and `apply-title-rule` commands, see [Title rules](#title-rules).                                                         |          |
| `task.labels`             | The `labels` key of `add-task`, `add-schedule`, `configure-task` and the `settings` of `edit-schedule`, and the field of a task and a schedule. |          |

- The baseline (`BASELINE_SERVER_FEATURES`) is what the server of contract 9 has. A server that answers no `features` key is taken to have exactly the baseline.
- A new server capability appends its name to `ADDED_SERVER_FEATURES` in the same commit that implements it.
- The CLI checks the one name a command needs (`features.includes(name)`), never a version.
- A server that lacks the feature makes that command refuse with "the board server does not support <what> yet; update the board server", and nothing else. Dispatch and the other commands go on. The listener says so once and keeps reconnecting.
- A comment with `--suggest` is the exception: the CLI posts it without the suggestion and says so on stderr.
- `board doctor` warns about each feature the server lacks.

#### Client vocabulary

The CLI sends `X-Board-Features: <names>` on every request. The names are the features of the enum values it understands, and the capabilities of this build (`CLIENT_CAPABILITIES`, see [Client capabilities](#client-capabilities)).

`VOCABULARY_FEATURES` in `features.mts` maps an enum value added after the baseline to such a feature. The enum fields are `status`, `priority`, `next` and `createdBy` of a task or schedule, and `author` and `kind` of a note. Every value there is today is baseline, so the table is empty and the header is too.

What the server does with a value whose feature the request did not name:

- `list-tasks`, `read-notes` and `list-schedules` leave the item out.
- A single task or schedule it cannot show is a 422: `this task uses status "x", which this CLI does not know; update the CLI`. That covers `get-task`, `claim-task` and the result of any write. The write is rolled back with the request.

A CLI of 0.8.0 or newer goes on after the 422:

- `board schedule --key` fails for that task alone. A script such as github-reviews logs it and continues.
- The dispatcher keeps the stored check of a task it cannot read.
- A worker whose task became unreadable logs it and keeps its run files.

Rules for adding a row:

- CLI 0.7.0 does not survive the 422. So the first row waits until every machine runs 0.8.0 or newer, or it comes with a raised `MIN_CLIENT`.

#### Client capabilities

A capability is something a CLI can read that is not an enum value. Today there is one: `schedule.after`, sent by every CLI that parses a schedule with an `after` rule. A CLI that predates it parses a schedule strictly, exactly one of `everyMs` and `cron`, and would fail the whole `list-schedules` on one that runs after another. So a request without `schedule.after` is not shown such a schedule: `list-schedules` leaves it out, and a single one (`update-schedule`, or the result of `add-schedule`) is a 422 with `this schedule runs after another schedule, which this CLI does not know; update the CLI`. The cards such a schedule makes are ordinary tasks and need no gate. A new capability is added to `CLIENT_CAPABILITIES` and the server withholds what needs it in the same way.

- A request without the header, which is what a CLI up to 0.7.0 sends, knows the baseline only.
- A row for a note `author` or `kind` must also make the server's `noteCount` leave out the notes that `read-notes` leaves out.
- The change needs both halves in the same pull request: the row, and the CLI sending the new name. The CLI sends it by being in the table.

The server reads the header leniently. It cuts it at 1024 characters and 64 names and ignores anything that is not a feature name. The header never makes a request fail.

### Wire rules

**An additive change adds a feature name and bumps no number.** That covers a new endpoint, a new optional key, and a new enum value with its vocabulary row.

- **Responses may gain keys.** A client ignores unknown keys.
- **A new request key must be optional.** The CLI sends it only when the server's `features` name it. An advisory key may instead be dropped with a notice. The server stays strict and refuses an unknown key or value with 400.
- **A new enum value in a response is additive only with a vocabulary row.** The row makes the server withhold the value from a CLI that does not name the feature, so an older CLI never meets it. Without the row the value is breaking. So is any change to the meaning of an existing value. In both cases release a CLI that knows the value first, and raise `API_VERSION` and `MIN_CLIENT` when the server starts producing it.
- **A new enum value the CLI can send needs a server feature.** Examples are a status for `board move` or a `--priority`. The server accepts the value only with that feature, and the CLI sends it only when `features` names it (`SENDABLE_SERVER_FEATURES` in `features.mts`). Otherwise `update-task`, `add-task` and `add-schedule` refuse with "the board server does not support <what> yet". The table is empty today. The choices and the shell completion are not filtered by it. They list every value of this build.

**The tolerant list reader** is a safety net behind the vocabulary filter. A CLI skips a task, note or schedule with an enum value it does not know instead of failing the whole list, and warns once per field and value on stderr. Every other shape error still fails the call.

**A breaking change** is removing or renaming a field, changing its meaning, or a client depending on something it cannot detect.

1. Raise `API_VERSION`.
2. Raise `MIN_CLIENT` to it when older CLIs cannot cope.
3. Raise `MIN_SERVER` to it when the CLI needs the newer server.
4. Release the CLI and roll out in the order of [Upgrading](setup.md#upgrading).

`MIN_CLIENT` can never be above `API_VERSION`. A client refuses a `version` answer where it is.

CI checks a pull request against the newest `cli-v*` release. When that release is below the pull request's `MIN_CLIENT`, the CLI version in `apps/cli/package.json` must be above the release's. Otherwise CI runs the release binary against the pull request's server (`scripts/previous-cli-smoke.sh`).

A minimum level per command, for the day one command breaks while the rest does not, is a possible later step. It is not built.

## Events

`GET <url>/api/machine/events` with the same bearer token is a stream of server-sent events. A missing, unknown or revoked token is a 401 JSON error before any stream starts.

The stream says "look at the board again" and carries no data. The CLI then reads with `list-tasks` as always. Three things read it: the listener, a worker's change watch and `board events`. `board events` finds what changed by comparing two `list-tasks` answers, and uses `noteCount` to see which threads grew.

**Connection.**

- The response headers are `content-type: text/event-stream`, `cache-control: no-cache` and `x-accel-buffering: no`.
- On connect the server sends the comment `: connected`, and every 25 seconds `: ping`.
- At each ping it checks the token again and ends the stream when the token was revoked.
- The CLI treats 60 seconds without a byte as a dead connection.
- Behind the board's web proxy the stream arrives as `application/json` and without the headers above, though its chunks still pass as they come. A client must not rely on the stream's response headers.

**What sends an event.** `event: tasks` with an empty `data:` follows a committed change to a task or a schedule:

- these commands: `add-task`, `update-task`, `configure-task`, `claim-task`, `add-note`, `add-pr`, `remove-pr`, `set-pr`, `ask`, `pause`, `stopped`, `fail`, `wait`, `wake`, `edit-prompt`, `add-schedule`, `update-schedule`, `edit-schedule` and `remove-schedule`;
- `apply-title-rule`, only when it stored an icon or a title;
- `set-agents`, so that every machine's listener ticks and applies the new version at once;
- any change to a task or schedule from the UI.

A failed or rolled back call sends nothing.

**What sends none.**

- `heartbeat` and `transcript`, which every running task sends every 15 seconds.
- `set-dirs`, `set-catalog`, `set-usage`, `set-feeds` and `ack-feed-requests`, which change no dispatch decision.
- `set-pr-states` and `set-pr-state`, `run-inbox` and `ack-messages`.
- The reads: `version`, `list-tasks`, `get-task`, `attach-session`, `read-notes`, `list-schedules`, `get-agents` and `get-title-rules`.
- The UI's changes to machines and keys.
- The hourly cleanup that closes old Done tasks and deletes old transcripts. The 2-minute timer covers those.

**Delivery.**

- The server holds the changes of one owner back for 500 ms and sends one event, so a burst gives one.
- An event reaches only the streams of tokens that belong to the same owner.
- The signal lives in the backend process, which is enough for one replica.
- A stream that was down misses events. The CLI runs one tick after every connect.

## Rules

- Every command is atomic under concurrent calls. The dispatchers of several machines, scripts, workers and people call at the same time.
- A write is visible to the next read.
- A sealed value comes back verbatim.
- The board sends no link to a task. The CLI builds links itself from the `url` of its `web.json`.
- `claim-task` answers 409 when the task is not free for this machine. The CLI treats that as an answer and moves on to the next task. Every other non-200 answer is a failure.

**What the core parses after opening.** The start marker of `agent-board: started <iso>` notes, and the first line of a review task's `input`, which is the PR URL. The PR head is the `head` field, a blind index.

**Proposals.** A task an agent proposed (`createdBy: agent`) is the user's to start. The server refuses `update-task` with a new status for it and loses `claim-task` for it, whoever asks. The user starts it in the browser, which moves it into Todo with its prompt sealed again for the creator `user`. The board then stores that prompt and sets `createdBy` to `user`. The core never runs a task whose `createdBy` is `agent`.

**Closed tasks and stale runs.** The core never writes to a task that is `closed`. After a run, the worker drops its result in two cases:

- The task is closed.
- The task is running again in another run. That is another `run` than the worker started with, or another `runStartedAt` on a server without `task.run`. The task was taken back and run again, on this machine or another.

Any other outcome is judged on the task's `status` after the run. Anything but `running` counts as reported: the agent reported, the user answered while the agent was still ending its turn, or the task was taken back.

A todo task whose worker unit is still active is not started again until the unit is gone.

### Runs

The machine fence (`machine`) cannot tell two runs on the same machine apart. When a run is taken back and the same machine claims the task again, an agent left over from the old run, its process still alive, would pass every check. A server with `task.run` gives every claim a run id and checks it on the calls a run makes for its own task.

**Where the id lives.**

- `claim-task` makes a new `run`. The task drops it whenever it leaves `running`.
- The worker reads it from its task, sends it as `run` with its own calls for the task, and hands it to the agent as `AGENT_BOARD_RUN` next to `AGENT_BOARD_TASK`.
- The agent's `board` sends it with its calls for that task, and not for any other.
- Both send it only to a server whose `features` name `task.run`.

**Commands that act only in their run.** `heartbeat`, `pause`, `wait`, `fail`, `ask`, `stopped`, `run-inbox` and `ack-messages` with `run` act only while the task runs in that run. Another run gets the answer the command gives a task that is not running:

- 409 `the task is running in a later run, not in this one`,
- `applied: false` for `fail`,
- or no change for `heartbeat`.

The machine is checked first, so another machine still gets its own answer. That is 403 for `run-inbox`, `ack-messages` and `stopped`.

`apply-title-rule` is fenced the same way, with one difference: it is also accepted after its run ended, because a short run can end before the title is written. It is refused only once a later run holds the task.

**`update-task` with `run`.**

- It is refused with 409 while the task runs in another run.
- A status change also needs the run to hold the task. Once the task left `running`, the answer is 409 `the task is <status>, no longer running in this run`, and nothing changes. The agent asked, or the user took the task back or moved it.
- The other keys still go through on a task that left `running`, so the worker can store the directory the session ended in.
- A move to `done` also needs the task to be set to `autoDone`. Otherwise the answer is 403 `This task is not set to finish by itself: move it to needs-me, and the user marks it done.`, and nothing changes. See [Auto-done](#auto-done).
- `board move` from inside a run, on its own task, reports the 409 as a usage error. The error tells the agent not to move the task again and to end its turn.

**Without `run`.** A call without `run` is checked by status and machine only. That covers older CLIs, the browser, `board move` from outside a run, and runs that started before the server had `task.run`. A `run` that is not a run id is 400.

## Task

```json
{
  "id": "Ab3dEf9x",
  "title": "abe1.…",
  "input": "abe1.…",
  "status": "needs-me",
  "createdBy": "user",
  "priority": "normal",
  "model": null,
  "effort": null,
  "autoDone": false,
  "closed": false,
  "machine": "laptop",
  "sessionId": "591d2ec1-d4ab-4e26-ac04-ed303f8fa44a",
  "workdir": "abe1.…",
  "pr": null,
  "prState": null,
  "prs": [],
  "promptPrState": null,
  "next": "fresh",
  "head": "abh1.…",
  "openQuestion": true,
  "requestedLane": null,
  "lane": null,
  "borrowed": false,
  "lastActiveAt": null,
  "runStartedAt": null,
  "paused": false,
  "notBefore": null,
  "scheduleId": null,
  "wakeAt": null,
  "waitCheck": false,
  "woken": false,
  "watchStops": []
}
```

The fields of the example are required, with these exceptions:

| Key                    | Absent when                                 | A client reads absent as        |
| ---------------------- | ------------------------------------------- | ------------------------------- |
| `model`                | the server lacks `task.model`               | `null`                          |
| `effort`               | the server lacks `task.effort`              | `null`                          |
| `requestedLane`        | the server lacks `task.lane`                | `null`                          |
| `autoDone`             | the server lacks `task.auto-done`           | `false`                         |
| `movedBy`              | no status change yet, or no `task.moved-by` | no actor                        |
| `pr`                   | the server lacks `task.pr`                  | `null`                          |
| `prState`              | the server lacks `task.pr-state`            | `null`                          |
| `prs`, `promptPrState` | the server lacks `task.prs`                 | `pr` and `prState` as one entry |
| `agent`                | the task has no agent                       | no agent                        |
| `icon`                 | the server lacks `task.icon`                | no icon                         |
| `labels`               | the server lacks `task.labels`              | no labels                       |
| `run`                  | the task is not running, or no `task.run`   | no run                          |
| `stopRequested`        | the server lacks `run-inbox`                | `false`                         |
| `noteCount`            | the server lacks `task.note-count`          | unknown                         |
| `watches`              | the task has none, or no `task.watches`     | `null`                          |
| `watchStops`           | the server lacks `task.watches`             | `[]`                            |
| `forkOf`               | the task is no fork, or no `task.fork`      | not a fork                      |

The CLI's plaintext `Task` adds `skillLabels` (the skill the prompt starts with, see `taskLabels`) and `unreadable`, and holds `icon` and `labels` opened.

### Identity and content

| Field           | Meaning                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | Opaque and stable for the life of the task. The client that makes the task chooses it: 12 random characters.                                                |
| `title`         | Sealed for the task, or for its schedule on an occurrence. One line, shown in lists.                                                                        |
| `input`         | Sealed for the task and its creator, or for its schedule and `user` on an occurrence. What to work on.                                                      |
| `createdBy`     | `user`, `agent` or `intake`. Part of the context of `input`, so a changed value makes the task unreadable.                                                  |
| `agent`         | Sealed, or absent. The name of the agent the task runs as. Needs `task.agent`.                                                                              |
| `icon`          | Sealed, or `null`. One emoji the user chose for the card. Display only: one that does not open as one emoji reads as none. Needs `task.icon`.               |
| `labels`        | Sealed, or `null`. The user's labels, one JSON list. Display only: a value that does not open as a list of labels reads as none. Needs `task.labels`.       |
| `model`         | The Claude model of the task's runs, or `null` for claude's default. Clear, not sealed: it is a choice, not content.                                        |
| `effort`        | The effort level of the task's runs, or `null` for claude's default. Clear, not sealed: it is a choice, not content. Needs `task.effort`.                   |
| `requestedLane` | The lane the user asked for, or `null` for the default lane. Clear, not sealed: it is routing. Needs `task.lane`. Not the lane it runs in, which is `lane`. |
| `head`          | The blind index (`abh1.…`) of `head:<sha>` for the version a task was made for (`board schedule --version`), or `null`.                                     |
| `autoDone`      | Whether the task's agent may move it to Done itself. Clear, not sealed: it is a choice, not content. Needs `task.auto-done`.                                |
| `forkOf`        | The id of the task this one was forked from, or absent. Clear. Needs `task.fork`.                                                                           |

- **`id`.** The client chooses it because the sealed fields are bound to it. It ends up in a systemd unit name, a log file name and argv. So the core refuses any id that does not match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, and the ids `dispatch` and `intake`.
- **`createdBy`.** `agent` is a proposal the user has not started. No worker runs it, and starting it changes it to `user` with the prompt sealed again. `intake` is only on the tasks of the removed built-in intake: with an agent they run as it, and without one no worker runs them.
- **`agent`.** The name matches `^[a-z0-9][a-z0-9-]{0,31}$` and names an agent the machine defines. It is sealed under the row's origin, which is `task:<id>`, or `schedule:<scheduleId>` for an occurrence. It is also written into the context of `input`, so a task whose agent was dropped or changed is unreadable (see [Encryption](encryption.md#encryption)). A client that opens it sets `agent` on its plaintext task. A task whose `agent` is unreadable lists `agent` in `unreadable` and is never run.
- **`model`.** An alias such as `fable`, `opus`, `sonnet` or `haiku`, or a full name such as `claude-opus-5-5` or `claude-sonnet-5-5[1m]`. It must match `^[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,63}$`, else the CLI refuses the answer. The worker checks it again before it reaches argv as `claude --model`. A schedule's occurrences all take the schedule's model.
- **`effort`.** One of `low`, `medium`, `high`, `xhigh` or `max`, else the CLI refuses the answer. The worker checks it again before it reaches argv as `claude --effort`. A schedule's occurrences all take the schedule's effort, and a fork takes its parent's.
- **`requestedLane`.** See [Lane](#lane).
- **`autoDone`.** See [Auto-done](#auto-done).
- **`forkOf`.** A task id (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`), checked again by the client. Only the browser sets it, through `tasks.fork`; `add-task` has no such key and a draft that names one is 400, so an agent can never make a fork. See [Forks](#forks).
- **`head`.** A script compares it with the blind index of the PR's head (`Backend.indexHead`) to see that the head moved. The sha itself is never stored.

### State

| Field          | Meaning                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| `status`       | One of `backlog`, `todo`, `running`, `waiting`, `needs-me`, `done`.                       |
| `priority`     | One of `urgent`, `high`, `normal`, `low`.                                                 |
| `closed`       | `true` for a task out of the workflow. Closed tasks are only listed with `all`.           |
| `next`         | `fresh` or `resume`: what the next run does.                                              |
| `openQuestion` | The agent's last question has no answer yet.                                              |
| `notBefore`    | Todo only: no machine may claim the task before this time, ISO 8601. Otherwise `null`.    |
| `scheduleId`   | The schedule the task is an occurrence of, or `null`.                                     |
| `paused`       | The last run gave up its slot (`pause`) and the task has not run since.                   |
| `woken`        | The task's wait ended into Todo and it has not run since.                                 |
| `wakeAt`       | Waiting only: when the wait ends at the latest, ISO 8601. Otherwise `null`.               |
| `waitCheck`    | Waiting only: a check on `machine` may end the wait earlier. Otherwise `false`.           |
| `noteCount`    | Optional. The number of notes `read-notes` gives for this client, a non-negative integer. |
| `held`         | Optional, `true` only. A Todo task whose schedule is at its `maxConcurrent` limit.        |

- **`closed`.** The core never starts, requeues or writes to a closed task.
- **`notBefore`.** The server clears it whenever the task leaves Todo, the claim included.
- **`scheduleId`.** The server sets it when a schedule makes the task. No draft or patch can set it. It stays when the schedule is removed, because the occurrence's sealed fields are bound to it.
- **`paused` and `woken`.** Both stay `true` through the claim, so the worker that resumes the task can tell the agent. The worker's first `update-task` of the run clears them, as does the task leaving Running another way. `woken` is also cleared when the task leaves Todo another way. The board's "Paused" badge is narrower than `paused`: it shows only in Todo. A wait ends into Todo by `wake`, Wake now, a reply or a drag.
- **`wakeAt`.** A timer's end or a check's timeout. The server clears it whenever the task leaves Waiting.
- **`waitCheck`.** The check's command is never sent to the board.
- **`held`.** Present, as `true`, on a task in Todo that is not closed and whose schedule has a `maxConcurrent` limit that other tasks of it already use (Running or Waiting), whether the task is due or not. `claim-task` refuses it then, and a dispatcher need not try. Absent otherwise, and from a server without `task.held`. `list-tasks` computes it for the whole list with one query.
- **`noteCount`.** Notes are never deleted, so it only grows. A client that keeps the number sees that the thread grew when it rises, and reads `read-notes` (oldest first) from the old count up to the new one. `list-tasks`, `get-task` and every command that returns a task answer it. The browser's own API does not carry it.

### Run

| Field           | Meaning                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `machine`       | The machine that claimed it last, or `null`. A resume runs only there.                                      |
| `sessionId`     | The Claude session of the last skill run, or `null`. A UUID.                                                |
| `workdir`       | Sealed, or `null`. The directory that session was in when it last stopped, on `machine`.                    |
| `lane`          | While running: the lane that runs it, from the last heartbeat. Otherwise `null`.                            |
| `borrowed`      | While running: the lane borrowed it. Otherwise `false`.                                                     |
| `lastActiveAt`  | While running: the last heartbeat, ISO 8601. Otherwise `null`.                                              |
| `runStartedAt`  | While running: when the worker claimed it, ISO 8601. Otherwise `null`.                                      |
| `run`           | Optional. While running on a server with `task.run`: the run's id, new with every claim. See [Runs](#runs). |
| `stopRequested` | Optional. While running: the user asked for an interrupt and no worker has acknowledged it yet.             |

- **`sessionId`.** The parser refuses anything but a UUID, because the value goes into `--resume=<id>`. A worker resumes only a session it started itself for the task.
- **`workdir`.** An absolute path without control characters. A resume starts there (see [Where a task runs](workers.md#where-a-task-runs)).
- **`lane`.** A value of the shape of a machine name.
- **`run`.** 16 to 64 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`. The server makes 22 from 16 random bytes.
- **`stopRequested`.** A worker acknowledges the request with `ack-messages` and `stop`.

### Lane

`requestedLane` is the name of the lane the user wants a task to run in, or `null` for none. It is `null` by default. The user sets it in the browser, with `configure-task` (`board task set lane`) or with the `lane` key of `add-task` and `add-schedule`. A schedule copies it into every occurrence it makes. A task made by `add-task` inside a run does not take its parent's: the draft names a lane or the task has none. A fork takes its parent's, like the model.

The name has the shape of a machine name (`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`). It is a clear field, as routing is: the server checks the shape on every write, the CLI checks it again in every answer that carries it and refuses the answer otherwise, and a worker checks it before it uses it. A machine runs a task in the lane of that name when its `config.json` has one, and in its default lane otherwise (see [Lanes](workers.md#lanes)). `requestedLane` says nothing about the lane a task runs in now; that is `lane`.

`configure-task` changes it, or sets it back to `null`, in any status but `running`: a running task keeps the lane it started in, and the request is 409, with nothing in it written. A schedule's update changes the lane of the schedule, and of its pending card while the card is still editable. The change writes no note. `board schedule --key` on a task that already exists never changes its lane, and the lane is not one of the `exists` reasons.

The CLI sends `lane` only to a server that lists `task.lane`, and refuses with "the board server does not support choosing the lane a task runs in yet" otherwise. It never sends `lane: null` unasked.

The machine's own lane names reach the board in the sealed `machine.catalog` document, as `lanes` (at most 20 names of the same shape, in config order), so the forms can offer them. See [Skills and models on the board](workers.md#skills-and-models-on-the-board). A document without `lanes`, from an older CLI, offers none.

### Auto-done

`autoDone` is a boolean on a task and on a schedule, `false` by default. When it is `true`, the task's agent may move the task from `running` to `done` itself. The user sets it: in the browser, with `configure-task` (`board task set auto-done`) or with the `autoDone` key of `add-task` and `add-schedule`. A schedule copies it into every occurrence it makes. A fork does not inherit it.

The setting changes in any status, a running task included, and writes no note. It is a clear field, so the CLI of a machine reads it without opening anything.

**What the server does with a move to Done.** Only an `update-task` that names a `run` is the agent's. It is the one case where the setting counts:

- With `autoDone` `false`, the server answers 403 `This task is not set to finish by itself: move it to needs-me, and the user marks it done.` and changes nothing. The message is for the agent. It reads the setting when the call arrives, so turning the option off during a run takes effect at once.
- With `autoDone` `true`, the server moves the task to the top of Done and writes the plain server event `Moved from running to done.` into the thread. There is no event text of its own. The rule about pending messages comes first: with messages the run never received, the task goes to the top of Todo instead and no `moved` event is written.
- A call without `run`, from a script or a terminal, moves the task as before, whatever the setting.

The CLI sends `autoDone` only to a server that lists `task.auto-done`, and refuses with "the board server does not support letting the agent move a task to Done yet" otherwise. It never sends `false` unasked.

### Who moved a task

`movedBy` is one of `user`, `agent` and `machine`: who made the task's last status change. It is clear, and absent until the first change. A change that keeps the status leaves it as it was. A client reads a value it does not know as absent, so a later actor does not break it. Needs `task.moved-by`.

| Actor     | Set by                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`    | Everything in the browser: a drag, Done, a reply or an answer that resumes the task, Stop, Take back, Wake now and Re-run.                                                            |
| `agent`   | `update-task` with a `run` that changes the status, `ask` and `wait`.                                                                                                                 |
| `machine` | `claim-task`, `wake`, `fail`, `pause` and `stopped`, and `update-task` without `run`, which covers a script's `board move`, a keyed requeue of `board schedule --key` and a terminal. |

`board events` prints it as the `actor` of a `moved` event.

### Pull requests

| Field           | Meaning                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `prs`           | A list of `{"id", "pr", "state"}`, oldest first: one for each PR the task's agent reported with `add-pr`. At most 20. |
| `promptPrState` | `open`, `merged`, `closed` or `null`: the state of the PR the task's prompt names.                                    |
| `pr`            | Legacy. Sealed, or `null`: the `pr` of the newest entry of `prs`.                                                     |
| `prState`       | Legacy. The `state` of the newest entry of `prs` when the task has entries, else `promptPrState`.                     |

An entry of `prs`:

- `id` is the entry's id, which `set-pr-states` and `remove-pr` name. It has the characters of a task id, and the parser refuses any other.
- `pr` is the sealed URL of that PR, sealed for the task and its agent (`task:<id>:agent`). A client shows it only when it opens under that binding to `https://github.com/<owner>/<repo>/pull/<number>`, and drops an entry that does not.
- `state` is `open`, `merged`, `closed` or `null`.

A state is GitHub's state as a worker's dispatcher last saw it, and `null` while unknown. It is clear, not sealed (see [Encryption](encryption.md)).

`pr` and `prState` are what a CLI without `task.prs` reads as the task's one PR and its state. A client with `task.prs` ignores them.

### Watches

| Field        | Meaning                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `watches`    | Optional. Sealed, or `null`: the watches the task's machine runs for it, as it last published them with `set-watches`.       |
| `watchStops` | The ids of the watches the user asked to stop that the machine has not acknowledged with `ack-watch-stops` yet. Often empty. |

The sealed `watches` is one envelope for the task and its agent (`task:<id>:agent`). It holds `{"watches": [{"id", "name", "kind", "label", "status", "deadline", "lastAttemptAt"?}], "pendingEvents": n}`:

- `id` is 16 lowercase hex digits and `name` a watch name (`^[a-z0-9][a-z0-9-]{0,31}$`).
- `kind` is `ci`, `command`, `timer`, `pr-review` or `pr-merged` (the merge or close of a PR). A client drops an entry whose kind it does not know.
- `label` is what it watches and `status` its state. Each is one line, at most 120 and 200 characters.
- `deadline` and `lastAttemptAt` are ISO 8601.
- At most 32 entries.
- `pendingEvents` is the number of undelivered events of the whole task, a non-negative integer, and absent counts as 0. A watch is claimed when its event fires, so the count belongs to the task and not to a watch.

A client shows an entry only when it has that shape. A list that does not open is unreadable (`watches` in `unreadable`). The command a watch runs and its output are never in it.

`watchStops` is clear: at most 32 ids of 16 lowercase hex digits. The server clears it with `watches` when the task goes to Done or Backlog, is closed or is re-run fresh.

### Forks

A fork is a task whose first run continues a copy of another task's Claude session. It has `forkOf` (the parent's id), a `parentId` of the same value that the board shows as its parent while the parent exists, the parent's `machine`, `model` and `effort`, and the parent's directory as `workdir`. It does not take the parent's `autoDone`: that is `false`. Its `agent` is the parent's, sealed again for it.

- **The prompt is bound to the link.** `input` is sealed under `<origin>:<creator>:fork:<parentId>`, and with an agent `<origin>:<creator>:fork:<parentId>:agent:<name>`. A client opens it under the `forkOf` the board shows (see [Forks](encryption.md#forks)), so a task whose link the server dropped, added or changed is unreadable. A CLI that does not know the field cannot open the prompt, and its dispatcher skips the task.
- **What the worker does.** A start-over of a fork reads the parent with `get-task` and requires its `sessionId` to be one this machine started for it. It then runs `claude -p --resume=<parent session> --fork-session --session-id=<new uuid>` and stores the new id on the fork with `update-task`, as a fresh run does (see [Workers](workers.md#how-a-task-runs)). A parent that is gone (404), has no session or ran on another machine blocks the run, and the worker fails the task with the reason.
- **The patch seal.** `patch.seal` in the CLI's `update-task` states `forkOf` (`null` for none) next to `createdBy`, `scheduleId` and `agent`, so a new `input` stays readable.

### Pickup order

Pickup order is the order of the array that `list-tasks` returns. Within a status, the first task is the top.

- **Todo.** Resumes (`next: resume`) come first, then `priority`, then manual order. The lanes pick from that order.
- **Delayed tasks.** A task with `notBefore` in the future comes last in Todo, by `notBefore`. Once due it sorts like any other. The dispatcher does not try to claim a delayed task.
- **Waiting, Needs me, Done.** The task updated last (`updatedAt`) is on top, whatever its priority. Nothing claims a task in Waiting.

## Schedule

```json
{
  "id": "Sc3dEf9x",
  "title": "abe1.…",
  "input": "abe1.…",
  "priority": "normal",
  "model": null,
  "effort": null,
  "requestedLane": null,
  "autoDone": false,
  "machine": "laptop",
  "workdir": "abe1.…",
  "everyMs": 7200000,
  "cron": null,
  "timezone": null,
  "after": null,
  "maxConcurrent": null,
  "anchorAt": "2027-01-01T08:00:00.000Z",
  "nextRunAt": "2027-01-01T10:00:00.000Z",
  "remaining": 3,
  "until": null,
  "paused": false,
  "ended": false,
  "occurrenceTaskId": "Ab3dEf9x",
  "createdAt": "2026-11-14T10:00:00.000Z"
}
```

The fields of the example are required. A missing `model`, from a server without `task.model`, reads as `null`, and so do a missing `effort` (without `task.effort`), a missing `requestedLane` (without `task.lane`), `after` and `maxConcurrent`. A missing `autoDone`, from a server without `task.auto-done`, reads as `false`. A schedule with an agent adds a sealed `agent`, which a server without `task.agent` leaves out, one with an icon a sealed `icon`, which a server without `task.icon` leaves out, and one with labels a sealed `labels`, which a server without `task.labels` leaves out.

| Field                       | Meaning                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `id`                        | Chosen by the client, as for a task.                                                      |
| `title`, `input`, `workdir` | Sealed for the schedule.                                                                  |
| `machine`, `workdir`        | Pin the occurrences. Both set, or both `null`.                                            |
| `everyMs`                   | An interval in ms, at least one minute, on the grid `anchorAt + k * everyMs`.             |
| `cron`, `timezone`          | A 5-field expression, read in the IANA zone `timezone`. A cron rule needs its zone.       |
| `moreCrons`                 | Optional: up to 9 more expressions, read in the same zone. Absent with one expression.    |
| `after`                     | `{"scheduleId", "delayMs"}`: the schedule this one runs after, and the delay in ms.       |
| `maxConcurrent`             | At most this many of its tasks Running or Waiting at once, 1 to 100. `null`: no limit.    |
| `anchorAt`                  | The first run of an interval, or the time a cron rule matches from.                       |
| `nextRunAt`                 | The start time of the pending occurrence, read from its task, so a changed delay shows.   |
| `occurrenceTaskId`          | The task of the pending occurrence.                                                       |
| `remaining`                 | The number of occurrences still to be made after the pending one. `null` means forever.   |
| `until`                     | The last time an occurrence may start.                                                    |
| `paused`, `ended`           | A paused schedule makes no occurrence until it is resumed. An ended one makes none again. |

Exactly one of `everyMs`, `cron` and `after` is set. A schedule with several cron expressions runs whenever any of them matches: `cron` is the first, so a CLI that predates `moreCrons` still parses and lists it (and shows the first only), and `moreCrons` goes only with `cron`. `schedule.crons` names the key.

`nextRunAt` and `occurrenceTaskId` are both `null` while the schedule is paused with nothing waiting, while a schedule that runs after another waits for it, and once it has ended. `nextRunAt` alone is `null` when the pending task has no start time any more, because it was told to run now. It is due now.

### Occurrences

A schedule has at most one pending occurrence. It is a task in Todo with `scheduleId` set and `notBefore` at `nextRunAt`, until someone changes that.

- Its `createdBy` is `user`.
- Its `title`, `input`, `workdir` and `agent` are the schedule's ciphertext, copied unchanged and opened against the schedule's id.
- The worker may later replace the directory with one sealed for the occurrence and its schedule (see [Encryption](encryption.md#encryption)).

When that task leaves Todo, the server makes the next one in the same transaction. A claim, `update-task`, a move and a close all count. The next occurrence is the first match of the rule after the previous occurrence's time that is not in the past, so missed runs are skipped.

With nothing left, the schedule ends (`ended: true`) and makes no more. That is when `remaining` is used up, or the next match lies after `until`.

A task that was an occurrence and returns to Todo later does not trigger another. Only the pending one does.

**A limit.** With `maxConcurrent`, `claim-task` of any task of the schedule (a first start and a resume) is refused with 409, like a lost claim, while that many other tasks of it are Running or Waiting. The server takes the schedule's row lock for the count, after the task's lock, so two machines claiming two cards at once cannot both pass. The pending card stays in Todo, due, with `held: true`, and the next occurrence is made when it is claimed. A card whose schedule was deleted is never held. The limit is not part of a schedule's rule and cannot be changed.

**After another schedule.** A schedule with `after` has no pending occurrence while it waits. When `update-task` moves a task of the upstream schedule from Running to Needs me or Done, which is how a run hands the card back as done work, the server makes the dependent's occurrence in the same transaction: a Todo task with `notBefore` at the finish time plus `delayMs`, and none when the delay is 0. Any `update-task` that moves a Running task to Needs me or Done counts, which includes `board move <id> done` typed in a terminal. A question, `fail`, `stopped`, `pause`, `wait`, the browser's moves and stops, and a card that never ran do not count. The server stores when a task first finished (`occurrence_finished_at`, never sent), so each task triggers once, however often it is replied to. An upstream that has ended still triggers when a task of it that was under way finishes. A dependent that is paused or ended, or that already has a pending occurrence, makes none. `remaining` counts the occurrences made, and an occurrence that would start after `until` ends the schedule instead. When the pending occurrence leaves Todo the server makes nothing and clears `occurrenceTaskId`, ending the schedule when `remaining` is 0. Resuming a paused dependent makes no occurrence.

## Note

```json
{
  "id": "n1",
  "body": "abe1.…",
  "preview": "abe1.…",
  "createdAt": "2026-11-13T10:00:00Z",
  "author": "agent",
  "kind": "comment"
}
```

| Field                              | Meaning                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `author`                           | `agent`, `user`, `system` or `server`.                                               |
| `kind`                             | `comment`, `question`, `answer`, `event` or `polish`.                                |
| `body`                             | Sealed for its task, author and kind. Plain text on a `server` note.                 |
| `preview`                          | A sealed preview, or `null`.                                                         |
| `suggestion`                       | Optional, on a comment by the agent: a sealed reply drafted for the user.            |
| `questions`                        | On a question note: sealed JSON, the list `ask` took.                                |
| `answers`                          | On an answer note: sealed JSON, `{"questions": [...], "answers": [...]}`.            |
| `questionNoteId`                   | On an answer note: the question it belongs to. It only informs.                      |
| `pending`, `deliveredAt`, `queued` | Optional, on a message to a running agent. Absent from a server without `run-inbox`. |

- **Server notes.** The body of an `author: "server"` note is one of the fixed event texts (see [Encryption](encryption.md#encryption)).
- **Answers.** `answers` holds one `{"selected": [labels], "other"?: text}` per question.
- **The plaintext `Note`.** The CLI's `Note` has `text` instead of `body`, keeps a server event as `author: "server"`, gives an answer note the `questions` from its own envelope, and adds `unreadable`.

### Messages to a running agent

A message the user sent to a running agent with Send or Stop & send carries three more keys:

- `pending: true` until a worker acknowledges the note with `ack-messages`, or until the run ends (see [Pending messages when a run ends](#pending-messages-when-a-run-ends)).
- `deliveredAt` (ISO 8601) once a worker handed it over mid-run.
- `queued: true` on every note written to a running agent. It is never cleared.

### What a resume prompt carries

A resume prompt is built from the `user` notes after the last `agent` note. Two rules adjust that:

- It leaves out a note with `deliveredAt`, because the agent has it already.
- It adds the `queued` notes without `deliveredAt` written since the previous run started, wherever they fall in the thread.

## Commands

| Command             | Request                                                                                                                                                                                                                                       | `result`                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `version`           | -                                                                                                                                                                                                                                             | See [Version handshake](#version-handshake)                                                             |
| `list-tasks`        | `all?`                                                                                                                                                                                                                                        | `[Task, ...]` in pickup order                                                                           |
| `get-task`          | `id`                                                                                                                                                                                                                                          | `Task`                                                                                                  |
| `attach-session`    | `id`                                                                                                                                                                                                                                          | `Task`                                                                                                  |
| `add-task`          | `body`: `{"id", "title", "input", "status"?, "priority"?, "model"?, "effort"?, "lane"?, "autoDone"?, "dedupeKey"?, "parentId"?, "createdBy"?, "machine"?, "workdir"?, "agent"?, "head"?, "notBefore"?}`                                       | `{"task": Task, "created": bool}`                                                                       |
| `update-task`       | `id`, `body`: `{"status"?, "priority"?, "input"?, "sessionId"?, "workdir"?, "next"?, "head"?, "notBefore"?, "expect"?}`                                                                                                                       | the updated `Task`, or 409                                                                              |
| `configure-task`    | `id`, `body`: `{"priority"?, "model"?, "effort"?, "lane"?, "autoDone"?, "place"?}`                                                                                                                                                            | the updated `Task`, or 409                                                                              |
| `edit-prompt`       | `id`, `body`: `{"title", "input", "previous"}`                                                                                                                                                                                                | the updated `Task`, or 403 or 409                                                                       |
| `claim-task`        | `id`, `machine`                                                                                                                                                                                                                               | the claimed `Task`, or 409                                                                              |
| `add-note`          | `id`, `author?`, `kind?`, `body`: `{"body", "preview"?, "suggestion"?}`                                                                                                                                                                       | `null`                                                                                                  |
| `read-notes`        | `id`                                                                                                                                                                                                                                          | `[Note, ...]`, oldest first                                                                             |
| `ask`               | `id`, `body`: `{"body", "questions"}`                                                                                                                                                                                                         | `null`                                                                                                  |
| `add-pr`            | `id`, `body`: `{"pr"}`, the sealed PR URL                                                                                                                                                                                                     | `null`                                                                                                  |
| `remove-pr`         | `id`, `body`: `{"pr"}`, the id of an entry of `prs`                                                                                                                                                                                           | `null`                                                                                                  |
| `set-pr-states`     | `id`, `body`: `{"prompt"?, "prs"?: [{"id", "state"}]}`                                                                                                                                                                                        | `null`                                                                                                  |
| `set-pr`            | Legacy. `id`, `body`: `{"pr"}`, the sealed PR URL                                                                                                                                                                                             | `null`                                                                                                  |
| `set-pr-state`      | Legacy. `id`, `body`: `{"prState"}`                                                                                                                                                                                                           | `null`                                                                                                  |
| `set-watches`       | `id`, `body`: `{"watches"}`, the sealed document, or `null` to clear                                                                                                                                                                          | `null`                                                                                                  |
| `ack-watch-stops`   | `id`, `body`: `{"ids"}`, watch ids, at most 32                                                                                                                                                                                                | `null`                                                                                                  |
| `set-dirs`          | `body`: `{"dirs", "index"}`                                                                                                                                                                                                                   | `null`                                                                                                  |
| `set-catalog`       | `body`: `{"catalog", "index"}`                                                                                                                                                                                                                | `null`                                                                                                  |
| `set-usage`         | `body`: `{"usage", "index"}`                                                                                                                                                                                                                  | `null`                                                                                                  |
| `set-feeds`         | `body`: `{"feeds", "index"}`                                                                                                                                                                                                                  | `null`                                                                                                  |
| `ack-feed-requests` | `body`: `{"requests"}`, at most 150                                                                                                                                                                                                           | `null`                                                                                                  |
| `get-agents`        | -                                                                                                                                                                                                                                             | `{"version", "document"}`, or `null`                                                                    |
| `set-agents`        | `body`: `{"document", "version", "expectedVersion"}`                                                                                                                                                                                          | `null`, or 409                                                                                          |
| `get-title-rules`   | -                                                                                                                                                                                                                                             | `{"version", "document"}`, or `null`                                                                    |
| `apply-title-rule`  | `id`, `run`, `body`: `{"icon"?, "title"?, "expectTitle"?}`                                                                                                                                                                                    | `{"icon": bool, "title": bool}`, or 409                                                                 |
| `heartbeat`         | `id`, `body`: `{"lane": string, "borrowed": bool}`                                                                                                                                                                                            | `null`                                                                                                  |
| `pause`             | `id`, `body`: `{"body", "preview"?}`                                                                                                                                                                                                          | the updated `Task`                                                                                      |
| `fail`              | `id`, `body`: `{"body", "preview"?}`                                                                                                                                                                                                          | `{"applied": bool, "task": Task}`                                                                       |
| `stopped`           | `id`, `body`: `{"body", "preview"?}`                                                                                                                                                                                                          | the updated `Task`                                                                                      |
| `run-inbox`         | `id`                                                                                                                                                                                                                                          | `{"stop": bool, "stopMessage"?: noteId, "messages": [Note]}`                                            |
| `ack-messages`      | `id`, `body`: `{"ids": [noteId, ...], "stop"?: bool}`                                                                                                                                                                                         | `null`                                                                                                  |
| `wait`              | `id`, `body`: `{"body", "preview"?, "wakeAt", "check"}`                                                                                                                                                                                       | the updated `Task`                                                                                      |
| `wake`              | `id`, `body`: `{"body", "preview"?}`                                                                                                                                                                                                          | `{"applied": bool, "task": Task}`                                                                       |
| `transcript`        | `id`, `body`: `{"runId", "startedAt", "sessionId", "resumed", "events": [...]}`                                                                                                                                                               | `null`                                                                                                  |
| `add-schedule`      | `body`: `{"id", "title", "input", "everyMs"? \| "cron"? + "timezone" + "moreCrons"? \| "after"?, "maxConcurrent"?, "priority"?, "model"?, "effort"?, "lane"?, "autoDone"?, "machine"?, "workdir"?, "agent"?, "startAt"?, "times"?, "until"?}` | `{"schedule": Schedule, "task": Task \| null}`                                                          |
| `list-schedules`    | -                                                                                                                                                                                                                                             | `[Schedule, ...]`: running first, then paused, then ended                                               |
| `update-schedule`   | `id`, `body`: `{"paused": bool}`                                                                                                                                                                                                              | the updated `Schedule`                                                                                  |
| `edit-schedule`     | `id`, `body`: `{"title", "input", "settings"?}`                                                                                                                                                                                               | `{"schedule": Schedule, "pending": "updated" \| "started" \| "none" \| "removed" \| "created"}`, or 409 |
| `remove-schedule`   | `id`                                                                                                                                                                                                                                          | `null`                                                                                                  |

Every body is strict. An unknown key, a missing required key or a value of the wrong shape is a 400, and nothing is written. A sealed key that holds plain text, or an envelope over its limit (`SEALED_LIMITS`), is a 400 too. An unknown task or schedule is a 404.

### Fences and shared rules

**The machine fence.** `heartbeat`, `pause`, `fail`, `wait` and `wake` act only for the token's machine, the one whose claim holds the task (`machine`). A call from another machine gets the answer it would get had the task left `running` or `waiting`. A worker whose run was taken back and claimed elsewhere cannot touch the new run. `ask`, `stopped`, `run-inbox` and `ack-messages` are bound to the token's machine too, with the errors their sections name.

**The run fence.** With `run`, the same commands except `wake`, and `update-task`, also act only for that run. An earlier run on the same machine gets the answer another machine would get. See [Runs](#runs).

**The fences are not a boundary between machines.** They keep workers from tripping over each other. Every token of an owner can act on that owner's whole board:

- `add-task`, schedules, notes, `add-pr`, `remove-pr` and `set-pr` by design. The binding, not the token, says whose value a sealed field is.
- `update-task` without `run` on any task, a running one included, so that `board move` works from any machine.

A leaked token, with the data key from the same `env` file, controls the whole board until it is revoked on Settings › Machines.

**Entering `waiting`.** Only `wait` takes a task into `waiting`. `update-task` and `add-task` with that status are 400.

**Leaving `waiting`.** A task that leaves `waiting` for `todo` by a drag or a reply is woken: `woken: true`, and `next` as for `wake`. One that leaves it for another status just loses its wait.

**Leaving `running`.** The task loses `runStartedAt`, `run`, the lane details and the stop request.

#### Pending messages when a run ends

A run can end while the user's messages are still pending, because the worker never got to them. It had closed the agent's stdin, or it crashed. Those messages must not be lost. The server handles it in one place for every way out of Running: `update-task` (a move to Done by the agent included), `ask`, `wait`, `pause` and `fail`.

- The pending notes stop being pending. They are replies now, with no `deliveredAt`, so the resume prompt carries them.
- A task that would have gone to `needs-me`, `done` or `waiting` goes to the top of Todo instead, with `next: resume`, or `fresh` without a session.
- The open question and the wait go.
- The server event "Your message reached the agent after its run ended; resuming with it." goes into the thread.

This redirect applies only to a run whose worker has read `run-inbox`. The server remembers that for the run, and the worker reads the inbox once right after the process starts. A worker that never reads the inbox would not put the message into a resume prompt.

For any other run, and for the user's own stops (`stopped`, Take back), the pending notes become plain replies and the task goes where it was going. The next Send & continue carries them.

### Tasks

#### `list-tasks`, `get-task`, `attach-session`

`list-tasks` returns the open tasks in [pickup order](#pickup-order). With `all: true` it includes closed ones.

`attach-session` returns the task whose session the token's machine may attach to. It needs the `attach-session` feature.

| Status | When                                       |
| ------ | ------------------------------------------ |
| 404    | There is no such task.                     |
| 409    | The task is running, or it has no session. |
| 403    | Another machine ran it.                    |

#### `add-task`

Creates a task at the bottom of its status.

| Key                  | Rule                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | The client's, of the safe shape. A taken id is 409, whoever holds it, with the same message.                                                                              |
| `title`, `input`     | Sealed. An empty input is sealed too.                                                                                                                                     |
| `status`             | `backlog`, `todo` (the default) or `needs-me`. Anything else is 400: a task gets into `running`, `waiting` and `done` only through `claim-task`, `wait` and a close.      |
| `priority`           | Defaults to the parent's with a `parentId`, and to `normal` without.                                                                                                      |
| `model`              | A model name. Defaults to none, which is claude's default. Only for a server that lists `task.model`.                                                                     |
| `effort`             | `low`, `medium`, `high`, `xhigh` or `max`. Defaults to none, which is claude's default. Only for a server that lists `task.effort`; the CLI refuses to send it otherwise. |
| `lane`               | A lane name of the shape of a machine name. Defaults to none. Only for a server that lists `task.lane`; the CLI refuses to send it otherwise.                             |
| `autoDone`           | A boolean, default `false`. Only for a server that lists `task.auto-done`.                                                                                                |
| `createdBy`          | `intake`, `user` or `agent`. Defaults to `user`.                                                                                                                          |
| `machine`, `workdir` | Come together and pin the task there. `workdir` is sealed.                                                                                                                |
| `agent`              | Sealed. Only for a server that lists `task.agent`. The CLI refuses to send it otherwise.                                                                                  |
| `icon`               | Sealed: one emoji. Only for a server that lists `task.icon`. The CLI refuses to send it otherwise.                                                                        |
| `labels`             | Sealed: one JSON list of labels. Only for a server that lists `task.labels`. The CLI refuses to send it otherwise.                                                        |
| `dedupeKey`          | The blind index of the key (`abh1.…`).                                                                                                                                    |
| `head`               | The blind index of the sha (`abh1.…`).                                                                                                                                    |
| `notBefore`          | ISO 8601. Accepted only with status `todo`.                                                                                                                               |
| `parentId`           | The task this one follows up on.                                                                                                                                          |

- **Deduplication.** With a `dedupeKey` that a task already has, nothing is created. The answer is that task with `created: false`.
- **Proposals.** `createdBy: agent` makes the task a proposal. It lands in `backlog` whatever `status` the draft names. A draft with both `agent` and `createdBy: agent` is 400.

#### `update-task`

Changes a task. It needs at least one key besides `expect`.

| Key         | Rule                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------- |
| `status`    | A status. A change puts the task at the bottom of its new place. `waiting` is 400.        |
| `priority`  | A priority. A change puts the task at the bottom of its new place.                        |
| `input`     | Sealed.                                                                                   |
| `workdir`   | Sealed, or `null`.                                                                        |
| `sessionId` | A UUID, or `null`.                                                                        |
| `next`      | `fresh` or `resume`.                                                                      |
| `head`      | A blind index, or `null` to clear it.                                                     |
| `notBefore` | An ISO 8601 time, or `null` to clear it. A time is 409 unless the task ends up in `todo`. |
| `expect`    | A status the task must have. It is a condition, not a change.                             |

- **`expect`.** When the task's status differs under the update's lock, nothing is written and the answer is 409. `board move --expect` and the requeue of `board schedule --key` use it, so a move planned from an earlier listing cannot hit a task a dispatcher claimed since.
- **Proposals.** A status change of a proposal is 403.
- **Questions.** Leaving `needs-me` for `todo` or `done` clears `openQuestion`.
- **Runs.** With `run`, see [Runs](#runs).

#### `configure-task`

The user's edit of a task's settings, in one atomic step. It needs the `task.configure` feature, and the CLI refuses without it. The body needs at least one key.

- **`priority`** works as the board's priority picker does. The task goes to the bottom of its new band, and the server writes the `Priority a → b.` note. The same priority changes nothing.
- **`model`** is a model name (`isModelName`), or `null` for claude's default. It applies from the next run on and is allowed in any status.
- **`effort`** is an effort level (`low`, `medium`, `high`, `xhigh` or `max`), or `null` for claude's default. It applies from the next run on and is allowed in any status. It needs `task.effort`; the CLI refuses without it.
- **`lane`** is a lane name (`isSafeLane`), or `null` for the default lane. It applies from the next start on and is refused with 409 while the task runs. It needs `task.lane`; the CLI refuses without it.
- **`autoDone`** is a boolean. It applies at once and is allowed in any status, a running task included. It needs `task.auto-done`; the CLI refuses without it.
- **`icon`** is the sealed emoji, or `null` for none. It applies at once, is allowed in any status and writes no note. It needs `task.icon`; the CLI refuses without it.
- **`labels`** is the sealed JSON list of labels, or `null` for none, and replaces the task's. It applies at once, is allowed in any status and writes no note. It needs `task.labels`; the CLI refuses without it. The CLI seals with `sealLabels` (in `sealing.mts`), which turns an empty list into `null`. The binding is the task's origin, not its creator, so a worker may set the labels of the task it runs with the machine's token.
- **`place`** is `{"workdir": <sealed>}` or `null`. The directory is sealed under the task's `workdir` binding.

What `place` does:

- The machine is the token's own, never read from the body. A machine pins a task to itself only, and a `machine` key is 400.
- With a directory, the server sets `workdir` and `home_workdir` to the new envelope and `machine` to the token's machine. `home_workdir` is what Re-run fresh restores.
- With `null`, it clears `workdir`, `home_workdir` and `machine`.
- Either way it drops the session: `sessionId` is null, `next` is `fresh`, and pause and wake flags go.
- The status stays, so an open question in Needs me stays open.
- On a `running` or `waiting` task the whole request is refused with 409. Nothing is written, `priority` and `model` in it included. Without `place`, model, effort, auto-done and priority go through in any status, and a lane in any status but `running`.

There is no run fence. A run is not a caller of this command, and the CLI refuses it inside one.

The server writes no note for a model, effort or directory change. A server event text unknown to an installed CLI would not pass that CLI's check, and the priority note is the one text that exists.

The browser makes the same change with `tasks.configure`.

#### `edit-prompt`

The user's new title and prompt for a task that has not started, in one atomic step. It needs the `prompt.edit` feature, and the CLI refuses without it.

| Key        | Rule                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `title`    | Sealed under the task's own row.                                                                                                   |
| `input`    | Sealed under the task's own row, its creator `user`, its fork link and its agent, as the task's prompt is (see [Forks](#forks)).   |
| `previous` | A `{"body", "preview"?}` note input: the old title and prompt as a note of the `user`'s, kind `event`. `suggestion` is a 400 here. |

The step is refused, and nothing is written, with:

- 403 for a task whose `createdBy` is not `user`, and for a proposal;
- 409 for a card of a schedule, which takes its prompt from the schedule;
- 409 for a task a worker ever claimed (`lastActiveAt` or `sessionId` is set), even when it is back in Todo;
- 409 for a closed task, and for one that is not in `todo` or `backlog`.

On success the server stores the `previous` note and replaces `title` and `input`. The status, the position and the session stay.

This is the one command where a machine stores a note of the user's. `add-note` still refuses `author: "user"`. The server cannot tell the user from an agent that holds the token, so the CLI is what keeps an agent out: it refuses `board task set prompt` inside a board run. See [Encryption](encryption.md#what-the-bindings-stop), "Editing a prompt".

The browser makes the same change with `tasks.edit`.

#### `claim-task`

Moves a task from `todo` to `running` for the machine, at the bottom of running, in one atomic step. It sets `runStartedAt` and a new `run`. `paused` stays as it is.

A token claims for its own machine only. Another `machine` in the request is 403.

The claim is lost, with 409, when the task is not free for this machine:

- It is not in `todo`. A `backlog` task is never claimed.
- `notBefore` is in the future.
- It is a proposal, or any task whose `createdBy` is `agent`.
- It is a resume (`next: resume` with a session) pinned to another machine.
- It has a directory (`workdir` set) and its `machine` is another one.

So a claim planned before the user moved the task loses.

### Notes and questions

#### `add-note`, `read-notes`

`add-note` appends a note to a task's thread. Any token of the owner may call it.

| `author`          | `kind`              | Note                                                                        |
| ----------------- | ------------------- | --------------------------------------------------------------------------- |
| `agent` (default) | `comment` (default) | An agent comment.                                                           |
| `agent`           | `polish`            | A polish note. The sealed body is the JSON `{"target", "title", "prompt"}`. |
| `system`          | `comment` or absent | A system `event`.                                                           |

- A polish note from `system`, or any other `kind`, is 400.
- `body` is sealed. The CLI refuses an empty text before sealing.
- `preview` is the sealed start of the text, or absent. For a polish note it is the start of the prompt.
- `suggestion` is a sealed reply for the user. Only author `agent` may send one. It needs the `note.suggestion` feature.

`read-notes` returns the thread, oldest first.

#### `ask`

Adds a question note with the sealed questions and moves the task to `needs-me` with `openQuestion: true`. `body` is a sealed empty body, and `questions` is the sealed questions JSON.

- It acts on a running task of the token's machine only. Otherwise it is 409, with nothing written. With `run`, a later run of the task on the same machine is refused the same way.
- A proposal is 403.

The 409 stops a stale agent from pulling the task into Needs me with a question. Its run was taken back, the task finished, or the task runs again on another machine. `board ask` reports the 409 as a usage error that tells the agent not to ask again and to end its turn.

The CLI validates the questions before sealing, because the server cannot: 1 to 4 questions, a header of at most 16 characters, 2 to 4 options with different labels, and at most one `recommended`.

### Pull request commands

#### `add-pr`

Appends the sealed `pr` to the task's `prs` with an unknown state. It needs the `task.prs` feature.

- A task holds at most 20 PRs. The 21st is 400.
- The server cannot read the URL, so it cannot see that it repeats one. `board pr` reads the task first and sends nothing for a URL the task already lists.
- The CLI checks that the URL is a GitHub pull request before sealing.
- Like `add-note`, any token of the owner may call it.
- It sets `updatedAt` and sends the `tasks` event.

#### `remove-pr`

Deletes one entry of the task's `prs`. It needs the `task.pr-remove` feature. The CLI refuses without it and does not fall back.

- `pr` is the `id` of the entry. `board pr --remove` reads it from `get-task` after matching the URL.
- The server deletes the entry only if it belongs to this task.
- An id the task does not list changes nothing and is still 200, so a retry is safe.
- The PR the prompt names is not an entry and cannot be removed.
- It sets `updatedAt` and sends the `tasks` event.
- Any token of the owner may call it. The browser removes an entry the same way, because that deletes a row and seals nothing.

#### `set-pr-states`

Writes the states the dispatcher looked up on GitHub. It needs the `task.prs` feature. Only the dispatcher calls it (see [How it decides](workers.md#how-it-decides)).

The body is `{"prompt"?: state, "prs"?: [{"id", "state"}]}`, with at least one of the two keys, at most 20 entries, and each state `open`, `merged` or `closed`.

- `prompt` becomes `promptPrState`.
- Each entry sets the `state` of the entry of `prs` with that `id`.
- An `id` that is not one of this task's entries is ignored. So the call is safe to repeat, and an entry of another task is never touched.
- It changes nothing else: not the status, not `updatedAt`, not a running task's pause. A run is never disturbed.
- There is no way to clear a state.

#### Legacy: `set-pr` and `set-pr-state`

A CLI without `task.prs` sends these two. A current CLI sends them only to a server that lacks `task.prs`.

- **`set-pr`** needs the `task.pr` feature. It makes the sealed `pr` the task's only entry in `prs`, with an unknown state, and replaces the entries the task had. `promptPrState` stays. It has the errors and the `updatedAt` of `add-pr`.
- **`set-pr-state`** needs the `task.pr-state` feature. The body is `{"prState": "open" | "merged" | "closed"}`. It sets the `state` of the newest entry of `prs` when the task has entries, else `promptPrState`. Like `set-pr-states` it changes nothing else, and there is no way to clear the state.

### Watch commands

Both need the `task.watches` feature. The CLI sends nothing to a server without it. Only the task's own machine may call either (`machine` is the token's machine), else 409. Neither changes `updatedAt` or sends the `tasks` event, so a machine can publish as often as its watches change without waking every listener.

#### `set-watches`

Body `{"watches": string | null}`: the sealed `watches` document of the task (see [Watches](#watches)), or `null` to clear it.

- It works in any status of the task and stores or clears the column. Nothing else changes.
- 400 for a value that is not an envelope or is over `SEALED_LIMITS.watches` (32 KiB), and for any other key. 404 for an unknown task.
- The server cannot read the document. The browser and the CLI check its shape when they open it.

#### `ack-watch-stops`

Body `{"ids": string[]}`, at most 32 watch ids. They leave the task's `watchStops`.

- An id that is not pending changes nothing, and an empty list is fine, so a retry is safe.
- 400 for an id that is not a watch id, for more than 32 ids and for any other key. 404 for an unknown task.

The user's Stop adds an id to `watchStops` through the browser (`tasks.stopWatch`, only for a task that has a machine and is not done or closed, at most 32 waiting). That sends the `tasks` event, so the machine's listener ticks within a second, ends the watch, tells the agent and acknowledges (see [Publishing and stops](workers.md#publishing-and-stops)).

### Machine documents

`set-dirs`, `set-catalog`, `set-usage` and `set-feeds` each replace one sealed document of the token's own machine. They share these rules:

- The token names the machine. That row is the only one the command touches, and a `machine` key is not read.
- The body holds the sealed document and `index`, its blind index (`abh1.…`). The server stores both with the time.
- The document is bound to `machine:<name>`, so it opens neither as another machine's nor as one of the other documents.
- The server returns the stored index in the `version` answer. The CLI sends the document again only when that index differs from the index of what it would send.
- The command sends no `tasks` event.
- No CLI reads a document back, and no run depends on one.
- Revoking a machine, or issuing it a new token, clears all of them.

| Command       | Feature           | Sealed key | Blind index of                 | Size limit |
| ------------- | ----------------- | ---------- | ------------------------------ | ---------- |
| `set-dirs`    | `machine.dirs`    | `dirs`     | `dirs:<machine>:<document>`    | 256 KiB    |
| `set-catalog` | `machine.catalog` | `catalog`  | `catalog:<machine>:<document>` | 256 KiB    |
| `set-usage`   | `machine.usage`   | `usage`    | `usage:<machine>:<document>`   | 64 KiB     |
| `set-feeds`   | `machine.feeds`   | `feeds`    | `feeds:<machine>:<document>`   | 192 KiB    |

#### `set-dirs`

The directory list, as advice for the New task form's Working directory field. The machine's own `config.json` is what workers enforce.

```json
{ "dirs": [{ "path": "/abs/path", "label": "Board" }] }
```

`label` is there only when the directory has one.

A CLI sends the list when `config.json` has a `dirs` key: at the start of a dispatch tick, and after a `board dirs` change.

#### `set-catalog`

The machine's skills and models, as advice for completing `/skill` in a prompt or reply and for offering models (see [Skills and models on the board](workers.md#skills-and-models-on-the-board)).

```json
{
  "claude": "2.1.326",
  "models": [{ "value": "…", "label": "…", "description": "…" }],
  "skills": [{ "name": "…", "description": "…", "argumentHint": "…" }],
  "dirs": { "/abs/path": [{ "name": "…" }] },
  "agents": { "version": 4, "hashes": { "reviewer": "<64 hex>" }, "replaced": ["reviewer"] }
}
```

- `skills` are the skills every directory the machine asked about has. `dirs` lists, per directory, those only it has.
- `description` and `argumentHint` are optional.
- The caps are 50 models, 500 skills, 200 directories and 200 skills in one directory.
- A skill name is letters, digits and `_ . : -`, starts with a letter or digit, and has at most 100 characters.
- A description is one line of at most 200 characters, and an argument hint of at most 100.
- `agents` is what the machine has of the agents: the version of the [shared agents](#shared-agents) it applied (`null` for none), the hash of every agent it has, wherever defined, and the names whose local definition an apply moved aside. At most 500 agents. A CLI from before shared agents leaves the key out; one of the wrong shape loses only that key.

A reader opens it with `parseMachineCatalog` in `packages/shared/src/catalog.mts`. It drops an entry of the wrong shape and keeps the rest. A list over its cap makes the whole document unreadable. It ignores other keys, so a later CLI can add some.

The CLI composes the catalogue from what it has asked `claude`, at most one directory per dispatch tick.

The browser reads catalogues with `machines.catalogs`, a call of its own. It returns, for each machine that has one and is not revoked, its `name`, the sealed `catalog` and `catalogUpdatedAt`. It is not part of `machines.list`, which the board page polls.

#### `set-usage`

The machine's usage status, for the Held badge on a card and the usage line in Settings › Machines (see [Usage limits](workers.md#usage-limits)).

```json
{
  "limits": { "fiveHour": 80, "sevenDay": 90, "priority": "urgent" },
  "windows": { "fiveHour": { "percent": 85, "resetsAt": "…", "seenAt": "…" } },
  "reached": ["fiveHour"],
  "held": ["Ab3dEf9x"],
  "open": []
}
```

- `limits` is the machine's `usageLimits`, absent when it has none.
- `windows` holds the last reading per window, `fiveHour` and `sevenDay`.
- `reached` lists the windows at or over their threshold.
- `held` lists the Todo tasks the machine could serve and held back. `open` lists those it could serve and does not hold.
- Each of `held` and `open` has at most 500 ids.

A reader opens it with `parseMachineUsage` in `packages/shared/src/machineUsage.mts`. It drops an entry of the wrong shape and keeps the rest. A list over its cap makes the whole document unreadable.

The CLI sends it at the end of a dispatch tick, whether or not the machine has `usageLimits`.

#### `set-feeds`

The machine's [feeds](usage.md#feeds), for the Feeds page: each one's name, integration and action, timer, pause, what its last run did and its recent runs. The commands, the options and the plugin's commit, URL and description stay on the machine.

```json
{
  "feeds": [
    {
      "id": "0123456789abcdef",
      "name": "github-reviews",
      "integration": "mloureiro:github",
      "action": "list-pull-requests",
      "everyMs": 600000,
      "paused": false,
      "runAsked": false,
      "last": {
        "startedAt": "…",
        "at": "…",
        "ok": true,
        "listed": 3,
        "created": 1,
        "requeued": 0,
        "rescheduled": 1,
        "closed": 1,
        "failed": 0,
        "tasks": [{ "id": "…", "outcome": "created" }]
      },
      "history": [
        {
          "startedAt": "…",
          "at": "…",
          "ok": false,
          "invalid": true,
          "error": "…",
          "listed": 0,
          "created": 0,
          "requeued": 0,
          "rescheduled": 0,
          "closed": 0,
          "failed": 0
        }
      ]
    },
    {
      "id": "fedcba9876543210",
      "name": "slack",
      "everyMs": 0,
      "paused": false,
      "runAsked": false,
      "problem": "…",
      "history": []
    }
  ]
}
```

- `id` is 16 hex characters that the machine makes the first time it sees the feed and keeps in its state file. Requests name it, never the feed's name.
- `integration` is `<marketplace>:<integration>` and `action` the action's name; both are absent on a feed whose `config.json` entry cannot be read. `runAsked` says a run was asked for and has not happened yet.
- `problem` says why the `config.json` entry cannot be used; such a feed does not run. It is one line of at most 300 characters, a name at most 40.
- `last` is the most recent run: `error` (at most 300 characters, one line) says why it failed, `invalid` that the integration was refused (an unpinned or missing plugin) so nothing was listed, and `tasks` the ids of at most 20 tasks it touched, each with its `outcome` (`created`, `requeued`, `rescheduled` or `closed`). No titles go in. `history` holds the last 10 runs, newest first, in the same fields without `tasks` and with `error` at most 120 characters.
- At most 30 feeds, and the document at most 192 KiB. A feed of the wrong shape is dropped and the rest kept, and so is a task or a run of the wrong shape inside it; a longer list makes the document unreadable. A reader opens it with `parseMachineFeeds` in `packages/shared/src/machineFeeds.mts`, which is also where the machine checks the document before it seals it.

The dispatch tick sends the feeds when they changed, and the watch unit after every run.

**Requests.** The browser's `feeds.request` (a machine name, an `action` of `pause`, `resume` or `run`, and a feed `id`) adds `<action>:<id>` to the machine's pending requests and sends a `tasks` event, so the listener runs a dispatch tick. A request that already waits changes nothing. A pause and a resume of one feed replace each other. At most 150 wait per machine. The `version` answer lists them in `feedRequests`. The tick applies each one to its state file (a run happens on the watch unit's next look), answers `ack-feed-requests` with all it read, including those for a feed it does not have, and sends the feeds again. Revoking the machine clears them.

The browser reads feeds with `feeds.list`: for each machine that sent feeds and is not revoked, its `name`, the sealed `feeds`, `feedsUpdatedAt`, `feedRequests` and `lastSeenAt`.

### Shared agents

The agent definitions the user put on the board for every machine (see [Agents on the board](workers.md#agents-on-the-board)). They are one sealed document per user, not one row per agent: agent names are sealed on tasks and must not appear in the clear, and one document makes a push atomic.

```json
{ "version": 4, "agents": { "reviewer": { "description": "…", "tools": ["Read"], "allowedTools": ["…"] } } }
```

- The document is sealed as `agents.shared` with the context `agents:v<version>` (see [Encryption](encryption.md#the-agents-on-the-board)). The server keeps `version` in the clear beside it, so a tick compares versions without opening anything, and it cannot hand an old document out as a newer one.
- Each entry has exactly the keys of an agent file, without `name` and `source`. A machine reads each with the strict parser of an agent file and records `source: board` itself.
- At most 200 agents and 256 KiB. The server checks only that the document is a sealed value of that size; it cannot read it.
- The version is a counter from 1 that only goes up, one per push.

#### `get-agents`

No body. The answer is `{"version": 4, "document": "abe1.…"}`, or `null` when the user pushed none. Any machine of the user may read it.

#### `set-agents`

```json
{ "document": "abe1.…", "version": 5, "expectedVersion": 4 }
```

Compare-and-set. The server stores the document only while its stored version is still `expectedVersion` (`0` when it holds none), and the new version is `expectedVersion + 1`.

- 400 for a `version` that is not `expectedVersion + 1`, an `expectedVersion` below 0, a document that is not a sealed value or is too long, and any other key.
- 409 when the stored version moved on, because another CLI pushed first. The CLI fetches again and retries once.
- It sends the `tasks` event.

Only the CLI writes the document (`board agents push`, `board agents rm --board`); the browser never writes it. The browser reads it with `agents.shared`, a call of its own outside the machine API: `{"version", "document", "pushedAt"}` of the user's row, or `null`. It opens the document under `agents:v<version>` as a machine does and computes each agent's hash to compare with the hashes in the machines' catalogues (`machines.catalogs`). There is no browser call that writes it. Export and import of the account carry the row as the table `shared_agents`; an import into a board that has its own keeps the board's.

### Title rules

The rules that give a new task an icon and say how its title is written (see [The title rules](encryption.md#the-title-rules)). Like the shared agents they are one sealed document per user, but the user writes them in the browser and every machine's CLI reads them.

```json
{ "version": 3, "rules": [{ "pattern": "^/review ", "flags": "i", "icon": "🔎", "instruction": "…" }] }
```

- The document is sealed as `titles` with the context `titles:v<version>`. The server keeps `version` in the clear beside it, so a save is compare-and-set and the server cannot hand an old document out as a newer one.
- At most 50 rules and 512 KiB. A pattern has at most 300 characters and an instruction at most 2000. The server checks only that the document is a sealed value of that size.

#### `get-title-rules`

No body. The answer is `{"version": 3, "document": "abe1.…"}`, or `null` when the user saved none. Any machine of the user may read it.

Only the browser writes the document, with `titleRules.set` (compare-and-set on `expectedVersion`, 409 when another save came first). The browser reads it with `titleRules.get`: `{"version", "document", "updatedAt"}` or `null`. Both are calls of their own outside the machine API, and no machine command writes the document. Export and import of the account carry the row as the table `title_rules`; an import into a board that has its own keeps the board's.

#### `apply-title-rule`

```json
{ "id": "<task>", "run": "<run id>", "body": { "icon": "abe1.…", "title": "abe1.…", "expectTitle": "abe1.…" } }
```

Stores a sealed icon and/or title on the task the run belongs to. This is not `configure-task`: it never replaces what the user set, and it acts only for its run.

- `icon` is sealed as `icon` under the task's binding. It is stored only while the task has no icon.
- `title` is sealed as `title` under the task's binding. It needs `expectTitle`, the `title` envelope the caller opened and found to be the default, and `expectTitle` is refused without `title`. The title is stored only while the task still holds exactly that envelope, so a rename in the browser in between is not overwritten.
- At least one of `icon` and `title`. Any other key is 400.
- `run` is required: without it the answer is 400 `run is required`. The call acts only while the task is not running in a later run (409 `the task is running in a later run, not in this one`). A run that ended may still apply, since a short run can end before its title is written.
- A schedule's occurrence is 409, with the message of a rename: it takes its title and icon from its schedule.
- The answer is `{"icon": bool, "title": bool}`, each saying whether that part was stored. A part that was not stored is not an error.
- It writes no note, changes neither the status nor the position, and sends the `tasks` event only when something was stored.

### Run control

#### `heartbeat`

Sets `lastActiveAt` to now, with the lane, on a task running on the token's machine. On any other task it changes nothing. `lane` is a value of the shape of a machine name.

#### `pause`

Adds the sealed note as a `system` event. Then it moves the task to the top of Todo with `next: resume`, or `fresh` without a session, and sets `paused`. It acts on a running task of the token's machine only, else 409.

#### `fail`

In one step, if the task is still `running` on the token's machine and not closed, it adds the sealed note as a `system` event, moves the task to `needs-me` and answers `applied: true`. Otherwise it changes nothing and answers `applied: false` with the task as it is.

#### `stopped`

The worker ended the run on the user's request, with nothing to carry on with. It needs the `run-inbox` feature and follows the rule of `run-inbox`.

It adds the sealed note as a `system` event, moves the task to `needs-me` as the user asked, and clears the stop request. It is exempt from the [redirect for pending messages](#pending-messages-when-a-run-ends).

### The run inbox

Both commands need the `run-inbox` feature.

#### `run-inbox`

Returns the user's stop request and the messages not yet handed to the agent, oldest first. It acts on a running task of the token's machine only: 409 when the task is not running, 403 when another machine claimed it. A call also marks the run as one that reads its inbox.

- `messages` are the user's notes with `pending: true`, sealed as any note.
- `stop` is true while the user's stop request stands.
- With `stopMessage`, the id of one of `messages`, the request is Stop & send. The worker interrupts, hands over all the messages, and the run carries on.
- Without `stopMessage` the stop is plain. The worker interrupts, ends the run and hands nothing over, so earlier pending messages stay pending.

The worker reads the inbox on every watch tick and whenever the event stream says tasks changed. It answers with `ack-messages`.

#### `ack-messages`

Same rule as `run-inbox`.

- The listed pending notes stop being pending and get `deliveredAt`.
- Unknown ids and notes that are no longer pending are ignored.
- At most 100 ids. The list may be empty.
- With `stop: true` the stop request and its `stopMessage` are cleared, so a request is acted on once.

### Waiting

Both commands need the `wait` feature.

#### `wait`

Adds the sealed note as the agent's `comment`, sealed for author `agent` and kind `comment`. Then it moves the task to `waiting`. It acts on a running, open task of the token's machine only, else 409.

- `wakeAt` is ISO 8601, in the future and at most 7 days ahead, else 400.
- `check` becomes `waitCheck`.
- `next` becomes `resume`, or `fresh` without a session.

#### `wake`

In one step, if the task is still `waiting` on the token's machine and not closed, it adds the sealed note as a `system` event and moves the task to the top of Todo, with `woken: true` and `next: resume`, or `fresh` without a session. It answers `applied: true`. Otherwise it changes nothing and answers `applied: false`.

The note starts with `agent-board: wait over:`. The worker hands the rest of the newest such note since the agent last spoke to the resumed agent.

### `transcript`

Appends a run's condensed events (see `packages/shared/src/transcript.mts`). An event is `{"seq", "at", "kind", "parent", "data", "output"?, "outputSize"?}`.

| Key                    | Rule                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `events`               | At most 5000 per call.                                                                                    |
| `sessionId`            | A UUID or `null`.                                                                                         |
| `seq`                  | An integer from 0 to 2147483647.                                                                          |
| `at`                   | A parseable time.                                                                                         |
| `parent`               | `null`, or a tool use id of up to 256 letters, digits, `_` and `-`.                                       |
| `data`                 | The sealed JSON of the event without its output.                                                          |
| `output`, `outputSize` | Only on a `tool_result`: the sealed output and its length in characters. Any other event carries neither. |

- A value outside these rules fails the call with 400. The CLI drops a `parent` of any other shape to `null` before sending.
- A `context` event is the main agent's context window usage after an API message. A client sends it only to a server whose `features` has `transcript.context`: any other server refuses a batch holding an unknown kind. It carries no `output` or `outputSize`. The board's transcript view does not list it and a run's `eventCount` does not count it.
- The client counts `outputSize`. The server cannot read the output, so the number is bounded and nothing more.
- An event already stored, with the same run and `seq`, stays as it is. So a retried batch is harmless.

### Schedules

#### `add-schedule`

Makes the schedule and its first card in one transaction.

| Key                         | Rule                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `id`                        | The client's, as for `add-task`. 409 when taken.                                                              |
| `title`, `input`, `workdir` | Sealed.                                                                                                       |
| `agent`                     | Sealed. Only for a server that lists `task.agent`. The server copies it into every occurrence.                |
| `icon`                      | Sealed. Only for a server that lists `task.icon`. The server copies it into every occurrence.                 |
| `labels`                    | Sealed. Only for a server that lists `task.labels`. The server copies it into every occurrence.               |
| `lane`                      | A lane name, as for `add-task`. Only for a server that lists `task.lane`. Copied into every occurrence.       |
| `autoDone`                  | A boolean, default `false`. Only for a server that lists `task.auto-done`. Copied into every occurrence.      |
| `machine`, `workdir`        | Come together.                                                                                                |
| `everyMs`, `cron`, `after`  | Exactly one of them. `cron` needs its `timezone`, and `timezone` goes only with `cron`.                       |
| `moreCrons`                 | Only with `cron`, only for a server that lists `schedule.crons`: up to 9 expressions.                         |
| `after`                     | `{"scheduleId", "delayMs"?}`, only for a server that lists `schedule.after`. Delay 0 to 10 years, default 0.  |
| `maxConcurrent`             | 1 to 100, only for a server that lists `schedule.max-concurrent`.                                             |
| `startAt`                   | ISO 8601, default now. The first run of an interval, and the earliest match of a cron rule. Not with `after`. |
| `times`                     | A positive integer up to 2147483647: the number of occurrences in all.                                        |
| `until`                     | ISO 8601.                                                                                                     |

`times` and `until` exclude each other. Neither means forever.

With `after` the answer's `task` is `null`: the schedule has no occurrence until a task of the other one finishes.

The answer is 400, and nothing is written, for:

- a cron expression the server cannot read, 6-field patterns included;
- an unknown time zone;
- an interval under a minute or over 10 years (`MAX_INTERVAL_MS`);
- a rule with no run before `until`;
- a `moreCrons` entry the server cannot read, one that repeats another expression (compared field by field, ignoring spaces), or more than 10 expressions in all;
- an `after` that names the schedule itself, a schedule that does not exist or one that has ended (a paused one is fine, and so is one that itself runs after another).

#### `update-schedule`

- `paused: true` takes the pending occurrence off the board when it never ran: it is still in Todo and has no session and no run. Its run goes back to `remaining`.
- `paused: false` makes the next occurrence at the first match from now.
- An ended schedule is 409.
- Pausing a paused schedule, or resuming a running one, changes nothing.

#### `edit-schedule`

The user's new title and prompt for a schedule, and with `settings` every other setting too. It needs the `prompt.edit` feature, and `settings` the `schedule.update` feature.

- `title` and `input` are sealed under the schedule, with its agent, as `add-schedule` seals them.
- An ended schedule is 409, and an unknown one is 404.
- Every later occurrence copies the new ciphertext.
- The pending occurrence takes it too when it is in `todo`, open, and no worker ever claimed it. The answer says what became of it in `pending`: `updated`, `started` (it exists but was left alone) or `none` (the schedule is paused, or has nothing waiting).
- No note is written. A schedule has no thread, so the old text is not kept.

**With `settings`** the request replaces everything the user sets on the schedule, in one step, as the browser's `schedules.update` does (see [The Schedules page](usage.md#the-schedules-page)); a key that is not given is cleared or off, not kept, except `at`, `effort`, `lane`, `icon` and `labels`. Without `settings` the command behaves as above, and the agent stays.

| Key of `settings` | Value                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`?          | The agent, sealed (`agent`). Absent: none. `title`, `input`, `agent` and the directory are sealed together under `{kind: schedule, id, agent}`, so a new agent reseals the first two. |
| `place`           | `{"machine", "workdir"}`, the machine's name and the directory sealed (`workdir`), or `null` for no machine and directory.                                                            |
| `priority`        | A priority.                                                                                                                                                                           |
| `model`           | A model name, or `null` for claude's default.                                                                                                                                         |
| `effort`?         | An effort level, or `null` for claude's default. Absent keeps the schedule's. Only for a server that lists `task.effort`.                                                             |
| `lane`?           | A lane name, or `null` for the default lane. Absent keeps the schedule's. Only for a server that lists `task.lane`.                                                                   |
| `icon`?           | The sealed emoji, or `null` for none. Absent keeps the schedule's. Only for a server that lists `task.icon`.                                                                          |
| `labels`?         | The sealed JSON list of labels, or `null` for none. Absent keeps the schedule's. Only for a server that lists `task.labels`.                                                          |
| `autoDone`        | Boolean.                                                                                                                                                                              |
| `repeat`          | Exactly one of `{"everyMs"}` (1 minute to 10 years), `{"cron", "moreCrons"?, "timezone"}` (up to 9 more expressions) or `{"after": {"scheduleId", "delayMs"}}` (0 to 10 years).       |
| `at`?             | ISO date: the first run of an `everyMs` or `cron` rule. Absent keeps the schedule's. Not with `after`.                                                                                |
| `runsLeft`        | Runs the schedule still has, the pending occurrence included (a positive integer, at most 2147483647), or `null` for forever.                                                         |
| `until`           | ISO date after which no occurrence starts, or `null`. Not with `runsLeft`.                                                                                                            |
| `maxConcurrent`   | 1 to 100, or `null` for no limit.                                                                                                                                                     |

- Every key but `agent`, `effort`, `lane`, `icon`, `labels` and `at` is required; an unknown key anywhere in `settings` is a 400, as are both `runsLeft` and `until`, an interval or delay outside its range, and a cron expression or time zone the server cannot read.
- The pending occurrence takes the text, agent, directory, priority, model, effort, lane, icon, labels and auto-done while it is in `todo`, open and never claimed. It moves to the new next run when the rule, `at` or `until` changed. A rule that would never run before `until` is a 400, and so is an `after` that makes a circle or names a schedule that has ended.
- Moving from a rule of its own to `after` removes a pending occurrence that never started (`pending` is `removed`); moving back makes one (`created`). Only a request with `settings` answers `removed` or `created`.
- A CLI sends `settings` only when the server lists `schedule.update`, and announces `schedule.after` with its other capabilities, so a schedule that runs after another is in the answer.

#### `remove-schedule`

Deletes the schedule and a pending occurrence that never ran. Tasks that ran stay and keep their `scheduleId`. An unknown schedule is 404. A schedule that others run after is 409, naming them (up to 5 ids): delete those first. That holds for an ended one too.
