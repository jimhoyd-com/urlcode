import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionHttpError, isSameOriginRequest, jsonResponse, readBody, readCookie, readFields, wantsJson } from '../packages/core/src/extensions.ts';
import type { ExtensionHttpErrorCode } from '../packages/core/src/extensions.ts';

// Core's request helpers (RIM-EXT-HTTP-001), exercised on hand-built request fields only: no extension package.
type Headers2 = readonly (readonly [string, string])[];
function request(headers: Headers2 = [], body: string | Uint8Array = '') {
  const map = new Headers(), counts: Record<string, number> = {};
  for (const [name, value] of headers) { map.append(name, value); counts[name.toLowerCase()] = (counts[name.toLowerCase()] ?? 0) + 1; }
  return { headers: map, headerCounts: counts, body: typeof body === 'string' ? new TextEncoder().encode(body) : body };
}
const json = (body: string, extra: Headers2 = []) => request([['content-type', 'application/json'], ...extra], body);
const form = (body: string) => request([['content-type', 'application/x-www-form-urlencoded']], body);
const refused = (status: number, code: ExtensionHttpErrorCode) => (error: unknown): boolean => {
  assert.ok(error instanceof ExtensionHttpError, String(error));
  assert.deepEqual([error.status, error.code], [status, code]);
  return true;
};
const nested = (depth: number, open = '[', close = ']'): string => open.repeat(depth) + close.repeat(depth);

test('readBody checks the content type count, size, media type, encoding, then the JSON shape', () => {
  assert.throws(() => readBody(request([['content-type', 'application/json'], ['content-type', 'application/json']], '{}'), { accept: ['json'], maxBytes: 10 }), refused(400, 'duplicate_header'));
  assert.throws(() => readBody(json('{"a":"12345"}'), { accept: ['json'], maxBytes: 5 }), refused(413, 'body_too_large'));
  assert.deepEqual(readBody(json('{"a":1}'), { accept: ['json'], maxBytes: 7 }), { kind: 'json', value: { a: 1 } }, 'exactly maxBytes is admitted');
  // Size is checked before the media type: an oversized body of the wrong type is still 413.
  assert.throws(() => readBody(request([['content-type', 'text/plain']], 'x'.repeat(20)), { accept: ['json'], maxBytes: 5 }), refused(413, 'body_too_large'));
  assert.throws(() => readBody(request([], '{}'), { accept: ['json'], maxBytes: 10 }), refused(415, 'unsupported_media_type'));
  assert.throws(() => readBody(request([['content-type', 'text/plain']], '{}'), { accept: ['json'], maxBytes: 10 }), refused(415, 'unsupported_media_type'));
  assert.throws(() => readBody(form('a=1'), { accept: ['json'], maxBytes: 10 }), refused(415, 'unsupported_media_type'), 'a media type outside accept');
  assert.throws(() => readBody(json('{}'), { accept: ['form'], maxBytes: 10 }), refused(415, 'unsupported_media_type'));
  assert.deepEqual(readBody(request([['content-type', 'Application/JSON; charset=UTF-8']], '[1]'), { accept: ['json'], maxBytes: 10 }), { kind: 'json', value: [1] }, 'case and parameters are ignored');
  assert.throws(() => readBody(request([['content-type', 'application/json']], new Uint8Array([0x7b, 0xff, 0x7d])), { accept: ['json'], maxBytes: 10 }), refused(400, 'invalid_encoding'));
  assert.throws(() => readBody(request([['content-type', 'application/x-www-form-urlencoded']], new Uint8Array([0x61, 0x3d, 0xc3])), { accept: ['form'], maxBytes: 10 }), refused(400, 'invalid_encoding'));
  assert.throws(() => readBody(json('{"a":'), { accept: ['json'], maxBytes: 10 }), refused(400, 'invalid_json'));
  assert.throws(() => readBody(json(''), { accept: ['json'], maxBytes: 10 }), refused(400, 'invalid_json'));
});

