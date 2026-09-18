# Next steps: closing the gaps

Status: plan written 2026-09-18 from the cleanup, the
[usability review](USABILITY-REVIEW.md) and the AI-first framework brief.
Each item says what it fixes, where the work is, how it is proven, and its
size (S: a day, M: a week, L: more). Phases can overlap; order inside a phase
is the recommended sequence. The [roadmap](../ROADMAP.md) owns what ships;
this page owns how the gaps close.

## The rule everything below serves

> AI should describe intent, not regenerate infrastructure.

Coding agents rebuild the same routing, validation, middleware, auth plumbing,
policies, admin patterns and deployment glue on every project. URLCode's job
is to make those a bounded, deterministic, portable contract in readable
YAML, so an agent spends its context and generated code on the part that is
actually the application. The corollary that decides what gets built:

> If agents repeatedly generate substantially the same infrastructure, that
> behavior becomes a URLCode primitive, policy, recipe or extension. If not,
> it stays application code.

And the hierarchy every agent is taught, in this order: native primitive,
recipe, small custom function, general application code. Nothing here weakens
the security model: guest code stays untrusted, grants stay operator-owned,
agents cannot self-authorize, unsupported behavior fails with the route named,
and inspection tooling never becomes a privilege escalation path.

## Phase 1: agent discovery (S each, no contract changes)

What exists: `llms.txt`, `AGENTS.md` (for working on the runtime),
`docs/AI-AUTHORING.md`, `docs/FRAMEWORK.md`, the JSON Schema, the generated
field reference, the cookbook, recipes, `validate`/`test`/`audit`, MCP
read-side tools (`inspectProject`, `validateProject`, `explainRoute`,
`getCapabilities`, `previewImport`/`previewExport`, `listRecipes`/`showRecipe`).
Keep all of it. The gap is that an agent still has to read documents to find
facts the runtime already knows.

### 1.1 Application-level `AGENTS.md` from `urlcode init` (S, core)

Fixes: a project made with URLCode is not self-describing to Claude Code,
Codex or any repository-aware agent. Today's `AGENTS.md` explains how to work
on the runtime, not on an application.

- Work: `urlcode init` (and `init --with`, 2.3 below) writes `AGENTS.md` into
  the project: inspect `urlcode.yaml` first; run `urlcode context` (1.3);
  check capabilities and search recipes before writing code; prefer native
  handlers; never recreate routing, validation, middleware, policies or
  authentication the runtime provides; validate, test, audit; report
  unsupported requirements instead of inventing fields; never create or
  approve grants. Generated from the installed runtime's capability list so
  it names only what that version has.
- Proof: starter test asserts the file exists and lists the commands; the
  public `urlcode-template` gets the same file.

### 1.2 `llms-full.txt` and clean Markdown for the docs site (S, core; S, urlcode-docs)

Fixes: `llms.txt` must stay a compact index, but an agent that wants complete
context has to fetch forty files.

- Work: `scripts/build-llms-full.ts` concatenates the authoring documents
  (framework, AI authoring, YAML guide, field reference, specification,
  routing, HTTP, middleware, assets, dynamic links, policies, extensions) in
  reading order with a table of contents; checked in `npm run check` for
  staleness like the field reference. The docs site serves `/docs/<page>.md`
  beside `/docs/<page>` so agents never parse HTML. Do not adopt `agents.txt`
  or similar until a convention settles.
- Proof: `npm run check` fails on a stale `llms-full.txt`; token estimate
  recorded in the file header.

### 1.3 `urlcode context` with a token budget (M, core)

Fixes: the central gap. An agent needs a handful of facts about this project
and this runtime and spends tens of thousands of tokens reading documentation
to get them.

- Work: `urlcode context [--project DIR] [--budget N] [--json] [--stats]`
  emits deterministic YAML (or JSON): runtime and schema version; project
  summary (route count, handlers used, extensions declared, policies in
  effect, custom functions and middleware files, bindings requested);
  constraints that matter for generation (no guest network or Node APIs, no
  regex routes, path shape, one handler per route, no interpolation); target
  support for the project's features; and the exact `validate`/`test`/`audit`
  commands with the intentional route count filled in. `--budget` drops
  sections in a fixed order (per-route detail, then target table, then
  constraints prose) until the estimate fits; estimation is a documented
  characters-per-token approximation, no tokenizer dependency. `--stats`
  prints the estimated size of the documentation corpus versus the emitted
  context, labeled as estimates. Derived from the compiled project and the
  capability catalog, never from prose.
- Proof: snapshot tests for the cookbook and the starter; a test that the
  same project yields byte-identical output twice; budget test that output
  never exceeds the estimate; MCP tool `get_context` returns the same data.

