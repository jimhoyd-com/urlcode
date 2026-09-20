import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.ts';
import { assertBodySchema, checkBodySchema } from '../src/body-schema.ts';
import { assertSafePattern } from '../src/pattern-guard.ts';
import type { BodySchema } from '../src/body-schema.ts';
import { project, request, param } from './helpers.ts';
import type { TestContext } from 'node:test';
// Deliberately unsafe patterns, joined at runtime: they are test inputs the guard must reject, never compiled here.
const unsafe = (head: string, tail: string): string => head + tail;

const uuid = '123e4567-e89b-42d3-a456-426614174000';
const todo = { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string', minLength: 1, maxLength: 200 } } } satisfies BodySchema;
const bodyPolicy = { format: 'json', contentTypes: ['application/json'], maxBytes: 4096, schema: todo };
async function serve(t: TestContext, routes: Parameters<typeof project>[1], files: Parameters<typeof project>[2] = {}) {
  const app = await startServer({ project: await project(t, routes, files), port: 0, log: () => {} }); t.after(() => app.close()); return app;
}

test('accepted patterns stay fast on adversarial input at the length cap (ReDoS bound)', () => {
  // The worst shapes the guard still allows: three adjacent unbounded quantifiers, polynomial on at most 256 characters.
  const worst: [string, string][] = [['^[a-z]*[a-z]*[a-z]*!$', 'a'.repeat(256)], ['^\\w+\\w+\\w+$', 'a'.repeat(255) + '!'], ['^[ab]+[ab]+[ab]+c$', 'ab'.repeat(128)]];
  for (const [pattern, input] of worst) {
    assert.doesNotThrow(() => assertSafePattern(pattern), pattern);
    const schema: BodySchema = { type: 'string', pattern, maxLength: 256 };
    assert.doesNotThrow(() => assertBodySchema(schema));
    const start = performance.now(); checkBodySchema(schema, input); const ms = performance.now() - start;
    assert.ok(ms < 500, `${pattern} took ${ms.toFixed(0)} ms`);
  }
  for (const evil of [unsafe('^(','a+)+$'), unsafe('^(','a*)*$'), unsafe('^(','a|a)+$'), unsafe('^(','[a-z]+)*$')]) assert.throws(() => assertSafePattern(evil), /repeat a group/, evil);
  const schema: BodySchema = { type: 'string', pattern: '^[a-z]*[a-z]*[a-z]*!$', maxLength: 256 };
  const start = performance.now(); checkBodySchema(schema, 'a'.repeat(100000)); assert.ok(performance.now() - start < 50, 'over-long input never reaches the regex');
});

test('activation rejects ReDoS-prone or unbounded body patterns before serving', async t => {
  for (const schema of [{ type: 'string', pattern: unsafe('^(','a+)+$'), maxLength: 10 }, { type: 'string', pattern: '^[a-z]+$' }, { type: 'string', pattern: 'a'.repeat(129), maxLength: 10 }]) {
    const root = await project(t, { '/x': { methods: ['POST'], request: { body: { format: 'json', schema } }, respond: { json: {} } } });
    await assert.rejects(startServer({ project: root, port: 0, log: () => {} }), /./, JSON.stringify(schema).slice(0, 60));
  }
});

test('body schema limits: bytes, depth, node count, property count, string, item and enum bounds', async t => {
  const wide: Record<string, BodySchema> = {}, many: Record<string, BodySchema> = {};
  for (let i = 0; i < 65; i++) wide[`p${i}`] = { type: 'string' };
  for (let i = 0; i < 64; i++) many[`p${i}`] = { type: 'string' };
  assert.throws(() => assertBodySchema({ type: 'object', properties: wide }), /at most 64/);
  assert.throws(() => assertBodySchema({ type: 'object', properties: { a: { type: 'object', properties: many }, b: { type: 'object', properties: many } } }), /too large/);
  assert.throws(() => assertBodySchema({ type: 'string', maxLength: 8193 }), /maxLength/);
  assert.throws(() => assertBodySchema({ type: 'array', maxItems: 10001 }), /maxItems/);
  assert.throws(() => assertBodySchema({ type: 'string', enum: Array.from({ length: 65 }, (_, i) => `v${i}`) }), /1 to 64/);
  const app = await serve(t, { '/todos': { methods: ['POST'], request: { body: { ...bodyPolicy, maxBytes: 64 } }, respond: { status: 201, json: { ok: true } } } });
  const post = (body: string) => request(app, '/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal((await post('{"title":"ok"}')).status, 201);
  assert.equal((await post(JSON.stringify({ title: 'x'.repeat(200) }))).status, 413, 'the byte cap applies before schema validation');
});

test('sandboxed routes get the same body and parameter validation before any guest code runs', async t => {
  const route = (sandbox: boolean) => ({ ...(sandbox ? { sandbox: true } : {}), methods: ['POST'], function: { source: 'f.mjs' },
    parameters: [{ ...param('id'), schema: { type: 'string', format: 'uuid' } }], request: { body: structuredClone(bodyPolicy) } });
  const app = await serve(t, { '/box/{id}': route(true), '/trusted/{id}': route(false) }, { 'f.mjs': 'export default () => new Response("guest ran");' });
  const post = (path: string, body: string) => request(app, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  for (const base of ['/box', '/trusted']) {
    const ok = await post(`${base}/${uuid}`, '{"title":"a"}');
    assert.equal(ok.status, 200, base); assert.equal(ok.body, 'guest ran');
    const bad = await post(`${base}/${uuid}`, '{"title":5}');
    assert.equal(bad.status, 422, base); assert.doesNotMatch(bad.body, /guest ran/);
    assert.equal((await post(`${base}/nope`, '{"title":"a"}')).status, 400, base);
    assert.equal((await post(`${base}/${uuid}`, '{bad')).status, 400, base);
  }
});
