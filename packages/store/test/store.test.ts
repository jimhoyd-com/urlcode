import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, addRecipe, runProjectTests } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { storeExtension } from '../src/index.ts';

const origin = 'https://store.example.test';
const todos = { mount: '/api/todos', fields: { title: { type: 'string', required: true, minLength: 1, maxLength: 20 }, done: { type: 'boolean', default: false }, priority: { type: 'integer', minimum: 1, maximum: 5 }, kind: { type: 'string', enum: ['a', 'b'] } }, maxRecords: 3, maxRecordBytes: 512 };
const json = { 'content-type': 'application/json' };

async function boot(t: TestContext, collection: object = todos, extraRoutes: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'store-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), data = join(root, 'data');
  await mkdir(project);
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { store: { version: '1', config: { collections: { todos: collection } } } }, routes: { '/api/todos/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] }, ...extraRoutes } }));
  const projectSha256 = await inspectExtensionRevision(project);
  const start = () => startServer({ project, origin, port: 0, log: () => {}, extensions: [storeExtension({ directory: data, projectSha256 })] });
  const app = await start();
  let open = true;
  t.after(async () => { if (open) await app.close(); });
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => fetch(`http://127.0.0.1:${app.address.port}${path}`, init);
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

test('persists atomically across restart, leaves no temporary files and holds a single-writer lock', async t => {
  const env = await boot(t);
  const made = await (await env.call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'keep' }) })).json() as { id: string };
  assert.deepEqual((await readdir(env.data)).sort(), ['.store.lock', 'todos.json']);
  // POSIX permission bits do not exist on Windows, which reports 0o666 for every file.
  if (process.platform !== 'win32') assert.equal((await stat0(join(env.data, 'todos.json'))) & 0o777, 0o600);
  await assert.rejects(env.start(), /in use by another process/, 'a second server over the directory is refused');
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
  assert.match(readme, /--ack store:public-write/); assert.match(readme, /init --with ui,auth,store/); assert.match(readme, /operator installs/i);
  const projectSha256 = await inspectExtensionRevision(project);
  const run = () => runProjectTests(project, { extensions: [storeExtension({ directory: data, projectSha256 })], origin });
  const first = await run();
  assert.ok(first.total >= 13, 'the lifecycle steps and negative cases all ran');
  assert.equal(first.failed, 0);
  // Re-runnable: the lifecycle deletes what it created.
  assert.equal((await run()).failed, 0);
});
async function stat0(path: string): Promise<number> { return (await (await import('node:fs/promises')).stat(path)).mode; }
