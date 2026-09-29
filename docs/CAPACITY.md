# Capacity, concurrency and system limits

These are the current implementation limits and planning models, not a throughput
SLA. Route count, connections, in-flight requests and sandbox concurrency are
four different quantities. Always measure the actual application on deployment
hardware with the intended proxy, TLS, logging and limits enabled.

## What happens for each request

A single Node process accepts HTTP, parses/validates inputs, matches a compiled
route and builds the response. Exact routes use a Map lookup (expected O(1)
lookup after path parsing). Parameter candidates are grouped by segment count
and scanned in specificity order; matching is O(P × L) in the worst case for P
candidates and L segments. Static mount prefixes are scanned longest first.

Plain redirects, declared responses and assets do not enter
the sandbox or the trusted executor.

`function`/`middleware` routes have **two distinct capacity models**, chosen
per route by `sandbox` (docs/SPIKE-DEFAULT-TRUST-MODEL.md):

- **`sandbox: true` (the isolated worker pool, unchanged from every earlier
  release):** a function or any attached middleware occupies one shared
  worker slot for its whole chain. Workers are shared by all `sandbox: true`
  routes in that snapshot; there is no per-route fairness or reserved
  capacity. Awaiting guest timers still occupies the slot. A fresh guest and
  module initialization are part of each call. See "Enforced limits and
  defaults" below for the numbers (2 workers, 5 s deadline, 32 MiB heap).
- **`sandbox` false/absent (the trusted default):** the call runs in-process,
  on the same event loop as everything else the server does — ordinary Node
  concurrency, not a fixed worker-slot ceiling. There is no separate pool to
  exhaust and no per-invocation heap/module reset: it is bounded by the same
  `--max-in-flight` HTTP admission cap (default 64) that bounds every other
  request, not by a `workers` count. A trusted call's declared `timeoutMs`
  races the call's own promise rather than forcibly terminating a worker
  thread — see "Trusted-path deadlines" below for what that does and does not
  protect against.

  This was architectural reasoning, not a measurement, until the run below:
  see "Measured: sandboxed vs trusted dispatch" for the actual comparison.

Node's main event loop remains a shared bottleneck for HTTP parsing, logging and
native responses. The sandbox contains a `sandbox: true` route's application
code authority and bounds its individual execution; the trusted default does
not attempt to, by design. Neither mode makes all host resources immune to
exhaustion.

### Trusted-path deadlines

A sandboxed worker's deadline is enforced by an interrupt handler the WASM
engine checks between guest operations, backed by an independent outer
termination that kills the worker thread if the guest never yields — the
worker (and its slot) can be forcibly reclaimed even from a stuck call. A
trusted, in-process call has no such mechanism available: `timeoutMs` starts
a race between the call's promise and a timer, so a call that never resolves
(an unresolved promise, an awaited operation that never completes) is
answered with a 504 on schedule, but a call that blocks the event loop
*synchronously* (an infinite `while` loop, a huge synchronous computation)
is not preempted — it keeps running, delays that timer's own firing, and
holds up every other request on the same process until it returns control to
the event loop or the process is restarted. This is a real, documented
difference from the sandboxed path's guarantee, not an oversight: Node has no
supported way to interrupt another turn of the same thread's event loop from
inside it. A route whose trusted code cannot be trusted to yield promptly is
exactly the kind of route `sandbox: true` exists for.

## Enforced limits and defaults

