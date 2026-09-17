# Performance checks

Run from the runtime checkout:

```sh
npm run benchmark -- 1000
npm run benchmark -- 10000
npm run benchmark -- 100000
```

Each invocation generates a temporary literal-redirect collection, measures
YAML load/compile/server startup, warms up 100 requests, then runs 5,000 real
loopback HTTP requests with 16 keep-alive connections. It verifies every status
and destination, never follows redirects, cleans up its process/files and
prints JSON with hardware/runtime, startup, memory, throughput and latency.

Initial local measurements on 2026-09-16: Apple M4 Pro, 48 GiB RAM, macOS arm64,
Node 26.8.2. These are short development runs on a shared machine, not an SLA,
sizing recommendation, soak result or comparison against other products.

| Routes | Startup | RSS after startup | Redirect requests/s | p95 latency |
|---|---:|---:|---:|---:|
| 1,000 | 29 ms | 86 MiB | 29,398 | 0.87 ms |
| 10,000 | 168 ms | 186 MiB | 28,458 | 0.85 ms |
| 100,000 (after parser fix) | 1,431 ms | 621 MiB | 28,563 | 0.85 ms |

These runs use the improved parser; the original 100,000-route startup took
42,493 ms. A string-key-only duplicate check reduced that to
1,431 ms while retaining duplicate rejection tests. Parser transient allocation
still contributes significantly to RSS; 100k startup exceeds the illustrative
512 MiB container limit. Do not size from routing data alone.

Before a stable production release, repeat on supported Node 22/24/26 deployment
hardware, measure long-running memory/reloads and tail latency under sustained
traffic, include mixed parameter/function workloads and overload/recovery, and
set regression budgets from repeatable evidence. Worker concurrency and slow
upstream services need separate tests; literal redirect throughput does not
predict function throughput. Runtime logs were disabled for these measurements.

The 5,000 measured requests do not exercise every route in the larger datasets.
Client and server share a process; these runs exclude TLS/proxy overhead and
production logging. No NGINX comparison has been measured. Use the
[capacity model](CAPACITY.md) and [recovery drills](RESILIENCE.md) when designing
a deployment benchmark; do not extrapolate native redirect RPS to middleware.

## TypeScript conversion, 2026-09-17

The runtime source became TypeScript, shipped as `dist/`: Node's own type
stripping with the specifier extension rewritten, so `dist/x.js` is
byte-equivalent to `src/x.ts` with the types removed (same lines, same
columns; no bundling, minification or syntax transform). The published
package therefore runs the same JavaScript it ran before. Measured on the same
machine (Intel Xeon 2.80 GHz, 16 GiB, Linux, Node 22.22.2), a plain-JavaScript
worktree of the pre-conversion commit against `dist/cli.js`, three alternating
runs each, medians of medians:

| Check | Before (JavaScript source) | After (`dist/`) |
|---|---:|---:|
| CLI cold start, `validate --project starters/default` (20 spawns) | 798.6 ms | 797.8 ms |
| CLI cold start, `routes --project starters/default` | 795.1 ms | 770.9 ms |
| CLI cold start, `--help` | 331.0 ms | 328.4 ms |
| `npm run benchmark -- 1000` requests/s (6 runs) | 4,640–4,927 | 4,657–4,914 |
| `npm run benchmark -- 1000` p95 | 5.77–6.00 ms | 5.65–5.96 ms |
| `npm run benchmark -- 1000` RSS after startup | 95–100 MiB | 95–100 MiB |
| `cli benchmark --project starters/default` (function route) | 1,188 req/s, p95 3.50 ms | 1,265 req/s, p95 3.28 ms |

Every difference is inside run-to-run spread; the gates (cold start within 2 %,
throughput within noise, RSS within 5 MiB) were met. Running the `.ts` source
directly (`node src/cli.ts`, the developer loop) costs about +190 ms of cold
start and +35 MiB RSS for the stripping itself; that mode never ships.
Container time-to-ready was not measured here (no Docker in that environment);
CI's readiness loop covers it.
