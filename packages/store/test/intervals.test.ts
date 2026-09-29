// The declarative non-overlap constraint (#902 item 1): `intervals` refuses a write whose half-open [start, end)
// interval overlaps another record's in its scope, inside the write's transaction and through an index. Proved for
// adjacency, moves that keep their old slot, transitions (a cancelled booking frees its slot), owned-collection
// privacy (another owner's booking blocks without being named), rollback, races in one process and across
// connections, activation over stored overlaps, the operator's reassign, and the UTC date-time rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore, normalize, reassignOwner } from '../src/index.ts';
import type { CollectionSpec } from '../src/index.ts';
import { describeStore } from '../src/openapi.ts';
import { direct, pin, race } from './direct.ts';
import { counts, execute, records, seed } from './rows.ts';

const hour = (h: number, suffix = ':00:00Z') => `2026-10-01T${String(h).padStart(2, '0')}${suffix}`;
const rooms = {
  mount: '/api/rooms', idempotency: { maxKeys: 100 },
  schema: { type: 'object', additionalProperties: false, required: ['room', 'start', 'end'], properties: { room: { type: 'string', maxLength: 20 }, start: { type: 'string', format: 'date-time', maxLength: 40 }, end: { type: 'string', format: 'date-time', maxLength: 40 }, status: { type: 'string', enum: ['booked', 'cancelled'] }, note: { type: 'string', maxLength: 40 } } },
  defaults: { status: 'booked' }, readOnlyProperties: ['status'],
  intervals: { start: 'start', end: 'end', within: ['room'], when: { status: 'booked' } },
  transitions: { cancel: { from: { status: 'booked' }, set: { status: 'cancelled' } }, reopen: { from: { status: 'cancelled' }, set: { status: 'booked' } } },
};
const slots = { type: 'object', additionalProperties: false, required: ['desk', 'start', 'end'], properties: { desk: { type: 'string', maxLength: 20 }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 } } };
const desks = { mount: '/api/desks', ownership: 'owner', schema: slots, intervals: { start: 'start', end: 'end', within: ['desk'] } };
const diaries = { mount: '/api/diaries', ownership: 'owner', schema: slots, intervals: { start: 'start', end: 'end', scope: 'owner' } };
const config = { collections: { rooms, desks, diaries } };
const mounts = ['/api/rooms', '/api/desks', '/api/diaries'];
const code = (answer: { body: Record<string, unknown> | undefined }) => (answer.body?.error as { code?: string } | undefined)?.code;

test('adjacent intervals are allowed, overlapping ones are 409 interval_conflict naming the record, other rooms are independent', async t => {
  const store = await direct(t, config, { mounts, principalMounts: ['/api/desks', '/api/diaries'] });
  const nine = await store.call('POST', '/api/rooms', { body: { room: 'a', start: hour(9), end: hour(10) } });
  assert.equal(nine.status, 201);
  // Half-open: [9, 10) and [10, 11) share only the instant 10:00, which belongs to the second. The same instant
  // written with milliseconds compares equal.
  assert.equal((await store.call('POST', '/api/rooms', { body: { room: 'a', start: hour(10, ':00:00.000Z'), end: hour(11) } })).status, 201);
  assert.equal((await store.call('POST', '/api/rooms', { body: { room: 'a', start: hour(8), end: hour(9) } })).status, 201);
  const before = counts(store.database);
  for (const [start, end] of [[hour(9, ':30:00Z'), hour(9, ':45:00Z')], [hour(7), hour(12)], [hour(9, ':59:59.999Z'), hour(10, ':30:00Z')], [hour(8, ':00:00.001Z'), hour(8, ':00:00.002Z')]] as const) {
    const refused = await store.call('POST', '/api/rooms', { body: { room: 'a', start, end }, headers: { 'idempotency-key': `k-${start}` } });
    assert.equal(refused.status, 409, `${start} to ${end}`); assert.equal(code(refused), 'interval_conflict');
    assert.equal(typeof (refused.body!.error as { conflict?: { id?: string } }).conflict?.id, 'string', 'a shared collection names the conflicting record');
  }
  const named = await store.call('POST', '/api/rooms', { body: { room: 'a', start: hour(9, ':15:00Z'), end: hour(9, ':20:00Z') } });
  assert.deepEqual((named.body!.error as { conflict: unknown }).conflict, { id: nine.body!.id });
  assert.deepEqual(counts(store.database), before, 'a refusal writes nothing, not even an Idempotency-Key claim');
  assert.equal((await store.call('POST', '/api/rooms', { body: { room: 'b', start: hour(9), end: hour(10) } })).status, 201, 'another room is another scope');
});

