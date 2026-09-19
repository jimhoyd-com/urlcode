# Release readiness

Status: `0.4.0-alpha.1` alpha of the extension contract and agent tooling on
top of the `0.3.0` self-hosted release. Production approval remains specific to
the workload and deployment environment.
This register describes the current public runtime, not future promises.
Use the contract and docs from the same pinned commit as your installed runtime.

## What is aligned

- One portable YAML project, explicit includes, one handler per route (redirect, respond, page, static, download, function, proxy, conditional or extension),
  per-route middleware and consistent request/response validation.
- One starter with a function route first and an ordinary redirect second.
  Clone urlcode-template or use `urlcode init`; neither requires a database.
- Native handlers avoid user-code execution unless middleware is attached.
- Functions/middleware run trusted and unsandboxed by default (in-process,
  full Node access); `sandbox: true` opts a route into isolated QuickJS/WASM
  with no ambient filesystem, network or Node APIs (docs/SPIKE-DEFAULT-TRUST-MODEL.md).
  Host bindings require external revision-pinned approval either way.
- The runtime is released under Apache-2.0.

## Regression evidence

`npm run verify` is the lint, syntax/schema-reference and unit/HTTP regression gate.
`npm run test:package` installs the packed artifact and exercises initialized apps,
route audits, bounded benchmarks and assets. CI runs Node 22/24/26 on
Linux/macOS/Windows and tests the container under resource restrictions.

| Area | Covered behavior | Practical limit |
|---|---|---|
| Routing and HTTP | Exact/parameter/static precedence, methods, inputs, assets, middleware and response assertions | Stable 0.1 contract; unsupported semantics reject rather than emulate |
| Isolation | `sandbox: true` capability/permission boundaries, deadlines, memory and invalid outputs; the trusted default's grant scoping | Not an independent security assessment or multi-tenant service certification; trusted-route code safety is the project's own call |
| Overload | Function/store queue caps; HTTP admission saturation, separate bounded probe budget, health availability and recovery after upload completion/disconnect | 64 application requests default; no fairness, upstream DDoS protection or end-to-end deadline |
| Worker replacement | Repeated guest deadlines shed load and the pool returns to service after backoff, rather than latching off for the life of the process | Store-connection replacement shares this logic but its failure branch has no automated test; a crash there is covered by reasoning and review only |
| Persistence | Committed writes visible to independent readers; concurrent CAS, restart and abrupt writer exit | SQLite on one host; no distributed availability |
| Shutdown | Full accepted store queue drains; new work rejects; repeated close shares completion | Existing deadlines can still fail; uncertain writes must be reconciled |
| Management | Token boundaries, body limits, origin rejection, conditional mutations, endpoint-specific Allow headers | Private operator API, not public end-user account management |
| Activation/recovery | Invalid reload retains last-good snapshot; corrupt revision metadata rejects activation | No deployment orchestration or automatic database repair |
| Packaging | Packed installation and starter examples tested; sensitive files excluded | No published npm/Homebrew release or provider adapter guarantee |

`npm audit --omit=dev` now runs in CI and fails the build on any runtime advisory;
development-only advisories are reported without blocking. Dependabot proposes npm,
GitHub Actions and base-image updates weekly. Actions and the container base image
are pinned by immutable SHA/digest, so a rebuild cannot silently change the runtime.
A passing audit is a dated check against known advisories, not proof of safety.

## Gates before production approval

These remain open. Record workload, runtime/app/image revisions, environment,
commands, results and owner for each exercise; do not convert a passing local
benchmark into a universal throughput claim.

1. Independent review of host/sandbox boundaries.
2. Sustained load and soak on intended hardware, through the actual TLS/proxy
   path: successful throughput, tail latency, 503/504 rate, RSS and recovery.
   `urlcode benchmark --target` measures a running deployment through its real
   path and separates shed responses from transport errors; see
   [load testing](LOAD-TESTING.md). The tool is GET/HEAD only and caps at 300
   seconds, so it does not by itself close this gate.
   Include mixed native/function workloads and slow peers.
3. Kill/restart, resource exhaustion and rolling deployment/rollback
   exercises with the chosen supervisor and ingress. A future durable-state
   extension needs its own backup/restore drill; core has no durable store.
4. Alerting and ownership for sustained errors, latency, readiness, dropped logs,
   disk space, restarts and backups. Pick service objectives for the actual app.
5. Stable-release support commitments before packaging/public reuse claims.
   Private security reporting and the current support baseline are documented in
   SECURITY.md.

License selection is resolved: URLCode is released under the Apache License 2.0,
`package.json` declares it, and the repository carries the full license text.
The remaining gates above are engineering and operational, not legal.

The unreleased next-phase source now includes strict bulk/provider interchange,
local recipes, TypeScript authoring, bounded self-hosted proxy/signals and read-only
MCP. Local AWS/Vercel/Cloudflare adapter tests and deployment probe tooling exist,
but actual provider deployments remain unverified. Node process/container hosting
remains the reference execution target. Guest networking, durable signals and
realtime capabilities are not provided. See [implementation status](NEXT-PHASE-PLAN.md)
and [roadmap](../ROADMAP.md); these additions do not close the operational gates above.

The [internal security audit](SECURITY-AUDIT.md) records reproduced findings, fixes
and prioritized gaps. Its regressions supplement these gates; they do not replace
independent assessment or real deployment exercises.

## Hardening follow-up

Implemented: bounded YAML workers and aggregate source budgets, cooperative route
compilation deadline, loopback-only management, scoped/expiring/revocable operator
credentials, atomic SQLite mutation audits, executable local/CI operational drills,
and a main-only candidate signing/SBOM workflow.

Still required: [independent review](SANDBOX-REVIEW.md), [actual deployment proof](OPERATIONAL-PROOF.md),
and publication/support arrangements. The Apache-2.0 license and the 0.3.0 self-hosted
release do not close the security and deployment gates. See [release process](RELEASE-SECURITY.md).
