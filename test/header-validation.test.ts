import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { validateHeaderName, validateHeaderValue } from '../src/header-validation.ts';

const accepts = (fn, ...args) => { try { fn(...args); return true; } catch { return false; } };

// A pure reimplementation of header validation is only safe if it agrees with
// Node everywhere. Disagreeing in the permissive direction is header injection.
test('header name validation agrees with node:http', () => {
  const names = ['content-type','X-Custom','a','Set-Cookie','x_1','ok-name','','with space','colon:','semi;','quote"','paren()','slash/','at@','bracket[]'];
  for (let code = 0; code < 0x100; code++) {
    const ch = String.fromCharCode(code);
    names.push(ch, `x${ch}`, `${ch}x`);
  }
  for (const name of names) {
    assert.equal(accepts(validateHeaderName,name), accepts(http.validateHeaderName,name),
      `name ${JSON.stringify(name)} disagrees`);
  }
  for (const value of [undefined,null,42,{},[]]) {
    assert.equal(accepts(validateHeaderName,value), accepts(http.validateHeaderName,value),
      `name ${String(value)} disagrees`);
  }
});

test('header value validation agrees with node:http', () => {
  const values = ['text','a b','"quoted"','https://example.com/a?b=c#d',''];
  for (let code = 0; code < 0x120; code++) {
    const ch = String.fromCharCode(code);
    values.push(ch, `v${ch}`, `${ch}v`);
  }
  for (const value of values) {
    assert.equal(accepts(validateHeaderValue,'x',value), accepts(http.validateHeaderValue,'x',value),
      `value ${JSON.stringify(value)} disagrees`);
  }
  assert.equal(accepts(validateHeaderValue,'x',undefined),false);
  assert.equal(accepts(http.validateHeaderValue,'x',undefined),false);
});

test('the obvious injection attempts are refused', () => {
  const cr = String.fromCharCode(13), lf = String.fromCharCode(10), nul = String.fromCharCode(0);
  for (const value of [`ok${cr}${lf}X-Injected: 1`,`ok${lf}X-Injected: 1`,`ok${cr}X-Injected: 1`,`ok${nul}`]) {
    assert.throws(() => validateHeaderValue('x',value));
  }
  for (const name of ['bad name','bad:name',`bad${cr}${lf}name`,'']) assert.throws(() => validateHeaderName(name));
});
