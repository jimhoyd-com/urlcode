// End to end with real npm: pack core and every add-on exactly as a release does, pin them in an addons.json by
// sha512, then create a site, add, serve, remove and tamper. Run after the workspaces are built
// (npm run verify:addons). It needs the npm registry for the add-ons' own third-party dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { addons, repositoryRoot } from '../scripts/workspaces.ts';
import { loadDocument } from '../packages/core/src/config.ts';
import { packAddons } from '../scripts/pack-addons.ts';
import type { PackedAddons } from '../scripts/pack-addons.ts';

const cli = join(repositoryRoot, 'dist', 'cli.js');

let packed: Promise<PackedAddons> | undefined;
/** Packs once per run: core and every add-on, with an addons.json pinning the add-on tarballs by sha512. */
function pack(): Promise<PackedAddons> {
  packed ??= mkdtemp(join(tmpdir(), 'urlcode-addons-')).then(out => { process.on('exit', () => { spawnSync('rm', ['-rf', out]); }); return packAddons(out); });
  return packed;
}
async function urlcode(t: TestContext, cwd: string, args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { manifest } = await pack();
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd, encoding: 'utf8', timeout: 600000, env: { ...process.env, URLCODE_ADDONS: manifest, ...env } });
  t.diagnostic(`urlcode ${args.join(' ')} -> ${result.status}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
/** A site whose core dependency is the packed checkout, not the registry release of the same version. */
async function site(t: TestContext): Promise<{ root: string; dir: string }> {
  const { core } = await pack();
  const root = await mkdtemp(join(tmpdir(), 'urlcode-site-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const created = await urlcode(t, root, ['init', 'site']);
  assert.equal(created.status, 0, created.stderr);
  const dir = join(root, 'site'), file = join(dir, 'package.json');
  const pkg = JSON.parse(await readFile(file, 'utf8')) as { dependencies: Record<string, string> };
  pkg.dependencies['@jimhoyd/urlcode'] = `file:${core}`;
  await writeFile(file, JSON.stringify(pkg, null, 2) + '\n');
  return { root, dir };
}
/** Runs an installed add-on's CLI with bounded JSON on stdin, as its operator would. */
function operatorCli(t: TestContext, dir: string, pkg: string, args: string[], input: unknown): unknown {
  const result = spawnSync(process.execPath, [join(dir, 'node_modules', '@jimhoyd', pkg, 'dist', 'cli.js'), ...args], { cwd: dir, encoding: 'utf8', input: JSON.stringify(input), timeout: 120000 });
  t.diagnostic(`${pkg} ${args.join(' ')} -> ${result.status}`);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
/** A cookie-keeping client that speaks to the served site as a same-origin browser on `origin` would. */
function browser(base: string, origin: string) {
  const jar = new Map<string, string>();
  return async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> => {
    const headers: Record<string, string> = { ...init.headers, cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') };
    if (init.method === 'POST') headers.origin = origin;
    const response = await fetch(base + path, { ...init, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';'), split = pair.indexOf('=');
      if (/max-age=0/i.test(cookie)) jar.delete(pair.slice(0, split)); else jar.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  };
}
async function copies(dir: string, name: string): Promise<number> {
  let count = 0;
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const child = join(path, entry.name);
      if (child.endsWith(join('node_modules', ...name.split('/')))) count++;
      await walk(child);
    }
  };
  await walk(join(dir, 'node_modules'));
  return count;
}

test('every extension installs once, composes, serves, and removes in dependency order', { timeout: 900000 }, async t => {
  const { dir } = await site(t);
  const all = (await addons()).filter(addon => addon.kind === 'extension').map(addon => addon.name);
  // --example reproduces the demos a new user expects: /api/todos and /todos, /contact, /private and /todo-form (#711, #529).
  const added = await urlcode(t, dir, ['extensions', 'add', ...all, '--example']);
  assert.equal(added.status, 0, added.stderr);
  const result = JSON.parse(added.stdout) as { added: string[]; projectSha256: string; examples: string[] };
  assert.deepEqual([...result.added].sort(), [...all].sort());
  assert.deepEqual([...result.examples].sort(), ['auth', 'form-records', 'forms', 'store']);
  for (const name of ['@jimhoyd/urlcode', '@jimhoyd/urlcode-ui', '@jimhoyd/urlcode-auth']) assert.equal(await copies(dir, name), 1, `${name} must be installed exactly once`);
  const listed = await urlcode(t, dir, ['extensions', 'list', '--strict']);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  // auth is installed in the same command, so the example todos are per-user (#331) and the owned collection
  // must activate behind auth's principal below.
  const todos = (await loadDocument(join(dir, 'app'))).document.extensions?.store?.config as { collections: { todos: { ownership?: string } } };
  assert.equal(todos.collections.todos.ownership, 'owner');
  // audit is installed in the same command too, so the example collection records its writes.
  assert.equal((todos.collections.todos as { audit?: boolean }).audit, true);
  // The console carries auth's policy, which hides it from anyone who is not signed in with a console permission.
  // (core expands the `auth:` short form into policies.extensions.auth when it loads the document.)
  const routes = (await loadDocument(join(dir, 'app'))).routes as Record<string, { policies?: { extensions?: Record<string, unknown> | false } }>;
  assert.deepEqual((routes['/admin/*']?.policies?.extensions || {}).auth, { onDeny: 404 });
  // abuse's HMAC key is scaffolded with the site; its counters database only appears once a host runs.
  await access(join(dir, 'data', 'abuse.key'));

  // Static validation needs no host, and the full runtime activates every extension through composeHost.
  const staticCheck = await urlcode(t, dir, ['validate', '--project', 'app']);
  assert.equal(staticCheck.status, 0, staticCheck.stderr);
  assert.equal((JSON.parse(staticCheck.stdout) as { static: boolean }).static, true);
  const env = { PROJECT_SHA256: result.projectSha256, AUTH_ORIGIN: 'https://site.example' };
  const full = await urlcode(t, dir, ['validate', '--project', 'app', '--host-file', 'host.mjs', '--origin', 'https://site.example'], env);
  assert.equal(full.status, 0, full.stderr);

  // Serve through the site's own installed core and host.
  const previous = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(env)) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; });
  const core = await import(pathToFileURL(join(dir, 'node_modules', '@jimhoyd', 'urlcode', 'dist', 'index.js')).href) as { startServer(options: object): Promise<{ address: { port: number }; close(): Promise<void> }> };
  const host = (await import(pathToFileURL(join(dir, 'host.mjs')).href) as { default: { extensions: unknown[]; close(): Promise<void> } }).default;
  const server = await core.startServer({ project: join(dir, 'app'), extensions: host.extensions, port: 0, host: '127.0.0.1', origin: 'https://site.example', log: () => undefined });
  // Closed here, not in an after hook: the site is removed in one, and Windows cannot delete the auth
  // database while the service still holds it open.
  try {
    // /todos is the store's own screen, contributed to ui (#709); signed-in only, so it redirects rather than 404s.
    // /todo-form is form-records' example, saving into the store example's owned todos (#529); signed-in only too.
    for (const path of ['/account/login', '/api/todos', '/todos', '/contact', '/private', '/todo-form']) {
      const response = await fetch(`http://127.0.0.1:${server.address.port}${path}`, { redirect: 'manual' });
      assert.ok(response.status !== 404 && response.status < 500, `${path} answered ${response.status}`);
    }
    // Admin hides itself from anyone who is not a signed-in administrator; an extension mount is always no-store.
    const admin = await fetch(`http://127.0.0.1:${server.address.port}/admin/`, { redirect: 'manual' });
    assert.equal(admin.status, 404);
    assert.match(admin.headers.get('cache-control') ?? '', /no-store/);

    // Real auth in front of the two `auth: {csrf: origin}` mounts: a signed-in HTML form POST (forms verifies its own
    // token) and a JSON write, both with the session cookie and no x-csrf-token header.
    const credentials = { email: 'owner@site.example', password: 'integration owner passphrase' };
    operatorCli(t, dir, 'urlcode-auth', ['bootstrap', '--operator-file', join(dir, 'operator-service.mjs')], credentials);
    const send = browser(`http://127.0.0.1:${server.address.port}`, 'https://site.example');
    const csrf = (await (await send('/account/csrf', { headers: { accept: 'application/json' } })).json() as { csrf: string }).csrf;
    const login = await send('/account/login', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(credentials) });
    assert.equal(login.status, 200, await login.text());
    const created = await send('/api/todos', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'first' }) });
    assert.equal(created.status, 201, await created.text());
    const form = await (await send('/todo-form', { headers: { accept: 'text/html' } })).text();
    const token = /name="csrf" value="([^"]+)"/.exec(form)?.[1];
    assert.ok(token, 'the form carries forms\' own token');
    const posted = await send('/todo-form', { method: 'POST', headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: token, title: 'second' }).toString() });
    assert.equal(posted.status, 303, await posted.text());

    // The store's audited write drains into the audit log while the host runs; the operator lists it offline.
    const database = join(dir, 'data', 'audit.sqlite');
    let listed: { events: { action: string }[] } = { events: [] };
    for (let attempt = 0; attempt < 40 && !listed.events.length; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 250));
      if (await access(database).then(() => true, () => false)) listed = operatorCli(t, dir, 'urlcode-audit', ['list'], { database, query: { action: 'store.record.created' } }) as typeof listed;
    }
    assert.ok(listed.events.length >= 1, 'a store.record.created event is queryable through urlcode-audit list');
  } finally { await server.close(); await host.close(); }

  const refused = await urlcode(t, dir, ['extensions', 'remove', 'auth']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /admin.* require.* auth/);
  const removed = await urlcode(t, dir, ['extensions', 'remove', 'admin']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.doesNotMatch(await readFile(join(dir, 'host.mjs'), 'utf8'), /urlcode-admin/);
});

