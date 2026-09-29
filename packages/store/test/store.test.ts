import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, addRecipe, runProjectTests } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { storeExtension } from '../src/index.ts';
import { STORE_APPLICATION_ID, STORE_SCHEMA_VERSION } from '../src/index.ts';
import { cleanup } from './cleanup.ts';
import { records, seed } from './rows.ts';

const origin = 'https://store.example.test';
const todos = { mount: '/api/todos', fields: { title: { type: 'string', required: true, minLength: 1, maxLength: 20 }, done: { type: 'boolean', default: false }, priority: { type: 'integer', minimum: 1, maximum: 5 }, kind: { type: 'string', enum: ['a', 'b'] } }, maxRecords: 3, maxRecordBytes: 512 };
const json = { 'content-type': 'application/json' };

async function boot(t: TestContext, collection: object = todos, extraRoutes: Record<string, unknown> = {}, extraConfig: Record<string, unknown> = {}, aliasOrigins?: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'store-test-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), data = join(root, 'data'), database = join(data, 'store.sqlite');
  await mkdir(project);
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { store: { version: '1', config: { collections: { todos: collection }, ...extraConfig } } }, routes: { '/api/todos/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] }, ...extraRoutes } }));
  const projectSha256 = await inspectExtensionRevision(project);
  const start = () => startServer({ project, origin, ...(aliasOrigins ? { aliasOrigins } : {}), port: 0, log: () => {}, extensions: [storeExtension({ database, projectSha256 })] });
  const app = await start();
  let open = true;
  // Registered after the directory, so it runs first: the database is closed before its file is removed.
  cleanup(t, async () => { if (open) await app.close(); });
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string; redirect?: RequestRedirect } = {}) => fetch(`http://127.0.0.1:${app.address.port}${path}`, init);
  /** A server started again over the same database; closed by the test's cleanup. */
  const restart = async () => { const again = await start(); cleanup(t, () => again.close()); return again; };
  return { root, project, data, database, app, call, start, restart, stop: async () => { open = false; await app.close(); } };
}

