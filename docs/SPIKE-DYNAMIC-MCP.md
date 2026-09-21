# URLCode agent-native context service

Status: implementation plan, refreshed against core 0.4.8 and the workspace
monorepo. The local stdio discovery tools are implemented and shipped; the
protocol-core extraction, hosted Streamable HTTP service and telemetry pipeline
are not.

## Decision

Build the public service on URLCode. URLCode owns HTTPS routing, method/body
admission, static fallback artifacts, response headers, limits, caching and
operations. A small trusted function implements MCP JSON-RPC because that
protocol is application logic, not a route primitive. Do not build a second web
service or a Lambda wrapper for the first hosted version.

```text
llms.txt / static files     fast discovery and no-MCP fallback
SKILL.md                    progressive instructions
MCP                         deterministic retrieval, composition and checks
optional small LLM          bounded intent classification only
urlcode.yaml                the agent's primary application output
telemetry                   privacy-bounded evidence for the next improvement
```

Use `https://urlcode.ai` as the canonical AI-native entry point. Its remote MCP
endpoint is `https://urlcode.ai/mcp`; static discovery and skill files use the
same origin. `mcp.urlcode.ai` is a decided alias serving the identical endpoint (same
bundle, same limits, no redirect). Documentation and client snippets use the
canonical URL; the alias exists for clients and registries that expect an
`mcp.` host. Both hosts must be in the Origin allowlist and the TLS certificate,
and telemetry records only the release, never which host was used to reach it.
Hostnames are an operator choice, not YAML.

## The problem

A recorded agent run building an application with URLCode used about twice the
tokens of a plain-Node control and made four times the tool calls, mostly
reading documentation before writing YAML. Its custom JavaScript was 64% of
application LOC. That is one diagnostic run, not a performance claim. It says
agents can build with URLCode but discover and assemble too much context before
acting. The default remedy is a deterministic context compiler: return the
smallest version-pinned capability, constraint, example and validation sequence
for a task.

## What exists now

`urlcode mcp --project .` is already a bounded local stdio server (`src/mcp.ts`,
`src/mcp-authoring.ts`, `src/tooling.ts`). It knows the installed version and
selected project and exposes semantic `validate`, `inspect`, `explain`,
`get_context`, capability/schema lookups, recipes and examples without starting
guest code or reading bindings. It also ships `list_skills`, `get_skill`,
`search_docs`, `get_example`, `validate_yaml`, `explain_error` and the read-only
`get_extension_artifacts` / `get_extension_artifact` pair for a committed
artifact lock. The protocol-neutral `src/mcp-core.ts` and `src/mcp-http.ts`
below do not exist yet.

Keep this local mode: it is authoritative for a checkout and must never be
silently replaced with a network service.

## Core and extension ownership boundary

Build this on URLCode core rather than a separate hosted-product code path.
Two things are deliberately kept apart, matching how extensions now ship (see
[extensions](EXTENSIONS.md)):

- **Executable code** (the MCP bridge and mount handler) is a trusted operator
  module. It is a workspace package, `packages/agent` (`@jimhoyd/urlcode-agent`,
  working name, Apache-2.0), released like `auth`/`admin`/`store`/`ui`: independent
  version, Changesets, an `@jimhoyd/urlcode-agent@<version>` tag. `urlcode.ai` is
  the reference deployment and first consumer. Operators import it from
  `host.mjs`; project YAML names only the logical extension and mount, never a
  package, URL, database, credential or telemetry provider.
- **Content** (skills, recipes, examples, the compiled index) is data. It is
  built from this repository by CI into an immutable bundle and can be
  distributed as a signed, data-only extension artifact, never as code.

Core owns the small reusable foundation:

```text
src/mcp-core.ts            protocol lifecycle, transport-neutral tool contracts/results (to extract)
src/mcp.ts                 stdio adapter for installed/local use
src/mcp-http.ts            Request/Response Streamable HTTP adapter (to add)
src/tooling.ts             public schema/capability/recipe/example queries
```

