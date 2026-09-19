import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.ts';
import { createRuntime } from '../src/runtime.ts';
import * as cache from '../src/policies/cache.ts';
import { project, redirect, request, approveBindings, param } from './helpers.ts';
import type { TestContext } from 'node:test';
import type { Server, ServerOptions } from '../src/server.ts';
import type { CacheConfig, CacheState } from '../src/policies/cache.ts';
import type { PolicyRequest, PolicyRoute, PolicyShared, RouteConfig } from '../src/types.ts';
import type { HandlerResult, HeaderPair } from '../src/http-response.ts';

type LogEvent = Record<string, unknown>;

async function serve(t: TestContext, root: string, options: Partial<ServerOptions> = {}): Promise<Server> {
  const app = await startServer({ project: root, port: 0, log: () => {}, workers: 2, ...options }); t.after(() => app.close()); return app;
}
const text = (body: string, extra: RouteConfig = {}): RouteConfig => ({ respond: { text: body }, ...extra });
const withCache = (route: RouteConfig, cache: CacheConfig): RouteConfig => ({ ...route, policies: { cache } });
// A body that changes per handler invocation, so equal bodies prove one invocation.
const stamped = `export default () => new Response(String(Math.random()) + ':' + Date.now());`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// A compiled state with a fake clock and a fake request, for tests that must not wait.
interface Clock {
  shared: PolicyShared; state: CacheState; tick(ms: number): void;
  req(headers?: Record<string, string>, method?: string, path?: string): PolicyRequest;
  result(body?: string, headers?: HeaderPair[]): HandlerResult;
}
async function compiled(config: CacheConfig, { route = { pattern: '/a' }, shared = {} }: { route?: PolicyRoute; shared?: PolicyShared } = {}): Promise<Clock> {
  let now = 0;
  const clockShared: PolicyShared = { now: () => now, ...shared };
  const state = await cache.compile(config, { route, shared: clockShared });
  return {
    shared: clockShared, state, tick(ms) { now += ms; },
    req: (headers = {}, method = 'GET', path = '/a') => ({ method, target: path, path, params: {}, query: new URLSearchParams(), headers: new Headers(headers),
      headerCounts: undefined, client: null, origin: undefined, route: route.pattern, secrets: false }),
    result: (body = 'x', headers = [['content-type','text/plain']]) => ({ status: 200, headers, body: Buffer.from(body) }),
  };
}

test('each strategy emits its catalogue headers; explicit fields override what the strategy implies', async t => {
  const routes = {
    '/no-store': withCache(text('a'), { strategy: 'no-store' }),
    '/revalidate': withCache(text('a'), { strategy: 'revalidate' }),
    '/public': withCache(text('a'), { strategy: 'public', maxAge: 60 }),
    '/private': withCache(text('a'), { strategy: 'private', maxAge: 30 }),
    '/immutable/{hash}': withCache(text('a', { parameters: [param('hash')] }), { strategy: 'immutable' }),
    '/short/{hash}': withCache(text('a', { parameters: [param('hash')] }), { strategy: 'immutable', maxAge: 600 }),
    '/swr': withCache(text('a'), { strategy: 'swr', maxAge: 10, staleWhileRevalidate: 60 }),
    '/sie': withCache(text('a'), { strategy: 'sie', maxAge: 10, staleWhileRevalidate: 20, staleIfError: 300 }),
    '/micro': withCache(text('a'), { strategy: 'micro' }),
    '/cdn': withCache(text('a'), { strategy: 'cdn-only', cdnMaxAge: 120 }),
  };
  const root = await project(t, routes);
  const app = await serve(t, root);
  const expect = async (path: string, control: string) => { const res = await request(app, path); assert.equal(res.status, 200); assert.equal(res.headers['cache-control'], control, path); return res; };
  await expect('/no-store', 'no-store');
  const revalidate = await expect('/revalidate', 'no-cache');
  assert.match(String(revalidate.headers.etag), /^"[0-9a-f]{64}"$/);
  await expect('/public', 'public, max-age=60');
  await expect('/private', 'private, max-age=30');
  await expect('/immutable/abc', 'public, max-age=31536000, immutable');
  await expect('/short/abc', 'public, max-age=600, immutable');
  await expect('/swr', 'public, max-age=10, stale-while-revalidate=60');
  await expect('/sie', 'public, max-age=10, stale-while-revalidate=20, stale-if-error=300');
  await expect('/micro', 'no-store');
  const cdn = await expect('/cdn', 'no-store');
  assert.equal(cdn.headers['cdn-cache-control'], 'max-age=120');
  const plan = (await createRuntime(root, { log: () => {} }));
  t.after(() => plan.close());
  const described = plan.testPlan().policies;
  assert.deepEqual(described['/swr']?.cache, { strategy: 'swr', cacheControl: 'public, max-age=10, stale-while-revalidate=60', origin: true, originTtl: 10, vary: [], staleWhileRevalidate: 60, target: 'native' });
  assert.equal(described['/micro']?.cache?.originTtl, 1);
  assert.equal(described['/public']?.cache?.origin, false);
  assert.equal(described['/cdn']?.cache?.cdnCacheControl, 'max-age=120');
});