test('creates, lists, reads, replaces, patches and deletes records with server-owned metadata', async t => {
  const { call } = await boot(t);
  const created = await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'one' }) });
  assert.equal(created.status, 201);
  const record = await created.json() as Record<string, unknown>;
  assert.match(record.id as string, /^[0-9a-f-]{36}$/);
  assert.equal(record.done, false, 'defaults apply');
  assert.equal(record.createdAt, record.updatedAt);
  assert.equal(created.headers.get('location'), `/api/todos/${record.id as string}`);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const list = await (await call('/api/todos')).json() as { items: unknown[]; total: number };
  assert.equal(list.total, 1);
  assert.deepEqual((await (await call(`/api/todos/${record.id as string}`)).json()), record);
  await new Promise(resolve => setTimeout(resolve, 5));
  const patched = await (await call(`/api/todos/${record.id as string}`, { method: 'PATCH', headers: json, body: JSON.stringify({ done: true }) })).json() as Record<string, unknown>;
  assert.equal(patched.title, 'one'); assert.equal(patched.done, true); assert.equal(patched.createdAt, record.createdAt); assert.notEqual(patched.updatedAt, record.updatedAt);
  const replaced = await (await call(`/api/todos/${record.id as string}`, { method: 'PUT', headers: json, body: JSON.stringify({ title: 'two', priority: 2 }) })).json() as Record<string, unknown>;
  assert.equal(replaced.done, false, 'PUT resets omitted fields to defaults'); assert.equal(replaced.priority, 2); assert.equal(replaced.id, record.id);
  assert.equal((await call(`/api/todos/${record.id as string}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(`/api/todos/${record.id as string}`)).status, 404);
});

test('PATCH with null removes an optional field, refuses a required one with a field error, and PUT keeps refusing null (#738)', async t => {
  const { call, database } = await boot(t, { ...todos, increments: ['count'], fields: { ...todos.fields, count: { type: 'integer', default: 0 } } });
  const record = await (await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'one', priority: 3, kind: 'a' }) })).json() as Record<string, unknown>;
  const path = `/api/todos/${record.id as string}`;
  const etag = (await call(path)).headers.get('etag')!;
  const cleared = await call(path, { method: 'PATCH', headers: { ...json, 'if-match': etag }, body: JSON.stringify({ priority: null, done: true }) });
  assert.equal(cleared.status, 200);
  const body = await cleared.json() as Record<string, unknown>;
  assert.equal(Object.hasOwn(body, 'priority'), false, 'the field is removed, not stored as null'); assert.equal(body.done, true); assert.equal(body.kind, 'a');
  const stored = records(database, 'todos')[0]!;
  assert.equal(Object.hasOwn(stored, 'priority'), false);
  // Only a null, even for a field that is already absent, is a change; If-Match still applies to it.
  assert.equal((await call(path, { method: 'PATCH', headers: json, body: JSON.stringify({ priority: null }) })).status, 200);
  assert.equal((await call(path, { method: 'PATCH', headers: { ...json, 'if-match': etag }, body: JSON.stringify({ kind: null }) })).status, 412);
  const required = await call(path, { method: 'PATCH', headers: json, body: JSON.stringify({ title: null, kind: null }) });
  assert.equal(required.status, 400);
  const refused = (await required.json() as { error: { code: string; fields: Record<string, string> } }).error;
  assert.equal(refused.code, 'invalid_record'); assert.deepEqual(refused.fields, { title: 'is required and cannot be cleared' });
  assert.equal((await (await call(path)).json() as Record<string, unknown>).kind, 'a', 'a refused patch clears nothing');
  const counter = await call(path, { method: 'PATCH', headers: json, body: JSON.stringify({ count: null }) });
  assert.equal(counter.status, 400); assert.equal((await counter.json() as { error: { fields: Record<string, string> } }).error.fields.count, 'is an increment field and cannot be cleared');
  const undeclared = await call(path, { method: 'PATCH', headers: json, body: JSON.stringify({ extra: null }) });
  assert.equal(undeclared.status, 400); assert.equal((await undeclared.json() as { error: { fields: Record<string, string> } }).error.fields.extra, 'is not a declared field');
  const put = await call(path, { method: 'PUT', headers: json, body: JSON.stringify({ title: 'two', priority: null }) });
  assert.equal(put.status, 400, 'PUT is unchanged: null is not a value'); assert.equal((await put.json() as { error: { fields: Record<string, string> } }).error.fields.priority, 'must be a number');
});

test('rejects invalid records with field names and never echoes submitted values', async t => {
  const { call } = await boot(t);
  const secret = 'sk-live-SECRET-VALUE-0123456789';
  const bad = await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: secret, priority: 9, kind: 'z', extra: secret, id: 'client-chosen' }) });
  assert.equal(bad.status, 400);
  const text = await bad.text();
  assert.ok(!text.includes(secret), 'no submitted value in the error');
  const { error } = JSON.parse(text) as { error: { code: string; fields: Record<string, string> } };
  assert.equal(error.code, 'invalid_record');
  assert.deepEqual(Object.keys(error.fields).sort(), ['extra', 'kind', 'priority', 'title']);
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({}) })).status, 400, 'required');
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify([1]) })).status, 400);
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: '{nope' })).status, 400);
  assert.equal((await call('/api/todos', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'x'.repeat(400) }) })).status, 400);
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'ok', done: 'yes' }) })).status, 400);
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'ok', pad: 'x'.repeat(6000) }) })).status, 413, 'body limit before validation');
});

test('enforces per-collection record quota and byte limits', async t => {
  const { call, database } = await boot(t, { ...todos, fields: { title: { type: 'string', required: true }, note: { type: 'string' } }, maxRecordBytes: 256 });
  for (const n of [1, 2, 3]) assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: `t${n}` }) })).status, 201);
  const full = await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'four' }) });
  assert.equal(full.status, 409); assert.equal(((await full.json()) as { error: { code: string } }).error.code, 'collection_full');
  const [first] = ((await (await call('/api/todos')).json()) as { items: { id: string }[] }).items;
  const big = await call(`/api/todos/${first!.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ note: 'x'.repeat(300) }) });
  assert.equal(big.status, 413);
  assert.equal(records(database, 'todos').length, 3, 'a refused write changes nothing');
});

test('paginates in creation order with a cursor and a capped page size', async t => {
  const { call } = await boot(t, { ...todos, maxRecords: 10, pageSize: 2 });
  for (const n of [1, 2, 3, 4, 5]) await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: `t${n}` }) });
  const first = await (await call('/api/todos?limit=100')).json() as { items: { title: string }[]; next: number; total: number };
  assert.deepEqual(first.items.map(i => i.title), ['t1', 't2']); assert.equal(first.next, 2); assert.equal(first.total, 5);
  const last = await (await call(`/api/todos?cursor=4`)).json() as { items: { title: string }[]; next?: number };
  assert.deepEqual(last.items.map(i => i.title), ['t5']); assert.equal(last.next, undefined);
  assert.equal((await call('/api/todos?limit=abc')).status, 400);
});

