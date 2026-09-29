// urlcode#988: a string holding an unpaired UTF-16 surrogate (a JSON `\uD800` escape) reached the store and bypassed
// `unique` and `intervals.within`, because SQLite's `->>` and a bound JS string carry it as different bytes; the next
// activation then saw the duplicate or overlap and refused to start. Core now refuses such a string in every JSON
// body (400 invalid_unicode), the store refuses it on every write path that does not pass through HTTP (StoreExports,
// host transactions, declarations), and activation names a row an earlier release stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { StoreError, normalize } from '../src/index.ts';
import type { CollectionSpec } from '../src/index.ts';
import { direct } from './direct.ts';
import { json, running } from './ownership-support.ts';
import { counts, records } from './rows.ts';

const tags = { mount: '/api/notes', ownership: 'owner', schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 20 } } }, unique: ['title'] };
const desks = { mount: '/api/notes', ownership: 'owner', schema: { type: 'object', additionalProperties: false, required: ['desk', 'start', 'end'], properties: { desk: { type: 'string', maxLength: 20 }, start: { type: 'integer' }, end: { type: 'integer' } } }, intervals: { start: 'start', end: 'end', within: ['desk'] } };
const links = { mount: '/api/notes', key: 'code', schema: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', maxLength: 20 } } } };
const code = async (response: Response) => ((await response.json()) as { error?: { code?: string } }).error?.code;

test('HTTP: a lone surrogate cannot bypass unique, and the restart still activates (#988 reproduction)', async t => {
  const app = await running(t, { collection: tags });
  const post = (who: string, raw: string) => app.as(who)('/api/notes', { method: 'POST', headers: json, body: raw });
  for (const raw of ['{"title":"\\ud800bob"}', '{"title":"bob\\uDFFF"}', '{"title":"\\udc00\\ud800"}']) {
    const refused = await post('alice', raw);
    assert.equal(refused.status, 400, raw); assert.equal(await code(refused), 'invalid_unicode');
  }
  // A key holding one is refused the same way, before the schema could report an undeclared name.
  assert.equal(await code(await post('alice', '{"title":"x","\\ud800":1}')), 'invalid_unicode');
  // A well-formed pair escape is ordinary text, and the control case still collides across owners.
  assert.equal((await post('alice', '{"title":"\\ud83d\\ude00bob"}')).status, 201);
  assert.equal(await code(await post('bob', '{"title":"\\ud83d\\ude00bob"}')), 'value_taken');
  assert.equal((await app.stored()).records.length, 1);
  await app.restart();
  assert.equal((await app.as('alice')('/api/notes')).status, 200, 'activation found nothing to refuse');
});

test('HTTP: a lone surrogate cannot bypass intervals.within; the control desk still conflicts', async t => {
  const app = await running(t, { collection: desks });
  const book = (who: string, raw: string) => app.as(who)('/api/notes', { method: 'POST', headers: json, body: raw });
  const refused = await book('alice', '{"desk":"\\udc00","start":0,"end":10}');
  assert.equal(refused.status, 400); assert.equal(await code(refused), 'invalid_unicode');
  assert.equal((await book('alice', '{"desk":"d1","start":0,"end":10}')).status, 201);
  const overlap = await book('bob', '{"desk":"d1","start":5,"end":15}');
  assert.equal(overlap.status, 409); assert.equal(await code(overlap), 'interval_conflict');
  await app.restart();
  assert.equal((await app.as('alice')('/api/notes')).status, 200);
});

test('HTTP: distinct lone-surrogate keys no longer collide with each other or with U+FFFD', async t => {
  const app = await running(t, { collection: links });
  const post = (raw: string) => app.as('alice')('/api/notes', { method: 'POST', headers: json, body: raw });
  for (const raw of ['{"code":"\\ud800a"}', '{"code":"\\ud801a"}']) assert.equal(await code(await post(raw)), 'invalid_unicode', raw);
  assert.equal((await post('{"code":"\\ufffda"}')).status, 201, 'the replacement character itself is well-formed text');
  // PATCH and PUT read the body through the same reader.
  const id = (await app.stored()).records[0]!.id as string;
  for (const method of ['PATCH', 'PUT']) assert.equal(await code(await app.as('alice')(`/api/notes/${id}`, { method, headers: json, body: '{"code":"\\ud800"}' })), 'invalid_unicode', method);
});

test('StoreExports and host transactions refuse a lone surrogate with 422 invalid_record and roll back', async t => {
  const store = await direct(t, { collections: { tags: { ...tags, mount: '/api/tags' } } }, { mounts: ['/api/tags'] });
  const alice = { id: 'alice' }, bob = { id: 'bob' };
  const unicode = (error: StoreError) => error.status === 422 && error.code === 'invalid_record' && error.issues?.[0]?.keyword === 'unicode';
  await assert.rejects(store.first.records('tags').create(alice, { title: '\ud800bob' }), unicode);
  const { record } = await store.first.records('tags').create(alice, { title: 'bob' });
  await assert.rejects(store.first.records('tags').update(alice, record.id as string, { title: '\udfffbob' }), unicode);
  const before = counts(store.database);
  assert.throws(() => store.first.transaction(tx => { tx.records('tags').create(bob, { title: 'carol' }); tx.records('tags').create(bob, { title: '\ud800bob' }); }), unicode);
  assert.throws(() => store.first.transaction(tx => { tx.records('tags').update(alice, record.id as string, { title: '\ud800' }); }), unicode);
  assert.deepEqual(counts(store.database), before, 'the create in the same transaction rolled back too');
  assert.deepEqual(records(store.database, 'tags').map(row => row.title), ['bob']);
});

test('activation names a stored lone surrogate as the cause; a declaration cannot hold one', async t => {
  const now = new Date().toISOString(), id = randomUUID();
  const app = await running(t, { collection: tags, seed: [{ id, createdAt: now, updatedAt: now, _owner: 'alice', title: '\ud800bob' }] }).catch((error: unknown) => error);
  assert.ok(app instanceof Error);
  assert.match(String((app as Error).message) + String((app as Error).cause ?? ''), new RegExp(`record ${id} holds title as a string with an unpaired UTF-16 surrogate`));
  assert.throws(() => normalize('tags', { ...tags, schema: { ...tags.schema, properties: { ...tags.schema.properties, colour: { type: 'string', maxLength: 8 } } }, defaults: { colour: '\udc00' } } as unknown as CollectionSpec), /defaults\.colour must be well-formed Unicode/);
  assert.throws(() => normalize('requests', { mount: '/api/r', ownership: 'owner', schema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', maxLength: 8 } } }, defaults: { status: 'a' }, readOnlyProperties: ['status'], transitions: { go: { from: { status: 'a' }, set: { status: '\ud800' } } } } as unknown as CollectionSpec), /set value for status must be well-formed Unicode/);
});

test('a list cursor holding a lone surrogate is an invalid cursor, not a fallback', async t => {
  const store = await direct(t, { collections: { tags: { ...tags, mount: '/api/tags', sortable: ['title'] } } }, { mounts: ['/api/tags'] });
  const cursor = Buffer.from(JSON.stringify(['title', false, '\ud800', randomUUID()])).toString('base64url');
  const answer = await store.call('GET', `/api/tags?sort=title&cursor=${cursor}`, { who: 'alice' });
  assert.equal(answer.status, 400); assert.equal((answer.body?.error as { code?: string }).code, 'invalid_query');
});