test('required fields are named per route at compile time', async () => {
  const route = { pattern: '/r' };
  await assert.rejects(cache.compile({ strategy: 'public' }, { route, shared: {} }), /policies\.cache\.maxAge on \/r is required by strategy public/);
  await assert.rejects(cache.compile({ strategy: 'swr', maxAge: 1 }, { route, shared: {} }), /staleWhileRevalidate on \/r is required/);
  await assert.rejects(cache.compile({ strategy: 'sie', maxAge: 1 }, { route, shared: {} }), /staleIfError on \/r is required/);
  await assert.rejects(cache.compile({ strategy: 'cdn-only' }, { route, shared: {} }), /cdnMaxAge on \/r is required/);
  // An unknown strategy is what compile must refuse; the cast hands it the invalid YAML shape.
  const unknownStrategy: unknown = { strategy: 'nope' };
  await assert.rejects(cache.compile(unknownStrategy as CacheConfig, { route, shared: {} }), /strategy on \/r must be one of/);
  await assert.rejects(cache.compile({ strategy: 'micro', originTtl: 6 }, { route, shared: {} }), /originTtl on \/r exceeds 5 seconds/);
  assert.equal((await cache.compile({ strategy: 'micro', originTtl: 6, force: true }, { route, shared: {} })).originTtl, 6);
});

test('immutable is refused on unhashed paths and accepted with a hashed segment, a hash parameter or force', async t => {
  const bad = await project(t, { '/app.js': withCache(text('a'), { strategy: 'immutable' }) });
  await assert.rejects(createRuntime(bad, { log: () => {} }), /\/app\.js declares policies\.cache strategy immutable on a path without a content hash/);
  const ok = await project(t, {
    '/app.3f2a9c1d.js': withCache(text('a'), { strategy: 'immutable' }),
    '/build/{hash}/app.js': withCache(text('a', { parameters: [param('hash')] }), { strategy: 'immutable' }),
    '/forced.js': withCache(text('a'), { strategy: 'immutable', force: true }),
  });
  const runtime = await createRuntime(ok, { log: () => {} });
  t.after(() => runtime.close());
  for (const pattern of Object.keys(runtime.testPlan().policies)) assert.equal(runtime.testPlan().policies[pattern]?.cache?.cacheControl, 'public, max-age=31536000, immutable');
});

test('swr serves fresh from the origin cache, serves stale once and refreshes on the next request', async () => {
  const clock = await compiled({ strategy: 'swr', maxAge: 10, staleWhileRevalidate: 60 });
  const { state } = clock;
  const first = clock.req();
  assert.equal(await cache.onRequest(state, first), undefined);
  const stored = cache.onResponse(state, first, clock.result('one'));
  assert.equal(stored.headers.find(([k]) => k === 'cache-control')?.[1], 'public, max-age=10, stale-while-revalidate=60');
  clock.tick(5000);
  const hit = await cache.onRequest(state, clock.req());
  assert.equal(String(hit?.body), 'one');
  assert.deepEqual(hit?.headers.find(([k]) => k === 'age'), ['age', '5']);
  clock.tick(10000);
  // Past max-age but inside the stale window: stale now, handler next.
  const stale = await cache.onRequest(state, clock.req());
  assert.equal(String(stale?.body), 'one');
  assert.deepEqual(stale?.headers.find(([k]) => k === 'age'), ['age', '15']);
  const refresh = clock.req();
  assert.equal(await cache.onRequest(state, refresh), undefined);
  cache.onResponse(state, refresh, clock.result('two'));
  assert.equal(String((await cache.onRequest(state, clock.req()))?.body), 'two');
  // Beyond max-age plus stale-while-revalidate nothing is served from memory.
  clock.tick(80000);
  assert.equal(await cache.onRequest(state, clock.req()), undefined);
  await cache.close(clock.shared);
  assert.equal(clock.shared.cache, undefined);
});

test('micro caches at the origin for one second while telling clients no-store', async t => {
  const events: LogEvent[] = [];
  const root = await project(t, { '/f': withCache({ function: { source: 'f.mjs' } }, { strategy: 'micro', originTtl: 1 }) }, { 'f.mjs': stamped });
  const app = await serve(t, root, { log: e => { events.push(e); } });
  const first = await request(app, '/f');
  const second = await request(app, '/f');
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(second.body, first.body);
  assert.equal(second.headers.age, '0');
  assert.equal(first.headers.age, undefined);
  await sleep(1100);
  const third = await request(app, '/f');
  assert.notEqual(third.body, first.body);
  const outcomes = events.filter(e => e['event'] === 'cache').map(e => e['outcome']);
  assert.deepEqual(outcomes, ['miss','store','hit','miss','store']);
});

