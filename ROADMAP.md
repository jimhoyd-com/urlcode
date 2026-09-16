# Public roadmap

All milestones are planned; no runtime exists yet. This is the public delivery
sequence. Tests accompany every feature, not a separate late phase.

| Milestone | Scope | Completion evidence |
|---|---|---|
| M0 — contract/build loop | YAML schema, matching/input semantics, function API, composition, runtime/packaging prototype, CI | Fixture validates; invalid definitions fail; verification runs |
| M1 — local alpha | CLI, aliases, redirects, parameters, custom functions, env/secrets, indexed routes and reload | Redirect plus function tested locally without accounts/DB; invalid reload preserves working version |
| M2 — bulk/reusable behavior | CSV/YAML/JSON, safe bulk edits/checks, templates, best-effort async signals, simple pages/static/downloads | 10k-route example, local side-effect tests, safe file serving, benchmark datasets |
| M3 — self-hosted beta | Process/container deployment, domain/TLS guide, packages/Homebrew, ngrok, monitoring and load tools | Install, test, deploy, observe and roll back a real project |
| M4 — provider public release | Cloudflare/AWS/Vercel adapters, provider conversion, capability/limit checks and stable docs | Baseline redirect/parameter/function fixtures on each advertised initial target; additional capability gaps explicit |
| M5 — advanced public features | Bounded proxies, protected/one-time downloads, durable signals/state, broader catalog and API/SDK/MCP | Feature-specific guarantees, tests and portable capability reports |
| M6 — optional managed Cloud | Git-connected managed deployments, domains/TLS, operations, secrets and isolation | Same source on managed infrastructure after the public foundation |

The first full public release is M4; earlier alphas/betas are useful but labeled
with their supported scope. Managed Cloud, a marketplace and advanced stateful
features are not prerequisites. No web UI/TUI or framework-hosting platform.
Netlify starts as redirect interchange after the initial provider adapters.

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