| Resource | Current behavior | Scope / configuration |
|---|---|---|
| Routes | 100,000 combined | Per project snapshot; schema/loader cap |
| Parameter routes | 1,000 | Per snapshot; not 1,000 concurrent requests |
| Included files / YAML size | 256 / 32 MiB per file / 64 MiB aggregate | Parser worker: 256 MiB old heap, 10 s deadline, two concurrent loads per isolate |
| Route path | 2,048 characters, 32 segments | Configured path; no regex or greedy parameters |
| Request target / headers | 8,192 characters / 16 KiB headers | Target is checked as a JS string; HTTP header limit is bytes |
| HTTP connections | 1,024 | Per server; includes keep-alive sockets, not worker slots or users |
| In-flight application requests | 64 default, no queue; excess gets 503 | From body receipt through response finish/disconnect; health probes exempt |
| Socket inactivity | 15 s | Destroys inactive sockets, including stalled response writers; not an absolute response deadline |
| Requests per socket | 1,000 | Connection recycling; not a requests-per-second limit |
| Header / request receipt / keep-alive timeouts | 10 s / 15 s / 5 s | These are not an overall end-to-end response deadline |
| Request body | 1 MiB default | Buffered; route maxBytes can tighten to 0–1 MiB |
| Sandbox concurrency (`sandbox: true` only) | 2 workers, no queue | Shared per `sandbox: true` snapshot; full pool returns 503 |
| Sandbox execution deadline (`sandbox: true` only) | 5 s default | Entire middleware + handler invocation; forcibly terminates the worker; timeout returns 504 |
| Trusted concurrency (`sandbox` false/absent, the default) | Ordinary Node concurrency | Bounded by `--max-in-flight` (default 64), not a worker count; no separate pool to exhaust |
| Trusted execution deadline (`sandbox` false/absent) | 5 s default (same `timeoutMs` knob) | Races the call's promise; cannot preempt synchronous event-loop-blocking code (see "Trusted-path deadlines" above); timeout returns 504 |
| Guest heap / stack (`sandbox: true` only) | 32 MiB / 512 KiB | Fresh per invocation; not a bound on total process RSS |
| Outer worker old-generation V8 budget (`sandbox: true` only) | 128 MiB | Separate from WASM/host/native allocations |
| Function response | 1 MiB default, 16 KiB / 256 header pairs | Buffered text/JSON; YAML headers also bounded; applies to both execution modes |
| Middleware | 16 entries per route | One shared slot/deadline (`sandbox: true`) or one in-process call (trusted), not 16 independent workers either way |
| Function sources (`sandbox: true` only) | 128 modules, 1 MiB/module, 4 MiB total | Sandboxed snapshot, including middleware dependencies; a trusted route's own source is hashed for grant pinning but not bundled or budget-limited this way (see docs/FUNCTION-SECURITY.md) |
| Worker startup (`sandbox: true` only) | 5 s deadline | Failure rejects activation; no untrusted host fallback |
| Worker replacement (`sandbox: true` only) | Up to 3 exits/minute per slot trigger replacement | Further churn leaves the slot unavailable until reload/restart |
| Assets | 16 MiB/file, 64 MiB unique contents | Buffered immutable snapshots; 10,000 static entries, depth 20 |
| Logger buffering | Drop at 1 MiB stdout buffering | Reports logs_dropped when output recovers |

The 1,024-connection cap is not a global memory bound, fairness policy or DDoS
protection. At the default admission/body limits, accepted uploads can buffer up to
64 MiB of payload before copies and other allocations. Slow readers can hold
sockets/response memory until completion/disconnect or the 15-second inactivity
timeout. A peer that continues making progress can stay connected longer. Use
proxy admission limits, timeouts and OS/container limits.

The CLI and the embedding JS API accept `--workers`/`workers` (1–32),
`--function-timeout-ms`/`timeoutMs` (10–60,000), `--max-response-bytes`/`maxBytes`
(response limit, 1–16 MiB), `--max-body-bytes`/`maxBodyBytes` (request limit, 1–16 MiB),
`--max-in-flight`/`maxInFlightRequests` (1–1,024; default 64) and
`--max-in-flight-health`/`maxInFlightHealthRequests` (1–1,024; default 16). Measure the effect with
[load testing](LOAD-TESTING.md) rather than guessing; `shedResponses` names the
limit that bound. These are
operator choices on `startServer`, not supported YAML fields or CLI flags.
Route body policy still cannot exceed 1 MiB. More workers consume memory and CPU;
increasing a timeout also increases how long an attacker can occupy capacity.
The CLI uses defaults. Keep settings identical across replicas unless testing a
controlled rollout. See [operations](OPERATIONS.md).

### Extension storage bounds

The first-party extensions that keep state bound it themselves.
Each bound refuses rather than growing without limit:

| Resource | Bound | When full |
|---|---|---|
| Audit log | keeps the newest `extensions.audit.config.retention` events (default 100,000; 1,000 to 10,000,000) | older events are pruned |
| Store records | `maxRecords` per collection (default 1,000, at most 10,000), `maxRecordBytes` each (default 4,096, at most 65,536), at most 32 collections, all in one SQLite database | a create answers `409 collection_full`, an oversized record `413` |
| Store writes | one SQLite transaction at a time per database, each fsynced (`synchronous=FULL`, unless the operator chose [`durability: 'normal'`](STORE.md#durability)) before it answers; statements are synchronous, so each commit blocks the event loop for its fsync | a write blocked by another process's lock for 2 s answers `503 storage_unavailable` |
| Store sorted or filtered lists | read the `id` and the named fields of every record in scope (at most `maxRecords`), then the page | bounded by `maxRecords` and `pageSize` (at most 200) |
| Audit outboxes | 1,000 undelivered events per audited store collection | the write that would add an event answers `503 audit_backlog` and changes nothing |
| Disk space for `store.sqlite`, `auth.sqlite` and `audit.sqlite` | the free space of the data directory's filesystem; no quota of its own | a store write answers `503 storage_unavailable`, a sign-in `503 auth_unavailable`, audit delivery waits in the outbox; nothing partial is written, and writes resume once space frees ([disk-full tests](STORE.md#what-the-disk-full-tests-prove)) |

The store's database path and commit durability are operator choices in `host.mjs`; the store and
audit bounds are reviewed YAML. See the
[store](STORE.md#storage-and-concurrency-what-it-does-and-does-not-guarantee)
and [audit](../packages/audit/README.md) packages. One local measurement of the store
follows; establish your own on your disk before relying on it.

### Measured: the SQLite store

Evidence for [#859](https://github.com/jimhoyd-com/urlcode/issues/859) items 1
and 5, from `npm run bench:store` (source:
[`packages/store/bench/store-throughput.ts`](../packages/store/bench/store-throughput.ts);
`-- --quick` for a short check, `-- --json <file>` for raw results). It is a
single-machine development measurement, not a production guarantee or a
sizing rule.

**Machine.** Apple M4 Pro (12 cores, 48 GiB), macOS 26.6 on the internal APFS
SSD, Node 26.10.0 with its bundled SQLite 3.53.4, 2026-09-28. Two full runs;
the figures below are the first, and the second agreed within about 15%.

**Method.** The server runs in a child process (`startServer` with the store,
audit and a header-based principal extension, no TLS, no proxy, logging off);
the parent drives it with a keep-alive `node:http` client at a fixed
concurrency over loopback. The collection is `ownership: owner` with
`idempotency: {maxKeys: 1000}`, `maxRecords: 10000`, `pageSize: 100`, two
sortable and one filterable field and a declared transition; one copy has
`audit: true` (its events drain into a real audit database), one does not.
Every write sends a fresh `Idempotency-Key`; each `PATCH` and transition sends
the record's current `If-Match`. The server samples its own event loop with
`monitorEventLoopDelay` (1 ms resolution, so values near 1 ms are the floor)
during each phase. List sizes are seeded directly into the database before the
server starts, all owned by the calling principal.

**Writes** (3,000 requests each, concurrency 16, every one answered 2xx):

| Write | audit off: writes/s | p50 / p99 ms | audit on: writes/s | p50 / p99 ms |
|---|---:|---:|---:|---:|
| `POST` create | 5,127 | 2.8 / 10.3 | 2,968 | 4.9 / 11.7 |
| `PATCH` with `If-Match` | 7,033 | 2.1 / 4.7 | 3,033 | 4.8 / 11.4 |
| transition with `If-Match` | 7,527 | 1.9 / 4.5 | 3,061 | 4.7 / 10.9 |

Event-loop delay during these writes was 1.9–4.8 ms at p50 and at most
19 ms, which at concurrency 16 is mostly the queue of ordinary request work,
not the commit. Auditing roughly halves write throughput: each event is a
second row in the same transaction plus a drain into the audit database.

**Commit cost in isolation** (one-row `BEGIN IMMEDIATE` transactions on a WAL
database, 3,000 each; the store's own setting was not changed):

| Setting | commits/s | p50 / p99 µs |
|---|---:|---:|
| `synchronous=FULL` (the store's default, `durability: 'full'`) | 19,313 | 41 / 136 |
| `synchronous=NORMAL` (`durability: 'normal'`) | 54,482 | 12 / 65 |
| `synchronous=FULL` with `fullfsync=ON` | 235 | 4,018 / 7,996 |

On this machine a `FULL` commit costs about 30 µs more than `NORMAL`, 1–2% of
a 2 ms write request, so the fsync is not what bounds store writes here. That
is a property of macOS: SQLite's default `fsync()` there does not flush the
drive's cache, and the `fullfsync` row shows what a real flush costs on the
same disk (about 4 ms, capping one database near 250 commits/s and blocking the
event loop for each). Linux `fsync` does flush, so `FULL` on a Linux server
costs something between these rows depending on the disk. **Measure on the
deployment's Linux host before reading these numbers as the store's write
ceiling there.** Where the fsync does bound writes, the operator can choose
[`store({durability: 'normal'})`](STORE.md#durability) per site: commits then
skip it, and the last ones before a power loss or OS crash can be lost (a
process crash loses nothing). The default stays `full`.

**Lists** (HTTP, concurrency 1, 400 requests each; the last row at
concurrency 16):

| Records | Query | page 20: p50 / p99 ms | page 100: p50 / p99 ms |
|---:|---|---:|---:|
| 1,000 | unsorted | 0.24 / 0.65 | 0.40 / 1.15 |
| 1,000 | `sort=title` | 0.96 / 1.45 | 1.28 / 1.84 |
| 1,000 | `kind=b&sort=title` | 1.05 / 1.42 | 1.27 / 1.74 |
| 10,000 | unsorted | 0.39 / 0.87 | 0.60 / 1.29 |
| 10,000 | `sort=title` | 8.7 / 11.2 | 10.1 / 12.7 |
| 10,000 | `kind=b&sort=title` | 9.9 / 13.1 | 11.0 / 81 |
| 10,000 | `sort=title`, concurrency 16 | — | 152 / 712 (80 lists/s) |

A sorted or filtered list reads every record in scope and orders it in memory,
synchronously: at the 10,000-record maximum each one holds the event loop for
about 9 ms, so concurrent sorted lists queue behind each other (and behind
every write) and one process serves about 100 of them a second. Unsorted
lists stay under 1.3 ms at p99 at either size.

**Ordering in SQL instead** (in-process, no HTTP; the store's projection and
`runList` path against `ORDER BY ... LIMIT` over the same rows; 50,000 is above
the configurable `maxRecords` and shown only for the curve; p50 ms, page 100):

| Records | store (JS order) | SQL, no index | SQL, expression index on the sort field | filter + sort, SQL with that index |
|---:|---:|---:|---:|---:|
| 1,000 | 0.85 | 0.46 | 0.12 | 0.50 |
| 10,000 | 8.4 | 3.0 | 0.28 | 3.9 |
| 50,000 | 45.9 | 14.2 | 1.43 | 43 to 79 |

The SQL rows compare bytes (SQLite `BINARY`, UTF-8 order) rather than the
documented UTF-16 code-unit order; the benchmark's titles are ASCII, where the
two agree, so this measures cost, not a correct replacement. An `ORDER BY`
without an index is about 3× faster; only an index on the sort expression
removes the scan, and an equality filter it does not cover still scans (and
counts) every record in scope.

**Caveats.** Loopback only, one client process on the same machine, no TLS,
proxy or request logging; small records (about 150 bytes); one principal
holding every record; a fresh database per run; short runs (seconds), so no
WAL checkpoint pressure, fragmentation or long-run GC behaviour is captured;
macOS `fsync` semantics as described above.

## Sandbox and trusted dispatch

`sandbox: true` routes use the shared worker pool and return 503 when that pool
is full. Trusted routes use the ordinary Node event loop and are instead bounded
by the shared HTTP `maxInFlightRequests` admission cap. Measure either mode on
the deployment hardware and workload before sizing it. Historical comparison
code and results are kept privately by the maintainers and are not public
evidence; measure your own with [load testing](LOAD-TESTING.md).

## A useful theoretical model

This worker-slot model describes the `sandbox: true` path only. A trusted
route has no fixed worker count to plug in as W; its ceiling is ordinary Node
request concurrency bounded by `--max-in-flight`, not this model — see
"Measured: sandboxed vs trusted dispatch" above for what that ceiling looks
like in practice.

Let W be worker slots, S the measured mean slot occupancy in seconds (including
sandbox startup and cleanup effects), and lambda the offered programmable
requests per second. An idealized worker ceiling is:

```text
worker-limited throughput <= W / S
mean offered worker load A = lambda * S
```

This ignores CPU contention, event-loop work, garbage collection, worker failures
and network overhead. It is an upper bound under simplified assumptions, not a
recommended arrival rate. With the default W=2:

| Mean slot time S | Idealized ceiling W/S |
|---|---:|
| 5 ms | 400 requests/s |
| 50 ms | 40 requests/s |
| 500 ms | 4 requests/s |
| 5 s | 0.4 requests/s (at the timeout boundary; not useful successful capacity) |

No queue means requests are rejected when both slots are occupied, even if the
average arrival rate is below the ceiling. Under a simplified independent
Poisson-arrival loss model, Erlang B gives blocking probability:

```text
B(W,A) = (A^W / W!) / sum(k=0..W, A^k / k!)
```

For W=2 and S=50 ms, an offered 20 requests/s gives A=1 and B=20%. That is a
model illustration, not a measured URLCode result. Bursts, correlated traffic and
CPU-dependent service times can differ substantially. Measure rejection rate as
well as latency; fast 503 responses must not count as successful throughput.
An upstream bounded queue may smooth bursts but adds latency and memory; it is
not included in this runtime. Unbounded queues just move the failure.

Little's law, L=lambda*R, describes average in-flight work for a stable system
using admitted/completed throughput and mean residence time. It does not turn
1,024 sockets into 1,024 execution slots or predict tail latency. CPU and bandwidth
put separate ceilings on throughput. For CPU-bound work, adding workers beyond
available cores cannot produce linear scaling. Bandwidth must also carry asset
bytes, response headers, TLS and protocol overhead.

## Native routes and mixed traffic

For native-only traffic, the Node event loop, network, buffers and logging dominate;
the W/S sandbox model does not apply. Function saturation does not itself consume
native route worker slots. However all routes share the server/event loop and
host resources, so a flood can still degrade ordinary redirects and health checks.
A single expensive function can starve other functions. For stronger isolation,
use separate processes/containers and proxy routing; there is no per-route pool
configuration in YAML today.

Horizontal replicas can add capacity if balanced well and supplied identical
runtime/application revisions and bindings. Scaling is not perfectly linear,
and capacity falls during failures/rollouts. Rate limits must account for all
replicas. In-memory counters in middleware reset per request and cannot implement
a shared rate limiter or durable application state.

Optional [policies](POLICIES.md) keep their state per runtime instance, and
their memory bounds are per instance too: the `throttle` counter table is one
LRU table per runtime capped by the largest declared `maxKeys` (default
100,000 keys), and the `cache` policy's origin cache is bounded by its
`maxEntries` and `maxBytes` per route and by 64 MiB of bodies across the
whole runtime; the `compression` policy holds up to 64 MiB of precompressed
asset variants per runtime, the same figure as the asset snapshot itself, so
a fully policied instance can hold three such budgets. Neither is shared between replicas or
serverless instances, so a client budget across N replicas is up to N times
the declared quota and a cached response is computed once per replica. Both
tables are dropped on a snapshot reload. Sharing state across instances is a
[plugin](PLUGINS.md) concern.

### Several serving processes on one host

Several `urlcode serve` processes on one host, on distinct ports behind a
proxy and sharing one site's SQLite files, are supported
([store](STORE.md#several-serving-processes-on-one-host)). The per-instance
state above stays per process there too. A `throttle` quota allows up to N
times its budget across N processes, because each process counts only the
requests the proxy sends to it. Each process fills its own `cache` origin
cache, so a cached response is computed up to once per process. Metrics are
per process: scrape each process's port, not the proxy. When the store finds a
live peer at activation it logs one `extension_warning` saying so. The store,
auth and audit each refuse to activate while a live peer serves their database
from another host. A budget
that must hold across the processes belongs at the proxy or in a
[plugin](PLUGINS.md). Better Auth's sign-in limit is the one shared counter,
because it counts in `auth.sqlite`.

More processes add capacity for reads and for request work that does not
write. They do not add store write throughput. SQLite admits one writer at a
time, and a process waiting for the write lock blocks its own event loop for
up to the 2 second busy timeout before it answers `503 storage_unavailable`.
Size store writes from [the SQLite store measurement](#measured-the-sqlite-store)
as one database, whatever the process count.

`npm run test:multiprocess` checks correctness with three processes: the
store invariants, one audit drainer delivering each event exactly once, no
false `401` during a sign-in burst, and integrity after a `SIGKILL`
([what it proves](STORE.md#what-the-multi-process-harness-proves)). It
measures no throughput and is not a soak test.

## Memory, startup and reload

A practical memory budget includes the Node baseline, parsed YAML/compiled route
objects, asset snapshots, source copies in workers, WASM heaps, active request
and response buffers, sockets, logs and transient garbage collection allocations.
These are not all covered by worker heap limits. Production needs measured peak
RSS with an OS/container ceiling, plus headroom.

Reload constructs a complete new snapshot while the old one serves/drains. Old
and new assets and worker pools can overlap; repeated reloads with in-flight calls
can retain multiple generations. Host route compilation and snapshot transfer can delay the shared event
loop even though the HTTP listener is not restarted. Do not equate atomic swap
with zero latency impact or incremental route updates. Prefer candidate replicas
and traffic switching for production. `serve` does not watch configuration.

A trusted route's own entry file is re-imported fresh on every reload (see
[docs/FUNCTION-SECURITY.md](FUNCTION-SECURITY.md)), matching the sandboxed
pool rebuilding its whole snapshot; a file that entry only imports is not,
since ordinary Node module resolution — not a per-reload snapshot — governs
it. Restart the process rather than reload after editing a trusted route's
dependency, not just its declared `source`.

Route limits are acceptance caps, not a promise that the maximum fits your
deployment. Use a deployment measurement that includes the intended proxy,
TLS and logging configuration; no universal performance ratio applies.

## Establish a deployment budget

1. Pin runtime, app, dependency locks and image; record CPU, RAM, Node, proxy/TLS
   settings, workers, timeouts and logging. Select representative input/body sizes.
2. Measure native redirects, parameter hits/misses, functions, middleware and
   assets separately, then use the expected mixed workload and hot-route skew.
3. Use a separate load generator for deployment tests. Increase offered rate and
   concurrency gradually; record successful throughput, all status counts,
   p50/p95/p99, CPU, peak RSS, sockets, restarts and network bytes.
4. Include bursts, slow clients, saturation, invalid inputs and one failed replica.
   Sustain tests long enough to observe memory/GC behavior and stable plateaus.
5. Choose admission limits below the measured failure knee with explicit spare
   capacity for a replica loss. Verify the service recovers after load stops.
6. Record the accepted load, error and latency budgets and repeat after changes.

The built-in local benchmark is a quick correctness-aware signal, not the above
production exercise. The readiness endpoint can stay 200 while all worker slots
are busy. Use error/latency signals too. No universal safe RPS can be derived
from the route count or these defaults alone. See [resilience](RESILIENCE.md).

Configuration parsing/schema validation now run in a terminated-on-deadline worker
(a worker that finishes in time exits by itself before its result is used);
route compilation still runs cooperatively on the host (10 seconds, yields every
64 routes). Source, AST, structured-clone output, compiled routes, assets, module
snapshots and overlapping runtimes all consume memory. Worker V8 limits do not cap
external buffers or aggregate process RSS. Enforce container/process limits and
operator-controlled activation; see [review scope](SANDBOX-REVIEW.md).
