// The store as the second audit producer (a non-SQLite outbox): a collection declared `audit: true` writes one event
// per record write into its own data file, in the same atomic replace, and a real audit drains it from there.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, startServer } from '@jimhoyd/urlcode';
import { defineExtension, inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { ExtensionActivation, ExtensionRequest, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import audit from '@jimhoyd/urlcode-audit/extension';
import { createAudit } from '@jimhoyd/urlcode-audit';
import type { AuditEvent, AuditExports, AuditProducer, AuditStoredEvent } from '@jimhoyd/urlcode-audit';
import store from '../src/extension.ts';
import { AUDIT_BACKLOG, StoreError, createStore } from '../src/index.ts';

const origin = 'https://store-audit.example.test', pin = 'a'.repeat(64);
const notes = {
  mount: '/api/notes', key: 'code', increments: ['clicks'], idempotency: { maxKeys: 10 }, audit: true,
  fields: {
    code: { type: 'string', required: true, maxLength: 32 },
    destination: { type: 'string', required: true, format: 'http-url', maxLength: 256 },
    title: { type: 'string', maxLength: 100 },
    clicks: { type: 'integer', default: 0, minimum: 0 },
  },
};
const plain = { mount: '/api/plain', fields: { title: { type: 'string', required: true, maxLength: 100 } } };

async function tempRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'store-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function withSha(t: TestContext, sha: string): void {
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = sha;
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
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
/** Reads the audit exports the way any extension that `uses` audit would, so the test can query the log. */
function probe(seen: { audit?: AuditExports | undefined }) {
  return defineExtension({
    name: 'probe', description: 'Reads the audit exports for the test', uses: ['audit'], schema: { type: 'object' },
    host(ctx) {
      seen.audit = ctx.get<AuditExports | undefined>('audit');
      return { registration: { name: 'probe', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema: { type: 'object' }, activate: () => ({ handle: () => ({ status: 404, headers: [] }) }) } };
    },
  });
}

/** A site whose YAML declares audit (unless `declareAudit` is false), the store with the given collections, and the badge provider. */
async function site(t: TestContext, collections: Record<string, unknown>, declareAudit = true) {
  const root = await tempRoot(t), project = join(root, 'app');
  await mkdir(project);
  const guarded = { policies: { extensions: { badge: {} } } };
  const routes: Record<string, unknown> = {};
  for (const spec of Object.values(collections) as { mount: string }[]) routes[`${spec.mount}/*`] = { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], ...guarded };
  if (collections.notes) routes['/go/*'] = { extension: 'store', methods: ['GET', 'HEAD'] };
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1',
    extensions: { badge: { version: '1', config: {} }, ...(declareAudit ? { audit: { version: '1', config: { retention: 1000 } } } : {}), store: { version: '1', config: { collections, ...(collections.notes ? { shortLinks: { public: { mount: '/go', collection: 'notes', destination: 'destination', clicks: 'clicks' } } } : {}) } } },
    routes }));
  const sha = await inspectExtensionRevision(project);
  withSha(t, sha);
  return { root, project, sha, hostUrl: pathToFileURL(join(root, 'host.mjs')) };
}

