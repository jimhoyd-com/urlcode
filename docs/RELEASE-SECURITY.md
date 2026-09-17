# Candidate and release security process

License remains undecided. `package.json` stays private. The workflow described
here produces an **alpha candidate**, not a stable release, npm/Homebrew package,
container registry publication or license grant.

1. Report vulnerabilities privately through [GitHub advisories](https://github.com/jimhoyd-com/urlcode/security/advisories/new).
   The maintainer triages impact, confirms affected exact revisions, coordinates a
   fix/retest privately, and publishes an advisory with upgrade guidance when safe.
   Current reviewed main is the alpha support baseline; no guaranteed SLA/backports.
2. Change dependencies through protected PRs. Review upstream provenance/advisories,
   lockfile integrity and tests. Direct dependencies are exact, npm installs use
   `npm ci`, CI actions use full commit SHAs, and container bases use SHA-256 digests.
   Dependabot proposes updates; it does not authorize merging. Never silently
   refresh dependencies during a candidate build.
3. After protected main checks pass, a maintainer manually dispatches
   `.github/workflows/candidate.yml` **on main**. It reads and validates the digest-pinned Node image directly from Dockerfile,
   installs without lifecycle scripts, verifies, package-tests and runs local drills.
   It packs the runtime and creates a CycloneDX dependency SBOM plus a manifest
   recording source commit, lockfile hash, engine versions and artifact hashes.
4. The pinned official `actions/attest` action signs provenance for the package,
   SBOM and manifest using short-lived GitHub OIDC/Sigstore credentials. No long-lived
   signing key is stored. Signing permissions exist only in this manual job; build
   commands run in a container without passing GitHub tokens. Files are retained as
   GitHub Actions artifacts for 30 days. There is no tag/release/registry publication.
5. Download the candidate for the intended commit and verify **each file**, e.g.
   `gh attestation verify urlcode-0.1.0-alpha.8.tgz --repo jimhoyd-com/urlcode --signer-workflow jimhoyd-com/urlcode/.github/workflows/candidate.yml --source-ref refs/heads/main --source-digest APPROVED_COMMIT_SHA`.
   Check the verified provenance's source commit against the approved commit, and
   compare package/SBOM hashes with the signed manifest. A signature establishes
   provenance, not safety, reproducible bytes or production approval. See
   [GitHub verification](https://cli.github.com/manual/gh_attestation_verify) and
   [the official attestation action](https://github.com/actions/attest).
6. Before any stable release, close independent-review and deployment gates, decide
   the license explicitly, assign patch/release ownership and retention, and approve
   version/support policy. Keep last-good verified artifacts and compatible policies;
   rehearse rollback. Never overwrite a published artifact/version or downgrade a
   management writer past its audit/security baseline.

The SBOM describes npm dependencies; it is not a complete OS/container SBOM. Hosted
runners and action runtimes remain platform-controlled. Digest pins improve supply
chain integrity but do not prove byte-for-byte reproducibility or engine safety.
Signing verification must be demonstrated on a successful main workflow run before
claiming a candidate has been signed. Workflow definition alone is not that evidence.
