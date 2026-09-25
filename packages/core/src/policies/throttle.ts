import { clientKey } from '../client-address.ts';
import { assert } from '../errors.ts';
import type { HandlerResult, HeaderPair } from '../http-response.ts';
import type { LogFn, PolicyContext, PolicyRequest, PolicyShared, PolicySupport, TargetName } from '../types.ts';

// Sliding-window request budget, expressed in the vocabulary of the IETF
// httpapi RateLimit-Policy / RateLimit fields (draft-ietf-httpapi-
// ratelimit-headers) so a NGINX limit_req or a CDN rule can restate the
// same numbers. Two fixed windows are blended by elapsed fraction: cheaper
// than a log, smoother than a fixed window, and the reset time stays
// explainable in a header. Counters are per runtime, never per process
// group; multi-instance sharing is a plugin concern.
export const name = 'throttle';
export const phases: readonly string[] = ['request','response'];
type Partition = 'client' | 'route' | 'client-route';
export interface ThrottleConfig { quota: number; window: number; partition?: Partition; status?: number; mode?: 'enforce' | 'report'; maxKeys?: number }
interface Entry { start: number; current: number; previous: number }
/** The one counter table per runtime, shared by every route that declares a throttle. */
export interface ThrottleTable { keys: Map<string, Entry>; maxKeys: number; now: () => number }
interface Budget { remaining: number; reset: number }
export interface ThrottleState {
  quota: number; window: number; windowMs: number; partition: Partition; status: number; mode: 'enforce' | 'report';
  route: string; table: ThrottleTable; log: LogFn | undefined; pending: WeakMap<object, Budget>;
}
export interface ThrottleDescription { quota: number; window: number; partition: Partition; mode: 'enforce' | 'report'; status: number; unresolvedClient?: string }
const policyName = 'default';
const partitions: readonly string[] = ['client','route','client-route'];
const bodies: Record<number, string> = { 429: 'Too many requests\n', 503: 'Service unavailable\n' };

// Per-instance counters are only honest where one instance sees the whole
// route; serverless targets fan a client across instances, so a client
// budget there would silently be quota × instances.
export function targets(config: Partial<ThrottleConfig> = {}): Record<TargetName, PolicySupport> {
  const perRoute = config.partition === 'route';
  return { node: 'native', vercel: perRoute ? 'native' : 'refused', aws: perRoute ? 'native' : 'refused', cloudflare: 'refused' };
}

export async function compile(config: ThrottleConfig, { route, shared }: PolicyContext): Promise<ThrottleState> {
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
// so a misconfigured proxy fails closed instead of open. IPv6 clients are
// grouped by /64 (clientKey) so address rotation within one network neither
// earns fresh budgets nor churns the shared key table.
function keyFor(state: ThrottleState, req: PolicyRequest): string {
  const client = clientKey(req.client) ?? req.client ?? 'shared';
  const budget = `${state.quota}/${state.window}`;
  if (state.partition === 'route') return `${budget}|route|${req.route}`;
  if (state.partition === 'client') return `${budget}|client|${client}`;
  return `${budget}|client-route|${client}|${req.route}`;
}

function touch(state: ThrottleState, key: string): Entry {
  const { keys, maxKeys } = state.table;
  let entry = keys.get(key);
  if (entry) keys.delete(key); else entry = { start: 0, current: 0, previous: 0 };
  keys.set(key, entry);
  // Map preserves insertion order, so re-inserting on access makes the first
  // key the least recently used.
  while (keys.size > maxKeys) keys.delete(keys.keys().next().value!);
  return entry;
}

// Roll the fixed windows forward, then weigh the previous one by how much of
// it still overlaps a window ending now.
function observe(state: ThrottleState, entry: Entry, now: number): { used: number; reset: number } {
  const start = now - (now % state.windowMs);
  if (start !== entry.start) {
    entry.previous = start - entry.start === state.windowMs ? entry.current : 0;
    entry.current = 0; entry.start = start;
  }
  const elapsed = (now - start) / state.windowMs;
  return { used: entry.previous * (1 - elapsed) + entry.current, reset: Math.max(1, Math.ceil((start + state.windowMs - now) / 1000)) };
}

function headersFor(state: ThrottleState, { remaining, reset }: Budget): HeaderPair[] {
  return [['ratelimit-policy', `"${policyName}";q=${state.quota};w=${state.window}`], ['ratelimit', `"${policyName}";r=${remaining};t=${reset}`]];
}

// RateLimit-Policy and RateLimit are structured-field lists whose members
// are named policies, so another producer's policy on the same response (the
// auth extension's "credential" quota on its 429, #701) is kept: every prior
// field line of that name is folded into one comma-joined list and this
// policy's member appended. Only a member already named "default" (this
// policy's own) is dropped, so the field never carries it twice.
function members(value: string): string[] {
  const out: string[] = [];
  let start = 0, quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === ',') { out.push(value.slice(start, i)); start = i + 1; }
  }
  out.push(value.slice(start));
  return out.map(member => member.trim()).filter(Boolean);
}
function memberName(member: string): string {
  if (!member.startsWith('"')) return member.split(/[;\s]/, 1)[0]!;
  let name = '';
  for (let i = 1; i < member.length && member[i] !== '"'; i++) name += member[i] === '\\' ? member[++i] ?? '' : member[i];
  return name;
}

function withHeaders(result: HandlerResult, added: HeaderPair[]): HandlerResult {
  const names = new Set(added.map(([n]) => n));
  const kept = new Map<string, string[]>();
  for (const [n, value] of result.headers) {
    const lower = String(n).toLowerCase();
    if (names.has(lower)) kept.set(lower, [...kept.get(lower) || [], ...members(value).filter(member => memberName(member) !== policyName)]);
  }
  return { ...result, headers: [...result.headers.filter(([n]) => !names.has(String(n).toLowerCase())),
    ...added.map(([n, value]): HeaderPair => [n, [...kept.get(n) || [], value].join(', ')])] };
}

export async function onRequest(state: ThrottleState, req: PolicyRequest): Promise<HandlerResult | undefined> {
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

export function onResponse(state: ThrottleState, req: PolicyRequest, result: HandlerResult): HandlerResult {
  const budget = state.pending.get(req);
  return budget ? withHeaders(result, headersFor(state, budget)) : result;
}

export function describe(state: ThrottleState): ThrottleDescription {
  const summary: ThrottleDescription = { quota: state.quota, window: state.window, partition: state.partition, mode: state.mode, status: state.status };
  if (state.partition !== 'route') summary.unresolvedClient = 'shared key';
  return summary;
}

export async function close(shared: PolicyShared): Promise<void> {
  shared.throttle?.keys.clear();
  delete shared.throttle;
}
