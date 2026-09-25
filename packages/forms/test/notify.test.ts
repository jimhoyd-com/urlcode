// forms as the second consumer of mail: a mounted flow's `notify` mails each accepted submission, after onSubmit and
// before the confirmation, to an operator-named recipient through a real mail extension (recording transport).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRuntime } from '@jimhoyd/urlcode';
import { composeHost } from '@jimhoyd/urlcode/host';
import ui from '@jimhoyd/urlcode-ui/extension';
import abuse from '@jimhoyd/urlcode-abuse/extension';
import mail from '@jimhoyd/urlcode-mail/extension';
import { recordingTransport } from '@jimhoyd/urlcode-mail';
import type { MailTransport } from '@jimhoyd/urlcode-mail';
import forms from '../src/extension.ts';
import { contact, origin, recordingHook, serve, site, valid } from './support.ts';

const csrfSecret = 'c'.repeat(32);
const recipients = { office: 'office@example.test' };
const calls = (key: string): unknown[] => (globalThis as unknown as Record<string, unknown[] | undefined>)[key] ?? [];
const confirmationCookie = (response: Response) => response.headers.getSetCookie().some(header => header.startsWith('__Host-urlcode-forms-confirmation=') && !header.includes('Max-Age=0'));

test('an accepted submission sends one forms.submission message to the recipient, with only the included fields', async t => {
  const transport = recordingTransport();
  const where = await site(t, { contact: contact({ notify: { recipient: 'office', include: ['message', 'name'] }, confirmation: { title: 'Thanks', message: 'Received {name}.', show: ['name'] } }) }, { declare: ['mail'] });
  const { submit } = await serve(t, where, [ui(), forms({ csrfSecret }), mail({ transport, recipients })]);
  const answer = await submit({ name: 'Ada\r\nLovelace', email: 'ada@example.test', message: 'Line one\r\nLine two' });
  assert.equal(answer.status, 303);
  assert.ok(confirmationCookie(answer), 'the confirmation handoff is issued after delivery');
  assert.equal(transport.sent.length, 1);
  const [envelope] = transport.sent;
  assert.equal(envelope!.template, 'forms.submission');
  assert.equal(envelope!.to, 'office@example.test');
  assert.equal(envelope!.subject, 'New form submission');
  assert.match(envelope!.text, /A visitor submitted the form "Contact us"\./);
  assert.match(envelope!.text, /^Name: Ada\nLovelace\nMessage: Line one\nLine two$/m, 'declaration order, CRLF as LF');
  assert.ok(!envelope!.text.includes('ada@example.test'), 'a field outside include is not mailed');
  assert.ok(!envelope!.text.includes('\r'));
});

test('C0 and C1 control characters in an included value become U+FFFD, so the notice still delivers', async t => {
  const transport = recordingTransport();
  const where = await site(t, { contact: contact({ notify: { recipient: 'office', include: ['message'] } }) }, { declare: ['mail'] });
  const { submit } = await serve(t, where, [ui(), forms({ csrfSecret }), mail({ transport, recipients })]);
  const answer = await submit({ ...valid, message: 'Next\u0085line\u009fand\u0007bell' });
  assert.equal(answer.status, 303);
  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0]!.text, /^Message: Next�line�and�bell$/m);
});

test('without include the message carries no values; a flow without notify sends nothing', async t => {
  const transport = recordingTransport();
  const where = await site(t, { contact: contact({ notify: { recipient: 'office' } }), quiet: { ...contact(), mount: '/quiet' } }, { declare: ['mail'] });
  const { submit } = await serve(t, where, [ui(), forms({ csrfSecret }), mail({ transport, recipients })]);
  assert.equal((await submit(valid)).status, 303);
  assert.match(transport.sent[0]!.text, /\(No submitted values are included in this notification\.\)/);
  assert.ok(!transport.sent[0]!.text.includes('Hello there'));
  assert.equal((await submit(valid, '/quiet')).status, 303);
  assert.equal(transport.sent.length, 1, 'the flow without notify sent nothing');
});

