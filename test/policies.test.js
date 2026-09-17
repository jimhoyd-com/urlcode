import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';
import { createRuntime } from '../src/runtime.js';
import { effectivePolicies, builtinProfiles } from '../src/policies.js';
import { validatePlugins } from '../src/plugins.js';
import { resolveClient, compileTrustedProxies } from '../src/client-address.js';
import { buildCloudflare } from '../src/build-cloudflare.js';
import { project, redirect, request } from './helpers.js';

async function serve(t, root, options = {}) {
  const app = await startServer({ project: root, port: 0, log: () => {}, ...options }); t.after(() => app.close()); return app;
}

test('effective policies layer profile, project keys and route keys; false disables', () => {
  const document = { policies: { profile: 'hardened', throttle: { quota: 5 } }, profiles: { mine: { security: { headers: 'oshp-no-csp' } } } };
  const project = effectivePolicies(document, {});
  assert.equal(project.throttle.quota, 5);
  assert.equal(project.throttle.window, builtinProfiles.hardened.throttle.window);
  assert.deepEqual(project.security, { headers: 'oshp' });
  const route = effectivePolicies(document, { policies: { profile: 'mine', throttle: false, cache: { strategy: 'swr', maxAge: 3 } } });
  assert.equal(route.throttle, undefined);
  assert.deepEqual(route.security, { headers: 'oshp-no-csp' });
  assert.deepEqual(route.cache, { strategy: 'swr', maxAge: 3 });
  assert.throws(() => effectivePolicies({ policies: { profile: 'nope' } }, {}), /Unknown policy profile/);
  // A custom profile shadows a built-in of the same name.
  assert.deepEqual(effectivePolicies({ policies: { profile: 'hardened' }, profiles: { hardened: { security: { headers: 'off' } } } }, {}), { security: { headers: 'off' } });
});

test('policies validate in YAML and unknown keys fail', async t => {
  const ok = await project(t, { '/go': { ...redirect(), policies: { security: { headers: 'oshp' } } } }, {}, { policies: { profile: 'hardened' } });
  const runtime = await createRuntime(ok, { log: () => {} });
  t.after(() => runtime.close());
  const plan = runtime.testPlan();
  assert.deepEqual(plan.inventory[0].policies.sort(), ['agents','cache','compression','security','throttle']);
  assert.equal(plan.policies['/go'].security.target, 'native');
  const bad = await project(t, { '/go': redirect() }, {}, { policies: { unknown: {} } });
  await assert.rejects(createRuntime(bad, { log: () => {} }), /Invalid configuration/);
  const badRoute = await project(t, { '/go': { ...redirect(), policies: { throttle: { quota: 1 } } } });
  await assert.rejects(createRuntime(badRoute, { log: () => {} }), /Invalid configuration/);
});

test('host plugins short-circuit, observe responses and errors, and are refused off-target', async t => {
  const root = await project(t, { '/go': redirect(), '/deny': redirect() });
  const seen = [];
  const plugin = { name: 'audit', version: '1.0.0', targets: ['node'],
    onActivate(runtime) { seen.push(['activate', runtime.testPlan().inventory.length]); },
    onRequest(req) { seen.push(['request', req.route, req.client]); if (req.path === '/deny') return { status: 451, headers: [], body: Buffer.from('no') }; },
    onResponse(req, result) { return { ...result, headers: [...result.headers, ['x-plugin', 'seen']] }; },
    onError(req, error) { seen.push(['error', error.status]); },
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
