# Development and release pipeline

The repository uses npm workspaces, independent package versions, and Changesets
for UI, auth and admin. Core source lives in `packages/core/src`, while the
repository root remains the published core package and is explicitly included
in the shared release inventory.

Repository automation is indexed in [`scripts/README.md`](../scripts/README.md).
Established script filenames remain stable because workflows, tests, release
helpers and operator documentation call them directly; new standalone scripts
belong under their logical `scripts/` area when that improves cohesion.

## Pull requests and main pushes

Every PR and every push to main starts `verify`. A complete Git diff selects one
of two lanes:

- **Prose:** root project Markdown, `docs/**/*.md`, `llms.txt`, `llms-full.txt`
  and each
  package's `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `GOVERNANCE.md` run
  guidance/generated-resource checks, runtime audit, and the required container
  job. CodeQL retains its repository policy.
- **Full:** all other changes, mixed changes, and empty, unclassifiable or
  unavailable diffs run static checks once and core and workspace suites
  separately. Both suites retain Linux on Node 22/24/26. Main adds
  Windows/macOS on Node 24. PRs add those platform legs for runtime, CLI,
  SQLite, fixture, dependency, workflow and unknown changes; known UI
  presentation-only changes omit them. Package, action, cookbook,
  reproducibility and operational checks retain their coverage.
  The `build-fidelity` job also runs `scripts/pack-sources.mjs` at the
  checked-out commit (offline, output outside the checkout) and asserts all five
  archives and the source manifest exist, so the operator reproducible-build path
  cannot break unnoticed; it adds about ten seconds to an existing job.

A pull request is classified against its merge base; a push to main is
classified tip to tip from the event's `before`/`after` SHAs, so a force-push or
rewritten history is measured by what actually moved. Classification fails
closed: a missing, malformed or all-zero SHA (branch creation or deletion), and
history this checkout cannot read, select full verification. Scheduled and
manually dispatched runs are never classified from paths at all, so exact-SHA
release coverage cannot silently become a docs-only run.

The prose allowlist is deliberately narrow, and it is a list of reviewed,
non-executable contributor prose rather than "every Markdown file". Skills,
starters, recipes, examples, schemas, manifests, workflows, and any package
document that ships inside
a published tarball or is read by an agent surface (`README.md`, `SECURITY.md`,
`CONTRACT.md`, `THREAT-MODEL.md`, `IMPLEMENTATION-STATUS.md`, `AGENTS.md`,
`CHANGELOG.md`) select full checks. Anything feeding a generator stays in the
code lane. A rename from source into docs also selects full checks, because the
diff is read without rename detection and shows both paths. Every prose path is
still covered by the always-run `docs` job, which walks all authored Markdown.
No required workflow uses `paths-ignore`.