The workspace package owns framework-specific product behavior:

```text
packages/agent/
  bundle/                  agent-content manifest, compiler and lexical index
  mcp/                     dynamic skill assembler, agent tools and resources
  telemetry/               redacted event schema and operator sink interface
  src/extension.ts         RuntimeExtension registration and mount handler
```

Skills, examples and reviewed prose live in this repository (`skills/`,
`examples/`, `recipes/`, `docs/`); the former separate docs repository is gone.
The bundle compiler reads exact revision inputs from the same checkout, so a
bundle hash is a function of one commit.

**Publishing.** The package is published to npm only as an ordinary workspace
release. It is not delivered as an artifact: artifacts cannot contain
JavaScript, a package manifest or an install hook, and artifact files are never
imported by `serve`, `validate` or the runtime. The compiled agent-content
bundle may additionally ship as a data-only `agent-content` artifact under
`artifacts/` (added to `artifacts/source.json`, released by an `extensions@v…`
tag through the artifact workflow, attested, pinned in
`urlcode.extensions.lock.json`). Artifact versions are independent of core and
package versions, so the bundle records which core release and commit it targets
and the hosted service refuses a bundle whose target does not match its release.
This split is a proposal: the artifact format currently allows only
`extension.json`, JSON configuration/schema data and a README, so a bundle of
that shape needs a format decision before it can ship, and `extension-artifacts`
is not a required path for the hosted service (it can load a bundle from its own
build). Local `get_extension_artifact` already reads verified members without
network access or activation.

The extension imports only public core APIs, so core never imports it and
self-hosters can replace or omit it. Telemetry follows the same boundary: the
package emits a generic redacted event to an operator-supplied sink interface;
neither core nor project YAML selects an analytics vendor or stores customer
data.

## Hosted service on URLCode

The hosted service is public, read-only and release-pinned. It serves no caller
filesystem, arbitrary URL fetch, agent-generated source, binding, deployment or
authoring tool.

```text
MCP client
  POST /mcp  ─┐
  GET  /mcp  ─┼─ URLCode routes ─ MCP bridge ─ immutable release bundle
              │
static fallback┘
  /llms.txt  /llms-full.txt  /skills/index.json  /skills/<name>/SKILL.md
```

Start with stateless JSON response mode: one POST carries one JSON-RPC message
and receives one JSON response. Initially return a correct `405` to `GET /mcp`.
Add SSE, resumability or session IDs only if a target client needs them.

```text
urlcode-mcp/
  urlcode.yaml              # POST /mcp, static fallback routes, policies
  functions/mcp.mjs         # narrow HTTP <-> MCP bridge
  public/                   # compiled immutable context bundle
  tests/requests.json       # framing, origin, limits and fallback checks
```

YAML owns POST-only admission, a bounded JSON body, security headers, throttle,
static cache policy and `site.llms` where appropriate. The bridge calls a new
package-level pure protocol core shared with stdio. It has no bindings and no
user-controlled filesystem or network access: this is the only necessary custom
JavaScript to expose MCP.

## Progressive tool contract

| Tool | Input | Return budget | Purpose |
|---|---|---:|---|
| `list_skills` | none | metadata | discover instruction boundaries |
| `get_skill` | stable name | one SKILL.md | load one applicable workflow |
| `search_docs` | short query | 3 excerpts | deterministic lexical discovery |
| `get_example` | stable ID | README + YAML | obtain a runnable start |
| `get_capability` / `get_schema` | name/path | one fragment | prevent invented YAML |
| `get_context` | task, target?, budget? | 1–3K tokens | compose the next minimum context |
| `validate_yaml` | YAML text | schema result | first-pass syntax/schema feedback |
| `explain_error` | validator output | next action | deterministic remediation |

For local MCP, `get_context` retains its project-summary behavior. When given a
task, it appends a task-specific packet; hosted mode requires a task. This avoids
breaking existing clients while converging modes.

