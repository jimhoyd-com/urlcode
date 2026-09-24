# Changesets

Changesets records release intent and changelogs for the extension workspace
packages under `packages/` (ui, auth, admin, store, forms and mcp). Core remains
the repository root and gets an explicit version update in the same reviewed
release PR; Changesets does not version it. Only core is an npm release target;
the extensions and artifacts are private add-ons released as tarballs on core's
GitHub Release at core's version.

Run `npx changeset` to record a package change. Apply queued changes in a release
PR with `npx changeset version`, then `npm install --package-lock-only` and
`npm run release:check`. Review peer ranges and changelogs before merging.

An explicitly selected stable version through `release:prepare` exits alpha
mode and changes the publication channel to `latest`. Later stable patches keep
pre-mode absent. Alpha targets require existing alpha mode; returning to alpha
requires a separate release-policy decision. Historical alpha tags and channel
pointers are preserved.
`fixed` and `linked` remain empty; packing refuses an add-on whose version
differs from core's.

`onlyUpdatePeerDependentsWhenOutOfRange` prevents Changesets from unnecessarily
raising peer floors and narrowing their upper bounds. A monorepo migration by
itself does not establish a new API requirement. Review the generated ranges;
this experimental flag is not a substitute for published-peer tests.

Publication is through the shared `release-dispatch.yml`/`release.yml`
coordinator workflows in this repository using npm OIDC. They share
preparation/preflight/publication helpers and coordinate through
`npm run release:run`.
That command is read-only unless `--execute` is explicitly supplied.

See [the pipeline](../docs/DEVELOPMENT-PIPELINE.md) and
[version alignment](../docs/VERSION-ALIGNMENT.md). `alpha` and `latest` are
separate channels and need not name the same release. No script automatically
moves historical channels or rewrites old version tags.
