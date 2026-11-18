# Running the board server

Deployment and server configuration.

## The board server

The server is two containers:

- **Backend** (`apps/backend`): Fastify, tRPC for the UI, Drizzle on Postgres. Migrations run on start.
- **Web** (`apps/frontend`): the React app, served by Caddy. Caddy proxies `/trpc`, `/api` and `/healthz` to the backend.

### What Caddy does to backend answers

The backend's answers share the app's origin, so a header the backend sets would act on the app too. Caddy therefore passes on none of them (`header_down -*`). Only the status and the body get through. That drops `Clear-Site-Data`, `Set-Cookie`, `Refresh`, `Link`, `Location`, `Service-Worker-Allowed`, `Strict-Transport-Security`, `Access-Control-*`, `Content-Encoding` and any header nobody thought of.

Caddy writes its own headers on every backend answer:

```text
Content-Type: application/json
Cache-Control: no-store
Content-Security-Policy: sandbox; default-src 'none'
X-Content-Type-Options: nosniff
Content-Disposition: attachment
Cross-Origin-Resource-Policy: same-origin
```

An error Caddy makes itself on a backend path, such as a 502 when the backend is down, gets the same headers through `handle_errors`.

The result is that a hostile backend cannot serve a page under `/api` or `/trpc` that runs script with the app's access to the keys in IndexedDB. The browser treats whatever comes from those paths as JSON. The app's own CSP has `worker-src 'none'`, so no service worker can be registered either. The app itself is served with `Cross-Origin-Opener-Policy: same-origin`.

The Caddy image is pinned by version and digest in `ARG CADDY_IMAGE` of `apps/frontend/Dockerfile`. CI pulls that image, and `caddyfile.docker.test.ts` runs the Caddyfile in it against a hostile backend. A Caddy upgrade is a change to that line and has to pass the test.

### Images and rollout

The images are `agent-board-backend` and `agent-board-web` on GHCR (`ghcr.io/codeplant-de/agent-board-*`). `.github/workflows/ci.yml` builds them on a push to `main`, only after its typecheck, lint and test job passed. A manual run builds them too. Flux image automation rolls them out.

The cluster side lives in the separate, private `codeplant-de/cloud-infra` repository: namespace, Postgres, the backend and web Deployments, IngressRoutes, the Authelia rule, image policies, DNS, and a nightly `pg_dump` into the restic backup.

### Environment of the backend

| Variable                | Meaning                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | Postgres, as a superuser or as the schema owner with CREATEROLE. Used only at start to create the app role and run migrations, then closed.                                                           |
| `APP_DATABASE_URL`      | The same database as `board_app`, the unprivileged role that serves every request. See below.                                                                                                         |
| `ALLOWED_GROUPS`        | Authelia groups that may use the UI, comma-separated. Default `admins`.                                                                                                                               |
| `PROXY_SECRET`          | The secret Caddy and the backend share. Required in production, at least 32 characters. See below.                                                                                                    |
| `CLI_VERSION`           | The newest CLI release, `x.y.z`. See below.                                                                                                                                                           |
| `PORT`                  | Default 4000.                                                                                                                                                                                         |
| `DEV_AUTH_USER`         | Local development only: act as this user without Authelia. The backend refuses to start with it in production.                                                                                        |
| `BACKFILL_OWNER`        | Only for the first start on a database from before boards were separated per user: the username that owns the existing tasks.                                                                         |
| `PGLITE_ASSETS_DIR`     | Only with a `pglite:` URL, and only for a compiled executable that has no `node_modules`: a folder holding `pglite.wasm`, `initdb.wasm` and `pglite.data`. A missing file is a start error naming it. |
| `PGLITE_SHARED_BUFFERS` | Only with a `pglite:` URL: PGlite's `shared_buffers`, a number and a unit (`kB`, `MB` or `GB`), such as `8MB`. Any other form, or setting it with a `postgresql://` URL, is a start error.            |

**`APP_DATABASE_URL`.** The role must be `board_app`, with no superuser and no BYPASSRLS. On start the backend creates it with this URL's password, or resets the password. It refuses to start if the role is privileged.