test('routes unknown ids, sub-paths and methods to fixed answers', async t => {
  const { call } = await boot(t);
  assert.equal((await call('/api/todos/not-an-id')).status, 404);
  assert.equal((await call('/api/todos/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await call('/api/todos/00000000-0000-4000-8000-000000000000/x')).status, 404);
  assert.equal((await call('/api/todos/00000000-0000-4000-8000-000000000000', { method: 'PATCH', headers: json, body: '{"done":true}' })).status, 404);
  const list = await call('/api/todos', { method: 'DELETE' });
  assert.equal(list.status, 405); assert.equal(list.headers.get('allow'), 'GET, HEAD, POST');
});

test('refuses cross-origin writes and honours readOnly', async t => {
  const { call } = await boot(t);
  const cross = await call('/api/todos', { method: 'POST', headers: { ...json, origin: 'https://evil.example' }, body: JSON.stringify({ title: 'x' }) });
  assert.equal(cross.status, 403);
  assert.equal((await call('/api/todos', { method: 'POST', headers: { ...json, origin }, body: JSON.stringify({ title: 'x' }) })).status, 201, 'the canonical origin is allowed');
  const ro = await boot(t, { ...todos, readOnly: true });
  assert.equal((await ro.call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'x' }) })).status, 405);
  assert.equal((await ro.call('/api/todos')).status, 200);
});

test('bodies and origins go through core: duplicate keys, deep nesting and bad encoding are 400; cross-site writes and duplicate Origin are 403', async t => {
  const { call } = await boot(t);
  const code = async (response: Response): Promise<[number, string]> => [response.status, ((await response.json()) as { error: { code: string } }).error.code];
  // `call` types its body as a string; the invalid-encoding case needs raw bytes, which fetch sends as they are.
  const post = (body: string | Uint8Array, headers: Record<string, string> = {}) => call('/api/todos', { method: 'POST', headers: { ...json, ...headers }, body: body as string });
  assert.deepEqual(await code(await post('{"title":"a","title":"b"}')), [400, 'duplicate_key']);
  assert.deepEqual(await code(await post(`{"title":${'['.repeat(40)}${']'.repeat(40)}}`)), [400, 'too_deep']);
  assert.deepEqual(await code(await post(new Uint8Array([0x7b, 0xff, 0x7d]))), [400, 'invalid_encoding']);
  assert.deepEqual(await code(await post('{')), [400, 'invalid_json']);
  assert.deepEqual(await code(await call('/api/todos', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })), [415, 'unsupported_media_type']);
  assert.deepEqual(await code(await post(JSON.stringify({ title: 'x'.repeat(10_000) }))), [413, 'record_too_large']);
  assert.deepEqual(await code(await post(JSON.stringify({ title: 'x' }), { origin, 'sec-fetch-site': 'cross-site' })), [403, 'forbidden_origin']);
  assert.deepEqual(await code(await post(JSON.stringify({ title: 'x' }), { referer: 'https://evil.example/' })), [403, 'forbidden_origin']);
  assert.equal((await post(JSON.stringify({ title: 'x' }))).status, 201, 'no provenance header at all is admitted: a JSON-only API');
});

test('admits writes from an operator alias origin and still refuses an unlisted origin', async t => {
  const { call } = await boot(t, todos, {}, {}, ['https://www.store.example.test']);
  const write = (from: string) => call('/api/todos', { method: 'POST', headers: { ...json, origin: from }, body: JSON.stringify({ title: 'x' }) });
  assert.equal((await write('https://www.store.example.test')).status, 201, 'the alias origin is allowed');
  assert.equal((await write(origin)).status, 201, 'the canonical origin is still allowed');
  const refused = await write('https://evil.example');
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'forbidden_origin');
});

