# Security model

- **Better Auth owns accounts and sessions.** Password hashing, session tokens,
  cookie attributes, its origin checks on its own endpoints, and its SQLite
  tables are Better Auth's. Review its releases before changing the pinned
  version in `package.json`.
- **The mount serves an allowlist.** Only the Better Auth paths listed in the
  README (plus operator `paths`) reach Better Auth; the request URL is rebuilt
  from the checked path. Better Auth's own `disabledPaths` matches literal
  paths only, which is why the allowlist is enforced here.
- **Throttling cannot be bypassed by headers.** Better Auth's limiter is always
  on and reads the client address only from a header the mount overwrites with
  the address URLCode admitted (see `--trusted-proxies`); the `betterAuth`
  option cannot turn it off or change that header. By default it keeps its
  counters in the auth database's `rateLimit` table, so a restart does not
  reset them; each check is one atomic SQL update. The operator's
  `betterAuth.rateLimit` can replace its `storage` (Better Auth's in-memory
  `memory`, which a restart resets), `window`, `max` and `customRules` (which replaces the default
  sign-in and sign-up rules rather than adding to them).
- **Only a hermetic run raises the limits.** An instance activated for a
  hermetic run (`HostContext.hermetic`, set by the operator host for `test`,
  `audit`, `benchmark` and a `--local-review` `validate` or `routes`, never by
  YAML or the environment) multiplies every rule's `max` by ten (#1019),
  including an operator's `customRules` and what a rule function returns; a rule
  the operator disabled stays disabled. That instance runs on a throwaway
  database with a random secret and never serves the site's accounts. `serve`,
  `dev` and a pinned `validate` activate without the flag and keep every limit
  as configured.
- **Body guards preserve upstream formats.** Every body has a 1 MiB cap and
  repeated `Content-Type` headers are refused. JSON and `application/*+json`
  pass core's `readBody` before Better Auth parses their unchanged bytes, retaining
  the unpaired-surrogate, duplicate-key, nesting and encoding guards (#1016).
  Form and plain-text bodies require valid UTF-8, including form percent-encoded
  bytes. Binary/multipart parsing and accepted formats belong to the enabled
  upstream endpoint; JSON-specific checks are not applied to those bodies.
  Better Auth's endpoint origin/CSRF checks still run, including on form sign-in.
- **Protected routes.** `auth: true` requires a session Better Auth verifies
  and refuses cross-origin unsafe methods. A database failure while verifying
  the session answers `503 auth_unavailable` with no detail, never a `401`;
  so does a mount endpoint Better Auth fails with a server error (a sign-in
  whose session cannot be stored on a full disk), with no `Set-Cookie`.
- **Sign-out is confirmed.** Better Auth answers a sign-out whose session
  delete failed with `200 {"success":true}` and a cleared cookie, leaving the
  session valid. The mount reads the session back from the database after a
  successful `/sign-out` and answers `503 auth_unavailable`, with no
  `Set-Cookie`, unless it is gone. So a client is never told it signed out
  while its token still works. `/revoke-session(s)` and
  `/revoke-other-sessions` already fail with Better Auth's `500`, which is a
  `503`. A `401` from the session endpoints (`/list-sessions`, the revoke
  endpoints, `/change-password`) is checked the same way, because Better Auth
  reads a storage failure there as "no session".
- **One process serves the auth database.** Each activation holds an OS lock
  on `auth.sqlite.server-lock`, and a second serving process is refused
  before it opens the database. The lock detects a misconfiguration, not an
  adversary who can write the files.
- **Route code never sees the cookie.** The route's own code never receives
  the session cookie or `Authorization` (core strips them), only the user id,
  which core stamps as the request principal. A client-supplied
  `x-urlcode-context-*` header is always removed before any extension runs.
- **Operator responsibilities.** `data/auth.secret` signs every session: keep
  it private (mode 0600), out of the route project and backed up with
  `data/auth.sqlite`. The extension creates `data/auth.sqlite` 0600 and refuses
  one that is group- or world-accessible, a link or not a regular file. It runs
  in WAL mode: back it up with SQLite's online backup, or stop every serving
  process and copy it; its `-wal` and `-shm` files hold recent commits while it
  is open. Serve over HTTPS in production so Better Auth sets
  `Secure` cookies. Accounts are created with `urlcode-auth create-user` unless
  `signUp` is enabled.
- **Not provided.** No brute-force lockout beyond the rate limiter, no account
  recovery and no audit log of sign-ins. One process serves the auth database;
  a second serving process is refused.

Report vulnerabilities through the repository's private reporting path; see the
root [security policy](https://github.com/jimhoyd-com/urlcode/security/policy).
