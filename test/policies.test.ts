import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.ts';
import { createRuntime } from '../src/runtime.ts';
import { effectivePolicies, builtinProfiles } from '../src/policies.ts';
import { validatePlugins } from '../src/plugins.ts';
import { resolveClient, compileTrustedProxies } from '../src/client-address.ts';
import { buildCloudflare } from '../src/build-cloudflare.ts';
import { project, redirect, request } from './helpers.ts';
import type { TestContext } from 'node:test';
import type { Server, ServerOptions } from '../src/server.ts';
import type { ProjectDocument } from '../src/types.ts';
import type { Plugin } from '../src/plugins.ts';
import type { Artifact, Validators } from '../src/cloudflare.ts';
import { HttpError } from '../src/errors.ts';

async function serve(t: TestContext, root: string, options: Partial<ServerOptions> = {}): Promise<Server> {
  const app = await startServer({ project: root, port: 0, log: () => {}, ...options }); t.after(() => app.close()); return app;
}

test('effective policies layer profile, project keys and route keys; false disables', () => {
  // A project layer may declare part of a policy; the profile supplies the rest.
  const document: ProjectDocument = { version: '1', routes: {}, policies: { profile: 'hardened', throttle: { quota: 5 } }, profiles: { mine: { security: { headers: 'oshp-no-csp' } } } };
  const project = effectivePolicies(document, {});
  assert.equal(project.throttle?.quota, 5);
  const hardened = builtinProfiles['hardened']?.throttle;
  assert.ok(hardened, 'the hardened profile declares a throttle');
  assert.equal(project.throttle?.window, hardened.window);
  assert.deepEqual(project.security, { headers: 'oshp' });
  const route = effectivePolicies(document, { policies: { profile: 'mine', throttle: false, cache: { strategy: 'swr', maxAge: 3 } } });
  assert.equal(route.throttle, undefined);
  assert.deepEqual(route.security, { headers: 'oshp-no-csp' });
  assert.deepEqual(route.cache, { strategy: 'swr', maxAge: 3 });
  assert.throws(() => effectivePolicies({ version: '1', routes: {}, policies: { profile: 'nope' } }, {}), /Unknown policy profile/);
  // A custom profile shadows a built-in of the same name.
  assert.deepEqual(effectivePolicies({ version: '1', routes: {}, policies: { profile: 'hardened' }, profiles: { hardened: { security: { headers: 'off' } } } }, {}), { security: { headers: 'off' } });
});

test('policies validate in YAML and unknown keys fail', async t => {
  const ok = await project(t, { '/go': { ...redirect(), policies: { security: { headers: 'oshp' } } } }, {}, { policies: { profile: 'hardened' } });
  const runtime = await createRuntime(ok, { log: () => {} });
  t.after(() => runtime.close());
  const plan = runtime.testPlan();
  assert.deepEqual(plan.inventory[0]?.policies.sort(), ['agents','cache','compression','security','throttle']);
  assert.equal(plan.policies['/go']?.security?.target, 'native');
  const bad = await project(t, { '/go': redirect() }, {}, { policies: { unknown: {} } });
  await assert.rejects(createRuntime(bad, { log: () => {} }), /Invalid configuration/);
  // Route-level keys merge over the project layer, so a partial override is
  // valid YAML; what is missing after merging is reported by the policy.
  const badRoute = await project(t, { '/go': { ...redirect(), policies: { throttle: { quota: 1 } } } });
  await assert.rejects(createRuntime(badRoute, { log: () => {} }), /policies\.throttle\.window on \/go/);
  const partial = await project(t, { '/go': { ...redirect(), policies: { throttle: { quota: 1 } } } }, {}, { policies: { throttle: { quota: 9, window: 60 } } });
  const merged = await createRuntime(partial, { log: () => {} }); t.after(() => merged.close());
  assert.equal(merged.testPlan().policies['/go']?.throttle?.quota, 1);
});

