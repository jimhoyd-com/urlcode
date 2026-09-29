// The store requests of the third agent trial (#952, #953):
// 1. `editable` and `deletable`: a record outside its declared states answers 409 record_locked to PUT, PATCH and
//    DELETE on every write path (HTTP, StoreExports, a host transaction), decided under the write lock, while creates
//    still take every writable property. `Allow` and a list's `allow` say which methods a record takes now.
// 2. `unique`: a handle no two records hold alike, across owners, so a directory lookup by it names one wallet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { StoreError, createStore, normalize } from '../src/index.ts';
import type { CollectionSpec } from '../src/index.ts';
import { uniqueIndex } from '../src/collection.ts';
import { describeStore } from '../src/openapi.ts';
import { direct, pin, race } from './direct.ts';
import type { Answer } from './direct.ts';
import { counts, records, seed } from './rows.ts';

const code = (answer: Answer) => (answer.body?.error as { code?: string } | undefined)?.code;
const members = { membership: true, key: 'userId', schema: { type: 'object', additionalProperties: false, required: ['userId'], properties: { userId: { type: 'string', maxLength: 128 } } } };

// 1. The trial's approval workflow, with the edits and deletes it could not declare.
const requests = {
  mount: '/api/requests', ownership: 'owner',
  schema: { type: 'object', additionalProperties: false, required: ['title', 'amount', 'status'], properties: { title: { type: 'string', minLength: 1, maxLength: 120 }, amount: { type: 'integer', minimum: 1, maximum: 100000 }, status: { type: 'string', enum: ['draft', 'pending', 'approved', 'rejected'] }, reviewedBy: { type: 'string', maxLength: 128 }, reviewedAt: { type: 'string', maxLength: 32 } } },
  defaults: { status: 'draft' }, readOnlyProperties: ['status', 'reviewedBy', 'reviewedAt'],
  editable: { status: 'draft' }, deletable: { status: ['draft', 'rejected'] },
  transitions: {
    submit: { from: { status: 'draft' }, set: { status: 'pending' } },
    withdraw: { from: { status: 'pending' }, set: { status: 'draft' } },
    approve: { from: { status: 'pending' }, set: { status: 'approved' }, stamp: { reviewedBy: 'actor', reviewedAt: 'now' }, by: 'others', mount: '/api/approve', members: 'reviewers' },
    reject: { from: { status: 'pending' }, set: { status: 'rejected' }, stamp: { reviewedBy: 'actor', reviewedAt: 'now' }, by: 'others', mount: '/api/reject', members: 'reviewers' },
  },
};
const approvals = { collections: { reviewers: members, requests } };
const approvalMounts = ['/api/requests', '/api/approve', '/api/reject'];

