import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import { assertBodySchema, bodySchemaIssues, compileBodySchema } from '../packages/core/src/body-schema.ts';
import { bodySchemaAjvOptions, bodySchemaRefusal } from '../packages/core/src/body-validation.ts';
import { buildCloudflare } from '../packages/core/src/build-cloudflare.ts';
import { createFetchHandler } from '../packages/core/src/cloudflare.ts';
import { createRuntime } from '../packages/core/src/runtime.ts';
import { startServer } from '../packages/core/src/server.ts';
import { inspectExtensionRevision } from '../packages/core/src/extensions.ts';
import { project, request } from './helpers.ts';
import type { Artifact, BodyValidators, Validators } from '../packages/core/src/cloudflare.ts';
import type { RuntimeExtension } from '../packages/core/src/extensions.ts';
import type { BodySchema, BodySchemaIssue } from '../packages/core/src/body-schema.ts';

// The request.body.<METHOD>.schema JSON Schema 2020-12 profile (#845). The shared fixtures in
// test/fixtures/body-schema/profile.json run on the Node validator (Ajv at load time) and on the
// Cloudflare build's standalone validators, so the two hosts cannot drift.
interface Fixture { accepted: { name: string; schema: BodySchema; valid: unknown[]; invalid: { value: unknown; issues: BodySchemaIssue[] }[] }[]; refused: { name: string; schema: unknown; message: string }[] }
const fixtures = JSON.parse(await readFile(new URL('./fixtures/body-schema/profile.json', import.meta.url), 'utf8')) as Fixture;
const json = { 'content-type': 'application/json' };
const route = (schema: unknown) => ({ methods: ['POST'], request: { body: { POST: { format: 'json', contentTypes: ['application/json'], maxBytes: 4096, schema } } }, respond: { status: 201, json: { ok: true } } });

test('accepted fixtures: valid values pass and invalid values report the fixed issues on Node', () => {
  for (const fixture of fixtures.accepted) {
    assert.doesNotThrow(() => assertBodySchema(fixture.schema), fixture.name);
    for (const value of fixture.valid) assert.deepEqual(bodySchemaIssues(fixture.schema, value), [], `${fixture.name} ${JSON.stringify(value)}`);
    for (const { value, issues } of fixture.invalid) assert.deepEqual(bodySchemaIssues(fixture.schema, value), issues, `${fixture.name} ${JSON.stringify(value)}`);
  }
});

test('refused fixtures fail at load with a bounded diagnostic naming the keyword and pointer, and never echo a $ref value', async t => {
  for (const fixture of fixtures.refused) {
    assert.throws(() => assertBodySchema(fixture.schema), (error: Error) => { assert.equal(error.message, fixture.message, fixture.name); return true; });
    // Compiling reports the identical diagnostic: every refusal is the profile's, before Ajv sees the schema.
    assert.throws(() => compileBodySchema(fixture.schema), (error: Error) => { assert.equal(error.message, fixture.message, fixture.name); return true; });
    assert.doesNotMatch(fixture.message, /hunter2|schemas\.example\.com\/a\.json/);
  }
  // The same refusal happens before serving: validate, the server and the Cloudflare build all refuse the project.
  const remote = fixtures.refused.find(fixture => fixture.name === 'remote ref')!;
  const root = await project(t, { '/x': route(remote.schema) });
  await assert.rejects(startServer({ project: root, port: 0, log: () => {} }), (error: Error) => { assert.match(error.message, /\/properties\/a\/\$ref: \$ref must be a local/); assert.doesNotMatch(error.message, /hunter2/); return true; });
  const out = await mkdtemp(join(tmpdir(), 'urlcode-cf-')); t.after(() => rm(out, { recursive: true, force: true }));
  await assert.rejects(buildCloudflare(root, { out }), /\$ref must be a local/);
  // A key that is not a string keyword is bounded in the diagnostic.
  assert.throws(() => assertBodySchema({ type: 'object', ['x'.repeat(5000)]: 1 }), (error: Error) => error.message.length < 600);
});

