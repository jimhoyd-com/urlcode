# @jimhoyd/urlcode-auth

## Unreleased

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
