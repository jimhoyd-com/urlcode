# Release readiness

Status: executable alpha, undergoing hardening; not a stable production release.
This register describes the current public runtime, not future Cloud promises.
Use the contract and docs from the same pinned commit as your installed runtime.

## What is aligned

- One portable YAML project, explicit includes, seven mutually exclusive handlers,
  per-route middleware and consistent request/response validation.
- One starter with a function route first and an ordinary redirect second.
  Clone urlcode-template or use `urlcode init`; neither requires a database.
- Native handlers avoid user-code execution unless middleware is attached.
- Live links are mutable records behind a declared route. Git owns definitions;
  an optional external SQLite store owns records. This is single-host storage.
- Untrusted functions run in isolated QuickJS/WASM with no ambient filesystem,
  network or Node APIs. Host bindings require external revision-pinned approval.
- Free product first. Cloud remains a future compatible operator, after launch,
  stabilization and user feedback. License selection remains undecided.

## Regression evidence

`npm run verify` is the lint, syntax/schema-reference and unit/HTTP regression gate.
`npm run test:package` installs the packed artifact and exercises initialized apps,
route audits, bounded benchmarks, assets and live links. CI runs Node 22/24 on
Linux/macOS/Windows and tests the container under resource restrictions.

| Area | Covered behavior | Practical limit |
|---|---|---|
| Routing and HTTP | Exact/parameter/static precedence, methods, inputs, assets, middleware and response assertions | Alpha contract; unsupported semantics reject rather than emulate |
| Isolation | Sandbox capability/permission boundaries, deadlines, memory and invalid outputs | Not an independent security assessment or multi-tenant service certification |
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

1. Independent review of host/sandbox boundaries and authenticated management.
2. Sustained load and soak on intended hardware, through the actual TLS/proxy
   path: successful throughput, tail latency, 503/504 rate, RSS and recovery.
   Include mixed native/function/live-link workloads and slow peers.
3. A real backup/restore drill on a separate host/volume, with record/version
   reconciliation and measured recovery time/data loss. Keep SQLite WAL files
   consistent; copying a live main database file alone is not a backup.
4. Kill/restart, resource exhaustion, disk-full and rolling deployment/rollback
   exercises with the chosen supervisor, ingress and persistent storage.
5. Alerting and ownership for sustained errors, latency, readiness, dropped logs,
   disk space, restarts and backups. Pick service objectives for the actual app.
6. Release support/security reporting process before packaging/public reuse claims.
7. **License selection — blocking and unresolved.** No `LICENSE` file exists and
   `package.json` declares no license, so the published source carries no grant
   and is not legally reusable by anyone, including contributors. `private: true`
   prevents accidental registry publication but is not a substitute. This is a
   deliberate owner decision, not an engineering task: nothing else on this list
   can complete a public release without it.

The full free-product roadmap additionally includes bulk interchange tooling,
installers/Homebrew, provider adapters, reusable templates/signals and the
Placecode/Peercode showcases. Those features are not implemented merely because
YAML has a portable design. Node process/container hosting is the supported
execution target today; AWS/Vercel/Cloudflare adapters and guest network/realtime
capabilities remain future work. See [roadmap](../ROADMAP.md).

The [internal security audit](SECURITY-AUDIT.md) records reproduced findings, fixes
and prioritized gaps. Its regressions supplement these gates; they do not replace
independent assessment or real deployment exercises.
