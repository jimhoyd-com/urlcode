# Contributing

URLCode is licensed under the Apache License 2.0. By submitting a contribution,
you agree that it may be distributed under that license and represent that you
have the right to submit it.

Use Node.js 22.18+ (the source is TypeScript, run directly through Node's type
stripping; CI targets 22, 24 and 26). Installed packages still run on 22.13+:

```sh
make dev         # installs dependencies and runs the bare starter (starters/default) under the watcher
# In another terminal:
make verify
make test-package
```

`starters/default` has zero routes, so `make dev` starts a server with nothing
to request yet — it proves the toolchain and watcher, not a working demo. To
see a route respond, point it at a populated project instead, for example
`make dev PROJECT=examples/cookbook`.

To run a single test file instead of the whole suite, call Node's test runner
directly with the same type-stripping flag `npm test` uses:

```sh
node --conditions=development --test test/cli.test.ts
```

Without Make, use `npm ci`, `npm run dev`, `npm run verify` and
`npm run test:package`. See [local development](docs/LOCAL-DEVELOPMENT.md) for
project/port overrides and the independent app workflow.

Verification runs ESLint, the TypeScript type check (`npm run typecheck`,
strict, over `src`, `scripts` and `test`), syntax/JSON checks and
unit/real HTTP tests; keep all of it green. `npm run typecheck:tooling` also
type-checks (`allowJs`/`checkJs`) the build/release tooling written as plain
`.mjs` (`action/comment.mjs`,
`packages/*/scripts/*.mjs`); recipe and example `.mjs` files stay lint-only
for now. All package tsconfigs, including this one, extend the shared
`tsconfig.base.json`. There is no build in the local
loop: `npm run dev` runs `packages/core/src/cli.ts` directly. `npm run build` emits `dist/`,
the JavaScript the package and container run, plus its declarations; `dist` is
never committed. Package verification builds, installs an actual archive in a
temporary directory and checks the starter and a TypeScript consumer of the
shipped declarations. It needs npm registry access. Default runtime tests use only local
HTTP/fake services; no hosting account, DB or ngrok. Framework
comparisons, authoring evals and their evidence are kept in a private
maintainer repository.

Keep changes consistent with the [implemented contract](docs/SPECIFICATION.md)
and [roadmap](ROADMAP.md). Add behavior/conformance tests for routing changes and
update docs when support changes. Do not claim a provider or OS is supported
without a passing test run. Preserve portable behavior and useful self-hosting.

Use synthetic data. Never commit secrets, customer URL collections or local
environment files. Project function and middleware code runs trusted in Node by default. Preserve
explicit `sandbox: true` isolation: never add a host-execution fallback for that
mode. Binding grants come from operator policy outside the project and govern
what URLCode injects, not ambient access by trusted code. Extend adversarial
tests with every new sandbox guest/host bridge. See the
[security model](docs/FUNCTION-SECURITY.md).

## Maintaining the starter

`starters/default` is the only starting point: `urlcode init` copies it from the
installed runtime, so a new site always matches the runtime that created it.
There is no separate template repository to keep in step.
`starters/default/AGENTS.md` and `.mcp.json` are generated from
`packages/core/src/agents-guide.ts` and checked by test. The Claude marketplace
skills are derived from `.claude/skills/`. When either source changes (including
the capability catalog, policies or starter routes), run `npm run docs:agents`
and commit every resulting asset; do not hand-edit a derived copy.
The richer asset demo lives in `examples/assets`, not a selectable starter.
Old starter-dynamic/starter-redirects branches are historical and no longer
maintained; do not use them in onboarding or publish further subtree updates.

## Changing an add-on

