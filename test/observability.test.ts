import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { createRuntime } from '../src/runtime.ts';
import { events, validateObservers, createObserverSink, createMetrics, renderPrometheus, SNAPSHOT_VERSION } from '../src/observability.ts';
import type { ObserverEvent, MetricsSnapshot } from '../src/observability.ts';
import type { ServerOptions } from '../src/server.ts';
import { project, redirect, request, param } from './helpers.ts';

const forbidden = /customer-7|secret|user-agent|127\.0\.0\.1|Mozilla/i;
const declared = (name: unknown): name is keyof typeof events => typeof name === 'string' && Object.hasOwn(events, name);
function conforms(seen: ObserverEvent[]) {
  for (const event of seen) {
    assert.ok(declared(event.event), `undeclared event ${event.event}`);
    for (const key of Object.keys(event)) assert.ok(events[event.event].includes(key), `undeclared field ${event.event}.${key}`);
  }
}
const collector = () => { const seen: ObserverEvent[] = []; return { seen, observer: { name: 'collect', version: '1', onEvent: (event: ObserverEvent) => seen.push(event) } }; };

test('every event a real server run emits matches the catalogue and carries no request text', async t => {
  const { seen, observer } = collector();
  const page = '<html>' + 'x'.repeat(64) + '</html>';
  const root = await project(t, {
    '/u/{id}': { parameters: [param('id')], ...redirect(), policies: { agents: { deny: ['ai-crawlers'], mode: 'report' } } },
    '/page': { page: { file: 'public/page.html' }, policies: { cache: { strategy: 'swr', maxAge: 60, staleWhileRevalidate: 60 } } },
    '/f': { sandbox: true, function: { source: 'f.mjs' } },
  }, { 'public/page.html': page, 'f.mjs': 'export default () => new Response("ok");' },
  { policies: { throttle: { quota: 2, window: 60, partition: 'route' } } });
  const app = await startServer({ project: root, port: 0, requestLog: 'detailed', log: () => {}, observers: [observer] });
  t.after(() => app.close());
  assert.equal((await request(app, '/u/customer-7?token=secret', { headers: { 'user-agent': 'Mozilla/5.0 GPTBot' } })).status, 302);
  assert.equal((await request(app, '/page')).status, 200);
  assert.equal((await request(app, '/page')).status, 200);
  assert.equal((await request(app, '/page')).status, 429);
  assert.equal((await request(app, '/f')).status, 200);
  assert.equal((await request(app, '/missing')).status, 404);
  assert.equal((await request(app, '/_urlcode/ready')).status, 200);
  assert.equal(await app.reload(), true);
  await writeFile(join(app.root, 'urlcode.yaml'), 'version: "1"\nroutes: { "/": { redirect: { url: "not a url" } } }\n');
  assert.equal(await app.reload(), false);
  const names = new Set(seen.map(event => event.event));
  for (const name of ['request', 'reload', 'function_worker', 'throttle', 'agents', 'cache']) assert.ok(names.has(name), `no ${name} event seen`);
  conforms(seen);
  assert.ok(!forbidden.test(JSON.stringify(seen)), 'an event carried request text');
  const detailed = seen.find(event => event.event === 'request');
  assert.ok(detailed, 'no request event seen');
  assert.deepEqual(Object.keys(detailed).sort(), [...events.request].sort());
  assert.equal(detailed.route, '/u/{id}');
  assert.deepEqual(seen.filter(event => event.event === 'reload').map(event => event.status), ['ok', 'rejected']);
  assert.deepEqual(app.observers, [{ name: 'collect', version: '1' }]);
});

test('a throwing or rejecting observer is isolated, counted, and does not stop the next observer', async t => {
  const { seen, observer } = collector();
  const closed: string[] = [];
  const root = await project(t, { '/go': redirect() });
  const app = await startServer({ project: root, port: 0, log: () => {}, observers: [
    { name: 'broken', version: '0', onEvent() { throw new Error('boom'); }, onClose() { closed.push('broken'); } },
    { name: 'async-broken', version: '0', async onEvent() { throw new Error('later'); } },
    { ...observer, onClose() { closed.push('collect'); } },
  ] });
  assert.equal((await request(app, '/go')).status, 302);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(seen.some(event => event.event === 'request' && event.status === 302));
  const snapshot = app.metrics();
  assert.equal(snapshot.observers.errors, 2);
  assert.equal(snapshot.requests.byStatusClass['3xx'], 1);
  await app.close();
  assert.deepEqual(closed, ['collect', 'broken']);
});

