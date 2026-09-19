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
