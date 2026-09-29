// The store's OpenAPI contribution (#881): with the host's registration loaded, every store mount is real paths
// whose schemas come from the collection's record schema, valid against the official OpenAPI 3.1 schema, and a
// contract run derived from the document gets only declared statuses, bodies and headers from the served store.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOpenApi, startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { createStore } from '../src/index.ts';
import { assertValidOpenApi, contractRun, operations } from '../../../test/openapi-contract.ts';
import type { Json, Operation } from '../../../test/openapi-contract.ts';
import { cleanup } from './cleanup.ts';

const origin = 'https://store-openapi.example.test';
const links = {
  mount: '/api/links', key: 'code', increments: ['clicks'], idempotency: { maxKeys: 10 }, sortable: ['code'], filterable: ['state'],
  schema: {
    title: 'Link', type: 'object', additionalProperties: false, required: ['code', 'destination'],
    properties: {
      code: { type: 'string', minLength: 1, maxLength: 32 },
      destination: { type: 'string', format: 'uri' },
      clicks: { type: 'integer', minimum: 0 },
      state: { type: 'string', enum: ['live', 'archived'] },
    },
  }, defaults: { clicks: 0, state: 'live' }, readOnlyProperties: ['state'],
  transitions: { archive: { from: { state: 'live' }, set: { state: 'archived' } } },
};
const reviewers = { membership: true, key: 'userId', schema: { type: 'object', additionalProperties: false, required: ['userId'], properties: { userId: { type: 'string', maxLength: 128 } } } };
const notes = {
  mount: '/api/notes', ownership: 'owner', readers: { mount: '/api/review', members: 'reviewers', showOwner: true },
  schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 40 }, body: { type: 'string', maxLength: 200 } } },
};
const config = { collections: { links, reviewers, notes }, shortLinks: { public: { mount: '/go', collection: 'links', destination: 'destination', clicks: 'clicks' } } };
const badge = { policies: { extensions: { badge: {} } } };
const routes = {
  '/api/links/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  '/go/*': { extension: 'store', methods: ['GET', 'HEAD'] },
  '/api/notes/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], ...badge },
  '/api/review/*': { extension: 'store', methods: ['GET', 'HEAD'], ...badge },
};

/** A principal-providing stand-in: the `x-badge` header names the principal, and no badge is a 401. */
function badgeExtension(projectSha256: string): RuntimeExtension {
  return {
    name: 'badge', version: '1', projectSha256, targets: ['node'], providesPrincipal: true, schema: { type: 'object' }, policySchema: { type: 'object' },
    activate() {
      return {
        handle() { return { status: 404, headers: [], body: '' }; },
        authorize(_policy, request) {
          const id = request.headers.get('x-badge');
          if (!id) return { status: 401, headers: [['content-type', 'text/plain']], body: 'no badge' };
          request.setPrincipal!({ id });
          return undefined;
        },
      };
    },
  };
}

async function site(t: TestContext, collections: Record<string, unknown> = config, declared: Record<string, unknown> = routes) {
  const root = await mkdtemp(join(tmpdir(), 'store-openapi-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'), database = join(root, 'data', 'store.sqlite');
  await mkdir(project);
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { store: { version: '1', config: collections }, badge: { version: '1', config: {} } }, routes: declared }));
  const projectSha256 = await inspectExtensionRevision(project);
  const store = createStore({ database, projectSha256 });
  cleanup(t, () => store.close());
  return { project, store, extensions: [store.registration, badgeExtension(projectSha256)] };
}

