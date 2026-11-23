# agent-board

A Kanban board for headless Claude Code runs. You write a task the way you would type a prompt into Claude Code (`/review-pr 17741`, or plain instructions). A worker on one of your machines runs it with `claude -p`, and the agent reports back on the board as a thread. When it needs you, it asks questions with options to pick, and it carries on in the same session once you answer.

All content is end-to-end encrypted. The server never sees a prompt, a note or a transcript in plain text.

## How it works

```
 browser ──tRPC──▶ backend (Fastify, Postgres) ◀──machine API + SSE── board CLI on each worker machine
                   board.codeplant.de, signs users in itself            dispatch · listen · worker
                                                                          └─ starts `claude -p` per task
```

| Part | What it is |
| --- | --- |
| `apps/backend` | Fastify server with tRPC for the browser and a token-authenticated machine API for workers. Postgres is the only state. |
| `apps/frontend` | React, Mantine and TanStack Query. Encrypts and decrypts in the browser. |
| `apps/cli` | The `board` command. Agents use it to report, and on a worker machine it runs the systemd units (launchd agents on macOS) that claim and run tasks. |
| `packages/shared` | The contract between all three: wire types, the sealing rules, crypto. |

A task moves through `backlog → todo → running → needs-me → done`, with `waiting` for tasks parked on CI or a timer. A run that reports, asks or fails ends in `needs-me`, and nothing moves on until you press a button. [docs/architecture.md](docs/architecture.md) explains the design.

## Install a worker machine

You need Linux with systemd, or macOS. You also need `claude` and `gh`, both logged in. On macOS the worker runs as launchd agents while you are logged in (see [macOS](docs/setup.md#macos)).

1. Open the board in the browser and set up encryption (passphrase and recovery key). On **Settings › Machines**, create a token for this machine and copy the data key.
2. Install the CLI from the newest release:

   ```sh
   gh release download --repo codeplant-de/agent-board --pattern install.sh -O - | sh
   ```

3. Configure and start it:

   ```sh
   board init            # board URL, machine token, data key, machine name
   board setup --enable  # systemd user units (launchd agents on macOS): dispatch, the listener and watches
   board doctor          # checks config, token, key, server version and units
   ```

4. Optional: list your checkouts with `board dirs` and split parallel runs with `lanes`. [Configuration worth knowing](docs/first-steps.md#configuration-worth-knowing) walks through both.

To turn PR review requests into tasks, add the reviewer agent with `board agents add example:reviewer` and run the `github-reviews` script on a timer. [Review requests from GitHub](docs/usage.md#review-requests-from-github) has the script and the timer unit.

For runs after you log out, enable lingering with `loginctl enable-linger $USER`. Update later with `board self-update`.

[docs/setup.md](docs/setup.md) covers installing from a checkout, every config key, and upgrading. Once the machine runs, [docs/first-steps.md](docs/first-steps.md) is a tour of what to try next and which settings are worth changing.

## Use it

Make a task from the terminal. It runs on this machine, in this directory:

```sh
board schedule /review-pr 17741
board schedule --priority high "Find out why the CSV export is slow and propose a fix"
board schedule --in 2h /review-pr 17741
board schedule --cron "0 9 * * 1-5" /review-pr --auto
```

Or use **New task** on the board and pick a working directory there. Without one, the machine that takes the task picks the directory (see [Where a task runs](docs/workers.md#where-a-task-runs)).

Then work from the task page:

- **Answer & continue** or **Send & continue** resumes the agent's session with your reply.
- **Re-run fresh** starts over with a new session.
- **Mark done** moves it to Done, and **Close** takes it out of the workflow.
- **Transcript** shows every tool call of every run, live while it runs.
- `board attach <task>` opens the session in your terminal on the machine that ran it.

Agents report with `board comment`, ask with `board ask`, wait for CI with `board watch`, report the PRs they open with `board pr`, and propose follow-up work with `board add`. A proposal only runs after you press **Start**.

A feed turns the items of an outside tool into tasks on a timer, with the integration coming from a plugin marketplace ([docs/plugins.md](docs/plugins.md)). A script such as `github-reviews` can turn GitHub review requests into review tasks on a timer too. Those tasks run as an agent with a narrow allow-list, because their input is PR text nobody chose to read.

The [documentation](#documentation) table below lists where to read more.

## Security in short

- Workers run Claude Code as you, with your home directory, SSH agent and `gh` login. There is no sandbox. Permission rules keep an agent on its task, but they are not a security boundary.
- Prompts, notes and transcripts are sealed with a data key that exists only in your browser and on your machines. Each value is bound to the row and role it was written for, so the server cannot move a value to another task or forge one.
- The server still sees metadata and decides when and where a task runs.

[docs/encryption.md](docs/encryption.md) lists exactly what the server can and cannot do.

## Develop

```sh
mise install                        # Node 24, pnpm 11, Bun
pnpm install
docker compose up -d postgres       # Postgres on :54331
cp apps/backend/.env.example apps/backend/.env
pnpm dev:backend                    # :4000, no login (NO_LOGIN_USER)
pnpm dev:frontend                   # :5173
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

[docs/development.md](docs/development.md) covers tests, migrations, CLI releases and how to point a worker at the local board. Server deployment and its environment are in [docs/operations.md](docs/operations.md). The wire protocol between CLI and server is in [docs/machine-api.md](docs/machine-api.md).

## Documentation

| Document | Contents |
| --- | --- |
| [first-steps.md](docs/first-steps.md) | What to try after installing, automatic task creation, useful settings. |
| [architecture.md](docs/architecture.md) | Components, data flow, design decisions and the rules a change must keep. |
| [usage.md](docs/usage.md) | Tasks, scheduling, questions and resume, waiting, proposals, polish, export and import of your data. |
| [workers.md](docs/workers.md) | Multiple machines, lanes, liveness, transcripts, permissions, how dispatch decides. |
| [plugins.md](docs/plugins.md) | Plugin marketplaces, installing one, writing a feed integration. |
| [setup.md](docs/setup.md) | Installing the CLI, `config.json`, upgrading. |
| [cli.md](docs/cli.md) | Generated `board` command reference. |
| [encryption.md](docs/encryption.md) | Threat model, sealing contexts, what the server can still do. |
| [machine-api.md](docs/machine-api.md) | The contract between CLI and server. |
| [operations.md](docs/operations.md) | Server deployment, environment, sign-in setup, the encryption cutover. |
| [development.md](docs/development.md) | Local setup, tests, migrations, releases. |
