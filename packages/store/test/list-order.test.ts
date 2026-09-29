// Sorted and filtered lists in SQL (#951), proved against the in-memory reference (query.ts `runList`, the path every
// list took before) on random data: the SQL page, `total`, cursor and `next` must equal the reference's for every
// declared type, both directions, filters, ties, absent values, non-ASCII text (code points on both sides of the
// surrogate range, surrogate pairs, NUL), every scope (a shared collection, an owner, a readers mount) and a cursor
// whose record was deleted. Rows the SQL key cannot represent exactly (a lone surrogate, a value of another type) are
// detected and answered by the reference.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection } from '../src/collection.ts';
import type { CollectionSpec, NormalizedSpec, Scalar, StoredRecord } from '../src/collection.ts';
import { openStoreDatabase } from '../src/database.ts';
import type { StoreDatabase } from '../src/database.ts';
import { listInSql, listPlan } from '../src/listing.ts';
import type { ListPlan, ListedRow } from '../src/listing.ts';
import { parseListQuery, runList } from '../src/query.ts';
import type { ExtensionActivation } from '@jimhoyd/urlcode/extensions';
import { createStore } from '../src/index.ts';
import { cleanup } from './cleanup.ts';
import { origin, pin } from './direct.ts';

const SEED = Number(process.env.LIST_ORDER_SEED ?? Date.now() % 2 ** 31);
/** mulberry32: a seeded generator, so a failure names the seed that reproduces it (LIST_ORDER_SEED). */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const schema = {
  type: 'object', additionalProperties: false,
  properties: { s: { type: 'string', maxLength: 256 }, t: { type: 'string', maxLength: 8 }, n: { type: 'number' }, i: { type: 'integer' }, b: { type: 'boolean' } },
};
const fields = ['s', 't', 'n', 'i', 'b'] as const;
const declare = (ownership: 'shared' | 'owner', readers: boolean): CollectionSpec => ({
  mount: '/api/things', maxRecords: 10_000, pageSize: 50, schema, sortable: ['s', 'n', 'i', 'b', 't'], filterable: ['t', 'n', 'i', 'b', 's'],
  ...(ownership === 'owner' ? { ownership: 'owner' } : {}), ...(readers ? { readers: { everyone: { mount: '/api/every', properties: ['s', 't', 'n', 'i', 'b'] } } } : {}),
} as unknown as CollectionSpec);

// Code points on both sides of every boundary where UTF-8 byte order and UTF-16 code unit order differ, and ties.
const pieces = ['', 'a', 'b', 'A', 'z', ' ', '~', '\u0000', '\u007f', '\u0080', 'é', '߿', 'ࠀ', '퟿', '', '', '�', '￿', '😀', '\u{10000}', '\u{1f600}', '\u{10ffff}', 'ab', 'ä'];
const numbers = [0, -0, 1, -1, 0.1, 0.2, 0.30000000000000004, 1e21, -1e21, 5e-324, -5e-324, 1.7976931348623157e308, -1.7976931348623157e308, 2 ** 53, 2 ** 53 + 2, -(2 ** 53), 9223372036854775000, 123456789012345680000, 2.2250738585072014e-308];

function values(random: () => number) {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const text = (max: number): string => { let out = ''; for (let n = Math.floor(random() * 4); n > 0; n--) out += pick(pieces); return [...out].slice(0, max).join(''); };
  const number = (): number => random() < 0.5 ? pick(numbers) : random() < 0.5 ? Math.floor(random() * 5) : (random() - 0.5) * 10 ** Math.floor(random() * 40 - 20);
  const integer = (): number => random() < 0.8 ? Math.floor(random() * 7) - 3 : Math.floor((random() - 0.5) * 2 * Number.MAX_SAFE_INTEGER);
  return {
    pick, text,
    record(): Record<string, Scalar | null> {
      const out: Record<string, Scalar | null> = {};
      const maybe = (field: string, make: () => Scalar): void => { const roll = random(); if (roll < 0.15) return; out[field] = roll < 0.18 ? null : make(); };
      maybe('s', () => text(256)); maybe('t', () => text(8)); maybe('n', number); maybe('i', integer); maybe('b', () => random() < 0.5);
      return out;
    },
  };
}

