# Test every route, then measure it

The runtime includes a local coverage gate and an assertion-aware project benchmark.
These validate a local snapshot, not the reachability of external redirect
services or the correctness of an entire production deployment.

```sh
urlcode routes --project ../my-links/app
urlcode audit --project ../my-links/app --expect-routes 2
urlcode benchmark --project ../my-links/app --requests 1000 --concurrency 2 --max-p95-ms 50
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

Commit N once, in the project's `tests/audit.json`:

```json
{"expectRoutes": 2}
```

With no `--expect-routes`, `audit` compares against that file, so a site's
`npm run audit`, its CI workflow and a hand-typed command share one reviewed
value; the flag overrides it for one run. `expectedRoutesFrom` in the report
names the source (`tests/audit.json`, `--expect-routes` or `null` when
unchecked), and a file that is not exactly `{"expectRoutes": N}` refuses the
audit with `invalid-audit-expectation`. `urlcode init` writes it as `0`, and
`extensions add|remove` move it by the routes they write
([tooling](TOOLING.md#operator-context-for-commands-and-npm-scripts)).

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
  {"path":"/api/accounts/acct-1","status":200,"expectJson":{"/balance":100,"/owner/name":"Ada"}},
  {"path":"/go","status":302,"expectHeaders":{"location":"https://example.com/"}},
  {"path":"/go","method":"POST","status":405,"expectHeaders":{"allow":"GET, HEAD"}},
  {"path":"/missing","status":404}
]
```

