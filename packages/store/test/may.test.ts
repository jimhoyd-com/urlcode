// `may` (#873 item 2): list, read and write answers say which transitions the caller may run on each record right
// now, from the record's values against `from`, its owner against `by`, and the caller's own membership for a
// `members` gate, read in the same transaction. Only the caller's membership is looked up, once per distinct gate
// whatever the page size, and a caller with no principal is offered only what the declaration alone allows.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CollectionSpec } from '../src/index.ts';
import { addMember, removeMember } from '../src/index.ts';
import { StoreDatabase } from '../src/database.ts';
import { direct } from './direct.ts';
import { cleanup } from './cleanup.ts';

const member = { membership: true, key: 'userId', fields: { userId: { type: 'string', required: true, maxLength: 128 } } };
const collections = {
  reviewers: member, leads: member,
  requests: {
    mount: '/api/requests', ownership: 'owner', pageSize: 50,
    fields: { title: { type: 'string', required: true, maxLength: 120 }, status: { type: 'string', enum: ['pending', 'approved', 'withdrawn', 'escalated'], default: 'pending', transitionOnly: true } },
    transitions: {
      withdraw: { from: { status: 'pending' }, set: { status: 'withdrawn' } },
      approve: { from: { status: 'pending' }, set: { status: 'approved' }, by: 'others', members: 'reviewers', mount: '/api/approvals' },
      escalate: { from: { status: 'pending' }, set: { status: 'escalated' }, by: 'others', members: 'leads', mount: '/api/escalations' },
    },
    readers: { mount: '/api/review', members: 'reviewers' },
  },
  notes: {
    mount: '/api/notes', fields: { text: { type: 'string', required: true, maxLength: 64 }, state: { type: 'string', enum: ['draft', 'published', 'pinned'], default: 'draft', transitionOnly: true } },
    transitions: { publish: { from: { state: 'draft' }, set: { state: 'published' } }, pin: { from: { state: 'published' }, set: { state: 'pinned' }, members: 'leads' } },
  },
};
const declared = collections as unknown as Record<string, CollectionSpec>;
const mounts = ['/api/requests', '/api/approvals', '/api/escalations', '/api/review', '/api/notes'];

async function site(t: Parameters<typeof direct>[0]) {
  // The notes mount carries no principal-providing policy: an anonymous caller reaches it.
  const store = await direct(t, { collections }, { mounts, principalMounts: mounts.filter(mount => mount !== '/api/notes') });
  const create = async (who: string, title: string) => {
    const created = await store.call('POST', '/api/requests', { who, body: { title } });
    assert.equal(created.status, 201);
    return created.body!.id as string;
  };
  const grant = (collection: string, principal: string) => addMember(store.database, { collections: declared, collection, principal });
  const revoke = (collection: string, principal: string) => removeMember(store.database, { collections: declared, collection, principal });
  const may = async (who: string | null, path: string) => {
    const listed = await store.call('GET', path, { who });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    return listed.body!.may as Record<string, string[]>;
  };
  return { ...store, create, grant, revoke, may };
}

test('the owner, another principal, a member and a non-member are each offered exactly what the store would accept', async t => {
  const store = await site(t);
  await store.grant('reviewers', 'rita');
  const laptop = await store.create('ann', 'laptop'), desk = await store.create('ann', 'desk'), own = await store.create('rita', 'monitor');
  assert.equal((await store.call('POST', `/api/requests/${desk}/withdraw`, { who: 'ann' })).status, 200);

  // The owner: withdraw on her pending record, nothing on the withdrawn one; never approve, which is by: others.
  assert.deepEqual(await store.may('ann', '/api/requests'), { [laptop]: ['withdraw'], [desk]: [] });
  // A member on the readers mount: approve on someone else's pending record, not on her own (by: others excludes the
  // owner), and never escalate, whose gate she is not in. Her own record still shows withdraw, which she owns.
  assert.deepEqual(await store.may('rita', '/api/review'), { [laptop]: ['approve'], [desk]: [], [own]: ['withdraw'] });
  // A non-member cannot list across owners, and on her own mount sees only her own records.
  assert.equal((await store.call('GET', '/api/review', { who: 'bob' })).status, 403);
  assert.deepEqual(await store.may('bob', '/api/requests'), {});

  // The single-record answers carry the same, as Allow-Transitions beside the ETag.
  const read = await store.call('GET', `/api/review/${laptop}`, { who: 'rita' });
  assert.deepEqual([read.status, read.header('allow-transitions')], [200, 'approve']);
  assert.equal((await store.call('GET', `/api/requests/${laptop}`, { who: 'ann' })).header('allow-transitions'), 'withdraw');
  assert.equal((await store.call('GET', `/api/review/${own}`, { who: 'rita' })).header('allow-transitions'), 'withdraw');
  // A write answers for the record as it now stands: approved, so nothing is left for the approver.
  const approved = await store.call('POST', `/api/approvals/${laptop}`, { who: 'rita' });
  assert.deepEqual([approved.status, approved.header('allow-transitions')], [200, '']);
  assert.ok(approved.header('etag'));
  const created = await store.call('POST', '/api/requests', { who: 'ann', body: { title: 'chair' } });
  assert.equal(created.header('allow-transitions'), 'withdraw');
  const edited = await store.call('PATCH', `/api/requests/${created.body!.id as string}`, { who: 'ann', body: { title: 'chairs' } });
  assert.equal(edited.header('allow-transitions'), 'withdraw');
  // The answer never names a member, and never carries any collection's membership records.
  const text = JSON.stringify(await store.call('GET', '/api/review', { who: 'rita' }));
  assert.ok(!text.includes('reviewers') && !text.includes('leads'), 'no gate or member list in the answer');
});

