# Container image promotion (design, issue #233)

Status: design only. Nothing under "Proposed" is implemented. The goal is
supply-chain integrity (the image a release publishes is the image CI tested),
not speed: the sampled CI image build took about 12 seconds, so build caching
is out of scope.

## Current behavior

- `ci.yml` job `container` (a required check) runs
  `docker build -f packaging/container/Dockerfile -t urlcode:test .` and
  smoke-tests it. That image is discarded; no digest is recorded.
- `publish.yml` job `build` packs and attests the npm tarballs, SBOM and pins.
  It builds no image.
- `publish.yml` job `publish`, step 5, runs a fresh `docker build` of the
  release commit with `org.opencontainers.image.revision`/`version` labels and
  pushes `:VERSION` and the channel tag (`:latest` or `:alpha`).
- On a retry, an existing `:VERSION` is accepted after checking only the
  `revision` label. A label is asserted by whoever built the image, so a
  differently built image with the same label passes. Bytes are not compared.
- The channel tag is moved to `:VERSION` on every run; nothing checks that it
  only moves forward.
- A rebuild is not byte-reproducible (it runs `npm ci` and embeds timestamps),
  so the published image is never the image CI tested, even for the same
  commit.

## Proposed path (not implemented)

1. **Build once.** In the `build` job, build the image from the release commit
   (`docker buildx build --output type=oci,dest=release/image.oci.tar` with the
   revision/version labels), run the `container` smoke tests against that
   archive, and let the existing `release/*` attestation cover it.
2. **Promote.** In `publish`, copy the archive to GHCR preserving its manifest
   digest (`skopeo copy` or `crane push` of the OCI layout, not `docker load`
   then `docker push`, which can change digests), and point `:VERSION` and the
   channel tag at that digest. `publish` never runs `docker build`.
3. **Retry identity.** If `:VERSION` exists, resolve its digest with
   `docker buildx imagetools inspect` and require it to equal the attested
   archive's digest; a rebuilt image with matching labels is refused.
4. **Channel monotonicity.** Move the channel tag only when the version it
   currently points at (its `version` label) is not newer.
5. **Attestation.** Optionally attest the pushed digest with `actions/attest`
   `push-to-registry`; its GHCR behavior is unverified.
6. **Self-hosting.** `docker build -f packaging/container/Dockerfile` remains
   the documented way to build from source, and CI's `container` check keeps
   its required name.

## Could not establish

- Whether GHCR preserves the OCI digest through `skopeo`/`crane` from the
  runner, and whether the organization's package settings permit it.
- Image attestation and OIDC behavior for GHCR.
- Whether the OCI archive fits the workflow artifact size limits.
