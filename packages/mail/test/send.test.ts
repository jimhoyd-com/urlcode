import test from 'node:test';
import assert from 'node:assert/strict';
import { createMail, recordingTransport } from '../src/index.ts';
import type { MailEnvelope, MailTransport } from '../src/index.ts';
import { activated, activation, demoContribution, origin, refusal, sha, tempSite } from './support.ts';

const notice = { template: 'demo.notice', to: 'user@example.test', values: { link: `${origin}/account` } };
/** A transport that never finishes on its own; it rejects only when its signal aborts. */
function hanging(): MailTransport & { calls: number; aborted: number } {
  const transport = { kind: 'hang', development: true, calls: 0, aborted: 0,
    deliver(_envelope: MailEnvelope, signal: AbortSignal) {
      transport.calls++;
      return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { transport.aborted++; reject(new Error('cancelled')); }, { once: true }));
    } };
  return transport;
}

test('the deadline answers timeout (503) and aborts the transport', async t => {
  const transport = hanging();
  const { exports } = await activated(t, { transport, deadlineMs: 1000 });
  const started = Date.now();
  const error = await refusal(exports.send(notice), 'timeout');
  assert.equal(error.status, 503);
  assert.ok(Date.now() - started >= 900);
  assert.equal(transport.aborted, 1);
});

test('the caller signal aborts a delivery, and a pre-aborted signal never reaches the transport', async t => {
  const transport = hanging();
  const { exports } = await activated(t, { transport });
  const controller = new AbortController();
  const pending = exports.send({ ...notice, signal: controller.signal });
  controller.abort();
  await refusal(pending, 'aborted');
  assert.equal(transport.calls, 1);
  await refusal(exports.send({ ...notice, signal: AbortSignal.abort() }), 'aborted');
  assert.equal(transport.calls, 1);
});

test('maxConcurrent bounds deliveries across consumers with an immediate busy', async t => {
  const transport = hanging();
  const { exports } = await activated(t, { transport, maxConcurrent: 1 });
  const controller = new AbortController();
  const first = exports.send({ ...notice, signal: controller.signal });
  const error = await refusal(exports.send(notice), 'busy');
  assert.equal(error.status, 503);
  controller.abort();
  await refusal(first, 'aborted');
  // The slot is released.
  const second = new AbortController();
  const again = exports.send({ ...notice, signal: second.signal });
  second.abort();
  await refusal(again, 'aborted');
});

test('a transport that ignores the abort keeps its slot until it settles', async t => {
  let finish: () => void = () => {};
  const transport: MailTransport = { kind: 'deaf', development: true, deliver: () => new Promise<void>(resolve => { finish = resolve; }) };
  const { exports } = await activated(t, { transport, maxConcurrent: 1 });
  const controller = new AbortController();
  const first = exports.send({ ...notice, signal: controller.signal });
  controller.abort();
  await refusal(first, 'aborted');
  await refusal(exports.send(notice), 'busy');
  finish();
  await new Promise(resolve => setImmediate(resolve));
  const second = new AbortController();
  const again = exports.send({ ...notice, signal: second.signal });
  second.abort();
  await refusal(again, 'aborted');
  finish();
});

test('inactive before activation, closed after close, and close ends deliveries in flight', async t => {
  const transport = hanging();
  const mail = await activated(t, { transport }, false);
  assert.equal(mail.exports.active, false);
  assert.equal(mail.exports.available, false);
  await refusal(mail.exports.send(notice), 'inactive');
  await mail.registration.activate({}, activation(mail.project));
  assert.equal(mail.exports.active, true);
  assert.equal(mail.exports.available, true);
  const pending = mail.exports.send(notice);
  await mail.close();
  await refusal(pending, 'closed');
  await refusal(mail.exports.send(notice), 'closed');
  assert.equal(mail.exports.active, false);
  await mail.close();
  await assert.rejects(async () => mail.registration.activate({}, activation(mail.project)), /closed/);
});

test('an instance close deactivates only its own activation; the runtime may activate again', async t => {
  const transport = recordingTransport();
  const mail = await activated(t, { transport });
  const second = await mail.registration.activate({}, activation(mail.project));
  await mail.instance!.close?.();
  assert.equal(mail.exports.active, true);
  await second.close?.();
  await second.close?.();
  assert.equal(mail.exports.active, false);
  await refusal(mail.exports.send(notice), 'inactive');
  await mail.registration.activate({}, activation(mail.project));
  await mail.exports.send(notice);
  assert.equal(transport.sent.length, 1);
});

test('transport null is unavailable before and after activation', async t => {
  const mail = await activated(t, { transport: null }, false);
  await refusal(mail.exports.send(notice), 'unavailable');
  await mail.registration.activate({}, activation(mail.project));
  assert.equal(mail.exports.active, true);
  assert.equal(mail.exports.available, false);
  const error = await refusal(mail.exports.send(notice), 'unavailable');
  assert.equal(error.status, 503);
});

