import { assert } from './errors.ts';

// Operator observability: the catalogue of events the runtime emits, a sink
// that fans each event out to operator observers, in-process counters and a
// Prometheus renderer. Observers mirror host plugins (src/plugins.js): they
// are passed by the embedding application, never named in YAML, and run in
// the host process with the host's privileges.
//
//   { name, version, onEvent(event)?, onMetrics(snapshot)?, onClose()? }
//
// Every field an event may carry is listed here. Nothing carries a request
// URL, query string, header, body, client address, User-Agent string, binding
// or secret; `route` is always the configured pattern.
export const events = Object.freeze({
  request: Object.freeze(['event', 'requestId', 'status', 'durationMs', 'method', 'route']),
  reload: Object.freeze(['event', 'status', 'version', 'routes']),
  watch: Object.freeze(['event', 'status']),
  function_worker: Object.freeze(['event', 'status', 'slot', 'attempt', 'delayMs']),
  link_store_worker: Object.freeze(['event', 'status', 'readOnly', 'attempt', 'delayMs']),
  link_request: Object.freeze(['event', 'requestId', 'collection', 'route', 'code', 'method', 'status', 'outcome', 'durationMs']),
  link_observer: Object.freeze(['event', 'status', 'reason', 'dropped', 'queued', 'delivered', 'failed', 'timedOut', 'closed']),
  logs_dropped: Object.freeze(['event', 'count']),
  observer: Object.freeze(['event', 'status', 'name']),
  management_request: Object.freeze(['event', 'timestamp', 'requestId', 'collection', 'action', 'authenticated', 'principal', 'status', 'outcome', 'durationMs']),
  throttle: Object.freeze(['event', 'route', 'outcome', 'remaining']),
  agents: Object.freeze(['event', 'route', 'list', 'outcome']),
  cache: Object.freeze(['event', 'route', 'outcome']),
  listening: Object.freeze(['event', 'address', 'port', 'mode', 'origin']),
});

const hookNames = ['onEvent', 'onMetrics', 'onClose'];
const namePattern = /^[a-z][a-z0-9-]{0,63}$/;

export function validateObservers(observers = []) {
  assert(Array.isArray(observers) && observers.length <= 32, 'Observers must be an array of at most 32 entries');
  const seen = new Set();
  for (const observer of observers) {
    assert(observer && typeof observer === 'object', 'Observer must be an object');
    assert(typeof observer.name === 'string' && namePattern.test(observer.name), 'Observer name must be lowercase kebab-case');
    assert(!seen.has(observer.name), `Duplicate observer "${observer.name}"`); seen.add(observer.name);
    assert(typeof observer.version === 'string' && observer.version.length <= 64, `Observer "${observer.name}" needs a version string`);
    for (const hook of hookNames) assert(observer[hook] === undefined || typeof observer[hook] === 'function', `Observer "${observer.name}" hook ${hook} must be a function`);
    assert(hookNames.some(hook => observer[hook]), `Observer "${observer.name}" declares no hooks`);
  }
  return observers;
}

export const SNAPSHOT_VERSION = 1;
const statusClasses = ['2xx', '3xx', '4xx', '5xx'];
const MAX_ROUTES = 10000;
const outcomes = {
  throttle: ['allowed', 'exceeded'],
  agents: ['denied', 'reported'],
  cache: ['hit', 'stale', 'miss', 'store'],
  link_request: ['completed', 'aborted', 'missing', 'disabled', 'expired', 'invalid_code', 'invalid_record', 'unavailable'],
};
const zeroed = keys => Object.fromEntries(keys.map(key => [key, 0]));

