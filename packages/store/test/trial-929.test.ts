// The store requests of the scheduling/credits trial (#929):
// 1. `intervals.length` and `intervals.step`: a fixed slot length and a grid the bounds sit on, refused with 422
//    invalid_record on every write path (create, PUT, PATCH, a transition, a host transaction) and at activation.
// 2. `create.members`: only a membership collection's principals create; anyone else is 401 without a principal or 403
//    before the Idempotency-Key or any record is read, on HTTP, StoreExports and a host transaction alike.
// 3. `readers.properties`: a projected readers mount, optionally without members, answers `id` and the listed properties
//    only, sorts and filters by those only, and tags them with an ETag of the projection, so a sender finds a
//    recipient's wallet id by name without seeing a balance, a timestamp or when a balance moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, StoreError, addMember, normalize, removeMember } from '../src/index.ts';
import type { CollectionSpec } from '../src/index.ts';
import { describeStore } from '../src/openapi.ts';
import { direct } from './direct.ts';
import type { Answer } from './direct.ts';
import { counts, records, seed } from './rows.ts';

const code = (answer: Answer) => (answer.body?.error as { code?: string } | undefined)?.code;
const issues = (answer: Answer) => (answer.body!.error as { issues: { pointer: string; keyword: string; message: string }[] }).issues.map(issue => `${issue.pointer} ${issue.message}`);
const at = (time: string) => `2026-10-01T${time}Z`;
const members = { membership: true, key: 'userId', schema: { type: 'object', additionalProperties: false, required: ['userId'], properties: { userId: { type: 'string', maxLength: 128 } } } };

// 1. Fixed-length, aligned slots.
const slotSchema = { type: 'object', additionalProperties: false, required: ['room', 'start', 'end'], properties: { room: { type: 'string', maxLength: 20 }, start: { type: 'string', format: 'date-time', maxLength: 40 }, end: { type: 'string', format: 'date-time', maxLength: 40 }, status: { type: 'string', enum: ['booked', 'cancelled'] } } };
const slots = {
  mount: '/api/slots', ownership: 'owner', schema: slotSchema, defaults: { status: 'booked' }, readOnlyProperties: ['status'],
  intervals: { start: 'start', end: 'end', within: ['room'], when: { status: 'booked' }, length: 'PT1H', step: 'PT1H' },
  transitions: { cancel: { from: { status: 'booked' }, set: { status: 'cancelled' } }, reopen: { from: { status: 'cancelled' }, set: { status: 'booked' } } },
};
const shiftSchema = { type: 'object', additionalProperties: false, required: ['start', 'end'], properties: { start: { type: 'integer' }, end: { type: 'integer' } } };
const shifts = { mount: '/api/shifts', schema: shiftSchema, intervals: { start: 'start', end: 'end', step: 15 } };