async function serve(t: TestContext, collections: Record<string, unknown>) {
  const { root, project, sha, hostUrl } = await site(t, collections);
  const seen: { audit?: AuditExports | undefined } = {};
  const host = await composeHost(hostUrl, [store(), audit(), probe(seen)()]);
  t.after(() => host.close?.());
  assert.deepEqual(host.extensions!.map(extension => extension.name), ['audit', 'probe', 'store'], 'audit is hosted before the store that uses it');
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: [...host.extensions!, badge(sha)] });
  t.after(() => app.close());
  const call = (path: string, init: { method?: string; body?: unknown; who?: string; headers?: Record<string, string> } = {}) => fetch(`http://127.0.0.1:${app.address.port}${path}`, {
    method: init.method ?? 'GET', redirect: 'manual',
    headers: { origin, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.who ? { authorization: `Badge ${init.who}` } : {}), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { root, call, audit: seen.audit! };
}
async function storeEvents(exports: AuditExports): Promise<AuditStoredEvent[]> {
  await exports.flush();
  return [...(await exports.query({ source: 'store', limit: 100 })).events];
}
const fileOf = (root: string, name = 'notes') => join(root, 'data', 'store', `${name}.json`);
const stored = async (root: string, name = 'notes') => JSON.parse(await readFile(fileOf(root, name), 'utf8')) as { records: unknown[]; audit?: AuditEvent[] };

test('every write kind emits one event naming the changed fields only; an idempotent replay emits nothing', async t => {
  const { root, call, audit: log } = await serve(t, { notes, plain });
  const secret = 'Private title words';
  const created = await call('/api/notes', { method: 'POST', who: 'alice', headers: { 'idempotency-key': 'create-1' }, body: { code: 'first', destination: 'https://example.test/one', title: secret } });
  assert.equal(created.status, 201);
  const { id } = await created.json() as { id: string };
  const replay = await call('/api/notes', { method: 'POST', who: 'alice', headers: { 'idempotency-key': 'create-1' }, body: { code: 'first', destination: 'https://example.test/one', title: secret } });
  assert.equal(replay.status, 409, 'the replay is refused');
  let etag = created.headers.get('etag')!;
  const put = await call(`/api/notes/${id}`, { method: 'PUT', who: 'bob', headers: { 'if-match': etag }, body: { code: 'first', destination: 'https://example.test/two', title: secret } });
  assert.equal(put.status, 200); etag = put.headers.get('etag')!;
  const patch = await call(`/api/notes/${id}`, { method: 'PATCH', who: 'alice', headers: { 'if-match': etag }, body: { title: null } });
  assert.equal(patch.status, 200);
  assert.equal((await call(`/api/notes/${id}/increment/clicks`, { method: 'POST', who: 'carol' })).status, 200);
  assert.equal((await call('/go/first')).status, 302, 'the short-link redirect counts a click, unaudited');
  const latest = await call(`/api/notes/${id}`, { who: 'alice' });
  assert.equal((await call(`/api/notes/${id}`, { method: 'DELETE', who: 'alice', headers: { 'if-match': latest.headers.get('etag')! } })).status, 204);
  assert.equal((await call('/api/plain', { method: 'POST', who: 'alice', body: { title: 'not audited' } })).status, 201);

  const events = await storeEvents(log);
  assert.deepEqual(events.map(event => [event.action, event.actor]), [
    ['store.record.created', 'alice'], ['store.record.replaced', 'bob'], ['store.record.updated', 'alice'],
    ['store.record.incremented', 'carol'], ['store.record.deleted', 'alice'],
  ], 'one event per write, none for the replay, the anonymous short-link click or the unaudited collection');
  assert.ok(events.every(event => event.source === 'store' && event.subject === `notes/${id}`));
  assert.deepEqual(events.map(event => event.metadata), [
    { collection: 'notes', fields: ['code', 'destination', 'title', 'clicks'] },
    { collection: 'notes', fields: ['destination'] },
    { collection: 'notes', fields: ['title'] },
    { collection: 'notes', fields: ['clicks'] },
    { collection: 'notes', fields: ['code', 'destination', 'clicks'] },
  ]);
  const text = JSON.stringify(events);
  for (const value of [secret, 'example.test', 'first']) assert.ok(!text.includes(value), `no value reaches the log: ${value}`);
  assert.equal((await stored(root)).audit, undefined, 'the drained outbox is acked out of the data file');
  assert.equal((await stored(root, 'plain')).audit, undefined);
});

/** A store over a real (active) audit whose drain never runs for the store: what a process killed before draining leaves. */
async function stalled(t: TestContext, root: string) {
  const log = await createAudit({ projectSha256: pin, database: join(root, 'audit.sqlite') });
  t.after(() => log.close());
  await log.registration.activate({}, { origin, target: 'node', projectSha256: pin, mounts: [], root });
  const exports: AuditExports = { ...log.exports, get active() { return log.exports.active; }, validate: value => log.exports.validate(value), attach: () => ({ notify() {}, async close() {} }) };
  return { log, exports };
}
function activation(root: string, mounts = ['/api/notes', '/go']): ExtensionActivation {
  return { origin, target: 'node', projectSha256: pin, mounts, principalMounts: mounts.filter(mount => mount !== '/go'), root: join(root, 'app') };
}
const config = { collections: { notes }, shortLinks: { public: { mount: '/go', collection: 'notes', destination: 'destination', clicks: 'clicks' } } };

test('at the backlog cap a write is refused 503 audit_backlog and the data file is unchanged', async t => {
  const root = await tempRoot(t), directory = join(root, 'data');
  await mkdir(join(root, 'app')); await mkdir(directory);
  const { exports } = await stalled(t, root);
  const pending = Array.from({ length: AUDIT_BACKLOG }, () => exports.validate({ id: randomUUID(), source: 'store', action: 'store.record.created', actor: 'alice', subject: `notes/${randomUUID()}`, at: Date.now(), metadata: { collection: 'notes', fields: ['code'] } }));
  await writeFile(join(directory, 'notes.json'), JSON.stringify({ version: 2, records: [], idempotency: [], audit: pending }));
  const before = await readFile(join(directory, 'notes.json'));
  const instance = createStore({ directory, projectSha256: pin, audit: exports });
  t.after(() => instance.close());
  const served = await instance.registration.activate(config, activation(root));
  t.after(() => served.close?.());
  await assert.rejects(instance.exports.records('notes').create({ id: 'alice' }, { code: 'late', destination: 'https://example.test/' }), (error: unknown) => error instanceof StoreError && error.status === 503 && error.code === 'audit_backlog');
  assert.deepEqual(await readFile(join(directory, 'notes.json')), before, 'nothing is written');
  assert.equal(instance.exports.records('notes').list(null).total, 0);
});

test('a write between capture and drain survives a kill: a new store and attachment drain it exactly once', async t => {
  const root = await tempRoot(t), directory = join(root, 'data');
  await mkdir(join(root, 'app')); await mkdir(directory);
  const { log, exports } = await stalled(t, root);
  const first = createStore({ directory, projectSha256: pin, audit: exports });
  const served = await first.registration.activate(config, activation(root));
  const records = first.exports.records('notes');
  for (const code of ['a', 'b', 'c']) await records.create({ id: 'alice' }, { code, destination: 'https://example.test/' });
  // The "kill": the store stops with its events captured in the file and never drained.
  await served.close?.(); await first.close();
  assert.equal(JSON.parse(await readFile(join(directory, 'notes.json'), 'utf8')).audit.length, 3);
  assert.equal((await log.exports.query({ source: 'store' })).events.length, 0);

  for (const round of [1, 2]) {
    const next = createStore({ directory, projectSha256: pin, audit: log.exports });
    const again = await next.registration.activate(config, activation(root));
    await log.exports.flush();
    const events = (await log.exports.query({ source: 'store' })).events;
    assert.equal(events.length, 3, `round ${round}: every captured event is stored once`);
    assert.equal(new Set(events.map(event => event.id)).size, 3);
    assert.equal(JSON.parse(await readFile(join(directory, 'notes.json'), 'utf8')).audit, undefined);
    await again.close?.(); await next.close();
  }
});

test('the producer peeks the oldest events across collections, so a flush never settles past an older one', async t => {
  const root = await tempRoot(t), directory = join(root, 'data');
  await mkdir(join(root, 'app')); await mkdir(directory);
  const { exports } = await stalled(t, root);
  let producer: AuditProducer | undefined;
  const capturing: AuditExports = { ...exports, get active() { return exports.active; }, attach: attached => { producer = attached; return { notify() {}, async close() {} }; } };
  const at = Date.now();
  const pending = (name: string, count: number, from: number) => Array.from({ length: count }, (_, index) => exports.validate({ id: randomUUID(), source: 'store', action: 'store.record.created', actor: 'alice', subject: `${name}/${randomUUID()}`, at: from + index, metadata: { collection: name, fields: ['title'] } }));
  await writeFile(join(directory, 'alpha.json'), JSON.stringify({ version: 2, records: [], idempotency: [], audit: pending('alpha', 120, at + 1000) }));
  await writeFile(join(directory, 'beta.json'), JSON.stringify({ version: 2, records: [], idempotency: [], audit: pending('beta', 5, at) }));
  const instance = createStore({ directory, projectSha256: pin, audit: capturing });
  t.after(() => instance.close());
  const collections = { alpha: { ...plain, mount: '/api/alpha', audit: true }, beta: { ...plain, mount: '/api/beta', audit: true } };
  const served = await instance.registration.activate({ collections }, activation(root, ['/api/alpha', '/api/beta']));
  t.after(() => served.close?.());
  const batch = await producer!.peek(100);
  assert.equal(batch.length, 100);
  assert.deepEqual(batch.slice(0, 5).map(event => event.subject.split('/')[0]), ['beta', 'beta', 'beta', 'beta', 'beta'], 'the older collection comes first');
  assert.ok(batch.every((event, index) => index === 0 || batch[index - 1]!.at <= event.at));
});

test('audit: true refuses a collection mount no principal-providing policy guards', async t => {
  const root = await tempRoot(t), directory = join(root, 'data');
  await mkdir(join(root, 'app')); await mkdir(directory);
  const { exports } = await stalled(t, root);
  const instance = createStore({ directory, projectSha256: pin, audit: exports });
  t.after(() => instance.close());
  const unguarded = { ...activation(root), principalMounts: [] };
  await assert.rejects(Promise.resolve().then(() => instance.registration.activate(config, unguarded)), /Collection notes: audit: true needs route \/api\/notes\/\* guarded by a principal-providing policy/);
});

test('audit: true refuses activation without an active audit; the store runs without audit when nothing opts in', async t => {
  // Absent: audit is not in host.mjs at all.
  const absent = await site(t, { notes }, false);
  const bare = await composeHost(absent.hostUrl, [store()]);
  t.after(() => bare.close?.());
  await assert.rejects(createRuntime(absent.project, { origin, extensions: [...bare.extensions!, badge(absent.sha)] }), /collection notes declares audit: true; install the audit extension \(urlcode extensions add audit\)/);
  // Hosted but not declared in the project, so never activated.
  const undeclared = await site(t, { notes }, false);
  const hosted = await composeHost(undeclared.hostUrl, [store(), audit()]);
  t.after(() => hosted.close?.());
  await assert.rejects(createRuntime(undeclared.project, { origin, extensions: [...hosted.extensions!, badge(undeclared.sha)] }), /collection notes declares audit: true/);
  // No collection opts in: the store serves with audit absent.
  const quiet = await site(t, { plain }, false);
  const without = await composeHost(quiet.hostUrl, [store()]);
  t.after(() => without.close?.());
  const runtime = await createRuntime(quiet.project, { origin, extensions: [...without.extensions!, badge(quiet.sha)] });
  t.after(() => runtime.close?.());
});

test('events left in a file are kept when audit is later absent, and a write keeps them', async t => {
  const root = await tempRoot(t), directory = join(root, 'data');
  await mkdir(join(root, 'app')); await mkdir(directory);
  const { exports } = await stalled(t, root);
  const first = createStore({ directory, projectSha256: pin, audit: exports });
  const served = await first.registration.activate(config, activation(root));
  await first.exports.records('notes').create({ id: 'alice' }, { code: 'kept', destination: 'https://example.test/' });
  await served.close?.(); await first.close();
  const unaudited = createStore({ directory, projectSha256: pin });
  const again = await unaudited.registration.activate({ ...config, collections: { notes: { ...notes, audit: false } } }, activation(root));
  t.after(() => again.close?.());
  await unaudited.exports.records('notes').create({ id: 'alice' }, { code: 'plain', destination: 'https://example.test/' });
  const file = JSON.parse(await readFile(join(directory, 'notes.json'), 'utf8')) as { records: unknown[]; audit: AuditEvent[] };
  assert.equal(file.records.length, 2);
  assert.deepEqual(file.audit.map(event => event.action), ['store.record.created'], 'the undelivered event is kept; the unaudited write adds none');
});
