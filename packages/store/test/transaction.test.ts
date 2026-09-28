// StoreExports.transaction (#835): trusted host code runs several store operations as one database transaction. Proved
// against the simulated-credit contract (value moves between records and the total never changes, even when a
// transfer fails half way), the scheduling contract (a move that would overlap is refused and keeps its old slot), and
// injected failures (nothing written, audit outbox included).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAudit } from '@jimhoyd/urlcode-audit';
import type { AuditExports } from '@jimhoyd/urlcode-audit';
import { StoreError } from '../src/index.ts';
import type { StoreExports, StoreTransaction } from '../src/records.ts';
import { cleanup } from './cleanup.ts';
import { direct, pin } from './direct.ts';
import { counts, execute, outbox, records } from './rows.ts';

const accounts = {
  mount: '/api/accounts', audit: true, maxRecords: 100,
  fields: { name: { type: 'string', required: true, maxLength: 20 }, available: { type: 'integer', default: 0, minimum: 0 }, held: { type: 'integer', default: 0, minimum: 0 } },
};
const bookings = {
  mount: '/api/bookings', ownership: 'owner', maxRecords: 1000, pageSize: 200,
  fields: { calendar: { type: 'string', required: true, maxLength: 40 }, start: { type: 'integer', required: true, minimum: 0 }, end: { type: 'integer', required: true, minimum: 1 } },
};
const tickets = { mount: '/api/tickets', audit: true, fields: { title: { type: 'string', required: true, maxLength: 40 }, open: { type: 'boolean', default: true } }, transitions: { close: { from: { open: true }, set: { open: false } } } };
const config = { collections: { accounts, bookings, tickets } };
const mounts = ['/api/accounts', '/api/bookings', '/api/tickets'];

/** A real audit database for event validation, with a drain that never runs, so undelivered events stay countable. */
async function auditFor(t: TestContext, root: string): Promise<AuditExports & { woken(): number }> {
  const log = await createAudit({ projectSha256: pin, database: join(root, 'audit.sqlite') });
  cleanup(t, () => log.close());
  await log.registration.activate({}, { origin: 'https://direct.example.test', target: 'node', projectSha256: pin, mounts: [], root });
  let woken = 0;
  return { ...log.exports, get active() { return log.exports.active; }, validate: value => log.exports.validate(value), attach: () => ({ notify() { woken++; }, async close() {} }), woken: () => woken };
}
async function site(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'store-audit-'));
  cleanup(t, () => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const audit = await auditFor(t, root);
  const store = await direct(t, config, { mounts, audit });
  return { ...store, audit };
}
const total = (database: string) => records(database, 'accounts').reduce((sum, record) => sum + (record.available as number) + (record.held as number), 0);

/** The simulated-credit operations, each one transaction: hold moves available to held; settle moves held to another account's available. */
function credits(store: StoreExports) {
  const change = (tx: StoreTransaction, id: string, delta: { available?: number; held?: number }) => {
    const current = tx.records('accounts').get(null, id);
    return tx.records('accounts').update(null, id, { available: (current.record.available as number) + (delta.available ?? 0), held: (current.record.held as number) + (delta.held ?? 0) }, { ifMatch: current.etag });
  };
  const counted = { updates: 0 };
  const run = (changes: number, work: (tx: StoreTransaction) => void) => { store.transaction(work); counted.updates += changes; };
  return {
    counted,
    transfer: (from: string, to: string, amount: number) => run(2, tx => { change(tx, from, { available: -amount }); change(tx, to, { available: amount }); }),
    hold: (id: string, amount: number) => run(1, tx => { change(tx, id, { available: -amount, held: amount }); }),
    settle: (from: string, to: string, amount: number) => run(2, tx => { change(tx, from, { held: -amount }); change(tx, to, { available: amount }); }),
    cancel: (id: string, amount: number) => run(1, tx => { change(tx, id, { available: amount, held: -amount }); }),
  };
}

