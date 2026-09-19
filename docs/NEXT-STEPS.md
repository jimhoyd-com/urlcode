# Next steps: closing the gaps

Status: plan written 2026-09-18 from the cleanup, the
[usability review](USABILITY-REVIEW.md) and the AI-first framework brief.
Each item says what it fixes, where the work is, how it is proven, and its
size (S: a day, M: a week, L: more). Phases can overlap; order inside a phase
is the recommended sequence. The [roadmap](../ROADMAP.md) owns what ships;
this page owns how the gaps close.

## The rule everything below serves

> Your AI should build your application, not your framework.

Agents rebuild the same routing, validation, middleware, auth plumbing,
policies, admin patterns and deployment glue on every project, and the person
ends up owning it. URLCode's job is a small, deterministic, portable vocabulary
in readable YAML, so generated code goes to the part that is the application.
The agent describes what; the runtime owns how. The three tests that decide
what gets built are in [project direction](PROJECT-DIRECTION.md#why-your-ai-should-build-your-application-not-your-framework):
the boundary test (do agents generate this across unrelated projects?), the
feature test (does it reduce what the agent must know, generate, debug or
maintain?) and the evidence test (measured repetition, not a feature list).

The order below follows from that. **Prove the thesis before building on
it.** Phase 0 is the benchmark; if it shows a large saving, the rest is worth
the work, and if it shows a small one, the abstraction is not doing enough yet
and the next phases change. Nothing here weakens the security model: a
`sandbox: true` route's isolation stays exactly as strict, grants stay
operator-owned regardless of a route's trust setting, agents cannot
self-authorize, unsupported behavior fails with the route named, and
inspection tooling never becomes a privilege escalation path.

**Status 2026-09-19 (sequence).** Most of Phases 1, 3 and 4 landed before the
Phase 0 benchmark produced a single model-backed run. The instrument is built
and tested (`benchmarks/agent/harness.ts`, `benchmarks/agent/count-lines.ts`,
`benchmarks/agent/adapters/anthropic.ts`), but `benchmarks/agent/runs/` holds
only `baseline.json`, a stub record, so the application-specific code ratio is
still unmeasured and the re-prioritization 0.1 describes has never been
exercised. This is an observation about the order the work happened in, not a
change of priorities: Phase 0 still owns the evidence, and Phase 5 is still how
each shipped phase gets measured. Items below are marked from the source at this
revision.

## Phase 0: prove the thesis (M, core `benchmarks/agent/`, before anything else)

### 0.1 The agent benchmark — partly done

Done 2026-09-19, the instrument only: the runner, the counting rule, the tasks
and the storage format exist and are tested — `benchmarks/agent/harness.ts`
(`runArm`, `summarize`, `securityChecklist`, `writeRun`),
`benchmarks/agent/count-lines.ts` (`classify`, `codeRatio`),
`benchmarks/agent/adapters.ts` (`selectAdapter`, `stubAdapter`) with
`benchmarks/agent/adapters/anthropic.ts`, ten task directories under
`benchmarks/agent/tasks/`, both arm preambles under `benchmarks/agent/prompts/`,
`npm run benchmark:agent`, and `test/agent-benchmark.test.ts` ("the counting
rule: functions and declared modules are the idea, everything else is
plumbing"). The measurement is not done: `benchmarks/agent/runs/` holds only
`baseline.json`, whose `model` is `stub`, and `benchmarks/agent/README.md`
states that no number there is evidence until a stored run with a real model
adapter backs it. Running the tasks in both arms against a real model, storing
the runs and publishing only what they support remains the work below.

Fixes: there is no evidence that URLCode saves agent effort, and the whole
plan depends on it.

- Work: ten representative tasks first, twenty later: redirect service, URL
  shortener, webhook receiver, small JSON API, static site plus API,
  OAuth-protected internal app, CRUD backend, admin backend, file and download
  service, API proxy, contact form, authenticated endpoint. Each task has a
  natural-language prompt, an acceptance test suite that is the same for both
  arms, and two harness configurations: conventional (the agent picks its own
  stack) and URLCode (the agent has the skill, `urlcode context` and the
  recipes). Run each arm several times with the same model. Capture input,
  output and total tokens, generated lines and files, agent turns, retries,
  failures, wall time, tests passed, and a checklist of obvious security
  mistakes. Store raw runs under `benchmarks/agent/runs/` with model, date and
  harness version.
- The headline metric is the **application-specific code ratio**: generated
  lines that are the idea versus generated lines that are plumbing, counted
  by a documented rule (files under `functions/` and the application's own
  modules count as the idea; routing, auth, sessions, middleware, validation,
  headers, static serving, deployment and test scaffolding count as plumbing).
  Report it beside tokens and turns.
- Proof: a reproducible runner; a README that states exactly what the
  numbers are and are not. Publish only what the stored runs support.
  A result like "same application, 65 percent fewer generated lines and half
  the tokens" is the story; a result like 8 percent means the vocabulary is
  too small or too hard to discover, and Phases 1, 3 and 4 are re-prioritized
  from what the runs show the agent still had to write.

### 0.2 Authoring regression evals (S, once 0.1 exists) — done

Done 2026-09-19: the five prompts are `benchmarks/agent/evals/*.yaml`
(`add-redirect`, `add-authenticated-endpoint`, `serve-directory`,
`add-middleware`, `create-webhook-endpoint`), scored against the eight criteria
by `scoreEval` and `summarizeEvals` in `benchmarks/agent/harness.ts`, gated
against `benchmarks/agent/runs/baseline.json` by `benchmarks/agent/gate.ts`, and
run weekly by `.github/workflows/evals.yml`. Caveat: the committed baseline is a
stub record and the scheduled job skips cleanly when no model key is configured,
so the recorded pass rate proves the pipeline, not a model's behavior.

Prompts for common requests ("add a redirect", "add an authenticated
endpoint", "serve this directory", "add middleware", "create a webhook
endpoint") scored on: native functionality chosen, valid YAML, no unsupported
fields, no unnecessary JavaScript, no boundary violations, tests written,
validation run, provider limits respected. Run on a schedule; a new feature
must not lower the pass rate.

## Phase 1: agent discovery (S each, no contract changes)

What exists: `llms.txt`, `AGENTS.md` (for working on the runtime),
`docs/AI-AUTHORING.md`, `docs/FRAMEWORK.md`, the JSON Schema, the generated
field reference, the cookbook, recipes, `validate`/`test`/`audit`, MCP
read-side tools (`inspectProject`, `validateProject`, `explainRoute`,
`getCapabilities`, `previewImport`/`previewExport`, `listRecipes`/`showRecipe`).
Keep all of it. The gap is that an agent still has to read documents to find
facts the runtime already knows.

### 1.1 Application-level `AGENTS.md` from `urlcode init` (S, core) — done

Done 2026-09-19: `renderAgentsGuide` in `src/agents-guide.ts` generates the file
from the installed capability catalog, `initProject` in `src/authoring.ts`
writes it, and `initProjectWith` in `src/init-with.ts` calls `initProject`, so
`init --with` writes it into the project directory too; `renderMcpConfig` writes
`.mcp.json` beside it. `test/cli.test.ts` asserts the commands, the packaged
skill path and the MCP tool names the file lists, its length bound, and that the
committed `starters/default/AGENTS.md` equals what `init` generates from this
runtime. Caveat: the public `urlcode-template` copy is outside this repository
and is not checked here; `npm run check:downstream-skills` stays advisory.

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

### 1.2 `llms-full.txt` and clean Markdown for the docs site (S, core; S, urlcode-docs) — partly done

Done 2026-09-19, the core side: `scripts/build-llms-full.ts` generates
`llms-full.txt` from 15 authoring documents in reading order with a table of
contents and a token estimate in the file header, `npm run check` runs it with
`--check`, and `test/llms-full.test.ts` covers determinism, rejection of a stale
copy and the conservative link rewriting. The docs-site half is not done here:
serving `/docs/<page>.md` beside `/docs/<page>` belongs to `urlcode-docs` and is
not verifiable from this repository.

Fixes: `llms.txt` must stay a compact index, but an agent that wants complete
context has to fetch forty files.

- Work: `scripts/build-llms-full.ts` concatenates the authoring documents
  (framework, AI authoring, YAML guide, field reference, specification,
  routing, HTTP, middleware, assets, policies, extensions) in
  reading order with a table of contents; checked in `npm run check` for
  staleness like the field reference. The docs site serves `/docs/<page>.md`
  beside `/docs/<page>` so agents never parse HTML. Do not adopt `agents.txt`
  or similar until a convention settles.
- Proof: `npm run check` fails on a stale `llms-full.txt`; token estimate
  recorded in the file header.

### 1.3 `urlcode context` with a token budget (M, core) — done

Done 2026-09-19: `urlcode context [--project] [--budget] [--json] [--stats]` in
`src/cli.ts` over `buildContext`, `renderContext`, `estimateTokens` and
`documentationTokens` in `src/context.ts`, derived from the compiled project and
the capability catalog; `--stats` writes the estimate to stderr so stdout stays
parseable. `test/context.test.ts` covers the cookbook and starter summaries,
byte-identical output across runs, the fixed budget drop order with the estimate
never exceeded, the CLI's YAML and JSON forms, and MCP `get_context`
(`src/mcp.ts`) returning the same data read-only.

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

### 1.4 Capability and schema fragment queries (M, core) — done

Done 2026-09-19: `urlcode capabilities <name>` and `urlcode schema <path>` in
`src/cli.ts` over `getCapability` in `src/capability-query.ts` and
`getSchemaFragment`/`schemaPathNames` in `src/schema-query.ts`, both re-exported
from `src/tooling.ts` and served as MCP `get_capability` and `get_schema`
(`src/mcp.ts`). `test/capability-query.test.ts` asserts that every catalog name
resolves with a valid, size-bounded fragment, that every schema path yields a
valid inline fragment and an unknown path lists the valid names, that entries
report bundled usage, grants and refusals from existing data, and that the CLI
fails closed on unknown names.

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

### 1.5 The URLCode agent skill (S, core `skills/urlcode/`) — done

Done 2026-09-19: `skills/urlcode/SKILL.md` is 104 lines, ships in the package,
and is named by the generated `AGENTS.md` through `skillPath` in
`src/agents-guide.ts`; `test/cli.test.ts` asserts the reference and
`test/release.test.ts` asserts the packaged starter copy. Caveat: the
with-and-without comparison in the proof line waits on 0.1 — the URLCode arm
preamble (`benchmarks/agent/prompts/urlcode.md`) assumes the skill, and no model
run has been stored to compare against.

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

### 2.1 Publish the three extension packages (decision, S) — done

Done 2026-09-18: `@jimhoyd/urlcode-ui`, `-auth` and `-admin` are on npm as
`0.1.0-alpha.x` against core `0.4.0-alpha.1`. The alpha caveat stays: source
complete, independent review, deployment evidence and accessibility
assessment pending ([issue 58](https://github.com/jimhoyd-com/urlcode/issues/58)).

Fixed: every install step in the "add accounts" row of the usability review
except the revision pin. Before this, a person or an agent cloned three private
repositories, ran `pack-sources.mjs` with four paths and a SHA, and installed
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
  script defaults from it; `ACCEPTANCE.md` links to it. 2.1 has shipped, so
  the published versions (`@jimhoyd/urlcode@0.4.0-alpha.1`,
  `@jimhoyd/urlcode-ui@0.1.0-alpha.4`) replace the SHAs and the file can go.

### 2.3 `urlcode init --with auth,admin,ui` (M, core plus each extension) — done

Done 2026-09-19: `--with` is parsed in `src/cli.ts` and implemented by
`parseWithNames`, `loadScaffold` and `initProjectWith` in `src/init-with.ts`,
which resolves `@jimhoyd/urlcode-<name>` from the invoking directory, refuses a
missing package or one without a `scaffold` export before writing anything,
merges the fragments into the starter through a last include, and writes one
`host.mjs` (`renderHost`), one `README.md` (`renderReadme`), `.mcp.json` and the
`AGENTS.md` from 1.1, printing the `inspectExtensionRevision` digest for
pinning. `test/init-with.test.ts` uses a fake `@jimhoyd/urlcode-<name>` package
in a temporary `node_modules` and, when companion checkouts are present,
composes the real auth and admin scaffolds. Caveat: each extension's own
`scaffold` export and admin's clean-project acceptance live in those
repositories and are not verified here.

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

### 2.4 Print extension schemas: `urlcode extensions` (M, core) — partly done

Done 2026-09-19, the command and the MCP tool: `urlcode extensions
[--host-file] [--json]` in `src/cli.ts` over `describeExtensions` in
`src/tooling.ts` prints each registration's name, version, targets,
configuration schema, policy schema, mounts, policy routes and revision-pin
verdict, and without a host file names the declared extensions and says schemas
need one. The same function is exported from `src/index.ts` and served as MCP
`get_extensions`, offered only when the operator started the server with a host
file, which `test/extensions.test.ts` asserts against the
`examples/extensions` registry. Not done: the fold-in. `urlcode context
--host-file` reports host extension names and a plugin count rather than their
schemas (`buildContext` in `src/context.ts`), and `urlcode capabilities auth`
takes no host file, so registered contracts are not part of either view.

Fixes: an agent cannot discover what `extensions.auth.config` accepts without
reading auth's source; `urlcode mcp` cannot serve it.

- Work: `urlcode extensions --host-file … [--json]` loads the host file as
  `validate` does and prints each registration's name, contract version,
  targets, configuration schema and policy schema; the same data through the
  SDK and an MCP tool. Folds into `urlcode context` and `capabilities auth`
  when a host file is given.
- Proof: test against the `examples/extensions` demo registry.

## Phase 3: retrieval instead of reading (M each, core)

### 3.1 Recipes as the vocabulary of common behavior — done

Done 2026-09-19: every bundled recipe carries `recipe.yaml`, and the catalog is
now ten — `authenticated-json-api`, `contact-form`, `cors-api`, `health-page`,
`json-api`, `middleware`, `protected-download`, `static-plus-api`, `typescript`
and `webhook-receiver` — which covers the seven this item names.
`urlcode recipes search|show|add` runs through `src/ecosystem-cli.ts` over
`searchRecipes` and `showRecipe` in `src/recipes.ts`, matching id, description,
tags and capabilities locally with no service, and MCP gained `search_recipes`.
`npm run check` validates the metadata and requires its derived fields to equal
the capability preflight (`checkCatalog` and `derivedDifferences` in
`scripts/check.ts`), and `test/recipes.test.ts` asserts a search hit per recipe
and that every recipe validates, passes its fixtures and audits with its
declared route count. Growing the catalog from the Phase 6 repetition log has
not started; the current ten are the seed list above.

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

### 3.2 Examples become searchable the same way — done

Done 2026-09-19: each example carries `example.yaml` in the recipe metadata
shape, `urlcode examples search <text>` runs through `src/ecosystem-cli.ts` over
`searchExamples` in `src/examples.ts` and names the smallest runnable match with
its route, and the cookbook's per-route tags are generated into
`examples/cookbook/route-index.json` by `scripts/build-cookbook-index.ts`,
checked by `npm run check`. `scripts/check.ts` holds example metadata to the
same preflight as recipes, and `test/recipes.test.ts` ("examples carry the same
metadata shape and search returns the smallest runnable match with its route")
is the search test.

- Work: `examples/*/example.yaml` with the same metadata shape; `urlcode
  examples search <text>` returns the smallest matching runnable example and
  its route. The cookbook's forty routes get per-route tags in one index file.
- Proof: search test; count audit unchanged.

### 3.3 `urlcode explain` from compiled semantics — done

Done 2026-09-19: `urlcode explain [/route] [--json]` in `src/cli.ts` over
`runExplainCommand` in `src/explain-cli.ts` and `explainRoute`/`explainProject`
in `src/explain.ts`, derived from the compiled IR, including extension policy
requirements when a host file is supplied. `test/explain.test.ts` covers the
project table and route detail through the CLI, the sandbox boolean, the
extension-protected route with a host registry, the nearest-route miss that
never carries binding values, and that explain agrees with the runtime on
methods and policies for every route.

Fixes: `explainRoute` exists in the SDK and MCP; there is no CLI, and the
output repeats matching rather than effective behavior.

- Work: `urlcode explain [/route] [--json]` prints, per route, the effective
  methods, handler, middleware chain, validated inputs, policies in effect
  (including `extensions.auth` requirements when a host file is given),
  cache and no-store outcome, bindings and target support, derived from the
  compiled IR. Whole-project form lists every route in one screen.
- Proof: snapshot tests on the cookbook; a test that `explain` and the
  runtime agree on methods and policies for every route.

### 3.4 A generated semantic manifest — done

Done 2026-09-19: `urlcode manifest [--json]` shares the `src/explain-cli.ts`
entry and runs `buildManifest` in `src/manifest.ts`; `build` writes
`manifest.json` beside the artifact and MCP offers `get_manifest`.
`test/manifest.test.ts` asserts determinism, that the revision equals the
extension revision digest, that external requirements and recipe provenance are
listed by name and never by value, and that the CLI prints the bytes the build
writes.

- Work: `urlcode manifest [--json]` (also written by `build` and offered by
  MCP as `get_manifest`) emits routes, capabilities, recipe provenance,
  external requirements, custom functions, requested bindings, target
  compatibility and the revision digest. Generated only; never checked in as
  a source of truth. `context` is a budgeted view of the same data.
- Proof: manifest equals `inspectProject` output for the same project;
  digest equals `inspectExtensionRevision`.

### 3.5 MCP authoring layer, separately authorized (M, core) — done

Done 2026-09-19: `src/mcp-authoring.ts` adds `create_route`, `add_recipe` and
`scaffold_feature` plus the `run_validate`, `run_test` and `run_audit` runners,
enabled only by `--allow-authoring` on the operator's command line, which
`src/cli.ts` refuses for any other command and which no tool argument or
environment variable can set (`src/mcp.ts`). Every write is validated before it
lands and returns the verdict. `test/mcp-authoring.test.ts` asserts the tools
are absent without the flag, that absolute, parent, symlinked, dotenv, git and
operator paths are refused, and that a create is followed by validation in one
call.

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

### 4.1 Short form for function routes (M, core) — done

Done 2026-09-19: `normalizeRoute` in `src/config.ts` expands
`function: functions/x.mjs` into `{source, args}` with an argument per `{param}`
and a required bounded path parameter for any the route does not declare itself
(`SHORT_FORM_PATH_SCHEMA`), and a string `middleware` entry into `{source}`; the
long form stays the IR. Both shapes are in
`schemas/urlcode.schema.json` (`$defs.route.properties.function` and
`.middleware`) and the generated field reference lists them as options.
`test/config.test.ts` ("function and middleware short forms normalize to the
long form the long form compiles to") asserts identical output, that a declared
parameter keeps its schema, and that a bad short-form string is refused with the
route named; the cookbook uses the short form in
`examples/cookbook/routes/middleware.yaml`.

Fixes: the smallest function route is ten lines.

- Work: `function: functions/hello.mjs` as a string expands every `{param}`
  to a required bounded string parameter and matching `args` entry; same for
  `middleware: [functions/x.mjs]`. The long form stays the canonical IR;
  `routes`, `audit`, `explain` and the field reference show the expansion.
- Proof: generated reference updated; cookbook gains a short-form route with
  fixtures; a test that short and long forms compile to identical IR.

### 4.2 Route-level `auth` as the semantic form (M, core plus auth) — done

Done 2026-09-19: the route-level `auth` key is in the schema
(`$defs.route.properties.auth` over `$defs.routeAuth` in
`schemas/urlcode.schema.json`) and expanded by `normalizeRouteAuth` in
`src/config.ts`, which refuses a route that declares `auth` without an
`extensions.auth` declaration, alongside `policies.extensions.auth`, or with
`policies.extensions: false`; `required: false` documents intent and emits
nothing. The type is documented in `src/types.ts`, and `test/recipes.test.ts`
("the authenticated recipes use the auth short form and never let credentials
reach the guest") covers both `auth: true` and a role requirement. The `cache`
short form this item defers to later shipped with it:
`$defs.route.properties.cache` and the cache branch of `normalizeRoute`, refused
alongside `policies.cache`. Caveat: the auth repository's HTTP tests are outside
this repository and were not run here.

Fixes: protecting a route today is `policies: { extensions: { auth: {} } }`,
which is the mechanism, not the intent. The form an agent should write is
`auth: { required: true, roles: [admin] }`.

- Work: a route-level `auth` key that expands to the `policies.extensions.auth`
  requirement the auth extension validates; `roles` maps to the extension's
  policy schema. Valid only when an `auth` extension is declared, refused
  with the route named otherwise. The same pattern applies later to `cache:
  { strategy: public, maxAge: 3600 }` over the cache policy where the policy
  form is more verbose than the intent.
- Proof: a test that the short form compiles to the identical requirement;
  `explain` shows both; the auth repo's HTTP tests pass unchanged.

### 4.3 Semantic over implementation configuration (rule, ongoing)

Every new field describes intended behavior (`auth: required`), never a
provider or framework knob. Review new YAML fields against this in PR
templates and the AI authoring matrix.

## Phase 5: keep measuring

Phase 0 runs again after each of Phases 1 to 4 lands, on the same tasks and
model, so every feature shows its effect on tokens, turns and the
application-specific code ratio. The repetition log in Phase 6 is fed from
the benchmark runs: every plumbing line the agent still wrote in the URLCode
arm is an entry.

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

### 7.2 Auth and admin render through the kit (L) — partly done

Done 2026-09-19, the core prerequisite only: the immutable-cache exception for
hashed extension assets shipped. `ExtensionImmutableAssets` and
`validateAssetPrefix` in `src/extensions.ts` bound a declared prefix to literal
segments under the extension's mounts, and `immutableAssetResponse` is what
lets such a response carry an asset cache-control instead of `no-store`. The
rendering work itself is in the auth, admin and ui repositories and is not
verified from here.

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
  path (`src/functions.ts`, `src/function-worker.ts`, `src/guest-api.ts`) —
  done 2026-09-19: `test/sandbox-pool.test.ts` covers load shedding with slot
  reuse, parallel workers with per-slot heaps, the 250 ms-to-30 s respawn
  backoff, the deadline kill with slot replacement, an abrupt worker exit
  failing the in-flight invocation, startup failure and close, and the guest
  `Request`/`Response`/context surface.
- Re-verify the remaining line-number rows in `STANDARDS.md`; cite symbols —
  done 2026-09-19: `docs/STANDARDS.md` records that every row was re-verified
  at `8d7dd01` and now cites the implementing function or constant rather than
  a line number, names the test that proves it, and says "unverified at
  8d7dd01" where a row could not be re-checked; no line-number citation
  remains in the file.
- Split the longest reference documents (YAML guide, policies) into task pages
  under 200 lines, so retrieval returns one page — done 2026-09-19:
  `docs/yaml/` holds nine pages (largest `functions.md`, 160 lines) and
  `docs/policies/` nine (largest `agents.md`, 182 lines), with
  `docs/YAML-GUIDE.md` down to 57 lines. Caveat: `docs/POLICIES.md` is still
  203 lines as the index page.
- A pre-test check in the extension repos that fails fast with the SQLite
  requirement named. Not verifiable from this repository.

## Sequence at a glance

What remains, as of 2026-09-19:

```
Phase 0  instrument built and tested; no model-backed run stored, so the
         code-ratio evidence is still missing. Evals (0.2) run weekly.
Phase 1  done: AGENTS.md from init, llms-full, urlcode context,
         capability/schema queries, the skill
         left: the docs site's /docs/<page>.md (urlcode-docs)
Phase 2  done: published alphas, init --with, urlcode extensions + get_extensions
         left: peers.json (auth, admin); extension schemas folded into
         urlcode context and capabilities <name>
Phase 3  done: recipe metadata + search, examples search, explain, manifest,
         MCP authoring behind --allow-authoring
Phase 4  done: short-form function and middleware routes, route-level auth,
         the cache short form; 4.3 stays a standing rule for new fields
Phase 5  waits on a Phase 0 run with a real model
Phase 6  not started: no docs/REPETITION-LOG.md, no docs/SPIKE-COLLECTIONS.md
Phase 7  extension repos; the core immutable-asset exception 7.2 needs is done
Phase 8  proof gaps, in parallel, as people and environments allow
Phase 9  done: sandbox pool tests, STANDARDS symbol citations, split reference
         pages; left: the extension repos' SQLite pre-test check
```

Phase 0 decides whether the rest is worth doing and in what order. Phases 1
and 3 are what an agent meets first; the rest makes that cheaper or proves it.
Because Phases 1, 3 and 4 landed ahead of the first model-backed run, that run
now measures what shipped rather than choosing it; Phase 5's re-runs are where
the choosing role returns.
