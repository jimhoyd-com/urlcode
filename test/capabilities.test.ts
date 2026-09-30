import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCapabilities, analyzeProjectCapabilities, analyzeCompiledCapabilities, assertTargetCompatibility } from '../packages/core/src/capabilities.ts';
import { loadDocument } from '../packages/core/src/config.ts';
import { compileRoutes } from '../packages/core/src/router.ts';
import { createRuntime } from '../packages/core/src/runtime.ts';
import { buildCloudflare } from '../packages/core/src/build-cloudflare.ts';
import { project, redirect, spawnAsync } from './helpers.ts';
import type { CapabilityCatalog } from '../packages/core/src/capabilities.ts';
import type { RuntimeExtension } from '../packages/core/src/extensions.ts';

const cli = fileURLToPath(new URL('../packages/core/src/cli.ts', import.meta.url));
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

test('CLI works without a project and rejects unknown targets without echoing arguments', async () => {
  const run = (...args: string[]) => spawnAsync(process.execPath, [cli, 'capabilities', ...args], { encoding: 'utf8', timeout: 10000 });
  // Three independent runs: started together, checked in order.
  const [result, plain, invalid] = await Promise.all([run('--target', 'cloudflare', '--json', '--project', '/missing'), run(), run('--target', 'SECRET')]);
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(result.stdout) as CapabilityCatalog;
  assert.deepEqual(catalog.targets, [{ target: 'cloudflare', deployment: 'unverified' }]);
  assert.match(plain.stdout, /self-hosted.*cloudflare.*aws.*vercel/);
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stderr, /SECRET/);
});

test('validate and capabilities refuse an extension on a target its installed descriptor does not declare (#867)', async t => {
  const site = await mkdtemp(join(tmpdir(), 'urlcode-targets-site-'));
  t.after(() => rm(site, { recursive: true, force: true }));
  const app = join(site, 'app'), installed = join(site, 'node_modules', '@jimhoyd', 'urlcode-store');
  await mkdir(app); await mkdir(installed, { recursive: true });
  const descriptor = JSON.parse(await readFile(new URL('../packages/store/urlcode.json', import.meta.url), 'utf8')) as { targets: string[] };
  assert.deepEqual(descriptor.targets, ['node'], 'the store declares only node');
  const install = (targets: string[]) => writeFile(join(installed, 'urlcode.json'), JSON.stringify({ ...descriptor, targets }));
  await install(descriptor.targets);
  await writeFile(join(app, 'urlcode.yaml'), JSON.stringify({ version: '1',
    extensions: { store: { version: '1', config: { collections: { todos: { mount: '/api/todos', schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 80 } } } } } } } },
    routes: { '/api/todos/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST'] } } }));
  const run = (...args: string[]) => spawnAsync(process.execPath, ['--conditions=development', cli, ...args], { encoding: 'utf8', timeout: 20000 });
  const extensionRow = (catalog: CapabilityCatalog, target: 'self-hosted' | 'aws' | 'vercel') => catalog.capabilities.find(row => row.capability === 'extension')!.targets[target]!;

  // Every run until the descriptor changes below is an independent read of one site: started together, checked in order.
  const [valid, refusedAws, refusedVercel, cloudflare, netlify, catalogRun, capabilitiesText, genericRun] = await Promise.all([
    run('validate', '--project', app), run('validate', '--project', app, '--target', 'aws'), run('validate', '--project', app, '--target', 'vercel'),
    run('validate', '--project', app, '--target', 'cloudflare'), run('validate', '--project', app, '--target', 'netlify'),
    run('capabilities', '--project', app, '--json'), run('capabilities', '--project', app), run('capabilities', '--project', join(site, 'missing'), '--json')]);
  // validate: self-hosted by default, which the store declares; aws and vercel are refused before any host file.
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual((JSON.parse(valid.stdout) as { event: string; target: string }).target, 'self-hosted');
  for (const [target, refused] of [['aws', refusedAws], ['vercel', refusedVercel]] as const) {
    assert.equal(refused.status, 1, target);
    assert.match(refused.stderr, /Refused by the extension's declared targets \(its urlcode\.json\): store/, target);
  }
  assert.match(cloudflare.stderr, /Operator extensions have no Worker artifact lowering/);
  assert.equal(netlify.status, 1, 'an unknown target fails');

  // capabilities: in the site, the extension rows follow the store's declared targets; without a project they stay generic.
  const catalog = JSON.parse(catalogRun.stdout) as CapabilityCatalog;
  assert.deepEqual(catalog.extensions, ['store']);
  assert.equal(extensionRow(catalog, 'aws').support, 'refused'); assert.match(extensionRow(catalog, 'aws').reason, /store/);
  assert.equal(extensionRow(catalog, 'vercel').support, 'refused');
  assert.equal(extensionRow(catalog, 'self-hosted').support, 'conditional', 'a descriptor can refuse a target, never confirm one');
  assert.match(capabilitiesText.stdout, /extension rows use the declared targets of this project's extensions: store/);
  const generic = JSON.parse(genericRun.stdout) as CapabilityCatalog;
  assert.equal(generic.extensions, undefined); assert.equal(extensionRow(generic, 'aws').support, 'conditional');

  // The installed descriptor, not the release catalog, decides: one that also declares aws is not refused there.
  await install(['node', 'aws']);
  const [validAws, catalogAws, stillRefusedVercel] = await Promise.all([run('validate', '--project', app, '--target', 'aws'), run('capabilities', '--project', app, '--target', 'aws', '--json'), run('validate', '--project', app, '--target', 'vercel')]);
  assert.equal(validAws.status, 0);
  assert.equal(extensionRow(JSON.parse(catalogAws.stdout) as CapabilityCatalog, 'aws').support, 'conditional');
  assert.equal(stillRefusedVercel.status, 1);
});

