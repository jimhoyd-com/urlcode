# CI and release follow-up, September 19, 2026

This is the evidence and disposition for [#185](https://github.com/jimhoyd-com/urlcode/issues/185),
after the Windows fixes (#190) and matrix change (#192). It does not authorize
publication or change required checks.

## Reproducible measurements

```sh
npm run ci:history -- 100 2026-09-19 > /tmp/ci-history.json
npm run ci:report -- 35482828280
```

The history helper reads GitHub through `gh`, with four concurrent requests at
most. It does not dispatch new runs. Increase the limit (maximum 1,000) as more
history accumulates. Use a date cutoff after the rollout when comparing the
same workflow generation. It groups by event, inferred lane and exact matrix,
reports counts and nearest-rank p50/p95, and flags groups with fewer than 20
successful first attempts. Failures/cancellations remain visible but are excluded
from successful-run percentiles. Reruns are excluded because run creation time
includes the human delay before retrying. Earlier attempts are not a complete
usage ledger. Raw job/step durations and run URLs remain in the output.

Workflow elapsed time ends at the last active job's completion. Runner-minutes
sum overlapping job execution durations: they are neither wall time nor billed
minutes. Job-creation-to-start is an observed scheduling interval, not a guarantee
of pure runner queue time. Workflow-creation-to-start also includes dependencies.
Missing timestamps remain missing; they are never treated as zero.

The initial 100-run sample spans September 19 04:59 UTC through September 20
02:00 UTC. Successful first-attempt results:

| Configuration | Samples | Wall p50 / p95 | Runner-minute p50 / p95 |
| --- | ---: | --- | --- |
| Historical combined main, 9 jobs | 20 | 8m27s / 9m04s | 49.82 / 53.62 |
| Historical combined PR, 3 jobs | 40 | 6m12s / 8m52s | 17.28 / 24.57 |
| Split full main, 18 jobs | 1 | 7m36s / 7m36s | 74.30 / 74.30 |
| Split compact main, 10 jobs | 1 | 6m48s / 6m48s | 43.20 / 43.20 |
| Split compact PR, 10 jobs | 2 | 6m38s / 7m15s | 40.23 / 43.58 |

Historical groups contain changing code and workflow revisions; they are context,
not a controlled experiment. The sample includes no classified docs-only runs.
It cannot satisfy the 20-run acceptance criterion for the new lanes. Do not
manufacture 20 redundant workflow runs to fill the sample.

The [compact main run](https://github.com/jimhoyd-com/urlcode/actions/runs/35482828280)
used 31.1 fewer runner-minutes than the preceding
[full matrix main run](https://github.com/jimhoyd-com/urlcode/actions/runs/35482515877),
an observed 41.9% reduction between two runs, not an established long-term rate.
Its Windows core job took 377 seconds: 258 in `npm test`, 58 in package smoke,
13 in installation. Linux Node 22 spent 300 of its 355 seconds in `npm test`.
The next useful optimization target is the runtime suite, not removing static,
container, audit or provenance checks. CLI subcommands are separate steps in the
raw report. File-level profiling is still needed before choosing balanced shards;
extra shards would add setup and runner pressure.

## Changes delivered in this follow-up

- `ci:history` makes the remaining baseline measurable without new CI jobs.
- Auth/admin release instructions now use scoped monorepo tags and the correct
  trusted-publisher workflow filenames. Package agent guides file issues here
  and point documentation at root `docs/`.
- Optional evals checks its credential before checkout/setup/install, and retains
  artifacts for 14 days. This avoids unused setup; it does not remove the weekly
  quality check or claim measured savings from a workflow with no prior runs.
- The manual signed candidate builds all four tarballs and installs them together
  in a temporary consumer outside the workspace. It verifies the peer dependency
  tree, installed versions, public imports, and `init --with auth,admin,ui`.
  `train.json` records package SHA-512 integrity and the source commit; the
  candidate manifest/checksums and provenance include the extension archives.
  Failure stops the candidate before attestation/upload. Nothing is published.

The candidate validates the proposed package set, not live-provider behavior or
registry OIDC. Per-package release workflows still prepare their own archives
and retain their original bytes for retries; candidate archives are not silently
substituted for published release bytes. Before a release, dispatch the candidate
at the selected main commit, then the full verification workflow, and inspect
both results before using the authorized coordinator.

## Remaining decisions and external validation

| Item | Disposition |
| --- | --- |
| Windows packaging/process coverage | Delivered in #190/#192; Node 24 on relevant PRs/main, all supported versions nightly/manually. |
| 20-run baseline per new lane | Wait for organic runs, then rerun the helper with a rollout cutoff. |
| Dependency-aware package selection | Keep conservative coverage for now. UI feeds auth/admin; auth feeds admin; core extension/CLI/scaffold changes affect the full composition. A package map must include integration, generated styles, peers and tooling, not just changed directory names. |
| Changeset/no-release enforcement | Still open. Define explicit core release intent as well as workspace Changesets; require reviewed reasons for no-release cases before implementing a gate. Blanket source-path rules would misclassify tests/tooling and root core is not versioned by Changesets. |
| Move core into `packages/core` | Separate migration, not a prerequisite for fast CI. Root-relative build, package files, CLI, Docker and starter paths make this higher risk than keeping the explicit root inventory. |
| OIDC and retained-artifact retry | Needs the next explicitly authorized release. No synthetic run proves npm's trust configuration or partial publication recovery. |
| Historical GHCR image labels/digests | Blocked on read access: anonymous registry lookup returned 403; organization package API explicitly requires `read:packages`. No labels/digests were verified, no images changed, and container publishing remains unenabled. |
| Dependabot grouping / unchanged nightly reuse | No change yet. Measure update PR fanout before grouping; unchanged source can still acquire new advisory findings, so reusing old verification indiscriminately would hide them. |

Keep #185 open for these acceptance items. The remaining items are not evidence
that a publish or recovery rehearsal has already succeeded.