test('what Ajv strict mode refused raw is now a pointed profile diagnostic, on every host', async t => {
  const overlap = fixtures.refused.find(fixture => fixture.name === 'properties matched by patternProperties')!;
  const root = await project(t, { '/x': route(overlap.schema) });
  await assert.rejects(startServer({ project: root, port: 0, log: () => {} }), (error: Error) => { assert.match(error.message, /Body schema \/properties\/x-id: is also matched by/); return true; });
  const out = await mkdtemp(join(tmpdir(), 'urlcode-cf-')); t.after(() => rm(out, { recursive: true, force: true }));
  await assert.rejects(buildCloudflare(root, { out }), /Body schema \/properties\/x-id: is also matched by/);
  // A control character in a declared name never reaches the diagnostic.
  assert.throws(() => assertBodySchema({ type: 'object', propertyNames: { maxLength: 32 }, properties: { 'x\u0007a': true }, patternProperties: { '^x': true } }), (error: Error) => /^Body schema \/properties\/x\?a: is also matched/.test(error.message));
  // Satisfiable neighbours of the refused conditions stay admitted.
  for (const schema of [
    { type: 'object', required: ['b'], properties: { a: true } }, // required without additionalProperties: false
    { type: 'object', required: ['x-b'], additionalProperties: false, propertyNames: { maxLength: 32 }, patternProperties: { '^x-': true } }, // required name matched by a pattern
    { minLength: 1 }, { type: ['string', 'number'], minLength: 1, minimum: 0 }, { type: 'number', enum: [1, 2.5], const: 1 }, { type: 'integer', const: 2 },
    { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'number' }, minItems: 3 }, { type: 'array', prefixItems: [true, true], items: false, minItems: 2 },
  ]) assert.doesNotThrow(() => compileBodySchema(schema), JSON.stringify(schema));
});

test('an Ajv refusal the profile did not foresee is mapped to a pointer and redacted', () => {
  // Ajv run directly on schemas the profile would refuse first, to reach each of its refusal shapes.
  const refuse = (schema: object): string => {
    const ajv = new Ajv.default({ ...bodySchemaAjvOptions });
    try { ajv.compile(schema); } catch (error) { return bodySchemaRefusal(error, ajv.errors); }
    throw new Error('Ajv compiled the schema');
  };
  // Strict-mode refusal without a path: root pointer, Ajv's option hint dropped.
  assert.equal(refuse({ type: 'object', properties: { xa: true }, patternProperties: { '^x': true } }),
    'Body schema /: the JSON Schema 2020-12 validator refused this schema (property xa matches pattern ^x)');
  // Unknown format: the pointer comes from Ajv's path, the quoted format is elided.
  assert.equal(refuse({ type: 'object', properties: { a: { type: 'string', format: 'hunter2-format' } } }),
    'Body schema /properties/a: the JSON Schema 2020-12 validator refused this schema (unknown format "...")');
  // Meta-schema failure: the pointer is Ajv's instancePath into the schema.
  assert.equal(refuse({ type: 'object', properties: { a: { minLength: -1 } } }),
    'Body schema /properties/a/minLength: does not satisfy the JSON Schema 2020-12 meta-schema at keyword minimum');
  // An unresolvable $ref never echoes the reference, which may carry credentials.
  assert.equal(refuse({ type: 'object', properties: { a: { $ref: 'https://user:hunter2@schemas.example.com/a.json' } } }),
    'Body schema /: a $ref could not be resolved (only a local #/$defs/<name> reference is supported)');
  // An arbitrary message: quoted text, URLs and # references elided, control characters replaced, length capped.
  const odd = bodySchemaRefusal(new Error(`strict mode: const 'sk_live_1' from https://u:hunter2@x.test/s#/a at \u0001 ${'z'.repeat(400)} (use allowSomething)`));
  assert.match(odd, /^Body schema \/: the JSON Schema 2020-12 validator refused this schema \(const "\.\.\." from <ref> at \? z+\.\.\.\)$/);
  assert.doesNotMatch(odd, /sk_live|hunter2|allowSomething|\u0001/);
  assert.ok(odd.length < 260);
  assert.equal(bodySchemaRefusal('odd'), 'Body schema /: the JSON Schema 2020-12 validator refused this schema (odd)');
  assert.equal(bodySchemaRefusal(new Error('x'), [{ instancePath: '/a\u0000b', keyword: '"><script>' }]), 'Body schema /a?b: does not satisfy the JSON Schema 2020-12 meta-schema at keyword schema');
});