test('metrics count requests by class, probes, shedding and per-route patterns', async t => {
  const root = await project(t, { '/go': redirect(), '/u/{id}': { parameters: [param('id')], ...redirect() } });
  const snapshots: MetricsSnapshot[] = [];
  const app = await startServer({ project: root, port: 0, maxInFlightRequests: 1, log: () => {},
    observers: [{ name: 'gauge', version: '1', onMetrics: snapshot => snapshots.push(snapshot) }] });
  t.after(() => app.close());
  assert.equal((await request(app, '/go')).status, 302);
  assert.equal((await request(app, '/u/private-value')).status, 302);
  assert.equal((await request(app, '/nope')).status, 404);
  assert.equal((await request(app, '/_urlcode/health')).status, 200);
  const entered = new Promise(resolve => app.server.once('request', resolve));
  const upload = http.request({ host: '127.0.0.1', port: app.address.port, path: '/go', method: 'POST', headers: { 'transfer-encoding': 'chunked' } });
  upload.on('error', () => {}); t.after(() => upload.destroy()); upload.write('unfinished'); await entered;
  assert.equal((await request(app, '/go')).status, 503);
  const busy = app.metrics();
  assert.equal(busy.requests.inFlight, 1);
  assert.equal(busy.shed.requests, 1);
  const completed = new Promise(resolve => upload.once('response', res => { res.resume(); res.once('end', resolve); }));
  upload.end(); await completed;
  const m = app.metrics();
  assert.equal(m.version, SNAPSHOT_VERSION);
  assert.equal(m.requests.total, 5);
  // Two redirects, a 404, the shed 503 and the finished POST (405 on a GET-only route).
  assert.deepEqual(m.requests.byStatusClass, { '2xx': 0, '3xx': 2, '4xx': 2, '5xx': 1 });
  assert.equal(m.requests.inFlight, 0);
  // A shed request never matched, so it has no route.
  assert.deepEqual(m.requests.byRoute, { '/go': 2, '/u/{id}': 1 });
  assert.equal(m.health.total, 1);
  assert.equal(m.health.byStatusClass['2xx'], 1);
  assert.deepEqual(m.reloads, { ok: 0, rejected: 0 });
  assert.deepEqual(m.functionWorkers, { started: 0, restarts: 0, healthySlots: 0, slots: 0 });
  assert.ok(m.uptimeSeconds >= 0 && m.rssBytes > 0);
  assert.ok(!JSON.stringify(m).includes('private-value'));
  await app.close();
  assert.equal(snapshots.length, 1, 'a final snapshot reaches onMetrics at close');
  assert.equal(snapshots[0]?.requests.total, 5);
});

test('policy and worker counters derive from the events the policies already emit', async t => {
  const page = '<html>' + 'x'.repeat(64) + '</html>';
  const root = await project(t, {
    '/page': { page: { file: 'public/page.html' }, policies: { cache: { strategy: 'swr', maxAge: 60, staleWhileRevalidate: 60 } } },
    '/bot': { ...redirect(), policies: { agents: { deny: ['ai-crawlers'] } } },
    '/f': { sandbox: true, function: { source: 'f.mjs' } },
  }, { 'public/page.html': page, 'f.mjs': 'export default () => new Response("ok");' },
  { policies: { throttle: { quota: 3, window: 60, partition: 'route' } } });
  const runtime = await createRuntime(root, { log: () => {}, workers: 1 });
  t.after(() => runtime.close());
  const handle = (target: string, headers: Record<string, string> = {}) => runtime.handle({ target, headers: new Headers(headers), headerCounts: {} });
  assert.equal((await handle('/page')).status, 200);
  assert.equal((await handle('/page')).status, 200);
  assert.equal((await handle('/bot', { 'user-agent': 'GPTBot/1.0' })).status, 403);
  assert.equal((await handle('/page')).status, 200);
  assert.equal((await handle('/page')).status, 429);
  const m = runtime.metrics();
  assert.deepEqual(m.policies.cache, { hit: 2, stale: 0, miss: 1, store: 1 });
  assert.deepEqual(m.policies.agents, { denied: 1, reported: 0 });
  // In enforce mode the throttle logs refusals only; `allowed` counts in report mode.
  assert.deepEqual(m.policies.throttle, { allowed: 0, exceeded: 1 });
  assert.deepEqual(m.functionWorkers, { started: 1, restarts: 0, healthySlots: 1, slots: 1 });
});