test('readBody refuses duplicate JSON keys at any depth, compared after decoding', () => {
  const read = (text: string) => readBody(json(text), { accept: ['json'], maxBytes: 4096 });
  assert.throws(() => read('{"a":1,"a":2}'), refused(400, 'duplicate_key'));
  assert.throws(() => read('{"a":1,"\\u0061":2}'), refused(400, 'duplicate_key'), 'escaped-equal keys are the same key');
  assert.throws(() => read('{"x":{"b":[{"c":1,"c":1}]}}'), refused(400, 'duplicate_key'), 'deep inside arrays of objects');
  assert.throws(() => read('{"x":{"k":1},"x":2}'), refused(400, 'duplicate_key'), 'after a nested object closes');
  assert.deepEqual(read('[{"a":1},{"a":2}]'), { kind: 'json', value: [{ a: 1 }, { a: 2 }] }, 'the same key in different objects is fine');
  assert.deepEqual(read('{"a":"a","b":{"a":"}\\"{,"},"c":"a"}'), { kind: 'json', value: { a: 'a', b: { a: '}"{,' }, c: 'a' } }, 'string values are skipped, including structural characters and escapes');
  assert.deepEqual(read('{"__proto__":1}'), { kind: 'json', value: JSON.parse('{"__proto__":1}') });
});

test('readBody bounds JSON nesting before parsing: default 32, at most 64', () => {
  const read = (text: string, maxDepth?: number) => readBody(json(text), { accept: ['json'], maxBytes: 4096, ...(maxDepth === undefined ? {} : { maxDepth }) });
  assert.deepEqual(read(nested(32)).kind, 'json');
  assert.throws(() => read(nested(33)), refused(400, 'too_deep'));
  assert.equal(read('{"a":'.repeat(32) + '1' + '}'.repeat(32)).kind, 'json', 'objects count the same as arrays');
  assert.throws(() => read('{"a":'.repeat(33) + '1' + '}'.repeat(33)), refused(400, 'too_deep'));
  assert.equal(read(nested(64), 64).kind, 'json');
  assert.throws(() => read(nested(65), 64), refused(400, 'too_deep'));
  // Unbalanced deep input is refused by depth before any recursive parse sees it.
  assert.throws(() => read('['.repeat(1000)), refused(400, 'too_deep'));
  assert.throws(() => read(nested(3), 2), refused(400, 'too_deep'));
  assert.throws(() => read('[]', 65), TypeError);
  assert.throws(() => readBody(json('[]'), { accept: ['json'], maxBytes: 0 }), TypeError);
  assert.throws(() => readBody(json('[]'), { accept: ['json'], maxBytes: 1048577 }), TypeError);
  assert.throws(() => readBody(json('[]'), { accept: [], maxBytes: 10 }), TypeError);
});

test('readBody returns form entries with duplicates kept', () => {
  assert.deepEqual(readBody(form('a=1&b=two+words&a=3'), { accept: ['json', 'form'], maxBytes: 100 }), { kind: 'form', entries: [['a', '1'], ['b', 'two words'], ['a', '3']] });
  assert.deepEqual(readBody(form(''), { accept: ['form'], maxBytes: 100 }), { kind: 'form', entries: [] });
});

