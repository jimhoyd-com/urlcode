# Load testing a deployment

URLCode does not ship a load generator. Measure a running runtime with a
general-purpose HTTP load tester, such as
[autocannon](https://github.com/mcollina/autocannon), pointed at `urlcode serve`
or at the deployment itself. A load test answers one question: *does this
deployment meet its budget under this load?* It is not a capacity model, not a
soak harness and not a substitute for the drills in
[production readiness](RELEASE-OPERATIONS.md#production-readiness).

Correctness belongs to `urlcode test`, `audit` and `verify-deployment`: they
assert statuses, headers and bodies. A load tester counts responses and times
them. Run the correctness checks first, then load the routes they proved.

## Measure the deployment, not only a local process

A local `serve` is useful for a regression budget. It says nothing about your
TLS termination, proxy, network or host, so load the deployment through its
real entry point as well. Point a load generator only at systems you operate;
aimed at someone else's host it is an attack, whatever the intent.

```sh
urlcode serve --project my-links/app --port 3456
npx autocannon --connections 4 --duration 5 http://127.0.0.1:3456/go    # warm-up, discarded
npx autocannon --connections 4 --duration 30 http://127.0.0.1:3456/go
```

Pick paths from your own `tests/requests.json`: the GET and HEAD fixtures
whose responses you have already asserted. Record the runtime and application
revisions, the host and the exact command with any figure you keep.

## Reading the result

- **Latency percentiles and throughput** are the load tester's own report.
  The discarded warm-up run keeps a cold asset snapshot, an empty connection
  pool and a just-started function worker out of the measurement.
- **Status counts.** A redirect route answers 3xx, which most load testers count
  as "non-2xx"; compare the counts with what the route should return.
- **503 and 504 are the runtime protecting itself**: admission control, a full
  function pool or a deadline ([capacity controls](CAPACITY.md)). Connection
  errors and timeouts are a different failure: nothing answered.

## A worked example

`serve` runs **2 function workers** by default. Loading a function route at a
concurrency of 4 therefore returns some 503s: the runtime refuses the excess
rather than queueing it without bound. Raising the pool removes them:

```sh
urlcode serve --project my-links/app --port 3457 --workers 8
```

That is the loop: measure, read the 503 count, tune the
[capacity controls](CAPACITY.md), measure again. More workers cost memory and
CPU; the right number is the one your workload and host justify, not the
largest one that makes a number go green.

## What a passing run does not prove

- **Redirects are not followed**, so a redirect's destination is never loaded.
- **One client, one host, no slow peers.** Tail latency under adversarial
  clients, connection churn or packet loss is not measured.
- **Not a soak.** Memory drift, file-descriptor leaks and log-volume growth need
  a long run watched through [monitoring](MONITORING.md).
- **A number from one environment is not a claim about another.**

`scripts/operational-drills.ts` covers the adjacent ground (mixed
native/function load, an invalid reload and rollback) as a local proof, never a
statement about production.
