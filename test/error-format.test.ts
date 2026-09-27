// Focused fixture for RIM-ERRORS-001 (docs/RUNTIME-IMPLEMENTATION.md): the declarative error representation,
// route `errors.format` and the `site.errors` path scope (docs/HTTP.md#error-format).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../packages/core/src/server.ts';
import { createRuntime } from '../packages/core/src/runtime.ts';
import http from 'node:http';
import { createLambdaHandler } from '../packages/core/src/aws.ts';
import { createVercelHandler } from '../packages/core/src/vercel.ts';
import type { LambdaEvent, LambdaResponse } from '../packages/core/src/aws.ts';
import { buildCloudflare } from '../packages/core/src/build-cloudflare.ts';
import { buildStatic } from '../packages/core/src/build-static.ts';
import { createFetchHandler } from '../packages/core/src/cloudflare.ts';
import type { Artifact, Validators } from '../packages/core/src/cloudflare.ts';
import { analyzeProjectCapabilities, getCapabilities } from '../packages/core/src/capabilities.ts';
import { loadDocument } from '../packages/core/src/config.ts';
import { applySite } from '../packages/core/src/site.ts';
import { errorCodes, errorEnvelope } from '../packages/core/src/http-response.ts';
import { inspectExtensionRevision } from '../packages/core/src/extensions.ts';
import type { RuntimeExtension } from '../packages/core/src/extensions.ts';
import { project, request } from './helpers.ts';

