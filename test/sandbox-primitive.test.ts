import test from 'node:test';
import assert from 'node:assert/strict';
import { SandboxPool } from '../packages/core/src/functions.ts';
import type { FunctionContext, FunctionResult, SandboxEntry, SandboxTarget } from '../packages/core/src/functions.ts';
import type { FunctionSources } from '../packages/core/src/function-sources.ts';
import type { HttpError } from '../packages/core/src/errors.ts';
import type { GuestRequestPayload } from '../packages/core/src/guest-api.ts';
import type { TestContext } from 'node:test';

// Direct tests for the public sandbox primitive (`@jimhoyd/urlcode/sandbox`,
// re-exported here as `SandboxPool` from packages/core/src/functions.ts): the route-shaped
// `FunctionPool` tests in sandbox-pool.test.ts prove route dispatch is
// unaffected by this refactor; these prove the generalized, route-independent
// entry point actually gives real isolation, not just "it returns a response".
const ROOT = '/project';
function snapshot(modules: Record<string, string>, entries: [string, string][] = Object.keys(modules).map(name => [name,'default'])): FunctionSources {
  const names = new Map<string, string>();
  for (const name of Object.keys(modules)) names.set(ROOT + name, name);
  const dependencies: Record<string, string[]> = {};
  for (const name of Object.keys(modules)) dependencies[name] = [];
  return { sources: modules, dependencies, entries, names };
}
const target = (source: string): SandboxTarget => ({ source: ROOT + source, export: 'default' });
const payload = (extra: Partial<GuestRequestPayload> = {}): GuestRequestPayload => ({ url: 'http://localhost/', method: 'GET', headers: [], ...extra });
const context = (extra: Partial<FunctionContext> = {}): FunctionContext => ({ inputs: { path: {}, query: {}, header: {} } as FunctionContext['inputs'], env: {}, secrets: {}, requestId: 'test-request', ...extra });
async function pool(t: TestContext, modules: Record<string, string>, options: { workers?: number; timeoutMs?: number; maxBytes?: number; entries?: SandboxEntry[]; log?: (event: Record<string, unknown>) => void } = {}): Promise<SandboxPool> {
  const entries = options.entries ?? Object.keys(modules).map(name => ({ source: ROOT + name, export: 'default' }));
  const instance = await new SandboxPool(entries, { snapshot: snapshot(modules), workers: options.workers ?? 1, timeoutMs: options.timeoutMs ?? 5000, maxBytes: options.maxBytes, log: options.log }).start();
  t.after(() => instance.close());
  return instance;
}
const status = (error: unknown): number => (error as HttpError).status;
const body = (result: FunctionResult): string => typeof result.body === 'string' ? result.body : Buffer.from(result.body ?? []).toString();
const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('Condition not met in time'); await new Promise(resolve => setTimeout(resolve, 20)); }
};

test('a public SandboxPool constructed from explicit entries runs a handler with no route shape involved', async t => {
  const modules = { '/hello.mjs': `export default () => new Response('hi');` };
  const p = await pool(t, modules);
  const result = await p.execute({ entry: target('/hello.mjs') }, payload(), context(), undefined);
  assert.equal(body(result), 'hi');
});

test('a module not declared as this entry\'s dependency is denied when the guest reaches for it by a relative import, even though it sits right next to it in the snapshot', async () => {
  // A hand-built snapshot (as this test file's `snapshot()` helper always
  // produces) can disagree with what the guest's own source actually
  // imports; function-worker.ts's `allow()` walk trusts only the
  // `dependencies` map, not what the guest's import statement asks for, so a
  // mismatch here still ends in denial — the module-allowlist enforcement is
  // the worker's own, independent of whatever collected it (defense in
  // depth against a snapshot that under-declares an edge).
  const modules = {
    '/entry.mjs': `import { secret } from './denied.mjs'; export default () => new Response(secret);`,
    '/denied.mjs': `export const secret = 'leaked';`,
  };
  const names = new Map<string, string>([[ROOT + '/entry.mjs','/entry.mjs'],[ROOT + '/denied.mjs','/denied.mjs']]);
  const snap: FunctionSources = { sources: modules, dependencies: { '/entry.mjs': [], '/denied.mjs': [] }, entries: [['/entry.mjs','default']], names };
  const p = new SandboxPool([{ source: ROOT + '/entry.mjs', export: 'default' }], { snapshot: snap, workers: 1 });
  // Denied firmly enough to fail every worker's own startup validation
  // (function-worker.ts evaluates every declared entry before reporting
  // ready), not just an individual request later.
  await assert.rejects(p.start(), /Function initialization failed/);
  assert.equal(p.closed, true);
});

test('a module never included when the snapshot was built cannot be targeted directly either', async t => {
  const allowedOnly = { '/allowed.mjs': `export default () => new Response('ok');` };
  const p = await pool(t, allowedOnly, { entries: [{ source: ROOT + '/allowed.mjs', export: 'default' }] });
  assert.equal(body(await p.execute({ entry: target('/allowed.mjs') }, payload(), context(), undefined)), 'ok');
  // /other.mjs was never part of this pool's snapshot at all (a different
  // pool's/route's module, say) — `snapshot.names` has no entry for it, so
  // the worker message carries `source: undefined` and the guest import
  // fails to resolve to anything real, rather than silently reaching a
  // module this pool never declared.
  await assert.rejects(p.execute({ entry: { source: ROOT + '/other.mjs', export: 'default' } }, payload(), context(), undefined), error => status(error) === 502);
});

