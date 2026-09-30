import { cleanup } from './cleanup.ts';
// The store's audit log (#1052): a collection declared `audit: true` records one event per record write in the store
// database, in the same transaction as the record, pruned to `auditRetention`; `StoreExports.audit` is its query and
// its tap, which a sink named `audit` (or anything else) pulls to forward events, with core's types only.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '@jimhoyd/urlcode';
import { AuditError, defineExtension, inspectExtensionRevision, validateAuditEvent } from '@jimhoyd/urlcode/extensions';
import type { AuditStoredEvent, AuditTap, ExtensionActivation, ExtensionRequest, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import store from '../src/extension.ts';
import { STORE_SCHEMA_VERSION, StoreError, createStore } from '../src/index.ts';
import type { StoreExports } from '../src/index.ts';
import { auditEvents, counts, execute, initialize, records } from './rows.ts';

const origin = 'https://store-audit.example.test', pin = 'a'.repeat(64);
const notes = {
  mount: '/api/notes', key: 'code', increments: ['clicks'], idempotency: { maxKeys: 10 }, audit: true,
  schema: { type: 'object', additionalProperties: false, required: ['code', 'destination'], properties: { code: { type: 'string', maxLength: 32 }, destination: { type: 'string', format: 'uri', maxLength: 256 }, title: { type: 'string', maxLength: 100 }, clicks: { type: 'integer', minimum: 0 } } }, defaults: { clicks: 0 },
};
const plain = { mount: '/api/plain', schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 100 } } } };

