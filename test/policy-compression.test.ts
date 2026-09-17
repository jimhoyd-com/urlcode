import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { startServer } from '../src/server.ts';
import { createRuntime } from '../src/runtime.ts';
import { negotiate, zstdAvailable } from '../src/policies/compression.ts';
import { project, request, approveBindings } from './helpers.ts';
import type { TestContext } from 'node:test';
import type { Server, ServerOptions } from '../src/server.ts';

async function serve(t: TestContext, root: string, options: Partial<ServerOptions> = {}): Promise<Server> {
  const app = await startServer({ project: root, port: 0, log: () => {}, ...options }); t.after(() => app.close()); return app;
}
const text = 'The quick brown fox jumps over the lazy dog. '.repeat(100); // 4500 bytes, compressible
const decode = { br: zlib.brotliDecompressSync, gzip: zlib.gunzipSync, deflate: zlib.inflateSync, zstd: zlib.zstdDecompressSync };

test('negotiation follows RFC 9110 q-values with the project order as tie-break', () => {
  const order = ['br','gzip'];
  assert.equal(negotiate('gzip, br', order), 'br');
  assert.equal(negotiate('gzip;q=1, br;q=0.5', order), 'gzip');
  assert.equal(negotiate('gzip', order), 'gzip');
  assert.equal(negotiate('*', order), 'br');
  assert.equal(negotiate('*;q=0.1, gzip;q=0.5', order), 'gzip');
  assert.equal(negotiate('br;q=0, *', order), 'gzip');
  assert.equal(negotiate('identity', order), null);
  assert.equal(negotiate('identity;q=0', order), null);
  assert.equal(negotiate('*;q=0', order), null);
  assert.equal(negotiate('', order), null);
  assert.equal(negotiate(undefined, order), null);
  assert.equal(negotiate('GZIP ; q=abc', order), null);
});

test('declared text responses compress per Accept-Encoding, below minBytes stay identity, Vary is set once', async t => {
  const root = await project(t, {
    '/big': { respond: { text }, response: { headers: { vary: 'Origin' } } },
    '/small': { respond: { text: 'tiny' } },
    '/raw': { respond: { text }, response: { headers: { 'cache-control': 'public, no-transform' } } },
  }, {}, { policies: { compression: { encodings: ['br','gzip'] } } });
  const app = await serve(t, root);
  const br = await request(app, '/big', { headers: { 'accept-encoding': 'gzip, br' } });
  assert.equal(br.headers['content-encoding'], 'br'); assert.equal(br.headers.vary, 'Origin, Accept-Encoding');
  assert.equal(Number(br.headers['content-length']), br.bytes.length); assert.ok(br.bytes.length < text.length);
  assert.equal(decode.br(br.bytes).toString(), text);
  const gzip = await request(app, '/big', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gzip.headers['content-encoding'], 'gzip'); assert.equal(decode.gzip(gzip.bytes).toString(), text);
  const identity = await request(app, '/big', { headers: { 'accept-encoding': 'identity' } });
  assert.equal(identity.headers['content-encoding'], undefined); assert.equal(identity.body, text);
  assert.equal(identity.headers.vary, 'Origin, Accept-Encoding');
  const small = await request(app, '/small', { headers: { 'accept-encoding': 'br' } });
  assert.equal(small.headers['content-encoding'], undefined); assert.equal(small.body, 'tiny'); assert.equal(small.headers.vary, 'Accept-Encoding');
  const raw = await request(app, '/raw', { headers: { 'accept-encoding': 'br' } });
  assert.equal(raw.headers['content-encoding'], undefined); assert.equal(raw.body, text);
  // Dynamic bodies are not compressed for HEAD; the response still varies.
  const head = await request(app, '/big', { method: 'HEAD', headers: { 'accept-encoding': 'br' } });
  assert.equal(head.headers['content-encoding'], undefined); assert.equal(head.headers.vary, 'Origin, Accept-Encoding');
  const runtime = await createRuntime(root, { log: () => {} }); t.after(() => runtime.close());
  assert.deepEqual(runtime.testPlan().policies['/big']?.compression,
    { encodings: ['br','gzip'], minBytes: 1024, types: 7, level: null, precompressed: 0, target: 'native' });
});

