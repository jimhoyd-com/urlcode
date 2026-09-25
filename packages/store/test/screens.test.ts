// The store owns its CRUD screen (#709): it declares screens in its own configuration and contributes a generic
// description of each to ui through contributes.ui. ui never reads extensions.store. This composes both real
// extensions, serves the screen and uses the API the screen binds to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import ui from '@jimhoyd/urlcode-ui/extension';
import store from '../src/extension.ts';
import { contributedScreens, screensSchema, storeScreens } from '../src/screens.ts';
import { storeConfigSchema, storeExtension } from '../src/store.ts';

const origin = 'https://todo.example.test';
const fields = { title: { type: 'string', required: true, minLength: 1, maxLength: 200 }, done: { type: 'boolean', default: false } };

function withSha(t: test.TestContext, sha: string): void {
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = sha;
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
}

test('the store configuration schema carries the screens block', async () => {
  assert.equal(storeConfigSchema.properties.screens, screensSchema);
  const Ajv = ((await import('ajv')) as unknown as { default: new (options: object) => { compile(schema: object): (data: unknown) => boolean } }).default;
  const validate = new Ajv({ strict: true }).compile(storeConfigSchema);
  const config = (screens: unknown) => ({ collections: { todos: { mount: '/api/todos', fields } }, screens });
  assert.equal(validate(config({ '/todos': { collection: 'todos', title: 'Todos' } })), true);
  assert.equal(validate(config({ '/todos': { collection: 'todos', columns: ['title', { field: 'done', label: 'Done?' }] } })), true);
  assert.equal(validate(config({ todos: { collection: 'todos' } })), false);
  assert.equal(validate(config({ '/todos': {} })), false);
  assert.equal(validate(config({ '/todos': { collection: 'todos', script: 'x' } })), false);
  assert.equal(validate(config({ '/todos': { collection: 'todos', columns: [] } })), false);
  assert.equal(validate(config({ '/todos': { collection: 'todos', columns: [{ field: 'title', extra: 1 }] } })), false);
});

test('storeScreens hands ui a generic description and refuses an undeclared collection', () => {
  const collections = { todo_items: { mount: '/api/todos', fields, sortable: ['title'], readOnly: false, maxRecords: 10 } };
  assert.deepEqual(storeScreens({ collections, screens: { '/todos': { collection: 'todo_items' } } }), {
    '/todos': { title: 'Todo items', collection: { mount: '/api/todos', fields, readOnly: false, sortable: ['title'] } },
  });
  assert.deepEqual(storeScreens({ collections }), {});
  assert.deepEqual(storeScreens(undefined), {});
  assert.throws(() => storeScreens({ collections, screens: { '/notes': { collection: 'notes' } } }), /Screen \/notes: collection notes is not declared/);
});

test('contributedScreens reads the store block of the project and nothing else', async t => {
  const root = await mkdtemp(join(tmpdir(), 'store-screens-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'urlcode.yaml'), JSON.stringify({ version: '1', routes: { '/': { respond: { text: 'hi' } } } }));
  assert.deepEqual(await contributedScreens({ root }), {}, 'a project that does not declare the store contributes no screens');
  await writeFile(join(root, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { store: { version: '1', config: { collections: { todos: { mount: '/api/todos', fields } }, screens: { '/todos': { collection: 'todos', title: 'Mine' } } } } }, routes: { '/api/todos/*': { extension: 'store' } } }));
  assert.equal((await contributedScreens({ root }))['/todos']?.title, 'Mine');
});

test('store activation refuses a screen naming a collection it does not declare', async t => {
  const root = await mkdtemp(join(tmpdir(), 'store-screens-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'); await mkdir(project);
  const registration = storeExtension({ directory: join(root, 'data'), projectSha256: 'a'.repeat(64) });
  await assert.rejects(Promise.resolve().then(() => registration.activate({ collections: { todos: { mount: '/api/todos', fields } }, screens: { '/notes': { collection: 'notes' } } }, { origin, target: 'node', projectSha256: 'a'.repeat(64), mounts: ['/api/todos'], root: project })), /collection notes is not declared/);
});

test('end to end: the scaffolded Todos screen is served by ui from the store contribution, and its API works', async t => {
  const root = await mkdtemp(join(tmpdir(), 'store-screens-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'); await mkdir(project);
  const request = { site: root, project, installed: ['store', 'ui'], acknowledgements: ['store:public-write'] };
  const results: Record<string, ScaffoldResult> = { ui: await ui.definition.scaffold!(request), store: await store.definition.scaffold!(request) };
  for (const result of Object.values(results)) for (const file of result.files ?? []) {
    await mkdir(join(root, file.path, '..'), { recursive: true });
    await writeFile(join(root, file.path), file.content);
  }
  const extensions = Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { version: '1', config: result.config }]));
  // ui's own block carries no screens: the screen is declared by the store, next to its collection.
  assert.equal('screens' in results.ui!.config, false);
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions, routes: { ...results.ui!.routes, ...results.store!.routes } }));
  withSha(t, await inspectExtensionRevision(project));
  const host = await composeHost(pathToFileURL(join(root, 'host.mjs')), [ui(), store({ directory: join(root, 'data', 'store') })]);
  t.after(() => host.close?.());
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: host.extensions! });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address.port}`;
  const page = await fetch(`${base}/todos`);
  const html = await page.text();
  assert.equal(page.status, 200, html);
  assert.match(html, /data-slot="card-title">Todos<\/h2>/);
  assert.match(html, /data-api="\/api\/todos"/);
  const script = /src="(\/assets\/ui\/static\/crud\.[0-9a-f]{12}\.js)"/.exec(html);
  assert.ok(script, 'the page loads the kit crud script');
  assert.equal((await fetch(`${base}${script[1]}`)).status, 200);
  const created = await fetch(`${base}/api/todos`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ title: 'first' }) });
  assert.equal(created.status, 201, await created.clone().text());
  const listed = await (await fetch(`${base}/api/todos`)).json() as { items: { title: string }[] };
  assert.deepEqual(listed.items.map(item => item.title), ['first']);
});