test('a blank install adds every capability and no sample endpoint (#711)', { timeout: 900000 }, async t => {
  const { dir } = await site(t);
  const all = (await addons()).filter(addon => addon.kind === 'extension').map(addon => addon.name);
  const added = await urlcode(t, dir, ['extensions', 'add', ...all]);
  assert.equal(added.status, 0, added.stderr);
  const result = JSON.parse(added.stdout) as { projectSha256: string; examples: string[] };
  assert.deepEqual(result.examples, []);
  const routes = Object.keys((await loadDocument(join(dir, 'app'))).routes).sort();
  // Only the capabilities are mounted: ui's assets, auth's account pages and admin's console.
  assert.deepEqual(routes, ['/account/*', '/admin/*', '/assets/ui/*']);
  const env = { PROJECT_SHA256: result.projectSha256, AUTH_ORIGIN: 'https://site.example' };
  const full = await urlcode(t, dir, ['validate', '--project', 'app', '--host-file', 'host.mjs', '--origin', 'https://site.example'], env);
  assert.equal(full.status, 0, full.stderr);
  // --ack only applies to the store example, so a blank add refuses it as having no effect.
  const unused = await urlcode(t, (await site(t)).dir, ['extensions', 'add', 'store', '--ack', 'store:public-write']);
  assert.notEqual(unused.status, 0);
  assert.match(unused.stderr, /--ack store:public-write has no effect/);
});

