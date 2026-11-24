# UI API

The tRPC procedures the board's browser app calls, declared as a versioned API so another UI (a desktop client, say) can build on them. The machine API the CLI uses is separate: see [machine-api.md](machine-api.md).

## Transport

- tRPC over HTTP at `/trpc`. Plain JSON, no transformer.
- A query is a GET with the input in the `input` query parameter. A mutation is a POST with a JSON body.
- A POST must carry `Content-Type: application/json`. The server answers 415 to forms and other types.

## Authentication

- On a board with login, the session cookie that sign-in sets. Without a session, only the public procedures answer (`ui.version`, and the `auth.*` procedures that sign in).
- On a board without login (`NO_LOGIN_USER`), every request is that user.

## Version rule

Three numbers in `packages/shared/src/ui/version.mts` describe the API, apart from the machine API's:

| Name             | Meaning                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `UI_API_VERSION` | The version the server speaks. Today 1.                          |
| `MIN_UI_CLIENT`  | The oldest client the server accepts. Today 1.                   |
| `MIN_UI_SERVER`  | The oldest server a UI of this build works with. A UI checks it. |

A client declares its version in the `x-board-ui-api` request header, a positive integer. The header is opt-in: a request without it is never refused. A value that is not a positive integer is answered with 400.

## `ui.version`

A client calls `ui.version` first. It is public, so it answers without a session:

```json
{ "api": 1, "minClient": 1, "features": ["events"] }
```

The client stops when `api` is below its own `MIN_UI_SERVER`.

## Upgrade required

A request whose header is below `MIN_UI_CLIENT` is refused before any board data is read or written, on every procedure including `ui.version`. The answer is 412 with the message "This app is too old for this board. Update it." and `error.data.upgrade = { "minClient": <number> }`. The client shows that the app must be updated.

## Feature names

An additive change to the API adds a feature name to `ui.version`'s `features` and bumps no number. A client checks for the one name it needs and disables only that part when it is missing. `UI_FEATURE_LABELS` holds the phrase a client shows for each. Today the list is `events`: the live-update stream.

## Live updates

`GET /api/ui/events` is a stream of server-sent events that says "something on your board changed", so a client need not poll fast. It needs the `events` feature.

- **Auth.** The same as a procedure: the session cookie, or the no-login user. Without a user the answer is 401 `{ "error": "Sign in to use the board." }` and no stream starts.
- **Lines.** `: connected` when it opens, then `event: changed` followed by an empty `data:` line each time the user's board changes, and `: ping` every 25 s. Nothing else is ever written: the stream carries no data, so a client reads the board again with the procedures.
- **What changes it.** A committed mutation of the user, from the browser or the machine API. Reads and machine heartbeats do not. A burst of writes gives one event, half a second after the last. Another user's writes never reach the stream.
- **When it ends.** The user signs out, the session expires or is revoked (checked at each ping on a board with sign-in), the account is deleted (at once), the client leaves, or the server closes. A client that sees it end opens it again, and polls slowly while it is down: a missed event is not replayed.

The bundled web app keeps its own 5 s poll and does not use the stream.

## Procedures

Every procedure of the router, with its kind. A test fails when the router and this list disagree: `UI_PROCEDURES` in `packages/shared/src/ui/procedures.mts`.

### Top level

- `me` (query)
- `revision` (query)

### `account`

- `account.delete` (mutation)
- `account.export` (query)
- `account.import` (mutation)
- `account.summary` (query)

### `agents`

- `agents.shared` (query)

### `auth`

- `auth.config` (query)
- `auth.logout` (mutation)
- `auth.oidc.finish` (mutation)
- `auth.oidc.start` (mutation)
- `auth.passkey.login` (mutation)
- `auth.passkey.loginOptions` (mutation)
- `auth.passkey.signup` (mutation)
- `auth.passkey.signupOptions` (mutation)
- `auth.saml.finish` (mutation)
- `auth.saml.start` (mutation)

### `feeds`

- `feeds.list` (query)
- `feeds.request` (mutation)

### `keys`

- `keys.get` (query)
- `keys.replaceSlots` (mutation)
- `keys.setup` (mutation)

### `links`

- `links.get` (query)
- `links.set` (mutation)

### `machines`

