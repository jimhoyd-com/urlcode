# Verify a running deployment against the project

`urlcode verify-deployment` answers one question: does the deployment behind
`--target` behave the way this project declares? It starts the local snapshot
(as `validate` does), sends a bounded set of HTTP requests to the target and
compares what came back with what the snapshot says should come back. It reads
responses only. It has no infrastructure access, uses no credential, follows no
redirect and offers no `--insecure`.

```bash
urlcode verify-deployment --project ../my-links/app --target https://links.example
urlcode verify-deployment --project ../my-links/app --target https://links.example \
  --expect-routes 12 --compliance baseline --fail-on medium --timeout-ms 5000
```

Options: `--origin` (the public origin the local snapshot generates absolute
URLs for; defaults to the target), `--expect-routes N`, `--expect-metrics`
(the operator chose to expose `/_urlcode/metrics` publicly), `--timeout-ms`
(per request, 100-120000, default 10000), `--fail-on high|medium|low|info|none`
(default `high`), the `audit` compliance flags (`--compliance`,
`--compliance-rules`, `--compliance-ignore`, `--compliance-warn`), and the
usual `--policy` binding the local snapshot needs to start.

The `probes` check compares the target's `version` and `routes` fields against
the local snapshot, so the *target* deployment must itself be started with
`--health-details` (or `--metrics`, which implies it; see
[operations](OPERATIONS.md#domains-https-and-exposure)) — otherwise
`/_urlcode/health`/`/_urlcode/ready` answer `{"status":"ok"}` only and every
run reports a high finding. Keep `/_urlcode/*` restricted to operators at the
proxy regardless, the same as any other internal endpoint.

## What it verifies

Every check yields findings `{check, severity, route?, message, expected?,
observed?}`. The report carries `checks` (assertions evaluated), `requests`
(HTTP requests sent), `findings`, `counts` by severity, `notes` (what was
deliberately not verified, such as compression delegated to a platform) and
`pass`.

| Check | What is compared | Severity |
|---|---|---|
| `probes` | `/_urlcode/health` and `/_urlcode/ready` answer 200 with `{status, version, routes}`; the deployed `version` equals the local snapshot's; the deployed route count equals the local count and `--expect-routes`; `/_urlcode/metrics` answers 404 unless `--expect-metrics` | high (metrics expected but absent: medium) |
| `fixtures` | `tests/requests.json` and the generated native cases, sent exactly as `urlcode test --target` would: status, expected headers and expected body | high |
| `security` | Per active literal route: every header of the effective security profile (`oshp`, `oshp-no-csp`, `set`, `unset`) with its exact value; a YAML `response.headers` value wins on a success, as it does in the runtime | high |
| `cache` | `Cache-Control` (and `CDN-Cache-Control`) equal the strategy's emitted value; skipped where YAML or an asset handler owns the header and on function routes, whose handlers may answer `private` | medium |
| `compression` | A second request with the declared `Accept-Encoding` on a response that is compressible (type, size at or above `minBytes`, no `no-transform`, no cookie, no secrets) carries `Content-Encoding`; on a delegated target it is noted, not checked | medium |
| `agents` | A `User-Agent` from the denied bundled list answers the configured status on every route with an enforcing agents policy; project list files and bare patterns are not probed | high |
| `throttle` | `RateLimit-Policy` carries the declared quota and window where the throttle is native | medium |
| `site` | Generated `robots.txt`, `sitemap.xml`, `favicon`, `security.txt` and `llms.txt` answer 200 with the expected content type; `robots.txt` and `security.txt` bodies equal the generated file (a `Sitemap:` line missing means the deployment was started without `--origin`) | medium |
| `methods` | A route that does not declare GET answers GET with 405 and `Allow`; a route with explicit `methods` answers OPTIONS with 405 and `Allow` | medium |
| `head` | On a `respond` route, HEAD answers 200 with GET's `Content-Length` and no body | medium |
| `errors` | An unmatched path (`/_urlcode-verify-<random>`) answers the runtime's 404 (`nosniff`, `no-store`) with the project-level security headers, which is also how a CDN error page or a different application shows itself | high |
| `transport` | On an https target, `Strict-Transport-Security` is present wherever the profile emits it (the deployment must have been started with `--origin https://...`); a certificate Node rejects, a refused connection or a timeout on the health probe ends the run; a redirect whose destination is plain `http:` is reported | high (http: destination: low) |

Bounds: fixtures plus generated cases, one to four requests per active literal
route (GET, then HEAD, OPTIONS, an encoded GET or a denied User-Agent where the
route calls for it), four probes. Concurrency is four for the route checks;
fixtures run one at a time, as `test` does. A run refuses to start above 10000
requests. Bodies are read up to 1 MiB and appear in the report only as the
first 200 bytes of a failing assertion. Requests count against the
deployment's throttle quotas: a quota smaller than the run turns later probes
into refusals, which the report shows as fixture and header findings.

Ordered `steps` fixtures run against the target with their captured values
(see [Multi-step fixtures](READINESS.md#multi-step-fixtures)); a fixture that
contains a `restart` step cannot be replayed against a live deployment and is
skipped whole, listed in `notes` and never silently.

## What it cannot verify

- Anything not visible in a response: process settings, worker counts,
  request logging, binding files, the proxy or CDN configuration, certificates
  beyond Node's default chain and host-name check, DNS.
- Routes with parameters, middleware or required inputs, except through the
  fixtures the project supplies; the generated cases never invent business
  data. Function bodies are verified only where a fixture asserts them.
- Agents policies built from project list files or bare patterns, compression
  delegated to a platform, throttle refusals (the run never exhausts a quota
  on purpose) and cache hits (the origin cache is invisible from outside).
- That the deployment stays this way: the report is a snapshot of one run.

A passing report says the target answered like the local snapshot during the
run. It is not a security assessment, a load test or a certification.

## Exit codes

`0` when no finding is at or above `--fail-on` (default `high`) and, when
`--compliance` was given, the compliance report passes or `--compliance-warn`
was set. `1` otherwise, and for an unreachable target, a rejected certificate,
a target that is not a bare HTTP(S) origin, or invalid options. The report is
printed as one JSON line after one `{"event":"finding",...}` line per finding.

## How it complements audit, compliance and benchmark

| Command | Runs against | Answers |
|---|---|---|
| `urlcode audit` | a local snapshot | are every route and method covered by passing checks, and do the counts reconcile |
| `urlcode audit --compliance` | declared configuration | does the configuration meet the rule set |
| `urlcode benchmark --target` | the deployment | how fast does it answer the workload |
| `urlcode verify-deployment` | the deployment | does it answer the way the project declares |

`audit` proves the project; `verify-deployment` proves the deployment is that
project. Neither replaces the [operational drills](RELEASE-OPERATIONS.md#production-readiness).

## A rollout gate

```bash
set -e
urlcode audit --project app --expect-routes 12 --compliance baseline
# deploy the candidate to the staging origin, then:
urlcode verify-deployment --project app --target https://staging.links.example \
  --expect-routes 12 --fail-on medium
urlcode benchmark --project app --target https://staging.links.example --requests 500 --max-p95-ms 50
# switch traffic, then verify the production origin the same way:
urlcode verify-deployment --project app --target https://links.example --expect-routes 12
```

A version mismatch after the switch means traffic reaches a different
snapshot: an old instance still serving, a cache in front of the origin, or a
project revision that was never deployed. Roll back per
[Operations](OPERATIONS.md#deployment-and-rollback-procedure).
