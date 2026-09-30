// The membership gate (#863), proved on the #843 approval: a `membership: true` collection lists reviewers by
// principal id; a `by: others` transition and a readers mount admit only its members. A non-member gets the same 403
// for an existing and a missing id, before any record is read; a membership change applies to the next request; of
// concurrent member approvals exactly one wins; activation refuses a gate naming an unknown or ordinary collection.
//
// The #866 follow-ups: the `urlcode-store members` CLI, audited membership changes (the member and its event commit or
// roll back together), `reassign` moving membership with records, enum filter refusal and `readers.showOwner`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { validateAuditEvent } from '@jimhoyd/urlcode/extensions';
import type { CollectionSpec } from '../src/index.ts';
import { addMember, createStore, listMembers, reassignOwner, removeMember } from '../src/index.ts';
import { direct, race } from './direct.ts';
import { auditEvents, execute, records, seed } from './rows.ts';

const reviewers = { membership: true, key: 'userId', schema: { type: 'object', additionalProperties: false, required: ['userId'], properties: { userId: { type: 'string', maxLength: 128 } } } };
const requests = {
  mount: '/api/requests', ownership: 'owner', idempotency: { maxKeys: 50 }, filterable: ['status'], sortable: ['title'],
  schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 120 }, status: { type: 'string', enum: ['pending', 'approved'] }, reviewedBy: { type: 'string', maxLength: 128 } } }, defaults: { status: 'pending' }, readOnlyProperties: ['status', 'reviewedBy'],
  transitions: { approve: { from: { status: 'pending' }, set: { status: 'approved' }, stamp: { reviewedBy: 'actor' }, by: 'others', members: 'reviewers', mount: '/api/approvals' } },
  readers: { review: { mount: '/api/review', members: 'reviewers' } },
};
const config = { collections: { reviewers, requests } };
const mounts = ['/api/requests', '/api/approvals', '/api/review'];
const declared = config.collections as unknown as Record<string, CollectionSpec>;
const code = (answer: { body: Record<string, unknown> | undefined }) => (answer.body!.error as { code: string }).code;

