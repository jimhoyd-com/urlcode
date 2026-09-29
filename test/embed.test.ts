import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createRuntime } from '../packages/core/src/runtime.ts';
import type { Runtime } from '../packages/core/src/runtime.ts';
import { startServer } from '../packages/core/src/server.ts';
import { createEmbeddedHandler } from '../packages/core/src/embed.ts';
import type { EmbeddedHandlerOptions } from '../packages/core/src/embed.ts';
import { joinedHeaderCounts } from '../packages/core/src/host-request.ts';
import { project, request } from './helpers.ts';
import type { ProjectRoutes } from './helpers.ts';

// The embedded fetch handler (RIM-EMBED-001) is driven with plain fetch Requests: no socket on the adapter side.
// Its answers are compared with startServer's for the same project, so both hosts must share one set of rules.

const origin = 'https://site.example';
const fn = `export default async (request) => {
  const body = request.method === 'POST' ? await request.text() : '';
  return new Response(JSON.stringify({ url: request.url, method: request.method, body }), { status: 201, headers: [
    ['content-type', 'application/json'], ['set-cookie', 'a=1; Path=/'], ['set-cookie', 'b=2; Path=/'], ['link', '</a>; rel=preload'], ['link', '</b>; rel=preload'], ['x-custom', 'yes']] });
};`;
const moved = `export default () => new Response(null, { status: 303, headers: { location: '/after' } });`;
const stream = `export default () => new Response(ReadableStream.from((async function* () { yield 'one\\n'; yield ''; yield new TextEncoder().encode('two\\n'); })()), { headers: { 'content-type': 'text/plain; charset=utf-8' } });`;
const early = `export default () => new Response(ReadableStream.from((async function* () { throw new Error('secret-detail'); })()), { headers: { 'content-type': 'text/plain' } });`;
const routes: ProjectRoutes = {
  '/old': { redirect: { url: '/new' } },
  '/away': { redirect: { url: 'https://elsewhere.example/x' } },
  '/hello': { respond: { text: 'hello' } },
  '/json': { respond: { json: { ok: true } } },
  '/fn': { methods: ['GET', 'POST'], function: { source: 'fn.mjs' } },
  '/moved': { function: { source: 'moved.mjs' } },
  '/stream': { stream: true, methods: ['GET', 'HEAD'], function: { source: 'stream.mjs' } },
  '/early': { stream: true, function: { source: 'early.mjs' } },
  '/submit': { methods: ['POST'], request: { body: { POST: { format: 'json', contentTypes: ['application/json'], maxBytes: 64,
    schema: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string' } } } } } }, respond: { status: 201, json: { ok: true } } },
  '/api/thing': { errors: { format: 'json' }, methods: ['GET'], respond: { json: { thing: 1 } } },
  '/mode': { parameters: [{ name: 'x-mode', in: 'header', schema: { type: 'string' } }], respond: { text: 'mode' } },
};
const files = { 'fn.mjs': fn, 'moved.mjs': moved, 'stream.mjs': stream, 'early.mjs': early };

async function site(t: TestContext, extra: ProjectRoutes = {}): Promise<string> { return await project(t, { ...routes, ...extra }, files); }
async function runtimeFor(t: TestContext, root: string, options: Parameters<typeof createRuntime>[1] = {}): Promise<Runtime> {
  const runtime = await createRuntime(root, { origin, log: () => {}, ...options });
  t.after(() => runtime.close());
  return runtime;
}
function lines(headers: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(headers)) out.push(key, value);
  return out;
}
const ignored = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding', 'x-request-id']);
interface Answer { status: number; headers: Record<string, string>; cookies: string[]; body: string }
async function fromFetch(response: Response): Promise<Answer> {
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers) if (!ignored.has(key) && key !== 'set-cookie') headers[key] = value;
  return { status: response.status, headers, cookies: response.headers.getSetCookie(), body: await response.text() };
}

interface Case { method: string; path: string; headers?: Record<string, string>; body?: string }
const matrix: Case[] = [
  { method: 'GET', path: '/old' },
  { method: 'GET', path: '/away' },
  { method: 'GET', path: '/hello' },
  { method: 'HEAD', path: '/hello' },
  { method: 'GET', path: '/json' },
  { method: 'GET', path: '/fn?x=1' },
  { method: 'POST', path: '/fn', headers: { 'content-type': 'text/plain' }, body: 'posted' },
  { method: 'GET', path: '/moved' },
  { method: 'GET', path: '/stream' },
  { method: 'HEAD', path: '/stream' },
  { method: 'GET', path: '/early' },
  { method: 'GET', path: '/missing' },
  { method: 'DELETE', path: '/hello' },
  { method: 'POST', path: '/submit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(100) }) },
  { method: 'POST', path: '/submit', headers: { 'content-type': 'text/plain' }, body: '{}' },
  { method: 'POST', path: '/submit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ other: 1 }) },
  { method: 'POST', path: '/submit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ok' }) },
  { method: 'DELETE', path: '/api/thing' },
  { method: 'GET', path: '/mode', headers: { 'x-mode': 'a' } },
];

test('the embedded handler answers exactly as startServer for a matrix of routes', async t => {
  const root = await site(t);
  const server = await startServer({ project: root, port: 0, origin, log: () => {} });
  t.after(() => server.close());
  const handle = createEmbeddedHandler(await runtimeFor(t, root), { origin });
  const statuses: number[] = [];
  for (const each of matrix) {
    const headers = { host: `127.0.0.1:${server.address.port}`, ...each.headers };
    const wire = await request(server, each.path, { method: each.method, headers: each.headers ?? {}, body: each.body });
    const expected: Answer = { status: wire.status, headers: {}, cookies: [], body: wire.body };
    for (const [key, value] of Object.entries(wire.headers)) {
      if (ignored.has(key) || value === undefined) continue;
      if (key === 'set-cookie') expected.cookies = value as string[];
      else expected.headers[key] = String(value);
    }
    const init: RequestInit = { method: each.method, headers, ...(each.body === undefined ? {} : { body: each.body }) };
    const answer = await fromFetch(await handle(new Request(`http://127.0.0.1:${server.address.port}${each.path}`, init), { rawHeaders: lines(headers), peer: '127.0.0.1' }));
    assert.deepEqual(answer, expected, `${each.method} ${each.path}`);
    statuses.push(answer.status);
  }
  // The matrix reaches every answer kind it names, not only 200s.
  assert.deepEqual(statuses, [302, 302, 200, 200, 200, 201, 201, 303, 200, 200, 502, 404, 405, 413, 415, 422, 201, 405, 200]);
});

test('Set-Cookie lines stay separate and repeated response headers are all kept', async t => {
  const handle = createEmbeddedHandler(await runtimeFor(t, await site(t)), { origin, headerLines: 'unavailable' });
  const response = await handle(new Request(`${origin}/fn`));
  assert.equal(response.status, 201);
  assert.deepEqual(response.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
  assert.equal(response.headers.get('link'), '</a>; rel=preload, </b>; rel=preload');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
});

test('a streamed answer arrives chunk by chunk; a producer failing before its first chunk is a 502', async t => {
  const handle = createEmbeddedHandler(await runtimeFor(t, await site(t)), { origin, headerLines: 'unavailable' });
  const response = await handle(new Request(`${origin}/stream`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), null);
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  for await (const chunk of response.body!) chunks.push(decoder.decode(chunk));
  assert.deepEqual(chunks, ['one\n', 'two\n']);
  const failed = await handle(new Request(`${origin}/early`));
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /secret-detail/);
});

test('trusted proxies: X-Forwarded-For is read only from a trusted peer and only when sent once', async t => {
  const root = await site(t);
  const runtime = await runtimeFor(t, root, { plugins: [{ name: 'who', version: '1', targets: ['node'], onRequest: request => ({ status: 200, headers: [['content-type', 'text/plain']], body: String(request.client) }) }] });
  const handle = createEmbeddedHandler(runtime, { origin, trustedProxies: ['10.0.0.0/8'] });
  const ask = async (peer: string, raw: string[]): Promise<string> => await (await handle(new Request(`${origin}/hello`), { peer, rawHeaders: ['host', 'site.example', ...raw] })).text();
  assert.equal(await ask('10.1.2.3', ['x-forwarded-for', '203.0.113.9']), '203.0.113.9');
  assert.equal(await ask('10.1.2.3', ['x-forwarded-for', '203.0.113.9, 10.4.4.4']), '203.0.113.9');
  assert.equal(await ask('198.51.100.7', ['x-forwarded-for', '203.0.113.9']), '198.51.100.7');
  // Two X-Forwarded-For lines are ambiguous: the peer stays the client.
  assert.equal(await ask('10.1.2.3', ['x-forwarded-for', '203.0.113.9', 'x-forwarded-for', '192.0.2.1']), '10.1.2.3');
  assert.equal(await ask('::ffff:10.1.2.3', ['x-forwarded-for', '2001:db8::1']), '2001:db8::1');
  // No proxies configured: the forwarded header is never read.
  const plain = createEmbeddedHandler(runtime, { origin });
  assert.equal(await (await plain(new Request(`${origin}/hello`), { peer: '10.1.2.3', rawHeaders: ['x-forwarded-for', '203.0.113.9'] })).text(), '10.1.2.3');
  assert.throws(() => createEmbeddedHandler(runtime, { trustedProxies: ['not-an-address'] }), /Invalid trusted proxy/);
});

test('repeated request headers: raw lines count exactly; joined headers count a comma as a repeat', async t => {
  const runtime = await runtimeFor(t, await site(t));
  const exact = createEmbeddedHandler(runtime, { origin });
  assert.equal((await exact(new Request(`${origin}/mode`), { rawHeaders: ['x-mode', 'a'] })).status, 200);
  assert.equal((await exact(new Request(`${origin}/mode`), { rawHeaders: ['x-mode', 'a', 'X-Mode', 'b'] })).status, 400);
  // A single line whose value holds a comma is one line when the host says so.
  assert.equal((await exact(new Request(`${origin}/mode`), { rawHeaders: ['x-mode', 'a,b'] })).status, 200);
  // A host that promised lines and sent none is a programming error, not a request to answer.
  await assert.rejects(exact(new Request(`${origin}/mode`)), /rawHeaders/);

  const joined = createEmbeddedHandler(runtime, { origin, headerLines: 'unavailable' });
  const twice = new Headers(); twice.append('x-mode', 'a'); twice.append('x-mode', 'b');
  assert.equal(twice.get('x-mode'), 'a, b');
  assert.equal((await joined(new Request(`${origin}/mode`, { headers: twice }))).status, 400);
  assert.equal((await joined(new Request(`${origin}/mode`, { headers: { 'x-mode': 'a' } }))).status, 200);
  // The price of not knowing: one line with a comma is refused too.
  assert.equal((await joined(new Request(`${origin}/mode`, { headers: { 'x-mode': 'a,b' } }))).status, 400);

  // The runtime itself never reads a missing count as zero.
  await assert.rejects(runtime.handle({ target: '/mode', headers: twice }), (error: { status?: number }) => error.status === 400);
  assert.equal((await runtime.handle({ target: '/mode', headers: new Headers({ 'x-mode': 'a' }) })).status, 200);
  assert.deepEqual({ ...joinedHeaderCounts(twice) }, { 'x-mode': 2 });
});

test('basePath: a prefix-stripping mount keeps its prefix in redirects and a function request.url', async t => {
  const handle = createEmbeddedHandler(await runtimeFor(t, await site(t)), { origin, basePath: '/app', headerLines: 'unavailable' });
  // What a prefix-stripping mount (Hono's app.mount('/app', ...)) does before calling the handler.
  const mount = async (path: string, init?: RequestInit): Promise<Response> => {
    assert.ok(path.startsWith('/app/'));
    return await handle(new Request(`${origin}${path.slice('/app'.length)}`, init));
  };
  const redirected = await mount('/app/old');
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get('location'), '/app/new');
  assert.equal((await mount('/app/moved')).headers.get('location'), '/app/after');
  assert.equal((await mount('/app/away')).headers.get('location'), 'https://elsewhere.example/x');
  const echoed = await (await mount('/app/fn?x=1')).json() as { url: string };
  assert.equal(echoed.url, `${origin}/app/fn?x=1`);
  for (const bad of ['app', '/app/', '/a//b', '/a/../b', '/a?x', '/a#x'] as const) {
    assert.throws(() => createEmbeddedHandler({} as Runtime, { basePath: bad } as EmbeddedHandlerOptions), /Base path/, bad);
  }
});

test('loopbackHost: a Host that is not the loopback bind or the site origin is refused with 421', async t => {
  const handle = createEmbeddedHandler(await runtimeFor(t, await site(t)), { origin, loopbackHost: { address: '127.0.0.1', port: 4191 } });
  const status = async (raw: string[]): Promise<number> => (await handle(new Request('http://127.0.0.1:4191/hello'), { rawHeaders: raw })).status;
  assert.equal(await status(['host', '127.0.0.1:4191']), 200);
  assert.equal(await status(['host', 'localhost:4191']), 200);
  assert.equal(await status(['host', 'site.example']), 200);
  assert.equal(await status(['host', 'attacker.example']), 421);
  assert.equal(await status(['host', '127.0.0.1:4191', 'host', '127.0.0.1:4191']), 421);
  assert.equal(await status([]), 421);
  // A non-loopback listener is not checked, as on the Node server.
  const open = createEmbeddedHandler(await runtimeFor(t, await site(t)), { origin, loopbackHost: { address: '0.0.0.0', port: 4191 } });
  assert.equal((await open(new Request('http://127.0.0.1:4191/hello'), { rawHeaders: ['host', 'attacker.example'] })).status, 200);
});

test('the request body is capped by maxBodyBytes and the route limit, and the origin defaults to the request URL', async t => {
  const runtime = await runtimeFor(t, await site(t));
  const handle = createEmbeddedHandler(runtime, { maxBodyBytes: 8, headerLines: 'unavailable' });
  const big = await handle(new Request('http://embedded.test/fn', { method: 'POST', body: 'x'.repeat(9) }));
  assert.equal(big.status, 413);
  const echoed = await (await handle(new Request('http://embedded.test/fn', { method: 'POST', body: 'small' }))).json() as { url: string; body: string };
  assert.deepEqual(echoed, { url: 'http://embedded.test/fn', method: 'POST', body: 'small' });
  assert.throws(() => createEmbeddedHandler(runtime, { maxBodyBytes: 0 }), /Request limit/);
  assert.throws(() => createEmbeddedHandler(runtime, { origin: 'https://site.example/path' }), /Origin must be/);
});
