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
  signal: Object.freeze(['event','outcome','count']),
  request: Object.freeze(['event', 'requestId', 'status', 'durationMs', 'method', 'route']),
  reload: Object.freeze(['event', 'status', 'version', 'routes']),
  watch: Object.freeze(['event', 'status']),
  function_worker: Object.freeze(['event', 'status', 'slot', 'attempt', 'delayMs']),
  logs_dropped: Object.freeze(['event', 'count']),
  observer: Object.freeze(['event', 'status', 'name']),
  throttle: Object.freeze(['event', 'route', 'outcome', 'remaining']),
  agents: Object.freeze(['event', 'route', 'list', 'outcome']),
  cache: Object.freeze(['event', 'route', 'outcome']),
  listening: Object.freeze(['event', 'address', 'port', 'mode', 'origin']),
  extension_warning: Object.freeze(['event', 'extension', 'message']),
});

/** One log record: a flat object whose `event` key names the kind (see `events`). */
export type ObserverEvent = Record<string, unknown>;
export interface Observer {
  name: string; version: string;
  onEvent?(event: ObserverEvent): unknown;
  onMetrics?(snapshot: MetricsSnapshot): unknown;
  onClose?(): unknown;
}
/** What the event does not say: the route when the request log is minimal, and whether this was a probe. */
export interface RecordContext { probe?: boolean; route?: string }
type Counters = Record<string, number>;
interface RequestCounters { total: number; byStatusClass: Counters; inFlight: number; byRoute?: Counters }
export interface MetricsSnapshot {
  version: number; uptimeSeconds: number; rssBytes: number;
  requests: { total: number; byStatusClass: Counters; inFlight: number; byRoute: Counters };
  health: { total: number; byStatusClass: Counters; inFlight: number };
  shed: { requests: number; health: number }; reloads: { ok: number; rejected: number }; watch: { failed: number };
  functionWorkers: { started: number; restarts: number; healthySlots: number; slots: number };
  policies: { throttle: Counters; agents: Counters; cache: Counters };
  signals: Counters;
  logsDropped: number; observers: { errors: number };
  [extra: string]: unknown;
}
export interface Metrics {
  record(event: unknown, context?: RecordContext): void;
  inFlight(kind: string, delta: number): void;
  shed(kind: string): void;
  observerError(): void;
  snapshot(extra?: Record<string, unknown>): MetricsSnapshot;
}
/** The log sink the runtime writes to: callable like a logger, with the counters and observers hanging off it. */
export type ObserverSink = ((event: ObserverEvent, context?: RecordContext) => void) & {
  fail(observer: Observer): void; metrics: Metrics; observers: Observer[];
  publish(snapshot: MetricsSnapshot): void; close(): Promise<void>;
};

const hookNames = ['onEvent', 'onMetrics', 'onClose'] as const;
const namePattern = /^[a-z][a-z0-9-]{0,63}$/;

export function validateObservers(observers: unknown = []): Observer[] {
  assert(Array.isArray(observers) && observers.length <= 32, 'Observers must be an array of at most 32 entries');
  const seen = new Set<string>();
  for (const candidate of observers as unknown[]) {
    assert(candidate && typeof candidate === 'object', 'Observer must be an object');
    const observer = candidate as Partial<Observer>; // trust boundary: operator code, checked field by field
    assert(typeof observer.name === 'string' && namePattern.test(observer.name), 'Observer name must be lowercase kebab-case');
    assert(!seen.has(observer.name), `Duplicate observer "${observer.name}"`); seen.add(observer.name);
    assert(typeof observer.version === 'string' && observer.version.length <= 64, `Observer "${observer.name}" needs a version string`);
    for (const hook of hookNames) assert(observer[hook] === undefined || typeof observer[hook] === 'function', `Observer "${observer.name}" hook ${hook} must be a function`);
    assert(hookNames.some(hook => observer[hook]), `Observer "${observer.name}" declares no hooks`);
  }
  return observers as Observer[]; // every entry was just checked
}

export const SNAPSHOT_VERSION = 2;
const statusClasses = ['2xx', '3xx', '4xx', '5xx'];
const MAX_ROUTES = 10000;
const outcomes = {
  throttle: ['allowed', 'exceeded'],
  agents: ['denied', 'reported'],
  cache: ['hit', 'stale', 'miss', 'store'],
};
const zeroed = (keys: string[]): Counters => Object.fromEntries(keys.map(key => [key, 0]));

