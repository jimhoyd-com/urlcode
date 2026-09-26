import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AuditError, auditOutboxLimits, auditPermissions, createAudit, validateAuditEvent } from '../src/index.ts';
import type { AuditEvent, AuditExports, AuditStoredEvent } from '../src/index.ts';
import { activation, activeAudit, event, openAudit, pin, tempDir } from './support.ts';

const rejectsWith = (promise: Promise<unknown>, status: number, code: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof AuditError && error.status === status && error.code === code);

async function all(exports: AuditExports, filter: Record<string, unknown> = {}): Promise<AuditStoredEvent[]> {
  const events: AuditStoredEvent[] = [];
  let after: string | undefined;
  do {
    const page = await exports.query({ ...filter, limit: 100, ...(after ? { after } : {}) });
    events.push(...page.events);
    after = page.next;
  } while (after);
  return events;
}
async function recordMany(exports: AuditExports, count: number, make: (index: number) => AuditEvent = () => event()): Promise<AuditEvent[]> {
  const events = Array.from({ length: count }, (_, index) => make(index));
  for (let index = 0; index < events.length; index += 100) await exports.record(events.slice(index, index + 100));
  return events;
}

test('the exports are version 1 with the shared constants', async t => {
  const { audit } = await openAudit(t);
  assert.equal(audit.exports.version, 1);
  assert.equal(audit.exports.validate, validateAuditEvent);
  assert.ok(Object.isFrozen(audit.exports));
  assert.deepEqual(auditOutboxLimits, { auth: 10000, perCollection: 1000 });
  assert.deepEqual(auditPermissions, ['audit.read', 'audit.export']);
  assert.ok(Object.isFrozen(auditOutboxLimits) && Object.isFrozen(auditPermissions));
  assert.throws(() => audit.exports.validate({}), (error: unknown) => error instanceof AuditError && error.status === 400);
});

test('record stores a batch durably, once per id, with its defaults', async t => {
  const { audit, database } = await activeAudit(t, { now: () => 1234 });
  const first = event({ reason: 'typed reason', metadata: { collection: 'todos', fields: ['title'] } }), second = event({ actor: 'operator' });
  await audit.exports.record([first, second]);
  await audit.exports.record([first, { ...second, action: 'changed.content' }]);
  const { events } = await audit.exports.query();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(item => item.id), [first.id, second.id]);
  assert.equal(events[1]!.action, 'thing.done', 'a redelivered id keeps the stored event');
  assert.deepEqual(events[0], { ...first, metadata: { collection: 'todos', fields: ['title'] }, seq: events[0]!.seq, recordedAt: 1234 });
  assert.equal(events[1]!.reason, '');
  assert.equal(events[1]!.metadata, null);
  await audit.close();
  const reopened = await createAudit({ projectSha256: pin, database });
  const instance = await reopened.registration.activate({}, activation('/'));
  try {
    assert.equal((await reopened.exports.query()).events.length, 2, 'the log survives a restart');
    if (process.platform !== 'win32') assert.equal((await stat(database)).mode & 0o777, 0o600);
  } finally {
    // Close before the test's own t.after cleanup removes the directory: t.after hooks run in registration
    // order, and this reopened database must not still be open when that runs (#768).
    await instance.close?.();
    await reopened.close();
  }
});

test('record refuses a batch outside 1..100 or with any invalid event, storing nothing', async t => {
  const { audit } = await activeAudit(t);
  await rejectsWith(audit.exports.record([]), 400, 'invalid_audit_event');
  await rejectsWith(audit.exports.record(Array.from({ length: 101 }, () => event())), 400, 'invalid_audit_event');
  await rejectsWith(audit.exports.record([event(), event({ actor: '' })]), 400, 'invalid_audit_event');
  assert.equal((await audit.exports.query()).events.length, 0);
});

test('retention prunes the oldest events in the ingest transaction and reports the count', async t => {
  const pruned: number[] = [];
  const { audit } = await activeAudit(t, { onPruned: removed => { pruned.push(removed); throw new Error('ignored'); } }, { retention: 1000 });
  const events = await recordMany(audit.exports, 1000);
  assert.deepEqual(pruned, []);
  await audit.exports.record([event(), event(), event()]);
  assert.deepEqual(pruned, [3]);
  const kept = await all(audit.exports);
  assert.equal(kept.length, 1000);
  assert.equal(kept[0]!.id, events[3]!.id);
  const page = await audit.exports.query({ limit: 1 });
  assert.equal(page.oldest, kept[0]!.seq);
});