async function tempRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'store-audit-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  return root;
}
function withSha(t: TestContext, sha: string): void {
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = sha;
  cleanup(t, () => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
}
/** `Authorization: Badge <id>` sets the principal; no header leaves the request anonymous. */
function badge(projectSha256: string): RuntimeExtension {
  return {
    name: 'badge', version: '1', projectSha256, targets: ['node'], providesPrincipal: true,
    schema: { type: 'object', additionalProperties: false }, policySchema: { type: 'object', additionalProperties: false },
    activate() {
      return {
        handle() { return { status: 404, headers: [] }; },
        authorize(_policy: unknown, request: ExtensionRequest) {
          const match = /^Badge (\S+)$/.exec(request.headers.get('authorization') ?? '');
          if (match) request.setPrincipal!({ id: match[1]! });
          return undefined;
        },
      };
    },
  };
}

/**
 * The conformance sink (#1052, "name is the role"): an independent extension named `audit` that consumes the store's
 * tap and forwards each event to its own destination (here an array standing in for a file), written against core's
 * types only: nothing from the store package or any first-party audit package. `forward()` is one round: peek, write,
 * then ack, so a crash between the two re-delivers and the sink deduplicates on id.
 */
function sink(forwarded: AuditStoredEvent[], rounds: { forward?: () => Promise<number> }) {
  return defineExtension({
    name: 'audit', description: 'Forwards the store audit log to another destination', contract: 2, targets: ['node'], requires: ['store'],
    schema: { type: 'object', additionalProperties: false },
    host(ctx) {
      const tap = ctx.get<{ audit: AuditTap }>('store').audit;
      const seen = new Set<string>();
      rounds.forward = async () => {
        const batch = await tap.peek(100);
        for (const event of batch) if (!seen.has(event.id)) { seen.add(event.id); forwarded.push(event); }
        return tap.ack(batch.map(event => event.id));
      };
      return { registration: { name: 'audit', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema: { type: 'object', additionalProperties: false }, activate: () => ({ handle: () => ({ status: 404, headers: [] }) }) } };
    },
  });
}

/** A served site: the badge provider, the store with the given collections, and the audit sink. */
async function serve(t: TestContext, collections: Record<string, unknown>) {
  const root = await tempRoot(t), project = join(root, 'app');
  await mkdir(project);
  const guarded = { policies: { extensions: { badge: {} } } };
  const routes: Record<string, unknown> = {};
  for (const spec of Object.values(collections) as { mount: string }[]) routes[`${spec.mount}/*`] = { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], ...guarded };
  if (collections.notes) routes['/go/*'] = { extension: 'store', methods: ['GET', 'HEAD'] };
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1',
    extensions: { badge: { version: '1', config: {} }, audit: { version: '1', config: {} }, store: { version: '1', config: { collections, ...(collections.notes ? { shortLinks: { public: { mount: '/go', collection: 'notes', destination: 'destination', clicks: 'clicks' } } } : {}) } } },
    routes }));
  const sha = await inspectExtensionRevision(project);
  withSha(t, sha);
  const forwarded: AuditStoredEvent[] = [], rounds: { forward?: () => Promise<number> } = {};
  const host = await composeHost(pathToFileURL(join(root, 'host.mjs')), [sink(forwarded, rounds)(), store()]);
  cleanup(t, () => host.close?.());
  assert.deepEqual(host.extensions!.map(extension => extension.name), ['store', 'audit'], 'the store is hosted before the sink that requires it');
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: [...host.extensions!, badge(sha)] });
  cleanup(t, () => app.close());
  const call = (path: string, init: { method?: string; body?: unknown; who?: string; headers?: Record<string, string> } = {}) => fetch(`http://127.0.0.1:${app.address.port}${path}`, {
    method: init.method ?? 'GET', redirect: 'manual',
    headers: { origin, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.who ? { authorization: `Badge ${init.who}` } : {}), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { root, call, forwarded, forward: () => rounds.forward!() };
}
const databaseOf = (root: string) => join(root, 'data', 'store.sqlite');

test('every write kind records one event naming the changed fields only, and a sink named audit forwards them through the tap', async t => {
  const { root, call, forwarded, forward } = await serve(t, { notes, plain });
  const secret = 'Private title words';
  const created = await call('/api/notes', { method: 'POST', who: 'alice', headers: { 'idempotency-key': 'create-1' }, body: { code: 'first', destination: 'https://example.test/one', title: secret } });
  assert.equal(created.status, 201);
  const { id } = await created.json() as { id: string };
  const replay = await call('/api/notes', { method: 'POST', who: 'alice', headers: { 'idempotency-key': 'create-1' }, body: { code: 'first', destination: 'https://example.test/one', title: secret } });
  assert.equal(replay.status, 201, 'the retry replays the first answer');
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  let etag = created.headers.get('etag')!;
  const put = await call(`/api/notes/${id}`, { method: 'PUT', who: 'bob', headers: { 'if-match': etag }, body: { code: 'first', destination: 'https://example.test/two', title: secret } });
  assert.equal(put.status, 200); etag = put.headers.get('etag')!;
  assert.equal((await call(`/api/notes/${id}`, { method: 'PATCH', who: 'alice', headers: { 'if-match': etag }, body: { title: null } })).status, 200);
  assert.equal((await call(`/api/notes/${id}/increment/clicks`, { method: 'POST', who: 'carol' })).status, 200);
  assert.equal((await call('/go/first')).status, 302, 'the short-link redirect counts a click, unaudited');
  const latest = await call(`/api/notes/${id}`, { who: 'alice' });
  assert.equal((await call(`/api/notes/${id}`, { method: 'DELETE', who: 'alice', headers: { 'if-match': latest.headers.get('etag')! } })).status, 204);
  assert.equal((await call('/api/plain', { method: 'POST', who: 'alice', body: { title: 'not audited' } })).status, 201);

  assert.equal(await forward(), 5, 'one round forwards and acknowledges every event');
  assert.equal(await forward(), 0, 'nothing is left to forward');
  assert.deepEqual(forwarded.map(event => [event.action, event.actor]), [
    ['store.record.created', 'alice'], ['store.record.replaced', 'bob'], ['store.record.updated', 'alice'],
    ['store.record.incremented', 'carol'], ['store.record.deleted', 'alice'],
  ], 'one event per write, none for the replay, the anonymous short-link click or the unaudited collection');
  assert.ok(forwarded.every(event => event.source === 'store' && event.subject === `notes/${id}`));
  assert.deepEqual(forwarded.map(event => event.metadata), [
    { collection: 'notes', fields: ['code', 'destination', 'title', 'clicks'] },
    { collection: 'notes', fields: ['destination'] },
    { collection: 'notes', fields: ['title'] },
    { collection: 'notes', fields: ['clicks'] },
    { collection: 'notes', fields: ['code', 'destination', 'clicks'] },
  ]);
  const text = JSON.stringify(forwarded);
  for (const value of [secret, 'example.test', 'first']) assert.ok(!text.includes(value), `no value reaches the log: ${value}`);
  assert.equal(auditEvents(databaseOf(root)).length, 5, 'forwarding keeps the store\'s own log: it is the log of record');
});

function activation(root: string, mounts = ['/api/notes', '/go']): ExtensionActivation {
  return { origin, target: 'node', projectSha256: pin, mounts, principalMounts: mounts.filter(mount => mount !== '/go'), root: join(root, 'app') };
}
const config = { collections: { notes }, shortLinks: { public: { mount: '/go', collection: 'notes', destination: 'destination', clicks: 'clicks' } } };
/** A store over `root/data/store.sqlite`, activated directly with `declared`; both are closed by the test's cleanup. */
async function opened(t: TestContext, root: string, declared: Record<string, unknown> = config): Promise<{ exports: StoreExports; close(): Promise<void> }> {
  const instance = createStore({ database: databaseOf(root), projectSha256: pin });
  const served = await instance.registration.activate(declared, activation(root));
  let open = true;
  const close = async () => { if (open) { open = false; await served.close?.(); await instance.close(); } };
  cleanup(t, close);
  return { exports: instance.exports, close };
}

test('the tap delivers at least once in record order: an unacknowledged event comes back after a restart, an acknowledged one never', async t => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'app'));
  const first = await opened(t, root);
  const tap: AuditTap = first.exports.audit;
  for (const code of ['a', 'b', 'c']) await first.exports.records('notes').create({ id: 'alice' }, { code, destination: 'https://example.test/' });
  const batch = await tap.peek(2);
  assert.deepEqual(batch.map(event => Number(event.seq)), [1, 2], 'oldest first, at most the limit');
  assert.equal(await tap.ack([batch[0]!.id]), 1);
  assert.equal(await tap.ack([batch[0]!.id, '00000000-0000-4000-8000-000000000000']), 0, 'an acknowledged or unknown id is ignored');
  // The "kill": the store stops with b acknowledged by nobody.
  await first.close();
  await assert.rejects(tap.peek(1), (error: unknown) => error instanceof AuditError && error.status === 503 && error.code === 'audit_inactive');
  const second = await opened(t, root);
  const again = await second.exports.audit.peek(100);
  const all = (await second.exports.audit.query()).events;
  assert.equal(all.length, 3, 'the log keeps every event, forwarded or not');
  assert.deepEqual(again.map(event => event.id), [all[1]!.id, all[2]!.id], 'b and c, never a');
  assert.equal(again[0]!.id, batch[1]!.id);
  for (const bad of [0, 101, 1.5]) await assert.rejects(second.exports.audit.peek(bad), { status: 400, code: 'invalid_audit_query' });
  await assert.rejects(second.exports.audit.ack(['not-an-id']), { status: 400, code: 'invalid_audit_query' });
  await assert.rejects(second.exports.audit.query({ limit: 500 }), { status: 400, code: 'invalid_audit_query' });
  for (const event of again) validateAuditEvent({ id: event.id, source: event.source, action: event.action, actor: event.actor, subject: event.subject, at: event.at, ...(event.metadata ? { metadata: event.metadata } : {}) });
});

