import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHook } from 'node:async_hooks';
import { createRuntime } from '../packages/core/src/runtime.ts';
import { startServer } from '../packages/core/src/server.ts';
import { TrustedFunctions } from '../packages/core/src/trusted-functions.ts';
import type { TrustedRoute } from '../packages/core/src/trusted-functions.ts';
import { project, request, approveBindings, redirect } from './helpers.ts';
import type { TestContext } from 'node:test';
import type { Server, ServerOptions } from '../packages/core/src/server.ts';

async function app(t: TestContext, root: string, options: Partial<ServerOptions> = {}): Promise<Server> {
  const server = await startServer({ project: root, port: 0, log: () => {}, ...options });
  t.after(() => server.close());
  return server;
}

test('a trusted (no sandbox field) function has full Node, filesystem and network access', async t => {
  const root = await project(t, { '/': { function: { source: 'f.mjs' } } }, {
    'f.mjs': `import { readFileSync } from 'node:fs';
      export default () => Response.json({
        process: typeof process, require: typeof require, fetch: typeof fetch,
        Buffer: typeof Buffer, canReadOwnSource: readFileSync(new URL(import.meta.url)).length > 0,
      });`,
  });
  const response = await request(await app(t, root), '/');
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body) as Record<string, unknown>;
  assert.deepEqual(body, { process: 'object', require: 'undefined', fetch: 'function', Buffer: 'function', canReadOwnSource: true });
});

test('`sandbox: false` behaves identically to an absent `sandbox` field', async t => {
  const root = await project(t, {
    '/absent': { function: { source: 'f.mjs' } },
    '/false': { sandbox: false, function: { source: 'f.mjs' } },
  }, { 'f.mjs': `export default () => Response.json({ hasProcess: typeof process === 'object' });` });
  const server = await app(t, root);
  const a = await request(server, '/absent'), b = await request(server, '/false');
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.body, b.body);
});

test('a trusted function still receives only the secrets its route explicitly declares and was granted', async t => {
  const root = await project(t, {
    '/allowed': { function: { source: 'f.mjs' }, secrets: { KEY: { secret: 'token' } } },
    '/other': { function: { source: 'f.mjs' } },
  }, { 'f.mjs': `export default (_request, context) => Response.json({ keys: Object.keys(context.secrets) });` });
  const environment = { token: 'TEST_PRIVATE', ambient: 'MUST_NOT_LEAK' };
  await assert.rejects(createRuntime(root, { environment }), /denied by operator policy/);
  const permissions = await approveBindings(root);
  const server = await app(t, root, { permissions, environment });
  assert.deepEqual(JSON.parse((await request(server, '/allowed')).body).keys, ['KEY']);
  assert.deepEqual(JSON.parse((await request(server, '/other')).body).keys, []);
});

test('trusted module state persists across requests: no fresh heap per call, unlike the sandbox', async t => {
  const root = await project(t, { '/': { function: { source: 'f.mjs' } } }, {
    'f.mjs': `let count = 0; export default () => new Response(String(++count));`,
  });
  const server = await app(t, root);
  assert.equal((await request(server, '/')).body, '1');
  assert.equal((await request(server, '/')).body, '2');
  assert.equal((await request(server, '/')).body, '3');
});

test('a trusted route and a sandboxed route in the same project do not cross-contaminate', async t => {
  const root = await project(t, {
    '/trusted': { function: { source: 'trusted.mjs' } },
    '/sandboxed': { sandbox: true, function: { source: 'sandboxed.mjs' } },
  }, {
    'trusted.mjs': `export default () => Response.json({ hasProcess: typeof process === 'object', hasFetch: typeof fetch === 'function' });`,
    'sandboxed.mjs': `export default () => Response.json({ hasProcess: typeof process === 'object', hasFetch: typeof fetch === 'function' });`,
  });
  const server = await app(t, root);
  assert.deepEqual(JSON.parse((await request(server, '/trusted')).body), { hasProcess: true, hasFetch: true });
  assert.deepEqual(JSON.parse((await request(server, '/sandboxed')).body), { hasProcess: false, hasFetch: false });
});

