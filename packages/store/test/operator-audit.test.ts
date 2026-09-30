// #875: operator commands that move records in an audited owned collection record each record in the same
// transaction (and refuse whole past the audit retention); `--actor` attributes every operator change; `urlcode-store
// audit` reads the log (#1052); list filters outside a field's declared bounds are 400s on the owner and readers mounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { validateAuditEvent } from '@jimhoyd/urlcode/extensions';
import type { CollectionSpec } from '../src/index.ts';
import { addMember, reassignOwner } from '../src/index.ts';
import { direct } from './direct.ts';
import { auditEvents, counts, execute, records } from './rows.ts';

const reviewers = { membership: true, key: 'userId', audit: true, schema: { type: 'object', additionalProperties: false, required: ['userId'], properties: { userId: { type: 'string', maxLength: 128 } } } };
const requests = {
  mount: '/api/requests', ownership: 'owner', audit: true, filterable: ['status', 'priority', 'score', 'code', 'site'],
  schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 120 }, status: { type: 'string', enum: ['pending', 'approved'] }, priority: { type: 'integer', minimum: 1, maximum: 5 }, score: { type: 'number', minimum: -1.5, maximum: 1.5 }, code: { type: 'string', minLength: 2, maxLength: 4 }, site: { type: 'string', maxLength: 200, format: 'uri' } } }, defaults: { status: 'pending' },
  readers: { review: { mount: '/api/review', members: 'reviewers' } },
};
const collections = { reviewers, requests };
const typed = collections as unknown as Record<string, CollectionSpec>;
const mounts = ['/api/requests', '/api/review'];