test('the Prometheus endpoint is off by default, shares the probe budget and renders the snapshot', async t => {
  const root = await project(t, { '/go': redirect() });
  const off = await startServer({ project: root, port: 0, log: () => {} });
  t.after(() => off.close());
  assert.equal((await request(off, '/_urlcode/metrics')).status, 404);
  const on = await startServer({ project: root, port: 0, log: () => {}, metrics: true, requestLog: 'detailed' });
  t.after(() => on.close());
  assert.equal((await request(on, '/go')).status, 302);
  const scrape = await request(on, '/_urlcode/metrics');
  assert.equal(scrape.status, 200);
  assert.match(scrape.headers['content-type'] ?? '', /^text\/plain; version=0\.0\.4/);
  assert.match(scrape.body, /^# TYPE urlcode_requests_total counter$/m);
  assert.match(scrape.body, /^urlcode_requests_total\{status_class="3xx"\} 1$/m);
  assert.match(scrape.body, /^urlcode_route_requests_total\{route="\/go"\} 1$/m);
  assert.match(scrape.body, /^urlcode_requests_in_flight 0$/m);
  assert.equal((await request(on, '/_urlcode/metrics', { method: 'POST' })).status, 405);
  // The scrape itself is metered with the probes, not the application.
  assert.equal(on.metrics().health.total, 2);
  assert.equal(on.metrics().requests.total, 1);
  // metrics:'yes' is the wrong type on purpose: the server must refuse it at run time.
  const invalid: Record<string, unknown>[] = [{ metrics: 'yes' }, { metricsIntervalMs: 10 }, { metricsIntervalMs: 1.5 }];
  for (const options of invalid) await assert.rejects(startServer({ project: root, port: 0, log: () => {}, ...options as ServerOptions }), /Metrics/);
});

test('renderPrometheus is pure and escapes route labels', () => {
  const metrics = createMetrics();
  metrics.record({ event: 'request', status: 200 }, { route: '/a/{x}' });
  metrics.record({ event: 'request', status: 503 }, { route: '/q"\\' });
  metrics.record({ event: 'request', status: 200 }, { probe: true });
  metrics.record({ event: 'reload', status: 'ok' }); metrics.record({ event: 'reload', status: 'bogus' });
  metrics.record({ event: 'function_worker', status: 'restarting', slot: 0, attempt: 1, delayMs: 250 });
  metrics.record({ event: 'cache', route: '/a', outcome: 'stale' });
  metrics.record({ event: 'link_request', outcome: 'completed' });
  metrics.record({ event: 'logs_dropped', count: 7 });
  metrics.record({ event: 'unknown' }); metrics.record(null);
  const snapshot = metrics.snapshot();
  const text = renderPrometheus(snapshot);
  assert.equal(text, renderPrometheus(snapshot));
  const expected = [
    '# HELP urlcode_requests_total Application requests answered since start, by status class.',
    '# TYPE urlcode_requests_total counter',
    'urlcode_requests_total{status_class="2xx"} 1', 'urlcode_requests_total{status_class="3xx"} 0',
    'urlcode_requests_total{status_class="4xx"} 0', 'urlcode_requests_total{status_class="5xx"} 1',
    '# HELP urlcode_route_requests_total Application requests answered since start, by configured route pattern.',
    '# TYPE urlcode_route_requests_total counter',
    'urlcode_route_requests_total{route="/a/{x}"} 1', 'urlcode_route_requests_total{route="/q\\"\\\\"} 1',
  ];
  assert.deepEqual(text.split('\n').slice(0, expected.length), expected);
  for (const line of ['urlcode_health_requests_total{status_class="2xx"} 1', 'urlcode_reloads_total{outcome="ok"} 1', 'urlcode_reloads_total{outcome="rejected"} 0',
    'urlcode_function_worker_restarts_total 1', 'urlcode_cache_total{outcome="stale"} 1', 'urlcode_link_requests_total{outcome="completed"} 1',
    'urlcode_logs_dropped_total 7', `urlcode_metrics_snapshot_version ${SNAPSHOT_VERSION}`]) assert.ok(text.includes(line + '\n'), `missing ${line}`);
  assert.ok(!/status=|method=|requestId=/.test(text));
  for (const name of text.match(/^urlcode_[a-z_]+/gm) ?? []) assert.match(name, /^urlcode_[a-z_]+$/);
  for (const line of text.split('\n')) if (line.startsWith('# TYPE') && line.endsWith('counter')) assert.match(line, /_total counter$/);
});

test('observers validate like plugins and the sink isolates the fallback logger', () => {
  assert.doesNotThrow(() => validateObservers([{ name: 'a', version: '1', onEvent() {} }]));
  const cases: [unknown, RegExp][] = [
    [[{ name: 'Bad', version: '1', onEvent() {} }], /kebab-case/],
    [[{ name: 'a', onEvent() {} }], /version/],
    [[{ name: 'a', version: '1' }], /declares no hooks/],
    [[{ name: 'a', version: '1', onEvent: 1 }], /must be a function/],
    [[{ name: 'a', version: '1', onEvent() {} }, { name: 'a', version: '2', onEvent() {} }], /Duplicate/],
    ['nope', /array/], [[null], /object/],
  ];
  for (const [bad, message] of cases) assert.throws(() => validateObservers(bad), message);
  const seen: ObserverEvent[] = [];
  const sink = createObserverSink([{ name: 'a', version: '1', onEvent: (event: ObserverEvent) => seen.push(event) }], () => { throw new Error('logger down'); });
  assert.doesNotThrow(() => sink({ event: 'watch', status: 'failed' }));
  assert.deepEqual(seen, [{ event: 'watch', status: 'failed' }]);
  assert.equal(sink.metrics.snapshot().watch.failed, 1);
  assert.ok(Object.isFrozen(events) && Object.isFrozen(events.request));
});
