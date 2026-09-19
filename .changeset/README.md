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

Two things in [VERSION-ALIGNMENT.md](../docs/VERSION-ALIGNMENT.md) break if
that happens. For **core**, "`latest` deliberately stays on the `0.3.0`
Apache-2.0 self-hosted baseline: the `0.4.0` line is a prerelease and must not
become the default install." For the **extension line**, `latest` and `alpha`
deliberately point at the same version -- publishing a stable `0.1.0` moves
`latest` off the alpha it is supposed to track, and ships a stable-numbered
release of a package whose own status is "alpha: review pending". The
workflows' rule that "a prerelease can only publish under `alpha`" holds in
both cases -- but it cannot help, because by the time it runs the version it
was handed is no longer a prerelease.

Verified rather than assumed: with pre mode the same changeset produces
`0.1.0-alpha.6` and a dist-tag of `alpha`; without it, `0.1.0` and `latest`.

When a package is genuinely ready to leave alpha, `npx changeset pre exit` is
a deliberate act with its own review, not a side effect of forgetting.

## Why `onlyUpdatePeerDependentsWhenOutOfRange` is set

`config.json` carries
`___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange`.
The name invites deletion. Do not delete it without reading this.

By default Changesets rewrites a `peerDependencies` range whenever the package
it points at is released, even when the new version already satisfies the range.
Releasing `@jimhoyd/urlcode-auth` `0.1.0-alpha.4` rewrote admin's declared peer
from `>=0.1.0-alpha.2 <0.2.0` to `>=0.1.0-alpha.4 <0.1.0`, which is wrong twice
over:

- **The upper bound narrowed** from `<0.2.0` to `<0.1.0`, so admin would refuse
  auth `0.1.0` and every release after it — it breaks the moment auth leaves
  alpha.
- **The floor rose** to `>=0.1.0-alpha.4` while auth's `latest` stays at
  `0.1.0-alpha.3`, because a prerelease publishes under `alpha` and nothing
  moves `latest`. That is exactly the failure
  [the second invariant](../docs/VERSION-ALIGNMENT.md) exists to prevent: a
  plain `npm install @jimhoyd/urlcode-auth` would resolve a build admin
  rejects.

Neither was intended: moving the packages into this repository added no new API
requirement between them. With the flag set, a range is rewritten only when the
released version actually falls outside it, which is the behaviour the declared
ranges already describe.

`updateInternalDependencies` does not cover this — it governs ordinary
dependencies, not peers.

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
