import test from 'node:test';
import assert from 'node:assert/strict';
import { createChallenge, validateWidget } from '../src/challenge.ts';
import type { AbuseChallengeProvider, AbuseChallengeWidget } from '../src/index.ts';
import { setup } from './helpers.ts';

const origin = 'https://challenge.example';
const widget: AbuseChallengeWidget = { markup: '<div data-challenge></div>', csp: { script: [origin], frame: [origin], connect: [] }, scripts: [{ src: origin + '/api.js', async: true }] };
function provider(verify: AbuseChallengeProvider['verify'], shape: (action: string) => AbuseChallengeWidget = () => widget): AbuseChallengeProvider { return { widget: shape, verify }; }
const input = { token: 'opaque-token', client: '192.0.2.1', action: 'forms' };

test('verify passes the checked input to the provider and admits only a strict true', async () => {
  const seen: unknown[] = [];
  let answer: unknown = true;
  const challenge = createChallenge(provider(async value => { seen.push({ ...value, signal: value.signal instanceof AbortSignal }); return answer as boolean; }));
  assert.equal(await challenge.verify(input), true);
  assert.deepEqual(seen, [{ token: 'opaque-token', client: '192.0.2.1', action: 'forms', signal: true }]);
  for (const value of ['true', 1, {}, undefined]) { answer = value; assert.equal(await challenge.verify(input), false); }
  assert.equal(await challenge.verify({ ...input, client: '2001:db8::1' }), false);
});

test('a malformed token, a non-IP client or an invalid action never reaches the provider', async () => {
  let calls = 0;
  const challenge = createChallenge(provider(async () => { calls++; return true; }));
  for (const token of [undefined, null, 7, '', 'x'.repeat(2049), 'line\nbreak', 'nul\0', 'del\x7f'])
    assert.equal(await challenge.verify({ ...input, token }), false, JSON.stringify(token));
  for (const client of [null, '', 'forwarded=spoofed', '2001:db8::/64', 'localhost'])
    assert.equal(await challenge.verify({ ...input, client }), false, String(client));
  for (const action of ['', 'Forms', 'a'.repeat(33), 7])
    assert.equal(await challenge.verify({ ...input, action: action as string }), false);
  assert.equal(await challenge.verify(undefined as never), false);
  assert.equal(calls, 0);
  assert.equal(await challenge.verify({ ...input, token: 'x'.repeat(2048) }), true);
  assert.equal(calls, 1);
});

test('a throwing or rejecting provider gives false', async () => {
  assert.equal(await createChallenge(provider(() => { throw new Error('secret upstream details'); })).verify(input), false);
  assert.equal(await createChallenge(provider(async () => { throw new Error('secret upstream details'); })).verify(input), false);
});

test('the deadline answers false and aborts the provider; a settled verification is aborted too', async () => {
  let signal: AbortSignal | undefined;
  const slow = createChallenge(provider(({ signal: given }) => { signal = given; return new Promise<boolean>(() => {}); }), { timeoutMs: 20 });
  assert.equal(await slow.verify(input), false);
  assert.equal(signal?.aborted, true);
  const fast = createChallenge(provider(async ({ signal: given }) => { signal = given; return true; }));
  assert.equal(await fast.verify(input), true);
  assert.equal(signal?.aborted, true);
});

test('the default deadline is 5000 ms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve: ((value: boolean) => void) | undefined;
  const challenge = createChallenge(provider(() => new Promise<boolean>(done => { resolve = done; })));
  let settled: boolean | undefined;
  const pending = challenge.verify(input).then(value => { settled = value; });
  await new Promise(done => setImmediate(done));
  t.mock.timers.tick(4999);
  await new Promise(done => setImmediate(done));
  assert.equal(settled, undefined);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(settled, false);
  resolve?.(true);
});

test('at most 32 verifications are in flight, and a provider that ignores the abort keeps its slot', async () => {
  let calls = 0;
  const challenge = createChallenge(provider(() => { calls++; return new Promise<boolean>(() => {}); }), { timeoutMs: 10 });
  const results = await Promise.all(Array.from({ length: 40 }, () => challenge.verify(input)));
  assert.equal(results.every(value => value === false), true);
  assert.equal(calls, 32);
  assert.equal(await challenge.verify(input), false);
  assert.equal(calls, 32);
});

test('slots are released when verifications settle', async () => {
  let calls = 0;
  const challenge = createChallenge(provider(async () => { calls++; return true; }));
  for (let round = 0; round < 3; round++) assert.equal((await Promise.all(Array.from({ length: 32 }, () => challenge.verify(input)))).every(Boolean), true);
  assert.equal(calls, 96);
});

test('no verdict is cached: the same token is verified every time', async () => {
  const answers = [true, false, true];
  let calls = 0;
  const challenge = createChallenge(provider(async () => answers[calls++]!));
  assert.deepEqual([await challenge.verify(input), await challenge.verify(input), await challenge.verify(input)], [true, false, true]);
  assert.equal(calls, 3);
});

test('widget() validates the provider output and hands back a frozen copy', () => {
  const challenge = createChallenge(provider(async () => true, action => ({ ...widget, markup: `<div data-action="${action}"></div>` })));
  const result = challenge.widget('forms');
  assert.deepEqual(result, { markup: '<div data-action="forms"></div>', csp: widget.csp, scripts: widget.scripts });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.csp) && Object.isFrozen(result.csp.script) && Object.isFrozen(result.scripts[0]));
  assert.throws(() => challenge.widget('Forms'), /Invalid challenge action/);
  assert.throws(() => challenge.widget('a'.repeat(33)), /Invalid challenge action/);
});

test('widget validation refuses non-https origins, scripts outside csp.script and oversized markup', () => {
  const bad: unknown[] = [
    null,
    { ...widget, markup: 7 },
    { ...widget, markup: 'x'.repeat(2049) },
    { ...widget, markup: 'é'.repeat(1025) },
    { ...widget, csp: { ...widget.csp, script: ['http://challenge.example'] } },
    { ...widget, csp: { ...widget.csp, frame: ['https://challenge.example/path'] } },
    { ...widget, csp: { ...widget.csp, connect: ['*'] } },
    { ...widget, csp: { ...widget.csp, connect: undefined } },
    { ...widget, csp: { ...widget.csp, script: Array.from({ length: 9 }, (_, i) => `https://c${i}.example`) } },
    { ...widget, scripts: [{ src: 'https://other.example/api.js', async: true }] },
    { ...widget, scripts: [{ src: 'http://challenge.example/api.js', async: true }] },
    { ...widget, scripts: [{ src: '/local.js', async: true }] },
    { ...widget, scripts: [{ src: origin + '/api.js', async: 'yes' }] },
    { ...widget, scripts: [null] },
    { ...widget, scripts: 'x' },
  ];
  for (const value of bad) assert.throws(() => validateWidget(value), Error, JSON.stringify(value)?.slice(0, 80));
  assert.equal(validateWidget({ ...widget, markup: 'x'.repeat(2048), scripts: [] }).scripts.length, 0);
});

test('abuse({challenge}) exposes the wrapped challenge through the exports', async t => {
  let calls = 0;
  const { abuse } = await setup(t, { challenge: provider(async () => { calls++; return true; }) });
  assert.ok(abuse.exports.challenge);
  assert.equal(await abuse.exports.challenge.verify({ ...input, token: '' }), false);
  assert.equal(await abuse.exports.challenge.verify(input), true);
  assert.equal(calls, 1);
  assert.deepEqual(abuse.exports.challenge.widget('auth').scripts, widget.scripts);
});