test('revalidate answers 304 to If-None-Match for respond and function routes', async t => {
  const root = await project(t, { '/r': withCache(text('hello'), { strategy: 'revalidate' }), '/f': withCache({ function: { source: 'f.mjs' } }, { strategy: 'revalidate' }) },
    { 'f.mjs': `export default () => new Response('fixed', { headers: { 'last-modified': 'Tue, 01 Jan 2030 00:00:00 GMT' } });` });
  const app = await serve(t, root);
  for (const path of ['/r','/f']) {
    const full = await request(app, path);
    const etag = full.headers.etag;
    assert.match(String(etag), /^"[0-9a-f]{64}"$/);
    const conditional = await request(app, path, { headers: { 'if-none-match': `W/${etag}` } });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.body, '');
    assert.equal(conditional.headers.etag, etag);
    assert.equal(conditional.headers['cache-control'], 'no-cache');
    // Content-Type stays on the 304 so a later policy still sees what varies.
    assert.equal(conditional.headers['content-type'], full.headers['content-type']);
    assert.equal((await request(app, path, { headers: { 'if-none-match': '"other"' } })).status, 200);
  }
  // A respond route carries its body on HEAD, so its hash validator holds;
  // a trusted function's HEAD answer is measured the same way GET's is (the
  // body is read to determine its real length even though HEAD never puts
  // it on the wire — see #139), so it hashes to the same ETag as GET's.
  assert.equal((await request(app, '/r', { method: 'HEAD', headers: { 'if-none-match': (await request(app, '/r')).headers.etag } })).status, 304);
  const getEtag = (await request(app, '/f')).headers.etag;
  const head = await request(app, '/f', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.etag, getEtag); assert.equal(head.headers['cache-control'], 'no-cache');
  assert.equal((await request(app, '/f', { method: 'HEAD', headers: { 'if-none-match': getEtag } })).status, 304);
  assert.equal((await request(app, '/f', { headers: { 'if-modified-since': 'Wed, 02 Jan 2030 00:00:00 GMT' } })).status, 304);
  assert.equal((await request(app, '/f', { headers: { 'if-modified-since': 'Mon, 01 Jan 2029 00:00:00 GMT' } })).status, 200);
  assert.equal((await request(app, '/r', { headers: { 'if-modified-since': 'Wed, 02 Jan 2030 00:00:00 GMT' } })).status, 200);
});

test('vary headers separate keys and are emitted; explicit YAML cache-control wins over the strategy', async t => {
  const root = await project(t, {
    '/f': withCache({ function: { source: 'f.mjs' } }, { strategy: 'micro', originTtl: 5, vary: ['Accept-Language'] }),
    '/y': withCache(text('y', { response: { headers: { 'cache-control': 'max-age=7', vary: 'Accept' } } }), { strategy: 'public', maxAge: 60, vary: ['accept'] }),
  }, { 'f.mjs': stamped });
  const app = await serve(t, root);
  const en = await request(app, '/f', { headers: { 'accept-language': 'en' } });
  const fr = await request(app, '/f', { headers: { 'accept-language': 'fr' } });
  const en2 = await request(app, '/f', { headers: { 'accept-language': 'en' } });
  assert.notEqual(en.body, fr.body);
  assert.equal(en2.body, en.body);
  assert.equal(en.headers.vary, 'accept-language');
  const yaml = await request(app, '/y');
  assert.equal(yaml.headers['cache-control'], 'max-age=7');
  assert.equal(yaml.headers.vary, 'Accept');
});

test('Set-Cookie, secret-bearing routes, handler no-store and oversized bodies are never stored', async t => {
  const root = await project(t, {
    '/cookie': withCache({ function: { source: 'cookie.mjs' } }, { strategy: 'micro', originTtl: 5 }),
    '/private': withCache({ function: { source: 'private.mjs' } }, { strategy: 'public', maxAge: 60, originTtl: 5 }),
    '/big': withCache({ function: { source: 'f.mjs' } }, { strategy: 'micro', originTtl: 5, maxBytes: 8 }),
    '/secret': withCache({ function: { source: 'f.mjs' }, secrets: { KEY: { secret: 'token' } } }, { strategy: 'micro', originTtl: 5 }),
  }, {
    'f.mjs': stamped,
    'cookie.mjs': `export default () => new Response(String(Math.random()), { headers: { 'set-cookie': 'a=1' } });`,
    'private.mjs': `export default () => new Response(String(Math.random()), { headers: { 'cache-control': 'private, max-age=5' } });`,
  });
  const permissions = await approveBindings(root);
  const app = await serve(t, root, { permissions, environment: { token: 'x' } });
  for (const path of ['/cookie','/private','/big','/secret']) {
    const a = await request(app, path), b = await request(app, path);
    assert.notEqual(a.body, b.body, path);
    assert.equal(b.headers.age, undefined, path);
  }
  // The handler's restriction is kept rather than widened to the strategy.
  assert.equal((await request(app, '/private')).headers['cache-control'], 'private, max-age=5');
  const runtime = await createRuntime(root, { permissions, environment: { token: 'x' }, log: () => {} });
  t.after(() => runtime.close());
  assert.equal(runtime.testPlan().policies['/secret']?.cache?.origin, false);
});

