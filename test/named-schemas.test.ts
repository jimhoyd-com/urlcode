import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDocument } from '../packages/core/src/config.ts';
import { inspectExtensionRevision } from '../packages/core/src/extensions.ts';
import type { RuntimeExtension } from '../packages/core/src/extensions.ts';
import { startServer } from '../packages/core/src/server.ts';
import { buildOpenApi } from '../packages/core/src/openapi.ts';
import { buildCloudflare } from '../packages/core/src/build-cloudflare.ts';
import { createFetchHandler } from '../packages/core/src/cloudflare.ts';
import type { Artifact, BodyValidators, Validators } from '../packages/core/src/cloudflare.ts';
import { assertValidOpenApi } from './openapi-contract.ts';
import type { Json, Operation } from './openapi-contract.ts';
import { project, request } from './helpers.ts';

// Named project schemas (RIM-SCHEMA-001, #845): the top-level `schemas:` map, inline or `{file}`, named by
// `request.body.<METHOD>.schema: <name>`. MCP tools naming the same schema are covered in packages/mcp/test.

const contact = {
  type: 'object', required: ['name', 'email'], additionalProperties: false,
  properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, email: { type: 'string', format: 'email' } },
};
const post = (schema: unknown) => ({ methods: ['POST'], request: { body: { POST: { format: 'json', contentTypes: ['application/json'], required: true, schema } } }, respond: { status: 201, json: { ok: true } } });
const json = { 'content-type': 'application/json' };

test('a named schema validates every route that names it, with the same 422 as an inline schema', async t => {
  const named = await project(t, { '/contacts': post('contact'), '/leads': post('contact') }, {}, { schemas: { contact } });
  const inline = await project(t, { '/contacts': post(contact) });
  const a = await startServer({ project: named, port: 0, log: () => {} }); t.after(() => a.close());
  const b = await startServer({ project: inline, port: 0, log: () => {} }); t.after(() => b.close());
  for (const body of ['{"name":"Ann","email":"ann@example.com"}', '{"name":"Ann","email":"nope"}', '{"email":"ann@example.com"}', '{"name":"Ann","email":"a@b.co","x":1}']) {
    const [left, right, lead] = await Promise.all([request(a, '/contacts', { method: 'POST', headers: json, body }), request(b, '/contacts', { method: 'POST', headers: json, body }), request(a, '/leads', { method: 'POST', headers: json, body })]);
    assert.equal(left.status, right.status, body); assert.equal(left.body, right.body, body); assert.equal(lead.body, left.body, body);
  }
  const bad = await request(a, '/contacts', { method: 'POST', headers: json, body: '{"name":"Ann","email":"nope"}' });
  assert.equal(bad.status, 422);
  assert.deepEqual((JSON.parse(bad.body) as { issues: { pointer: string }[] }).issues.map(issue => issue.pointer), ['/email']);
  // The authored route keeps the name; only the compiled route holds the schema.
  const loaded = await loadDocument(named);
  assert.equal(loaded.routes['/contacts']!.request?.body?.POST?.schema, 'contact');
  assert.deepEqual(loaded.schemas, { contact });
});

