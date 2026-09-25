// forms as the second consumer of abuse: a mounted flow's `abuse` block rate limits submissions per client network
// through a real abuse extension, escalates to the operator's challenge, and drops honeypot submissions silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRuntime } from '@jimhoyd/urlcode';
import { composeHost } from '@jimhoyd/urlcode/host';
import ui from '@jimhoyd/urlcode-ui/extension';
import abuse from '@jimhoyd/urlcode-abuse/extension';
import type { AbuseChallengeProvider } from '@jimhoyd/urlcode-abuse';
import forms from '../src/extension.ts';
import { contact, origin, recordingHook, serve, site, valid } from './support.ts';

const csrfSecret = 'c'.repeat(32);
const challengeOrigin = 'https://challenge.example.test';
/** A stand-in verifier: the token `good-token` passes, anything else fails. */
function provider(calls: { token: string; client: string; action: string }[] = []): AbuseChallengeProvider {
  return {
    widget(action) {
      return { markup: `<div class="test-challenge" data-action="${action}"></div>`, csp: { script: [challengeOrigin], frame: [challengeOrigin], connect: [challengeOrigin] }, scripts: [{ src: `${challengeOrigin}/widget.js`, async: true }] };
    },
    async verify(input) { calls.push({ token: input.token, client: input.client, action: input.action }); return input.token === 'good-token'; },
  };
}
const calls = (key: string): unknown[] => (globalThis as unknown as Record<string, unknown[] | undefined>)[key] ?? [];

test('the sixth submission in a window gets 429 with Retry-After, and invalid submissions count too', async t => {
  const where = await site(t, { contact: contact({ abuse: { client: { limit: 5, windowMs: 3600000 } } }) }, { declare: ['abuse'], hook: recordingHook('__formsAbuseLimit') });
  const { submit } = await serve(t, where, [ui(), forms({ csrfSecret }), abuse({ key: randomBytes(32) })]);
  for (let index = 0; index < 3; index++) assert.equal((await submit(valid)).status, 303);
  assert.equal((await submit({ ...valid, email: 'not-an-email' })).status, 422, 'an invalid submission is refused after it is counted');
  assert.equal((await submit(valid)).status, 303);
  const limited = await submit(valid);
  assert.equal(limited.status, 429);
  const retryAfter = Number(limited.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 3600, `Retry-After ${retryAfter}`);
  const page = await limited.text();
  assert.match(page, /Too many submissions/);
  assert.ok(!page.includes('127.0.0.1'), 'the page names no client');
  assert.equal(calls('__formsAbuseLimit').length, 4, 'onSubmit ran for the four admitted valid submissions only');
});

test('above challengeAfter the form re-renders 403 with the widget and the values; a verified token is admitted', async t => {
  const seen: { token: string; client: string; action: string }[] = [];
  const where = await site(t, { contact: contact({ abuse: { client: { limit: 5, windowMs: 3600000 }, challengeAfter: 2 } }) }, { declare: ['abuse'] });
  const { form, submit } = await serve(t, where, [ui(), forms({ csrfSecret }), abuse({ key: randomBytes(32), challenge: provider(seen) })]);
  const page = await form();
  assert.match(page.html, /class="test-challenge" data-action="forms"/, 'the widget is always on a flow with challengeAfter');
  assert.match(page.html, new RegExp(`<script[^>]+src="${challengeOrigin}/widget.js"[^>]* async`));
  assert.equal((await submit(valid)).status, 303);
  assert.equal((await submit(valid)).status, 303);
  const challenged = await submit({ ...valid, message: 'Keep <this> text', challengeToken: 'bad-token' });
  assert.equal(challenged.status, 403);
  assert.ok((challenged.headers.get('content-security-policy') ?? '').includes(challengeOrigin), 'the widget origin is allowed by the page CSP');
  const html = await challenged.text();
  assert.match(html, /Complete the verification and submit again/);
  assert.match(html, /Keep &lt;this&gt; text/, 'the entered values are kept, escaped');
  assert.match(html, /class="test-challenge"/);
  const verified = await submit({ ...valid, challengeToken: 'good-token' });
  assert.equal(verified.status, 303);
  assert.deepEqual(seen.map(call => [call.token, call.action]), [['bad-token', 'forms'], ['good-token', 'forms']]);
  assert.ok(seen.every(call => call.client === '127.0.0.1'), 'the raw client address, not a clientKey, reaches the verifier');
});