test('intervals.length and step: only a whole, aligned slot is written; anything else is 422 and writes nothing', async t => {
  const store = await direct(t, { collections: { slots, shifts } }, { mounts: ['/api/slots', '/api/shifts'] });
  const book = (body: Record<string, unknown>) => store.call('POST', '/api/slots', { who: 'ann', body: { room: 'a', ...body } });
  // The trial's twelve-hour booking, a half-hour one and a slot off the hour.
  const long = await book({ start: at('08:00:00'), end: at('20:00:00') });
  assert.equal(long.status, 422); assert.equal(code(long), 'invalid_record');
  assert.deepEqual(issues(long), ['/end must be exactly PT1H after start']);
  assert.deepEqual(issues(await book({ start: at('09:00:00'), end: at('09:30:00') })), ['/end must be a whole multiple of PT1H from 1970-01-01T00:00:00Z', '/end must be exactly PT1H after start']);
  assert.deepEqual(issues(await book({ start: at('09:30:00'), end: at('10:30:00') })), ['/start must be a whole multiple of PT1H from 1970-01-01T00:00:00Z', '/end must be a whole multiple of PT1H from 1970-01-01T00:00:00Z']);
  assert.deepEqual(issues(await book({ start: at('09:00:00.001'), end: at('10:00:00.001') })), ['/start must be a whole multiple of PT1H from 1970-01-01T00:00:00Z', '/end must be a whole multiple of PT1H from 1970-01-01T00:00:00Z'], 'a millisecond off the grid is off it');
  assert.equal(records(store.database, 'slots').length, 0);
  const nine = await book({ start: at('09:00:00'), end: at('10:00:00') });
  assert.equal(nine.status, 201);
  assert.equal((await book({ start: at('10:00:00.000'), end: at('11:00:00') })).status, 201, 'an adjacent slot, the instant written with milliseconds');
  const id = nine.body!.id as string;
  // PATCH and PUT are judged on the record as they leave it: a move of one bound breaks the length.
  const patched = await store.call('PATCH', `/api/slots/${id}`, { who: 'ann', body: { end: at('11:00:00') } });
  assert.equal(patched.status, 422); assert.deepEqual(issues(patched), ['/end must be exactly PT1H after start']);
  assert.equal((await store.call('PUT', `/api/slots/${id}`, { who: 'ann', body: { room: 'b', start: at('13:00:00'), end: at('14:00:00') } })).status, 200, 'a whole slot elsewhere');
  // The integer grid: a shift of any whole number of quarter hours, in minutes from zero.
  assert.equal((await store.call('POST', '/api/shifts', { body: { start: 540, end: 585 } })).status, 201);
  const off = await store.call('POST', '/api/shifts', { body: { start: 600, end: 610 } });
  assert.equal(off.status, 422); assert.deepEqual(issues(off), ['/end must be a whole multiple of 15']);
});

test('intervals.length holds for a transition and a host transaction too, and activation refuses stored records that break it', async t => {
  const store = await direct(t, { collections: { slots } }, { mounts: ['/api/slots'] });
  const nine = await store.call('POST', '/api/slots', { who: 'ann', body: { room: 'a', start: at('09:00:00'), end: at('10:00:00') } });
  assert.equal((await store.call('POST', `/api/slots/${nine.body!.id as string}/cancel`, { who: 'ann' })).status, 200, 'a transition that leaves the bounds alone passes');
  assert.throws(() => store.exports.transaction(tx => tx.records('slots').create({ id: 'ann' }, { room: 'a', start: at('09:00:00'), end: at('09:45:00') })), (error: unknown) => error instanceof StoreError && error.status === 422 && error.code === 'invalid_record');
  await store.close();
  await seed(store.database, 'slots', [{ id: '00000000-0000-4000-8000-000000000009', createdAt: at('00:00:00'), updatedAt: at('00:00:00'), _owner: 'bob', room: 'c', start: at('09:00:00'), end: at('11:00:00'), status: 'cancelled' }]);
  await assert.rejects(store.open(), /record 00000000-0000-4000-8000-000000000009 holds an interval that intervals refuses \(.*a length or step it does not keep\)/, 'a cancelled record keeps the length too: the bounds are the record\'s own');
});

test('activation refuses a length or step it cannot keep exactly', () => {
  const refuse = (intervals: Record<string, unknown>, message: RegExp, schema?: unknown) => assert.throws(() => normalize('c', { ...schema === undefined ? slots : { ...shifts, schema }, intervals: { start: 'start', end: 'end', ...intervals } } as unknown as CollectionSpec), message);
  for (const duration of ['PT0S', 'P', 'PT', 'P1Y', 'P1M', 'PT1.5H', 60]) refuse({ length: duration }, /length must be an ISO 8601 duration/);
  refuse({ length: 'PT90M', step: 'PT1H' }, /length must be a whole multiple of step/);
  refuse({ step: 'PT1H' }, /step must be a positive integer for integer bounds/, shiftSchema);
  refuse({ step: 0 }, /step must be a positive integer/, shiftSchema);
  refuse({ length: 10 }, /length needs integer bounds/, { ...shiftSchema, properties: { start: { type: 'number' }, end: { type: 'number' } } });
  const spec = normalize('c', { ...slots, intervals: { start: 'start', end: 'end', length: 'P1DT2H', step: 'PT30M' } } as unknown as CollectionSpec).intervals!;
  assert.deepEqual([spec.length, spec.step], [{ declared: 'P1DT2H', units: 26 * 3_600_000 }, { declared: 'PT30M', units: 1_800_000 }]);
  // The declaration is part of the fence's fingerprint (#936): a changed length is a changed declaration.
  const fingerprint = (intervals: Record<string, unknown>) => new Collection('c', { ...slots, intervals: { ...slots.intervals, ...intervals } } as unknown as CollectionSpec).fingerprint;
  assert.notEqual(fingerprint({}), fingerprint({ length: 'PT2H' }));
  assert.notEqual(fingerprint({}), fingerprint({ step: 'PT30M' }));
});