test('credits: concurrent transfers, holds and settlements conserve the total, and a failed transfer changes nothing', async t => {
  const store = await site(t);
  const api = store.exports.records('accounts');
  const ids = await Promise.all(['a', 'b', 'c', 'd'].map(async name => (await api.create(null, { name, available: 100 })).record.id as string));
  const ops = credits(store.exports);
  let refused = 0;
  // Interleaved on the event loop: each operation is one synchronous transaction, so nothing runs between its reads
  // and its writes; the random amounts overdraw often, and an overdraft (below minimum 0) must undo the whole transfer.
  await Promise.all(Array.from({ length: 200 }, async (_, index) => {
    await new Promise(resolve => setImmediate(resolve));
    const from = ids[index % 4]!, to = ids[(index * 7 + 1) % 4]!, amount = 1 + (index * 37) % 90;
    try {
      if (from === to) return;
      if (index % 3 === 0) ops.transfer(from, to, amount);
      else if (index % 3 === 1) { ops.hold(from, amount); if (index % 2) ops.settle(from, to, amount); else ops.cancel(from, amount); }
      else ops.transfer(to, from, amount);
    } catch (error) {
      assert.ok(error instanceof StoreError && error.status === 400, String(error));
      refused++;
    }
    assert.equal(total(store.database), 400, `after operation ${index}`);
  }));
  assert.ok(refused > 0, 'some operations overdrew and were refused');
  assert.equal(total(store.database), 400);
  assert.ok(records(store.database, 'accounts').every(record => (record.held as number) === 0), 'every hold was settled or cancelled');
  const events = outbox(store.database).map(event => event.action);
  assert.deepEqual([events.filter(action => action === 'store.record.created').length, events.filter(action => action === 'store.record.updated').length], [4, ops.counted.updates], 'one event per committed change, none for a refused one');
});

