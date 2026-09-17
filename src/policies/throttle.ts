import { assert } from '../errors.ts';

// Sliding-window request budget, expressed in the vocabulary of the IETF
// httpapi RateLimit-Policy / RateLimit fields (draft-ietf-httpapi-
// ratelimit-headers) so a NGINX limit_req or a CDN rule can restate the
// same numbers. Two fixed windows are blended by elapsed fraction: cheaper
// than a log, smoother than a fixed window, and the reset time stays
// explainable in a header. Counters are per runtime, never per process
// group; multi-instance sharing is a plugin concern.
export const name = 'throttle';
export const phases = ['request','response'];
const partitions = ['client','route','client-route'];
const bodies = { 429: 'Too many requests\n', 503: 'Service unavailable\n' };

// Per-instance counters are only honest where one instance sees the whole
// route; serverless targets fan a client across instances, so a client
// budget there would silently be quota × instances.
export function targets(config = {}) {
  const perRoute = config.partition === 'route';
  return { node: 'native', vercel: perRoute ? 'native' : 'refused', aws: perRoute ? 'native' : 'refused', cloudflare: 'refused' };
}

export async function compile(config, { route, shared }) {
  assert(config && typeof config === 'object', `policies.${name} on ${route.pattern} must be an object`);
  const { quota, window, partition = 'client', status = 429, mode = 'enforce', maxKeys = 100000 } = config;
  assert(Number.isInteger(quota) && quota >= 1, `policies.${name}.quota on ${route.pattern} must be a positive integer`);
  assert(Number.isInteger(window) && window >= 1, `policies.${name}.window on ${route.pattern} must be a positive integer of seconds`);
  assert(partitions.includes(partition), `policies.${name}.partition on ${route.pattern} must be one of ${partitions.join(', ')}`);
  assert(Number.isInteger(status) && status >= 400 && status <= 599, `policies.${name}.status on ${route.pattern} must be a 4xx or 5xx status`);
  assert(mode === 'enforce' || mode === 'report', `policies.${name}.mode on ${route.pattern} must be enforce or report`);
  assert(Number.isInteger(maxKeys) && maxKeys >= 1, `policies.${name}.maxKeys on ${route.pattern} must be a positive integer`);
  // One table per runtime so a client budget spans routes that share a
  // policy; the widest maxKeys wins because the table is common.
  const table = shared.throttle ||= { keys: new Map(), maxKeys: 0, now: shared.now || Date.now };
  table.maxKeys = Math.max(table.maxKeys, maxKeys);
  return { quota, window, windowMs: window * 1000, partition, status, mode, route: route.pattern, table, log: shared.log, pending: new WeakMap() };
}

// Key by what the partition names, scoped to the budget itself so routes
// that restate the same quota share one client counter while a route that
// overrides it gets its own. An unresolved client (a caller that gave none,
// or an adapter without a peer) shares one bucket rather than being exempt,
// so a misconfigured proxy fails closed instead of open.
function keyFor(state, req) {
  const client = req.client ?? 'shared';
  const budget = `${state.quota}/${state.window}`;
  if (state.partition === 'route') return `${budget}|route|${req.route}`;
  if (state.partition === 'client') return `${budget}|client|${client}`;
  return `${budget}|client-route|${client}|${req.route}`;
}

function touch(state, key) {
  const { keys, maxKeys } = state.table;
  let entry = keys.get(key);
  if (entry) keys.delete(key); else entry = { start: 0, current: 0, previous: 0 };
  keys.set(key, entry);
  // Map preserves insertion order, so re-inserting on access makes the first
  // key the least recently used.
  while (keys.size > maxKeys) keys.delete(keys.keys().next().value);
  return entry;
}

// Roll the fixed windows forward, then weigh the previous one by how much of
// it still overlaps a window ending now.
function observe(state, entry, now) {
  const start = now - (now % state.windowMs);
  if (start !== entry.start) {
    entry.previous = start - entry.start === state.windowMs ? entry.current : 0;
    entry.current = 0; entry.start = start;
  }
  const elapsed = (now - start) / state.windowMs;
  return { used: entry.previous * (1 - elapsed) + entry.current, reset: Math.max(1, Math.ceil((start + state.windowMs - now) / 1000)) };
}

function headersFor(state, { remaining, reset }) {
  return [['ratelimit-policy', `"default";q=${state.quota};w=${state.window}`], ['ratelimit', `"default";r=${remaining};t=${reset}`]];
}

function withHeaders(result, added) {
  const names = new Set(added.map(([n]) => n));
  return { ...result, headers: [...result.headers.filter(([n]) => !names.has(String(n).toLowerCase())), ...added] };
}

export async function onRequest(state, req) {
  const now = state.table.now();
  const entry = touch(state, keyFor(state, req));
  const { used, reset } = observe(state, entry, now);
  const exceeded = used + 1 > state.quota;
  // A refused request is not counted: it did no work, and counting it would
  // let a retry loop keep its own window from ever clearing.
  if (!exceeded || state.mode === 'report') entry.current++;
  const remaining = Math.max(0, Math.floor(state.quota - used - (exceeded ? 0 : 1)));
  const budget = { remaining, reset };
  if (exceeded || state.mode === 'report') {
    try { state.log?.({ event: 'throttle', route: state.route, outcome: exceeded ? 'exceeded' : 'allowed', remaining }); } catch { /* logging never changes the outcome */ }
  }
  if (!exceeded || state.mode === 'report') { state.pending.set(req, budget); return undefined; }
  // The runtime skips the response phase of request-phase modules for an
  // early result, so the refusal must carry its own headers.
  return withHeaders({ status: state.status, headers: [['content-type', 'text/plain; charset=utf-8'], ['cache-control', 'no-store'], ['retry-after', String(reset)]],
    body: Buffer.from(bodies[state.status] || 'Request refused\n') }, headersFor(state, budget));
}

export function onResponse(state, req, result) {
  const budget = state.pending.get(req);
  return budget ? withHeaders(result, headersFor(state, budget)) : result;
}

export function describe(state) {
  const summary = { quota: state.quota, window: state.window, partition: state.partition, mode: state.mode, status: state.status };
  if (state.partition !== 'route') summary.unresolvedClient = 'shared key';
  return summary;
}

export async function close(shared) {
  shared.throttle?.keys.clear();
  delete shared.throttle;
}