test('retention comes from createAudit and is overridden by the activation config', async t => {
  await assert.rejects(createAudit({ projectSha256: pin, database: join(await tempDir(t), 'a.sqlite'), retention: 999 }), /retention/);
  const { audit, dir } = await openAudit(t, { retention: 1000 });
  await assert.rejects(Promise.resolve().then(() => audit.registration.activate({ retention: 10000001 }, activation(dir))), /retention/);
  assert.equal(audit.exports.active, false);
});

test('an activation without retention returns to the host default rather than keeping the previous value', async t => {
  const pruned: number[] = [];
  const { audit, dir } = await openAudit(t, { retention: 2000, onPruned: removed => { pruned.push(removed); } });
  const strict = await audit.registration.activate({ retention: 1000 }, activation(dir));
  strict.close?.();
  const relaxed = await audit.registration.activate({}, activation(dir));
  t.after(() => relaxed.close?.());
  await recordMany(audit.exports, 1500);
  assert.deepEqual(pruned, [], 'the host default of 2000 applies, not the removed 1000');
  assert.equal((await all(audit.exports)).length, 1500);
});

test('query filters by source, actor, subject, action, action prefix and time', async t => {
  const { audit } = await activeAudit(t);
  const base = 1_700_000_000_000;
  const rows: AuditEvent[] = [
    event({ source: 'auth', action: 'admin', actor: 'a1', subject: 's1', at: base }),
    event({ source: 'auth', action: 'admin.roles', actor: 'a1', subject: 's2', at: base + 1 }),
    event({ source: 'admin', action: 'admin.audit.exported', actor: 'a2', subject: 's1', at: base + 2 }),
    event({ source: 'store', action: 'administrator.x', actor: 'a2', subject: 's3', at: base + 3 }),
    event({ source: 'store', action: 'admin_x', actor: 'a3', subject: '', at: base + 4 }),
    event({ source: 'store', action: 'adminx', actor: 'a3', subject: 's1', at: base + 5 }),
  ];
  await audit.exports.record(rows);
  const ids = async (filter: Record<string, unknown>) => (await audit.exports.query(filter)).events.map(item => rows.findIndex(row => row.id === item.id));
  assert.deepEqual(await ids({ source: 'store' }), [3, 4, 5]);
  assert.deepEqual(await ids({ actor: 'a1' }), [0, 1]);
  assert.deepEqual(await ids({ subject: 's1' }), [0, 2, 5]);
  assert.deepEqual(await ids({ subject: '' }), [4]);
  assert.deepEqual(await ids({ action: 'admin' }), [0]);
  assert.deepEqual(await ids({ actionPrefix: 'admin' }), [0, 1, 2]);
  assert.deepEqual(await ids({ actionPrefix: 'admin.audit' }), [2]);
  assert.deepEqual(await ids({ from: base + 2, to: base + 4 }), [2, 3, 4]);
  assert.deepEqual(await ids({ from: base + 5 }), [5]);
  assert.deepEqual(await ids({ to: base }), [0]);
  assert.deepEqual(await ids({ source: 'store', actor: 'a3', subject: 's1' }), [5]);
  assert.deepEqual(await ids({ order: 'desc', source: 'auth' }), [1, 0]);
});

test('pages walk every event once in either order, with next and oldest', async t => {
  const { audit } = await activeAudit(t);
  const events = await recordMany(audit.exports, 125);
  const walk = async (order: 'asc' | 'desc', limit?: number) => {
    const seen: string[] = [];
    let after: string | undefined, pages = 0;
    do {
      const page = await audit.exports.query({ order, ...(limit ? { limit } : {}), ...(after ? { after } : {}) });
      seen.push(...page.events.map(item => item.id));
      assert.ok(page.oldest);
      after = page.next; pages++;
    } while (after);
    return { seen, pages };
  };
  const asc = await walk('asc');
  assert.equal(asc.pages, 3, 'the default limit is 50');
  assert.deepEqual(asc.seen, events.map(item => item.id));
  const desc = await walk('desc', 100);
  assert.equal(desc.pages, 2);
  assert.deepEqual(desc.seen, events.map(item => item.id).reverse());
  const exact = await audit.exports.query({ limit: 100, after: (await audit.exports.query({ limit: 25 })).next! });
  assert.equal(exact.events.length, 100);
  assert.equal(exact.next, undefined, 'a page that ends exactly at the last event has no next');
  const empty = await activeAudit(t);
  assert.deepEqual(await empty.audit.exports.query(), { events: [] });
});