/** A store activated directly with `auditRetention: 10`, capturing its activation and runtime warnings. */
async function behind(t: TestContext, root: string) {
  const warned: string[] = [], started: string[] = [];
  const instance = createStore({ database: databaseOf(root), projectSha256: pin });
  const served = await instance.registration.activate({ ...config, auditRetention: 10 }, { ...activation(root), warn: message => started.push(message), runtimeWarn: message => warned.push(message) });
  let open = true;
  const close = async () => { if (open) { open = false; await served.close?.(); await instance.close(); } };
  cleanup(t, close);
  let n = 0;
  // Each write is one audited create; the loss check runs in a microtask after its transaction, so settle it too.
  const write = async (count: number) => { for (let i = 0; i < count; i++) { await instance.exports.records('notes').create({ id: 'alice' }, { code: `c${n++}`, destination: 'https://example.test/' }); await new Promise(resolve => setImmediate(resolve)); } };
  return { tap: instance.exports.audit, metrics: () => served.metrics!(), warned, started, write, close };
}

test('a sink behind the retention window is told what it lost: the tap status, the metric and one warning; writes still succeed (#1067)', async t => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'app'));
  const site = await behind(t, root);
  await site.write(15);
  assert.deepEqual(await site.tap.status(), { lost: 0 }, 'with no consumer, pruning is only retention');
  assert.deepEqual(site.metrics(), { audit_pruned_unacked_total: 0 });
  // The sink arrives, reads the whole window and acknowledges only the oldest event.
  const window = await site.tap.peek(100);
  assert.equal(window.length, 10);
  assert.equal(await site.tap.ack([window[0]!.id]), 1);
  await site.write(5);
  assert.deepEqual(await site.tap.status(), { lost: 4 }, 'five events pruned, the acknowledged one not lost');
  assert.deepEqual(site.metrics(), { audit_pruned_unacked_total: 4 });
  assert.equal(site.warned.length, 1, 'exactly one warning when the count first became nonzero');
  assert.match(site.warned[0]!, /audit log: 1 event was pruned \(auditRetention 10\) before the tap's consumer acknowledged them/);
  await site.write(4);
  assert.deepEqual(await site.tap.status(), { lost: 8 });
  assert.equal(site.warned.length, 1, 'growth within a retention window is not warned again');
  assert.equal((await site.tap.peek(100)).length, 10, 'the log still holds its window: no write was refused');
  await site.write(2);
  assert.deepEqual(await site.tap.status(), { lost: 10 });
  assert.equal(site.warned.length, 2, 'a whole retention window lost warns once more');
  assert.match(site.warned[1]!, /audit log: 10 events were pruned/);
  assert.deepEqual(site.started, []);
  // The count is the database's: a restart reports it once at activation, and the metric carries it on.
  await site.close();
  const again = await behind(t, root);
  assert.deepEqual(await again.tap.status(), { lost: 10 });
  assert.deepEqual(again.metrics(), { audit_pruned_unacked_total: 10 });
  assert.equal(again.started.length, 1);
  assert.match(again.started[0]!, /audit log: 10 events were pruned/);
});

