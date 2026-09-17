import { createHash } from 'node:crypto';
import { assert, ConfigError } from '../errors.ts';

// Named HTTP caching strategies (RFC 9111) chosen from a fixed catalogue so a
// browser, a CDN and this runtime's own origin cache read the same headers
// the same way. Each strategy names a pattern known outside this project:
// RFC 5861 stale-while-revalidate / stale-if-error, RFC 8246 immutable,
// RFC 9213 CDN-Cache-Control, the NGINX micro-cache. Explicit fields override
// what the strategy implies; the strategy never overrides explicit YAML
// response headers. The origin cache is one per runtime, bounded by entries
// and bytes, and dropped with the runtime, so a reload starts empty.
export const name = 'cache';
export const phases = ['request','response'];

const strategies = ['no-store','revalidate','public','immutable','swr','sie','micro','cdn-only','private'];
const DEFAULT_STATUSES = [200,301,302,404,410];
const DEFAULT_MAX_BYTES = 1048576;      // per entry
const DEFAULT_MAX_ENTRIES = 10000;
const STORE_BYTES = 64 * 1024 * 1024;   // per runtime, all routes together
const MAX_WAITERS = 64;                 // coalesced requests per in-flight key
const YEAR = 31536000;
const MICRO_MAX = 5;
const hashedSegment = /[0-9a-f]{8,}/i;
const hashedParameter = /^\{[^}]*(?:hash|digest|sha|fingerprint|rev|version|build)[^}]*\}$/i;

// Per-instance memory: honest on node, per-instance on serverless (documented),
// impossible in a Worker that has no policy runtime at all.
export function targets() { return { node:'native', vercel:'native', aws:'native', cloudflare:'refused' }; }

function lower(list) { return list.map(v => String(v).trim().toLowerCase()).filter(Boolean); }
function header(headers, key) {
  const found = headers.find(([k]) => String(k).toLowerCase() === key);
  return found ? found[1] : undefined;
}
function without(headers, ...keys) { return headers.filter(([k]) => !keys.includes(String(k).toLowerCase())); }
function directive(value, token) { return new RegExp(`(?:^|,)\\s*${token}\\s*(?:=|,|$)`, 'i').test(value || ''); }

