# Development and release pipeline

The repository uses npm workspaces, independent package versions, and Changesets
for UI, auth and admin. Core remains at the repository root and is explicitly
included in the shared release inventory. Moving it is not required to use the
same release checks and coordinator.

## Pull requests

Every PR starts `verify`. A complete Git diff selects one of two lanes:

- **Prose:** root project Markdown, `docs/**/*.md`, `llms.txt` and
  `llms-full.txt` changes run guidance/generated-resource checks, runtime audit,
  and the required container job. CodeQL retains its repository policy.
- **Full:** all other changes, mixed changes, empty/unavailable diffs and main
  pushes run static checks once and core and workspace suites separately. Both
  suites retain Linux on Node 22/24/26. Main adds Windows/macOS on Node 24.
  PRs add those platform legs for runtime, CLI, SQLite, fixture, dependency,
  workflow and unknown changes; known UI presentation-only changes omit them. Package, action,
  cookbook, reproducibility and operational checks retain their coverage.

The prose allowlist is deliberately narrow. Package documentation, skills,
starters, examples, schemas, manifests and workflow changes select full checks.
A rename from source into docs also selects full checks. No required workflow
uses `paths-ignore`.

`verify-complete` accepts only the results specified by the successful plan.
Failed, canceled, missing or unexpectedly skipped work fails the gate. Required
check names (`verify-complete`, `container`) and CodeQL enforcement are preserved.
The repository ruleset currently does not require a branch to be up to date;
release publication separately requires verification of the exact main commit.

```sh
npm run check:docs                 # prose checks without the runtime suite
npm run ci:plan -- BASE_SHA HEAD_SHA
npm run ci:report -- RUN_ID         # read GitHub job/step durations
npm run ci:history -- 100 2026-09-19 # group historical timing samples
npm run verify                    # full local validation remains available
npm run test:package              # builds and installs a real archive
```

CI uses `test:package:built` only after building in that same job. Core tests and
workspace tests run in separate jobs to shorten their serial critical path;
this increases job setup overhead and needs monitoring for runner queue pressure.
After building all three extensions, the workspace job also runs the real
`init --with auth,admin,ui` scaffold integration. Missing workspace outputs fail
instead of silently skipping an absent external checkout.
The [audit](CI-RELEASE-AUDIT-2026-09-19.md) records the previous timings.
The [follow-up measurements](CI-FOLLOWUP-2026-09-19.md) record the first compact
main result and explain why the new lanes still need 20 organic runs each.

## Version and release ownership

A feature PR records release intent in a Changeset for a changed workspace
package. Review dependency/peer changes explicitly. Keep pre-mode enabled until
an explicit decision to leave alpha. Do not force all packages to one version.
Core version bumps remain explicit in the release PR, including its CLI banner.
`release:check` verifies every manifest against its lockfile entry and checks the
alpha-mode policy. Existing CLI tests catch core banner/version disagreement.

A release PR collects version/changelog and lockfile changes together. Ordinary
unreleased development does not move existing version tags or npm versions.
Use the exact release commit after its full platform checks have passed. Routine
main builds use five OS/Node combinations per suite (ten jobs total), rather
than the full nine per suite (eighteen). Nightly runs at 07:17 UTC and manual
runs retain all three operating systems on all three Node versions. Before a
release, run `gh workflow run ci.yml --ref main` and wait for that exact commit's
full run to succeed. A successful compact main run alone cannot authorize a
release. Main pushes do not cancel scheduled/manual verification.

Inspect release state:

```sh
npm run release:status   # registry channels, peer compatibility, remote tag SHAs
npm run release:plan     # read-only JSON inventory, including root core
npm run release:run      # read-only ordered proposal at HEAD
```

All three commands require network access; none publish. `release:run` selects
unpublished manifest versions and releases already tagged at HEAD (for resuming
partial completion). Its order is core, UI, auth, admin, skipping other already
published versions. Plan fields come from package manifests, not copied versions
in another config file.

Once the release itself is authorized, from a clean checkout of that exact SHA:

```sh
npm run release:run -- --execute
```