test('readFields admits an exact allow-list and trusted patterns, once each, as bounded strings', () => {
  const fields = ['email', 'csrf'];
  const read = (req: ReturnType<typeof request>, extra: Partial<Parameters<typeof readFields>[1]> = {}) => readFields(req, { fields, ...extra });
  const result = read(form('email=a%40b.test&csrf=t'));
  assert.deepEqual({ ...result }, { email: 'a@b.test', csrf: 't' });
  assert.equal(Object.getPrototypeOf(result), null);
  assert.ok(Object.isFrozen(result));
  assert.deepEqual({ ...read(json('{"email":"x"}')) }, { email: 'x' });
  assert.throws(() => read(form('other=1')), refused(400, 'invalid_field'));
  assert.throws(() => read(form('email=1&email=2')), refused(400, 'invalid_field'), 'a repeated form field');
  assert.throws(() => read(json('{"email":"1","email":"2"}')), refused(400, 'duplicate_key'), 'a repeated JSON key');
  assert.throws(() => read(json('{"email":1}')), refused(400, 'invalid_field'), 'a non-string JSON value');
  assert.throws(() => read(json('{"email":null}')), refused(400, 'invalid_field'));
  assert.throws(() => read(json('["email"]')), refused(400, 'expected_object'));
  assert.throws(() => read(json('null')), refused(400, 'expected_object'));
  assert.throws(() => read(json('"email"')), refused(400, 'expected_object'));
  const pattern = /^selected\.[a-f0-9]{8}$/;
  assert.deepEqual({ ...read(form('selected.0123abcd=on&email=x'), { patterns: [pattern] }) }, { 'selected.0123abcd': 'on', email: 'x' });
  assert.throws(() => read(form('selected.0123abcdx=on'), { patterns: [pattern] }), refused(400, 'invalid_field'));
  const many = Array.from({ length: 65 }, (_, index) => `selected.${String(index).padStart(8, '0')}=1`).join('&');
  assert.throws(() => read(form(many), { patterns: [pattern] }), refused(400, 'too_many_fields'));
  assert.throws(() => read(form('email=1&csrf=2'), { maxFields: 1 }), refused(400, 'too_many_fields'));
  assert.throws(() => read(form(`email=${'x'.repeat(4097)}`)), refused(400, 'invalid_field'));
  assert.equal(read(form(`email=${'x'.repeat(4096)}`)).email!.length, 4096);
  assert.throws(() => read(form('email=abc'), { maxValueLength: 2 }), refused(400, 'invalid_field'));
  assert.equal(read(form(`csrf=${'x'.repeat(2048)}`), { maxValueLength: 10, limits: { csrf: 2048 } }).csrf!.length, 2048, 'a per-field limit replaces the default');
  assert.throws(() => read(form(`csrf=${'x'.repeat(2049)}`), { limits: { csrf: 2048 } }), refused(400, 'invalid_field'));
  assert.throws(() => read(json('{}'), { accept: ['form'] }), refused(415, 'unsupported_media_type'));
  assert.throws(() => read(form('email=' + 'x'.repeat(16384))), refused(413, 'body_too_large'), 'default maxBytes 16384');
  assert.deepEqual({ ...read(form('email=1'), { maxBytes: 7 }) }, { email: '1' });
});

test('jsonResponse sets the extension security headers; a caller header replaces one, set-cookie appends', () => {
  const plain = jsonResponse(200, { ok: true });
  assert.equal(plain.status, 200);
  assert.equal(plain.body, '{"ok":true}');
  assert.deepEqual(Object.fromEntries(plain.headers), {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", 'referrer-policy': 'strict-origin',
  });
  const custom = jsonResponse(201, [], [['Cache-Control', 'private'], ['set-cookie', 'a=1'], ['set-cookie', 'b=2'], ['x-extra', 'y']]);
  assert.deepEqual(custom.headers.filter(([name]) => name.toLowerCase() === 'cache-control'), [['Cache-Control', 'private']]);
  assert.deepEqual(custom.headers.filter(([name]) => name === 'set-cookie').map(([, value]) => value), ['a=1', 'b=2']);
  assert.ok(custom.headers.some(([name]) => name === 'x-extra'));
  assert.equal(jsonResponse(599, null).body, 'null');
  for (const status of [199, 600, 200.5, Number.NaN]) assert.throws(() => jsonResponse(status, {}), TypeError);
});

test('wantsJson reads Accept or a JSON request body', () => {
  assert.equal(wantsJson(request([['accept', 'text/html, application/json;q=0.9']])), true);
  assert.equal(wantsJson(request([['accept', 'text/html']])), false);
  assert.equal(wantsJson(request([['content-type', 'application/json; charset=utf-8']])), true);
  assert.equal(wantsJson(request([['content-type', 'application/x-www-form-urlencoded']])), false);
  assert.equal(wantsJson(request()), false);
});

test('readCookie refuses ambiguity and treats a malformed value as absent', () => {
  const shape = /^[A-Za-z0-9_-]{4,16}$/;
  assert.equal(readCookie(request([['cookie', 'a=1; session=abcd1234; b=2']]), 'session', shape), 'abcd1234');
  assert.equal(readCookie(request([['cookie', 'a=1']]), 'session', shape), undefined);
  assert.equal(readCookie(request(), 'session', shape), undefined);
  assert.equal(readCookie(request([['cookie', 'session=bad value!']]), 'session', shape), undefined, 'a shape mismatch is absent, not an error');
  assert.equal(readCookie(request([['cookie', 'xsession=abcd1234']]), 'session', shape), undefined, 'a longer name is a different cookie');
  assert.throws(() => readCookie(request([['cookie', 'session=abcd1234; session=efgh5678']]), 'session', shape), refused(400, 'invalid_cookie'));
  assert.throws(() => readCookie(request([['cookie', 'a=1'], ['cookie', 'session=abcd1234']]), 'session', shape), refused(400, 'invalid_cookie'));
  assert.throws(() => readCookie(request([['cookie', `a=${'x'.repeat(8191)}`]]), 'session', shape), refused(400, 'invalid_cookie'));
  assert.equal(readCookie(request([['cookie', `a=${'x'.repeat(8190)}`]]), 'a', /^x+$/)?.length, 8190, 'exactly 8192 bytes is admitted');
});