test('keeps declared keys, increments and idempotency claims durable for short links and webhook-style mutations', async t => {
  const links = {
    mount: '/api/todos', key: 'code', increments: ['clicks'], idempotency: { maxKeys: 2 },
    fields: {
      code: { type: 'string', required: true, minLength: 1, maxLength: 32 },
      destination: { type: 'string', required: true, format: 'http-url', maxLength: 512 },
      clicks: { type: 'integer', default: 0, minimum: 0 },
      delivered: { type: 'boolean', default: false },
    },
  };
  const { call, restart, stop } = await boot(t, links, { '/go/*': { extension: 'store', methods: ['GET', 'HEAD'] } }, { shortLinks: { public: { mount: '/go', collection: 'todos', destination: 'destination', clicks: 'clicks' } } });
  const badDestination = await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ code: 'bad', destination: 'javascript:alert(1)' }) });
  assert.equal(badDestination.status, 400, 'the destination is schema-bound before it can become a Location header');
  const injectedDestination = await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ code: 'injected', destination: 'https://example.test/\nX-Injected: value' }) });
  assert.equal(injectedDestination.status, 400, 'URL parser whitespace normalization cannot turn stored input into a Location header');
  const created = await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ code: 'first', destination: 'https://example.test/landing' }) });
  assert.equal(created.status, 201);
  const first = await created.json() as { id: string; clicks: number };
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ code: 'first', destination: 'https://example.test/other' }) })).status, 409, 'caller-chosen collection keys are unique');
  const redirect = await call('/go/first', { redirect: 'manual' });
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), 'https://example.test/landing');
  assert.equal((await call('/go/missing', { redirect: 'manual' })).status, 404);
  const delivered = await Promise.all([0, 1].map(() => call(`/api/todos/${first.id}/increment/clicks`, { method: 'POST', headers: { 'idempotency-key': 'webhook-42' } })));
  assert.deepEqual(delivered.map(response => response.status), [200, 200], 'concurrent deliveries with one key both answer 200');
  assert.deepEqual(delivered.map(response => response.headers.get('idempotency-replayed')).sort(), ['true', null].sort(), 'but exactly one ran; the other replayed it');
  assert.equal(((await (await call(`/api/todos/${first.id}`)).json()) as { clicks: number }).clicks, 2, 'one redirect plus one accepted increment');
  await stop();
  const again = await restart();
  const increment = (key: string) => fetch(`http://127.0.0.1:${again.address.port}/api/todos/${first.id}/increment/clicks`, { method: 'POST', headers: { 'idempotency-key': key } });
  const duplicate = await increment('webhook-42');
  assert.equal(duplicate.status, 200, 'a retained idempotency claim survives restart');
  assert.equal(duplicate.headers.get('idempotency-replayed'), 'true');
  assert.equal(((await duplicate.json()) as { clicks: number }).clicks, 2, 'the replay counted nothing');
  assert.equal((await increment('webhook-43')).status, 200);
  assert.equal((await increment('webhook-44')).status, 200);
  const evicted = await increment('webhook-42');
  assert.equal(evicted.headers.get('idempotency-replayed'), null, 'the oldest key is predictably evicted at maxKeys');
  assert.equal(((await evicted.json()) as { clicks: number }).clicks, 5, 'so the retry ran again');
  const deleted = await fetch(`http://127.0.0.1:${again.address.port}/api/todos/${first.id}`, { method: 'DELETE', headers: { 'idempotency-key': 'delete-1' } });
  assert.equal(deleted.status, 204);
  const deletedAgain = await fetch(`http://127.0.0.1:${again.address.port}/api/todos/${first.id}`, { method: 'DELETE', headers: { 'idempotency-key': 'delete-1' } });
  assert.equal(deletedAgain.status, 204, 'a retried delete replays its 204 even though the record is gone');
  assert.equal(deletedAgain.headers.get('idempotency-replayed'), 'true');
});

test('persists across restart in one private database file and refuses data the declaration does not admit', async t => {
  const env = await boot(t);
  const made = await (await env.call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'keep' }) })).json() as { id: string };
  assert.ok((await readdir(env.data)).includes('store.sqlite'));
  assert.deepEqual((await readdir(env.data)).filter(name => !name.startsWith('store.sqlite')), [], 'no other file: no lock, temporary or per-collection file');
  // POSIX permission bits do not exist on Windows, which reports 0o666 for every file.
  if (process.platform !== 'win32') for (const name of await readdir(env.data)) assert.equal((await stat0(join(env.data, name))) & 0o777, 0o600, name);
  await env.stop();
  assert.deepEqual(await readdir(env.data), ['store.sqlite'], 'the last close checkpoints the write-ahead log into the database');
  const again = await env.start();
  try {
    const response = await fetch(`http://127.0.0.1:${again.address.port}/api/todos/${made.id}`);
    assert.equal(((await response.json()) as { title: string }).title, 'keep');
  } finally { await again.close(); }
  // A stored record the declaration refuses stops activation, without naming the path.
  await seed(env.database, 'todos', [{ id: 'a', createdAt: 'x', updatedAt: 'x', title: 7 }]);
  await assert.rejects(env.start(), (error: Error) => /no longer matches/.test(error.message) && !error.message.includes(env.data));
});

