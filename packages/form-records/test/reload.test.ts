// `urlcode dev`'s hot reload of the site `urlcode init <site> --with admin,form-records --example` generates (#777,
// RIM-EXT-HANDOFF-001): the real ui, audit, mail, abuse, auth, admin, store, forms and form-records packages, composed
// by the generated host.mjs, served with a canonical origin and the dev server's followed revision pin. The store
// takes an exclusive directory lock on every activation, so a reload has to hand it over rather than overlap.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addAddons, initSite, startServer } from '@jimhoyd/urlcode';
import type { RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { cleanup } from './cleanup.ts';

const origin = 'https://reload.example.test';
const repository = fileURLToPath(new URL('../../../', import.meta.url));

function environment(t: TestContext, values: Record<string, string>): void {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  cleanup(t, () => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}
/**
 * `urlcode init <site> --with admin,form-records --example` against this checkout: `initSite`, then `addAddons` with
 * core's development manifest (every add-on at its workspace source), through the add-on tests' offline npm stand-in
 * that links each `file:` dependency. The site's core dependency is this checkout, as `test/addons.integration.ts` does.
 */
async function generatedSite(t: TestContext): Promise<{ site: string; app: string; projectSha256: string }> {
  const root = await mkdtemp(join(tmpdir(), 'form-records-reload-'));
  cleanup(t, () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  environment(t, { URLCODE_NPM: join(repository, 'test', 'fixtures', 'addons', 'fake-npm.mjs') });
  const { site } = await initSite(join(root, 'site'));
  const packageFile = join(site, 'package.json');
  const pkg = JSON.parse(await readFile(packageFile, 'utf8')) as { dependencies: Record<string, string> };
  pkg.dependencies['@jimhoyd/urlcode'] = `file:${repository}`;
  await writeFile(packageFile, JSON.stringify(pkg, null, 2) + '\n');
  const added = await addAddons(site, 'extension', ['admin', 'form-records'], { example: true });
  assert.deepEqual([...added.examples].sort(), ['auth', 'form-records', 'forms', 'store']);
  assert.ok(added.projectSha256);
  return { site, app: join(site, 'app'), projectSha256: added.projectSha256 };
}
/** The generated host.mjs, imported as `urlcode dev --host-file host.mjs` does, with the reviewed pin. */
async function generatedHost(t: TestContext, site: string, projectSha256: string): Promise<{ extensions: RuntimeExtension[]; close(): Promise<void> }> {
  environment(t, { PROJECT_SHA256: projectSha256, AUTH_ORIGIN: origin });
  const host = (await import(pathToFileURL(join(site, 'host.mjs')).href) as { default: { extensions: RuntimeExtension[]; close(): Promise<void> } }).default;
  cleanup(t, () => host.close());
  assert.ok(host.extensions.some(extension => extension.name === 'store'));
  return host;
}
const lockOf = (site: string): Promise<string> => readFile(join(site, 'data', 'store', '.store.lock'), 'utf8');
const strays = async (site: string): Promise<string[]> => (await readdir(join(site, 'data', 'store'))).filter(name => name.startsWith('.store.lock.'));
async function page(port: number, path: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
  return { status: response.status, text: await response.text() };
}

test('the generated stateful site hot reloads an edited contact title, then keeps its last-good snapshot and single store lock when a reload is refused (#777)', { timeout: 120000 }, async t => {
  const { site, app, projectSha256 } = await generatedSite(t);
  const host = await generatedHost(t, site, projectSha256);
  const events: Record<string, unknown>[] = [], diagnostics: Record<string, unknown>[] = [];
  const server = await startServer({ project: app, extensions: host.extensions, port: 0, host: '127.0.0.1', origin, followExtensionPinOnReload: true, debugErrors: true,
    log: event => { events.push(event as Record<string, unknown>); }, diagnostics: line => { diagnostics.push(JSON.parse(line) as Record<string, unknown>); } });
  // Registered after the host's close, so it runs first: the server releases the store before the host closes.
  cleanup(t, () => server.close());
  const port = server.address.port;
  const before = await page(port, '/contact');
  assert.equal(before.status, 200);
  assert.match(before.text, /Contact us/);
  const lock = await lockOf(site);
  assert.match(lock, new RegExp(`^${process.pid}:`));

  // Change only the contact form's title, as the reproduction does.
  const yamlFile = join(app, 'urlcode.yaml'), original = await readFile(yamlFile, 'utf8');
  assert.equal(original.split('title: Contact us').length, 2, 'the generated project names the contact title once');
  const changed = original.replace('title: Contact us', 'title: Changed contact title');
  await writeFile(yamlFile, changed);
  assert.equal(await server.reload(), true, JSON.stringify(diagnostics.at(-1)));
  assert.deepEqual(events.filter(event => event.event === 'reload').map(event => event.status), ['ok']);
  assert.deepEqual(events.find(event => event.event === 'extension_pin_followed')?.from, projectSha256);
  const after = await page(port, '/contact');
  assert.equal(after.status, 200);
  assert.match(after.text, /Changed contact title/);
  assert.doesNotMatch(after.text, /Contact us/);
  assert.equal(await lockOf(site), lock, 'the handed-over store holds the same process lock');
  for (const path of ['/account/login', '/api/todos', '/todos', '/private', '/todo-form']) {
    const answered = await page(port, path);
    assert.ok(answered.status !== 404 && answered.status < 500, `${path} answered ${answered.status} after the reload`);
  }

  // A refused reload: the edit passes every static check, and form-records refuses at activation, after the store
  // (which it requires) has already taken the lock for the replacement. The last-good snapshot keeps serving.
  const broken = changed.replace('title: Changed contact title', 'title: Rejected contact title').replace(/(mount: \/todo-form\n\s+collection: )todos\n/, '$1missing\n');
  assert.equal(broken.split('collection: missing').length, 2, 'the form-records example names its store collection after its mount');
  await writeFile(yamlFile, broken);
  assert.equal(await server.reload(), false);
  assert.deepEqual(events.filter(event => event.event === 'reload').map(event => event.status), ['ok', 'rejected']);
  const rejected = diagnostics.at(-1)!;
  assert.equal(rejected.event, 'reload_rejected');
  assert.match(String(rejected.message), /^Extension "form-records" failed to activate: .*missing/);
  assert.doesNotMatch(String(rejected.message), /locked/);
  assert.equal(rejected.extensions, undefined, 'the last-good extensions were restored');
  const kept = await page(port, '/contact');
  assert.equal(kept.status, 200);
  assert.match(kept.text, /Changed contact title/);
  assert.doesNotMatch(kept.text, /Rejected contact title/);
  assert.equal((await page(port, '/_urlcode/ready')).status, 200);
  assert.equal(await lockOf(site), lock, 'exactly one store instance holds the lock, the restored one');
  assert.deepEqual(await strays(site), []);

  // A refused reload whose edit the restored ui would trip over if it resolved the store's screens from the file on
  // disk: the edited store screen names a collection the store does not declare. The restore resolves them from the
  // last-good snapshot's declarations instead.
  await writeFile(yamlFile, changed.replace(/(\/todos:\n\s+collection: )todos\n/, '$1missing\n'));
  assert.notEqual(await readFile(yamlFile, 'utf8'), changed, 'the store example declares a /todos screen');
  assert.equal(await server.reload(), false);
  assert.match(String(diagnostics.at(-1)?.message), /Screen \/todos: collection missing is not declared/);
  assert.doesNotMatch(String(diagnostics.at(-1)?.message), /restoring the last-good extensions also failed/);
  assert.equal(diagnostics.at(-1)?.extensions, undefined);
  assert.match((await page(port, '/contact')).text, /Changed contact title/);
  assert.notEqual((await page(port, '/todos')).status, 404);
  assert.equal(await lockOf(site), lock);

  // Fixing the edit hands over again.
  await writeFile(yamlFile, changed.replace('title: Changed contact title', 'title: Fixed contact title'));
  assert.equal(await server.reload(), true, JSON.stringify(diagnostics.at(-1)));
  assert.match((await page(port, '/contact')).text, /Fixed contact title/);

  // The one live activation releases the lock on close: nothing else still holds it.
  await server.close();
  await assert.rejects(lockOf(site), { code: 'ENOENT' });
  assert.deepEqual(await strays(site), []);
});
