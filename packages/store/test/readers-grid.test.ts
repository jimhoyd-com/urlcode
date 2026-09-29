// Two store follow-ups of #929:
// 1. #944 `readers` is a map of named mounts: one collection serves a projected directory every signed-in principal
//    searches and a members-gated reviewer mount showing whole records, each with its own gate, view, query rules and
//    ETag, and each described as its own OpenAPI path.
// 2. #945 `intervals.origin`: the `step` grid counts from a declared instant (a fixed offset such as UTC+05:30) or
//    integer instead of the epoch or 0, exactly, on every write path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, addMember, normalize } from '../src/index.ts';
import type { CollectionSpec } from '../src/index.ts';
import { describeStore } from '../src/openapi.ts';
import { direct } from './direct.ts';
import type { Answer } from './direct.ts';

const code = (answer: Answer) => (answer.body?.error as { code?: string } | undefined)?.code;
const issues = (answer: Answer) => (answer.body!.error as { issues: { pointer: string; message: string }[] }).issues.map(issue => `${issue.pointer} ${issue.message}`);
const members = { membership: true, key: 'userId', schema: { type: 'object', additionalProperties: false, required: ['userId'], properties: { userId: { type: 'string', maxLength: 128 } } } };
const describe = (mount: string, config: unknown) => describeStore({ mount, config, schemas: {} } as unknown as Parameters<typeof describeStore>[0])!;

// 1. Several readers mounts on one collection.
const walletSchema = { type: 'object', additionalProperties: false, required: ['name', 'balance'], properties: { name: { type: 'string', maxLength: 40 }, balance: { type: 'integer', minimum: -1_000_000 }, status: { type: 'string', enum: ['open', 'frozen'] } } };
const wallets = {
  mount: '/api/wallets', ownership: 'owner', schema: walletSchema, defaults: { balance: 0, status: 'open' }, readOnlyProperties: ['balance', 'status'],
  filterable: ['name', 'status'], sortable: ['name', 'balance'],
  transfers: { pay: { amount: 'balance' }, issue: { amount: 'balance', min: -1_000_000, members: 'treasurers' } },
  transitions: { freeze: { from: { status: 'open' }, set: { status: 'frozen' } } },
  readers: {
    directory: { mount: '/api/directory', properties: ['name'] },
    audit: { mount: '/api/audit', members: 'treasurers', showOwner: true },
  },
};
const config = { collections: { treasurers: { ...members }, wallets } };
const mounts = ['/api/wallets', '/api/directory', '/api/audit'];

test('readers: a directory and a treasurers\' audit mount on one collection, each with its own gate, view, query and ETag', async t => {
  const store = await direct(t, config, { mounts });
  await addMember(store.database, { collections: config.collections as unknown as Record<string, CollectionSpec>, collection: 'treasurers', principal: 'tess' });
  const open = async (who: string, name: string) => (await store.call('POST', '/api/wallets', { who, body: { name } })).body!.id as string;
  const mint = await open('tess', 'mint'), ann = await open('ann', 'ann');
  assert.equal((await store.call('POST', '/api/wallets/transfers/issue', { who: 'tess', body: { from: mint, to: ann, amount: 300 } })).status, 200);
  // Ann finds a name on the directory, but is not a treasurer: the audit mount is 403 before anything is read.
  assert.deepEqual((await store.call('GET', '/api/directory?name=mint', { who: 'ann' })).body!.items, [{ id: mint, name: 'mint' }]);
  for (const path of ['/api/audit', `/api/audit/${ann}`, '/api/audit/not-an-id']) {
    const refused = await store.call('GET', path, { who: 'ann' });
    assert.equal(refused.status, 403, path); assert.equal(code(refused), 'membership_required');
  }
  // Tess audits whole records, with owners, sorted by the balance the directory never shows.
  const audit = await store.call('GET', '/api/audit?sort=-balance', { who: 'tess' });
  assert.equal(audit.status, 200);
  assert.deepEqual((audit.body!.items as Record<string, unknown>[]).map(item => [item.name, item._owner, item.balance, typeof item.updatedAt]), [['ann', 'ann', 300, 'string'], ['mint', 'tess', -300, 'string']]);
  assert.deepEqual(audit.body!.may, { [ann]: [], [mint]: ['freeze'] }, 'the whole-record mount offers what the caller may run');
  const hidden = await store.call('GET', '/api/directory?sort=-balance', { who: 'tess' });
  assert.equal(hidden.status, 400, 'the directory keeps its projection rules for a treasurer too'); assert.equal(code(hidden), 'invalid_query');
  assert.deepEqual((await store.call('GET', '/api/directory?name=mint', { who: 'tess' })).body!.may, { [mint]: [] }, 'freeze reads a hidden status');
  // The audit mount answers the record's own ETag; the directory, an ETag of the projection.
  const own = (await store.call('GET', `/api/wallets/${ann}`, { who: 'ann' })).header('etag');
  assert.equal((await store.call('GET', `/api/audit/${ann}`, { who: 'tess' })).header('etag'), own);
  assert.equal((audit.body!.etags as Record<string, string>)[ann], own);
  const listed = (await store.call('GET', `/api/directory/${ann}`, { who: 'tess' }));
  assert.deepEqual(listed.body, { id: ann, name: 'ann' });
  assert.notEqual(listed.header('etag'), own);
  assert.equal((await store.call('DELETE', `/api/audit/${ann}`, { who: 'tess' })).status, 405, 'read-only');
});

