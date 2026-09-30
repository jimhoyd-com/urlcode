# @jimhoyd/urlcode-auth

## Unreleased

- **Better Auth's origin and CSRF checks stay on under `NODE_ENV=test` or `TEST`.** Better Auth skips its origin
  check, and with it its CSRF check and `callbackURL`/`redirectTo` validation, whenever `NODE_ENV=test` or `TEST` is
  truthy and `advanced.disableOriginCheck` is unset, so a server started in such an environment accepted a cross-origin
  sign-in and an untrusted `callbackURL` (reproduced against better-auth 1.7.6: `200`; now `403 INVALID_ORIGIN` and
  `403 INVALID_CALLBACK_URL`). The adapter pins `advanced.disableOriginCheck` and `advanced.disableCSRFCheck` to
  `false` beside telemetry and the rate limiter, for the bundled database and an owner database alike; the
  `betterAuth` option cannot turn them back off. `betterAuth.trustedOrigins` admits another origin.
- **Activation no longer drops `auth_servers` (#1078).** The multi-process release's host lease table was dropped on
  every activation of the bundled database; nothing has created it since, so the cleanup is gone. A database that
  still has the table keeps it, unread.
- **`urlcode-auth create-user` no longer fails with "database is locked" beside a busy server.** SQLite's busy
  handler sleeps up to 100 ms between attempts and is not a queue: beside a serving process that holds the write lock
  for most of each commit (a slow flush, as on Windows runners) with only a request's gap between commits, its attempts
  over 2 seconds could all find the lock held. The operator commands now wait up to 10 seconds and try for the write
  lock every millisecond (reproduced: 4 of 5 `create-user` calls failed beside a writer holding the lock 20 ms per
  commit; 10 of 10 pass). Serving keeps its 2-second bound and `503 auth_unavailable`.
- **Seeds run the owner's `validateUserInfo` and database hooks (#1058).** `tests/seed.json` accounts are created
  inside a hermetic seed context: the endpoint context Better Auth passes its hooks, with no request (`request` and
  `path` undefined) and empty `headers`. Before, a configured `betterAuth.user.validateUserInfo` refused every seed
  with `User validation requires an endpoint context`, and `databaseHooks` got no context at all. A validator sees
  `{method: 'email-password', action: 'create-user'}`; one that rejects a seeded user, or a `create.before` hook that
  returns `false`, refuses the run with a message naming the user and the hook.
- **The owner's Better Auth choices are honoured (#1052).** `auth({database})` also takes the owner's own Better Auth
  database (an adapter, a Kysely dialect, a Postgres or MySQL pool), passed to Better Auth unchanged; before, the
  bundled SQLite file always replaced it. With one, the one-server lock, the WAL and file checks, the table check and
  migrations do not apply, activation logs one `extension_warning` saying the schema, migration state, backups and
  single-writer rules are the owner's, and `urlcode-auth migrate`, `create-user` and `find-user` refuse (exit 2)
  while `data/auth.owner-database` says host.mjs names one. A hermetic run (`test`, `audit`, a local review) serves
  the owner's `testDatabase` factory's fresh database instead, and is refused without one: it never falls back to the
  live database. Seed accounts are created through Better Auth's internal adapter rather than a raw model insert, so
  they work on any adapter. Email and password is now a default, not forced: `betterAuth.emailAndPassword.enabled:
  false` turns it off, and its endpoints then answer `404`. `betterAuth.database` is refused in favour of `database`.
- The extension declares its credential for `urlcode openapi` as `openapiSecurity` (#1047): Better Auth's session
  cookie, without a name, since the name is the operator's Better Auth configuration. The export no longer gives an
  `auth: true` route a `urlcodeSession.auth` scheme with the placeholder cookie `session`, which a generated client
  would have sent; the operation states the cookie under `x-urlcode.authentication` instead.

- **Breaking: one serving process per database.** Each activation takes an exclusive OS-held lock on
  `auth.sqlite.server-lock` (core's `holdServerLock`) before it opens the database, and a second serving process is
  refused with `Another process is already serving this auth database`; the operating system releases the lock when
  the process exits or is killed. This replaces the host lease (#941, #978, #1010): the `auth_servers` table (dropped
  on activation), its heartbeat, the per-request check and the temporary write triggers on Better Auth's tables are
  gone. `urlcode-auth migrate`, `create-user` and `find-user` never take the lock and run beside the server. The
  network filesystem refusal stays, and an activation that fails still releases what it took (#979).
- A site whose fixtures sign in more than ten times passes `urlcode test` and `audit` (#1019). Better Auth's limit of
  10 sign-ins a minute per client address applied to hermetic runs too, where every fixture comes from one address, so
  the eleventh sign-in answered `429` and every later step was skipped (store-booking and store-credits merged sign in
  12 times). An instance activated for a hermetic run now multiplies every rate-limit rule's `max` by ten (100
  sign-ins, 50 sign-ups, 1,000 other requests a minute by default, and an operator's own rules alike); the limiter
  stays on, database-stored and keyed by the admitted address. Only the operator host's hermetic flag raises it:
  `serve`, `dev` and a pinned `validate` keep every limit as configured.

- A mount request body holding an unpaired UTF-16 surrogate escape (`"\ud800"` alone) answers core's
  `400 {"error":"invalid_unicode"}` (#1016). Better Auth parses its own body, so sign-up stored such a name as U+FFFD.
  Every body now passes core's `readBody` before Better Auth sees it, and answers the reader's other refusals too: a
  repeated key or `Content-Type`, nesting past 32, invalid UTF-8 or JSON (`400`) and a media type other than
  `application/json` (`415`), each as `{"error": <code>}`. `urlcode-auth create-user` refuses the same input (exit 2).

- Every Better Auth write checks the host lease under its own write lock (#1010). A temporary trigger on each Better
  Auth table, on auth's connection only, runs the lease check before every insert, update and delete. Before, the lease
  was checked once per request before Better Auth ran, so a request that stalled for longer than the lease's time to
  live after that check (`SIGSTOP`, a paused VM, a blocked event loop) could still write after another host took over;
  it now answers `503 auth_unavailable` and writes nothing. The check itself now always reads the lease table, as
  store and audit writes do.
- A sign-out whose session delete fails answers `503 auth_unavailable` with no `Set-Cookie`, and the session keeps working (#980).
  Better Auth answered `200 {"success":true}` and cleared the cookie while the session stayed valid. The mount now
  confirms against the database that a successful `/sign-out` removed the session. A `401` from `/list-sessions`, the
  revoke endpoints or `/change-password` is confirmed the same way, because Better Auth's session middleware reads a
  storage failure as "no session"; when the session exists or cannot be read, the answer is `503`.
- The host lease (core's `joinHostLease`) never compares two hosts' clocks (#978): each renewal writes a larger `heartbeat_at`, and a process judges another host's row by whether it advances, timed on its own monotonic clock. A joiner watches another host's row for up to 20 s, refusing if it advances and deleting it if it stays silent, so a joiner whose clock runs ahead no longer evicts a live holder and a crashed host whose clock ran ahead blocks a restart for 20 s, not for the skew. Every heartbeat re-checks the table: a process that finds another host's row loses the lease, deletes its own row, logs it, does not re-insert it, and rejoins by itself once no other host holds one. A failed heartbeat is logged. A serving process that lost the lease answers `503 auth_unavailable` to every auth request, checked once per request before Better Auth runs.
- An activation that fails after joining the host lease (a seed that breaks, Better Auth failing to start) releases it
  (#979). Before, its `auth_servers` row blocked another host until it expired and its heartbeat kept firing against the
  closed connection.
- A mount endpoint Better Auth fails on the database (a sign-in whose session cannot be stored because the disk is
  full or the lock was held past the busy timeout) answers `503 {"error":"auth_unavailable"}` with `Retry-After: 1` and
  no `Set-Cookie` (#902). Before, a full disk was Better Auth's bare `500`, and a lock timeout a throw that core answered
  `500`.
- auth refuses a second host and a network filesystem without the store (#941). Activation and the `urlcode-auth`
  commands refuse a database directory on a network filesystem by its Linux `statfs` type (NFS, SMB, SMB2, CIFS, FUSE,
  9P, Ceph, AFS; not checked on macOS or Windows). Each activation joins a host lease, a new `auth_servers` table in
  `auth.sqlite` created on first activation (heartbeat every 5 s, live 20 s), and is refused while a live peer runs on
  another host (another Linux boot id, or another hostname when either has none). Both checks are core's
  (`joinHostLease`, `refuseNetworkFilesystem`), shared with the store and audit. `createAuthExtension` takes a `probe`
  test seam; operators never set it.
- `urlcode test`, `audit` and `benchmark` never touch the site's accounts (#930). In a hermetic run (`HostContext.hermetic`)
  the host ignores `database`, `secretFile` and `BETTER_AUTH_SECRET`: Better Auth gets a fresh database in the run's data
  directory, its tables are created at activation, and sessions are signed with a secret that lives only for the run. The
  registration then accepts a test seed (`authSeedSchema`, exported): `tests/seed.json` `{"auth": {"users": [{id, email,
  password, name?}]}}` creates each account with that user id through Better Auth's adapter and password hashing before
  the first fixture, so tests need no `migrate` or `create-user` and a rerun starts from the same accounts.
- Several processes on one host can share `data/auth.sqlite` (#927). It opens with a 2-second busy timeout, WAL and
  `synchronous=FULL`, is created `0600` and refused unless private; `urlcode-auth create-user` beside a running server
  no longer fails with "database is locked". Better Auth's transactions begin `IMMEDIATE`: its sign-up reads, hashes,
  then writes, and under WAL a deferred transaction failed with `SQLITE_BUSY_SNAPSHOT` whenever another process
  committed during the hash (reproduced: 40 of 40 create-user calls failed beside a steady writer).
- Rate limits are stored in the auth database (`rateLimit.storage: 'database'`), so every serving process shares one
  sign-in budget; `urlcode-auth migrate` creates the `rateLimit` table and activation refuses a database without it.
  Existing sites run `npx urlcode-auth migrate` once.
- A protected route answers `503 {"error":"auth_unavailable"}` (with `Retry-After: 1`) when the session cannot be
  checked because the database is locked or failing, instead of a false `401`.

- `urlcode-auth find-user --email <email>` prints a user's id, email, name and `createdAt` through Better Auth's own
  lookup (#917), so `urlcode-store members add --principal` no longer needs a SQL query for a self-registered user.

The definition declares its deployment targets (node), which `npm run build:addons` writes into `urlcode.json` as `targets` (#859); core refuses a registration whose targets differ, and the capability preflight refuses a recipe or plan that uses this extension on any other target.

- Rebuilt on Better Auth 1.7.6 (#841, #843). Accounts, passwords, sessions and their SQLite tables are Better Auth's;
  the extension serves an allowlist of its endpoints on one mount, gates `auth: true` routes with a verified session
  and same-origin unsafe methods, and hands route code the user id as `context.capabilities.auth.identity`.
  `urlcode-auth migrate` and `create-user` are the operator CLI.
- Removed with no compatibility layer: the previous account system (registration flows, account pages, passkeys,
  OIDC, TOTP, recovery, API keys and bearer routes, roles and permissions, support sessions, backups, lifecycle hooks,
  `AuthExports`, `sessionUserId`) and the admin extension that depended on it.
