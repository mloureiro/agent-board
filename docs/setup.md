# Setting up a machine

Installing the `board` CLI, configuring it, and upgrading.

## Install

The `board` command and the worker (`dispatch`, `listen`, `worker`) are one program. A released build is a single binary per platform (Linux x64 and arm64, macOS arm64) and needs no Node.

A worker machine needs:

- `claude` and `gh`, both logged in.
- On Linux: systemd, `flock`, `systemd-run` and `timeout` from coreutils.
- On macOS: `lockf`, which ships with it. See [macOS](#macos).

A machine that only uses the board, without running tasks, needs just `board init`.

### From a release

Set up encryption in the browser first (see [Encryption](encryption.md#encryption)). On the board's **Settings › Machines** page, create a token for this machine and copy your data key. Then:

```sh
gh release download --repo mloureiro/agent-board --pattern install.sh -O - | sh
board init
board setup --enable
board doctor
```

#### install.sh

`install.sh` downloads the newest `cli-v*` release of `mloureiro/agent-board` for this platform, checks it against `SHA256SUMS` and installs it as `~/.local/bin/board`. `BOARD_INSTALL_DIR` chooses another directory.

The checksum catches a broken or partial download. It is not a signature. Anyone who can write releases of this repository can replace the binary and `SHA256SUMS` together, so the trust is in who has write access to the repository.

#### board init

`board init` asks for four things: the board's URL, the machine token, the data key and the machine name. It does not show the token or the data key as you type. At each prompt, paste one line: the bare value, or the `AGENT_BOARD_TOKEN=…` or `AGENT_BOARD_DATA_KEY=…` line as Settings › Machines offers it.

It writes three files into `~/.config/agent-board`:

| File          | Contents                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `web.json`    | The board's URL.                                                                                                                      |
| `env`         | The token and the data key, mode 600. The CLI refuses a file with any other mode.                                                     |
| `config.json` | Written only if missing, from `apps/cli/config.example.json`: one `general` lane, the default, and no `repos`. See [Config](#config). |

`env` holds two lines, `AGENT_BOARD_TOKEN=abm_...` and `AGENT_BOARD_DATA_KEY=abk1_...`. The data key is the same on every machine and never leaves your machines and browser. The CLI refuses to start without it, with a different key than the board's, or before the board has a key. `board doctor` checks all three.

`board init` keeps a file that exists. With `--force` it copies the file to `<name>.bak-<timestamp>` first, replaces it, and keeps the secrets you do not give again. An `env` that has a token but no data key is completed without `--force`: `board init` asks for the missing value only.

For a script, pass everything as flags:

```sh
board init --url https://board.codeplant.de --token-file <file> --data-key-file <file> --machine <name>
```

A secret never goes on the command line. A file given with `--token-file` or `--data-key-file` can hold both lines, and one of the two can be `/dev/stdin`.

#### board setup

`board setup` writes four systemd user units into `~/.config/systemd/user` as copies and reloads systemd:

| Unit                                        | What it does                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `agent-board-dispatch.service` and `.timer` | A dispatch tick every 2 minutes, run under `flock`.                                             |
| `agent-board-listen.service`                | The listener. It holds a stream to the board and starts a dispatch tick when something changes. |
| `agent-board-watch.service`                 | Polls the [watches](usage.md#waiting) of this machine's tasks. Always restarted.                |

`--enable` also enables and starts the timer, the listener and the watch unit. `--print` only shows the units. Setup also removes the intake timer and service that an earlier version installed, and says so.

The units run the installed binary as `<board> internal dispatch`. Run `board setup` again after moving the binary.

User units only run while you are logged in. For runs after logout, run `loginctl enable-linger $USER`.

#### The listener and the timer

The listener runs a dispatch tick about a second after a new task, an answer or a drag to Todo. It also starts a tick when something is due that no event announces: a delayed task, the end of a wait, a check, or taking back a borrowed slot. Each tick leaves the next such time in the run directory (see [How it decides](workers.md#how-it-decides)).

The 2-minute timer is the fallback. It covers the stale sweep, an event missed while the stream was down, and a listener that is down.

A tick the listener starts runs under the same lock as the timer's and is stopped after 110 s, as the timer's is.

Logs: `board logs` shows the end of the three units together, `board logs listen -f` follows one, and `board logs <task id>` shows a task's log file. `--since "1 hour ago"` limits the units to a time. `board restart` restarts the timer, the listener and the watch unit (or the ones named); running workers are not stopped. The same by hand:

```sh
journalctl --user -u agent-board-dispatch
journalctl --user -u agent-board-listen
journalctl --user -u agent-board-watch
```

#### board doctor

`board doctor` checks the whole machine: config, token, data key, the server and its API range, the worker tools and the units. From a checkout it also checks Node.

A key in `config.json` that the CLI does not read is a warning that names the nearest known key. That covers a typo such as `inactivityMinuts` and a key a newer version dropped. The warning appears in `board doctor` and as a `WARN config.json:` line at the start of every dispatch tick. It never stops the machine, and the setting keeps its default.

`board completion bash|zsh|fish` prints a shell completion script. See the [CLI reference](cli.md).

### From a checkout (development)

You need Node 24+, pnpm, and for a worker the tools above.

1. Run `pnpm install` in the repository. The CLI imports its dependencies and `@agent-board/shared` from the workspace, so repeat this after each pull.
2. Run `apps/cli/install.sh`. It links `board` into `~/.local/bin`, links `apps/cli/bin/.node` to a Node 24+ binary, and runs `board setup`. `NODE=` chooses the binary. It must be a real binary, not a mise shim, because a shim does not resolve a version outside a project directory.
3. Continue with `board init` and `board doctor` as above.
4. Enable the units with `board setup --enable`. `apps/cli/install.sh --enable` does steps 2 and 4 in one.

The units then run `<node> <checkout>/apps/cli/src/main.mts internal dispatch`, with the Node that ran `board setup`. Run `install.sh` or `board setup` again after moving the checkout or upgrading Node. `board doctor` flags a unit whose Node or checkout has gone.

To build the binaries, run `apps/cli/build.sh`. It needs Bun, pinned in `mise.toml`, and writes them into `apps/cli/dist` with a `SHA256SUMS`. `pnpm --filter @agent-board/cli test:binary` builds one for this host and runs it the way a worker machine would. [Releasing the CLI](development.md#releasing-the-cli) describes how a release is published.

### macOS

A Mac runs the worker the way a Linux machine does, with launchd in place of systemd and detached processes in place of transient units. The install is the same: `install.sh`, `board init`, `board setup --enable`, `board doctor`.

The released binary is built for Apple silicon (arm64). An Intel Mac runs the CLI from a checkout.

`board setup` writes three launch agents into `~/Library/LaunchAgents` as copies (mode 644). With `--enable` it loads them with `launchctl bootout` and `launchctl bootstrap gui/<uid>`.

| Agent                               | What it does                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `de.codeplant.agent-board.dispatch` | A dispatch tick every 120 s and at load, run as `lockf -s -t 0 <run dir>/agent-board-dispatch.lock <board> internal dispatch`. Exit 75 means another tick holds the lock, which is not a failure. |
| `de.codeplant.agent-board.listen`   | The listener, kept alive and restarted every 10 s at the soonest. `ExitTimeOut` 130 s lets a stop wait for a running tick.                                                                        |
| `de.codeplant.agent-board.watch`    | The watch unit (`board internal watch`), kept alive and restarted every 5 s at the soonest.                                                                                                       |

All three set `AbandonProcessGroup`, so launchd never kills a worker the job started.

A plist expands nothing, and launchd's own default `PATH` has only `/usr/bin:/bin:/usr/sbin:/sbin`. So setup writes out a `PATH` of `~/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, where Homebrew and the installer put `claude`, `gh` and `node`.

Setup passes on `AGENT_BOARD_CONFIG_DIR`, `AGENT_BOARD_STATE_DIR`, `AGENT_BOARD_RUN_DIR`, `XDG_STATE_HOME` and `XDG_RUNTIME_DIR` when the shell that ran it sets them. Run `board setup` again after moving the binary.

```sh
board setup --print                                              # show the agents, change nothing
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/de.codeplant.agent-board.listen.plist     # enable (setup --enable does both)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/de.codeplant.agent-board.dispatch.plist
launchctl bootout gui/$(id -u)/de.codeplant.agent-board.listen   # disable (dispatch the same way)
launchctl kickstart -k gui/$(id -u)/de.codeplant.agent-board.listen   # restart the listener (board restart and board self-update do it for you)
launchctl print gui/$(id -u)/de.codeplant.agent-board.listen     # state, last exit code, the program it runs
```

#### Logs

launchd writes each agent's output to `~/.local/state/agent-board/logs/launchd.<agent>.log`, next to the task logs. `AGENT_BOARD_STATE_DIR` or `XDG_STATE_HOME` moves them. They are not rotated. `board logs [dispatch|listen|watch] [-f]` runs `tail` on them; `--since` is not available there.

#### Runs

A run is a detached `board internal worker <task>` process in its own session, not a transient unit.

- The run directory is `~/.local/state/agent-board/run` (mode 700). `XDG_RUNTIME_DIR` or `AGENT_BOARD_RUN_DIR` override it. It holds each run's `<task>.pid` and the agent's process group (`<task>.agent`).
- Nothing clears the run directory at reboot. The dispatcher trusts a `.pid` only when the pid is alive and its command line ends in `internal worker <task>`, and removes a stale one.
- A stop signals the worker's process group and the agent's with SIGTERM, then SIGKILL after 10 s. The worker also ends the agent's group when the run ends.
- A process that a run started in a session of its own (a daemon, `setsid`) is not reached. macOS has no cgroup to clean up after a run as Linux does.

#### Where checkouts can be

A background job may not read `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive (`~/Library/Mobile Documents`) without your consent, and nobody is there to give it. Keep checkouts, `dirs`, `defaultCwd` and lane `cwd`s elsewhere, such as `~/code`. `board doctor` warns about a path under them.

Do not rely on Full Disk Access as a way out. macOS may attribute a background job's access to a binary other than `board`. The dispatch agent's program is `/usr/bin/lockf`, which then starts `board`, so a grant to `board` alone may not cover runs the timer starts.

#### Sleep

A sleeping Mac runs nothing. While a run goes on, the worker holds `caffeinate -i`, which turns idle sleep off. Closing the lid or a low battery still sleeps the machine.

After a sleep, the worker's 15-second check sees the clock jump and starts the idle time over, so a night's sleep does not count as hours without a tool call. The next dispatch tick sees a gap of more than 10 minutes since the last one and does not count quiet time against the runs either. The 6-hour limit counts wall-clock time, sleep included.

#### Login

The agents are in your `gui` domain, so they run only while you are logged in. A locked screen is fine. `claude` and `gh` keep their credentials in the login keychain, which is only open in that session.

On macOS 13 and later, System Settings, General, Login Items lets you switch background items off, which unloads the agents. `board doctor` reports an agent that launchd has not loaded.

#### Self-update

`board self-update` replaces the binary by a rename, because a write in place would invalidate the code signature of a running file. It restarts the listener with `launchctl kickstart -k` when launchd has it loaded.

## Uninstall

`board uninstall` undoes `board setup` and the install:

- It stops, disables and deletes the dispatch timer, the listener and the watch unit. On macOS it boots out and deletes the three launchd agents. A unit that is not installed or not running is skipped. A unit that fails to stop keeps its file, is named in the output, and makes the command exit 1. The installed `board` stays too; stop the unit by hand and run the command again.
- It deletes the installed `board`: `~/.local/bin/board`, or `$BOARD_INSTALL_DIR/board`. For a checkout install that is the link `install.sh` made; the checkout itself stays.
- Workers that are running keep running until they end.

It keeps the config directory, the state directory and the run directory (see [Files](#files)). `install.sh` and `board setup --enable` then bring the machine back as it was. `--include-optional` removes them too, and refuses a directory that is the home directory or holds it (exit 1). The config directory's `env` holds the data key, so keep a copy of it first if the machine may need it again.

```sh
board uninstall --dry-run            # print what would be stopped and removed, change nothing
board uninstall                      # units and binary; config and state stay
board uninstall --include-optional   # also the config, state and run directories
```

## Upgrading

The CLI checks the server's API range once per process (see [Version handshake](machine-api.md#version-handshake)). Two kinds of change follow from that:

- **An additive change** adds a [feature](machine-api.md#features) name and no version number: a new command, a new optional field. Deploy the server and release the CLI in any order. An older CLI keeps working, and a command that needs a feature the server lacks refuses with a message that says so. A CLI that is newer than the server skips its dispatch ticks quietly until the server catches up.
- **A change that raises `MIN_CLIENT`** makes the server refuse older CLIs. The server and every machine's CLI update together, in the order under [A raised MIN_CLIENT](#a-raised-min_client). A machine left on an older CLI fails each dispatch tick with a version error until it is updated.

Every note below is additive unless it says otherwise. After updating the CLI on a machine, restart its listener (see [Restarting the listener](#restarting-the-listener)).

### A raised MIN_CLIENT

For a change that raises `MIN_CLIENT`, in this order:

1. Stop the dispatch timer and the listener on every worker machine: `systemctl --user stop agent-board-dispatch.timer agent-board-listen.service`.
2. Take a dump of the database. It is your way back if a migration has to be undone.
3. Deploy or restart the server. Migrations run on start.
4. Wait for the CLI release. Once the change is on `main`, CI publishes `cli-v<version>` before it builds the images, so `board self-update` has something to fetch before any machine is switched. `board self-update --check` on a machine shows it.
5. Update the CLI on each machine, then run `board doctor`.
   - A release binary: `board self-update`. It needs `gh`. It also runs the migration steps the release declares (see [Machine migrations](#machine-migrations)).
   - A checkout: `git pull`, `pnpm install` and `apps/cli/install.sh`. A checkout that only pulls cannot resolve new dependencies, and then `board`, dispatch and every run's hook fail.
   - Run `board setup` once if an older version wrote the units.
6. Start the timer and the listener again: `systemctl --user start agent-board-dispatch.timer agent-board-listen.service`.

CI fails a pull request, and a push to `main`, that raises `MIN_CLIENT` without a CLI version above the newest `cli-v*` tag.

### Restarting the listener

The listener is one process that keeps the code it started with, across reconnects. It needs a restart to run a new CLI.

- `board self-update` restarts it after it replaced the binary, and prints a line saying so.
- `board setup` restarts it when it wrote a changed unit file. It uses `systemctl --user try-restart`, which leaves a stopped listener alone.
- After a plain `git pull` in a checkout, run `board restart` (or `board restart listen watch`; on Linux that is `systemctl --user restart agent-board-listen agent-board-watch`).

Stopping the listener waits for a dispatch tick that is running. The unit's `TimeoutStopSec` is 130 s: a tick's 110 s limit, its 10 s grace and a margin.

The listener checks the API range each time it connects. When the server no longer serves this CLI, the listener logs that and exits, and systemd restarts it every 10 seconds until the CLI matches. When the server is older than the CLI, the listener logs that once and keeps reconnecting with its usual backoff.

### Machine migrations

A release can declare steps that change a machine's own files: units, the config directory, where the CLI keeps its state. `board self-update` and the dispatcher's `autoUpdate` run them, so a machine does not need hand edits after an update. A release that declares none updates exactly as before: no warning, no backup, no step.

#### Updating from a terminal

After the download is checked, the old binary asks the new one which steps it brings. With none, it replaces itself and restarts the listener as before. With some, and a terminal:

1. If workers run, it refuses before asking, says how many run, and changes nothing. Run `board self-update` again once they end. `board self-update --resume` from a terminal refuses the same way.
2. It prints `There are breaking changes, so a migration is needed.`, one line per step (a step that needs you is marked `(needs you)`) and asks whether to continue. The default is no, and then nothing changes and the downloaded file is removed.
3. On yes it takes the migration lock, backs up, writes the journal and replaces the binary. The new binary then runs the steps, one line each as it runs them, restarts the listener and the watch unit, and prints where the backup is.

Without a terminal (a script, cron) it does not ask and does not refuse for workers; it goes ahead.

#### The backup

Made only when a step applies, before anything changes, in `backups/<time>-<kind>-<from>-<to>/` of the state directory (`~/.local/state/agent-board`, or `AGENT_BOARD_STATE_DIR`):

- the previous binary (an update only), every file directly in the config directory (`web.json`, `env`, `config.json`), and the unit files (`~/.config/systemd/user`, or the three launchd plists on macOS);
- a `manifest.json` with the versions, the API level of the old CLI and a checksum of every file.

The backup holds the machine token and the data key, so the directory is mode 700 and its files mode 600. `board doctor` warns when a backup is readable by others. The 3 newest backups stay after a migration ends, and one a journal names is never removed.

#### When a step stops

A step that fails stops the migration and prints `migration stopped at <id> (<title>): <reason>`. A step that needs a person prints its instruction. From a terminal it asks `Done?`, checks the result when the step has a check, and stops with the `--resume` hint if you decline or the check still fails. Without a terminal it stops with the instruction and the hint, unless its check already passes.

Fix the cause or do the step, then run `board self-update --resume`. It continues with the steps the journal (`migration/journal.json`) still lists, so finished steps do not run again. `board doctor` reports a journal that is pending or stopped, with the reason and the hint, and a machine whose marker is behind this binary with steps waiting.

#### Rolling back

`board self-update --rollback` puts the machine back as it was before the newest backup was made. It works after a migration that stopped, and after one that finished, because the backup stays. It cannot be combined with `--check` or `--resume`.

1. It takes the migration lock and refuses while another process holds it.
2. It reads the newest backup. When that backup was rolled back already it says `nothing to roll back` and changes nothing; it never goes on to an older one.
3. It checks every file of the backup against the checksums in its manifest.
4. A backup without a binary (kind `steps`, made by a tick for a binary that updated some other way) is refused, and the message names the backup directory so its files can be copied back by hand. Restoring the config alone would make the next tick run the same steps again.
5. It reads the board's URL and token from the backup and asks the board for its API range. When the board now serves clients only from a newer API than the old CLI speaks, it refuses and prints both numbers, and when the board cannot be reached within 15 s it refuses too. Both refusals say `nothing was changed`.
6. From a terminal it lists what it restores and asks (default no). Without a terminal it goes on.
7. It restores the config files, the unit files and the binary, each written beside its place and renamed over it. A file that is a symlink at its place is refused and named, and the backup is only restored to the binary path and the config and unit directories it was made for. On Linux it runs `systemctl --user daemon-reload` when a unit changed. On macOS an agent that is loaded and whose plist changed is booted out and bootstrapped again.
8. It sets the migration marker back to the old version, deletes the journal of a migration that stopped, marks the backup as rolled back, restarts the listener and the watch unit, and prints what it restored.

After a rollback auto-update holds the release it rolled back from, and every older one: the dispatcher logs `UPDATE-HELD <version> was rolled back; run "board self-update" to take it` and does not update. A plain `board self-update` lifts the hold before it starts, and `board doctor` reports a held version. The hold is the `heldThrough` field of `update.json`.

A rollback restores the files of this machine only. Whatever the board server stored while the new version ran stays, and a migration step that changed server data has nothing to undo it.

#### The dispatcher

`autoUpdate` updates the same way, without asking. Because the dispatcher runs inside the listener, the update replaces the binary, writes the journal and ends the tick; the next tick runs the steps. While a migration is pending, stopped or running, no tick claims a task, so no worker runs the old code against the new files. Each tick logs one of:

| Line                                    | Meaning                                                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIGRATION-RUNNING`                     | Another process holds the migration lock; the tick ends.                                                                                                                                  |
| `MIGRATION-WAIT <n> worker(s) running`  | Workers must end first. The tick ends, and the next one looks again.                                                                                                                      |
| `MIGRATION ✓ <title>`                   | A step finished.                                                                                                                                                                          |
| `MIGRATION-DONE`                        | The last step finished, and the listener and watch unit restart without waiting.                                                                                                          |
| `MIGRATION-OUT-OF-TIME`                 | No step starts later than 60 s into a tick, and a step still running at 95 s is aborted. The next tick continues from that step, which every step allows because it is safe to run twice. |
| `MIGRATION-BLOCKED <id>: <instruction>` | A step waits for you. Do it, then run `board self-update --resume`; a step with a check goes on by itself once the check passes.                                                          |
| `MIGRATION-FAILED <id>: <reason>`       | A step failed. A tick does not retry it; run `board self-update --resume`.                                                                                                                |

A dry run of the dispatcher logs `DRY migration <n> step(s)` and changes nothing. `board doctor` also fails on a `migration/applied.json` it cannot read, naming the file, because every tick fails on it.

A machine updated by a CLI older than 0.38.0, by `install.sh` or by a `git pull` never saw the warning. Its first tick on the new binary finds the steps its marker is missing, backs up without a binary (kind `steps`), and runs them.

### Releases come from mloureiro/agent-board (CLI 0.35.0)

`board self-update`, the dispatcher's `autoUpdate` and `install.sh` download `cli-v*` releases from `mloureiro/agent-board`. The CLI alone changes, from 0.35.0 on.

A CLI at 0.34.0 or older still lists and downloads the releases of `codeplant-de/agent-board`. It never sees a fork-only release, and an upstream release newer than its own would replace it with upstream's binary. Each such machine needs one manual install from the fork, described under [Switching an upstream install to the fork](#switching-an-upstream-install-to-the-fork), after which `board self-update` works again.

### Switching an upstream install to the fork

An installation that follows `codeplant-de/agent-board` moves onto the fork once, outside `board`: the upstream CLI cannot change where it updates from. One command does it for a release binary, with no tag to look up:

```sh
gh release download --repo mloureiro/agent-board --pattern install.sh -O - | sh && board restart
```

- `gh release download` without a tag takes the release marked Latest, and `--pattern install.sh` fetches the installer attached to it. `sh` runs it, and the fork's `install.sh` replaces the installed `board` in place.
- `board restart` runs the newly installed binary and restarts the listener and the watch unit. They keep the old code until then.

If the upstream install used `BOARD_INSTALL_DIR`, set it the same way for the fork's `install.sh`, for example `gh release download --repo mloureiro/agent-board --pattern install.sh -O - | BOARD_INSTALL_DIR=~/bin sh`. Otherwise the fork's binary lands in `~/.local/bin` and the units keep running the upstream binary.

A checkout install changes its remote instead:

```sh
git remote set-url origin https://github.com/mloureiro/agent-board.git
git pull
pnpm install
apps/cli/install.sh
board restart
```

From then on `board self-update` takes releases from the fork. `board --version` ends with `updates from mloureiro/agent-board` for a release binary.

### `board --version` names its updater (CLI 0.36.0)

`board --version` ends with where the CLI updates from: `updates from mloureiro/agent-board` for a release binary, `updates with git pull` for a checkout. The CLI alone changes. A script that matches the whole line needs the new ending; one that matches `(api <n>` still works.

### `board self-update --rollback` (CLI 0.39.0)

The CLI alone changes. `board self-update --rollback` restores the config, the units and the binary from the newest backup and holds auto-update at the release it left, as described under [Rolling back](#rolling-back). Nothing changes on a machine until the command runs. A tick that finds a leftover `.board-update-*` file beside the binary from a killed update removes it when it is over an hour old, and a tick's update no longer leaves the migration lock behind. `board doctor` fails on a `migration/applied.json` it cannot read, where it used to say nothing was pending.

### Updates run migration steps (CLI 0.38.0)

The CLI alone changes. No release declares a step yet, so updating to 0.38.0 changes nothing on a machine: `board self-update` and the dispatcher's update behave as before. From this release on, an update that brings steps warns, backs up and runs them, as described under [Machine migrations](#machine-migrations). A CLI at 0.37.0 or older replaces itself without asking, so an update from one of them skips the warning and the backup of the binary: the first dispatch tick of the new binary runs the steps.

### Machine migrations (CLI 0.37.0)

The CLI alone changes. No release declares a migration step yet, so updating to 0.37.0 changes nothing on a machine. It adds the machinery that later releases use to change a machine's own files, and the command that continues a migration which stopped.

- `board self-update --resume` runs the steps a stopped migration still lists, then restarts the listener and the watch unit. With nothing to run it prints `nothing to resume`. It works on a checkout too, cannot be combined with `--check`, and from a terminal refuses while workers run.
- The state directory (`~/.local/state/agent-board`, or `AGENT_BOARD_STATE_DIR`) gains `migration/applied.json`, the version whose steps are applied, written by `board init` on a new machine and by `board self-update --resume` on an older one. A machine that has a `web.json` and no marker counts from 0.37.0, so it receives every step declared after that release.
- A migration that has steps to run first copies `web.json`, `env`, `config.json` and the unit files into `backups/<time>-<kind>-<from>-<to>/` in the state directory. The backup holds the machine token and the data key, so the directory is mode 700 and its files mode 600. The three newest backups stay.
- While a migration is unfinished, `migration/journal.json` lists its steps and the ones done. `board self-update --resume` reads it, and a journal it cannot read is reported with its path and changes nothing.

### Feeds, plugins and Settings › Feeds (CLI 0.34.0)

The CLI adds `board feeds`, `board plugins` and a `feeds` key in `config.json` (see [Feeds](usage.md#feeds) and [Plugins](plugins.md)). The server adds the feature `machine.feeds`, migrations `0047_machine-sources`, `0050_drop-machine-sources` and `0051_machine-feeds`, and the **Feeds** page under Settings. The migrations run when the backend starts. Deploy and release in any order. No `MIN_CLIENT` or `API_VERSION` change.

Until a machine runs this CLI, it sends no feeds and the page lists nothing for it. CLI 0.33.0 has `board sources` and a `sources` key in `config.json`. They are renamed with no alias, so a machine that configured sources moves them by hand:

1. Re-add each entry as a feed under `feeds` with `board feeds add`. A feed takes an integration from a marketplace in place of the `command`, and an entry with a `command` or a key prefix is a config error that `board feeds` shows.
2. Delete the `sources` key. CLI 0.34.0 only warns about it (`unknown key "sources", ignored`), and its sources stop without an error.
3. Delete `~/.local/state/agent-board/sources/`, which nothing reads any more.

Expect one duplicate task per open item, once: the old tasks are keyed `source:<name>:` and the feed keys its tasks `feed:<name>:`. Until the machine runs 0.34.0, its 0.33.0 sources keep running, and the page does not list them.

On each machine:

1. Update the CLI: `board self-update`, or `git pull`, `pnpm install` for a checkout.
2. Restart the watch unit, which runs the feeds, and the listener, which keeps the old code until it restarts: `board restart watch listen`. That is `systemctl --user restart agent-board-watch agent-board-listen` on Linux; on macOS `board restart` kickstarts the launchd agents. `board self-update` restarts the listener itself.
3. Make sure `git` and the integration's interpreter (the first line of its program, such as `python3`) are on the units' PATH. `board doctor` checks both: a missing `git` is a warning, and a missing interpreter makes the integration's check fail.
4. Install a marketplace: `board plugins install <url>`.
5. Add the feed: `board feeds add <name> <file>`, with `integration`, `action`, `options` and `prompts` (see [feeds](#feeds)).

If a `github-reviews.sh` timer already makes review tasks on this machine, stop it before step 5. A feed keys its tasks as `feed:<name>:<url>` and the script keys them as `<url>`, so both would make a task for each open review request. Expect one duplicate per open review request, once, for the tasks the script already made.

### `board watch --ci --ignore` and `ciIgnore` (CLI 0.31.0)

The CLI alone changes: `--ignore <pattern>` on `board watch --ci`, and the `ciIgnore` setting of a `dirs` entry (see [dirs](#dirs) and [CI](usage.md#sources)). The server and the contract stay as they are, and the patterns are never sent to the board. Update machines in any order.

- A watch with ignore patterns is a watch file with one more key. A watch unit that still runs the older CLI reads it and ignores the key, so its `--ci` watch counts the ignored checks again, and it writes the watch back without the key. Restart the unit after updating a checkout install: `board restart watch`. `board self-update` restarts it.
- An older CLI refuses a config that has `ciIgnore`: `parseConfig` throws `has no setting "ciIgnore"`, and every command that reads the config stops with that error. That includes each dispatch tick (the timer's and the ones the listener starts), every worker, `board watch`, `board dirs` and `board doctor`, so a machine with a stale CLI stops dispatching. The listener and the watch unit themselves do not read config.json, so they keep running, but the ticks the listener starts fail. Add `ciIgnore` only after every CLI on the machine runs the new version: `board self-update`, or on a checkout install `git pull`, `pnpm install` and `board restart`.
- `--ignore` alone needs no config change.

### Title rules set labels

A new server feature, `task.title-rule-labels`. A title rule can set labels as well as an icon and a title (see [Title rules](usage.md#title-rules)): Settings › Titles has a labels field per rule, and the worker sets them at run start on a task that has none. No migration, and no version number is raised.

Update the server first, then the CLI on every machine before you save a rule that sets labels and nothing else.

- A machine on an older CLI applies the icon and title of a rule and ignores its labels.
- An older CLI cannot read a rule that sets only labels, so it finds the whole document unreadable and applies no rule at all. Its task log says `the title rules cannot be decrypted with this machine's data key`. A rule that also sets an icon or a title does not have this problem.
- A newer CLI against a server without the feature logs `labels not set: …` and still applies the icon and the title.

### A task carries labels

A new server feature, `task.labels`. A task and a schedule take a list of labels, sealed like the title, that the board shows as badges on the card and the task page (see [Labels](usage.md#labels)). The card, the task page and the New task form can change them, and `board schedule --label`, `board add --label`, `board schedules edit --label` and `board task <task> set labels` set them. A migration adds a `labels` column to `task` and `schedule`. Nothing changes for the tasks you have, and no version number is raised.

Update the server first. A server without `task.labels` makes the flags refuse with "the board server does not support task labels yet; update the board server", and nothing else changes. A machine on an older CLI ignores the field, and labels never change how a task runs.

### A task shows an icon

A new server feature, `task.icon`. A task and a schedule take one emoji, sealed like the title, that the board shows at the left of the card's title (see [Icon](usage.md#icon)). The board, the task page and the New task form have a picker for it, and `board schedule --icon`, `board add --icon`, `board schedules edit --icon` and `board task <task> set icon` set it. A migration adds an `icon` column to `task` and `schedule`. Nothing changes for the tasks you have, and no version number is raised.

Update the server first. A server without `task.icon` makes the flags refuse with "the board server does not support task icons yet; update the board server", and nothing else changes. A machine on an older CLI ignores the field, and the icon never changes how a task runs.

### Context usage on the task page (CLI 0.33.0)

A new server feature, `transcript.context`. The worker reports how full the main agent's context window is, and the task page shows it as a bar (see [Context usage](workers.md#context-usage)). A migration is not needed and no version number is raised.

Deploy the server and release the CLI in any order. A machine on an older CLI reports nothing, and its runs show no bar. A CLI against a server without the feature sends no context events, and its transcripts are unchanged.

### A task names its effort (CLI 0.32.0)

A new server feature, `task.effort`. A task and a schedule take an effort level (`low`, `medium`, `high`, `xhigh` or `max`) that the worker passes to `claude` as `--effort`. `board schedule --effort`, `board schedules edit --effort` and `board task <task> set effort` set it, and the New task form, the task page and the schedule editor have an **Effort** select (see [Effort](usage.md#effort)). A migration adds an `effort` column to `task` and `schedule`. Nothing changes for the tasks you have, and no version number is raised.

Update the server first. A server without `task.effort` makes the flags refuse with "the board server does not support choosing an effort level yet; update the board server", and nothing else changes. A machine on an older CLI ignores the field and runs every task at claude's default effort.

### Agents on the board (CLI 0.32.0)

A new server feature, `agents.shared`: `board agents push` puts an agent on the board, and every machine applies it on its next tick (see [Agents on the board](workers.md#agents-on-the-board)). A migration adds the table `shared_agents`. No version number is raised.

Update the server first; against an older one `push` and `rm --board` refuse with "the board server does not support … yet". Then update the CLI on each machine that should run board agents.

- A machine on an older CLI ignores the board's agents and runs only its own. A task that names a board agent waits in Todo for a machine that has it.
- The first apply on a machine moves its own definition of each board name (an `agents/` file or a `config.json` entry) to `agents.replaced/`. Push one agent at a time and check `board agents` on the other machines.
- Read the accepted limit under [Agents on the board](workers.md#agents-on-the-board) before you push: a run that reads the data key can push a definition every machine applies.

### Changing every setting of a schedule (CLI 0.30.0)

A new server feature, `schedule.update`. `board schedules edit` takes the settings of the Edit schedule dialog as flags: `--priority`, `--model`, `--lane`, `--auto-done`, `--agent`, `--dir`, the repeat (`--every`, `--cron`, `--after` with `--delay`), the first run (`--in`, `--at`), the end (`--times`, `--until`, `--forever`) and `--max-concurrent` (see [Managing schedules](usage.md#repeating-schedules)). The text became optional. Nothing changes in the database, and no version number is raised.

`--lane` also needs `task.lane`. Update the server first. A server without `schedule.update` makes a setting flag refuse with "the board server does not support changing every setting of a schedule yet; update the board server", and nothing else changes: a title or prompt alone still works with `prompt.edit`. A machine on an older CLI has no such flags and runs everything as before.

### A task names its lane

A new server feature, `task.lane`. A task and a schedule take a lane, and a task no longer gets its lane from the skill its prompt starts with. `board schedule --lane`, `board add --lane` and `board task <task> set lane` set it, and the New task form, the task page and the schedule editor have a **Lane** select (see [Lane](usage.md#lane)). A migration adds a `requested_lane` column to `task` and `schedule`. Nothing changes for the tasks you have, and no version number is raised.

Update the server first. A server without `task.lane` makes the flags refuse with "the board server does not support choosing the lane a task runs in yet; update the board server", and nothing else changes.

**Rewrite `lanes` in `config.json`.** Mark one lane `"default": true` and drop the `skills` lists: the lane for every task that names none, or one this machine lacks. Before:

```json
"lanes": {
  "reviews": { "skills": ["review-pr"], "slots": 2 },
  "general": { "skills": ["*"], "slots": 3 }
}
```

After:

```json
"lanes": {
  "reviews": { "slots": 2 },
  "general": { "slots": 3, "default": true }
}
```

A config with `skills` keeps loading for this release: the `skills` lists are ignored, and the lane whose list had `*` is the default (the first lane when none had it). `board doctor` and the dispatch log warn about each one. A config that marks no lane takes the first lane as the default, and one with two marked is refused. To move the mark, run `board config set lanes.general.default false`, then `board config set lanes.reviews.default true`.

**Pass `--lane` from scripts.** A task that used to land in `reviews` because its prompt began with `/review-pr` now lands in the default lane, since a prompt picks nothing. Add `--lane reviews` to the `board schedule` calls of your scripts. The `github-reviews.sh` example does, with `BOARD_LANE` to change the name; run `board example github-reviews.sh` for the new copy. A task that is already on the board has no lane either, and `board task <task> set lane reviews` sets one.

- A machine on an older CLI ignores the field: its tasks keep their lane from their skill, and its config keeps working.
- A newer CLI on a server without `task.lane` runs every task in the default lane of the machine.
- Restart the listener after updating (see [Restarting the listener](#restarting-the-listener)); it keeps the old dispatch code until then.

### Schedule rules and limits (CLI 0.29.0)

Four new server features: `schedule.crons`, `schedule.max-concurrent`, `schedule.after` and `task.held`. `board schedule` takes `--cron` several times, `--max-concurrent <n>` and `--after <schedule> [--delay <dur>]` (see [Repeating schedules](usage.md#repeating-schedules)). A migration adds columns to `schedule` and `task`. Nothing changes for the schedules you have, and no version number is raised.

Update the server first. A server without the feature makes the flag refuse with "the board server does not support … yet", and nothing else changes.

- A machine on an older CLI does not see a schedule that runs after another: `board schedules` leaves it out there. Its tasks run on any worker.
- An older worker does not know that a task waits for a free slot of its schedule. It tries to claim the task, the board refuses, and it moves on, so the limit holds.

### Editing a prompt (CLI 0.28.0)

A new server feature, `prompt.edit`. `board task <task> set prompt` and `board schedules edit` change the prompt of a task that has not started and of a schedule, as the task page and the Schedules page do (see [Editing the prompt](usage.md#editing-the-prompt)). Nothing changes in the database, and no version number is raised.

Update the server first. A server without `prompt.edit` makes both commands refuse with "the board server does not support editing a prompt yet; update the board server", and nothing else changes. A machine on an older CLI has no such command and runs everything as before.

- `board doctor` warns about a server without `prompt.edit`.

### Forking a task (CLI 0.25.0)

A new server feature, `task.fork`. On the task page, **Fork** makes a new task that continues a copy of the task's Claude session (see [Forking a task](usage.md#forking-a-task)). A migration adds the column `fork_of` to `task`. Nothing changes for a task that is not a fork, and no version number is raised.

Update every machine that runs tasks before you fork, in any order against the server. A CLI that does not know forks cannot open the prompt of one, because the prompt is sealed under a context that includes the parent's id (see [Forks](encryption.md#forks)). Its dispatcher logs `SKIP <id> cannot decrypt its input` and the task stays in Todo until the CLI is updated. It never runs the fork as a plain task. The board does not know which CLI a machine runs, so it does not stop you from forking a task of such a machine.

- The fork runs on the machine of its parent, so only that machine needs the update.
- `board task <id>` shows `fork of` for a fork.
- `board doctor` warns about a server without `task.fork`. Such a server has no Fork button either.

### `board watch --pr-merged` (CLI 0.24.0)

A new watch source: one event when a pull request is merged or closed (see [Sources](usage.md#sources)). Nothing changes on the server, and no feature name is added.

- The watch unit polls it, so restart the unit after updating the CLI on a checkout install: `board restart watch`. `board self-update` restarts it. A unit that still runs the older CLI skips the watch file with a warning in its log until then.
- On the board, the watch shows as `merge of #<n>` once the web app is the version that knows the `pr-merged` kind. An older one leaves the entry out of the list and shows the task's other watches.
- The shipped `reviewer` agent's allow list is unchanged. An agent that should wait for a merge needs `Bash(board watch * --pr-merged)` and `Bash(board watch * --pr-merged *)` in its `allowedTools`.

### Stream watches (CLI 0.23.0)

The CLI alone changes: `board watch <task> --name <name> --stream -- '<command>'` keeps a command running in the watch unit and reports its output lines as events (see [Sources](usage.md#sources) and [Streams](workers.md#streams)). The server and the contract stay as they are. Update machines in any order.

- On a checkout install, restart the watch unit after updating: `board restart watch`. `board self-update` restarts it. A unit that still runs the older code skips a stream watch and logs that it cannot read its file.
- A stream needs the watch unit. On a machine without it, `board watch --stream` is refused; run `board setup --enable`.
- The board shows a stream once the server of this version is deployed. An older page leaves the watch out of its list.

### `board watch --pr-review` (CLI 0.22.0)

A new watch source: the first review or comment someone else leaves on a pull request (see [Sources](usage.md#sources)). Nothing changes on the server, and no feature name is added.

- The watch unit polls it, so restart the unit after updating the CLI on a checkout install: `board restart watch`. `board self-update` restarts it. A unit that still runs the older CLI skips the watch file with a warning in its log until then.
- On the board, a review watch shows once the web app is the version that knows the `pr-review` kind. An older one leaves the entry out of the list and shows the task's other watches.
- The shipped `reviewer` agent's allow list is unchanged. An agent that should wait for reviews needs `Bash(board watch * --pr-review)` and `Bash(board watch * --pr-review *)` in its `allowedTools`.

### Watch times and a self-repairing watch list (CLI 0.21.1)

The CLI alone changes. Run `board self-update` on each machine, or pull and restart the units on a checkout (`board restart`).

- `board watch` names a timer's end once, and an end less than ten minutes away is shown to the second.
- The dispatch tick publishes a task's watches again when the board's list is not the machine's (see [Publishing and stops](workers.md#publishing-and-stops)). On a server without `task.watches` this logs the "does not show watches yet" line on every tick while a task there has open watches.

### Watches on the board (CLI 0.21.0)

A new server feature, `task.watches`. The CLI publishes the sealed list of a task's watches, and the server stores it with the stop requests of the user. The board shows a badge on the card and a **Watches** list on the task page (see [What the board shows of watches](usage.md#what-the-board-shows-of-watches)). A migration adds the columns `watches` and `watch_stops` to `task`.

Update in any order. A CLI sends nothing to a server without the feature and logs one line per process. A server without a CLI that publishes shows no list.

- **Stop** needs both: the dispatch tick of the task's machine ends the watch.
- On a checkout install, restart the watch unit after updating the CLI: `systemctl --user restart agent-board-watch`. `board self-update` restarts it and the listener.
- Watches that are open during the update appear on the board at their next change, or when the task's next watch command runs.

See [Publishing and stops](workers.md#publishing-and-stops).

### `board config` and `board task` (CLI 0.20.0)

Two new commands. `board config` shows and changes this machine's `config.json`. `board task` shows a task's settings and changes its priority, model and working directory. The task page has the same controls for model and directory.

`board config` needs nothing from the server. Changing a task needs the server feature `task.configure`. Update in any order: a machine on an older CLI still runs a changed task correctly.

### Usage status on the board (CLI 0.19.0)

A new server feature, `machine.usage`. The CLI sends a sealed usage status at the end of every dispatch tick, whether or not the machine has `usageLimits`. The board shows a badge on held Todo cards and a usage line in Settings › Machines (see [Usage limits](workers.md#usage-limits)). No worker reads the status.

Update the server first. A migration adds three columns to `machine`.

### Usage limits (CLI 0.18.0)

The CLI alone changes. A machine with `usageLimits` in its `config.json` leaves Todo tasks below a priority unclaimed while its Claude usage is at or over a threshold (see [Usage limits](workers.md#usage-limits)). Nothing changes without the key. Run `board self-update` on each machine that should use it.

### Watches (CLI 0.17.0)

The CLI alone changes: `board watch`, `board watches` and `board unwatch`, a new unit that polls them, and new rules text for runs (see [Waiting](usage.md#waiting)). Update machines in any order. On each machine:

1. Update the CLI.
2. Run `board setup --enable` to install, enable and start the watch unit. Plain `board setup` writes it and prints the command that starts it.
3. Run `board doctor`.

Until the unit runs, the dispatch tick polls the watches at its own pace and logs `WARN … the watch unit is not running; run "board setup --enable"` on each tick.

A `board wait --check` that is open during the update keeps working. Runs that started before the update keep the rule they were given and park with `board wait`, which still works.

### Skills and models on the board (CLI 0.16.0)

A new server feature, `machine.catalog`. The CLI asks `claude` which skills and models the machine has and sends the answer sealed. The browser uses it to complete `/skill` in a prompt or reply and to fill the New task form's Model field. No worker reads it.

Update the server first. A migration adds three columns to `machine`. An updated machine then starts `claude` without a prompt, in one of its directories per dispatch tick. [Skills and models on the board](workers.md#skills-and-models-on-the-board) says what that does and costs.

### A task can hold several pull requests (CLI 0.15.0)

A new server feature, `task.prs`. `board pr` adds a PR instead of replacing the earlier one, and the dispatcher writes the state of each PR. `board pr --remove` needs the server feature `task.pr-remove`.

Update the server first, then every machine. A CLI up to 0.14.0 still works against the new server, but its `board pr` replaces every PR of the task, including the ones a newer CLI added.

The migration moves each task's reported PR into the new `task_pr` table and keeps its state. On a task that also had a reported PR, the state of the PR the prompt names is unknown until the next dispatcher tick, within about 10 minutes.

`board tasks --json` and `board show --json` carry `prs` and `promptPrState` in place of `pr` and `prState`. A script that reads the old keys needs changing.

### Runs are told apart by a run id (CLI 0.14.0)

A new server feature, `task.run`. Every claim gets a run id, and a worker and its agent send it with their calls for the task. An agent left over from a run that was taken back and claimed again on the same machine can then not pause, fail, wait, ask on or move the new run (see [Runs](machine-api.md#runs)).

Update in any order. Until a machine is updated and its listener restarted, its runs are checked by machine only. Runs already going when it updates get the id from their next claim.

### The built-in intake is removed (CLI 0.13.0)

The CLI alone changes. The intake timer and service, the `intake` key of `config.json` and the intake checks of `board doctor` are gone. The `github-reviews` script makes the review tasks instead (`board example github-reviews.sh`).

Update every machine before the script runs anywhere. A CLI that still has the intake would requeue the script's tasks sealed for the creator `intake`, which makes them unreadable.

On each machine that used the intake:

1. Update the CLI and run `board setup`. It stops and deletes the intake timer and service, and says so. Restart the listener.
2. Delete the `intake` key from `config.json` and move its lists into `agents.<name>`. `apps/cli/examples/config.reviews.json` shows the `reviewer` agent. Until then the CLI ignores the key with a warning on each dispatch tick and `board doctor` fails. Nothing stops.
3. Install the script and run it on a timer. [Review requests from GitHub](usage.md#review-requests-from-github) has the unit and the cron line.

What happens to tasks the intake made:

- A task with an agent runs as that agent, and the script requeues it like its own. Once a machine has run it, it stays on that machine like any task. **Re-run fresh** unpins it.
- A task without an agent never runs. A worker that claims one fails it with a note. Close it, or create it again with `board schedule --agent <name>`.
- Such a task shares the script's key, the bare PR URL. For its PR the script answers `exists (other-agent)` and never reviews it again. Closing the task does not help, because a closed key stays closed. `KEY_PREFIX=github-review:` makes the script use new keys. Every open PR is then reviewed once more, as a duplicate.

### Directory settings

The CLI alone changes: `board dirs set` and `unset`, and four settings in the `dirs` entries of `config.json` (see [dirs](#dirs)). Nothing changes on a machine that does not use them, and the server needs no update.

A label travels inside the sealed directory list. The New task form shows it once the web app is deployed too.

### Directory lists on the board

A new server feature, `machine.dirs`. A machine with a `dirs` key sends its list sealed, from its next dispatch tick or its next `board dirs` change. The New task form offers these directories in its Working directory field. The copy is advice and no worker reads it.

Update the server first. A migration adds three columns to `machine`. `board doctor` warns about a server without the feature.

### The `dirs` list is enforced

The CLI alone changes. Nothing changes on a machine until its `config.json` has a `dirs` key, and the first `board dirs add` creates it. Before that, on each machine:

1. Run `board dirs add --from-config`. It lists `defaultCwd`, the lane `cwd`s and the `repos` checkouts that exist.
2. Add the directories you schedule from.
3. Run `board doctor`, which fails for a route the list does not cover.

Existing tasks meet the list at their next start:

- A task in Todo, or a resume, whose directory is not listed goes to Needs me with the reason. List the directory, then press **Re-run fresh** or **Send & continue**.
- A running task finishes.
- A waiting task is woken and then checked like any resume.
- `board schedule` refuses in an unlisted directory.

### Tasks that run as an agent

A new server feature, `task.agent`. The server stores the sealed `agent` of a task and of a schedule, and a migration adds the column to both. Nothing changes for a task without an agent.

The order matters, because a CLI that does not know the field cannot run such a task, only skip it:

1. Update the server.
2. Update every machine's CLI, and define the `agents` the tasks will name in each machine's `config.json` (see [Agents](workers.md#agents)). `board doctor` checks them. Do this before anyone sets an agent.
3. Then use `--agent` or the form's Agent field.

An older CLI cannot open the prompt of such a task, because the prompt is sealed under a context that includes the agent's name (see [Encryption](encryption.md#encryption)). Its dispatcher logs `SKIP <id> cannot decrypt its input` and its worker fails the task without running `claude`. So an older CLI can leave an agent task waiting in Todo, but it never runs one with your permissions.

### Removed

- **Slack.** The Slack integration is gone, including `board notify` and the `slackWebhookFile` key. Remove the key from `config.json` and revoke the old incoming webhook in Slack. A CLI that was not updated keeps posting through it, in clear text.

### Updating the CLI

The board server knows the newest CLI release (`CLI_VERSION`, see [The board server](operations.md#the-board-server)), and every CLI reports its own version. So both sides can tell when a machine is behind.

#### On the board

**Settings › Machines** lists each machine's CLI as the machine last reported it:

| Shown                                          | Meaning                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `0.7.0`                                        | Current.                                                                                   |
| `0.5.0 · update available`                     | Older than the newest release.                                                             |
| `0.4.0 · incompatible — run board self-update` | Its API level is below the server's `minClient`. Its dispatcher fails until it is updated. |
| `version unknown`                              | The machine has not reported a version.                                                    |

A checkout's `x.y.z-dev` compares as `x.y.z`. The board page shows a banner naming every machine that is incompatible, was seen in the last 24 hours and whose token is not revoked.

#### The hint

When a command that reached the board learns of a newer release, it prints one line on stderr after its output:

```text
board 0.7.0 is available (this is 0.6.0); run "board self-update"
```

A checkout is told to `git pull` instead. The hint appears at most once per 24 hours and only when stderr is a terminal. It never appears inside a board run or from `board internal`.

#### `autoUpdate`

The `autoUpdate` key of `config.json` lets the dispatcher fetch the CLI itself.

| Value                    | What the dispatcher does                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `incompatible` (default) | Updates when a tick fails because the board refuses this CLI as too old.                                                                                 |
| `always`                 | Also updates at the start of a tick when the board advertises a newer release and no worker runs. While a worker runs it logs `UPDATE-WAIT` and goes on. |
| `never`                  | Leaves it to you.                                                                                                                                        |

An update runs `board self-update` in-process and asks systemd to restart the listener without waiting. The tick logs what happened and ends with success, and the next tick runs the new binary. When the release declares migration steps, the update does not ask, and the next tick runs them: see [Machine migrations](#machine-migrations). Workers run as their own transient units, so the listener restart does not stop them.

When it does not work:

- If the update fails, for example because `gh` is missing or not logged in, the dispatcher logs the reason and does not try again for one hour.
- If the advertised release is not published yet, it tries again after 5 minutes.
- In that time a too-old dispatcher skips its ticks with one `UPDATE-SKIPPED` line each and exit code 0.
- A checkout never updates itself. It logs `UPDATE-NEEDED` with the `git pull` hint on each tick, and a too-old checkout's tick still fails.

After a [rollback](#rolling-back) the dispatcher does not install the release it rolled back from, or an older one. It logs `UPDATE-HELD <version> was rolled back; run "board self-update" to take it`, the tick goes on, and a too-old CLI's tick still fails so the machine does not look healthy. Run `board self-update` to lift the hold.

The dispatcher records the attempt in `update.json` before it starts, so a tick that its time limit kills does not start the download over on every tick. Each `gh` call is limited to 90 s.

The listener of a machine whose CLI is too old exits on the mismatch and starts no ticks. The update on such a machine comes from the 2-minute dispatch timer.

## Config

Machine settings are in `~/.config/agent-board/config.json`. `AGENT_BOARD_CONFIG_DIR` changes the directory.

`board config` shows the file. `board config set maxRunHours 4` changes one key and `board config edit` the whole file, both with a check before anything is written (see [Using the board](usage.md)). A text editor works as well.

| Key                 | Meaning                                                                                                                                                                                          | Default                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `machine`           | This machine's name on the board. It must match the name of its token. See [Machine names](#machine-names).                                                                                      | The host name up to the first dot. |
| `lanes`             | Lane name to `{ "slots": n, "cwd": "<path>", "default": true }`. `cwd` is optional, and at most one lane is marked `default` (without a mark, the first lane is). See [Lanes](workers.md#lanes). | `general`, 3 slots, the default.   |
| `defaultCwd`        | Where a task without a directory of its own runs.                                                                                                                                                | `~`                                |
| `repos`             | `owner/name` to local checkout. A task whose prompt names a PR of that repository runs there.                                                                                                    | None.                              |
| `pauseAfterMinutes` | A borrowed run is paused for its lane's own work only after this long.                                                                                                                           | 5                                  |
| `inactivityMinutes` | A run with no tool call for this long is stopped.                                                                                                                                                | 15                                 |
| `maxRunHours`       | A run is stopped after this long, however busy.                                                                                                                                                  | 6                                  |
| `autoUpdate`        | What the dispatcher does when this CLI is behind the board. See [`autoUpdate`](#autoupdate).                                                                                                     | `incompatible`                     |
| `usageLimits`       | Holds Todo tasks back while Claude usage is high. See [usageLimits](#usagelimits).                                                                                                               | Absent.                            |
| `agents`            | Named agents a task can run as. See [agents](#agents).                                                                                                                                           | Absent.                            |
| `dirs`              | The directories workers may run in. See [dirs](#dirs).                                                                                                                                           | Absent.                            |
| `feeds`             | Integrations from installed plugins that make this machine's tasks from other tools, on a timer. See [feeds](#feeds).                                                                            | Absent.                            |

An `intake` key is ignored with a warning, and `board doctor` fails on it. See [The built-in intake is removed](#the-built-in-intake-is-removed-cli-0130).

### Machine names

A name is 1 to 64 characters of letters, digits, `.`, `-` and `_`, starting with a letter or digit. The CLI states this when it refuses a name.

An older token may carry a name outside that shape. It keeps working for what the machine API allows. Settings › Machines shows its name as `(invalid)` and still offers **Revoke**. To use the machine again, issue it a token under a valid name and set `machine` to it.

### usageLimits

```json
"usageLimits": { "fiveHour": 80, "sevenDay": 90, "priority": "urgent" }
```

- `fiveHour` and `sevenDay` are whole percents from 1 to 100. Each is optional, and a window without a number is not limited.
- `priority` is the lowest priority that still starts: `urgent` (the default), `high` or `normal`. `low` is refused, since it would hold nothing.

[Usage limits](workers.md#usage-limits) describes what is held and when.

### agents

Each agent has `description` and `tools`, and optionally `prompt`, `allowedTools`, `disallowedTools`, `mcpServers`, `env` and `model`. An unknown key inside an agent makes that agent unusable.

An agent can also be a file in the `agents` directory beside `config.json`, which `board agents add` writes, or a definition the board holds for every machine, which `board agents push` puts there. A task names an agent with `board schedule --agent` or the New task form. [Agents](workers.md#agents) has the details.

### feeds

An object keyed by feed name (1 to 40 letters, digits, `.`, `-` and `_`, starting with a letter or digit). The board shows at most 30 feeds per machine: `board feeds add` refuses a 31st, and when config.json holds more, only the first 30 are sent and `board feeds` and `board doctor` warn.

```json
"feeds": {
  "gh-review-requests": {
    "integration": "mloureiro:github",
    "action": "list-pull-requests",
    "options": { "repositories": ["acme/app"], "query": "is:open draft:false review-requested:@me" },
    "every": "10m",
    "dir": "~/workspace/acme/app",
    "agent": "reviewer",
    "lane": "reviews",
    "prompts": {
      "new": "/review-pr {url} --auto",
      "update": "{url} changed since your last review. Review it again: /review-pr {url} --auto"
    }
  }
}
```

| Key              | Rule                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `integration`    | Required: `<marketplace>:<integration>` of an installed marketplace (see [Plugins](plugins.md)). It is never looked up on `PATH`.  |
| `action`         | Required: an action the integration describes.                                                                                     |
| `options`        | Optional JSON object, at most 16 KiB. The integration's own settings, checked against the action's schema.                         |
| `every`          | Required duration of at least `1m`.                                                                                                |
| `dir`            | Required: where the integration runs and where an item without a directory of its own makes its task. It must be listed in `dirs`. |
| `agent`, `lane`  | Optional. They apply to every task the feed makes.                                                                                 |
| `timeout`        | Optional: the longest one run may take. Default `2m`, at most `30m`.                                                               |
| `prompts.new`    | Required text of 1 to 10 000 characters: the prompt of a new task.                                                                 |
| `prompts.update` | Required text of 1 to 10 000 characters: what the session is told when its item changed.                                           |

A `{name}` in a prompt is replaced by the item's `key`, `title`, `version` or a field the action provides. A `command` and a key prefix no longer exist: a feed with them is a config error.

A feed with a bad setting is not run, and `board feeds` says why. The other feeds and the rest of the config are not affected. Manage it with `board feeds add`, `rm`, `run`, `pause` and `resume` (see [Feeds](usage.md#feeds)).

### dirs

An object keyed by path, where `~/` works. Each value holds the directory's settings, or `{}` for none:

```json
"dirs": { "~/workspace/acme/app": { "label": "App", "repo": "acme/app" } }
```

Manage it with `board dirs add`, `rm`, `set`, `unset` and `list`, which rewrite only this key.

`board dirs add` sets `repo` itself when the directory is the top level of a git checkout (not a subdirectory, not a linked worktree) whose remote is a GitHub repository. The remote is the one of the current branch's upstream, else `origin`; only `git@github.com:`, `https://github.com/` and `ssh://git@github.com/` URLs count. It sets nothing, and says why, when another entry has that repo or `repos` maps it to a different path. `--no-repo` skips it. Adding a listed directory again sets or corrects its `repo` the same way and keeps its other settings; when git gives no repo, an existing `repo` stays and `add` says it could not confirm it. The remote is read on the machine and `repo` is never sent to the board.

| Setting    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`    | A short name the New task form shows with the path. 1 to 64 characters, no control characters, no space around it. The only setting the board is sent.                                                                                                                                                                                                                                                                                                                        |
| `repo`     | `owner/name`. The directory is that repository's checkout, like a `repos` entry.                                                                                                                                                                                                                                                                                                                                                                                              |
| `default`  | Only `true`. Tasks without a directory run here, like `defaultCwd`. At most one entry.                                                                                                                                                                                                                                                                                                                                                                                        |
| `lane`     | A lane of this config. That lane's tasks without a directory run here, like the lane's `cwd`. At most one entry per lane.                                                                                                                                                                                                                                                                                                                                                     |
| `ciIgnore` | A list of 1 to 20 check names that `board watch --ci` leaves out, started in this directory or one below it (see [CI](usage.md#sources)). Each name is up to 100 characters without control characters, and `*` stands for any characters. Stays on this machine: the board is not sent it. `board dirs set ciIgnore 'policy-bot*,hold *'` takes a comma-separated list and replaces the whole list, so a name cannot hold a comma there; edit config.json for one that does. |

A setting wins over the key it stands for (`repos`, `defaultCwd`, a lane's `cwd`). Those keys keep working, and `board doctor` and the dispatch log warn when a setting overrides a different path.

`ciIgnore` is for checks that wait for a person and never finish alone, such as an approval gate like policy-bot or a CI hold job. A `--ci` watch looks up the entry with the longest path that covers its working directory, so a worktree below a listed checkout takes the checkout's list, and merges it with its own `--ignore` flags. It reads the list once, when the watch starts: a later change of the config does not touch a watch that is open.

The CLI refuses a config with an unknown setting, a bad value, two entries with the same `repo`, `default` or `lane`, or a `lane` that is not one of `lanes`. The list holds at most 200 entries.

**The list is enforced from this file.** Without the key, workers run anywhere. With it, even as `{}`, a run starts only in a listed directory or below one. [Where a task runs](workers.md#where-a-task-runs) has the rules.

`board doctor` warns about a listed directory that is gone. It fails for a `defaultCwd`, lane `cwd` or `repos` checkout that the list does not cover.

The CLI also sends the listed directories that exist to the board as a sealed copy, for the New task form's Working directory field. No worker reads that copy back.

### Files

The config directory is `~/.config/agent-board` (`AGENT_BOARD_CONFIG_DIR`):

| Path               | Purpose                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `config.json`      | The machine settings above.                                                                                                          |
| `web.json`         | The board's `url`. Plain `http` is refused except for localhost.                                                                     |
| `env`              | The token and the data key.                                                                                                          |
| `agents/`          | Agent definitions as files, one per agent.                                                                                           |
| `agents.board/`    | The board's agent definitions as this machine applied them, and `state.json` with the version and hashes. Written by the apply only. |
| `agents.replaced/` | Local definitions an apply moved aside for the board's. Nothing reads them.                                                          |

The CLI builds every task link it prints as `<url>/t/<id>` from `web.json`. The board's own answers carry no link. The CLI reads `web.json` and `env` on its first call to the board, so a command that fails on a usage error needs neither.

The state directory is `~/.local/state/agent-board` (`AGENT_BOARD_STATE_DIR`, or `XDG_STATE_HOME`):

| Path                         | Purpose                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `logs/<task>.log`            | The task's log, emptied when a worker starts. The worker's own fatal errors are appended to it.                |
| `sessions/<task>`            | The Claude session this machine started for the task.                                                          |
| `watches/<task>/`            | The task's watches and their events (see [Watches](workers.md#watches)).                                       |
| `waits/<task>.json`          | A check stored by `board wait --check` (see [Waiting](usage.md#waiting)).                                      |
| `worktree-locks/<task>.json` | The worktrees the task locked (see [Where a task runs](workers.md#where-a-task-runs)).                         |
| `catalog/`                   | What `claude` reported as skills and models, one file per directory.                                           |
| `usage.json`                 | The usage this machine's runs reported, one entry per window (see [Usage limits](workers.md#usage-limits)).    |
| `context-windows.json`       | The context window each model reported in this machine's runs (see [Context usage](workers.md#context-usage)). |
| `pr-refresh.json`            | The time of the last PR state lookup.                                                                          |
| `update.json`                | The last update hint and the last self-update attempt.                                                         |

The dispatcher deletes a task's log and session record once the task is done, closed or deleted and the file has not changed for 14 days. A task in any other column keeps them, so it can still be resumed. A done task brought back after that cannot resume its session and needs **Re-run fresh**.

The run directory holds what lives only while runs go on: heartbeats, pause flags and the dispatch lock. It is `$XDG_RUNTIME_DIR/agent-board` on Linux and `~/.local/state/agent-board/run` on macOS. `AGENT_BOARD_RUN_DIR` overrides it.