test('isSameOriginRequest applies one ordered rule; only the no-evidence case varies', () => {
  const site = { origin: 'https://site.example', origins: ['https://site.example', 'https://alias.example'] };
  const check = (headers: Headers2, whenAbsent: 'refuse' | 'admit' = 'refuse') => isSameOriginRequest(request(headers), site, { whenAbsent });
  // 1. Duplicated provenance headers.
  assert.equal(check([['origin', 'https://site.example'], ['origin', 'https://site.example']]), false);
  assert.equal(check([['sec-fetch-site', 'same-origin'], ['sec-fetch-site', 'same-origin']], 'admit'), false);
  assert.equal(check([['referer', 'https://site.example/a'], ['referer', 'https://site.example/b']], 'admit'), false);
  // 2. cross-site refuses even with a matching Origin.
  assert.equal(check([['origin', 'https://site.example'], ['sec-fetch-site', 'cross-site']]), false);
  // 3. Origin decides when present.
  assert.equal(check([['origin', 'https://site.example']]), true);
  assert.equal(check([['origin', 'https://alias.example'], ['sec-fetch-site', 'same-site']]), true, 'an alias origin');
  assert.equal(check([['origin', 'https://evil.example'], ['sec-fetch-site', 'same-origin']]), false);
  assert.equal(check([['origin', 'null']], 'admit'), false, 'the opaque origin never matches');
  assert.equal(check([['origin', 'https://site.example'], ['referer', 'https://evil.example/']]), true, 'Origin wins over Referer');
  // 4. Sec-Fetch-Site without Origin.
  assert.equal(check([['sec-fetch-site', 'same-origin']]), true);
  assert.equal(check([['sec-fetch-site', 'none']]), true);
  assert.equal(check([['sec-fetch-site', 'same-site']], 'admit'), false, 'same-site without Origin cannot say which sibling');
  assert.equal(check([['sec-fetch-site', 'same-site'], ['referer', 'https://site.example/']]), false, 'Sec-Fetch-Site decides before Referer');
  // 5. Referer.
  assert.equal(check([['referer', 'https://site.example/page?x=1']]), true);
  assert.equal(check([['referer', 'https://alias.example/']]), true);
  assert.equal(check([['referer', 'https://evil.example/']], 'admit'), false);
  assert.equal(check([['referer', '/relative']], 'admit'), false, 'a Referer that does not parse');
  // 6. No evidence at all.
  assert.equal(check([], 'refuse'), false);
  assert.equal(check([], 'admit'), true);
  // A site with only a canonical origin.
  assert.equal(isSameOriginRequest(request([['origin', 'https://site.example']]), { origin: 'https://site.example' }, { whenAbsent: 'refuse' }), true);
  assert.equal(isSameOriginRequest(request([['origin', 'https://alias.example']]), { origin: 'https://site.example' }, { whenAbsent: 'refuse' }), false);
  assert.throws(() => isSameOriginRequest(request(), site, {} as never), TypeError);
});

test('an ExtensionHttpError message is fixed per code and never echoes the request', () => {
  const secret = 'secret-value-123';
  for (const attempt of [
    () => readFields(form(`${secret}=1`), { fields: [] }),
    () => readBody(json(`{"${secret}":1,"${secret}":2}`), { accept: ['json'], maxBytes: 100 }),
    () => readBody(request([['content-type', secret]], ''), { accept: ['json'], maxBytes: 100 }),
    () => readCookie(request([['cookie', `s=${secret}; s=${secret}`]]), 's', /x/),
  ]) assert.throws(attempt, (error: unknown) => error instanceof ExtensionHttpError && !error.message.includes(secret) && error.name === 'ExtensionHttpError');
});