The deterministic planner tokenizes a task, matches versioned
tags/capabilities/recipes, expands a curated dependency graph, chooses the
smallest runnable example, and renders a hard-budget packet with explicit
omissions. It never silently truncates.

```yaml
release: <core release>
recommend: [respond, request.body, policies.security]
example: contact-form
validate_next: [validate_yaml, "urlcode validate --local --project ."]
omitted: [full-reference, unrelated-capabilities]
```

## Optional dynamic LLM router

The caller is already an LLM, so the service must not reflexively call another
one. A dynamic model is useful only for ambiguous wording or terminology that
the deterministic tag matcher cannot resolve. Treat it as a bounded classifier,
not a documentation generator or YAML author.

```text
task -> deterministic retrieval -> confidence/high? -> compact context
                               \-> low confidence -> small-model classifier
                                                -> allowed capability IDs
                                                -> deterministic composer
```

The classifier receives a capped, redacted task and a release-pinned catalog of
capability IDs, recipe IDs, and targets. It returns strict JSON only:

```json
{"capabilities":["request.body","respond"],"recipes":["contact-form"],"confidence":0.82}
```

The server rejects unknown IDs, applies the same dependency graph and token
budget, and records whether classifier output changed the selected packet. It
never gives the model source documents, tool authority, secrets, project files,
or permission to call the network. It may not generate YAML, prose, or a final
answer.

The classifier is out of scope for v1. Ship deterministic routing first and
decide separately whether to add it. If added, it goes behind a flag, caches only
normalized, release-pinned classifications and expires them with the release.

## Documentation and bundle cleanup

The documentation-repository wording below now means this repository's `docs/`,
`skills/`, `recipes/` and `examples/`. Core owns schema, capability catalog,
recipes and shipped local skills; CI combines exact revision inputs into an
immutable bundle and never scrapes the public site at request time.

1. Make `/llms.txt` a compact index: purpose, declarative-first rule, release,
   MCP endpoint, skills index, full static fallback and three authoring checks.
2. Generate `/llms-full.txt` from a reviewed registry. Each entry has ID,
   canonical URL, release/SHA, capability and intent tags, summary, size, hash.
3. Keep only workflow-based skills: `urlcode-authoring`, `urlcode-diagnosis`,
   `urlcode-operations`. Do not split by each YAML field.
4. Give every recipe machine-readable capability/target/prerequisite metadata,
   validation commands, expected behavior and smallest copyable YAML.
5. Add one AI authoring landing page explaining the retrieval sequence; link it
   from navigation, `llms.txt`, starter `AGENTS.md` and the package skill.
6. Fail CI on missing, oversized or stale registry content and bundle hashes.

Static files are the availability fallback for agents without MCP support. MCP
improves selection and composition; it is not the only way to learn URLCode.

## Skill and entry-point matrix

The skill is the best *in-workspace* entry point: agents that see a URLCode
project need an immediate instruction to use the local server and write YAML
before custom JavaScript. The current single `urlcode` skill should become a
small compatibility wrapper during migration, pointing to these versioned,
separately discoverable skills:

| Entry point | Audience and trigger | First payload | Next step |
|---|---|---:|---|
| Project `AGENTS.md` | agent opens a URLCode checkout | 10–20 lines | local MCP or CLI fallback |
| Package `skills/urlcode` | installed-package agent skill discovery | metadata then <5K-token SKILL.md | authoring/dx references |
| `urlcode-authoring` | create/change routes, forms, APIs, redirects | declarative-first loop | `get_context`, schema, recipe |
| `urlcode-diagnosis` | validation, target, policy, deployment errors | error triage loop | `explain_error`, `explain`, `validate` |
| `urlcode-operations` | run/test/audit/inspect/host a project | safe operational loop | project MCP commands |
| `.mcp.json` | local MCP-capable client | tool catalog | version/project-aware retrieval |
| `https://urlcode.ai/mcp` | hosted MCP-capable client | remote tool catalog | release-pinned retrieval |
| `/llms.txt` | crawler, generic assistant, no MCP | compact index | individual static pages/skills |
| `/llms-full.txt` | compatibility fallback | full reviewed corpus | no interactive retrieval |
| `/skills/index.json` and static `SKILL.md` URLs | Agent Skills-aware client | skill metadata | full skill/resources |
| npm package / starter | agent creates a new project | `AGENTS.md`, `.mcp.json`, skill assets | local tool loop |
| Docs AI landing page | human or agent starts at web docs | one-screen decision tree | static fallback or MCP registration |