test('bounds are UTC date-times with at most millisecond precision, and end must be after start (422)', async t => {
  const store = await direct(t, config, { mounts, principalMounts: ['/api/desks', '/api/diaries'] });
  const issues = async (start: string, end: string) => { const answer = await store.call('POST', '/api/rooms', { body: { room: 'a', start, end } }); assert.equal(answer.status, 422, `${start} ${end}`); return (answer.body!.error as { issues: { pointer: string; keyword: string }[] }).issues.map(issue => `${issue.pointer} ${issue.keyword}`); };
  assert.deepEqual(await issues(hour(10), hour(10)), ['/end intervals']);
  assert.deepEqual(await issues(hour(11), hour(10)), ['/end intervals']);
  assert.deepEqual(await issues('2026-10-01T10:00:00+01:00', hour(12)), ['/start intervals'], 'an offset is refused: compare in UTC, write Z');
  assert.deepEqual(await issues(hour(9), '2026-10-01T10:00:00.0001Z'), ['/end intervals'], 'sub-millisecond precision is refused');
  assert.deepEqual(await issues(hour(9), '2026-10-01t10:00:00z'), ['/end intervals'], 'lower-case t and z are refused');
  assert.equal(records(store.database, 'rooms').length, 0);
  const numeric = await store.call('POST', '/api/desks', { who: 'ann', body: { desk: 'd', start: 5, end: 5 } });
  assert.equal(numeric.status, 422); assert.equal(code(numeric), 'invalid_record');
});

test('a move that would overlap is refused and keeps its old slot; a move over its own old slot is allowed', async t => {
  const store = await direct(t, config, { mounts, principalMounts: ['/api/desks', '/api/diaries'] });
  const nine = await store.call('POST', '/api/rooms', { body: { room: 'a', start: hour(9), end: hour(10) } });
  const ten = await store.call('POST', '/api/rooms', { body: { room: 'a', start: hour(10), end: hour(11) } });
  const id = ten.body!.id as string;
  for (const [method, body] of [['PATCH', { start: hour(9, ':30:00Z') }], ['PUT', { room: 'a', start: hour(9, ':30:00Z'), end: hour(10, ':30:00Z') }]] as const) {
    const moved = await store.call(method, `/api/rooms/${id}`, { body, headers: { 'if-match': ten.header('etag')! } });
    assert.equal(moved.status, 409, method); assert.equal(code(moved), 'interval_conflict');
    const kept = await store.call('GET', `/api/rooms/${id}`);
    assert.deepEqual([kept.body!.start, kept.body!.end, kept.header('etag')], [hour(10), hour(11), ten.header('etag')], 'the record keeps its old slot and revision');
  }
  // Overlapping its own current interval is not a conflict: the record itself is excluded.
  const shifted = await store.call('PATCH', `/api/rooms/${id}`, { body: { start: hour(10, ':30:00Z'), end: hour(11, ':30:00Z') }, headers: { 'if-match': ten.header('etag')! } });
  assert.equal(shifted.status, 200);
  // A change that leaves the interval alone still passes through the check and is accepted.
  assert.equal((await store.call('PATCH', `/api/rooms/${nine.body!.id as string}`, { body: { note: 'standup' } })).status, 200);
  // The slot the move left is free again.
  assert.equal((await store.call('POST', '/api/rooms', { body: { room: 'a', start: hour(10), end: hour(10, ':30:00Z') } })).status, 201);
});

test('only records holding the when values take part: cancelling frees the slot, and reopening into a taken slot is refused', async t => {
  const store = await direct(t, config, { mounts, principalMounts: ['/api/desks', '/api/diaries'] });
  const first = await store.call('POST', '/api/rooms', { body: { room: 'a', start: hour(9), end: hour(10) } });
  const id = first.body!.id as string;
  assert.equal((await store.call('POST', '/api/rooms', { body: { room: 'a', start: hour(9), end: hour(10) } })).status, 409);
  assert.equal((await store.call('POST', `/api/rooms/${id}/cancel`)).status, 200);
  const second = await store.call('POST', '/api/rooms', { body: { room: 'a', start: hour(9), end: hour(10) } });
  assert.equal(second.status, 201, 'a cancelled booking no longer holds its slot');
  const reopened = await store.call('POST', `/api/rooms/${id}/reopen`);
  assert.equal(reopened.status, 409); assert.equal(code(reopened), 'interval_conflict');
  assert.deepEqual((reopened.body!.error as { conflict: unknown }).conflict, { id: second.body!.id });
  assert.equal((await store.call('GET', `/api/rooms/${id}`)).body!.status, 'cancelled', 'the refused transition changed nothing');
  assert.equal((await store.call('POST', `/api/rooms/${second.body!.id as string}/cancel`)).status, 200);
  assert.equal((await store.call('POST', `/api/rooms/${id}/reopen`)).status, 200, 'once the slot is free again the transition applies');
});

