import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, addRecipe, runProjectTests } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { storeExtension } from '../src/index.ts';
import { lockStoreDirectory } from '../src/store.ts';

const origin = 'https://store.example.test';
const todos = { mount: '/api/todos', fields: { title: { type: 'string', required: true, minLength: 1, maxLength: 20 }, done: { type: 'boolean', default: false }, priority: { type: 'integer', minimum: 1, maximum: 5 }, kind: { type: 'string', enum: ['a', 'b'] } }, maxRecords: 3, maxRecordBytes: 512 };
const json = { 'content-type': 'application/json' };

async function boot(t: TestContext, collection: object = todos, extraRoutes: Record<string, unknown> = {}, extraConfig: Record<string, unknown> = {}, aliasOrigins?: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'store-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), data = join(root, 'data');
  await mkdir(project);
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { store: { version: '1', config: { collections: { todos: collection }, ...extraConfig } } }, routes: { '/api/todos/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] }, ...extraRoutes } }));
  const projectSha256 = await inspectExtensionRevision(project);
  const start = () => startServer({ project, origin, ...(aliasOrigins ? { aliasOrigins } : {}), port: 0, log: () => {}, extensions: [storeExtension({ directory: data, projectSha256 })] });
  const app = await start();
  let open = true;
  t.after(async () => { if (open) await app.close(); });
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string; redirect?: RequestRedirect } = {}) => fetch(`http://127.0.0.1:${app.address.port}${path}`, init);
  return { root, project, data, app, call, start, stop: async () => { open = false; await app.close(); } };
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
  const { call, data } = await boot(t, { ...todos, increments: ['count'], fields: { ...todos.fields, count: { type: 'integer', default: 0 } } });
  const record = await (await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'one', priority: 3, kind: 'a' }) })).json() as Record<string, unknown>;
  const path = `/api/todos/${record.id as string}`;
  const etag = (await call(path)).headers.get('etag')!;
  const cleared = await call(path, { method: 'PATCH', headers: { ...json, 'if-match': etag }, body: JSON.stringify({ priority: null, done: true }) });
  assert.equal(cleared.status, 200);
  const body = await cleared.json() as Record<string, unknown>;
  assert.equal(Object.hasOwn(body, 'priority'), false, 'the field is removed, not stored as null'); assert.equal(body.done, true); assert.equal(body.kind, 'a');
  const stored = (JSON.parse(await readFile(join(data, 'todos.json'), 'utf8')) as { records: Record<string, unknown>[] }).records[0]!;
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
  const { call, data } = await boot(t, { ...todos, fields: { title: { type: 'string', required: true }, note: { type: 'string' } }, maxRecordBytes: 256 });
  for (const n of [1, 2, 3]) assert.equal((await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: `t${n}` }) })).status, 201);
  const full = await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'four' }) });
  assert.equal(full.status, 409); assert.equal(((await full.json()) as { error: { code: string } }).error.code, 'collection_full');
  const [first] = ((await (await call('/api/todos')).json()) as { items: { id: string }[] }).items;
  const big = await call(`/api/todos/${first!.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ note: 'x'.repeat(300) }) });
  assert.equal(big.status, 413);
  assert.equal(JSON.parse(await readFile(join(data, 'todos.json'), 'utf8')).records.length, 3, 'a refused write changes nothing');
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
  const { call, start, stop } = await boot(t, links, { '/go/*': { extension: 'store', methods: ['GET', 'HEAD'] } }, { shortLinks: { public: { mount: '/go', collection: 'todos', destination: 'destination', clicks: 'clicks' } } });
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
  assert.deepEqual(delivered.map(response => response.status).sort(), [200, 409], 'concurrent delivery decisions claim one durable key');
  assert.equal(((await (await call(`/api/todos/${first.id}`)).json()) as { clicks: number }).clicks, 2, 'one redirect plus one accepted increment');
  await stop();
  const again = await start();
  t.after(() => again.close());
  const increment = (key: string) => fetch(`http://127.0.0.1:${again.address.port}/api/todos/${first.id}/increment/clicks`, { method: 'POST', headers: { 'idempotency-key': key } });
  const duplicate = await increment('webhook-42');
  assert.equal(duplicate.status, 409, 'a retained idempotency claim survives restart');
  assert.equal((await increment('webhook-43')).status, 200);
  assert.equal((await increment('webhook-44')).status, 200);
  assert.equal((await increment('webhook-42')).status, 200, 'the oldest key is predictably evicted at maxKeys');
  const deleted = await fetch(`http://127.0.0.1:${again.address.port}/api/todos/${first.id}`, { method: 'DELETE', headers: { 'idempotency-key': 'delete-1' } });
  assert.equal(deleted.status, 204);
  const deletedAgain = await fetch(`http://127.0.0.1:${again.address.port}/api/todos/${first.id}`, { method: 'DELETE', headers: { 'idempotency-key': 'delete-1' } });
  assert.equal(deletedAgain.status, 409, 'a retained duplicate is deterministic even after its record was deleted');
});