The Agent Skills format supports exactly this progressive structure: all skill
metadata is cheap startup context, the selected `SKILL.md` is loaded only on
activation, and focused `references/` / `assets/` files load later. Keep each
main skill below the recommended 5,000 tokens/500 lines, use accurate keyword-
rich descriptions, and keep references one level deep. Do not make scripts the
normal path: URLCode's MCP/CLI are the supported executable interface.

Two discovery gaps are easy to miss:

1. **MCP resources and prompts.** Expose `skill://`, `doc://` and
   `example://` resources plus a small `author-urlcode` prompt *in addition to*
   tools. Some clients discover resources/prompts better than tools, while tools
   remain the portable baseline. Tool results should include structured output
   schemas and resource links for clients that support them, with text JSON kept
   for compatibility.
2. **Registration and no-install discovery.** Publish ready-to-copy remote and
   local configuration snippets for Codex, Claude Code, Cursor and generic MCP
   clients. The static `/llms.txt` must mention both. A hosted MCP endpoint that
   agents cannot discover, and a great skill unavailable from a starter, both
   lose the benefit before retrieval starts.
3. **Registry discovery (after the release gates, not v1).** Once the remote endpoint has passed conformance and
   security gates, publish a release-pinned remote `server.json` in the official
   MCP Registry. This is the app-store/search entry point for clients that do
   not crawl `llms.txt` or visit the docs site. Treat registry metadata as a
   versioned release artifact, not a substitute for the endpoint's own tests.

The first client compatibility matrix should test, rather than assume: Codex,
Claude Code, Cursor, VS Code/Copilot, and one generic Streamable HTTP inspector.
For each, record whether it discovers tools, resources, prompts, static skill
URLs, project `AGENTS.md`, and `.mcp.json`; select the smallest reliable common
surface as the documented happy path.

## Dynamic skill assembly

Dynamic skills are the central product behavior. They should be **assembled,
not hallucinated**. A static skill remains the portable fallback, while MCP can
compose a much smaller task card from trusted fragments.

```text
"Build a validated contact form"
  -> get_context(task, target, budget)
  -> match: authoring + request.body + respond + security + contact-form recipe
  -> return: dynamic task card (for this task/release only)
```

The returned card is a first-class `skill://` resource and a normal structured
tool result for clients that do not support resources:

```yaml
id: urlcode/task-contact-form
release: <core release>+<sha>
baseSkills: [urlcode-authoring]
capabilities: [request.body, respond, policies.security]
example: contact-form
instructions:
  - Use a declarative respond route before a function.
  - Bound and validate the request body in YAML.
  - Run validate_yaml, then local validate and test.
resources:
  - skill://urlcode-authoring@sha/references/request-body
  - example://contact-form@sha
estimatedTokens: 680
```

The compiler may select or parameterize only these reviewed fields: capability
IDs, recipe/example IDs, target constraints, fixed instruction fragments,
schema fragments and validation commands. It cannot include the raw task,
arbitrary document text, agent-generated YAML, user content, or LLM-written
instructions in the resource. The task card has a content hash and release ID,
a byte/token cap, and an explicit omitted list.

The optional dynamic LLM classifier may choose the IDs when deterministic
matching has low confidence; it never writes the skill. Every dynamic card is
therefore reproducible from `{release, selected IDs, target, budget}` and can
be cached and audited. This gives agents the benefit of a dynamic
skill while preserving the trust, compatibility and review properties of static
`SKILL.md` files.

