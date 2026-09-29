// End to end with real npm: pack core and every add-on exactly as a release does, pin them in an addons.json by
// sha512, then create a site, add, serve, remove and tamper. Run after the workspaces are built
// (npm run verify:addons). It needs the npm registry for the add-ons' own third-party dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { addons, repositoryRoot } from '../scripts/workspaces.ts';
import { loadDocument } from '../packages/core/src/config.ts';
import { packAddons } from '../scripts/pack-addons.ts';
import type { PackedAddons } from '../scripts/pack-addons.ts';

const cli = join(repositoryRoot, 'dist', 'cli.js');
/** npm's own CLI under this Node when a script started the test, so no shell is needed on Windows. */
const npmRun = (args: string[], cwd: string) => process.env.npm_execpath
  ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: 'utf8' })
  : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });

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
  // --example reproduces the demo a new user expects: the /api/todos JSON mount (#711, API only since #883).
  const added = await urlcode(t, dir, ['extensions', 'add', ...all, '--example']);
  assert.equal(added.status, 0, added.stderr);
  const result = JSON.parse(added.stdout) as { added: string[]; projectSha256: string; examples: string[] };
  assert.deepEqual([...result.added].sort(), [...all].sort());
  assert.deepEqual([...result.examples].sort(), ['store']);
  for (const name of ['@jimhoyd/urlcode', '@jimhoyd/urlcode-audit', '@jimhoyd/urlcode-auth']) assert.equal(await copies(dir, name), 1, `${name} must be installed exactly once`);
  const listed = await urlcode(t, dir, ['extensions', 'list', '--strict']);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  // auth is installed in the same command, so the example todos are per-user (#331) and the owned collection
  // must activate behind auth's principal below.
  const todos = (await loadDocument(join(dir, 'app'))).document.extensions?.store?.config as { collections: { todos: { ownership?: string } } };
  assert.equal(todos.collections.todos.ownership, 'owner');
  // audit is installed in the same command too, so the example collection records its writes.
  assert.equal((todos.collections.todos as { audit?: boolean }).audit, true);
  // The store example's JSON mount is signed-in only (core expands `auth: true` into policies.extensions.auth).
  const routes = (await loadDocument(join(dir, 'app'))).routes as Record<string, { policies?: { extensions?: Record<string, unknown> | false } }>;
  assert.deepEqual((routes['/api/todos/*']?.policies?.extensions || {}).auth, {});

  // Better Auth's tables are an explicit operator step; auth refuses to activate without them.
  operatorCli(t, dir, 'urlcode-auth', ['migrate'], {});
  // Static validation needs no host, and the full runtime activates every extension through composeHost.
  const staticCheck = await urlcode(t, dir, ['validate', '--project', 'app']);
  assert.equal(staticCheck.status, 0, staticCheck.stderr);
  assert.equal((JSON.parse(staticCheck.stdout) as { static: boolean }).static, true);
  const env = { PROJECT_SHA256: result.projectSha256 };
  const full = await urlcode(t, dir, ['validate', '--project', 'app', '--host-file', 'host.mjs', '--origin', 'https://site.example'], env);
  assert.equal(full.status, 0, full.stderr);

  // Serve through the site's own installed core and host.
  const previous = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(env)) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; });
  const core = await import(pathToFileURL(join(dir, 'node_modules', '@jimhoyd', 'urlcode', 'dist', 'index.js')).href) as { startServer(options: object): Promise<{ address: { port: number }; reload(): Promise<boolean>; close(): Promise<void> }> };
  const host = (await import(pathToFileURL(join(dir, 'host.mjs')).href) as { default: { extensions: unknown[]; close(): Promise<void> } }).default;
  // `urlcode dev`'s reload path: the stateful composition must hot reload an edit (#777, RIM-EXT-HANDOFF-001).
  const server = await core.startServer({ project: join(dir, 'app'), extensions: host.extensions, port: 0, host: '127.0.0.1', origin: 'https://site.example', log: () => undefined, followExtensionPinOnReload: true });
  // Closed here, not in an after hook: the site is removed in one, and Windows cannot delete the auth
  // database while the service still holds it open.
  try {
    for (const path of ['/api/auth/ok', '/api/todos']) {
      const response = await fetch(`http://127.0.0.1:${server.address.port}${path}`, { redirect: 'manual' });
      assert.ok(response.status !== 404 && response.status < 500, `${path} answered ${response.status}`);
    }
    // An extension mount is always no-store, and Better Auth answers only its allowlisted paths.
    const mount = await fetch(`http://127.0.0.1:${server.address.port}/api/auth/update-user`, { redirect: 'manual' });
    assert.equal(mount.status, 404);
    assert.match(mount.headers.get('cache-control') ?? '', /no-store/);

    // Better Auth in front of the `auth: true` JSON mount: a signed-in write with the session cookie from
    // Better Auth's own sign-in.
    const credentials = { email: 'owner@site.example', password: 'integration owner passphrase', name: 'Owner' };
    operatorCli(t, dir, 'urlcode-auth', ['create-user'], credentials);
    const send = browser(`http://127.0.0.1:${server.address.port}`, 'https://site.example');
    const login = await send('/api/auth/sign-in/email', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ email: credentials.email, password: credentials.password }) });
    assert.equal(login.status, 200, await login.text());
    const created = await send('/api/todos', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'first' }) });
    assert.equal(created.status, 201, await created.text());

    // Hot reload an edit of the collection's title limit: the replacement runtime's store serves the same database
    // connection, the new limit is enforced, and the records written before the reload are still readable.
    const yaml = join(dir, 'app', 'urlcode.yaml');
    const text = await readFile(yaml, 'utf8');
    assert.match(text, /maxLength: 200/);
    await writeFile(yaml, text.replace('maxLength: 200', 'maxLength: 20'));
    assert.equal(await server.reload(), true, 'the generated stateful site reloads');
    const tooLong = await send('/api/todos', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'a title longer than twenty characters' }) });
    assert.equal(tooLong.status, 400, await tooLong.text());
    const kept = await (await send('/api/todos', { headers: { accept: 'application/json' } })).json() as { items: { title: string }[] };
    assert.deepEqual(kept.items.map(item => item.title), ['first']);
    const later = await send('/api/todos', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'after reload' }) });
    assert.equal(later.status, 201, await later.text());

    // The store's audited write drains into the audit log while the host runs; the operator lists it offline.
    const database = join(dir, 'data', 'audit.sqlite');
    let listed: { events: { action: string }[] } = { events: [] };
    for (let attempt = 0; attempt < 40 && !listed.events.length; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 250));
      if (await access(database).then(() => true, () => false)) listed = operatorCli(t, dir, 'urlcode-audit', ['list'], { database, query: { action: 'store.record.created' } }) as typeof listed;
    }
    assert.ok(listed.events.length >= 1, 'a store.record.created event is queryable through urlcode-audit list');
  } finally { await server.close(); await host.close(); }

  // auth cannot be removed while other routes still protect themselves with it.
  const refused = await urlcode(t, dir, ['extensions', 'remove', 'auth']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /still uses auth/);
  const removed = await urlcode(t, dir, ['extensions', 'remove', 'mcp']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.doesNotMatch(await readFile(join(dir, 'host.mjs'), 'utf8'), /urlcode-mcp/);
});

