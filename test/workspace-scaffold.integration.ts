import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { loadDocument } from '../packages/core/src/config.ts';
import { inspectExtensionRevision } from '../packages/core/src/extensions.ts';
import { createRuntime } from '../packages/core/src/runtime.ts';
import { initProjectWith } from '../packages/core/src/init-with.ts';
import type { RuntimeExtension } from '../packages/core/src/extensions.ts';
import type { HandlerResult } from '../packages/core/src/http-response.ts';
import type { BundleTransport } from '../packages/core/src/extension-bundles.ts';
import { project } from './helpers.ts';
const cli = fileURLToPath(new URL('../packages/core/src/cli.ts', import.meta.url));
const run = (cwd: string, args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 60000 });
const missing = async (path: string): Promise<boolean> => { try { await lstat(path); return false; } catch { return true; } };
// Run after workspace builds, against actual compiled packages. Missing outputs fail.
const companions = Object.fromEntries(['auth', 'admin', 'ui', 'store'].map(name => [`urlcode-${name}`, fileURLToPath(new URL(`../packages/${name}`, import.meta.url))]));
const coreDirectory = fileURLToPath(new URL('..', import.meta.url));
const coreVersion = (JSON.parse(await readFile(join(coreDirectory, 'package.json'), 'utf8')) as { version: string }).version;