const envelope = (code: string, message: string) => JSON.stringify({ error: { code, message } });
const json = 'application/json; charset=utf-8';
const body = { format: 'json', contentTypes: ['application/json'], maxBytes: 64, schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', maxLength: 4 } } } };
const routes = {
  '/status': { respond: { json: { status: 'ok' } }, errors: { format: 'json' } },
  '/plain': { respond: { json: { status: 'ok' } } },
  '/todos': { methods: ['POST'], request: { body }, respond: { status: 201, json: { ok: true } }, errors: { format: 'json' } },
  '/api/v1/items': { respond: { json: [] } },
  '/api/legacy': { respond: { text: 'legacy' }, errors: { format: 'text' } },
  '/api/teapot': { respond: { status: 404, text: 'handler says no' } },
  '/api/off': { respond: { text: 'off' }, enabled: false },
  '/api/boom': { function: { source: 'boom.mjs' } },
  '/': { page: { file: 'index.html' } },
};
const files = { 'boom.mjs': 'export default () => { throw new Error("secret internal detail"); };', 'index.html': '<!doctype html><title>home</title>', '404.html': '<!doctype html><title>missing</title>' };
const settings = { site: { notFound: '404.html', errors: { format: 'json', paths: ['/api/*'] } } };

test('text stays the default, byte for byte', async t => {
  const app = await startServer({ project: await project(t, { '/plain': routes['/plain'], '/todos': { ...routes['/todos'], errors: undefined } }), port: 0, log: () => {} }); t.after(() => app.close());
  const refused = await request(app, '/plain', { method: 'POST' });
  assert.equal(refused.status, 405); assert.equal(refused.headers.allow, 'GET, HEAD'); assert.equal(refused.body, 'Method not allowed\n');
  assert.equal(refused.headers['content-type'], undefined); assert.equal(refused.headers['content-length'], '19');
  const missing = await request(app, '/nope');
  assert.equal(missing.status, 404); assert.equal(missing.body, 'Not found\n'); assert.equal(missing.headers['content-type'], 'text/plain; charset=utf-8');
  const wrongType = await request(app, '/todos', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(wrongType.status, 415); assert.equal(wrongType.body, 'Unsupported media type\n');
  // The body-schema 422 keeps its own JSON answer when no error format is declared.
  const invalid = await request(app, '/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(invalid.status, 422); assert.equal(invalid.headers['content-type'], 'application/json'); assert.equal((JSON.parse(invalid.body) as { error: string }).error, 'body_validation_failed');
});

test('a JSON route answers its runtime errors with the fixed envelope, keeping Allow, headers and the HEAD rule', async t => {
  const app = await startServer({ project: await project(t, routes, files, settings), port: 0, log: () => {} }); t.after(() => app.close());
  const ok = await request(app, '/status');
  assert.equal(ok.status, 200); assert.equal(ok.body, '{"status":"ok"}');
  const refused = await request(app, '/status', { method: 'POST' });
  assert.equal(refused.status, 405); assert.equal(refused.headers.allow, 'GET, HEAD');
  assert.equal(refused.headers['content-type'], json); assert.equal(refused.body, envelope('METHOD_NOT_ALLOWED', 'Method not allowed'));
  assert.equal(refused.headers['x-content-type-options'], 'nosniff'); assert.equal(refused.headers['cache-control'], 'no-store'); assert.ok(refused.headers['x-request-id']);
  // HEAD on a route that does not admit it: 405 with Allow, the JSON length stated, no body.
  const head = await request(app, '/todos', { method: 'HEAD' });
  assert.equal(head.status, 405); assert.equal(head.headers.allow, 'POST'); assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], String(Buffer.byteLength(envelope('METHOD_NOT_ALLOWED', 'Method not allowed'))));
  const post = (headers: Record<string, string>, payload: string) => request(app, '/todos', { method: 'POST', headers, body: payload });
  const large = await post({ 'content-type': 'application/json' }, JSON.stringify({ title: 'x'.repeat(100) }));
  assert.equal(large.status, 413); assert.equal(large.body, envelope('CONTENT_TOO_LARGE', 'Request body too large')); assert.equal(large.headers['content-type'], json);
  const media = await post({ 'content-type': 'text/plain' }, 'x');
  assert.equal(media.status, 415); assert.equal(media.body, envelope('UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type'));
  const malformed = await post({ 'content-type': 'application/json' }, '{bad');
  assert.equal(malformed.status, 400); assert.equal(malformed.body, envelope('BAD_REQUEST', 'Invalid JSON body'));
  const invalid = await post({ 'content-type': 'application/json' }, JSON.stringify({ title: 'secret-value' }));
  assert.equal(invalid.status, 422); assert.equal(invalid.headers['content-type'], json); assert.doesNotMatch(invalid.body, /secret-value/);
  assert.deepEqual(JSON.parse(invalid.body), { error: { code: 'UNPROCESSABLE_CONTENT', message: 'Request body failed validation', issues: [{ pointer: '/title', keyword: 'maxLength', message: 'must be at most 4 characters', expected: 4 }] } });
});

test('site.errors scopes unmatched and matched paths; routes, handlers and the not-found page keep their own answers', async t => {
  const app = await startServer({ project: await project(t, routes, files, settings), port: 0, log: () => {} }); t.after(() => app.close());
  for (const [method, path] of [['GET', '/api/missing/deep?x=1'], ['POST', '/api/orders'], ['GET', '/api'], ['DELETE', '/api/']] as const) {
    const answer = await request(app, path, { method });
    assert.equal(answer.status, 404, path); assert.equal(answer.headers['content-type'], json, path); assert.equal(answer.body, envelope('NOT_FOUND', 'Not found'), path);
  }
  const head = await request(app, '/api/missing', { method: 'HEAD' });
  assert.equal(head.status, 404); assert.equal(head.body, ''); assert.equal(head.headers['content-type'], json);
  const inScope = await request(app, '/api/v1/items', { method: 'PUT' });
  assert.equal(inScope.status, 405); assert.equal(inScope.headers.allow, 'GET, HEAD'); assert.equal(inScope.body, envelope('METHOD_NOT_ALLOWED', 'Method not allowed'));
  assert.equal((await request(app, '/api/off')).body, envelope('NOT_FOUND', 'Not found'));
  // A thrown function is the generic 502, never its message.
  const failed = await request(app, '/api/boom');
  assert.equal(failed.status, 502); assert.equal(failed.body, envelope('BAD_GATEWAY', 'Function execution failed')); assert.doesNotMatch(failed.body, /secret internal/);
  // An invalid encoding under the scope never parsed: the raw path decides.
  const encoding = await request(app, '/api/%zz');
  assert.equal(encoding.status, 400); assert.equal(encoding.body, envelope('BAD_REQUEST', 'Invalid URL encoding'));
  // A route's own text wins over the scope; a handler's own 404 is never rewritten.
  assert.equal((await request(app, '/api/legacy', { method: 'POST' })).body, 'Method not allowed\n');
  const handler = await request(app, '/api/teapot');
  assert.equal(handler.status, 404); assert.equal(handler.body, 'handler says no'); assert.equal(handler.headers['content-type'], 'text/plain; charset=utf-8');
  // Outside the scope: the HTML not-found page, and text for other methods.
  const page = await request(app, '/elsewhere');
  assert.equal(page.status, 404); assert.match(page.body, /missing/); assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal((await request(app, '/elsewhere', { method: 'POST' })).body, 'Not found\n');
  assert.equal((await request(app, '/apis')).status, 404); assert.match((await request(app, '/apis')).body, /missing/);
  assert.equal((await request(app, '/', { method: 'POST' })).body, 'Method not allowed\n');
});

test('policy, plugin and extension answers are never rewritten', async t => {
  const origin = 'https://errors.example.test';
  const root = await project(t, {
    '/api/budget': { respond: { text: 'ok' }, policies: { throttle: { quota: 1, window: 60, partition: 'route' } } },
    '/api/early': { respond: { text: 'late' } },
    '/api/private': { respond: { text: 'private' }, policies: { extensions: { demo: {} } } },
    '/demo/*': { extension: 'demo', errors: { format: 'json' } },
  }, {}, { site: { errors: { format: 'json', paths: ['/api/*'] } }, extensions: { demo: { version: '1', config: {} } } });
  const extension: RuntimeExtension = { name: 'demo', version: '1', projectSha256: await inspectExtensionRevision(root), targets: ['node'],
    schema: { type: 'object' }, policySchema: { type: 'object' },
    activate: () => ({ handle: () => ({ status: 404, headers: [['content-type', 'text/plain']], body: 'extension miss' }), authorize: () => ({ status: 401, headers: [], body: 'sign in' }) }) };
  const plugin = { name: 'early', version: '1', targets: ['node' as const], onRequest: (req: { route: string }) => req.route === '/api/early' ? { status: 409, headers: [['content-type', 'text/plain']] as [string, string][], body: 'plugin answer' } : undefined };
  const app = await startServer({ project: root, origin, port: 0, extensions: [extension], plugins: [plugin], log: () => {} }); t.after(() => app.close());
  assert.equal((await request(app, '/api/budget')).status, 200);
  const limited = await request(app, '/api/budget');
  assert.equal(limited.status, 429); assert.notEqual(limited.headers['content-type'], json); assert.doesNotMatch(limited.body, /"error"/);
  const early = await request(app, '/api/early');
  assert.equal(early.status, 409); assert.equal(early.body, 'plugin answer');
  const denied = await request(app, '/api/private');
  assert.equal(denied.status, 401); assert.equal(denied.body, 'sign in');
  const miss = await request(app, '/demo/x');
  assert.equal(miss.status, 404); assert.equal(miss.body, 'extension miss');
  // The runtime's own 405 on that extension mount is the envelope.
  assert.equal((await request(app, '/demo/x', { method: 'DELETE' })).body, envelope('METHOD_NOT_ALLOWED', 'Method not allowed'));
});

test('host-side errors use the target format: server body limit, runtime errorFormat, and the Lambda adapter', async t => {
  const root = await project(t, routes, files, settings);
  const runtime = await createRuntime(root, { log: () => {} }); t.after(() => runtime.close());
  assert.equal(runtime.errorFormat(new Error('x'), '/api/anything'), 'json');
  assert.equal(runtime.errorFormat(new Error('x'), '/status?x=1'), 'json');
  assert.equal(runtime.errorFormat(new Error('x'), '/api/legacy'), 'text');
  assert.equal(runtime.errorFormat(new Error('x'), '/plain'), 'text');
  assert.equal(runtime.errorFormat(new Error('x'), '/api/%zz'), 'json');
  const { '/api/boom': _boom, ...native } = routes;
  const handler = createLambdaHandler({ project: await project(t, native, files, settings) });
  const invoke = (path: string, method = 'GET', payload?: string): LambdaEvent => ({ version: '2.0', rawPath: path, rawQueryString: '', headers: { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: payload, isBase64Encoded: false }), requestContext: { http: { method } } });
  const decode = (response: LambdaResponse) => Buffer.from(response.body, 'base64').toString();
  const refused = await handler(invoke('/status', 'POST'));
  assert.equal(refused.statusCode, 405); assert.equal(refused.headers.allow, 'GET, HEAD'); assert.equal(decode(refused), envelope('METHOD_NOT_ALLOWED', 'Method not allowed'));
  // Refused by the adapter before handle(): the target still decides.
  const large = await handler(invoke('/todos', 'POST', 'x'.repeat(200)));
  assert.equal(large.statusCode, 413); assert.equal(large.headers['content-type'], json); assert.equal(decode(large), envelope('CONTENT_TOO_LARGE', 'Request body too large'));
  assert.equal(decode(await handler(invoke('/api/none'))), envelope('NOT_FOUND', 'Not found'));
  assert.equal(decode(await handler(invoke('/plain', 'POST'))), 'Method not allowed\n');
});