test('owned collections: another owner\'s booking blocks the slot without being named; scope: owner constrains each owner alone', async t => {
  const store = await direct(t, config, { mounts, principalMounts: ['/api/desks', '/api/diaries'] });
  const ann = await store.call('POST', '/api/desks', { who: 'ann', body: { desk: 'd1', start: 10, end: 20 } });
  const bob = await store.call('POST', '/api/desks', { who: 'bob', body: { desk: 'd1', start: 15, end: 25 } });
  assert.equal(bob.status, 409); assert.equal(code(bob), 'interval_conflict');
  assert.equal((bob.body!.error as { conflict?: unknown }).conflict, undefined, 'bob cannot read ann\'s booking, so it is not named');
  assert.ok(!JSON.stringify(bob.body).includes(ann.body!.id as string));
  const own = await store.call('POST', '/api/desks', { who: 'ann', body: { desk: 'd1', start: 15, end: 25 } });
  assert.deepEqual((own.body!.error as { conflict: unknown }).conflict, { id: ann.body!.id }, 'ann may read her own booking, so it is named');
  // Through a host transaction the same rule applies to the principal passed.
  assert.throws(() => store.exports.transaction(tx => tx.records('desks').create({ id: 'bob' }, { desk: 'd1', start: 12, end: 13 })), (error: unknown) => (error as { code?: string; conflict?: unknown }).code === 'interval_conflict' && (error as { conflict?: unknown }).conflict === undefined);
  assert.equal((await store.call('POST', '/api/desks', { who: 'bob', body: { desk: 'd1', start: 20, end: 25 } })).status, 201);
  // scope: owner, and no within: each owner's diary is its own timeline.
  assert.equal((await store.call('POST', '/api/diaries', { who: 'ann', body: { desk: 'x', start: 1, end: 5 } })).status, 201);
  assert.equal((await store.call('POST', '/api/diaries', { who: 'bob', body: { desk: 'y', start: 1, end: 5 } })).status, 201, 'another owner\'s interval never conflicts');
  assert.equal((await store.call('POST', '/api/diaries', { who: 'ann', body: { desk: 'z', start: 4, end: 6 } })).status, 409, 'ann\'s own intervals still may not overlap, in any desk');
});

test('the operator\'s reassign refuses a move that would give the target overlapping intervals under scope: owner', async t => {
  const store = await direct(t, config, { mounts, principalMounts: ['/api/desks', '/api/diaries'] });
  await store.call('POST', '/api/diaries', { who: 'ann', body: { desk: 'x', start: 1, end: 5 } });
  await store.call('POST', '/api/diaries', { who: 'bob', body: { desk: 'x', start: 3, end: 8 } });
  const before = records(store.database, 'diaries');
  for (const dryRun of [true, false]) await assert.rejects(reassignOwner(store.database, { from: 'ann', to: 'bob', collections: config.collections as Record<string, CollectionSpec>, dryRun }), /Nothing was moved: collection diaries would give bob records .* whose intervals overlap/);
  assert.deepEqual(records(store.database, 'diaries'), before);
  assert.equal((await reassignOwner(store.database, { from: 'ann', to: 'cy', collections: config.collections as Record<string, CollectionSpec> })).moved, 1, 'a principal with no overlapping interval takes them');
});

