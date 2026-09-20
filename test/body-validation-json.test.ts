import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../src/server.ts';
import { buildCloudflare } from '../src/build-cloudflare.ts';
import { createFetchHandler } from '../src/cloudflare.ts';
import { bodySchemaIssues, bodySchemaJson, prefersJson } from '../src/body-schema.ts';
import type { BodySchema } from '../src/body-schema.ts';
import { project, request } from './helpers.ts';
import type { Artifact, Validators } from '../src/cloudflare.ts';

const secret = 'sk_live_TOPSECRET_9f8e7d';
const schema = { type: 'object', required: ['title', 'kind'], additionalProperties: false, properties: {
  title: { type: 'string', minLength: 1, maxLength: 8 }, kind: { type: 'string', enum: ['a', 'b'] }, count: { type: 'integer', maximum: 3 },
  'a/b~c': { type: 'boolean' }, list: { type: 'array', maxItems: 2, items: { type: 'string', pattern: '^[a-z]+$', maxLength: 8 } } } } satisfies BodySchema;
const routes = {
  '/todos': { methods: ['POST'], request: { body: { format: 'json', contentTypes: ['application/json'], maxBytes: 4096, schema: structuredClone(schema) } }, respond: { status: 201, json: { ok: true } } },
  '/box': { sandbox: true, methods: ['POST'], function: { source: 'f.mjs' }, request: { body: { format: 'json', schema: structuredClone(schema) } } },
};
const files = { 'f.mjs': 'export default () => new Response("guest ran");' };
const bad = { title: secret, kind: secret, count: 99, 'a/b~c': secret, list: [secret, 'ok', secret], [secret]: secret };
const textAccepts = [undefined, '*/*', 'text/html,application/xhtml+xml,*/*;q=0.8', 'text/plain', 'application/json;q=0'];

test('prefersJson negotiates conservatively: only an explicit application/json wins', () => {
  for (const yes of ['application/json', 'text/html, application/json;q=0.9', 'application/json, text/plain;q=0.5', 'APPLICATION/JSON ; q=1']) assert.equal(prefersJson(yes), true, yes);
  for (const no of [undefined, '', '*/*', 'application/*', 'text/plain', 'text/html', 'application/json;q=0', 'text/plain, application/json;q=0.5', 'application/json;q=abc', 'application/jsonx', 'x'.repeat(2000) + ',application/json']) assert.equal(prefersJson(no), false, String(no).slice(0, 40));
});

test('a 422 answers a structured JSON body on request and never carries client values (trusted and sandboxed)', async t => {
  const app = await startServer({ project: await project(t, routes as never, files), port: 0, log: () => {} }); t.after(() => app.close());
  const post = (path: string, body: unknown, accept?: string) => request(app, path, { method: 'POST', headers: { 'content-type': 'application/json', ...(accept ? { accept } : {}) }, body: JSON.stringify(body) });
  for (const path of ['/todos', '/box']) {
    const json = await post(path, bad, 'application/json');
    assert.equal(json.status, 422, path);
    assert.equal(json.headers['content-type'], 'application/json');
    assert.equal(json.headers['cache-control'], 'no-store');
    assert.doesNotMatch(json.body, /TOPSECRET/); assert.doesNotMatch(json.body, /guest ran/);
    const parsed = JSON.parse(json.body) as { error: string; issues: { pointer: string; keyword: string; expected?: unknown }[] };
    assert.equal(parsed.error, 'body_validation_failed');
    const has = (pointer: string, keyword: string) => parsed.issues.find(issue => issue.pointer === pointer && issue.keyword === keyword);
    assert.equal(has('/title', 'maxLength')?.expected, 8);
    assert.deepEqual(has('/kind', 'enum')?.expected, ['a', 'b']);
    assert.equal(has('/count', 'maximum')?.expected, 3);
    assert.ok(has('', 'additionalProperties'));
    assert.ok(parsed.issues.length <= 8);
    const missing = JSON.parse((await post(path, {}, 'application/json')).body) as { issues: { property?: string }[] };
    assert.deepEqual(missing.issues.map(issue => issue.property), ['title', 'kind']);
    for (const accept of textAccepts) {
      const text = await post(path, bad, accept);
      assert.equal(text.status, 422); assert.match(text.headers['content-type']!, /^text\/plain/);
      assert.match(text.body, /^Request body failed validation\n[^]*\/title must be at most 8 characters/); assert.doesNotMatch(text.body, /TOPSECRET/);
    }
    assert.equal((await request(app, path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{bad' })).status, 400);
  }
});

test('the built Worker answers the same JSON and text 422 bodies as the server', async t => {
  const root = await project(t, { '/todos': routes['/todos'] });
  const out = await mkdtemp(join(tmpdir(), 'urlcode-cf-')); t.after(() => rm(out, { recursive: true, force: true }));
  await buildCloudflare(root, { out });
  const artifact = ((await import(pathToFileURL(join(out, 'artifact.js')).href)) as { default: Artifact }).default;
  const validators = (await import(pathToFileURL(join(out, 'validators.js')).href)) as Validators;
  const worker = createFetchHandler(artifact, validators);
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
  const properties: Record<string, BodySchema> = {}; const required: string[] = [];
  for (let i = 0; i < 40; i++) { const name = `field${i}_${'n'.repeat(400)}`; properties[name] = { type: 'string' }; required.push(name); }
  const text = bodySchemaJson(bodySchemaIssues({ type: 'object', properties, required }, {}, '', [], 40));
  assert.ok(new TextEncoder().encode(text).length <= 4096);
  const parsed = JSON.parse(text) as { truncated?: boolean; issues: unknown[] };
  assert.equal(parsed.truncated, true); assert.ok(parsed.issues.length > 0 && parsed.issues.length < 40);
  assert.equal((JSON.parse(bodySchemaJson(bodySchemaIssues(schema, {}))) as { truncated?: boolean }).truncated, undefined);
  assert.equal(bodySchemaIssues({ type: 'array', items: { type: 'string' } }, Array(50).fill(1)).length, 8);
  const escaped = bodySchemaIssues(schema, { title: 'x', kind: 'a', 'a/b~c': 1 });
  assert.equal(escaped[0]?.pointer, '/a~1b~0c');
});