test('the Vercel adapter writes the same envelopes, including its own pre-handle 413', async t => {
  const { '/api/boom': _boom, ...native } = routes;
  const handler = createVercelHandler({ project: await project(t, native, files, settings), environment: {} });
  const server = http.createServer((req, res) => { void handler(req, res).catch(() => { if (!res.headersSent) res.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const app = { address: server.address() as { port: number } };
  const refused = await request(app, '/status', { method: 'POST' });
  assert.equal(refused.status, 405); assert.equal(refused.headers.allow, 'GET, HEAD'); assert.equal(refused.body, envelope('METHOD_NOT_ALLOWED', 'Method not allowed'));
  const large = await request(app, '/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(200) });
  assert.equal(large.status, 413); assert.equal(large.body, envelope('CONTENT_TOO_LARGE', 'Request body too large'));
  assert.equal((await request(app, '/api/none')).body, envelope('NOT_FOUND', 'Not found'));
  assert.equal((await request(app, '/plain', { method: 'POST' })).body, 'Method not allowed\n');
});

test('the Worker artifact answers the same envelopes and keeps text elsewhere', async t => {
  const root = await project(t, {
    '/status': routes['/status'], '/plain': routes['/plain'], '/todos': routes['/todos'], '/api/v1/items': routes['/api/v1/items'], '/api/legacy': routes['/api/legacy'],
  }, { '404.html': '<!doctype html><title>missing</title>' }, settings);
  const out = await mkdtemp(join(tmpdir(), 'urlcode-cf-errors-')); t.after(() => rm(out, { recursive: true, force: true }));
  await buildCloudflare(root, { out });
  const artifact = ((await import(pathToFileURL(join(out, 'artifact.js')).href)) as { default: Artifact }).default;
  const validators = (await import(pathToFileURL(join(out, 'validators.js')).href)) as Validators;
  assert.deepEqual(artifact.errorPaths, ['/api/*']);
  const fetch = createFetchHandler(artifact, validators);
  const call = async (path: string, init: RequestInit = {}) => { const response = await fetch(new Request('https://example.test' + path, init)); return { status: response.status, type: response.headers.get('content-type'), allow: response.headers.get('allow'), body: await response.text() }; };
  assert.deepEqual(await call('/status', { method: 'POST' }), { status: 405, type: json, allow: 'GET, HEAD', body: envelope('METHOD_NOT_ALLOWED', 'Method not allowed') });
  assert.deepEqual(await call('/status', { method: 'DELETE' }).then(r => r.body), envelope('METHOD_NOT_ALLOWED', 'Method not allowed'));
  assert.deepEqual(await call('/api/missing', { method: 'POST' }), { status: 404, type: json, allow: null, body: envelope('NOT_FOUND', 'Not found') });
  assert.equal((await call('/api/missing')).body, envelope('NOT_FOUND', 'Not found'));
  assert.equal((await call('/api/v1/items', { method: 'PUT' })).body, envelope('METHOD_NOT_ALLOWED', 'Method not allowed'));
  assert.equal((await call('/api/legacy', { method: 'PUT' })).body, 'Method not allowed\n');
  assert.equal((await call('/plain', { method: 'PUT' })).body, 'Method not allowed\n');
  assert.match((await call('/elsewhere')).body, /missing/);
  const head = await call('/api/missing', { method: 'HEAD' });
  assert.equal(head.status, 404); assert.equal(head.body, '');
  const invalid = await call('/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(invalid.status, 422); assert.equal((JSON.parse(invalid.body) as { error: { code: string } }).error.code, 'UNPROCESSABLE_CONTENT');
});

test('static hosting refuses the JSON error format before building; every other target reports it', async t => {
  const routeOnly = await project(t, { '/': { respond: { text: 'hi' }, errors: { format: 'json' } } });
  await assert.rejects(buildStatic(routeOnly, { out: join(routeOnly, 'out') }), /capability: errors[\s\S]*no server/);
  const siteOnly = await project(t, { '/': { respond: { text: 'hi' } } }, {}, { site: { errors: { format: 'json', paths: ['/api/*'] } } });
  await assert.rejects(buildStatic(siteOnly, { out: join(siteOnly, 'out') }), /\(project\)\n {2}capability: errors/);
  const loaded = await loadDocument(siteOnly); await applySite(loaded);
  for (const target of ['self-hosted', 'aws', 'vercel', 'cloudflare']) assert.equal(analyzeProjectCapabilities(loaded, target).compatible, true, target);
  // An explicit text route is the default and needs nothing from a target.
  const text = await project(t, { '/': { respond: { text: 'hi' }, errors: { format: 'text' } } });
  const textLoaded = await loadDocument(text); await applySite(textLoaded);
  assert.equal(analyzeProjectCapabilities(textLoaded, 'static').compatible, true);
  const row = getCapabilities().capabilities.find(entry => entry.capability === 'errors')!;
  assert.deepEqual(Object.fromEntries(Object.entries(row.targets).map(([target, decision]) => [target, decision!.support])), { 'self-hosted': 'native', cloudflare: 'compiled', aws: 'native', vercel: 'native', static: 'refused' });
});

test('site.errors paths are validated and the code set is closed', async t => {
  for (const paths of [[], ['api'], ['/api*'], ['/a/*/b'], ['/a b']]) {
    const root = await project(t, { '/': { respond: { text: 'hi' } } }, {}, { site: { errors: { format: 'json', paths } } });
    await assert.rejects(createRuntime(root, { log: () => {} }), /site\.errors|errors/, JSON.stringify(paths));
  }
  const textSite = await project(t, { '/': { respond: { text: 'hi' } } }, {}, { site: { errors: { format: 'text', paths: ['/*'] } } });
  await assert.rejects(createRuntime(textSite, { log: () => {} }), /format/);
  assert.deepEqual(Object.keys(errorCodes).map(Number), [400, 404, 405, 410, 413, 414, 415, 421, 422, 500, 502, 503, 504]);
  assert.equal(errorEnvelope(418, 'x'), '{"error":{"code":"ERROR","message":"x"}}');
});
