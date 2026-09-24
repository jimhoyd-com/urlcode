# Release operations

This is the operator runbook for preparing, approving, publishing, rehearsing
and recovering a URLCode release. It complements [release security](RELEASE-SECURITY.md)
and [release readiness](RELEASE-READINESS.md); neither a green release nor this
runbook establishes production readiness or an independent security assessment.

## Prepare a version

Core remains at the repository root. Independent extension versions remain
supported; a coordinated version is an explicit maintainer choice. Feature PRs
record workspace release intent in Changesets; core release notes remain a
maintainer responsibility.

`release:check` checks manifest/lock versions and peer ranges, CLI and MCP
versions, generated plugin metadata, local peer compatibility and channel policy.
The preparation helper updates them together, adds release notes and extension
changelogs, and records the version decision. Pending Changesets must be
explicitly consumed; they are archived under `.changeset/pre/` and their
summaries included in release notes. Review the resulting diff and peer minimums.

<!-- urlcode-current-version:start -->
```sh
# Choose the intended version before executing.
npm run release:prepare -- --version 0.5.9 --consume-changesets
# Apply edits on a clean non-main branch; no remote writes or publication:
npm run release:prepare -- --version 0.5.9 --consume-changesets --execute
```
<!-- urlcode-current-version:end -->

An optional `--notes PATH` adds reviewed maintainer notes. Dry runs do not
change files. Preparation rejects downgrades, reused local tags, dirty checkouts
and stale plans. A stable target removes `.changeset/pre.json` only once no
package remains on alpha; alpha targets require existing alpha mode. The helper
does not silently create a fixed-version policy or re-enter prerelease mode.

Before release preparation, manually dispatch **Verify — compatibility** from
the branch under review. It is read-only: package installation, reproducibility,
the composite Action, container and cross-workspace proofs run without tagging
or publishing. The coordinator repeats exact-commit verification before it
creates a tag.

## Actions entry points

**op start** means a maintainer deliberately starts the workflow from Actions.
**Release approval** is the protected environment gate: GitHub pauses the job,
withholds release secrets and requires the designated approver. Workflows named
**internal** support a coordinator and are not release substitutes.

| Goal | Workflow in Actions | Start | Gate before release-affecting action |
| --- | --- | --- | --- |
| Publish core | **Release: core: op start** (`release-core-dispatch.yml`) | Select `main`, run it with version and Changesets choice | `release` approval before PR/tag coordination and again before the tag publisher receives credentials |
| Publish executable first-party bundles | **Release: extensions: op start** (`extension-bundles.yml`) | Select `main`, run it with a new bundle version | `release` approval before the immutable `extension-bundles@v…` tag and again for its build/publish run |
| Publish declarative artifacts | **Release: extensions: op — publish declarative artifacts** (`extension-artifacts.yml`) | Push reviewed immutable `extensions@v…` tag | `release` approval before publication |
| Exercise without publication | **Release: rehearsal: operator run (no publication)** (`release-rehearsal.yml`) | Select ref and run | No release approval; it cannot tag, sign, retain or publish |

**Release: core: internal signed candidate** is dispatched for the exact merge
commit; it is evidence, not an operator button. **Release: core: op — internal
coordinator** performs approval-gated coordination. **Verify — CI** can be run
for coverage but is not a publication gate by itself.

The core train creates a release PR, waits for normal required checks, merges
without bypass, runs the full exact-commit matrix and signed candidate, publishes
an immutable tag, checks registry installability, updates Homebrew and verifies
the standalone starter. Executable bundles are a separate GitHub Release train;
they do not publish extension npm packages.

The protected `release` environment covers core and bundle publication. It
admits only `main`, `v*` and `extension-bundles@v*`. Self-review remains enabled
while the project has one maintainer; it is not independent review. Configure
`RELEASE_AUTOMATION_TOKEN` as a repository Actions secret, preferably a
repository-scoped GitHub App token. A fine-grained PAT may be limited to
`urlcode` and `urlcode-template` with Contents, Pull requests and Actions
read/write. Do not grant ruleset bypass, administration, PR approval or package
registry credentials. Dispatch from `main`.

## Extension distribution

### Declarative artifacts

Data-only artifact sources live under `extension-artifacts/`; generated catalogs and
archives do not. In a new empty directory, prepare and inspect the exact inputs:

```sh
npm run artifacts:prepare -- --tag extensions@v1.0.0 --commit "$(git rev-parse HEAD)" --output /tmp/urlcode-extension-artifacts
tar -tzf /tmp/urlcode-extension-artifacts/store-schema-1.0.0.tgz
```

The declarative workflow runs only for the disjoint `extensions@v*` tag namespace.
It requires a protected-main commit, builds deterministic gzip/tar assets in a
runner-temporary directory, inserts `GITHUB_SHA` into the generated catalog,
rechecks every digest and allowlist, then attests and publishes through the
protected environment. The catalog is generated after checkout: a committed
catalog cannot safely include the hash of the commit that contains it. Never
reuse or move a published tag.

