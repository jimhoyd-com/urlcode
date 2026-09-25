// Ported from packages/auth/test/challenge.test.ts and challenge-ui.test.ts, with the action generalised to the
// caller's namespace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnstileChallenge, turnstileOrigin, turnstileScript } from '../src/index.ts';
import { createChallenge, validateWidget } from '../src/challenge.ts';

const config = { secret: 'secret_value_12345', siteKey: 'site_key_12345', hostname: 'login.example' };
const input = { token: 'opaque-token', client: '192.0.2.1', action: 'auth', signal: new AbortController().signal };
const verdict = (extra: Record<string, unknown> = {}) => ({ success: true, hostname: config.hostname, action: 'auth', challenge_ts: new Date().toISOString(), ...extra });

test('Turnstile uses a fixed POST upstream and validates hostname, action, freshness and provider replay verdict', async () => {
  let calls = 0, response = verdict();
  const challenge = createTurnstileChallenge({ ...config, fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('remoteip'), input.client);
    assert.equal(body.get('secret'), config.secret);
    assert.equal(body.get('response'), input.token);
    return Response.json(response);
  } });
  assert.equal(await challenge.verify(input), true);
  for (const bad of [{ hostname: 'evil.example' }, { action: 'signup' }, { success: false }, { challenge_ts: new Date(Date.now() - 301000).toISOString() }, { challenge_ts: 'invalid' }]) {
    response = verdict(bad);
    assert.equal(await challenge.verify(input), false);
  }
  assert.equal(calls, 6);
  assert.equal(await challenge.verify({ ...input, client: 'forwarded=spoofed' }), false);
  assert.equal(await challenge.verify({ ...input, token: 'x'.repeat(2049) }), false);
  assert.equal(calls, 6);
  assert.throws(() => createTurnstileChallenge({ ...config, hostname: 'login.example/path' }));
});

test('the verdict action must match the caller action', async () => {
  let response = verdict({ action: 'forms' });
  const challenge = createTurnstileChallenge({ ...config, fetch: async () => Response.json(response) });
  assert.equal(await challenge.verify({ ...input, action: 'forms' }), true);
  assert.equal(await challenge.verify({ ...input, action: 'auth' }), false);
  response = verdict({ action: 'auth' });
  assert.equal(await challenge.verify({ ...input, action: 'forms' }), false);
  assert.equal(await challenge.verify({ ...input, action: 'Not-A-Scope' }), false);
});

test('Turnstile bounds responses, exceptions, deadlines and outstanding cancellation-ignoring requests', async () => {
  for (const fetcher of [async () => new Response('x'.repeat(8193)), async () => new Response('{}', { status: 302 }), async () => { throw new Error('secret upstream details'); }])
    assert.equal(await createTurnstileChallenge({ ...config, fetch: fetcher }).verify(input), false);
  let calls = 0;
  const never = () => new Promise<Response>(() => {});
  const challenge = createTurnstileChallenge({ ...config, timeoutMs: 10, fetch: () => { calls++; return never(); } });
  const results = await Promise.all(Array.from({ length: 40 }, () => challenge.verify(input)));
  assert.equal(results.every(value => value === false), true);
  assert.equal(calls, 32);
  assert.equal(await challenge.verify(input), false);
  assert.equal(calls, 32);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await challenge.verify({ ...input, signal: aborted.signal }), false);
});

test('the Turnstile widget names the action, posts challengeToken and declares its fixed origin', () => {
  const challenge = createTurnstileChallenge(config);
  const widget = challenge.widget('forms');
  assert.equal(widget.markup, '<div class="cf-turnstile" data-sitekey="site_key_12345" data-action="forms" data-response-field-name="challengeToken"></div>');
  assert.deepEqual(widget.csp, { script: [turnstileOrigin], frame: [turnstileOrigin], connect: [turnstileOrigin] });
  assert.deepEqual(widget.scripts, [{ src: turnstileScript, async: true }]);
  assert.equal(turnstileScript, 'https://challenges.cloudflare.com/turnstile/v0/api.js');
  // It passes abuse's own widget validation, directly and through the wrapper.
  assert.deepEqual(validateWidget(widget), widget);
  assert.deepEqual(createChallenge(challenge).widget('auth').markup, challenge.widget('auth').markup);
});

test('the widget refuses script injection through the site key or the action', () => {
  for (const siteKey of ['"><script>', 'short', 'x'.repeat(257)]) assert.throws(() => createTurnstileChallenge({ ...config, siteKey }), /Invalid Turnstile configuration/);
  const challenge = createTurnstileChallenge(config);
  for (const action of ['"><script>', 'Auth', '', 'a'.repeat(33)]) assert.throws(() => challenge.widget(action), /Invalid challenge action/);
});
