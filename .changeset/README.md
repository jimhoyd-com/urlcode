# Changesets

This directory is the release flow for the workspace packages under
`packages/`, chosen over Nx and Turborepo in
[docs/SPIKE-MONOREPO.md](../docs/SPIKE-MONOREPO.md) ("npm workspace
restructuring"). A changeset is a small markdown file naming a package, a
semver bump and a description. `npx changeset` writes one.

It exists to be a deliberate checkpoint. Once `packages/*` sit beside core,
local development tests against a sibling package's *unreleased* state by
default, because the workspace links source rather than the published tarball.
The changeset is what stops that from silently becoming a release: a package
whose behavior changed but which has no changeset has not been released, and
CI can check that mechanically.

## What it does and does not cover

**Covered:** every package under `packages/`. Today that is
`@jimhoyd/urlcode-ui`.

**Not covered:** core itself. `@jimhoyd/urlcode` is the repository root rather
than a workspace member (layout option A), so its version is still managed as
it always was, and its release still runs from `.github/workflows/release.yml`.
Do not expect `changeset version` to bump it.

## Pre mode is on, and must stay on

`pre.json` puts this repository in Changesets' **pre mode** with the tag
`alpha`. Do not leave it without deciding to, because leaving it is how the
alpha line accidentally ships as stable.

Every package here is on a prerelease version, and outside pre mode a `patch`
changeset against `0.1.0-alpha.5` does not produce `0.1.0-alpha.6` -- it
produces **`0.1.0`**. That is a stable version, and the release workflows
derive the npm dist-tag from the version, so it would publish under `latest`
and become what a plain `npm install @jimhoyd/urlcode-ui` resolves to. A
published version can never be replaced.

That directly contradicts
[VERSION-ALIGNMENT.md](../docs/VERSION-ALIGNMENT.md): "`latest` deliberately
stays on the `0.3.0` Apache-2.0 self-hosted baseline: the `0.4.0` line is a
prerelease and must not become the default install." The workflows' rule that
"a prerelease can only publish under `alpha`" holds -- but it cannot help when
the version it is handed is no longer a prerelease.

Verified rather than assumed: with pre mode the same changeset produces
`0.1.0-alpha.6` and a dist-tag of `alpha`; without it, `0.1.0` and `latest`.

When a package is genuinely ready to leave alpha, `npx changeset pre exit` is
a deliberate act with its own review, not a side effect of forgetting.

## Independent versioning is preserved

`fixed` and `linked` are both empty on purpose. Each package keeps its own
version and its own release cadence — a monorepo with workspaces is not one
version number for everything, and nothing here makes ui's version follow
core's.

## Before the first release from this repository

Publishing is **not** wired up yet. Each package's npm trusted-publisher entry
on npmjs.com is pinned to its old repository *and its old workflow filename*,
and does not follow the code. `@jimhoyd/urlcode-ui`'s entry still names
`jimhoyd-com/urlcode-ui` + `release.yml`; it must be re-registered against this
repository and this repository's per-package workflow path before ui is
released from here, or the publish step fails closed. See mechanics #6 in the
spike.