- `machines.advertisedCli` (query)
- `machines.catalogs` (query)
- `machines.issue` (mutation)
- `machines.list` (query)
- `machines.revoke` (mutation)

### `passkeys`

- `passkeys.list` (query)
- `passkeys.register` (mutation)
- `passkeys.registerOptions` (mutation)
- `passkeys.remove` (mutation)
- `passkeys.rename` (mutation)

### `schedules`

- `schedules.list` (query)
- `schedules.remove` (mutation)
- `schedules.setPaused` (mutation)
- `schedules.update` (mutation)

### `tasks`

- `tasks.answer` (mutation)
- `tasks.applyPolish` (mutation)
- `tasks.configure` (mutation)
- `tasks.create` (mutation)
- `tasks.dismissQuestion` (mutation)
- `tasks.done` (mutation)
- `tasks.edit` (mutation)
- `tasks.fork` (mutation)
- `tasks.get` (query)
- `tasks.list` (query)
- `tasks.move` (mutation)
- `tasks.removePr` (mutation)
- `tasks.reply` (mutation)
- `tasks.rerun` (mutation)
- `tasks.send` (mutation)
- `tasks.setClosed` (mutation)
- `tasks.setNotBefore` (mutation)
- `tasks.setPriority` (mutation)
- `tasks.stop` (mutation)
- `tasks.stopWatch` (mutation)
- `tasks.takeBack` (mutation)
- `tasks.wakeNow` (mutation)

### `titleRules`

- `titleRules.get` (query)
- `titleRules.set` (mutation)

### `transcript`

- `transcript.context` (query)
- `transcript.events` (query)
- `transcript.output` (query)
- `transcript.runs` (query)

### `ui`

- `ui.version` (query)

## Shapes

Every procedure's input and output is declared by hand in `packages/shared/src/ui/wire.mts` and exported from `@agent-board/shared/ui` as `UiInputs` and `UiOutputs`, keyed by the dotted path (`UiInput<P>` and `UiOutput<P>` pick one). The file has no dependencies and no runtime code. A backend check, `apps/backend/src/trpc/uiConformance.ts`, runs inside `pnpm typecheck` and fails when the router and a declaration disagree: a declared input the router would reject, a router output that is not assignable to its declared output, a path of `UI_PROCEDURES` without a declaration, or a declaration for a path not in the list.

Conventions:

- `Envelope` is a sealed `abe1.…` string. Only the server's stored copy is opaque to it: a client seals before it sends and opens after it reads. The binding each sealed field is sealed under is named below (the `field` of the binding in `packages/shared/src/sealing.mts`; its context is built by the function named there).
- `IsoDate` is an ISO 8601 string: JSON has no dates. A date input also accepts what the server's date parser reads, but a client sends this form.
- Clear metadata stays clear by design: ids, `status`, `priority`, `model`, `effort`, lane names, machine names, flags, counters and every timestamp are never sealed, because the server routes, orders and schedules on them.
- A procedure that answers `void` has no body worth reading: the call either succeeds or fails with an error.
- Enum values come from `contract.mts`: `Status`, `Priority`, `Effort`, `NextRun`, `PrState`, `NoteKind`, `WireNoteAuthor`, `TaskCreator`, `TaskActor`.

### Sealed fields