test('onSubmit runs before the mail; onSubmit throwing, a honeypot or a failed validation sends nothing', async t => {
  const transport = recordingTransport(), key = '__formsNotifyOrder';
  const order: string[] = [];
  const observed: MailTransport = { kind: 'observed', development: true, async deliver(envelope, signal) { order.push(`mail:${calls(key).length}`); await transport.deliver(envelope, signal); } };
  const where = await site(t, { contact: contact({ notify: { recipient: 'office' }, abuse: { client: { limit: 50, windowMs: 3600000 }, honeypot: 'website' } }) }, { declare: ['abuse', 'mail'], hook: recordingHook(key) });
  const { submit } = await serve(t, where, [ui(), forms({ csrfSecret }), abuse({ key: randomBytes(32) }), mail({ transport: observed, recipients })]);
  assert.equal((await submit(valid)).status, 303);
  assert.deepEqual(order, ['mail:1'], 'onSubmit had run (one call recorded) when the mail was delivered');
  assert.equal((await submit({ ...valid, message: 'boom now' })).status, 500);
  assert.equal((await submit({ ...valid, website: 'https://spam.example' })).status, 303);
  assert.equal((await submit({ ...valid, email: 'nope' })).status, 422);
  assert.equal(transport.sent.length, 1, 'none of those sent mail');
});

test('a failed delivery answers 503 and issues no confirmation', async t => {
  const failing: MailTransport = { kind: 'failing', development: true, async deliver() { throw new Error('relay down'); } };
  const where = await site(t, { contact: contact({ notify: { recipient: 'office' }, confirmation: { title: 'Thanks', message: 'Received {name}.', show: ['name'] } }) }, { declare: ['mail'] });
  const { submit } = await serve(t, where, [ui(), forms({ csrfSecret }), mail({ transport: failing, recipients })]);
  const answer = await submit(valid);
  assert.equal(answer.status, 503);
  assert.equal(await answer.text(), 'The form could not be submitted');
  assert.equal(confirmationCookie(answer), false);
  assert.equal(answer.headers.get('location'), null);
});

test('activation refuses notify without mail, with delivery disabled, or with an unknown recipient', async t => {
  const notifying = contact({ notify: { recipient: 'office' } });
  const absent = await site(t, { contact: notifying });
  const bare = await composeHost(absent.hostUrl, [ui(), forms({ csrfSecret })]);
  t.after(() => bare.close?.());
  await assert.rejects(createRuntime(absent.project, { origin, extensions: bare.extensions ?? [] }), /Form contact: notify needs the mail extension; run urlcode extensions add mail/);
  const declared = await site(t, { contact: notifying }, { declare: ['mail'] });
  const disabled = await composeHost(declared.hostUrl, [ui(), forms({ csrfSecret }), mail({ transport: null, recipients })]);
  t.after(() => disabled.close?.());
  await assert.rejects(createRuntime(declared.project, { origin, extensions: disabled.extensions ?? [] }), /Form contact: notify needs mail delivery, which is disabled/);
  const unknown = await composeHost(declared.hostUrl, [ui(), forms({ csrfSecret }), mail({ transport: recordingTransport() })]);
  t.after(() => unknown.close?.());
  await assert.rejects(createRuntime(declared.project, { origin, extensions: unknown.extensions ?? [] }), /Form contact: notify recipient office is not configured/);
  const include = await site(t, { contact: contact({ notify: { recipient: 'office', include: ['phone'] } }) }, { declare: ['mail'] });
  const undeclaredField = await composeHost(include.hostUrl, [ui(), forms({ csrfSecret }), mail({ transport: recordingTransport(), recipients })]);
  t.after(() => undeclaredField.close?.());
  await assert.rejects(createRuntime(include.project, { origin, extensions: undeclaredField.extensions ?? [] }), /notify include lists undeclared field phone/);
});

test('mail installed without any notify flow changes nothing', async t => {
  const transport = recordingTransport();
  const where = await site(t, { contact: contact() }, { declare: ['mail'] });
  const { submit } = await serve(t, where, [ui(), forms({ csrfSecret }), mail({ transport, recipients })]);
  assert.equal((await submit(valid)).status, 303);
  assert.equal(transport.sent.length, 0);
});
