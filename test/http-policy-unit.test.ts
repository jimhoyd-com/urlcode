import test from 'node:test';
import assert from 'node:assert/strict';
import { compileHttp, checkRequest, decorateResponse } from '../src/http-policy.ts';
import type { HttpRoute, RequestBodyPolicy } from '../src/http-policy.ts';
import type { HeaderPair } from '../src/http-response.ts';

// The Worker ships this module verbatim, so its behavior is pinned here without
// a Node server in front of it.
const headers = (record: Record<string, string>) => ({ has: (n: string) => n.toLowerCase() in record, get: (n: string) => record[n.toLowerCase()] ?? null });
const status = (fn: () => unknown): number | undefined => { try { fn(); return undefined; } catch (error) { return (error as { status?: number }).status; } };
const encode = (text: string) => new TextEncoder().encode(text);

test('compileHttp validates declared headers and compiles static replies', () => {
  const route: HttpRoute = { response: { headers: { 'X-One': 'a', 'Set-Cookie': ['a=1', 'b=2'] } }, respond: { json: { ok: true } } };
  compileHttp(route);
  assert.deepEqual(route.responseHeaders, [['x-one','a'],['set-cookie','a=1'],['set-cookie','b=2']]);
  assert.equal(route.reply!.status, 200);
  assert.deepEqual(route.reply!.headers, [['content-type','application/json; charset=utf-8']]);
  assert.equal(new TextDecoder().decode(route.reply!.body), '{"ok":true}');
  const text: HttpRoute = { respond: { status: 201, text: 'made' } }; compileHttp(text);
  assert.deepEqual(text.reply!.headers, [['content-type','text/plain; charset=utf-8']]); assert.equal(text.reply!.status, 201);
  const empty: HttpRoute = { respond: { status: 204 } }; compileHttp(empty); assert.equal(empty.reply!.body.length, 0);
  const none: HttpRoute = {}; compileHttp(none); assert.deepEqual(none.responseHeaders, []); assert.equal(none.reply, undefined);
  const cases: [HttpRoute, RegExp][] = [
    [{ response: { headers: { 'X-A': '1', 'x-a': '2' } } }, /Duplicate response header/],
    [{ response: { headers: { 'Content-Length': '1' } } }, /owned by the runtime/],
    [{ response: { headers: { 'X-Content-Type-Options': 'nosniff' } } }, /owned by the runtime/],
    [{ response: { headers: { 'X-List': ['a','b'] } } }, /Only Set-Cookie/],
    [{ page: {}, response: { headers: { 'Content-Type': 'text/html' } } }, /asset metadata/],
    [{ response: { headers: { 'Bad Name': 'x' } } }, /Invalid response header/],
    [{ response: { headers: { 'X-Ctl': 'ab' } } }, /Invalid response header|Control characters/],
    [{ response: { headers: { 'X-Big': 'a'.repeat(16400) } } }, /exceed 16 KiB/],
    [{ respond: { status: 304 } }, /native asset handlers/],
    [{ respond: { status: 204, text: 'x' } }, /cannot declare a body/],
    [{ respond: { text: 'a'.repeat(1048577) } }, /exceeds 1 MiB/],
    [{ respond: { json: {} }, response: { headers: { 'Content-Type': 'text/plain' } } }, /JSON content type/],
  ];
  for (const [route, message] of cases) assert.throws(() => compileHttp(route), message, JSON.stringify(route).slice(0, 80));
  const typed: HttpRoute = { respond: { json: [] }, response: { headers: { 'Content-Type': 'application/problem+json' } } };
  compileHttp(typed); assert.equal(typed.reply!.status, 200);
});

test('checkRequest enforces the declared body policy with the right statuses', () => {
  const route = (body: RequestBodyPolicy): HttpRoute => ({ request: { body } });
  assert.equal(status(() => checkRequest({}, encode('anything'), headers({}))), undefined);
  assert.equal(status(() => checkRequest(route({ maxBytes: 4 }), encode('12345'), headers({}))), 413);
  assert.equal(status(() => checkRequest(route({ required: true }), new Uint8Array(), headers({}))), 400);
  assert.equal(status(() => checkRequest(route({}), new Uint8Array(), headers({}))), undefined);
  assert.equal(status(() => checkRequest(route({}), encode('x'), headers({ 'content-type': 'text/plain' }), { 'content-type': 2 })), 400);
  assert.equal(status(() => checkRequest(route({}), encode('x'), headers({ 'content-encoding': 'gzip' }))), 415);
  assert.equal(status(() => checkRequest(route({}), encode('x'), headers({ 'content-encoding': 'identity' }))), undefined);
  assert.equal(status(() => checkRequest(route({ contentTypes: ['application/json'] }), encode('{}'), headers({ 'content-type': 'text/plain' }))), 415);
  assert.equal(status(() => checkRequest(route({ contentTypes: ['application/json'] }), encode('{}'), headers({ 'content-type': 'Application/JSON; charset=utf-8' }))), undefined);
  assert.equal(status(() => checkRequest(route({ format: 'text' }), new Uint8Array([0xff, 0xfe]), headers({ 'content-type': 'text/plain' }))), 400);
  assert.equal(status(() => checkRequest(route({ format: 'json' }), encode('{}'), headers({ 'content-type': 'text/plain' }))), 415);
  assert.equal(status(() => checkRequest(route({ format: 'json' }), encode('{'), headers({ 'content-type': 'application/json' }))), 400);
  assert.equal(status(() => checkRequest(route({ format: 'json' }), encode('{"a":1}'), headers({ 'content-type': 'application/ld+json' }))), undefined);
});

test('decorateResponse replaces handler headers with the declared ones and bounds the total', () => {
  const result = { status: 200, headers: [['x-one','handler'],['x-two','kept'],['X-ONE','dup']] as HeaderPair[], body: 'b' };
  assert.equal(decorateResponse({ responseHeaders: [] }, result), result);
  const decorated = decorateResponse({ responseHeaders: [['x-one','yaml']] }, result);
  assert.deepEqual(decorated.headers, [['x-two','kept'],['x-one','yaml']]); assert.equal(decorated.body, 'b');
  const many: HeaderPair[] = Array.from({ length: 256 }, (_, i) => [`x-${i}`, 'v']);
  assert.equal(status(() => decorateResponse({ responseHeaders: [['x-extra','v']] }, { status: 200, headers: many })), 502);
  assert.equal(status(() => decorateResponse({ responseHeaders: [['x-extra','v']] }, { status: 200, headers: [['x-big','a'.repeat(16380)]] })), 502);
});