test('refuses a file that is not a store database, or a store schema newer than this release', async t => {
  const env = await boot(t);
  await env.stop();
  await rm(env.database);
  await writeFile(env.database, 'not a database', { mode: 0o600 });
  await assert.rejects(env.start(), /not a database|file is not a database/i);
  const privateDatabase = async () => { await rm(env.database); await writeFile(env.database, '', { mode: 0o600 }); return new DatabaseSync(env.database); };
  const foreign = await privateDatabase();
  foreign.exec('CREATE TABLE other(x); PRAGMA user_version=1;'); foreign.close();
  await assert.rejects(env.start(), /Not a store database/);
  const newer = await privateDatabase();
  newer.exec(`CREATE TABLE later(x); PRAGMA application_id=${STORE_APPLICATION_ID}; PRAGMA user_version=99;`); newer.close();
  await assert.rejects(env.start(), new RegExp(`schema version 99; this release supports up to ${STORE_SCHEMA_VERSION}`));
});

test('short-link destination must be required at config time, and legacy data missing it 404s without counting a click (#469)', async t => {
  const badLinks = { mount: '/api/todos', key: 'code', increments: ['clicks'], fields: { code: { type: 'string', required: true, maxLength: 32 }, destination: { type: 'string', format: 'http-url', maxLength: 512 }, clicks: { type: 'integer', default: 0, minimum: 0 } } };
  await assert.rejects(boot(t, badLinks, { '/go/*': { extension: 'store', methods: ['GET', 'HEAD'] } }, { shortLinks: { public: { mount: '/go', collection: 'todos', destination: 'destination', clicks: 'clicks' } } }), /must name a required string field/, 'declaring a non-required destination field is refused at activation');
  const okLinks = { mount: '/api/todos', key: 'code', increments: ['clicks'], fields: { code: { type: 'string', required: true, maxLength: 32 }, destination: { type: 'string', required: true, format: 'http-url', maxLength: 512 }, clicks: { type: 'integer', default: 0, minimum: 0 } } };
  const env = await boot(t, okLinks, { '/go/*': { extension: 'store', methods: ['GET', 'HEAD'] } }, { shortLinks: { public: { mount: '/go', collection: 'todos', destination: 'destination', clicks: 'clicks' } } });
  await env.stop();
  // Activation does not retroactively enforce a field that became required after data was written,
  // so this simulates data from before `destination` was declared required — the runtime check in
  // dispatchShortLink, not the config-time one, is what protects an existing deployment's data.
  const legacyId = '00000000-0000-0000-0000-000000000001';
  await seed(env.database, 'todos', [{ id: legacyId, createdAt: 'x', updatedAt: 'x', code: 'legacy', clicks: 0 }]);
  const again = await env.restart();
  const call = (path: string, init: { method?: string; redirect?: RequestRedirect } = {}) => fetch(`http://127.0.0.1:${again.address.port}${path}`, init);
  const missing = await call('/go/legacy', { redirect: 'manual' });
  assert.equal(missing.status, 404, 'a record without its destination 404s instead of Location: undefined');
  const record = await (await call(`/api/todos/${legacyId}`)).json() as { clicks: number };
  assert.equal(record.clicks, 0, 'the failed resolution did not count a click');
});

