# Monitoring a URLCode deployment

URLCode emits one JSON object per line on stdout, answers two unauthenticated
probes and, when an operator opts in, serves in-process counters in Prometheus
format. Everything below is built from those sources, and the example
configuration in [`examples/monitoring/`](../examples/monitoring/) is the
runnable form of it. The contract behind all of it (the event catalogue, the
observer interface for in-process sinks, the metrics snapshot and the
exposition endpoint) is in [observability](OBSERVABILITY.md).

What you can measure is shaped by a deliberate logging decision: records carry
**no URL, query string, header, body, binding or user exception text**. You can
alert on error rates and latency per configured route; you cannot get per-URL
analytics from these logs, and adding it would mean logging user data. See
[operations](OPERATIONS.md).

## Probes

| Endpoint | Meaning | Alert when |
|---|---|---|
| `GET /_urlcode/health` | The process is alive and not shutting down. | It fails at all (`UrlcodeDown`). |
| `GET /_urlcode/ready` | The active snapshot and every function worker are available. | It fails for longer than replacement takes (`UrlcodeNotReady`). |

Both return `{status, version, routes}`. A third endpoint,
`GET /_urlcode/metrics`, exists only with `startServer({ metrics: true })` and
answers 404 otherwise; see [metrics](#metrics) below. Keep both: alerting only on health hides
a process that is up and serving nothing, while alerting only on readiness pages
for a brief, self-healing worker replacement. Probes have their own bounded
admission budget (`--max-in-flight-health`), so they keep answering while the
application sheds load — but they are unauthenticated and disclose the
configuration digest and route count, so keep them internal.

## Log records

| Event | Fields | Why it matters |
|---|---|---|
| `request` | `requestId`, `status`, `durationMs`; plus `method` and `route` with `--request-log detailed` | Error rate and latency per route. `route` is the configured pattern such as `/u/{id}`, never the requested path. |
| `stream` | `requestId`, `status`, `bytes`, `durationMs`, `reason`; plus `method` and `route` with `--request-log detailed` | A [streamed response](SPECIFICATION.md#streamed-responses) ended. `reason` is `complete`, `client-closed`, `idle-timeout`, `max-duration`, `max-bytes`, `error` or `shutdown`. A rising share of `error` is a failing producer; of `idle-timeout`/`max-duration`/`max-bytes`, a stream limit that is too tight or a producer that never ends ([stream limits](OPERATIONS.md#streamed-responses)). The `request` record for the same `requestId` was written when its head was sent. |
| `stream_refused` | `requestId`, `route`, `reason` (`undeclared`, `invalid`, `capacity`) | `undeclared`/`invalid`: code returned a stream on a route that does not declare streaming (answered 502); fix the route or the extension registration. `capacity`: `--max-streams` were open (answered 503, counted as shed). |
| `reload` | `status` (`ok`/`rejected`); `version` and `routes` on `ok` | A `rejected` reload means the last-good snapshot is still serving and a deploy did not take effect. |
| `watch` | `status` | Development watcher failure; not used by `serve`. |
| `extension_pin_followed` | `extensions` (names), `from`, `to` (project revisions) | `urlcode dev` only: a hot reload accepted extensions still pinned to the revision dev started from for the edited project ([the revision pin](EXTENSIONS.md#the-revision-pin)). Never emitted by `serve`; if a deployed process logs it, something other than `serve` is running. Re-review and re-pin `to` before serving that revision. |
| `function_worker` | `status` (`started`/`restarting`), `slot`; `attempt` and `delayMs` on `restarting` | Sustained `restarting` means a function is failing on real traffic. |
| `logs_dropped` | `count` | The logger shed records because the collector fell behind. Every other signal is unreliable while this fires. |
| `observer` | `status` (`failed`), `name` | An in-process observer threw; the request was unaffected. Written to the log only, never to observers. Sustained failures mean the observer's own sink is broken. |
| `throttle`, `agents`, `cache` | `route`, `outcome`; `remaining` or `list` | Policy decisions; see [policies](POLICIES.md). `throttle` logs `allowed` only in report mode. |
| `site` | `key`, `path`, `status` (`generated`/`shadowed`); or `severity` (`info`/`warning`) and `message` | Activation records for [site conventions](SITE.md). `shadowed` means a declared route took the path; an `info`/`warning` line reports an omitted `Sitemap:` line (no `--origin`), skipped list names or a far-future `security.txt` expiry. |
| `extension_warning` | `extension`, `message` | An extension reported a non-fatal problem while activating (for example auth's stored passkeys registered under a different relying-party ID, #736). One bounded line per warning, at most 20 per extension per activation; see [activation warnings](EXTENSIONS.md#activation-warnings). Act on it before users hit the condition it describes. |

`urlcode dev`, and `serve` only with `--debug-errors`, also write two
diagnostics to stderr that are not log records and never reach observers:
`function_error` (`requestId`, `status`, `route`, `source`, `export`,
`message`, `stack`) names the trusted function behind a generic 502/504, and
`reload_rejected` (`message`, `serving`) carries the validation message for a
`reload` that was `rejected`. They contain thrown text and source paths, so do
not ship them to a shared collector; see
[local development](LOCAL-DEVELOPMENT.md#environment-and-troubleshooting).

Startup prints `listening` with the effective `origin`, which is what functions
and absolute URLs see. Behind a proxy or tunnel this must be your public origin;
forwarded headers are deliberately not trusted. See [tunnels](TUNNELS.md).

## Metrics

`startServer({ metrics: true })` serves `GET /_urlcode/metrics` in Prometheus
text format: requests by status class and by configured route, in-flight
gauges, shed 503s, reloads, worker restarts and healthy slots, policy
outcomes, dropped logs and observer errors, all prefixed
`urlcode_`. The same numbers are available in process as `app.metrics()`. The
endpoint shares the probes' admission budget and bind host and is off by
default; it discloses route patterns and traffic shape, so keep it internal
like the probes. `urlcode audit --metrics` reports this as the
[deployment advisory](READINESS.md#deployment-advisories)
`metrics-on-public-listener`. [`examples/monitoring/prometheus-scrape.yaml`](../examples/monitoring/prometheus-scrape.yaml)
scrapes it directly, without a log pipeline. Field names and label sets are
fixed in [observability](OBSERVABILITY.md).

If you would rather keep everything in one process, an observer passed as
`startServer({ observers })` receives every log record and a periodic metrics
snapshot; the same page shows an OpenTelemetry sketch.

## What to alert on

The example rules in
[`examples/monitoring/prometheus-rules.yaml`](../examples/monitoring/prometheus-rules.yaml)
cover:

- **`UrlcodeDown`** — liveness probe failing. Process-level; check the supervisor.
- **`UrlcodeNotReady`** — readiness failing for more than a few minutes.
- **`UrlcodeServerErrors`** — over 5% 5xx on a route. 502 is a function error,
  503 is capacity, 504 is a deadline.
- **`UrlcodeCapacityShedding`** — sustained 503. Raise `--max-in-flight` or
  `--workers`, or find what is occupying the pool.
- **`UrlcodeWorkerRestartLoop`** — replacement backs off but never stops, so a
  persistent cause appears as a steady restart rate rather than a stopped pool.
  This is the signal that a function is exceeding its deadline on real traffic.
- **`UrlcodeLogsDropped`** — the collector is behind, so the other rules are
  blind until it recovers.

Pick service objectives for your own application; these thresholds are a
starting point, not a recommendation for your workload.

## Wiring it up

1. Send the process's stdout to a collector. The runtime never writes log files
   and owns no rotation or retention; that belongs to the collector.
2. Get counters either by scraping `/_urlcode/metrics` (enable `metrics`
   and load [`examples/monitoring/prometheus-scrape.yaml`](../examples/monitoring/prometheus-scrape.yaml))
   or by deriving them from the JSON records — see
   [`examples/monitoring/vector.toml`](../examples/monitoring/vector.toml), which
   produces `urlcode_requests_total`, `urlcode_worker_restarts_total` and
   `urlcode_logs_dropped_total`. Fluent Bit, Promtail and Alloy work equally
   well; the field names are what matter. The endpoint labels requests by
   `status_class` where the log pipeline keeps the exact `status`; the example
   rules carry both forms.
3. Probe both endpoints with blackbox_exporter — see
   [`examples/monitoring/blackbox-jobs.yaml`](../examples/monitoring/blackbox-jobs.yaml).
4. Load the alert rules and set the thresholds to your objectives.

Latency percentiles need a histogram; `durationMs` is per record, so have the
log pipeline bucket it rather than averaging in the alert.

## What this does not give you

Dashboards here describe one process. There is no built-in tracing, no
per-URL analytics, no distributed aggregation, no metrics persistence across
restarts and no automatic capacity management. The example configuration is a starting point that has not been
run against a production workload; validate it in your own environment before
relying on it, and run the drills in
[production readiness](RELEASE-OPERATIONS.md#production-readiness) before treating any of it as proof.
