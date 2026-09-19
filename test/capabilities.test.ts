import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCapabilities, analyzeProjectCapabilities, analyzeCompiledCapabilities, assertTargetCompatibility } from '../src/capabilities.ts';
import { loadDocument } from '../src/config.ts';
import { compileRoutes } from '../src/router.ts';
import { createRuntime } from '../src/runtime.ts';
import { buildCloudflare } from '../src/build-cloudflare.ts';
import { project, redirect } from './helpers.ts';
import type { CapabilityCatalog } from '../src/capabilities.ts';
import type { RuntimeExtension } from '../src/extensions.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
test('catalog distinguishes implementation, configuration, delegation and unverified deployment', () => {
  const catalog = getCapabilities();
  const row = (name: string) => catalog.capabilities.find(item => item.capability === name)!.targets;
  assert.equal(row('function')['self-hosted']?.support, 'native');
  for (const target of ['aws', 'vercel', 'cloudflare'] as const) {
    assert.equal(row('function')[target]?.support, 'refused');
    assert.equal(row('middleware')[target]?.support, 'refused');
    assert.equal(catalog.targets.find(item => item.target === target)?.deployment, 'unverified');
  }
  for (const name of ['page', 'static', 'download', 'bindings']) {
    assert.equal(row(name).cloudflare?.support, 'refused');
    assert.equal(row(name).aws?.support, 'native');
    assert.equal(row(name).vercel?.support, 'native');
  }
  assert.equal(row('policies.throttle').aws?.support, 'conditional');
  assert.equal(row('policies.compression').cloudflare?.support, 'delegated');
  assert.deepEqual(getCapabilities('node'), getCapabilities('self-hosted'));
  assert.throws(() => getCapabilities('netlify'), /Unknown capability target/);
});

test('CLI works without a project and rejects unknown targets without echoing arguments', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'capabilities', ...args], { encoding: 'utf8', timeout: 10000 });
  const result = run('--target', 'cloudflare', '--json', '--project', '/missing');
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(result.stdout) as CapabilityCatalog;
  assert.deepEqual(catalog.targets, [{ target: 'cloudflare', deployment: 'unverified' }]);
  assert.match(run().stdout, /self-hosted.*cloudflare.*aws.*vercel/);
  const invalid = run('--target', 'SECRET');
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stderr, /SECRET/);
});

test('preflight and compiled IR agree, including inherited and disabled policies', async t => {
  const root = await project(t, {
    '/go': { ...redirect(), policies: { throttle: { partition: 'route' }, cache: false } },
    '/off': { ...redirect(), enabled: false, policies: { throttle: false } },
  }, {}, { policies: { throttle: { quota: 5, window: 60 }, cache: { strategy: 'revalidate' } } });
  const loaded = await loadDocument(root);
  const compiled = await compileRoutes(loaded, {});
  for (const target of ['self-hosted', 'cloudflare', 'aws', 'vercel']) {
    const before = analyzeProjectCapabilities(loaded, target);
    const after = analyzeCompiledCapabilities(loaded.document, compiled, target);
    assert.deepEqual(after, before);
  }
  const aws = analyzeProjectCapabilities(loaded, 'aws');
  assert.equal(aws.compatible, true);
  const cf = analyzeProjectCapabilities(loaded, 'cloudflare');
  assert.deepEqual(cf.issues.map(item => [item.path, item.capability]), [['/go', 'policies.throttle'], ['/off', 'policies.cache']]);
});

test('unsupported routes fail together before sources, bindings, assets or output writes', async t => {
  const root = await project(t, {
    '/checkout': { enabled: false, function: { source: 'missing.mjs' }, secrets: { TOKEN: { secret: 'PRIVATE_SECRET_NAME' } } },
    '/download/private': { download: { file: 'missing.txt' } },
  });
  const loaded = await loadDocument(root);
  const report = analyzeProjectCapabilities(loaded, 'cloudflare');
  assert.deepEqual(report.issues.map(item => item.capability), ['function', 'bindings', 'download']);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_SECRET_NAME|missing\.mjs/);
  assert.throws(() => assertTargetCompatibility(report), /\/checkout[\s\S]*capability: function[\s\S]*\/download\/private[\s\S]*capability: download/);
  const out = join(root, 'never-written');
  await assert.rejects(buildCloudflare(root, { out }), /capability: function/);
  await assert.rejects(access(out));
  for (const target of ['aws', 'vercel'] as const) await assert.rejects(createRuntime(root, { target }), /capability: function/);
});