test('a membership change is reflected in the next list; a principal-less caller is offered only ungated shared transitions', async t => {
  const store = await site(t);
  await store.grant('reviewers', 'rita');
  const laptop = await store.create('ann', 'laptop');
  assert.deepEqual(await store.may('rita', '/api/review'), { [laptop]: ['approve'] });
  await store.grant('leads', 'rita');
  assert.deepEqual(await store.may('rita', '/api/review'), { [laptop]: ['approve', 'escalate'] });
  await store.revoke('leads', 'rita');
  assert.deepEqual(await store.may('rita', '/api/review'), { [laptop]: ['approve'] });

  // A shared collection: anyone may publish a draft; only a lead may pin a published note.
  const draft = (await store.call('POST', '/api/notes', { body: { text: 'a' } })).body!.id as string;
  const published = (await store.call('POST', '/api/notes', { body: { text: 'b' } })).body!.id as string;
  assert.equal((await store.call('POST', `/api/notes/${published}/publish`)).status, 200);
  assert.deepEqual(await store.may(null, '/api/notes'), { [draft]: ['publish'], [published]: [] }, 'anonymous: no gate is evaluated');
  assert.deepEqual(await store.may('bob', '/api/notes'), { [draft]: ['publish'], [published]: [] });
  await store.grant('leads', 'lee');
  assert.deepEqual(await store.may('lee', '/api/notes'), { [draft]: ['publish'], [published]: ['pin'] });
  assert.equal((await store.call('GET', `/api/notes/${published}`)).header('allow-transitions'), '');
  assert.deepEqual(await store.may(null, '/api/notes?limit=1'), { [draft]: ['publish'] }, 'only the page is covered');
});

test('membership is looked up once per distinct gate, never per listed record', async t => {
  const store = await site(t);
  await store.grant('reviewers', 'rita');
  // Counts the membership lookups: the one statement that reads a membership collection by key.
  const lookups: string[] = [], original = StoreDatabase.prototype.get;
  StoreDatabase.prototype.get = function (this: StoreDatabase, sql: string, ...values: Parameters<typeof original> extends [string, ...infer R] ? R : never) {
    if (/^SELECT 1 AS found FROM store_records WHERE collection = \? AND key = \?$/.test(sql) && (values[0] === 'reviewers' || values[0] === 'leads')) lookups.push(String(values[0]));
    return original.call(this, sql, ...values);
  } as typeof original;
  cleanup(t, () => { StoreDatabase.prototype.get = original; });
  const counted = async (path: string) => { lookups.length = 0; await store.may('rita', path); return [...lookups].sort(); };

  await store.create('ann', 'one');
  const few = await counted('/api/review');
  for (let index = 0; index < 30; index++) await store.create(`owner-${index % 3}`, `request ${index}`);
  const many = await counted('/api/review');
  // The readers gate (reviewers), then may's own lookups: reviewers for approve, leads for escalate. The same for 1 and 31.
  assert.deepEqual(few, ['leads', 'reviewers', 'reviewers']);
  assert.deepEqual(many, few);
  assert.equal(Object.keys((await store.call('GET', '/api/review', { who: 'rita' })).body!.may as object).length, 31);
  // On the owner's mount no gated transition applies to any record (approve and escalate are by: others, and every
  // record is hers), so no membership is looked up at all.
  for (let index = 0; index < 20; index++) await store.create('rita', `mine ${index}`);
  assert.deepEqual(await counted('/api/requests'), []);
  assert.equal(Object.values(await store.may('rita', '/api/requests')).filter(names => names.join() === 'withdraw').length, 20);
});