### Executable bundles

Executable first-party bundles are intentionally separate from data-only
artifacts. Before proposing a tag, use a clean checkout and inspect the frozen
module inventory:

```sh
npm run bundles:prepare -- --tag extension-bundles@v1.0.0 --commit "$(git rev-parse HEAD)" --output /tmp/urlcode-extension-bundles
tar -tzf /tmp/urlcode-extension-bundles/store-*.tgz
```

The bundle workflow runs on an `extension-bundles@v*` tag, or a dispatch from
`main` creates that tag after protected-environment approval and dispatches the
same tag run. Nothing is built or signed by the `main` dispatch. The tag run
builds exact-commit inputs, installs locked production dependencies only in the
release runner, rejects links/special files, emits deterministic archives,
verifies catalog digests and member paths, then attests catalog and bundles.
Before publication and again from the published release, it runs
`scripts/verify-extension-bundles.ts` with the consumer transport. A release the
CLI would refuse must fail the workflow. Consumers never use npm for these
assets; an explicit operator host verifies the tag attestation before loading a
locked entry.

## Local coordinator and resume

A package never published to npm cannot use this path for its first version:
registry lookups treat a 404 as an error on purpose, and npm trusted publishing
must be configured on the package's npmjs.com settings before the pipeline can
publish it, which needs one manual `npm publish` first. First-party extensions
no longer need this: they ship as signed GitHub Release bundles, not npm
packages. A version published this way is recorded in
`scripts/release-hand-published.ts` (below). Inspect without writing:

<!-- urlcode-current-version:start -->
```sh
npm run release:status
npm run release:plan
npm run release:run
npm run release:run -- --version 0.5.9 --consume-changesets
```
<!-- urlcode-current-version:end -->

For an explicitly authorized release, add `--execute`. It authorizes the full
sequence—release branch/PR, checks and merge, gates, tags, publication, installed
consumer proof and starter update—but never approves review or bypasses a
required check. It works in a temporary clone, prepares or resumes
`codex/release-VERSION`, and discovers existing PRs, gates, tags and workflow
state instead of creating another train.

For an independently prepared release PR already merged to main, use a clean
checkout of its exact commit:

```sh
npm run release:run -- --execute
```

The coordinator creates `codex/release-validation/SHA` only at that SHA, dispatches
full `ci.yml` and `candidate.yml`, and reuses successful or waits for running
runs. Compact PR/main checks cannot replace the full matrix or CodeQL. Before
tags, it downloads and verifies the candidate bundle. Release tags bind source
commit, candidate run ID and signed-manifest SHA256; every package in a resumed
train selects those same bytes. A later candidate or newer main commit cannot
replace them silently.

Publication is sequential: core, UI, auth, then admin, skipping unchanged
published versions. Each package must be registry-readable with a downloadable,
SHA512-verified tarball before dependents begin. The coordinator then tests a
fresh external consumer and updates the standalone starter from the installed
core package. `--skip-template` leaves that follow-up to the maintainer; the
dedicated `release:template -- --version … --execute` helper opens but does not
merge its PR.

## Candidate bytes, rehearsal and recovery

Core publishes only the signed candidate's verified archive. Bundle releases
separately attest their exact workspace source, catalog and frozen archives.
Candidate/release artifacts retain for 90 days; retention is not an archival or
rollback guarantee. Keep independent last-good copies.

Run `npm run rehearse:release` for the inexpensive rehearsal tests. The manual
**Release: rehearsal: operator run (no publication)** also exercises the
candidate channel and container path, but cannot prove registry/GitHub API,
attestation, protected-environment credentials, runner-specific conditions or
tag-only behavior. Use it after changing release scripts, container packaging or
release workflows.

A retry restores the original retained bundle or recovers a complete verified
bundle from its GitHub Release. It never rebuilds archives or substitutes a new
candidate. Existing npm versions and GitHub assets must match byte-for-byte;
partial success is possible and not atomic. A source change requires a new
version and tag. Never delete, recreate, move or force-push a version tag.

A version published by hand has no tag; any untagged published version stops
the release for inspection and repair. The one-time hand-publish exception
(`scripts/release-hand-published.ts`) that let the coordinator resume past
`@jimhoyd/urlcode-store`'s manual first publish has been removed now that the
release path is core-only and core has always published through the
automated pipeline; a future first-of-its-kind publish would need the same
kind of narrow, explicit exception again. See
[FIRST-NPM-PUBLISH.md](FIRST-NPM-PUBLISH.md). npm uses OIDC with pinned npm. Alpha versions use
the alpha channels; existing latest pointers are not promoted. Core GHCR
publication remains conditional on `PUBLISH_CONTAINER=true`. See
[release security](RELEASE-SECURITY.md) for provenance/dependency triage and
[release readiness](RELEASE-READINESS.md) for production gates.
