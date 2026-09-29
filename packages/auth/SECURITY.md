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
  counters in the auth database's `rateLimit` table, so every process serving
  that database on one host shares one limit; each check is one atomic SQL
  update. The operator's `betterAuth.rateLimit` can replace its `storage`
  (Better Auth's per-process `memory`, which gives each process its own
  limit), `window`, `max` and `customRules` (which replaces the default
  sign-in and sign-up rules rather than adding to them).
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
- **One host serves the auth database.** A process that finds another host
  holding the auth database's host lease answers `503 auth_unavailable` to
  every auth request until that host is gone. The check runs once per request,
  before Better Auth, not inside Better Auth's own transactions. The lease rows
  are ordinary rows in `auth.sqlite`: they detect a misconfiguration, not an
  adversary who can write the file.
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
  recovery, no audit log of sign-ins and no multi-process session revocation
  broadcast beyond the shared database.

Report vulnerabilities through the repository's private reporting path; see the
root [security policy](https://github.com/jimhoyd-com/urlcode/security/policy).
