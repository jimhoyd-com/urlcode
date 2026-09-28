// Declared transitions (#835), proved against the #843 approval: a reviewer moves another principal's pending request
// to approved in one conditional write. The owner cannot approve its own request, concurrent approvals give exactly one
// 200, a stale If-Match or a record no longer pending writes nothing, and only a transition changes the state fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, createStore } from '../src/index.ts';
import { direct, race } from './direct.ts';
import { counts, records } from './rows.ts';

const requests = {
  mount: '/api/requests', ownership: 'owner', idempotency: { maxKeys: 50 },
  fields: {
    title: { type: 'string', required: true, maxLength: 120 },
    status: { type: 'string', enum: ['pending', 'approved', 'withdrawn'], default: 'pending', transitionOnly: true },
    reviewedBy: { type: 'string', maxLength: 128, transitionOnly: true },
    reviewedAt: { type: 'string', maxLength: 32, transitionOnly: true },
  },
  transitions: {
    approve: { from: { status: 'pending' }, set: { status: 'approved' }, stamp: { reviewedBy: 'actor', reviewedAt: 'now' }, by: 'others', mount: '/api/approvals' },
    withdraw: { from: { status: 'pending' }, set: { status: 'withdrawn' } },
  },
};
const config = { collections: { requests } };
const mounts = ['/api/requests', '/api/approvals'];
const code = (answer: { body: Record<string, unknown> | undefined }) => (answer.body!.error as { code: string }).code;

async function site(t: Parameters<typeof direct>[0]) {
  const store = await direct(t, config, { mounts });
  const create = async (who: string, title: string) => {
    const created = await store.call('POST', '/api/requests', { who, body: { title } });
    assert.equal(created.status, 201);
    return { id: created.body!.id as string, etag: created.header('etag')! };
  };
  return { ...store, create };
}

