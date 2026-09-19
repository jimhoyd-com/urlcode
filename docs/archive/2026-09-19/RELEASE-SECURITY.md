# Historical release process — superseded September 19, 2026

This is the prior process and incident record. Current instructions live in
[release security](../../RELEASE-SECURITY.md). Links below resolve to the current documentation unless otherwise noted.

# Candidate and release security process

URLCode 0.3.0 is the Apache-2.0 self-hosted baseline; licensing is defined
in [LICENSE](../../../LICENSE). Two workflows share one audited build path and differ
only in what they do with its output:

- `candidate.yml` is dispatched manually on main and retains a **signed build
  candidate** for 30 days without publishing it. Use it to review a commit
  before tagging it.
- `release.yml` runs on a `v*` tag whose commit is already on main, and publishes
  a GitHub release. Publication to npm and GHCR is opt-in per repository variable
  (`PUBLISH_NPM`, `PUBLISH_CONTAINER`), so a release can be artifacts-only.

Neither workflow is a statement that a release is production-ready; see
[release readiness](../../RELEASE-READINESS.md).

## Publishing an alpha

An alpha such as `0.4.0-alpha.1` follows the same path: tag `v0.4.0-alpha.1`
on a commit that is already on main. The release workflow publishes to npm
only when the repository variable `PUBLISH_NPM` is `true` and the npm trusted
publisher for this repository and `release.yml` exists; otherwise the run is
artifacts-only (a GitHub release with the signed tarball). Publish order is
core → ui → auth → admin, because the extension packages declare
`@jimhoyd/urlcode >=0.4.0-alpha.1 <0.5.0` and must resolve the core alpha.

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
   them to the GitHub release, and publishes to npm and to GHCR when those
   repository variables are enabled.

   **npm publication holds no credential.** The registry is configured with a
   trusted publisher naming this repository and `release.yml`, so the publish
   step exchanges the job's OIDC identity for a credential that lives for the
   length of one publish. There is no npm token in the repository's secrets to
   leak, revoke or rotate, and a fork or another workflow cannot publish under
   this package's name. Provenance is generated on that same identity, so
   `--provenance` is not passed and its absence is not a downgrade.

   A bearer token would silently take precedence over this exchange, so the
   publish step must reference none; `test/release.test.ts` fails if one
   reappears in it, and checks the npm and Node floors below which the exchange
   is not attempted at all.
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
claiming a candidate has been signed. Workflow definition alone is not that evidence.
`release.yml` ran successfully for the first time publishing `v0.4.0-alpha.1`
(2026-09-18), after the fixes below; treat any repository whose workflow has not
had a real successful tagged run the same way this one was treated before that.

## What broke on every first release, and why

Four repositories (core, ui, auth, admin) each cut their first tagged release in
the same session. Every one hit a subset of the same bugs, because each
`release.yml` was written and reviewed but never actually run end-to-end against
a real tag before. None of this is repository-specific; check for all of it
before trusting an unexercised release workflow:

- **`npm ci` on the bare runner's root-owned npm.** A build that runs entirely
  inside a pinned Docker image never calls `actions/setup-node`, so a later
  `npm install --global npm@11.5.1` (needed for the trusted-publishing floor)
  hits the runner's preinstalled, root-owned npm and fails `EACCES`. Add
  `actions/setup-node` before any step that installs global npm packages, even
  if the main build never touches the runner's own Node.
- **The floor check must run after the pin, not before.** A guard asserting
  "npm ≥ 11.5.1" is useless directly after `setup-node` with `node-version: '22'`,
  which bundles npm ~10.9.x — it can never pass. The floor only means something
  once the publish step's own `npm install --global npm@11.5.1` has actually run.
- **`npm publish` refuses an unqualified prerelease.** `You must specify a tag
  using --tag when publishing a prerelease version.` npm's safety default is
  `latest`; a prerelease must derive an explicit dist-tag from its version
  (`0.1.0-alpha.1` → `alpha`, anything without a `-` → `latest`) and pass
  `--tag`. This path is only exercised by a package's *first* prerelease, so it
  silently sat broken in every repository until each hit it for the first time.
