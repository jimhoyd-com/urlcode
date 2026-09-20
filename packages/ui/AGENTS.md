# Working on URLCode UI

- Read CONTRIBUTING.md, SECURITY.md and CONTRACT.md. docs/SPIKE-UI.md is the plan.
- Apache-2.0. Do not publish packages or bypass protected main.
- Production code stays dependency-free and free of Node APIs, authentication
  decisions, database access, project-code evaluation and secrets. Only
  `src/host/` may import Node modules; the closure test enforces it.
- `src/styles.generated.ts` is built by `npm run styles` (also by build/verify)
  and is gitignored; run it before consumers resolve the `development` export.
- When a partial's view model changes, bump its `viewModel` version so
  `urlcode-ui doctor` reports ejected templates that are behind.
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
[development and release pipeline](../../docs/DEVELOPMENT-PIPELINE.md) for scoped
release tags and the shared coordinator; standalone repository workflows are retired.