test('a filled honeypot is accepted with the confirmation redirect and never reaches onSubmit', async t => {
  const where = await site(t, { contact: contact({ abuse: { client: { limit: 5, windowMs: 3600000 }, honeypot: 'website' } }) }, { declare: ['abuse'], hook: recordingHook('__formsHoneypot') });
  const { form, submit } = await serve(t, where, [ui(), forms({ csrfSecret }), abuse({ key: randomBytes(32) })]);
  assert.match((await form()).html, /<div hidden><label>Leave this field empty<input name="website"/);
  const bot = await submit({ ...valid, website: 'https://spam.example' });
  assert.equal(bot.status, 303);
  assert.equal(bot.headers.get('location'), '/contact/confirmation');
  assert.equal(calls('__formsHoneypot').length, 0);
  const person = await submit({ ...valid, website: '' });
  assert.equal(person.status, 303, 'an empty honeypot is not refused as an undeclared field');
  assert.equal(calls('__formsHoneypot').length, 1);
});

test('activation refuses abuse that cannot be enforced: missing, off node, or a challenge without a verifier', async t => {
  const limited = contact({ abuse: { client: { limit: 5, windowMs: 3600000 } } });
  const missing = await site(t, { contact: limited });
  const bare = await composeHost(missing.hostUrl, [ui(), forms({ csrfSecret })]);
  t.after(() => bare.close?.());
  await assert.rejects(createRuntime(missing.project, { origin, extensions: bare.extensions ?? [] }), /Form contact: abuse needs the abuse extension; run urlcode extensions add abuse/);
  await assert.rejects(createRuntime(missing.project, { origin, target: 'vercel', extensions: bare.extensions ?? [] }), /Form contact: abuse runs on node only; target vercel cannot enforce it/);
  const hosted = await site(t, { contact: contact({ abuse: { client: { limit: 5, windowMs: 3600000 }, challengeAfter: 2 } }) }, { declare: ['abuse'] });
  const noVerifier = await composeHost(hosted.hostUrl, [ui(), forms({ csrfSecret }), abuse({ key: randomBytes(32) })]);
  t.after(() => noVerifier.close?.());
  await assert.rejects(createRuntime(hosted.project, { origin, extensions: noVerifier.extensions ?? [] }), /abuse\.challengeAfter needs a challenge verifier/);
  const badThreshold = await site(t, { contact: contact({ abuse: { client: { limit: 5, windowMs: 3600000 }, challengeAfter: 5 } }) }, { declare: ['abuse'] });
  const threshold = await composeHost(badThreshold.hostUrl, [ui(), forms({ csrfSecret }), abuse({ key: randomBytes(32), challenge: provider() })]);
  t.after(() => threshold.close?.());
  await assert.rejects(createRuntime(badThreshold.project, { origin, extensions: threshold.extensions ?? [] }), /challengeAfter must be below abuse.client.limit/);
  const collision = await site(t, { contact: contact({ abuse: { client: { limit: 5, windowMs: 3600000 }, honeypot: 'email' } }) }, { declare: ['abuse'] });
  const colliding = await composeHost(collision.hostUrl, [ui(), forms({ csrfSecret }), abuse({ key: randomBytes(32) })]);
  t.after(() => colliding.close?.());
  await assert.rejects(createRuntime(collision.project, { origin, extensions: colliding.extensions ?? [] }), /abuse.honeypot email collides with a field/);
});

test('flows without abuse are unchanged, and still serve on aws and vercel', async t => {
  const where = await site(t, { contact: contact() });
  const host = await composeHost(where.hostUrl, [ui(), forms({ csrfSecret })]);
  t.after(() => host.close?.());
  for (const target of ['aws', 'vercel'] as const) {
    const runtime = await createRuntime(where.project, { origin, target, extensions: host.extensions ?? [] });
    await runtime.close?.();
  }
  const { submit } = await serve(t, where, [ui(), forms({ csrfSecret })]);
  assert.equal((await submit({ ...valid, challengeToken: 'x' })).status, 422, 'a flow without a challenge refuses challengeToken as an undeclared field');
  for (let index = 0; index < 7; index++) assert.equal((await submit(valid)).status, 303, 'no budget applies');
});