async function database(t: TestContext): Promise<StoreDatabase> {
  const root = await mkdtemp(join(tmpdir(), 'store-list-order-'));
  const db = await openStoreDatabase(join(root, 'store.sqlite'));
  cleanup(t, () => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  cleanup(t, () => db.close());
  return db;
}
let seq = 0;
function insert(db: StoreDatabase, name: string, owner: string | null, data: Record<string, unknown> | string, id = randomUUID()): string {
  const now = new Date(Date.UTC(2026, 0, 1) + seq++).toISOString();
  db.run('INSERT INTO store_records(collection, id, owner, key, created_at, updated_at, data) VALUES (?, ?, ?, NULL, ?, ?, ?)', name, id, owner, now, now, typeof data === 'string' ? data : JSON.stringify(data));
  return id;
}

/** The reference: the in-memory path exactly as `listIn` ran it before #951 (every row in scope, in creation order). */
function reference(db: StoreDatabase, name: string, scope: string | undefined | null, params: URLSearchParams, spec: NormalizedSpec) {
  const where = scope === null ? 'collection = ? AND owner IS NOT NULL' : scope === undefined ? 'collection = ?' : 'collection = ? AND owner = ?';
  const rows = db.all<{ id: string; data: string }>(`SELECT id, data FROM store_records WHERE ${where} ORDER BY seq`, ...[name, ...scope ? [scope] : []]);
  const projected = rows.map(row => ({ id: row.id, ...JSON.parse(row.data) as StoredRecord }));
  const page = runList(projected, parseListQuery(spec, params));
  return { ids: page.items.map(item => item.id as string), total: page.total, next: page.next };
}
const COLUMNS = 'id, owner, key, created_at, updated_at, data';
const parse = (row: ListedRow): StoredRecord => ({ id: row.id, ...JSON.parse(row.data) as StoredRecord });
function viaSql(db: StoreDatabase, plan: ListPlan, scope: string | undefined | null, params: URLSearchParams, spec: NormalizedSpec) {
  const page = db.transaction(() => listInSql(db, plan, parseListQuery(spec, params), scope, COLUMNS, parse), 'DEFERRED');
  return page && { ids: page.items.map(item => item.id as string), total: page.total, next: page.next };
}

for (const [label, ownership, readers] of [['a shared collection', 'shared', false], ['an owned collection', 'owner', false], ['an owned collection with a readers mount', 'owner', true]] as const) {
  test(`SQL pages equal the in-memory reference on random data: ${label} (seed ${SEED})`, async t => {
    const random = generator(SEED ^ label.length), make = values(random), db = await database(t);
    const collection = new Collection('things', declare(ownership, readers)), spec = collection.spec, plan = listPlan('things', spec)!;
    collection.open(db);
    // The indexes the declaration asks for exist, so the pages below are read through them.
    const built = new Set(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name GLOB 'store_list_*'").map(row => row.name));
    assert.deepEqual([...plan.indexes.keys()].filter(index => !built.has(index)), []);
    const owners = ownership === 'owner' ? ['p1', 'p2', null] : [null];
    const ids: string[] = [];
    db.transaction(() => { for (let n = 0; n < 400; n++) ids.push(insert(db, 'things', make.pick(owners), make.record())); });
    // Another collection's rows are never in scope.
    db.transaction(() => { for (let n = 0; n < 20; n++) insert(db, 'other', 'p1', make.record()); });
    const scopes = ownership === 'owner' ? readers ? [null, 'p1'] : ['p1', 'p2'] : [undefined];
    const stored = db.all<{ data: string }>("SELECT data FROM store_records WHERE collection = 'things'").map(row => JSON.parse(row.data) as Record<string, Scalar | null>);
    const filterValue = (field: string): string => {
      const seen = stored.map(record => record[field]).filter(value => value !== null && value !== undefined);
      const value = random() < 0.8 && seen.length ? make.pick(seen)! : field === 'b' ? random() < 0.5 : field === 'i' ? 1 : field === 'n' ? 0.5 : make.text(field === 't' ? 8 : 256);
      return String(value);
    };
    let compared = 0;
    for (let round = 0; round < 60; round++) {
      const scope = make.pick(scopes), params = new URLSearchParams({ limit: String(1 + Math.floor(random() * 40)) });
      if (random() < 0.85) params.set('sort', `${random() < 0.5 ? '-' : ''}${make.pick(fields)}`);
      for (let n = Math.floor(random() * 3); n > 0; n--) { const field = make.pick(fields); if (!params.has(field)) params.set(field, filterValue(field)); }
      if (!params.has('sort') && ![...params.keys()].some(key => (fields as readonly string[]).includes(key))) params.set('t', filterValue('t'));
      for (let pages = 0; pages < 500; pages++) {
        const expected = reference(db, 'things', scope, params, spec), actual = viaSql(db, plan, scope, params, spec);
        assert.deepEqual(actual, expected, `seed ${SEED}, ${params}`);
        compared++;
        if (expected.next === undefined) break;
        // Cursor stability: now and then the cursor's own record is deleted before the next page, or a record added.
        if (params.has('sort') && random() < 0.1) db.run('DELETE FROM store_records WHERE collection = ? AND id = ?', 'things', expected.ids.at(-1)!);
        if (random() < 0.05) insert(db, 'things', make.pick(owners), make.record());
        params.set('cursor', String(expected.next));
      }
    }
    assert.ok(compared > 100, `compared ${compared} pages`);
  });
}

test('each page is read through the declared index: a range seek from the cursor, never a sort of the scope', async t => {
  const db = await database(t), make = values(generator(SEED));
  const owned = new Collection('things', declare('owner', true)), shared = new Collection('shared', declare('shared', false));
  owned.open(db); shared.open(db);
  db.transaction(() => {
    for (let n = 0; n < 50; n++) for (const [name, owner] of [['things', 'p1'], ['shared', null]] as const) insert(db, name, owner, { s: make.text(256), t: 'ab'[n % 2]!, n: n / 3, i: n % 7 });
  });
  const statements: [string, unknown[]][] = [];
  const all = db.all.bind(db);
  db.all = <T>(sql: string, ...bound: never[]): T[] => { statements.push([sql, bound]); return all<T>(sql, ...bound); };
  // The caller's own records, a readers mount's (every owned record), a filter beside the sort, and a shared collection.
  for (const [collection, scope, query] of [[owned, 'p1', 'sort=s&limit=5'], [owned, null, 'sort=-n&limit=5'], [owned, 'p1', 't=a&sort=i&limit=5'], [shared, undefined, 'sort=-s&limit=5']] as const) {
    const plan = listPlan(collection.name, collection.spec)!, first = viaSql(db, plan, scope, new URLSearchParams(query), collection.spec)!;
    viaSql(db, plan, scope, new URLSearchParams(`${query}&cursor=${first.next}`), collection.spec);
  }
  db.all = all;
  const sorted = statements.filter(([sql]) => sql.includes('ORDER BY coalesce'));
  assert.equal(sorted.length, 8);
  for (const [sql, bound] of sorted) {
    const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...bound as never[]).map(row => row.detail).join('; ');
    assert.match(plan, /USING INDEX store_list_[0-9a-f]{24}/, plan);
    assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
    if (sql.includes(' OR id ')) assert.match(plan, /<expr>[<>]\?/, `the cursor bounds the index range: ${plan}`);
  }
});

test('a row the SQL key cannot represent exactly is answered by the in-memory path, with the same page', async t => {
  const db = await database(t), make = values(generator(SEED + 1));
  const collection = new Collection('things', declare('shared', false)), spec = collection.spec, plan = listPlan('things', spec)!;
  collection.open(db);
  // Valid records only (no JSON null), so every page the collection serves parses.
  db.transaction(() => { for (let n = 0; n < 60; n++) insert(db, 'things', null, { s: make.text(256), n: n % 4, b: n % 3 === 0 }); });
  const params = new URLSearchParams('sort=s&limit=7');
  assert.notEqual(viaSql(db, plan, undefined, params, spec), undefined);
  // A lone surrogate (valid JSON, and a valid record) decodes to bytes that do not order as UTF-16: "\udbff" sorts after
  // "𐀀" (U+10000) in UTF-16 but before it as UTF-8.
  const lone = insert(db, 'things', null, { s: '\udbff' });
  insert(db, 'things', null, { s: '\u{10000}' });
  assert.equal(viaSql(db, plan, undefined, params, spec), undefined);
  const walk = (): string[] => { const out: string[] = []; const query = new URLSearchParams(params); for (;;) { const page = collection.list(query); out.push(...page.items.map(item => item.id as string)); if (page.next === undefined) return out; query.set('cursor', String(page.next)); } };
  const expected: string[] = []; { const query = new URLSearchParams(params); for (;;) { const page = reference(db, 'things', undefined, query, spec); expected.push(...page.ids); if (page.next === undefined) break; query.set('cursor', String(page.next)); } }
  assert.deepEqual(walk(), expected);
  db.run('DELETE FROM store_records WHERE id = ?', lone);
  assert.notEqual(viaSql(db, plan, undefined, params, spec), undefined);
  // A value of another type than declared (a row written under another declaration) is detected per type.
  for (const [field, value] of [['s', 5], ['n', 'x'], ['i', true], ['b', 1], ['t', false]] as const) {
    const id = insert(db, 'things', null, { [field]: value });
    assert.equal(viaSql(db, plan, undefined, params, spec), undefined, `${field}: ${JSON.stringify(value)}`);
    db.run('DELETE FROM store_records WHERE id = ?', id);
  }
  // A filter value or cursor with a lone surrogate is never bound as UTF-8 either.
  const query = parseListQuery(spec, new URLSearchParams('sort=s'));
  assert.equal(db.transaction(() => listInSql(db, plan, { ...query, after: { value: '\ud800', id: randomUUID() } }, undefined, COLUMNS, parse), 'DEFERRED'), undefined);
});

test('the list indexes follow the declaration: built on activation, and dropped once no declaration names them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'store-list-order-'));
  cleanup(t, () => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(join(root, 'app'));
  const database = join(root, 'data', 'store.sqlite');
  const indexes = async (): Promise<string[]> => { const db = await openStoreDatabase(database); try { return db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name GLOB 'store_list_*' ORDER BY name").map(row => row.name); } finally { db.close(); } };
  const activation: ExtensionActivation = { origin, target: 'node', projectSha256: pin, mounts: ['/api/things'], principalMounts: ['/api/things'], root: join(root, 'app') };
  const activate = async (things: object): Promise<() => Promise<void>> => {
    const store = createStore({ database, projectSha256: pin });
    const active = await store.registration.activate({ collections: { things } }, activation);
    return async () => { await active.close?.(); await store.close(); };
  };
  const sortable = { mount: '/api/things', schema, sortable: ['s', 'n'] };
  let close = await activate(sortable);
  const first = await indexes();
  // One per property and one for anomalous rows, exactly the plan's.
  assert.deepEqual(first, [...listPlan('things', new Collection('things', sortable as unknown as CollectionSpec).spec)!.indexes.keys()].sort());
  assert.equal(first.length, 3);
  await close();
  close = await activate({ mount: '/api/things', schema, filterable: ['b'] });
  const second = await indexes();
  assert.equal(second.length, 2);
  assert.deepEqual(second.filter(name => first.includes(name)), []);
  await close();
  close = await activate({ mount: '/api/things', schema });
  assert.deepEqual(await indexes(), []);
  await close();
});
