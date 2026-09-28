// The membership gate (#863), proved on the #843 approval: a `membership: true` collection lists reviewers by
// principal id; a `by: others` transition and a readers mount admit only its members. A non-member gets the same 403
// for an existing and a missing id, before any record is read; a membership change applies to the next request; of
// concurrent member approvals exactly one wins; activation refuses a gate naming an unknown or ordinary collection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAuditEvent } from '@jimhoyd/urlcode-audit';
import type { AuditExports } from '@jimhoyd/urlcode-audit';
import type { CollectionSpec } from '../src/index.ts';
import { addMember, createStore, listMembers, removeMember, storeScreens } from '../src/index.ts';
import { direct, race } from './direct.ts';
import { outbox, records, seed } from './rows.ts';

const reviewers = { membership: true, key: 'userId', fields: { userId: { type: 'string', required: true, maxLength: 128 } } };
const requests = {
  mount: '/api/requests', ownership: 'owner', idempotency: { maxKeys: 50 }, filterable: ['status'], sortable: ['title'],
  fields: {
    title: { type: 'string', required: true, maxLength: 120 },
    status: { type: 'string', enum: ['pending', 'approved'], default: 'pending', transitionOnly: true },
    reviewedBy: { type: 'string', maxLength: 128, transitionOnly: true },
  },
  transitions: { approve: { from: { status: 'pending' }, set: { status: 'approved' }, stamp: { reviewedBy: 'actor' }, by: 'others', members: 'reviewers', mount: '/api/approvals' } },
  readers: { mount: '/api/review', members: 'reviewers' },
};
const config = { collections: { reviewers, requests } };
const mounts = ['/api/requests', '/api/approvals', '/api/review'];
const declared = config.collections as unknown as Record<string, CollectionSpec>;
const code = (answer: { body: Record<string, unknown> | undefined }) => (answer.body!.error as { code: string }).code;
/** An audit stand-in: audit's own validator, and a drain that never runs, so events stay in the outbox to inspect. */
const heldAudit = { version: 1, active: true, validate: validateAuditEvent, attach: () => ({ notify() {}, async close() {} }) } as unknown as AuditExports;

async function site(t: Parameters<typeof direct>[0], options: { audit?: AuditExports; collections?: Record<string, unknown> } = {}) {
  const collections = (options.collections ?? config.collections) as unknown as Record<string, CollectionSpec>;
  const store = await direct(t, { collections }, { mounts, ...(options.audit ? { audit: options.audit } : {}) });
  const create = async (who: string, title: string) => {
    const created = await store.call('POST', '/api/requests', { who, body: { title } });
    assert.equal(created.status, 201);
    return created.body!.id as string;
  };
  const member = (principal: string) => addMember(store.database, { collections, collection: 'reviewers', principal });
  return { ...store, create, member };
}

test('only a member approves, never the owner; a non-member learns nothing about which ids exist', async t => {
  const store = await site(t);
  await store.member('rita');
  const id = await store.create('ann', 'laptop');
  const missing = randomUUID();
  for (const who of ['bob', 'ann']) {
    const existing = await store.call('POST', `/api/approvals/${id}`, { who });
    const absent = await store.call('POST', `/api/approvals/${missing}`, { who });
    assert.equal(existing.status, 403, who); assert.equal(code(existing), 'membership_required');
    assert.deepEqual([absent.status, absent.body], [existing.status, existing.body], 'the same answer for a missing id');
    const conditional = await store.call('POST', `/api/approvals/${id}`, { who, headers: { 'if-match': `"${'0'.repeat(32)}"`, 'idempotency-key': 'k' } });
    assert.equal(conditional.status, 403, 'the gate comes before If-Match and the retained key');
  }
  assert.equal((await store.call('POST', `/api/approvals/${id}`)).status, 401, 'no principal');
  assert.equal(records(store.database, 'requests')[0]!.status, 'pending', 'nothing written');
  const approved = await store.call('POST', `/api/approvals/${id}`, { who: 'rita' });
  assert.equal(approved.status, 200); assert.equal(approved.body!.reviewedBy, 'rita');
  assert.equal((await store.call('POST', `/api/approvals/${missing}`, { who: 'rita' })).status, 404, 'a member sees the ordinary 404');
  // A member who owns the request is still refused: by: others excludes the owner.
  await store.member('ann');
  const own = await store.create('ann', 'monitor');
  const refused = await store.call('POST', `/api/approvals/${own}`, { who: 'ann' });
  assert.equal(refused.status, 403); assert.equal(code(refused), 'own_record_refused');
});