| Field (on the wire)                                     | Binding `field`   | Context (`sealing.mts`)                                    |
| ------------------------------------------------------- | ----------------- | ---------------------------------------------------------- |
| `title`                                                 | `title`           | `titleBinding`: the task, or the schedule of an occurrence |
| `input` (a task's or a schedule's prompt, `startInput`) | `input`           | `inputBinding`: origin, creator, fork parent and agent     |
| `workdir`                                               | `workdir`         | `workdirBinding` (`workdirOpenBindings` to open)           |
| `agent`                                                 | `agent`           | `agentBinding`                                             |
| `icon`                                                  | `icon`            | `iconBinding`                                              |
| `labels`                                                | `labels`          | `labelsBinding`                                            |
| `pr` (a reported pull request)                          | `pr`              | `prBinding`: the task                                      |
| `watches`                                               | `watches`         | `watchesBinding`: the task                                 |
| a note's `body`                                         | `note.body`       | `noteBinding`: task, author, kind                          |
| a note's `preview`                                      | `note.preview`    | `noteBinding`                                              |
| a note's `questions`                                    | `note.questions`  | `noteBinding`                                              |
| a note's `answers`                                      | `note.answers`    | `noteBinding`                                              |
| a note's `suggestion`                                   | `note.suggestion` | `noteBinding`                                              |
| a machine's `dirs`                                      | `machine.dirs`    | `machineDirsBinding`: the machine                          |
| a machine's `catalog`                                   | `machine.catalog` | `machineCatalogBinding`                                    |
| a machine's `usage`                                     | `machine.usage`   | `machineUsageBinding`                                      |
| a machine's `feeds`                                     | `machine.feeds`   | `machineFeedsBinding`                                      |
| shared agents `document`                                | `agents.shared`   | `agents:v<version>`                                        |
| link rules `document`                                   | `links`           | `links:v<version>`                                         |
| title rules `document`                                  | `titles`          | `titles:v<version>`                                        |
| a transcript event's `data`, a run context's `data`     | `tr.data`         | `transcriptBinding`: task, run, seq                        |
| a transcript event's output                             | `tr.output`       | `transcriptBinding`                                        |

A note by the author `server` is the one exception: its `body` is plain text from the fixed list in `events.mts`. The key slots' `wrapped` values are wrapped data keys (`abw1.…`), not envelopes.

Types named below are exported by `@agent-board/shared/ui` and defined in `wire.mts`.

### Top level and `ui`

| Procedure    | Input | Output                                                            |
| ------------ | ----- | ----------------------------------------------------------------- |
| `me`         | none  | `{ username: string; keyId: string \| null }`                     |
| `revision`   | none  | `string \| null`: the commit the server was built from            |
| `ui.version` | none  | `{ api: number; minClient: number; features: UiServerFeature[] }` |

### `tasks`

`UiTask` holds the clear columns of a task plus its sealed `title`, `input`, `workdir`, `agent`, `icon`, `labels`, `pr`, `prs[].pr` and `watches`. Its optional fields are absent, not null, when the server has nothing to say: `agent`, `icon`, `labels`, `prs`, `promptPrState`, `watches`, `watchStops`, `movedBy`, `run`, `held`, `forkOf`, `stopRequested`, `noteCount`. `UiTaskListItem` is a `UiTask` with `lastNote` (clear `createdAt`, sealed `preview`, `author`, `kind`) and `context` (the newest `UiRunContext` of a running task, or null).

| Procedure               | Input                                                                                                                                                                                                                   | Output                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `tasks.list`            | `{ closed?: boolean }` or none                                                                                                                                                                                          | `UiTaskListItem[]`                                             |
| `tasks.get`             | `{ id }`                                                                                                                                                                                                                | `UiTaskDetail`: task, thread, follow-ups, parent               |
| `tasks.create`          | `UiTaskCreate`: sealed `title`, `input`, and optional `place`, `agent`, `icon`, `labels`; `when` is `now`, `backlog`, `hold`, `{ at }` or a repeat (`every`, `cron` or `after`, with `times`, `until`, `maxConcurrent`) | `UiTask`, or null when a repeat created a schedule and no task |
| `tasks.fork`            | `{ id, parentId, title, input, workdir, agent? }` (all but the ids sealed)                                                                                                                                              | `UiTask`                                                       |
| `tasks.answer`          | `{ id, questionNoteId, answers, message }`: `answers` sealed as `note.answers`, `message` a `UiNoteInput`                                                                                                               | `UiTask`                                                       |
| `tasks.dismissQuestion` | `{ id, questionNoteId }`                                                                                                                                                                                                | `UiTask`                                                       |
| `tasks.reply`           | `{ id, message, resume }`                                                                                                                                                                                               | `UiTask`                                                       |
| `tasks.send`            | `{ id, message }`                                                                                                                                                                                                       | `UiTask`                                                       |
| `tasks.stop`            | `{ id, message? }`                                                                                                                                                                                                      | `UiTask`                                                       |
| `tasks.applyPolish`     | `{ id, polishId, title, input, previous }`: `previous` is the old text as a `UiNoteInput`                                                                                                                               | `UiTask`                                                       |
| `tasks.edit`            | `{ id, title, input, previous }`                                                                                                                                                                                        | `UiTask`                                                       |
| `tasks.done`            | `{ id }`                                                                                                                                                                                                                | `UiTask`                                                       |
| `tasks.rerun`           | `{ id }`                                                                                                                                                                                                                | `UiTask`                                                       |
| `tasks.setPriority`     | `{ id, priority }`                                                                                                                                                                                                      | `UiTask`                                                       |
| `tasks.configure`       | `UiTaskConfigure`: at least one of `priority`, `model`, `effort`, `lane`, `autoDone`, `icon`, `labels`, `place`, `title`                                                                                                | `UiTask`                                                       |
| `tasks.setNotBefore`    | `{ id, notBefore: IsoDate \| null }`                                                                                                                                                                                    | `UiTask`                                                       |
| `tasks.wakeNow`         | `{ id }`                                                                                                                                                                                                                | `UiTask`                                                       |
| `tasks.takeBack`        | `{ id }`                                                                                                                                                                                                                | `UiTask`                                                       |
| `tasks.removePr`        | `{ id, prId }`                                                                                                                                                                                                          | `UiTask`                                                       |
| `tasks.stopWatch`       | `{ id, watchId }`                                                                                                                                                                                                       | `UiTask`                                                       |
| `tasks.setClosed`       | `{ id, closed }`                                                                                                                                                                                                        | `UiTask`                                                       |
| `tasks.move`            | `{ id, status, beforeId?, afterId?, startInput? }`: `startInput` is the prompt sealed again as the user's when an agent's proposal moves into Todo                                                                      | `UiTask`                                                       |

