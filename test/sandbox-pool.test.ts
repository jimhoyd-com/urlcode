import test from 'node:test';
import assert from 'node:assert/strict';
import { FunctionPool } from '../src/functions.ts';
import type { FunctionContext, FunctionResult } from '../src/functions.ts';
import type { FunctionSources, FunctionRoute } from '../src/function-sources.ts';
import type { HttpError } from '../src/errors.ts';
import type { GuestRequestPayload } from '../src/guest-api.ts';
import type { HandlerResult } from '../src/http-response.ts';
import type { TestContext } from 'node:test';

// Direct tests for the sandbox pool, below the HTTP server: the snapshot is
// built in memory, so the smallest guest module is one string.
const ROOT = '/project';
function snapshot(modules: Record<string, string>, entries: [string, string][] = Object.keys(modules).map(name => [name,'default'])): FunctionSources {
  const names = new Map<string, string>();
  for (const name of Object.keys(modules)) names.set(ROOT + name, name);
  const dependencies: Record<string, string[]> = {};
  for (const name of Object.keys(modules)) dependencies[name] = [];
  return { sources: modules, dependencies, entries, names };
}
const route = (source: string, middleware: string[] = []): FunctionRoute => ({ function: { source: ROOT + source, export: 'default' }, middleware: middleware.map(m => ({ source: ROOT + m, export: 'default' })) });
const payload = (extra: Partial<GuestRequestPayload> = {}): GuestRequestPayload => ({ url: 'http://localhost/', method: 'GET', headers: [], ...extra });
const context = (extra: Partial<FunctionContext> = {}): FunctionContext => ({ inputs: { path: {}, query: {}, header: {} } as FunctionContext['inputs'], env: {}, secrets: {}, ...extra });
async function pool(t: TestContext, modules: Record<string, string>, options: { workers?: number; timeoutMs?: number; log?: (event: Record<string, unknown>) => void } = {}): Promise<FunctionPool> {
  const instance = await new FunctionPool(Object.keys(modules).map(name => route(name)), { snapshot: snapshot(modules), workers: options.workers ?? 1, timeoutMs: options.timeoutMs ?? 5000, log: options.log }).start();
  t.after(() => instance.close());
  return instance;
}
const status = (error: unknown): number => (error as HttpError).status;
const body = (result: FunctionResult): string => typeof result.body === 'string' ? result.body : Buffer.from(result.body ?? []).toString();
const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('Condition not met in time'); await new Promise(resolve => setTimeout(resolve, 20)); }
};

test('a busy pool sheds load with 503 and reuses the slot once the invocation completes', async t => {
  const modules = { '/slow.mjs': `export default () => new Promise(resolve => setTimeout(() => resolve(new Response('slow')), 150));` };
  const p = await pool(t, modules, { workers: 1 });
  const first = p.execute(route('/slow.mjs'), payload(), context(), undefined);
  await assert.rejects(p.execute(route('/slow.mjs'), payload(), context(), undefined), error => status(error) === 503);
  assert.equal(body(await first), 'slow');
  assert.equal(p.healthy, true);
  assert.equal(body(await p.execute(route('/slow.mjs'), payload(), context(), undefined)), 'slow');
  assert.equal(p.restarts.size, 0);
});

test('workers serve in parallel and each slot recycles its own heap', async t => {
  const modules = { '/count.mjs': `export default () => { globalThis.n = (globalThis.n || 0) + 1; return new Response(String(globalThis.n)); }` };
  const p = await pool(t, modules, { workers: 2 });
  const results = await Promise.all([1,2].map(() => p.execute(route('/count.mjs'), payload(), context(), undefined)));
  assert.deepEqual(results.map(body), ['1','1']);
  assert.equal(body(await p.execute(route('/count.mjs'), payload(), context(), undefined)), '1');
});

