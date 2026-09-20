# Blog on URLCode (the pinned release)

## Run
```
cd app && npm install
npm start                # urlcode serve --project . (http://127.0.0.1:3000; --port via `npx urlcode serve --project . --port N`)
npm test                 # node:test suite, 8 tests, incl. restart persistence (starts real URLCode servers on port 0)
npm run validate         # urlcode validate --local  -> valid, 10 routes
npm run fixtures         # urlcode test: 18 HTTP fixtures in tests/requests.json (stateless/negative cases)
npm run audit            # urlcode audit --expect-routes 10 -> checks pass; ready:false (see below)
```
Data: `app/data/posts.json` (override dir with `BLOG_DATA_DIR`). Public: `/`, `/posts/{slug}`. Management: `/admin`, `/admin/new`, `POST /admin/posts`, `GET|POST /admin/posts/{id}`, `POST /admin/posts/{id}/{publish|unpublish|delete}`. Successful writes redirect 303; validation errors 422; missing 404.

## Files
`app/urlcode.yaml` (all routes/policies), `app/functions/blog.mjs` (handlers + HTML), `app/functions/store.mjs` (JSON file store + validation), `app/tests/requests.json` (fixtures), `app/test/blog.test.mjs` (lifecycle tests), `app/package.json`.

## URLCode features used
- Handlers: `function` (long form with named `export`, `args: {from: path}`) only; no native handler fits dynamic HTML.
- Per-route: `methods` (405 + Allow), `parameters` (path schema), `request.body` (`required`, `maxBytes` -> 413, `contentTypes` -> 415, `format: text`), `sandboxReason`.
- Policies: `policies.security` (`headers: oshp-no-csp` + `set` for a custom CSP).
- `site.robots` generates `/robots.txt` (Disallow /admin).
- Extension package `@jimhoyd/urlcode-ui` used as a library (not as a runtime extension): `renderDocument`, `navigation`, `emptyState`, `alert`, `button`, `escapeHtml`, `createPresentation` for the responsive, escaped HTML shell.
- Tooling: `validate`, `test`, `audit`, `capabilities`, `schema`; embedding API `startServer` in tests.

## Custom JavaScript (and why)
- `functions/store.mjs`: persistence and post validation (slug rules, uniqueness, timestamps). Core has no storage/CRUD handler or body-validation beyond size/type/JSON syntax; docs list persistence as a known gap. Uses trusted (unsandboxed) routes because the sandbox has no filesystem.
- `functions/blog.mjs`: dynamic rendering and form handling; no template/list handler exists in core. Textarea markup and the extra CSS are hand-written since the ui kit's `field` is single-line.
- `test/blog.test.mjs`: hand-written harness because fixtures are single stateless requests (the docs record multi-step/restart fixtures as open issue #256).

## Not found / gaps
- A storage/CRUD handler or recipe (docs say to report as gap), form-body validation, custom 404 pages (unknown-route 404s are plain runtime output; post-not-found is a function-rendered HTML 404), a textarea component in ui kit, template rendering of lists from data.
- `urlcode audit` reports `ready:false` (`uncovered-route-methods`): coverage requires a <400 asserted response for every function route/method (mutating routes, `{id}`/`{slug}` routes) which needs seeded state, and fixtures cannot create state. All 10 generated+fixture checks pass. I did not fake it with seed data.

## Confusing
- `npm run serve --port` default 3000; I hit "Port is already in use" from another process, with only a JSON `error` event.
- Site `robots` schema: `rules/userAgent` (a natural guess) fails with only `additionalProperties`; needed `urlcode schema site.robots`.
- `oshp` CSP (`default-src 'self'`, `upgrade-insecure-requests`) breaks inline-style pages and plain-http localhost; had to use `oshp-no-csp` + `set`.
- `--expect-routes` counts generated `site` routes (10, not 9) - documented but easy to miss; validate reports 10 too.
- Route-level `function` short form auto-binds params, but the long form (needed for named `export`) requires manual `args`; single-export-per-route forced an `editOrUpdate` dispatcher on `/admin/posts/{id}` (no per-method function map).
- `urlcode test` output is verbose JSON per request even for passing cases (docs say quiet-by-default exists in repo HEAD, not in the pinned release npm).
- Function docs say `.js` modules need `type: module`; I set it on package.json for the test file anyway.