test('the deadline terminates a hung guest invocation via the outer worker-termination fallback', async t => {
  const modules = { '/spin.mjs': `export default () => { const end = Date.now() + 60000; while (Date.now() < end) {} return new Response('never'); }` };
  const p = await pool(t, modules, { workers: 1, timeoutMs: 100 });
  const started = Date.now();
  await assert.rejects(p.execute({ entry: target('/spin.mjs') }, payload(), context(), undefined), error => status(error) === 504);
  // The outer worker-termination timeout is timeoutMs (100ms here); this
  // must fire well before the guest's own 60s busy-loop would ever return.
  assert.ok(Date.now() - started < 2000);
  await until(() => p.healthy);
});

test('the deadline also terminates a guest stuck in an async microtask loop, bounded well under the guest\'s own runtime', async t => {
  // An infinite `await Promise.resolve()` loop never returns control from a
  // single evalCode() call the way a synchronous busy-loop does; it is driven
  // by function-worker.ts's own promise-pump (`executePendingJobs` /
  // `__pump`), whose driving `while` loop checks the same wall-clock deadline
  // on every pump — the host-side half of deadline enforcement, independent
  // of the outer worker-termination timer this file's other deadline test
  // exercises. Either mechanism resolves the call (502 from the guest-side
  // check, 504 from the outer terminate); what must never happen is the pool
  // waiting on this call indefinitely.
  const modules = { '/loop.mjs': `export default async () => { for (;;) { await Promise.resolve(); } }` };
  const p = await pool(t, modules, { workers: 1, timeoutMs: 150 });
  const started = Date.now();
  await assert.rejects(p.execute({ entry: target('/loop.mjs') }, payload(), context(), undefined), error => [502,504].includes(status(error)));
  assert.ok(Date.now() - started < 2000);
  await until(() => p.healthy);
});

test('maxBytes rejects an oversized guest response instead of truncating or passing it through', async t => {
  const modules = { '/big.mjs': `export default () => new Response('x'.repeat(4096));` };
  const p = await pool(t, modules, { workers: 1, maxBytes: 1024 });
  await assert.rejects(p.execute({ entry: target('/big.mjs') }, payload(), context(), undefined), error => status(error) === 502);
});

test('a malformed guest response (bad status, non-string body, oversized headers) is rejected, never passed through', async t => {
  const modules = {
    '/status.mjs': `export default () => ({ status: 999, headers: [], body: 'x' });`,
    '/notresponse.mjs': `export default () => ({ hello: 'world' });`,
    '/headers.mjs': `export default () => { const h = new Headers(); for (let i = 0; i < 500; i++) h.append('x' + i, 'v'.repeat(50)); return new Response('x', { headers: h }); }`,
  };
  const p = await new SandboxPool(Object.keys(modules).map(name => ({ source: ROOT + name, export: 'default' })), { snapshot: snapshot(modules), workers: 1 }).start();
  t.after(() => p.close());
  for (const name of Object.keys(modules)) await assert.rejects(p.execute({ entry: target(name) }, payload(), context(), undefined), error => status(error) === 502);
  assert.equal(p.healthy, true);
});

test('no Node global is reachable from guest code executed through the public primitive', async t => {
  const modules = { '/probe.mjs': `export default () => Response.json({
    process: typeof globalThis.process, require: typeof globalThis.require, fs: typeof globalThis.fs,
    fetch: typeof globalThis.fetch, Buffer: typeof globalThis.Buffer, module: typeof globalThis.module,
    __dirname: typeof globalThis.__dirname, WorkerThreads: typeof globalThis.Worker,
  });` };
  const p = await pool(t, modules);
  const result = JSON.parse(body(await p.execute({ entry: target('/probe.mjs') }, payload(), context(), undefined))) as Record<string, string>;
  assert.deepEqual(result, { process: 'undefined', require: 'undefined', fs: 'undefined', fetch: 'undefined', Buffer: 'undefined', module: 'undefined', __dirname: 'undefined', WorkerThreads: 'undefined' });
});

test('the public primitive enforces the same next()-called-once chain discipline as route middleware', async t => {
  const modules = {
    '/mw.mjs': `export default async (request, context, next) => { const response = await next(); response.headers.set('x-seen','1'); return response; }`,
    '/twice.mjs': `export default async (request, context, next) => { await next(); return await next(); }`,
    '/handler.mjs': `export default () => new Response('h');`,
  };
  const p = await pool(t, modules, { entries: [{ source: ROOT + '/mw.mjs', export: 'default' }, { source: ROOT + '/twice.mjs', export: 'default' }, { source: ROOT + '/handler.mjs', export: 'default' }] });
  const wrapped = await p.execute({ entry: target('/handler.mjs'), chain: [target('/mw.mjs')] }, payload(), context(), undefined);
  assert.equal(body(wrapped), 'h');
  assert.deepEqual(wrapped.headers.filter(([k]) => k === 'x-seen'), [['x-seen','1']]);
  await assert.rejects(p.execute({ entry: target('/handler.mjs'), chain: [target('/twice.mjs')] }, payload(), context(), undefined), error => status(error) === 502);
});
