# Changesets

Changesets manages independent versions and changelogs for the three workspace
packages: UI, auth and admin. Core remains the repository root and gets an
explicit version update in the same reviewed release PR; Changesets does not
version it. Shared release helpers include all four packages.

Run `npx changeset` to record a package change. Apply queued changes in a release
PR with `npx changeset version`, then `npm install --package-lock-only` and
`npm run release:check`. Review peer ranges and changelogs before merging.

An explicitly selected stable version through `release:prepare` exits alpha
mode and changes the publication channel to `latest`. Later stable patches keep
pre-mode absent. Alpha targets require existing alpha mode; returning to alpha
requires a separate release-policy decision. Historical alpha tags and channel
pointers are preserved.
`fixed` and `linked` remain empty: one repository does not mean one version.

`onlyUpdatePeerDependentsWhenOutOfRange` prevents Changesets from unnecessarily
raising peer floors and narrowing their upper bounds. A monorepo migration by
itself does not establish a new API requirement. Review the generated ranges;
this experimental flag is not a substitute for published-peer tests.

Publication is through the per-package workflows in this repository using npm
OIDC. They share preparation/preflight/publication helpers, retain their existing
trusted-publisher filenames, and coordinate through `npm run release:run`.
That command is read-only unless `--execute` is explicitly supplied.

See [the pipeline](../docs/DEVELOPMENT-PIPELINE.md) and
[version alignment](../docs/VERSION-ALIGNMENT.md). `alpha` and `latest` are
separate channels and need not name the same release. No script automatically
moves historical channels or rewrites old version tags.
