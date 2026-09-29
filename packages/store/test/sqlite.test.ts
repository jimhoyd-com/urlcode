// The SQLite engine's own guarantees (#835): restart persistence, race-free conditional writes and quotas inside one
// transaction, forward-only schema initialization, what another connection holding the lock does to a write, and a
// consistent online copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sqlite from 'node:sqlite';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { ExtensionActivation } from '@jimhoyd/urlcode/extensions';
import { STORE_APPLICATION_ID, STORE_SCHEMA_VERSION, StoreError, createStore, storeExtension } from '../src/index.ts';
import { openStoreDatabase } from '../src/database.ts';
import { cleanup } from './cleanup.ts';
import { records } from './rows.ts';

const origin = 'https://sqlite.example.test', pin = 'a'.repeat(64), json = { 'content-type': 'application/json' };
const todos = { mount: '/api/todos', maxRecords: 3, schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 40 }, done: { type: 'boolean' } } }, defaults: { done: false } };

async function temp(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'store-sqlite-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'app'));
  return root;
}
const activation = (root: string): ExtensionActivation => ({ origin, target: 'node', projectSha256: pin, mounts: ['/api/todos'], principalMounts: [], root: join(root, 'app') });
/** A store over `database`, activated directly (no server); closed, database included, by the test's cleanup. */
async function activate(t: TestContext, root: string, database = join(root, 'data', 'store.sqlite')) {
  const store = createStore({ database, projectSha256: pin });
  const instance = await store.registration.activate({ collections: { todos } }, activation(root));
  let open = true;
  const close = async () => { if (open) { open = false; await instance.close?.(); await store.close(); } };
  cleanup(t, close);
  return { store, instance, database, todos: store.exports.records('todos'), close };
}
async function serve(t: TestContext, root: string) {
  const project = join(root, 'app'), database = join(root, 'data', 'store.sqlite');
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { store: { version: '1', config: { collections: { todos } } } }, routes: { '/api/todos/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] } } }));
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: [storeExtension({ database, projectSha256: await inspectExtensionRevision(project) })] });
  cleanup(t, () => app.close());
  return { database, call: (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${app.address.port}${path}`, init) };
}

test('records, ETags and retained state survive closing the database and opening it again', async t => {
  const root = await temp(t);
  const first = await activate(t, root);
  const one = await first.todos.create(null, { title: 'one' });
  const changed = await first.todos.update(null, one.record.id as string, { done: true }, { ifMatch: one.etag });
  await first.todos.create(null, { title: 'two' });
  await first.close();
  const second = await activate(t, root);
  assert.deepEqual(second.todos.list(null).items.map(record => [record.title, record.done]), [['one', true], ['two', false]], 'creation order kept');
  assert.equal(second.todos.get(null, one.record.id as string).etag, changed.etag, 'the ETag is derived from stored state only');
  await assert.rejects(second.todos.update(null, one.record.id as string, { done: false }, { ifMatch: one.etag }), (error: unknown) => error instanceof StoreError && error.status === 412);
});

test('concurrent conditional writes on one record: exactly one wins, every other answers 412 and changes nothing', async t => {
  const { call, database } = await serve(t, await temp(t));
  const created = await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'race' }) });
  const { id } = await created.json() as { id: string };
  const etag = created.headers.get('etag')!;
  // Fired together immediately after the create, so every writer holds the same If-Match and most land in the same
  // millisecond as the create: the ETag still moves on each write (updatedAt never repeats for one record).
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => call(`/api/todos/${id}`, { method: 'PATCH', headers: { ...json, 'if-match': etag }, body: JSON.stringify({ title: `writer ${index}` }) })));
  const statuses = responses.map(response => response.status);
  assert.equal(statuses.filter(status => status === 200).length, 1, statuses.join(','));
  assert.equal(statuses.filter(status => status === 412).length, 7, statuses.join(','));
  const winner = await responses.find(response => response.status === 200)!.json() as { title: string };
  assert.equal(records(database, 'todos')[0]!.title, winner.title, 'the stored record is the winner\'s');
  // Back-to-back unconditional writes still give every version its own ETag.
  const etags = new Set<string>();
  for (let index = 0; index < 5; index++) etags.add((await call(`/api/todos/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ done: index % 2 === 0 }) })).headers.get('etag')!);
  assert.equal(etags.size, 5);
});

test('concurrent creates never overshoot maxRecords', async t => {
  const { call, database } = await serve(t, await temp(t));
  const responses = await Promise.all(Array.from({ length: 10 }, (_, index) => call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: `t${index}` }) })));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 201, 201, 409, 409, 409, 409, 409, 409, 409]);
  assert.equal(records(database, 'todos').length, 3);
});

test('schema initialization is forward-only and idempotent: reopening changes nothing', async t => {
  const root = await temp(t), path = join(root, 'data', 'store.sqlite');
  const schema = () => { const db = new sqlite.DatabaseSync(path); try { return { version: db.prepare('PRAGMA user_version').get()!.user_version, application: db.prepare('PRAGMA application_id').get()!.application_id, objects: db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() }; } finally { db.close(); } };
  (await openStoreDatabase(path)).close();
  const initial = schema();
  assert.equal(initial.version, STORE_SCHEMA_VERSION); assert.equal(initial.application, STORE_APPLICATION_ID);
  assert.deepEqual(initial.objects.map(object => object.name), ['store_audit_drain', 'store_audit_outbox', 'store_audit_outbox_collection', 'store_audit_outbox_order', 'store_idempotency', 'store_idempotency_order', 'store_records', 'store_records_order', 'store_records_owner']);
  const { todos: api, close } = await activate(t, root, path);
  await api.create(null, { title: 'kept' });
  await close();
  for (let round = 0; round < 2; round++) (await openStoreDatabase(path)).close();
  assert.deepEqual(schema(), initial, 'no step ran twice');
  assert.deepEqual(records(path, 'todos').map(record => record.title), ['kept'], 'and no data was touched');
});

test('a write waits for a lock another connection holds, then answers 503 and writes nothing; the next write succeeds', async t => {
  const { call, database } = await serve(t, await temp(t));
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'before' }) })).status, 201);
  // Another connection (another process would behave the same) holds the write lock past the busy timeout.
  const other = new sqlite.DatabaseSync(database);
  other.exec('BEGIN IMMEDIATE');
  try {
    const started = Date.now();
    const blocked = await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'blocked' }) });
    assert.equal(blocked.status, 503);
    assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, 'storage_unavailable');
    assert.ok(Date.now() - started >= 1500, 'it waited for the busy timeout first');
    assert.equal((await call('/api/todos')).status, 200, 'reads are not blocked by a writer in WAL mode');
  } finally { other.exec('ROLLBACK'); other.close(); }
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'after' }) })).status, 201);
  assert.deepEqual(records(database, 'todos').map(record => record.title), ['before', 'after']);
});

test('an online copy through SQLite\'s backup API is consistent while the server keeps serving', { skip: typeof sqlite.backup !== 'function' && 'node:sqlite backup() needs Node 22.16 or newer' }, async t => {
  const root = await temp(t);
  const { call, database } = await serve(t, root);
  for (const title of ['a', 'b']) assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title }) })).status, 201);
  const source = new sqlite.DatabaseSync(database, { readOnly: true });
  try { await sqlite.backup(source, join(root, 'copy.sqlite')); } finally { source.close(); }
  assert.deepEqual(records(join(root, 'copy.sqlite'), 'todos').map(record => record.title), ['a', 'b']);
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'c' }) })).status, 201, 'the server kept writing');
});
