# Operational evidence and deployment acceptance

`node scripts/operational-drills.js` creates and deletes its own temporary project
and store. It runs mixed real HTTP requests against native redirects, isolated
functions and live links while updating records; asserts responses; rejects a bad
reload; activates and rolls back a configuration; then closes all users of the
store, explicitly verifies a successful WAL checkpoint, and restores a copied database. It checks integrity, record/version and
latest durable audit revision. `URLCODE_SOAK_SECONDS=60` selects a longer run
(1–3600 seconds, default 5). Output is JSON with request count, batch p99 duration,
RSS and restore time. Batch latency is not per-request p99 or a capacity promise.
CI runs the short drill on all six supported Node/OS combinations.

The container job additionally uses `--disk-full-dir /state` on a disposable
16 MiB tmpfs. It reserves recovery space, writes until a real volume exhaustion
failure, checks available disk space, releases the reserve, proves a subsequent
mutation succeeds, and checks integrity and equal committed link/audit counts.
Never point this option at production storage: it intentionally consumes up to
84 MiB of writes in a newly created temporary child directory. The CI mount is
nonpersistent. An I/O device failure or power cut is a different failure mode.

## Required proof on the intended deployment

Local/CI passes do not close these gates. The deployment owner must record:

| Exercise | Acceptance evidence |
|---|---|
| Soak | At least 24 hours at expected peak and burst load through actual TLS/ingress; native/function/live-link mix, slow clients, response correctness, p50/p95/p99, throughput, error/rejection rate, RSS plateau, CPU, FD and disk/WAL growth. Define numerical SLOs before starting |
| Restore | Restore a consistent backup onto a separate host/volume. Reconcile collection counts, latest committed revisions and audit journal; measure RPO/RTO against agreed targets. Test encrypted backup access and credential recovery |
| Logical export/restore | Run `links export` against a store under write load, restore it with `links import` onto a separate store, and reconcile record counts and every field. Prove the export's digest verifies, that a truncated stream is rejected, and that stale management ETags are discarded because the restore reassigns versions. An export carries no audit journal, so pair it with a file backup |
| Kill/restart | Kill server and writer with outstanding reads/writes. Reconcile uncertain mutations by version/request ID, run integrity checks, restore readiness, and prove no duplicate successful conditional writes |
| Disk/log exhaustion | Fill the actual disposable staging storage type and log destination. Verify bounded 503s, audit/mutation atomicity, alert delivery through an independent sink, reserve-space recovery and readiness after recovery |
| Rollback | Deploy candidate by exact digest beside last-good, run route assertions, switch ingress, drain, then switch back. Verify configuration/policy compatibility and audit continuity; never downgrade to an unaudited writer |
| Monitoring | Deliver test alerts for missing logs, sustained errors, pool rejection/failure, low disk, restart storms, backup age and failed readiness to a named on-call owner |

Record date, operator, source/app/policy/image digests, topology, hardware/limits,
commands, duration, synthetic dataset size, raw metrics/log locations, result,
RPO/RTO and unresolved findings. A reviewer signs the acceptance record; a blank
record is not a pass. Do not copy only the main file of a live WAL database.
The executable local drill uses a fully quiesced, explicitly checkpointed database intentionally. A last
read-only connection can leave WAL frames even after every connection closes;
closing alone is insufficient proof that the main database file is a full backup. For a
live-backup system, prove its SQLite-consistent snapshot method separately.
