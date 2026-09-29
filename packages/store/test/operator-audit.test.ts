// #875: operator commands that move or delete records in an audited owned collection record each record in the
// same transaction (and refuse whole at the outbox backlog); `--actor` attributes every operator change; list filters
// outside a field's declared bounds are 400s on the owner and readers mounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { validateAuditEvent } from '@jimhoyd/urlcode-audit';
import type { AuditExports } from '@jimhoyd/urlcode-audit';
import type { CollectionSpec } from '../src/index.ts';
import { AUDIT_BACKLOG, addMember, assignOwnerless, deleteOwnerless, reassignOwner } from '../src/index.ts';
import { direct } from './direct.ts';
import { counts, execute, outbox, records, seed, seedOutbox } from './rows.ts';

const reviewers = { membership: true, key: 'userId', audit: true, fields: { userId: { type: 'string', required: true, maxLength: 128 } } };
const requests = {
  mount: '/api/requests', ownership: 'owner', audit: true, filterable: ['status', 'priority', 'score', 'code', 'site'],
  fields: {
    title: { type: 'string', required: true, maxLength: 120 },
    status: { type: 'string', enum: ['pending', 'approved'], default: 'pending' },
    priority: { type: 'integer', minimum: 1, maximum: 5 }, score: { type: 'number', minimum: -1.5, maximum: 1.5 },
    code: { type: 'string', minLength: 2, maxLength: 4 }, site: { type: 'string', maxLength: 200, format: 'http-url' },
  },
  readers: { mount: '/api/review', members: 'reviewers' },
};
const collections = { reviewers, requests };
const typed = collections as unknown as Record<string, CollectionSpec>;
const mounts = ['/api/requests', '/api/review'];
/** An audit stand-in: audit's own validator, and a drain that never runs, so events stay in the outbox to inspect. */
const heldAudit = { version: 1, active: true, validate: validateAuditEvent, attach: () => ({ notify() {}, async close() {} }) } as unknown as AuditExports;