test('members list and read every owner\'s records, read-only; owners keep their own view', async t => {
  const store = await site(t);
  await store.member('rita');
  const ann = await store.create('ann', 'laptop'), bob = await store.create('bob', 'desk');
  await store.create('bob', 'chair');
  await store.call('POST', `/api/approvals/${bob}`, { who: 'rita' });
  // A record with no owner (written while the collection was shared) is nobody's: not listed, not readable.
  const ownerless = randomUUID(), at = new Date().toISOString();
  await seed(store.database, 'requests', [{ id: ownerless, createdAt: at, updatedAt: at, title: 'orphan', status: 'pending' }]);
  const all = await store.call('GET', '/api/review', { who: 'rita' });
  assert.equal(all.status, 200);
  assert.deepEqual((all.body!.items as { title: string }[]).map(item => item.title), ['laptop', 'desk', 'chair']);
  assert.equal(all.body!.total, 3);
  const pending = await store.call('GET', '/api/review?status=pending&sort=-title', { who: 'rita' });
  assert.deepEqual((pending.body!.items as { title: string }[]).map(item => item.title), ['laptop', 'chair'], 'filters and sort through the declared query');
  assert.equal((await store.call('GET', '/api/review?owner=ann', { who: 'rita' })).status, 400, 'only declared filters');
  const one = await store.call('GET', `/api/review/${ann}`, { who: 'rita' });
  assert.equal(one.status, 200); assert.equal(one.body!.title, 'laptop'); assert.ok(one.header('etag'));
  for (const item of [...all.body!.items as Record<string, unknown>[], one.body!]) assert.equal(Object.hasOwn(item, '_owner'), false, 'the owner never leaves the database');
  assert.equal((await store.call('GET', `/api/review/${ownerless}`, { who: 'rita' })).status, 404);
  assert.equal((await store.call('GET', `/api/review/${randomUUID()}`, { who: 'rita' })).status, 404);
  assert.equal((await store.call('HEAD', '/api/review', { who: 'rita' })).status, 200);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const write = await store.call(method, `/api/review/${ann}`, { who: 'rita', body: { title: 'x' } });
    assert.equal(write.status, 405, method); assert.equal(write.header('allow'), 'GET, HEAD');
  }
  // Non-members, owners included: one 403 for the list, an existing id, a missing id and a malformed one.
  for (const who of ['ann', 'bob']) {
    const answers = await Promise.all(['/api/review', '/api/review?status=pending', `/api/review/${ann}`, `/api/review/${randomUUID()}`, '/api/review/nope', '/api/review?bogus=1'].map(path => store.call('GET', path, { who })));
    for (const answer of answers) assert.deepEqual([answer.status, answer.body], [403, answers[0]!.body], who);
    assert.equal(code(answers[0]!), 'membership_required');
  }
  assert.equal((await store.call('GET', '/api/review')).status, 401);
  // The owner's own mount is unchanged: only its own records.
  assert.deepEqual(((await store.call('GET', '/api/requests', { who: 'bob' })).body!.items as { title: string }[]).map(item => item.title), ['desk', 'chair']);
  assert.equal((await store.call('GET', `/api/requests/${ann}`, { who: 'rita' })).status, 404, 'a member reads other owners only on the readers mount');
});

test('a membership change applies to the next request, through the operator path and StoreExports', async t => {
  const store = await site(t);
  const id = await store.create('ann', 'laptop');
  assert.equal((await store.call('GET', '/api/review', { who: 'rita' })).status, 403);
  // The operator adds a member on its own connection while the store is serving.
  assert.deepEqual(await store.member('rita'), { collection: 'reviewers', principal: 'rita', changed: true });
  assert.deepEqual(await store.member('rita'), { collection: 'reviewers', principal: 'rita', changed: false }, 'adding twice changes nothing');
  assert.equal((await store.call('GET', '/api/review', { who: 'rita' })).status, 200);
  assert.equal((await store.call('POST', `/api/approvals/${id}`, { who: 'rita', headers: { 'idempotency-key': 'approve-1' } })).status, 200);
  const removed = await removeMember(store.database, { collections: declared, collection: 'reviewers', principal: 'rita' });
  assert.equal(removed.changed, true);
  assert.equal((await store.call('GET', '/api/review', { who: 'rita' })).status, 403);
  const retry = await store.call('POST', `/api/approvals/${id}`, { who: 'rita', headers: { 'idempotency-key': 'approve-1' } });
  assert.equal(retry.status, 403, 'a removed member\'s retry is refused, not replayed');
  // Trusted extension code maintains it too; the collection has no HTTP API.
  const exports = store.exports;
  exports.records('reviewers').create(null, { userId: 'rex' });
  assert.equal((await store.call('GET', '/api/review', { who: 'rex' })).status, 200);
  exports.transaction(tx => { const list = tx.records('reviewers'); list.remove(null, list.list(null).items.find(item => item.userId === 'rex')!.id as string); });
  assert.equal((await store.call('GET', '/api/review', { who: 'rex' })).status, 403);
  assert.deepEqual(await listMembers(store.database, { collections: declared, collection: 'reviewers' }), { collection: 'reviewers', members: [] });
  // A host transaction's transition passes the same gate.
  assert.throws(() => exports.transaction(tx => tx.records('requests').transition({ id: 'bob' }, randomUUID(), 'approve')), { status: 403, code: 'membership_required' });
  await assert.rejects(exports.records('reviewers').create(null, { userId: 'not a principal' }), { status: 400 });
  await assert.rejects(addMember(store.database, { collections: declared, collection: 'requests', principal: 'rita' }), /not a membership collection/);
  await assert.rejects(addMember(store.database, { collections: declared, collection: 'reviewers', principal: ' rita' }), /principal id/);
});