`UiNoteInput` is `{ body, preview? }`, sealed as `note.body` and `note.preview` under the note's task, author and kind. A `UiThreadNote` carries `id`, `createdAt`, `author`, `kind`, `by`, the sealed `body`, `preview`, and optional `questions`, `answers`, `suggestion`, `questionNoteId`, `pending`, `queued`, `deliveredAt`.

### `schedules`

`UiSchedule` carries the sealed `title`, `input`, `workdir` and optional `agent`, `icon`, `labels`, and the clear rule and state (`everyMs`, `cron`, `moreCrons`, `timezone`, `after`, `maxConcurrent`, `anchorAt`, `nextRunAt`, `remaining`, `until`, `paused`, `ended`, `occurrenceTaskId`).

| Procedure             | Input                                                                                                               | Output                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `schedules.list`      | none                                                                                                                | `UiSchedule[]`                                         |
| `schedules.setPaused` | `{ id, paused }`                                                                                                    | `UiSchedule`                                           |
| `schedules.update`    | `UiScheduleUpdate`: everything the user sets, with sealed `title`, `input`, optional `agent`, and a `place` or null | `{ schedule: UiSchedule; pending: UiScheduleOutcome }` |
| `schedules.remove`    | `{ id }`                                                                                                            | none                                                   |

### `transcript`

| Procedure            | Input                  | Output                                                                                                   |
| -------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `transcript.runs`    | `{ id }`               | `UiTranscriptRun[]`, newest first                                                                        |
| `transcript.events`  | `{ runId, afterSeq? }` | `UiTranscriptEvent[]` after `afterSeq`: clear `seq`, `at`, `kind`, `parent`, `outputSize`, sealed `data` |
| `transcript.context` | `{ id }`               | `UiRunContext` or null: clear `at`, `runId`, `seq`, sealed `data`                                        |
| `transcript.output`  | `{ runId, seq }`       | the sealed output (`tr.output`) or null                                                                  |

### `machines` and `feeds`

| Procedure                | Input                                                             | Output                                                                                         |
| ------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `machines.list`          | none                                                              | `UiMachine[]`: clear name, timestamps, `clientVersion`, `clientStatus`; sealed `dirs`, `usage` |
| `machines.catalogs`      | none                                                              | `UiMachineCatalog[]`: sealed `catalog`                                                         |
| `machines.advertisedCli` | none                                                              | `string \| null`: the newest CLI release the server knows of                                   |
| `machines.issue`         | `{ name }`                                                        | `{ token }`: shown once                                                                        |
| `machines.revoke`        | `{ name }`                                                        | none                                                                                           |
| `feeds.list`             | none                                                              | `UiMachineFeeds[]`: sealed `feeds`, clear `feedRequests`                                       |
| `feeds.request`          | `{ machine, action, id }`: `action` is `pause`, `resume` or `run` | none                                                                                           |