test('activation refuses readers mounts it cannot serve apart, and names the mount', async t => {
  const refuse = (readers: Record<string, unknown>, message: RegExp) => assert.throws(() => normalize('wallets', { ...wallets, readers } as unknown as CollectionSpec), message);
  refuse({ a: { mount: '/api/directory', properties: ['name'] }, b: { mount: '/api/directory', members: 'treasurers' } }, /readers b: its mount is also readers a's/);
  refuse({ a: { mount: '/api/wallets', members: 'treasurers' } }, /readers a: its mount must differ from the collection mount/);
  refuse({ directory: wallets.readers.directory, open: { mount: '/api/open' } }, /readers open needs members, or properties/);
  refuse({ directory: { mount: '/api/directory', properties: ['secret'] } }, /readers directory: properties names secret/);
  assert.throws(() => normalize('t', { ...members, readers: wallets.readers } as unknown as CollectionSpec), /a membership collection takes no readers/);
  const failed = (collections: Record<string, unknown>, served: string[]) => direct(t, { collections }, { mounts: served }).then(() => undefined, (error: unknown) => String(error));
  assert.match((await failed({ ...config.collections, wallets: { ...wallets, readers: { ...wallets.readers, audit: { ...wallets.readers.audit, members: 'wallets' } } } }, mounts))!, /readers audit: members names wallets, which is not a membership collection/);
  assert.match((await failed(config.collections, ['/api/wallets', '/api/directory']))!, /readers audit: route \/api\/audit\/\* with extension: store is not declared/);
  // Another collection's readers mount is another store mount.
  const other = { mount: '/api/other', ownership: 'owner', schema: walletSchema, readers: { mine: { mount: '/api/audit', members: 'treasurers' } } };
  assert.match((await failed({ ...config.collections, other }, [...mounts, '/api/other']))!, /readers (audit|mine): mount \/api\/audit conflicts with another store mount/);
});

test('OpenAPI: one path per readers mount, each with its own record shape, query and gate', () => {
  const directory = describe('/api/directory', config), audit = describe('/api/audit', config);
  assert.deepEqual(Object.keys(directory.paths), ['/api/directory', '/api/directory/{id}']);
  assert.deepEqual(Object.keys(audit.paths), ['/api/audit', '/api/audit/{id}']);
  const shown = directory.schemas!.StoreWalletsDirectoryReaderRecord as { properties: Record<string, unknown> };
  const whole = audit.schemas!.StoreWalletsAuditReaderRecord as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(Object.keys(shown.properties), ['id', 'name']);
  assert.ok(['_owner', 'balance', 'updatedAt'].every(field => Object.hasOwn(whole.properties, field))); assert.ok(whole.required.includes('_owner'));
  type Get = { get: { parameters: { name: string; schema: { enum?: string[] } }[]; responses: Record<string, unknown> } };
  const list = (described: typeof audit, path: string) => (described.paths[path] as Get).get;
  assert.deepEqual(list(directory, '/api/directory').parameters.find(parameter => parameter.name === 'sort')!.schema.enum, ['name', '-name']);
  assert.deepEqual(list(audit, '/api/audit').parameters.find(parameter => parameter.name === 'sort')!.schema.enum, ['name', '-name', 'balance', '-balance']);
  assert.equal(list(directory, '/api/directory').responses['403'], undefined);
  assert.ok(list(audit, '/api/audit').responses['403']);
  // A reviewer mount with neither a projection nor showOwner answers the owner mount's own shapes.
  const plain = describe('/api/audit', { collections: { ...config.collections, wallets: { ...wallets, readers: { audit: { mount: '/api/audit', members: 'treasurers' } } } } });
  assert.deepEqual(Object.keys(plain.schemas!).filter(name => name.includes('Reader')), []);
});

test('the declaration fingerprint covers every readers mount, and not how the map was written', () => {
  const fingerprint = (readers: Record<string, unknown>) => new Collection('wallets', { ...wallets, readers } as unknown as CollectionSpec).fingerprint;
  const both = fingerprint(wallets.readers);
  assert.equal(both, fingerprint({ audit: wallets.readers.audit, directory: wallets.readers.directory }), 'key order does not matter');
  assert.notEqual(both, fingerprint({ directory: wallets.readers.directory }));
  assert.notEqual(both, fingerprint({ directory: wallets.readers.directory, review: wallets.readers.audit }), 'a renamed mount is a changed declaration');
  assert.notEqual(both, fingerprint({ ...wallets.readers, audit: { ...wallets.readers.audit, showOwner: false } }));
});

// 2. A step grid with an origin.
const at = (time: string) => `2026-10-01T${time}Z`;
const slotSchema = { type: 'object', additionalProperties: false, required: ['room', 'start', 'end'], properties: { room: { type: 'string', maxLength: 20 }, start: { type: 'string', format: 'date-time', maxLength: 40 }, end: { type: 'string', format: 'date-time', maxLength: 40 } } };
// A clinic at UTC+05:30: hour slots on the local hour, so :30 past in UTC.
const slots = { mount: '/api/slots', schema: slotSchema, intervals: { start: 'start', end: 'end', within: ['room'], length: 'PT1H', step: 'PT1H', origin: '1970-01-01T00:00:00+05:30' } };
// Whole local days at the same offset: local midnight is 18:30Z the day before.
const days = { mount: '/api/days', schema: slotSchema, intervals: { start: 'start', end: 'end', within: ['room'], step: 'P1D', origin: '2026-01-01T00:00:00+05:30' } };
const shiftSchema = { type: 'object', additionalProperties: false, required: ['start', 'end'], properties: { start: { type: 'integer' }, end: { type: 'integer' } } };
const shifts = { mount: '/api/shifts', schema: shiftSchema, intervals: { start: 'start', end: 'end', step: 15, origin: 5 } };
const grids = { collections: { slots, days, shifts } };

test('intervals.origin: a fixed-offset grid (UTC+05:30) on the local hour and local midnight, and an integer grid from 5', async t => {
  const store = await direct(t, grids, { mounts: ['/api/slots', '/api/days', '/api/shifts'] });
  const post = (mount: string, body: Record<string, unknown>) => store.call('POST', mount, { body: { room: 'a', ...body } });
  assert.equal((await post('/api/slots', { start: at('03:30:00'), end: at('04:30:00') })).status, 201, '09:00 to 10:00 local');
  const utcHour = await post('/api/slots', { start: at('05:00:00'), end: at('06:00:00') });
  assert.equal(utcHour.status, 422); assert.equal(code(utcHour), 'invalid_record');
  assert.deepEqual(issues(utcHour), ['/start must be a whole multiple of PT1H from 1970-01-01T00:00:00+05:30', '/end must be a whole multiple of PT1H from 1970-01-01T00:00:00+05:30']);
  assert.equal((await post('/api/days', { start: '2026-09-30T18:30:00Z', end: '2026-10-02T18:30:00Z' })).status, 201, 'two local days');
  assert.deepEqual(issues(await post('/api/days', { start: at('00:00:00'), end: '2026-10-02T00:00:00Z' })), ['/start must be a whole multiple of P1D from 2026-01-01T00:00:00+05:30', '/end must be a whole multiple of P1D from 2026-01-01T00:00:00+05:30'], 'UTC midnight is not local midnight');
  // Integer bounds: 5, 20, 35 ... and, below zero, -10.
  assert.equal((await store.call('POST', '/api/shifts', { body: { start: 20, end: 50 } })).status, 201);
  assert.equal((await store.call('POST', '/api/shifts', { body: { start: -10, end: 5 } })).status, 201, 'the grid runs below its origin too');
  assert.deepEqual(issues(await store.call('POST', '/api/shifts', { body: { start: 60, end: 90 } })), ['/start must be a whole multiple of 15 from 5', '/end must be a whole multiple of 15 from 5']);
  // PATCH is judged on the record as it leaves it, and a host transaction by the same rule.
  const id = (await post('/api/slots', { start: at('05:30:00'), end: at('06:30:00') })).body!.id as string;
  assert.equal((await store.call('PATCH', `/api/slots/${id}`, { body: { start: at('07:00:00'), end: at('08:00:00') } })).status, 422);
  assert.equal((await store.call('PATCH', `/api/slots/${id}`, { body: { start: at('07:30:00'), end: at('08:30:00') } })).status, 200);
});

test('intervals.origin keeps the arithmetic exact at the ends of the safe integers', () => {
  const edge = normalize('e', { ...shifts, intervals: { start: 'start', end: 'end', step: 2, origin: -Number.MAX_SAFE_INTEGER } } as unknown as CollectionSpec).intervals!;
  assert.deepEqual(edge.origin, { declared: -Number.MAX_SAFE_INTEGER, residue: 1 }, 'an odd origin puts the grid on the odd integers');
  const offset = normalize('o', slots as unknown as CollectionSpec).intervals!;
  assert.deepEqual(offset.origin, { declared: '1970-01-01T00:00:00+05:30', residue: 1_800_000 });
});

test('activation refuses an origin it cannot count from, and the declaration fingerprint and OpenAPI carry it', () => {
  const refuse = (intervals: Record<string, unknown>, message: RegExp, base: { intervals: Record<string, unknown> } = slots) => assert.throws(() => normalize('c', { ...base, intervals: { ...base.intervals, ...intervals } } as unknown as CollectionSpec), message);
  refuse({ step: undefined, length: undefined }, /origin needs step/);
  for (const origin of ['2026-02-30T00:00:00Z', '2026-10-01T24:00:00Z', '1970-01-01T00:00:00+24:00', '1970-01-01T00:00:00+05:60', '1970-01-01T00:00:00.0001Z', '1970-01-01', 0]) refuse({ origin }, /origin must be an RFC 3339 date-time with Z or a fixed offset/);
  for (const origin of ['1970-01-01T00:00:00Z', 1.5, Number.MAX_SAFE_INTEGER + 1]) refuse({ origin }, /origin must be an integer for integer bounds/, shifts);
  assert.equal(normalize('c', { ...slots, intervals: { ...slots.intervals, origin: '1969-12-31T18:30:00-05:30' } } as unknown as CollectionSpec).intervals!.origin!.residue, 0, 'a negative offset');
  const fingerprint = (origin: unknown) => new Collection('c', { ...slots, intervals: { ...slots.intervals, origin } } as unknown as CollectionSpec).fingerprint;
  assert.notEqual(fingerprint(undefined), fingerprint('1970-01-01T00:00:00+05:30'));
  assert.notEqual(fingerprint('1970-01-01T00:00:00+05:30'), fingerprint('1970-01-01T00:00:00+05:45'));
  const invalid = ((describe('/api/slots', grids).paths['/api/slots'] as { post: { responses: Record<string, { description: string }> } }).post.responses['422']!).description;
  assert.match(invalid, /whole multiple of PT1H from 1970-01-01T00:00:00\+05:30/);
});

test('#972: showOwner needs members on every named readers mount, so only members ever receive an owner\'s principal id', async t => {
  const readers = (directory: Record<string, unknown>) => ({ ...wallets, readers: { ...wallets.readers, directory: { mount: '/api/directory', properties: ['name'], ...directory } } }) as unknown as CollectionSpec;
  // The review's reproduction: a projected directory without a gate. A gated sibling mount does not lend it one.
  assert.throws(() => normalize('wallets', readers({ showOwner: true })), /readers directory: showOwner needs members; without a gate every signed-in principal would receive every owner's principal id/);
  assert.throws(() => normalize('wallets', { ...wallets, readers: { directory: { mount: '/api/directory', properties: ['name'], showOwner: true } } } as unknown as CollectionSpec), /showOwner needs members/);
  await assert.rejects(direct(t, { collections: { treasurers: { ...members }, wallets: readers({ showOwner: true }) } }, { mounts }), /showOwner needs members/);
  // showOwner: false is the default and stays accepted; with members the mount may show owners.
  assert.equal(normalize('wallets', readers({ showOwner: false })).readers.directory!.showOwner, false);
  assert.equal(normalize('wallets', readers({ showOwner: true, members: 'treasurers' })).readers.directory!.showOwner, true);
  // Every accepted mount that shows owners is gated.
  const store = await direct(t, config, { mounts });
  const id = (await store.call('POST', '/api/wallets', { who: 'bob', body: { name: 'bob' } })).body!.id as string;
  assert.equal(JSON.stringify((await store.call('GET', '/api/directory', { who: 'eve' })).body).includes('_owner'), false);
  assert.equal((await store.call('GET', `/api/audit/${id}`, { who: 'eve' })).status, 403);
});
