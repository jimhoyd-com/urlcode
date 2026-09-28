// The store across a reload (core RIM-EXT-HANDOFF-001, #777): the replacement runtime's activation and the serving
// one are views over the registration's one database connection, so both write through it and see each other at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { createStore } from '../src/index.ts';
import { cleanup } from './cleanup.ts';
import { records } from './rows.ts';

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
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), data = join(root, 'data'), database = join(data, 'store.sqlite');
  await mkdir(project);
  const edit = (collection?: object, fail?: boolean, text?: string) => writeFile(join(project, 'urlcode.yaml'), JSON.stringify(document(collection, fail, text)));
  await edit();
  const projectSha256 = await inspectExtensionRevision(project);
  const store = createStore({ database, projectSha256 });
  return { project, data, database, edit, store, projectSha256, extensions: [store.registration, breaker(projectSha256)] };
}
/** Only the database file is left once the last connection closed and checkpointed its write-ahead log. */
const closedCleanly = async (data: string) => assert.deepEqual(await readdir(data), ['store.sqlite']);
const titles = async (call: (path: string, init?: RequestInit) => Promise<Response>) => ((await (await call('/api/todos')).json()) as { items: { title: string }[] }).items.map(item => item.title);
const stored = async (database: string) => records(database, 'todos').map(record => record.title);

test('a dev reload shares the store: data written before is served, writes after persist, one connection throughout (#777)', async t => {
  const { project, data, database, edit, store, extensions } = await site(t);
  const events: Record<string, unknown>[] = [];
  const app = await startServer({ project, origin, port: 0, followExtensionPinOnReload: true, extensions, log: event => { events.push(event as Record<string, unknown>); } });
  let open = true;
  cleanup(t, async () => { if (open) await app.close(); });
  const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${app.address.port}${path}`, init);
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'before' }) })).status, 201);
  await edit(todos, false, 'v2');
  assert.equal(await app.reload(), true, 'the replacement joins the lease instead of failing on the lock');
  assert.equal(events.filter(event => event.event === 'reload').at(-1)?.status, 'ok');
  assert.equal(await (await call('/hello')).text(), 'v2');
  assert.deepEqual(await titles(call), ['before'], 'data written before the reload is served');
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'after' }) })).status, 201);
  assert.deepEqual(await stored(database), ['before', 'after']);
  assert.deepEqual(store.exports.records('todos').list(null).items.map(record => record.title), ['before', 'after'], 'the records export follows the served activation');
  // The retired runtime closes once idle; the replacement keeps the connection open and keeps writing.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'idle' }) })).status, 201, 'closing the retired runtime did not close the database');
  // A changed collection declaration reloads too: the new declaration serves the same file.
  await edit({ ...todos, fields: { ...todos.fields, note: { type: 'string', maxLength: 20 } } }, false, 'v3');
  assert.equal(await app.reload(), true);
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'noted', note: 'new field' }) })).status, 201);
  assert.deepEqual(await titles(call), ['before', 'after', 'idle', 'noted']);
  open = false; await app.close();
  await closedCleanly(data);
  await store.close();
});

test('a reload that fails after the store accepted its hand-off leaves the serving store working (#777)', async t => {
  const { project, database, edit, store, extensions } = await site(t);
  const diagnostics: string[] = [];
  const app = await startServer({ project, origin, port: 0, followExtensionPinOnReload: true, extensions, log: () => {}, debugErrors: true, diagnostics: line => { diagnostics.push(line); } });
  cleanup(t, async () => { await app.close(); await store.close(); });
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
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'two' }) })).status, 201, 'and the serving store still writes');
  assert.deepEqual(await titles(call), ['one', 'two']);
  assert.deepEqual(await stored(database), ['one', 'two']);
  assert.equal(store.exports.active, true, 'the records export still reaches the serving activation');
  assert.deepEqual(store.exports.records('todos').list(null).items.map(record => record.title), ['one', 'two']);
  await edit(todos, false, 'v3');
  assert.equal(await app.reload(), true);
  assert.deepEqual(await titles(call), ['one', 'two']);
});

test('during the overlap both runtimes write through one path and see each other at once (#777)', async t => {
  const { project, data, database, edit, store, projectSha256, extensions } = await site(t);
  cleanup(t, () => store.close());
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
  assert.deepEqual(await stored(database), ['a', 'b', 'c'], 'no write was lost to a second writer');
  assert.equal((await post(serving, 'far too long')).status, 201, 'the retiring declaration still admits it');
  const refused = await next.handle({ target: '/api/todos' });
  assert.equal(refused.status, 503, 'a view that cannot represent the committed state refuses instead of overwriting it');
  await serving.close();
  assert.equal((await next.handle({ target: '/api/todos' })).status, 503, 'still refused after the retiring runtime closed: the row stays');
  await next.close();
  await closedCleanly(data);
});