test('explain, manifest, context and review use installed descriptor targets without a host file (#875)', async t => {
  const site = await mkdtemp(join(tmpdir(), 'urlcode-targets-tools-'));
  t.after(() => rm(site, { recursive: true, force: true }));
  const app = join(site, 'app'), installed = join(site, 'node_modules', '@jimhoyd', 'urlcode-store');
  await mkdir(app); await mkdir(installed, { recursive: true });
  const descriptor = JSON.parse(await readFile(new URL('../packages/store/urlcode.json', import.meta.url), 'utf8')) as { targets: string[] };
  const install = (targets: string[]) => writeFile(join(installed, 'urlcode.json'), JSON.stringify({ ...descriptor, targets }));
  await install(['node']);
  await writeFile(join(app, 'hit.mjs'), 'let hits = 0;\nexport default function(request){\n  hits++;\n  return {status:200,body:String(hits)};\n}\n');
  await writeFile(join(app, 'urlcode.yaml'), JSON.stringify({ version: '1',
    extensions: { store: { version: '1', config: { collections: { todos: { mount: '/api/todos', schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 80 } } } } } } } },
    routes: { '/api/todos/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST'] }, '/hit': { methods: ['GET'], function: { source: 'hit.mjs' } } } }));
  const run = async (...args: string[]) => { const result = await spawnAsync(process.execPath, ['--conditions=development', cli, ...args, '--project', app], { encoding: 'utf8', timeout: 20000 }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  type Support = { compatible: boolean; issues: { capability: string; support: string; reason: string }[] };

  const reviewRun = (target?: string) => run('review', '--json', ...(target ? ['--target', target] : []));
  // Every run until the descriptor changes below is an independent read of one site: started together, checked in order.
  const [explainedJson, explainedAws, manifestJson, manifestText, contextJson, reviewPlain, reviewSelfHosted, reviewAws] = await Promise.all([
    run('explain', '/api/todos/x', '--json'), run('explain', '/api/todos/x', '--target', 'aws'), run('manifest', '--json'), run('manifest'), run('context', '--json'),
    reviewRun(), reviewRun('self-hosted'), reviewRun('aws')]);
  const explained = JSON.parse(explainedJson) as { targets: Record<string, Support> };
  const extensionIssue = (support: Support) => support.issues.find(issue => issue.capability === 'extension');
  assert.equal(extensionIssue(explained.targets.aws!)?.support, 'refused'); assert.match(extensionIssue(explained.targets.aws!)!.reason, /declared targets.*store/);
  assert.equal(extensionIssue(explained.targets.vercel!)?.support, 'refused');
  assert.equal(extensionIssue(explained.targets['self-hosted']!)?.support, 'conditional', 'a descriptor can refuse a target, never confirm one');
  assert.match(explainedAws, /target aws: extension refused \(Refused by the extension's declared targets/);

  const manifest = JSON.parse(manifestJson) as { targets: Record<string, { compatible: boolean; issues: number; refused: number }> };
  assert.equal(manifest.targets.aws!.compatible, false); assert.equal(manifest.targets.aws!.refused, 3, 'the project, the store mount and the function route');
  assert.equal(manifest.targets['self-hosted']!.refused, 0);
  assert.match(manifestText, /aws \d+ issues \(3 refused\)/);

  const context = JSON.parse(contextJson) as { targets: Record<string, { refused: string[]; conditional: string[] }> };
  assert.ok(context.targets.aws!.refused.includes('extension')); assert.ok(context.targets['self-hosted']!.conditional.includes('extension'));

  const observation = (stdout: string) => (JSON.parse(stdout) as { observations: { signal: string; category: string; extension?: string; refusedOn?: string; note: string }[] }).observations.find(item => item.signal === 'global-mutable-state')!;
  assert.equal(observation(reviewPlain).category, 'extension-alternative'); assert.equal(observation(reviewSelfHosted).refusedOn, undefined);
  const refused = observation(reviewAws);
  assert.equal(refused.category, 'gap'); assert.equal(refused.refusedOn, 'aws'); assert.equal(refused.extension, undefined); assert.match(refused.note, /store is declared but does not run on aws/);

  // A descriptor that declares aws is not refused there.
  await install(['node', 'aws']);
  const [explainedAgain, reviewedAgain] = await Promise.all([run('explain', '/api/todos/x', '--json'), reviewRun('aws')]);
  assert.equal(extensionIssue((JSON.parse(explainedAgain) as { targets: Record<string, Support> }).targets.aws!)?.support, 'conditional');
  assert.equal(observation(reviewedAgain).category, 'extension-alternative');
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
      methods: ['POST'], request: { body: { POST: { format: 'json', maxBytes: 32 } } },
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

test('serverless partition: route throttle reports delegated with the quota-times-instances caveat, not native (#553)', async t => {
  const root = await project(t, { '/go': { ...redirect(), policies: { throttle: { partition: 'route' } } } }, {}, { policies: { throttle: { quota: 5, window: 60 } } });
  const loaded = await loadDocument(root);
  for (const target of ['aws', 'vercel'] as const) {
    const report = analyzeProjectCapabilities(loaded, target);
    const row = report.requirements.find(item => item.path === '/go' && item.capability === 'policies.throttle');
    assert.equal(row?.support, 'delegated', target);
    assert.match(row!.reason, /quota × instance count/);
    // Delegated is not an activation blocker: the route quota is real,
    // native-code enforcement, just with a topology caveat this report can't verify.
    assert.equal(report.compatible, true, target);
  }
  // client/client-route stay refused outright: no qualified description is honest for them.
  for (const partition of ['client', 'client-route'] as const) {
    const clientRoot = await project(t, { '/go': { ...redirect(), policies: { throttle: { partition, quota: 5, window: 60 } } } });
    const clientLoaded = await loadDocument(clientRoot);
    for (const target of ['aws', 'vercel'] as const) {
      const report = analyzeProjectCapabilities(clientLoaded, target);
      const row = report.requirements.find(item => item.path === '/go' && item.capability === 'policies.throttle');
      assert.equal(row?.support, 'refused', `${partition} ${target}`);
    }
  }
});

test('doctor distinguishes implemented targets from verified provider deployments', () => {
  const result = spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { providers: string[]; capabilityTargets: CapabilityCatalog['targets'] };
  assert.deepEqual(report.providers, []);
  assert.deepEqual(report.capabilityTargets, getCapabilities().targets);
});
