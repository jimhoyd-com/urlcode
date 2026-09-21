import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { storeExtension } from '../src/index.ts';

// Filtering and sorting (#330): declared fields only, single-field sort, equality filters, id tie-break.
const origin = 'https://store.example.test';
const json = { 'content-type': 'application/json' };
const catalog = {
  mount: '/api/todos', pageSize: 7, maxRecords: 200, maxRecordBytes: 512,
  sortable: ['title', 'priority', 'done', 'score'], filterable: ['kind', 'done', 'priority', 'score'],
  fields: {
    title: { type: 'string', required: true, maxLength: 40 }, kind: { type: 'string', enum: ['a', 'b', 'c'] },
    priority: { type: 'integer' }, score: { type: 'number' }, done: { type: 'boolean', default: false }, secret: { type: 'string', maxLength: 40 },
  },
};
type Row = { id: string; title: string; kind?: string; priority?: number; score?: number; done: boolean };
type Page = { items: Row[]; total: number; next?: string | number };

async function boot(t: TestContext, collection: object) {
  const root = await mkdtemp(join(tmpdir(), 'store-query-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), data = join(root, 'data');
  await mkdir(project);
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { store: { version: '1', config: { collections: { todos: collection } } } }, routes: { '/api/todos/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] } } }));
  const projectSha256 = await inspectExtensionRevision(project);
  const start = () => startServer({ project, origin, port: 0, log: () => {}, extensions: [storeExtension({ directory: data, projectSha256 })] });
  let app = await start();
  t.after(async () => { await app.close(); });
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => fetch(`http://127.0.0.1:${app.address.port}${path}`, init);
  return { call, restart: async () => { await app.close(); app = await start(); } };
}

async function seed(t: TestContext, rows: object[], collection: object = catalog) {
  const ctx = await boot(t, collection);
  for (const row of rows) assert.equal((await ctx.call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify(row) })).status, 201);
  const page = async (query: string): Promise<Page> => { const res = await ctx.call(`/api/todos?${query}`); assert.equal(res.status, 200, query); return await res.json() as Page; };
  const walk = async (query: string): Promise<Row[]> => {
    const out: Row[] = []; let cursor: string | number | undefined;
    for (let i = 0; i < 100; i++) {
      const p = await page(cursor === undefined ? query : `${query}&cursor=${encodeURIComponent(String(cursor))}`);
      out.push(...p.items); cursor = p.next; if (cursor === undefined) return out;
    }
    throw new Error('pagination did not terminate');
  };
  return { ...ctx, page, walk };
}
const many = Array.from({ length: 60 }, (_, n) => ({ title: `t${String(n % 12).padStart(2, '0')}`, kind: ['a', 'b', 'c'][n % 3], priority: n % 5, score: (n % 4) / 2 - 0.5, done: n % 2 === 0 }));
const ordered = (rows: Row[], key: (r: Row) => number | string | boolean | undefined, descending: boolean) => {
  for (let i = 1; i < rows.length; i++) {
    const a = key(rows[i - 1]!)!, b = key(rows[i]!)!;
    assert.ok(descending ? a >= b : a <= b, 'ordered');
    if (a === b) assert.ok(descending ? rows[i - 1]!.id > rows[i]!.id : rows[i - 1]!.id < rows[i]!.id, 'ties break on id, reversed with the direction');
  }
};

test('sorted pages across many records never skip or repeat, for every declared type and both directions', async t => {
  const { walk } = await seed(t, many);
  for (const [field, desc] of [['title', false], ['title', true], ['priority', false], ['priority', true], ['score', false], ['score', true], ['done', false], ['done', true]] as const) {
    const rows = await walk(`sort=${desc ? '-' : ''}${field}&limit=4`);
    assert.equal(rows.length, 60, field); assert.equal(new Set(rows.map(r => r.id)).size, 60, `${field} has no repeats`);
    ordered(rows, r => r[field], desc);
  }
});

test('sorted order is type-safe: numeric not textual, false before true, absent values last, code-unit strings', async t => {
  const { walk } = await seed(t, [{ title: 'a', priority: 10, score: 0.5 }, { title: 'b', priority: 9, score: -2 }, { title: 'c', priority: -3, score: 1e2 }, { title: 'd' }, { title: 'e', priority: 2, score: 0 }, { title: 'B' }]);
  assert.deepEqual((await walk('sort=priority&limit=2')).map(r => r.priority), [-3, 2, 9, 10, undefined, undefined]);
  assert.deepEqual((await walk('sort=-priority&limit=2')).map(r => r.priority), [undefined, undefined, 10, 9, 2, -3]);
  assert.deepEqual((await walk('sort=score')).map(r => r.score), [-2, 0, 0.5, 100, undefined, undefined]);
  assert.deepEqual((await walk('sort=title')).map(r => r.title), ['B', 'a', 'b', 'c', 'd', 'e']);
  assert.deepEqual((await walk('sort=done')).map(r => r.done), [false, false, false, false, false, false]);
});

test('a sorted walk survives inserts and deletes between pages without repeating or skipping a record', async t => {
  const { call, page } = await seed(t, many);
  const first = await page('sort=priority&limit=5');
  const seen = new Set(first.items.map(r => r.id));
  const untouched = (await page('sort=priority&limit=100')).items.slice(5).map(r => r.id);
  await call(`/api/todos/${first.items[0]!.id}`, { method: 'DELETE' });
  await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'late', priority: -1 }) });
  await call('/api/todos', { method: 'POST', headers: json, body: JSON.stringify({ title: 'late2', priority: 4 }) });
  let cursor = first.next, guard = 0;
  const ids: string[] = [];
  while (cursor !== undefined && guard++ < 100) { const p = await page(`sort=priority&limit=5&cursor=${encodeURIComponent(String(cursor))}`); for (const r of p.items) ids.push(r.id); cursor = p.next; }
  assert.equal(ids.filter(id => seen.has(id)).length, 0, 'nothing from page one reappears');
  assert.equal(new Set(ids).size, ids.length);
  for (const id of untouched) assert.ok(ids.includes(id), 'a record that was after the cursor and untouched is still visited');
});