test('recipients are refused unless they are one plain mailbox; the domain is lower-cased', async t => {
  const transport = recordingTransport();
  const { exports } = await activated(t, { transport });
  for (const to of ['', 'no-at', '@example.test', 'a@b@example.test', 'a @example.test', 'a@example.test\r\nBcc: b@example.test', 'a@example.test,b@example.test',
    'a@example.test;b@example.test', '<a@example.test>', 'a@nodot', 'a@example..test', '"a"@example.test', 'a@example.test ', `${'a'.repeat(320)}@example.test`]) {
    const error = await refusal(exports.send({ ...notice, to }), 'invalid-recipient');
    assert.equal(error.status, 400);
  }
  await exports.send({ ...notice, to: 'User.Name+tag@Example.TEST' });
  await exports.send({ ...notice, to: 'dev@localhost' });
  assert.deepEqual(transport.sent.map(envelope => envelope.to), ['User.Name+tag@example.test', 'dev@localhost']);
  assert.equal(transport.sent[0]!.from, 'no-reply@localhost');
});

test('refusals come in the documented order and carry the documented status', async t => {
  const { exports } = await activated(t, { transport: recordingTransport(), recipients: { ops: 'ops@example.test' } });
  assert.equal((await refusal(exports.send({ ...notice, template: 'demo.missing', to: 'bad' }), 'unknown-template')).status, 500);
  assert.equal((await refusal(exports.send({ ...notice, to: 'bad', values: {} }), 'invalid-recipient')).status, 400);
  assert.equal((await refusal(exports.send({ ...notice, values: {} }), 'invalid-values')).status, 500);
  assert.equal(exports.recipient('ops'), 'ops@example.test');
  assert.throws(() => exports.recipient('sales'), (error: Error & { code?: string; status?: number }) => error.code === 'unknown-recipient' && error.status === 500 && /sales/.test(error.message));
});

test('a transport failure is delivery-failed with the cause attached and never echoed', async t => {
  const cause = new Error('SES said user@example.test is suppressed');
  const failing: MailTransport = { kind: 'failing', development: true, async deliver() { throw cause; } };
  const { exports } = await activated(t, { transport: failing });
  const error = await refusal(exports.send(notice), 'delivery-failed');
  assert.equal(error.cause, cause);
  assert.equal(error.message, 'Email delivery failed: demo.notice');
  const synchronous: MailTransport = { kind: 'sync', development: true, deliver() { throw cause; } };
  const other = await activated(t, { transport: synchronous });
  await refusal(other.exports.send(notice), 'delivery-failed');
});

test('no address or value ever appears in a MailError message', async t => {
  const secret = 'user-secret@example.test', value = 'https://mail.example.test/reset?token=SECRETTOKEN';
  const messages: string[] = [];
  const collect = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { messages.push((error as Error).message); } };
  const failing: MailTransport = { kind: 'failing', development: true, async deliver() { throw new Error(secret + value); } };
  const { exports } = await activated(t, { transport: failing });
  await collect(exports.send({ template: secret, to: secret, values: { link: value } }));
  await collect(exports.send({ template: 'demo.notice', to: secret + '\n', values: { link: value } }));
  await collect(exports.send({ template: 'demo.notice', to: secret, values: { link: value } }));
  await collect(exports.send({ template: 'demo.token', to: secret, values: { link: value } }));
  try { exports.recipient(secret); } catch (error) { messages.push((error as Error).message); }
  assert.equal(messages.length, 5);
  for (const message of messages) {
    assert.ok(!message.includes('user-secret'), message);
    assert.ok(!message.includes('SECRETTOKEN'), message);
  }
});

test('host options are validated', async t => {
  const { site } = await tempSite(t);
  const make = (options: Record<string, unknown>) => () => createMail({ projectSha256: sha, site, contributions: [demoContribution], ...options });
  assert.throws(make({ maxConcurrent: 0 }), /maxConcurrent/);
  assert.throws(make({ maxConcurrent: 65 }), /maxConcurrent/);
  assert.throws(make({ deadlineMs: 999 }), /deadlineMs/);
  assert.throws(make({ deadlineMs: 30001 }), /deadlineMs/);
  assert.throws(make({ from: 'ops@example.test\r\nBcc: evil@example.test' }), /from/);
  assert.throws(make({ recipients: { Ops: 'ops@example.test' } }), /recipient names/);
  assert.throws(make({ recipients: { ops: 'not an address' } }), /recipient ops/);
  assert.throws(make({ recipients: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`r${index}`, 'ops@example.test'])) }), /32/);
  assert.throws(make({ transport: { kind: 'Bad', development: true, deliver() {} } }), /transport/);
  assert.throws(make({ transport: { kind: 'real', development: false, deliver() {} } }), /needs from/);
  assert.throws(() => createMail({ projectSha256: 'x', site, contributions: [] }), /revision pin/);
  make({ transport: { kind: 'real', development: false, deliver() {} }, from: 'ops@example.test' })();
});