test('a blank install adds every capability and no sample endpoint (#711)', { timeout: 900000 }, async t => {
  const { dir } = await site(t);
  const all = (await addons()).filter(addon => addon.kind === 'extension').map(addon => addon.name);
  const added = await urlcode(t, dir, ['extensions', 'add', ...all]);
  assert.equal(added.status, 0, added.stderr);
  const result = JSON.parse(added.stdout) as { projectSha256: string; examples: string[] };
  assert.deepEqual(result.examples, []);
  const routes = Object.keys((await loadDocument(join(dir, 'app'))).routes).sort();
  // Only the capabilities are mounted: the Better Auth mount.
  assert.deepEqual(routes, ['/api/auth/*']);
  operatorCli(t, dir, 'urlcode-auth', ['migrate'], {});
  const env = { PROJECT_SHA256: result.projectSha256 };
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
  // #857: add recorded every installed file; verify compares them offline, and --online against the pinned tarballs.
  for (const args of [['artifacts', 'verify'], ['artifacts', 'verify', '--online']]) {
    const verified = await urlcode(t, dir, args);
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
    assert.ok((JSON.parse(verified.stdout) as { addons: { files: { status: string } }[] }).addons.every(item => item.files.status === 'match'), verified.stdout);
  }
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
  const first = await urlcode(t, one.dir, ['extensions', 'add', 'store', 'audit', 'auth', '--example']);
  const second = await urlcode(t, two.dir, ['extensions', 'add', 'auth', 'store', 'audit', '--example']);
  assert.equal(first.status, 0, first.stderr); assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(join(one.dir, 'host.mjs'), 'utf8'), await readFile(join(two.dir, 'host.mjs'), 'utf8'));
  assert.equal(await readFile(join(one.dir, 'app', 'urlcode.yaml'), 'utf8'), await readFile(join(two.dir, 'app', 'urlcode.yaml'), 'utf8'));
});