test('a sink that keeps up within the retention window loses nothing and hears nothing (#1067)', async t => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'app'));
  const site = await behind(t, root);
  let forwarded = 0;
  for (let round = 0; round < 6; round++) {
    await site.write(5);
    const batch = await site.tap.peek(100);
    forwarded += await site.tap.ack(batch.map(event => event.id));
  }
  assert.equal(forwarded, 30);
  assert.deepEqual(await site.tap.status(), { lost: 0 });
  assert.deepEqual(site.metrics(), { audit_pruned_unacked_total: 0 });
  assert.deepEqual([site.warned, site.started], [[], []]);
});

test('audit: true refuses a collection mount no principal-providing policy guards', async t => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'app'));
  const instance = createStore({ database: databaseOf(root), projectSha256: pin });
  cleanup(t, () => instance.close());
  const unguarded = { ...activation(root), principalMounts: [] };
  await assert.rejects(Promise.resolve().then(() => instance.registration.activate(config, unguarded)), /Collection notes: audit: true needs route \/api\/notes\/\* guarded by a principal-providing policy/);
});

test('recorded events are kept when a collection stops being audited, and an unaudited write adds none', async t => {
  const root = await tempRoot(t), database = databaseOf(root);
  await mkdir(join(root, 'app'));
  const first = await opened(t, root);
  await first.exports.records('notes').create({ id: 'alice' }, { code: 'kept', destination: 'https://example.test/' });
  await first.close();
  const unaudited = await opened(t, root, { ...config, collections: { notes: { ...notes, audit: false } } });
  await unaudited.exports.records('notes').create({ id: 'alice' }, { code: 'plain', destination: 'https://example.test/' });
  assert.equal(records(database, 'notes').length, 2);
  assert.deepEqual(auditEvents(database).map(event => event.action), ['store.record.created']);
});

