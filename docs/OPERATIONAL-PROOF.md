# Operational evidence and deployment acceptance

`node scripts/operational-drills.ts` creates and deletes its own temporary
project. It runs mixed real HTTP requests against native redirects and
`function` routes; asserts responses; rejects a bad reload; and activates and
rolls back a configuration. `URLCODE_SOAK_SECONDS=60` selects a longer run
(1–3600 seconds, default 5). Output is JSON with request count, batch p99
duration and RSS. Batch latency is not per-request p99 or a capacity promise.
CI's `verify` job runs the short drill across a 3-Node (22/24/26) × 3-OS
(Linux/macOS/Windows) matrix, nine combinations, but only on a push to `main`.
A pull request runs the same drill across all three Node versions on Linux
only (3 of the 9 combinations); the macOS/Windows legs only run once a PR
merges, per `.github/workflows/ci.yml`'s matrix.

Core has no durable store of its own, so this drill has no backup/restore or
disk-exhaustion exercise: a future extension package owning durable state
(such as the planned `urlcode-dynamic-link`) is responsible for its own
persistence proof once it exists.

## Required proof on the intended deployment

Local/CI passes do not close these gates. `urlcode verify-deployment --target`
([deployment checks](DEPLOYMENT-CHECKS.md)) records that the deployed responses
match the project and is the first step of the rollback drill below, not a
substitute for it. The deployment owner must record:

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