test('concurrent misses coalesce into one handler invocation; HEAD hits serve the GET entry without a body', async t => {
  const root = await project(t, { '/f': withCache({ function: { source: 'f.mjs' } }, { strategy: 'swr', maxAge: 30, staleWhileRevalidate: 30 }) },
    { 'f.mjs': `export default async () => { await new Promise(r => setTimeout(r, 150)); return new Response('body-' + Math.random(), { headers: { 'content-type': 'text/plain' } }); };` });
  const app = await serve(t, root);
  const results = await Promise.all(Array.from({ length: 10 }, () => request(app, '/f')));
  assert.equal(new Set(results.map(r => r.body)).size, 1);
  assert.equal(results.filter(r => r.headers.age === undefined).length, 1);
  const head = await request(app, '/f', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  const [leader] = results;
  assert.ok(leader, 'ten requests produced a result');
  assert.equal(head.headers['content-length'], String(Buffer.byteLength(leader.body)));
  assert.equal(head.headers['content-type'], 'text/plain');
  assert.equal(head.headers['cache-control'], 'public, max-age=30, stale-while-revalidate=30');
  assert.equal(head.headers.age, '0');
});

test('a failed fill releases waiters to the handler and never stores', async () => {
  const clock = await compiled({ strategy: 'micro', originTtl: 2 });
  const { state } = clock;
  const leader = clock.req();
  assert.equal(await cache.onRequest(state, leader), undefined);
  const waiter = cache.onRequest(state, clock.req());
  cache.onError(state, leader);
  assert.equal(await waiter, undefined);
  assert.equal(state.store.entries.size, 0);
  assert.equal(state.store.pending.size, 0);
});

test('the origin store is bounded by entries and bytes with LRU eviction', async () => {
  const clock = await compiled({ strategy: 'micro', originTtl: 5, maxEntries: 2 });
  const { state } = clock;
  for (const path of ['/1','/2','/3']) { const req = clock.req({}, 'GET', path); await cache.onRequest(state, req); cache.onResponse(state, req, clock.result(path)); }
  assert.equal(state.store.entries.size, 2);
  assert.equal(await cache.onRequest(state, clock.req({}, 'GET', '/1')), undefined);
  assert.equal(String((await cache.onRequest(state, clock.req({}, 'GET', '/3')))?.body), '/3');
  assert.equal(state.store.bytes, 4);
});

test('assets keep their handler cacheControl under an inherited policy and follow a route-level strategy', async t => {
  const root = await project(t, {
    '/inherited': { page: { file: 'index.html', cacheControl: 'public, max-age=3600' } },
    '/explicit': withCache({ page: { file: 'index.html', cacheControl: 'public, max-age=3600' } }, { strategy: 'revalidate' }),
  }, { 'index.html': '<h1>hi</h1>' }, { policies: { cache: { strategy: 'private', maxAge: 9 } } });
  const app = await serve(t, root);
  const inherited = await request(app, '/inherited');
  assert.equal(inherited.headers['cache-control'], 'public, max-age=3600');
  const explicit = await request(app, '/explicit');
  assert.equal(explicit.headers['cache-control'], 'no-cache');
  // The asset handler's own 304 and Range answers are untouched.
  assert.equal((await request(app, '/explicit', { headers: { 'if-none-match': explicit.headers.etag } })).status, 304);
  assert.equal((await request(app, '/explicit', { headers: { range: 'bytes=0-1' } })).status, 206);
});

test('the cloudflare target refuses the policy with the route named', async t => {
  const root = await project(t, { '/go': withCache(redirect(), { strategy: 'public', maxAge: 1 }) });
  await assert.rejects(createRuntime(root, { target: 'cloudflare', log: () => {} }), /\/go[\s\S]*capability: policies\.cache[\s\S]*unsupported by target: cloudflare/);
  assert.deepEqual(cache.targets(), { node: 'native', vercel: 'native', aws: 'native', cloudflare: 'refused' });
});