**`PROXY_SECRET`.** The web container's Caddy sends it as `Board-Proxy-Secret` on every request it proxies. The backend takes `Remote-User` and `Remote-Groups` only with it, so a pod that reaches port 4000 directly cannot pose as a user. The same value goes into the web container's env. `openssl rand -hex 32` makes one. Outside production an unset secret means no check.

**`CLI_VERSION`.** The machine API advertises it as `cli` in its `version` answer. The backend image sets it from `apps/cli/package.json` at build time. Unset, or not `x.y.z`, means unknown: the server advertises nothing and shows no machine as outdated.

**`BACKFILL_OWNER`.** The migration stops with an error naming this variable when rows exist and it is unset. A fresh database does not need it, and it is ignored afterwards.

### PGlite instead of Postgres

A `DATABASE_URL` and `APP_DATABASE_URL` that start with `pglite:` run the backend on [PGlite](https://pglite.dev), an in-process Postgres, instead of a server. The form is `pglite://[role[:password]@]local/<absolute data directory>`: `local` is a fixed host token, because a URL without a host cannot carry a username, and the path is percent-decoded, so `~/Library/Application%20Support/board/db` works. The password is ignored. Both URLs point at the same directory, and `APP_DATABASE_URL` names `board_app`.

`@electric-sql/pglite` is an optional dependency of the backend, loaded only for a `pglite:` URL. A hosted image that does not install it starts as before. A `postgresql://` URL never loads it.

PGlite limits:

- One session, so requests are serialised.
- The session is a superuser underneath. Each statement or transaction on the `board_app` handle takes that role with `set local role`, so the role boundary is weaker than a Postgres login role: a statement that ran `reset role` would escape, which needs SQL injection.
- PGlite runs Postgres 17, the core targets 16.
- One database per data directory, and one process may open a directory.

### Boards per user

Every row belongs to the signed-in user, which is `Remote-User` in lower case. Requests run as the unprivileged `board_app` role with row-level security, so a query sees only its owner's rows even if it forgets a `WHERE`.

Deleting an account (Settings → Your data) removes its rows from the database and nothing else. Backups and volume snapshots keep the data until they expire, so the operator decides how long that is.

A machine token belongs to the user who made it on the Settings page, and the machine API works on that user's board. Two users may use the same machine name or dedupe key.

### Two ways in

**The UI** (`/trpc`):

1. Traefik runs Authelia's forward-auth and strips `Remote-*` headers a client sent.
2. Caddy in the web container adds `Board-Proxy-Secret`, overwriting any value a client sent.
3. The backend checks that secret, takes the user from `Remote-User` and requires one of `ALLOWED_GROUPS` in `Remote-Groups`.

A NetworkPolicy lets only the web pod reach port 4000, and the secret keeps any other pod that gets through off `/trpc`.

The session cookie covers the whole parent domain, so another subdomain can send a plain HTML form with it. A form cannot send `Content-Type: application/json`. So the backend answers a write to `/trpc` with any other content type with 415, before tRPC reads it.

**The machine API** (`POST /api/machine/<command>`):

Its own Traefik route skips Authelia. The route matches only that path with an `Authorization: Bearer` header. The backend looks the token up by its sha256 and refuses a revoked one. Tokens are shown once, on the Settings page. A token claims tasks only under its own machine name.

## Removing the Slack app

The Slack integration was removed. To clean up a deployment that had it:

- Migration `0035_drop_slack` drops the `slack_inbox`, `slack_link` and `slack_link_code` tables with their data, and the four `slack_*` functions. It runs on start.
- Remove `INTAKE_TOKEN` and `BOARD_URL` from the backend's env secret. The backend does not read them.
- Remove the `agent-board-slack` Deployment and its secret `agent-board-slack-env` from `codeplant-de/cloud-infra`. The image is not built any more.
- Delete the Slack app at api.slack.com/apps.

## Cutover to encryption

A new board starts encrypted and needs none of this.

The one board from before encryption was re-encrypted in place on 2026-11-14. Since migration 0014 the database refuses plain text in every sealed column, which `apps/backend/src/db/sealedColumns.ts` lists.

The re-encryption script and its runbook were removed afterwards. The last tag that ships both is `cli-v0.8.0`: see `apps/backend/src/scripts/reencrypt.ts` and this section at that tag. Migration 0014 still names the script in its error, because migrations are not edited after they ship. On a database this code has migrated, that error cannot occur.
