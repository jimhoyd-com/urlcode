# Candidate and release security process

URLCode 0.3.0 is the Apache-2.0 self-hosted baseline; licensing is defined
in [LICENSE](../LICENSE). Two workflows share one audited build path and differ
only in what they do with its output:

- `candidate.yml` is dispatched manually on main and retains a **signed build
  candidate** for 30 days without publishing it. Use it to review a commit
  before tagging it.
- `release.yml` runs on a `v*` tag whose commit is already on main, and publishes
  a GitHub release. Publication to npm and GHCR is opt-in per repository variable
  (`PUBLISH_NPM`, `PUBLISH_CONTAINER`), so a release can be artifacts-only.

Neither workflow is a statement that a release is production-ready; see
[release readiness](RELEASE-READINESS.md).

1. Report vulnerabilities privately through [GitHub advisories](https://github.com/jimhoyd-com/urlcode/security/advisories/new).
   The maintainer triages impact, confirms affected exact revisions, coordinates a
   fix/retest privately, and publishes an advisory with upgrade guidance when safe.
   Current reviewed main is the security support baseline; no guaranteed SLA/backports.
2. Change dependencies through protected PRs. Review upstream provenance/advisories,
   lockfile integrity and tests. Direct dependencies are exact, npm installs use
   `npm ci`, CI actions use full commit SHAs, and container bases use SHA-256 digests.
   Dependabot proposes updates; it does not authorize merging. Never silently
   refresh dependencies during a candidate build.
3. After protected main checks pass, a maintainer manually dispatches
   `.github/workflows/candidate.yml` **on main**, or pushes a `v<version>` tag to
   run `.github/workflows/release.yml`. The release workflow refuses a tag whose
   commit is not an ancestor of main, refuses a tag that disagrees with
   `package.json`, and refuses to build a private or unlicensed package. It reads and validates the digest-pinned Node image directly from Dockerfile,
   installs without lifecycle scripts, verifies, package-tests and runs local drills.
   It packs the runtime and creates a CycloneDX dependency SBOM plus a manifest
   recording source commit, lockfile hash, engine versions and artifact hashes.
   The package contains `dist/`, produced inside that build from the tagged
   TypeScript sources by Node's type stripping (`scripts/build.ts`); `dist` is
   never committed. The manifest records the Node version that stripped it, the
   locked TypeScript version and a SHA-256 per emitted file
   (`dist/BUILD-MANIFEST.json`), so a download can be verified by running
   `npm run build` on the tagged commit with that Node version and comparing its
   `dist/` file by file. The build strips types and rewrites specifier
   extensions; it never bundles, minifies or transforms syntax, so every line of
   `dist/x.js` is the corresponding line of `src/x.ts`. CI's `build-fidelity`
   job builds twice and diffs the trees, so the transform is known to be
   deterministic before a tag is cut.
4. The pinned official `actions/attest` action signs provenance for the package,
   SBOM and manifest using short-lived GitHub OIDC/Sigstore credentials. No long-lived
   signing key is stored. Signing permissions exist only in this manual job; build
   commands run in a container without passing GitHub tokens. Candidate files are
   retained as GitHub Actions artifacts for 30 days. A release additionally attaches
   them to the GitHub release, and publishes to npm with `--provenance` and to GHCR
   when those repository variables are enabled.
5. Download the candidate for the intended commit and verify **each file**, e.g.
   `gh attestation verify jimhoyd-urlcode-0.3.0.tgz --repo jimhoyd-com/urlcode --signer-workflow jimhoyd-com/urlcode/.github/workflows/candidate.yml --source-ref refs/heads/main --source-digest APPROVED_COMMIT_SHA`
   (use `release.yml` as the signer workflow for a tagged release).
   Check the verified provenance's source commit against the approved commit, and
   compare package/SBOM hashes with the signed manifest. A signature establishes
   provenance, not safety, reproducible bytes or production approval. See
   [GitHub verification](https://cli.github.com/manual/gh_attestation_verify) and
   [the official attestation action](https://github.com/actions/attest).
6. Before registry publication, assign patch/release ownership and retention, and
   document version/support policy. Before claiming hostile multi-tenant or
   deployment-specific readiness, close independent-review and deployment gates. Keep last-good verified artifacts and compatible policies;
   rehearse rollback. Never overwrite a published artifact/version or downgrade a
   management writer past its audit/security baseline.

The SBOM describes npm dependencies; it is not a complete OS/container SBOM. Hosted
runners and action runtimes remain platform-controlled. Digest pins improve supply
chain integrity but do not prove byte-for-byte reproducibility or engine safety.
Signing verification must be demonstrated on a successful main workflow run before
claiming a candidate has been signed. Workflow definition alone is not that evidence:
`release.yml` has never been executed, so no release has yet been produced or signed
by it, and the npm and GHCR publication paths are unproven until a real tag runs.
