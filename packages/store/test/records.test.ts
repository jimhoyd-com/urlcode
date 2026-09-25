import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { StoreError, createStore } from '../src/index.ts';
import type { StoreExports } from '../src/index.ts';

// #529: the store's export contract (StoreExports, version 1). A synthetic consumer ("jot") reads it the way an
// extension that requires store would, alongside a synthetic principal provider ("badge"), so the seam is proven
// without form-records or auth.
const origin = 'https://records.example.test';
const notes = { mount: '/api/notes', ownership: 'owner', maxRecords: 3, pageSize: 2, fields: { title: { type: 'string', required: true, maxLength: 20 }, pinned: { type: 'boolean', default: false }, rank: { type: 'integer', minimum: 1 } } };
const board = { mount: '/api/board', maxRecords: 5, fields: { title: { type: 'string', required: true, maxLength: 20 } } };

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
/** POST /jot?title=x creates a note for the caller; GET /jot/<id> reads it back. Store failures answer with their status. */
function jot(projectSha256: string, store: StoreExports): RuntimeExtension {
  return {
    name: 'jot', version: '1', projectSha256, targets: ['node'], schema: { type: 'object', additionalProperties: false },
    activate() {
      const records = store.records('notes');
      return {
        async handle(request: ExtensionRequest) {
          try {
            const id = request.path.slice('/jot/'.length);
            const result = request.method === 'POST' ? await records.create(request.principal, { title: request.query.get('title') ?? '' }) : records.get(request.principal, id);
            return { status: 200, headers: [['content-type', 'application/json'], ['etag', result.etag]], body: JSON.stringify(result.record) };
          } catch (error) {
            if (error instanceof StoreError) return { status: error.status, headers: [['content-type', 'text/plain']], body: error.code };
            throw error;
          }
        },
      };
    },
  };
}

async function boot(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'store-records-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), data = join(root, 'data'); await mkdir(project); await mkdir(data);
  const guarded = { policies: { extensions: { badge: {} } } };
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1',
    extensions: { badge: { version: '1', config: {} }, store: { version: '1', config: { collections: { notes, board } } }, jot: { version: '1', config: {} } },
    routes: { '/api/notes/*': { extension: 'store', methods: ['GET', 'POST', 'PATCH'], ...guarded }, '/api/board/*': { extension: 'store', methods: ['GET', 'POST'], ...guarded }, '/jot/*': { extension: 'jot', methods: ['GET', 'POST'], ...guarded } } }));
  const projectSha256 = await inspectExtensionRevision(project), store = createStore({ directory: data, projectSha256 });
  assert.equal(store.exports.version, 1); assert.equal(store.exports.active, false);
  assert.throws(() => store.exports.records('notes'), /store is not active yet/);
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: [badge(projectSha256), store.registration, jot(projectSha256, store.exports)] });
  let open = true;
  t.after(async () => { if (open) await app.close(); });
  const as = (who: string) => (path: string, method = 'GET') => fetch(`http://127.0.0.1:${app.address.port}${path}`, { method, headers: { authorization: `Badge ${who}` } });
  return { store: store.exports, as, data, close: async () => { open = false; await app.close(); } };
}

test('a consumer creates and reads owned records through the export; another principal gets the same 404 as the HTTP API', async t => {
  const { as, data } = await boot(t);
  const created = await as('alice')('/jot?title=hello', 'POST');
  assert.equal(created.status, 200);
  const note = await created.json() as Record<string, unknown>;
  assert.equal(Object.hasOwn(note, '_owner'), false); assert.equal(note.pinned, false);
  assert.match(created.headers.get('etag')!, /^"[0-9a-f]{32}"$/);
  assert.equal((await as('alice')(`/jot/${note.id as string}`)).status, 200);
  assert.equal(await (await as('bob')(`/jot/${note.id as string}`)).text(), 'not_found');
  assert.equal((await as('bob')(`/api/notes/${note.id as string}`)).status, 404, 'the HTTP API agrees');
  const stored = JSON.parse(await readFile(join(data, 'notes.json'), 'utf8')) as { records: Record<string, unknown>[] };
  assert.equal(stored.records[0]!._owner, 'alice');
  // The HTTP API sees the export's record, with the same ETag.
  const api = await as('alice')(`/api/notes/${note.id as string}`);
  assert.equal(api.headers.get('etag'), created.headers.get('etag'));
});

