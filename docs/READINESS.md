# Test every route, then measure it

The runtime includes a local coverage gate and an assertion-aware project benchmark.
These validate a local snapshot, not the reachability of external redirect
services or the correctness of an entire production deployment.

```sh
urlcode routes --project ../my-links
urlcode audit --project ../my-links --expect-routes 2
urlcode benchmark --project ../my-links --requests 1000 --concurrency 2 --max-p95-ms 50
```

All three activate/validate the project with the same runtime that serves it --
each route in its own declared trust mode, trusted in-process unless it declares
`sandbox: true` -- and use local environment loading like `test`. Pass an
external `--policy` for explicitly authorized bindings. No destination redirects are followed, credentials are not
printed, and no remote load-test target is accepted.

## Inventory and count reconciliation

`routes` reports each configured route's pattern, handler, exact allowed methods,
execution mode (`sandbox`, with `sandboxReason` when the route declares one)
and active/disabled/expired state. It includes routes from YAML includes. A
parameter pattern is one route; its possible URLs are not a finite route count.
A static mount is one route, even when it contains many files.

`routes --compare previous.json` diffs the current inventory against a saved
`routes` report: added, removed and changed routes (handler, methods, state,
execution mode and its reason, middleware count, policies, generated marker and
the policy description). A route that flips between trusted and sandboxed
execution is a change, including when its handler is native and only its
middleware runs project code. It
prints JSON, or Markdown tables with `--format markdown`, and always exits 0;
it reports, it does not judge. The [GitHub action](CI.md) posts this diff on
pull requests.

`audit --expect-routes N` compares N with the total configured count. That
count includes routes generated from `site` keys (`/robots.txt`, `/sitemap.xml`,
`/favicon.ico`, `/.well-known/security.txt`, `/llms.txt`), so a project with 10
declared routes and `site.robots` expects 11. `verify-deployment --expect-routes`
uses the same rule. The audit summary reports `counts.declared` and
`counts.generated` (they add up to `counts.configured`) so you can see the split;
only `configured` is compared. Its summary
separately counts active, disabled and expired routes and groups by handler.
A mismatch exits nonzero. Keep N reviewed in your application CI so accidentally
removing a route cannot silently reduce the test workload. Change it intentionally
when adding/removing routes; do not calculate the expected value from the same YAML.

## Generated checks plus explicit examples

The audit generates GET/HEAD checks for concrete native redirects, declared
responses, pages/downloads and every snapshotted static file. It checks status,
redirect Location, file metadata/length and declared bodies where applicable.
It also checks literal disabled/expired routes for 404/410. Generated checks are
contract consistency checks; they cannot decide whether your intended destination
or content is correct. Keep independent expected outcomes in fixtures too.

Functions, parameterized routes, required inputs/bodies and non-GET/HEAD methods
need fixtures in `tests/requests.json`:

```json
[
  {"path":"/hello/Ada","status":200,"expectBody":"{\"message\":\"Hello, Ada!\"}"},
  {"path":"/hello/Ada","method":"HEAD","status":200,"expectBody":""},
  {"path":"/go","status":302,"expectHeaders":{"location":"https://example.com/"}},
  {"path":"/go","method":"POST","status":405,"expectHeaders":{"allow":"GET, HEAD"}},
  {"path":"/missing","status":404}
]
```

Each case may supply `method`, string-valued `headers`, a text `body`, expected
`status`, string-valued `expectHeaders`, and exact UTF-8 `expectBody`. Status is
required. The file is checked against the shipped
[`schemas/requests.schema.json`](../schemas/requests.schema.json) before any
request is sent: any other key (a `json`, `expectJson` or misspelled
`expectBdy`) is refused with the fixture number and what to write instead,
rather than ignored. A passing case needs at least one body/header assertion to count toward
coverage; status-only successes appear in `unassertedCases`. Choose assertions
that verify your intended business result, not just a generic header. Fixtures
are limited to 10,000 cases/16 MiB; checked response bodies to 16 MiB. Requests have
10-second transport timeouts. Failures do not stop subsequent checks. Status 0
means a transport/response-limit failure.