### 1.4 Capability and schema fragment queries (M, core)

Fixes: `urlcode capabilities` reports target support per handler; an agent
cannot ask "what does `throttle` accept, where does it run, which recipe
shows it" or "give me only the schema for `redirect`".

- Work: `urlcode capabilities <name> [--json]` extends the existing catalog
  entry with the schema fragment, constraints, required grants, per-target
  support, known unsupported behavior and related recipes and examples.
  `urlcode schema <path>` (`route`, `redirect`, `middleware`, `policies.cache`,
  `extensions`) returns only that fragment of `schemas/urlcode.schema.json`,
  resolving `$ref`s. Both derive from the schema and the catalog; nothing is
  hand-maintained. MCP gains `get_capability` and `get_schema`.
- Proof: a test that every capability name resolves and every fragment is
  valid JSON Schema; a size test that no fragment exceeds a fixed byte cap.

### 1.5 The URLCode agent skill (S, core `skills/urlcode/`)

Fixes: agents that support skills have no packaged instruction for URLCode.

- Work: a small skill (under 150 lines) that teaches the loop: recognize a
  project by `urlcode.yaml`; run `urlcode context`; query a capability;
  search recipes and examples; prefer YAML; write minimal functions; validate,
  test, audit; respect grants and never approve one; report unsupported
  requirements. It tells the agent how to retrieve the minimum, and links
  nothing else. Ship in the package under `skills/` and reference it from
  the generated `AGENTS.md`.
- Proof: the authoring evals in Phase 5 run with and without the skill.

## Phase 2: make the ladder real (no contract changes)

### 2.1 Publish the three extension packages (decision, S)

Fixes: every install step in the "add accounts" row of the usability review
except the revision pin. Today a person or an agent clones three private
repositories, runs `pack-sources.mjs` with four paths and a SHA, and installs
four tarballs.

- Decide: publish `@jimhoyd/urlcode-ui`, `-auth`, `-admin` as `0.1.0-alpha.N`
  to npm with provenance, from tags on `main`, keeping the "private until
  reviewed" caveats in each README and status file. An alpha on npm is a
  distribution channel, not an endorsement.
- Work: copy core's `release.yml` shape into each repo (candidate build, npm
  audit, `npm pack`, attest, publish behind a repository variable). Drop
  `"private": true` only in the release commit. Set real peer ranges.
- Proof: a clean directory installs core and auth from the registry and runs
  `urlcode-auth init`, `bootstrap`, `serve`; admin's
  `scripts/clean-project-acceptance.mjs` runs against the published tarballs.

### 2.2 One place for peer revisions (S)