test('generated site routes participate in compatibility checks', async t => {
  const site = await project(t, {}, {}, { site: { favicon: 'missing.ico' } });
  await assert.rejects(buildCloudflare(site, { out: join(site, 'out') }), /\/favicon.ico[\s\S]*capability: page/);
});

test('extension/policies.extensions report per-extension refusal from the registration\'s own targets, and conditional/unknown without one', async t => {
  const root = await project(t, { '/widget/*': { extension: 'widget' } }, {}, { extensions: { widget: { version: '1', config: {} } } });
  const loaded = await loadDocument(root);
  // Without a resolved registration set, the answer is conditional, never a false native.
  const noHost = analyzeProjectCapabilities(loaded, 'aws');
  const extensionRow = noHost.requirements.find(item => item.capability === 'extension' && item.path === '/widget/*');
  assert.equal(extensionRow?.support, 'conditional');
  // With a registration whose own `targets` excludes this target, it is refused.
  const nodeOnly: RuntimeExtension[] = [{ name: 'widget', version: '1', projectSha256: 'a'.repeat(64), targets: ['node'], schema: {}, activate: () => ({ handle: () => ({ status: 200, headers: [], body: Buffer.alloc(0) }) }) }];
  for (const target of ['aws', 'vercel'] as const) {
    const report = analyzeProjectCapabilities(loaded, target, nodeOnly);
    const row = report.requirements.find(item => item.capability === 'extension' && item.path === '/widget/*');
    assert.equal(row?.support, 'refused', target);
    assert.match(row!.reason, /own declared targets/);
  }
  // The same registration is native on the target it declares.
  const native = analyzeProjectCapabilities(loaded, 'self-hosted', nodeOnly);
  const nativeRow = native.requirements.find(item => item.capability === 'extension' && item.path === '/widget/*');
  assert.equal(nativeRow?.support, 'native');
  // An extension the host file did not register is unknown, not silently native.
  const unregistered = analyzeProjectCapabilities(loaded, 'aws', []);
  const unknownRow = unregistered.requirements.find(item => item.capability === 'extension' && item.path === '/widget/*');
  assert.equal(unknownRow?.support, 'unknown');
});

test('compiled requirements preserve HTTP, inputs, bindings and profile semantics without leaking values', async t => {
  const root = await project(t, {
    '/input/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      methods: ['POST'], request: { body: { format: 'json', maxBytes: 32 } },
      response: { headers: { 'x-example': 'PRIVATE_HEADER_VALUE' } },
      expires: '2030-01-01T00:00:00Z', respond: { text: 'PRIVATE_BODY' },
      env: { NAME: { value: 'PRIVATE_BINDING_VALUE' } },
      policies: { profile: 'route-budget' },
    },
  }, {}, { profiles: { 'route-budget': { throttle: { quota: 5, window: 60, partition: 'route' } } } });
  const loaded = await loadDocument(root);
  const compiled = await compileRoutes(loaded, {});
  const before = analyzeProjectCapabilities(loaded, 'aws');
  const after = analyzeCompiledCapabilities(loaded.document, compiled, 'aws');
  assert.deepEqual(after, before);
  assert.equal(after.compatible, true);
  for (const name of ['respond', 'parameters', 'methods', 'enabled', 'expires', 'request.body', 'response.headers', 'bindings', 'policies.throttle']) {
    assert.ok(after.requirements.some(item => item.capability === name), name);
  }
  assert.doesNotMatch(JSON.stringify(after), /PRIVATE_/);
});

test('doctor distinguishes implemented targets from verified provider deployments', () => {
  const result = spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { providers: string[]; capabilityTargets: CapabilityCatalog['targets'] };
  assert.deepEqual(report.providers, []);
  assert.deepEqual(report.capabilityTargets, getCapabilities().targets);
});