// #844: an extension package outside @jimhoyd, packed to a local tarball, installs through the same command as a
// released one. npm locks its sha512 integrity; core finds it by its urlcode.json descriptor, not its name.
test('an independent extension package installs from a pinned local tarball, validates, serves and removes', { timeout: 900000 }, async t => {
  const { root, dir } = await site(t);
  const packed = npmRun(['pack', '--silent', '--pack-destination', root, join(repositoryRoot, 'test', 'fixtures', 'addons', 'greeting')], root);
  assert.equal(packed.status, 0, packed.stderr);
  const tarball = join(root, packed.stdout.trim().split('\n').at(-1)!);
  const added = await urlcode(t, dir, ['extensions', 'add', tarball]);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  const result = JSON.parse(added.stdout) as { added: string[]; projectSha256: string };
  assert.deepEqual(result.added, ['greeting']);
  const lock = JSON.parse(await readFile(join(dir, 'package-lock.json'), 'utf8')) as { packages: Record<string, { integrity?: string; version?: string }> };
  assert.match(lock.packages['node_modules/@example/urlcode-greeting']?.integrity ?? '', /^sha512-/);
  const listed = await urlcode(t, dir, ['extensions', 'list', '--strict']);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  const report = JSON.parse(listed.stdout) as { addons: { name: string; package: string; independent?: boolean; pinned: boolean; version: string }[] };
  assert.deepEqual(report.addons.map(item => [item.name, item.package, item.independent, item.pinned, item.version]), [['greeting', '@example/urlcode-greeting', true, true, '2.3.4']]);
  assert.equal((await urlcode(t, dir, ['validate', '--project', 'app'])).status, 0);
  const env = { PROJECT_SHA256: result.projectSha256 };
  // The operator host imports the package's own ./extension entry and activates it.
  const activated = await urlcode(t, dir, ['validate', '--local', '--project', 'app', '--host-file', 'host.mjs', '--origin', 'https://site.example'], env);
  assert.equal(activated.status, 0, activated.stdout + activated.stderr);
  const removed = await urlcode(t, dir, ['extensions', 'remove', 'greeting']);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.doesNotMatch(await readFile(join(dir, 'host.mjs'), 'utf8'), /urlcode-greeting/);
});

