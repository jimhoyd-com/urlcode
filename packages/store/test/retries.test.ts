// Result-aware Idempotency-Key replay (#835): a retained key replays the first answer's status with the record as it
// is now, a key reused for a different request is 422 and writes nothing, racing retries run the mutation once (in
// one process and across connections), and the retry history survives a restart and a schema upgrade.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rm, writeFile } from 'node:fs/promises';
import { STORE_APPLICATION_ID, STORE_SCHEMA_VERSION } from '../src/index.ts';
import { direct, race } from './direct.ts';
import { counts, records } from './rows.ts';

const todos = { mount: '/api/todos', idempotency: { maxKeys: 50 }, maxRecords: 100, schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 40 }, done: { type: 'boolean' }, votes: { type: 'integer' } } }, defaults: { done: false, votes: 0 }, increments: ['votes'] };
const config = { collections: { todos } };
const mounts = ['/api/todos'];
const key = (value: string) => ({ 'idempotency-key': value });

test('a retry with the same key and request replays the first status with the record as it is now', async t => {
  const store = await direct(t, config, { mounts, principalMounts: [] });
  const first = await store.call('POST', '/api/todos', { body: { title: 'draft', done: false }, headers: key('create-1') });
  assert.equal(first.status, 201); assert.equal(first.header('idempotency-replayed'), undefined);
  const id = first.body!.id as string;
  // Key order does not matter: the fingerprint hashes the canonical JSON body.
  const same = await store.call('POST', '/api/todos', { raw: '{"done":false,"title":"draft"}', headers: key('create-1') });
  assert.equal(same.status, 201); assert.equal(same.header('idempotency-replayed'), 'true');
  assert.equal(same.body!.id, id); assert.equal(same.header('location'), `/api/todos/${id}`); assert.equal(same.header('etag'), first.header('etag'));
  // A later change, made without the key: the replay now shows the current record and its current ETag, never a stale
  // copy (no record values are kept with the claim), so an If-Match taken from the replay is usable.
  const changed = await store.call('PATCH', `/api/todos/${id}`, { body: { title: 'final' } });
  const replay = await store.call('POST', '/api/todos', { body: { title: 'draft', done: false }, headers: key('create-1') });
  assert.equal(replay.status, 201, 'the status of the first answer');
  assert.equal(replay.body!.title, 'final', 'the record as it is now');
  assert.equal(replay.header('etag'), changed.header('etag'));
  assert.equal((await store.call('PATCH', `/api/todos/${id}`, { body: { done: true }, headers: { 'if-match': replay.header('etag')! } })).status, 200);
  assert.equal(records(store.database, 'todos').length, 1, 'the create ran once');
  // Once the record is gone, the replay is the ordinary 404: nothing is recreated and no deleted value is kept.
  assert.equal((await store.call('DELETE', `/api/todos/${id}`)).status, 204);
  const gone = await store.call('POST', '/api/todos', { body: { title: 'draft', done: false }, headers: key('create-1') });
  assert.equal(gone.status, 404); assert.equal((gone.body!.error as { code: string }).code, 'not_found');
  assert.equal(records(store.database, 'todos').length, 0);
});

test('the same key on a different request is 422 idempotency_key_reused and writes nothing', async t => {
  const store = await direct(t, config, { mounts, principalMounts: [] });
  const created = await store.call('POST', '/api/todos', { body: { title: 'one' }, headers: key('k') });
  const id = created.body!.id as string;
  const before = counts(store.database);
  for (const [method, path, body] of [['POST', '/api/todos', { title: 'two' }], ['PATCH', `/api/todos/${id}`, { title: 'one' }], ['POST', `/api/todos/${id}/increment/votes`, undefined], ['DELETE', `/api/todos/${id}`, undefined]] as const) {
    const reused = await store.call(method, path, { ...(body ? { body } : {}), headers: key('k') });
    assert.equal(reused.status, 422, `${method} ${path}`);
    assert.equal((reused.body!.error as { code: string }).code, 'idempotency_key_reused');
  }
  assert.deepEqual(counts(store.database), before);
  assert.deepEqual(records(store.database, 'todos').map(record => [record.title, record.votes]), [['one', 0]]);
});