test('a failure after the check rolls everything back and the slot stays free', async t => {
  const store = await direct(t, config, { mounts, principalMounts: ['/api/desks', '/api/diaries'] });
  execute(store.database, "CREATE TRIGGER fail_insert BEFORE INSERT ON store_records WHEN NEW.collection = 'rooms' BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  const failed = await store.call('POST', '/api/rooms', { body: { room: 'a', start: hour(9), end: hour(10) }, headers: { 'idempotency-key': 'once' } });
  assert.equal(failed.status, 503);
  assert.deepEqual(counts(store.database), { records: 0, idempotency: 0, outbox: 0 });
  execute(store.database, 'DROP TRIGGER fail_insert');
  assert.equal((await store.call('POST', '/api/rooms', { body: { room: 'a', start: hour(9), end: hour(10) }, headers: { 'idempotency-key': 'once' } })).status, 201, 'the retry finds the slot free');
  // A host transaction that books and then fails leaves nothing behind either.
  assert.throws(() => store.exports.transaction(tx => { tx.records('rooms').create(null, { room: 'b', start: hour(9), end: hour(10) }); throw new Error('later step failed'); }), /later step failed/);
  assert.equal((await store.call('POST', '/api/rooms', { body: { room: 'b', start: hour(9), end: hour(10) } })).status, 201);
});

test('racing overlapping bookings: exactly one commits, in one process and across connections', async t => {
  const store = await direct(t, config, { mounts, principalMounts: ['/api/desks', '/api/diaries'] });
  const local = await Promise.all(Array.from({ length: 12 }, (_, index) => store.call('POST', '/api/desks', { who: `p${index % 3}`, body: { desk: 'hot', start: 100 + index, end: 200 } })));
  assert.equal(local.filter(answer => answer.status === 201).length, 1);
  assert.ok(local.every(answer => answer.status === 201 || code(answer) === 'interval_conflict'));
  await store.close();
  // Four threads, each its own connection as a second process would have, book overlapping slots at once.
  const racers = Array.from({ length: 4 }, (_, worker) => Array.from({ length: 3 }, (_, index) => ({ method: 'POST', path: '/api/desks', init: { who: `w${worker}`, body: { desk: 'cold', start: 10 * index + worker, end: 10 * index + worker + 15 } } })));
  const answers = (await race(t, store.database, config, store.activation, racers)).flat();
  assert.ok(answers.every(answer => answer.status === 201 || answer.status === 409), JSON.stringify(answers.map(answer => answer.status)));
  const kept = records(store.database, 'desks').filter(record => record.desk === 'cold').sort((a, b) => (a.start as number) - (b.start as number));
  assert.equal(kept.length, answers.filter(answer => answer.status === 201).length);
  assert.ok(kept.length >= 1);
  for (let index = 1; index < kept.length; index++) assert.ok((kept[index - 1]!.end as number) <= (kept[index]!.start as number), 'no two committed bookings overlap');
});

test('activation refuses stored records that overlap or break the interval rules, and reads through its index', async t => {
  const store = await direct(t, config, { mounts, principalMounts: ['/api/desks', '/api/diaries'] });
  await store.close();
  const at = '2026-10-01T00:00:00.000Z';
  const row = (id: string, fields: Record<string, unknown>) => ({ id: `00000000-0000-4000-8000-00000000000${id}`, createdAt: at, updatedAt: at, ...fields });
  await seed(store.database, 'rooms', [row('1', { room: 'a', start: hour(9), end: hour(10), status: 'booked' }), row('2', { room: 'a', start: hour(9, ':30:00Z'), end: hour(11), status: 'cancelled' })]);
  await store.open();
  // The index covers only the booked rows (the when filter) and the check's query uses it: never a scan of the collection.
  const spec = normalize('rooms', rooms as unknown as CollectionSpec).intervals!;
  const db = new DatabaseSync(store.database);
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name GLOB 'store_intervals_*' ORDER BY name").all().map(entry => entry.name).includes(spec.index), true);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${spec.latest}`).all('a', 0, 'x').map(step => String(step.detail));
    assert.ok(plan.some(detail => detail.includes(`USING INDEX ${spec.index}`)), plan.join('; '));
    assert.ok(!plan.some(detail => detail.includes('TEMP B-TREE')), 'the order comes from the index');
  } finally { db.close(); }
  await store.close();
  execute(store.database, "UPDATE store_records SET data = json_set(data, '$.status', 'booked') WHERE id LIKE '%2'");
  await assert.rejects(store.open(), /records 00000000-0000-4000-8000-000000000001 and 00000000-0000-4000-8000-000000000002 hold overlapping intervals/);
  execute(store.database, "UPDATE store_records SET data = json_set(data, '$.start', '2026-10-01T12:00:00+02:00') WHERE id LIKE '%2'");
  await assert.rejects(store.open(), /record 00000000-0000-4000-8000-000000000002 holds an interval that intervals refuses/);
});

