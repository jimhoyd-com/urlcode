# Release readiness

Status: this register records evidence and open gates for the public runtime.
It deliberately carries no current version table: the manifests are the version
authority, [VERSION-ALIGNMENT.md](VERSION-ALIGNMENT.md) explains channels and
ownership, and `npm run release:status` reads live registry and tag state. A
stable release is a packaging fact. It is not production approval and does not
perform any gate under "Gates before production approval" below; neither does a
passing CI run. Production approval remains specific to the workload and
deployment environment. Registry channels and deployments were not re-checked
when this register was reconciled on 2026-09-20 (#242).
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
| Packaging | Packed installation and starter examples tested; sensitive files excluded | Published versions and channels: see VERSION-ALIGNMENT.md and `release:status`; this row asserts none. Dated registry observations are kept under "Dated packaging observations" below. GitHub Releases attach a Homebrew formula (`urlcode.rb`) for manual copy into a tap, not an automated Homebrew Core/tap publish. No provider adapter guarantee. |

## Dated packaging observations

Kept as observed; each is true only of its date and none is current status.
Use `npm run release:status` for the present.

- **2026-09-19, registry check.** `@jimhoyd/urlcode` had `latest` = `0.3.0` and
  `alpha` = `0.4.0-alpha.1`; the repository then stood at `0.4.0-alpha.2`, which
  was unpublished. Published extension packages that day:
  `@jimhoyd/urlcode-auth@0.1.0-alpha.2`, `@jimhoyd/urlcode-admin@0.1.0-alpha.2`,
  `@jimhoyd/urlcode-ui@0.1.0-alpha.4`.
- **2026-09-19, retired packages.** `@jimhoyd/urlcode-short@0.1.0-alpha.1`,
  `@jimhoyd/urlcode-dynamic-link@0.1.0-alpha.1` and
  `@jimhoyd/urlcode-middleware@0.1.0-alpha.2` were published that day, then
  retired and unpublished later the same day; all three repositories were
  deleted. Middleware's withdrawal removed no capability: per-route middleware
  is native to core.
- **2026-09-19, observed in passing.** auth's dist-tags were split (`alpha` at
  `0.1.0-alpha.2`, `latest` at `0.1.0-alpha.1`), so a plain install resolved a
  build below admin's declared floor.
- **Later 2026-09-19 or after (the source did not date these; treat as
  superseded).** auth and admin both read `latest` = `alpha` =
  `0.1.0-alpha.3`, resolving the split above; `@jimhoyd/urlcode-ui` carried a
  deliberate `alpha` = `0.1.0-alpha.6` / `latest` = `0.1.0-alpha.5` split, safe
  only because admin's ui floor was exactly `>=0.1.0-alpha.5`. The stable
  `0.4.1` alignment postdates these. The current aligned release is described
  in [VERSION-ALIGNMENT.md](VERSION-ALIGNMENT.md).

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
5. Stable-release support commitments before packaging/public reuse claims;
   a stable release exists, but that does not by itself record such commitments.
   Private security reporting and the current support baseline are documented in
   SECURITY.md.

License selection is resolved: URLCode is released under the Apache License 2.0,
`package.json` declares it, and the repository carries the full license text.
The remaining gates above are engineering and operational, not legal.

The next-phase source (shipped in the alpha releases; see the archived plan) includes strict bulk/provider interchange,
local recipes, TypeScript authoring, bounded self-hosted proxy/signals and read-only
MCP. Local AWS/Vercel/Cloudflare adapter tests and deployment probe tooling exist,
but actual provider deployments remain unverified. Node process/container hosting
remains the reference execution target. Guest networking, durable signals and
realtime capabilities are not provided. See [implementation status](archive/2026-09-19/NEXT-PHASE-PLAN.md)
and [roadmap](../ROADMAP.md); these additions do not close the operational gates above.

Detailed internal source-review findings and regressions are private maintainer
material. They supplement these gates; they do not replace independent assessment
or real deployment exercises.

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