test('every store mount is described from the collection schema, and the document is valid OpenAPI 3.1', async t => {
  const { project, extensions } = await site(t);
  const document = await buildOpenApi(project, { origin, extensions });
  assertValidOpenApi(document);
  assert.deepEqual(document['x-urlcode'].describedMounts.map(mount => mount.path), ['/api/links/*', '/api/notes/*', '/api/review/*', '/go/*']);
  assert.deepEqual(document['x-urlcode'].opaqueMounts, []);
  assert.deepEqual(Object.keys(document.paths), ['/api/links', '/api/links/{id}', '/api/links/{id}/increment/{field}', '/api/links/{id}/archive', '/api/notes', '/api/notes/{id}', '/api/review', '/api/review/{id}', '/go/{key}']);
  const schemas = document.components.schemas as Record<string, Json>;
  // The record is the declared schema plus the store-owned names; the collection's defaults and readOnlyProperties are its annotations.
  const record = schemas.StoreLinksRecord!;
  assert.equal(record.title, 'Link'); assert.equal(record.additionalProperties, false);
  assert.deepEqual(record.required, ['id', 'createdAt', 'updatedAt', 'code', 'destination']);
  assert.deepEqual((record.properties as Json).state, { ...links.schema.properties.state, default: 'live', readOnly: true });
  assert.deepEqual((record.properties as Json).id, { type: 'string', format: 'uuid', readOnly: true, description: 'Store-owned: the record id.' });
  // A create leaves out readOnly properties and does not require a defaulted one; PATCH may clear an optional one.
  const create = schemas.StoreLinksCreate!;
  assert.deepEqual(Object.keys(create.properties as Json), ['code', 'destination', 'clicks']); assert.deepEqual(create.required, ['code', 'destination']);
  assert.deepEqual((schemas.StoreNotesPatch!.properties as Json).body, { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] });
  assert.deepEqual((schemas.StoreNotesPatch!.properties as Json).title, { type: 'string', minLength: 1, maxLength: 40 }, 'a required property cannot be cleared');
  assert.ok(((schemas.StoreNotesReaderRecord!.required as string[]).includes('_owner')), 'showOwner adds the owner on the readers mount only');
  const op = (path: string, method: string) => document.paths[path]![method] as Operation & { parameters?: Json[] };
  // Filters take their property's schema (without the store's annotations); sort is the declared list.
  assert.deepEqual(op('/api/links', 'get').parameters!.map(parameter => [parameter.name, parameter.schema]).slice(2), [['sort', { enum: ['code', '-code'] }], ['state', { type: 'string', enum: ['live', 'archived'] }]]);
  assert.deepEqual(op('/api/links', 'post').parameters!.map(parameter => parameter.name), ['Idempotency-Key']);
  assert.deepEqual(op('/api/links/{id}', 'patch').parameters!.map(parameter => parameter.name), ['If-Match', 'Idempotency-Key']);
  assert.deepEqual(Object.keys(op('/api/links/{id}', 'patch').responses), ['200', '400', '403', '404', '409', '412', '413', '415', '422', '503']);
  assert.deepEqual(op('/api/links', 'post').requestBody, { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/StoreLinksCreate' } } }, 'x-urlcode': { maxBytes: 8192 } });
  assert.deepEqual(Object.keys(op('/api/links', 'post').responses['201']!.headers!), ['ETag', 'Allow-Transitions', 'Idempotency-Replayed', 'Location', 'X-Request-Id', 'X-Content-Type-Options', 'Cache-Control']);
  // The sign-in gate on the owned mounts comes from core; the redirect mount has none.
  assert.deepEqual(op('/api/notes', 'get').security, [{ 'urlcodeSession.badge': [] }]); assert.equal(op('/go/{key}', 'get').security, undefined);
  assert.deepEqual(Object.keys(op('/go/{key}', 'get').responses), ['302', '404', '503']);
  // Without the host file's registration the mounts stay opaque.
  const bare = await buildOpenApi(project);
  assert.deepEqual(bare['x-urlcode'].opaqueMounts.map(mount => mount.path), ['/api/links/*', '/api/notes/*', '/api/review/*', '/go/*']);
  assert.deepEqual(bare.paths, {});
});

test('a by: others transition mount and a read-only collection are described as served', async t => {
  const requests = {
    mount: '/api/requests', ownership: 'owner', readOnly: false,
    schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 40 }, status: { enum: ['pending', 'approved'], type: 'string' } } }, defaults: { status: 'pending' }, readOnlyProperties: ['status'],
    transitions: { approve: { from: { status: 'pending' }, set: { status: 'approved' }, by: 'others', mount: '/api/approvals', members: 'reviewers' } },
  };
  const frozen = { mount: '/api/frozen', readOnly: true, schema: { type: 'object', additionalProperties: false, properties: { n: { type: 'integer' } } } };
  const { project, extensions } = await site(t, { collections: { reviewers, requests, frozen } }, {
    '/api/requests/*': { extension: 'store', methods: ['GET', 'POST'], ...badge },
    '/api/approvals/*': { extension: 'store', methods: ['POST'], ...badge },
    '/api/frozen/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST'] },
  });
  const document = await buildOpenApi(project, { extensions });
  assertValidOpenApi(document);
  assert.deepEqual(Object.keys(document.paths), ['/api/approvals/{id}', '/api/frozen', '/api/frozen/{id}', '/api/requests', '/api/requests/{id}']);
  const approve = document.paths['/api/approvals/{id}']!.post as Operation;
  assert.match(String((approve.responses['403'] as Json).description), /membership_required.*own_record_refused/);
  // The route declares GET and POST only: the store's PUT, PATCH and DELETE on a record are not listed.
  assert.deepEqual(Object.keys(document.paths['/api/requests/{id}']!).filter(key => key !== 'parameters' && key !== 'x-urlcode'), ['get']);
  assert.deepEqual(Object.keys(document.paths['/api/frozen']!).filter(key => !['summary', 'x-urlcode'].includes(key)), ['get', 'head'], 'a readOnly collection is described without writes');
});

test('a contract run against the served store answers only declared statuses, bodies and headers', async t => {
  const { project, store, extensions } = await site(t);
  const document = await buildOpenApi(project, { origin, extensions });
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions });
  cleanup(t, () => app.close());
  const who = { id: 'u1', provider: 'badge' };
  store.exports.records('reviewers').create(null, { userId: 'u1' });
  // The link with code `a` is the one a sampled body names, so each operation gets a fresh one under that code.
  const link = async (): Promise<string> => {
    const api = store.exports.records('links'), found = api.list(null, { limit: 50 }).items.find(item => item.code === 'a');
    if (found) store.exports.transaction(tx => tx.records('links').remove(null, found.id as string));
    return (await api.create(null, { code: 'a', destination: 'https://example.test/landing' })).record.id as string;
  };
  const given = async (path: string): Promise<Record<string, unknown>> => {
    if (path.startsWith('/api/links/')) return { id: await link() };
    if (path === '/go/{key}') { await link(); return { key: 'a' }; }
    if (path === '/api/notes/{id}' || path === '/api/review/{id}') return { id: (await store.exports.records('notes').create(who, { title: 'note' })).record.id };
    return {};
  };
  const checked = await contractRun(document, app, { 'x-badge': 'u1', origin }, given);
  assert.equal(checked.filter(line => line.startsWith('valid ')).length, operations(document).length);
  for (const status of ['413', '415', '422']) assert.ok(checked.some(line => line.endsWith(` ${status}`)), status);
});
