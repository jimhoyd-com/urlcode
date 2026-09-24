# Working on URLCode store

- Read CONTRIBUTING.md and SECURITY.md first. Core owns the generic extension
  contract (`@jimhoyd/urlcode/extensions`); this package owns the trusted,
  file-backed collection store: declared typed collections mounted as a
  bounded JSON CRUD API, no project handler code. [docs/STORE.md](../../docs/STORE.md)
  is the full guide, HTTP contract and the honest list of concurrency
  guarantees.
- Apache-2.0. Do not publish packages by hand. This package ships as a tarball
  on core's GitHub Release, pinned by sha512 in core's `dist/addons.json`; only
  core is on npm. Do not change licensing or bypass protected main.
- TypeScript run through Node type stripping; `dist/` is built, never
  committed. The peer is a workspace sibling: core resolves through the
  `file:../..` link that `scripts/check-workspace-links.ts` enforces, never
  from a registry.
- The store is trusted operator code: unsandboxed, not a multi-tenant
  boundary, and every caller who can reach a mount can read and (unless
  `readOnly`) change every record in that collection. It owns one exclusive,
  atomically written lock file per data directory (`src/store.ts`), whole-file
  atomic writes, per-collection record/byte quotas, `sortable`/`filterable`
  query handling (`src/query.ts`) and the extension definition
  (`src/extension.ts`: the `urlcode extensions add store` scaffold and the
  `host()` registration), whose scaffold refuses an unprotected mount without an
  explicit `--ack store:public-write`. See [SECURITY.md](SECURITY.md) for the full
  trust boundary before changing any of these.
- Run `npm run verify` for every change. Locking, quota, `ETag`/`If-Match`,
  `Idempotency-Key` scoping and query-validation paths need a regression test
  in the same PR (`test/store.test.ts`, `test/query.test.ts`,
  `test/scaffold.test.ts`).
- Never commit credentials, customer data or a real operator data directory.
  Synthetic fixtures only.
- Report actual evidence and remaining limitations; CI passing is not an
  independent security review or a crash/disk-full/filesystem behavior proof.

## File what you find

Do not drop a defect, a gap or an idea you could not act on. Runtime, CLI and
schema, accounts and protected routes, users and audit, extension page styling
and copy, and this extension's own data contract all live in this one
repository now, so file everything against
[urlcode](https://github.com/jimhoyd-com/urlcode/issues), using its issue
templates.

Feature requests are wanted, not just bugs: if you had to hand-write
application code that the URLCode vocabulary could have owned, that is the
evidence the roadmap runs on — file it with the YAML you had to write. Search
first and add to the existing issue rather than opening a duplicate. State what
you observed, not what you assume, and say plainly what you did not verify.

## Documentation lives in the monorepo

Write guides and references in the root `docs/` directory, alongside core
docs. Keep this package's contributor and security material accurate. Follow
the root [development and release pipeline](../../docs/DEVELOPMENT-PIPELINE.md)
for the shared version and release.
