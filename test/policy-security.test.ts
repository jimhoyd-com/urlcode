import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../src/server.ts';
import { createRuntime } from '../src/runtime.ts';
import { buildCloudflare } from '../src/build-cloudflare.ts';
import { createFetchHandler } from '../src/cloudflare.ts';
import { profiles, compile, onResponse, describe, reservedHeaders } from '../src/policies/security.ts';
import { project, redirect, request } from './helpers.ts';
import type { TestContext } from 'node:test';
import type { Server, ServerOptions } from '../src/server.ts';
import type { SecurityConfig } from '../src/policies/security.ts';
import type { Plugin } from '../src/plugins.ts';
import type { Artifact, Validators } from '../src/cloudflare.ts';

const log = () => {};
async function serve(t: TestContext, root: string, options: Partial<ServerOptions> = {}): Promise<Server> {
  const app = await startServer({ project: root, port: 0, log, ...options }); t.after(() => app.close()); return app;
}
type Profile = readonly (readonly [string, string])[];
const profileNames = (profile: Profile) => profile.map(([key]) => key);
// The profile table is keyed by name; a test names only profiles the module ships.
function profile(name: string): Profile { const found = profiles[name]; assert.ok(found, `profile ${name} exists`); return found; }

test('profile tables are frozen, ordered and consistent with each other', () => {
  assert.ok(Object.isFrozen(profiles) && Object.isFrozen(profile('oshp')));
  assert.deepEqual(profileNames(profile('oshp-no-csp')), profileNames(profile('oshp')).filter(key => key !== 'content-security-policy'));
  assert.deepEqual(profile('off'), []);
  // Owned elsewhere: the runtime (nosniff) and the cache policy.
  assert.ok(!profileNames(profile('oshp')).includes('x-content-type-options'));
  assert.ok(!profileNames(profile('oshp')).includes('cache-control'));
  assert.ok(reservedHeaders.has('cache-control') && reservedHeaders.has('content-type'));
  // Every profile value passes the same header rules the wire enforces.
  for (const [key, value] of profile('oshp')) assert.doesNotMatch(key + value, /[\u0000-\u001f\u007f]/u);
});

