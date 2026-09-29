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
reviewed compressed, unpacked or file-count budgets. It also reads every packed
Markdown file and `llms.txt` and fails on a relative link whose target the
archive does not contain: an installed copy has only the packed files. Ship the
target, or link this repository's `blob/v<current version>/...` as a reference
definition inside a `urlcode-current-version` block (below), which
`check-local-links` checks against the checkout. A new extension fails until
its reviewed policy is added. Increase a budget only with a reviewed explanation
of the new installed requirement; do not use budget headroom instead of updating
the allowlist.

`scripts/pack-addons.ts`, which packs core and every add-on into tarballs for
the integration tests, the CI action job and `npm run release:pack`, packs with
`--ignore-scripts` like every other pack here: it packs the `dist/` a checkout
already has and never builds. Build first, with `npm run build` for core and
`node scripts/workspaces.ts run build` for the add-ons. It refuses, before
packing anything, a package whose `exports` or `bin` name a file that is not
there, and names each missing file and the build that makes it (#960). It does
not detect a stale build: `dist/` older than its source still packs.

## Current-version references in documentation

When reader-facing Markdown must name the current core version, wrap the
smallest complete paragraph or fenced example containing it with
`urlcode-current-version:start` and `urlcode-current-version:end` HTML comments
on their own lines. `npm run release:bump` discovers these markers in every
tracked Markdown file and `llms.txt`, so a newly added guide needs no
central file-list update. It replaces the old core version only inside marked
blocks. The bump then regenerates `llms-full.txt` from its sources: it keeps the
source markers, and its `Source:` lines and rewritten relative links name the
release tag (`blob/v<version>/`), read from `package.json` by
`scripts/build-llms-full.ts`.

`node scripts/release-bump.ts --check` fails when markers are unbalanced, a
marked block does not contain the manifest's current version, a tracked
Markdown file or `llms.txt` mentions that version outside a marker, or
`llms-full.txt` differs from a fresh build. Add markers in the same
pull request as a new current-version reference. Changelogs are not scanned.

A link to this repository from a file the package ships, `llms.txt` and
`llms-full.txt` included, names the release tag, never `blob/main`: an
installed copy should read the docs of its own version, and main may already
describe the next one. There is one copy of each index. The repository's own
`llms.txt` is the same file the package ships, and a reader of a checkout has
the pages under `docs/` directly, so there is no separate main-branch copy.

Text the runtime prints or generates follows the same rule. CLI output,
capability reasons, compliance references and exported OpenAPI descriptions
link a page as `docsUrl('HTTP.md#error-format')` from
`packages/core/src/release.ts`, which builds this release's
`blob/v<version>/docs/...` URL from `CORE_VERSION`, the one version literal in
core's source that the bump rewrites. The package audit parses every packed
script and fails when a string or template literal (not a comment) names a
`docs/*.md` page the package does not ship (#938).

Other packed text follows it too (#948): schema descriptions, which an editor
shows on hover, comments in example and starter YAML, the llms indexes and every
other packed file that is neither Markdown nor code. They have no marker blocks,
so they carry this release's full URL,
`https://github.com/jimhoyd-com/urlcode/blob/v<version>/docs/...`, and
`release:bump` rewrites every such link in tracked non-Markdown text (JSON,
YAML, TXT, TOML, HTML, CSS; not this repository's tests, scripts or workflows);
`--check` fails when one names another version. `npm run docs:reference` turns
a schema description's pinned URL into a reference link labelled by its
`docs/` path, defined in the page's marker block, so `YAML-REFERENCE.md` names
the version once. `scripts/build-llms-full.ts` links a bare `docs/X.md`
mention in prose, or a code span holding only that path, to the release tag
when the package does not ship the page. The package audit reads every other
packed text line, fenced or not, and fails on a `docs/*.md` mention of a page
the package does not ship that is not a link label, and on a main-branch link
outside a `package.json` (a manifest's `homepage` names the project).
TypeScript declarations are code, and their comments are not read.

The release procedure is in
[release operations](RELEASE-OPERATIONS.md#release-a-version).