test('host plugins short-circuit, observe responses and errors, and are refused off-target', async t => {
  const root = await project(t, { '/go': redirect(), '/deny': redirect() });
  const seen: unknown[][] = [];
  const plugin: Plugin = { name: 'audit', version: '1.0.0', targets: ['node'],
    onActivate(runtime) {
      const plan = runtime.testPlan();
      seen.push(['activate', plan.inventory.length]);
    },
    onRequest(req) { seen.push(['request', req.route, req.client]); if (req.path === '/deny') return { status: 451, headers: [], body: Buffer.from('no') }; return undefined; },
    onResponse(req, result) { return { ...result, headers: [...result.headers, ['x-plugin', 'seen']] }; },
    onError(req, error) { seen.push(['error', error instanceof HttpError ? error.status : undefined]); },
    onClose() { seen.push(['close']); } };
  const app = await serve(t, root, { plugins: [plugin] });
  const ok = await request(app, '/go');
  assert.equal(ok.status, 302); assert.equal(ok.headers['x-plugin'], 'seen');
  const denied = await request(app, '/deny');
  assert.equal(denied.status, 451); assert.equal(denied.headers['x-plugin'], 'seen');
  await request(app, '/go', { method: 'POST' });
  assert.deepEqual(seen[0], ['activate', 2]);
  assert.deepEqual(seen[1], ['request', '/go', '127.0.0.1']);
  await app.close();
  assert.deepEqual(seen.at(-1), ['close']);
  assert.throws(() => validatePlugins([{ ...plugin, targets: ['vercel'] }], 'node'), /does not support the node target/);
  assert.throws(() => validatePlugins([{ name: 'Bad Name', version: '1', targets: ['node'], onRequest() {} }]), /kebab-case/);
  assert.throws(() => validatePlugins([{ name: 'x', version: '1', targets: ['node'] }]), /declares no hooks/);
});

test('client identity trusts forwarded headers only from configured proxies', () => {
  const trusted = compileTrustedProxies('10.0.0.0/8, ::1, 192.168.1.5');
  assert.equal(resolveClient('203.0.113.9', '198.51.100.1', trusted), '203.0.113.9');
  assert.equal(resolveClient('10.1.2.3', '198.51.100.1, 10.0.0.7', trusted), '198.51.100.1');
  assert.equal(resolveClient('10.1.2.3', '10.0.0.7', trusted), '10.0.0.7');
  assert.equal(resolveClient('::ffff:10.1.2.3', '2001:db8::1', trusted), '2001:db8::1');
  assert.equal(resolveClient('10.1.2.3', 'garbage, 198.51.100.1', trusted), '198.51.100.1');
  assert.equal(resolveClient('203.0.113.9', undefined, []), '203.0.113.9');
  assert.throws(() => compileTrustedProxies('10.0.0.0/33'), /prefix/);
});

test('cloudflare build refuses policies it cannot compile', async t => {
  const root = await project(t, { '/go': { ...redirect(), policies: { throttle: { quota: 1, window: 1 } } } });
  await assert.rejects(buildCloudflare(root, { out: `${root}/dist` }), /policies\.throttle cannot be compiled/);
});

