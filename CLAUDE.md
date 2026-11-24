# CLAUDE.md

agent-board is a board for headless Claude Code runs: a Fastify/tRPC backend, a React frontend, and the `board` CLI that runs workers on the user's machines. Content is end-to-end encrypted. Read [docs/architecture.md](docs/architecture.md) before changing anything that crosses the CLI/server boundary, sealing, or how runs start.

## Where to look

| Question                                                      | Read                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| How the parts fit, design decisions, rules a change must keep | `docs/architecture.md`                                    |
| What a user sees and does                                     | `docs/usage.md`                                           |
| Dispatch, lanes, worker permissions, how a run starts         | `docs/workers.md`                                         |
| Sealing contexts and the threat model                         | `docs/encryption.md`, `packages/shared/src/sealing.mts`   |
| The UI API a custom UI builds on                              | `docs/ui-api.md`                                          |
| CLI ↔ server wire protocol                                    | `docs/machine-api.md`, `packages/shared/src/contract.mts` |
| Feed plugins, marketplaces, the integration protocol          | `docs/plugins.md`                                         |
| Install, config keys, upgrade steps per contract              | `docs/setup.md`                                           |
| Server env, sign-in setup, deploy, cutover                    | `docs/operations.md`                                      |
| Tests, migrations, releases                                   | `docs/development.md`                                     |

## Commands

```
mise exec -- pnpm install
docker compose up -d postgres                      # :54331, board_dev + board_test
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
pnpm db:generate --name <change>                   # after editing apps/backend/src/db/schema.ts
pnpm --filter @agent-board/cli run docs            # regenerate docs/cli.md after changing a command
mise exec -- node apps/cli/src/main.mts <command>  # the CLI from source
```

`pnpm --filter @agent-board/cli docs` without `run` hits pnpm's own `docs` command.

## Traps

- **`~/workspace/agent-board` is the live checkout.** The user's installed CLI and systemd timers may run from it. Never do unfinished work there. Work in a worktree (see Worktrees), branched from `origin/main` (the local `main` is often behind).
- **`MIN_CLIENT` is a coordinated rollout.** The server deploys on every merge to `main`. Raising `MIN_CLIENT` (in `packages/shared/src/contract.mts`, after `API_VERSION`) breaks every older installed CLI until a `cli-v*` release is out and machines run `board self-update`; CLIs up to 0.7.0 compare `contract` exactly, which `LEGACY_CONTRACT` keeps at 9. The numbers are a break level: an additive change (new command, optional field, new enum value with a vocabulary row, but only once every machine runs CLI 0.8.0 or newer: 0.7.0 does not survive the 422 for a task it cannot read) adds a feature name in `packages/shared/src/features.mts` and bumps nothing. A raised `MIN_CLIENT` also raises `apps/cli/package.json` and adds an Upgrading note to `docs/setup.md`. See `docs/architecture.md#versioning` and `docs/machine-api.md#features`.
- **Parallel branches collide** on the migration number, the version numbers and the CLI version. On rebase take `main`'s `drizzle/meta` files, regenerate the migration with `pnpm db:generate --name <same name>`, copy any hand-written SQL over from the old file, and renumber the versions.
- **Backend tests reset `board_test`** on every run. Two worktrees testing at once need separate databases through `TEST_DATABASE_URL`.
- **Never let an agent seal as `user`.** Anything an agent produces that would change the user's text (a prompt rewrite, a proposed task) is a suggestion the user applies in the browser. New content fields get a binding in `sealing.mts` and an entry in `apps/backend/src/db/sealedColumns.ts`.
- **The user name owns the board.** It comes from the sign-in (passkey, OIDC claim, SAML NameID, `NO_LOGIN_USER`) and is bound into every sealed value. A change to how a method names users strands the boards of everyone it renames. See `docs/operations.md#sign-in`.
- **Clear values from the server are untrusted.** Shape-check them before they reach argv, paths, unit names or agent-visible text. Prompts go to `claude` on stdin.
- **CLI code must run on Node and Bun.** Use `node:` APIs only.
- **The listener keeps its old code** after a `git pull` or `self-update` until `systemctl --user restart agent-board-listen`.
- **Headless `claude -p` has no AskUserQuestion.** Board runs use `board ask`.

## Worktrees

- Every worktree lives at `.claude/worktrees/<branch with / as +>`. Create or enter one with `scripts/worktree.sh open <pr|branch> [base]` (or `create`), never `git worktree add` by hand.
- A new branch has no upstream until `git push -u origin HEAD`.
- Run `scripts/worktree.sh elevate` before tests, lint or typecheck: a fresh worktree has no `node_modules`. The backend dev server and `db:migrate` also need `apps/backend/.env`, which elevate does not copy.
- A worktree outside that folder (the older `../agent-board-*` siblings) is moved with `scripts/worktree.sh open <branch> --move` when next used.

## Working conventions

- Commits and tags are SSH-signed with a hardware key. Never bypass signing (`--no-gpg-sign`, `-c commit.gpgsign=false`). If signing fails, the key has dropped out of the agent: ask the user to run `ssh-add-signing` (in a headless board run with `board ask`), then commit and push yourself once they answer. Don't hand the commit to the user.
- Keep commits scoped to the task. Don't sweep unrelated working-tree changes into them.
- PRs are squash-merged (the repository allows nothing else); the squash subject is the PR title with its number. Describe what changed, the rollout or upgrade steps, how it was tested, and what was not verified (say so when nothing was checked in a real browser).
- Document behaviour where users and agents will look: user-facing behaviour in `docs/usage.md` or `docs/workers.md`, protocol in `docs/machine-api.md`, design reasons in `docs/architecture.md`. Keep `README.md` short: it is the entry point, not the reference.
- Only describe what is on `main` as shipped. Work on unmerged branches is "planned".