test('editable and deletable: an approved request cannot be edited or deleted, and a create still takes every writable property', async t => {
  const store = await direct(t, approvals, { mounts: approvalMounts });
  store.first.records('reviewers').create(null, { userId: 'rita' });
  const created = await store.call('POST', '/api/requests', { who: 'alice', body: { title: 'Laptop', amount: 1200 } });
  assert.equal(created.status, 201, 'readOnlyProperties never blocked title or amount; editable does not either');
  assert.deepEqual([created.body!.title, created.body!.amount, created.body!.status], ['Laptop', 1200, 'draft']);
  assert.equal(created.header('allow'), undefined, 'a create answers at another URL');
  const id = created.body!.id as string, url = `/api/requests/${id}`;
  const read = await store.call('GET', url, { who: 'alice' });
  assert.equal(read.header('allow'), 'GET, HEAD, PUT, PATCH, DELETE');
  const patched = await store.call('PATCH', url, { who: 'alice', body: { amount: 1100 } });
  assert.equal(patched.status, 200); assert.equal(patched.header('allow'), 'GET, HEAD, PUT, PATCH, DELETE');
  assert.equal((await store.call('POST', `${url}/submit`, { who: 'alice' })).status, 200);
  // Pending: under review, so neither the owner's edits nor a delete; withdraw is the way back.
  const locked = async (label: string) => {
    const before = { counts: counts(store.database), rows: records(store.database, 'requests') };
    for (const [method, body] of [['PATCH', { amount: 99999 }], ['PUT', { title: 'Laptop', amount: 99999 }], ['DELETE', undefined]] as const) {
      const refused = await store.call(method, url, { who: 'alice', ...(body ? { body } : {}) });
      assert.equal(refused.status, 409, `${label} ${method}`); assert.equal(code(refused), 'record_locked');
    }
    assert.deepEqual({ counts: counts(store.database), rows: records(store.database, 'requests') }, before, `${label}: nothing written`);
  };
  await locked('pending');
  assert.equal((await store.call('GET', url, { who: 'alice' })).header('allow'), 'GET, HEAD');
  assert.equal((await store.call('POST', `/api/approve/${id}`, { who: 'rita' })).status, 200);
  await locked('approved');
  const list = await store.call('GET', '/api/requests', { who: 'alice' });
  assert.deepEqual(list.body!.allow, { [id]: ['GET', 'HEAD'] });
  assert.equal(records(store.database, 'requests')[0]!.amount, 1100, 'the approval vouches for the amount reviewed');
  // A stale If-Match is still a 412, checked first, and an unknown id a 404: the lock discloses nothing more.
  assert.equal((await store.call('PATCH', url, { who: 'alice', body: { amount: 5 }, headers: { 'if-match': created.header('etag')! } })).status, 412);
  assert.equal((await store.call('DELETE', url, { who: 'mallory' })).status, 404);
  // A rejected request may be deleted, not edited.
  const second = (await store.call('POST', '/api/requests', { who: 'alice', body: { title: 'Desk', amount: 300 } })).body!.id as string;
  await store.call('POST', `/api/requests/${second}/submit`, { who: 'alice' });
  await store.call('POST', `/api/reject/${second}`, { who: 'rita' });
  assert.equal((await store.call('GET', `/api/requests/${second}`, { who: 'alice' })).header('allow'), 'GET, HEAD, DELETE');
  assert.equal(code(await store.call('PATCH', `/api/requests/${second}`, { who: 'alice', body: { amount: 1 } })), 'record_locked');
  assert.equal((await store.call('DELETE', `/api/requests/${second}`, { who: 'alice' })).status, 204);
});

test('editable and deletable hold for StoreExports and host transactions, which roll back', async t => {
  const store = await direct(t, approvals, { mounts: approvalMounts });
  store.first.records('reviewers').create(null, { userId: 'rita' });
  const alice = { id: 'alice' }, rita = { id: 'rita' };
  const { record } = await store.first.records('requests').create(alice, { title: 'Laptop', amount: 1200 });
  const id = record.id as string;
  await store.first.records('requests').transition(alice, id, 'submit');
  await store.first.records('requests').transition(rita, id, 'approve');
  await assert.rejects(store.first.records('requests').update(alice, id, { amount: 99999 }), (error: StoreError) => error.status === 409 && error.code === 'record_locked');
  const before = counts(store.database);
  for (const step of [(tx: Parameters<Parameters<typeof store.first.transaction>[0]>[0]) => tx.records('requests').update(alice, id, { amount: 99999 }), (tx: Parameters<Parameters<typeof store.first.transaction>[0]>[0]) => tx.records('requests').remove(alice, id)]) {
    assert.throws(() => store.first.transaction(tx => { tx.records('requests').create(alice, { title: 'Chair', amount: 50 }); step(tx); }), (error: StoreError) => error.code === 'record_locked');
  }
  assert.deepEqual(counts(store.database), before, 'the create in the same transaction rolled back too');
  assert.equal(records(store.database, 'requests')[0]!.amount, 1200);
});

test('editable and deletable: activation refuses a state an edit could leave or that no record could hold', () => {
  const refused = (change: Partial<CollectionSpec>, pattern: RegExp) => assert.throws(() => normalize('requests', { ...requests, ...change } as CollectionSpec), pattern);
  refused({ editable: { title: 'x' } }, /editable: title must be listed under readOnlyProperties/);
  refused({ deletable: { colour: 'red' } }, /deletable names colour, which is not a declared property/);
  refused({ editable: { status: ['draft', 'archived'] } }, /editable value for status must be one of the declared values/);
  refused({ readOnly: true }, /editable needs a writable collection/);
  assert.throws(() => normalize('reviewers', { ...members, editable: { userId: 'x' } } as CollectionSpec), /a membership collection takes no editable/);
  assert.deepEqual(normalize('requests', requests as CollectionSpec).deletable, { status: ['draft', 'rejected'] });
});

