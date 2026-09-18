# Contributing

Read SECURITY.md and CONTRACT.md. Keep Apache-2.0 licensing and do not publish
packages outside the release workflow. Work on branches and pull requests; never
bypass reviews/checks. Keep production code dependency-free and free of Node-specific
APIs, authentication decisions, database access, project-code evaluation and secrets.

Only `src/host/` may import Node modules; the main entry and the rendering core stay free of them, and the closure test enforces it. When a partial's view model changes, bump its `viewModel` version so `doctor` can report ejected templates that are behind.

`src/styles.generated.ts` is the compiled Tailwind output and is gitignored. Run `npm run styles` (or `npm run build` / `npm run verify`, which run it) before a consumer resolves the `development` export condition against `src/`; a fresh checkout has no generated stylesheet until then.

Releases: tag a commit on main `vX.Y.Z-alpha.N` (matching `package.json`) to run `.github/workflows/release.yml`, which verifies, packs, signs provenance and creates the GitHub release; it publishes to npm only when the `PUBLISH_NPM` repository variable is `true`, through an npm trusted publisher for this repository and `release.yml` (no token).

Run npm run verify. Changes to public exports require an actual packed consumer test
with core, auth and admin. Do not commit dist, node_modules, fixture credentials or
real data. Record accessibility/security limitations honestly.
