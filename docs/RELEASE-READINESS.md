# Release readiness

A stable release means the package was published. It does **not** establish
production readiness, independent security assessment, hostile multi-tenant
isolation or support commitments. Use the runtime, schema and documentation from
the same pinned commit. Manifests and `npm run release:status` are the source of
current version and channel state.

This is the one authoritative production-gate list. Other operational and
release guides link here instead of repeating it.

## Evidence in the repository

- `npm run verify` checks lint, types, generated references and unit/real-HTTP
  behavior. `npm run test:package` exercises the packed artifact and starter.
- CI covers supported Node and operating-system combinations, package fidelity,
  the constrained container and workspace compatibility. A passing check covers
  only its tested behavior.
- Native routes do not execute project code unless middleware is attached.
  Functions and middleware are trusted Node code by default; `sandbox: true`
  opts into the bounded QuickJS/WASM path. Binding injection is externally
  granted and revision-pinned in either mode.
- URLCode is Apache-2.0. The portable YAML contract, supported handlers and
  target limits are defined by the [specification](SPECIFICATION.md) and
  [capabilities](CAPABILITIES.md), not this page.
- `node scripts/operational-drills.ts` creates and deletes its own temporary
  project. It runs mixed real HTTP requests against native redirects and
  `function` routes; asserts responses; rejects a bad reload; and activates and
  rolls back a configuration. `URLCODE_SOAK_SECONDS=60` selects a longer run
  (1–3600 seconds, default 5). Output is JSON with request count, batch p99
  duration and RSS. Batch latency is not per-request p99 or a capacity promise.
  CI's `verify` job runs the short drill across a 3-Node (22/24/26) × 3-OS
  (Linux/macOS/Windows) matrix, nine combinations, but only on a push to
  `main`. A pull request runs the same drill across all three Node versions on
  Linux only (3 of the 9 combinations); the macOS/Windows legs only run once a
  PR merges, per `.github/workflows/ci.yml`'s matrix.
- Core has no durable store of its own, so this drill has no backup/restore or
  disk-exhaustion exercise: an extension owning durable state is responsible
  for its own persistence proof. Two do: `auth` keeps accounts and sessions in
  SQLite ([backup and restore](AUTH-BACKUP.md)) and `store` keeps JSON
  collections in an operator-owned directory ([store](STORE.md)). This drill
  exercises neither.

## Gates before production approval

The deployment owner must record the workload, exact revisions, environment,
commands, results and an accountable owner for each open gate:

1. Independent review of the host and `sandbox: true` boundaries.
2. Sustained load and soak through the real TLS/ingress path, with workload SLOs,
   tail latency, rejection/error rate, RSS and recovery evidence.
3. Kill/restart, resource-exhaustion and deployment/rollback exercises using the
   chosen supervisor and ingress. Durable-state extensions own their own
   backup/restore proof.
4. Tested alerting and ownership for errors, latency, readiness, logs, disk and
   restart failures.
5. Any support, publication or provider commitments needed for the deployment.

Local/CI passes do not close these gates. `urlcode verify-deployment --target`
([deployment checks](DEPLOYMENT-CHECKS.md)) records that the deployed responses
match the project and is the first step of the rollback drill below, not a
substitute for it. The deployment owner must record the following acceptance
evidence:

| Exercise | Acceptance evidence |
|---|---|
| Soak | At least 24 hours at expected peak and burst load through actual TLS/ingress; native/function mix, slow clients, response correctness, p50/p95/p99, throughput, error/rejection rate, RSS plateau, CPU and FD growth. Define numerical SLOs before starting |
| Kill/restart | Kill the server with outstanding requests. Reconcile uncertain mutations by request ID, restore readiness, and prove no duplicate side effects from application code |
| Rollback | Deploy candidate by exact digest beside last-good, run route assertions, switch ingress, drain, then switch back. Verify configuration/policy compatibility |
| Monitoring | Deliver test alerts for missing logs, sustained errors, pool rejection/failure, low disk, restart storms and failed readiness to a named on-call owner |

If your deployment adds a durable-state extension, add that extension's own
backup/restore, logical export/import and disk/log exhaustion exercises to
this table; core's proof above does not cover them.

Record date, operator, source/app/policy/image digests, topology, hardware/limits,
commands, duration, synthetic dataset size, raw metrics/log locations, result
and unresolved findings. A reviewer signs the acceptance record; a blank
record is not a pass.

[Sandbox review](SANDBOX-REVIEW.md) defines the independent-review gate.
[Development pipeline](DEVELOPMENT-PIPELINE.md) and
[release security](RELEASE-SECURITY.md) describe how candidates are built and
published. Dated registry checks, detailed source-review notes and superseded
release observations are private maintainer records, not current status.