// 2. The trial's credits directory, with a handle no two owners share.
const wallets = {
  mount: '/api/wallets', ownership: 'owner',
  schema: { type: 'object', additionalProperties: false, required: ['handle', 'balance'], properties: { handle: { type: 'string', pattern: '^[a-z0-9_]{3,20}$', maxLength: 20 }, note: { type: 'string', maxLength: 40 }, balance: { type: 'integer' } } },
  defaults: { balance: 0 }, readOnlyProperties: ['balance'], filterable: ['handle'], unique: ['handle'],
  readers: { directory: { mount: '/api/directory', properties: ['handle'] } },
  transfers: { pay: { amount: 'balance' } },
};
const walletMounts = ['/api/wallets', '/api/directory'];

test('unique: a handle is taken across owners, so a directory lookup finds one wallet', async t => {
  const store = await direct(t, { collections: { wallets } }, { mounts: walletMounts });
  const bob = await store.call('POST', '/api/wallets', { who: 'bob', body: { handle: 'bob' } });
  assert.equal(bob.status, 201);
  const before = counts(store.database);
  const spoof = await store.call('POST', '/api/wallets', { who: 'mallory', body: { handle: 'bob' } });
  assert.equal(spoof.status, 409); assert.equal(code(spoof), 'value_taken');
  assert.deepEqual((spoof.body!.error as { issues: unknown }).issues, [{ pointer: '/handle', keyword: 'unique', message: 'is already used by another record' }], 'names the property, never the holder');
  assert.deepEqual(counts(store.database), before);
  const lookup = await store.call('GET', '/api/directory?handle=bob', { who: 'carol' });
  assert.equal(lookup.body!.total, 1); assert.equal((lookup.body!.items as { id: string }[])[0]!.id, bob.body!.id);
  // An update is checked too, except against the record's own value; the same owner's second record is refused alike.
  const mine = (await store.call('POST', '/api/wallets', { who: 'mallory', body: { handle: 'mal' } })).body!.id as string;
  assert.equal(code(await store.call('PATCH', `/api/wallets/${mine}`, { who: 'mallory', body: { handle: 'bob' } })), 'value_taken');
  assert.equal(code(await store.call('PUT', `/api/wallets/${mine}`, { who: 'mallory', body: { handle: 'bob' } })), 'value_taken');
  assert.equal((await store.call('PATCH', `/api/wallets/${mine}`, { who: 'mallory', body: { handle: 'mal', note: 'same handle' } })).status, 200);
  assert.equal(code(await store.call('POST', '/api/wallets', { who: 'bob', body: { handle: 'mal' } })), 'value_taken');
  assert.throws(() => store.first.transaction(tx => tx.records('wallets').update({ id: 'mallory' }, mine, { handle: 'bob' })), (error: StoreError) => error.code === 'value_taken');
  // A deleted record frees its handle.
  assert.equal((await store.call('DELETE', `/api/wallets/${bob.body!.id as string}`, { who: 'bob' })).status, 204);
  assert.equal((await store.call('PATCH', `/api/wallets/${mine}`, { who: 'mallory', body: { handle: 'bob' } })).status, 200);
});

test('unique: racing creates from separate connections claim a handle once', async t => {
  const store = await direct(t, { collections: { wallets } }, { mounts: walletMounts });
  await store.close();
  const answers = (await race(t, store.database, { collections: { wallets } }, store.activation, ['ann', 'bea', 'cy', 'dee'].map(who => [{ method: 'POST', path: '/api/wallets', init: { who, body: { handle: 'shared' } } }]))).flat();
  assert.deepEqual(answers.map(answer => answer.status).sort(), [201, 409, 409, 409]);
  assert.equal(records(store.database, 'wallets').length, 1);
});

