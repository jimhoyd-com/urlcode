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
import { assignOwnerless, deleteOwnerless, reassignOwner, reportOwnerless, storeExtension } from '../src/index.ts';

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

// urlcode#731: a per-owner record limit on an owned collection.
const capped = { ...notes, maxRecords: 5, maxRecordsPerOwner: 2 };
type As = (who: string) => (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;
const post = (as: As, who: string, title: string, headers: Record<string, string> = {}) =>
  as(who)('/api/notes', { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify({ title }) });
const codeOf = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;
const postAt = (port: number, who: string) => fetch(`http://127.0.0.1:${port}/api/notes`, { method: 'POST', headers: { ...json, authorization: `Badge ${who}` }, body: JSON.stringify({ title: 'x' }) });

test('maxRecordsPerOwner stops one principal at its limit while another can still create, without revealing any count', async t => {
  const { as, create, restart } = await running(t, { collection: capped });
  await create('alice', 'a1'); await create('alice', 'a2');
  const refused = await post(as, 'alice', 'a3');
  assert.equal(refused.status, 409);
  const body = await refused.json() as { error: Record<string, unknown> };
  assert.deepEqual(Object.keys(body), ['error']); assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
  assert.equal(body.error.code, 'owner_quota_exceeded');
  assert.doesNotMatch(body.error.message as string, /\d/, 'no count, limit or total in the message');
  await create('bob', 'b1');
  // Deleting frees a slot for that owner only.
  const mine = await (await as('alice')('/api/notes')).json() as { items: { id: string }[] };
  assert.equal((await as('alice')(`/api/notes/${mine.items[0]!.id}`, { method: 'DELETE' })).status, 204);
  await create('alice', 'a3');
  assert.equal(await codeOf(await post(as, 'alice', 'a4')), 'owner_quota_exceeded');
  // The counts are rebuilt from the data file after a restart.
  await restart();
  assert.equal(await codeOf(await post(as, 'alice', 'a5')), 'owner_quota_exceeded');
  await create('bob', 'b2');
  assert.equal(await codeOf(await post(as, 'bob', 'b3')), 'owner_quota_exceeded');
});

test('maxRecords stays the collection-wide ceiling under maxRecordsPerOwner', async t => {
  const { as, create } = await running(t, { collection: capped });
  await create('alice', 'a1'); await create('alice', 'a2'); await create('bob', 'b1'); await create('bob', 'b2'); await create('carol', 'c1');
  const full = await post(as, 'carol', 'c2');
  assert.equal(full.status, 409);
  assert.equal(await codeOf(full), 'collection_full');
  // A principal already at its own limit is told about its own limit.
  assert.equal(await codeOf(await post(as, 'alice', 'a3')), 'owner_quota_exceeded');
});

test('an idempotent replay does not count twice toward the per-owner limit', async t => {
  const { as, create } = await running(t, { collection: capped });
  assert.equal((await post(as, 'alice', 'a1', { 'idempotency-key': 'once' })).status, 201);
  const replay = await post(as, 'alice', 'a1', { 'idempotency-key': 'once' });
  assert.equal(replay.status, 409);
  assert.equal(await codeOf(replay), 'idempotency_duplicate');
  await create('alice', 'a2');
  assert.equal(((await (await as('alice')('/api/notes')).json()) as { total: number }).total, 2);
});

test('legacy ownerless records count toward the collection but no owner, and ownerless-assign updates the counts', async t => {
  const { as, create, stop, start, data } = await running(t, { collection: capped, seed: [legacy('old-1'), legacy('old-2'), legacy('old-3')] });
  await create('alice', 'a1'); await create('alice', 'a2');
  assert.equal(await codeOf(await post(as, 'alice', 'a3')), 'owner_quota_exceeded');
  assert.equal(await codeOf(await post(as, 'bob', 'b1')), 'collection_full', 'the three legacy records still fill the collection');
  await stop();
  // Assigning them to bob puts bob over his limit: activation still succeeds, and bob cannot create more.
  await assignOwnerless(data, 'notes', 'bob');
  const app = await start();
  try { assert.equal(await codeOf(await postAt(app.address.port, 'bob')), 'owner_quota_exceeded'); }
  finally { await app.close(); }
});

test('ownerless-delete frees room for owners after the restart', async t => {
  const { as, create, stop, start, data } = await running(t, { collection: capped, seed: [legacy('old-1'), legacy('old-2'), legacy('old-3')] });
  await create('alice', 'a1'); await create('alice', 'a2');
  assert.equal(await codeOf(await post(as, 'bob', 'b1')), 'collection_full');
  await stop();
  await deleteOwnerless(data, 'notes');
  const app = await start();
  try {
    assert.equal((await postAt(app.address.port, 'bob')).status, 201);
    assert.equal(await codeOf(await postAt(app.address.port, 'alice')), 'owner_quota_exceeded');
  } finally { await app.close(); }
});

test('activation refuses maxRecordsPerOwner on a shared collection and above maxRecords', async t => {
  const { ownership: _ownership, ...shared } = notes;
  const onShared = await boot(t, { collection: { ...shared, maxRecordsPerOwner: 2 } });
  await assert.rejects(onShared.start(), /maxRecordsPerOwner needs ownership: owner/);
  const above = await boot(t, { collection: { ...notes, maxRecords: 5, maxRecordsPerOwner: 6 } });
  await assert.rejects(above.start(), /maxRecordsPerOwner exceeds maxRecords \(5\)/);
  const { maxRecords: _max, ...defaulted } = notes;
  const aboveDefault = await boot(t, { collection: { ...defaulted, maxRecordsPerOwner: 1001 } });
  await assert.rejects(aboveDefault.start(), /maxRecordsPerOwner exceeds maxRecords \(1000\)/);
  const equal = await boot(t, { collection: { ...notes, maxRecords: 5, maxRecordsPerOwner: 5 } });
  const app = await equal.start();
  await app.close();
});

// urlcode#732: moving every record one principal owns to another (a rotated API key's records to its replacement).
const tasks = { mount: '/api/tasks', ownership: 'owner', maxRecords: 20, maxRecordsPerOwner: 3, fields: { title: { type: 'string', required: true, maxLength: 40 } } };
const board = { mount: '/api/board', fields: { title: { type: 'string', required: true, maxLength: 40 } } };
const owned = (title: string, owner: string) => ({ ...legacy(title), _owner: owner });
async function reassignFixture(t: TestContext) {
  const booted = await boot(t, { seed: [owned('n1', 'apikey:old'), owned('n2', 'apikey:old'), owned('n3', 'alice'), legacy('orphan')], extraCollections: { tasks, board } });
  const collections = { notes, tasks, board } as never;
  const write = (name: string, records: object[]) => writeFile(join(booted.data, `${name}.json`), JSON.stringify({ version: 2, records, idempotency: [] }));
  const read = async (name: string) => (JSON.parse(await readFile(join(booted.data, `${name}.json`), 'utf8')) as { records: Record<string, unknown>[] }).records;
  await write('board', [legacy('shared')]);
  return { ...booted, collections, write, read };
}
const cliPath = join(import.meta.dirname, '..', 'src', 'cli.ts');
const runCli = (...args: string[]) => promisify(execFile)(process.execPath, ['--conditions=development', cliPath, ...args]);
const cliFailure = (...args: string[]) => runCli(...args).then(() => null, (error: { code: number; stderr: string }) => error);

test('reassign reports first on --dry-run, then moves only the --from records in owned collections', async t => {
  const { data, collections, write, read } = await reassignFixture(t);
  await write('tasks', [owned('t1', 'apikey:old'), owned('t2', 'bob')]);
  const before = { notes: await read('notes'), tasks: await read('tasks'), board: await read('board') };
  const dry = await reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, dryRun: true });
  assert.deepEqual(dry, { from: 'apikey:old', to: 'alice', dryRun: true, moved: 3, collections: [
    { collection: 'notes', moved: 2, toBefore: 1, toAfter: 3, maxRecordsPerOwner: null },
    { collection: 'tasks', moved: 1, toBefore: 0, toAfter: 1, maxRecordsPerOwner: 3 },
  ] });
  assert.deepEqual({ notes: await read('notes'), tasks: await read('tasks'), board: await read('board') }, before, 'a dry run writes nothing');
  // --collection limits the move to one owned collection.
  const onlyTasks = await reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, collection: 'tasks' });
  assert.equal(onlyTasks.moved, 1); assert.deepEqual(onlyTasks.collections.map(report => report.collection), ['tasks']);
  assert.deepEqual((await read('tasks')).map(record => record._owner), ['alice', 'bob']);
  assert.deepEqual((await read('notes')).map(record => record._owner), ['apikey:old', 'apikey:old', 'alice', undefined]);
  const rest = await reassignOwner(data, { from: 'apikey:old', to: 'alice', collections });
  assert.equal(rest.moved, 2);
  const notesAfter = await read('notes');
  assert.deepEqual(notesAfter.map(record => record._owner), ['alice', 'alice', 'alice', undefined], 'ownerless records stay ownerless');
  assert.deepEqual(notesAfter.map(({ _owner, ...fields }) => fields), before.notes.map(({ _owner, ...fields }) => fields), 'only the owner changes');
  assert.deepEqual(await read('board'), before.board, 'shared collections are never touched');
  // Running it again moves nothing.
  assert.equal((await reassignOwner(data, { from: 'apikey:old', to: 'alice', collections })).moved, 0);
});

