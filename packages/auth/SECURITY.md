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
  the address URLCode admitted (see `--trusted-proxies`). It keeps its counters
  in memory, per process.
- **Protected routes.** `auth: true` requires a session Better Auth verifies
  and refuses cross-origin unsafe methods. The route's own code never receives
  the session cookie or `Authorization` (core strips them), only the user id,
  which core stamps as the request principal. A client-supplied
  `x-urlcode-context-*` header is always removed before any extension runs.
- **Operator responsibilities.** `data/auth.secret` signs every session: keep
  it private (mode 0600), out of the route project and backed up with
  `data/auth.sqlite`. Serve over HTTPS in production so Better Auth sets
  `Secure` cookies. Accounts are created with `urlcode-auth create-user` unless
  `signUp` is enabled.
- **Not provided.** No brute-force lockout beyond the rate limiter, no account
  recovery, no audit log of sign-ins and no multi-process session revocation
  broadcast beyond the shared database.

Report vulnerabilities through the repository's private reporting path; see the
root [SECURITY.md](../../SECURITY.md).