export async function compile(config, { route, shared }) {
  assert(config && typeof config === 'object', `policies.${name} on ${route.pattern} must be an object`);
  const { strategy, maxAge, staleWhileRevalidate, staleIfError, cdnMaxAge, force = false } = config;
  const where = `on ${route.pattern}`;
  assert(strategies.includes(strategy), `policies.${name}.strategy ${where} must be one of ${strategies.join(', ')}`);
  const seconds = (value, key, required) => {
    if (value === undefined) { if (required) throw new ConfigError(`policies.${name}.${key} ${where} is required by strategy ${strategy}`); return undefined; }
    assert(Number.isInteger(value) && value >= 0, `policies.${name}.${key} ${where} must be a non-negative integer of seconds`);
    return value;
  };
  const vary = lower(config.vary ?? []);
  assert(vary.length <= 8 && new Set(vary).size === vary.length && vary.every(v => /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(v)), `policies.${name}.vary ${where} must list at most 8 distinct header names`);
  const statuses = config.statuses ?? DEFAULT_STATUSES;
  assert(Array.isArray(statuses) && statuses.every(s => Number.isInteger(s) && s >= 200 && s <= 599), `policies.${name}.statuses ${where} must list HTTP statuses`);
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES, maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
  assert(Number.isInteger(maxBytes) && maxBytes >= 0, `policies.${name}.maxBytes ${where} must be a non-negative integer`);
  assert(Number.isInteger(maxEntries) && maxEntries >= 1, `policies.${name}.maxEntries ${where} must be a positive integer`);

  // What the strategy implies, then what the fields override.
  let cacheControl, cdnCacheControl, fresh = 0, stale = 0, origin = false;
  const age = seconds(maxAge, 'maxAge', ['public','private','swr','sie'].includes(strategy));
  const swr = seconds(staleWhileRevalidate, 'staleWhileRevalidate', strategy === 'swr');
  const sie = seconds(staleIfError, 'staleIfError', strategy === 'sie');
  const cdn = seconds(cdnMaxAge, 'cdnMaxAge', strategy === 'cdn-only');
  let originTtl = seconds(config.originTtl, 'originTtl', false);
  switch (strategy) {
    case 'no-store': cacheControl = 'no-store'; break;
    case 'revalidate': cacheControl = 'no-cache'; break;
    case 'public': cacheControl = `public, max-age=${age}`; origin = originTtl > 0; fresh = originTtl ?? 0; break;
    case 'private': cacheControl = `private, max-age=${age}`; break;
    case 'immutable': {
      const hashed = route.pattern.split('/').some(part => hashedSegment.test(part) || hashedParameter.test(part));
      if (!hashed && !force) throw new ConfigError(`${route.pattern} declares policies.${name} strategy immutable on a path without a content hash; add a hashed segment or force: true`);
      cacheControl = `public, max-age=${age ?? YEAR}, immutable`; break;
    }
    case 'swr': cacheControl = `public, max-age=${age}, stale-while-revalidate=${swr}`; origin = true; fresh = originTtl ?? age; stale = swr; break;
    case 'sie':
      cacheControl = `public, max-age=${age}${swr !== undefined ? `, stale-while-revalidate=${swr}` : ''}, stale-if-error=${sie}`;
      origin = true; fresh = originTtl ?? age; stale = swr ?? 0; break;
    case 'micro':
      originTtl ??= 1;
      if (originTtl > MICRO_MAX && !force) throw new ConfigError(`policies.${name}.originTtl ${where} exceeds ${MICRO_MAX} seconds for strategy micro; use public or set force: true`);
      cacheControl = 'no-store'; origin = originTtl > 0; fresh = originTtl; break;
    case 'cdn-only': cacheControl = 'no-store'; cdnCacheControl = `max-age=${cdn}`; break;
  }
  // A route bound to secrets never enters the origin cache, whatever it says.
  const secrets = Object.keys(route.secrets || {}).length > 0;
  if (secrets || !(route.methods || ['GET','HEAD']).includes('GET')) origin = false;
  const store = shared.cache ||= { entries: new Map(), pending: new Map(), bytes: 0, maxBytes: STORE_BYTES, now: shared.now || Date.now };
  return {
    strategy, cacheControl, cdnCacheControl, vary, statuses: new Set(statuses), maxBytes, maxEntries,
    origin, freshMs: fresh * 1000, staleMs: stale * 1000, originTtl: origin ? fresh : null, staleIfError: sie ?? null,
    route: route.pattern, secrets, log: shared.log, store,
    // Who owns Cache-Control on this route: explicit YAML headers always,
    // an asset handler's cacheControl unless the route itself names a policy.
    yamlCacheControl: (route.responseHeaders || []).some(([k]) => k === 'cache-control'),
    inheritedAsset: Boolean(route.asset) && !route.policies?.cache,
    inflight: new WeakMap(),
  };
}

// Key: route pattern, path, query and the values of the declared Vary
// headers. HEAD shares the GET entry (only GET results are stored), so the
// method is not part of the key.
function keyFor(state, req) {
  const varied = state.vary.map(h => req.headers.get(h) ?? '').join('\u0001');
  return `${state.route}\u0000${req.path}\u0000${req.query?.toString?.() ?? ''}\u0000${varied}`;
}
function log(state, outcome) {
  try { state.log?.({ event: 'cache', route: state.route, outcome }); } catch { /* logging never changes the outcome */ }
}
function touch(store, key, entry) {
  store.entries.delete(key); store.entries.set(key, entry);
}
function served(entry, ageMs) {
  const headers = [...without(entry.headers, 'age'), ['age', String(Math.max(0, Math.floor(ageMs / 1000)))]];
  // The body stays attached on HEAD, as the asset handler does: the response
  // writer drops it, and a later policy can still pick the encoded variant.
  return { ...entry.result, headers, contentLength: entry.body.length, body: entry.body };
}