// 2. Members-gated create.
const staff = { ...members };
const bookings = { mount: '/api/bookings', ownership: 'owner', idempotency: { maxKeys: 50 }, audit: false, schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 40 } } }, create: { members: 'staff' } };
const notices = { mount: '/api/notices', schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 40 } } }, create: { members: 'staff' } };
const gated = { collections: { staff, bookings, notices } };

test('create.members: a non-member is 403 before anything is written, a member creates, and a removed member\'s retry is refused', async t => {
  const store = await direct(t, gated, { mounts: ['/api/bookings', '/api/notices'], principalMounts: ['/api/bookings'] });
  const declared = gated.collections as unknown as Record<string, CollectionSpec>;
  await addMember(store.database, { collections: declared, collection: 'staff', principal: 'rita' });
  const before = counts(store.database);
  const refused = await store.call('POST', '/api/bookings', { who: 'bob', body: { title: 'x' }, headers: { 'idempotency-key': 'k1' } });
  assert.equal(refused.status, 403); assert.equal(code(refused), 'membership_required');
  // The gate comes before the body is judged: an invalid body from a non-member is the same 403.
  assert.equal((await store.call('POST', '/api/bookings', { who: 'bob', body: { nope: 1 } })).status, 403);
  assert.deepEqual(counts(store.database), before, 'no record and no Idempotency-Key claim');
  // A shared collection's gate needs a principal: 401 without one, before anything is read.
  const anonymous = await store.call('POST', '/api/notices', { body: { title: 'x' } });
  assert.equal(anonymous.status, 401); assert.equal(code(anonymous), 'principal_required');
  assert.equal((await store.call('POST', '/api/notices', { who: 'bob', body: { title: 'x' } })).status, 403);
  assert.equal((await store.call('GET', '/api/notices')).status, 200, 'the gate is on create only: reading is the route\'s business');
  const created = await store.call('POST', '/api/bookings', { who: 'rita', body: { title: 'standup' }, headers: { 'idempotency-key': 'k2' } });
  assert.equal(created.status, 201);
  assert.equal((await store.call('POST', '/api/notices', { who: 'rita', body: { title: 'hello' } })).status, 201);
  // Other writes on the member's own record are unaffected by the gate, and so a non-member keeps its own records.
  assert.equal((await store.call('PATCH', `/api/bookings/${created.body!.id as string}`, { who: 'rita', body: { title: 'retro' } })).status, 200);
  await removeMember(store.database, { collections: declared, collection: 'staff', principal: 'rita' });
  const retried = await store.call('POST', '/api/bookings', { who: 'rita', body: { title: 'standup' }, headers: { 'idempotency-key': 'k2' } });
  assert.equal(retried.status, 403, 'the gate comes before the retained key: a removed member\'s retry is refused, not replayed');
  // Trusted code passes the same gate, by the principal it is given.
  await assert.rejects(store.exports.records('bookings').create({ id: 'rita' }, { title: 'x' }), (error: unknown) => error instanceof StoreError && error.status === 403);
  assert.throws(() => store.exports.transaction(tx => tx.records('notices').create(null, { title: 'x' })), (error: unknown) => error instanceof StoreError && error.status === 401);
  await addMember(store.database, { collections: declared, collection: 'staff', principal: 'sam' });
  assert.equal(store.exports.transaction(tx => tx.records('notices').create({ id: 'sam' }, { title: 'y' })).record.title, 'y');
});