test('a changed or removed declaration drops the index nobody declares any more', async t => {
  const store = await direct(t, config, { mounts, principalMounts: ['/api/desks', '/api/diaries'] });
  await store.close();
  const indexes = () => { const db = new DatabaseSync(store.database); try { return db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name GLOB 'store_intervals_*' ORDER BY name").all().map(entry => String(entry.name)); } finally { db.close(); } };
  assert.equal(indexes().length, 3);
  const { intervals: _dropped, ...plain } = desks;
  const running = createStore({ database: store.database, projectSha256: pin });
  const instance = await running.registration.activate({ collections: { rooms, desks: plain, diaries: { ...diaries, intervals: { ...diaries.intervals, scope: 'collection' } } } }, store.activation);
  try { assert.deepEqual(indexes().sort(), [normalize('rooms', rooms as unknown as CollectionSpec).intervals!.index, normalize('diaries', { ...diaries, intervals: { ...diaries.intervals, scope: 'collection' } } as unknown as CollectionSpec).intervals!.index].sort()); }
  finally { await instance.close?.(); await running.close(); }
});

test('declarations the constraint cannot enforce are refused at activation', () => {
  const refuse = (spec: Record<string, unknown>, message: RegExp) => assert.throws(() => normalize('c', { ...desks, ...spec } as unknown as CollectionSpec), message);
  const optional = { ...slots, required: ['desk'] };
  refuse({ schema: optional }, /intervals: start must be required/);
  refuse({ schema: { ...slots, properties: { ...slots.properties, start: { type: 'string', maxLength: 30 } } } }, /start must be a string with format: date-time, an integer or a number/);
  refuse({ schema: { ...slots, properties: { ...slots.properties, end: { type: 'string', format: 'date-time' } } } }, /start and end must both be date-times or both be numbers/);
  refuse({ intervals: { start: 'start', end: 'start' } }, /start and end must be different properties/);
  refuse({ intervals: { start: 'start', end: 'end', within: ['nope'] } }, /nope is not a declared property/);
  refuse({ intervals: { start: 'start', end: 'end', within: ['end'] } }, /within cannot name start or end/);
  refuse({ ownership: 'shared', intervals: { start: 'start', end: 'end', scope: 'owner' } }, /scope: owner needs ownership: owner/);
  refuse({ schema: slots, defaults: { start: 0 }, increments: ['start'] }, /start is an increment property/);
  refuse({ intervals: { start: 'start', end: 'end', when: { desk: 'x'.repeat(30) } } }, /when value for desk/);
  assert.throws(() => normalize('m', { membership: true, key: 'desk', schema: slots, intervals: { start: 'start', end: 'end' } } as unknown as CollectionSpec), /a membership collection takes no intervals/);
});

test('the OpenAPI description names interval_conflict and its bounded conflict body', () => {
  const described = describeStore({ config, mount: '/api/rooms', schemas: {} } as unknown as Parameters<typeof describeStore>[0])!;
  const paths = described.paths as Record<string, Record<string, { responses: Record<string, { description: string }> }>>;
  assert.match(paths['/api/rooms']!.post!.responses['409']!.description, /interval_conflict/);
  assert.match(paths['/api/rooms/{id}']!.patch!.responses['409']!.description, /interval_conflict/);
  assert.match(paths['/api/rooms/{id}/reopen']!.post!.responses['409']!.description, /transition_conflict.*interval_conflict/);
  const error = (described.schemas as Record<string, { properties: { error: { properties: Record<string, unknown> } } }>).StoreError!;
  assert.deepEqual(Object.keys(error.properties.error.properties), ['code', 'message', 'fields', 'issues', 'conflict']);
  const plain = describeStore({ config: { collections: { desks: { ...desks, intervals: undefined } } }, mount: '/api/desks', schemas: {} } as unknown as Parameters<typeof describeStore>[0])!;
  assert.doesNotMatch(JSON.stringify(plain.paths), /interval_conflict/, 'a collection without intervals never answers it');
});

test('a UTC date-time compares in SQL exactly as it does in JavaScript, to the millisecond', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const sql = db.prepare("SELECT CAST(round(unixepoch(?, 'subsec') * 1000) AS INTEGER) AS ms");
    for (let index = 0; index < 5000; index++) {
      const ms = Math.floor((Math.random() * 2 - 0.5) * 4e12), iso = new Date(ms).toISOString();
      const digits = index % 4, text = digits === 3 ? iso : iso.replace(/\.\d{3}Z$/, digits === 0 ? 'Z' : `.${iso.slice(20, 20 + digits)}Z`);
      assert.equal(Number(sql.get(text)!.ms), Date.parse(text), text);
    }
  } finally { db.close(); }
});