- **`npm pack --pack-destination candidate` needs `candidate/` to exist first.**
  npm does not create the destination directory; `mkdir -p candidate` first.
- **A private repository's unauthenticated `git fetch origin main` cannot work.**
  If checkout uses `persist-credentials: false` (correct, for a step that
  should not need write access) and the repo is private, `git fetch` fails
  `could not read Username for 'https://github.com'` before ever reaching the
  version check. Compare the tag against main through the GitHub API instead
  (`gh api repos/OWNER/REPO/compare/main...SHA --jq .status`, expecting
  `identical` or `behind`) — it needs no credentials and stays read-only. Public
  repositories can keep the plain fetch; it works there.
- **`--conditions=development` in `npm run verify`'s test script resolves peers
  to source that a real npm install never ships.** The regular CI job symlinks
  sibling checkouts in place of `node_modules`, so `./src/*.ts` exists and the
  flag is correct there. A release installs real published tarballs of its
  peers, which only ever ship `dist/`, so the same flag makes every import of a
  peer fail `ERR_MODULE_NOT_FOUND`. Drop the flag for the release-workflow test
  invocation specifically (run `node scripts/check-sqlite.mjs` explicitly first,
  since bypassing `npm test` skips that pretest hook), and audit any test file
  that separately hardcodes the flag in a spawned child process — it has to be
  fixed the same way, independently, wherever it appears.
- **A peer-install command with the wrong flag combination is a silent no-op.**
  `npm install --no-save --no-package-lock --ignore-scripts --legacy-peer-deps
  <peer>@<version>` installed *nothing*, with no error, when the target package
  names already appear in `peerDependencies` — `npm ci` earlier reports "added N
  packages" as if it worked. Confirm the install actually happened
  (`ls node_modules/@scope/*/package.json` and print each version) rather than
  trusting the exit code; `--no-save --ignore-scripts <specs>` (no
  `--no-package-lock`, no `--legacy-peer-deps`) is the version that works, paired
  with `git diff --exit-code -- package.json package-lock.json` to prove nothing
  was recorded as a dependency.
- **A version published from an unbuilt checkout is burned forever.** npm never
  allows a version to be replaced. `@jimhoyd/urlcode-auth@0.1.0-alpha.1` reached
  the registry from something other than the CI workflow (a manual `npm
  publish` run before `npm run build` had produced `dist/`), so the published
  tarball contained only metadata files and no code. Every consumer's typecheck
  failed with `Cannot find module '@jimhoyd/urlcode-auth'` — a real, correct
  failure, not a bug in the consumer. The only fix is bumping to a new version
  and publishing that instead; nothing can repair or unpublish the bad one.
  **Never run `npm publish` by hand outside the release workflow** — the
  workflow is the only place that reliably builds before packing.
- **`ENEEDAUTH` on `npm publish` under trusted publishing usually means the
  registry-side configuration doesn't exist or doesn't permit direct publish
  yet**, not a workflow bug. Trusted publishing needs an entry under the
  package's npm settings ("Trusted Publisher") naming the exact GitHub
  org/repo and workflow filename, with no environment set unless the workflow
  declares one; recent npm UI changes default new configurations to
  "stage publish" only; "allow npm publish" (direct publish, which is what
  this project's workflows do) must be explicitly enabled too. A wrong
  org/repo/workflow match tends to surface as a 404, not `ENEEDAUTH`;
  `ENEEDAUTH` is the signature of no matching configuration existing at all.
- **Publish order matters and is easy to get backwards.** Extension packages
  declare `@jimhoyd/urlcode >=X <Y` as a peer range; publish core before ui,
  auth or admin, or their own release-workflow peer-install step has nothing
  real to resolve against.

None of the above is exotic; all nine bugs were found by actually running each
workflow against a real tag, one release at a time, and reading the actual
failure rather than guessing from the workflow source. Treat "the workflow file
looks right" and "the workflow has actually published successfully once" as two
different, unrelated claims.