async function site(t: Parameters<typeof direct>[0]) {
  const store = await direct(t, { collections }, { mounts, audit: heldAudit });
  const create = async (who: string, title: string, fields: Record<string, unknown> = {}) => {
    const created = await store.call('POST', '/api/requests', { who, body: { title, ...fields } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body!.id as string;
  };
  return { ...store, create };
}
const cliPath = join(import.meta.dirname, '..', 'src', 'cli.ts');
const cli = (...args: string[]) => promisify(execFile)(process.execPath, ['--conditions=development', cliPath, ...args]).then(
  result => ({ code: 0, stdout: result.stdout, stderr: result.stderr }), (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
async function project(root: string): Promise<string> {
  const app = join(root, 'app'), route = { extension: 'store', methods: ['GET', 'HEAD', 'POST'] };
  await writeFile(join(app, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { store: { version: '1', config: { collections } } }, routes: Object.fromEntries(mounts.map(mount => [`${mount}/*`, route])) }));
  return app;
}
const recordEvents = (database: string) => outbox(database, 'requests').filter(event => event.action === 'store.record.reassigned' || (event.action === 'store.record.deleted' && event.metadata?.ownerless === true));
const filler = (count: number, collection: string) => Array.from({ length: count }, () => validateAuditEvent({ id: randomUUID(), source: 'store', action: 'store.record.created', actor: 'x', subject: `${collection}/x`, at: Date.now(), metadata: { collection } }));

test('reassign records every moved record of an audited owned collection, in the same transaction as the move', async t => {
  const store = await site(t);
  const a = await store.create('apikey:old', 'laptop'), b = await store.create('apikey:old', 'desk');
  await store.create('ann', 'chair');
  await addMember(store.database, { collections: typed, collection: 'reviewers', principal: 'apikey:old' });
  const before = outbox(store.database).length;
  const dry = await reassignOwner(store.database, { from: 'apikey:old', to: 'apikey:new', collections: typed, dryRun: true });
  assert.deepEqual([dry.moved, dry.auditEvents], [2, 4], 'two records, and the membership as removed plus added');
  assert.equal(outbox(store.database).length, before, 'a dry run records nothing');
  // A failure on the event insert rolls back the moves and every event already written.
  execute(store.database, "CREATE TRIGGER fail_event BEFORE INSERT ON store_audit_outbox WHEN json_extract(NEW.event, '$.subject') = 'requests/" + b + "' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  await assert.rejects(reassignOwner(store.database, { from: 'apikey:old', to: 'apikey:new', collections: typed }), /injected failure/);
  assert.equal(outbox(store.database).length, before, 'no event survives the rollback');
  assert.deepEqual(records(store.database, 'requests').map(record => record._owner), ['apikey:old', 'apikey:old', 'ann'], 'nor any move');
  assert.deepEqual(records(store.database, 'reviewers').map(record => record.userId), ['apikey:old'], 'nor the membership');
  execute(store.database, 'DROP TRIGGER fail_event');
  const moved = await reassignOwner(store.database, { from: 'apikey:old', to: 'apikey:new', collections: typed, actor: 'ops:jim' });
  assert.deepEqual([moved.moved, moved.auditEvents], [2, 4]);
  const events = recordEvents(store.database);
  assert.deepEqual(events.map(event => [event.action, event.actor, event.subject, event.metadata]), [a, b].map(id => ['store.record.reassigned', 'ops:jim', `requests/${id}`, { collection: 'requests', from: 'apikey:old', to: 'apikey:new' }]));
  for (const event of events) { assert.equal(event.source, 'store'); validateAuditEvent(event); }
  assert.deepEqual(outbox(store.database, 'reviewers').slice(-2).map(event => [event.action, event.actor]), [['store.membership.removed', 'ops:jim'], ['store.membership.added', 'ops:jim']]);
  assert.equal((await store.call('GET', `/api/requests/${a}`, { who: 'apikey:new' })).status, 200);
});

test('reassign and the ownerless commands refuse whole, before writing, when the events would pass the backlog', async t => {
  const store = await site(t);
  for (const title of ['one', 'two', 'three']) await store.create('apikey:old', title);
  // 998 events waiting: the three moves would take the outbox to 1001.
  await seedOutbox(store.database, 'requests', filler(AUDIT_BACKLOG - 2 - outbox(store.database, 'requests').length, 'requests'));
  const before = counts(store.database), owners = records(store.database, 'requests').map(record => record._owner);
  for (const dryRun of [true, false]) {
    await assert.rejects(reassignOwner(store.database, { from: 'apikey:old', to: 'ann', collections: typed, dryRun }), (error: { status: number; code: string; message: string }) =>
      error.status === 503 && error.code === 'audit_backlog' && /collection requests would record 3 audit events with 998 already waiting, over its audit backlog of 1000/.test(error.message));
  }
  assert.deepEqual(counts(store.database), before, 'nothing written');
  assert.deepEqual(records(store.database, 'requests').map(record => record._owner), owners);
  // With room for exactly the three events it goes through, and the outbox is then full.
  execute(store.database, "DELETE FROM store_audit_outbox WHERE seq = (SELECT min(seq) FROM store_audit_outbox WHERE collection = 'requests')");
  assert.equal((await reassignOwner(store.database, { from: 'apikey:old', to: 'ann', collections: typed })).auditEvents, 3);
  assert.equal(outbox(store.database, 'requests').length, AUDIT_BACKLOG);
  // The ownerless commands check the same way.
  const at = new Date().toISOString();
  await seed(store.database, 'requests', [{ id: randomUUID(), createdAt: at, updatedAt: at, title: 'orphan', status: 'pending' }]);
  const full = counts(store.database);
  await assert.rejects(assignOwnerless(store.database, { collections: typed, collection: 'requests', owner: 'ann' }), { status: 503, code: 'audit_backlog' });
  await assert.rejects(deleteOwnerless(store.database, { collections: typed, collection: 'requests' }), { status: 503, code: 'audit_backlog' });
  assert.deepEqual(counts(store.database), full);
  assert.equal(records(store.database, 'requests').filter(record => record._owner === undefined).length, 1);
});

test('ownerless-assign and ownerless-delete record each record on an audited collection, with the operator\'s --actor', async t => {
  const store = await site(t);
  const app = await project(store.root);
  const at = new Date().toISOString(), [one, two] = [randomUUID(), randomUUID()];
  await seed(store.database, 'requests', [{ id: one, createdAt: at, updatedAt: at, title: 'a', status: 'pending' }]);
  const assigned = await cli('ownerless-assign', '--database', store.database, '--project', app, '--collection', 'requests', '--owner', 'ann', '--actor', 'ops:jim');
  assert.equal(assigned.code, 0, assigned.stderr);
  await seed(store.database, 'requests', [{ id: two, createdAt: at, updatedAt: at, title: 'b', status: 'pending' }]);
  const deleted = await cli('ownerless-delete', '--database', store.database, '--project', app, '--collection', 'requests');
  assert.equal(deleted.code, 0, deleted.stderr);
  assert.deepEqual(recordEvents(store.database).map(event => [event.action, event.actor, event.subject, event.metadata]), [
    ['store.record.reassigned', 'ops:jim', `requests/${one}`, { collection: 'requests', to: 'ann' }],
    ['store.record.deleted', 'operator', `requests/${two}`, { collection: 'requests', ownerless: true }],
  ]);
  assert.deepEqual(records(store.database, 'requests').map(record => [record.id, record._owner]), [[one, 'ann']]);
});

test('--actor attributes every writing operator command, is validated like a principal id and applies to writes only', async t => {
  const store = await site(t);
  const app = await project(store.root);
  const base = ['--database', store.database, '--project', app];
  assert.equal((await cli('members', 'add', ...base, '--collection', 'reviewers', '--principal', 'rita', '--actor', 'ops:jim')).code, 0);
  assert.equal((await cli('members', 'remove', ...base, '--collection', 'reviewers', '--principal', 'rita')).code, 0);
  assert.deepEqual(outbox(store.database, 'reviewers').map(event => [event.action, event.actor]), [['store.membership.added', 'ops:jim'], ['store.membership.removed', 'operator']]);
  await store.create('apikey:old', 'laptop');
  assert.equal((await cli('reassign', ...base, '--from', 'apikey:old', '--to', 'ann', '--actor', 'ops:jim')).code, 0);
  assert.equal(recordEvents(store.database).at(-1)!.actor, 'ops:jim');
  const before = counts(store.database);
  const refusals: [string[], RegExp][] = [
    [['members', 'add', ...base, '--collection', 'reviewers', '--principal', 'rex', '--actor', 'jim@example.com'], /--actor must be a principal id/],
    [['reassign', ...base, '--from', 'ann', '--to', 'bob', '--actor', ''], /--actor must be a principal id/],
    [['ownerless-assign', ...base, '--collection', 'requests', '--owner', 'ann', '--actor', 'jim@example.com'], /--actor must be a principal id/],
    [['members', 'list', ...base, '--collection', 'reviewers', '--actor', 'ops:jim'], /--actor applies to the commands that change records/],
    [['ownerless', '--database', store.database, '--collection', 'requests', '--actor', 'ops:jim'], /--actor applies to the commands that change records/],
    [['ownerless', '--database', store.database, '--project', app, '--collection', 'requests'], /--project does not apply to ownerless/],
    [['ownerless-delete', '--database', store.database, '--collection', 'requests'], /--project is required/],
    [['ownerless-delete', ...base, '--collection', 'reviewers'], /not declared with ownership: owner/],
  ];
  for (const [args, message] of refusals) {
    const failed = await cli(...args);
    assert.equal(failed.code, 1, args.join(' ')); assert.match(failed.stderr, message, args.join(' '));
    assert.doesNotMatch(failed.stderr, /jim@example/, 'a refused value is not echoed');
  }
  assert.deepEqual(counts(store.database), before, 'no refused command wrote anything');
});

test('a filter value outside the field\'s bounds, lengths or format is a 400 on the owner mount and the readers mount', async t => {
  const store = await site(t);
  await addMember(store.database, { collections: typed, collection: 'reviewers', principal: 'rita' });
  await store.create('ann', 'laptop', { priority: 5, score: -1.5, code: 'ab', site: 'https://example.test/a' });
  const refused: [string, string, string][] = [
    ['priority=0', 'priority', 'must be at least 1'], ['priority=6', 'priority', 'must be at most 5'], ['score=1.6', 'score', 'must be at most 1.5'], ['score=-2', 'score', 'must be at least -1.5'],
    ['code=a', 'code', 'must be at least 2 characters'], ['code=abcde', 'code', 'must be at most 4 characters'], ['code=', 'code', 'must be at least 2 characters'],
    ['site=not-a-url-SECRETVALUE', 'site', 'must be an absolute HTTP(S) URL without credentials or ASCII whitespace'], ['site=https%3A%2F%2Fu%3Ap%40example.test%2F', 'site', 'must be an absolute HTTP(S) URL without credentials or ASCII whitespace'],
  ];
  for (const [who, path] of [['ann', '/api/requests'], ['rita', '/api/review']] as const) {
    for (const query of ['priority=5', 'priority=1', 'score=-1.5', 'code=ab', 'code=abcd', `site=${encodeURIComponent('https://example.test/a')}`]) {
      const answered = await store.call('GET', `${path}?${query}`, { who });
      assert.equal(answered.status, 200, `${path} ${query}`);
    }
    assert.equal((await store.call('GET', `${path}?priority=5`, { who })).body!.total, 1, 'a bound value still matches');
    for (const [query, field, message] of refused) {
      const answered = await store.call('GET', `${path}?${query}`, { who });
      assert.equal(answered.status, 400, `${path} ${query}`);
      assert.deepEqual(answered.body!.error, { code: 'invalid_query', message: 'The query is not valid', fields: { [field]: message } }, `${path} ${query}`);
      assert.ok(!JSON.stringify(answered.body).includes('SECRETVALUE'), 'the value is never echoed');
    }
  }
  assert.equal((await store.call('GET', '/api/review?priority=0', { who: 'bob' })).status, 403, 'a non-member still gets the gate first');
});