This opt-in command creates missing tags through GitHub, refuses an existing tag
at a different commit, and waits for each package's tag-triggered release before
starting the next. It stops on failure or missing npm publication. Do not push
all release tags at once: publication workflows share one concurrency group and
GitHub may replace pending runs. The coordinator intentionally starts one at a
time. It never merges a PR, bypasses checks, force-pushes or publishes locally.

The coordinator needs `gh` authentication with repository Contents write and
Actions read; reading checks also needs Checks read. It is intended for an
authorized maintainer session or a repository-scoped GitHub App. A fine-grained
PAT can serve a short-lived maintainer script with those permissions, but must
have no ruleset bypass. The workflow `GITHUB_TOKEN` should not be used to create
these trigger tags: its push events do not start another ordinary push workflow.
For long-lived automation prefer a GitHub App; do not add a bypass to `main`.
[GitHub App guidance](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app)

## Publication and recovery

The four workflow filenames remain unchanged because npm trusted publishing
names them. They call shared helpers for identity, preflight, peer installation,
retry handling and publication. npm authentication remains OIDC; no npm token
is introduced. Core candidate and release share `prepare-core-release.sh`.
For an authorized release, first dispatch the manual `candidate.yml` workflow on
the selected main commit. It extends the core candidate with UI/auth/admin
archives and verifies all four together in an isolated temporary consumer:
peer compatibility, installed versions, public imports and real scaffold
composition. Its signed `train.json` records the proposed archives and integrity.
A candidate does not publish, validate live providers or prove registry OIDC;
release workflows still prepare and retain their own immutable retry artifacts.
Extensions share `prepare-extension-release.sh` and test published peer floors.
Auth/admin build in the workspace for packaging, then build and run their suites
in a temporary copy outside the monorepo against exact registry peer floors.
This preserves #184’s isolation fix; npm `--prefix` is not an isolation boundary.

Preflight checks the checkout SHA, main ancestry, a successful exact-SHA full
`ci.yml` nightly or explicit manual run, CodeQL, remote tag SHA, npm
channel monotonicity and published peer floors. When a full run was canceled,
run `verify` manually at the selected tag/ref, then rerun the failed release;
never substitute another commit's passing run or move the tag.

Prepared artifacts are retained for 90 days before publication. A rerun of the
same workflow run restores those original bytes and skips preparation. npm
versions already present must have identical SHA-512 integrity; existing GitHub
assets must match byte for byte. Different bytes stop the release. An absent or
expired artifact requires reconstruction that still passes these comparisons;
if it cannot, diagnose and create a new version rather than overwrite history.

GitHub release classification follows the manifest's prerelease status. New
GitHub releases use `--latest=false`; stable latest promotion is a separate
maintainer decision, avoiding accidental promotion by a package-level release.
GHCR updates the derived channel (`alpha` for alphas, `latest` for stable) and
preserves existing version images only when their source label matches. An
existing image/channel without the required labels fails closed and needs a
reviewed migration; this change does not silently relabel old images.

Partial npm/GitHub/GHCR success is possible; those systems cannot be updated
atomically. Rerun the original failed run, check its summary and then rerun the
coordinator. A changed source commit requires a new version and tag. Failed
OIDC configuration needs correction on npm, not tag deletion. A green dry run
cannot prove registry-side OIDC trust; each package's first authorized publish
must verify it.

Historical tags, GitHub release flags and npm channels are not retroactively
rewritten by these scripts. Use `release:status` to inspect them. The active [Immutable release tags rule](https://github.com/jimhoyd-com/urlcode/rules/23712319)
prohibits update/deletion of `v*` and `@jimhoyd/urlcode-*@*` tags, permits
creation, and has no bypass actors. Its reviewed configuration is tracked in
`.github/rulesets/release-tags.json`. Main protection is unchanged.

During the September 19 alignment, GitHub releases `v0.4.0-alpha.1` and
`v0.4.0-alpha.2` were explicitly marked as prereleases and GitHub latest was
restored to `v0.3.0`, matching npm. Their tags and artifact bytes were unchanged.
Further performance and release-train validation is tracked in
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
