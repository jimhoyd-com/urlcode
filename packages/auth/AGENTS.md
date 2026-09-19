# Working on URLCode auth

- Read CONTRIBUTING.md, SECURITY.md, THREAT-MODEL.md and IMPLEMENTATION-STATUS.md first.
  Core owns the generic extension contract (`@jimhoyd/urlcode/extensions`); this
  repository owns the trusted auth implementation. docs/SPIKE-AUTH.md is the plan,
  not the contract.
- Apache-2.0. Do not publish packages by hand (release.yml publishes tagged commits on main), change licensing or bypass protected main.
- TypeScript run through Node type stripping; `dist/` is built, never committed.
  Peers resolve from local checkouts or tarballs, never from a registry.
- Tests need a Node build whose SQLite is 3.51.3+ (or 3.50.7 / 3.44.6); the store
  refuses others with `patched_sqlite_required`. CI runs Node 22/24/26.
- Run `npm run verify` for every change. Security-relevant paths (sessions,
  tokens, factors, backoff, CSRF, escaping) need a regression test in the same PR.
- Never commit credentials, databases, key files or customer data. Synthetic
  fixtures only. Live Google/Apple/SES checks are separate operator tasks.
- Report actual evidence and remaining limitations; CI is not a security review.

## File what you find

Do not drop a defect, a gap or an idea you could not act on. File an issue on the
repository that owns it, using its issue templates:

| What you touched | Where to file |
|---|---|
| Runtime, CLI, schema | [urlcode](https://github.com/jimhoyd-com/urlcode/issues) |
| Accounts, sign-in, protected routes | [urlcode-auth](https://github.com/jimhoyd-com/urlcode-auth/issues) |
| Users, sessions, roles, audit | [urlcode-admin](https://github.com/jimhoyd-com/urlcode-admin/issues) |
| Extension page styling and copy | [urlcode-ui](https://github.com/jimhoyd-com/urlcode-ui/issues) |

Feature requests are wanted, not just bugs: if you had to hand-write application
code that the URLCode vocabulary could have owned, that is the evidence the
roadmap runs on — file it with the YAML you had to write. Search first and add to
the existing issue rather than opening a duplicate. State what you observed, not
what you assume, and say plainly what you did not verify.

## Documentation for this package lives in this repository

Reader-facing guides and references for this package are authored here, next to
the code they describe — there is no separate documentation repository. Runtime
documentation lives in the core repository's `docs/`. Keep this repository's
README, `docs/` and contributor docs accurate rather than pointing readers
somewhere else.