`audit` output reports case numbers and statuses, not response bodies, header
values or fixture URLs that may contain private data. `urlcode test` is the
author's own debugging loop, so a failing case there also prints the fixture's
`method` and `path` as written and a `failures` list: for each failed assertion
its `check` (`status`, `header` or `body`), the header `name`, and the
`expected` and `actual` values, each cut to about 200 characters from just
before the first difference (`firstDifference`). A value a `steps` fixture
captured is printed as its `{{name}}`, never as the value. Keep secrets out of
fixtures and test responses you would not want in a CI log.

`urlcode test` with no cases (no `tests/requests.json`, or an empty array)
exits nonzero once the project has an active route, because a run that checks
nothing is not a pass. A project with no active route yet, such as a fresh
`urlcode init`, passes with a `no-test-cases` warning.

Coverage uses the route that actually matched. A literal route shadowing a
parameter example cannot count toward parameter coverage. Each active route and
allowed method needs a passing normal response (below 400); an intentionally
error-valued native `respond` check can cover its declared outcome. A negative
fixture alone cannot prove a function works normally. Disabled/expired routes
are counted separately and excluded from active coverage requirements. Inactive
parameter patterns still need explicit negative fixtures to exercise them.

`ready: true` requires a nonempty active project, matching expected count (when
supplied), zero failed checks and no uncovered active route/method combinations.
When `ready` is false, `notReadyReasons` lists each failed condition:
`no-active-routes`, `route-count-mismatch`, `failed-checks` and
`uncovered-route-methods` (see `uncovered` for the pairs). `unassertedCases` never
affects `ready`. It means this local gate passed, not that all branches, parameter values or assets
have independent business assertions. Function routes intentionally serving only
errors cannot satisfy normal-response coverage in this release, and a waiver cannot hide them. Time-dependent
expiry is evaluated at audit start; avoid running a gate exactly at expiry.

### Deployment advisories

`deploymentAdvisories` lists findings about how the project will be served, not
about one route. They never affect `ready` or the exit code. Pass `audit` the
same `--trusted-proxies` and `--metrics` flags the deployment passes to
`serve`; the audit's own probe server applies neither, they only describe the
deployment under review (the JS API takes `auditProject(app, { deployment:
{ trustedProxies, metrics } })`).

- `client-throttle-without-trusted-proxies` (with the affected `routes`): a
  [throttle](policies/throttle.md) partitions by `client` or `client-route`
  and no trusted proxies are declared. Behind a load balancer every caller then
  resolves to the proxy's address and shares one budget. A server that takes
  connections directly from clients can ignore it.
- `metrics-on-public-listener`: `--metrics` serves `/_urlcode/metrics` on the
  same listener as public traffic. Block the path at the proxy or network edge.
  There is no separate metrics listener yet.

### Waive a method covered elsewhere

A stateful route (create, update, delete) may be tested by other means. Declare
that on the route in `urlcode.yaml`, per method, with a required non-empty reason:
`coveredElsewhere: {POST: "why"}`. There is no CLI flag, so a reviewer sees every
waiver in the diff. `audit` then lists each waived pair with its reason under
`waivedRouteMethods`, even when `ready` is true: readiness means "tested, or
explicitly waived with a reason". A waiver is honored only when the route has
another passing normal-response fixture, so it never excuses an error-only
function route or a route with no fixture (those pairs stay in `uncovered`, and
`ignoredWaivers` names the waiver). A waiver whose pair already has a passing
fixture appears under `redundantWaivers`; it never blocks `ready`. Example:
[examples/coverage-waiver](../examples/coverage-waiver/README.md).

## Multi-step fixtures

A lifecycle (create, read, update, restart, read again) is one ordered fixture: an
entry with a `steps` list in place of a single request. `steps` is the entry's only
key. Each step is a request case as above, plus an optional `capture`, or the
restart step `{"restart": true}`:

```json
{"steps":[
  {"path":"/notes","method":"POST","headers":{"content-type":"application/json"},"body":"{\"text\":\"first\"}","status":201,
   "capture":{"id":{"json":"id"},"where":{"header":"location"}}},
  {"path":"{{where}}","status":200,"expectBody":"{\"id\":\"{{id}}\",\"text\":\"first\",\"version\":1}"},
  {"restart":true},
  {"path":"/notes/{{id}}","status":200,"expectBody":"{\"id\":\"{{id}}\",\"text\":\"first\",\"version\":1}"}
]}
```

`examples/lifecycle` runs this against a project that keeps notes in files.

- **Capture.** `capture` maps a name to `{"json":"items.0.id"}` (dotted keys and
  array indexes into a JSON response body) or `{"header":"location"}` (one
  single-valued response header, so not `set-cookie`). The value must be a
  nonempty string, finite number or boolean of at most 4096 bytes with no control
  characters; the body is read up to 1 MiB. Names are letters, digits and
  underscores, at most 32; at most 16 per step. A step captures only when it
  passes; a value that is missing or unacceptable fails the step.
- **Substitution.** `{{name}}` is replaced in a step's `path`, `body`, `headers`,
  `expectHeaders` and `expectBody`, and nowhere else. The value goes in as written,
  with no encoding, so capture URL-safe values (or a whole `location`) for a path.
  A name must be captured by an earlier step of the same fixture; anything else is
  rejected when the file is read. A path that is not local once filled in fails the
  step. Single-request entries never substitute or capture, and `capture` is
  rejected outside `steps`.
- **Restart.** The runtime is closed and started again on the same project and the
  same data directory, on a new port. `urlcode test` and `audit` create one empty
  temporary data directory per run, offer it to the project as `URLCODE_DATA_DIR`
  and delete it at the end; a route reads it through `env: {DIR: {env: URLCODE_DATA_DIR}}`.
  Only in those runs, and only for that one name, the binding needs no operator
  policy. Memory, caches and rate-limit counters do not survive a restart; files in
  the directory do. All fixtures in a run share the directory, in file order, so make
  each fixture create the data it reads. On a filesystem where the temporary directory
  cannot be created, such as a read-only container, no directory is offered and the run
  continues; a route that reads `URLCODE_DATA_DIR` then refuses to activate, as it would
  unset.
- **Failure.** A failed step ends its fixture: each later step is reported failed
  with status 0 and is never sent, and a restart after it does not happen. A broken
  chain cannot pass.
- **Bounds.** At most 50 steps per fixture, 5 restarts per fixture and 20 per file;
  10000 entries and 10000 requests per file; the 16 MiB file limit applies. A
  restart costs a runtime start, so use it sparingly.
- **Output.** Reports carry case numbers and statuses only. Captured values never
  appear in a report, log line or error, and a failure names the fixture as written
  (`{{id}}`), never as sent.

**Counting.** Each request step is one case: it adds one to `checks` and to `passed`
or `failed`, and gets the next case number after the generated cases (a restart is
not a case). A step covers a route and method exactly as a single fixture does: it
passes, asserts a body or header, and the route is the one its filled-in path
matched. A step with no assertion appears in `unassertedCases`. A skipped step
counts as failed, so `failed-checks` makes the audit not ready. The benchmark
replays only single-request GET/HEAD fixtures, never `steps`, because a step may
depend on earlier state.

**Deployment checks.** `verify-deployment` sends the fixtures to a live deployment,
which it cannot close and restart, so it never restarts one. A fixture containing a
restart step is skipped whole, not run up to the restart: nothing in it is sent, the
report `notes` say `fixture N contains a restart step ... not verified`, and a
`skipped` event is logged. The skip does not fail the run. Steps without a restart
run against the deployment, captures included; note that they send real writes.
`audit` needs an app it can restart and refuses a restart step otherwise (the
`urlcode audit` command always can).