test('unique: the index is built on activation and dropped once nothing declares it', async t => {
  const store = await direct(t, { collections: { wallets } }, { mounts: walletMounts });
  await store.close();
  const indexes = () => { const db = new DatabaseSync(store.database); try { return db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name GLOB 'store_unique_*'").all().map(entry => String(entry.name)); } finally { db.close(); } };
  assert.deepEqual(indexes(), [uniqueIndex('wallets', 'handle').index]);
  const running = createStore({ database: store.database, projectSha256: pin });
  const instance = await running.registration.activate({ collections: { wallets: { ...wallets, unique: undefined } } }, store.activation);
  try { assert.deepEqual(indexes(), []); } finally { await instance.close?.(); await running.close(); }
});

test('unique: activation refuses stored duplicates, and the declaration is checked', async t => {
  const store = await direct(t, { collections: { wallets } }, { mounts: walletMounts });
  await store.close();
  const stamp = '2026-01-01T00:00:00.000Z';
  await seed(store.database, 'wallets', [
    { id: '00000000-0000-4000-8000-000000000001', createdAt: stamp, updatedAt: stamp, _owner: 'bob', handle: 'bob', balance: 0 },
    { id: '00000000-0000-4000-8000-000000000002', createdAt: stamp, updatedAt: stamp, _owner: 'mallory', handle: 'bob', balance: 0 },
  ]);
  await assert.rejects(store.open(), /two records hold the same handle, which unique refuses/);
  const refused = (change: Record<string, unknown>, pattern: RegExp) => assert.throws(() => normalize('wallets', { ...wallets, ...change } as CollectionSpec), pattern);
  refused({ unique: ['balance'] }, /unique property balance must be a string property/);
  refused({ unique: ['handle'], defaults: { balance: 0, handle: 'abc' } }, /no default and not readOnly/);
  refused({ unique: ['nope'] }, /unique property nope is not declared/);
  const bare = { mount: '/api/tags', schema: { type: 'object', additionalProperties: false, required: ['tag'], properties: { tag: { type: 'string', maxLength: 20 }, state: { type: 'string', maxLength: 20 } } }, unique: ['tag'] };
  assert.throws(() => normalize('tags', { ...bare, transitions: { claim: { from: { state: 'open' }, set: { tag: 'x' } } } } as CollectionSpec), /unique property tag is set by transition claim/);
  assert.throws(() => normalize('tags', { ...bare, key: 'tag' } as CollectionSpec), /is the key/);
  assert.throws(() => normalize('tags', { ...bare, ownership: 'owner', key: 'tag', unique: undefined } as unknown as CollectionSpec), /declare unique: \[tag\]/);
});

test('OpenAPI names record_locked, value_taken and the Allow hint', () => {
  const out = describeStore({ mount: '/api/requests', config: approvals, schemas: {} } as unknown as Parameters<typeof describeStore>[0])!;
  const item = out.paths['/api/requests/{id}'] as Record<string, { responses: Record<string, { description: string; headers?: Record<string, unknown> }> }>;
  assert.match(item.patch!.responses['409']!.description, /record_locked \(the record is not in an editable state: status is "draft"\)/);
  assert.match(item.delete!.responses['409']!.description, /record_locked: the record is not in a deletable state \(status is "draft" or "rejected"\)/);
  assert.ok(item.get!.responses['200']!.headers!.Allow);
  assert.ok(((out.schemas!.StoreRequestsList as { properties: Record<string, unknown> }).properties.allow));
  const wallet = describeStore({ mount: '/api/wallets', config: { collections: { wallets } }, schemas: {} } as unknown as Parameters<typeof describeStore>[0])!;
  const post = (wallet.paths['/api/wallets'] as Record<string, { responses: Record<string, { description: string }> }>).post!;
  assert.match(post.responses['409']!.description, /value_taken/);
  assert.equal(((wallet.paths['/api/wallets/{id}'] as Record<string, { responses: Record<string, { headers?: Record<string, unknown> }> }>).get!.responses['200']!.headers!.Allow), undefined, 'no hint without editable or deletable');
});