test('credits: an injected failure on the second record rolls back the first, the audit outbox included', async t => {
  const store = await site(t);
  const api = store.exports.records('accounts');
  const a = (await api.create(null, { name: 'a', available: 50 })).record.id as string, b = (await api.create(null, { name: 'b', available: 50 })).record.id as string;
  const woken = store.audit.woken();
  const before = { counts: counts(store.database), accounts: records(store.database, 'accounts'), outbox: outbox(store.database) };
  // The second account's update fails inside SQLite, after the first account and its audit event were written.
  execute(store.database, `CREATE TRIGGER fail_b BEFORE UPDATE ON store_records WHEN NEW.id = '${b}' BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
  assert.throws(() => credits(store.exports).transfer(a, b, 10), (error: unknown) => error instanceof StoreError && error.status === 503 && error.code === 'storage_unavailable');
  assert.deepEqual({ counts: counts(store.database), accounts: records(store.database, 'accounts'), outbox: outbox(store.database) }, before);
  assert.equal(store.audit.woken(), woken, 'a rolled-back transaction wakes nothing');
  execute(store.database, 'DROP TRIGGER fail_b');
  credits(store.exports).transfer(a, b, 10);
  assert.deepEqual(records(store.database, 'accounts').map(record => record.available), [40, 60]);
  assert.equal(store.audit.woken(), woken + 1, 'one wake-up after the commit');
});

test('scheduling: a move that would overlap is refused and keeps its old slot; racing bookings never overlap', async t => {
  const store = await site(t);
  const overlaps = (tx: StoreTransaction, who: string, calendar: string, start: number, end: number, except?: string) => {
    for (let cursor: string | undefined; ;) {
      const page = tx.records('bookings').list({ id: who }, { ...(cursor === undefined ? {} : { cursor }) });
      // Half-open intervals: [start, end) and [s, e) overlap when start < e and s < end.
      if (page.items.some(item => item.id !== except && item.calendar === calendar && start < (item.end as number) && (item.start as number) < end)) return true;
      if (page.next === undefined) return false;
      cursor = page.next;
    }
  };
  const book = (who: string, calendar: string, start: number, end: number) => store.exports.transaction(tx => {
    if (overlaps(tx, who, calendar, start, end)) throw new StoreError(409, 'slot_taken', 'That slot is taken');
    return tx.records('bookings').create({ id: who }, { calendar, start, end });
  });
  const move = (who: string, id: string, ifMatch: string, start: number, end: number) => store.exports.transaction(tx => {
    const current = tx.records('bookings').get({ id: who }, id);
    if (overlaps(tx, who, current.record.calendar as string, start, end, id)) throw new StoreError(409, 'slot_taken', 'That slot is taken');
    return tx.records('bookings').update({ id: who }, id, { start, end }, { ifMatch });
  });
  const nine = book('ann', 'room', 540, 600), ten = book('ann', 'room', 600, 660);
  assert.throws(() => move('ann', ten.record.id as string, ten.etag, 570, 630), (error: unknown) => error instanceof StoreError && error.code === 'slot_taken');
  assert.deepEqual(store.exports.records('bookings').get({ id: 'ann' }, ten.record.id as string).record, ten.record, 'the rejected move keeps its old slot');
  assert.throws(() => move('ann', ten.record.id as string, nine.etag, 700, 760), (error: unknown) => error instanceof StoreError && error.status === 412, 'another booking\'s revision is not this one\'s');
  const moved = move('ann', ten.record.id as string, ten.etag, 660, 720);
  assert.equal(moved.record.start, 660);
  assert.throws(() => move('ann', ten.record.id as string, ten.etag, 800, 860), (error: unknown) => error instanceof StoreError && error.status === 412, 'the expected revision is the one it was read at');
  const raced = await Promise.all(Array.from({ length: 10 }, async (_, index) => { await new Promise(resolve => setImmediate(resolve)); try { return book('ann', 'room', 900 + index * 10, 960 + index * 10).record.id; } catch { return undefined; } }));
  const kept = records(store.database, 'bookings').filter(record => (record.start as number) >= 900);
  assert.equal(raced.filter(Boolean).length, kept.length);
  for (const one of kept) for (const other of kept) if (one !== other) assert.ok((one.end as number) <= (other.start as number) || (other.end as number) <= (one.start as number), 'no two kept bookings overlap');
  assert.throws(() => store.exports.transaction(tx => tx.records('bookings').get({ id: 'bob' }, nine.record.id as string)), (error: unknown) => error instanceof StoreError && error.status === 404, 'owner scoping applies inside a transaction');
});

test('a transaction is synchronous, single-use and never nested', async t => {
  const store = await site(t);
  const before = counts(store.database);
  assert.throws(() => store.exports.transaction(async tx => { tx.records('accounts').create(null, { name: 'async' }); }), /must be synchronous/);
  assert.deepEqual(counts(store.database), before, 'the synchronous part was rolled back');
  let kept: StoreTransaction | undefined;
  store.exports.transaction(tx => { kept = tx; });
  assert.throws(() => kept!.records('accounts'), /has ended/);
  assert.throws(() => store.exports.transaction(() => store.exports.transaction(() => 1)), /do not nest/);
  assert.throws(() => store.exports.transaction(tx => tx.records('nope')), /declares no collection nope/);
  const mine = new Error('the caller\'s own reason');
  assert.throws(() => store.exports.transaction(tx => { tx.records('accounts').create(null, { name: 'undone' }); throw mine; }), (error: unknown) => error === mine, 'the caller\'s own error is rethrown unchanged');
  assert.deepEqual(counts(store.database), before);
  assert.equal(store.exports.transaction(tx => tx.records('accounts').create(null, { name: 'kept' }).record.name), 'kept');
});

test('a transition is audited with its name, and runs inside a host transaction under the same rules', async t => {
  const store = await site(t);
  const created = await store.exports.records('tickets').create({ id: 'ann' }, { title: 'printer' });
  const closed = store.exports.transaction(tx => tx.records('tickets').transition({ id: 'rita' }, created.record.id as string, 'close', { ifMatch: created.etag }));
  assert.equal(closed.record.open, false);
  assert.throws(() => store.exports.transaction(tx => tx.records('tickets').transition({ id: 'rita' }, created.record.id as string, 'close')), (error: unknown) => error instanceof StoreError && error.code === 'transition_conflict');
  const event = outbox(store.database, 'tickets').at(-1)!;
  assert.deepEqual([event.action, event.actor, event.metadata], ['store.record.transitioned', 'rita', { collection: 'tickets', transition: 'close', fields: ['open'] }]);
  await assert.rejects(store.exports.records('tickets').transition({ id: 'rita' }, created.record.id as string, 'reopen'), (error: unknown) => error instanceof StoreError && error.status === 404);
});
