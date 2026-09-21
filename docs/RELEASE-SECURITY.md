# Candidate and release security

The [development pipeline](DEVELOPMENT-PIPELINE.md) is the release runbook. A
release uses a reviewed commit on `main`, successful verification of that exact
commit, matching manifests/lockfile/tags and CodeQL results. The project does
not bypass protected-branch checks or self-approve pull requests.

Candidates build the package archives once from locked inputs, attest the
result, and retain the evidence before any publisher is allowed to promote it.
Publishers must use those exact verified bytes; a missing or mismatched original
fails closed. `dist/` is built during that process and is never committed.

## Identity, artifacts and recovery

- Package publication uses the repository's reviewed trusted-publisher identity,
  not a long-lived npm token. Workflow/repository identity changes need a
  registry trust review.
- Compare an artifact's provenance, source ref and digest to the intended
  release; an attestation establishes provenance, not safety or reproducibility.
- Declarative extension artifacts additionally bind both catalog and archive
  attestations to the exact `extensions@v*` source ref and refuse self-hosted
  runner attestations. Their immutable tag controls and release-environment
  policy must cover that namespace before the first release; see
  [the artifact runbook](DEVELOPMENT-PIPELINE.md#data-only-extension-artifacts).
- Executable extension bundles bind the catalog and each frozen Node module
  tree to the exact `extension-bundles@v*` source ref and dedicated workflow,
  refuse self-hosted runner attestations, and load only from an explicit
  operator host. Their tag controls and protected release environment must be
  configured before the first release; see [the bundle runbook](DEVELOPMENT-PIPELINE.md#signed-executable-extension-bundles).
- Never move, delete or recreate a release tag to repair a failed release. Ship
  a new version. Existing artifacts are reused only when their identity and
  integrity match exactly.
- Release retries fail closed when the original verified bytes are unavailable.
  Maintain and rehearse an independent rollback path; CI artifact retention is
  not an archival or deployment-recovery guarantee.

Publication is opt-in and does not itself prove registry identity, container
behavior, partial-failure recovery, production security or operational fitness.
Those require an authorized release rehearsal and deployment-specific evidence.
See [release readiness](RELEASE-READINESS.md), [security](../SECURITY.md) and
[operational proof](OPERATIONAL-PROOF.md). Detailed workflow configuration,
dated observations and prior release incidents are private maintainer records.
