import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../packages/core/src/server.ts';
import { assertBodySchema, bodySchemaSubset, checkBodySchema, maxRequestBodyBytes } from '../packages/core/src/body-schema.ts';
import { assertSafePattern } from '../packages/core/src/pattern-guard.ts';
import type { BodySchema } from '../packages/core/src/body-schema.ts';
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
  // The worst shapes the guard still allows: three adjacent unbounded quantifiers, polynomial on at most 128 characters.
  // This is a regression tripwire, not a benchmark: hosted Windows runners can
  // be descheduled long enough that a 500 ms ceiling flakes. Two seconds still
  // catches a materially worse permitted pattern while the 128-character input
  // bound remains the actual resource control.
  const hostedRunnerCeilingMs = 2_000;
  const worst: [string, string][] = [['^[a-z]*[a-z]*[a-z]*!$', 'a'.repeat(128)], ['^\\w+\\w+\\w+$', 'a'.repeat(127) + '!'], ['^[ab]+[ab]+[ab]+c$', 'ab'.repeat(64)],
    // Flat runs of optional, bounded or alternative atoms, each at the edge of the path budget.
    ['^[a-z]*[a-z]*[a-z]*a?!$', 'a'.repeat(128)], ['^' + 'a?'.repeat(20) + '!$', 'a'.repeat(128)], ['^' + '[a-z]{0,8}'.repeat(6) + '!$', 'a'.repeat(128)],
    ['^' + '(a|a)'.repeat(20) + '!$', 'a'.repeat(128)],
    // Unanchored patterns are retried from every start position, so they get less room.
    ['[a-z]*[a-z]*!', 'a'.repeat(128)], ['[a-z]{0,8}'.repeat(4) + '!', 'a'.repeat(128)], ['a?'.repeat(13) + '!', 'a'.repeat(128)]];
  for (const [pattern, input] of worst) {
    assert.doesNotThrow(() => assertSafePattern(pattern), pattern);
    const schema: BodySchema = { type: 'string', pattern, maxLength: 128 };
    assert.doesNotThrow(() => assertBodySchema(schema));
    const start = performance.now(); checkBodySchema(schema, input); const ms = performance.now() - start;
    assert.ok(ms < hostedRunnerCeilingMs, `${pattern} took ${ms.toFixed(0)} ms (limit ${hostedRunnerCeilingMs} ms)`);
  }
  for (const evil of [unsafe('^(','a+)+$'), unsafe('^(','a*)*$'), unsafe('^(','a|a)+$'), unsafe('^(','[a-z]+)*$')]) assert.throws(() => assertSafePattern(evil), /repeat a group/, evil);
  // The same repeats written out flat: every variable-width quantifier (`?`, `{n,m}`) and alternation counts.
  for (const evil of ['^' + 'a?'.repeat(21) + '!$', '^' + '[a-z]{0,64}'.repeat(4) + '!$', '^' + '[a-z]{0,16}'.repeat(6) + '!$', '^' + '(a|a)'.repeat(21) + '!$',
    '^[a-z]*[a-z]*[a-z]*a?a?!$', '^[a-z]*[a-z]*[a-z]*[a-z]{0,8}!$', '[a-z]*[a-z]*[a-z]*!', '[a-z]{0,8}'.repeat(6) + '!', '^' + '\\w{0,40}'.repeat(4) + '!$']) {
    assert.throws(() => assertSafePattern(evil), /matching cost/, evil);
  }
  for (const ordinary of ['^\\+?[0-9]{7,15}$', '^[A-Z]{2}-?[0-9]{3,5}$', '^https?://[a-z.]+/?$', '^[^@]+@[^@]+\\.[a-z]{2,6}$', '^\\d{3}-?\\d{3}-?\\d{4}$', '^(jpg|png|gif|webp)$', '^[a-z]*?[a-z]+?$']) {
    assert.doesNotThrow(() => assertSafePattern(ordinary), ordinary);
  }
  const schema: BodySchema = { type: 'string', pattern: '^[a-z]*[a-z]*[a-z]*!$', maxLength: 128 };
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
  assert.throws(() => assertBodySchema({ type: 'string', maxLength: maxRequestBodyBytes + 1 }), /maxLength must be an integer from 0 to 1048576/);
  assert.throws(() => assertBodySchema({ type: 'string', minLength: maxRequestBodyBytes + 1 }), /minLength/);
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

test('a string without a pattern may be as long as the request body limit; a pattern keeps its regex cap (#713)', async t => {
  assert.equal(maxRequestBodyBytes, 1048576);
  assert.equal(bodySchemaSubset.limits.length, maxRequestBodyBytes, 'the published subset states the new string cap');
  for (const maxLength of [8193, 100000, maxRequestBodyBytes]) {
    assert.doesNotThrow(() => assertBodySchema({ type: 'string', maxLength }), String(maxLength));
    assert.doesNotThrow(() => assertBodySchema({ type: 'string', minLength: maxLength, maxLength }), String(maxLength));
  }
  assert.throws(() => assertBodySchema({ type: 'string', pattern: '^[a-z]+$', maxLength: 129 }), /pattern requires maxLength of at most 128/);
  assert.throws(() => assertBodySchema({ type: 'string', pattern: '^[a-z]+$', maxLength: 8193 }), /pattern requires maxLength of at most 128/);
  assert.throws(() => assertBodySchema({ type: 'array', maxItems: 10001 }), /maxItems must be an integer from 0 to 10000/, 'item bounds are unchanged');

  const note = { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', minLength: 9000, maxLength: 100000 } } } satisfies BodySchema;
  const app = await serve(t, { '/notes': { methods: ['POST'], request: { body: { format: 'json', contentTypes: ['application/json'], schema: note } }, respond: { status: 201, json: { ok: true } } } });
  const post = (text: string) => request(app, '/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  assert.equal((await post('x'.repeat(50000))).status, 201, 'a 50,000-character string within the bounds is accepted');
  const long = await post('x'.repeat(100001));
  assert.equal(long.status, 422);
  assert.deepEqual(JSON.parse(long.body).issues, [{ pointer: '/text', keyword: 'maxLength', message: 'must be at most 100000 characters', expected: 100000 }]);
  const short = await post('x'.repeat(8193));
  assert.equal(short.status, 422);
  assert.equal(JSON.parse(short.body).issues[0].keyword, 'minLength');
});