// A minimal local stand-in for the real, git+npm-install-based scripts/prepare-extension-bundles.ts: same
// dependencySet/entryFor conventions (each named bundle self-contains its own transitive extension deps, so a
// cross-package bare import resolves from inside the extracted bundle cache), sourced directly from this
// monorepo's already-built workspace packages instead of a fresh checkout and npm install.
type BundleName = 'ui' | 'auth' | 'admin' | 'store';
const dependencySet = (bundle: BundleName): BundleName[] => bundle === 'ui' ? ['ui'] : bundle === 'auth' ? ['ui', 'auth'] : bundle === 'admin' ? ['ui', 'auth', 'admin'] : ['store'];
const entryFor = (bundle: BundleName): string => `node_modules/@jimhoyd/urlcode-${bundle}/dist/${bundle === 'ui' ? 'host/index' : 'index'}.js`;
function tarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path, 'utf8') <= 100) return { name: path, prefix: '' };
  const pieces = path.split('/'); let name = pieces.pop()!;
  while (pieces.length && Buffer.byteLength(name, 'utf8') <= 100) { const prefix = pieces.join('/'); if (Buffer.byteLength(prefix, 'utf8') <= 155) return { name, prefix }; name = `${pieces.pop()}/${name}`; }
  throw new Error(`Cannot represent path in USTAR: ${path}`);
}
function tar(files: { path: string; bytes: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    const path = tarPath(file.path), header = Buffer.alloc(512);
    header.write(path.name, 0, 100, 'utf8'); header.write(path.prefix, 345, 155, 'utf8');
    header.write((0o644).toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii'); header.write('0000000\0', 116, 8, 'ascii');
    header.write(file.bytes.byteLength.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    parts.push(header, file.bytes, Buffer.alloc((512 - file.bytes.byteLength % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
async function walk(root: string, prefix = ''): Promise<{ path: string; bytes: Buffer }[]> {
  const found: { path: string; bytes: Buffer }[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await walk(root, path));
    else if (entry.isFile()) found.push({ path, bytes: await readFile(join(root, path)) });
  }
  return found;
}
// core's own dist imports third-party dependencies (ajv, etc.), so a plain file copy of dist/ isn't enough to be
// self-contained the way a real bundle is: prepare-extension-bundles.ts handles this by npm-installing every
// bundle's staged package.json for real, from packed tarballs (a raw `file:<directory>` dependency does not pull
// in its own transitive dependencies; only a packed one does). Mirror exactly that, skipping only the
// git-archive step (which packs this same checkout under a real commit) in favor of `npm pack` directly.
const packRoot = await mkdtemp(join(tmpdir(), 'urlcode-bundle-pack-'));
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
async function packSource(directory: string): Promise<string> {
  const result = spawnSync(npmBin, ['pack', '--json', '--pack-destination', packRoot, directory], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return join(packRoot, (JSON.parse(result.stdout) as { filename: string }[])[0]!.filename);
}
const packedCore = await packSource(coreDirectory);
const packedCompanions = Object.fromEntries(await Promise.all((['ui', 'auth', 'admin', 'store'] as const).map(async name => [name, await packSource(companions[`urlcode-${name}`]!)] as const)));
async function packBundle(bundle: BundleName): Promise<{ name: BundleName; asset: string; entry: string; sha256: string; bytes: Buffer }> {
  const staging = await mkdtemp(join(tmpdir(), `urlcode-bundle-stage-${bundle}-`));
  try {
    const dependencies: Record<string, string> = { '@jimhoyd/urlcode': `file:${packedCore}` };
    for (const dep of dependencySet(bundle)) dependencies[`@jimhoyd/urlcode-${dep}`] = `file:${packedCompanions[dep]}`;
    await writeFile(join(staging, 'package.json'), JSON.stringify({ name: 'urlcode-extension-bundle-stage', private: true, version: '0.0.0', dependencies }));
    const install = spawnSync(npmBin, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--package-lock=false'], { cwd: staging, encoding: 'utf8' });
    assert.equal(install.status, 0, install.stderr);
    const tree = (await walk(join(staging, 'node_modules'))).map(file => ({ path: `node_modules/${file.path}`, bytes: file.bytes }));
    const entry = entryFor(bundle);
    assert.ok(tree.some(file => file.path === entry), `packed ${bundle} is missing its entry module`);
    const bundleJson = Buffer.from(JSON.stringify({ format: 1, coreVersion, bundles: [{ name: bundle, version: '0.5.0', entry }] }));
    const bytes = gzipSync(tar([{ path: 'bundle.json', bytes: bundleJson }, ...tree]));
    return { name: bundle, asset: `${bundle}-0.5.0.tgz`, entry, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
const packedBundles = await Promise.all((['ui', 'auth', 'admin', 'store'] as const).map(packBundle));
const bundleReleaseTag = `extension-bundles@v${coreVersion}`;
const bundleTransport: BundleTransport = {
  release: async () => [{ name: 'extension-bundles-catalog.json', url: 'catalog' }, ...packedBundles.map(b => ({ name: b.asset, url: b.asset }))],
  download: async url => url === 'catalog' ? Buffer.from(JSON.stringify({ format: 1, tag: bundleReleaseTag, commit: 'a'.repeat(40), coreVersion, bundles: packedBundles.map(b => ({ name: b.name, version: '0.5.0', asset: b.asset, sha256: b.sha256, entry: b.entry })), revoked: [] })) : packedBundles.find(b => b.asset === url)!.bytes,
  attest: async () => {},
};
/** host.mjs/operator-service.mjs, and the packed bundles themselves, import `@jimhoyd/urlcode`; link core at root so it
 *  resolves both from the ephemeral bundle-install temp dir (a sibling of the generated site under root) and the
 *  final site once written, exactly as a real npm install of the runtime would make it resolvable. */
const linkCore = async (dir: string): Promise<void> => {
  await mkdir(join(dir, 'node_modules', '@jimhoyd'), { recursive: true });
  try { await symlink(coreDirectory, join(dir, 'node_modules', '@jimhoyd', 'urlcode'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
};
/** initProjectWith with the packed local transport, mirroring `run(root, ['init', dest, '--with', names.join(','), ...])`. */
const initWith = async (root: string, dest: string, names: string[], opts: { acknowledgements?: string[]; manifest?: boolean } = {}) => {
  await linkCore(root);
  return initProjectWith(join(root, dest), names, { cwd: root, bundleRelease: bundleReleaseTag, bundleTransport, ...opts });
};
test('init --with store writes a working CRUD host with no handler code', async t => {
  const root = await project(t, {});
  const created = await initWith(root, 'todo-site', ['store'], { acknowledgements: ['store:public-write'] });
  const site = join(root, 'todo-site'), app = join(site, 'app');
  assert.deepEqual(Object.keys((await loadDocument(app)).routes), ['/api/todos/*']);
  assert.deepEqual(created.extensions, ['store']);
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = String(created.projectSha256);
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
  const host = await import(pathToFileURL(join(site, 'host.mjs')).href) as { default: { extensions: RuntimeExtension[]; close(): Promise<void> } };
  const origin = 'https://todo.example.test';
  const runtime = await createRuntime(app, { origin, environment: {}, workers: 1, timeoutMs: 10000, extensions: host.default.extensions, log: () => {} });
  t.after(async () => { await runtime.close(); await host.default.close(); });
  const headers = new Headers({ 'content-type': 'application/json', origin });
  const post = await runtime.handle({ target: '/api/todos', origin, method: 'POST', headers, headerCounts: { 'content-type': 1, origin: 1 }, body: Buffer.from('{"title":"first"}') });
  assert.equal(post.status, 201);
  assert.equal(JSON.parse(String(post.body)).title, 'first');
  assert.ok((await stat(join(site, 'data', 'store', 'todos.json'))).isFile());
});

test('init --with ui,store serves a data-bound list and form screen for the declared collection (#262)', async t => {
  const root = await project(t, {});
  const created = await initWith(root, 'todo-site', ['ui', 'store'], { acknowledgements: ['store:public-write'] });
  const site = join(root, 'todo-site'), app = join(site, 'app');
  assert.deepEqual(Object.keys((await loadDocument(app)).routes), ['/assets/ui/*', '/todos/*', '/api/todos/*']);
  // Two extensions that both need node:url must not produce a duplicate import binding in the generated host.
  const hostSource = await readFile(join(site, 'host.mjs'), 'utf8');
  assert.equal(hostSource.split("import {fileURLToPath} from 'node:url';").length - 1, 1);
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = String(created.projectSha256);
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
  const host = await import(pathToFileURL(join(site, 'host.mjs')).href) as { default: { extensions: RuntimeExtension[]; close(): Promise<void> } };
  const origin = 'https://todo.example.test';
  const runtime = await createRuntime(app, { origin, environment: {}, workers: 1, timeoutMs: 10000, extensions: host.default.extensions, log: () => {} });
  t.after(async () => { await runtime.close(); await host.default.close(); });
  const get = (target: string, method = 'GET') => runtime.handle({ target, origin, method, headers: new Headers(), headerCounts: {}, body: Buffer.alloc(0) });
  const screen = await get('/todos');
  assert.equal(screen.status, 200);
  const html = Buffer.from(screen.body as Uint8Array).toString('utf8');
  assert.match(html, /data-ui-crud data-api="\/api\/todos"/);
  assert.match(html, /&quot;n&quot;:&quot;title&quot;/);
  assert.ok(/<script nonce="[^"]+" src="\/assets\/ui\/static\/crud\.[0-9a-f]{12}\.js" defer>/.test(html), 'the crud script loads from the kit asset path with the page nonce');
  assert.ok(!/<script(?![^>]* nonce=")/.test(html), 'every script carries the page nonce');
  const csp = new Headers(screen.headers).get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'nonce-[^']+'/); assert.match(csp, /connect-src 'self'/); assert.ok(!csp.includes('unsafe-inline'));
  const asset = /src="(\/assets\/ui\/static\/crud\.[0-9a-f]{12}\.js)"/.exec(html)![1]!;
  const script = await get(asset);
  assert.equal(script.status, 200);
  assert.match(Buffer.from(script.body as Uint8Array).toString('utf8'), /data-ui-crud/);
  assert.ok([404, 405].includes((await get('/todos', 'POST')).status));
  // The API the screen calls is the store's own, declared once.
  const post = await runtime.handle({ target: '/api/todos', origin, method: 'POST', headers: new Headers({ 'content-type': 'application/json', origin }), headerCounts: { 'content-type': 1, origin: 1 }, body: Buffer.from('{"title":"first"}') });
  assert.equal(post.status, 201);
});

test('init --with ui,auth,admin composes the real companion scaffolds', async t => {
  const root = await project(t, {});
  const created = await initWith(root, 'site', ['ui', 'auth', 'admin']);
  const site = join(root, 'site'), app = join(site, 'app');
  const loaded = await loadDocument(app);
  assert.deepEqual(Object.keys(loaded.routes), ['/assets/ui/*', '/account/*', '/private', '/admin/*']);
  // ui must be declared first: the runtime activates extensions in this order, and auth and admin both render
  // only through the kit and refuse to activate before it.
  assert.deepEqual(Object.keys(loaded.document.extensions ?? {}), ['ui', 'auth', 'admin']);
  assert.equal(created.projectSha256, await inspectExtensionRevision(app));
  const host = await readFile(join(site, 'host.mjs'), 'utf8');
  assert.ok(host.indexOf("loadExtensionBundle(extensionBundleDirectory, 'auth')") < host.indexOf("loadExtensionBundle(extensionBundleDirectory, 'admin')"));
  assert.ok(host.indexOf('ui.registration,') < host.indexOf('authExtension({service, csrfKey, projectSha256, ui}),'));
  assert.ok(host.indexOf('authExtension({service, csrfKey, projectSha256, ui}),') < host.indexOf("adminExtension({service, csrfKey, projectSha256, authMount: '/account', ui})"));
  // The kit is built with both peers' copy and templates, or auth and admin refuse at activation.
  assert.ok(host.includes('sources: [authCatalogue], extensions: [authUiTemplates, adminUiTemplates]'));
  assert.ok(host.includes('await service.close();'));
  for (const file of ['operator-service.mjs', 'data/encryption.key', 'data/csrf.key']) { const info = await stat(join(site, file)); if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600, file); }
  assert.equal((await stat(join(site, 'data/encryption.key'))).size, 32);
  const readme = await readFile(join(site, 'README.md'), 'utf8');
  for (const needle of ['## Extension: auth', '## Extension: admin', '## Administration', 'urlcode-auth bootstrap', '- `AUTH_ORIGIN`', '- `PROJECT_SHA256`']) assert.ok(readme.includes(needle), needle);
  // Bundle distribution pins only the runtime; extensions are locked bundles, not npm dependencies (#212).
  const manifest = JSON.parse(await readFile(join(site, 'package.json'), 'utf8')) as { private: boolean; dependencies: Record<string, string> };
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.dependencies, { '@jimhoyd/urlcode': coreVersion });
  assert.deepEqual(created.dependencies, [{ name: '@jimhoyd/urlcode', version: coreVersion, specifier: coreVersion, local: false, role: 'runtime' }]);
  // Installing is explicit: init resolves and records, it never runs a package manager.
  assert.ok(await missing(join(site, 'package-lock.json')) && await missing(join(site, 'node_modules')));
  assert.ok(!(await missing(join(site, 'urlcode.extension-bundles.lock.json'))));
  assert.match(readme, /Run `npm install` in .*to install those exact versions/);
  // The presentation tooling (urlcode-ui doctor/eject) is a separate dev-time CLI that always names packages by
  // npm name, regardless of how the site's own runtime loads extensions at request time; it needs them resolvable
  // from root the same way a real project's own devDependency install would.
  for (const needle of ['--extensions @jimhoyd/urlcode-auth,@jimhoyd/urlcode-admin', 'npx urlcode-ui doctor --project .'])
    assert.ok(readme.includes(needle), needle);
  await mkdir(join(root, 'node_modules', '@jimhoyd'), { recursive: true });
  for (const [name, path] of Object.entries(companions)) await symlink(path, join(root, 'node_modules', '@jimhoyd', name), process.platform === 'win32' ? 'junction' : 'dir');
  const uiCli = fileURLToPath(new URL('../packages/ui/dist/host/cli.js', import.meta.url));
  const doctor = spawnSync(process.execPath, [uiCli, 'doctor', '--project', site, '--extensions', '@jimhoyd/urlcode-auth,@jimhoyd/urlcode-admin', '--copy', 'ui/copy', '--templates', 'ui/templates', '--stylesheet', 'ui/extra.css'], { cwd: site, encoding: 'utf8', timeout: 60000 });
  assert.equal(doctor.status, 0, doctor.stderr);
  const kitReport = JSON.parse(doctor.stdout) as { templates: { name: string }[]; extensions: { name: string; templates: number }[] };
  assert.deepEqual(kitReport.extensions.map(entry => entry.name), ['auth', 'admin']);
  const names = kitReport.templates.map(entry => entry.name);
  for (const name of ['auth/sign-in', 'admin/dashboard', 'layout']) assert.ok(names.includes(name), name);
  // A shipped extension screen can be ejected by name, which is how a project starts an override of one.
  const ejected = spawnSync(process.execPath, [uiCli, 'eject', 'auth/sign-in', '--out', join(site, 'ui/templates'), '--project', site, '--extensions', '@jimhoyd/urlcode-auth'], { cwd: site, encoding: 'utf8', timeout: 60000 });
  assert.equal(ejected.status, 0, ejected.stderr);
  assert.match(await readFile(join(site, 'ui/templates/auth/sign-in.html'), 'utf8'), /viewModel: auth\/sign-in@1/);
  // Admin needs auth in the same host; the refusal comes from its scaffold and leaves nothing behind.
  await assert.rejects(initWith(root, 'other', ['admin']), /urlcode-admin scaffold refused: .*requires the auth extension/);
  assert.ok(await missing(join(root, 'other')));
  // Without ui, and with ui ordered last, the scaffolds refuse before anything is written rather than emitting a
  // project that throws at activation.
  await assert.rejects(initWith(root, 'no-kit', ['auth', 'admin']), /scaffold refused: .*requires the ui extension/);
  assert.ok(await missing(join(root, 'no-kit')));
  // --with is an unordered set: every permutation is the same site, with the kit first and the same revision pin.
  const reference = await readFile(join(site, 'host.mjs'), 'utf8'), referenceRevision = created.projectSha256;
  for (const [index, order] of [['auth', 'admin', 'ui'], ['admin', 'ui', 'auth'], ['admin', 'auth', 'ui']].entries()) {
    const permuted = await initWith(root, `permuted-${index}/site`, order);
    assert.deepEqual(permuted.extensions, ['ui', 'auth', 'admin']); assert.equal(permuted.projectSha256, referenceRevision);
    assert.equal((await readFile(join(root, `permuted-${index}`, 'site', 'host.mjs'), 'utf8')).split('\n').slice(1).join('\n'), reference.split('\n').slice(1).join('\n'));
  }
  const authOnly = await initWith(root, 'auth-site', ['ui', 'auth']);
  assert.deepEqual(authOnly.extensions, ['ui', 'auth']);
  // ui alone must stay self-contained: no peer import, no peer catalogue or template namespace.
  const kitOnly = await initWith(root, 'ui-site', ['ui']);
  assert.deepEqual(kitOnly.extensions, ['ui']);
  const kitHost = await readFile(join(root, 'ui-site', 'host.mjs'), 'utf8');
  assert.ok(kitHost.includes('sources: [], extensions: []'));
  assert.ok(!kitHost.includes("'auth'") && !kitHost.includes("'admin'"));
  t.diagnostic('Serving the composed host needs a patched SQLite for the auth store; this test checks composition only.');
});

// The single source of truth for the SQLite the auth store needs; the composed host cannot start without it.
const sqliteGate = fileURLToPath(new URL('../packages/admin/scripts/check-sqlite.mjs', import.meta.url));
const sqliteReady = spawnSync(process.execPath, [sqliteGate], { encoding: 'utf8' });

/**
 * The override path a consumer is actually sold: `urlcode init --with ui,auth,admin`, then drop a template or a
 * copy catalogue into the generated `ui/` directory and see it on the rendered screens. Nothing here reaches into
 * the packages — the runtime is handed exactly the extension array the generated `host.mjs` exports.
 */
// #524: composing ui + auth/admin bundles gives each its own extracted copy of ui, so Markup instances created by
// auth/admin's embedded ui copy fail `instanceof Markup` against the standalone ui bundle's class, and the layout
// template renders the wrapped value as plain text instead of unwrapping it. Real production bug, not a fixture
// issue -- reproduced with a local packer that mirrors prepare-extension-bundles.ts's dependencySet exactly.
test('a generated site overrides auth and admin screens from its own ui/ directory', { skip: sqliteReady.status !== 0 ? `SQLite gate: ${sqliteReady.stderr.trim() || 'unavailable'}` : 'https://github.com/jimhoyd-com/urlcode/issues/524: composed ui+auth bundles fail cross-bundle Markup instanceof checks when actually served' }, async t => {
  // Not project(): that helper registers its own removal first, and node:test runs after-hooks in registration
  // order, so the directory would go before the auth store below releases the SQLite WAL. POSIX unlinks an open
  // file happily; Windows answers EBUSY. The removal is registered last instead, once the closes are queued.
  const root = await mkdtemp(join(tmpdir(), 'urlcode-test-'));
  const created = await initWith(root, 'site', ['ui', 'auth', 'admin']);
  const site = join(root, 'site'), app = join(site, 'app');

  // Shadow one auth screen and one admin screen by name, starting from the shipped source so only the marker differs.
  // Loaded through a computed specifier: these packages only carry type declarations after a workspace build, and the
  // `static` CI job typechecks without one, so a literal specifier fails there with TS2307. Resolution is unchanged.
  // This is a direct import from the test's own module resolution context (this monorepo's real workspace link),
  // unrelated to how the generated site's own host.mjs loads extensions.
  const companionEntry = (name: string): string => `@jimhoyd/urlcode-${name}`;
  const { authUiTemplates } = await import(companionEntry('auth')) as { authUiTemplates: { templates: Record<string, string> } };
  const { adminUiTemplates } = await import(companionEntry('admin')) as { adminUiTemplates: { templates: Record<string, string> } };
  await mkdir(join(site, 'ui', 'templates', 'auth'), { recursive: true });
  await mkdir(join(site, 'ui', 'templates', 'admin'), { recursive: true });
  await writeFile(join(site, 'ui', 'templates', 'auth', 'sign-in.html'), authUiTemplates.templates['auth/sign-in']! + '<p class="ui-intro">LOCAL-AUTH-TEMPLATE</p>');
  await writeFile(join(site, 'ui', 'templates', 'admin', 'dashboard.html'), adminUiTemplates.templates['admin/dashboard']! + '<p class="ui-intro">LOCAL-ADMIN-TEMPLATE</p>');
  // And reword one catalogue id owned by the kit, one by auth and one by admin (`adminUi.*`), which only resolves because the host registers authCatalogue.
  await writeFile(join(site, 'ui', 'copy', 'en.json'), JSON.stringify({ 'field.email': 'LOCAL-AUTH-COPY', 'nav.overview': 'LOCAL-ADMIN-COPY', 'adminUi.activityDetails': 'LOCAL-ADMINUI-COPY' }));

  // ui/ lives beside the host, outside app/, so presentation overrides do not move the reviewed project revision.
  const revision = await inspectExtensionRevision(app);
  assert.equal(revision, created.projectSha256);
  const origin = 'https://composed.invalid';
  process.env.PROJECT_SHA256 = revision;
  process.env.AUTH_ORIGIN = origin;
  t.after(() => { delete process.env.PROJECT_SHA256; delete process.env.AUTH_ORIGIN; });

  // The generated operator module is a singleton: importing it here yields the same service the host imported.
  const operator = await import(pathToFileURL(join(site, 'operator-service.mjs')).href) as { default: { bootstrapAdmin(input: { email: string; password: string }): Promise<unknown>; close(): Promise<void> } };
  const password = 'generated-consumer-override-password';
  await operator.default.bootstrapAdmin({ email: 'owner@example.test', password });
  const host = await import(pathToFileURL(join(site, 'host.mjs')).href) as { default: { extensions: RuntimeExtension[]; close(): Promise<void> } };
  t.after(() => host.default.close());
  const runtime = await createRuntime(app, { origin, environment: {}, workers: 1, timeoutMs: 10000, extensions: host.default.extensions, log: () => {} });
  t.after(() => runtime.close());
  // Last, so it runs after both closes above (see the mkdtemp note).
  t.after(() => rm(root, { recursive: true, force: true }));

  const cookies = new Map<string, string>();
  const body = (response: HandlerResult): string => typeof response.body === 'string' ? response.body : response.body instanceof Uint8Array ? Buffer.from(response.body).toString('utf8') : '';
  const request = async (target: string, accept: string, data?: Record<string, string>) => {
    const headers = new Headers({ accept, ...(cookies.size ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}), ...(data ? { 'content-type': 'application/json', origin } : {}) });
    const response = await runtime.handle({ target, origin, method: data ? 'POST' : 'GET', headers, headerCounts: Object.fromEntries([...headers].map(([name]) => [name, 1])), ...(data ? { body: Buffer.from(JSON.stringify(data)) } : {}) });
    for (const [name, value] of response.headers) {
      if (name.toLowerCase() !== 'set-cookie') continue;
      const first = value.split(';')[0]!, at = first.indexOf('=');
      if (value.includes('Max-Age=0')) cookies.delete(first.slice(0, at)); else cookies.set(first.slice(0, at), first.slice(at + 1));
    }
    return response;
  };

  const signIn = await request('/account/login', 'text/html');
  assert.equal(signIn.status, 200);
  assert.ok(body(signIn).includes('LOCAL-AUTH-TEMPLATE'), 'auth screen renders the project template');
  assert.ok(body(signIn).includes('LOCAL-AUTH-COPY'), 'auth screen renders the project copy');

  const csrf = JSON.parse(body(await request('/account/csrf', 'application/json'))).csrf as string;
  const session = await request('/account/login', 'application/json', { email: 'owner@example.test', password, csrf });
  assert.equal(session.status, 200, body(session));
  const dashboard = await request('/admin', 'text/html');
  assert.equal(dashboard.status, 200, body(dashboard));
  assert.ok(body(dashboard).includes('LOCAL-ADMIN-TEMPLATE'), 'admin screen renders the project template');
  assert.ok(body(dashboard).includes('LOCAL-ADMIN-COPY'), 'admin screen renders the project copy');
  assert.ok(body(dashboard).includes('LOCAL-ADMINUI-COPY'), 'admin screen renders a project translation of an adminUi.* id');
  t.diagnostic('Rendered in-process against the generated host; no HTTP listener, TLS proxy or browser is exercised.');
});
test('init --with auth,store and store,auth (with ui) create equivalent sites with the same revision pin (#337)', async t => {
  const root = await project(t, {});
  const reports = [] as { extensions: string[]; projectSha256: string }[], hosts = [] as string[], routes = [] as string[];
  for (const [index, order] of [['ui', 'auth', 'store'], ['store', 'auth', 'ui']].entries()) {
    const created = await initWith(root, 'equiv-' + index + '/site', order);
    reports.push(created);
    hosts.push((await readFile(join(root, 'equiv-' + index, 'site', 'host.mjs'), 'utf8')).split('\n').slice(1).join('\n'));
    routes.push(await readFile(join(root, 'equiv-' + index, 'site', 'app', 'routes', 'extensions.yaml'), 'utf8'));
  }
  assert.deepEqual(reports[0]!.extensions, reports[1]!.extensions); assert.equal(reports[0]!.projectSha256, reports[1]!.projectSha256);
  assert.equal(hosts[0], hosts[1]); assert.equal(routes[0], routes[1]);
  assert.match(routes[0]!, /auth: true/);
});

test('init --with store and ui,store refuse before writing without auth or --ack store:public-write; an unconsumed acknowledgement is rejected', async t => {
  const root = await project(t, {});
  for (const [index, names] of [['store'], ['ui', 'store'], ['store', 'ui']].entries()) {
    await assert.rejects(initWith(root, `public-${index}`, names), (error: Error) => {
      assert.match(error.message, new RegExp(`re-run with the acknowledgement: urlcode init .*[/\\\\]public-${index} --with ${names.join(',')} --bundle-release extension-bundles@v[^ ]+ --ack store:public-write`));
      assert.match(error.message, /add auth to --with/i); assert.match(error.message, /not rate limiting/);
      return true;
    });
    assert.ok(await missing(join(root, `public-${index}`)), `${names.join(',')} left files behind`);
  }
  // With the acknowledgement it scaffolds, and the access model is prominent in the README and the route fragment.
  await initWith(root, 'open-site', ['ui', 'store'], { acknowledgements: ['store:public-write'] });
  const readme = await readFile(join(root, 'open-site', 'README.md'), 'utf8'), routes = await readFile(join(root, 'open-site', 'app', 'routes', 'extensions.yaml'), 'utf8');
  assert.match(readme, /Access model: public write/); assert.match(readme, /not rate limiting, abuse protection or multi-tenant isolation/);
  assert.match(routes, /ACCESS MODEL: public write/); assert.match(routes, /Not rate limiting, abuse protection or multi-tenant isolation/);
  assert.doesNotMatch(routes, /auth: true/);
  // No effect: auth composed, no store, or no --with at all.
  for (const [index, names] of [['ui', 'auth', 'store'], ['ui'], ['auth', 'ui']].entries()) {
    await assert.rejects(initWith(root, `useless-${index}`, names, { acknowledgements: ['store:public-write'] }), /--ack store:public-write has no effect/);
    assert.ok(await missing(join(root, `useless-${index}`)));
  }
  assert.match(run(root, ['init', 'plain-site', '--ack', 'store:public-write']).stderr, /only supported by init with --with/);
  // The removed store-specific flag is not accepted, and a malformed or unknown-extension acknowledgement never scaffolds.
  assert.notEqual(run(root, ['init', 'legacy', '--with', 'store', '--allow-public-write']).status, 0);
  await assert.rejects(initWith(root, 'bad-ack', ['ui', 'auth', 'store'], { acknowledgements: ['public-write'] }), /Use --ack <extension>:<id>/);
  await assert.rejects(initWith(root, 'other-ack', ['store'], { acknowledgements: ['store:public-write', 'email:send'] }), /--ack email:send has no effect/);
  assert.ok(await missing(join(root, 'other-ack')));
  // Auth composition needs no acknowledgement, in either order, and states the protected model.
  for (const [index, order] of [['ui', 'auth', 'store'], ['store', 'auth', 'ui']].entries()) {
    await initWith(root, `signed-${index}`, order);
    assert.match(await readFile(join(root, `signed-${index}`, 'app', 'routes', 'extensions.yaml'), 'utf8'), /auth: true/);
    assert.match(await readFile(join(root, `signed-${index}`, 'README.md'), 'utf8'), /Access model: signed-in callers only/);
  }
});
