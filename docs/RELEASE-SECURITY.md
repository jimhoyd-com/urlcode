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
full verification of that exact SHA and CodeQL analysis. Package manifests,
lockfile versions and tag names must agree. Published peer floors must exist and
extension tests must resolve the published packages, not workspace source.
The manual core candidate and tagged core release use the same preparation
script with the digest-pinned Node image from Dockerfile. Locked dependencies,
verification, runtime audit, package installation tests and local drills precede
packing. Build commands in that container receive no GitHub token.

The candidate workflow stores artifacts without publishing. A tagged release
publishes npm only when `PUBLISH_NPM=true` and core images only when
`PUBLISH_CONTAINER=true`. Preparation retains original artifacts for 90 days
before publication so reruns of the same run reuse them. Manual candidates retain
their existing 30-day retention. Keep independent last-good artifacts and
rehearse deployment rollback; Actions retention is not an archival guarantee.

## Identity and provenance

The four per-package workflow filenames are stable npm trusted-publisher
identities. npm publishing uses OIDC, npm 11.5.1 and a supported Node version,
with no long-lived npm token. Renaming a workflow or changing the repository
requires a reviewed registry trust migration. Successful preparation does not
prove the registry-side identity permits direct publication.

`actions/attest` signs the candidate files with GitHub OIDC/Sigstore provenance.
Core includes its package archive, dependency SBOM, build manifest, checksums,
and, for a release, Homebrew formula. Extensions include their archive and
checksums. The core manifest records source SHA, lockfile hash, Node and
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

Alpha versions use npm/GHCR `alpha` and GitHub prerelease classification. New
GitHub releases are not automatically promoted to GitHub `latest`. Mutable npm
and container channels cannot regress to an older version. Existing core image
versions are reused only with matching source labels; unlabeled historical
images require a reviewed migration rather than an inferred identity.

The coordinator creates one package tag at a time and waits for success before
releasing dependents. Shared publication concurrency avoids cross-version races.
The active immutable-tag rule blocks release tag updates/deletions with no
bypass actors; its configuration is in `.github/rulesets/release-tags.json`. No automation needs permission to bypass main checks or approve
its own PR. A repository-scoped GitHub App is the preferred eventual automation
identity; a narrowly scoped fine-grained PAT can support a maintainer script.

## Remaining validation

Keep full supported-OS/Node coverage and archive-install tests green. The actual
publish path, OIDC trust for every package, tag protection, GHCR behavior and
partial-failure recovery must be verified on an authorized release; local tests
and workflow inspection cannot prove them. The release helpers do not alter
historical npm channels, GitHub flags, tags or registry artifacts.
