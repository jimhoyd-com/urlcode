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
