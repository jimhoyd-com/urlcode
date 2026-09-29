// A store collection naming a project schema (#908): one schema under the top-level `schemas:` is a collection's
// record shape, a route's request body and an MCP tool's arguments. All three refuse the same invalid input at the
// same pointer with the same issue; the store's defaults and readOnlyProperties (its own layer, beside the schema)
// act as they do with an inline schema; a named schema the store cannot hold is refused at activation; and the
// OpenAPI export references the named component instead of copying it.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOpenApi, startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { createMcpExtension } from '../../mcp/src/index.ts';
import { createStore } from '../src/index.ts';
import { assertValidOpenApi } from '../../../test/openapi-contract.ts';
import type { Json } from '../../../test/openapi-contract.ts';
import { cleanup } from './cleanup.ts';

const origin = 'https://store-named.example.test';
const json = { 'content-type': 'application/json' };
const Ticket = {
  title: 'Ticket', type: 'object', additionalProperties: false, required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 80 },
    email: { type: 'string', format: 'email' },
    priority: { type: 'integer', minimum: 1, maximum: 3 },
    status: { type: 'string', enum: ['open', 'closed'] },
  },
};
/** `tickets` adds the store's layer (a default and a transition-only property); `drafts` takes the schema as it is. */
const collections = {
  tickets: { mount: '/api/tickets', schema: 'Ticket', defaults: { priority: 2, status: 'open' }, readOnlyProperties: ['status'], transitions: { close: { from: { status: 'open' }, set: { status: 'closed' } } } },
  drafts: { mount: '/api/drafts', schema: 'Ticket' },
};
const routes = {
  '/api/tickets/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  '/api/drafts/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  '/mcp/*': { extension: 'mcp', methods: ['POST', 'HEAD'] },
  '/tickets': { methods: ['POST'], request: { body: { POST: { format: 'json', required: true, schema: 'Ticket' } } }, respond: { status: 201, json: { ok: true } } },
};

