import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from '../src/runtime.ts';
import { startServer } from '../src/server.ts';
import { project, request, approveBindings, redirect } from './helpers.ts';
import type { TestContext } from 'node:test';
import type { Server, ServerOptions } from '../src/server.ts';

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