Extensions (`packages/<name>`) and artifacts (`artifacts/<name>`) are add-ons
at core's version; see [add-ons](docs/EXTENSIONS.md#add-ons-extensions-and-artifacts).
A new or changed add-on must follow the
[generic add-on authoring rules](docs/EXTENSIONS.md#generic-add-on-authoring-rules)
and pass its [author checklist](docs/EXTENSIONS.md#author-checklist).
An extension's `urlcode.json` is generated from its `defineExtension`
definition, and the store-schema artifact's schema from the store extension:
after changing a name, description, `requires`, schema, policy schema, hooks or
authoring contract, run `npm run build:addons` and commit the result. CI fails
on a stale descriptor. `npm run verify:addons` packs core and every add-on as a
release does and runs the end-to-end site integration.

## Keep authoring documentation executable

When changing YAML fields, update schema and semantics, run `npm run docs:reference`,
and add a runnable example/response fixture in `examples/cookbook` where appropriate.
`npm run verify` rejects a stale generated field reference. `npm run docs:llms`
regenerates the consolidated `llms-full.txt`, and verify rejects a stale copy of it too. For a documentation PR, rebase onto current `main` and run `npm run docs:llms` as the final pre-merge step; do not hand-merge the generated bundle. CI runs cookbook tests
and its expected-count audit on supported Node/OS combinations; package checks
verify the cookbook and AI authoring resources ship. Keep unsupported features
explicit in `docs/AI-AUTHORING.md`; never present future roadmap fields as valid YAML.

## Documentation

Documentation lives in `docs/` in this repository. Write public guides,
references, recipes, contributor instructions, operational runbooks and the
generated `YAML-REFERENCE.md` here. Keep private strategy, internal research and
detailed dated review notes in the maintainer repository; they never replace a
public behavior, security or operations contract.

A behavior change that a reader depends on is not finished until the matching
page in `docs/` is updated. Put both in the **same** pull request so review can
see both halves and neither can land alone.

### Maintain existing pages first

Before creating a page, search the docs and update the existing home for the
reader's task. A new page needs a distinct purpose and a link from the relevant
guide or index. Routine task summaries and verification transcripts belong in
the pull request, not a new permanent report.

Keep each kind of information in its authoritative home:

| Information | Home |
|---|---|
| Implemented behavior and accepted fields | Specification, topic contracts and generated schema reference |
| How to accomplish a task | The existing guide or executable recipe |
| Current versions and publication state | Manifests and the commands in [version alignment](docs/VERSION-ALIGNMENT.md) |
| Actionable bugs and proposed work | GitHub issues; the roadmap links to priorities rather than copying task lists |
| Unresolved design choices | [Open decisions](docs/OPEN-DECISIONS.md), linked to the relevant issue |
| Security and operational evidence | Dated, scoped evidence records and the readiness register |
| Completed or superseded plans | The private maintainer record, with a link to the current owner of any remaining work |
| Private strategy, research and detailed internal reviews | The private maintainer repository; do not cite it as public evidence |

Link to these sources instead of copying changing status or entire explanations.
Examples and brief task-specific explanations are useful; a second maintained
version table or backlog is not. Do not treat archiving a plan as closing its
unperformed security or deployment checks.

GitHub Issues are the only tracker for actionable defects, gaps, feature
requests and follow-up work. Do not add repository-local issue files, backlogs,
or duplicate issue bodies. Evidence records may link to the owning GitHub issue,
but the issue itself and its changing status belong on GitHub.

When a decision is implemented, update the reader-facing guide and remove its
obsolete next steps. Preserve useful rationale and evidence with an explicit
status; do not leave historical proposals presenting themselves as current
instructions. Avoid moving files only for tidiness: existing links and anchors
are part of the documentation interface.

Run `npm run check:docs` after documentation changes. It checks local links,
retired repository references, guidance claims and generated resources. These
checks cannot prove prose is current: review the affected facts against code
and evidence too. Reviewers should ask which page owns the changed information
and whether this PR introduced a competing explanation.

### Preserve implementation portability

Core behavior is a contract, not an implementation-language requirement. When
changing a major semantic seam, update the corresponding card in
[runtime implementation](docs/RUNTIME-IMPLEMENTATION.md), its authoritative
semantic documentation and its narrowest relevant fixture. A target that cannot
enforce a behavior must refuse it before serving; do not silently approximate it.

Keep language-neutral implementation instructions and source maps in that
contributor guide, not as extensive comments in `packages/core/src/`: Node's type-stripping
build preserves source comments in `dist/`. The guide and its test guard are
not part of the npm tarball or production container. Trusted Node guest modules
and the opt-in sandbox are separate execution modes, not a portable
cross-language guest-code guarantee.

If live documentation names the current release version, wrap its complete
paragraph or fenced example in the `urlcode-current-version:start` and
`urlcode-current-version:end` HTML comments documented in the
[development pipeline](docs/DEVELOPMENT-PIPELINE.md#current-version-references-in-documentation).
`npm run release:bump` discovers and updates every tracked marked block. Keep
changelogs and archived plans unmarked.

`urlcode-docs` was deleted on 2026-09-19. It held its own copy of most of these
pages and had drifted from them; the content that was ahead has been brought
across, and the repository was retired rather than reconciled page by page.
Links to it no longer resolve.

If you find a gap you cannot close, file it as an issue on the repository that
owns the code rather than leaving it undocumented. Feature requests are wanted:
if you had to hand-write application code that the URLCode vocabulary could have
owned, say so and include the YAML.

## Pull requests and review

Work on a branch and open a focused pull request. Explain the problem, resulting
behavior, validation and compatibility/security implications. Never include real
credentials or customer data. Use the PR template and keep unrelated changes out.

`main` requires a pull request, the `verify-complete` and `container` checks,
CodeQL results and resolved conversations. The current ruleset does not require
an up-to-date branch. [Repository CI](docs/CI.md#checking-this-repository)
describes the fast prose lane, full code lane and exact-commit release gate. High/critical
security findings and error-level CodeQL alerts block merging. Force pushes and branch
deletion are blocked; squash merging keeps a linear history. Administrators have
no configured ruleset bypass. Automation cannot approve pull requests.

Pull request titles become the lines of the GitHub-generated release notes, so
write them for readers. A release is a pull request containing only
`npm run release:bump -- <version>`; merging it publishes that version (see
[release operations](docs/RELEASE-OPERATIONS.md)).

The project currently has one maintainer, @jimhoyd. CODEOWNERS identifies the
responsible reviewer, but no second-person approval is required while there is
only one maintainer; this is not an independent review guarantee. Require an
independent approval when another trusted maintainer joins. Security-sensitive
changes warrant independent review before production use regardless of CI.

See [governance](GOVERNANCE.md) and the [code of conduct](CODE_OF_CONDUCT.md).
