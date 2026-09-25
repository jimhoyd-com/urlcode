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
const notes = { mount: '/api/notes', ownership: 'owner', maxRecords: 3, fields: { title: { type: 'string', required: true, maxLength: 20 }, pinned: { type: 'boolean', default: false } } };
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
  assert.deepEqual(Object.keys(notesApi.fields), ['title', 'pinned']);
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
