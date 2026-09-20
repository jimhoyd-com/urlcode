# Historical record

Archived 2026-09-19. This records an earlier implementation or proposal, not
current instructions. See the [current roadmap](../../../ROADMAP.md),
[current contract](../../SPECIFICATION.md) and [open decisions](../../OPEN-DECISIONS.md).
Remaining acceptance work is not declared complete by archiving this record.

<!-- trust-model-prose: historical-file -->
<!-- local-links: historical-file -->
<!-- guidance-claims: ignore-file -->

# Public roadmap

URLCode is a portable runtime for programmable URL behavior, not a URL
shortener. Stored short links are an operator-installed extension, not a core
handler. The
[project direction](../../PROJECT-DIRECTION.md) explains how application
projects and provider adapters fit without redefining or restricting the free
runtime.

This is the public delivery sequence. Tests accompany every feature, not a
separate late phase. The stable 0.1 self-hosted release covers much of M0/M1 plus initial
process/container packaging and benchmarks. Provider adapters and the remaining
production-readiness gates remain open.

## 0.4.0-alpha.2 — current alpha

`0.4.0-alpha.2` is a behavior-changing release on top of `0.4.0-alpha.1`:
**`function` and `middleware` routes now run trusted and unsandboxed by
default** — in the host process, with full Node/filesystem/network access,
exactly like any other project code — instead of always dispatching through
the QuickJS/WebAssembly worker pool. Sandboxing is now an explicit per-route
opt-in via `sandbox: true`; a route that declares it gets exactly the
isolation every earlier alpha provided, unchanged. See
[docs/SPIKE-DEFAULT-TRUST-MODEL.md](../../SPIKE-DEFAULT-TRUST-MODEL.md) for
the maintainer's decision and rationale, and
[docs/FUNCTION-SECURITY.md](../../FUNCTION-SECURITY.md) for the resulting
contract of both execution modes.