test('a refused write retains no key: its retry is evaluated again', async t => {
  const store = await direct(t, config, { mounts, principalMounts: [] });
  const created = await store.call('POST', '/api/todos', { body: { title: 'one' } });
  const id = created.body!.id as string, etag = created.header('etag')!;
  await store.call('PATCH', `/api/todos/${id}`, { body: { done: true } });
  const stale = await store.call('PATCH', `/api/todos/${id}`, { body: { title: 'two' }, headers: { ...key('p'), 'if-match': etag } });
  assert.equal(stale.status, 412);
  assert.equal(counts(store.database).idempotency, 0, 'a 412 claims nothing');
  const fresh = (await store.call('GET', `/api/todos/${id}`)).header('etag')!;
  const retried = await store.call('PATCH', `/api/todos/${id}`, { body: { title: 'two' }, headers: { ...key('p'), 'if-match': fresh } });
  assert.equal(retried.status, 200); assert.equal(retried.header('idempotency-replayed'), undefined);
  // If-Match is not part of the fingerprint: the retry of a committed write replays whatever If-Match it carries.
  const replayed = await store.call('PATCH', `/api/todos/${id}`, { body: { title: 'two' }, headers: { ...key('p'), 'if-match': etag } });
  assert.equal(replayed.status, 200); assert.equal(replayed.header('idempotency-replayed'), 'true');
});

test('keys are scoped to the principal when there is one, else to the network client', async t => {
  const store = await direct(t, config, { mounts });
  const post = (who: string | null, client: string) => store.call('POST', '/api/todos', { who, client, body: { title: 'x' }, headers: key('shared') });
  assert.equal((await post('alice', '198.51.100.1')).header('idempotency-replayed'), undefined);
  assert.equal((await post('alice', '198.51.100.2')).header('idempotency-replayed'), 'true', 'a signed-in retry from another address replays');
  assert.equal((await post('bob', '198.51.100.1')).header('idempotency-replayed'), undefined, 'another principal never sees alice\'s answer');
  assert.equal((await post(null, '198.51.100.1')).header('idempotency-replayed'), undefined, 'an anonymous caller is scoped by client');
  assert.equal((await post(null, '198.51.100.1')).header('idempotency-replayed'), 'true');
  assert.equal((await post(null, '198.51.100.3')).header('idempotency-replayed'), undefined);
  assert.equal(records(store.database, 'todos').length, 4);
});

test('racing retries in one process run the mutation once and replay it to every other caller', async t => {
  const store = await direct(t, config, { mounts, principalMounts: [] });
  const answers = await Promise.all(Array.from({ length: 12 }, () => store.call('POST', '/api/todos', { body: { title: 'once' }, headers: key('race') })));
  assert.ok(answers.every(answer => answer.status === 201));
  assert.equal(answers.filter(answer => answer.header('idempotency-replayed') === undefined).length, 1);
  assert.equal(new Set(answers.map(answer => answer.body!.id)).size, 1);
  assert.deepEqual(counts(store.database), { records: 1, idempotency: 1, outbox: 0 });
});

test('racing retries from separate connections run the mutation once', async t => {
  const store = await direct(t, config, { mounts, principalMounts: [] });
  const target = (await store.call('POST', '/api/todos', { body: { title: 'shared' } })).body!.id as string;
  await store.close();
  const racer = [{ method: 'POST', path: '/api/todos', init: { body: { title: 'raced' }, headers: key('cross') } }, { method: 'POST', path: `/api/todos/${target}/increment/votes`, init: { headers: key('bump') } }];
  const answers = (await race(t, store.database, config, store.activation, Array.from({ length: 4 }, () => racer))).flat();
  const creates = answers.filter((_, index) => index % 2 === 0), bumps = answers.filter((_, index) => index % 2 === 1);
  assert.ok(answers.every(answer => answer.status === 201 || answer.status === 200), JSON.stringify(answers.map(answer => answer.status)));
  assert.equal(creates.filter(answer => answer.replayed === null).length, 1, 'exactly one create ran');
  assert.equal(new Set(creates.map(answer => answer.body!.id)).size, 1);
  assert.equal(bumps.filter(answer => answer.replayed === null).length, 1, 'exactly one increment ran');
  assert.deepEqual(records(store.database, 'todos').map(record => [record.title, record.votes]), [['shared', 1], ['raced', 0]]);
});