test('short-link HEAD resolves the destination without counting a click; GET counts exactly one (#469)', async t => {
  const links = { mount: '/api/todos', key: 'code', increments: ['clicks'], fields: { code: { type: 'string', required: true, maxLength: 32 }, destination: { type: 'string', required: true, format: 'http-url', maxLength: 512 }, clicks: { type: 'integer', default: 0, minimum: 0 } } };
  const { call } = await boot(t, links, { '/go/*': { extension: 'store', methods: ['GET', 'HEAD'] } }, { shortLinks: { public: { mount: '/go', collection: 'todos', destination: 'destination', clicks: 'clicks' } } });
  const created = await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ code: 'head-test', destination: 'https://example.test/x' }) });
  const { id } = await created.json() as { id: string };
  const head = await call('/go/head-test', { method: 'HEAD', redirect: 'manual' });
  assert.equal(head.status, 302); assert.equal(head.headers.get('location'), 'https://example.test/x');
  assert.equal(((await (await call(`/api/todos/${id}`)).json()) as { clicks: number }).clicks, 0, 'HEAD must not count a click');
  const get = await call('/go/head-test', { redirect: 'manual' });
  assert.equal(get.status, 302);
  assert.equal(((await (await call(`/api/todos/${id}`)).json()) as { clicks: number }).clicks, 1, 'GET counts exactly one click');
});

test('readOnly still counts short-link clicks but keeps refusing every public record write (#552)', async t => {
  const links = { mount: '/api/todos', key: 'code', increments: ['clicks'], readOnly: true, fields: { code: { type: 'string', required: true, maxLength: 32 }, destination: { type: 'string', required: true, format: 'http-url', maxLength: 512 }, clicks: { type: 'integer', default: 0, minimum: 0 } } };
  const env = await boot(t, links, { '/go/*': { extension: 'store', methods: ['GET', 'HEAD'] } }, { shortLinks: { public: { mount: '/go', collection: 'todos', destination: 'destination', clicks: 'clicks' } } });
  await env.stop();
  // The collection is readOnly from the start, so its record cannot be created through the public
  // POST API; seed it directly, the same way the legacy-destination test above does.
  const id = '00000000-0000-0000-0000-000000000002';
  await seed(env.database, 'todos', [{ id, createdAt: 'x', updatedAt: 'x', code: 'ro-link', destination: 'https://example.test/ro', clicks: 0 }]);
  const again = await env.restart();
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string; redirect?: RequestRedirect } = {}) => fetch(`http://127.0.0.1:${again.address.port}${path}`, init);
  // Public record API: create, update, delete and the direct increment endpoint all still refuse with 405.
  assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ code: 'other', destination: 'https://example.test/y' }) })).status, 405);
  assert.equal((await call(`/api/todos/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ destination: 'https://example.test/z' }) })).status, 405);
  assert.equal((await call(`/api/todos/${id}`, { method: 'DELETE' })).status, 405);
  assert.equal((await call(`/api/todos/${id}/increment/clicks`, { method: 'POST' })).status, 405, 'the public increment endpoint stays gated by readOnly');
  assert.equal((await call('/api/todos')).status, 200, 'reads stay allowed');
  // Store-owned short-link redirect: the click counter still counts despite readOnly.
  const redirected = await call('/go/ro-link', { redirect: 'manual' });
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get('location'), 'https://example.test/ro');
  assert.equal(((await (await call(`/api/todos/${id}`)).json()) as { clicks: number }).clicks, 1, 'the redirect counted its own click through readOnly');
});

test('GET returns a strong ETag; PUT/PATCH/DELETE honour If-Match and refuse a stale precondition with 412 (#469)', async t => {
  const { call } = await boot(t);
  const created = await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'first' }) });
  const { id } = await created.json() as { id: string };
  const etag = created.headers.get('etag');
  assert.ok(etag);
  assert.equal((await call(`/api/todos/${id}`)).headers.get('etag'), etag);
  const stale = await call(`/api/todos/${id}`, { method: 'PATCH', headers: { ...json, 'if-match': `"${'0'.repeat(32)}"` }, body: JSON.stringify({ title: 'changed' }) });
  assert.equal(stale.status, 412);
  assert.equal(((await (await call(`/api/todos/${id}`)).json()) as { title: string }).title, 'first', 'no write applied under a stale If-Match');
  const patched = await call(`/api/todos/${id}`, { method: 'PATCH', headers: { ...json, 'if-match': etag! }, body: JSON.stringify({ title: 'second' }) });
  assert.equal(patched.status, 200);
  const nextEtag = patched.headers.get('etag');
  assert.ok(nextEtag && nextEtag !== etag, 'the ETag changes on every mutation');
  assert.equal((await call(`/api/todos/${id}`, { method: 'PATCH', headers: { ...json, 'if-match': 'not-an-etag' }, body: JSON.stringify({ title: 'third' }) })).status, 400, 'a malformed If-Match is a clean 400, not a silent bypass');
  assert.equal((await call(`/api/todos/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ title: 'third' }) })).status, 200, 'writes remain last-write-wins by default, without If-Match');
  const deleteStale = await call(`/api/todos/${id}`, { method: 'DELETE', headers: { 'if-match': nextEtag! } });
  assert.equal(deleteStale.status, 412, 'the ETag from before the last unconditional PATCH is now stale');
});