test('activation refuses a create gate it cannot serve', async t => {
  assert.throws(() => normalize('m', { ...members, create: { members: 'staff' } } as unknown as CollectionSpec), /a membership collection takes no create/);
  assert.throws(() => normalize('n', { ...notices, readOnly: true } as unknown as CollectionSpec), /a readOnly one takes no create/);
  const store = await direct(t, { collections: { notices: { ...notices, create: { members: 'notices' } } } }, { mounts: ['/api/notices'] }).catch((error: unknown) => error);
  assert.match(String(store), /create: members names notices, which is not a membership collection/);
  const described = describeStore({ mount: '/api/bookings', config: gated, schemas: {} } as unknown as Parameters<typeof describeStore>[0])!;
  const post = (described.paths['/api/bookings'] as { post: { description: string; responses: Record<string, { description: string }> } }).post;
  assert.match(post.description, /Only a member of staff may create/);
  assert.match(post.responses['403']!.description, /membership_required/);
  assert.match(post.responses['401']!.description, /principal_required/);
});

// 3. A directory: find a recipient's wallet id by name without seeing any balance.
const walletSchema = { type: 'object', additionalProperties: false, required: ['name', 'balance'], properties: { name: { type: 'string', maxLength: 40 }, balance: { type: 'integer', minimum: -1_000_000 }, status: { type: 'string', enum: ['open', 'frozen'] } } };
const wallets = {
  mount: '/api/wallets', ownership: 'owner', schema: walletSchema, defaults: { balance: 0, status: 'open' }, readOnlyProperties: ['balance', 'status'],
  filterable: ['name', 'balance', 'status'], sortable: ['name', 'balance'],
  transfers: { pay: { amount: 'balance' }, issue: { amount: 'balance', min: -1_000_000, members: 'treasurers' } },
  transitions: { freeze: { from: { status: 'open' }, set: { status: 'frozen' } }, rename: { from: { name: 'unnamed' }, set: { name: 'renamed' } } },
  readers: { directory: { mount: '/api/directory', properties: ['name'] } },
};
const directory = { collections: { treasurers: { ...members }, wallets } };
const walletMounts = ['/api/wallets', '/api/directory'];

test('readers.properties: every signed-in principal finds a wallet id by name, and never sees a balance or when it moved', async t => {
  const store = await direct(t, directory, { mounts: walletMounts });
  await addMember(store.database, { collections: directory.collections as unknown as Record<string, CollectionSpec>, collection: 'treasurers', principal: 'tess' });
  const open = async (who: string, name: string) => (await store.call('POST', '/api/wallets', { who, body: { name } })).body!.id as string;
  const mint = await open('tess', 'mint'), ann = await open('ann', 'ann'), bob = await open('bob', 'bob');
  assert.equal((await store.call('POST', '/api/wallets/transfers/issue', { who: 'tess', body: { from: mint, to: ann, amount: 500 } })).status, 200);
  // Ann looks bob up by name: no membership needed, only a principal.
  assert.equal((await store.call('GET', '/api/directory?name=bob')).status, 401);
  const found = await store.call('GET', '/api/directory?name=bob', { who: 'ann' });
  assert.equal(found.status, 200);
  assert.deepEqual(found.body!.items, [{ id: bob, name: 'bob' }], 'id and the listed property only: no balance, status, createdAt or updatedAt');
  assert.equal(found.body!.total, 1);
  assert.equal((await store.call('POST', '/api/wallets/transfers/pay', { who: 'ann', body: { from: ann, to: bob, amount: 120 } })).status, 200);
  // Sorting or filtering by a hidden property would disclose it: both are 400, even though the collection declares them.
  for (const query of ['balance=0', 'sort=-balance', 'status=open']) {
    const refused = await store.call('GET', `/api/directory?${query}`, { who: 'ann' });
    assert.equal(refused.status, 400, query); assert.equal(code(refused), 'invalid_query');
  }
  const list = await store.call('GET', '/api/directory?sort=name', { who: 'bob' });
  assert.deepEqual((list.body!.items as { name: string }[]).map(item => Object.keys(item).sort().join()), ['id,name', 'id,name', 'id,name']);
  // may lists only transitions whose from names only shown properties: freeze (from a hidden status) never appears.
  assert.deepEqual(list.body!.may, { [ann]: [], [bob]: [], [mint]: [] });
  // The ETag is of the projection: a transfer (a hidden balance) does not move it; a shown change does.
  const one = await store.call('GET', `/api/directory/${bob}`, { who: 'ann' });
  assert.deepEqual(one.body, { id: bob, name: 'bob' });
  assert.equal(one.header('etag'), (list.body!.etags as Record<string, string>)[bob]);
  const own = await store.call('GET', `/api/wallets/${bob}`, { who: 'bob' });
  assert.notEqual(one.header('etag'), own.header('etag'), 'not the record\'s own ETag');
  assert.equal((await store.call('POST', '/api/wallets/transfers/pay', { who: 'ann', body: { from: ann, to: bob, amount: 1 } })).status, 200);
  assert.equal((await store.call('GET', `/api/directory/${bob}`, { who: 'ann' })).header('etag'), one.header('etag'), 'a balance moved and the directory cannot tell');
  assert.equal((await store.call('PATCH', `/api/wallets/${bob}`, { who: 'bob', body: { name: 'robert' } })).status, 200);
  assert.notEqual((await store.call('GET', `/api/directory/${bob}`, { who: 'ann' })).header('etag'), one.header('etag'));
  assert.equal((await store.call('POST', `/api/directory/${bob}`, { who: 'ann' })).status, 405, 'read-only');
});