test('persists atomically across restart, leaves no temporary files and holds a single-writer lock', async t => {
  const env = await boot(t);
  const made = await (await env.call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'keep' }) })).json() as { id: string };
  assert.deepEqual((await readdir(env.data)).sort(), ['.store.lock', 'todos.json']);
  // POSIX permission bits do not exist on Windows, which reports 0o666 for every file.
  if (process.platform !== 'win32') assert.equal((await stat0(join(env.data, 'todos.json'))) & 0o777, 0o600);
  await assert.rejects(env.start(), /already locked by this process/, 'a second server over the directory in this same process is refused');
  await env.stop();
  assert.deepEqual(await readdir(env.data), ['todos.json'], 'lock released on close');
  const again = await env.start();
  t.after(() => again.close());
  const response = await fetch(`http://127.0.0.1:${again.address.port}/api/todos/${made.id}`);
  assert.equal(((await response.json()) as { title: string }).title, 'keep');
});

test('reclaims a lock left by a dead process and refuses data that violates the declaration', async t => {
  const env = await boot(t);
  await env.stop();
  await writeFile(join(env.data, '.store.lock'), '999999999');
  await writeFile(join(env.data, 'todos.json'), JSON.stringify({ version: 1, records: [{ id: 'a', createdAt: 'x', updatedAt: 'x', title: 7 }] }));
  await assert.rejects(env.start(), (error: Error) => /no longer matches/.test(error.message) && !error.message.includes(env.data));
  await writeFile(join(env.data, 'todos.json'), '{broken');
  await assert.rejects(env.start(), /not valid JSON/);
  await rm(join(env.data, 'todos.json'));
  const up = await env.start(); await up.close();
});

test('reclaims a lock carrying our own PID but a different instance id (recycled PID after an unclean restart, #469)', async t => {
  const env = await boot(t);
  await env.stop();
  // A container restarted after an unclean exit routinely gets the same PID back (often PID 1).
  // A lock file left behind by the previous, now-dead process is what this simulates: same PID,
  // different (or, for the legacy-format case below, absent) instance id.
  await writeFile(join(env.data, '.store.lock'), `${process.pid}:not-our-instance`);
  const up = await env.start();
  const response = await fetch(`http://127.0.0.1:${up.address.port}/api/todos`);
  assert.equal(response.status, 200, 'a lock recording our own PID but a foreign instance id is reclaimed, not treated as already held');
  await up.close();
});

test('stale-lock reclaim never deletes a fresh lock another process claimed between read and reclaim (#549)', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'store-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, '.store.lock');
  // The parent process is alive and is not us: its identity stands in for a concurrent reclaimer.
  const fresh = `${process.ppid}:concurrent-reclaimer`;
  await writeFile(path, '999999999:dead-instance');
  await assert.rejects(lockStoreDirectory(directory, { beforeReclaim: async () => {
    // Process A reclaims the same stale lock and links its own after we judged it stale.
    await rm(path); await writeFile(path, fresh);
  } }), /in use by another process/);
  assert.equal(await readFile(path, 'utf8'), fresh, "the concurrent process's fresh lock is left in place");
  assert.deepEqual(await readdir(directory), ['.store.lock'], 'no renamed or temporary lock files are left behind');

  // A stale lock someone else already removed (ENOENT on rename) just retries the claim.
  await writeFile(path, '999999999:dead-instance');
  const unlock = await lockStoreDirectory(directory, { beforeReclaim: async () => { await rm(path, { force: true }); } });
  assert.match(await readFile(path, 'utf8'), new RegExp(`^${process.pid}:`));
  await unlock();
  assert.deepEqual(await readdir(directory), []);
});

test('unlock removes the lock file only while it still carries this lock identity (#549)', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'store-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, '.store.lock');
  const unlock = await lockStoreDirectory(directory);
  const foreign = `${process.ppid}:someone-else`;
  await writeFile(path, foreign);
  await unlock();
  assert.equal(await readFile(path, 'utf8'), foreign, 'a lock this process no longer owns is not removed');
});

