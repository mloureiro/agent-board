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
{ "api": 1, "minClient": 1, "features": [] }
```

The client stops when `api` is below its own `MIN_UI_SERVER`.

## Upgrade required

A request whose header is below `MIN_UI_CLIENT` is refused before anything is read or written, on every procedure including `ui.version`. The answer is 412 with the message "This app is too old for this board. Update it." and `error.data.upgrade = { "minClient": <number> }`. The client shows that the app must be updated.

## Feature names

An additive change to the API adds a feature name to `ui.version`'s `features` and bumps no number. A client checks for the one name it needs and disables only that part when it is missing. `UI_FEATURE_LABELS` holds the phrase a client shows for each. The list is empty today.

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

The input and output of each procedure are declared in `packages/shared/src/ui/`.