// Counters and gauges derived from the events that pass through a sink, plus
// the few facts only the server knows (admission, shedding). Numbers only; the
// only keyed series is per configured route pattern, capped so a reviewed but
// large configuration cannot grow it without bound.
export function createMetrics(): Metrics {
  const started = Date.now();
  const requests: Required<RequestCounters> = { total: 0, byStatusClass: zeroed(statusClasses), inFlight: 0, byRoute: Object.create(null) as Counters };
  const health: RequestCounters = { total: 0, byStatusClass: zeroed(statusClasses), inFlight: 0 };
  const shed = { requests: 0, health: 0 };
  const reloads = { ok: 0, rejected: 0 };
  const watch = { failed: 0 };
  const functionWorkers = { started: 0, restarts: 0 };
  const policies = { throttle: zeroed(outcomes.throttle), agents: zeroed(outcomes.agents), cache: zeroed(outcomes.cache) };
  const signals = zeroed(['accepted','delivered','failed','dropped']);
  let logsDropped = 0, observerErrors = 0;
  const count = (table: Counters, key: unknown): void => { if (typeof key === 'string' && Object.hasOwn(table, key)) table[key]!++; };
  function countRequest(target: RequestCounters, status: unknown, route: unknown): void {
    target.total++;
    const cls = `${Math.floor(Number(status) / 100)}xx`;
    if (Object.hasOwn(target.byStatusClass, cls)) target.byStatusClass[cls]!++;
    if (route && target.byRoute) {
      const key = String(route);
      if (Object.hasOwn(target.byRoute, key)) target.byRoute[key]!++;
      else if (Object.keys(target.byRoute).length < MAX_ROUTES) target.byRoute[key] = 1;
    }
  }
  return {
    // `context` carries what the event does not: the route when the request
    // log is minimal, and whether this was a probe.
    record(event, context = {}) {
      if (!event || typeof event !== 'object') return;
      const record = event as ObserverEvent; // any object is read as a record; unknown keys are ignored
      switch (record.event) {
        case 'signal': if(typeof record.outcome==='string'&&Object.hasOwn(signals,record.outcome)&&Number.isSafeInteger(record.count)&&Number(record.count)>0)signals[record.outcome]!+=Number(record.count);break;
        case 'request': countRequest(context.probe ? health : requests, record.status, context.probe ? null : (record.route ?? context.route)); break;
        case 'reload': count(reloads, record.status); break;
        case 'watch': if (record.status === 'failed') watch.failed++; break;
        case 'function_worker': if (record.status === 'restarting') functionWorkers.restarts++; else if (record.status === 'started') functionWorkers.started++; break;
        case 'throttle': case 'agents': case 'cache': count(policies[record.event], record.outcome); break;
        case 'logs_dropped': logsDropped += Number(record.count) || 0; break;
        case 'observer': if (record.status === 'failed') observerErrors++; break;
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
        policies: { throttle: { ...policies.throttle }, agents: { ...policies.agents }, cache: { ...policies.cache } },
        signals: {...signals},
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
export function createObserverSink(observers: unknown = [], fallbackLog: (event: ObserverEvent) => void = () => {}, metrics: Metrics = createMetrics()): ObserverSink {
  const checked = validateObservers(observers);
  const report = (event: ObserverEvent): void => { try { fallbackLog(event); } catch { /* Logging cannot fail requests. */ } };
  const settle = (result: unknown, observer: Observer): void => {
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') (result as PromiseLike<unknown>).then(undefined, () => sink.fail(observer));
  };
  const sink: ObserverSink = Object.assign((event: ObserverEvent, context?: RecordContext): void => {
    metrics.record(event, context);
    report(event);
    for (const observer of checked) {
      if (!observer.onEvent) continue;
      try { settle(observer.onEvent(event), observer); } catch { sink.fail(observer); }
    }
  }, {
    fail(observer: Observer): void { metrics.observerError(); report({ event: 'observer', status: 'failed', name: observer.name }); },
    metrics,
    observers: checked,
    publish(snapshot: MetricsSnapshot): void {
      for (const observer of checked) {
        if (!observer.onMetrics) continue;
        try { settle(observer.onMetrics(snapshot), observer); } catch { sink.fail(observer); }
      }
    },
    async close(): Promise<void> {
      for (let i = checked.length - 1; i >= 0; i--) { try { await checked[i]!.onClose?.(); } catch { sink.fail(checked[i]!); } }
    },
  });
  return sink;
}

// Prometheus text exposition, version 0.0.4. Labels are limited to
// status_class, route (a configured pattern) and outcome (a fixed vocabulary).
const escapeLabel = (value: unknown): string => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
type Sample = [Record<string, string>, unknown];
export function renderPrometheus(snapshot: Partial<MetricsSnapshot>): string {
  const lines: string[] = [];
  const metric = (name: string, type: string, help: string, samples: Sample[]): void => {
    lines.push(`# HELP urlcode_${name} ${help}`, `# TYPE urlcode_${name} ${type}`);
    for (const [labels, value] of samples) {
      const label = Object.entries(labels || {}).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
      lines.push(`urlcode_${name}${label ? `{${label}}` : ''} ${typeof value === 'number' && Number.isFinite(value) ? value : 0}`);
    }
  };
  const byKey = (table: Counters | undefined, label: string): Sample[] => Object.entries(table || {}).map(([key, value]) => [{ [label]: key }, value]);
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
  metric('throttle_total', 'counter', 'Throttle policy decisions.', byKey(snapshot.policies?.throttle, 'outcome'));
  metric('agents_total', 'counter', 'Agents policy decisions.', byKey(snapshot.policies?.agents, 'outcome'));
  metric('cache_total', 'counter', 'Cache policy outcomes.', byKey(snapshot.policies?.cache, 'outcome'));
  metric('signals_total','counter','Best-effort webhook outcomes.',Object.entries(snapshot.signals||{}).map(([outcome,value])=>[{outcome},value]));
  metric('logs_dropped_total', 'counter', 'Log records the JSON logger shed.', [[{}, snapshot.logsDropped]]);
  metric('observer_errors_total', 'counter', 'Observer hooks that threw or rejected.', [[{}, snapshot.observers?.errors]]);
  metric('uptime_seconds', 'gauge', 'Seconds since the process started serving.', [[{}, snapshot.uptimeSeconds]]);
  metric('process_rss_bytes', 'gauge', 'Resident set size of the process.', [[{}, snapshot.rssBytes]]);
  metric('metrics_snapshot_version', 'gauge', 'Version of the metrics snapshot shape.', [[{}, snapshot.version]]);
  return lines.join('\n') + '\n';
}
