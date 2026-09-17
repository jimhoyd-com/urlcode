# Test every route, then measure it

Alpha.5 includes a local coverage gate and an assertion-aware project benchmark.
These validate a local snapshot, not the reachability of external redirect
services or the correctness of an entire production deployment.

```sh
urlcode routes --project ../my-links
urlcode audit --project ../my-links --expect-routes 2
urlcode benchmark --project ../my-links --requests 1000 --concurrency 2 --max-p95-ms 50
```

All three activate/validate the project with the same isolated runtime and use
local environment loading like `test`. Pass an external `--policy` for explicitly
authorized bindings. No destination redirects are followed, credentials are not
printed, and no remote load-test target is accepted.

## Inventory and count reconciliation

`routes` reports each configured route's pattern, handler, exact allowed methods
and active/disabled/expired state. It includes routes from YAML includes. A
parameter pattern is one route; its possible URLs are not a finite route count.
A static mount is one route, even when it contains many files.

`audit --expect-routes N` compares N with the total configured count. Its summary
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
required. A passing case needs at least one body/header assertion to count toward
coverage; status-only successes appear in `unassertedCases`. Choose assertions
that verify your intended business result, not just a generic header. Fixtures
are limited to 10,000 cases/16 MiB; checked response bodies to 16 MiB. Requests have
10-second transport timeouts. Failures do not stop subsequent checks. Status 0
means a transport/response-limit failure. Output reports case numbers/statuses,
not response bodies, header values or fixture URLs that may contain private data.

Coverage uses the route that actually matched. A literal route shadowing a
parameter example cannot count toward parameter coverage. Each active route and
allowed method needs a passing normal response (below 400); an intentionally
error-valued native `respond` check can cover its declared outcome. A negative
fixture alone cannot prove a function works normally. Disabled/expired routes
are counted separately and excluded from active coverage requirements. Inactive
parameter patterns still need explicit negative fixtures to exercise them.

`ready: true` requires a nonempty active project, matching expected count (when
supplied), zero failed checks and no uncovered active route/method combinations.
It means this local gate passed, not that all branches, parameter values or assets
have independent business assertions. Function routes intentionally serving only
errors cannot satisfy normal-response coverage in this release. Time-dependent
expiry is evaluated at audit start; avoid running a gate exactly at expiry.

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
The existing synthetic `npm run benchmark -- 10000` is still a separate scale test.

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
Run the local audit in CI now; do not label a passing local audit “production certified.”

Routes with middleware need explicit request fixtures with meaningful response
assertions for every active method. Audit cannot infer their behavior from the
underlying redirect or asset handler, so it does not generate native checks for
those routes. The route inventory includes a middleware count.