test('page assets are precompressed once, served by reference with a suffixed strong ETag, and revalidate', async t => {
  const html = '<!doctype html><ul>' + '<li>item</li>'.repeat(500) + '</ul>';
  const root = await project(t, { '/': { page: { file: 'public/index.html' } }, '/s/*': { static: { directory: 'public' } } }, { 'public/index.html': html, 'public/logo.png': Buffer.alloc(4096, 1) },
    { policies: { compression: { encodings: ['gzip','br'], level: 6 } } });
  const runtime = await createRuntime(root, { log: () => {} }); t.after(() => runtime.close());
  const plan = runtime.testPlan().policies;
  assert.equal(plan['/']?.compression?.precompressed, 2); assert.equal(plan['/s/*']?.compression?.precompressed, 2); // the PNG is not a listed type
  const app = await serve(t, root);
  const identity = await request(app, '/');
  const identityTag = identity.headers.etag;
  assert.ok(identityTag, 'the identity response carries an ETag');
  const gz = await request(app, '/', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers['content-encoding'], 'gzip'); assert.equal(gz.headers.vary, 'Accept-Encoding');
  assert.equal(gz.headers.etag, identityTag.replace(/"$/, '-gz"')); assert.ok(!String(gz.headers.etag).startsWith('W/'));
  // Served bytes are the precomputed variant, byte for byte (level 6 in both).
  assert.deepEqual(gz.bytes, zlib.gzipSync(Buffer.from(html), { level: 6 })); assert.equal(decode.gzip(gz.bytes).toString(), html);
  const br = await request(app, '/s/index.html', { headers: { 'accept-encoding': 'br;q=0.9, gzip;q=0.8' } });
  assert.equal(br.headers['content-encoding'], 'br'); assert.equal(decode.br(br.bytes).toString(), html); assert.equal(br.headers.etag, identityTag.replace(/"$/, '-br"'));
  // HEAD reports what GET would send for a precompressed variant.
  const head = await request(app, '/', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(head.headers['content-encoding'], 'gzip'); assert.equal(head.headers['content-length'], String(gz.bytes.length)); assert.equal(head.body, '');
  // Revalidation with either tag stays consistent with what was served.
  const suffixed = await request(app, '/', { headers: { 'accept-encoding': 'gzip', 'if-none-match': gz.headers.etag } });
  assert.equal(suffixed.status, 304); assert.equal(suffixed.headers.etag, gz.headers.etag); assert.equal(suffixed.headers.vary, 'Accept-Encoding'); assert.equal(suffixed.body, '');
  const plain = await request(app, '/', { headers: { 'accept-encoding': 'gzip', 'if-none-match': identity.headers.etag } });
  assert.equal(plain.status, 304);
  const crossed = await request(app, '/', { headers: { 'accept-encoding': 'br', 'if-none-match': gz.headers.etag } });
  assert.equal(crossed.status, 200); assert.equal(crossed.headers['content-encoding'], 'br');
  // Ranges are never compressed; an unlisted type is untouched and does not vary.
  const range = await request(app, '/', { headers: { 'accept-encoding': 'gzip', range: 'bytes=0-9' } });
  assert.equal(range.status, 206); assert.equal(range.headers['content-encoding'], undefined); assert.equal(range.body, html.slice(0, 10)); assert.equal(range.headers.vary, 'Accept-Encoding');
  const png = await request(app, '/s/logo.png', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(png.headers['content-encoding'], undefined); assert.equal(png.headers.vary, undefined); assert.equal(png.bytes.length, 4096);
});

test('function JSON compresses with a weak ETag; Set-Cookie and secrets skip unless allowWithSecrets', async t => {
  // The guest builds the same payload the test expects, so no request data
  // is interpolated into module source.
  const build = "JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: 'item ' + i })) })";
  const payload = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: 'item ' + i })) });
  const root = await project(t, {
    '/json': { function: { source: 'json.mjs' } },
    '/cookie': { function: { source: 'cookie.mjs' } },
    '/secret': { function: { source: 'json.mjs' }, secrets: { KEY: { secret: 'token' } } },
    '/secret-ok': { function: { source: 'json.mjs' }, secrets: { KEY: { secret: 'token' } }, policies: { compression: { allowWithSecrets: true } } },
  }, {
    'json.mjs': `export default () => new Response(${build}, { headers: { 'content-type': 'application/json', etag: '"v1"' } });`,
    'cookie.mjs': `export default () => new Response(${build}, { headers: { 'content-type': 'application/json', 'set-cookie': 'session=abc; HttpOnly' } });`,
  }, { policies: { compression: {} } });
  const app = await serve(t, root, { permissions: await approveBindings(root), environment: { token: 'SUPER_SECRET' } });
  const json = await request(app, '/json', { headers: { 'accept-encoding': 'br' } });
  assert.equal(json.headers['content-encoding'], 'br'); assert.equal(json.headers.etag, 'W/"v1"'); assert.equal(decode.br(json.bytes).toString(), payload);
  const cookie = await request(app, '/cookie', { headers: { 'accept-encoding': 'br' } });
  assert.equal(cookie.headers['content-encoding'], undefined); assert.equal(cookie.body, payload); assert.equal(cookie.headers.vary, 'Accept-Encoding');
  const secret = await request(app, '/secret', { headers: { 'accept-encoding': 'br' } });
  assert.equal(secret.headers['content-encoding'], undefined); assert.equal(secret.body, payload);
  const allowed = await request(app, '/secret-ok', { headers: { 'accept-encoding': 'br' } });
  assert.equal(allowed.headers['content-encoding'], 'br'); assert.equal(decode.br(allowed.bytes).toString(), payload);
});

test('zstd is honoured only when node:zlib provides it; serverless targets delegate the policy', async t => {
  const root = await project(t, { '/z': { respond: { text } } }, {}, { policies: { compression: { encodings: ['zstd','gzip'] } } });
  if (zstdAvailable) {
    const app = await serve(t, root);
    const z = await request(app, '/z', { headers: { 'accept-encoding': 'zstd, gzip' } });
    assert.equal(z.headers['content-encoding'], 'zstd'); assert.equal(decode.zstd(z.bytes).toString(), text);
  } else await assert.rejects(createRuntime(root, { log: () => {} }), /\/z declares policies\.compression\.encodings zstd/);
  const vercel = await project(t, { '/v': { respond: { text }, policies: { compression: {} } } });
  // The platform compresses, so the policy is accepted and dropped rather
  // than refusing a deployment that shares its YAML with a Node host.
  const delegated = await createRuntime(vercel, { log: () => {}, target: 'vercel' }); t.after(() => delegated.close());
  assert.deepEqual(delegated.testPlan().policies['/v']?.compression, { target: 'delegated' });
  const bad = await project(t, { '/b': { respond: { text } } }, {}, { policies: { compression: { types: ['not a type'] } } });
  await assert.rejects(createRuntime(bad, { log: () => {} }), /not a media type/);
});