test('profile headers land on redirects, declared responses and function results; existing headers win', async t => {
  const root = await project(t, {
    '/go': redirect(),
    '/hello': { respond: { json: { ok: true } }, response: { headers: { 'X-Frame-Options': 'sameorigin', 'x-demo': 'yes' } } },
    '/f': { function: { source: 'f.mjs' } },
  }, { 'f.mjs': 'export default () => new Response("x", { headers: { "referrer-policy": "no-referrer" } });' },
  { policies: { security: { headers: 'oshp' } } });
  const app = await serve(t, root);

  const go = await request(app, '/go');
  assert.equal(go.status, 302);
  for (const [key, value] of profile('oshp')) if (key !== 'strict-transport-security') assert.equal(go.headers[key], value, key);
  assert.equal(go.headers['x-content-type-options'], 'nosniff');
  assert.equal(go.headers['cache-control'], 'no-store');

  // YAML response.headers are applied before the profile and are kept.
  const hello = await request(app, '/hello');
  assert.equal(hello.headers['x-frame-options'], 'sameorigin');
  assert.equal(hello.headers['x-demo'], 'yes');
  assert.equal(hello.headers['content-security-policy'], Object.fromEntries(profile('oshp'))['content-security-policy']);

  // A function's own header is kept too; the rest of the profile fills in.
  const fn = await request(app, '/f');
  assert.equal(fn.status, 200);
  assert.equal(fn.headers['referrer-policy'], 'no-referrer');
  assert.equal(fn.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(fn.headers['permissions-policy'], Object.fromEntries(profile('oshp'))['permissions-policy']);
});

test('set overrides the profile and existing headers; unset drops a profile header', async t => {
  const root = await project(t, {
    '/go': { ...redirect(), response: { headers: { 'x-frame-options': 'sameorigin' } } },
  }, {}, { policies: { security: { headers: 'oshp',
    set: { 'X-Frame-Options': 'deny', 'Content-Security-Policy-Report-Only': "default-src 'self'", 'Clear-Site-Data': '"cache"' },
    unset: ['Cross-Origin-Embedder-Policy'] } } });
  const app = await serve(t, root);
  const res = await request(app, '/go');
  // Explicit operator intent beats the route's own header.
  assert.equal(res.headers['x-frame-options'], 'deny');
  assert.equal(res.headers['content-security-policy-report-only'], "default-src 'self'");
  assert.equal(res.headers['clear-site-data'], '"cache"');
  assert.equal(res.headers['cross-origin-embedder-policy'], undefined);
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
});

test('HSTS follows the request origin scheme', async t => {
  const root = await project(t, { '/go': redirect() }, {}, { policies: { security: { headers: 'oshp' } } });
  const plain = await serve(t, root);
  assert.equal((await request(plain, '/go')).headers['strict-transport-security'], undefined);
  const secure = await serve(t, root, { origin: 'https://links.example' });
  assert.equal((await request(secure, '/go')).headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  // The header cannot be smuggled onto a plain-text origin through a proxy header.
  assert.equal((await request(plain, '/go', { headers: { 'x-forwarded-proto': 'https' } })).headers['strict-transport-security'], undefined);
});

test('oshp-no-csp omits the policy header and off emits nothing', async t => {
  const root = await project(t, {
    '/nocsp': { ...redirect(), policies: { security: { headers: 'oshp-no-csp' } } },
    '/off': { ...redirect(), policies: { security: { headers: 'off' } } },
  }, {}, { policies: { security: { headers: 'oshp' } } });
  const app = await serve(t, root, { origin: 'https://links.example' });
  const nocsp = await request(app, '/nocsp');
  assert.equal(nocsp.headers['content-security-policy'], undefined);
  assert.equal(nocsp.headers['x-frame-options'], 'deny');
  assert.equal(nocsp.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  const off = await request(app, '/off');
  for (const key of profileNames(profile('oshp'))) assert.equal(off.headers[key], undefined, key);
  assert.equal(off.headers['x-content-type-options'], 'nosniff');
});

test('invalid, reserved and unknown header adjustments are refused at activation with the route named', async t => {
  const refused: Array<[SecurityConfig, RegExp]> = [
    [{ set: { 'bad name': 'x' } }, /\/go.*invalid set header "bad name"/],
    [{ set: { 'x-ok': 'line\nbreak' } }, /\/go.*invalid set header "x-ok"/],
    [{ set: { 'Content-Length': '3' } }, /\/go.*"Content-Length" is owned by the runtime/],
    [{ set: { 'Cache-Control': 'no-store' } }, /\/go.*"Cache-Control" is owned by the runtime/],
    [{ set: { 'x-a': '1', 'X-A': '2' } }, /\/go.*duplicate set header/],
    [{ unset: ['X-Nope'] }, /\/go.*unset names "X-Nope", which the oshp profile does not emit/],
    [{ headers: 'oshp-no-csp', unset: ['content-security-policy'] }, /\/go.*oshp-no-csp profile does not emit/],
    [{ set: { 'x-b1': 'v'.repeat(4000), 'x-b2': 'v'.repeat(4000), 'x-b3': 'v'.repeat(4000) } }, /\/go.*static headers exceed 8192 bytes/],
  ];
  for (const [security, expected] of refused) {
    const root = await project(t, { '/go': redirect() }, {}, { policies: { security } });
    let error: unknown;
    try { const runtime = await createRuntime(root, { log }); await runtime.close(); } catch (caught) { error = caught; }
    assert.ok(error instanceof Error, `expected ${expected} to reject`);
    assert.match(error.message + '\n' + (error.cause instanceof Error ? error.cause.message : ''), expected);
  }
});

test('describe reports the profile and every adjustment; onResponse needs no body', () => {
  const state = compile({ headers: 'oshp', set: { 'X-Custom': 'v' }, unset: ['X-Frame-Options'] }, { route: { pattern: '/x' } });
  assert.ok(!(state instanceof Promise), 'compile is synchronous');
  assert.deepEqual(profileNames(state.profile), profileNames(profile('oshp')).filter(key => key !== 'x-frame-options'));
  const summary = describe(state);
  assert.equal(summary.headers, 'oshp');
  assert.deepEqual(summary.emits, profileNames(state.profile));
  assert.deepEqual(summary.set, ['x-custom']);
  assert.deepEqual(summary.unset, ['x-frame-options']);
  assert.ok(summary.bytes > 0 && summary.bytes <= 8192);
  const out = onResponse(state, { origin: 'https://a.example' }, { status: 429, headers: [['retry-after', '3']] });
  assert.equal(out.body, undefined);
  assert.deepEqual(out.headers[0], ['retry-after', '3']);
  assert.ok(out.headers.some(([key]) => key === 'strict-transport-security'));
  assert.ok(out.headers.some(([key, value]) => key === 'x-custom' && value === 'v'));
  assert.ok(!out.headers.some(([key]) => key === 'x-frame-options'));
  // A profile with nothing to add hands the result back untouched.
  const off = compile({ headers: 'off' }, { route: { pattern: '/x' } });
  const same = { status: 200, headers: [] };
  assert.equal(onResponse(off, { origin: 'http://a' }, same), same);
});

test('early results that skip the handler still carry the profile', async t => {
  const root = await project(t, { '/go': redirect() }, {}, { policies: { security: { headers: 'oshp' } } });
  const plugin: Plugin = { name: 'deny', version: '1.0.0', targets: ['node'],
    onRequest() { return { status: 451, headers: [['x-frame-options', 'sameorigin']], body: Buffer.from('no') }; } };
  const app = await serve(t, root, { plugins: [plugin] });
  const denied = await request(app, '/go');
  assert.equal(denied.status, 451);
  assert.equal(denied.headers['x-frame-options'], 'sameorigin');
  assert.equal(denied.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(denied.headers['cross-origin-resource-policy'], 'same-origin');
});

test('the Worker emits the same security headers as the self-hosted server', async t => {
  const root = await project(t, {
    '/go': redirect(),
    '/hello': { respond: { text: 'hi' }, response: { headers: { 'x-frame-options': 'sameorigin' } } },
    '/nocsp': { ...redirect(), policies: { security: { headers: 'oshp-no-csp', set: { 'X-Extra': '1' }, unset: ['X-Permitted-Cross-Domain-Policies'] } } },
  }, {}, { policies: { security: { headers: 'oshp' } } });
  const hosted = await serve(t, root, { origin: 'https://links.example' });
  const out = await mkdtemp(join(tmpdir(), 'urlcode-cf-sec-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  await buildCloudflare(root, { out });
  const artifact: Artifact = (await import(pathToFileURL(join(out, 'artifact.js')).href)).default;
  const validators: Validators = await import(pathToFileURL(join(out, 'validators.js')).href);
  const fetch = createFetchHandler(artifact, validators);
  const keys = [...profileNames(profile('oshp')), 'x-extra', 'x-content-type-options', 'cache-control'];
  for (const path of ['/go', '/hello', '/nocsp']) {
    const a = await request(hosted, path);
    const b = await fetch(new Request(`https://links.example${path}`));
    const headers = Object.fromEntries([...b.headers]);
    assert.equal(b.status, a.status, path);
    for (const key of keys) assert.equal(headers[key], a.headers[key], `${key} differs for ${path}`);
    assert.equal(headers['strict-transport-security'], 'max-age=31536000; includeSubDomains', path);
  }
  const plain = await fetch(new Request('http://links.example/go'));
  assert.equal(plain.headers.get('strict-transport-security'), null);
});