async function site(t: Parameters<typeof direct>[0], options: { collections?: Record<string, unknown> } = {}) {
  const collections = (options.collections ?? config.collections) as unknown as Record<string, CollectionSpec>;
  const store = await direct(t, { collections }, { mounts });
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
  await assert.rejects(exports.records('reviewers').create(null, { userId: 'not a principal' }), { status: 422, code: 'invalid_record' });
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
  const store = await site(t, { collections: { reviewers, requests: { ...requests, audit: true } } });
  await store.member('rita');
  const id = await store.create('ann', 'laptop');
  assert.equal((await store.call('POST', `/api/approvals/${id}`, { who: 'bob' })).status, 403);
  assert.equal((await store.call('POST', `/api/approvals/${id}`, { who: 'rita' })).status, 200);
  const events = auditEvents(store.database, 'requests');
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
  await refuses({ reviewers, notes: { mount: '/api/notes', schema: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' } } } }, requests: { ...requests, readers: { review: { mount: '/api/review', members: 'notes' } } } }, /readers review: members names notes, which is not a membership collection/, [...mounts, '/api/notes']);
  await refuses({ reviewers, requests: { ...requests, transitions: { approve: { ...approve, members: 'requests' } } } }, /members names requests, which is not a membership collection/);
  await refuses({ reviewers: { ...reviewers, mount: '/api/reviewers' }, requests }, /a membership collection takes no mount/);
  await refuses({ reviewers: { membership: true, schema: reviewers.schema }, requests }, /needs a key/);
  await refuses({ reviewers, shared: { mount: '/api/requests', schema: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' } } }, readers: { review: { mount: '/api/review', members: 'reviewers' } } } }, /readers needs ownership: owner/);
  await refuses({ reviewers, requests: { ...requests, mount: undefined } }, /mount is required/);
  // The readers mount needs its own route, carrying a principal.
  await refuses(config.collections, /readers review: route \/api\/review\/\* with extension: store is not declared/, ['/api/requests', '/api/approvals']);
  const store = createStore({ database: join(nowhere, 'store.sqlite'), projectSha256: 'a'.repeat(64) });
  await assert.rejects(async () => store.registration.activate(config, { origin: 'https://x.example.test', target: 'node', projectSha256: 'a'.repeat(64), mounts, principalMounts: ['/api/requests', '/api/approvals'], root: join(nowhere, 'app') }), /readers review: route \/api\/review\/\* needs a principal-providing policy/);
});

const cliPath = join(import.meta.dirname, '..', 'src', 'cli.ts');
const cli = (...args: string[]) => promisify(execFile)(process.execPath, ['--conditions=development', cliPath, ...args]).then(
  result => ({ code: 0, stdout: result.stdout, stderr: result.stderr }), (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
/** Writes the route project the CLI reads the declared collections from, beside the direct store's database. */
async function project(root: string, collections: Record<string, unknown>): Promise<string> {
  const app = join(root, 'app'), route = { extension: 'store', methods: ['GET', 'HEAD', 'POST'] };
  await writeFile(join(app, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { store: { version: '1', config: { collections } } }, routes: Object.fromEntries(mounts.map(mount => [`${mount}/*`, route])) }));
  return app;
}
const auditedReviewers = { ...reviewers, audit: true };

test('urlcode-store members adds, lists and removes members beside the serving store, validating every input', async t => {
  const store = await site(t);
  const app = await project(store.root, config.collections);
  const base = ['--database', store.database, '--project', app, '--collection', 'reviewers'];
  const added = await cli('members', 'add', ...base, '--principal', 'rita');
  assert.equal(added.code, 0, added.stderr);
  assert.deepEqual(JSON.parse(added.stdout), { collection: 'reviewers', principal: 'rita', changed: true });
  assert.deepEqual(JSON.parse((await cli('members', 'add', ...base, '--principal', 'rita')).stdout), { collection: 'reviewers', principal: 'rita', changed: false });
  assert.equal((await store.call('GET', '/api/review', { who: 'rita' })).status, 200, 'the serving store admits the new member at once');
  await cli('members', 'add', ...base, '--principal', 'apikey:k1');
  assert.deepEqual(JSON.parse((await cli('members', 'list', ...base)).stdout), { collection: 'reviewers', members: ['rita', 'apikey:k1'] });
  const removed = await cli('members', 'remove', ...base, '--principal', 'rita');
  assert.deepEqual(JSON.parse(removed.stdout), { collection: 'reviewers', principal: 'rita', changed: true });
  assert.deepEqual(JSON.parse((await cli('members', 'remove', ...base, '--principal', 'rita')).stdout).changed, false);
  assert.equal((await store.call('GET', '/api/review', { who: 'rita' })).status, 403);
  const refusals: [string[], RegExp][] = [
    [['members', 'add', ...base, '--principal', 'rita@example.com'], /must be a principal id/],
    [['members', 'add', ...base, '--principal', ''], /must be a principal id/],
    [['members', 'add', ...base], /--principal is required/],
    [['members', 'list', ...base, '--principal', 'rita'], /--principal and --actor apply to members add and members remove only/],
    [['members', 'grant', ...base, '--principal', 'rita'], /Use members add, members remove or members list/],
    [['members', ...base], /Invalid command/],
    [['members', 'add', '--database', store.database, '--project', app, '--collection', 'requests', '--principal', 'rita'], /not a membership collection/],
    [['members', 'add', '--database', store.database, '--project', app, '--collection', 'missing', '--principal', 'rita'], /Collection missing is not declared/],
    [['members', 'add', '--database', store.database, '--project', 'app', '--collection', 'reviewers', '--principal', 'rita'], /--project must be an absolute path/],
    [['members', 'add', '--project', app, '--collection', 'reviewers', '--principal', 'rita'], /--database, --project and --collection are required/],
    [['members', 'list', '--database', `${store.database}.missing`, '--project', app, '--collection', 'reviewers'], /does not exist/],
    [['audit', '--database', store.database, '--principal', 'rita'], /--principal does not apply to audit/],
  ];
  for (const [args, message] of refusals) {
    const failed = await cli(...args);
    assert.equal(failed.code, 1, args.join(' ')); assert.match(failed.stderr, message, args.join(' '));
    assert.doesNotMatch(failed.stderr, /rita@example/, 'a refused value is not echoed');
  }
  assert.deepEqual(await listMembers(store.database, { collections: declared, collection: 'reviewers' }), { collection: 'reviewers', members: ['apikey:k1'] });
});

test('an audited membership collection records every added and removed member, from every path', async t => {
  const collections = { reviewers: auditedReviewers, requests };
  const store = await site(t, { collections });
  const app = await project(store.root, collections);
  const typed = collections as unknown as Record<string, CollectionSpec>;
  await addMember(store.database, { collections: typed, collection: 'reviewers', principal: 'rita' });
  assert.equal((await cli('members', 'add', '--database', store.database, '--project', app, '--collection', 'reviewers', '--principal', 'rex')).code, 0);
  await addMember(store.database, { collections: typed, collection: 'reviewers', principal: 'rita' }); // already a member: no change, no event
  await removeMember(store.database, { collections: typed, collection: 'reviewers', principal: 'nobody' }); // not a member: no event
  const exports = store.exports;
  const ray = exports.records('reviewers').create({ id: 'admin-1' }, { userId: 'ray' });
  exports.transaction(tx => tx.records('reviewers').remove(null, (tx.records('reviewers').list(null).items.find(item => item.userId === 'rex')!).id as string));
  assert.equal((await cli('members', 'remove', '--database', store.database, '--project', app, '--collection', 'reviewers', '--principal', 'rita')).code, 0);
  await ray;
  const events = auditEvents(store.database, 'reviewers');
  assert.deepEqual(events.map(event => [event.action, event.actor, event.subject]), [
    ['store.membership.added', 'operator', 'reviewers/rita'],
    ['store.membership.added', 'operator', 'reviewers/rex'],
    ['store.membership.added', 'admin-1', 'reviewers/ray'],
    ['store.membership.removed', 'anonymous', 'reviewers/rex'],
    ['store.membership.removed', 'operator', 'reviewers/rita'],
  ]);
  for (const event of events) { assert.deepEqual(event.metadata, { collection: 'reviewers' }); assert.equal(event.source, 'store'); validateAuditEvent(event); }
  // A member is never renamed: the grant and the revocation stay separate events.
  const rayId = exports.records('reviewers').list(null).items[0]!.id as string;
  await assert.rejects(exports.records('reviewers').update(null, rayId, { userId: 'roy' }), (error: { status: number; issues: { pointer: string; message: string }[] }) => error.status === 422 && error.issues[0]!.pointer === '/userId' && /cannot be changed/.test(error.issues[0]!.message));
  assert.equal(auditEvents(store.database, 'reviewers').length, 5, 'a refused change records nothing');
});

test('a membership change and its audit event commit or roll back together', async t => {
  const collections = { reviewers: auditedReviewers, requests };
  const store = await site(t, { collections });
  const typed = collections as unknown as Record<string, CollectionSpec>;
  const options = { collections: typed, collection: 'reviewers' };
  await addMember(store.database, { ...options, principal: 'rita' });
  // The event insert fails after the member row was written: the member is not added (nor removed) either.
  execute(store.database, "CREATE TRIGGER fail_event BEFORE INSERT ON store_audit_events BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  await assert.rejects(addMember(store.database, { ...options, principal: 'rex' }), { status: 503, code: 'storage_unavailable' });
  await assert.rejects(removeMember(store.database, { ...options, principal: 'rita' }), { status: 503 });
  await assert.rejects(store.exports.records('reviewers').create(null, { userId: 'ray' }), { status: 503 });
  assert.deepEqual((await listMembers(store.database, options)).members, ['rita']);
  assert.equal((await store.call('GET', '/api/review', { who: 'rex' })).status, 403, 'the gate never saw an unrecorded grant');
  assert.equal((await store.call('GET', '/api/review', { who: 'rita' })).status, 200, 'nor lost a member through an unrecorded revocation');
  execute(store.database, 'DROP TRIGGER fail_event');
  // A host transaction that throws after adding a member rolls back the member and its event.
  assert.throws(() => store.exports.transaction(tx => { tx.records('reviewers').create(null, { userId: 'ray' }); throw new Error('changed my mind'); }), /changed my mind/);
});

test('reassign moves membership with the records, in the same transaction, and records it on an audited list', async t => {
  const collections = { reviewers: auditedReviewers, requests };
  const store = await site(t, { collections });
  const typed = collections as unknown as Record<string, CollectionSpec>;
  const options = { collections: typed, collection: 'reviewers' };
  for (const member of ['apikey:old', 'rex']) await addMember(store.database, { ...options, principal: member });
  const mine = await store.create('apikey:old', 'laptop');
  const events = () => auditEvents(store.database, 'reviewers').map(event => [event.action, event.subject]);
  const recorded = events();
  const dry = await reassignOwner(store.database, { from: 'apikey:old', to: 'apikey:new', collections: typed, dryRun: true });
  assert.deepEqual(dry.memberships, [{ collection: 'reviewers', toWasMember: false }]);
  assert.deepEqual((await listMembers(store.database, options)).members, ['apikey:old', 'rex'], 'a dry run changes nothing');
  assert.deepEqual(events(), recorded);
  // A failure after the membership moved (injected on the owned collection's update) rolls it back too.
  execute(store.database, "CREATE TRIGGER fail_requests BEFORE UPDATE OF owner ON store_records WHEN NEW.collection = 'requests' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  await assert.rejects(reassignOwner(store.database, { from: 'apikey:old', to: 'apikey:new', collections: typed }), /injected failure/);
  assert.deepEqual((await listMembers(store.database, options)).members, ['apikey:old', 'rex']);
  assert.deepEqual(events(), recorded, 'no event for a move that did not happen');
  execute(store.database, 'DROP TRIGGER fail_requests');
  const moved = await reassignOwner(store.database, { from: 'apikey:old', to: 'apikey:new', collections: typed });
  assert.equal(moved.moved, 1); assert.deepEqual(moved.memberships, [{ collection: 'reviewers', toWasMember: false }]);
  assert.deepEqual((await listMembers(store.database, options)).members, ['apikey:new', 'rex'], 'the entry keeps its place');
  assert.equal(records(store.database, 'reviewers')[0]!.userId, 'apikey:new', 'the key field and the key column move together');
  assert.equal((await store.call('GET', '/api/review', { who: 'apikey:old' })).status, 403);
  assert.equal((await store.call('GET', '/api/review', { who: 'apikey:new' })).status, 200);
  assert.equal((await store.call('GET', `/api/requests/${mine}`, { who: 'apikey:new' })).status, 200);
  assert.deepEqual(events().slice(recorded.length), [['store.membership.removed', 'reviewers/apikey:old'], ['store.membership.added', 'reviewers/apikey:new']]);
  // When --to already is a member, --from's entry just goes; --collection can name the membership list alone.
  const merged = await reassignOwner(store.database, { from: 'apikey:new', to: 'rex', collections: typed, collection: 'reviewers' });
  assert.deepEqual([merged.moved, merged.collections, merged.memberships], [0, [], [{ collection: 'reviewers', toWasMember: true }]]);
  assert.deepEqual((await listMembers(store.database, options)).members, ['rex']);
  assert.deepEqual(events().at(-1), ['store.membership.removed', 'reviewers/apikey:new']);
  assert.equal((await store.call('GET', `/api/requests/${mine}`, { who: 'apikey:new' })).status, 200, '--collection reviewers left the records alone');
  // Through the CLI, beside the serving store.
  const app = await project(store.root, collections);
  const cliMove = await cli('reassign', '--database', store.database, '--project', app, '--from', 'rex', '--to', 'rita');
  assert.equal(cliMove.code, 0, cliMove.stderr);
  assert.deepEqual((JSON.parse(cliMove.stdout) as { memberships: unknown }).memberships, [{ collection: 'reviewers', toWasMember: false }]);
  assert.equal((await store.call('GET', '/api/review', { who: 'rita' })).status, 200);
});

test('a filter value outside the property\'s enum is a 400 on the owner mount and the readers mount', async t => {
  const store = await site(t);
  await store.member('rita');
  await store.create('ann', 'laptop');
  for (const [who, path] of [['ann', '/api/requests'], ['rita', '/api/review']] as const) {
    assert.equal((await store.call('GET', `${path}?status=pending`, { who })).status, 200, path);
    for (const value of ['withdrawn', 'PENDING', '']) {
      const refused = await store.call('GET', `${path}?status=${value}`, { who });
      assert.equal(refused.status, 400, `${path} ${value}`);
      assert.deepEqual(refused.body!.error, { code: 'invalid_query', message: 'The query is not valid', fields: { status: 'must be one of the declared values' } });
    }
  }
  assert.equal((await store.call('GET', '/api/review?status=withdrawn', { who: 'bob' })).status, 403, 'a non-member still gets the gate first');
});

test('readers.showOwner shows each record\'s owner id on the readers mount only', async t => {
  const shown = { ...requests, readers: { review: { ...requests.readers.review, showOwner: true } } };
  const store = await site(t, { collections: { reviewers, requests: shown } });
  await store.member('rita');
  const ann = await store.create('ann', 'laptop');
  await store.create('bob', 'desk');
  const list = await store.call('GET', '/api/review?sort=title', { who: 'rita' });
  assert.deepEqual((list.body!.items as Record<string, unknown>[]).map(item => [item.title, item._owner]), [['desk', 'bob'], ['laptop', 'ann']]);
  const one = await store.call('GET', `/api/review/${ann}`, { who: 'rita' });
  assert.equal(one.body!._owner, 'ann');
  // The list keeps its per-record ETags (#872) with showOwner, and each matches the record's own ETag.
  const etags = list.body!.etags as Record<string, string>;
  assert.deepEqual(Object.keys(etags).sort(), (list.body!.items as { id: string }[]).map(item => item.id).sort());
  for (const etag of Object.values(etags)) assert.match(etag, /^"[0-9a-f]{32}"$/);
  assert.equal(etags[ann], one.header('etag'));
  // Everywhere else the owner stays in the database: the owner's own mount, the transition's answer, StoreExports.
  assert.equal(Object.hasOwn((await store.call('GET', `/api/requests/${ann}`, { who: 'ann' })).body!, '_owner'), false);
  assert.ok(((await store.call('GET', '/api/requests', { who: 'ann' })).body!.items as Record<string, unknown>[]).every(item => !Object.hasOwn(item, '_owner')));
  const approved = await store.call('POST', `/api/approvals/${ann}`, { who: 'rita' });
  assert.equal(approved.status, 200); assert.equal(Object.hasOwn(approved.body!, '_owner'), false);
  assert.equal(Object.hasOwn(store.exports.records('requests').get({ id: 'ann' }, ann).record, '_owner'), false);
  // A non-member learns nothing, owners included.
  assert.equal((await store.call('GET', '/api/review', { who: 'ann' })).status, 403);
});

test('reassign is a write: every reader that shows the owner, and every If-Match, sees a new ETag (#1088)', async t => {
  const shown = { ...requests, readers: {
    review: { ...requests.readers.review, showOwner: true },
    board: { mount: '/api/board', members: 'reviewers', properties: ['title'], showOwner: true },
    titles: { mount: '/api/titles', properties: ['title'] },
  } };
  const collections = { reviewers, requests: shown } as unknown as Record<string, CollectionSpec>;
  const store = await direct(t, { collections }, { mounts: [...mounts, '/api/board', '/api/titles'] });
  await addMember(store.database, { collections, collection: 'reviewers', principal: 'rita' });
  const id = (await store.call('POST', '/api/requests', { who: 'ann', body: { title: 'laptop' } })).body!.id as string;
  const read = async () => {
    const review = await store.call('GET', `/api/review/${id}`, { who: 'rita' });
    const list = await store.call('GET', '/api/review', { who: 'rita' });
    const board = await store.call('GET', `/api/board/${id}`, { who: 'rita' });
    const titles = await store.call('GET', `/api/titles/${id}`, { who: 'rita' });
    return { owner: review.body!._owner, updatedAt: review.body!.updatedAt, review: review.header('etag')!, listed: (list.body!.etags as Record<string, string>)[id], board: board.header('etag'), boardOwner: board.body!._owner, titles: titles.header('etag') };
  };
  const before = await read();
  assert.equal(before.owner, 'ann'); assert.equal(before.listed, before.review);
  await reassignOwner(store.database, { from: 'ann', to: 'bob', collections });
  const after = await read();
  assert.deepEqual([after.owner, after.boardOwner], ['bob', 'bob']);
  assert.notEqual(after.updatedAt, before.updatedAt, 'the move stamps a new updatedAt');
  assert.notEqual(after.review, before.review, 'the unprojected showOwner reader answers a new ETag');
  assert.equal(after.listed, after.review, 'and the list\'s per-record ETag with it');
  assert.notEqual(after.board, before.board, 'a projected reader that shows the owner answers a new ETag');
  assert.equal(after.titles, before.titles, 'a projected reader that shows nothing the move changed keeps its ETag');
  // A conditional GET with the old tag is a full answer, and a write carrying it is refused.
  assert.equal((await store.call('GET', `/api/review/${id}`, { who: 'rita', headers: { 'if-none-match': before.review } })).status, 200);
  const approve = await store.call('POST', `/api/approvals/${id}`, { who: 'rita', headers: { 'if-match': before.review } });
  assert.equal(approve.status, 412); assert.equal(code(approve), 'precondition_failed');
  assert.equal((await store.call('PATCH', `/api/requests/${id}`, { who: 'bob', headers: { 'if-match': before.review }, body: { title: 'desk' } })).status, 412);
  assert.equal((await store.call('POST', `/api/approvals/${id}`, { who: 'rita', headers: { 'if-match': after.review } })).status, 200);
});
