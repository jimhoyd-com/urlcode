import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionHttpError, isSameOriginRequest, jsonResponse, readBody } from '../packages/core/src/extensions.ts';
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
  assert.throws(() => readBody(request([['content-type', 'application/json'], ['content-type', 'application/json']], '{}'), { maxBytes: 10 }), refused(400, 'duplicate_header'));
  assert.throws(() => readBody(json('{"a":"12345"}'), { maxBytes: 5 }), refused(413, 'body_too_large'));
  assert.deepEqual(readBody(json('{"a":1}'), { maxBytes: 7 }), { a: 1 }, 'exactly maxBytes is admitted');
  // Size is checked before the media type: an oversized body of the wrong type is still 413.
  assert.throws(() => readBody(request([['content-type', 'text/plain']], 'x'.repeat(20)), { maxBytes: 5 }), refused(413, 'body_too_large'));
  assert.throws(() => readBody(request([], '{}'), { maxBytes: 10 }), refused(415, 'unsupported_media_type'));
  assert.throws(() => readBody(request([['content-type', 'text/plain']], '{}'), { maxBytes: 10 }), refused(415, 'unsupported_media_type'));
  assert.throws(() => readBody(form('a=1'), { maxBytes: 10 }), refused(415, 'unsupported_media_type'), 'a form body is not JSON');
  assert.deepEqual(readBody(request([['content-type', 'Application/JSON; charset=UTF-8']], '[1]'), { maxBytes: 10 }), [1], 'case and parameters are ignored');
  assert.throws(() => readBody(request([['content-type', 'application/json']], new Uint8Array([0x7b, 0xff, 0x7d])), { maxBytes: 10 }), refused(400, 'invalid_encoding'));
  assert.throws(() => readBody(json('{"a":'), { maxBytes: 10 }), refused(400, 'invalid_json'));
  assert.throws(() => readBody(json(''), { maxBytes: 10 }), refused(400, 'invalid_json'));
});

test('readBody refuses duplicate JSON keys at any depth, compared after decoding', () => {
  const read = (text: string) => readBody(json(text), { maxBytes: 4096 });
  assert.throws(() => read('{"a":1,"a":2}'), refused(400, 'duplicate_key'));
  assert.throws(() => read('{"a":1,"\\u0061":2}'), refused(400, 'duplicate_key'), 'escaped-equal keys are the same key');
  assert.throws(() => read('{"x":{"b":[{"c":1,"c":1}]}}'), refused(400, 'duplicate_key'), 'deep inside arrays of objects');
  assert.throws(() => read('{"x":{"k":1},"x":2}'), refused(400, 'duplicate_key'), 'after a nested object closes');
  assert.deepEqual(read('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }], 'the same key in different objects is fine');
  assert.deepEqual(read('{"a":"a","b":{"a":"}\\"{,"},"c":"a"}'), { a: 'a', b: { a: '}"{,' }, c: 'a' }, 'string values are skipped, including structural characters and escapes');
  assert.deepEqual(read('{"__proto__":1}'), JSON.parse('{"__proto__":1}'));
});

test('readBody bounds JSON nesting before parsing: default 32, at most 64', () => {
  const read = (text: string, maxDepth?: number) => readBody(json(text), { maxBytes: 4096, ...(maxDepth === undefined ? {} : { maxDepth }) });
  assert.deepEqual(read(nested(32)), JSON.parse(nested(32)));
  assert.throws(() => read(nested(33)), refused(400, 'too_deep'));
  assert.doesNotThrow(() => read('{"a":'.repeat(32) + '1' + '}'.repeat(32)), 'objects count the same as arrays');
  assert.throws(() => read('{"a":'.repeat(33) + '1' + '}'.repeat(33)), refused(400, 'too_deep'));
  assert.doesNotThrow(() => read(nested(64), 64));
  assert.throws(() => read(nested(65), 64), refused(400, 'too_deep'));
  // Unbalanced deep input is refused by depth before any recursive parse sees it.
  assert.throws(() => read('['.repeat(1000)), refused(400, 'too_deep'));
  assert.throws(() => read(nested(3), 2), refused(400, 'too_deep'));
  assert.throws(() => read('[]', 65), TypeError);
  assert.throws(() => readBody(json('[]'), { maxBytes: 0 }), TypeError);
  assert.throws(() => readBody(json('[]'), { maxBytes: 1048577 }), TypeError);
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
    () => readBody(json(`{"${secret}":1,"${secret}":2}`), { maxBytes: 100 }),
    () => readBody(request([['content-type', secret]], ''), { maxBytes: 100 }),
  ]) assert.throws(attempt, (error: unknown) => error instanceof ExtensionHttpError && !error.message.includes(secret) && error.name === 'ExtensionHttpError');
});