test('concurrent member approvals: exactly one 200, in one process and across connections', async t => {
  const store = await site(t);
  for (const reviewer of ['rita', 'rex', 'ray', 'rob']) await store.member(reviewer);
  const first = await store.create('ann', 'laptop');
  const answers = await Promise.all(['rita', 'rex', 'ray', 'rob', 'bob'].map(who => store.call('POST', `/api/approvals/${first}`, { who })));
  assert.deepEqual(answers.map(answer => answer.status).sort(), [200, 403, 409, 409, 409]);
  const second = await store.create('ann', 'desk');
  await store.close();
  const raced = (await race(t, store.database, config, store.activation, ['rita', 'rex', 'ray', 'rob'].map(who => [{ method: 'POST', path: `/api/approvals/${second}`, init: { who } }]))).flat();
  assert.deepEqual(raced.map(answer => answer.status).sort(), [200, 409, 409, 409]);
  assert.equal(records(store.database, 'requests')[1]!.reviewedBy, raced.find(answer => answer.status === 200)!.body!.reviewedBy);
});

test('an audited gated transition records the member as the actor', async t => {
  const store = await site(t, { audit: heldAudit, collections: { reviewers, requests: { ...requests, audit: true } } });
  await store.member('rita');
  const id = await store.create('ann', 'laptop');
  assert.equal((await store.call('POST', `/api/approvals/${id}`, { who: 'bob' })).status, 403);
  assert.equal((await store.call('POST', `/api/approvals/${id}`, { who: 'rita' })).status, 200);
  const events = outbox(store.database, 'requests');
  assert.deepEqual(events.map(event => [event.action, event.actor]), [['store.record.created', 'ann'], ['store.record.transitioned', 'rita']], 'a refused approval records nothing');
  assert.equal(events[1]!.metadata!.transition, 'approve');
});

test('activation refuses a gate naming an unknown or ordinary collection, and a misdeclared membership collection', async () => {
  // Every refusal comes before the database is opened, so nothing is created under this never-made directory.
  const nowhere = join(tmpdir(), `store-never-${randomUUID()}`);
  const refuses = async (collections: Record<string, unknown>, message: RegExp, extraMounts: string[] = mounts) => {
    const store = createStore({ database: join(nowhere, 'store.sqlite'), projectSha256: 'a'.repeat(64) });
    await assert.rejects(async () => store.registration.activate({ collections }, { origin: 'https://x.example.test', target: 'node', projectSha256: 'a'.repeat(64), mounts: extraMounts, principalMounts: extraMounts, root: join(nowhere, 'app') }), message);
  };
  const approve = requests.transitions.approve;
  await refuses({ reviewers, requests: { ...requests, transitions: { approve: { ...approve, members: 'nobody' } } } }, /transition approve: members names nobody, which is not a declared collection/);
  await refuses({ reviewers, notes: { mount: '/api/notes', fields: { title: { type: 'string' } } }, requests: { ...requests, readers: { mount: '/api/review', members: 'notes' } } }, /readers: members names notes, which is not a membership collection/, [...mounts, '/api/notes']);
  await refuses({ reviewers, requests: { ...requests, transitions: { approve: { ...approve, members: 'requests' } } } }, /members names requests, which is not a membership collection/);
  await refuses({ reviewers: { ...reviewers, mount: '/api/reviewers' }, requests }, /a membership collection takes no mount/);
  await refuses({ reviewers: { membership: true, fields: reviewers.fields }, requests }, /needs a key/);
  await refuses({ reviewers, shared: { mount: '/api/requests', fields: { title: { type: 'string' } }, readers: { mount: '/api/review', members: 'reviewers' } } }, /readers needs ownership: owner/);
  await refuses({ reviewers, requests: { ...requests, mount: undefined } }, /mount is required/);
  // The readers mount needs its own route, carrying a principal.
  await refuses(config.collections, /readers: route \/api\/review\/\* with extension: store is not declared/, ['/api/requests', '/api/approvals']);
  const store = createStore({ database: join(nowhere, 'store.sqlite'), projectSha256: 'a'.repeat(64) });
  await assert.rejects(async () => store.registration.activate(config, { origin: 'https://x.example.test', target: 'node', projectSha256: 'a'.repeat(64), mounts, principalMounts: ['/api/requests', '/api/approvals'], root: join(nowhere, 'app') }), /readers: route \/api\/review\/\* needs a principal-providing policy/);
  assert.throws(() => storeScreens({ collections: config.collections, screens: { '/reviewers': { collection: 'reviewers' } } }), /membership collection, which has no mount/);
});