test('equality filters combine with sort and pagination and report the filtered total', async t => {
  const { page, walk } = await seed(t, many);
  assert.equal((await page('kind=b&done=true&limit=3')).total, many.filter(r => r.kind === 'b' && r.done).length);
  const rows = await walk('kind=b&sort=-priority&limit=4');
  assert.equal(rows.length, 20); assert.ok(rows.every(r => r.kind === 'b'));
  ordered(rows, r => r.priority, true);
  assert.equal((await page('priority=3&score=0.5')).total, many.filter(r => r.priority === 3 && r.score === 0.5).length, 'numbers match by value, not text');
  assert.equal((await page('score=5e-1&priority=3')).total, many.filter(r => r.priority === 3 && r.score === 0.5).length);
  assert.equal((await page('kind=zzz')).total, 0);
  assert.equal((await walk('kind=a&limit=3')).length, 20, 'a filter without a sort pages by offset over the filtered list');
  assert.equal((await page('done=false&priority=-0')).total, many.filter(r => !r.done && r.priority === 0).length, '-0 is 0');
});

test('a record without a value never matches an equality filter', async t => {
  const { page } = await seed(t, [{ title: 'x' }, { title: 'y', priority: 0 }]);
  assert.equal((await page('priority=0')).total, 1);
});

test('undeclared, duplicated and malformed names and values are 400s that name only the key', async t => {
  const { call } = await seed(t, [{ title: 'x', secret: 'hush' }]);
  const cases: [string, string][] = [
    ['secret=hush', 'secret'], ['title=x', 'title'], ['sort=secret', 'secret'], ['sort=-kind', 'kind'], ['bogus=1', 'bogus'], ['id=abc', 'id'], ['createdAt=x', 'createdAt'],
    ['sort=__proto__', '__proto__'], ['constructor=1', 'constructor'], ['kind=a&kind=b', 'kind'], ['priority=abc', 'priority'], ['priority=1.5', 'priority'], ['priority=0x10', 'priority'],
    ['score=Infinity', 'score'], ['score=', 'score'], ['done=yes', 'done'], ['priority=99999999999999999999', 'priority'], ['limit=-1', 'limit'], ['sort=title&cursor=12', 'cursor'],
  ];
  for (const [query, key] of cases) {
    const res = await call(`/api/todos?${query}`);
    assert.equal(res.status, 400, query);
    const text = await res.text();
    const body = JSON.parse(text) as { error: { code: string; fields: Record<string, string> } };
    assert.equal(body.error.code, 'invalid_query'); assert.ok(Object.hasOwn(body.error.fields, key), `${query} names ${key}`);
    assert.ok(!text.includes('hush'), 'no stored value in the error');
  }
});