## Feedback loop with privacy boundaries

Raw prompts and YAML may contain customer URLs, code or secrets. Do not use
normal request logs for product research: URLCode intentionally avoids request
bodies and paths in standard operational logs.

Emit one bounded `agent_context_event` per tool result to a separate,
access-controlled telemetry sink:

```json
{"day":"2026-09-20","release":"<core release>+<sha>","tool":"get_context",
 "intentFingerprint":"sha256(normalized-intent + rotating-salt)",
 "intentTerms":["contact","form"],"selected":["contact-form","request.body"],
 "returnedEstimatedTokens":842,"omitted":["full-reference"],"result":"ok"}
```

- Never retain raw YAML, source, headers, bodies, credentials, IPs, user IDs or
  full prompt text by default.
- Normalize/cap terms; remove URLs and high-entropy token-like strings before
  fingerprinting. Rotate salts to prevent cross-period tracking.
- Record tool outcomes, coarse client family and sample/rate-limit anonymous use.
- Any opt-in redacted raw sample is separate, access-restricted, short-lived,
  documented and disabled by default.
- Review weekly: empty searches, unmatched clusters, high-budget packets,
  repeated validation errors and custom-JS escapes. Each becomes a docs, recipe,
  error or capability hypothesis, never an automatic feature.

For classifier-assisted requests, add `retrievalPath` (`deterministic`,
`classifier`, `classifier-rejected` or `fallback`), the classifier model and
prompt/catalog version, confidence bucket, selected-ID delta from deterministic
matching, latency, and input/output token counts. This lets us prove whether the
extra AI call improved selection enough to justify its cost, without storing the
request it classified.

The service can observe retrieval and `validate_yaml` results directly, but it
cannot know whether an agent successfully changed a local project. Add an
optional, no-content `report_outcome` tool for MCP-capable hosts:

```json
{"contextId":"ctx_...","outcome":"local-validate-passed","elapsedMs":12000}
```

Accept only an opaque context ID minted by `get_context`, a closed outcome enum
(`not-used`, `yaml-valid`, `local-validate-passed`, `tests-passed`,
`unsupported`, `abandoned`) and a bounded elapsed time. Hosts, not models,
decide whether to send it; it is never required for a tool result. This closes
the feedback loop from question category -> context packet -> validation outcome
without requesting project content.

Create four product views from the events: **demand** (intent clusters and empty
searches), **retrieval quality** (selection/fallback/confidence), **efficiency**
(returned and classifier tokens/latency), and **effectiveness** (reported
validation/test outcomes). Production telemetry discovers problems; each
improvement is judged by the next review, never applied automatically.

`report_outcome` context IDs are minted per `get_context` call, are random and
unlinked to any session or caller, and expire with the release. They are
accepted once. Rotating salts mean intent fingerprints cannot be counted across
salt periods; rotate weekly to match the review cadence and compare clusters by
`intentTerms` across periods.

The classifier is paid inference on anonymous traffic. It needs a hard daily
call budget, a per-client rate limit, and an operator kill switch that falls
back to deterministic routing; it stays off until those exist.

The telemetry adapter is operator-owned and fail-open for MCP responses. It has
no credentials in YAML and is tested with a fake sink; analytics is not in the
public request critical path.

## Open-source research

| Project | Useful precedent | URLCode decision |
|---|---|---|
| `langchain-ai/mcpdoc` | auditable `llms.txt` retrieval and allowed domains | Reuse the index/fallback idea only. It is archived and fetch-oriented, so no request-time crawl/dependency. |
| `StacklokLabs/skills-mcp` | three-tier progressive disclosure and skills over MCP/resources/prompts | Reuse the interaction pattern. Current repo is proprietary; do not fork/embed without a license decision. |
| `bigbag/llmdoc` | BM25/FTS, attribution and refresh | Defer. Begin with release-built lexical search; add build-time BM25 only if measured misses justify it. |
| MCP Streamable HTTP | one endpoint, POST JSON-RPC and optional SSE/session support | Start standards-conformant/stateless, validate Origin, then add auth/rate limits before launch. |

