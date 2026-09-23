# Checking a project on GitHub

For this repository's own PR checks and releases, see the
[development pipeline](DEVELOPMENT-PIPELINE.md). This page describes the action
used by applications built with URLCode.

`jimhoyd-com/urlcode/action` is a composite GitHub Action for a URLCode
*project*: a repository with a `urlcode.yaml`. It runs the same local checks
you run by hand and, on pull requests, keeps one comment up to date with the
route-inventory diff against the base branch. It needs no cloud credentials;
the only token it touches is the workflow's own `GITHUB_TOKEN`.

The starter ships it as `.github/workflows/urlcode.yml` (`urlcode init` copies
it; the [template repository](https://github.com/jimhoyd-com/urlcode-template)
carries the same file):

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
      - uses: jimhoyd-com/urlcode/action@main # pin a release tag or commit
        with:
          expect-routes: 2
```

The action lives at `action/action.yml` in the runtime repository, so the
reference is `jimhoyd-com/urlcode/action@<ref>`. Pin `<ref>` the way you pin
the runtime: a release tag or a commit SHA, not `main`, once the project is
past its first commit.

## What it runs

| Step | Command | Fails the job when |
|---|---|---|
| Install | `npm ci` in the project (see below) | Dependencies do not install |
| Validate | `urlcode validate --project <project>` | The YAML, includes, functions or bindings do not load |
| Test | `urlcode test --project <project>` | A `tests/requests.json` fixture fails |
| Audit | `urlcode audit --project <project> --expect-routes N --compliance <profile>` | Count mismatch, failed generated check, uncovered active route/method, or a `high` compliance finding without `compliance-warn` |
| Route diff | `urlcode routes --compare base.json --format markdown` | Never; it reports |

Every command is the CLI documented in [readiness](READINESS.md) and
[compliance](COMPLIANCE.md); the action adds no check of its own. `--origin`
is passed to validate, test and audit when set. Steps run with `bash`, so the
action works on the Linux, macOS and Windows runners.

The project's runtime comes from the project. With a `package.json` the action
runs `npm ci --ignore-scripts` (or `npm install --ignore-scripts` without a
lockfile) and uses the `@jimhoyd/urlcode` that resolves from there, hoisted or
not; set `ignore-scripts: 'false'` when the project's own install scripts are
required and trusted. A project without `package.json`, such as a fresh
`urlcode init`, gets the `runtime` input installed into a private prefix under
the runner's temp directory (that install always runs with
`--ignore-scripts`, regardless of the `ignore-scripts` input, since it never
executes the project's own scripts). Left empty (the default), `runtime` is
derived from the action ref you selected: `jimhoyd-com/urlcode/action@vX.Y.Z`
installs `@jimhoyd/urlcode@X.Y.Z`. A ref that is not a release tag (`@main`, a
branch, a commit) cannot be turned into a version this way, so the action
falls back to unpinned `@jimhoyd/urlcode` with a warning; pin the action to a
release tag, or set `runtime` explicitly, to avoid that. `runtime` also
accepts an absolute tarball path.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `project` | `.` | Directory containing `urlcode.yaml`, relative to the workspace |
| `node-version` | `26` | Passed to `actions/setup-node` |
| `runtime` | empty | npm spec installed when the project has no `package.json`; derived from the action ref when empty |
| `ignore-scripts` | `true` | Pass `--ignore-scripts` to the project's own `npm ci`/`npm install` |
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
host code. In a repository with the project at the root, put it in a sibling
directory and pass the absolute path:

```yaml
      - uses: jimhoyd-com/urlcode/action@main
        with:
          expect-routes: 25
          compliance: strict
          compliance-rules: ${{ github.workspace }}/ci/rules.mjs
          compliance-warn: true
```

`ci/rules.mjs` is inside the checkout but not inside the project only when
`project` is a subdirectory; with `project: .` keep the rules in a second
checkout or under `${{ runner.temp }}`. `compliance-rules` alone implies
`compliance: baseline`; `compliance: none` without rules skips the compliance
section entirely.

## Exit codes

The job fails when any of validate, test or audit exits nonzero; the
[audit exit codes](COMPLIANCE.md#exit-codes) apply unchanged. The route diff
and the comment never fail the job. A failing install (missing `@jimhoyd/urlcode`
dependency, unavailable `runtime` spec) fails the job before any check runs.

## The same checks locally

```sh
urlcode validate --project .
urlcode test --project .   # quiet: failing cases and a summary; add --verbose for every request log
urlcode audit --project . --expect-routes 2 --compliance baseline
git stash && urlcode routes --project . > /tmp/base.json && git stash pop
urlcode routes --project . --compare /tmp/base.json --format markdown
```

Or `make validate`, `make test` and `make audit ARGS='--expect-routes 2'`
from the starter Makefile. The runtime repository exercises the action on
full-lane pull requests against `examples/cookbook` (`.github/workflows/ci.yml`,
job `action`) with the packed tarball as `runtime`, and `test/action.test.ts`
checks that `action.yml` is a composite action with the inputs above and that
every third-party action it or the starter workflow uses is pinned to a
commit.