test('idempotency keys are scoped per network client, not shared across every caller (#469)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'store-test-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), database = join(root, 'data', 'store.sqlite');
  await mkdir(project);
  const idempotent = { ...todos, idempotency: { maxKeys: 10 } };
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { store: { version: '1', config: { collections: { todos: idempotent } } } }, routes: { '/api/todos/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] } } }));
  const projectSha256 = await inspectExtensionRevision(project);
  const instance = await storeExtension({ database, projectSha256 }).activate({ collections: { todos: idempotent } }, { origin, target: 'node', projectSha256, mounts: ['/api/todos'], root: project });
  cleanup(t, async () => { await instance.close?.(); });
  const post = (client: string | null) => instance.handle({ method: 'POST', target: '/api/todos', path: '/api/todos', query: new URLSearchParams(), headers: new Headers({ 'content-type': 'application/json', 'idempotency-key': 'shared-key' }), headerCounts: { 'content-type': 1, 'idempotency-key': 1 }, body: new TextEncoder().encode(JSON.stringify({ title: 'x' })), origin, route: '/api/todos/*', mount: '/api/todos', client, requestId: 'test-request', env: {} });
  assert.equal((await post('203.0.113.5')).status, 201);
  assert.equal((await post('198.51.100.7')).status, 201, 'a different client choosing the same Idempotency-Key does not collide with the first');
  const again = await post('203.0.113.5');
  assert.equal(again.status, 201);
  assert.equal(again.headers.find(([name]) => name === 'idempotency-replayed')?.[1], 'true', 'the same client reusing the key gets its first answer replayed');
});

test('refuses a database inside the project, unknown mounts and missing collections', async t => {
  const env = await boot(t);
  await env.stop();
  const projectSha256 = await inspectExtensionRevision(env.project);
  await assert.rejects(startServer({ project: env.project, origin, port: 0, log: () => {}, extensions: [storeExtension({ database: join(env.project, 'data', 'store.sqlite'), projectSha256 })] }), /outside the route project/);
  assert.throws(() => storeExtension({ database: 'relative.sqlite', projectSha256 }), /absolute/);
  await assert.rejects(boot(t, { ...todos, mount: '/api/other' }), /is not declared/);
});

test('rejects declarations the schema or cross-field rules forbid', async t => {
  for (const [name, bad, pattern] of [
    ['reserved', { ...todos, fields: { id: { type: 'string' } } }, /reserved|Invalid extension configuration/],
    ['range', { ...todos, fields: { n: { type: 'integer', minimum: 5, maximum: 1 } } }, /minimum exceeds maximum/],
    ['default', { ...todos, fields: { n: { type: 'integer', default: 'x' } } }, /Invalid extension configuration|must be a number/],
    ['huge', { ...todos, maxRecords: 10_000_000 }, /Invalid extension configuration/],
  ] as const) {
    await assert.rejects(boot(t, bad), pattern, name);
  }
});

// The catalog recipe recipes/store-crud is a core artifact but needs this package to activate,
// so its fixtures run here, against the real extension and a data directory outside the project.
test('the store-crud catalog recipe passes its ordered fixtures and leaves the collection empty', async t => {
  const root = await mkdtemp(join(tmpdir(), 'store-recipe-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'crud'), database = join(root, 'data', 'store.sqlite');
  await addRecipe('store-crud', project);
  const readme = await readFile(join(project, 'README.md'), 'utf8');
  assert.match(readme, /--ack store:public-write/); assert.match(readme, /--with auth,store/); assert.match(readme, /urlcode extensions add store/);
  const projectSha256 = await inspectExtensionRevision(project);
  const run = () => runProjectTests(project, { extensions: [storeExtension({ database, projectSha256 })], origin });
  const first = await run();
  assert.ok(first.total >= 13, 'the lifecycle steps and negative cases all ran');
  assert.equal(first.failed, 0);
  // Re-runnable: the lifecycle deletes what it created.
  assert.equal((await run()).failed, 0);
});
async function stat0(path: string): Promise<number> { return (await (await import('node:fs/promises')).stat(path)).mode; }