test('interoperability: conditional requests bypass origin hits, 405 carries policy headers, probes identify themselves', async t => {
  const { gzipSync } = await import('node:zlib');
  const page = '<html>' + 'x'.repeat(4096) + '</html>';
  const root = await project(t, {
    '/page': { page: { file: 'public/page.html' }, policies: { cache: { strategy: 'swr', maxAge: 60, staleWhileRevalidate: 60 }, compression: { minBytes: 16 } } },
    '/only-post': { methods: ['POST'], respond: { text: 'posted' } },
    '/empty-ua': { redirect: { url: 'https://example.com/' }, policies: { agents: { denyEmpty: true } } },
  }, { 'public/page.html': page }, { policies: { security: { headers: 'oshp' }, throttle: { quota: 50, window: 60, partition: 'route' } } });
  const app = await serve(t, root);
  const first = await request(app, '/page', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(first.status, 200); assert.equal(first.headers['content-encoding'], 'gzip');
  // A hit exists now; validators and ranges still reach the handler.
  const identityTag = (await request(app, '/page')).headers.etag;
  assert.equal((await request(app, '/page', { headers: { 'if-none-match': identityTag } })).status, 304);
  assert.equal((await request(app, '/page', { headers: { range: 'bytes=0-9' } })).status, 206);
  // HEAD on a hit reports the encoded length of the variant GET would send.
  const head = await request(app, '/page', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(head.headers['content-encoding'], 'gzip');
  assert.equal(head.headers['content-length'], String(gzipSync(Buffer.from(page), { level: 9 }).length));
  // 405 passes through the response phase.
  const wrong = await request(app, '/only-post');
  assert.equal(wrong.status, 405); assert.equal(wrong.headers['x-frame-options'], 'deny'); assert.match(String(wrong.headers['ratelimit']), /r=\d+/);
  // Generated probes send a User-Agent, so denyEmpty does not fail an audit.
  const { auditProject } = await import('../src/readiness.ts');
  const report = await auditProject(app, { expectRoutes: 3 });
  assert.equal(report.failed, 0);
  assert.equal((await request(app, '/empty-ua', { headers: { 'user-agent': '' } })).status, 403);
});

test('security set cannot take over headers other policies own', async t => {
  const root = await project(t, { '/go': { ...redirect(), policies: { security: { set: { Vary: 'Origin' } } } } });
  await assert.rejects(createRuntime(root, { log: () => {} }), /policies\.security on \/go/);
});

test('error responses carry the security headers of the matched route or the project', async t => {
  const root = await project(t, {
    '/gone': { ...redirect(), expires: '2020-01-01T00:00:00Z' },
    '/bare': { ...redirect(), expires: '2020-01-01T00:00:00Z', policies: { security: false } },
    '/strict': { ...redirect(), expires: '2020-01-01T00:00:00Z', policies: { security: { headers: 'oshp', set: { 'X-Frame-Options': 'sameorigin' } } } },
    '/post': { methods: ['POST'], request: { body: { maxBytes: 8 } }, respond: { text: 'ok' } },
  }, {}, { policies: { security: { headers: 'oshp-no-csp' } } });
  const app = await serve(t, root, { origin: 'https://links.example' });
  // No route matched: project-level headers, including HSTS on an https origin.
  const missing = await request(app, '/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['x-frame-options'], 'deny');
  assert.equal(missing.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  assert.equal(missing.headers['content-security-policy'], undefined);
  assert.equal(missing.headers['cache-control'], 'no-store');
  // Matched routes use their own effective policy.
  assert.equal((await request(app, '/gone')).headers['x-frame-options'], 'deny');
  assert.equal((await request(app, '/bare')).headers['x-frame-options'], undefined);
  assert.equal((await request(app, '/strict')).headers['x-frame-options'], 'sameorigin');
  // A host-side error before handle() (oversized body) gets the project's.
  const big = await request(app, '/post', { method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': '64' }, body: 'x'.repeat(64) });
  assert.equal(big.status, 413);
  assert.equal(big.headers['x-frame-options'], 'deny');
  // HEAD errors keep the headers and drop the body.
  const head = await request(app, '/nope', { method: 'HEAD' });
  assert.equal(head.body, ''); assert.equal(head.headers['x-frame-options'], 'deny');
});

test('cloudflare error responses match the self-hosted server', async t => {
  const { createFetchHandler } = await import('../src/cloudflare.ts');
  const routes = {
    '/gone': { ...redirect(), expires: '2020-01-01T00:00:00Z' },
    '/bare': { ...redirect(), expires: '2020-01-01T00:00:00Z', policies: { security: false } },
    '/only-post': { methods: ['POST'], respond: { text: 'posted' } },
  };
  const root = await project(t, routes, {}, { policies: { security: { headers: 'oshp' } } });
  const out = `${root}/dist`;
  await buildCloudflare(root, { out });
  const { pathToFileURL } = await import('node:url');
  const artifact: Artifact = (await import(pathToFileURL(`${out}/artifact.js`).href)).default, validators: Validators = await import(pathToFileURL(`${out}/validators.js`).href);
  assert.deepEqual(artifact.policies, { security: { headers: 'oshp' } });
  const worker = createFetchHandler(artifact, validators);
  const app = await serve(t, root, { origin: 'https://links.example' });
  const probes: Array<[string, string]> = [['/nope','GET'], ['/gone','GET'], ['/bare','GET'], ['/only-post','GET'], ['/nope','HEAD']];
  for (const [path, method] of probes) {
    const node = await request(app, path, { method });
    const edge = await worker(new Request(`https://links.example${path}`, { method }));
    assert.equal(edge.status, node.status, path);
    for (const name of ['x-frame-options','strict-transport-security','content-security-policy','referrer-policy','cache-control','x-content-type-options','allow']) {
      assert.equal(edge.headers.get(name), node.headers[name] ?? null, `${path} ${name}`);
    }
  }
});
