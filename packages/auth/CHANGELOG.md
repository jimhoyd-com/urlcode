# @jimhoyd/urlcode-auth

## Unreleased

- Rebuilt on Better Auth 1.7.6 (#841, #843). Accounts, passwords, sessions and their SQLite tables are Better Auth's;
  the extension serves an allowlist of its endpoints on one mount, gates `auth: true` routes with a verified session
  and same-origin unsafe methods, and hands route code the user id as `context.capabilities.auth.identity`.
  `urlcode-auth migrate` and `create-user` are the operator CLI.
- Removed with no compatibility layer: the previous account system (registration flows, account pages, passkeys,
  OIDC, TOTP, recovery, API keys and bearer routes, roles and permissions, support sessions, backups, lifecycle hooks,
  `AuthExports`, `sessionUserId`) and the admin extension that depended on it.