**This changes existing projects with no YAML edit.** Every `function`/
`middleware` route that does not declare `sandbox` — which, before this
release, meant every such route in every existing project — now runs trusted
instead of sandboxed the moment the runtime is upgraded to `0.4.0-alpha.2` or
later. Binding grants (`env`/`secrets`) are unaffected: a route still
receives only what it declares and an operator policy pins to the project
revision, whether trusted or sandboxed. Review which of your project's
`function`/`middleware` routes handle input or code you would not otherwise
trust with full Node/filesystem/network access, and add `sandbox: true` to
those specifically (docs/AI-AUTHORING.md's "Deciding when a route needs
`sandbox: true`") before upgrading a project that relies on the old,
always-sandboxed behavior. An operator policy pinned to a project's revision
is invalidated by this upgrade regardless of whether the project's own YAML
changed, since the project hash includes the trust-model-affecting change;
re-derive and re-approve it (`urlcode permissions`) after upgrading.

## 0.4.0-alpha.1

`0.4.0-alpha.1` is the first alpha of the extension contract and the agent
tooling on top of the `0.3.0` self-hosted release. It carries: the
revision-pinned extension contract, capabilities and provider conformance,
strict redirect interchange, bulk import, recipes and search, TypeScript
guests, conditions, bounded proxy and signals, MCP read and authoring modes,
the `context`, `explain`, `manifest` and `schema` queries, short forms,
route-level auth, `init --with`, the agent benchmark harness, `llms-full`,
and the generated `AGENTS.md` and skill. It is an alpha: provider
deployments, soak and independent security review remain open. The
extension packages declare `@jimhoyd/urlcode >=0.4.0-alpha.1 <0.5.0` and
are published after core.

## Extensions: accounts, administration and presentation — implemented, unreleased

The runtime now carries a generic, revision-pinned extension contract
(`@jimhoyd/urlcode/extensions`, [extensions](../../EXTENSIONS.md)): a project
declares versioned `extensions.<name>` blocks, exclusive `extension` mounts and
`policies.extensions` requirements; the operator supplies the implementations
in a host file loaded with `--host-file`, outside the project. Guest requests
never see `Cookie`, `Authorization` or declared credential headers. Cloudflare
refuses extensions until its artifact format can run them.

The implementations live in their own repositories, each with an
implementation-status file that is the authoritative feature list:
[urlcode-auth](https://github.com/jimhoyd-com/urlcode-auth) (accounts, sessions,
MFA, roles, account page, operator CLI), [urlcode-admin](https://github.com/jimhoyd-com/urlcode-admin)
(users, sessions, roles, audit, approvals, cases, impersonation) and
[urlcode-ui](https://github.com/jimhoyd-com/urlcode-ui) (escaped templates,
partials, themes, translations). All three are Apache-2.0 and published to
npm as `0.1.0-alpha.1` while first-release acceptance is reviewed; see
[issue 58](https://github.com/jimhoyd-com/urlcode/issues/58) for what remains:
browser and device WebAuthn coverage, accessibility assessment, soak, backup
and recovery drills on a deployment, live provider senders and independent
security review. [The framework](../../FRAMEWORK.md) describes how the four
packages compose, and [next steps](NEXT-STEPS.md) is the phased plan to
close the remaining gaps.

## Capability foundation — implemented, unreleased

`urlcode capabilities [--target self-hosted|cloudflare|aws|vercel] [--json]`
and the public capability API centralize target support for handlers, bindings
and effective policies. Runtime activation and Cloudflare builds use the shared
preflight; unknown targets fail closed and unsupported requirements identify the
route and capability before resources or artifacts are created. The existing
compiled route IR is documented, not replaced. Configuration-dependent and
delegated behavior remain explicit; all provider deployments remain unverified.
See [capabilities](../../CAPABILITIES.md) and the
[next-phase review and implementation status](NEXT-PHASE-PLAN.md).

## Portability and URL behavior — implemented, unreleased

Strict redirect interchange supports CSV/JSON/YAML, Netlify and Cloudflare
`_redirects`, a bounded Netlify TOML subset and Vercel redirects. Conversion
reports refuse unsupported semantics; provider differences require explicit
acknowledgment and are never called lossless. A synthetic conformance fixture
and bounded HTTPS runner distinguish local adapter tests from observed
provider deployments. Actual Cloudflare/AWS/Vercel deployment evidence remains
pending; this does not complete M4.

Exact query/header/cookie/origin/method conditions and disjoint conditional
redirect/response cases run in the self-hosted, AWS and Vercel runtimes.
Cloudflare refuses these until its compiler can preserve their semantics.
Self-hosted proxy and webhook signals use explicit revision-pinned operator
origin grants, connection-pinned public DNS and bounded transport. Signals
have no durable delivery or retry guarantee. Other targets refuse proxy and
signals. See [conditions](../../CONDITIONS.md), [egress](../../EGRESS.md),
[interchange](../../INTERCHANGE.md) and
[provider verification](../../PROVIDER-VERIFICATION.md).

## Developer ecosystem — implemented, unreleased

Bundled Git-owned recipes, safe bulk imports into route includes, build-time
TypeScript guest transpilation, read-only inspection APIs and optional stdio
MCP tooling are available. The runtime still executes only JavaScript, and
TypeScript authoring adds no execution mode: transpilation happens at build
time, is not type checking, and a `sandbox: true` route's emitted JavaScript
runs inside QuickJS/WASM exactly as before. Bulk benchmarks
successfully cover 1,000, 10,000 and 100,000 routes without relaxing parser
limits. See [recipes](../../RECIPES.md), [bulk evidence](../../BULK.md),
[TypeScript authoring](../../TYPESCRIPT-AUTHORING.md) and
[SDK/MCP](../../TOOLING.md). These features do not supply durable signals,
protected downloads, a remote marketplace or provider deployment proof.

## TypeScript source and shipped declarations — implemented, unreleased

The runtime, scripts, tests and benchmarks are TypeScript under a strict
configuration, checked by `npm run typecheck` inside `npm run verify`. The
package ships `dist/`: Node's own type stripping of the source with the
specifier extension rewritten, so it is the same JavaScript line for line,
plus `.d.ts` declarations for every export (`urlcode`, `@jimhoyd/urlcode/plugins`,
`@jimhoyd/urlcode/policies`, `@jimhoyd/urlcode/observability`, `@jimhoyd/urlcode/compliance`,
`@jimhoyd/urlcode/prerender` and the three provider entries). `dist` is never
committed; the build runs in the digest-pinned release container, its hashes
are recorded in the manifest, and a CI job builds twice and diffs the trees.
Measured cold start, throughput and memory of `dist/` equal the previous
JavaScript (see [performance](../../PERFORMANCE.md)). Contributors need Node
22.18+ to run the source directly; installed packages still run on 22.13+.
See [TypeScript](../../TYPESCRIPT.md).

## Host policies and plugins — implemented, unreleased

A `policies` block in YAML, reusable `profiles` and an operator plugin API
close the gaps the [extensions spike](SPIKE-EXTENSIONS.md) ranked
highest: no cross-cutting behavior, no per-client throttle, no bot policy, no
security-header preset, no compression and no response cache. Five policies
(`throttle`, `agents`, `security`, `compression`, `cache`) run in the host
process after route match and before the route contract, all off by default,
with a per-target table that refuses at activation what a target cannot
enforce: the serverless adapters take `agents`, `security`, `cache` and
route-partitioned `throttle`; the Cloudflare build compiles `agents` and
`security` into the artifact and refuses the rest with the route named.
`--trusted-proxies` names the hops allowed to set `X-Forwarded-For` for client
identity. Plugins are host code passed to `startServer` and the adapters on
the same hook seam the policies use; nothing in YAML names one. See
[policies](../../POLICIES.md) and [plugins](../../PLUGINS.md).

This checkpoint is on a branch and not in a published release. An
interoperability review of the five policies together, the spike's `report`
mode headers on every target and the audit's policy table remain open, and no
deployment has exercised a policy on a provider.

## Provider adapters — Vercel and AWS Lambda native handlers

`@jimhoyd/urlcode/vercel` serves a project as a Vercel Node function, reusing the
runtime's transport-agnostic handle() and a shared response writer, so a
deployment returns byte-identical status, body and headers to the self-hosted
server. Bindings arrive through a `URLCODE_POLICY` environment variable holding
the same revision-pinned grant document the operator policy file carries.

Native handlers only: `function` and `middleware` routes are refused at
activation, trusted or sandboxed alike, because they need the self-hosted Node
lifecycle and a sandboxed one would pay worker and WASM startup on every cold
start. The
`@jimhoyd/urlcode/aws` does the same for a Lambda Function URL or API Gateway HTTP API.
Payload format 2.0 only: format 1.0 supplies an already-decoded path and query,
and this runtime rejects ambiguous encoding deliberately, so rebuilding a target
from decoded parts would misrepresent the request. Response policy, including
content length, now lives in one place shared by every host rather than partly
relying on Node's implicit behaviour.

Neither adapter has been deployed; see the [Vercel](../../VERCEL.md) and
[AWS](../../AWS.md) guides, which state what stays unverified as a result.

## Provider targets — Cloudflare Workers

Cloudflare Workers has no worker threads, no filesystem and no runtime code
generation, so it gets a compiler rather than an adapter: `urlcode build
--target cloudflare` emits a Worker, the compiled routes and Ajv standalone
validators, and `@jimhoyd/urlcode/cloudflare` serves them with the same matching, request
policy and response policy as every other host. Declarative routes only —
redirects and declared responses with parameters, defaults, validation, response
headers, `enabled` and `expires`. Functions, middleware, assets and
bindings are refused at build time with the route named, so an unsupported
project fails the build instead of the deployment. Bindings are refused even as
literals, because a build artifact must never carry a secret.

Making this possible moved request-time matching into `src/match.ts` and header
validation into `src/header-validation.ts`, both free of Node imports, so one
implementation now serves the Node server, the serverless adapters and the
Worker. `test/header-validation.test.ts` compares the header rules against
`node:http` across the full character range, because disagreeing there is header
injection, and `test/cloudflare.test.ts` asserts the Worker and the self-hosted
server return the same status, body and headers for the same project.

This has not been deployed to Cloudflare; see the
[Cloudflare guide](../../CLOUDFLARE.md) for the two request-level differences the
platform imposes and what stays unverified.

## Installation and publication — 0.1.0

Added a tag-driven release workflow that reuses the audited candidate build path,
publishes a GitHub release with the signed tarball, SBOM, manifest, `SHA256SUMS`
and a rendered Homebrew formula, and optionally publishes to npm (with
provenance) and GHCR behind repository variables. Added a checksum-verifying
`install.sh`, a Homebrew formula template rendered only from measured bytes, and
an [installation guide](../../INSTALL.md) covering npm, Homebrew, the script, the
container and provenance verification.

0.1.0 was released from this pipeline: the GitHub release carries the signed
tarball, SBOM, manifest, `SHA256SUMS` and Homebrew formula, and an install from
the published release was verified end to end. npm and GHCR publication stay
opt-in and remain unproven until enabled, so the Homebrew formula's registry URL
does not resolve yet.

Added tunnel and [monitoring](../../MONITORING.md) recipes, and extended
`urlcode benchmark` to measure a running deployment through its real path with
warm-up and shed/transport separation; see [load testing](../../LOAD-TESTING.md).
M3's remaining gap is sustained soak and slow-peer behaviour, which that tool
does not cover.

## Hardening checkpoint — alpha.8

Bound HTTP admission and inactive sockets, and correct management
defaults/method responses.
The [readiness register](../../RELEASE-READINESS.md) distinguishes tested safeguards
from deployment and stable-release gates. Feature breadth does not imply stability.

## Live short links — alpha.8 (removed from core, superseded)

Implemented an optional native `link` handler, local SQLite persistence, CLI CRUD
and a separate authenticated management API. Links became visible without YAML
changes/reloads; versioned writes prevented silent lost updates. No guest storage
or network access was added. Same-host only; distributed storage, general state,
user accounts and provider adapters remained open.

This native `link` handler, its SQLite store, CLI and management API were
removed from core in the layering work that followed. Stored short links moved
to a separate `urlcode-dynamic-link` extension package (mount-based, like
`auth`/`admin`), which was retired and unpublished in September 2026 without a
successor. A project that used `link`/`dynamicLinks` now owns that storage
itself; there is no in-core replacement and no deprecation shim.

## Middleware — alpha.7

Implemented route-local ordered `next()` middleware around every handler, early
responses, request-local state and shared sandbox deadlines. Plain native routes
retain their fast path. Native bodies stay opaque; middleware coverage requires
explicit assertions. See [middleware](../../MIDDLEWARE.md).

## One starter — alpha.6

`urlcode init <directory>` always creates the same function-plus-redirect project.
There is no template selector. The public urlcode-template repository mirrors
those examples with a pinned npm dependency. Richer asset examples remain under
examples/assets. Historical starter branches are not maintained.

## Route readiness and local project benchmarks — alpha.5

Implemented route inventory, expected-count checks, active route/method coverage,
generated native probes plus explicit fixtures, and bounded assertion-aware local
benchmarks. [Readiness](../../READINESS.md) documents the gate and remaining deployment,
soak, remote-destination and business-coverage work. This does not complete M3/M4.

## HTTP configuration and standalone starter — 0.1.0-alpha.4

Implemented bounded request body/media-type/JSON checks, literal response headers
and separate Set-Cookie values, and native text/JSON responses. See [HTTP](../../HTTP.md)
for precise scope; automatic CORS, multipart, streaming and other listed features
remain open. The public [urlcode-template](https://github.com/jimhoyd-com/urlcode-template)
provides two routes with a pinned runtime dependency and cross-platform CI.

## Native assets — 0.1.0-alpha.3

Implemented the page/static/download portion of M2: project-contained asset
snapshots, automatic MIME types, attachment names, HEAD, cache validators and
single byte ranges. Dedicated public directories, symlink/hardlink rejection and
bounded memory are part of the contract. [Asset guide](../../ASSETS.md).
Bulk tools, recipes and best-effort signals were added in the unreleased next-phase work above; they were not part of alpha.3.

## Security correction — 0.1.0-alpha.2

<!-- trust-model-prose: historical -->
All function code is untrusted. Node host execution has been replaced by
QuickJS/WebAssembly isolation with fresh invocation state, no ambient host or
network APIs, bounded resources, restricted module graphs and revision-pinned
operator binding policy. This protection is part of the free product. See the
[security model](../../FUNCTION-SECURITY.md). Full Fetch/Node
API compatibility and network integrations were not part of that alpha and
remain outside the 0.1 contract. That default was superseded in
`0.4.0-alpha.2`, which made this isolation the per-route `sandbox: true`
opt-in instead (see
[docs/SPIKE-DEFAULT-TRUST-MODEL.md](../../SPIKE-DEFAULT-TRUST-MODEL.md)).

## Earlier implementation checkpoint — 0.1.0-alpha.1

Implemented: versioned strict YAML/JSON Schema subset, explicit file composition,
redirect/parameter semantics, JavaScript Request/Response functions with bounded
workers, scoped binding context, init/add/validate/dev/serve/test/doctor, indexed
snapshots, last-good reloads, graceful shutdown, health/readiness, safe request
logs, two runnable starters, ESLint and unit/HTTP/package tests. Cross-platform
CI and a non-root container build are included. See the [contract](../../SPECIFICATION.md)
and [operations guide](../../OPERATIONS.md) for exact support and evidence limits.

Still open in the early contract: host namespaces, stable identity beyond paths,
fuller parameter vocabulary. Build-time TypeScript authoring and capability planning are now implemented in the unreleased work above.
No claims of complete M0/M1 or stable production readiness. M2–M4 work continues
in the order below; a few independently useful operational foundations shipped early.


| Milestone | Scope | Completion evidence |
|---|---|---|
| M0 — contract/build loop | YAML schema, matching/input semantics, function API, composition, runtime/packaging prototype, CI | Fixture validates; invalid definitions fail; verification runs |
| M1 — local alpha | CLI, aliases, redirects, parameters, custom functions, env/secrets, indexed routes and reload | Redirect plus function tested locally without accounts/DB; invalid reload preserves working version |
| M2 — bulk/reusable behavior | CSV/YAML/JSON, safe bulk edits/checks, templates, best-effort async signals, simple pages/static/downloads | 10k-route example, local side-effect tests, safe file serving, benchmark datasets |
| M3 — self-hosted beta | Process/container deployment, domain/TLS guide, packages/Homebrew, ngrok, monitoring and load tools | Install, test, deploy, observe and roll back a real project |
| M4 — provider public release | Cloudflare/AWS/Vercel adapters, provider conversion, capability/limit checks and stable docs | Baseline redirect/parameter/function fixtures on each advertised initial target; additional capability gaps explicit |
| M5 — advanced public features | Bounded proxies, protected/one-time downloads, durable signals/state, broader catalog and API/SDK/MCP | Feature-specific guarantees, tests and portable capability reports |

The first provider-capable public release is M4; the 0.1 self-hosted release is
useful within its documented scope. A marketplace and advanced stateful
features are not prerequisites. No web UI/TUI or framework-hosting platform.
Netlify starts as redirect interchange after the initial provider adapters.

## Launch and stabilize the free version

Stability means repeatable installs/upgrades, dependable routing/functions,
working deployment and rollback, useful diagnostics, and serious recurring
issues from actual users addressed. Feedback begins with usable alphas, but the
free version is not stable until that evidence exists; do not invent a calendar
deadline or adoption-count threshold.

Keep the architectural direction: reusable runtime/compiler, provider adapters,
separate configuration and secrets, versioned artifacts, Git-owned definitions
and observable behavior. Avoid assumptions that would force users to rewrite
projects later. No artificial restrictions in the free version; it is licensed
under Apache-2.0.

## Starter delivery

The [starter plan](../../STARTERS.md) makes both Git clone and CLI initialization
release requirements: one function-plus-redirect starter in M1, bulk-growth examples in
M2, and the business foundation with self-host tooling in M3. Provider recipes
follow tested M4 adapters. All use the same runtime and portable project format.

## Quality gates

- Same fixtures pass on the local reference and each claimed runtime adapter.
  A static exporter alone is not a complete function-capable adapter.
- Pure redirects avoid Lambda/per-route user functions; generated shared routing
  is allowed where native provider rules cannot preserve behavior.
- CSV exports report unsupported nested content instead of silently losing it.
- 1k/10k/100k datasets measure compile/reload, memory, latency and throughput.
- Default tests run against local HTTP/fake services; ngrok is optional.
- Load tests use bounded owned targets and do not follow third-party redirects.
- Invalid reload preserves working config; secret values stay out of artifacts.
- Installation claims match tested OS/architecture packages.

Implementation runtime, exact schema/function API, first adapter order and package
format are decided through early prototypes. Do not invent performance targets
or advertise all providers before they pass tests.