// #844 operation 1: an artifact package outside @jimhoyd, packed to a local tarball, installs through `artifacts add`
// with npm's lock integrity as its pin, and `artifacts inspect` reads its standard documents offline. Its lifecycle
// scripts never run, and a tarball replaced after locking is refused.
test('an independent artifact package installs from a pinned local tarball, inspects offline, refuses a stale tarball and removes', { timeout: 900000 }, async t => {
  const { root, dir } = await site(t);
  const fixture = join(repositoryRoot, 'test', 'fixtures', 'addons', 'petstore-docs');
  const packFrom = (source: string): string => {
    const packed = npmRun(['pack', '--silent', '--pack-destination', root, source], root);
    assert.equal(packed.status, 0, packed.stderr);
    return join(root, packed.stdout.trim().split('\n').at(-1)!);
  };

  // A copy with install scripts: npm runs none of them (--ignore-scripts), and the artifact is refused as not inert.
  const scripted = join(root, 'scripted');
  await cp(fixture, scripted, { recursive: true });
  const marker = join(root, 'lifecycle.marker'), write = `node -e "require('fs').appendFileSync(${JSON.stringify(marker)}, 'ran')"`;
  const manifest = JSON.parse(await readFile(join(scripted, 'package.json'), 'utf8')) as Record<string, unknown>;
  await writeFile(join(scripted, 'package.json'), JSON.stringify({ ...manifest, version: '1.4.1', scripts: { preinstall: write, install: write, postinstall: write } }));
  const before = await readFile(join(dir, 'package.json'), 'utf8');
  const refused = await urlcode(t, dir, ['artifacts', 'add', packFrom(scripted)]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing @example\/urlcode-petstore-docs: .*(?:hasInstallScript|declares scripts)/);
  await assert.rejects(access(marker), 'no lifecycle script ran');
  assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), before, 'the refused artifact is rolled back');

  const tarball = packFrom(fixture);
  const added = await urlcode(t, dir, ['artifacts', 'add', tarball]);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  assert.deepEqual((JSON.parse(added.stdout) as { added: string[] }).added, ['petstore-docs']);
  const lock = JSON.parse(await readFile(join(dir, 'package-lock.json'), 'utf8')) as { packages: Record<string, { integrity?: string; resolved?: string }> };
  const entry = lock.packages['node_modules/@example/urlcode-petstore-docs']!;
  assert.match(entry.integrity ?? '', /^sha512-/);
  assert.match(entry.resolved ?? '', /^file:.*\.tgz$/);
  const listed = await urlcode(t, dir, ['artifacts', 'list', '--strict']);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  const report = JSON.parse(listed.stdout) as { addons: { name: string; package: string; independent?: boolean; pinned: boolean; version: string }[] };
  assert.deepEqual(report.addons.map(item => [item.name, item.package, item.independent, item.pinned, item.version]), [['petstore-docs', '@example/urlcode-petstore-docs', true, true, '1.4.0']]);

  const inspected = await urlcode(t, dir, ['artifacts', 'inspect', 'petstore-docs', '--strict']);
  assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr);
  const inspection = JSON.parse(inspected.stdout) as { artifact: { verification: string; integrity: string; version: string }; documents: { path: string; mediaType: string; kind: string; version: string | null; sha256: string; refs: { target: string }[]; diagnostics: unknown[] }[]; referencedFiles: { path: string }[] };
  assert.deepEqual([inspection.artifact.verification, inspection.artifact.integrity, inspection.artifact.version], ['local-tarball', entry.integrity, '1.4.0']);
  const installed = join(dir, 'node_modules', '@example', 'urlcode-petstore-docs');
  for (const document of inspection.documents) assert.equal(document.sha256, createHash('sha256').update(await readFile(join(installed, document.path))).digest('hex'), document.path);
  assert.deepEqual(inspection.documents.map(item => [item.path, item.mediaType, item.kind, item.version, item.diagnostics.length]), [
    ['openapi/petstore.yaml', 'application/vnd.oai.openapi', 'openapi', '3.1.0', 0],
    ['schemas/order.json', 'application/schema+json', 'json-schema', 'https://json-schema.org/draft/2020-12/schema', 0],
    ['README.md', 'text/markdown', 'markdown', null, 0],
  ]);
  assert.ok(inspection.documents[0]!.refs.some(ref => ref.target === 'schemas/pet.json#'), 'the OpenAPI document resolves its local file $ref');
  assert.deepEqual(inspection.referencedFiles.map(item => item.path), ['schemas/pet.json']);

  // #857: a hand edit to an installed file is caught offline, and --online names it against the published tarball.
  const petFile = join(installed, 'schemas', 'pet.json'), pet = await readFile(petFile);
  await writeFile(petFile, '{"edited":true}');
  const offline = await urlcode(t, dir, ['artifacts', 'verify', 'petstore-docs']);
  assert.equal(offline.status, 1, offline.stdout + offline.stderr);
  assert.match(offline.stdout, /installed files differ from addon-files\.lock\.json \(changed schemas\/pet\.json\)/);
  assert.notEqual((await urlcode(t, dir, ['artifacts', 'inspect', 'petstore-docs'])).status, 0);
  const online = await urlcode(t, dir, ['artifacts', 'verify', 'petstore-docs', '--online']);
  assert.equal(online.status, 1, online.stdout + online.stderr);
  const onlineReport = JSON.parse(online.stdout) as { addons: { online: { integrity: string; installed: { changed: string[] }; recorded: { counts: { changed: number } } } }[] };
  assert.deepEqual([onlineReport.addons[0]!.online.integrity, onlineReport.addons[0]!.online.installed.changed, onlineReport.addons[0]!.online.recorded.counts.changed], ['match', ['schemas/pet.json'], 0]);
  await writeFile(petFile, pet);

  // Replace the locked tarball: npm's recorded integrity no longer describes it, so inspection and list --strict refuse.
  const original = await readFile(tarball);
  await writeFile(tarball, await readFile(packFrom(scripted)));
  const stale = await urlcode(t, dir, ['artifacts', 'inspect', 'petstore-docs']);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /no longer matches the sha512 integrity package-lock\.json recorded/);
  assert.notEqual((await urlcode(t, dir, ['artifacts', 'list', '--strict'])).status, 0);
  await writeFile(tarball, original);

  const removed = await urlcode(t, dir, ['artifacts', 'remove', 'petstore-docs']);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal((JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies['@example/urlcode-petstore-docs'], undefined);
});