async function site(t: TestContext, schemas: Record<string, unknown> = { Ticket }, declared: Record<string, unknown> = collections) {
  const root = await mkdtemp(join(tmpdir(), 'store-named-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app');
  await mkdir(project);
  await writeFile(join(project, 'file.mjs'), 'export default function file(input) { return { filed: input.title }; }\n');
  const mcp = { servers: { default: { mount: '/mcp', serverName: 'tickets', serverVersion: '1.0.0', tools: { file_ticket: { description: 'Files a ticket', handler: './file.mjs', inputSchema: 'Ticket' } } } } };
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', schemas, extensions: { store: { version: '1', config: { collections: declared } }, mcp: { version: '1', config: mcp } }, routes }));
  const projectSha256 = await inspectExtensionRevision(project);
  const store = createStore({ database: join(root, 'data', 'store.sqlite'), projectSha256 });
  cleanup(t, () => store.close());
  return { project, store, extensions: [store.registration, createMcpExtension({ projectSha256 })] };
}

async function serve(t: TestContext) {
  const { project, store, extensions } = await site(t);
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions });
  cleanup(t, () => app.close());
  const base = `http://127.0.0.1:${app.address.port}`;
  const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { origin, ...init.headers as Record<string, string> } });
  const post = (path: string, body: unknown) => call(path, { method: 'POST', headers: json, body: JSON.stringify(body) });
  const rpc = async (method: string, params: unknown) => {
    const response = await call('/mcp', { method: 'POST', headers: { ...json, accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const text = await response.text();
    const data = response.headers.get('content-type')?.startsWith('text/event-stream') ? text.split('\n').filter(line => line.startsWith('data: ')).at(-1)!.slice(6) : text;
    return JSON.parse(data) as { result: { isError?: boolean; content: { text: string }[] } };
  };
  return { store, call, post, rpc };
}

type Issue = { pointer: string; keyword: string; message: string };

test('one named schema: the store, a route body and an MCP tool refuse the same input at the same pointer', async t => {
  const { post, rpc } = await serve(t);
  for (const [input, pointer] of [
    [{ title: 'Printer', email: 'nope' }, '/email'],
    [{ title: 'Printer', priority: 9 }, '/priority'],
    [{ title: '' }, '/title'],
    [{ email: 'a@b.co' }, ''],
    [{ title: 'Printer', extra: 1 }, ''],
  ] as const) {
    const route = await post('/tickets', input);
    assert.equal(route.status, 422, JSON.stringify(input));
    const expected = (await route.json() as { issues: Issue[] }).issues;
    assert.equal(expected[0]!.pointer, pointer, JSON.stringify(input));
    const stored = await post('/api/drafts', input);
    assert.equal(stored.status, 422);
    const refused = (await stored.json() as { error: { code: string; issues: Issue[] } }).error;
    assert.equal(refused.code, 'invalid_record');
    assert.deepEqual(refused.issues, expected, `the store's issues are the route's for ${JSON.stringify(input)}`);
    const called = await rpc('tools/call', { name: 'file_ticket', arguments: input });
    assert.equal(called.result.isError, true);
    assert.equal(called.result.content[0]!.text, `Invalid arguments for tool file_ticket: ${pointer || '/'} ${expected[0]!.message}`);
  }
  const valid = { title: 'Printer', email: 'a@b.co', priority: 3 };
  assert.equal((await post('/tickets', valid)).status, 201);
  assert.equal((await post('/api/drafts', valid)).status, 201);
  assert.notEqual((await rpc('tools/call', { name: 'file_ticket', arguments: valid })).result.isError, true);
});

test('the store layer acts on a named schema: defaults on create and PUT, readOnly properties changed only by a transition', async t => {
  const { store, call, post } = await serve(t);
  const created = await post('/api/tickets', { title: 'Printer' });
  assert.equal(created.status, 201);
  const record = await created.json() as Record<string, unknown>;
  assert.equal(record.priority, 2); assert.equal(record.status, 'open');
  const path = `/api/tickets/${record.id as string}`;
  // A body naming a readOnly property is refused on every write, even with the value the record holds.
  for (const [method, body] of [['POST', { title: 'x', status: 'open' }], ['PATCH', { status: 'closed' }], ['PUT', { title: 'x', status: 'closed' }]] as const) {
    const answer = await call(method === 'POST' ? '/api/tickets' : path, { method, headers: json, body: JSON.stringify(body) });
    assert.equal(answer.status, 422, method);
    assert.deepEqual((await answer.json() as { error: { issues: Issue[] } }).error.issues, [{ pointer: '/status', keyword: 'readOnly', message: 'is changed only by a transition' }]);
  }
  assert.equal((await call(path, { method: 'PATCH', headers: json, body: JSON.stringify({ priority: 3 }) })).status, 200);
  const closed = await call(`${path}/close`, { method: 'POST' });
  assert.equal(closed.status, 200);
  assert.equal((await closed.json() as { status: string }).status, 'closed');
  // PUT rebuilds from the body and the defaults, and keeps the readOnly property's stored value.
  const replaced = await (await call(path, { method: 'PUT', headers: json, body: JSON.stringify({ title: 'Scanner' }) })).json() as Record<string, unknown>;
  assert.deepEqual([replaced.title, replaced.priority, replaced.status], ['Scanner', 2, 'closed']);
  // The typed export hands a consumer the resolved schema and the layer beside it.
  const tickets = store.exports.records('tickets');
  assert.deepEqual(tickets.schema, Ticket);
  assert.deepEqual(tickets.defaults, { priority: 2, status: 'open' });
  assert.deepEqual(tickets.readOnlyProperties, ['status']);
});

test('a named schema that is not a flat record, or a layer naming what it does not declare, is refused at activation', async t => {
  const refused = async (schemas: Record<string, unknown>, declared: Record<string, unknown>, pattern: RegExp) => {
    const { project, extensions } = await site(t, { Ticket, ...schemas }, declared);
    await assert.rejects(startServer({ project, origin, port: 0, log: () => {}, extensions }), pattern);
  };
  const nested = { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, address: { type: 'object', properties: { zip: { type: 'string' } } } } };
  await refused({ Contact: nested }, { contacts: { mount: '/api/tickets', schema: 'Contact' } }, /Collection contacts: schema Contact \(top-level schemas:\) cannot be a record schema: \/properties\/address\/type must be one of string, integer, number, boolean: a record holds scalars only/);
  const open = { type: 'object', properties: { title: { type: 'string' } } };
  await refused({ Open: open }, { open: { mount: '/api/tickets', schema: 'Open' } }, /Collection open: schema Open \(top-level schemas:\) cannot be a record schema: \/additionalProperties must be false, written out/);
  const shared = { type: 'object', additionalProperties: false, properties: { zip: { $ref: '#/$defs/zip' } }, $defs: { zip: { type: 'string', maxLength: 5 } } };
  await refused({ Shared: shared }, { shared: { mount: '/api/tickets', schema: 'Shared' } }, /Collection shared: schema Shared \(top-level schemas:\) cannot be a record schema: \/\$defs: a record schema takes only .* at its root \(a flat record has no subschemas to share/);
  await refused({}, { tickets: { mount: '/api/tickets', schema: 'Tikcet' } }, /Collection tickets: schema names Tikcet, which the project does not declare under schemas/);
  await refused({}, { tickets: { mount: '/api/tickets', schema: 'Ticket', defaults: { priority: 7 } } }, /Collection tickets: defaults\.priority must be at most 3/);
  await refused({}, { tickets: { mount: '/api/tickets', schema: 'Ticket', readOnlyProperties: ['status'] } }, /Collection tickets: property status is readOnly but no transition sets or stamps it/);
});

test('the OpenAPI export references the named component from the store\'s schemas instead of copying it', async t => {
  const { project, extensions } = await site(t);
  const document = await buildOpenApi(project, { origin, extensions });
  assertValidOpenApi(document);
  const schemas = document.components.schemas as Record<string, Json>;
  assert.deepEqual(schemas.Ticket, Ticket, 'written once, as the route naming it writes it');
  const at = (property: string): Json => ({ $ref: `#/components/schemas/Ticket/properties/${property}` });
  const post = (path: string) => ((document.paths[path]!.post as Json).requestBody as { content: Record<string, { schema: Json }> }).content['application/json']!.schema;
  assert.deepEqual(post('/tickets'), { $ref: '#/components/schemas/Ticket' });
  // drafts takes the schema exactly as a create body, so its create body is the component itself.
  assert.deepEqual(schemas.StoreDraftsCreate, { $ref: '#/components/schemas/Ticket', description: 'A create (POST) or replace (PUT) body. Omitted properties take their default; readOnly properties are changed only by a transition and refused here.' });
  // tickets' layer changes the create body, so each property references the component's own, with the layer's annotations beside it.
  const record = schemas.StoreTicketsRecord!.properties as Record<string, Json>;
  assert.deepEqual(record.title, at('title'));
  assert.deepEqual(record.priority, { ...at('priority'), default: 2 });
  assert.deepEqual(record.status, { ...at('status'), default: 'open', readOnly: true });
  const create = schemas.StoreTicketsCreate!;
  assert.deepEqual(Object.keys(create.properties as Json), ['title', 'email', 'priority']);
  assert.deepEqual(create.required, ['title']);
  assert.deepEqual((schemas.StoreTicketsPatch!.properties as Record<string, Json>).email, { anyOf: [at('email'), { type: 'null' }] });
  assert.deepEqual((schemas.StoreTicketsPatch!.properties as Record<string, Json>).title, at('title'));
});