test('a reviewer approves another user\'s pending request; the owner cannot approve its own', async t => {
  const store = await site(t);
  const { id } = await store.create('ann', 'laptop');
  const own = await store.call('POST', `/api/approvals/${id}`, { who: 'ann' });
  assert.equal(own.status, 403); assert.equal(code(own), 'own_record_refused');
  assert.equal(records(store.database, 'requests')[0]!.status, 'pending', 'nothing written');
  const approved = await store.call('POST', `/api/approvals/${id}`, { who: 'rita' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body!.status, 'approved'); assert.equal(approved.body!.reviewedBy, 'rita');
  assert.equal(approved.body!.reviewedAt, approved.body!.updatedAt, 'now is the commit time');
  assert.equal(Object.hasOwn(approved.body!, '_owner'), false, 'the owner never leaves the database');
  assert.equal(approved.header('etag'), (await store.call('GET', `/api/requests/${id}`, { who: 'ann' })).header('etag'));
  const again = await store.call('POST', `/api/approvals/${id}`, { who: 'rex' });
  assert.equal(again.status, 409); assert.equal(code(again), 'transition_conflict');
  assert.equal(records(store.database, 'requests')[0]!.reviewedBy, 'rita', 'the first approval stands');
});

test('only a transition changes a transitionOnly field', async t => {
  const store = await site(t);
  const created = await store.call('POST', '/api/requests', { who: 'ann', body: { title: 'x', status: 'approved' } });
  assert.equal(created.status, 400); assert.deepEqual((created.body!.error as { fields: unknown }).fields, { status: 'is changed only by a transition' });
  const { id, etag } = await store.create('ann', 'x');
  for (const [method, body] of [['PATCH', { status: 'approved' }], ['PATCH', { reviewedBy: null }], ['PUT', { title: 'y', status: 'approved' }]] as const) {
    const refused = await store.call(method, `/api/requests/${id}`, { who: 'ann', body });
    assert.equal(refused.status, 400, `${method} ${JSON.stringify(body)}`);
  }
  await store.call('POST', `/api/approvals/${id}`, { who: 'rita' });
  const put = await store.call('PUT', `/api/requests/${id}`, { who: 'ann', body: { title: 'renamed' } });
  assert.equal(put.status, 200);
  assert.deepEqual([put.body!.title, put.body!.status, put.body!.reviewedBy], ['renamed', 'approved', 'rita'], 'PUT keeps what only a transition may change');
  assert.equal((await store.call('PATCH', `/api/requests/${id}`, { who: 'ann', body: { title: 'z' }, headers: { 'if-match': etag } })).status, 412);
});

test('concurrent approvals: exactly one 200, every other 409, one reviewer stamped', async t => {
  const store = await site(t);
  const { id } = await store.create('ann', 'laptop');
  const answers = await Promise.all(['rita', 'rex', 'ray', 'rob', 'roz'].map(who => store.call('POST', `/api/approvals/${id}`, { who })));
  assert.deepEqual(answers.map(answer => answer.status).sort(), [200, 409, 409, 409, 409]);
  const winner = answers.find(answer => answer.status === 200)!.body!.reviewedBy;
  assert.equal(records(store.database, 'requests')[0]!.reviewedBy, winner);
});

test('concurrent approvals from separate connections (as separate processes): exactly one 200', async t => {
  const store = await site(t);
  const { id } = await store.create('ann', 'laptop');
  await store.close();
  const answers = (await race(t, store.database, config, store.activation, ['rita', 'rex', 'ray', 'rob'].map(who => [{ method: 'POST', path: `/api/approvals/${id}`, init: { who } }]))).flat();
  assert.deepEqual(answers.map(answer => answer.status).sort(), [200, 409, 409, 409]);
  assert.equal(records(store.database, 'requests')[0]!.reviewedBy, answers.find(answer => answer.status === 200)!.body!.reviewedBy);
});

test('a stale If-Match is 412 and writes nothing; the current one applies', async t => {
  const store = await site(t);
  const { id, etag } = await store.create('ann', 'laptop');
  const renamed = await store.call('PATCH', `/api/requests/${id}`, { who: 'ann', body: { title: 'laptop, 16 inch' } });
  const before = records(store.database, 'requests');
  const stale = await store.call('POST', `/api/approvals/${id}`, { who: 'rita', headers: { 'if-match': etag } });
  assert.equal(stale.status, 412); assert.deepEqual(records(store.database, 'requests'), before, 'no mutation');
  assert.equal((await store.call('POST', `/api/approvals/${id}`, { who: 'rita', headers: { 'if-match': renamed.header('etag')! } })).status, 200);
});

test('an approval retried with its Idempotency-Key replays the approval, even after a later change', async t => {
  const store = await site(t);
  const { id } = await store.create('ann', 'laptop');
  const first = await store.call('POST', `/api/approvals/${id}`, { who: 'rita', headers: { 'idempotency-key': 'approve-1' } });
  assert.equal(first.status, 200);
  await store.call('PATCH', `/api/requests/${id}`, { who: 'ann', body: { title: 'renamed' } });
  const retry = await store.call('POST', `/api/approvals/${id}`, { who: 'rita', headers: { 'idempotency-key': 'approve-1' } });
  assert.equal(retry.status, 200, 'not the 409 a second approval would get');
  assert.equal(retry.header('idempotency-replayed'), 'true'); assert.equal(retry.body!.title, 'renamed');
  const other = await store.create('bob', 'desk');
  assert.equal((await store.call('POST', `/api/approvals/${other.id}`, { who: 'rita', headers: { 'idempotency-key': 'approve-1' } })).status, 422, 'the key belongs to the first request');
  assert.equal(records(store.database, 'requests')[1]!.status, 'pending');
});

test('owner transitions run on the collection mount, scoped like every other write', async t => {
  const store = await site(t);
  const { id } = await store.create('ann', 'laptop');
  assert.equal((await store.call('POST', `/api/requests/${id}/withdraw`, { who: 'bob' })).status, 404, 'another owner\'s record is a missing one');
  assert.equal((await store.call('POST', `/api/requests/${id}/approve`, { who: 'rita' })).status, 404, 'a by: others transition answers only on its own mount');
  assert.equal((await store.call('POST', `/api/requests/${id}/unknown`, { who: 'ann' })).status, 404);
  assert.equal((await store.call('GET', `/api/requests/${id}/withdraw`, { who: 'ann' })).status, 405);
  const withBody = await store.call('POST', `/api/requests/${id}/withdraw`, { who: 'ann', body: { status: 'approved' } });
  assert.equal(withBody.status, 400); assert.equal(code(withBody), 'body_not_allowed');
  const withdrawn = await store.call('POST', `/api/requests/${id}/withdraw`, { who: 'ann' });
  assert.equal(withdrawn.status, 200); assert.equal(withdrawn.body!.status, 'withdrawn');
  assert.equal((await store.call('POST', `/api/approvals/${id}`, { who: 'rita' })).status, 409, 'a withdrawn request cannot be approved');
  assert.equal((await store.call('GET', `/api/approvals/${id}`, { who: 'rita' })).status, 405);
  assert.equal((await store.call('POST', '/api/approvals/not-a-uuid', { who: 'rita' })).status, 404);
  assert.equal((await store.call('POST', `/api/approvals/${crypto.randomUUID()}`, { who: 'rita' })).status, 404);
  assert.equal((await store.call('POST', `/api/approvals/${id}`)).status, 401, 'no principal, nothing read');
});

test('a failure inside the transition rolls back the record, the claim and nothing is left behind', async t => {
  const store = await site(t);
  const { id } = await store.create('ann', 'laptop');
  const before = { counts: counts(store.database), records: records(store.database, 'requests') };
  const { execute } = await import('./rows.ts');
  execute(store.database, "CREATE TRIGGER fail_claim BEFORE INSERT ON store_idempotency BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  const failed = await store.call('POST', `/api/approvals/${id}`, { who: 'rita', headers: { 'idempotency-key': 'k' } });
  assert.equal(failed.status, 503); assert.equal(code(failed), 'storage_unavailable');
  assert.deepEqual({ counts: counts(store.database), records: records(store.database, 'requests') }, before, 'the approval was written before the claim failed, and rolled back with it');
  execute(store.database, 'DROP TRIGGER fail_claim');
  assert.equal((await store.call('POST', `/api/approvals/${id}`, { who: 'rita', headers: { 'idempotency-key': 'k' } })).status, 200);
});

test('activation refuses a transition it cannot serve safely', async t => {
  const declare = (transitions: Record<string, unknown>, fields: Record<string, unknown> = requests.fields, extra: Record<string, unknown> = {}) => () => new Collection('requests', { ...requests, fields, transitions, ...extra } as never);
  assert.throws(declare({ approve: { from: { status: 'pending' }, set: { status: 'approved' }, by: 'others' } }), /by: others needs its own mount/);
  assert.throws(declare({ withdraw: { from: { status: 'pending' }, set: { status: 'withdrawn' }, mount: '/api/w' } }), /mount is only for by: others/);
  assert.throws(declare({ approve: { from: { status: 'maybe' }, set: { status: 'approved' } } }), /from value for status is not one of the allowed values/);
  assert.throws(declare({ approve: { from: { nope: 1 }, set: { status: 'approved' } } }), /from names nope, which is not a declared field/);
  assert.throws(declare({ increment: { from: { status: 'pending' }, set: { status: 'approved' } } }), /reserved/);
  assert.throws(declare({ approve: { from: { status: 'pending' }, set: { status: 'approved' }, stamp: { title: 'actor' } } }), /stamp field title must be a string .* at least 128/);
  assert.throws(declare({ approve: { from: { status: 'pending' }, set: { status: 'approved' }, stamp: { status: 'now' } } }), /both set and stamped/);
  assert.throws(declare({ withdraw: { from: { status: 'pending' }, set: { status: 'withdrawn' } } }), /reviewedBy is transitionOnly but no transition sets or stamps it/);
  const { ownership: _ownership, ...shared } = requests;
  assert.throws(() => new Collection('requests', { ...shared, transitions: { approve: { ...requests.transitions.approve } } } as never), /by needs ownership: owner/);
  // The transition mount must be routed and guarded by a principal-providing policy.
  const store = createStore({ database: '/nonexistent/never-opened.sqlite', projectSha256: 'a'.repeat(64) });
  t.after(() => store.close());
  const activation = { origin: 'https://x.example.test', target: 'node' as const, projectSha256: 'a'.repeat(64), root: '/nonexistent/app' };
  await assert.rejects(async () => store.registration.activate(config, { ...activation, mounts: ['/api/requests'], principalMounts: ['/api/requests'] }), /route \/api\/approvals\/\* with extension: store is not declared/);
  await assert.rejects(async () => store.registration.activate(config, { ...activation, mounts, principalMounts: ['/api/requests'] }), /by: others needs route \/api\/approvals\/\* guarded by a principal-providing policy/);
});
