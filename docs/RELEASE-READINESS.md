# Release readiness

Status: `0.4.0-alpha.2` (`package.json`) alpha of the extension contract and
agent tooling on top of the `0.3.0` self-hosted release; `0.4.0-alpha.1` is the
most recent alpha actually published; the npm dist-tags for `@jimhoyd/urlcode`
were `latest` = `0.3.0` and `alpha` = `0.4.0-alpha.1` when checked against the
registry on 2026-09-19, so the repository's `0.4.0-alpha.2` is unpublished (see
"Packaging" below). Production approval remains specific to
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
route audits, bounded benchmarks and assets. On a push to `main`, CI runs Node
22/24/26 on Linux/macOS/Windows (nine combinations) and tests the container
under resource restrictions; a pull request runs the same Node versions on
Linux only (`.github/workflows/ci.yml`'s matrix), with the macOS/Windows legs
deferred to the post-merge run.

| Area | Covered behavior | Practical limit |
|---|---|---|
| Routing and HTTP | Exact/parameter/static precedence, methods, inputs, assets, middleware and response assertions | Stable 0.1 contract; unsupported semantics reject rather than emulate |
| Isolation | `sandbox: true` capability/permission boundaries, deadlines, memory and invalid outputs; the trusted default's grant scoping | Not an independent security assessment or multi-tenant service certification; trusted-route code safety is the project's own call |
| Overload | Function pool queue caps; HTTP admission saturation, separate bounded probe budget, health availability and recovery after upload completion/disconnect | 64 application requests default; no fairness, upstream DDoS protection or end-to-end deadline |
| Worker replacement | Repeated guest deadlines shed load and the pool returns to service after backoff, rather than latching off for the life of the process | Bounded by the configured worker count; no cross-process load balancing |
| Shutdown | New work rejects; repeated close shares completion | Existing deadlines can still fail during shutdown |
| Activation/recovery | Invalid reload retains last-good snapshot; corrupt revision metadata rejects activation | No deployment orchestration |
| Packaging | Packed installation and starter examples tested; sensitive files excluded | `0.3.0` and `0.4.0-alpha.1` are published to npm as `@jimhoyd/urlcode` (`latest` and `alpha` dist-tags respectively; dist-tags verified against the npm registry on 2026-09-19, when the repository stood at the unpublished `0.4.0-alpha.2`). Published extension packages on the same date: `@jimhoyd/urlcode-auth@0.1.0-alpha.2`, `@jimhoyd/urlcode-admin@0.1.0-alpha.2`, `@jimhoyd/urlcode-ui@0.1.0-alpha.4`, `@jimhoyd/urlcode-middleware@0.1.0-alpha.1`. (`@jimhoyd/urlcode-short@0.1.0-alpha.1` and `@jimhoyd/urlcode-dynamic-link@0.1.0-alpha.1` were also published that date, then retired and unpublished later the same day; their repositories were deleted.) Observed in passing: auth's dist-tags are split — `alpha` points at `0.1.0-alpha.2` while `latest` still points at `0.1.0-alpha.1`, so a plain `npm install @jimhoyd/urlcode-auth` resolves the older alpha. GitHub Releases attach a Homebrew formula (`urlcode.rb`) for manual copy into a tap, not an automated Homebrew Core/tap publish. No provider adapter guarantee. |

`npm run check:downstream-skills` is a manual, advisory report worth running
before a release: it diffs core's `.claude/skills/` copies against copies
vendored by downstream repositories (currently `urlcode-template`) when that
repository is cloned as a sibling checkout, and prints how many lines differ
per skill. It never fails and never asserts which side is correct -- a
downstream repo commonly pins an older published core version, and
divergence from core's current `main` can be the *correct* reflection of
that pin rather than staleness (see issue #155). It is not part of `check`
or `verify` because it depends on an out-of-repo sibling checkout that
normal CI does not have; it is a prompt to review the diff against the
downstream pin, not a pass/fail gate.

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
realtime capabilities are not provided. See [implementation status](archive/2026-09-19/NEXT-PHASE-PLAN.md)
and [roadmap](../ROADMAP.md); these additions do not close the operational gates above.

The [internal security audit](SECURITY-AUDIT.md) records reproduced findings, fixes
and prioritized gaps. Its regressions supplement these gates; they do not replace
independent assessment or real deployment exercises.

## Hardening follow-up

Implemented: bounded YAML workers and aggregate source budgets, cooperative route
compilation deadline, scoped/expiring/revocable operator credentials for host
bindings, executable local/CI operational drills, and a main-only candidate
signing/SBOM workflow. The loopback-only management API and its atomic SQLite
mutation audits were part of the `link`/`dynamicLinks` store that PR #126
removed from core; that functionality moved to the `urlcode-dynamic-link`
extension (docs/EXTENSIONS.md), which was retired and unpublished on
2026-09-19. No supported stored-link package ships today, and this runtime does
not provide one: a project needing a durable link store owns it itself.

Still required: [independent review](SANDBOX-REVIEW.md), [actual deployment proof](OPERATIONAL-PROOF.md),
and publication/support arrangements. The Apache-2.0 license and the 0.3.0 self-hosted
release do not close the security and deployment gates. See [release process](RELEASE-SECURITY.md).
