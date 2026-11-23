# Plugins

A feed gets its items from an integration, and integrations come in marketplaces. This page is for installing a marketplace and for writing an integration. [Feeds](usage.md#feeds) is the user's side: how a feed is configured, what it does to tasks and how the board shows it.

- [Marketplaces](#marketplaces)
- [Commands](#commands)
- [The pin](#the-pin)
- [The manifest](#the-manifest)
- [Writing an integration](#writing-an-integration)
- [Items](#items)
- [Fields](#fields)
- [Prompts](#prompts)
- [On the units' PATH](#on-the-units-path)

## Marketplaces

A marketplace is a git repository with a manifest at `.agent-board/marketplace.json`. It lists integrations, and each integration is one program in the repository. After `board plugins install <url>`, a feed names an integration as `<marketplace>:<integration>`, for example `mloureiro:github`.

The core holds no integration. [`mloureiro/agent-board-plugins`](https://github.com/mloureiro/agent-board-plugins) is an example marketplace, and its GitHub integration is planned. Everything below holds for any marketplace.

Only you install code. A marketplace reaches a machine through `board plugins install` typed in a terminal outside a board run. The board server never names a repository, a commit or a program, and the browser has no plugin action. `install`, `update` and `remove` refuse inside a board run, since a plugin is code that later runs with your authority.

## Commands

```text
board plugins install <url>     clone, pin the checked-out commit, validate, register
board plugins update <name>     fetch, show the commits it accepts, move the pin
board plugins remove <name>     refuse while a feed uses it, then delete the checkout
board plugins list              installed marketplaces, their pin state and integrations
```

**`install <url>`** clones the repository, reads the manifest at the commit it checked out, and registers the marketplace under the name the manifest gives. It prints `installed marketplace <name> at <12 hex> from <url>`, one line per integration (`<name>:<integration>` and its description), and a line showing how a feed names one. It refuses a marketplace that is already installed (it says to `update` or `remove` first), a manifest it cannot use, and a program that is not a tracked executable file. Git's own prompts and errors reach the terminal, so a private repository asks for its credentials there. A clone that takes longer than 5 minutes fails, and nothing is registered on any failure.

The URL is one of:

| Form             | Example                                                        |
| ---------------- | -------------------------------------------------------------- |
| HTTPS            | `https://github.com/mloureiro/agent-board-plugins`             |
| SSH              | `ssh://git@github.com/mloureiro/agent-board-plugins`           |
| scp-like SSH     | `git@github.com:mloureiro/agent-board-plugins`                 |
| Local repository | `/home/me/src/my-plugins` (an existing directory, for authors) |

At most 500 characters, none starting with `-`, no whitespace. Plain `http://`, `git://` and every `<transport>::` form are refused, and git runs without the `ext` transport and without submodules.

**`update <name>`** fetches the remote's default branch and moves the pin to its tip. It prints `<name>: <old 12 hex> → <new 12 hex>` and the commit subjects it accepts (the first 20, then "… and N more"), so you see which code you accepted. It says `<name> is at <12 hex>, the latest` when nothing is new. It refuses:

- when a tracked file in the checkout has a local change (the board never overwrites an edit),
- when the new commit has no usable manifest, or the manifest now has another name,
- when `git` cannot fetch.

It prints a warning for each feed that names an integration the new manifest no longer has. Those feeds stop running until you fix them. Subjects in the log and descriptions are text someone else wrote, so they are shown cut and stripped of control characters.

**`remove <name>`** refuses while a feed in `config.json` names the marketplace (`board feeds rm <feed>` first), and while a tracked file has a local change. Then it deletes the registry entry and the checkout.

**`list`** prints each marketplace with its URL, the pinned commit, the dates of the install and the last update, then `ok` or why the pin does not hold, then each integration with its program, description and the feeds that use it. It runs no integration. `list` is the one plugin command that is allowed inside a board run.

## The pin

The installed commit is the only code that runs. Only `board plugins update` moves it. No timer and no other command fetches.

The registry is `<state dir>/plugins/installed.json`, outside the checkouts in `<state dir>/plugins/marketplaces/<name>`, so nothing done inside a checkout changes what the board believes is installed. Before every use of an integration (adding a feed, `board doctor`, `board plugins list` and every run) the board checks that:

1. the checkout exists,
2. its `HEAD` is the pinned commit,
3. no tracked file has a local change.

When any of them fails, every feed that uses the marketplace is invalid: it never runs, and the reason names the fix (`board plugins update <name>` to accept the checkout's code, or discard the edit). Untracked files do not count, because an interpreter may write a cache next to its program, and the program itself must be tracked.

The check protects against drift: a `git pull` in the directory, an edit, a half-finished update. It is not a boundary against a process that runs as you, which can rewrite the registry as easily as `config.json`. [Architecture](architecture.md) says why that limit stands.

`git` is a runtime dependency of feeds, since the check runs it. It must be on the units' PATH, and `board doctor` warns when it is not.

## The manifest

`.agent-board/marketplace.json`, read from the pinned commit and not from the working tree:

```json
{
  "protocol": 1,
  "name": "mloureiro",
  "description": "Feed integrations for agent-board",
  "feeds": {
    "github": {
      "program": "feeds/github/board-feed-github",
      "description": "Pull requests that match a GitHub search"
    }
  }
}
```

The manifest is another person's text, so it is checked before any value reaches a path or a command line, and anything else is refused.

| Key                       | Rule                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the file                  | At most 64 KiB, a JSON object.                                                                                                                         |
| `protocol`                | Exactly `1`. Any other number says which protocol the marketplace speaks and which this CLI speaks.                                                    |
| `name`                    | Lowercase letters, digits and `-`, 1 to 40 characters, starting with a letter or digit. It names the install directory and the feed's `<marketplace>`. |
| `description`             | Optional text of at most 300 characters.                                                                                                               |
| `feeds`                   | An object of at most 50 integrations, possibly empty. A key follows the same rule as `name`.                                                           |
| `feeds.<key>.program`     | A relative path of at most 200 characters, made of segments of letters, digits, `.`, `_` and `-`, none of them `.` or `..`.                            |
| `feeds.<key>.description` | Optional text of at most 300 characters.                                                                                                               |
| any other key             | Refused.                                                                                                                                               |

The program must be a tracked regular file with the executable bit at the pinned commit. A symlink, a missing file or a file without the bit fails the install and the update. That is what keeps `program` inside the checkout.

## Writing an integration

An integration is one program. It may be written in any language: its first line picks the interpreter (`#!/usr/bin/env python3`, `#!/usr/bin/env node`, a compiled binary), and the interpreter must be found on [the units' PATH](#on-the-units-path). The board runs it with `bash -c`, in the feed's directory, with the `env` of your Claude Code settings on top, so a token such as `GH_TOKEN` stays on the machine.

The program answers four kinds of call:

| Call             | stdin       | stdout                          | Exit                                                                       | Time limit           |
| ---------------- | ----------- | ------------------------------- | -------------------------------------------------------------------------- | -------------------- |
| `describe`       | nothing     | one JSON document               | 0                                                                          | 30 s                 |
| `doctor`         | nothing     | optional one-line summary       | 0 when ready; otherwise non-zero, with the reason on the first stderr line | 30 s                 |
| `check <action>` | the options | ignored                         | 0 when the options are valid; otherwise non-zero, reason on stderr         | 30 s                 |
| `<action>`       | the options | items, one JSON object per line | 0 for a complete listing; non-zero for a failed one                        | the feed's `timeout` |

- The options are one JSON object on **stdin**, never on the command line.
- A non-zero exit from `<action>` is a failed listing: nothing is scheduled and nothing is closed. Print nothing partial and exit non-zero instead.
- `doctor` checks what the integration needs on the machine, such as a tool and a login. It may be slow or use the network, so it runs only in `board doctor` and `board feeds add`, never in a run. A failure at `board feeds add` is a warning: the feed is written, since a missing login is the machine's state and not a bad entry.
- `check` looks at the options alone, offline and fast. It runs every time the feed is validated. Check there what the schema cannot say, and do not trust that the board's schema pass ran.
- A program whose interpreter is missing fails every call with the shell's message (`env: python3: No such file or directory`). The board shows its first stderr line, cut to 200 characters, wherever it records the failure.
- An unknown call exits 2 with a usage line on stderr.
- A listing may print at most 200 KB.

### `describe`

```json
{
  "protocol": 1,
  "actions": {
    "list-pull-requests": {
      "summary": "Open pull requests that match a GitHub search, one item per PR",
      "options": {
        "type": "object",
        "properties": { "query": { "type": "string", "minLength": 1, "maxLength": 256 } },
        "required": ["query"],
        "additionalProperties": false
      },
      "fields": ["url", "title", "updatedAt", "status", "labels"]
    }
  }
}
```

- `protocol` must be `1`.
- An action name is lowercase letters, digits and `-`, up to 64 characters, starting with a letter or digit. `summary` is optional text of at most 300 characters.
- `fields` lists the names the action's items put in `fields` and a prompt may use as `{name}`: letters, digits and `_`, starting with a letter, at most 40 characters, at most 16 names.
- The answer is read again on every validation. The board keeps nothing between calls.

### The options schema

`options` is a JSON Schema subset. A schema with any other keyword is refused as a whole, so a rule is never silently skipped.

| Applies to      | Keywords                                                                      |
| --------------- | ----------------------------------------------------------------------------- |
| any             | `type` (`object`, `array`, `string`, `integer`, `number`, `boolean`), `enum`  |
| object          | `properties`, `required`, `additionalProperties` (`false` or a schema)        |
| array           | `items`, `minItems`, `maxItems`                                               |
| string          | `minLength`, `maxLength`, `pattern` (up to 500 characters, with the `u` flag) |
| number, integer | `minimum`, `maximum`                                                          |
| ignored         | `description`, `default`, `title`, `examples`                                 |

Schemas nest at most 8 levels deep, and an `enum` holds at most 100 values. An error names the path, for example `options.repositories[1] must match ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`. A feed's `options` is at most 16 KiB as JSON.

### What the board validates

On `board feeds add`, in `board doctor` and at the start of every run, a feed goes through these steps, and the first failure is the reason:

1. The integration resolves: the marketplace is installed, its pin holds, and its manifest lists the integration.
2. `describe` exits 0 and parses.
3. The feed's `action` is one of the described actions.
4. `options` passes the action's schema.
5. Every placeholder in `prompts.new` and `prompts.update` is `key`, `title`, `version` or a field the action declares.
6. `check <action>` exits 0.

An invalid feed never runs. It records the reason, which `board feeds` and Settings › Feeds show, and tries again at its next interval.

## Items

An action prints one JSON object per line. Empty lines are skipped, and one bad line fails the whole listing. At most 200 items, and a key appears once.

| Field       | Rule                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`       | Required, non-empty text. The board's key is `feed:<name>:<key>`, at most 500 characters.                                                         |
| `title`     | Required, non-empty. It becomes the task's title, on one line and cut to 200 characters. Put the item's own id in it when it has one.             |
| `version`   | Optional text of at most 200 characters. A change of `version` is what makes an item "changed" (see [Feeds](usage.md#feeds)).                     |
| `dir`       | Optional path of a directory in `dirs`, where the task runs.                                                                                      |
| `repo`      | Optional `owner/name`. The task runs in the checkout that `config.json` maps it to.                                                               |
| `notBefore` | Optional ISO time such as `2026-11-23T10:00:00Z`. The task waits in Todo until then.                                                              |
| `fields`    | Optional object of text values for the prompts: at most 16 entries of at most 2 000 characters, and only names the action declared in `describe`. |

An item that sends a `prompt`, or any field not listed here, fails the listing: the prompts come from the feed's `prompts.new` and `prompts.update`.

The task runs in this order: the item's `dir`, else the checkout `config.json` maps the item's `repo` to, else the feed's `dir`. The result must be a listed directory, or that item fails alone.

## Fields

Provide only what a task needs. A prompt may use every field an integration provides, so each extra field is more text from outside in front of the agent. Leave out an author, a description or a comment thread unless the task cannot work without it.

The board cannot check what a field means. These names are a convention, so prompts read the same across integrations:

| Field       | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `url`       | The item's link.                                         |
| `id`        | The outside tool's id, when it is not the link.          |
| `title`     | The item's own title, with its story id when it has one. |
| `updatedAt` | ISO time of the item's last update.                      |
| `createdAt` | Optional ISO time.                                       |
| `status`    | The item's state in the outside tool, as a short word.   |
| `labels`    | The item's labels, comma-separated.                      |

## Prompts

A feed's `prompts.new` starts a task and `prompts.update` goes to the session of a task whose item changed. A `{name}` is replaced by the item's `key`, `title`, `version` or one of its fields. Any other brace is literal text. A value is cut to 500 characters, with control characters and line breaks removed. An item that lacks a field the prompt names fails alone, with an error that says which.

**Prefer `{url}` in prompts.** A title is text someone else wrote, and the prompt is sealed as yours. With the link the agent reads the item itself, as data, under the agent's own rules. Use `{title}` or any other free text only where the task needs it.

## On the units' PATH

The watch unit and the listener run with a short PATH that `board setup` writes, not the PATH of your shell. The program of an integration, its interpreter (the shebang's) and the tools it calls must all be found on it. For something installed in a place the units do not search, make a link in `~/.local/bin`:

```sh
ln -s /opt/homebrew/bin/python3 ~/.local/bin/python3
```

`board doctor` runs each used integration's `doctor` under the units' PATH. That is why a feed can pass as `feeds.<name>` and still fail as `integrations.<marketplace>:<integration>`: validating a feed runs under the PATH of the shell you ran `board doctor` from, and the integration's own `doctor` runs under the units' PATH. The second one is what a feed meets when it runs on its timer.