test('hostile query input is bounded and never echoed beyond a plain key name', async t => {
  const { call } = await seed(t, [{ title: 'x' }]);
  const evil = '<script>alert(1)</script>';
  for (const query of [`${encodeURIComponent(evil)}=1`, `sort=${encodeURIComponent(evil)}`, `sort=-${'a'.repeat(5000)}`, `${'k'.repeat(5000)}=1`, `kind=${'z'.repeat(100_000)}`]) {
    const res = await call(`/api/todos?${query}`), text = await res.text();
    assert.ok(res.status === 400 || (res.status === 431 && query.length > 50_000), `${res.status} ${query.slice(0, 30)}`); // the host refuses an oversized request line first
    assert.ok(!text.includes('script') && !text.includes('aaaa') && !text.includes('kkkk') && !text.includes('zzzz'), 'nothing hostile comes back');
    assert.ok(text.length < 600);
  }
  assert.equal((await call(`/api/todos?${Array.from({ length: 40 }, (_, n) => `k${n}=1`).join('&')}`)).status, 400, 'parameter count is bounded');
  assert.equal((await call('/api/todos?kind=a&done=true&priority=1&score=1')).status, 400, 'more than three filters');
  const id = '00000000-0000-4000-8000-000000000000', encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const cursor of ['%25%25%25', 'AAAA', 'e30', encode([1, 2, 3, 4]), encode(['title', false, 5, id]), encode(['title', false, 'x', 'not-an-id']), encode(['title', false, 'x'.repeat(300), id]), encode(['title', true, 'x', id]), 'A'.repeat(5000)]) {
    const res = await call(`/api/todos?sort=title&cursor=${cursor}`);
    assert.equal(res.status, 400, cursor.slice(0, 20));
    assert.ok((await res.text()).length < 300);
  }
  assert.equal((await call(`/api/todos?sort=title&cursor=${encode(['title', false, 'x', id])}`)).status, 200, 'a well-formed cursor for an absent record is fine');
});

test('a cursor is bound to the sort that issued it', async t => {
  const { page, call } = await seed(t, many);
  const p = await page('sort=priority&limit=3');
  assert.equal((await call(`/api/todos?sort=-priority&cursor=${p.next as string}`)).status, 400);
  assert.equal((await call(`/api/todos?sort=title&cursor=${p.next as string}`)).status, 400);
  assert.equal((await call(`/api/todos?cursor=${p.next as string}`)).status, 400);
  assert.equal((await call(`/api/todos?sort=priority&cursor=${p.next as string}`)).status, 200);
  assert.equal((await page('limit=3')).next, 3, 'the unsorted order keeps its numeric offset cursor');
});

test('sorting and filtering see the same data after the file store restarts', async t => {
  const ctx = await seed(t, many.slice(0, 12));
  const before = await ctx.walk('sort=-priority&kind=a&limit=2');
  assert.ok(before.length > 2);
  await ctx.restart();
  assert.deepEqual(await ctx.walk('sort=-priority&kind=a&limit=3'), before);
});

test('collections without declarations refuse every sort and filter, and bad declarations refuse activation', async t => {
  const plain = await seed(t, [{ title: 'x' }], { ...catalog, sortable: undefined, filterable: undefined });
  assert.equal((await plain.call('/api/todos?sort=title')).status, 400);
  assert.equal((await plain.call('/api/todos?kind=a')).status, 400);
  assert.equal((await plain.call('/api/todos')).status, 200);
  const fields = catalog.fields;
  for (const [name, bad, pattern] of [
    ['sortable unknown', { ...catalog, sortable: ['nope'] }, /not a declared field/],
    ['filterable reserved', { ...catalog, filterable: ['id'] }, /not a declared field/],
    ['filterable list parameter', { ...catalog, fields: { ...fields, limit: { type: 'integer' } }, filterable: ['limit'] }, /list parameter/],
    ['long string', { ...catalog, sortable: ['title'], fields: { ...fields, title: { type: 'string', maxLength: 5000 } } }, /maxLength of at most 256/],
    ['unbounded string', { ...catalog, filterable: ['secret'], fields: { ...fields, secret: { type: 'string' } } }, /maxLength of at most 256/],
    ['duplicate', { ...catalog, sortable: ['title', 'title'] }, /Invalid extension configuration/],
    ['too many', { ...catalog, sortable: Array.from({ length: 9 }, (_, n) => `f${n}`) }, /Invalid extension configuration/],
    ['not a list', { ...catalog, sortable: 'title' }, /Invalid extension configuration/],
  ] as const) await assert.rejects(boot(t, bad), pattern, name);
});
