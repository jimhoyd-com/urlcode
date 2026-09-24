# Checking on GitHub

This page has two audiences: [this repository's checks](#checking-this-repository)
and the [composite Action for URLCode projects](#checking-a-urlcode-project-on-github).

## Checking this repository

**Verify — CI** is the required repository workflow. `verify-complete` accepts
only the successful results specified by the plan; failed, cancelled, missing or
unexpectedly skipped work fails the gate. `container` and CodeQL remain
separately required by the repository ruleset. The planner in
`scripts/ci-plan.ts` classifies a complete Git diff; unknown, empty and
unavailable diffs fail closed.

| Change portfolio | Routine PR/main work |
| --- | --- |
| Prose | `plan`, `docs` and `verify-complete`; code jobs intentionally skip. The narrow allowlist is root project Markdown, `docs/**/*.md`, `llms.txt`, `llms-full.txt`, and package contributor/governance prose. |
| Extension-only | Static checks plus the changed extension and reverse dependencies on Linux/Node 24. Unrelated core tests, examples/drills, audit, package, Action, container and reproducibility proofs skip. |
| Runtime, shared, shipping or unknown | Static checks, Linux/Node 24 core shards, all consuming extensions and applicable root-runtime proofs. |

The prose allowlist is reviewed non-executable contributor prose, not every
Markdown file. Skills, starters, recipes, examples, schemas, manifests,
workflows, package documents that ship or are read by agents, and generator
inputs select the runtime lane. A rename from source to docs also selects full
verification. Every prose path remains covered by `docs`; no required workflow
uses `paths-ignore`.

Routine PR/main work is intentionally the fast feedback portfolio. Scheduled
**Verify — sweep**, merge-queue and manually dispatched exact-commit runs use
the full Linux/macOS/Windows × Node 22/24/26 matrix. Before release preparation,
dispatch **Verify — compatibility**: it is read-only and runs package
installation, reproducibility, the composite Action, container and
cross-workspace integration on Linux, macOS and Windows with Node 24. Release
operations repeat the exact-commit proof before tagging.

None of those Node versions is the documented package floor itself (`engines`:
`>=22.13.0` on core and every first-party extension, [Install](INSTALL.md)):
`setup-node` resolves `'22'` to whatever the newest 22.x patch is. The
`package-floor-smoke` job, gated the same as package smoke, pins `22.13.0`
exactly, packs and installs the real core tarball (the same
`scripts/package-smoke.ts` check other legs run on newer Node) and builds every
extension package, so the floor is proven rather than only asserted in prose.

The `workspace-integration` Linux leg runs that add-on integration and the UI browser test
([#332](https://github.com/jimhoyd-com/urlcode/issues/332)) using preinstalled
Chrome through DevTools. CI sets `URLCODE_REQUIRE_BROWSER=1`; locally it uses
installed Chrome/Chromium and skips when absent. It is not part of `npm test`;
Firefox, Safari and platform-native browsers remain unverified.

`docs` runs `npm run check:docs`; full-lane `static` runs
`npm run check:code`; together they are `npm run check`. Core shards and
workspace packages are separate jobs to shorten the critical path. Compatibility
rebuilds extensions, audits their archives and runs the real add-on
integration (`npm run test:addons`: pack core and every add-on, pin them by
sha512, create a site and add, serve and remove every extension); missing
workspace outputs fail.

Auth/admin fixtures register cleanup in package-local `test/cleanup.ts` in
reverse acquisition order, closing servers and SQLite before temporary
directories. Every closer is attempted even if one fails. The suites use a
five-minute test-file timeout; platform-sensitive Windows coverage is Node 24
in the relevant compatibility proof, while sweep/exact-commit runs cover all
supported Node versions.

```sh
npm run ci:plan -- BASE_SHA HEAD_SHA
npm run check:docs
npm run check:code
npm run verify
npm run verify:workspace-integration
```

For workflow names, release buttons, exact-commit validation, recovery and
rehearsal, see [release operations](RELEASE-OPERATIONS.md).

## Checking a URLCode project on GitHub

`jimhoyd-com/urlcode/action` is a composite GitHub Action for a URLCode
*site*: a repository created by `urlcode init`, holding `package.json`,
`package-lock.json`, `host.mjs` and the route project in `app/`. It installs
exactly what the lockfile pins, checks the add-ons against the runtime's pins,
runs the same local checks you run by hand and, on pull requests, keeps one
comment up to date with the route-inventory diff against the base branch. It
needs no cloud credentials; the only token it touches is the workflow's own
`GITHUB_TOKEN`.

The starter ships it as `.github/workflows/urlcode.yml`, which `urlcode init`
copies with the action pinned to the release tag of the runtime that ran it:

```yaml
name: urlcode
on:
  push:
  pull_request:
permissions:
  contents: read
  pull-requests: write # the sticky route-diff comment; drop it to only log the diff
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: jimhoyd-com/urlcode/action@vX.Y.Z # the runtime release tag; init writes its own version here
        with:
          expect-routes: 2
```

The action lives at `action/action.yml` in the runtime repository, so the
reference is `jimhoyd-com/urlcode/action@<ref>`. Pin `<ref>` the way you pin
the runtime: a release tag or a commit SHA, never `main`. Replace `vX.Y.Z` in
these examples with the release you depend on, and move it together with the
runtime version in `package.json` when you upgrade.

## What it runs

| Step | Command | Fails the job when |
|---|---|---|
| Install | `npm ci --ignore-scripts` in the site | `package-lock.json` is missing, dependencies do not install, or the site does not depend on `@jimhoyd/urlcode` |
| Add-ons | `urlcode extensions list --strict` and `urlcode artifacts list --strict` | An add-on does not match the runtime's pin, is installed as a nested copy, has drifted between `package.json`, `app/urlcode.yaml` and `host.mjs`, or an artifact is not inert |
| Validate | `urlcode validate --project app` (plus `--host-file` when set) | The YAML, includes, functions, bindings or extension configuration do not load |
| Test | `urlcode test --project app` (plus `--host-file`) | A `tests/requests.json` fixture fails |
| Audit | `urlcode audit --project app --expect-routes N --compliance <profile>` (plus `--host-file`) | Count mismatch, failed generated check, uncovered active route/method, or a `high` compliance finding without `compliance-warn` |
| Route diff | `urlcode routes --compare base.json --format markdown` | Never; it reports |

Every command is the CLI documented in [readiness](READINESS.md),
[compliance](COMPLIANCE.md) and [add-ons](EXTENSIONS.md#add-ons-extensions-and-artifacts);
the action adds no check of its own. `--origin` is passed to validate, test and
audit when set. Steps run with `bash`, so the action works on the Linux, macOS
and Windows runners.

The runtime and every add-on come from the site's `package-lock.json`; no
install script ever runs. Without a `host-file` input, a project that declares
extensions is validated statically, each extension's configuration and route
policies checked against its installed `urlcode.json` schemas with no extension
code running, and `test` and `audit` are skipped with a notice. With
`host-file: host.mjs`, validate, test and audit activate the installed
extensions through the host; the action computes `PROJECT_SHA256` from the
checked-out project for that run only, and the workflow must provide any
secrets the host reads (for example through `env`). A site that declares no
extensions runs all three either way.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `site` | `.` | Directory holding the site's `package.json`, `package-lock.json` and `host.mjs`, relative to the workspace; the route project is always `<site>/app` |
| `host-file` | empty | Operator host relative to the site (usually `host.mjs`); empty checks declared extensions statically and skips test and audit when the project declares extensions |
| `node-version` | `26` | Passed to `actions/setup-node` |
| `expect-routes` | empty | `audit --expect-routes N`; empty skips the count check |
| `allow-empty-project` | `false` | Permit only the initial `no-active-routes` audit result; remove after adding the first active route |
| `compliance` | `baseline` | `baseline`, `strict`, `privacy` or `none` |
| `compliance-rules` | empty | Absolute path to an operator rules module outside the project |
| `compliance-warn` | `false` | Report findings without failing (`--compliance-warn`) |
| `origin` | empty | Public origin of the deployment under review |
| `route-diff` | `true` | Post the route diff on pull requests |

Output `route-diff` is the path of the Markdown diff on a pull request, empty
otherwise, for a later step that wants to upload or reuse it.

## The sticky comment

On `pull_request` events the action fetches the base commit, checks it out into
a temporary git worktree, runs `urlcode routes` there and on the head with the
head's runtime, and renders `routes --compare` as Markdown: one table each for
added, removed and changed routes, or "No route changes". A changed route lists
each differing field (handler, methods, state, `sandbox`, `sandboxReason`,
middleware count, policies, generated marker or policy description) with its
before and after value.

`action/comment.mjs` then finds the pull request's comments for the marker
`<!-- urlcode-route-diff project="<project>" -->` and updates that comment,
or creates it on the first run. The key is the project directory, so a
repository with several projects gets one comment per project and never a
pile of stale ones. Updating comments needs `pull-requests: write`; on a
fork's pull request or without that permission the API answers 403 or 404 and
the step logs a notice and exits 0, leaving the diff in the job log. The same
happens when the base commit is not reachable or its YAML does not load with
the head runtime. The diff is generic: only the action knows about GitHub.

## Custom compliance rules

Write a rules module as [compliance](COMPLIANCE.md#writing-custom-rules)
describes and keep it outside the audited project, because it runs as trusted
host code. The project is `app/`, so a file elsewhere in the site checkout
qualifies; pass the absolute path:

```yaml
      - uses: jimhoyd-com/urlcode/action@vX.Y.Z
        with:
          expect-routes: 25
          compliance: strict
          compliance-rules: ${{ github.workspace }}/ci/rules.mjs
          compliance-warn: true
```

`ci/rules.mjs` is inside the checkout but outside `app/`, so it is accepted. `compliance-rules` alone implies
`compliance: baseline`; `compliance: none` without rules skips the compliance
section entirely.

## Exit codes

The job fails when the add-on check, validate, test or audit exits nonzero;
the [audit exit codes](COMPLIANCE.md#exit-codes) apply unchanged. The route
diff and the comment never fail the job. A failing install (missing
`package-lock.json` or `@jimhoyd/urlcode` dependency) fails the job before any
check runs.

## The same checks locally

From the site directory:

```sh
npx urlcode extensions list --strict
npx urlcode artifacts list --strict
npx urlcode validate --project app --host-file host.mjs
npx urlcode test --project app --host-file host.mjs   # quiet: failing cases and a summary; add --verbose for every request log
npx urlcode audit --project app --host-file host.mjs --expect-routes 2 --compliance baseline
git stash && npx urlcode routes --project app > /tmp/base.json && git stash pop
npx urlcode routes --project app --compare /tmp/base.json --format markdown
```

Or `make validate`, `make test` and `make audit ARGS='--expect-routes 2'`
from the starter Makefile. The runtime repository exercises the action on
full-lane pull requests (`.github/workflows/ci.yml`, job `action`) against a
site built from the packed runtime and add-ons (`scripts/pack-addons.ts --site
… --with ui,store`), once with extensions checked statically and once through
`host.mjs`, and `test/action.test.ts`
checks that `action.yml` is a composite action with the inputs above and that
every third-party action it or the starter workflow uses is pinned to a
commit.