test('artifacts install inert, and a tarball that does not match its pin rolls back', { timeout: 600000 }, async t => {
  const { dir } = await site(t);
  const artifacts = (await addons()).filter(addon => addon.kind === 'artifact').map(addon => addon.name);
  const added = await urlcode(t, dir, ['artifacts', 'add', ...artifacts]);
  assert.equal(added.status, 0, added.stderr);
  const listed = await urlcode(t, dir, ['artifacts', 'list', '--strict']);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  const schema = JSON.parse(await readFile(join(dir, 'node_modules', '@jimhoyd', 'urlcode-store-schema', 'schemas', 'config.json'), 'utf8')) as { type: string };
  assert.equal(schema.type, 'object');

  const { manifest } = await pack();
  const tampered = join(dir, 'tampered.json'), pins = JSON.parse(await readFile(manifest, 'utf8')) as { addons: Record<string, { integrity: string }> };
  pins.addons.mcp!.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  await writeFile(tampered, JSON.stringify(pins));
  const before = await readFile(join(dir, 'package.json'), 'utf8');
  const refused = await urlcode(t, dir, ['extensions', 'add', 'mcp'], { URLCODE_ADDONS: tampered });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /does not match core's pin/);
  assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), before);
});

test('the order extensions are named in never changes the site', { timeout: 600000 }, async t => {
  const one = await site(t), two = await site(t);
  const first = await urlcode(t, one.dir, ['extensions', 'add', 'store', 'ui', 'auth', '--example']);
  const second = await urlcode(t, two.dir, ['extensions', 'add', 'auth', 'store', 'ui', '--example']);
  assert.equal(first.status, 0, first.stderr); assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(join(one.dir, 'host.mjs'), 'utf8'), await readFile(join(two.dir, 'host.mjs'), 'utf8'));
  assert.equal(await readFile(join(one.dir, 'app', 'urlcode.yaml'), 'utf8'), await readFile(join(two.dir, 'app', 'urlcode.yaml'), 'utf8'));
});