test('an unknown schema name, an include declaring schemas and a bad name or file reference are refused at load', async t => {
  const unknown = await project(t, { '/contacts': post('contcat') }, {}, { schemas: { contact } });
  await assert.rejects(loadDocument(unknown), (error: Error & { details?: { code?: string; pointer?: string } }) => {
    assert.match(error.message, /route \/contacts, request\.body\.POST\.schema names schema "contcat", which the project does not declare; did you mean "contact"\?/);
    assert.equal(error.details?.code, 'unknown-schema'); assert.equal(error.details?.pointer, '/routes/~1contacts/request/body/POST/schema');
    return true;
  });
  const included = await project(t, {}, { 'more.yaml': 'version: "1"\nschemas: {x: {type: object}}\nroutes: {}\n' }, { includes: ['more.yaml'] });
  await assert.rejects(loadDocument(included), /schemas may only be set in the entry urlcode\.yaml/);
  const reserved = await project(t, {}, {}, { schemas: { UrlcodeThing: { type: 'object' } } });
  await assert.rejects(loadDocument(reserved), /schemas\.UrlcodeThing: names starting with Urlcode are reserved/);
  const mixed = await project(t, {}, {}, { schemas: { contact: { file: 'contact.json', type: 'object' } } });
  await assert.rejects(loadDocument(mixed), /schemas\.contact: a file reference takes only file/);
  const outside = await project(t, {}, {}, { schemas: { contact: { file: '../contact.json' } } });
  await assert.rejects(loadDocument(outside), /schemas\.contact: file must be a project-relative \.json, \.yaml or \.yml path/);
  // An inline schema outside the profile fails with the profile's own pointer, restated as the named schema's.
  const profile = await project(t, {}, {}, { schemas: { contact: { type: 'object', default: {} } } });
  await assert.rejects(loadDocument(profile), (error: Error & { details?: { line?: number } }) => {
    assert.match(error.message, /^urlcode\.yaml:\d+:\d+: schemas\.contact \/default: keyword "default" is not in the supported JSON Schema 2020-12 profile/);
    assert.ok(error.details?.line);
    return true;
  });
});

test('a schema file with a relative $ref to a second file (JSON and YAML) is bundled offline into one self-contained schema', async t => {
  const root = await project(t, { '/contacts': post('contact') }, {
    'schemas/contact.json': JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Contact', type: 'object', required: ['name', 'address'], additionalProperties: false,
      $defs: { name: { type: 'string', minLength: 1, maxLength: 100 } },
      properties: { name: { $ref: '#/$defs/name' }, address: { $ref: 'common/address.yaml' }, phone: { $ref: 'common/phone.json#/$defs/phone' } },
    }),
    'schemas/common/address.yaml': 'type: object\nrequired: [zip]\nadditionalProperties: false\nproperties:\n  zip: {$ref: "#/$defs/zip"}\n  country: {type: string, maxLength: 2}\n$defs:\n  zip: {type: string, pattern: "^[0-9]{5}$", maxLength: 5}\n  unused: {type: string}\n',
    'schemas/common/phone.json': JSON.stringify({ $defs: { phone: { type: 'string', maxLength: 32 } } }),
  }, { schemas: { contact: { file: 'schemas/contact.json' } } });
  const loaded = await loadDocument(root);
  assert.deepEqual(loaded.schemas!.contact, {
    $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Contact', type: 'object', required: ['name', 'address'], additionalProperties: false,
    properties: { name: { $ref: '#/$defs/name' }, address: { $ref: '#/$defs/address' }, phone: { $ref: '#/$defs/phone.phone' } },
    $defs: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      address: { type: 'object', required: ['zip'], additionalProperties: false, properties: { zip: { $ref: '#/$defs/address.zip' }, country: { type: 'string', maxLength: 2 } } },
      'address.zip': { type: 'string', pattern: '^[0-9]{5}$', maxLength: 5 },
      'phone.phone': { type: 'string', maxLength: 32 },
    },
  });
  assert.deepEqual(Object.keys(loaded.schemaFiles!).sort(), ['schemas/common/address.yaml', 'schemas/common/phone.json', 'schemas/contact.json']);
  const app = await startServer({ project: root, port: 0, log: () => {} }); t.after(() => app.close());
  assert.equal((await request(app, '/contacts', { method: 'POST', headers: json, body: '{"name":"A","address":{"zip":"12345"}}' })).status, 201);
  const bad = await request(app, '/contacts', { method: 'POST', headers: json, body: '{"name":"A","address":{"zip":"1234x"}}' });
  assert.equal(bad.status, 422);
  assert.deepEqual((JSON.parse(bad.body) as { issues: { pointer: string; keyword: string }[] }).issues, [{ pointer: '/address/zip', keyword: 'pattern', message: 'does not match the declared pattern' }]);
});