test('query refuses invalid filters, including a limit outside 1..100', async t => {
  const { audit } = await activeAudit(t);
  for (const filter of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { order: 'up' }, { after: '0' }, { after: '01' }, { after: 5 }, { after: '99999999999999999' },
    { source: 'Bad' }, { actionPrefix: 'a b' }, { actor: '' }, { from: -1 }, { to: 1.5 }, { unknown: 1 }, 'x', []]) {
    await rejectsWith(audit.exports.query(filter as never), 400, 'invalid_audit_query');
  }
  assert.equal((await audit.exports.query({ limit: 100 })).events.length, 0);
});

test('record, query and flush refuse until activation and after the instance closes; attach works before', async t => {
  const { audit, dir } = await openAudit(t);
  assert.equal(audit.exports.active, false);
  await rejectsWith(audit.exports.record([event()]), 503, 'audit_inactive');
  await rejectsWith(audit.exports.query(), 503, 'audit_inactive');
  await rejectsWith(audit.exports.flush(), 503, 'audit_inactive');
  const attachment = audit.exports.attach({ source: 'early', peek: async () => [], ack: async () => {} });
  const instance = await audit.registration.activate({}, activation(dir));
  assert.equal(audit.exports.active, true);
  await audit.exports.flush();
  const next = await audit.registration.activate({}, activation(dir));
  await instance.close?.();
  assert.equal(audit.exports.active, true, 'a reload that activates the next runtime first stays active');
  await next.close?.();
  assert.equal(audit.exports.active, false);
  await attachment.close();
  await audit.close();
  await rejectsWith(audit.exports.query(), 503, 'audit_inactive');
  await assert.rejects(Promise.resolve().then(() => audit.registration.activate({}, activation(dir))), /closed/);
});

test('activation refuses any mount: audit serves no routes', async t => {
  const { audit, dir } = await openAudit(t);
  await assert.rejects(Promise.resolve().then(() => audit.registration.activate({}, activation(dir, ['/audit']))), /audit serves no routes/);
  assert.equal(audit.exports.active, false);
  assert.deepEqual(audit.registration.targets, ['node']);
  const instance = await audit.registration.activate({}, activation(dir));
  t.after(() => instance.close?.());
  const answer = await instance.handle({} as never);
  assert.equal(answer.status, 404);
});

test('createAudit refuses a missing pin, a public file, a symlink, a hard link and a foreign database', async t => {
  const dir = await tempDir(t);
  await assert.rejects(createAudit({ projectSha256: 'x', database: join(dir, 'a.sqlite') }), /revision pin/);
  if (process.platform !== 'win32') {
    const shared = join(dir, 'shared.sqlite');
    await writeFile(shared, '', { mode: 0o644 });
    await chmod(shared, 0o644);
    await assert.rejects(createAudit({ projectSha256: pin, database: shared }), /private regular file/);
  }
  const target = join(dir, 'target.sqlite');
  await writeFile(target, '', { mode: 0o600 });
  await symlink(target, join(dir, 'alias.sqlite'));
  await assert.rejects(createAudit({ projectSha256: pin, database: join(dir, 'alias.sqlite') }), /private regular file/);
  await link(target, join(dir, 'second-name.sqlite'));
  await assert.rejects(createAudit({ projectSha256: pin, database: target }), /private regular file/);
  const foreign = join(dir, 'foreign.sqlite');
  const db = new DatabaseSync(foreign);
  db.exec('CREATE TABLE other(x)');
  db.close();
  await chmod(foreign, 0o600);
  await assert.rejects(createAudit({ projectSha256: pin, database: foreign }), /Not an audit database/);
  const garbage = join(dir, 'garbage.sqlite');
  await writeFile(garbage, 'not a database at all, just bytes '.repeat(200), { mode: 0o600 });
  await assert.rejects(createAudit({ projectSha256: pin, database: garbage }));
  assert.equal((await readFile(garbage, 'utf8')).startsWith('not a database'), true, 'a refused file is left untouched');
});

test('a closed audit refuses a late attachment', async t => {
  const { audit } = await activeAudit(t);
  await audit.close();
  assert.throws(() => audit.exports.attach({ source: 'late', peek: async () => [], ack: async () => {} }), (error: unknown) => error instanceof AuditError && error.code === 'audit_unavailable');
});