## Delivery plan

Owner is the maintainer for every phase. Durations are estimates; stop and
re-plan after phase 2 if the HTTP conformance tests are not green.

### 1. Compile the corpus — 1 week

- Define `agent-content.json` and its schema in this repository; decide whether
  the compiled bundle also ships as an `agent-content` extension artifact.
- Add metadata; compile deterministic release manifest/index/static artifacts.
- Publish fallback routes and test links, hashes, size limits and stale releases.

### 2. Extract protocol core — 1 week

- Move lifecycle parsing, tool definitions and dispatch out of stdio framing
  while preserving current 2025-11-25 stdio tests.
- Add task-aware planner and build-time lexical index. Keep inputs
  manifest-constrained.
- Add HTTP conformance tests: JSON-RPC errors, `Accept`, Origin, limits, CORS,
  405 GET, no path/URL escape and no secret echo.

### 3. Dogfood deployment — 1 week

- Create the `urlcode-mcp` project (private `urlcode-ai` repository, per the
  site plan) using the released runtime.
- Route MCP, fallback, health/readiness and metrics through URLCode. The bridge
  has no bindings or user-controlled filesystem/network access.
- Deploy behind HTTPS, rate limiting and an explicit Origin policy. Start
  anonymous/read-only; add OAuth only if a later private capability needs it.

### 4. Instrument and improve — ongoing

- Ship aggregate-only telemetry and internal weekly review.
- Make one docs/skill/recipe improvement at a time. Promote a framework
  feature only with repeated evidence from the weekly review.

## Decisions

- **Repositories.** The reusable extension is `packages/agent` in this
  monorepo. The deployment (`urlcode.yaml`, `host.mjs`, DNS and hosting config)
  lives in the private `urlcode-ai` repository and consumes the published
  package.
- **Trust.** The bridge and mount handler are trusted operator code, like every
  extension: they run unsandboxed and `sandbox: true` is not used. That is
  acceptable because the service has no bindings, no filesystem or network
  access from request input, and serves only an immutable bundle.
- **Hosting.** Lightsail (decided). The bridge needs the self-hosted Node
  lifecycle, so the AWS Lambda and Vercel adapters (native handlers only) and
  Cloudflare cannot run it. Run the container on a small Lightsail instance in
  the AWS account, with Cloudflare for DNS and optional proxy. Move to App Runner
  or ECS only if load requires it; the choice does not change the project YAML.
- **Release support.** Serve the bundle for the current release and the latest
  patch of the previous minor. Any other requested release returns an explicit
  unsupported-release result naming the supported ones and the upgrade path; the
  service never silently answers with a different release. Each served release
  is a separate immutable bundle; two at most.
- **Cost ceiling.** US$100 per month total for hosting, classifier inference
  and telemetry storage, tracked monthly. Suggested split: hosting 60,
  classifier 30, telemetry 10. The classifier has its own hard cap and is off
  until that cap and the kill switch exist. Crossing the ceiling disables the
  classifier first, then rate-limits, before any spend increase.
- **Entry points.** Starter `AGENTS.md`, the package skills and `.mcp.json`
  snippets name `https://urlcode.ai/mcp` as the hosted server and keep local
  MCP as the authority for a checkout. They are updated in the same change that
  announces the endpoint, and that update is a release gate.
## Release gates and non-goals

Before announcing the endpoint: reproducible bundle; MCP conformance against
target clients; URLCode HTTP fixtures; security review of origin/auth/rate-limit;
and telemetry-redaction tests. A green build is not a production/security/soak claim.

Version one has no vector database, unrestricted crawling, remote project
inspection, writes, shell, deployment, secrets, bindings or default raw-prompt
retention. Any later LLM classifier is constrained, never the source of truth or an
authority-expanding tool.
