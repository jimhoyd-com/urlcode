# Development and release pipeline

The repository uses npm workspaces, independent package versions, and Changesets
for UI, auth and admin. Core remains at the repository root and is explicitly
included in the shared release inventory. Moving it is not required to use the
same release checks and coordinator.

## Pull requests and main pushes

Every PR and every push to main starts `verify`. A complete Git diff selects one
of two lanes:

- **Prose:** root project Markdown, `docs/**/*.md`, `llms.txt`, `llms-full.txt`,
  `benchmarks/agent/README.md`, `benchmarks/results/README.md` and each
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
  checked-out commit (offline, output outside the checkout) and asserts all four
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
starters, recipes, examples, schemas, manifests, workflows, benchmark prompts,
tasks, answers and acceptance notes, and any package document that ships inside
a published tarball or is read by an agent surface (`README.md`, `SECURITY.md`,
`CONTRACT.md`, `THREAT-MODEL.md`, `IMPLEMENTATION-STATUS.md`, `AGENTS.md`,
`CHANGELOG.md`) select full checks. Anything feeding a generator stays in the
code lane. A rename from source into docs also selects full checks, because the
diff is read without rename detection and shows both paths. Every prose path is
still covered by the always-run `docs` job, which walks all authored Markdown.
No required workflow uses `paths-ignore`.

The always-run `docs` job runs `npm run check:docs`; in the full lane the
`static` job runs `npm run check:code`, which is the rest of `npm run check`.
The two together are exactly `npm run check`, which stays complete for local
use. This removes a duplicated dependency install plus seven repeated checks on
the same commit, not meaningful wall time: the sampled documentation checking
was about two seconds. Job names, lane selection and `verify-complete`
dependencies are unchanged.

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
After building all three extensions, the workspace job also runs the real
`init --with ui,auth,admin` scaffold integration. Missing workspace outputs fail
instead of silently skipping an absent external checkout.
The [audit](CI-RELEASE-AUDIT-2026-09-19.md) records the previous timings.
The [follow-up measurements](CI-FOLLOWUP-2026-09-19.md) record early compact-main observations; issue #185 contains the later decision
and current sample sizes.

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
npm run release:prepare -- --version 0.4.2 --consume-changesets
# Apply local edits on a clean non-main branch; no remote writes or publication:
npm run release:prepare -- --version 0.4.2 --consume-changesets --execute
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

The Actions page exposes `release core`, `release UI`, `release auth`, `release
admin` and `release all packages`. Each manual workflow accepts an exact stable
or alpha version and whether to consume relevant pending Changesets. The four
package workflows update and publish only their selected package. `release all
packages` aligns and publishes the complete train in core → UI → auth → admin
order. A Changeset spanning selected and unselected packages is rejected; use
the all-packages workflow or split the change intentionally.

All five buttons call the same serialized reusable workflow. It creates a
release PR, waits for normal required checks, merges without bypass, runs the
exact-commit full matrix and signed candidate, publishes the selected immutable
tag, checks registry installability, and verifies the current four-package
consumer combination. A core release also updates the standalone starter. The
workflow is resumable: rerun the same button and version after repairing a
failure. It reuses matching PRs, tags, candidates and successful publishers.

The reusable coordinator targets the protected `release` environment. GitHub
holds the job, including its repository secrets, until `@jimhoyd` approves the
deployment; administrators cannot bypass this gate. Self-review remains enabled
because the project currently has one maintainer. The environment admits only
`main` and the release tag patterns `v*` and `@jimhoyd/urlcode-*@*`. Local agents
using the maintainer's authenticated identity may dispatch, approve and resume
this workflow, but an untrusted GitHub account cannot.

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

## One-command local release and resume

Inspect without writing:

<!-- urlcode-current-version:start -->
```sh
npm run release:status  # registry channels, peer compatibility, tag SHAs
npm run release:plan    # manifest-derived inventory
npm run release:run     # ordered states at this checkout: pending/resume/unchanged
npm run release:run -- --version 0.4.2 --consume-changesets
npm run release:run -- --version 0.4.2 --package auth --consume-changesets
```

For an explicitly authorized coordinated release:

```sh
npm run release:run -- --version 0.4.2 --consume-changesets --execute
npm run release:run -- --version 0.4.2 --package auth --consume-changesets --execute
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

The standalone starter helper updates the exact core pin, lockfile, matching
schema/docs links and guide from the installed published core package, then runs
validation/tests/audit/benchmark,
and opens a resumable PR. The coordinator waits for checks and merges it, checking
for a newer template pin immediately before merge. `--skip-template` explicitly
leaves this follow-up to the maintainer. To run only that follow-up:

<!-- urlcode-current-version:start -->
```sh
npm run release:template -- --version 0.4.2 --execute
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

The four publisher filenames remain unchanged for npm trusted-publisher identity.
The candidate builds in the digest-pinned environment, runs verification,
packaging and local operational checks, packs all four packages, and tests an
isolated combined consumer. The signed bundle contains all four archives,
SBOM, Homebrew formula, source/build manifest, train identity and checksums.
The manifest binds it to the candidate run as well as the commit.

Publishers verify the selected candidate's workflow provenance, exact source SHA,
run identity, manifest/package identities and hashes. They publish the selected
package's existing archive without rebuilding it. Auth/admin still run isolated
compatibility tests against their actual published peer floors; temporary test
builds do not replace the promoted archive. This preserves the distinction
between workspace compatibility and registry compatibility.

Each package's GitHub release stores the complete signed bundle for durable
recovery. Supporting sibling archives are candidate evidence: an independent
package release does not imply every sibling archive was published to npm.
Candidate and release Actions artifacts retain 90 days; retention is not an
archival guarantee. Keep independent last-good copies for deployment rollback.

The publisher also renders the signed `train.json` into the GitHub release
description. It labels the selected package as stable (`latest`) or prerelease,
lists the exact four-package combination tested by the candidate, reports the
peer requirements captured from the package manifests and provides an exact
install command. This distinguishes independently stable package versions from
the recommended tested stack without maintaining a second hand-edited version
table. The attached `train.json` carries the same versions, channels, peer
requirements, archive identities and integrities for machine consumers.

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
