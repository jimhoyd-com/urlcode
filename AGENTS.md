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