test('a record write and its audit event commit together: a failure after the record write rolls both back', async t => {
  const root = await tempRoot(t), database = databaseOf(root);
  await mkdir(join(root, 'app'));
  const { exports } = await opened(t, root);
  const notesApi = exports.records('notes');
  const kept = await notesApi.create({ id: 'alice' }, { code: 'kept', destination: 'https://example.test/' });
  const before = { counts: counts(database), records: records(database, 'notes'), audit: auditEvents(database) };
  // The event insert is the last statement of every audited write; failing it proves the record write before it
  // is undone by the same rollback. Injected from outside, as a trigger, so the store code is exactly as shipped.
  execute(database, "CREATE TRIGGER fail_event BEFORE INSERT ON store_audit_events BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  const refused = (error: unknown) => error instanceof StoreError && error.status === 503 && error.code === 'storage_unavailable';
  await assert.rejects(notesApi.create({ id: 'alice' }, { code: 'lost', destination: 'https://example.test/' }), refused);
  await assert.rejects(notesApi.update({ id: 'alice' }, kept.record.id as string, { title: 'changed' }, { ifMatch: kept.etag }), refused);
  assert.deepEqual({ counts: counts(database), records: records(database, 'notes'), audit: auditEvents(database) }, before, 'neither the record nor the event was written');
  assert.equal(notesApi.get({ id: 'alice' }, kept.record.id as string).etag, kept.etag, 'the ETag still matches: nothing changed');
  execute(database, 'DROP TRIGGER fail_event');
  assert.equal((await notesApi.update({ id: 'alice' }, kept.record.id as string, { title: 'changed' }, { ifMatch: kept.etag })).record.title, 'changed');
  assert.deepEqual(auditEvents(database).map(event => event.action), ['store.record.created', 'store.record.updated']);
});

test('the version 7 upgrade moves events still waiting in the old outbox into the log, in order, and drops the outbox', async t => {
  const root = await tempRoot(t), database = databaseOf(root);
  await mkdir(join(root, 'app'));
  await initialize(database);
  // Rewind the fresh file to version 6: the outbox and the drain marker as that release left them, two events waiting.
  const events = ['b', 'a'].map((name, index) => validateAuditEvent({ id: `00000000-0000-4000-8000-00000000000${index + 1}`, source: 'store', action: 'store.record.created', actor: name, subject: `notes/${name}`, at: 1000 - index, metadata: { collection: 'notes', fields: ['code'] } }));
  const db = new DatabaseSync(database);
  try {
    db.exec(`DROP TABLE store_audit_events; DROP TABLE store_audit_tap;
      CREATE TABLE store_audit_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, collection TEXT NOT NULL, at INTEGER NOT NULL, event TEXT NOT NULL CHECK (json_valid(event)));
      CREATE TABLE store_audit_drain(id INTEGER PRIMARY KEY CHECK (id = 1), drained_at INTEGER);
      PRAGMA user_version=6;`);
    for (const event of events) db.prepare('INSERT INTO store_audit_outbox(id, collection, at, event) VALUES (?, ?, ?, ?)').run(event.id, 'notes', event.at, JSON.stringify(event));
  } finally { db.close(); }
  const { exports } = await opened(t, root);
  const page = await exports.audit.query();
  assert.deepEqual(page.events.map(event => [event.actor, event.reason, event.metadata]), [['b', '', { collection: 'notes', fields: ['code'] }], ['a', '', { collection: 'notes', fields: ['code'] }]], 'in outbox order');
  assert.equal((await exports.audit.peek(100)).length, 2, 'not yet forwarded');
  const check = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, STORE_SCHEMA_VERSION);
    assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE name IN ('store_audit_outbox', 'store_audit_drain')").all(), []);
  } finally { check.close(); }
});