**In-process helper.** `startServer({project, port: 0, local: true, isolateData: true})`
gives a Node test its own server and data directory, offered as `URLCODE_DATA_DIR` and
removed by `close()`. `dataDir: '/path'` uses that directory instead, creates it and
never deletes it, so a second server started on it sees the first one's files. Use one
of the two, not both.

`urlcode test` runs only explicit fixtures. `audit` adds generated native checks,
counts and coverage. Both execute locally and never follow redirect destinations.
Audits run sequentially to avoid mistaking worker saturation for a routing failure.

## Benchmark your actual project

The benchmark cycles generated checks and explicit successful GET/HEAD fixtures.
POST/PUT/PATCH/DELETE/OPTIONS and expected error cases are excluded. Function
GET/HEAD handlers still execute: use synthetic test data and reviewed bindings.
The workload is case-weighted, not a simulation of real user traffic. A short run
may not reach every case; compare `exercisedWorkloadCases` with `workloadCases`.

Output includes requested/completed count, assertion failures, status histogram,
startup time, throughput, p50/p95/p99 response time, process RSS, Node and OS.
Any wrong status/header/body, incomplete run or exceeded `--max-p95-ms` budget
exits nonzero. Warmup is zero and is reported explicitly. Client/server share one
process; RSS and latency are local measurements, not server-only production SLAs.

Defaults: 1,000 requests, concurrency 2, 30-second scheduling budget. Bounds:
1–100,000 requests, 1–32 concurrent requests, `--seconds` 1–300. In-flight requests
may finish after the scheduling budget, bounded by their timeout. Higher function
concurrency can legitimately cause 503 because the default pool has two workers.
Choose a latency budget from repeatable measurements on your intended host.

## What a release should prove

| Check | Evidence to require |
|---|---|
| Counts and coverage | Reviewed expected count; every active route/method covered; disabled/expired routes accounted for |
| Correct happy paths | Exact redirect destinations/status/query handling; function bodies/headers; representative parameter and asset examples |
| Invalid inputs | Missing/duplicate/wrong-type inputs; malformed paths/encoding; wrong methods; bad JSON/media type; oversized bodies |
| Response contracts | HEAD empty bodies, Allow headers, cookies, cache policy, download names/MIME; ETag/304 and range/206/416 fixtures |
| Configuration changes | Invalid candidate keeps last-good routes; valid reload updates behavior; removed routes are intentional |
| Code containment | Runtime security suite passes; no ambient filesystem/network access; grants narrow and revision-pinned |
| Capacity and failure | Representative mix and concurrency; low errors and repeatable latency; timeouts, overload recovery and memory over sustained runs |
| Deployment | Fresh install; real HTTPS/domain/health smoke; rollback; shutdown; logs/alerts; explicitly authorized destination reachability checks |

The runtime suite covers many generic protocol/security/reload cases. Apps must
supply their own business and boundary fixtures. Automated remote destination
health, redirect-chain/loop analysis, DNS/TLS checks, sustained soak/load profiles,
coverage by function branch and historical performance comparison remain planned.
Run the local audit in CI now (the [project action](CI.md) wires validate, test,
audit and the route diff into GitHub pull requests); do not label a passing local
audit “production certified.”
Once a candidate is deployed, `urlcode verify-deployment --target` compares its
responses with this project; see [deployment checks](DEPLOYMENT-CHECKS.md).

Before writing fixtures, `urlcode explain /route` shows what the compiled
configuration will do for a path: effective methods, the handler, the middleware
chain, validated inputs, the policies in effect and the cache outcome, so a
fixture asserts declared behavior rather than a guess. `urlcode manifest --json`
(also written by `build` as `manifest.json`) lists every route, the capabilities
in use, external requirements and per-target support with the revision digest,
which is the document to attach to a release review. Both read the
configuration only; they are not evidence that a deployment serves it.

Routes with middleware need explicit request fixtures with meaningful response
assertions for every active method. Audit cannot infer their behavior from the
underlying redirect or asset handler, so it does not generate native checks for
those routes. The route inventory includes a middleware count.
