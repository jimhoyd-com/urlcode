# Working on URLCode UI

- Read CONTRIBUTING.md, SECURITY.md and CONTRACT.md, the contract for what
  shipped. The original design spike is private maintainer material.
- Apache-2.0. Do not publish packages or bypass protected main.
- Production code stays dependency-free and free of Node APIs, authentication
  decisions, database access, project-code evaluation and secrets. Only
  `src/host/` may import Node modules; the closure test enforces it.
- `src/styles.generated.ts` is built by `npm run styles` (also by build/verify)
  and is gitignored; run it before consumers resolve the `development` export.
  `verify` runs `styles` once up front and then the compiler-only `typecheck:tsc`
  and `build:tsc`; do not reintroduce a second `styles` call into that chain.
- When a partial's view model changes, bump its `viewModel` version so
  `urlcode-ui doctor` reports ejected templates that are behind. An extension's
  namespace is only in that report when its package is named in `--extensions`,
  so keep `scaffold`'s generated commands naming the peers a site composes.
- Run `npm run verify`. Escaping, URL validation, CSP and limits need tests.
- Public export changes need a packed consumer test with core, auth and admin.

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
