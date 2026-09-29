// Retries for host transactions (#902 item 3): `StoreExports.transaction(work, {idempotencyKey, fingerprint})` keeps
// the transaction's JSON result with its key in the same transaction and replays it to a retry without running
// `work`; a different fingerprint is 422; a failed transaction keeps nothing; the claims survive a restart; racing
// calls with one key run `work` once, in one process and across connections; the result is bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { StoreError, TRANSACTION_RETRIES } from '../src/index.ts';
import type { StoreExports, StoreTransactionOptions } from '../src/index.ts';
import { direct, race } from './direct.ts';
import { counts, records } from './rows.ts';

const accounts = { mount: '/api/accounts', maxRecords: 2000, schema: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', maxLength: 40 }, available: { type: 'integer', minimum: 0 } } }, defaults: { available: 0 } };
const config = { collections: { accounts } };
const mounts = ['/api/accounts'];
const claims = (database: string): number => { const db = new DatabaseSync(database); try { return Number(db.prepare('SELECT count(*) AS n FROM store_transaction_results').get()!.n); } finally { db.close(); } };

/** Opens an account and reports whether `work` ran, as a caller that sets a replay header would. */
function open(store: StoreExports, name: string, options?: StoreTransactionOptions) {
  let ran = false;
  const value = store.transaction(tx => { ran = true; const created = tx.records('accounts').create(null, { name, available: 10 }); return { id: created.record.id as string, etag: created.etag }; }, options);
  return { value, ran };
}

test('a retry with the key and fingerprint replays the first result without running work or writing', async t => {
  const store = await direct(t, config, { mounts, principalMounts: [] });
  const first = open(store.exports, 'ann', { idempotencyKey: 'open:ann', fingerprint: 'POST /open {"name":"ann"}' });
  assert.equal(first.ran, true);
  const before = counts(store.database);
  const replay = open(store.exports, 'ann', { idempotencyKey: 'open:ann', fingerprint: 'POST /open {"name":"ann"}' });
  assert.equal(replay.ran, false, 'work did not run');
  assert.deepEqual(replay.value, first.value, 'the first result, as it was returned');
  assert.deepEqual(counts(store.database), before, 'nothing was written');
  assert.equal(records(store.database, 'accounts').length, 1);
  // The result is a snapshot: a later change does not alter what the key replays.
  store.exports.transaction(tx => tx.records('accounts').update(null, first.value.id, { available: 3 }));
  assert.deepEqual(open(store.exports, 'ann', { idempotencyKey: 'open:ann', fingerprint: 'POST /open {"name":"ann"}' }).value, first.value);
  // Without a fingerprint the empty one is used, and `undefined` is a result too.
  let runs = 0;
  const nothing = () => store.exports.transaction(() => { runs++; }, { idempotencyKey: 'no-result' });
  assert.equal(nothing(), undefined); assert.equal(nothing(), undefined); assert.equal(runs, 1);
  // Without a key (or with an undefined one) every call runs.
  assert.equal(open(store.exports, 'bob').ran, true);
  assert.equal(open(store.exports, 'bob', { idempotencyKey: undefined } as unknown as StoreTransactionOptions).ran, true);
  assert.equal(records(store.database, 'accounts').length, 3);
});

test('the same key with a different fingerprint is 422 idempotency_key_reused and writes nothing', async t => {
  const store = await direct(t, config, { mounts, principalMounts: [] });
  open(store.exports, 'ann', { idempotencyKey: 'k', fingerprint: 'one' });
  const before = counts(store.database);
  for (const options of [{ idempotencyKey: 'k', fingerprint: 'two' }, { idempotencyKey: 'k' }]) {
    assert.throws(() => open(store.exports, 'ann', options), (error: unknown) => error instanceof StoreError && error.status === 422 && error.code === 'idempotency_key_reused');
  }
  assert.deepEqual(counts(store.database), before);
});

test('a transaction that throws or returns what JSON cannot keep retains nothing, and its retry runs again', async t => {
  const store = await direct(t, config, { mounts, principalMounts: [] });
  const options = { idempotencyKey: 'retry-me', fingerprint: 'f' };
  assert.throws(() => store.exports.transaction(tx => { tx.records('accounts').create(null, { name: 'x' }); throw new Error('declined'); }, options), /declined/);
  assert.throws(() => store.exports.transaction(tx => tx.records('accounts').update(null, '00000000-0000-4000-8000-000000000000', { available: 1 }), options), (error: unknown) => error instanceof StoreError && error.status === 404);
  assert.throws(() => store.exports.transaction(tx => ({ at: new Date(), id: tx.records('accounts').create(null, { name: 'x' }).record.id }), options), /must return a JSON value or undefined/);
  assert.throws(() => store.exports.transaction(tx => { tx.records('accounts').create(null, { name: 'x' }); return 'y'.repeat(TRANSACTION_RETRIES.resultBytes); }, options), RangeError);
  assert.deepEqual(counts(store.database), { records: 0, idempotency: 0, outbox: 0 });
  assert.equal(claims(store.database), 0);
  assert.equal(open(store.exports, 'x', options).ran, true, 'the retry runs');
  assert.throws(() => store.exports.transaction(() => 1, { idempotencyKey: '' }), TypeError);
  assert.throws(() => store.exports.transaction(() => 1, { idempotencyKey: 'k'.repeat(TRANSACTION_RETRIES.keyLength + 1) }), TypeError);
  assert.throws(() => store.exports.transaction(() => 1, { idempotencyKey: 'k', fingerprint: 7 as unknown as string }), TypeError);
});

test('the retry history survives a restart, stores hashes only, and keeps the newest keys', async t => {
  const store = await direct(t, config, { mounts, principalMounts: [] });
  const first = open(store.exports, 'ann', { idempotencyKey: 'secret-key-value', fingerprint: 'secret-fingerprint' });
  await store.open();
  const replay = open(store.exports, 'ann', { idempotencyKey: 'secret-key-value', fingerprint: 'secret-fingerprint' });
  assert.equal(replay.ran, false); assert.deepEqual(replay.value, first.value);
  const db = new DatabaseSync(store.database);
  try {
    const row = db.prepare('SELECT key, fingerprint FROM store_transaction_results').get()!;
    assert.match(String(row.key), /^[0-9a-f]{64}$/); assert.match(String(row.fingerprint), /^[0-9a-f]{64}$/);
  } finally { db.close(); }
  for (let index = 0; index < TRANSACTION_RETRIES.keys; index++) store.exports.transaction(() => index, { idempotencyKey: `bulk-${index}` });
  assert.equal(claims(store.database), TRANSACTION_RETRIES.keys);
  assert.equal(open(store.exports, 'ann', { idempotencyKey: 'secret-key-value', fingerprint: 'secret-fingerprint' }).ran, true, 'the oldest key was evicted, so its retry runs again');
});

test('racing calls with one key run work once, in one process and across connections', async t => {
  const store = await direct(t, config, { mounts, principalMounts: [] });
  const local = await Promise.all(Array.from({ length: 10 }, async () => { await new Promise(resolve => setImmediate(resolve)); return open(store.exports, 'local', { idempotencyKey: 'race-local' }); }));
  assert.equal(local.filter(call => call.ran).length, 1);
  assert.equal(new Set(local.map(call => call.value.id)).size, 1);
  await store.close();
  const racer = [{ method: 'TRANSACTION', path: 'accounts', init: { body: { values: { name: 'remote' }, key: 'race-remote', fingerprint: 'same' } } }];
  const answers = (await race(t, store.database, config, store.activation, Array.from({ length: 4 }, () => racer))).flat();
  assert.ok(answers.every(answer => answer.status === 200), JSON.stringify(answers));
  assert.equal(answers.filter(answer => answer.replayed === null).length, 1, 'exactly one ran');
  assert.equal(new Set(answers.map(answer => answer.body!.id)).size, 1, 'and every other call got its result');
  assert.equal(records(store.database, 'accounts').filter(record => record.name === 'remote').length, 1);
});
