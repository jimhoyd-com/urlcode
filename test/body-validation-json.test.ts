import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../packages/core/src/server.ts';
import { buildCloudflare } from '../packages/core/src/build-cloudflare.ts';
import { createFetchHandler } from '../packages/core/src/cloudflare.ts';
import { bodySchemaIssues, bodySchemaJson } from '../packages/core/src/body-schema.ts';
import type { BodySchema } from '../packages/core/src/body-schema.ts';
import { project, request } from './helpers.ts';
import type { Artifact, Validators, BodyValidators } from '../packages/core/src/cloudflare.ts';

const secret = 'sk_live_TOPSECRET_9f8e7d';
const schema = { type: 'object', required: ['title', 'kind'], additionalProperties: false, properties: {
  title: { type: 'string', minLength: 1, maxLength: 8 }, kind: { type: 'string', enum: ['a', 'b'] }, count: { type: 'integer', maximum: 3 },
  'a/b~c': { type: 'boolean' }, list: { type: 'array', maxItems: 2, items: { type: 'string', pattern: '^[a-z]+$', maxLength: 8 } } } } satisfies BodySchema;
const routes = {
  '/todos': { methods: ['POST'], request: { body: { format: 'json', contentTypes: ['application/json'], maxBytes: 4096, schema: structuredClone(schema) } }, respond: { status: 201, json: { ok: true } } },
  '/box': { sandbox: true, methods: ['POST'], function: { source: 'f.mjs' }, request: { body: { format: 'json', schema: structuredClone(schema) } } },
};
const files = { 'f.mjs': 'export default () => new Response("guest ran");' };
const bad = { title: secret, kind: secret, count: 99, 'a/b~c': secret, list: [secret, 'ok', secret], extra: secret, ['<' + secret + '>']: secret };
const textAccepts = [undefined, '*/*', 'text/html,application/xhtml+xml,*/*;q=0.8', 'text/plain', 'application/json;q=0'];

test('a JSON-schema route always answers 422 as JSON, names identifier-shaped extra properties and never carries client values (trusted and sandboxed)', async t => {
  const app = await startServer({ project: await project(t, routes as never, files), port: 0, log: () => {} }); t.after(() => app.close());
  const post = (path: string, body: unknown, accept?: string) => request(app, path, { method: 'POST', headers: { 'content-type': 'application/json', ...(accept ? { accept } : {}) }, body: JSON.stringify(body) });
  for (const path of ['/todos', '/box']) {
    const json = await post(path, bad, 'application/json');
    assert.equal(json.status, 422, path);
    assert.equal(json.headers['content-type'], 'application/json');
    assert.equal(json.headers['cache-control'], 'no-store');
    assert.doesNotMatch(json.body, /TOPSECRET/); assert.doesNotMatch(json.body, /guest ran/);
    const parsed = JSON.parse(json.body) as { error: string; issues: { pointer: string; keyword: string; expected?: unknown; property?: string }[] };
    assert.equal(parsed.error, 'body_validation_failed');
    // Ajv stops at the first failure: here the first undeclared property, named because it looks like an identifier.
    assert.deepEqual(parsed.issues, [{ pointer: '', keyword: 'additionalProperties', message: 'has a property the schema does not declare', property: 'extra' }]);
    const first = async (body: unknown) => (JSON.parse((await post(path, body, 'application/json')).body) as typeof parsed).issues;
    assert.deepEqual((await first({ title: secret, kind: 'a' }))[0], { pointer: '/title', keyword: 'maxLength', message: 'must be at most 8 characters', expected: 8 });
    assert.deepEqual((await first({ title: 'x', kind: secret }))[0]?.expected, ['a', 'b']);
    assert.deepEqual((await first({ title: 'x', kind: 'a', count: 99 }))[0]?.expected, 3);
    assert.deepEqual((await first({ title: 'x', kind: 'a', list: ['ok', secret] }))[0], { pointer: '/list/[]', keyword: 'maxLength', message: 'must be at most 8 characters', expected: 8 });
    assert.deepEqual(await first({ title: 'x', kind: 'a', ['<' + secret + '>']: secret }), [{ pointer: '', keyword: 'additionalProperties', message: 'has a property the schema does not declare' }]);
    assert.deepEqual((await first({})).map(issue => issue.property), ['title']);
    for (const accept of textAccepts) {
      const answer = await post(path, bad, accept);
      assert.equal(answer.status, 422); assert.equal(answer.headers['content-type'], 'application/json', String(accept));
      assert.equal(answer.body, json.body); assert.doesNotMatch(answer.body, /TOPSECRET/);
    }
    assert.equal((await request(app, path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{bad' })).status, 400);
  }
});

test('the built Worker answers the same JSON 422 body as the server, whatever the Accept header', async t => {
  const root = await project(t, { '/todos': routes['/todos'] });
  const out = await mkdtemp(join(tmpdir(), 'urlcode-cf-')); t.after(() => rm(out, { recursive: true, force: true }));
  await buildCloudflare(root, { out });
  const artifact = ((await import(pathToFileURL(join(out, 'artifact.js')).href)) as { default: Artifact }).default;
  const validators = (await import(pathToFileURL(join(out, 'validators.js')).href)) as Validators; const bodyValidators = (await import(pathToFileURL(join(out, 'body-validators.js')).href)) as BodyValidators;
  const worker = createFetchHandler(artifact, validators, bodyValidators);
  const app = await startServer({ project: root, port: 0, log: () => {} }); t.after(() => app.close());
  const body = JSON.stringify(bad);
  for (const accept of ['application/json', ...textAccepts]) {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(accept ? { accept } : {}) };
    const local = await request(app, '/todos', { method: 'POST', headers, body });
    const remote = await worker(new Request('https://example.com/todos', { method: 'POST', headers, body }));
    assert.equal(remote.status, 422); assert.equal(local.status, 422);
    assert.equal(remote.headers.get('content-type'), local.headers['content-type']);
    const text = await remote.text();
    assert.equal(text, local.body, String(accept)); assert.doesNotMatch(text, /TOPSECRET/);
  }
});

test('the JSON 422 body is bounded, RFC 6901 escaped and omits nothing silently', () => {
  const issues = Array.from({ length: 40 }, (_, i) => ({ pointer: `/field${i}_${'n'.repeat(400)}`, keyword: 'required', message: 'is missing a required property' }));
  const text = bodySchemaJson(issues);
  assert.ok(new TextEncoder().encode(text).length <= 4096);
  const parsed = JSON.parse(text) as { truncated?: boolean; issues: unknown[] };
  assert.equal(parsed.truncated, true); assert.ok(parsed.issues.length > 0 && parsed.issues.length < 40);
  assert.equal((JSON.parse(bodySchemaJson(bodySchemaIssues(schema, {}))) as { truncated?: boolean }).truncated, undefined);
  assert.equal(bodySchemaIssues({ type: 'array', items: { type: 'string' } }, Array(50).fill(1)).length, 1);
  const escaped = bodySchemaIssues(schema, { title: 'x', kind: 'a', 'a/b~c': 1 });
  assert.equal(escaped[0]?.pointer, '/a~1b~0c');
});