const conditional = ['if-none-match','if-modified-since','if-match','if-unmodified-since','range'];
export async function onRequest(state, req) {
  if (!state.origin || req.secrets || (req.method !== 'GET' && req.method !== 'HEAD')) return undefined;
  // A stored entry is a full 200 representation; the handler owns validators
  // and ranges, so a conditional or partial request always reaches it.
  if (conditional.some(name => req.headers.has(name))) return undefined;
  const { store } = state, now = store.now(), key = keyFor(state, req);
  const entry = store.entries.get(key);
  if (entry) {
    const age = now - entry.storedAt;
    if (age < state.freshMs) { touch(store, key, entry); log(state, 'hit'); return served(entry, age); }
    // Stale within the window: answer now and let the next request refresh.
    // A policy has no handle to the handler, so this is the origin-side
    // approximation of background revalidation; the flag makes it one-shot.
    if (age < state.freshMs + state.staleMs && !entry.revalidating) { entry.revalidating = true; log(state, 'stale'); return served(entry, age); }
  }
  // Miss: the first request for a key reaches the handler; concurrent ones
  // wait for its result up to a bounded count, beyond which they proceed.
  const pending = store.pending.get(key);
  if (pending && pending.waiters < MAX_WAITERS) {
    pending.waiters++;
    let stored;
    try { stored = await pending.promise; } catch { stored = null; }
    if (stored) { log(state, 'hit'); return served(stored, store.now() - stored.storedAt, req.method); }
    return undefined;
  }
  if (!pending && req.method === 'GET') {
    const flight = { waiters: 0 };
    flight.promise = new Promise((resolve, reject) => { flight.resolve = resolve; flight.reject = reject; });
    flight.promise.catch(() => {});
    store.pending.set(key, flight);
    state.inflight.set(req, { key, flight });
  }
  log(state, 'miss');
  return undefined;
}

function mergeVary(headers, names) {
  if (!names.length) return headers;
  const index = headers.findIndex(([k]) => String(k).toLowerCase() === 'vary');
  const present = index < 0 ? [] : headers[index][1].split(',').map(v => v.trim()).filter(Boolean);
  if (present.includes('*')) return headers;
  const seen = new Set(present.map(v => v.toLowerCase()));
  const merged = [...present, ...names.filter(n => !seen.has(n))];
  if (index < 0) return [...headers, ['vary', merged.join(', ')]];
  const out = [...headers]; out[index] = [headers[index][0], merged.join(', ')]; return out;
}
function noneMatch(value, etag) {
  const strip = tag => tag.trim().replace(/^W\//, '');
  return value.split(',').some(tag => tag.trim() === '*' || strip(tag) === strip(etag));
}
function bodyOf(result) { return result.body ? (Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body)) : Buffer.alloc(0); }

// Conditional requests for results the handler did not validate itself:
// assets answer 304 before this phase, so only 200 results are examined.
function revalidate(state, req, result) {
  if (result.status !== 200 || (req.method !== 'GET' && req.method !== 'HEAD')) return result;
  let headers = result.headers, etag = header(headers, 'etag');
  if (!etag) {
    // A strong validator over the representation. A HEAD answer without a
    // body (a function's) has nothing to hash and gets no validator, rather
    // than one that would disagree with GET.
    const body = bodyOf(result);
    if (req.method === 'HEAD' && !body.length) return result;
    etag = '"' + createHash('sha256').update(body).digest('hex') + '"'; headers = [...headers, ['etag', etag]];
  }
  const none = req.headers.get('if-none-match'), modified = header(headers, 'last-modified');
  const since = req.headers.get('if-modified-since');
  const matched = none ? noneMatch(none, etag) : Boolean(modified && since && Date.parse(modified) <= Date.parse(since));
  if (!matched) return { ...result, headers };
  // Content-Type stays so a later policy can still see what varied (RFC 9110 §15.4.5).
  const kept = new Set(['etag','cache-control','cdn-cache-control','vary','last-modified','content-location','expires','date','content-type']);
  return { ...result, status: 304, headers: headers.filter(([k]) => kept.has(String(k).toLowerCase())), body: Buffer.alloc(0), contentLength: undefined };
}