test('a projection with members keeps the gate, shows the owner only with showOwner, and activation refuses an ungated whole-record mount', async t => {
  const gatedDirectory = { collections: { treasurers: { ...members }, wallets: { ...wallets, readers: { directory: { mount: '/api/directory', members: 'treasurers', properties: ['name', 'balance'], showOwner: true } } } } };
  const store = await direct(t, gatedDirectory, { mounts: walletMounts });
  const id = (await store.call('POST', '/api/wallets', { who: 'ann', body: { name: 'ann' } })).body!.id as string;
  assert.equal((await store.call('GET', '/api/directory', { who: 'bob' })).status, 403);
  await addMember(store.database, { collections: gatedDirectory.collections as unknown as Record<string, CollectionSpec>, collection: 'treasurers', principal: 'tess' });
  assert.deepEqual((await store.call('GET', `/api/directory/${id}`, { who: 'tess' })).body, { id, _owner: 'ann', name: 'ann', balance: 0 });
  assert.equal((await store.call('GET', '/api/directory?sort=-balance', { who: 'tess' })).status, 200, 'a shown property sorts');
  assert.throws(() => normalize('w', { ...wallets, readers: { directory: { mount: '/api/directory' } } } as unknown as CollectionSpec), /readers directory needs members, or properties/);
  assert.throws(() => normalize('w', { ...wallets, readers: { directory: { mount: '/api/directory', properties: ['nope'] } } } as unknown as CollectionSpec), /readers directory: properties names nope, which is not a declared property/);
});

test('OpenAPI describes the projection: id and the listed properties, the sorts and filters it takes, and no 403 without members', () => {
  const described = describeStore({ mount: '/api/directory', config: directory, schemas: {} } as unknown as Parameters<typeof describeStore>[0])!;
  const reader = described.schemas!.StoreWalletsDirectoryReaderRecord as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(Object.keys(reader.properties), ['id', 'name']);
  assert.deepEqual(reader.required, ['id', 'name']);
  const get = (described.paths['/api/directory'] as { get: { parameters: { name: string; schema: { enum?: string[] } }[]; responses: Record<string, unknown> } }).get;
  assert.deepEqual(get.parameters.map(parameter => parameter.name), ['limit', 'cursor', 'sort', 'name']);
  assert.deepEqual(get.parameters.find(parameter => parameter.name === 'sort')!.schema.enum, ['name', '-name']);
  assert.equal(get.responses['403'], undefined);
  const slotsDescribed = describeStore({ mount: '/api/slots', config: { collections: { slots } }, schemas: {} } as unknown as Parameters<typeof describeStore>[0])!;
  const invalid = ((slotsDescribed.paths['/api/slots'] as { post: { responses: Record<string, { description: string }> } }).post.responses['422']!).description;
  assert.match(invalid, /not exactly PT1H after its start/); assert.match(invalid, /whole multiple of PT1H from 1970-01-01T00:00:00Z/);
});
