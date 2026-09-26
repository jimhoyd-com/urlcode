// The store's reload hand-off (core RIM-EXT-HANDOFF-001, #777): the replacement runtime joins the serving
// activation's directory lease instead of failing on its lock, and every view of a data file writes through one path.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { createStore, storeExtension } from '../src/index.ts';
import { lockStoreDirectory } from '../src/store.ts';

const origin = 'https://reload.example.test';
const todos = { mount: '/api/todos', fields: { title: { type: 'string', required: true, minLength: 1, maxLength: 40 }, done: { type: 'boolean', default: false } }, maxRecords: 10, maxRecordBytes: 512 };
const json = { 'content-type': 'application/json' };
/** Activates after the store and throws on demand: a reload that fails after the store accepted its hand-off. */
function breaker(projectSha256: string): RuntimeExtension {
  return { name: 'breaker', version: '1', projectSha256, targets: ['node'], schema: { type: 'object', properties: { fail: { type: 'boolean' } }, required: ['fail'], additionalProperties: false },
    activate(config) { if (config.fail) throw new Error('breaker refused this configuration'); return { handle: () => ({ status: 204, headers: [] }) }; } };
}
const document = (collection: object = todos, fail = false, text = 'v1') => ({ version: '1',
  extensions: { store: { version: '1', config: { collections: { todos: collection } } }, breaker: { version: '1', config: { fail } } },
  routes: { '/api/todos/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] }, '/breaker/*': { extension: 'breaker', methods: ['GET'] }, '/hello': { respond: { text } } } });

async function site(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'store-reload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), data = join(root, 'data');
  await mkdir(project);
  const edit = (collection?: object, fail?: boolean, text?: string) => writeFile(join(project, 'urlcode.yaml'), JSON.stringify(document(collection, fail, text)));
  await edit();
  const projectSha256 = await inspectExtensionRevision(project);
  const store = createStore({ directory: data, projectSha256 });
  return { project, data, edit, store, projectSha256, extensions: [store.registration, breaker(projectSha256)] };
}
const exists = (path: string) => access(path).then(() => true, () => false);
const titles = async (call: (path: string, init?: RequestInit) => Promise<Response>) => ((await (await call('/api/todos')).json()) as { items: { title: string }[] }).items.map(item => item.title);
const stored = async (data: string) => (JSON.parse(await readFile(join(data, 'todos.json'), 'utf8')) as { records: { title: string }[] }).records.map(record => record.title);

test('a dev reload shares the store: data written before is served, writes after persist, the lock stays single (#777)', async t => {
  const { project, data, edit, store, projectSha256, extensions } = await site(t);
  const events: Record<string, unknown>[] = [];
  const app = await startServer({ project, origin, port: 0, followExtensionPinOnReload: true, extensions, log: event => { events.push(event as Record<string, unknown>); } });
  let open = true;
  t.after(async () => { if (open) await app.close(); });
  const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${app.address.port}${path}`, init);
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'before' }) })).status, 201);
  await edit(todos, false, 'v2');
  assert.equal(await app.reload(), true, 'the replacement joins the lease instead of failing on the lock');
  assert.equal(events.filter(event => event.event === 'reload').at(-1)?.status, 'ok');
  assert.equal(await (await call('/hello')).text(), 'v2');
  assert.deepEqual(await titles(call), ['before'], 'data written before the reload is served');
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'after' }) })).status, 201);
  assert.deepEqual(await stored(data), ['before', 'after']);
  assert.deepEqual(store.exports.records('todos').list(null).items.map(record => record.title), ['before', 'after'], 'the records export follows the served activation');
  // The retired runtime closes once idle; the lock is still held for the replacement, and still one writer.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(await exists(join(data, '.store.lock')), 'closing the retired runtime did not release the lock');
  await assert.rejects(lockStoreDirectory(data), /already locked by this process/, 'an independent opener in this process is refused');
  await assert.rejects(createRuntime(project, { origin, extensions: [storeExtension({ directory: data, projectSha256 }), breaker(projectSha256)], acceptedExtensionPin: { from: projectSha256 } }), /Store directory is already locked by this process/, 'so is another store registration over the directory');
  // A changed collection declaration reloads too: the new declaration serves the same file.
  await edit({ ...todos, fields: { ...todos.fields, note: { type: 'string', maxLength: 20 } } }, false, 'v3');
  assert.equal(await app.reload(), true);
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'noted', note: 'new field' }) })).status, 201);
  assert.deepEqual(await titles(call), ['before', 'after', 'noted']);
  open = false; await app.close();
  assert.equal(await exists(join(data, '.store.lock')), false, 'the last reference releases the lock');
  await store.close();
});

test('a reload that fails after the store accepted its hand-off leaves the serving store working (#777)', async t => {
  const { project, data, edit, store, extensions } = await site(t);
  const diagnostics: string[] = [];
  const app = await startServer({ project, origin, port: 0, followExtensionPinOnReload: true, extensions, log: () => {}, debugErrors: true, diagnostics: line => { diagnostics.push(line); } });
  t.after(async () => { await app.close(); await store.close(); });
  const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${app.address.port}${path}`, init);
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'one' }) })).status, 201);
  // Another extension throws after the store joined the lease.
  await edit(todos, true, 'v2');
  assert.equal(await app.reload(), false);
  assert.match(JSON.parse(diagnostics.at(-1)!).message, /Extension "breaker" failed to activate/);
  // The store's own activation fails after joining (a declaration its data breaks).
  await edit({ ...todos, fields: { ...todos.fields, title: { ...todos.fields.title, maxLength: 1 } } }, false, 'v2');
  assert.equal(await app.reload(), false);
  assert.match(JSON.parse(diagnostics.at(-1)!).message, /Extension "store" failed to activate: Collection todos: a stored record no longer matches the declared fields/);
  assert.equal(await (await call('/hello')).text(), 'v1', 'the last-good snapshot keeps serving');
  assert.ok(await exists(join(data, '.store.lock')), 'neither failed replacement released the lock');
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'two' }) })).status, 201, 'and the serving store still writes');
  assert.deepEqual(await titles(call), ['one', 'two']);
  assert.deepEqual(await stored(data), ['one', 'two']);
  assert.equal(store.exports.active, true, 'the records export still reaches the serving activation');
  assert.deepEqual(store.exports.records('todos').list(null).items.map(record => record.title), ['one', 'two']);
  await edit(todos, false, 'v3');
  assert.equal(await app.reload(), true);
  assert.deepEqual(await titles(call), ['one', 'two']);
});

test('during the overlap both runtimes write through one path and see each other at once (#777)', async t => {
  const { project, data, edit, store, projectSha256, extensions } = await site(t);
  t.after(() => store.close());
  const serving = await createRuntime(project, { origin, extensions });
  const post = (runtime: typeof serving, title: string) => runtime.handle({ target: '/api/todos', method: 'POST', headers: new Headers(json), body: Buffer.from(JSON.stringify({ title })) });
  const list = async (runtime: typeof serving) => (JSON.parse(Buffer.from((await runtime.handle({ target: '/api/todos' })).body as Uint8Array).toString()) as { items: { title: string }[] }).items.map(item => item.title);
  assert.equal((await post(serving, 'a')).status, 201);
  // A tighter declaration for the replacement: the retiring runtime's writes that break it make it answer 503.
  await edit({ ...todos, fields: { ...todos.fields, title: { ...todos.fields.title, maxLength: 5 } } });
  const next = await createRuntime(project, { origin, extensions, replacing: serving, acceptedExtensionPin: { from: projectSha256 } });
  assert.deepEqual(await list(next), ['a']);
  assert.equal((await post(next, 'b')).status, 201);
  assert.deepEqual(await list(serving), ['a', 'b'], 'the serving view sees the replacement write at once');
  assert.equal((await post(serving, 'c')).status, 201);
  assert.deepEqual(await list(next), ['a', 'b', 'c'], 'and the reverse');
  assert.deepEqual(await stored(data), ['a', 'b', 'c'], 'no write was lost to a second writer');
  assert.equal((await post(serving, 'far too long')).status, 201, 'the retiring declaration still admits it');
  const refused = await next.handle({ target: '/api/todos' });
  assert.equal(refused.status, 503, 'a view that cannot represent the committed state refuses instead of overwriting it');
  await serving.close();
  assert.ok(await exists(join(data, '.store.lock')));
  await next.close();
  assert.equal(await exists(join(data, '.store.lock')), false);
});
