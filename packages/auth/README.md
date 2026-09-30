# @jimhoyd/urlcode-auth

Operator-installed authentication for URLCode. Accounts, passwords, sessions,
cookies and their tables are [Better Auth](https://better-auth.com/)'s; this
extension serves one Better Auth instance on one mount and lets routes require
a signed-in user. Released with core and installed with
`urlcode extensions add auth`. Apache-2.0. It is the bundled default sign-in
provider, not a requirement: an independent provider may stand in for it
([owner choice][extensions-owner-choice]).

It replaced URLCode's own account system (#841, proven in #843). What it does
not do is listed [below](#not-included).

## Add it

```sh
urlcode extensions add auth
npx urlcode-auth migrate
echo '{"email":"you@example.com","password":"a long local password","name":"You"}' | npx urlcode-auth create-user
```

`npx urlcode-auth find-user --email you@example.com` prints that user's id,
email, name and `createdAt` as one JSON line (exit `1` when no user has the
email), through Better Auth's own lookup rather than SQL. The id is the
principal a protected route receives and what `urlcode-store members add
--principal` takes. It only reads: it never migrates or creates the database.

`add` writes `extensions.auth` (empty config), a `/api/auth/*` mount route and
a private `data/auth.secret`, and adds `auth()` to `host.mjs`. `migrate`
creates Better Auth's tables in the bundled default database, `data/auth.sqlite`
(or pass [your own database](#your-own-database)), including the `rateLimit`
table its limiter counts in; the extension refuses to activate until they all
exist, and until Better Auth's own schema check against the database has
passed. Both files stay out of the route project; keep them private and backed
up.

`data/auth.sqlite` is created `0600` and must stay a private regular file. It
runs in WAL mode with `synchronous=FULL`, so while any process has it open,
recent commits are in `data/auth.sqlite-wal` (with `data/auth.sqlite-shm`
beside it). To back it up, stop the process that serves it (the last one to
close folds the log into `auth.sqlite`) and copy the file, or take an online
copy with SQLite's backup API, for example `sqlite3 data/auth.sqlite ".backup
/srv/backups/auth.sqlite"`. A plain copy of `auth.sqlite` alone while a server
runs can miss committed sign-ins and accounts.

```yaml
version: "1"
extensions:
  auth: {version: "1", config: {}}
routes:
  /api/auth/*:
    extension: auth
    methods: [GET, POST]
  /api/me:
    methods: [GET]
    auth: true
    function: {source: functions/me.mjs}
```

## Protect a route

`auth: true` (the short form of `policies.extensions.auth: {}`) requires a
session Better Auth verifies from the request's own cookie. Without one the
route answers `401 {"error":"authentication_required"}`. A `POST`, `PUT`,
`PATCH` or `DELETE` must also come from the site's own origin (`Origin`,
`Sec-Fetch-Site` or `Referer`), or it answers `403 {"error":"cross_origin_refused"}`.
When the session cannot be checked because the auth database is unavailable
(another process held its write lock past the 2-second busy timeout, or an I/O
error), the route answers `503 {"error":"auth_unavailable"}` with
`Retry-After: 1` rather than a `401` that would tell the client it is signed
out. The mount answers the same `503` (and sets no cookie) when Better Auth
itself fails on the database, for example a sign-in that cannot store its
session because the disk is full, instead of Better Auth's bare `500`.
Both checks apply only to a method the route declares: core answers any other
method `405` with `Allow` before this extension runs.

The route's function never receives the cookie or an `Authorization` header.
It receives the verified user id through the request-bound capability:

```js
export default function me(request, context) {
  const { userId } = context.capabilities.auth.identity;
  return Response.json({ userId });
}
```

Test a protected route with a request fixture that signs in through
`POST /api/auth/sign-in/email` inside a `steps` fixture, as a browser does; the
fixture's cookie jar keeps the session, and `"origin":"{{origin}}"` passes the
same-origin check. There is no test principal that skips the gate. See
[authenticated routes][readiness-authenticated-routes].

`urlcode test` and `audit`, and a `--local-review` `validate` or
`routes` with no operator pin, never open the site's
`data/auth.sqlite`: each run uses a fresh database in a temporary directory,
creates Better Auth's tables itself, signs sessions with a secret that lives
only for the run (the `database` and `secretFile` options and
`BETTER_AUTH_SECRET` are ignored). With the owner's own database, the run
serves the owner's `testDatabase` instead, or is refused
([your own database](#your-own-database)). `test` and `audit` then create the accounts
`app/tests/seed.json` declares, with the ids a store membership names:

```json
{"auth": {"users": [{"id": "alice", "email": "alice@example.test", "password": "alice-local-demo-password", "name": "Alice"}]}}
```

Each user needs an `id` (a principal id), an `email` and a password of 8 to
128 characters; `name` defaults to the email. No `migrate` or `create-user`
is needed for tests, and a rerun starts from the same accounts. See
[test data and seeds][readiness-seeds].

Seed accounts are created as Better Auth's email sign-up creates them, so the
owner's `betterAuth.user.validateUserInfo` and `databaseHooks` run for each
one, in a hermetic seed context: the endpoint context Better Auth passes its
hooks, with no request (`ctx.request` and `ctx.path` are `undefined`) and
empty `ctx.headers`, so there is no client address or cookie to read.
`validateUserInfo` receives `{method: 'email-password', action: 'create-user'}`
as its source; `user.create.before` and `after`, then `account.create.before`
and `after`, run in that order. A validator that rejects a seeded user (or
throws), or a `create.before` hook that returns `false`, refuses the run with
a message naming the user and the hook. A validator that needs a request must
accept one without it, or the seed accounts must satisfy it.

Identity is not permission. Roles, ownership and approvals are application
data keyed by that id. A `sandbox: true` route cannot name `auth`: the
capability is a live object that cannot cross into the sandbox, so the runtime
refuses it before serving.

## Sign in from the browser

Use Better Auth's own client; the mount is its `basePath`:

```js
import { createAuthClient } from 'better-auth/client';
const auth = createAuthClient({ basePath: '/api/auth' });
await auth.signIn.email({ email, password });
await auth.signOut();
```

The mount forwards only these Better Auth paths; everything else under it is
`404`:

| Path | Purpose |
| --- | --- |
| `POST /sign-in/email`, `POST /sign-out` | Sign in and out |
| `GET /get-session` (or `POST`), `GET /list-sessions` | The current session and the user's sessions |
| `POST /revoke-session`, `/revoke-sessions`, `/revoke-other-sessions` | End sessions |
| `POST /change-password` | Change the signed-in user's password |
| `GET /ok` | Health |
| `POST /sign-up/email` | Only with `auth({signUp: true})` |

The mount forwards the unchanged body and `Content-Type` to Better Auth, which
owns each endpoint's accepted formats, including form-encoded sign-in and formats
an enabled plugin declares. It does not translate requests into a private auth
format. Every body is limited to 1 MiB and repeated `Content-Type` headers are
`400 duplicate_header`, regardless of format.

JSON bodies (including `application/*+json`) first pass core's JSON body reader
([`readBody`][extensions-request-helpers]): a string or key holding an unpaired
UTF-16 surrogate escape is `400 invalid_unicode`; repeated keys, nesting past
32, invalid UTF-8 or invalid JSON are `400`. Form-encoded and plain-text bodies
must be valid UTF-8; form percent-encoded bytes must also decode as valid UTF-8
(`400 invalid_encoding`). Duplicate form fields and literal percent signs retain
upstream semantics. Binary and multipart parsing stays with the enabled upstream
endpoint; these formats do not receive the JSON-specific structural checks.
Better Auth still owns origin/CSRF checks on its endpoints. Supporting a format
does not enable another path or disable those checks.

`urlcode-auth create-user` refuses unpaired surrogates in its input, and core
refuses them in `tests/seed.json`.

## Operator options

Everything about the Better Auth instance is `host.mjs` code, never YAML:

```js
auth({
  signUp: false,          // allow POST /sign-up/email
  paths: [],              // more Better Auth paths to serve, for example a plugin's
  betterAuth: {},         // extra Better Auth options, such as plugins (trusted code)
  database: 'data/auth.sqlite',
  secretFile: 'data/auth.secret',
})
```

Email and password sign-in is on by default, not forced:
`betterAuth: {emailAndPassword: {enabled: false}}` turns it off, and the mount
then answers `404` for `/sign-in/email` and `/change-password` (and refuses
`signUp: true` and a `tests/seed.json` `auth` entry, both email and password
accounts). Sign in with another Better Auth method instead by adding its plugin
through `betterAuth` and its paths through `paths`.

### Your own database

`database` also takes the owner's own Better Auth database: any value Better
Auth's `database` option accepts, such as an adapter (`prismaAdapter`,
`drizzleAdapter`, `memoryAdapter`), a Kysely dialect or a Postgres or MySQL
pool. It goes to Better Auth unchanged (`betterAuth.database` is refused;
pass it as `database`):

```js
import { memoryAdapter } from 'better-auth/adapters/memory';
import { Pool } from 'pg';

auth({
  database: new Pool({ connectionString: process.env.AUTH_DATABASE_URL }),
  // What test, audit and a --local-review validate or routes serve instead:
  // a fresh database, once per run, holding Better Auth's schema and no live data.
  testDatabase: () => memoryAdapter({ user: [], session: [], account: [], verification: [], rateLimit: [] }),
})
```

The bundled file's machinery does not apply to it. There is no one-server lock,
no WAL, permission or network-filesystem check, no table check before
serving (Better Auth's own schema check still runs when its adapter has one), and
the adapter never migrates it. Activation logs one `extension_warning` saying
so: its schema and migration state, backups, single-writer or multi-server
rules and access control are the owner's. `urlcode-auth migrate`,
`create-user` and `find-user` refuse (exit `2`): while host.mjs names an owner
database, loading it leaves `data/auth.owner-database` for them to find, and
removes it when host.mjs goes back to the bundled file. Use the database's
own tooling (Better Auth's CLI, or its server API) instead. The limiter's
`storage: 'database'` default counts in its `rateLimit` table.

A hermetic run never falls back to the live database. With an owner database
and no `testDatabase`, it is refused, naming the option; a `testDatabase` that
returns the live database itself is refused too. The factory is trusted operator code, so
one that returns another handle on live data cannot be detected: keep it
isolated. Test seed accounts are created through Better Auth's own API, so they
work on any adapter, and the owner's `validateUserInfo` and database hooks run
for them in the hermetic seed context described under
[protect a route](#protect-a-route). The mount's contract holds unchanged: `503
auth_unavailable` when the database fails (on the gate, the mount, and an
unconfirmed sign-out), the path allowlist, and the body and header bounds.

`BETTER_AUTH_SECRET` overrides the secret file. The extension always keeps
Better Auth's rate limiter on, keyed by the client address URLCode admitted,
and telemetry off; the `betterAuth` option cannot change either. By default
the limiter allows 10 sign-in attempts per client address a minute and counts
in the auth database (`rateLimit.storage: 'database'`), so a restart does
not reset it. `betterAuth.rateLimit` can replace `storage`
(Better Auth's per-process `memory`), `window`, `max` and `customRules`; a
`customRules` replaces the default sign-in and sign-up rules rather than adding
to them.

A hermetic run (`urlcode test`, `audit`, and `validate` or
`routes` under `--local-review`) replays every fixture from one client address
within seconds, on a throwaway database. There the limiter stays on, stored and
keyed the same way, but every rule allows ten times its `max`: 100 sign-ins,
50 sign-ups and 1,000 other requests a minute by default, so a site whose
fixtures sign in more than ten times still passes (#1019), and a fixture can
still reach the 429 past that bound. Only the operator host's hermetic flag
raises it; nothing in `urlcode.yaml` or the environment can, and `serve` and
`dev` always enforce the limits above.

With the bundled file, one process serves `data/auth.sqlite`. Each activation holds an OS lock on
`auth.sqlite.server-lock`, taken before the database is opened, and a second
serving process is refused with or without the store; the lock is released
when the process exits or is killed, so a restart never waits. The operator
commands (`urlcode-auth migrate`, `create-user` and `find-user`) do not take
it and run beside the server. A statement that finds the other connection
holding the write lock waits up to 2 seconds (blocking that process's event
loop meanwhile) before failing, and Better Auth's transactions (sign-up,
account creation) take the write lock when they begin, so one that reads and
then writes cannot fail on a commit made in between. An operator command waits
up to 10 seconds instead and tries for the write lock every millisecond, so it
gets in between a busy server's commits even when each commit holds the lock
for most of its time (a slow disk flush). Retrying is not a queue, though: a
lock held for the whole 10 seconds, or a server that commits with literally no
gap between commits (on Windows, a writer that releases and re-takes the lock
at once wins nearly every retry), fails it with `database is locked`. A real
server has a gap after each commit while it answers the request. Activation and the
operator commands refuse a database directory on a network filesystem by its
Linux `statfs` type, the list the store refuses (not checked on macOS or
Windows). Several servers need a database server: pass it as
[your own database](#your-own-database); see
[one serving process per database][store-one-process].

A storage failure answers `503 auth_unavailable`, never a false success or a
false sign-out. Better Auth itself answers a sign-out whose session delete
failed with `200` and a cleared cookie, and its session endpoints answer `401`
when reading the session failed. So the mount confirms, against the database,
that a successful `/sign-out` really removed the session, and that a `401` from
`/list-sessions`, `/revoke-session`, `/revoke-sessions`,
`/revoke-other-sessions` or `/change-password` means there is no session. When
it cannot confirm, it answers `503`, sends no cookie, and the client keeps its
session and retries. Better Auth's base URL is the
operator's `--origin` and its base path is the mount.

## Not included

- No account pages, admin console, audit events, email flows,
  two-factor, social or OIDC sign-in, API keys or account recovery. Add a
  Better Auth plugin through `betterAuth` and its paths through `paths` when an
  application needs one.
- No role or permission model: keep permissions in the application.
- Node only; aws and vercel refuse it.

See [SECURITY.md](SECURITY.md) for the security model.

<!-- extension-reference:start -->
<!-- Generated from urlcode.json by scripts/generate-extension-reference.ts (npm run docs:extensions). Do not edit between these markers; change the extension's schema descriptions instead. -->

## Field reference

Every key `auth` accepts, rendered from this package's `urlcode.json` (the schema the runtime validates against). Required means required within its containing object; `*` is a key you choose and `[]` an array item.

**Schema-valid is not activatable.** JSON Schema checks shape only. Activation also checks what a schema cannot express: the route for each declared mount exists, referenced fields and collections are declared, peers are installed and active, and the cross-field rules the descriptions state. A project that validates can still refuse to start; run `urlcode validate --local --project app --host-file host.mjs --local-review` (`npm run validate`), which activates it.

**Peers.** none.

### Configuration: `extensions.auth.config`

No configuration keys: declare `extensions.auth: {version: "1", config: {}}`.

### Route policy: `policies.extensions.auth`

A route may write this as the `auth:` short form: `auth: true` is `{}`.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|


Whole-policy rules: unknown keys rejected.

### Authoring surfaces and limits

Accounts and sessions served by Better Auth on one extension mount. Protect a route with `auth: true`; its function reads the signed-in user id from context.capabilities.auth.identity.userId. Permissions are data keyed by that id, never roles in auth: per-user records and membership lists are store declarations (ownership: owner, membership).

- **mount** (extension, `urlcode.yaml#routes`): Mount Better Auth at one path, for example /api/auth/* with extension: auth and methods [GET, POST]. Only the operator-enabled Better Auth endpoints answer; everything else under it is 404.
- **route protection** (configuration, `urlcode.yaml#routes`): `auth: true` on a route requires a verified Better Auth session and refuses cross-origin unsafe methods; the route receives no cookie or Authorization header. It is the principal-providing policy a store `ownership: owner` mount, `readers` mount or `by: others` transition mount needs.

Fast checks: `urlcode validate --project app`, `urlcode validate --local --project app --host-file host.mjs --local-review`.
<!-- extension-reference:end -->

<!-- x-release-please-start-version -->
[extensions-owner-choice]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#native-independent-integration-or-bundled-default
[extensions-request-helpers]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#request-helpers
[readiness-authenticated-routes]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/READINESS.md#authenticated-routes-auth-true
[readiness-seeds]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/READINESS.md#test-data-and-seeds
[store-one-process]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#one-serving-process-per-database
<!-- x-release-please-end -->
