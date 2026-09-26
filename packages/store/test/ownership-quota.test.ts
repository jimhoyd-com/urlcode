import test from 'node:test';
import assert from 'node:assert/strict';
import { assignOwnerless, deleteOwnerless } from '../src/index.ts';
import { boot, json, legacy, notes, running } from './ownership-support.ts';

// urlcode#731: a per-owner record limit on an owned collection.
const capped = { ...notes, maxRecords: 5, maxRecordsPerOwner: 2 };
type As = (who: string) => (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;
const post = (as: As, who: string, title: string, headers: Record<string, string> = {}) =>
  as(who)('/api/notes', { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify({ title }) });
const codeOf = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;
const postAt = (port: number, who: string) => fetch(`http://127.0.0.1:${port}/api/notes`, { method: 'POST', headers: { ...json, authorization: `Badge ${who}` }, body: JSON.stringify({ title: 'x' }) });

test('maxRecordsPerOwner stops one principal at its limit while another can still create, without revealing any count', async t => {
  const { as, create, restart } = await running(t, { collection: capped });
  await create('alice', 'a1'); await create('alice', 'a2');
  const refused = await post(as, 'alice', 'a3');
  assert.equal(refused.status, 409);
  const body = await refused.json() as { error: Record<string, unknown> };
  assert.deepEqual(Object.keys(body), ['error']); assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
  assert.equal(body.error.code, 'owner_quota_exceeded');
  assert.doesNotMatch(body.error.message as string, /\d/, 'no count, limit or total in the message');
  await create('bob', 'b1');
  // Deleting frees a slot for that owner only.
  const mine = await (await as('alice')('/api/notes')).json() as { items: { id: string }[] };
  assert.equal((await as('alice')(`/api/notes/${mine.items[0]!.id}`, { method: 'DELETE' })).status, 204);
  await create('alice', 'a3');
  assert.equal(await codeOf(await post(as, 'alice', 'a4')), 'owner_quota_exceeded');
  // The counts are rebuilt from the data file after a restart.
  await restart();
  assert.equal(await codeOf(await post(as, 'alice', 'a5')), 'owner_quota_exceeded');
  await create('bob', 'b2');
  assert.equal(await codeOf(await post(as, 'bob', 'b3')), 'owner_quota_exceeded');
});

test('maxRecords stays the collection-wide ceiling under maxRecordsPerOwner', async t => {
  const { as, create } = await running(t, { collection: capped });
  await create('alice', 'a1'); await create('alice', 'a2'); await create('bob', 'b1'); await create('bob', 'b2'); await create('carol', 'c1');
  const full = await post(as, 'carol', 'c2');
  assert.equal(full.status, 409);
  assert.equal(await codeOf(full), 'collection_full');
  // A principal already at its own limit is told about its own limit.
  assert.equal(await codeOf(await post(as, 'alice', 'a3')), 'owner_quota_exceeded');
});

test('an idempotent replay does not count twice toward the per-owner limit', async t => {
  const { as, create } = await running(t, { collection: capped });
  assert.equal((await post(as, 'alice', 'a1', { 'idempotency-key': 'once' })).status, 201);
  const replay = await post(as, 'alice', 'a1', { 'idempotency-key': 'once' });
  assert.equal(replay.status, 409);
  assert.equal(await codeOf(replay), 'idempotency_duplicate');
  await create('alice', 'a2');
  assert.equal(((await (await as('alice')('/api/notes')).json()) as { total: number }).total, 2);
});

test('legacy ownerless records count toward the collection but no owner, and ownerless-assign updates the counts', async t => {
  const { as, create, stop, start, data } = await running(t, { collection: capped, seed: [legacy('old-1'), legacy('old-2'), legacy('old-3')] });
  await create('alice', 'a1'); await create('alice', 'a2');
  assert.equal(await codeOf(await post(as, 'alice', 'a3')), 'owner_quota_exceeded');
  assert.equal(await codeOf(await post(as, 'bob', 'b1')), 'collection_full', 'the three legacy records still fill the collection');
  await stop();
  // Assigning them to bob puts bob over his limit: activation still succeeds, and bob cannot create more.
  await assignOwnerless(data, 'notes', 'bob');
  const app = await start();
  try { assert.equal(await codeOf(await postAt(app.address.port, 'bob')), 'owner_quota_exceeded'); }
  finally { await app.close(); }
});

test('ownerless-delete frees room for owners after the restart', async t => {
  const { as, create, stop, start, data } = await running(t, { collection: capped, seed: [legacy('old-1'), legacy('old-2'), legacy('old-3')] });
  await create('alice', 'a1'); await create('alice', 'a2');
  assert.equal(await codeOf(await post(as, 'bob', 'b1')), 'collection_full');
  await stop();
  await deleteOwnerless(data, 'notes');
  const app = await start();
  try {
    assert.equal((await postAt(app.address.port, 'bob')).status, 201);
    assert.equal(await codeOf(await postAt(app.address.port, 'alice')), 'owner_quota_exceeded');
  } finally { await app.close(); }
});

test('activation refuses maxRecordsPerOwner on a shared collection and above maxRecords', async t => {
  const { ownership: _ownership, ...shared } = notes;
  const onShared = await boot(t, { collection: { ...shared, maxRecordsPerOwner: 2 } });
  await assert.rejects(onShared.start(), /maxRecordsPerOwner needs ownership: owner/);
  const above = await boot(t, { collection: { ...notes, maxRecords: 5, maxRecordsPerOwner: 6 } });
  await assert.rejects(above.start(), /maxRecordsPerOwner exceeds maxRecords \(5\)/);
  const { maxRecords: _max, ...defaulted } = notes;
  const aboveDefault = await boot(t, { collection: { ...defaulted, maxRecordsPerOwner: 1001 } });
  await assert.rejects(aboveDefault.start(), /maxRecordsPerOwner exceeds maxRecords \(1000\)/);
  const equal = await boot(t, { collection: { ...notes, maxRecords: 5, maxRecordsPerOwner: 5 } });
  const app = await equal.start();
  await app.close();
});
