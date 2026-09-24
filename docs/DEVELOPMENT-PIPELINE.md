# Development and release pipeline

This page maps repository automation. It deliberately keeps CI policy and
release operations in their own reader-focused guides so routine workflow,
documentation and release changes do not all edit one runbook.

| Task | Authoritative guide |
| --- | --- |
| Understand a URLCode application's GitHub Action | [Checking a URLCode project](CI.md#checking-a-urlcode-project-on-github) |
| Understand this repository's PR, merge-queue, sweep and compatibility checks | [Checking this repository](CI.md#checking-this-repository) |
| Bump the version, release, retry or fix forward | [Release operations](RELEASE-OPERATIONS.md) |
| Check package versions and channels | [Package and channel alignment](VERSION-ALIGNMENT.md) |
| Review provenance, add-on pinning and dependency triage | [Release security](RELEASE-SECURITY.md) |
| Record production-readiness evidence | [Production readiness](RELEASE-OPERATIONS.md#production-readiness) |

The repository uses npm workspaces with one version shared by core and every
add-on. Core source lives in `packages/core/src`, while the repository root
remains the published core package. Repository automation is indexed in
[`scripts/README.md`](../scripts/README.md).

Established script filenames remain stable because workflows, tests, release
helpers and operator documentation call them directly. New standalone scripts
belong under their logical `scripts/` area when that improves cohesion.

## Common local commands

```sh
npm run check:docs                   # prose checks without runtime tests
npm run check:code                   # remaining static checks
npm run ci:plan -- BASE_SHA HEAD_SHA # preview PR classification
npm run ci:report -- RUN_ID          # inspect GitHub job/step durations
npm run ci:history -- 100 2026-09-19 # group historical timing samples
npm run verify                       # full local validation
npm run verify:addons                # cross-workspace add-on proof
npm run test:package                 # build and install a real archive
npm run test:examples                # build, then test starter/examples
```

## Release package boundary

Release archives contain installed behavior and the smallest set of resources
that behavior consumes. Core includes built JavaScript and declarations,
schemas, policy data, starters, runnable examples, recipes, agent skills and
the two `llms` documents. Extension archives include built output, README,
license, security policy and required third-party notices. Repository history,
plans, audits, contributor instructions, release records, source, tests and
package-specific design/status documents stay in the source repository.
`llms-full.txt` is the single offline documentation bundle; the authored
`docs/` tree is not duplicated into the npm archive.

`npm run audit:packages` discovers core and every workspace under `packages/`
with a reviewed budget, runs `npm pack --dry-run` without package hooks, and
enforces this boundary. It rejects unexpected top-level paths, source/tests/maps
and environment files, missing export/executable targets, and archives over the
reviewed compressed, unpacked or file-count budgets. A new extension fails until
its reviewed policy is added. Increase a budget only with a reviewed explanation
of the new installed requirement; do not use budget headroom instead of updating
the allowlist.

## Current-version references in documentation

When reader-facing Markdown must name the current core version, wrap the
smallest complete paragraph or fenced example containing it with
`urlcode-current-version:start` and `urlcode-current-version:end` HTML comments
on their own lines. `npm run release:bump` discovers these markers in every
tracked Markdown file and both `llms` indexes, so a newly added guide needs no
central file-list update. It replaces the old core version only inside marked
blocks. Generated `llms-full.txt` preserves the source markers and advances in
the same bump, keeping it byte-aligned with its sources.

`node scripts/release-bump.ts --check` fails when markers are unbalanced, a
marked block does not contain the manifest's current version, or a tracked
Markdown file mentions that version outside a marker. Add markers in the same
pull request as a new current-version reference. Changelogs are not scanned.
The release procedure is in
[release operations](RELEASE-OPERATIONS.md#release-a-version).
