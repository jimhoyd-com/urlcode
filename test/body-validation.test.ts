import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../packages/core/src/server.ts';
import { assertBodySchema, checkBodySchema } from '../packages/core/src/body-schema.ts';
import { assertSafePattern } from '../packages/core/src/pattern-guard.ts';
import { compileHttp, checkRequest } from '../packages/core/src/http-policy.ts';
import type { HttpRoute } from '../packages/core/src/http-policy.ts';
import type { BodySchema } from '../packages/core/src/body-schema.ts';
import { project, request, param } from './helpers.ts';
import type { TestContext } from 'node:test';
// Deliberately unsafe patterns, joined at runtime: they are test inputs the guard must reject, never compiled here.
const unsafe = (head: string, tail: string): string => head + tail;

const uuid = '123e4567-e89b-42d3-a456-426614174000';
const todo = { type: 'object', required: ['title'], additionalProperties: false, properties: {
  title: { type: 'string', minLength: 1, maxLength: 200 }, description: { type: 'string', maxLength: 2000 }, completed: { type: 'boolean' } } } satisfies BodySchema;
const encode = (text: string) => new TextEncoder().encode(text);
const jsonHeaders = { has: (n: string) => n.toLowerCase() === 'content-type', get: () => 'application/json' };
async function serve(t: TestContext, routes: Parameters<typeof project>[1]) {
  const app = await startServer({ project: await project(t, routes), port: 0, log: () => {} }); t.after(() => app.close()); return app;
}

test('pattern guard accepts bounded patterns and refuses backtracking constructs', () => {
  for (const ok of ['^[a-z0-9-]+$', '^\\d{3}-\\d{4}$', '^(ab){1,3}$', '^[a-z]+@[a-z]+\\.[a-z]+$', '^(a|b)?c$', '^(ab){2,3}(cd){1,2}$']) assert.doesNotThrow(() => assertSafePattern(ok), ok);
  const bad: [string, RegExp][] = [
    [unsafe('^(','a+)+$'), /repeat a group/], [unsafe('^(','a|aa)*$'), /repeat a group/], [unsafe('^(','ab){2,}$'), /repeat a group/],
    // Bounded repetition (`{n,m}`) of a group whose body itself has a
    // quantifier or alternation still backtracks super-linearly; only an
    // unbounded outer repeat used to be refused.
    [unsafe('^(','a+){2,3}$'), /bound-repeat a group/], [unsafe('^(','a|aa){2,5}$'), /bound-repeat a group/],
    [unsafe('^((','a+)+){2,3}$'), /repeat a group/],
    ['(?=a)b', /lookaround/], ['(?<!a)b', /lookaround/], ['(a)\\1', /backreferences/], ['(?<x>a)\\k<x>', /backreferences/],
    ['a*b*c*d*', /at most 3 unbounded/], ['(', /Invalid pattern/], ['', /1 to 128/], ['a'.repeat(129), /1 to 128/],
  ];
  for (const [pattern, message] of bad) assert.throws(() => assertSafePattern(pattern), message, pattern);
  assert.doesNotThrow(() => assertSafePattern('^[(*+]+$'), 'classes hide quantifier characters');
  assert.doesNotThrow(() => assertSafePattern('^\\(a\\)*$'), 'escaped parentheses are literals');
});

test('body schema subset rejects unsupported keywords and oversized schemas at load time', () => {
  assert.doesNotThrow(() => assertBodySchema(todo));
  const bad: [unknown, RegExp][] = [
    [{ type: 'object', $ref: '#/x' }, /Unsupported body schema keyword/], [{ type: 'object', oneOf: [] }, /Unsupported body schema keyword/],
    [{ type: 'money' }, /type must be one of/], [{ properties: {} }, /require type object/], [{ type: 'string', minimum: 1 }, /Numeric bounds/],
    [{ type: 'string', format: 'email' }, /supported: uuid/], [{ type: 'string', pattern: '^a$' }, /requires maxLength/],
    [{ type: 'string', pattern: '^a$', maxLength: 5000 }, /at most 128/], [{ type: 'string', pattern: unsafe('^(','a+)+$'), maxLength: 10 }, /repeat a group/],
    [{ type: 'object', required: ['x'], properties: {} }, /declared in properties/], [{ type: 'array', maxItems: -1 }, /maxItems/],
    [{ type: 'object', additionalProperties: {} }, /true or false/], [{ type: 'string', enum: [] }, /1 to 64/], [{ type: 'string', enum: [{}] }, /scalars/],
    ['x', /must be an object/],
  ];
  for (const [schema, message] of bad) assert.throws(() => assertBodySchema(schema), message, JSON.stringify(schema));
  let deep: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < 6; i++) deep = { type: 'object', properties: { a: deep } };
  assert.throws(() => assertBodySchema(deep), /too large or deeply nested/);
});

