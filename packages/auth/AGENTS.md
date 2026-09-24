# Working on URLCode auth

- Read CONTRIBUTING.md, SECURITY.md, THREAT-MODEL.md and IMPLEMENTATION-STATUS.md first.
  Core owns the generic extension contract (`@jimhoyd/urlcode/extensions`); this
  package owns the trusted auth implementation. IMPLEMENTATION-STATUS.md is the
  contract for what shipped; the original design spike is private maintainer
  material.
- Apache-2.0. Do not publish packages by hand. This package ships as a tarball
  on core's GitHub Release, pinned by sha512 in core's `dist/addons.json`; only
  core is on npm. Do not change licensing or bypass protected main.
- TypeScript run through Node type stripping; `dist/` is built, never committed.
  Peers are workspace siblings: core resolves through the `file:../..` link that
  `scripts/check-workspace-links.ts` enforces, never from a registry.
- Tests need a Node build whose SQLite is 3.51.3+ (or 3.50.7 / 3.44.6); the store
  refuses others with `patched_sqlite_required`. CI runs Node 22/24/26.
- Run `npm run verify` for every change. Security-relevant paths (sessions,
  tokens, factors, backoff, CSRF, escaping) need a regression test in the same PR.
- Never commit credentials, databases, key files or customer data. Synthetic
  fixtures only. Live Google/Apple/SES checks are separate operator tasks.
- Report actual evidence and remaining limitations; CI is not a security review.

## File what you find

Do not drop a defect, a gap or an idea you could not act on. Runtime, CLI and
schema, accounts and protected routes, users and audit, extension page styling
and copy all live in this one repository now, so file everything against
[urlcode](https://github.com/jimhoyd-com/urlcode/issues), using its issue
templates.

Feature requests are wanted, not just bugs: if you had to hand-write application
code that the URLCode vocabulary could have owned, that is the evidence the
roadmap runs on — file it with the YAML you had to write. Search first and add to
the existing issue rather than opening a duplicate. State what you observed, not
what you assume, and say plainly what you did not verify.

## Documentation lives in the monorepo

Write guides and references in the root `docs/` directory, alongside core docs.
Keep package contributor and security material accurate. Follow the root
[development and release pipeline](../../docs/DEVELOPMENT-PIPELINE.md) for
the shared version and release.