test('resource limits: schema nodes, depth, $ref uses, $defs entries and the size a schema expands to through $ref', () => {
  const defs: Record<string, unknown> = {};
  for (let i = 0; i < 33; i++) defs[`d${i}`] = { type: 'string' };
  assert.throws(() => assertBodySchema({ type: 'object', $defs: defs }), /\/\$defs: declares more than 32 schemas/);
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 33; i++) properties[`p${i}`] = { $ref: '#/$defs/d0' };
  assert.throws(() => assertBodySchema({ type: 'object', $defs: { d0: { type: 'string' } }, properties }), /more than 32 \$ref uses/);
  // Each level uses the one below it four times: 12 source nodes, far more once expanded.
  const chain: Record<string, unknown> = { l0: { type: 'string' } };
  for (let i = 1; i < 6; i++) chain[`l${i}`] = { allOf: [{ $ref: `#/$defs/l${i - 1}` }, { $ref: `#/$defs/l${i - 1}` }, { $ref: `#/$defs/l${i - 1}` }, { $ref: `#/$defs/l${i - 1}` }] };
  assert.throws(() => assertBodySchema({ $defs: chain, $ref: '#/$defs/l5' }), /expands through \$ref to more than 1024 schema nodes/);
  assert.doesNotThrow(() => assertBodySchema({ $defs: { l0: chain.l0, l1: chain.l1, l2: chain.l2 }, $ref: '#/$defs/l2' }));
  assert.throws(() => assertBodySchema({ $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' }), /recursive \$ref/);
  assert.throws(() => assertBodySchema({ type: 'object', properties: { a: { $defs: {} } } }), /\/properties\/a\/\$defs: \$defs is allowed only at the root/);
  assert.throws(() => assertBodySchema({ type: 'object', properties: { a: { $schema: 'https://json-schema.org/draft/2020-12/schema' } } }), /allowed only at the root/);
});

test('regex admission: catastrophic patterns are refused, and an over-long value or key never reaches an admitted regex', () => {
  const slow = '^[a-z]*[a-z]*[a-z]*!$';
  const value = bodySchemaIssues({ type: 'string', maxLength: 128, pattern: slow }, 'a'.repeat(100000));
  assert.deepEqual(value.map(issue => issue.keyword), ['maxLength']);
  const start = performance.now();
  const key = bodySchemaIssues({ type: 'object', propertyNames: { maxLength: 128 }, patternProperties: { [slow]: true }, additionalProperties: false }, { ['a'.repeat(100000)]: 1 });
  assert.ok(performance.now() - start < 500, 'the property name bound runs before patternProperties');
  assert.deepEqual(key.map(issue => issue.keyword), ['propertyNames']);
  assert.doesNotMatch(JSON.stringify(key), /aaaa/);
});

test('absent and null are different: a nullable required property accepts null but not absence; an optional one accepts both', () => {
  const schema: BodySchema = { type: 'object', required: ['a'], properties: { a: { type: ['string', 'null'] }, b: { type: 'string' }, c: { type: ['integer', 'null'] } } };
  assert.deepEqual(bodySchemaIssues(schema, { a: null }), []);
  assert.deepEqual(bodySchemaIssues(schema, { a: null, c: null }), []);
  assert.deepEqual(bodySchemaIssues(schema, {}).map(issue => issue.keyword), ['required']);
  assert.deepEqual(bodySchemaIssues(schema, { a: 'x', b: null }), [{ pointer: '/b', keyword: 'type', message: 'must be a string', expected: 'string' }]);
  // Only own properties count: an inherited name such as toString never satisfies `required`.
  assert.deepEqual(bodySchemaIssues({ type: 'object', required: ['toString'] }, {}).map(issue => issue.property), ['toString']);
  assert.deepEqual(bodySchemaIssues({ type: 'null' }, null), []);
});

test('issue pointers name only declared properties; any other client key is "*" and an array position "[]"', () => {
  const schema: BodySchema = { type: 'object', additionalProperties: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' } } } } };
  const issues = bodySchemaIssues(schema, { 'sk_live_TOPSECRET': [{ n: 1 }, { n: 'x' }] });
  assert.deepEqual(issues, [{ pointer: '/*/[]/n', keyword: 'type', message: 'must be an integer', expected: 'integer' }]);
  assert.equal(compileBodySchema(schema), compileBodySchema(schema), 'compiled once per schema object');
});

test('the Cloudflare build runs the same fixtures through build-time standalone validators, with no code generation at runtime', async t => {
  const routes: Record<string, unknown> = {};
  fixtures.accepted.forEach((fixture, index) => { routes[`/f${index}`] = route(fixture.schema); });
  const root = await project(t, routes as never);
  const out = await mkdtemp(join(tmpdir(), 'urlcode-cf-')); t.after(() => rm(out, { recursive: true, force: true }));
  await buildCloudflare(root, { out });
  const source = await readFile(join(out, 'body-validators.js'), 'utf8');
  assert.doesNotMatch(source, /\bnew Function\b|\beval\(|\brequire\(/, 'standalone ESM, nothing compiled at runtime');
  const artifact = ((await import(pathToFileURL(join(out, 'artifact.js')).href)) as { default: Artifact }).default;
  const validators = (await import(pathToFileURL(join(out, 'validators.js')).href)) as Validators;
  const bodyValidators = (await import(pathToFileURL(join(out, 'body-validators.js')).href)) as BodyValidators;
  assert.throws(() => createFetchHandler(artifact, validators, {}), /missing the request\.body\.POST\.schema validator for \/f0; rebuild/);
  const worker = createFetchHandler(artifact, validators, bodyValidators);
  const app = await startServer({ project: root, port: 0, log: () => {} }); t.after(() => app.close());
  for (const [index, fixture] of fixtures.accepted.entries()) {
    for (const value of fixture.valid) {
      const answer = await worker(new Request(`https://example.com/f${index}`, { method: 'POST', headers: json, body: JSON.stringify(value) }));
      assert.equal(answer.status, 201, `${fixture.name} ${JSON.stringify(value)}`);
    }
    for (const { value, issues } of fixture.invalid) {
      const body = JSON.stringify(value);
      const remote = await worker(new Request(`https://example.com/f${index}`, { method: 'POST', headers: json, body }));
      const local = await request(app, `/f${index}`, { method: 'POST', headers: json, body });
      const text = await remote.text();
      assert.equal(remote.status, 422); assert.equal(text, local.body, `${fixture.name} ${body}`);
      assert.deepEqual((JSON.parse(text) as { issues: unknown }).issues, issues);
    }
  }
});

test('identity before validation: an unauthenticated request with an invalid body gets the auth refusal, not a 422', async t => {
  const root = await project(t, { '/notes': { ...route({ type: 'object', required: ['text'], properties: { text: { type: 'string' } } }), policies: { extensions: { gate: {} } } } }, {}, { extensions: { gate: { version: '1', config: {} } } });
  const gate: RuntimeExtension = {
    name: 'gate', version: '1', projectSha256: await inspectExtensionRevision(root), targets: ['node', 'aws', 'vercel'],
    schema: { type: 'object', additionalProperties: false }, policySchema: { type: 'object', additionalProperties: false },
    activate() { return { handle() { return { status: 404, headers: [], body: '' }; },
      authorize(_policy, req) { return req.headers.get('cookie') === 'session=yes' ? undefined : { status: 401, headers: [], body: 'sign in' }; } }; },
  };
  const runtime = await createRuntime(root, { origin: 'https://gate.example.test', extensions: [gate] }); t.after(() => runtime.close());
  const body = new TextEncoder().encode('{"text":5}');
  const denied = await runtime.handle({ target: '/notes', method: 'POST', headers: new Headers(json), body });
  assert.equal(denied.status, 401);
  // Once the identity is admitted, the same body reaches validation (runtime.handle surfaces the 422 as an HttpError).
  await assert.rejects(runtime.handle({ target: '/notes', method: 'POST', headers: new Headers({ ...json, cookie: 'session=yes' }), body }), (error: { status?: number }) => error.status === 422);
});