test('short-link destination must be required at config time, and legacy data missing it 404s without counting a click (#469)', async t => {
  const badLinks = { mount: '/api/todos', key: 'code', increments: ['clicks'], fields: { code: { type: 'string', required: true, maxLength: 32 }, destination: { type: 'string', format: 'http-url', maxLength: 512 }, clicks: { type: 'integer', default: 0, minimum: 0 } } };
  await assert.rejects(boot(t, badLinks, { '/go/*': { extension: 'store', methods: ['GET', 'HEAD'] } }, { shortLinks: { public: { mount: '/go', collection: 'todos', destination: 'destination', clicks: 'clicks' } } }), /must name a required string field/, 'declaring a non-required destination field is refused at activation');
  const okLinks = { mount: '/api/todos', key: 'code', increments: ['clicks'], fields: { code: { type: 'string', required: true, maxLength: 32 }, destination: { type: 'string', required: true, format: 'http-url', maxLength: 512 }, clicks: { type: 'integer', default: 0, minimum: 0 } } };
  const env = await boot(t, okLinks, { '/go/*': { extension: 'store', methods: ['GET', 'HEAD'] } }, { shortLinks: { public: { mount: '/go', collection: 'todos', destination: 'destination', clicks: 'clicks' } } });
  await env.stop();
  // `load()` does not retroactively enforce a field that became required after data was written,
  // so this simulates data from before `destination` was declared required — the runtime check in
  // dispatchShortLink, not the config-time one, is what protects an existing deployment's data.
  const legacyId = '00000000-0000-0000-0000-000000000001';
  await writeFile(join(env.data, 'todos.json'), JSON.stringify({ version: 2, records: [{ id: legacyId, createdAt: 'x', updatedAt: 'x', code: 'legacy', clicks: 0 }], idempotency: [] }));
  const again = await env.start();
  t.after(() => again.close());
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
  await writeFile(join(env.data, 'todos.json'), JSON.stringify({ version: 2, records: [{ id, createdAt: 'x', updatedAt: 'x', code: 'ro-link', destination: 'https://example.test/ro', clicks: 0 }], idempotency: [] }));
  const again = await env.start();
  t.after(() => again.close());
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
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), data = join(root, 'data');
  await mkdir(project);
  const idempotent = { ...todos, idempotency: { maxKeys: 10 } };
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { store: { version: '1', config: { collections: { todos: idempotent } } } }, routes: { '/api/todos/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] } } }));
  const projectSha256 = await inspectExtensionRevision(project);
  const instance = await storeExtension({ directory: data, projectSha256 }).activate({ collections: { todos: idempotent } }, { origin, target: 'node', projectSha256, mounts: ['/api/todos'], root: project });
  t.after(async () => { await instance.close?.(); });
  const post = (client: string | null) => instance.handle({ method: 'POST', target: '/api/todos', path: '/api/todos', query: new URLSearchParams(), headers: new Headers({ 'content-type': 'application/json', 'idempotency-key': 'shared-key' }), headerCounts: { 'content-type': 1, 'idempotency-key': 1 }, body: new TextEncoder().encode(JSON.stringify({ title: 'x' })), origin, route: '/api/todos/*', mount: '/api/todos', client, requestId: 'test-request', env: {} });
  assert.equal((await post('203.0.113.5')).status, 201);
  assert.equal((await post('198.51.100.7')).status, 201, 'a different client choosing the same Idempotency-Key does not collide with the first');
  assert.equal((await post('203.0.113.5')).status, 409, 'the same client reusing the key is still rejected');
});

test('refuses a data directory inside the project, unknown mounts and missing collections', async t => {
  const env = await boot(t);
  await env.stop();
  const projectSha256 = await inspectExtensionRevision(env.project);
  await assert.rejects(startServer({ project: env.project, origin, port: 0, log: () => {}, extensions: [storeExtension({ directory: join(env.project, 'data'), projectSha256 })] }), /outside the route project/);
  assert.throws(() => storeExtension({ directory: 'relative', projectSha256 }), /absolute/);
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
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'crud'), data = join(root, 'data');
  await addRecipe('store-crud', project);
  const readme = await readFile(join(project, 'README.md'), 'utf8');
  assert.match(readme, /--ack store:public-write/); assert.match(readme, /--with ui,auth,store/); assert.match(readme, /urlcode extensions add store/);
  const projectSha256 = await inspectExtensionRevision(project);
  const run = () => runProjectTests(project, { extensions: [storeExtension({ directory: data, projectSha256 })], origin });
  const first = await run();
  assert.ok(first.total >= 13, 'the lifecycle steps and negative cases all ran');
  assert.equal(first.failed, 0);
  // Re-runnable: the lifecycle deletes what it created.
  assert.equal((await run()).failed, 0);
});
async function stat0(path: string): Promise<number> { return (await (await import('node:fs/promises')).stat(path)).mode; }
