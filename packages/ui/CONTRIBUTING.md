# Contributing

Read SECURITY.md and CONTRACT.md. Keep Apache-2.0 licensing and do not publish
packages outside the release workflow. Work on branches and pull requests; never
bypass reviews/checks. Keep production code dependency-free and free of Node-specific
APIs, authentication decisions, database access, project-code evaluation and secrets.

Only `src/host/` may import Node modules; the main entry and the rendering core stay free of them, and the closure test enforces it. When a partial's view model changes, bump its `viewModel` version so `doctor` can report ejected templates that are behind.

`src/styles.generated.ts` is the compiled Tailwind output and is gitignored. Run `npm run styles` (or `npm run build` / `npm run verify`, which run it) before a consumer resolves the `development` export condition against `src/`; a fresh checkout has no generated stylesheet until then.

`verify` is `styles` then `typecheck:tsc`, `build:tsc` and `test`. `typecheck:tsc` and `build:tsc` are the bare compiler invocations; `typecheck` and `build` are those same steps with `styles` in front, so each stays correct on its own. The split exists only so one verification compiles Tailwind once instead of twice -- it is not a cache, and nothing skips work because an output already exists. Put any new step that needs generated styles behind `styles` rather than adding a second `styles` call.

First-party executable extensions use immutable `extension-bundles@v…` tags and
the root [`extension-bundles.yml`](../../.github/workflows/extension-bundles.yml)
publisher. Use the shared [release coordinator](../../docs/DEVELOPMENT-PIPELINE.md);
do not publish a UI npm package or use the package's former standalone `v*` tag
scheme.

Run npm run verify. One test validates the scaffolded fragment against core. Core is this
repository's root, so it is found automatically and the test runs rather than skipping --
build it once with `npm run build` at the root. There is no pinned peer revision any more:
`peers.json` and the workflow that read it were removed when this package moved in, because
a workspace package and its sibling are always the same commit and cannot drift apart.
Set `URLCODE_CORE=/path/to/urlcode` only to test against some other checkout;
without either, that one test skips and says so. Changes to public exports require an actual packed consumer test
with core, auth and admin. Do not commit dist, node_modules, fixture credentials or
real data. Record accessibility/security limitations honestly.