// Counters and gauges derived from the events that pass through a sink, plus
// the few facts only the server knows (admission, shedding). Numbers only; the
// only keyed series is per configured route pattern, capped so a reviewed but
// large configuration cannot grow it without bound.
export function createMetrics() {
  const started = Date.now();
  const requests = { total: 0, byStatusClass: zeroed(statusClasses), inFlight: 0, byRoute: Object.create(null) };
  const health = { total: 0, byStatusClass: zeroed(statusClasses), inFlight: 0 };
  const shed = { requests: 0, health: 0 };
  const reloads = { ok: 0, rejected: 0 };
  const watch = { failed: 0 };
  const functionWorkers = { started: 0, restarts: 0 };
  const linkStoreWorkers = { started: 0, restarts: 0 };
  const policies = { throttle: zeroed(outcomes.throttle), agents: zeroed(outcomes.agents), cache: zeroed(outcomes.cache) };
  const linkRequests = zeroed(outcomes.link_request);
  const linkObserver = { failed: 0, dropped: 0 };
  let logsDropped = 0, observerErrors = 0;
  const count = (table, key) => { if (Object.hasOwn(table, key)) table[key]++; };
  function countRequest(target, status, route) {
    target.total++;
    const cls = `${Math.floor(status / 100)}xx`;
    if (Object.hasOwn(target.byStatusClass, cls)) target.byStatusClass[cls]++;
    if (route && target.byRoute) {
      if (Object.hasOwn(target.byRoute, route)) target.byRoute[route]++;
      else if (Object.keys(target.byRoute).length < MAX_ROUTES) target.byRoute[route] = 1;
    }
  }
  return {
    // `context` carries what the event does not: the route when the request
    // log is minimal, and whether this was a probe.
    record(event, context = {}) {
      if (!event || typeof event !== 'object') return;
      switch (event.event) {
        case 'request': countRequest(context.probe ? health : requests, event.status, context.probe ? null : (event.route ?? context.route)); break;
        case 'reload': count(reloads, event.status); break;
        case 'watch': if (event.status === 'failed') watch.failed++; break;
        case 'function_worker': if (event.status === 'restarting') functionWorkers.restarts++; else if (event.status === 'started') functionWorkers.started++; break;
        case 'link_store_worker': if (event.status === 'restarting') linkStoreWorkers.restarts++; else if (event.status === 'started') linkStoreWorkers.started++; break;
        case 'throttle': case 'agents': case 'cache': count(policies[event.event], event.outcome); break;
        case 'link_request': count(linkRequests, event.outcome); break;
        case 'link_observer': if (event.status === 'failed') linkObserver.failed++; else if (event.status === 'dropped' || event.status === 'closed') linkObserver.dropped = Math.max(linkObserver.dropped, event.dropped || 0); break;
        case 'logs_dropped': logsDropped += Number(event.count) || 0; break;
        case 'observer': if (event.status === 'failed') observerErrors++; break;
        default: break;
      }
    },
    inFlight(kind, delta) { if (kind === 'health') health.inFlight += delta; else requests.inFlight += delta; },
    shed(kind) { shed[kind === 'health' ? 'health' : 'requests']++; },
    observerError() { observerErrors++; },
    snapshot(extra = {}) {
      return {
        version: SNAPSHOT_VERSION,
        uptimeSeconds: Math.round((Date.now() - started) / 1000),
        rssBytes: process.memoryUsage.rss(),
        requests: { total: requests.total, byStatusClass: { ...requests.byStatusClass }, inFlight: requests.inFlight, byRoute: { ...requests.byRoute } },
        health: { total: health.total, byStatusClass: { ...health.byStatusClass }, inFlight: health.inFlight },
        shed: { ...shed },
        reloads: { ...reloads },
        watch: { ...watch },
        functionWorkers: { ...functionWorkers, healthySlots: 0, slots: 0 },
        linkStoreWorkers: { ...linkStoreWorkers },
        policies: { throttle: { ...policies.throttle }, agents: { ...policies.agents }, cache: { ...policies.cache } },
        linkRequests: { ...linkRequests },
        linkObserver: { ...linkObserver },
        logsDropped,
        observers: { errors: observerErrors },
        ...extra,
      };
    },
  };
}

// Fan-out to the default sink first, then each observer in array order. An
// observer that throws is counted and reported to the default sink only, so a
// bad observer can neither fail a request nor recurse through the others.
export function createObserverSink(observers = [], fallbackLog = () => {}, metrics = createMetrics()) {
  validateObservers(observers);
  const report = event => { try { fallbackLog(event); } catch { /* Logging cannot fail requests. */ } };
  const sink = (event, context) => {
    metrics.record(event, context);
    report(event);
    for (const observer of observers) {
      if (!observer.onEvent) continue;
      try {
        const result = observer.onEvent(event);
        if (result && typeof result.then === 'function') result.then(undefined, () => sink.fail(observer));
      } catch { sink.fail(observer); }
    }
  };
  sink.fail = observer => { metrics.observerError(); report({ event: 'observer', status: 'failed', name: observer.name }); };
  sink.metrics = metrics;
  sink.observers = observers;
  sink.publish = snapshot => {
    for (const observer of observers) {
      if (!observer.onMetrics) continue;
      try {
        const result = observer.onMetrics(snapshot);
        if (result && typeof result.then === 'function') result.then(undefined, () => sink.fail(observer));
      } catch { sink.fail(observer); }
    }
  };
  sink.close = async () => {
    for (let i = observers.length - 1; i >= 0; i--) { try { await observers[i].onClose?.(); } catch { sink.fail(observers[i]); } }
  };
  return sink;
}

