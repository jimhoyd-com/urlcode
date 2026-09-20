# Candidate and release security

The [development pipeline](DEVELOPMENT-PIPELINE.md) is the operational runbook
for CI selection, release planning, tags, publication and recovery. The
[September 19 audit](CI-RELEASE-AUDIT-2026-09-19.md) explains the changes;
[the prior process and failure history](archive/2026-09-19/RELEASE-SECURITY.md)
is retained as a historical record, not current instructions.

The license remains Apache-2.0. A successful release is not an independent
security assessment, hostile multi-tenant readiness claim or deployment proof.
See [release readiness](RELEASE-READINESS.md) and [security](../SECURITY.md).

## Source and validation

A release must name the checked-out commit, already on main, with successful
full verification of that exact SHA and CodeQL analysis. Full verification
means a successful nightly or manual `ci.yml` run across every supported OS/Node
combination; the compact push/PR matrix alone does not authorize publication. Package manifests,
lockfile versions and tag names must agree. Published peer floors must exist and
extension tests must resolve the published packages, not workspace source.
The candidate builds all package archives once using the digest-pinned Node
image from Dockerfile; publishers promote those exact signed bytes. The builder
installs Git from Debian for repository-fixture tests; Git is a test dependency,
not an addition to the runtime image or npm package. Locked dependencies,
verification, runtime audit, package installation tests and local drills precede
packing. Build commands in that container receive no GitHub token.

The candidate workflow stores artifacts without publishing. A tagged release
publishes npm only when `PUBLISH_NPM=true` and core images only when
`PUBLISH_CONTAINER=true`. Candidate and release artifacts are retained for 90 days, and each package
GitHub release stores the complete signed candidate bundle. Retries verify and
reuse original retained or durable bytes; missing originals fail closed. Keep independent last-good artifacts and
rehearse deployment rollback; Actions retention is not an archival guarantee.

## Identity and provenance

The four per-package workflow filenames are stable npm trusted-publisher
identities. npm publishing uses OIDC, npm 11.5.1 and a supported Node version,
with no long-lived npm token. Renaming a workflow or changing the repository
requires a reviewed registry trust migration. Successful preparation does not
prove the registry-side identity permits direct publication.

`actions/attest` signs the candidate files with GitHub OIDC/Sigstore provenance.
The candidate bundle includes all four archives, dependency SBOM, build manifest,
train metadata (exact versions, npm channels, peer requirements and archive
integrities), checksums and Homebrew formula. The publisher renders that signed
train into the GitHub release's recommended-stack table. Each publisher retains that
bundle and publishes only its selected npm archive. New annotated version tags
pin the candidate run ID and signed-manifest SHA256. The run ID is also bound
into the manifest; the digest prevents another attempt of that run from
substituting different artifacts. The core manifest records source SHA, lockfile hash, Node and
TypeScript versions and emitted-file hashes. `dist/` is built, never committed.

Verify an artifact with `gh attestation verify <tarball> --repo
jimhoyd-com/urlcode`, and constrain verification to the expected workflow,
source ref and source digest for the selected release. Compare the source and
artifact hashes to the intended release, rather than accepting any signed file.
A signature establishes provenance, not safety or reproducibility. The npm SBOM
is not a complete OS/container SBOM; hosted runners remain platform-controlled.

## Immutability and channels

Never delete/recreate or move a version tag to repair a workflow. A source fix
requires a new version. Repeating publication of an existing npm version requires
identical SHA-512 integrity. GitHub assets are compared and missing assets added;
existing unequal assets are never clobbered. Transient registry errors fail
closed rather than count as an unpublished version.

Alpha versions use npm/GHCR `alpha` and GitHub prerelease classification.
Explicit stable versions use npm `latest` and normal GitHub releases. Only the
stable core release advances GitHub `latest`, so the core installer cannot pick
an extension release. Stable preparation removes Changesets prerelease mode;
existing alpha artifacts, tags and channel pointers remain unchanged. Mutable npm
and container channels cannot regress to an older version. Existing core image
versions are reused only with matching source labels; unlabeled historical
images require a reviewed migration rather than an inferred identity.

The coordinator verifies candidate availability and provenance before creating
any version tag, then creates one at a time and waits for successful publication
and consumer-facing registry installability before releasing dependents. Shared publication concurrency avoids cross-version races.
The active immutable-tag rule blocks release tag updates/deletions with no
bypass actors; its configuration is in `.github/rulesets/release-tags.json`.
The separate release-tag-creation rule allows only `@jimhoyd`, including trusted
local agents and automation operating through that identity, to create matching
tags; its configuration is in
`.github/rulesets/release-tag-creations.json`. This creation exception does not
permit moving or deleting a published tag. No automation needs permission to
bypass main checks or approve its own PR. Manual package/all release workflows
share the coordinator and need
`RELEASE_AUTOMATION_TOKEN` because events created by the ordinary `GITHUB_TOKEN`
do not trigger tag publishers. A repository-scoped GitHub App is preferred. A
fine-grained PAT may select only `urlcode` and `urlcode-template`, with Contents,
Pull requests and Actions read/write plus Checks read. Neither identity needs
main or immutable-tag bypass, administration, npm secrets or review approval.

The shared Actions coordinator targets the protected `release` environment.
`@jimhoyd` must approve the job before it receives secrets or performs release
mutations; administrator bypass is disabled and self-review remains enabled for
the sole maintainer. Only `main` and the two release tag patterns are admitted by
the environment. This gate covers Actions-driven releases; a trusted local agent
running the coordinator directly still relies on the same maintainer credentials,
main ruleset and tag rulesets.

## Remaining validation

Keep full supported-OS/Node coverage and archive-install tests green. The actual
publish path, OIDC trust for every package, tag protection, GHCR behavior and
partial-failure recovery must be verified on an authorized release; local tests
and workflow inspection cannot prove them. The release helpers do not alter
historical npm channels, GitHub flags, tags or registry artifacts.

The coordinated `.3` release proved the existing OIDC identities, but exposed
missing-artifact retry behavior tracked in #223. New workflows fail closed or
recover verified durable bytes; old immutable tags retain their original
workflow code. The new promotion path still needs a future explicitly authorized
release rehearsal; implementing it does not publish a new version.
