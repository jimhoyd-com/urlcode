# Load testing a deployment

`urlcode benchmark` sends a project's own workload at a running runtime and
reports throughput, tail latency and how many requests were refused. It answers
one question — *does this deployment meet its budget under this load* — and
nothing else. It is not a capacity model, not a soak harness and not a
substitute for the drills in [release readiness](RELEASE-READINESS.md).

## Measure the deployment, not a fresh local snapshot

By default the command starts a private runtime and loads that. Useful for a
regression budget in CI; useless for judging a deployment, because it bypasses
your TLS termination, proxy, network and host.

`--target` sends the same workload at something already running:

```sh
urlcode benchmark --project app --target https://links.example \
  --requests 5000 --concurrency 8 --warmup 100 --max-p95-ms 50
```

The project is still required: it supplies the routes and fixtures that make up
the workload. Load goes to the target; the local runtime is only consulted for
the plan. `rssMiB` is `null` in this mode, because the memory of the machine
running the benchmark says nothing about the machine under test.

Point `--target` only at systems you operate. A load generator aimed at someone
else's host is an attack, whatever the intent.

## Warm up before measuring

`--warmup N` sends and discards N requests first. A cold asset snapshot, an
empty connection pool and a just-started function worker are not what a latency
budget is about. Warm-up traffic reaches the deployment and is excluded from
every statistic; `warmupRequests` records how many.

## Reading the report

| Field | Meaning |
|---|---|
| `pass` | Every request completed, none failed, and `p95Ms` met `--max-p95-ms` if given. |
| `completed` / `complete` | How many requests ran. Short of `requested` means the `--seconds` budget ended the run first — the numbers describe a shorter run than you asked for. |
| `failed` | Responses that did not match the expectation for that case. |
| `transportErrors` | Connections that never produced a response: refused, reset or timed out. Distinct from a deployment deliberately refusing work. |
| `shedResponses` | 503 and 504 responses — admission, function-pool capacity or a deadline. Not errors so much as the runtime protecting itself. |
| `p50Ms` / `p95Ms` / `p99Ms` | Latency percentiles over completed requests. |
| `statuses` | Full status histogram, so a "pass" that is secretly all redirects is visible. |
| `rssMiB` | Local mode only. |

## A worked example

Against a small project with one function route and a few redirects (the bare
default starter has no routes, so point `--project` at your own):

```
$ urlcode serve --project my-links --port 3456
$ urlcode benchmark --project my-links --target http://127.0.0.1:3456 \
    --requests 60 --warmup 10 --concurrency 4
pass: false   failed: 6   shedResponses: 6   p95Ms: 6.7
```

Six of sixty requests were shed. Not a bug: `serve` runs **2 function workers**
by default, so a concurrency of 4 exceeds the pool and the runtime returns 503
rather than queueing without bound. Raising the pool:

```
$ urlcode serve --project my-links --port 3457 --workers 8
$ urlcode benchmark ... --concurrency 4
pass: true    failed: 0   shedResponses: 0   statuses: {"200":24,"302":36}
```

That is the loop this tool exists for: measure, read `shedResponses`, tune the
[capacity controls](CAPACITY.md), measure again. More workers cost memory and
CPU; the right number is the one your workload and host justify, not the
largest one that makes a number go green.

## What a passing run does not prove

- **GET and HEAD only.** Function routes with request bodies are not exercised.
  `workload` states this in every report.
- **Redirects are not followed**, so a redirect's destination is never loaded.
- **One client, one host, no slow peers.** Tail latency under adversarial
  clients, connection churn or packet loss is not measured.
- **Not a soak.** `--seconds` caps at 300. Memory drift, file-descriptor leaks
  and log-volume growth need a long run watched through
  [monitoring](MONITORING.md).
- **A number from one environment is not a claim about another.** Record the
  runtime and application revisions, host, and command with any figure you keep.

`scripts/operational-drills.ts` covers the adjacent ground — mixed
native/function load, an invalid reload and rollback — as a local proof,
never a statement about production.