// Prometheus text exposition, version 0.0.4. Labels are limited to
// status_class, route (a configured pattern) and outcome (a fixed vocabulary).
const escapeLabel = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
export function renderPrometheus(snapshot) {
  const lines = [];
  const metric = (name, type, help, samples) => {
    lines.push(`# HELP urlcode_${name} ${help}`, `# TYPE urlcode_${name} ${type}`);
    for (const [labels, value] of samples) {
      const label = Object.entries(labels || {}).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
      lines.push(`urlcode_${name}${label ? `{${label}}` : ''} ${Number.isFinite(value) ? value : 0}`);
    }
  };
  const byKey = (table, label) => Object.entries(table || {}).map(([key, value]) => [{ [label]: key }, value]);
  metric('requests_total', 'counter', 'Application requests answered since start, by status class.', byKey(snapshot.requests?.byStatusClass, 'status_class'));
  metric('route_requests_total', 'counter', 'Application requests answered since start, by configured route pattern.', byKey(snapshot.requests?.byRoute, 'route'));
  metric('requests_in_flight', 'gauge', 'Application requests currently admitted.', [[{}, snapshot.requests?.inFlight]]);
  metric('health_requests_total', 'counter', 'Probe and metrics requests answered since start, by status class.', byKey(snapshot.health?.byStatusClass, 'status_class'));
  metric('health_requests_in_flight', 'gauge', 'Probe and metrics requests currently admitted.', [[{}, snapshot.health?.inFlight]]);
  metric('shed_total', 'counter', 'Requests refused with 503 because an admission budget was full.', byKey(snapshot.shed, 'outcome'));
  metric('reloads_total', 'counter', 'Configuration reloads since start.', byKey(snapshot.reloads, 'outcome'));
  metric('watch_failures_total', 'counter', 'Development watcher failures.', [[{}, snapshot.watch?.failed]]);
  metric('function_worker_restarts_total', 'counter', 'Function worker replacements scheduled.', [[{}, snapshot.functionWorkers?.restarts]]);
  metric('function_worker_healthy_slots', 'gauge', 'Function worker slots ready to serve.', [[{}, snapshot.functionWorkers?.healthySlots]]);
  metric('function_worker_slots', 'gauge', 'Function worker slots configured.', [[{}, snapshot.functionWorkers?.slots]]);
  metric('link_store_worker_restarts_total', 'counter', 'Link-store worker replacements scheduled.', [[{}, snapshot.linkStoreWorkers?.restarts]]);
  metric('throttle_total', 'counter', 'Throttle policy decisions.', byKey(snapshot.policies?.throttle, 'outcome'));
  metric('agents_total', 'counter', 'Agents policy decisions.', byKey(snapshot.policies?.agents, 'outcome'));
  metric('cache_total', 'counter', 'Cache policy outcomes.', byKey(snapshot.policies?.cache, 'outcome'));
  metric('link_requests_total', 'counter', 'Dynamic link requests by outcome.', byKey(snapshot.linkRequests, 'outcome'));
  metric('link_observer_failures_total', 'counter', 'Link event collector failures.', [[{}, snapshot.linkObserver?.failed]]);
  metric('link_observer_dropped_total', 'counter', 'Link events dropped under overload.', [[{}, snapshot.linkObserver?.dropped]]);
  metric('logs_dropped_total', 'counter', 'Log records the JSON logger shed.', [[{}, snapshot.logsDropped]]);
  metric('observer_errors_total', 'counter', 'Observer hooks that threw or rejected.', [[{}, snapshot.observers?.errors]]);
  metric('uptime_seconds', 'gauge', 'Seconds since the process started serving.', [[{}, snapshot.uptimeSeconds]]);
  metric('process_rss_bytes', 'gauge', 'Resident set size of the process.', [[{}, snapshot.rssBytes]]);
  metric('metrics_snapshot_version', 'gauge', 'Version of the metrics snapshot shape.', [[{}, snapshot.version]]);
  return lines.join('\n') + '\n';
}
