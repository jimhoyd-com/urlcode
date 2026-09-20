import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDocument } from '../src/config.ts';
import { inspectExtensionRevision } from '../src/extensions.ts';
import { createRuntime } from '../src/runtime.ts';
import type { RuntimeExtension } from '../src/extensions.ts';
import type { HandlerResult } from '../src/http-response.ts';
import { project } from './helpers.ts';
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const run = (cwd: string, args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 60000 });
const parse = (out: string): Record<string, unknown> => JSON.parse(out.trim().split('\n').pop()!) as Record<string, unknown>;
const missing = async (path: string): Promise<boolean> => { try { await lstat(path); return false; } catch { return true; } };
// Run after workspace builds, against actual compiled packages. Missing outputs fail.
const companions = Object.fromEntries(['auth', 'admin', 'ui', 'store'].map(name => [`urlcode-${name}`, fileURLToPath(new URL(`../packages/${name}`, import.meta.url))]));
test('init --with store writes a working CRUD host with no handler code', async t => {
  const root = await project(t, {});
  const link = async (dir: string): Promise<void> => { await mkdir(join(dir, 'node_modules', '@jimhoyd'), { recursive: true }); await symlink(companions['urlcode-store']!, join(dir, 'node_modules', '@jimhoyd', 'urlcode-store'), process.platform === 'win32' ? 'junction' : 'dir'); };
  await link(root);
  const created = run(root, ['init', 'todo-site', '--with', 'store']);
  assert.equal(created.status, 0, created.stderr);
  const report = parse(created.stdout), site = join(root, 'todo-site'), app = join(site, 'app');
  assert.deepEqual(Object.keys((await loadDocument(app)).routes), ['/hello/{name}', '/go', '/api/todos/*']);
  assert.deepEqual(report.extensions, ['store']);
  // The generated host imports the installed package by name, exactly as a real site resolves it after npm install.
  await link(site);
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = String(report.projectSha256);
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
  const link = async (dir: string): Promise<void> => { await mkdir(join(dir, 'node_modules', '@jimhoyd'), { recursive: true }); for (const name of ['urlcode-ui', 'urlcode-store']) await symlink(companions[name]!, join(dir, 'node_modules', '@jimhoyd', name), process.platform === 'win32' ? 'junction' : 'dir'); };
  await link(root);
  const created = run(root, ['init', 'todo-site', '--with', 'ui,store']);
  assert.equal(created.status, 0, created.stderr);
  const report = parse(created.stdout), site = join(root, 'todo-site'), app = join(site, 'app');
  assert.deepEqual(Object.keys((await loadDocument(app)).routes), ['/hello/{name}', '/go', '/assets/ui/*', '/todos/*', '/api/todos/*']);
  // Two extensions that both need node:url must not produce a duplicate import binding in the generated host.
  const hostSource = await readFile(join(site, 'host.mjs'), 'utf8');
  assert.equal(hostSource.split("import {fileURLToPath} from 'node:url';").length - 1, 1);
  await link(site);
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = String(report.projectSha256);
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
  await mkdir(join(root, 'node_modules', '@jimhoyd'), { recursive: true });
  for (const [name, path] of Object.entries(companions)) await symlink(path, join(root, 'node_modules', '@jimhoyd', name), process.platform === 'win32' ? 'junction' : 'dir');
  const created = run(root, ['init', 'site', '--with', 'ui,auth,admin']);
  assert.equal(created.status, 0, created.stderr);
  const report = parse(created.stdout), site = join(root, 'site'), app = join(site, 'app');
  const loaded = await loadDocument(app);
  assert.deepEqual(Object.keys(loaded.routes), ['/hello/{name}', '/go', '/assets/ui/*', '/account/*', '/private', '/admin/*']);
  // ui must be declared first: the runtime activates extensions in this order, and auth and admin both render
  // only through the kit and refuse to activate before it.
  assert.deepEqual(Object.keys(loaded.document.extensions ?? {}), ['ui', 'auth', 'admin']);
  assert.equal(report.projectSha256, await inspectExtensionRevision(app));
  const host = await readFile(join(site, 'host.mjs'), 'utf8');
  assert.ok(host.indexOf("from '@jimhoyd/urlcode-auth'") < host.indexOf("from '@jimhoyd/urlcode-admin'"));
  assert.ok(host.indexOf('ui.registration,') < host.indexOf('authExtension({service, csrfKey, projectSha256, ui}),'));
  assert.ok(host.indexOf('authExtension({service, csrfKey, projectSha256, ui}),') < host.indexOf("adminExtension({service, csrfKey, projectSha256, authMount: '/account', ui})"));
  // The kit is built with both peers' copy and templates, or auth and admin refuse at activation.
  assert.ok(host.includes('sources: [authCatalogue], extensions: [authUiTemplates, adminUiTemplates]'));
  assert.ok(host.includes('await service.close();'));
  for (const file of ['operator-service.mjs', 'data/encryption.key', 'data/csrf.key']) { const info = await stat(join(site, file)); if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600, file); }
  assert.equal((await stat(join(site, 'data/encryption.key'))).size, 32);
  const readme = await readFile(join(site, 'README.md'), 'utf8');
  for (const needle of ['## Extension: auth', '## Extension: admin', '## Administration', 'urlcode-auth bootstrap', '- `AUTH_ORIGIN`', '- `PROJECT_SHA256`']) assert.ok(readme.includes(needle), needle);
  // The generated manifest pins the runtime and every named extension (#212).
  // ui is named here, so it is an extension rather than a peer -- and since the
  // scaffolds now refuse `--with auth,admin` outright, no real composition
  // reaches the peer role. That role is covered against synthetic packages in
  // test/project-dependencies.test.ts.
  const versions = Object.fromEntries(await Promise.all(Object.entries(companions).map(async ([name, path]) =>
    [`@jimhoyd/${name}`, (JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as { version: string }).version])));
  const core = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  const manifest = JSON.parse(await readFile(join(site, 'package.json'), 'utf8')) as { private: boolean; dependencies: Record<string, string> };
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.dependencies, { '@jimhoyd/urlcode': core, '@jimhoyd/urlcode-admin': versions['@jimhoyd/urlcode-admin'], '@jimhoyd/urlcode-auth': versions['@jimhoyd/urlcode-auth'], '@jimhoyd/urlcode-ui': versions['@jimhoyd/urlcode-ui'] });
  assert.deepEqual(report.dependencies, Object.entries(manifest.dependencies).map(([name, version]) => ({ name, version, specifier: version, local: false, role: name === '@jimhoyd/urlcode' ? 'runtime' : 'extension' })));
  // Installing is explicit: init resolves and records, it never runs a package manager.
  assert.ok(await missing(join(site, 'package-lock.json')) && await missing(join(site, 'node_modules')));
  assert.match(readme, /Run `npm install` in .*to install those exact versions/);
  // The presentation tooling must see the same kit the host builds. The CLI is the kit alone until the peer
  // packages are named, so the generated commands name them, and running one here proves the real
  // `authUiTemplates`/`adminUiTemplates` exports are what it loads.
  for (const needle of ['--extensions @jimhoyd/urlcode-auth,@jimhoyd/urlcode-admin', 'npx urlcode-ui doctor --project .'])
    assert.ok(readme.includes(needle), needle);
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
  const alone = run(root, ['init', 'other', '--with', 'admin']);
  assert.equal(alone.status, 1); assert.match(alone.stderr, /urlcode-admin scaffold refused: .*requires the auth extension/); assert.ok(await missing(join(root, 'other')));
  // Without ui, and with ui ordered last, the scaffolds refuse before anything is written rather than emitting a
  // project that throws at activation.
  const noKit = run(root, ['init', 'no-kit', '--with', 'auth,admin']);
  assert.equal(noKit.status, 1); assert.match(noKit.stderr, /scaffold refused: .*requires the ui extension/); assert.ok(await missing(join(root, 'no-kit')));
  // --with is an unordered set: every permutation is the same site, with the kit first and the same revision pin.
  const reference = await readFile(join(site, 'host.mjs'), 'utf8'), referenceRevision = String(parse(created.stdout).projectSha256);
  for (const [index, order] of ['auth,admin,ui', 'admin,ui,auth', 'admin,auth,ui'].entries()) {
    const permuted = run(root, ['init', `permuted-${index}/site`, '--with', order]);
    assert.equal(permuted.status, 0, permuted.stderr);
    const report = parse(permuted.stdout);
    assert.deepEqual(report.extensions, ['ui', 'auth', 'admin']); assert.equal(report.projectSha256, referenceRevision);
    assert.equal((await readFile(join(root, `permuted-${index}`, 'site', 'host.mjs'), 'utf8')).split('\n').slice(1).join('\n'), reference.split('\n').slice(1).join('\n'));
  }
  const authOnly = run(root, ['init', 'auth-site', '--with', 'ui,auth']);
  assert.equal(authOnly.status, 0, authOnly.stderr);
  assert.deepEqual(parse(authOnly.stdout).extensions, ['ui', 'auth']);
  // ui alone must stay self-contained: no peer import, no peer catalogue or template namespace.
  const kitOnly = run(root, ['init', 'ui-site', '--with', 'ui']);
  assert.equal(kitOnly.status, 0, kitOnly.stderr);
  const kitHost = await readFile(join(root, 'ui-site', 'host.mjs'), 'utf8');
  assert.ok(kitHost.includes('sources: [], extensions: []'));
  assert.ok(!kitHost.includes('@jimhoyd/urlcode-auth') && !kitHost.includes('@jimhoyd/urlcode-admin'));
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
test('a generated site overrides auth and admin screens from its own ui/ directory', { skip: sqliteReady.status === 0 ? false : `SQLite gate: ${sqliteReady.stderr.trim() || 'unavailable'}` }, async t => {
  // Not project(): that helper registers its own removal first, and node:test runs after-hooks in registration
  // order, so the directory would go before the auth store below releases the SQLite WAL. POSIX unlinks an open
  // file happily; Windows answers EBUSY. The removal is registered last instead, once the closes are queued.
  const root = await mkdtemp(join(tmpdir(), 'urlcode-test-'));
  await mkdir(join(root, 'node_modules', '@jimhoyd'), { recursive: true });
  for (const [name, path] of Object.entries(companions)) await symlink(path, join(root, 'node_modules', '@jimhoyd', name), process.platform === 'win32' ? 'junction' : 'dir');
  const created = run(root, ['init', 'site', '--with', 'ui,auth,admin']);
  assert.equal(created.status, 0, created.stderr);
  const site = join(root, 'site'), app = join(site, 'app');

  // Shadow one auth screen and one admin screen by name, starting from the shipped source so only the marker differs.
  // Loaded through a computed specifier: these packages only carry type declarations after a workspace build, and the
  // `static` CI job typechecks without one, so a literal specifier fails there with TS2307. Resolution is unchanged.
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
  assert.equal(revision, parse(created.stdout).projectSha256);
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
  await mkdir(join(root, 'node_modules', '@jimhoyd'), { recursive: true });
  for (const [name, path] of Object.entries(companions)) await symlink(path, join(root, 'node_modules', '@jimhoyd', name), process.platform === 'win32' ? 'junction' : 'dir');
  const reports = [] as Record<string, unknown>[], hosts = [] as string[], routes = [] as string[];
  for (const [index, order] of ['ui,auth,store', 'store,auth,ui'].entries()) {
    const created = run(root, ['init', 'equiv-' + index + '/site', '--with', order]);
    assert.equal(created.status, 0, created.stderr);
    reports.push(parse(created.stdout));
    hosts.push((await readFile(join(root, 'equiv-' + index, 'site', 'host.mjs'), 'utf8')).split('\n').slice(1).join('\n'));
    routes.push(await readFile(join(root, 'equiv-' + index, 'site', 'app', 'routes', 'extensions.yaml'), 'utf8'));
  }
  assert.deepEqual(reports[0]!.extensions, reports[1]!.extensions); assert.equal(reports[0]!.projectSha256, reports[1]!.projectSha256);
  assert.equal(hosts[0], hosts[1]); assert.equal(routes[0], routes[1]);
  assert.match(routes[0]!, /auth: true/);
});
