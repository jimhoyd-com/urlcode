import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { assignOwnerless, deleteOwnerless, reportOwnerless, storeExtension } from '../src/index.ts';

// urlcode#331: per-record ownership. The principal provider here is a synthetic "badge" extension, not auth, so the
// store is proven against core's generic principal contract rather than one first-party pair: `Badge <id>` sets the
// principal, `Badge-anon` is allowed without one, anything else is a 401 from the provider itself.
const origin = 'https://owned.example.test';
const json = { 'content-type': 'application/json' };
const notes = { mount: '/api/notes', fields: { title: { type: 'string', required: true, maxLength: 40 }, votes: { type: 'integer', default: 0 } }, increments: ['votes'], idempotency: { maxKeys: 10 }, maxRecords: 50, ownership: 'owner' };

async function badge(project: string, provides = true): Promise<RuntimeExtension> {
  return {
    name: 'badge', version: '1', projectSha256: await inspectExtensionRevision(project), targets: ['node'], ...(provides ? { providesPrincipal: true } : {}),
    schema: { type: 'object', additionalProperties: false }, policySchema: { type: 'object', additionalProperties: false },
    activate() {
      return {
        handle() { return { status: 404, headers: [] }; },
        authorize(_policy: unknown, request: ExtensionRequest) {
          const value = request.headers.get('authorization') ?? '';
          if (value === 'Badge-anon') return undefined;
          const match = /^Badge (\S+)$/.exec(value);
          if (!match) return { status: 401, headers: [['content-type', 'text/plain']], body: 'no badge' };
          request.setPrincipal!({ id: match[1]! });
          return undefined;
        },
      };
    },
  };
}