test('checkBodySchema reports fixed-wording failures and never echoes client data', () => {
  assert.deepEqual(checkBodySchema(todo, { title: 'x', completed: true }), []);
  assert.deepEqual(checkBodySchema(todo, {}), ['/ is missing required property title']);
  assert.deepEqual(checkBodySchema(todo, { title: '' }), ['/title must be at least 1 characters']);
  assert.deepEqual(checkBodySchema(todo, { title: 5 }), ['/title must be a string']);
  assert.deepEqual(checkBodySchema(todo, { title: 'x', completed: 'yes' }), ['/completed must be a boolean']);
  assert.deepEqual(checkBodySchema(todo, { title: 'x', "<script>": 1 } as never), ['/ has a property the schema does not declare']);
  assert.deepEqual(checkBodySchema(todo, []), ['/ must be an object']);
  assert.deepEqual(checkBodySchema({ type: 'integer', minimum: 1, maximum: 3 }, 1.5), ['/ must be an integer']);
  assert.deepEqual(checkBodySchema({ type: 'integer', minimum: 1, maximum: 3 }, 9), ['/ must be at most 3']);
  assert.deepEqual(checkBodySchema({ type: 'array', maxItems: 1, items: { type: 'string' } }, ['a', 'b']), ['/ must have at most 1 items']);
  assert.deepEqual(checkBodySchema({ type: 'array', items: { type: 'string' } }, ['a', 2]), ['[] must be a string']);
  assert.deepEqual(checkBodySchema({ type: 'string', enum: ['a', 'b'] }, 'c'), ['/ must be one of the declared values']);
  assert.deepEqual(checkBodySchema({ type: 'string', format: 'uuid' }, 'nope'), ['/ must be a uuid']);
  assert.deepEqual(checkBodySchema({ type: 'string', format: 'uuid' }, uuid), []);
  const slug: BodySchema = { type: 'string', pattern: '^[a-z]+$', maxLength: 8 };
  assert.deepEqual(checkBodySchema(slug, 'abc'), []);
  assert.deepEqual(checkBodySchema(slug, 'ABC'), ['/ does not match the declared pattern']);
  assert.deepEqual(checkBodySchema(slug, 'a'.repeat(9)), ['/ must be at most 8 characters'], 'over-long input is refused before the regex runs');
  assert.equal(checkBodySchema({ type: 'array', items: { type: 'string' } }, Array(50).fill(1)).length, 8, 'reports at most eight failures');
});

test('checkRequest returns 422 for schema failures and keeps 400/415 for syntax and media type', () => {
  const route: HttpRoute = { request: { body: { format: 'json', schema: todo } } }; compileHttp(route);
  const run = (text: string) => { try { checkRequest(route, encode(text), jsonHeaders); return 200; } catch (error) { return (error as { status: number }).status; } };
  assert.equal(run('{"title":"ok"}'), 200);
  assert.equal(run('{"title":1}'), 422);
  assert.equal(run('{bad'), 400);
  assert.throws(() => compileHttp({ request: { body: { schema: todo } } }), /requires format json/);
  assert.throws(() => compileHttp({ request: { body: { format: 'json', schema: { type: 'string', pattern: '(a+)+', maxLength: 5 } } } }), /repeat a group/);
});

test('a route with request.body.schema answers 422 with declared paths only', async t => {
  const app = await serve(t, { '/todos': { methods: ['POST'], request: { body: { format: 'json', contentTypes: ['application/json'], maxBytes: 4096, schema: todo } },
    respond: { status: 201, json: { ok: true } } } });
  const post = (body: string) => request(app, '/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal((await post('{"title":"Buy milk"}')).status, 201);
  const invalid = await post('{"title":5,"completed":"x","<img src=x>":1}');
  assert.equal(invalid.status, 422);
  assert.match(invalid.headers['content-type']!, /^text\/plain/);
  assert.match(invalid.body, /^Request body failed validation\n/);
  assert.match(invalid.body, /\/title must be a string/);
  assert.doesNotMatch(invalid.body, /img|<|Buy/);
  assert.equal((await post('{nope')).status, 400);
});

test('parameter format uuid and bounded pattern are enforced on path, query and header inputs', async t => {
  const app = await serve(t, {
    '/items/{id}': { parameters: [{ ...param('id'), schema: { type: 'string', format: 'uuid' } }], respond: { json: { ok: true } } },
    '/tags': { parameters: [{ ...param('slug', 'string', 'query'), required: true, schema: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 32 } }], respond: { json: { ok: true } } },
  });
  assert.equal((await request(app, `/items/${uuid}`)).status, 200);
  assert.equal((await request(app, '/items/not-a-uuid')).status, 400);
  assert.equal((await request(app, '/tags?slug=ok-1')).status, 200);
  assert.equal((await request(app, '/tags?slug=Bad_Slug')).status, 400);
  assert.equal((await request(app, `/tags?slug=${'a'.repeat(33)}`)).status, 400);
});

test('unsafe or unbounded parameter patterns and unknown formats fail activation', async t => {
  const bad: Record<string, unknown>[] = [
    { type: 'string', pattern: unsafe('^(','a+)+$'), maxLength: 10 }, { type: 'string', pattern: '^a$' }, { type: 'string', pattern: '^a$', maxLength: 999 },
    { type: 'string', format: 'email' }, { type: 'integer', format: 'uuid' }, { type: 'integer', pattern: '^1$', maxLength: 3 },
  ];
  for (const schema of bad) {
    await assert.rejects(startServer({ project: await project(t, { '/x': { parameters: [{ ...param('q', 'string', 'query'), schema }], respond: { json: {} } } }), port: 0, log: () => {} }), /./, JSON.stringify(schema));
  }
});
