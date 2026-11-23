# Running the board server

Deployment and server configuration.

## The board server

The server is two containers:

- **Backend** (`apps/backend`): Fastify, tRPC for the UI, Drizzle on Postgres. Migrations run on start.
- **Web** (`apps/frontend`): the React app, served by Caddy. Caddy proxies `/trpc`, `/api` and `/healthz` to the backend.

### What Caddy does to backend answers

The backend's answers share the app's origin, so a header the backend sets would act on the app too. Caddy therefore passes on none of them (`header_down -*`). Only the status and the body get through. That drops `Clear-Site-Data`, `Refresh`, `Link`, `Location`, `Service-Worker-Allowed`, `Strict-Transport-Security`, `Access-Control-*`, `Content-Encoding` and any header nobody thought of.

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

The result is that a hostile backend cannot serve a page under `/api` or `/trpc` that runs script with the app's access to the keys in IndexedDB. The browser treats whatever comes from those paths as JSON. The app's own CSP has `worker-src 'self'`, but the only worker it registers is its own `/sw.js` from the static image, which handles notification clicks and no requests. A backend answer cannot become a worker: it is JSON with `sandbox`. The app itself is served with `Cross-Origin-Opener-Policy: same-origin`.

Two answers are not dropped entirely, because signing in needs them:

- **`Set-Cookie` on `/trpc*`.** The sign-in and sign-out procedures set the session cookie. Caddy passes the header there only when it is exactly the cookie the backend writes: the name `__Host-board-session` or `board-session`, a session token or nothing, and the fixed attributes in the backend's order, with no `Domain`. Anything else is dropped and the status and body still pass, so a hostile backend cannot set a cookie for a sibling site. The backend sends at most one `Set-Cookie` per answer. Caddy sees several of them joined by commas, which matches nothing, so two are never passed. The strings are pinned by a backend test and by the regular expression in the Caddyfile, so a change to the cookie is a change to both. The cookie is HttpOnly and the app reads no cookie. It keeps its keys in IndexedDB, which a cookie cannot reach. The worst a hostile backend gains is to sign the browser in as another user, whose board the browser's keys cannot open (see [Keys in the browser](encryption.md#keys-in-the-browser)). Every other path still drops `Set-Cookie`.
- **One 303 on the SAML assertion consumer** (`/api/auth/saml/acs`). The identity provider posts the user's browser there, and a redirect is the only way to turn that post back into a page. The backend answers a good response with a 303 to `/login/saml?flow=<id>` and a refused one with a 303 to `/login/saml?error=<code>`, because a JSON error on a top-level navigation would end as a downloaded file. The code is one of a short fixed set, and the app turns it into its own sentence. Caddy checks that `Location` is exactly that path with a flow id or a code of lower case letters and underscores, then sends its own 303 to it and copies nothing else from the backend's answer. Any other 303 becomes a 502. The target is fixed to this origin, so the backend cannot send the browser anywhere else.

The Caddy image is pinned by version and digest in `ARG CADDY_IMAGE` of `apps/frontend/Dockerfile`. CI pulls that image, and `caddyfile.docker.test.ts` runs the Caddyfile in it against a hostile backend. A Caddy upgrade is a change to that line and has to pass the test.

### Images and rollout

The images are `agent-board-backend` and `agent-board-web` on GHCR (`ghcr.io/codeplant-de/agent-board-*`). `.github/workflows/ci.yml` builds them on a push to `main`, only after its typecheck, lint and test job passed. A manual run builds them too. Flux image automation rolls them out.

The cluster side lives in the separate, private `codeplant-de/cloud-infra` repository: namespace, Postgres, the backend and web Deployments, IngressRoutes, the OIDC client registered at the identity provider, image policies, DNS, and a nightly `pg_dump` into the restic backup.

### Environment of the backend

| Variable           | Meaning                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`     | Postgres, as a superuser or as the schema owner with CREATEROLE. Used only at start to create the app role and run migrations, then closed. |
| `APP_DATABASE_URL` | The same database as `board_app`, the unprivileged role that serves every request. See below.                                               |
| `CLI_VERSION`      | The newest CLI release, `x.y.z`. See below.                                                                                                 |
| `GIT_SHA`          | The commit the image was built from. See below.                                                                                             |
| `PORT`             | Default 4000.                                                                                                                               |
| `BACKFILL_OWNER`   | Only for the first start on a database from before boards were separated per user: the username that owns the existing tasks.               |

**`APP_DATABASE_URL`.** The role must be `board_app`, with no superuser and no BYPASSRLS. On start the backend creates it with this URL's password, or resets the password. It refuses to start if the role is privileged.

**`CLI_VERSION`.** The machine API advertises it as `cli` in its `version` answer. The backend image sets it from `apps/cli/package.json` at build time. Unset, or not `x.y.z`, means unknown: the server advertises nothing and shows no machine as outdated.

**`GIT_SHA`.** The settings page shows it at the bottom as the server's revision. CI builds both images with the commit it built (`--build-arg GIT_SHA`): the backend image sets the variable, the web image bakes the commit into the bundle as its own revision. The two images roll out separately, so the page shows both. Unset, or not a hex commit, shows as unknown.

**`BACKFILL_OWNER`.** The migration stops with an error naming this variable when rows exist and it is unset. A fresh database does not need it, and it is ignored afterwards.

The sign-in variables come in four groups. The backend starts in one of two modes. With `NO_LOGIN_USER` set it runs without login. Without it, `PUBLIC_URL` is required and the board signs users in itself. A start with neither fails with a message that names both. The two modes exclude each other, and the backend refuses to start with a setting that its mode would ignore, so a typo does not leave a board open or closed by accident. [Sign-in](#sign-in) has a working setup for each method.

**No login**

| Variable        | Meaning                                                                                                                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NO_LOGIN_USER` | Switches login off: every request to the UI is this user. Works in production too, and the backend logs a warning at every start. It refuses to start if any of `PUBLIC_URL`, `PASSKEYS`, `SESSION_DAYS`, `SIGNUP_TOKEN`, `ALLOWED_GROUPS`, `OIDC_*` or `SAML_*` is set next to it. |
| `DEV_AUTH_USER` | An older name for `NO_LOGIN_USER`, for local development only: the backend refuses to start with it when `NODE_ENV=production`. `NO_LOGIN_USER` wins when both are set.                                                                                                             |
| `ALLOWED_HOSTS` | Comma-separated `Host` header values the backend answers, as `host` or `host:port`. Any other request gets 421, except `/healthz`. Unset or empty means no check.                                                                                                                   |

**Login, whatever the method**

| Variable         | Meaning                                                                                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`     | The board's address in the browser, as an origin: scheme, host and port, no path. https in production, and http also outside it. Gives the passkey origin and every redirect URL.                                                        |
| `SESSION_DAYS`   | How long a session lasts after its last use, 1 to 365. Default 30.                                                                                                                                                                       |
| `ALLOWED_GROUPS` | OIDC only: groups of which a user needs one, comma-separated. Empty or unset means no check, so every account the provider lets through gets a board. There is no default. The backend refuses to start with it when OIDC is not set up. |

**Passkeys**

| Variable       | Meaning                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `PASSKEYS`     | `on` or `off`. Default `on`, which needs no other setting.                                                                          |
| `SIGNUP_TOKEN` | At least 32 characters. Lets whoever holds it create an account with a passkey. Unset means sign-up is closed. Needs `PASSKEYS=on`. |

**OIDC** (set `OIDC_ISSUER` to switch it on)

| Variable              | Meaning                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OIDC_ISSUER`         | The issuer URL. The board finds the endpoints at `<issuer>/.well-known/openid-configuration`.                                                                                                    |
| `OIDC_CLIENT_ID`      | Required with `OIDC_ISSUER`.                                                                                                                                                                     |
| `OIDC_CLIENT_SECRET`  | Required with `OIDC_ISSUER`.                                                                                                                                                                     |
| `OIDC_SCOPES`         | Space-separated, must include `openid`. Default `openid profile email`.                                                                                                                          |
| `OIDC_USERNAME_CLAIM` | The claim that names the user. Default `preferred_username`.                                                                                                                                     |
| `OIDC_GROUPS_CLAIM`   | The claim that lists the user's groups, checked against `ALLOWED_GROUPS`. Default `groups`. A string claim is split on commas only, so `Domain Admins` is one group and does not match `Admins`. |
| `OIDC_LABEL`          | The text of the login button, at most 40 characters. Default `Single sign-on`.                                                                                                                   |

**SAML** (set `SAML_ENTRY_POINT` to switch it on)

| Variable                  | Meaning                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `SAML_ENTRY_POINT`        | The identity provider's single sign-on URL.                                                   |
| `SAML_IDP_CERT`           | The identity provider's signing certificate, as PEM or the bare base64 body.                  |
| `SAML_IDP_CERT_FILE`      | A file that holds it. Set this or `SAML_IDP_CERT`, not both.                                  |
| `SAML_ISSUER`             | The board's entity ID, which is also the audience a response must name. Default `PUBLIC_URL`. |
| `SAML_USERNAME_ATTRIBUTE` | An assertion attribute that names the user. Default: the NameID.                              |
| `SAML_LABEL`              | The text of the login button, at most 40 characters. Default `SAML sign-on`.                  |

**Who the user is.** The board's user name owns the board and is bound into every sealed value. It is lower case, at most 128 characters, without whitespace. A passkey sign-up picks a tighter one: lower case letters, digits, dots, dashes, underscores and `@`, up to 64. **A name belongs to the method that created it.** A board records the method of its first sign-in as its `source`: `passkey`, `oidc` or `saml`. A passkey sign-up creates a board only for a free name. An OIDC or SAML sign-in creates a missing board, signs in to one with its own source, and is refused one with another source ("This name belongs to an account with a different sign-in method."; the log has the detail). Without this, whoever holds the sign-up token could register `alice` before Alice's first OIDC sign-in and then hold a passkey for the board she lands on. A board from before sign-in (`source` null, such as every board of the auth proxy) is claimed by the first OIDC or SAML sign-in, which sets it. A passkey never looks at the source: it is tied to its owner when it is registered, and an OIDC user may add passkeys in Settings › Account. A board without login has no source. To move a board to another method, set the source as the database owner: `update app_user set source = 'saml' where username = 'alice'`, or `source = null` to let the next OIDC or SAML sign-in claim it. The sign-up token lets its holder take any free name, which is why it is meant to be removed once the accounts exist.

**Passkeys belong to the host.** A passkey is bound to the hostname of `PUBLIC_URL`. A board that moves to another hostname loses every passkey.

**Sessions.** A sign-in creates a row in `session`, which keeps the sha256 of a random token. The browser holds the token in an HttpOnly, `SameSite=Lax` cookie: `__Host-board-session` on https, `board-session` on http, which only local use has. A session ends `SESSION_DAYS` after its last use, and the expiry moves at most once an hour. The cleanup pass deletes expired sessions and unfinished sign-in flows. Signing out deletes the row.

Two limits are known. A session is not checked against the identity provider again, so a user who loses access there stays signed in until the session ends, or until you delete the row, and a passkey keeps working after the user loses access there. The sign-in endpoints have no rate limit of their own: put one in front, at the ingress, if the board is reachable from the internet.

### Boards per user

Every row belongs to the signed-in user, by the name the sign-in gave. Requests run as the unprivileged `board_app` role with row-level security, so a query sees only its owner's rows even if it forgets a `WHERE`.

Deleting an account (Settings › Account › Your data) removes its rows from the database and nothing else. Backups and volume snapshots keep the data until they expire, so the operator decides how long that is.

A machine token belongs to the user who made it on Settings › Machines, and the machine API works on that user's board. Two users may use the same machine name or dedupe key.

### Two ways in

**The UI** (`/trpc`). The browser signs in with a passkey, OIDC or SAML, and the backend answers with the session cookie. Every procedure except the sign-in ones needs it, and a request without a live session gets 401, which the app shows as the login page. A board with `NO_LOGIN_USER` skips the cookie and treats every request as that user.

The cookie is also the reason for two rules against cross-site writes:

- `SameSite=Lax` keeps the cookie off a cross-site POST. It does not cover a sibling subdomain, which is the same site. On https the `__Host-` prefix makes the browser refuse a cookie that a sibling subdomain tries to set.
- A plain HTML form on a sibling subdomain could still send the cookie, but a form cannot send `Content-Type: application/json`. So the backend answers a write to `/trpc` with any other content type with 415, before tRPC reads it, public sign-in procedures included. A cross-origin JSON write needs a CORS preflight, which the backend never grants.

The SAML assertion consumer is the one route that takes a form, because the identity provider posts it. It does not read the session cookie.

**The machine API** (`POST /api/machine/<command>`). It has nothing to do with the session. The backend looks the bearer token up by its sha256 and refuses a revoked one. Tokens are shown once, on Settings › Machines. A token claims tasks only under its own machine name. No proxy in front needs a login exemption for this path, because the backend checks the token itself.

## Sign-in

Pick the methods you need. They combine: with `OIDC_ISSUER` and passkeys both set, the login page shows both. In every case `PUBLIC_URL` must be the address users type, and the redirect URLs below are built from it.

### Authelia (OIDC)

The board uses the authorization code flow with PKCE (`S256`), a state and a nonce. It authenticates to the token endpoint with `client_secret_basic` when the provider lists it, or lists no method at all, and with `client_secret_post` otherwise. It reads the claims from the ID token and from the userinfo endpoint. The ID token wins where both have a claim. Authelia 4.39 and newer put `preferred_username` and `groups` only in userinfo, which is why the board asks for both.

Register the board as a client in Authelia's configuration. Make the secret with `authelia crypto hash generate pbkdf2 --variant sha512 --random --random.length 72 --random.charset rfc3986`, which prints the plain value and its hash. The hash goes below, the plain value into the board:

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: board
        client_name: Agent board
        client_secret: '$pbkdf2-sha512$310000$...' # the hash
        public: false
        authorization_policy: two_factor
        redirect_uris:
          - https://board.example.com/login/oidc
        scopes:
          - openid
          - profile
          - groups
        token_endpoint_auth_method: client_secret_basic
```

The redirect URI is `PUBLIC_URL` plus `/login/oidc`, spelled exactly. Authelia names its own options in its documentation; check the keys against your version.

The backend's environment:

```text
PUBLIC_URL=https://board.example.com
OIDC_ISSUER=https://auth.example.com
OIDC_CLIENT_ID=board
OIDC_CLIENT_SECRET=<the plain secret>
OIDC_SCOPES="openid profile groups"
ALLOWED_GROUPS=admins
```

`OIDC_SCOPES` needs `groups` for `ALLOWED_GROUPS` to see any group. Without `ALLOWED_GROUPS`, every user the provider signs in may use the board. The user name is the `preferred_username` claim, lower-cased. Another provider works the same way. Set `OIDC_USERNAME_CLAIM` and `OIDC_GROUPS_CLAIM` if its claims are called something else.

### Google Workspace (SAML)

The board is a service provider that starts the sign-in itself (SP-initiated). In the Google Admin console, add a custom SAML app (Apps, Web and mobile apps, Add app, Add custom SAML app).

1. On the Google identity provider page, copy the **SSO URL** and download the **certificate**. These become `SAML_ENTRY_POINT` and `SAML_IDP_CERT` (or `SAML_IDP_CERT_FILE`).
2. Under service provider details, set the **ACS URL** to `https://board.example.com/api/auth/saml/acs` and the **Entity ID** to the board's `SAML_ISSUER`, which is `PUBLIC_URL` when you set nothing else.
3. Set the **Name ID format** to `EMAIL` and the **Name ID** to Basic Information, Primary email.
4. Leave **Signed response** off. Google signs the assertion, and the board requires that. It does not need the response signed as well.
5. Turn the app on for the users who may sign in.

The backend's environment:

```text
PUBLIC_URL=https://board.example.com
SAML_ENTRY_POINT=https://accounts.google.com/o/saml2/idp?idpid=<id>
SAML_IDP_CERT_FILE=/run/secrets/google-idp.pem
SAML_ISSUER=https://board.example.com
SAML_LABEL=Sign in with Google
```

The user name is the NameID, so here the lower-cased email address. `SAML_USERNAME_ATTRIBUTE` names an attribute instead.

The board accepts only a response to a request it sent. Starting from Google's app launcher (IdP-initiated) is refused, and the user has to open the board and press its button. Access is whatever the SAML app allows: there is no group check, because `ALLOWED_GROUPS` applies to OIDC alone.

### Passkeys only

Passkeys need nothing but `PUBLIC_URL`. Nobody can sign in until an account exists, so create the first one with a sign-up token:

1. Set `PUBLIC_URL` and `SIGNUP_TOKEN` (`openssl rand -hex 32` makes one) and start the backend.
2. Open the board. The login page offers **Create an account**. Enter a name, the token and, if you like, a name for the passkey, then confirm with the device.
3. Remove `SIGNUP_TOKEN` and restart. Sign-up is closed from then on.
4. In Settings › Account, add a passkey for a second device. A user with one passkey and no other method has no way back in once it is lost.

A name that is in use is refused, so a sign-up cannot take over a board that already exists, whichever method created it. A user whose board a passkey created cannot remove their last passkey, because it is their only way in: Settings › Account shows the refusal, and adding a second one first lifts it. To add a user later, set the token again, give it to them, and remove it afterwards. Passkeys are discoverable and require user verification, so the device asks for a fingerprint, a face or a PIN and the user types no name.

### No login

```text
NO_LOGIN_USER=me
```

Every request to the UI is that user, with no cookie and no sign-in page, in production as well as in development, and the backend logs one warning line at start that says so. The machine API still needs a token. The backend refuses to start with `NO_LOGIN_USER` next to any setting that only login uses (`PUBLIC_URL`, `PASSKEYS`, `SESSION_DAYS`, `SIGNUP_TOKEN`, `ALLOWED_GROUPS`, `OIDC_*`, `SAML_*`). `DEV_AUTH_USER` is the same setting under its older name and is refused when `NODE_ENV=production`. This is meant for a board on your own machine or behind something else that decides who reaches it. **Anyone who can reach the backend's port is that user.** A board on your own machine should set `ALLOWED_HOSTS` to the address the browser uses, because a web page can reach a loopback port through DNS rebinding. Do not expose it to a network you do not trust. Removing the variable and setting `PUBLIC_URL` turns login on, and the users keep their boards as long as the names match.

## Moving from the auth proxy to the login page

Until this version the backend had no login. An auth proxy (Traefik with Authelia's forward-auth) signed users in and sent `Remote-User` and `Remote-Groups`, and Caddy added `Board-Proxy-Secret` (`PROXY_SECRET`). The backend ignores all three now. To move an existing deployment:

1. **Register the OIDC client** at the identity provider, with the redirect URI `https://<board>/login/oidc`. [Authelia (OIDC)](#authelia-oidc) has the entry.
2. **Add the new variables to the backend's env** while the old version still runs, which ignores them: `PUBLIC_URL` and the `OIDC_*` set together, and **`ALLOWED_GROUPS`**. Do not skip that one. The old default `admins` is gone, and unset now means every account the identity provider lets through this client gets a board. Set it to the group the forward-auth used to check, or you open the board to everyone the provider knows.
3. **Deploy this version.** A backend with neither `PUBLIC_URL` nor `NO_LOGIN_USER` refuses to start, so the old pod keeps serving if step 2 was missed. A backend with `PUBLIC_URL` alone starts and offers passkeys only, which nobody can use yet, so check that the login page shows the OIDC button. With the forward-auth still in front you sign in twice, once at the proxy and once at the board, usually without a second prompt.
4. **Take the proxy out.** Remove the forward-auth middleware from the UI route, and the separate machine-API route that skipped it. The machine API needs no exemption any more. Remove the NetworkPolicy that kept other pods off port 4000 and `PROXY_SECRET` from both containers' env. The backend ignores a leftover `PROXY_SECRET`, and Caddy no longer sends the header.
5. **Check the user name.** The claim must give the same name `Remote-User` did, since the name owns the board and is bound into every sealed value. With Authelia, `preferred_username` is that name. A user who arrives under another name lands on an empty board, and the old content stays out of reach. If the claim differs, set `OIDC_USERNAME_CLAIM` before anyone signs in. The existing boards have no `source`, so the first OIDC sign-in under each name claims it for OIDC.
6. **Optionally add passkeys.** Users add them in Settings › Account once signed in. Set `PASSKEYS=off` if the identity provider should be the only way in. A passkey keeps working after its owner loses access at the identity provider, so leave passkeys off where that matters.

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