interface Boot { collection?: object; policy?: object | null; provides?: boolean; seed?: object[]; extraCollections?: Record<string, object>; extraRoutes?: Record<string, unknown> }
async function boot(t: TestContext, options: Boot = {}) {
  const root = await mkdtemp(join(tmpdir(), 'store-owned-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), data = join(root, 'data');
  await mkdir(project); await mkdir(data);
  if (options.seed) await writeFile(join(data, 'notes.json'), JSON.stringify({ version: 2, records: options.seed, idempotency: [] }));
  const policy = options.policy === undefined ? { policies: { extensions: { badge: {} } } } : options.policy === null ? {} : options.policy;
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1',
    extensions: { badge: { version: '1', config: {} }, store: { version: '1', config: { collections: { notes: options.collection ?? notes, ...options.extraCollections } } } },
    routes: { '/api/notes/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], ...policy }, ...options.extraRoutes } }));
  const projectSha256 = await inspectExtensionRevision(project);
  const start = async () => startServer({ project, origin, port: 0, log: () => {}, extensions: [await badge(project, options.provides ?? true), storeExtension({ directory: data, projectSha256 })] });
  return { root, project, data, start };
}
async function running(t: TestContext, options: Boot = {}) {
  const booted = await boot(t, options);
  let app = await booted.start(), open = true;
  t.after(async () => { if (open) await app.close(); });
  const as = (who: string | null) => (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(`http://127.0.0.1:${app.address.port}${path}`, { ...init, headers: { ...(who === null ? {} : { authorization: who === 'anon' ? 'Badge-anon' : `Badge ${who}` }), ...init.headers } });
  const create = async (who: string, title: string) => {
    const response = await as(who)('/api/notes', { method: 'POST', headers: json, body: JSON.stringify({ title }) });
    assert.equal(response.status, 201);
    return await response.json() as Record<string, unknown> & { id: string };
  };
  const stored = async () => JSON.parse(await readFile(join(booted.data, 'notes.json'), 'utf8')) as { records: Record<string, unknown>[] };
  return { ...booted, as, create, stored, stop: async () => { open = false; await app.close(); }, restart: async () => { await app.close(); app = await booted.start(); } };
}
const legacy = (title: string) => { const now = new Date().toISOString(); return { id: randomUUID(), createdAt: now, updatedAt: now, title, votes: 0 }; };

test('create stamps the principal as owner; the owner never appears in a response', async t => {
  const { create, as, stored } = await running(t);
  const note = await create('alice', 'mine');
  assert.equal(Object.hasOwn(note, '_owner'), false);
  const read = await (await as('alice')(`/api/notes/${note.id}`)).json() as Record<string, unknown>;
  assert.deepEqual(read, note);
  const list = await (await as('alice')('/api/notes')).json() as { items: Record<string, unknown>[]; total: number };
  assert.equal(list.total, 1); assert.equal(Object.hasOwn(list.items[0]!, '_owner'), false);
  assert.equal((await stored()).records[0]!._owner, 'alice');
});

test('another principal cannot list, read, replace, patch, increment or delete a record: every answer is the missing-record 404', async t => {
  const { create, as, stored, restart } = await running(t);
  const a1 = await create('alice', 'a1'), a2 = await create('alice', 'a2'), b1 = await create('bob', 'b1');
  const bob = as('bob'), alice = as('alice');
  const bobList = await (await bob('/api/notes')).json() as { items: { id: string }[]; total: number };
  assert.equal(bobList.total, 1); assert.deepEqual(bobList.items.map(item => item.id), [b1.id]);
  // Paging one record at a time through bob's view never reaches alice's records either.
  const page = await (await bob('/api/notes?limit=1')).json() as { items: { id: string }[]; total: number; next?: number };
  assert.equal(page.total, 1); assert.equal(page.next, undefined);
  const aliceList = await (await alice('/api/notes')).json() as { items: { id: string }[]; total: number };
  assert.deepEqual(aliceList.items.map(item => item.id), [a1.id, a2.id]); assert.equal(aliceList.total, 2);
  const missing = await bob(`/api/notes/${randomUUID()}`);
  const missingBody = await missing.text();
  const etag = (await alice(`/api/notes/${a1.id}`)).headers.get('etag')!;
  const attempts: [string, { method?: string; headers?: Record<string, string>; body?: string }][] = [
    [`/api/notes/${a1.id}`, {}],
    [`/api/notes/${a1.id}`, { method: 'HEAD' }],
    [`/api/notes/${a1.id}`, { method: 'PUT', headers: json, body: JSON.stringify({ title: 'stolen' }) }],
    [`/api/notes/${a1.id}`, { method: 'PUT', headers: { ...json, 'if-match': etag }, body: JSON.stringify({ title: 'stolen' }) }],
    [`/api/notes/${a1.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ title: 'stolen' }) }],
    [`/api/notes/${a1.id}`, { method: 'PATCH', headers: { ...json, 'if-match': '"00000000000000000000000000000000"' }, body: JSON.stringify({ title: 'stolen' }) }],
    [`/api/notes/${a1.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ nope: 1 }) }],
    [`/api/notes/${a1.id}/increment/votes`, { method: 'POST' }],
    [`/api/notes/${a1.id}`, { method: 'DELETE' }],
    [`/api/notes/${a1.id}`, { method: 'DELETE', headers: { 'if-match': etag } }],
  ];
  for (const [path, init] of attempts) {
    const response = await bob(path, init);
    assert.equal(response.status, 404, `${init.method ?? 'GET'} ${JSON.stringify(init.headers ?? {})}`);
    if (init.method !== 'HEAD') assert.equal(await response.text(), missingBody, 'byte-identical to a missing id');
  }
  const before = (await stored()).records.find(record => record.id === a1.id);
  assert.deepEqual(before, { ...a1, _owner: 'alice' }, 'alice\'s record is unchanged on disk');
  // The owner survives a restart, and so does the denial.
  await restart();
  assert.equal((await as('bob')(`/api/notes/${a1.id}`)).status, 404);
  assert.equal((await as('alice')(`/api/notes/${a1.id}`)).status, 200);
  // The owner's own mutations still work.
  assert.equal((await as('alice')(`/api/notes/${a1.id}/increment/votes`, { method: 'POST' })).status, 200);
  assert.equal((await as('alice')(`/api/notes/${a2.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await stored()).records.find(record => record.id === a1.id)!._owner, 'alice');
});

test('a client can neither set nor change the owner', async t => {
  const { create, as, stored } = await running(t);
  const forged = await as('mallory')('/api/notes', { method: 'POST', headers: json, body: JSON.stringify({ title: 'x', _owner: 'alice' }) });
  assert.equal(forged.status, 400);
  assert.deepEqual(((await forged.json()) as { error: { fields: Record<string, string> } }).error.fields, { _owner: 'is not a declared field' });
  const note = await create('alice', 'mine');
  for (const method of ['PUT', 'PATCH']) {
    const moved = await as('alice')(`/api/notes/${note.id}`, { method, headers: json, body: JSON.stringify({ title: 'moved', _owner: 'bob' }) });
    assert.equal(moved.status, 400, method);
  }
  // A full round trip of what the owner read (no owner in it) keeps the stamped owner.
  const read = await (await as('alice')(`/api/notes/${note.id}`)).json() as Record<string, unknown>;
  assert.equal((await as('alice')(`/api/notes/${note.id}`, { method: 'PUT', headers: json, body: JSON.stringify({ ...read, title: 'renamed' }) })).status, 200);
  const records = (await stored()).records;
  assert.equal(records.length, 1); assert.equal(records[0]!._owner, 'alice'); assert.equal(records[0]!.title, 'renamed');
  assert.equal((await (await as('bob')('/api/notes')).json() as { total: number }).total, 0);
});

test('a request that reaches an owned collection without a principal is refused before any data is touched', async t => {
  const { create, as, stored } = await running(t);
  const note = await create('alice', 'mine');
  // The provider allowed the request but set no principal: the store refuses rather than falling back to shared.
  for (const [path, init] of [['/api/notes', {}], [`/api/notes/${note.id}`, {}], ['/api/notes', { method: 'POST', headers: json, body: JSON.stringify({ title: 'x' }) }], [`/api/notes/${note.id}`, { method: 'DELETE' }], [`/api/notes/${note.id}/increment/votes`, { method: 'POST' }]] as const) {
    const response = await as('anon')(path, init);
    assert.equal(response.status, 401, `${(init as { method?: string }).method ?? 'GET'} ${path}`);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'principal_required');
  }
  // With no credential at all, the provider's own policy answers first.
  assert.equal((await as(null)('/api/notes')).status, 401);
  assert.equal((await stored()).records.length, 1);
});

test('activation refuses an owned collection on a mount without a principal-providing policy, and a key on an owned collection', async t => {
  const unguarded = await boot(t, { policy: null });
  await assert.rejects(unguarded.start(), /ownership: owner needs route \/api\/notes\/\* guarded by a principal-providing policy/);
  const notProviding = await boot(t, { provides: false });
  await assert.rejects(notProviding.start(), /ownership: owner needs route/);
  const keyed = await boot(t, { collection: { ...notes, key: 'title', fields: { ...notes.fields, title: { type: 'string', required: true, maxLength: 40 } } } });
  await assert.rejects(keyed.start(), /key is not supported with ownership: owner/);
});

test('legacy records without an owner are served to nobody until the operator assigns or deletes them', async t => {
  const old1 = legacy('old-1'), old2 = legacy('old-2');
  const { as, create, stop, start, data, stored } = await running(t, { seed: [old1, old2] });
  const mine = await create('alice', 'new');
  for (const who of ['alice', 'bob']) {
    const list = await (await as(who)('/api/notes')).json() as { items: { id: string }[]; total: number };
    assert.deepEqual(list.items.map(item => item.id), who === 'alice' ? [mine.id] : [], who);
    assert.equal((await as(who)(`/api/notes/${old1.id}`)).status, 404);
    assert.equal((await as(who)(`/api/notes/${old1.id}`, { method: 'DELETE' })).status, 404);
  }
  // The operator step refuses while the server holds the directory.
  await assert.rejects(reportOwnerless(data, 'notes'), /in use|already locked/);
  await stop();
  assert.deepEqual(await reportOwnerless(data, 'notes'), { collection: 'notes', records: 3, ownerless: 2, ids: [old1.id, old2.id] });
  await assert.rejects(assignOwnerless(data, 'notes', 'not an id'), /Owner must be a principal id/);
  // The shipped CLI reports the same thing.
  const cli = await promisify(execFile)(process.execPath, ['--conditions=development', join(import.meta.dirname, '..', 'src', 'cli.ts'), 'ownerless', '--directory', data, '--collection', 'notes']);
  assert.equal((JSON.parse(cli.stdout) as { ownerless: number }).ownerless, 2);
  const assigned = await assignOwnerless(data, 'notes', 'alice');
  assert.deepEqual(assigned.ids, [old1.id, old2.id]);
  assert.deepEqual((await stored()).records.map(record => record._owner), ['alice', 'alice', 'alice']);
  assert.equal((await reportOwnerless(data, 'notes')).ownerless, 0);
  const app = await start();
  try {
    const list = await (await fetch(`http://127.0.0.1:${app.address.port}/api/notes`, { headers: { authorization: 'Badge alice' } })).json() as { total: number };
    assert.equal(list.total, 3);
  } finally { await app.close(); }
});

test('the operator can delete legacy records instead', async t => {
  const old = legacy('old');
  const { data } = await boot(t, { seed: [old, { ...legacy('owned'), _owner: 'bob' }] });
  const removed = await deleteOwnerless(data, 'notes');
  assert.deepEqual(removed.ids, [old.id]);
  const records = (JSON.parse(await readFile(join(data, 'notes.json'), 'utf8')) as { records: Record<string, unknown>[] }).records;
  assert.equal(records.length, 1); assert.equal(records[0]!._owner, 'bob');
});

test('a collection holding owned records refuses to activate as shared, and a malformed owner refuses to load', async t => {
  const { ownership: _ownership, ...shared } = notes;
  const downgraded = await boot(t, { collection: shared, seed: [{ ...legacy('owned'), _owner: 'alice' }] });
  await assert.rejects(downgraded.start(), /holds owned records but the collection is not declared with ownership: owner/);
  const malformed = await boot(t, { seed: [{ ...legacy('owned'), _owner: 'alice@example.com' }] });
  await assert.rejects(malformed.start(), /invalid record owner/);
});

test('idempotency keys are scoped per principal on an owned collection', async t => {
  const { as } = await running(t);
  const post = (who: string) => as(who)('/api/notes', { method: 'POST', headers: { ...json, 'idempotency-key': 'same-key' }, body: JSON.stringify({ title: who }) });
  assert.equal((await post('alice')).status, 201);
  assert.equal((await post('bob')).status, 201, 'bob is not told alice used this key');
  assert.equal((await post('alice')).status, 409);
});

test('shared collections are unchanged: every caller sees every record and nothing is stamped', async t => {
  const { ownership: _ownership, ...shared } = notes;
  const { as, create, stored } = await running(t, { collection: shared });
  const note = await create('alice', 'team');
  assert.equal((await as('bob')(`/api/notes/${note.id}`)).status, 200);
  assert.equal((await as('anon')('/api/notes')).status, 200);
  assert.equal((await as('bob')(`/api/notes/${note.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ title: 'edited' }) })).status, 200);
  assert.equal(Object.hasOwn((await stored()).records[0]!, '_owner'), false);
  // An unguarded shared mount still activates.
  const open = await boot(t, { collection: shared, policy: null });
  const app = await open.start();
  await app.close();
});