test('the export applies ownership, validation, limits and If-Match exactly as the HTTP API does', async t => {
  const { store, close } = await boot(t);
  const notesApi = store.records('notes'), boardApi = store.records('board');
  assert.equal(notesApi.ownership, 'owner'); assert.equal(boardApi.ownership, 'shared'); assert.equal(notesApi.readOnly, false);
  assert.deepEqual(Object.keys(notesApi.fields), ['title', 'pinned', 'rank']);
  assert.throws(() => { (notesApi.fields.title as { maxLength?: number }).maxLength = 1; }, TypeError, 'the declared fields are a frozen copy');
  assert.throws(() => store.records('missing'), /store declares no collection missing/);
  const alice = { id: 'alice', provider: 'badge' }, bob = { id: 'bob', provider: 'badge' };
  await assert.rejects(notesApi.create(null, { title: 'x' }), (error: StoreError) => error.status === 401 && error.code === 'principal_required');
  const first = await notesApi.create(alice, { title: 'first' });
  assert.equal(Object.hasOwn(first.record, '_owner'), false);
  assert.throws(() => notesApi.get(bob, first.record.id as string), (error: StoreError) => error.status === 404);
  assert.throws(() => notesApi.get(alice, 'not-a-uuid'), (error: StoreError) => error.status === 404);
  await assert.rejects(notesApi.create(alice, { title: 'x'.repeat(21) }), (error: StoreError) => error.status === 400 && error.fields?.title === 'must be at most 20 characters');
  await assert.rejects(notesApi.create(alice, { title: 'x', _owner: 'bob' } as never), (error: StoreError) => error.status === 400 && error.fields?._owner === 'is not a declared field');
  // A partial update keeps the other fields and the owner, and moves the ETag.
  const updated = await notesApi.update(alice, first.record.id as string, { pinned: true }, { ifMatch: first.etag });
  assert.equal(updated.record.title, 'first'); assert.equal(updated.record.pinned, true); assert.notEqual(updated.etag, first.etag);
  await assert.rejects(notesApi.update(alice, first.record.id as string, { pinned: false }, { ifMatch: first.etag }), (error: StoreError) => error.status === 412 && error.code === 'precondition_failed');
  await assert.rejects(notesApi.update(bob, first.record.id as string, { pinned: false }, { ifMatch: updated.etag }), (error: StoreError) => error.status === 404, 'scoped before the ETag');
  await assert.rejects(notesApi.update(alice, first.record.id as string, { pinned: false }, { ifMatch: 'W/"x"' }), (error: StoreError) => error.status === 400);
  await assert.rejects(notesApi.update(alice, first.record.id as string, {}), (error: StoreError) => error.status === 400);
  // maxRecords holds for the export too.
  await notesApi.create(bob, { title: 'b' }); await notesApi.create(bob, { title: 'c' });
  await assert.rejects(notesApi.create(alice, { title: 'd' }), (error: StoreError) => error.status === 409 && error.code === 'collection_full');
  // A shared collection ignores the principal, as its HTTP API does.
  const shared = await boardApi.create(null, { title: 'public' });
  assert.equal(boardApi.get(bob, shared.record.id as string).record.title, 'public');
  await close();
  assert.equal(store.active, false, 'closing the activation withdraws the export');
  assert.throws(() => store.records('notes'), /not active/);
});

test('update with null removes an optional field and refuses a required one; ETag and ownership still apply (#738)', async t => {
  const { store } = await boot(t);
  const notesApi = store.records('notes'), alice = { id: 'alice', provider: 'badge' }, bob = { id: 'bob', provider: 'badge' };
  const first = await notesApi.create(alice, { title: 'first', rank: 2 });
  const id = first.record.id as string;
  await assert.rejects(notesApi.update(bob, id, { rank: null }, { ifMatch: first.etag }), (error: StoreError) => error.status === 404, 'another owner cannot clear a field');
  const cleared = await notesApi.update(alice, id, { rank: null }, { ifMatch: first.etag });
  assert.equal(Object.hasOwn(cleared.record, 'rank'), false); assert.equal(cleared.record.title, 'first'); assert.notEqual(cleared.etag, first.etag);
  await assert.rejects(notesApi.update(alice, id, { rank: null }, { ifMatch: first.etag }), (error: StoreError) => error.status === 412, 'a stale ETag refuses a clear too');
  await assert.rejects(notesApi.update(alice, id, { title: null }), (error: StoreError) => error.status === 400 && error.code === 'invalid_record' && error.fields?.title === 'is required and cannot be cleared');
  await assert.rejects(notesApi.update(alice, id, { rank: 0 }), (error: StoreError) => error.status === 400 && error.fields?.rank === 'must be at least 1', 'a set value is still validated');
  assert.equal(notesApi.get(alice, id).record.title, 'first');
});

test('list pages through only the principal\'s own records, with next and previous cursors (#738)', async t => {
  const { store } = await boot(t);
  const notesApi = store.records('notes'), alice = { id: 'alice', provider: 'badge' }, bob = { id: 'bob', provider: 'badge' };
  const a1 = await notesApi.create(alice, { title: 'a1' }); await notesApi.create(bob, { title: 'b1' }); const a2 = await notesApi.create(alice, { title: 'a2' });
  const first = notesApi.list(alice, { limit: 1 });
  assert.equal(first.total, 2, 'total counts only the caller\'s records'); assert.deepEqual(first.items.map(item => item.title), ['a1']);
  assert.equal(first.next, '1'); assert.equal(first.previous, undefined);
  assert.equal(Object.hasOwn(first.items[0]!, '_owner'), false, 'items never carry their owner');
  const second = notesApi.list(alice, { limit: 1, cursor: first.next! });
  assert.deepEqual(second.items.map(item => item.id), [a2.record.id]); assert.equal(second.next, undefined); assert.equal(second.previous, '0');
  assert.deepEqual(notesApi.list(alice, { limit: 1, cursor: second.previous! }).items.map(item => item.id), [a1.record.id]);
  assert.deepEqual(notesApi.list(bob).items.map(item => item.title), ['b1']);
  assert.equal(notesApi.list(alice, { limit: 50 }).items.length, 2, 'limit is capped at pageSize (2)');
  assert.throws(() => notesApi.list(null), (error: StoreError) => error.status === 401);
  assert.throws(() => notesApi.list(alice, { cursor: 'abc' }), (error: StoreError) => error.status === 400 && error.code === 'invalid_query');
  assert.throws(() => notesApi.list(alice, { limit: 0 }), (error: StoreError) => error.status === 400 && error.fields?.limit !== undefined);
  assert.throws(() => { (first.items as unknown[]).push({}); }, TypeError, 'the page is frozen');
});
