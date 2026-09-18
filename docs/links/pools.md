# Dynamic links: Reader and writer pools

Part of [dynamic links](../DYNAMIC-LINKS.md), which indexes every page.

## Separate reader and writer pools

Pool sizes are operator infrastructure settings, not portable behavior YAML.
`dynamicLinks: true` and logical collection names stay the same across targets.

```sh
urlcode serve --project ./my-links \
  --link-store links=/absolute/links.sqlite \
  --link-readers 4 --link-read-limit 32

urlcode links api --project ./my-links \
  --store /absolute/links.sqlite --token-file /absolute/link-admin.token \
  --link-readers 2 --link-read-limit 16 --link-write-limit 8
```

| Control | Default | Meaning |
|---|---|---|
| `--link-readers` / JS `readers` | 2 | 1–8 read-only connections per store instance |
| `--link-read-limit` / JS `maxReads` | 32 | 1–32 admitted reads across all readers, not per reader |
| `--link-write-limit` / JS `maxWrites` | 32 | 1–32 admitted mutations across the single writer |

`get` and `list` use the least-busy healthy reader. `create`, `update` and `delete`
use the writer. Each worker serializes its own accepted operations. There is no
additional unbounded acquisition queue. A read flood cannot take writer admission
and a mutation backlog cannot take reader admission. CPU, disk, database locks
and the event loop remain shared resources: separation is not an isolation SLA.
A write response resolves after commit; a subsequent awaited read sees committed
data on the same database. Reads started before the commit may see the old value.
There is no replica lag or application cache in this adapter.

`openLinkStore({file, project, readOnly, readers, maxReads, maxWrites})` exposes
`stats()` with separate read/write connection counts, healthy counts, in-flight
counts, limits, completed/failed/rejected totals and cumulative durationMs. These
process-local counters reset at restart and are for trusted operator monitoring;
there is no public metrics endpoint/exporter yet. `readHealthy` and `writeHealthy`
are separate. Public runtime readiness uses `readHealthy` when available; management
operators must monitor writer health separately. A read-only pool has zero writers
and rejects mutations. Shutdown drains both groups and rejects new admission.

Do not multiply connection counts blindly across processes: N public replicas at
R readers use N×R connections, plus management readers/writers. Each connection
has its own worker and memory budget. Measure mixed load and lock contention;
adding readers can reduce performance on an already saturated disk.

SQLite WAL supports simultaneous readers and a single active writer across the
database. Multiple writer connections cannot create parallel write throughput.
All connections must access the same local database on one host; never mount it
across hosts over a network filesystem. See [SQLite WAL](https://www.sqlite.org/wal.html).
We require a Node build with SQLite 3.51.3+ or patched branches 3.50.7+/3.44.6+
to avoid the documented [WAL-reset concurrency bug](https://www.sqlite.org/wal.html#the_wal_reset_bug).
Live-link initialization checks this before opening files and verifies WAL mode.
Use `urlcode doctor` to inspect the bundled SQLite version; upgrade Node when
rejected. Static YAML projects do not require SQLite.

For multi-host scaling, a future server-database adapter must provide distinct
read/write credentials and pool budgets, connect/acquire/query deadlines,
transactional version checks, primary-read or explicit replica consistency,
replica-lag monitoring, migration coordination, backup/restore and failover drills.
These are adapter acceptance requirements, not implemented PostgreSQL support.
Keep writes on the primary and avoid automatic retries of ambiguous commits.
The existing operator adapter boundary remains available, but deploying a custom
adapter requires its own conformance/load/recovery evidence.

## Shutdown and management defaults

`links api` defaults to private address `127.0.0.1:3001`; public serving defaults
to port 3000. Endpoint method errors return 405 with an `Allow` header.
Store shutdown rejects new work, drains accepted operations within each connection and
then closes SQLite. Repeated `close()` calls share completion. Existing operation
deadlines still apply: a timeout can leave a mutation outcome unknown, so read
the record before retrying. Missing/invalid revision metadata rejects startup.