test('respawn backoff starts at 250 ms, doubles to a 30 s ceiling and stays there', t => {
  const events: Record<string, unknown>[] = [];
  const p = new FunctionPool([route('/f.mjs')], { snapshot: snapshot({ '/f.mjs': 'export default () => new Response("")' }), log: e => { events.push(e); } });
  t.after(() => p.close());
  // Never started: no slot exists, so the scheduled spawn is discarded before it can run.
  for (let attempt = 1; attempt <= 10; attempt++) { p.scheduleRespawn(0); for (const timer of p.restartTimers) clearTimeout(timer); p.restartTimers.clear(); }
  assert.deepEqual(events.map(e => e['delayMs']), [250,500,1000,2000,4000,8000,16000,30000,30000,30000]);
  assert.deepEqual(events.map(e => e['attempt']), [1,2,3,4,5,6,7,8,9,10]);
  assert.ok(events.every(e => e['event'] === 'function_worker' && e['status'] === 'restarting' && e['slot'] === 0));
});

test('the deadline kills the worker with 504, the slot is replaced after backoff and a completed invocation clears it', async t => {
  const modules = { '/spin.mjs': `export default (request) => { if (request.url.endsWith('/ok')) return new Response('ok'); const end = Date.now() + 60000; while (Date.now() < end) {} return new Response('never'); }` };
  const events: Record<string, unknown>[] = [];
  const p = await pool(t, modules, { workers: 1, timeoutMs: 100, log: e => { events.push(e); } });
  const started = Date.now();
  await assert.rejects(p.execute(route('/spin.mjs'), payload(), context(), undefined), error => status(error) === 504);
  assert.ok(Date.now() - started < 1000);
  assert.equal(p.healthy, false);
  await assert.rejects(p.execute(route('/spin.mjs'), payload({ url: 'http://localhost/ok' }), context(), undefined), error => status(error) === 503);
  await until(() => events.some(e => e['status'] === 'restarting'));
  assert.equal(events.find(e => e['status'] === 'restarting')?.['delayMs'], 250);
  assert.equal(p.restarts.get(0), 1);
  await until(() => p.healthy);
  assert.equal(body(await p.execute(route('/spin.mjs'), payload({ url: 'http://localhost/ok' }), context(), undefined)), 'ok');
  assert.equal(p.restarts.has(0), false);
  // A later exit restarts the schedule from 250 ms rather than continuing to double.
  await assert.rejects(p.execute(route('/spin.mjs'), payload(), context(), undefined), error => status(error) === 504);
  await until(() => events.filter(e => e['status'] === 'restarting').length === 2);
  assert.equal(events.filter(e => e['status'] === 'restarting')[1]?.['delayMs'], 250);
});

test('an abrupt worker exit fails the in-flight invocation with 502 and schedules a replacement', async t => {
  const modules = { '/wait.mjs': `export default () => new Promise(resolve => setTimeout(() => resolve(new Response('late')), 2000));` };
  const events: Record<string, unknown>[] = [];
  const p = await pool(t, modules, { workers: 1, log: e => { events.push(e); } });
  const inflight = p.execute(route('/wait.mjs'), payload(), context(), undefined);
  await p.slots[0]?.worker.terminate();
  await assert.rejects(inflight, error => status(error) === 502);
  await until(() => events.some(e => e['status'] === 'restarting'));
  await until(() => p.healthy);
  assert.equal(events.filter(e => e['status'] === 'started').length, 2);
});

test('startup failures reject and close the pool; close settles in-flight work and refuses new invocations', async t => {
  const broken = new FunctionPool([route('/f.mjs')], { snapshot: snapshot({ '/f.mjs': 'export const other = 1;' }) });
  await assert.rejects(broken.start(), /Function initialization failed/);
  assert.equal(broken.closed, true);
  await assert.rejects(broken.execute(route('/f.mjs'), payload(), context(), undefined), error => status(error) === 503);
  const p = await pool(t, { '/f.mjs': 'export default () => new Response("x")' });
  const pending = p.execute(route('/f.mjs'), payload(), context(), undefined).then(() => 'done', (error: unknown) => status(error));
  await p.close();
  const settled = await pending;
  assert.ok(settled === 'done' || settled === 503);
  await assert.rejects(p.execute(route('/f.mjs'), payload(), context(), undefined), error => status(error) === 503);
});