test('reassign refuses the whole move, naming the collection, when --to would exceed maxRecordsPerOwner', async t => {
  const { data, collections, write, read } = await reassignFixture(t);
  await write('tasks', [owned('t1', 'apikey:old'), owned('t2', 'apikey:old'), owned('t3', 'alice'), owned('t4', 'alice')]);
  const notesBefore = await read('notes'), tasksBefore = await read('tasks');
  await assert.rejects(reassignOwner(data, { from: 'apikey:old', to: 'alice', collections }), /Nothing was moved: collection tasks would give alice 4 records, over its maxRecordsPerOwner of 3/);
  await assert.rejects(reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, dryRun: true }), /collection tasks/);
  assert.deepEqual(await read('notes'), notesBefore, 'notes, which had room, was not moved either');
  assert.deepEqual(await read('tasks'), tasksBefore);
  // Exactly at the limit is allowed.
  await write('tasks', [owned('t1', 'apikey:old'), owned('t3', 'alice'), owned('t4', 'alice')]);
  assert.equal((await reassignOwner(data, { from: 'apikey:old', to: 'alice', collections })).moved, 3);
  assert.deepEqual((await read('tasks')).map(record => record._owner), ['alice', 'alice', 'alice']);
});

test('reassign validates both principal ids and the collection, and refuses while the server holds the directory', async t => {
  const { data, collections } = await reassignFixture(t);
  for (const [from, to, pattern] of [['not an id', 'alice', /--from must be a principal id/], ['apikey:old', 'alice@example.com', /--to must be a principal id/], ['', 'alice', /--from must be/], ['alice', 'alice', /same principal/]] as const)
    await assert.rejects(reassignOwner(data, { from, to, collections }), pattern);
  await assert.rejects(reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, collection: 'board' }), /Collection board is not declared with ownership: owner/);
  await assert.rejects(reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, collection: 'missing' }), /Collection missing is not declared/);
  await assert.rejects(reassignOwner(data, { from: 'apikey:old', to: 'alice', collections: { board } as never }), /no collection with ownership: owner/);
  // A declared owned collection with no data file yet has nothing to move.
  assert.deepEqual((await reassignOwner(data, { from: 'apikey:old', to: 'alice', collections, dryRun: true })).collections.map(report => report.collection), ['notes']);
  const live = await running(t, { seed: [owned('n1', 'apikey:old')] });
  await assert.rejects(reassignOwner(live.data, { from: 'apikey:old', to: 'alice', collections: { notes } as never }), /in use|already locked/);
  await live.stop();
  assert.equal((await reassignOwner(live.data, { from: 'apikey:old', to: 'alice', collections: { notes } as never })).moved, 1);
});