### `agents`, `links` and `titleRules`

| Procedure        | Input                                                                                          | Output                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `agents.shared`  | none                                                                                           | `{ document, version, pushedAt }` or null; read only            |
| `links.get`      | none                                                                                           | `UiSealedDocument` (`document`, `version`, `updatedAt`) or null |
| `links.set`      | `UiDocumentSave`: `{ document, version, expectedVersion }`, `version` is `expectedVersion + 1` | none; CONFLICT when another save came first                     |
| `titleRules.get` | none                                                                                           | `UiSealedDocument` or null                                      |
| `titleRules.set` | `UiDocumentSave`                                                                               | none; CONFLICT as above                                         |

### `keys`

| Procedure           | Input                                                                                      | Output                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `keys.get`          | none                                                                                       | `{ keyId, slots }` or null before setup; a slot is passphrase (`kdf`, `m`, `t`, `p`, `salt`, `wrapped`) or recovery (`wrapped`) |
| `keys.setup`        | `{ keyId, slots }`: 16 lower-case hex characters, one to four slots with a passphrase slot | none                                                                                                                            |
| `keys.replaceSlots` | `{ keyId, slots }`                                                                         | none                                                                                                                            |

### `account`

| Procedure         | Input                                                         | Output                                                                                    |
| ----------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `account.summary` | none                                                          | `UiAccountSummary`: a count per table and `running`                                       |
| `account.export`  | `{ table: UiAccountTable, cursor?: string \| null }`          | `{ next: string \| null; rows: Record<string, unknown>[] }`: rows as stored, still sealed |
| `account.import`  | `{ keyId, table, rows: unknown[] }`, at most 1000 rows        | `{ inserted, existing, invalid, orphaned }`                                               |
| `account.delete`  | `{ username }`: the signed-in name, typed as the confirmation | none                                                                                      |

### `auth` and `passkeys`

The `auth.*` procedures are public. A successful sign-in answers `{ ok: true }` and sets the session cookie: the token is in no body. The WebAuthn option and response shapes (`UiPasskeyRequestOptions`, `UiPasskeyCreationOptions`, `UiAuthenticationResponse`, `UiRegistrationResponse`) follow the browser's JSON form of the standard types, with enumerations as plain strings.

| Procedure                    | Input                                               | Output                                                                                                      |
| ---------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `auth.config`                | none                                                | `{ login: false }` or `{ login: true, passkeys, signup, oidc: { label } \| null, saml: { label } \| null }` |
| `auth.logout`                | none                                                | none                                                                                                        |
| `auth.oidc.start`            | `{ challenge }`                                     | `{ url }`                                                                                                   |
| `auth.oidc.finish`           | `{ code, state, verifier, iss? }`                   | `{ ok: true }`                                                                                              |
| `auth.saml.start`            | `{ challenge }`                                     | `{ url }`                                                                                                   |
| `auth.saml.finish`           | `{ flow, verifier }`                                | `{ ok: true }`                                                                                              |
| `auth.passkey.loginOptions`  | none                                                | `{ options: UiPasskeyRequestOptions, flow }`                                                                |
| `auth.passkey.login`         | `{ flow, response: UiAuthenticationResponse }`      | `{ ok: true }`                                                                                              |
| `auth.passkey.signupOptions` | `{ username, signupToken }`                         | `{ options: UiPasskeyCreationOptions, flow }`                                                               |
| `auth.passkey.signup`        | `{ flow, response: UiRegistrationResponse, name? }` | `{ ok: true }`                                                                                              |
| `passkeys.list`              | none                                                | `UiPasskey[]`: `id`, `name`, `createdAt`, `lastUsedAt`                                                      |
| `passkeys.registerOptions`   | none                                                | `{ options: UiPasskeyCreationOptions, flow }`                                                               |
| `passkeys.register`          | `{ flow, response: UiRegistrationResponse, name }`  | none                                                                                                        |
| `passkeys.rename`            | `{ id, name }`                                      | none                                                                                                        |
| `passkeys.remove`            | `{ id }`                                            | none                                                                                                        |
