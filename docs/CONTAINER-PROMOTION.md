# Container image promotion (design, issue #233)

Status: design only. Nothing described under "Proposed" is implemented, and no
workflow was changed. An earlier inert helper (`scripts/release-image.ts` and
its unit tests) pinned the invariants below in code without being wired into
any workflow; it was removed as unused surface (#569) and would need to be
rebuilt as part of a first implementation. This does not authorize enabling
`PUBLISH_CONTAINER`, publishing, or changing any existing tag. The point is
supply-chain integrity (tested bytes are shipped bytes), not speed: the sampled
CI image build took about 12 seconds, so build caching is deliberately out of scope.

## Current behavior (read from the workflows at 67a6996)

- `ci.yml` job `container` (a required check) runs `docker build -f packaging/container/Dockerfile -t urlcode:test .`
  and smoke-tests it. That image is discarded; no digest is recorded.
- `candidate.yml` builds and signs the npm archives, SBOM and manifests. It builds no
  image. `manifest.json` and the exact-file-set check in `validateCandidate` know nothing
  about images.
- `release.yml`, only when `vars.PUBLISH_CONTAINER == 'true'`, runs a fresh
  `docker build` of the tagged commit with `revision`/`version` labels and pushes
  `:VERSION` and the channel tag.
- On retry, if `:VERSION` already exists it is accepted after checking only the
  `revision` label. A label is asserted by whoever built the image, so a differently
  built image with the same label passes. Bytes are not compared.
- Channel monotonicity is enforced by reading the `version` label of the existing
  channel tag (semver `gte`). That guard is sound and should be kept.
- A rebuild is not byte-reproducible (it runs `npm ci`, embeds timestamps), so the image
  the release publishes is never the image CI tested, even for the same commit.

Not verified: live GHCR contents, package visibility/permissions, whether
`PUBLISH_CONTAINER` is set, and whether any image was ever pushed.

## Proposed path (not implemented)

1. Candidate build. In `candidate.yml`, build the image once from the exact commit
   (`docker buildx build --output type=oci,dest=candidate/image.oci.tar` with the
   revision/version labels), run the same three smoke tests as `ci.yml` against that
   archive, and record `image: { digest, sourceCommit, version }` in `manifest.json`.
   Add `image.oci.tar` to the attested subjects so the existing `attestation verify` and
   the manifest SHA-256 pinned in the annotated tag cover the image as well.
2. Manifest schema. Add the archive to the expected file set in `validateCandidate`
   and validate the record with a `candidateImage()`-shaped check (reintroduced with
   this implementation; the prior inert helper was removed as unused, see above).
   Because the tag pins the manifest hash, the digest is immutable once tagged.
3. Promotion. `release.yml` verifies the bundle (already done by `restore`), then copies
   the archive to the registry preserving the manifest digest (`skopeo copy` or
   `crane push` of the OCI layout; not `docker load` then `docker push`, which can
   change digests under some storage drivers) and pushes `:VERSION` and the channel tag
   as pointers to that digest. It never runs `docker build`.
4. Retry identity. If `:VERSION` exists, resolve its digest with
   `docker buildx imagetools inspect` and require `assertPromotedImage()` to pass. A
   rebuilt image with matching labels but different bytes is refused. Channel tags keep
   the existing `assertChannel` check via `assertImageChannel()`.
5. Attestation. Optionally attest the image digest with `actions/attest` using
   `push-to-registry`; this needs `packages: write` and its GHCR behavior is unverified.
6. Self-hosting. `packaging/container/Dockerfile` and `docker build -f packaging/container/Dockerfile` remain the documented way to build
   from source. CI's `container` check stays as is to preserve the required check name.

## Could not establish

- Whether GHCR preserves the OCI digest through `skopeo`/`crane` from the runner, and
  whether the org's package settings permit it.
- Behavior of image attestation and OIDC for GHCR.
- Whether a candidate-built OCI archive fits comfortably within the artifact size and
  90-day retention model; recovery from GitHub release assets would need the archive
  attached there too.
- Any real run: none was dispatched.

A first implementation should be a separate reviewed PR that lands the candidate-side
build behind an operator-controlled input, and leaves the publisher change until one
candidate has been produced and inspected.