test('the retry history survives a restart', async t => {
  const store = await direct(t, config, { mounts, principalMounts: [] });
  const first = await store.call('POST', '/api/todos', { body: { title: 'kept' }, headers: key('restart') });
  await store.open();
  const replay = await store.call('POST', '/api/todos', { body: { title: 'kept' }, headers: key('restart') });
  assert.equal(replay.status, 201); assert.equal(replay.header('idempotency-replayed'), 'true'); assert.equal(replay.body!.id, first.body!.id);
  assert.equal((await store.call('POST', '/api/todos', { body: { title: 'other' }, headers: key('restart') })).status, 422, 'and still guards the original fingerprint');
  assert.equal(records(store.database, 'todos').length, 1);
});

test('a version 1 database moves forward: records stay, fingerprint-less claims are dropped', async t => {
  const store = await direct(t, config, { mounts, principalMounts: [] });
  await store.close();
  // The shipped version 1 schema, as the first SQLite release created it (a frozen fixture of MIGRATIONS[0]).
  const path = store.database;
  for (const suffix of ['', '-wal', '-shm']) await rm(`${path}${suffix}`, { force: true, maxRetries: 5 });
  await writeFile(path, '', { mode: 0o600 });
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE store_records(seq INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, id TEXT NOT NULL,
       owner TEXT, key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
       data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'), UNIQUE(collection, id), UNIQUE(collection, key));
     CREATE INDEX store_records_order ON store_records(collection, seq);
     CREATE INDEX store_records_owner ON store_records(collection, owner, seq);
     CREATE TABLE store_idempotency(seq INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, key TEXT NOT NULL,
       claimed_at INTEGER NOT NULL, UNIQUE(collection, key));
     CREATE INDEX store_idempotency_order ON store_idempotency(collection, seq);
     CREATE TABLE store_audit_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, collection TEXT NOT NULL,
       at INTEGER NOT NULL, event TEXT NOT NULL CHECK (json_valid(event)));
     CREATE INDEX store_audit_outbox_order ON store_audit_outbox(at, seq);
     CREATE INDEX store_audit_outbox_collection ON store_audit_outbox(collection);
     PRAGMA application_id=${STORE_APPLICATION_ID}; PRAGMA user_version=1;`);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO store_records(collection, id, owner, key, created_at, updated_at, data) VALUES (?, ?, NULL, NULL, ?, ?, ?)').run('todos', '00000000-0000-4000-8000-000000000001', now, now, JSON.stringify({ title: 'old', done: false, votes: 0 }));
    db.prepare('INSERT INTO store_idempotency(collection, key, claimed_at) VALUES (?, ?, ?)').run('todos', 'f'.repeat(64), Date.now());
  } finally { db.close(); }
  await store.open();
  const upgraded = new DatabaseSync(path);
  try {
    assert.equal(upgraded.prepare('PRAGMA user_version').get()!.user_version, STORE_SCHEMA_VERSION);
    assert.deepEqual(upgraded.prepare('PRAGMA table_info(store_idempotency)').all().map(column => column.name), ['seq', 'collection', 'key', 'fingerprint', 'status', 'record_id', 'claimed_at']);
  } finally { upgraded.close(); }
  assert.deepEqual(records(path, 'todos').map(record => record.title), ['old']);
  assert.equal(counts(path).idempotency, 0);
});