test('guest Request exposes url, method, headers and a single-use text/json body', async t => {
  const modules = { '/req.mjs': `export default async (request) => {
    const first = await request.json();
    let again = 'readable'; try { await request.text(); } catch (e) { again = e.constructor.name; }
    return Response.json({ url: request.url, method: request.method, ct: request.headers.get('content-type'), missing: request.headers.get('x-none'), has: request.headers.has('X-Multi'), multi: request.headers.get('x-multi'), first, again, bodyUsed: request.bodyUsed });
  }` };
  const p = await pool(t, modules);
  const result = await p.execute(route('/req.mjs'), payload({ method: 'POST', headers: [['content-type','application/json'],['x-multi','a'],['x-multi','b']], body: Buffer.from('{"n":1}') }), context(), undefined);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(body(result)), { url: 'http://localhost/', method: 'POST', ct: 'application/json', missing: null, has: true, multi: 'a, b', first: { n: 1 }, again: 'TypeError', bodyUsed: true });
});

test('guest Response covers text, json, redirect, headers, status validation and HEAD', async t => {
  const modules = {
    '/text.mjs': `export default () => new Response('hi', { status: 201, headers: { 'X-Custom': ' v ' } });`,
    '/json.mjs': `export default () => Response.json({ a: 1 }, { headers: [['set-cookie','a=1'],['set-cookie','b=2']] });`,
    '/redirect.mjs': `export default () => Response.redirect('https://example.com/x', 308);`,
    '/checks.mjs': `export default () => {
      const outcomes = [];
      for (const fn of [() => new Response('x', { status: 199 }), () => new Response('x', { status: 204 }), () => new Response(null, { status: 204 }), () => Response.redirect('/', 200), () => new Response({}), () => new Response('x', { headers: { 'bad key': 'v' } }), () => new Response('x', { headers: { ok: 'a\\r\\nb' } })]) {
        try { fn(); outcomes.push('allowed'); } catch (e) { outcomes.push(e.constructor.name); }
      }
      const h = new Headers({ A: '1' }); h.append('a', '2'); h.set('b', '3'); h.delete('A');
      return Response.json({ outcomes, headers: [...h], noBody: new Response(null, { status: 204 }).headers.has('content-type') });
    }`,
  };
  const p = await pool(t, modules);
  const text = await p.execute(route('/text.mjs'), payload(), context(), undefined);
  assert.equal(text.status, 201); assert.equal(body(text), 'hi');
  assert.deepEqual(text.headers, [['x-custom','v'],['content-type','text/plain;charset=UTF-8']]);
  const json = await p.execute(route('/json.mjs'), payload(), context(), undefined);
  assert.deepEqual(json.headers, [['set-cookie','a=1'],['set-cookie','b=2'],['content-type','application/json']]);
  assert.equal(body(json), '{"a":1}');
  const redirect = await p.execute(route('/redirect.mjs'), payload(), context(), undefined);
  assert.equal(redirect.status, 308); assert.deepEqual(redirect.headers, [['location','https://example.com/x']]); assert.equal(body(redirect), '');
  const checks = JSON.parse(body(await p.execute(route('/checks.mjs'), payload(), context(), undefined))) as Record<string, unknown>;
  assert.deepEqual(checks['outcomes'], ['TypeError','TypeError','allowed','TypeError','TypeError','TypeError','TypeError']);
  assert.deepEqual(checks['headers'], [['b','3']]);
  assert.equal(checks['noBody'], false);
  const head = await p.execute(route('/text.mjs'), payload({ method: 'HEAD' }), context(), undefined);
  assert.equal(head.status, 201); assert.equal(body(head), '');
});

test('guest context carries args, env and secrets exactly as posted and nothing else', async t => {
  const modules = { '/ctx.mjs': `export default (_request, context) => Response.json({ keys: Object.keys(context).sort(), args: context.args, env: context.env, secrets: context.secrets, state: context.state === undefined, inputs: context.inputs });` };
  const p = await pool(t, modules);
  const posted = context({ args: { id: 7, name: 'x', flag: true }, env: { REGION: 'eu' }, secrets: { KEY: 's' }, inputs: { path: { id: '7' }, query: {}, header: {} } as FunctionContext['inputs'] });
  const result = JSON.parse(body(await p.execute(route('/ctx.mjs'), payload(), posted, undefined))) as Record<string, unknown>;
  assert.deepEqual(result, { keys: ['args','env','inputs','secrets'], args: { id: 7, name: 'x', flag: true }, env: { REGION: 'eu' }, secrets: { KEY: 's' }, state: true, inputs: { path: { id: '7' }, query: {}, header: {} } });
});

