# Observability

URLCode reports what it does through three interfaces built on one stream of
events: the JSON log on stdout, operator **observers** that receive the same
events in process, and a **metrics snapshot** of counters derived from them,
optionally served in Prometheus format. Observers mirror [host plugins](PLUGINS.md):
they are JavaScript an operator passes to `startServer` or `createRuntime`,
never something a project's YAML can name, and they run with the host's
privileges. [Monitoring](MONITORING.md) is the operator's guide to probes,
recipes and alerts; this page is the contract.

```js
import { startServer } from '@jimhoyd/urlcode';

await startServer({
  project: './site',
  observers: [myObserver],   // in-process event and metrics sinks
  metrics: true,             // GET /_urlcode/metrics, Prometheus text format
});
```

## Event catalogue

`events` in `@jimhoyd/urlcode/observability` is a frozen object mapping each event name
to the complete list of fields it may carry. A test runs a real server and
holds every record to it, so a field or event that is not in the table below
does not ship. Fields marked *optional* are present only in the situations
named.

| Event | Fields | Emitted when |
|---|---|---|
| `request` | `requestId` string, `status` integer, `durationMs` number; `method` string and `route` string or `null` with `--request-log detailed` | Every response the server wrote, including probes and shed 503s. `route` is the configured pattern (`/u/{id}`) or the probe path, never the requested path. |
| `stream` | `requestId` string, `status` integer, `bytes` integer, `durationMs` number, `reason` (`complete`, `client-closed`, `idle-timeout`, `max-duration`, `max-bytes`, `error`, `shutdown`); `method` and `route` with `--request-log detailed` | A [streamed response](SPECIFICATION.md#streamed-responses) whose head was sent has ended. It follows that request's `request` record (written when the head was sent); `durationMs` counts from the handler's result to the end, `bytes` the body bytes sent. Never chunk content or what a producer threw. |
| `stream_refused` | `requestId` string, `route` string or `null`, `reason` (`undeclared`, `invalid`, `capacity`) | A streamed result was answered 502 because its route does not declare streaming (or the result was malformed), or 503 because `--max-streams` were open. |
| `reload` | `status` `ok`/`rejected`; `version` string and `routes` integer on `ok` | `app.reload()` or the development watcher swapped, or refused to swap, the snapshot. |
| `watch` | `status` `failed` | The development watcher could not fingerprint the project. |
| `extension_pin_followed` | `extensions` string array, `from` string, `to` string | `urlcode dev` only, once per reload: the edited project (revision `to`) activated extensions whose registration is still pinned to `from`, the revision dev started from ([the revision pin](EXTENSIONS.md#the-revision-pin)). Emitted after the reload fully activated, never for a rejected one and never by `serve`. |
| `function_worker` | `status` `started`/`restarting`, `slot` integer; `attempt` and `delayMs` integers on `restarting` | A function worker became ready or is scheduled for replacement. |
| `signal` | `outcome` (`accepted`, `delivered`, `failed`, `dropped`), positive `count` | Best-effort webhook totals; no destination, request data or secrets. |
| `logs_dropped` | `count` integer | The JSON logger shed records because stdout was not writable. Written by the logger itself, so observers do not see it. |
| `observer` | `status` `failed`, `name` string | An observer hook threw or rejected. Written to the default log only, never to observers. |
| `throttle` | `route`, `outcome` `allowed`/`exceeded`, `remaining` integer | A throttle decision. `allowed` is logged only in `mode: report`; enforce mode logs refusals. |
| `agents` | `route`, `list` string, `outcome` `denied`/`reported` | A User-Agent matched a list. The list name is logged, never the header. |
| `cache` | `route`, `outcome` `hit`/`stale`/`miss`/`store`, or `vary-bypass`/`stream-bypass` when a response was not stored because of an undeclared `Vary` or because it streamed | A cache lookup or store. |
| `listening` | `address`, `port`, `mode`, `origin` | Printed once by the CLI at startup, not emitted by the server. |
| `extension_warning` | `extension` string, `message` string | An operator extension called `warn()` while it activated ([activation warnings](EXTENSIONS.md#activation-warnings)): at startup or a reload, never per request. `message` is one line of at most 500 characters; at most 21 records per extension per activation. |

Every event carries `event` (its name). Numbers are JSON numbers, never
strings.

### Terminal output

The table above is the wire contract: `--json`, a piped/redirected stdout, and
every in-process observer always see exactly these events, unchanged. When
stdout is a TTY and `--json` is not passed, the CLI's own default logger for
`urlcode dev`/`serve` additionally renders `request` (`GET /go 302 0.9ms`,
using the same `method`/`route`/`status`/`durationMs` fields; a bare
`302 0.9ms` when `--request-log` was left at `minimal`), `reload`, `watch`,
`extension_warning` and `extension_pin_followed` as one short line apiece instead of the JSON line; every other event still
prints as JSON on that same stdout. This is terminal-only formatting done by
the CLI's logger, not a change to the events themselves or to what an operator
observer receives.

### Privacy guarantees

No event, snapshot or exposition carries a request URL, path, query string,
header, body, client address, User-Agent string, binding, secret or user
exception text. `route` is always a configured pattern
from reviewed YAML. The one free-text field, `extension_warning.message`, is
what the operator's own installed extension chose to write at activation; the
extension contract requires it to carry counts and configuration names only,
never user data or secrets. The `function_error` and `reload_rejected` diagnostics that
`urlcode dev` and `serve --debug-errors` write to stderr are not events: they
carry source paths, thrown messages and stacks, never pass through the logger
or observers, and are off by default for `serve` (see
[local development](LOCAL-DEVELOPMENT.md#environment-and-troubleshooting)).
`requestId` is server-generated unless
`--trust-request-id` accepts one from a trusted proxy. An observer
that logs should keep the same rule; nothing in an event lets it break it.

## Observers

```js
const myObserver = {
  name: 'forwarder',            // ^[a-z][a-z0-9-]{0,63}$, unique per server
  version: '1.0.0',             // any string up to 64 characters
  onEvent(event) {},            // every record the JSON logger writes, in order
  onMetrics(snapshot) {},       // the metrics snapshot, on the interval and at close
  async onClose() {},           // release resources; reverse order
};
```

In TypeScript the contract is `Observer` from `@jimhoyd/urlcode/observability` (also
exported from `urlcode`), with `ObserverEvent` for a record and
`MetricsSnapshot` for what `onMetrics` receives; the declarations ship with the
package:

```ts
import type { Observer, ObserverEvent, MetricsSnapshot } from '@jimhoyd/urlcode/observability';

const myObserver: Observer = {
  name: 'forwarder',
  version: '1.0.0',
  onEvent(event: ObserverEvent) { queue.push(event); },
  onMetrics(snapshot: MetricsSnapshot) { gauge.set(snapshot.requests.inFlight); },
};
```

Validation (`validateObservers`) matches plugins: at most 32 observers, each
an object with a kebab-case `name` no other observer uses, a `version` string,
every declared hook a function and at least one present. It runs before the
listener starts, so a bad observer fails startup rather than a request.

`onEvent` receives the same object the logger serialised, after the logger,
observers in array order. Do not mutate it. It runs on the request path, so
keep it cheap: buffer and flush on a timer rather than awaiting a network
call. A hook that throws or returns a rejecting promise is isolated: the
request is unaffected, the next observer still runs, `observers.errors` in
the snapshot increments and one `observer` record goes to the default log.
Nothing is retried; an observer that needs delivery guarantees owns its own
queue.

`onMetrics` receives a fresh snapshot every `metricsIntervalMs`
(`startServer` option, `0` off by default, 1 s to 1 h) and once at `close()`.
`onClose` runs in reverse order after the runtime has closed.
`app.observers` lists the `{ name, version }` pairs.

`createRuntime(project, { observers })` takes the same array for embedding
without the server: the runtime's own sink and counters are then yours, and
`runtime.metrics()` returns its snapshot. `startServer` never passes its
observers down to the runtimes it creates, so a reload does not re-register
them and counters survive reloads.

`createObserverSink(observers, fallbackLog)` is the fan-out itself, exported
for tests and custom hosts: it returns a `log(event)` function with `.metrics`,
`.publish(snapshot)` and `.close()`.

## Metrics snapshot

`app.metrics()` and `runtime.metrics()` return a plain object, safe to
`JSON.stringify`, of counters since the process started serving. Numbers
only; the one keyed table is `requests.byRoute`, keyed by configured pattern
and capped at 10 000 keys.

| Field | Type | Meaning |
|---|---|---|
| `version` | gauge | Snapshot shape version, currently `2`. |
| `uptimeSeconds`, `rssBytes` | gauge | Process facts. |
| `requests.total`, `requests.byStatusClass.{2xx,3xx,4xx,5xx}` | counter | Application responses, including shed 503s. |
| `requests.inFlight` | gauge | Requests holding application admission now. |
| `requests.byRoute[pattern]` | counter | Responses per matched route. A shed or unmatched request has no route. |
| `health.total`, `health.byStatusClass`, `health.inFlight` | counter, gauge | The probe budget: `/_urlcode/health`, `/_urlcode/ready` and `/_urlcode/metrics`. |
| `shed.requests`, `shed.health` | counter | 503s answered because an admission budget was full. |
| `reloads.ok`, `reloads.rejected` | counter | Snapshot swaps. |
| `watch.failed` | counter | Development watcher failures. |
| `functionWorkers.started`, `functionWorkers.restarts` | counter | Worker starts and scheduled replacements. |
| `functionWorkers.healthySlots`, `functionWorkers.slots` | gauge | Ready slots and configured slots of the serving runtime. |
| `policies.throttle.{allowed,exceeded}` | counter | Throttle decisions (see the catalogue for what enforce mode logs). |
| `policies.agents.{denied,reported}` | counter | Agents decisions. |
| `policies.cache.{hit,stale,miss,store}` | counter | Cache outcomes. |
| `signals.{accepted,delivered,failed,dropped}` | counter | Best-effort webhook outcomes; exposed as `signals_total` with outcome labels. |
| `logsDropped` | counter | Records the JSON logger shed. |
| `observers.errors` | counter | Observer hooks that threw or rejected. |

Policy counters are derived from the `throttle`, `agents` and `cache` events
as they pass through the sink, so the policies themselves have no metrics
code. Runtime facts that never become events (admission, shedding, slot
health) are recorded by the server directly. Counters are per process;
aggregation across replicas is the scraper's job.

## Prometheus exposition

`startServer({ metrics: true })`, or `urlcode serve --metrics` on the command
line, serves `GET /_urlcode/metrics` as `text/plain; version=0.0.4`, rendered from the same snapshot by
`renderPrometheus(snapshot)`, a pure function you can also call yourself.
Every metric is prefixed `urlcode_`; counters end in `_total`; the only labels
are `status_class`, `route` and `outcome`.

```
# HELP urlcode_requests_total Application requests answered since start, by status class.
# TYPE urlcode_requests_total counter
urlcode_requests_total{status_class="2xx"} 1042
urlcode_route_requests_total{route="/u/{id}"} 977
urlcode_requests_in_flight 3
urlcode_shed_total{outcome="requests"} 0
urlcode_reloads_total{outcome="ok"} 2
urlcode_function_worker_restarts_total 0
urlcode_function_worker_healthy_slots 2
urlcode_throttle_total{outcome="exceeded"} 14
urlcode_cache_total{outcome="hit"} 511
urlcode_logs_dropped_total 0
urlcode_observer_errors_total 0
urlcode_uptime_seconds 86400
urlcode_process_rss_bytes 71303168
```

The endpoint is **off by default**. It shares the probes' admission budget
(`--max-in-flight-health`) and the same bind host, which is `127.0.0.1`
unless `--host` says otherwise. Like the probes it is unauthenticated and
discloses route patterns and traffic shape, so **do not expose it publicly**:
keep it on an internal interface or restrict it at the ingress. A scrape
counts under `health`, not under application requests. See
[`examples/monitoring/prometheus-scrape.yaml`](../examples/monitoring/prometheus-scrape.yaml).

## OpenTelemetry sketch

The runtime has no OpenTelemetry dependency. An observer can forward events
to an OTLP exporter and map the snapshot onto instruments; this is a sketch,
not shipped code, and omits batching, resource attributes and error handling.

```js
// Sketch. `logs` and `meter` come from the OpenTelemetry SDK the operator
// configures; the runtime knows nothing about them.
export function otelObserver({ logger, meter }) {
  const requests = meter.createCounter('urlcode.requests', { unit: '{request}' });
  const inFlight = meter.createObservableGauge('urlcode.requests.in_flight');
  let last;
  inFlight.addCallback(result => { if (last) result.observe(last.requests.inFlight); });
  return {
    name: 'otel', version: '0.1.0',
    onEvent(event) {
      // Every field is already safe to attach as an attribute.
      logger.emit({ body: event.event, attributes: event });
      if (event.event === 'request') requests.add(1, { status_class: `${Math.floor(event.status / 100)}xx`, route: event.route ?? '' });
    },
    onMetrics(snapshot) { last = snapshot; },   // the gauge reads the latest snapshot
  };
}
```

Counters in the snapshot are cumulative, so they map to OpenTelemetry
`Counter` instruments read through an observable callback, or to a
Prometheus receiver scraping `/_urlcode/metrics` directly. `durationMs` on
`request` is the input for a `Histogram`; the runtime does not bucket it.

## What is not provided

- **Tracing.** There are no spans and no context propagation; `requestId` is
  the only correlation key, and a trusted proxy can supply it.
- **Sampling.** Every event is delivered to every observer, or shed by the
  logger under back-pressure and reported as `logs_dropped`.
- **Persistence and aggregation.** Counters live in process memory, reset on
  restart, and describe one process. Retention and cross-replica sums belong
  to the collector.
- **Per-URL analytics.** By design; see the privacy guarantees.
- **Adapters.** Vercel, Lambda and Cloudflare handlers emit through the
  platform's own logging and do not take observers.