Each case may supply `method`, string-valued `headers`, a text `body`, expected
`status`, string-valued `expectHeaders`, exact UTF-8 `expectBody`, `expectJson`
and `expectSignals`, the signals the request must emit
([checking signals locally](EGRESS.md#checking-signals-locally)). `test` and
`audit` record signals without delivering them. `verify-deployment` cannot
observe signals and notes `expectSignals` as not checked. Status is
required. The file is checked against the shipped
[`schemas/requests.schema.json`](../schemas/requests.schema.json) before any
request is sent: any other key (a `json`, `expectStatus` or misspelled
`expectBdy`) is refused with the fixture number and what to write instead,
rather than ignored.

`expectJson` asserts values inside a JSON body without its exact text, so a
body that also carries generated ids and timestamps can still be checked: it
maps [JSON Pointers](https://www.rfc-editor.org/rfc/rfc6901) to the value each
must equal (`{"/balance": 100, "/items/0/done": false}`; `""` is the whole
body, `~1` is `/` and `~0` is `~` in a key). Objects compare regardless of key
order, arrays in order, and nothing the map does not name is checked. At most
16 pointers of at most 8 segments; a body that is not JSON, or over 1 MiB,
fails every pointer. Strings may hold `{{name}}` references (see
[multi-step fixtures](#multi-step-fixtures)). A passing case needs at least one body/header assertion to count toward
coverage (see [coverage rules](#coverage-rules)); status-only successes appear in `unassertedCases`. Choose assertions
that verify your intended business result, not just a generic header. Fixtures
are limited to 10,000 cases/16 MiB; checked response bodies to 16 MiB. Requests have
10-second transport timeouts. Failures do not stop subsequent checks. Status 0
means a transport/response-limit failure.

`audit` output reports case numbers and statuses, not response bodies, header
values or fixture URLs that may contain private data. `urlcode test` is the
author's own debugging loop, so a failing case there also prints its `method`
and `path` as sent (captured values filled in, `/notes/n-8f2c/100`), the path
as written as `fixturePath` when that differs (`/notes/{{id}}/{{count}}`), and a
`failures` list: for each failed assertion
its `check` (`status`, `header`, `body`, `json` or `signals`), the header `name`
or JSON Pointer (or the unmet `expectSignals.N` entry), and the
`expected` and `actual` values, each cut to about 200 characters from just
before the first difference (`firstDifference`). A `status` failure also
carries the start of the response `body` (at most 1 KiB read, shown cut the same
way), so a refusal names its reason: a `403` without an `Origin` shows
`{"error":"cross_origin_refused"}`, a missing session
`{"error":"authentication_required"}`. A value a `steps` fixture captured
from a JSON body or a header is printed as the value; one captured with
`"secret": true`, and any cookie capture, is printed as its `{{name}}`, and a
cookie value a response set as `<cookie NAME>` (see [cookies](#cookies)). Keep
secrets out of fixtures and test responses you would not want in a CI log.

`urlcode test` with no cases (no `tests/requests.json`, or an empty array)
exits nonzero once the project has an active route, because a run that checks
nothing is not a pass. A project with no active route yet, such as a fresh
`urlcode init`, passes with a `no-test-cases` warning.

### Coverage rules

Each active route and allowed method needs covering. A route/method pair is
covered by a case (generated check, single fixture or step) that:

1. **passes**;
2. **matched that route**: coverage uses the route that actually matched, so a
   literal route shadowing a parameter example cannot count toward parameter
   coverage;
3. **answered below 400**: a negative fixture alone cannot prove a route works
   normally (a generated check of an intentionally error-valued native
   `respond` is the one exception: it covers its declared outcome); and
4. **asserts the response** with `expectBody`, `expectJson` or `expectHeaders`. A status
   alone does not count: a catch-all page, a wrong handler or a generic `200`
   from somewhere else all pass a status check. Such passing cases appear in
   `unassertedCases`, and a `coverageNotes` entry `unasserted-success` names
   them.

**HEAD is implied by GET.** When a route allows both and its GET is covered, its
HEAD is covered too and listed in `impliedRouteMethods`: the runtime answers HEAD
through the same handler and strips the body for every handler. A handler that
deliberately answers HEAD differently from GET needs its own HEAD fixture
(`"method":"HEAD","expectBody":""` or an `expectHeaders`), which counts as
usual. Other methods are never implied.

Disabled/expired routes are counted separately and excluded from active
coverage requirements. Inactive parameter patterns still need explicit negative
fixtures to exercise them.

`coverageNotes` explains each kind of gap once, with fixed wording, the route
patterns, methods or case numbers, and what to write: `unasserted-success`,
`method-without-success`, `gated-route-uncovered` and `waiver-without-proof`
(see [waivers](#waive-a-method-covered-elsewhere)). It never affects `ready`.
The two for uncovered pairs split on whether the route was reached at all:

- `method-without-success`: another method of the route is covered, so the
  route is reached (signed in, where it is gated), and each listed `methods`
  entry lacks its own passing, asserted success case. `cases` lists the
  fixture cases that sent the method only a refusal (a status of 400 or
  more), which proves the refusal and covers nothing. Add a success case for
  that method.
- `gated-route-uncovered`: a route behind a sign-in gate with no method
  covered, so no case reached it signed in; see
  [authenticated routes](#authenticated-routes-auth-true).

`ready: true` requires a nonempty active project, matching expected count (when
supplied), zero failed checks and no uncovered active route/method combinations.
A pair counts as covered by a passing fixture or generated check, or by an honored
[`coveredElsewhere` waiver](#waive-a-method-covered-elsewhere); waived pairs are
listed separately so a reader sees why.
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
explicitly waived with a reason". A waiver is honored only when the audit has seen the route served, and each
waived pair's `basis` says how:

- `route-covered`: another method of the same route is covered by the
  [coverage rules](#coverage-rules).
- `gate-refusal`: the route is behind a sign-in gate (its `gatedBy` in the
  inventory names a principal-providing extension, such as `auth: true`) and a
  passing fixture asserts that gate's anonymous `401` on it, with `expectBody`,
  `expectJson` or `expectHeaders`. This is for a fully gated route no fixture can sign in
  to, for example one whose provider signs in only through an external
  identity provider. The asserted refusal proves the route is mounted and gated;
  the waiver's reason says where the signed-in behavior is tested. Prefer a
  [signed-in fixture](#authenticated-routes-auth-true) wherever one can sign in.

Nothing else is a basis, so a waiver never excuses an error-only function route
(a `401` from the function itself is not a gate), or a route with no fixture:
those pairs stay in `uncovered`, `ignoredWaivers` names the waiver and a
`waiver-without-proof` note says what is missing. A waiver whose pair already
has a passing fixture appears under `redundantWaivers`; it never blocks `ready`.
Example: [examples/coverage-waiver](../examples/coverage-waiver/README.md).

## Authenticated routes (`auth: true`)

A route behind a sign-in gate is covered by signing in, inside a `steps`
fixture, through the provider's own endpoints: the same request a browser
sends. The fixture's [cookie jar](#cookies) keeps the session cookie the
provider sets, so later steps are signed in; `audit` counts those steps like
any other. There is no test principal, header or fixture key that skips the
gate, so a fixture proves the gate and the signed-in behavior together and
nothing in a project can grant itself an identity.

```json
{"steps":[
  {"path":"/api/auth/sign-in/email","method":"POST",
   "headers":{"content-type":"application/json","origin":"{{origin}}"},
   "body":"{\"email\":\"ann@example.test\",\"password\":\"ann-local-demo-password\"}","status":200,
   "expectHeaders":{"content-type":"application/json"}},
  {"path":"/api/notes","method":"POST","headers":{"content-type":"application/json","origin":"{{origin}}"},
   "body":"{\"title\":\"first\"}","status":201,
   "expectHeaders":{"content-type":"application/json; charset=utf-8"},"capture":{"id":{"json":"id"}}},
  {"path":"/api/notes/{{id}}","status":200,"expectHeaders":{"content-type":"application/json; charset=utf-8"}},
  {"path":"/api/auth/sign-out","method":"POST","headers":{"content-type":"application/json","origin":"{{origin}}"},"body":"{}","status":200,"expectBody":"{\"success\":true}"}
]}
```

- **Accounts.** Declare them in the [test seed](#test-data-and-seeds),
  `tests/seed.json`, with the ids a membership names; each `urlcode test` and
  `audit` run creates them in its own fresh database, so nothing is provisioned
  by hand and a rerun starts from the same state. Fixtures and the seed are
  project files: use synthetic accounts and passwords only, never a real user's.
- **Origin.** `auth: true` refuses a `POST`, `PUT`, `PATCH` or `DELETE`
  without a same-origin `Origin` (`403 {"error":"cross_origin_refused"}`)
  before it checks the session, so an unsafe fixture request sends
  `"origin":"{{origin}}"`. `{{origin}}` is the site origin the run serves (its
  `--origin`, else the local runtime's own address; for `verify-deployment`,
  the `--target`), so one fixture file works under any `--origin`. Write a
  literal foreign origin only to test the refusal.
- **Rate limits.** Better Auth allows 10 sign-in attempts per client address a
  minute, per process; sign in once per fixture, not once per step.
- **No fixture can sign in** (an external identity provider, say): assert the
  anonymous `401` and waive the methods with `coveredElsewhere`; the waiver's
  basis is then `gate-refusal` ([above](#waive-a-method-covered-elsewhere)).

[`proofs/private-requests`](../proofs/private-requests/README.md) (Better Auth)
and [`proofs/private-requests-authjs`](../proofs/private-requests-authjs/README.md)
(Auth.js, with its CSRF token captured first) reach `ready` this way with every
`auth: true` route covered, and their end-to-end tests audit the same fixtures
under a second `--origin`.

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
  array indexes into a JSON response body), `{"header":"location"}` (one
  single-valued response header; `set-cookie` is refused, use the next form) or
  `{"cookie":"session"}` (the value the fixture's [cookie jar](#cookies) holds for
  that cookie name after this step's response, as the jar would send it to this
  step's path). The value must be a
  nonempty string, finite number or boolean of at most 4096 bytes with no control
  characters; the body is read up to 1 MiB. Names are letters, digits and
  underscores, at most 32; at most 16 per step. A step captures only when it
  passes; a value that is missing or unacceptable fails the step.
- **Substitution.** `{{name}}` is replaced in a step's `path`, `body`, `headers`,
  `expectHeaders`, `expectBody` and the strings of `expectJson`, and nowhere else.
  In `expectJson`, a string that is exactly one `{{name}}` of a number or boolean
  a `json` capture kept stands for that number or boolean, so
  `{"/balance": "{{bal}}"}` matches `100`. The value goes in as written,
  with no encoding, so capture URL-safe values (or a whole `location`) for a path.
  A name must be captured by an earlier step of the same fixture, or be the one
  built-in reference `{{origin}}` (the site origin, see
  [authenticated routes](#authenticated-routes-auth-true)), which cannot be
  captured; anything else is rejected when the file is read. A path that is not
  local once filled in fails the step. Single-request entries substitute only
  `{{origin}}` and never capture, and `capture` is rejected outside `steps`.
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
- **Output.** Reports carry case numbers and statuses only. `urlcode test` prints a
  failing step's path as sent, with json and header captures filled in, so the
  failure shows the request that failed. A capture that holds a credential (a
  bearer token in a JSON body) declares `"secret": true`
  (`{"token": {"json": "token", "secret": true}}`) and is then printed as
  `{{token}}` wherever it appears; cookie values are always redacted (below).
  `verify-deployment` names the fixture as written, never as sent, since a live
  deployment's values can be real.

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

### Cookies

Each `steps` fixture is one client with its own cookie jar. The jar starts empty
when the fixture starts and is dropped when it ends: its steps send the cookies
that earlier steps' responses set, and no other fixture, and no later run, ever
sees them. A single-request entry has no jar. A restart step keeps the jar, as a
client outlives a server restart; whether the server still accepts the cookie
afterwards is the server's business.

- **Storage.** The jar follows the RFC 6265 storage model for one client of one
  origin. `Path` scopes a cookie, and without one it defaults to the directory
  of the request that set it; `Domain` must match the origin's host (a host-only
  cookie otherwise); `Max-Age` wins over `Expires`, and a zero or negative
  `Max-Age` or a past `Expires` deletes the stored cookie of that name, domain
  and path. `__Secure-` and `__Host-` prefixes are enforced. `HttpOnly` and
  `SameSite` do not apply, because every fixture request is a same-site request
  made by the client itself. There is no public-suffix list: the only host is the
  test origin. The jar keeps at most 50 cookies of at most 4096 bytes each; one it
  refuses is dropped, as a browser drops it.
- **Origin and `Secure`.** The jar is a client of the site origin: the `--origin`
  given to `urlcode test` or `audit`, else the runtime's own loopback address; for
  `verify-deployment`, the `--target`. `Secure` cookies are kept and sent when that
  origin is `https`, or loopback (`127.0.0.0/8`, `::1`, `localhost`), which
  browsers also treat as a secure context. So `urlcode test --origin
  https://api.example.com` keeps a `__Host-` session cookie even though the local
  runtime is reached over plain HTTP on loopback; an `http://` origin that is not
  loopback does not.
- **An explicit `cookie` header.** A step's own `cookie` request header is sent as
  written, and the jar adds only the cookies whose names it does not already send,
  so an explicit `name=value` wins for that name on that request. It never changes
  the jar. Replaying a captured cookie after sign-out is written this way:
  `"headers":{"cookie":"session={{old}}"}`.
- **Redaction.** No cookie value a response set is printed: not in `urlcode test`
  failures, in the `audit` report or log, or in `verify-deployment` findings. A
  failure shows each such value as `<cookie NAME>` (a captured one as its
  `{{name}}`), including in a mismatched `set-cookie` header or a body that echoes
  it. This applies to single-request entries' `set-cookie` headers too.

This is how a route behind a cookie session (`auth: true`) is covered; see
[authenticated routes](#authenticated-routes-auth-true).
[`proofs/private-requests/app/tests/requests.json`](../proofs/private-requests/app/tests/requests.json)
tests a whole cookie-session lifecycle this way: Better Auth sign-in, signed-in
reads and writes, a permission the user lacks refused, sign-out and the old
session cookie replayed and refused, and another user refused the first
user's record.

## Test data and seeds

`urlcode test`, `audit` and `benchmark` (and the MCP server's `run_tests`)
never use the site's live data. With `--host-file`, each run composes the
operator host on a fresh, empty temporary directory and removes it when the run
ends: every first-party extension keeps its database there (whatever
`database` option or `STORE_DATABASE` the host names), auth creates Better
Auth's tables itself and signs sessions with a secret that lives only as long
as the run, so no `urlcode-auth migrate`, `data/auth.secret` or cleanup is
needed, and a rerun starts from nothing. `validate` and `routes` run the same
way under `--local-review` with no operator pin, as the generated npm scripts
do. `dev`, `serve`, and `validate` and `routes` with the reviewed pin, use the
site's own `data/`: the pinned `validate` checks what `serve` will use,
including a missing migration or secret.

What fixtures cannot create over HTTP is declared in `tests/seed.json` beside
`tests/requests.json`: an object keyed by extension name, handed to that
extension when the run's runtime first starts (never again after a `restart`
step). Each extension defines its entry and refuses anything else:

```json
{
  "auth": {"users": [
    {"id": "alice", "email": "alice@example.test", "password": "alice-local-demo-password", "name": "Alice"},
    {"id": "bob", "email": "bob@example.test", "password": "bob-local-demo-password"}
  ]},
  "store": {"members": {"reviewers": ["alice"]}}
}
```

- **auth** `users`: 1 to 100 accounts, each with the user `id` (the request
  principal id, so a membership can name it), `email`, a `password` of 8 to 128
  characters and an optional `name`. A fixture signs in with them.
- **store** `members`: principal ids by
  [membership collection](STORE.md#membership-gates-and-cross-owner-reads),
  written as `urlcode-store members add` writes them (actor `operator`). Records
  a route can create are written by the fixtures themselves.

A seed only reaches an extension composed for such a run: an entry for an
extension that is not registered, or that accepts no seed, is refused before
anything is served, as is one that does not match the extension's shape or
that holds a string or key with an unpaired UTF-16 surrogate escape
(`"\ud800"` alone), which a database would store as U+FFFD. `tests/requests.json`
refuses such a string too, because a request cannot send it as UTF-8: to test
core's `400 invalid_unicode`, put the escape inside the body text with its
backslash doubled (`"body": "{\"a\":\"\\ud800\"}"`). A
third-party extension accepts a seed by declaring a `seedSchema` on the
registration it builds for a hermetic host
([extension contract](EXTENSIONS.md#hermetic-runs-and-test-seeds)). The
project's own `URLCODE_DATA_DIR` ([restart](#multi-step-fixtures)) is a separate directory.

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

This table is the local test evidence a release should have before the
deployment owner works through the [production-approval
gates](RELEASE-OPERATIONS.md#production-readiness); it is not a second gate list.

| Check | Evidence to require |
|---|---|
| Counts and coverage | Reviewed expected count; every active route/method covered; disabled/expired routes accounted for |
| Correct happy paths | Exact redirect destinations/status/query handling; function bodies/headers; representative parameter and asset examples |
| Invalid inputs | Missing/duplicate/wrong-type inputs; malformed paths/encoding; wrong methods; bad JSON/media type; oversized bodies |
| Response contracts | HEAD empty bodies, Allow headers, cookies, cache policy, download names/MIME; ETag/304 and range/206/416 fixtures |
| Configuration changes | Invalid candidate keeps last-good routes; valid reload updates behavior; removed routes are intentional |
| Code containment | Runtime security suite passes; every trusted (default) `function`/`middleware` reviewed as first-party Node code with full ambient filesystem/network/`process.env` access; code needing isolation declares `sandbox: true` and has no ambient filesystem/network access; grants narrow and revision-pinned |
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