test('schema files: a remote ref, an escaping ref, a symlink, an oversized file and a missing file are refused before serving', async t => {
  const refusing = async (files: Record<string, string>, pattern: RegExp, setup?: (root: string) => Promise<void>) => {
    const root = await project(t, {}, files, { schemas: { contact: { file: 'schemas/contact.json' } } });
    await setup?.(root);
    await assert.rejects(loadDocument(root), (error: Error) => { assert.match(error.message, pattern); return true; });
  };
  const referring = (ref: string) => ({ 'schemas/contact.json': JSON.stringify({ type: 'object', properties: { a: { $ref: ref } } }) });
  // The URL (with its credentials) is never echoed.
  await refusing(referring('https://user:secret@schemas.example/a.json'), /schemas\.contact: schemas\/contact\.json#\/properties\/a: a remote reference is refused: schema references are resolved offline, inside the project, and never fetched$/);
  await refusing(referring('../../outside.json'), /schemas\/contact\.json#\/properties\/a: the reference leaves the project directory$/);
  await refusing(referring('missing.json'), /schemas\/contact\.json#\/properties\/a: the reference does not resolve to a JSON or YAML file in the project/);
  await refusing(referring('other.json#/properties/x'), /schemas\.contact: schemas\/contact\.json: a reference to schemas\/other\.json must name the whole file or one of its \/\$defs\/<name> entries$/,
    async root => { await writeFile(join(root, 'schemas/other.json'), JSON.stringify({ type: 'object', properties: { x: { type: 'string' } } })); });
  const outside = await mkdtemp(join(tmpdir(), 'urlcode-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'target.json'), JSON.stringify({ type: 'string' }));
  await refusing(referring('linked.json'), /schemas\/contact\.json#\/properties\/a: the path is a symlink/, async root => { await symlink(join(outside, 'target.json'), join(root, 'schemas/linked.json')); });
  await refusing({ 'schemas/contact.json': JSON.stringify({ type: 'object', description: 'x'.repeat(300 * 1024) }) }, /schemas\.contact: schemas\/contact\.json is \d+ bytes, over the 262144-byte document limit; it was not read$/);
  await refusing({}, /schemas\.contact: schemas\/contact\.json: the file does not exist in the project$/);
  await refusing({ 'schemas/contact.json': JSON.stringify({ type: 'object', properties: { a: { $ref: 'contact.json' } } }) }, /schemas\.contact: schemas\/contact\.json#: the references form a cycle; recursive schemas are not supported$/);
});

test('the project revision changes when a schema file changes, even by bytes alone', async t => {
  const schema = JSON.stringify({ type: 'object', properties: { a: { $ref: 'part.json' } } });
  const root = await project(t, { '/contacts': post('contact') }, { 'schemas/contact.json': schema, 'schemas/part.json': '{"type":"string","maxLength":5}' }, { schemas: { contact: { file: 'schemas/contact.json' } } });
  const first = await inspectExtensionRevision(root), version = (await loadDocument(root)).version;
  assert.equal(await inspectExtensionRevision(root), first);
  // Whitespace only in the referenced file: the schema is the same, the bytes are not.
  await writeFile(join(root, 'schemas/part.json'), '{ "type": "string", "maxLength": 5 }\n');
  const second = await inspectExtensionRevision(root);
  assert.notEqual(second, first);
  await writeFile(join(root, 'schemas/part.json'), '{"type":"string","maxLength":6}');
  const third = await inspectExtensionRevision(root);
  assert.notEqual(third, second); assert.notEqual((await loadDocument(root)).version, version);
});

test('the OpenAPI export emits a named schema once as a component and references it from every operation', async t => {
  const root = await project(t, {
    '/contacts': post('contact'), '/leads': post('contact'),
    '/notes': post({ type: 'object', properties: { text: { type: 'string', maxLength: 10 } } }),
  }, { 'schemas/address.json': JSON.stringify({ type: 'object', properties: { zip: { type: 'string', maxLength: 5 } } }) },
  { schemas: { contact: { ...contact, properties: { ...contact.properties, address: { $ref: '#/$defs/address' } }, $defs: { address: { type: 'object', maxProperties: 4 } } }, address: { file: 'schemas/address.json' }, unused: { type: 'string' } } });
  const document = await buildOpenApi(root);
  assertValidOpenApi(document);
  for (const path of ['/contacts', '/leads']) assert.deepEqual((document.paths[path]!.post as Operation).requestBody!.content['application/json']!.schema, { $ref: '#/components/schemas/contact' });
  const names = Object.keys(document.components.schemas).filter(name => !name.startsWith('Urlcode')).sort();
  // Only schemas an operation uses are written; a named schema's $defs are components beside it, like an inline one's.
  assert.deepEqual(names, ['PostNotesRequestBody', 'contact', 'contact_address']);
  assert.deepEqual((document.components.schemas.contact as Json).properties, { ...contact.properties, address: { $ref: '#/components/schemas/contact_address' } });
});

test('an extension contribution may reference a named schema or one of its root properties; core writes it once (#908)', async t => {
  const root = await project(t, { '/api/notes/*': { extension: 'notes', methods: ['GET', 'POST'] } }, {},
    { extensions: { notes: { version: '1', config: {} } }, schemas: { contact: { ...contact, properties: { ...contact.properties, address: { $ref: '#/$defs/address' } }, $defs: { address: { type: 'object', maxProperties: 4 } } } } });
  const seen: unknown[] = [];
  const describe: RuntimeExtension['describe'] = request => {
    seen.push(request.schemas);
    return { paths: { [request.mount]: {
      get: { responses: { '200': { description: 'One email.', content: { 'application/json': { schema: { $ref: '#/components/schemas/contact/properties/email' } } } } } },
      post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/contact' } } } }, responses: { '201': { description: 'Created.' } } },
    } } };
  };
  const notes: RuntimeExtension = { name: 'notes', version: '1', projectSha256: await inspectExtensionRevision(root), targets: ['node'], schema: { type: 'object' }, describe, activate() { return { handle() { return { status: 404, headers: [], body: '' }; } }; } };
  const document = await buildOpenApi(root, { extensions: [notes] });
  assertValidOpenApi(document);
  assert.deepEqual(seen, [(await loadDocument(root)).schemas], 'describe() gets the project\'s named schemas');
  assert.deepEqual(Object.keys(document.components.schemas).filter(name => !name.startsWith('Urlcode')).sort(), ['contact', 'contact_address']);
});

test('the built Worker artifact validates a named schema with one standalone validator shared by its routes', async t => {
  const root = await project(t, { '/contacts': post('contact'), '/leads': post('contact'), '/notes': post({ type: 'object', maxProperties: 1 }) }, {}, { schemas: { contact } });
  const out = await mkdtemp(join(tmpdir(), 'urlcode-cf-')); t.after(() => rm(out, { recursive: true, force: true }));
  await buildCloudflare(root, { out });
  const artifact = ((await import(pathToFileURL(join(out, 'artifact.js')).href)) as { default: Artifact }).default;
  const bodyValidators = (await import(pathToFileURL(join(out, 'body-validators.js')).href)) as BodyValidators;
  const validators = (await import(pathToFileURL(join(out, 'validators.js')).href)) as Validators;
  const byPattern = Object.fromEntries(artifact.routes.map(route => [route.pattern, route]));
  assert.equal(byPattern['/contacts']!.bodyValidators!.POST, byPattern['/leads']!.bodyValidators!.POST);
  assert.notEqual(byPattern['/notes']!.bodyValidators!.POST, byPattern['/contacts']!.bodyValidators!.POST);
  assert.deepEqual(Object.keys(bodyValidators).filter(key => key !== 'default').sort(), ['b0', 'b1']);
  const worker = createFetchHandler(artifact, validators, bodyValidators);
  const app = await startServer({ project: root, port: 0, log: () => {} }); t.after(() => app.close());
  for (const [path, body] of [['/leads', '{"name":"A","email":"a@b.co"}'], ['/leads', '{"name":"A","email":"nope"}'], ['/contacts', '{"name":""}'], ['/notes', '{"a":1,"b":2}']] as const) {
    const local = await request(app, path, { method: 'POST', headers: json, body });
    const remote = await worker(new Request(`https://example.com${path}`, { method: 'POST', headers: json, body }));
    assert.equal(remote.status, local.status, `${path} ${body}`);
    assert.equal(await remote.text(), local.body, `${path} ${body}`);
  }
});
