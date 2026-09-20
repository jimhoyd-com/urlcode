# CI and monorepo release audit — 2026-09-19

Status: historical findings and recommendation. The accompanying implementation
and current commands are documented in [the development pipeline](DEVELOPMENT-PIPELINE.md).
The proposed helper table below records the audit design, not the installed command list. Source inspected:
`3a3d9adf6f0ec53faa078c93dfb977aa5ac416f7`; GitHub settings, runs, tags,
releases and npm dist-tags were read on September 19. Concurrent PRs may change
this snapshot. This review does not authorize publishing or changing protections.

## Recommendation

Keep npm workspaces and Changesets, independent package versions, and the
existing public package names. Add an explicit change classifier for CI and one
release coordinator for all four packages. Preserve the existing required gate
and CodeQL policy. Stop using tag pushes as the place to discover whether a
release is buildable. Prepare and validate an immutable release plan first;
create tags from that plan once; resume partial publication without moving them.

Do this incrementally. A repository layout migration, Nx, Turborepo, remote
caching, or fewer security assertions is not a prerequisite for faster PRs.

## Measured bottleneck

[PR #181](https://github.com/jimhoyd-com/urlcode/pull/181) changed only
`AGENTS.md` (9 additions, 4 deletions). Its
[verify run](https://github.com/jimhoyd-com/urlcode/actions/runs/35475753912)
took **9m08s** from creation to completion.

| Job | Execution time |
| --- | ---: |
| verify, Linux / Node 22 | 8m24s, after 39s from workflow creation to job start |
| verify, Linux / Node 24 | 5m49s |
| verify, Linux / Node 26 | 5m36s |
| build-fidelity | 27s |
| action | 25s |
| container | 22s |
| audit | 19s |
| verify-complete | 2s |

Within Node 22, `npm run verify` took 7m33s. Its core tests took 281.7s,
auth tests 92.9s, admin tests 23.6s, and UI tests 2.7s. These suites run
**serially**. Lint, typecheck and source checks took roughly 29s combined.
Package verification subsequently took 28s; drills took 7s. This is chiefly
execution time, not queueing, in this example.

The same pattern appears in
[PR #180's run](https://github.com/jimhoyd-com/urlcode/actions/runs/35475563183):
8m38s overall, with Node 22 the longest job. These are sampled runs, not a
long-term percentile study or a demonstrated performance gain.

Conversely, the
[UI alpha.6 release](https://github.com/jimhoyd-com/urlcode/actions/runs/35475220590)
took 19m23s: approximately 11m24s before the job started, then 7m37s in the
whole-repository verify step. Both queue pressure and unnecessarily broad
release verification matter there; the API does not establish the queue's cause.

The workflow already avoids branch-push plus PR duplication and cancels stale
PR runs. Its three PR matrix legs repeat lint, types, generated-file checks,
builds, every package's tests, package smoke tests and drills. Main expands this
to nine OS/Node combinations. `test:package` builds again after `verify` has
built; candidate/core release explicitly build before calling `verify`, which
builds again, and then `test:package`, which builds a third time.

## What the checks buy

| Check | Purpose | Proposed placement |
| --- | --- | --- |
| Documentation and generated resources | Prevent stale references, guidance and authoring resources | Every PR; standalone fast lane for prose changes |
| Lint and typecheck | Source and contract errors | Once per relevant change on a canonical Node version |
| Core and extension regressions | Behavioral, integration and isolation invariants | Affected packages and downstream consumers on PRs; full validation for releases |
| Supported Node versions | Detect runtime compatibility failures | Retain all three versions for runtime changes initially; avoid repeating static checks |
| Windows/macOS | Path, process, filesystem and platform differences | Targeted PR coverage plus full main coverage initially |
| Package install smoke | Prove shipped archives and declarations work | Relevant package/CLI/starter changes and releases; lightweight pack inventory for shipped-doc changes |
| Container | Validate the shipped execution environment | Keep existing required job; early optimization can leave this cheap job alone |
| Action smoke | Exercise the consumer-facing composite action | Runtime/action/starter/build changes |
| Build fidelity | Detect nondeterministic emitted files and packs | Build/package/toolchain changes and releases |
| Runtime dependency audit | Detect known advisories | Keep initially: measured cost is small; also run on a schedule and before release |
| CodeQL | Static security analysis | Preserve current enforced policy; not the observed critical path |
| Operational drills | Local lifecycle/recovery regression signal | Relevant runtime changes, main and release validation |
| Real-model evals | Authoring quality regression | Existing weekly/manual workflow; no need to put it on ordinary PRs |

Do not remove timeout, worker replacement, sandbox or authentication tests to
save time. Profile and change their scheduling or fixtures while preserving the
behavior they establish. The longest sampled core subtests included explain
versus runtime agreement (~35s), a slim-image installer test (~21s), and sitemap
limits (~21s). Investigate repeated CLI startups and repeated project loading;
these measurements do not yet establish which internal operation dominates.
Auth's ~93s warrants separate profiling, including password hashing, without
changing production security parameters to speed up tests.

## PR workflow shape

Always start the workflow. A small, tested classifier compares the complete PR
diff against its base, including renamed/deleted paths, and emits an explicit
job plan. Missing history, unknown paths, classifier errors and workflow/shared
toolchain changes select full verification. Do not infer safety just from a
`.md` extension: starter, recipe and executable authoring inputs need their
own categories. Core changes affect all consumers; UI affects auth/admin; auth
affects admin; admin-only changes need not retest all of core.

For a prose-only PR, run guidance and generated-resource checks, local link and
reference checks, and applicable package file-inclusion assertions. Extract this
from today's `check` rather than calling the full source/test syntax walk.
Changes to generator code, manifests, lockfiles, schemas, executable examples or
CI configuration must leave the prose-only lane.

For code PRs, run static checks once, build required outputs/styles in dependency
order, and schedule core/UI/auth/admin tests independently. Start by preserving
the current Node coverage. Pilot two balanced core-test shards on the slowest
leg, measure runner-minutes and wall time, and increase only if the gains justify
the extra jobs. Keep the full local `npm run verify` entry point.

The `verify-complete` gate must know which jobs the classifier required. It must
reject failure, cancellation, missing results and unexpected skips; accept a
skip only when the validated plan explicitly marks that job unnecessary. Test
the gate's failure paths. The present gate rejects every skipped dependency, so
adding `if:` conditions without updating its contract will break merging.

Do not add workflow-level `paths-ignore` to a required workflow: GitHub documents
that such skipped workflows can leave required checks pending. Use job selection
inside an always-triggered workflow instead.
[GitHub documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)

The live main ruleset requires `container` and `verify-complete`, and separately
enforces CodeQL findings. It has no bypass actors. Its strict up-to-date setting
is **false**, contrary to CONTRIBUTING's claim that an up-to-date branch is
required. Preserve protections in the first implementation; reconcile that
documentation. A later policy change needs a deliberate review, not an implicit
side effect of renaming jobs.

Windows failures are real: the
[main run at cc582f2](https://github.com/jimhoyd-com/urlcode/actions/runs/35475923267)
failed on `spawnSync npm.cmd EINVAL` in UI packaging. PR
[#182](https://github.com/jimhoyd-com/urlcode/pull/182) already addresses this.
Linux-only PR tests let this reach main. Add a focused Windows packaging/process
smoke for relevant changes before considering a smaller main matrix. Keep the
existing full main matrix during rollout; moving exhaustive coverage to nightly
is a later tradeoff, and release candidates must still pass full validation.

Initial goals: prose PRs under 90 seconds excluding runner queueing; ordinary
code PRs under 5 minutes. These are targets, not measured promises. Report queue
time separately from execution, and compare p50/p95 over at least 20 runs per
change class before deciding the optimization succeeded.

## Release and tag findings

1. **Tags have actually moved across source revisions.** Release history for
   `v0.4.0-alpha.1` records five distinct commits: `b5cd619`, `871dd87`,
   `bb0f9e6`, `84e45ea`, then successful `8dabc7e`. The sampled history also
   shows multiple commits for `v0.3.0`, `v0.2.0`, and `v0.1.0`. This establishes
   reuse of tag names across commits, not who changed them or whether every
   failed attempt published an artifact. The live ruleset inventory contained
   only a branch ruleset, not tag protection.
2. **An ancestor of main is not necessarily a validated release commit.** All
   four release workflows check main ancestry, but do not require the exact
   commit's main CI result. UI alpha.6 published from `8fa7f8b` while that
   commit's main verify run failed on Windows. Release validation was Linux-only.
3. **Core alphas are classified as normal GitHub releases.** Both alpha.1 and
   alpha.2 had `prerelease: false`; GitHub's latest-release endpoint returned
   alpha.2. Core's release creation omits the prerelease flag. npm correctly
   separates its `alpha` channel; this is a distinct GitHub-channel defect.
4. **Core container publication always updates `latest`.** `release.yml` tags
   and pushes `latest` even for prereleases when `PUBLISH_CONTAINER` is enabled.
   The code path is confirmed; this audit did not establish whether an alpha
   actually overwrote the live GHCR tag.
5. **Candidate and release have already diverged.** Candidate reads Dockerfile
   into two shell variables, swallowing `AS build` into the image variable and
   failing the digest regex. The same parse was fixed only in release. Running
   candidate's parser locally against the current Dockerfile reproduced failure.
   The last listed candidate successes predate this snapshot; no new candidate
   was dispatched during this audit. Existing release tests check release's parser,
   not both paths.
6. **Existence is treated as sufficient for retry.** Publish steps skip an
   existing npm version without checking its integrity against the candidate;
   GitHub release uploads use `--clobber`. The fidelity job tests repeated packing
   in one checkout, not equality to a prior publication. Extension builds use
   floating Node 22 and registry-installed peers, so same-commit reproducibility
   across days is not established. Preserve and compare the original artifact.
7. **Concurrency is scoped to a tag.** Two different versions of one package can
   publish concurrently; there is no shared release-train order or monotonic
   channel guard. A late old release could update a channel after a newer one.
8. **Changesets is only partially in charge.** Version 3.0.3 is installed and
   pre-mode is enabled, with independent versions. Core is outside its workspace
   package set. The tag checker checks trigger disjointness, not remote tag SHA,
   registry integrity, missing changesets, peer compatibility or channel state.
   PR [#183](https://github.com/jimhoyd-com/urlcode/pull/183) already tackles a
   Changesets peer-range rewrite and stale channel documentation; build on it.
9. **Release documentation contains competing snapshots.** VERSION-ALIGNMENT
   still describes old repository pins, and the Changesets README says only UI
   is covered and publishing is not wired up, despite a successful monorepo UI
   release. RELEASE-SECURITY describes candidate/release as sharing a path that
   has demonstrably diverged. Generate the live inventory; retain policy in prose.

The actual npm channels at audit time were:

| Package | `latest` | `alpha` |
| --- | --- | --- |
| core | 0.3.0 | 0.4.0-alpha.2 |
| ui | 0.1.0-alpha.5 | 0.1.0-alpha.6 |
| auth | 0.1.0-alpha.3 | 0.1.0-alpha.3 |
| admin | 0.1.0-alpha.3 | 0.1.0-alpha.3 |

Different channel values are not inherently drift. Historical extension `latest`
values are already alphas; do not silently move them. Define channel intent,
test the documented install combinations against peer ranges, and report
deviations. An old core release tag also should not follow current main:
unreleased development is normal; silently relabeling a published version is not.

## One release process for four independently versioned packages

Use Changesets for reviewed release intent and changelogs, with `fixed` and
`linked` remaining empty. Require a changeset or a reviewed no-release reason
for changes to publishable behavior. A routine feature PR need not manually
bump versions: an accumulated release PR owns version changes, lockfile updates,
peer-range changes and changelogs together. This replaces VERSION-ALIGNMENT's
instruction to bump on every source-changing PR once the new flow is implemented.
[Changesets configuration](https://github.com/changesets/changesets/blob/main/docs/config-file-options.md)

Near term, keep root core where it is and include it explicitly in the common
release inventory and plan, with its existing version update reviewed in the
same release PR. Do not pretend `changeset version` covers it. Longer term,
evaluate moving core to `packages/core` with a private tooling root so Changesets
can own all four uniformly. That is a separate migration with CLI/container/
starter/package tests, not part of the urgent CI fix. Preserve existing tag
formats during this transition; any future new core tag format needs an explicit
compatibility decision for install.sh, Homebrew, action consumers and old links.

Proposed lifecycle:

1. A protected release PR produces versions and a plan listing package name,
   directory, version, tag, channel and dependency order. Manifests supply the
   versions; the plan does not become a second hand-maintained version database.
2. After merge, select and freeze its exact main SHA. Require that SHA's main
   checks and release-specific validation; never substitute the newest passing
   run from another commit. A canceled/missing full check must be run for the
   selected SHA. Run without publication credentials during preparation.
3. Build once with locked tooling, pack the proposed packages, and install the
   actual tarballs together in a clean consumer project without development
   export conditions. Separately test declared published peer floors. Where a
   new floor belongs to this release, test its candidate tarball before publishing
   and confirm registry resolution after its predecessor publishes.
4. Sign and retain artifacts and a manifest binding source SHA, package versions,
   dependency versions, lock hash and artifact hashes. Exercise this same prepare
   path for a manual candidate; candidate must not be a second copied implementation.
5. Create each expected tag once at that SHA. Refuse a remote tag at a different
   SHA. Publish the prepared bytes in dependency order: core/UI before auth, auth
   before admin, including only packages that need a release. Serialize publication
   across the release train. Keep write/OIDC permissions confined to publication.
6. On retry, reconcile each artifact with npm integrity, tags, GitHub assets and
   container digests. Identical means complete; a mismatch stops. A registry
   timeout is not proof a version is absent. Never clobber a different asset or
   move a version tag. Reuse retained bytes; if unavailable, require a rebuild
   that matches recorded hashes. A source fix needs a new version and release PR.
7. Mark prereleases consistently on GitHub/npm/GHCR, and update mutable channels
   only according to explicit policy with a guard against regressions. Summarize
   partial success clearly; separate registries cannot form an atomic transaction.

Protect release tag namespaces against update/deletion, with a narrowly defined
creation path. This is a proposed strengthening, not a settings change made by
the audit. Avoid a token-created-tag event chain: coordinate preparation and
publication explicitly in workflow jobs/dispatch, rather than depending on
another push workflow being triggered by a workflow-created tag.

Initially retain the existing four trusted-publisher workflow filenames as thin
wrappers around shared checked-in helpers. Consolidating to a new filename is a
registry trust migration: verify each package's npm publisher identity and direct
publish permission first. A dry run cannot prove the OIDC exchange works.
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

## Small helper surface

These names describe proposed commands, not commands implemented by this audit.

| Command | Contract |
| --- | --- |
| `npm run ci:plan -- --base SHA --head SHA` | Print change class, affected package closure, required jobs and why; deterministic and fail closed |
| `npm run ci:report -- --run ID` | Read GitHub job/step timings, separate queue and execution, show failed checks and run links |
| `npm run release:status` | Read manifests, Changesets state, Git tags, GitHub releases, npm versions/channels/integrity and peer compatibility; no mutations |
| `npm run release:plan -- --sha SHA` | Produce the exact package/version/tag/channel/order plan, including root core |
| `npm run release:prepare -- --plan FILE` | Validate, build, pack, smoke-test and write immutable artifact manifest; no publication |
| `npm run release:publish -- --plan FILE` | CI-only mutation path; validate commit/checks/tags/artifacts, publish or resume idempotently |

Use structured JSON outputs plus a short human summary. Share the version/tag/
channel parser, manifest inventory, Docker image parser and integrity comparison
between candidate and release. Test those contracts by execution, not only by
regex checks that particular shell snippets exist in YAML. Add workflow syntax
validation and fixtures for wrong tag, wrong SHA, mismatched version, prerelease,
partial publish, existing unequal artifact, registry outage and peer-floor failure.

## Rollout order and acceptance

1. **Release correctness:** shared candidate parser, correct GitHub/GHCR alpha
   handling, read-only status/preflight, immutable retry checks and exact-SHA
   main-CI gate. Coordinate with #183; preserve the current publisher identities.
2. **Immediate PR speed:** prose lane and tested classifier/gate. Keep existing
   required check names, audit, CodeQL and container. Demonstrate a docs-only PR
   finishing quickly and a deliberately failed required job blocking the gate.
3. **Code throughput:** split static/core/workspace checks, remove redundant
   builds, profile and shard the slow suites, add targeted Windows coverage.
   Verify equivalent test coverage and measure queue/cost as well as latency.
4. **Release coordination:** one Changesets release PR and package inventory,
   one preparation path, serialized dependency-aware publication and immutable
   reconciliation. Prove partial-failure recovery on a future authorized release.
5. **Optional structural work:** core workspace migration and reconsideration of
   the nine-leg main matrix after measured coverage/performance evidence.

This audit made no release, tag, registry-channel or branch-protection changes.
It inspected live evidence and reproduced the candidate parser failure locally;
it did not execute a new full matrix, deploy containers, change npm trust, or
prove end-to-end recovery. Passing CI is not an independent security assessment.

## Implementation follow-through

The user subsequently authorized implementation. The accompanying PR installs
the conservative prose lane, separate core/workspace jobs, shared release
helpers, live inventory and an explicit sequential tag coordinator. Root core
remains outside Changesets; whole-train preparation before any tag and finer
package selection are tracked in [#185](https://github.com/jimhoyd-com/urlcode/issues/185).
The user explicitly approved the immutable-tag rule, now active as
[23712319](https://github.com/jimhoyd-com/urlcode/rules/23712319), without bypass.
The two historical core alpha release flags were corrected and GitHub latest
restored to stable v0.3.0. No tags or artifact bytes were rewritten.