function evict(store, maxEntries) {
  while (store.entries.size > maxEntries || store.bytes > store.maxBytes) {
    const [key, oldest] = store.entries.entries().next().value;
    store.entries.delete(key); store.bytes -= oldest.body.length;
  }
}

export function onResponse(state, req, result) {
  const flight = state.inflight.get(req);
  if (flight) state.inflight.delete(req);
  const handlerControl = header(result.headers, 'cache-control');
  // Explicit beats strategy: YAML headers, an inherited policy over an asset
  // handler's own cacheControl, and a handler that asked for private or
  // no-store (a personalized answer under a public route stays private).
  const restrictive = directive(handlerControl, 'no-store') || directive(handlerControl, 'private');
  const owned = !state.yamlCacheControl && !state.inheritedAsset && !restrictive;
  let headers = result.headers;
  if (owned) {
    headers = [...without(headers, 'cache-control', 'cdn-cache-control'), ['cache-control', state.cacheControl]];
    if (state.cdnCacheControl) headers.push(['cdn-cache-control', state.cdnCacheControl]);
  }
  // Only responses the cache could hold vary on the declared headers; a
  // refusal produced ahead of the handler keeps its own headers.
  if (flight || state.statuses.has(result.status)) headers = mergeVary(headers, state.vary);
  let out = { ...result, headers };
  if (state.strategy === 'revalidate') out = revalidate(state, req, out);
  if (!flight) return out;
  // Store decision for the request that reached the handler; waiters are
  // released either way, with the entry or with nothing.
  const { store } = state, body = bodyOf(out);
  const storable = !req.secrets && state.statuses.has(out.status) && !restrictive && body.length <= state.maxBytes
    && !out.headers.some(([k]) => String(k).toLowerCase() === 'set-cookie');
  let entry = null;
  if (storable) {
    const previous = store.entries.get(flight.key);
    if (previous) { store.entries.delete(flight.key); store.bytes -= previous.body.length; }
    const { body: _body, headers: _headers, ...rest } = out;
    entry = { result: rest, headers: without(out.headers, 'age'), body, storedAt: store.now(), revalidating: false };
    store.entries.set(flight.key, entry); store.bytes += body.length;
    evict(store, state.maxEntries);
    log(state, 'store');
  }
  store.pending.delete(flight.key);
  flight.flight.resolve(entry);
  return out;
}

export function onError(state, req) {
  const flight = state.inflight.get(req);
  if (!flight) return;
  state.inflight.delete(req);
  state.store.pending.delete(flight.key);
  flight.flight.reject(new Error('cache fill failed'));
  // A stale entry that failed to refresh may be served once more.
  const entry = state.store.entries.get(flight.key);
  if (entry) entry.revalidating = false;
}

export function describe(state) {
  const summary = { strategy: state.strategy, cacheControl: state.cacheControl, origin: state.origin, originTtl: state.originTtl, vary: state.vary };
  if (state.cdnCacheControl) summary.cdnCacheControl = state.cdnCacheControl;
  if (state.staleMs) summary.staleWhileRevalidate = state.staleMs / 1000;
  if (state.staleIfError !== null) summary.staleIfError = state.staleIfError;
  if (state.yamlCacheControl) summary.cacheControl = 'explicit response header';
  else if (state.inheritedAsset) summary.cacheControl = 'asset handler';
  if (state.secrets) summary.origin = false;
  return summary;
}

export async function close(shared) {
  const store = shared?.cache;
  if (!store) return;
  for (const flight of store.pending.values()) flight.reject(new Error('runtime closed'));
  store.pending.clear(); store.entries.clear(); store.bytes = 0;
  delete shared.cache;
}