test('a sandboxed route rejects Node imports at startup; the same import is legal once trusted', async t => {
  const files = { 'f.mjs': `import fs from 'node:fs'; export default () => new Response(typeof fs.readFileSync);` };
  const sandboxedRoot = await project(t, { '/': { sandbox: true, function: { source: 'f.mjs' } } }, files);
  await assert.rejects(createRuntime(sandboxedRoot), /relative project/);
  const trustedRoot = await project(t, { '/': { function: { source: 'f.mjs' } } }, files);
  assert.equal((await request(await app(t, trustedRoot), '/')).body, 'function');
});

test('trusted middleware shares context.state, enforces next() semantics and can pass through a native reply unchanged', async t => {
  const root = await project(t, {
    '/go': { ...redirect(), middleware: [{ source: 'mw.mjs' }] },
    '/twice': { ...redirect(), middleware: [{ source: 'twice.mjs' }] },
  }, {
    'mw.mjs': `export default async (request, context, next) => { context.state.seen = true; const response = await next(); response.headers.set('x-seen', String(context.state.seen)); return response; }`,
    'twice.mjs': `export default async (request, context, next) => { await next(); return await next(); }`,
  });
  const server = await app(t, root);
  const go = await request(server, '/go');
  assert.equal(go.status, 302); assert.equal(go.headers.location, 'https://example.com/'); assert.equal(go.headers['x-seen'], 'true');
  assert.equal((await request(server, '/twice')).status, 502);
});

test('trusted native metadata mutation is rejected the same way the sandbox rejects it', async t => {
  const root = await project(t, { '/go': { ...redirect(), middleware: [{ source: 'mw.mjs' }] } },
    { 'mw.mjs': `export default async (req, ctx, next) => { const res = await next(); res.headers.set('location','https://bad.example'); return res; }` });
  assert.equal((await request(await app(t, root), '/go')).status, 502);
});

test('a trusted call that never settles is still bounded by the configured deadline', async t => {
  const root = await project(t, { '/hang': { function: { source: 'f.mjs' } } },
    { 'f.mjs': `export default () => new Promise(() => {});` });
  const server = await app(t, root, { timeoutMs: 200 });
  const started = Date.now();
  const response = await request(server, '/hang');
  assert.equal(response.status, 504);
  assert.ok(Date.now() - started < 5000);
});

test('editing a trusted function invalidates its binding grant, same as a sandboxed one', async t => {
  const root = await project(t, { '/go': { function: { source: 'f.mjs' }, secrets: { KEY: { secret: 'token' } } } },
    { 'f.mjs': `export default (_r, ctx) => new Response(ctx.secrets.KEY);` });
  const permissions = await approveBindings(root);
  const server = await app(t, root, { permissions, environment: { token: 'approved' } });
  assert.equal((await request(server, '/go')).body, 'approved');
  await writeFile(join(root, 'f.mjs'), `export default (_r, ctx) => new Response('changed:' + ctx.secrets.KEY);`);
  await assert.rejects(createRuntime(root, { permissions, environment: { token: 'approved' } }), /denied by operator policy/);
});

// #137: TrustedFunctions must count bytes while streaming a response body and
// cancel the reader as soon as maxBytes is exceeded, instead of buffering the
// whole stream via a single .arrayBuffer() call before checking the limit.
test('a trusted response exceeding maxBytes is cancelled mid-stream, not fully buffered first', async t => {
  const root = await project(t, { '/stream': { function: { source: 'f.mjs' } }, '/pulls': { function: { source: 'f.mjs', export: 'pulls' } } }, {
    'f.mjs': `
      globalThis.__pulls = 0;
      export default () => new Response(new ReadableStream({
        pull(controller) {
          globalThis.__pulls++;
          if (globalThis.__pulls > 20) { controller.close(); return; }
          controller.enqueue(new Uint8Array(1024));
        },
      }));
      export const pulls = () => new Response(String(globalThis.__pulls));
    `,
  });
  const server = await app(t, root, { maxBytes: 1024 });
  const response = await request(server, '/stream');
  assert.equal(response.status, 502);
  const pulls = Number((await request(server, '/pulls')).body);
  // The limit is exactly one chunk (1024 bytes); a correct incremental reader
  // stops at the second chunk (total 2048 > 1024) instead of pulling all 20.
  assert.ok(pulls <= 3, `expected the stream to be cancelled after ~2 chunks, but it was pulled ${pulls} times`);
});