test('the reassign CLI reads the owned collections and limits from the project', async t => {
  const { data, project, write, read } = await reassignFixture(t);
  await write('tasks', [owned('t1', 'apikey:old'), owned('t2', 'alice'), owned('t3', 'alice'), owned('t4', 'alice')]);
  const dry = await runCli('reassign', '--directory', data, '--project', project, '--from', 'apikey:old', '--to', 'apikey:new', '--dry-run');
  const report = JSON.parse(dry.stdout) as { dryRun: boolean; moved: number };
  assert.equal(report.dryRun, true); assert.equal(report.moved, 3);
  assert.deepEqual((await read('notes')).map(record => record._owner), ['apikey:old', 'apikey:old', 'alice', undefined]);
  const refused = await cliFailure('reassign', '--directory', data, '--project', project, '--from', 'apikey:old', '--to', 'alice');
  assert.equal(refused?.code, 1); assert.match(refused!.stderr, /collection tasks would give alice 4 records/);
  const moved = await runCli('reassign', '--directory', data, '--project', project, '--from', 'apikey:old', '--to', 'alice', '--collection', 'notes');
  assert.equal((JSON.parse(moved.stdout) as { moved: number }).moved, 2);
  assert.deepEqual((await read('tasks')).map(record => record._owner), ['apikey:old', 'alice', 'alice', 'alice']);
  for (const args of [['--from', 'bad id', '--to', 'alice'], ['--from', 'apikey:old'], ['--from', 'apikey:old', '--to', 'alice', '--owner', 'x'], ['--from', 'apikey:old', '--to', 'alice', '--project', 'relative/app']])
    assert.equal((await cliFailure('reassign', '--directory', data, '--project', project, ...args))?.code, 1, args.join(' '));
  assert.match((await cliFailure('ownerless', '--directory', data, '--collection', 'notes', '--dry-run'))!.stderr, /apply to reassign only/);
});