Fixes: three disagreeing lists of verified peer commits (the CI workflows,
`ACCEPTANCE.md` in auth and admin, the pack script's core-revision check).

- Work: `peers.json` in auth and admin; the workflows read it; the pack
  script defaults from it; `ACCEPTANCE.md` links to it. Once 2.1 ships,
  replace SHAs with published versions and delete the file.

### 2.3 `urlcode init --with auth,admin,ui` (M, core plus each extension)

Fixes: three initializers with three directory conventions; no single command
produces the layered project the framework page describes.

- Work in core: `--with a,b,c` resolves the installed
  `@jimhoyd/urlcode-<name>` from the invoking directory and calls its
  `scaffold` export (a small documented contract returning a YAML fragment,
  host imports and entries, and a README section). Core merges fragments into
  `urlcode.yaml`, writes one `host.mjs`, one `README.md`, the `AGENTS.md`
  from 1.1, and prints the `inspectExtensionRevision` SHA. A missing package
  refuses with the install command; core never imports the packages at build
  time. Each extension exports `scaffold` built from its existing `init`.
- Proof: a core test with a fake `@jimhoyd/urlcode-demo` package in a temp
  `node_modules`; each extension tests that its `scaffold` output validates
  with core; admin's clean-project acceptance uses the new command.

### 2.4 Print extension schemas: `urlcode extensions` (M, core)

Fixes: an agent cannot discover what `extensions.auth.config` accepts without
reading auth's source; `urlcode mcp` cannot serve it.

- Work: `urlcode extensions --host-file … [--json]` loads the host file as
  `validate` does and prints each registration's name, contract version,
  targets, configuration schema and policy schema; the same data through the
  SDK and an MCP tool. Folds into `urlcode context` and `capabilities auth`
  when a host file is given.
- Proof: test against the `examples/extensions` demo registry.

## Phase 3: retrieval instead of reading (M each, core)

### 3.1 Recipes as the vocabulary of common behavior

Fixes: four bundled recipes with a README each and no metadata; an agent
cannot search them, and nothing tells it to look before generating.

- Work: every recipe gains `recipe.yaml`: `id`, `description`,
  `capabilities`, `tags`, `complexity`, required external services, grants,
  configuration inputs, files, target compatibility, tests and expected
  behavior. `urlcode recipes search <text>` matches id, description, tags and
  capabilities locally (no AI service); `show` prints the metadata first.
  MCP gains `search_recipes`. Grow the catalog from observed repetition (see
  Phase 6), starting with: authenticated JSON endpoint, webhook receiver with
  signature check via `proxy`/signals, contact form to a signal, protected
  download, health and readiness page, CORS API, static site with API.
- Proof: schema for `recipe.yaml` checked in `npm run check`; a search test
  per recipe; every recipe still validates, tests and audits.

### 3.2 Examples become searchable the same way

- Work: `examples/*/example.yaml` with the same metadata shape; `urlcode
  examples search <text>` returns the smallest matching runnable example and
  its route. The cookbook's forty routes get per-route tags in one index file.
- Proof: search test; count audit unchanged.

### 3.3 `urlcode explain` from compiled semantics

Fixes: `explainRoute` exists in the SDK and MCP; there is no CLI, and the
output repeats matching rather than effective behavior.

- Work: `urlcode explain [/route] [--json]` prints, per route, the effective
  methods, handler, middleware chain, validated inputs, policies in effect
  (including `extensions.auth` requirements when a host file is given),
  cache and no-store outcome, bindings and target support, derived from the
  compiled IR. Whole-project form lists every route in one screen.
- Proof: snapshot tests on the cookbook; a test that `explain` and the
  runtime agree on methods and policies for every route.

### 3.4 A generated semantic manifest

- Work: `urlcode manifest [--json]` (also written by `build` and offered by
  MCP as `get_manifest`) emits routes, capabilities, recipe provenance,
  external requirements, custom functions, requested bindings, target
  compatibility and the revision digest. Generated only; never checked in as
  a source of truth. `context` is a budgeted view of the same data.
- Proof: manifest equals `inspectProject` output for the same project;
  digest equals `inspectExtensionRevision`.

### 3.5 MCP authoring layer, separately authorized (M, core)

Fixes: MCP is read-only by design; an agent that wants to add a recipe or a
route still has to write files by hand.

- Work: keep the read side as is and add the new read tools above. Add an
  authoring server mode enabled only by an explicit flag on the operator's
  command line (`urlcode mcp --allow-authoring --project DIR`): `add_recipe`,
  `create_route`, `scaffold_feature` (writes YAML and placeholder files
  through the existing scaffold path), and `validate`/`test`/`audit` runners.
  Every write is confined to the selected project, refuses paths outside it,
  never touches operator files, grants, policies or host files, and returns
  the validation verdict. Nothing in either mode reads secrets, creates
  grants, deploys, or changes operator security policy.
- Proof: tests that authoring tools are absent without the flag; path
  confinement tests; a write followed by `validate` in one call.

## Phase 4: fewer lines for the common case (schema additions, `version: "1"` stays valid)

### 4.1 Short form for function routes (M, core)

Fixes: the smallest function route is ten lines.

- Work: `function: functions/hello.mjs` as a string expands every `{param}`
  to a required bounded string parameter and matching `args` entry; same for
  `middleware: [functions/x.mjs]`. The long form stays the canonical IR;
  `routes`, `audit`, `explain` and the field reference show the expansion.
- Proof: generated reference updated; cookbook gains a short-form route with
  fixtures; a test that short and long forms compile to identical IR.

### 4.2 Semantic over implementation configuration (rule, ongoing)

Every new field describes intended behavior (`auth: required`), never a
provider or framework knob. Review new YAML fields against this in PR
templates and the AI authoring matrix.

## Phase 5: measure whether it works (M, core `benchmarks/agent/`)

### 5.1 Agent benchmark

Fixes: no evidence that URLCode saves agent effort; no defensible number.

- Work: 10 to 20 representative tasks (redirect service, shortener, webhook
  receiver, small API, static plus API, OAuth-enabled app, CRUD backend,
  admin backend, download service, API proxy, contact form, authenticated
  endpoint). Each task has a prompt, an acceptance test and two harness
  configurations: conventional (agent free to pick a stack) and URLCode
  (agent with the skill and `urlcode context`). Capture input, output and
  total tokens, generated lines and files, wall time, turns, retries, test
  pass rate, custom infrastructure lines, and a checklist of obvious security
  mistakes. Store raw runs under `benchmarks/agent/runs/` with model, date and
  harness version. Publish only numbers the stored runs support.
- Proof: a reproducible runner script; a README that states what the numbers
  are and are not.

### 5.2 Authoring regression evals

- Work: prompts for common requests ("add a redirect", "add an authenticated
  endpoint", "serve this directory", "add middleware", "create a webhook
  endpoint") scored on: native functionality chosen, valid YAML, no
  unsupported fields, no unnecessary JavaScript, no boundary violations,
  tests written, validation run, provider limits respected. Run in CI on a
  schedule, not per push; a new feature must not lower the pass rate.

## Phase 6: grow from observed repetition (rule, ongoing)

When building an application with URLCode, record every place an agent still
generated commodity infrastructure and classify it: missing primitive,
policy, recipe, capability, documentation, example, integration, or
legitimately application-specific. Keep the log in `docs/REPETITION-LOG.md`
with the project, the code that was written and the classification. Candidate
areas the brief lists (CRUD, webhooks, email, uploads, jobs, pagination, API
envelopes) are built only when the log shows them repeating. The application
data question is the first entry:

### 6.1 Spike: a declared `collection` handler with an admin view (M to write, L to build)

"Full-fledged application" today means "site with accounts". Write
`docs/SPIKE-COLLECTIONS.md` against the same principles as links: YAML
declares a collection with a JSON Schema for records, exact bounded query and
mutation routes, operator-owned SQLite, no guest queries; admin registers a
generic records screen; functions receive records as validated `args`. It
must answer portability to serverless targets, limits, schema migration and
whether links become a collection. Decide after review; build nothing first.

## Phase 7: one presentation story (extension repos)

### 7.1 Shared markup helpers into urlcode-ui (S)

`hiddenField`, `postForm`, `withDeadline` in the ui main entry; auth and
admin drop their copies (`admin-markup.ts`, `admin-deadline.ts`).

### 7.2 Auth and admin render through the kit (L)

Auth exports its catalogue and templates with view models, takes an optional
`ui` from the host, and renders with `ui.kit.page` when present; admin the
same. Needs the runtime change first: an immutable-cache exception for hashed
extension assets (core, S). Proof: `urlcode-ui doctor` shows full coverage;
existing HTTP tests pass under both render paths; a themed browser
walkthrough. Retire the `presentation` option one minor version later.

## Phase 8: evidence still missing (unchanged from issue 58)

| Gap | Plan | Owner and size |
|---|---|---|
| Browser and device WebAuthn coverage | Playwright with a virtual authenticator in auth CI; one manual pass on Safari and Android | auth, M |
| Accessibility assessment | Automated axe pass in the browser walkthroughs plus one manual screen-reader and forced-colors pass | ui, auth, admin, M |
| Soak, backup and recovery on a deployment | `operational-drills` with `URLCODE_SOAK_SECONDS=3600` on a real host; auth's recovery drill against a restored snapshot | core and auth, M |
| Provider deployments | Deploy `examples/provider-conformance` to one Vercel, AWS and Cloudflare account; run `verify-provider` | core, M, needs accounts |
| Live Google, Apple and SES | Deferred by the owner; synthetic signed fixtures stay | auth, later |
| Independent security review | `SANDBOX-REVIEW.md` is the package; commission one reviewer before any non-alpha auth release | all, L, external |

## Phase 9: hardening left from the audit (core, S each)

- Direct tests for the sandbox pool, worker crash recovery and timeout kill
  path (`src/functions.ts`, `src/function-worker.ts`, `src/guest-api.ts`).
- Tests for `src/link-store-worker.ts` behind the WAL gate.
- Re-verify the remaining line-number rows in `STANDARDS.md`; cite symbols.
- Split the three longest reference documents (YAML guide, policies, dynamic
  links) into task pages under 200 lines, so retrieval returns one page.
- A pre-test check in the extension repos that fails fast with the SQLite
  requirement named.

## Sequence at a glance

```
Phase 1  AGENTS.md from init → llms-full → urlcode context → capability/schema queries → skill
Phase 2  publish alphas → peers.json → init --with → extensions --schema
Phase 3  recipe metadata + search → examples search → explain → manifest → MCP authoring
Phase 4  short-form function route
Phase 5  agent benchmark + authoring evals   (start early; run on every phase)
Phase 6  repetition log → collections spike, then decide
Phase 7  shared helpers → kit adoption
Phase 8  proof gaps, in parallel, as people and environments allow
Phase 9  hardening, in any gap
```

Phases 1 and 5 are the ones that change what URLCode is for. Everything else
makes that cheaper or proves it.