// #137: a trusted call's deadline firing must cancel the in-flight body read,
// not just reject the outer call while the stream keeps being consumed.
test('a trusted deadline cancels an in-flight body read instead of letting it keep consuming the stream', async t => {
  const root = await project(t, { '/slow': { function: { source: 'f.mjs' } }, '/pulls': { function: { source: 'f.mjs', export: 'pulls' } } }, {
    'f.mjs': `
      globalThis.__pulls = 0;
      export default () => new Response(new ReadableStream({
        async pull(controller) {
          globalThis.__pulls++;
          if (globalThis.__pulls > 10) { controller.close(); return; }
          await new Promise(resolve => setTimeout(resolve, 10));
          controller.enqueue(new Uint8Array(1));
        },
      }));
      export const pulls = () => new Response(String(globalThis.__pulls));
    `,
  });
  const server = await app(t, root, { timeoutMs: 25 });
  const response = await request(server, '/slow');
  assert.equal(response.status, 504);
  // Give a cancelled reader (correct behavior) time to actually stop, and a
  // non-cancelled one (old, buggy behavior) time to run all 10 chunks (~100ms).
  await new Promise(resolve => setTimeout(resolve, 200));
  const pulls = Number((await request(server, '/pulls')).body);
  assert.ok(pulls < 10, `expected the reader to be cancelled well before all 10 chunks were pulled, but it reached ${pulls}`);
});

// #138: a completed trusted call (success or failure) must clear its deadline
// timer; a leaked, un-cleared setTimeout per call means pending timers scale
// with request rate × timeoutMs.
test('a completed trusted call clears its deadline timer, leaving no pending Timeout resources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-timer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'f.mjs'), `export default () => new Response('hello');`);
  const trusted = new TrustedFunctions({ timeoutMs: 60000 });
  const route: TrustedRoute = { function: { source: join(root, 'f.mjs'), export: 'default' } };
  await trusted.start([route]);
  const live = new Set<number>();
  const hook = createHook({
    init(asyncId, type) { if (type === 'Timeout') live.add(asyncId); },
    destroy(asyncId) { live.delete(asyncId); },
  });
  hook.enable();
  try {
    const context = { inputs: { path: {}, query: {}, header: {} }, env: {}, secrets: {} } as Parameters<TrustedFunctions['execute']>[2];
    for (let i = 0; i < 100; i++) {
      const result = await trusted.execute(route, { url: 'http://example.invalid/', method: 'GET', headers: [] }, context, undefined);
      assert.equal(result.status, 200);
    }
    await new Promise(resolve => setImmediate(resolve));
  } finally { hook.disable(); }
  assert.equal(live.size, 0, `expected no pending Timeout resources after 100 completed calls, found ${live.size}`);
});

// #139: a trusted HEAD response must advertise the real GET body length,
// never an invented 0 — for both a plain response and one a middleware
// transforms (a fresh Response built from the original, not the native
// passthrough shortcut).
test('a trusted HEAD response reports the real body length, plain and middleware-transformed', async t => {
  const root = await project(t, {
    '/plain': { function: { source: 'f.mjs' } },
    '/transformed': { function: { source: 'f.mjs' }, middleware: [{ source: 'mw.mjs' }] },
  }, {
    'f.mjs': `export default () => new Response('hello');`,
    'mw.mjs': `export default async (request, context, next) => {
      const response = await next();
      const text = await response.text();
      return new Response(text.toUpperCase(), { headers: response.headers });
    }`,
  });
  const server = await app(t, root);

  const plainGet = await request(server, '/plain');
  assert.equal(plainGet.status, 200); assert.equal(plainGet.body, 'hello');
  assert.equal(plainGet.headers['content-length'], '5');
  const plainHead = await request(server, '/plain', { method: 'HEAD' });
  assert.equal(plainHead.status, 200); assert.equal(plainHead.bytes.length, 0);
  assert.equal(plainHead.headers['content-length'], '5');

  const transformedGet = await request(server, '/transformed');
  assert.equal(transformedGet.status, 200); assert.equal(transformedGet.body, 'HELLO');
  assert.equal(transformedGet.headers['content-length'], '5');
  const transformedHead = await request(server, '/transformed', { method: 'HEAD' });
  assert.equal(transformedHead.status, 200); assert.equal(transformedHead.bytes.length, 0);
  assert.equal(transformedHead.headers['content-length'], '5');
});
