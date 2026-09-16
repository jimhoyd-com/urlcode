# Public roadmap

This is the public delivery sequence. Tests accompany every feature, not a
separate late phase. The first executable alpha now covers much of M0/M1 plus
initial process/container packaging and benchmarks. No milestone is declared
fully complete; provider adapters and the stable-release gates remain open.

## Native assets — 0.1.0-alpha.3

Implemented the page/static/download portion of M2: project-contained asset
snapshots, automatic MIME types, attachment names, HEAD, cache validators and
single byte ranges. Dedicated public directories, symlink/hardlink rejection and
bounded memory are part of the contract. [Asset guide](docs/ASSETS.md).
Bulk tools, templates and signals remain open; M2 is not complete.

## Security correction — 0.1.0-alpha.2

All function code is untrusted. Node host execution has been replaced by
QuickJS/WebAssembly isolation with fresh invocation state, no ambient host or
network APIs, bounded resources, restricted module graphs and revision-pinned
operator binding policy. This protection is part of the free product, not deferred
until Cloud. See the [security model](docs/FUNCTION-SECURITY.md). Full Fetch/Node
API compatibility and network integrations are not supported by this alpha.

## Earlier implementation checkpoint — 0.1.0-alpha.1

Implemented: versioned strict YAML/JSON Schema subset, explicit file composition,
redirect/parameter semantics, JavaScript Request/Response functions with bounded
workers, scoped binding context, init/add/validate/dev/serve/test/doctor, indexed
snapshots, last-good reloads, graceful shutdown, health/readiness, safe request
logs, two runnable starters, ESLint and unit/HTTP/package tests. Cross-platform
CI and a non-root container build are included. See the [contract](docs/SPECIFICATION.md)
and [operations guide](docs/OPERATIONS.md) for exact support and evidence limits.

Still open in the early contract: host namespaces, stable identity beyond paths,
TypeScript support, fuller parameter vocabulary and capability/artifact planning.
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
| M6 — define optional Cloud, then build | Flesh out product/architecture from actual operational needs after free-version launch and stability | Free version launched and stable; feedback reviewed before Cloud scope is defined |

The first full public release is M4; earlier alphas/betas are useful but labeled
with their supported scope. Managed Cloud, a marketplace and advanced stateful
features are not prerequisites. No web UI/TUI or framework-hosting platform.
Netlify starts as redirect interchange after the initial provider adapters.

## Launch and stabilize the free version; then define Cloud

The sequence is: build the free version → launch → gather feedback and stabilize
real deployments → flesh out Cloud's product and architecture → build Cloud.
Feedback begins with usable alphas, but feedback alone is not the Cloud gate:
the free version must be launched and stable first.

Stability means repeatable installs/upgrades, dependable routing/functions,
working deployment and rollback, useful diagnostics, and serious recurring
issues from actual users addressed. Review that evidence before beginning
Cloud discovery; do not invent a calendar deadline or adoption-count threshold.

Keep Cloud as the architectural direction now: reusable runtime/compiler,
provider adapters, separate configuration and secrets, versioned artifacts,
Git-owned definitions and observable behavior. These boundaries also benefit
self-hosters. Avoid assumptions that would force users to rewrite projects later.

Do not build or flesh out Cloud-specific billing, tenancy, UI, control-plane
services, pricing or infrastructure now. Existing Cloud material is a set of
future hypotheses, not a committed specification. After the free version is
launched and stable, use its operational feedback to define Cloud's actual scope.
No artificial restrictions in the free version. License selection stays deferred.

## Prove the platform with Placecode and Peercode

Build Placecode, a short URL for a place, and Peercode, a short session code for
WebRTC camera/screen sharing and collaborative pointer/click indicators. Their
planned demo domains are `placecode.com` and `peercode.com`.

Prototype alongside M1/M2 and deploy on self-managed infrastructure in M3/M4.
Use normal public routes/functions/assets plus explicitly documented app-owned
state/realtime services. No private runtime fork or Cloud dependency. A Peercode
session is runtime data behind a parameterized route, not a new Git commit.
The demos can have browser UIs; the URLCode core remains CLI-first.

Success means another builder can run, deploy and adapt both with documented
setup, measured effort and no hidden services. Feed shortcomings into the free
product before declaring it validated/stable. Alphas need not wait for completed
demos. Later migrate the same projects to Cloud after Cloud is defined and built;
that does not move Cloud work ahead of the free launch/stability gate.

## Starter delivery

The [starter plan](docs/STARTERS.md) makes both Git clone and CLI initialization
release requirements: redirect/dynamic projects in M1, bulk-growth examples in
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
or advertise all providers before they pass tests. License selection is deferred
and does not block development or code pushes.