async function site(t: Parameters<typeof direct>[0], config: Record<string, unknown> = {}) {
  const store = await direct(t, { collections, ...config }, { mounts });
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
const recordEvents = (database: string) => auditEvents(database, 'requests').filter(event => event.action === 'store.record.reassigned');

test('reassign records every moved record of an audited owned collection, in the same transaction as the move', async t => {
  const store = await site(t);
  const a = await store.create('apikey:old', 'laptop'), b = await store.create('apikey:old', 'desk');
  await store.create('ann', 'chair');
  await addMember(store.database, { collections: typed, collection: 'reviewers', principal: 'apikey:old' });
  const before = auditEvents(store.database).length;
  const dry = await reassignOwner(store.database, { from: 'apikey:old', to: 'apikey:new', collections: typed, dryRun: true });
  assert.deepEqual([dry.moved, dry.auditEvents], [2, 4], 'two records, and the membership as removed plus added');
  assert.equal(auditEvents(store.database).length, before, 'a dry run records nothing');
  // A failure on the event insert rolls back the moves and every event already written.
  execute(store.database, "CREATE TRIGGER fail_event BEFORE INSERT ON store_audit_events WHEN NEW.subject = 'requests/" + b + "' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  await assert.rejects(reassignOwner(store.database, { from: 'apikey:old', to: 'apikey:new', collections: typed }), /injected failure/);
  assert.equal(auditEvents(store.database).length, before, 'no event survives the rollback');
  assert.deepEqual(records(store.database, 'requests').map(record => record._owner), ['apikey:old', 'apikey:old', 'ann'], 'nor any move');
  assert.deepEqual(records(store.database, 'reviewers').map(record => record.userId), ['apikey:old'], 'nor the membership');
  execute(store.database, 'DROP TRIGGER fail_event');
  const moved = await reassignOwner(store.database, { from: 'apikey:old', to: 'apikey:new', collections: typed, actor: 'ops:jim' });
  assert.deepEqual([moved.moved, moved.auditEvents], [2, 4]);
  const events = recordEvents(store.database);
  assert.deepEqual(events.map(event => [event.action, event.actor, event.subject, event.metadata]), [a, b].map(id => ['store.record.reassigned', 'ops:jim', `requests/${id}`, { collection: 'requests', from: 'apikey:old', to: 'apikey:new' }]));
  for (const event of events) { assert.equal(event.source, 'store'); validateAuditEvent(event); }
  assert.deepEqual(auditEvents(store.database, 'reviewers').slice(-2).map(event => [event.action, event.actor]), [['store.membership.removed', 'ops:jim'], ['store.membership.added', 'ops:jim']]);
  assert.equal((await store.call('GET', `/api/requests/${a}`, { who: 'apikey:new' })).status, 200);
});

test('reassign refuses whole, before writing, when its events would not fit in the audit retention', async t => {
  const store = await site(t);
  for (const title of ['one', 'two', 'three']) await store.create('apikey:old', title);
  const before = counts(store.database), owners = records(store.database, 'requests').map(record => record._owner);
  for (const dryRun of [true, false])
    await assert.rejects(reassignOwner(store.database, { from: 'apikey:old', to: 'ann', collections: typed, dryRun, auditRetention: 2 }), /Nothing was moved: the move would record 3 audit events, more than the audit log keeps \(auditRetention 2\)/);
  assert.deepEqual(counts(store.database), before, 'nothing written');
  assert.deepEqual(records(store.database, 'requests').map(record => record._owner), owners);
  assert.equal((await reassignOwner(store.database, { from: 'apikey:old', to: 'ann', collections: typed, auditRetention: 3 })).auditEvents, 3);
  assert.deepEqual(auditEvents(store.database).map(event => event.action), Array(3).fill('store.record.reassigned'), 'pruned to the newest three, all of them its own');
});

test('--actor attributes every writing operator command, is validated like a principal id and applies to writes only', async t => {
  const store = await site(t);
  const app = await project(store.root);
  const base = ['--database', store.database, '--project', app];
  assert.equal((await cli('members', 'add', ...base, '--collection', 'reviewers', '--principal', 'rita', '--actor', 'ops:jim')).code, 0);
  assert.equal((await cli('members', 'remove', ...base, '--collection', 'reviewers', '--principal', 'rita')).code, 0);
  assert.deepEqual(auditEvents(store.database, 'reviewers').map(event => [event.action, event.actor]), [['store.membership.added', 'ops:jim'], ['store.membership.removed', 'operator']]);
  await store.create('apikey:old', 'laptop');
  assert.equal((await cli('reassign', ...base, '--from', 'apikey:old', '--to', 'ann', '--actor', 'ops:jim')).code, 0);
  assert.equal(recordEvents(store.database).at(-1)!.actor, 'ops:jim');
  const before = counts(store.database);
  const refusals: [string[], RegExp][] = [
    [['members', 'add', ...base, '--collection', 'reviewers', '--principal', 'rex', '--actor', 'jim@example.com'], /--actor must be a principal id/],
    [['reassign', ...base, '--from', 'ann', '--to', 'bob', '--actor', ''], /--actor must be a principal id/],
    [['members', 'list', ...base, '--collection', 'reviewers', '--actor', 'ops:jim'], /--principal and --actor apply to members add and members remove only/],
    [['audit', ...base], /--project does not apply to audit/],
    [['backup', '--database', store.database, '--actor', 'ops:jim'], /--actor does not apply to backup/],
    [['ownerless', '--database', store.database, '--collection', 'requests'], /Unknown command/],
  ];
  for (const [args, message] of refusals) {
    const failed = await cli(...args);
    assert.equal(failed.code, 1, args.join(' ')); assert.match(failed.stderr, message, args.join(' '));
    assert.doesNotMatch(failed.stderr, /jim@example/, 'a refused value is not echoed');
  }
  assert.deepEqual(counts(store.database), before, 'no refused command wrote anything');
});

test('urlcode-store audit reads one page of the log read-only, filtered and paged, beside the serving store', async t => {
  const store = await site(t);
  const app = await project(store.root);
  const base = ['--database', store.database];
  const read = async (...args: string[]) => { const result = await cli('audit', ...base, ...args); assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout) as { events: { action: string; actor: string; subject: string; seq: string }[]; next?: string; oldest?: string }; };
  assert.deepEqual(await read(), { events: [] }, 'an empty log');
  const a = await store.create('ann', 'laptop');
  await store.create('bob', 'desk');
  await addMember(store.database, { collections: typed, collection: 'reviewers', principal: 'rita' });
  const all = await read();
  assert.deepEqual(all.events.map(event => [event.action, event.actor]), [['store.record.created', 'ann'], ['store.record.created', 'bob'], ['store.membership.added', 'operator']]);
  assert.equal(all.oldest, all.events[0]!.seq);
  assert.deepEqual((await read('--actor', 'bob')).events.map(event => event.actor), ['bob']);
  assert.deepEqual((await read('--subject', `requests/${a}`)).events.length, 1);
  assert.deepEqual((await read('--action-prefix', 'store.membership')).events.map(event => event.action), ['store.membership.added']);
  const first = await read('--limit', '2', '--order', 'desc');
  assert.deepEqual(first.events.map(event => event.actor), ['operator', 'bob']);
  assert.deepEqual((await read('--limit', '2', '--order', 'desc', '--after', first.next!)).events.map(event => event.actor), ['ann']);
  for (const [args, message] of [[['--limit', '0'], /Invalid audit query: limit/], [['--order', 'sideways'], /Invalid audit query: order/], [['--from', 'yesterday'], /--from must be a whole number/], [['--project', app], /--project does not apply to audit/]] as [string[], RegExp][]) {
    const failed = await cli('audit', ...base, ...args);
    assert.equal(failed.code, 1, args.join(' ')); assert.match(failed.stderr, message);
  }
  assert.match((await cli('audit', '--database', `${store.database}.missing`)).stderr, /does not exist/, 'it never creates a database');
  // The same log through the store's exports (core's AuditLog).
  assert.deepEqual((await store.exports.audit.query({ actor: 'ann' })).events.map(event => event.subject), [`requests/${a}`]);
});

test('audit retention prunes the oldest events in the write\'s own transaction', async t => {
  const store = await site(t, { auditRetention: 3 });
  for (const title of ['one', 'two', 'three', 'four', 'five']) await store.create('ann', title);
  const kept = auditEvents(store.database);
  assert.equal(kept.length, 3);
  assert.deepEqual((await store.exports.audit.query()).events.map(event => event.id), kept.map(event => event.id));
  for (const event of kept) validateAuditEvent(event);
});

test('a reassign carrying another declaration than the serving one is refused, and proceeds once no server holds the lock', async t => {
  const store = await site(t);
  await store.create('apikey:old', 'laptop');
  const unaudited = { ...collections, requests: { ...requests, audit: false } } as unknown as Record<string, CollectionSpec>;
  await assert.rejects(reassignOwner(store.database, { from: 'apikey:old', to: 'ann', collections: unaudited }), { status: 503, code: 'storage_unavailable', message: /the serving process declares it differently/ });
  await store.close();
  const plain = await reassignOwner(store.database, { from: 'apikey:old', to: 'ann', collections: unaudited });
  assert.deepEqual([plain.moved, plain.auditEvents], [1, 0]);
});

test('a filter value outside the property\'s bounds, lengths or format is a 400 on the owner mount and the readers mount', async t => {
  const store = await site(t);
  await addMember(store.database, { collections: typed, collection: 'reviewers', principal: 'rita' });
  await store.create('ann', 'laptop', { priority: 5, score: -1.5, code: 'ab', site: 'https://example.test/a' });
  const refused: [string, string, string][] = [
    ['priority=0', 'priority', 'must be at least 1'], ['priority=6', 'priority', 'must be at most 5'], ['score=1.6', 'score', 'must be at most 1.5'], ['score=-2', 'score', 'must be at least -1.5'],
    ['code=a', 'code', 'must be at least 2 characters'], ['code=abcde', 'code', 'must be at most 4 characters'], ['code=', 'code', 'must be at least 2 characters'],
    ['site=not-a-url-SECRETVALUE', 'site', 'must be a uri'], ['site=https%3A%2F%2Fexample.test%2Fa%20b', 'site', 'must be a uri'],
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