test('middleware shares context.state, calls next once and can return or replace a native response', async t => {
  const modules = {
    '/mw.mjs': `export default async (request, context, next) => { context.state.seen = (context.state.seen || 0) + 1; const response = await next(); response.headers.set('x-seen', String(context.state.seen)); return response; }`,
    '/twice.mjs': `export default async (request, context, next) => { await next(); return await next(); }`,
    '/handler.mjs': `export default (request, context) => new Response('h' + context.state.seen);`,
    '/native.mjs': `export default async (request, context, next) => { const response = await next(); let opaque = 'readable'; try { await response.text(); } catch (e) { opaque = e.constructor.name; } if (request.url.endsWith('/replace')) return new Response('replaced:' + opaque, { status: response.status }); return response; }`,
  };
  const routes: FunctionRoute[] = [route('/handler.mjs', ['/mw.mjs','/mw.mjs']), route('/handler.mjs', ['/twice.mjs']), { middleware: [{ source: ROOT + '/native.mjs', export: 'default' }] }];
  const p = new FunctionPool(routes, { snapshot: snapshot(modules), workers: 1 });
  t.after(() => p.close());
  await p.start();
  const chained = await p.execute(routes[0]!, payload(), context(), undefined);
  assert.equal(body(chained), 'h2');
  assert.deepEqual(chained.headers.filter(([k]) => k === 'x-seen'), [['x-seen','2']]);
  await assert.rejects(p.execute(routes[1]!, payload(), context(), undefined), error => status(error) === 502);
  const native: HandlerResult = { status: 200, headers: [['etag','"1"'],['content-type','text/plain']], body: Buffer.from('native bytes') };
  const passthrough = await p.execute(routes[2]!, payload(), context(), native);
  assert.equal(passthrough.nativeBody, true); assert.equal(body(passthrough), 'native bytes');
  assert.deepEqual(passthrough.headers, native.headers);
  const replaced = await p.execute(routes[2]!, payload({ url: 'http://localhost/replace' }), context(), native);
  assert.equal(replaced.nativeBody, false); assert.equal(body(replaced), 'replaced:TypeError');
});

test('the worker refuses malformed guest output: non-Response returns, oversized bodies and too many headers', async t => {
  const modules = {
    '/plain.mjs': `export default () => ({ status: 200 });`,
    '/big.mjs': `export default () => new Response('x'.repeat(2048));`,
    '/headers.mjs': `export default () => { const h = new Headers(); for (let i = 0; i < 300; i++) h.append('h' + i, 'v'); return new Response('x', { headers: h }); }`,
    '/throws.mjs': `export default () => { throw new Error('boom'); }`,
  };
  const routes = Object.keys(modules).map(name => route(name));
  const p = new FunctionPool(routes, { snapshot: snapshot(modules), workers: 1, maxBytes: 1024 });
  t.after(() => p.close());
  await p.start();
  for (const r of routes) await assert.rejects(p.execute(r, payload(), context(), undefined), error => status(error) === 502);
  // Guest errors answer through the protocol, so the slot stays healthy and is not restarted.
  assert.equal(p.healthy, true); assert.equal(p.restarts.size, 0);
});

test('guest timers fire through the pump and are bounded', async t => {
  const modules = { '/timers.mjs': `export default async () => { const order = []; await new Promise(r => { setTimeout(() => { order.push('b'); r(); }, 20); setTimeout(() => order.push('a'), 0); const id = setTimeout(() => order.push('never'), 5); clearTimeout(id); }); let limit = 'none'; try { for (let i = 0; i < 200; i++) setTimeout(() => {}, 1000); } catch (e) { limit = e.message; } return Response.json({ order, limit }); }` };
  const p = await pool(t, modules);
  assert.deepEqual(JSON.parse(body(await p.execute(route('/timers.mjs'), payload(), context(), undefined))), { order: ['a','b'], limit: 'Timer limit' });
});