The `workspace-integration` job's Linux Node 24 leg also runs `npm run test:browser
--workspace @jimhoyd/urlcode-ui` ([#332](https://github.com/jimhoyd-com/urlcode/issues/332)),
a real-browser check of the CRUD screen (edit text, focus and caret surviving a
re-render, checkbox rollback after a failed PATCH, hostile record markup shown
as text, no CSP violation). It drives the Chrome preinstalled on the runner image
over the DevTools protocol with Node's built-in WebSocket, so it adds no action,
download or dependency, and it is a step in an existing job, not a new required
check. Locally it runs against any installed Chrome or Chromium (`CHROME_BIN`
overrides discovery) and skips without one; CI sets `URLCODE_REQUIRE_BROWSER=1`
so a missing browser fails instead. It is not part of `npm test`. Firefox,
Safari and Windows/macOS browsers remain unverified.

The always-run `docs` job runs `npm run check:docs`; in the full lane the
`static` job runs `npm run check:code`, which is the rest of `npm run check`.
The two together are exactly `npm run check`, which stays complete for local
use. This removes a duplicated dependency install plus seven repeated checks on
the same commit, not meaningful wall time: the sampled documentation checking
was about two seconds. Lane selection and the `verify-complete` gate are
unchanged. The `verify` matrix jobs now carry a shard number, for example
`verify (ubuntu-latest, 24, 1)`, and package smoke runs in a separate `checks`
job per leg; only `verify-complete` and `container` are required checks.
`verify --workspace <pkg>` for the five extension packages (ui, auth, admin,
store, forms) runs one package per `workspace-verify` job instead of serially
in one job: `auth`'s own SQLite-backed suite alone was over half of the
several-minute serial windows-latest run. `workspace-integration` then rebuilds
the four consumed packages and runs the publish audit and the workspace
integration suite once per leg, after every `workspace-verify` job for that
plan has completed.

`verify-complete` accepts only the results specified by the successful plan.
Failed, canceled, missing or unexpectedly skipped work fails the gate. Required
check names (`verify-complete`, `container`) and CodeQL enforcement are preserved.
The repository ruleset currently does not require a branch to be up to date;
release publication separately requires verification of the exact main commit.

```sh
npm run check:docs                 # prose checks without the runtime suite
npm run check:code                 # everything in `check` except the prose checks
npm run ci:plan -- BASE_SHA HEAD_SHA # previews as a pull request outside Actions
npm run ci:report -- RUN_ID         # read GitHub job/step durations
npm run ci:history -- 100 2026-09-19 # group historical timing samples
npm run verify                    # full local validation remains available
npm run test:package              # builds and installs a real archive
```

CI uses `test:package:built` only after building in that same job. Core tests and
workspace tests run in separate jobs to shorten their serial critical path;
this increases job setup overhead and needs monitoring for runner queue pressure.
After rebuilding the four extensions it needs, `workspace-integration` also runs
the real `init --with ui,auth,admin` scaffold integration. Missing workspace
outputs fail instead of silently skipping an absent external checkout.
Issue #185 contains the current decision and sample sizes. Dated CI timing
measurements and retrospective review notes are maintained privately; they do
not replace this operational runbook.

### Release package boundary

Release archives contain installed behavior and the smallest set of resources
that behavior consumes. Core includes built JavaScript and declarations,
schemas, policy data, starters, runnable examples, recipes, agent skills and the
two `llms` documents. Extension archives include their built output, README,
license, security policy and required third-party notices. Repository history,
plans, audits, contributor instructions, release records, source, tests and
package-specific design/status documents stay in the source repository.
`llms-full.txt` is the single offline documentation bundle; the authored
`docs/` tree is not duplicated into the npm archive.

`npm run audit:packages` discovers core and every publishable workspace under
`packages/`, then runs `npm pack --dry-run` without package hooks and enforces
this boundary. A new extension fails until its reviewed policy is added. The
audit rejects unexpected top-level
paths, source/tests/maps/environment files, missing export or executable
targets, and archives over the reviewed compressed, unpacked or file-count
budgets. `test:package:built` applies it to core before installing the actual
archive. Every extension release applies the same check to its selected
workspace immediately before packing. Increase a budget only with a reviewed
explanation of the new installed requirement; do not use budget headroom as a
substitute for updating the allowlist.

## Version preparation and release ownership

Core remains at the repository root. Independent extension versions remain
supported; a coordinated version is an explicit maintainer choice, not a
permanent fixed-version policy. An explicitly selected stable version exits
Changesets alpha pre-mode when no package remains on alpha; subsequent stable
patches stay out of pre-mode. Feature PRs record workspace release intent in
Changesets; core release notes remain an explicit maintainer responsibility.

`release:check` checks manifest/lock versions and peer ranges, CLI and MCP
versions, generated plugin metadata, local peer compatibility, and channel policy.
The preparation helper updates these together, adds release notes and extension
changelogs, and records the version decision. Pending Changesets must be
explicitly consumed; they are archived under `.changeset/pre/` and their summaries
included in the release notes. Review the resulting diff and peer minimums.

### Current-version references in documentation

When reader-facing Markdown must name the current core version, wrap the
smallest complete paragraph or fenced example containing it with
`urlcode-current-version:start` and `urlcode-current-version:end` HTML comments.
Write both comments using ordinary Markdown HTML-comment syntax on their own
lines. Release preparation discovers these markers in every tracked Markdown
file and both `llms` indexes, so a newly added guide needs no central file-list
update. It replaces the old core version only inside marked blocks. Generated
`llms-full.txt` preserves the source markers and advances in the same release
edit, keeping it byte-aligned with its sources.

`release:check` fails when the markers are unbalanced, a marked block does not
contain the manifest's current core version, or a live Markdown file mentions
that current version outside a marker. Add markers in the same pull request as
a new current-version reference. Leave historical release documents,
Changeset archives, changelogs and archived plans unmarked; the scanner excludes
those records so later releases do not rewrite history.

<!-- urlcode-current-version:start -->
```sh
# Example only: choose the next intended version before executing.
npm run release:prepare -- --version 0.5.8 --consume-changesets
# Apply local edits on a clean non-main branch; no remote writes or publication:
npm run release:prepare -- --version 0.5.8 --consume-changesets --execute
```
<!-- urlcode-current-version:end -->

An optional `--notes PATH` adds reviewed maintainer notes. Dry runs do not change
files. Preparation rejects downgrades, reused local tags, dirty checkouts and
stale plans. A stable target removes `.changeset/pre.json` once no package
remains on alpha, publishes to npm `latest`, and leaves the historical `alpha`
pointer unchanged. Alpha targets
require existing alpha mode; the helper never silently re-enters prerelease mode.
It does not invoke a permanent Changesets fixed-version policy.

## GitHub Actions release buttons

The Actions page releases core through the protected core release workflow. It
creates a release PR, waits for normal required checks, merges without bypass,
runs the exact-commit full matrix and signed candidate, publishes the immutable
core tag, checks registry installability, updates Homebrew and verifies the
standalone starter. The first-party executable extension release is separate:
after the reviewed source commit is available, create one immutable
`extension-bundles@v…` tag. Its dedicated workflow builds, attests and publishes
the UI, auth, admin and store bundles to GitHub Releases. It does not publish
extension npm packages.

The release environment protects both core and bundle publication. GitHub holds
the job, including its repository secrets, until `@jimhoyd` approves the
deployment; administrators cannot bypass this gate. Self-review remains enabled
because the project currently has one maintainer. The environment admits only
`main` and the release tag patterns `v*` and `extension-bundles@v*`. Local
agents using the maintainer's authenticated identity may dispatch, approve and
resume this workflow, but an untrusted GitHub account cannot.

Configure `RELEASE_AUTOMATION_TOKEN` as a repository Actions secret. Prefer a
repository-scoped GitHub App token when available. A fine-grained PAT is also
supported when it is limited to `urlcode` and `urlcode-template` with Contents,
Pull requests and Actions read/write. The repositories are public, so the
coordinator can inspect their check runs without an additional token
permission. The token owner needs ordinary write access. Do not grant ruleset
bypass on main or immutable tags, administration, PR approval or package-registry
credentials; the maintainer identity is the sole bypass actor on the separate
release-tag-creation rule so the coordinator can create a new version tag. npm
publishers continue to use their workflow OIDC identities. Dispatch from
`main`.

### Signed declarative artifact releases

Data-only artifact sources live under `artifacts/`; generated catalogs and
archives do not. Before proposing an artifact tag, build the exact inputs in a
new empty directory and review the catalog and archive inventory:

```sh
npm run artifacts:prepare -- --tag extensions@v1.0.0 --commit "$(git rev-parse HEAD)" --output /tmp/urlcode-extension-artifacts
tar -tzf /tmp/urlcode-extension-artifacts/store-schema-1.0.0.tgz
```

The `publish extension artifacts` workflow runs only for the disjoint
`extensions@v*` tag namespace. It requires the tagged commit to be on protected
`main`, builds deterministic gzip/tar assets from the reviewed source data in a
runner-temporary directory, inserts `GITHUB_SHA` into the generated catalog,
rechecks every digest and the declarative-only member allowlist, then attests and
publishes the generated files through the protected `release` environment. The
catalog is generated after checkout: a committed catalog cannot safely contain
the hash of the commit that contains it.

Creating or pushing an artifact tag is a publication decision. Configure the
release environment and immutable-tag rules to admit `extensions@v*` before the
first run, and do not reuse or move a published tag. A green workflow proves the
scoped build and attestation path, not independent security review or that an
executable npm extension can be retired.

### Signed executable extension bundles

Executable first-party bundles are built from the same reviewed source commit,
but are deliberately separate from data-only artifacts. Before proposing a
bundle tag, use a clean checkout and inspect the frozen module inventory:

```sh
npm run bundles:prepare -- --tag extension-bundles@v1.0.0 --commit "$(git rev-parse HEAD)" --output /tmp/urlcode-extension-bundles
tar -tzf /tmp/urlcode-extension-bundles/store-*.tgz
```

The `publish extension bundles` workflow runs for an
`extension-bundles@v*` tag, or can be dispatched from the Actions page with a
new version while `main` is selected. A manual dispatch creates that immutable
tag at the selected `main` commit only after the protected `release` environment
is approved. It builds exact-commit package inputs, installs their locked
production dependency closure only in the release runner, rejects links and
special files, emits deterministic USTAR/gzip archives, verifies every catalog
digest and member path, then attests and publishes the catalog and each bundle.
The consumer never uses npm to install these assets; it verifies the exact tag
attestation before loading a locked entry from an explicit operator host.

Creating or pushing a bundle tag is a publication decision. Immutable tag
controls for `extension-bundles@v*` and the protected release environment cover
this workflow. To release from GitHub Actions, choose **publish extension
bundles**, select `main`, click **Run workflow**, and enter a new version such
as `0.5.2`; then approve the release environment. Do not reuse a published tag.
The signed bundle consumer flow is the supported distribution for first-party
executable extensions; keep the fresh composed consumer evidence with the
release record. This scoped build does not prove an independent security review.

## One-command local release and resume

A package that has never been on npm cannot use this path for its first
version: see [publishing a new package for the first time](FIRST-NPM-PUBLISH.md).

Inspect without writing:

<!-- urlcode-current-version:start -->
```sh
npm run release:status  # registry channels, peer compatibility, tag SHAs
npm run release:plan    # manifest-derived inventory
npm run release:run     # ordered states at this checkout: pending/resume/unchanged
npm run release:run -- --version 0.5.8 --consume-changesets
npm run release:run -- --version 0.5.8 --package auth --consume-changesets
```

For an explicitly authorized coordinated release:

```sh
npm run release:run -- --version 0.5.8 --consume-changesets --execute
npm run release:run -- --version 0.5.8 --package auth --consume-changesets --execute
```
<!-- urlcode-current-version:end -->

`--execute` authorizes the entire sequence: create the release branch/PR, wait
for checks and merge, run the release gates, create version tags, publish, verify
an installed consumer, and create/check/merge the starter update. It never
approves a review or bypasses a required check. A required human review still
blocks merging. No write or publication occurs without `--execute`.

The coordinator works in a temporary clone and prints its location. It prepares
`codex/release-VERSION`, or resumes the existing PR/branch after checking its
versions and receipt. It checks out the actual merged SHA and reinstalls that
commit's locked dependencies. Repeating the command discovers existing PRs,
gates, tags and workflow state rather than creating another version. Temporary
release clones are retained for diagnosis and can be removed after completion.

For an independently prepared release PR already merged to main, use a clean
checkout of its exact commit:

```sh
npm run release:run -- --execute
```

The coordinator creates `codex/release-validation/SHA` at the already-merged
commit when gates are missing. An existing validation branch must name that
exact SHA; it is never moved. This lets main advance without changing the release
being tested. The branches remain as audit/resume references. It dispatches full
`ci.yml` and `candidate.yml`, reuses existing successful runs, and waits for
running ones. A failed gate stops with its run ID; diagnose it and rerun that
exact run before resuming. Compact PR/main checks cannot replace the full
OS/Node matrix or CodeQL on the selected commit.

Before creating any version tags, it downloads and verifies the candidate bundle.
A green run with missing artifacts does not authorize tags. New version tags are
annotated with the source commit, chosen candidate run ID and the SHA256 of its
signed manifest. The manifest binds every package and supporting asset by hash. Every package in a
resumed train must select that same candidate. Neither a later candidate of the
same source nor a newer main commit can silently replace the chosen bytes.
A successful rerun of the same candidate ID cannot substitute a changed bundle: its
manifest must still match the immutable checksum in the release tag.
After tags exist, rerun package publishers rather than the pinned candidate run.
If a later attempt of that candidate run fails, the coordinator stops even when
an earlier attempt succeeded; it does not infer which attempt should be trusted.

Publication is sequential: core → UI → auth → admin, skipping unchanged published
versions. Each publisher must succeed and its version must be readable through
npm's abbreviated install metadata, with a downloadable SHA512-verified tarball,
before dependents begin. Bounded retries handle propagation, transport failures,
429 and server errors; authentication and integrity failures stop immediately.
Afterward, an external consumer with a fresh npm cache installs the four exact
registry versions, checks its peer tree and imports, and generates the combined
extension scaffold in dependency order (`ui,auth,admin`). The candidate archive
smoke uses the same scaffold check before any package is published.

The standalone starter helper updates the exact core pin, lockfile and matching
schema/docs links, then copies the initializer's application files, generated
agent guide, skills and local MCP registration from the installed published core
package. The committed generated-file manifest also removes app files deleted
from the initializer. Template-owned packaging, CI and onboarding files remain
untouched. It then runs validation/tests/audit/benchmark,
and opens a resumable PR. The coordinator waits for checks and merges it, checking
for a newer template pin immediately before merge. `--skip-template` explicitly
leaves this follow-up to the maintainer. To run only that follow-up:

<!-- urlcode-current-version:start -->
```sh
npm run release:template -- --version 0.5.8 --execute
```
<!-- urlcode-current-version:end -->

That standalone helper opens a PR but does not merge it. All helpers stop on
errors; rerun after diagnosis. A failed publisher is retried at most once per
coordinator invocation and must pass the original-byte recovery checks below.

The maintainer identity needs repository Contents, Actions and Pull requests
write, plus Checks read, on the affected repositories. GitHub App installations
should be scoped to URLCode and its template. No ruleset bypass or long-lived
npm token is needed. The workflow `GITHUB_TOKEN` must not create the triggering
version tags because its push events do not start ordinary push workflows.
[GitHub App guidance](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app)

## Build once, publish verified bytes

The core release coordinator builds and verifies the exact core archive in the
digest-pinned environment, including its isolated consumer proof. The executable
extension publisher is separate: its immutable `extension-bundles@v…` tag builds
the five workspace sources (`ui`, `auth`, `admin`, `store`, `forms`) from that
exact commit, checks the bounded archives
and catalog digests, and attests the resulting GitHub Release assets. The bundle
catalog binds the source commit, compatible core version, archive names and
checksums; the consumer verifies that record before loading a locked extension.

For a core npm release, the publisher then copies the candidate's measured
`urlcode.rb` into `jimhoyd-com/homebrew-urlcode` before it creates the GitHub
release. Store a fine-grained `HOMEBREW_TAP_TOKEN` secret in this repository
with Contents read/write permission only for that tap. Missing credentials or a
rejected push fail the core release. Extension-bundle publishing does not need
the Homebrew credential.

Core's GitHub Release stores its signed archive and release receipt. The
extension GitHub Release stores its attested catalog and bundle archives.
Candidate and release Actions artifacts retain 90 days; retention is not an
archival guarantee. Keep independent last-good copies for deployment rollback.

## Release rehearsal

Several release attempts failed at steps that ordinary CI never runs: git
refused the candidate container's foreign-owned checkout, the tag publisher's
peer-floor preflight held core to a floor, and a release commit had no git
identity on a runner (#365). Two cheap guards now reach those steps.

`test/release-rehearsal.test.ts` runs in `npm test`, so it is part of the
existing `verify` job on every leg, with no new job, no change to the required
checks in `scripts/ci-plan.ts` and about a second of test time. Run it alone with
`npm run rehearse:release`. It covers:

- **Foreign owner.** The git-touching check scripts (the tracked-NUL scan,
  `release:check`, the release-tag and workspace-link checks) run with
  `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`, which makes git treat the checkout as
  owned by someone else, as it is in the container. A control asserts the
  variable still makes plain git refuse the checkout. `npm run check` itself is
  not repeated, because the scan is its only git use and it takes about half a
  minute.
- **No git identity.** The release scripts commit through `releaseIdentity`
  (`scripts/release-identity.ts`), and a static check fails a `commit -m` that does
  not. A behavioural check commits in a repository with an empty home, no global
  or system config and no author or committer environment, after proving that a
  plain commit there fails.
- **Publisher peer-floor preflight.** For every directory in the release
  inventory the test calls `assertPeerFloorCoversApi` with the real manifests. Between
  releases the extensions' core floors are legitimately below the API they use
  until `release:prepare` raises them, so it checks the state `release:prepare`
  would leave (`raisedCorePeer`), and core must pass with no floor. When the
  checked-out commit is a `Prepare release` commit, as on main just before the
  tags, the actual manifests are checked unadjusted.

The manual `release rehearsal` workflow (`release-rehearsal.yml`, `workflow_dispatch`
only, read-only token) runs that test and then `scripts/prepare-core-release.sh`
with the candidate channel, the same container steps as `signed build candidate`.
It does not sign, retain an artifact, tag or publish, and any ref may be
dispatched. A run takes about as long as a candidate run (roughly ten minutes of
one Linux runner) and only happens when someone starts it, for example after
changing `scripts/`, `packaging/container/Dockerfile` or the release workflows.

What it cannot cover: the registry, GitHub API and attestation steps (candidate
source, `validateMain`, npm and tap publication, release notes), the
protected `release` environment and tokens, a runner's real user and hostname,
timing that only fails on a slow runner, and a check that runs only when the
release tag exists. Those still surface first in a real release attempt.

## Recovery, immutable tags and channels

A retry restores the original retained bundle, or recovers the complete verified
bundle from that package's GitHub release. Missing, incomplete or unverifiable
originals stop the retry. It never rebuilds archives or substitutes a new
candidate. If publication stopped before a complete durable release existed and
the retained artifact is gone, a new version may be required.

Existing npm versions must match SHA512 integrity; existing GitHub assets must
match byte for byte. Partial npm/GitHub/GHCR success is possible and cannot be
made atomic. Fix registry identity/settings where appropriate and resume the
original run. A source change requires a new version and tag. Never delete,
recreate, move or force-push version tags.

A version published by hand has no tag, and pushing one would start the release
workflow for bytes it did not build. Such a version is instead recorded in
`scripts/release-hand-published.ts` with its registry integrity; the coordinator
accepts it untagged only while the registry integrity still matches, and any
other untagged published version still stops the release. See
[FIRST-NPM-PUBLISH.md](FIRST-NPM-PUBLISH.md).

These recovery changes apply to releases made with the new workflows. They cannot
change the immutable workflow source at `0.4.0-alpha.3` or repair that historical
run by rerunning it. The missing-artifact behavior observed there is recorded in
[issue #223](https://github.com/jimhoyd-com/urlcode/issues/223).

npm uses OIDC with pinned npm 11.5.1. Alpha versions use npm/GHCR `alpha`, and
GitHub prerelease classification with `--latest=false`. Existing `latest`
pointers are not promoted by this flow. Core GHCR publication remains conditional
on `PUBLISH_CONTAINER=true`; its existing version/channel identity guards remain.
Historical GHCR verification is still a separate follow-up. Digest promotion of a
tested image is design only, in [CONTAINER-PROMOTION.md](CONTAINER-PROMOTION.md);
the publisher still builds from source.

The [Immutable release tags rule](https://github.com/jimhoyd-com/urlcode/rules/23712319)
blocks updates/deletions of `v*` and `@jimhoyd/urlcode-*@*`, permits creation, and
has no bypass actors. Main protection is unchanged. Source and artifact checks
are not an independent security assessment, provider deployment or recovery
proof. The next explicitly authorized new release must exercise the complete
new promotion/recovery path. Progress and remaining work are recorded in
[issue #185](https://github.com/jimhoyd-com/urlcode/issues/185).

### Windows fixture cleanup

Auth/admin tests register resources with their package-local `test/cleanup.ts`.
Cleanup runs in reverse acquisition order: close servers and SQLite services
before deleting temporary directories, including services reopened by a test.
Every registered callback is attempted even if another closer throws, and the
combined error fails the test. Register each closer as soon as its resource opens.
The suites use a five-minute test-file timeout so a stuck fixture is diagnosed
before the CI job limit. Node applies this limit to whole test files too; the
large auth-core file legitimately exceeds two minutes on Windows Node 22.
Windows regression coverage runs on Node 24 for platform-sensitive PRs and
main; nightly/manual runs cover Node 22/24/26.

Failed auth service initialization also waits for its SQLite worker to terminate
before rejecting. Callers can clean up or retry after a rejected open without
racing a remaining database handle; configuration identity failures still fail
closed with the same error code.
