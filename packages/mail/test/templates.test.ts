import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMail, recordingTransport } from '../src/index.ts';
import type { MailContribution, MailTemplate } from '../src/index.ts';
import type { Contribution } from '@jimhoyd/urlcode/extensions';
import { activated, activation, demo, demoContribution, origin, refusal, sha, tempSite } from './support.ts';

// Each value is stamped as composeHost would: `from` is its own namespace when that is a valid name.
const stamp = (value: unknown) => ({ from: typeof (value as MailContribution)?.namespace === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test((value as MailContribution).namespace) ? (value as MailContribution).namespace : 'x', value });
const build = (...contributions: unknown[]) => createMail({ projectSha256: sha, site: '/srv/site', contributions: contributions.map(stamp) as Contribution<MailContribution>[], transport: null });
const one = (template: Partial<MailTemplate> & Record<string, unknown>) => ({ namespace: 'x', templates: { t: { subject: 'S', text: 'Hi {name}', slots: { name: 'text' }, ...template } } });

test('contributions are validated at host time, naming the namespace or key', () => {
  assert.throws(() => build(demo, { ...demo }), /Two extensions contribute mail namespace demo/);
  assert.throws(() => build({ namespace: 'Bad', templates: {} }), /namespace/);
  assert.throws(() => build({ namespace: 'x', templates: {} }), /x needs 1-128 templates/);
  assert.throws(() => build(one({ text: 'Hi {name} {other}' })), /x\.t: the \{slots\}/);
  assert.throws(() => build(one({ text: 'Hi there' })), /x\.t: the \{slots\}/);
  assert.throws(() => build(one({ subject: 'Hi {name}' })), /x\.t: the subject/);
  assert.throws(() => build(one({ subject: 'Hi\r\nBcc: evil@example.test' })), /x\.t: the subject/);
  assert.throws(() => build(one({ subject: 'x'.repeat(161) })), /subject/);
  assert.throws(() => build(one({ text: 'Hi {name}' + 'x'.repeat(16384) })), /text/);
  assert.throws(() => build(one({ text: 'Hi\r\n{name}' })), /text/);
  assert.throws(() => build(one({ slots: { name: 'html' as never } })), /kind/);
  assert.throws(() => build(one({ text: '{a}{b}{c}{d}{e}{f}{g}{h}{i}', slots: Object.fromEntries('abcdefghi'.split('').map(slot => [slot, 'text'])) })), /at most 8 slots/);
  assert.throws(() => build({ namespace: 'x', templates: { Bad: { subject: 'S', text: 'T', slots: {} } } }), /template keys/);
  const many = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`k${index}`, { subject: 'S', text: 'T', slots: {} }]));
  assert.throws(() => build({ namespace: 'x', templates: many }), /1-128 templates/);
  const mail = build(demo);
  assert.equal(mail.exports.has('demo.notice'), true);
  assert.equal(mail.exports.has('demo.missing'), false);
  assert.equal(mail.exports.has('notice'), false);
});

test('a mail namespace must be its contributor\'s own name, which core stamps as from', () => {
  const direct = (contributions: unknown[]) => () => createMail({ projectSha256: sha, site: '/srv/site', contributions: contributions as Contribution<MailContribution>[], transport: null });
  assert.throws(direct([{ from: 'forms', value: demo }]), /Mail namespace "demo" is contributed by extension "forms": an extension contributes mail templates only under its own name/);
  // A bare contribution, without the stamp, is not accepted.
  assert.throws(direct([demo]), /must be \{from, value\}/);
  assert.throws(direct([{ from: 'Bad', value: demo }]), /must be \{from, value\}/);
  assert.equal(createMail({ projectSha256: sha, site: '/srv/site', contributions: [demoContribution], transport: null }).exports.has('demo.notice'), true);
});

test('every slot kind is enforced at send time', async t => {
  const transport = recordingTransport();
  const { exports } = await activated(t, { transport, context: { origins: [origin, 'https://alias.example.test'] } });
  const to = 'user@example.test';
  const send = (template: string, values: Record<string, string>) => exports.send({ template: `demo.${template}`, to, values });
  await send('notice', { link: `${origin}/account` });
  await send('token', { link: `${origin}/account/reset?token=abc` });
  await send('code', { code: '123456', link: `${origin}/signup` });
  await send('note', { body: 'line one\n\tline two' });
  await send('plain', {});
  assert.equal(transport.sent.length, 5);
  assert.equal(transport.sent[0]!.text, `Something changed.\n\nReview it at ${origin}/account.`);
  for (const [template, values] of [
    ['notice', { link: 'https://evil.example.test/account' }],
    ['notice', { link: 'https://alias.example.test/account' }],
    ['notice', { link: `${origin}/account?token=abc` }],
    ['notice', { link: `${origin}/account?` }],
    ['notice', { link: `${origin}/account#frag` }],
    ['notice', { link: 'https://user:pw@mail.example.test/account' }],
    ['notice', { link: `${origin}/acc\nount` }],
    ['notice', { link: `${origin}/account `.trim() + '/' + 'x'.repeat(2048) }],
    ['notice', { link: '/account' }],
    ['token', { link: `${origin}/reset?token=abc#x` }],
    ['token', { link: `http://mail.example.test/reset?token=abc` }],
    ['code', { code: '12', link: `${origin}/signup` }],
    ['code', { code: '12 34', link: `${origin}/signup` }],
    ['note', { body: 'carriage\rreturn' }],
    ['note', { body: 'x'.repeat(8193) }],
    ['note', { body: 'bell\x07' }],
    ['notice', {}],
    ['plain', { extra: 'x' }],
    ['note', { body: 'ok', extra: 'x' }],
  ] as const) await refusal(send(template, values), 'invalid-values');
  assert.equal(transport.sent.length, 5);
});

test('copy files override and translate with a locale fallback chain', async t => {
  const { site, project } = await tempSite(t);
  await mkdir(join(site, 'mail', 'copy'), { recursive: true });
  await writeFile(join(site, 'mail', 'copy', 'en.json'), JSON.stringify({ 'demo.note': { subject: 'Operator note', text: 'Operator says:\n{body}' } }));
  await writeFile(join(site, 'mail', 'copy', 'fr.json'), JSON.stringify({ 'demo.notice': { subject: 'Avis', text: 'Consultez {link}.' } }));
  await writeFile(join(site, 'mail', 'copy', 'de.json'), JSON.stringify({ 'demo.notice': { subject: 'Hinweis', text: 'Siehe {link}.' } }));
  const transport = recordingTransport();
  const mail = createMail({ projectSha256: sha, site, contributions: [demoContribution], transport });
  t.after(() => mail.close());
  await mail.registration.activate({ defaultLocale: 'de', copy: { en: 'mail/copy/en.json', fr: 'mail/copy/fr.json', de: 'mail/copy/de.json' } }, activation(project));
  const send = (template: string, values: Record<string, string>, locale?: string) => mail.exports.send({ template: `demo.${template}`, to: 'u@example.test', values, ...(locale ? { locale } : {}) });
  const link = `${origin}/account`;
  await send('notice', { link }, 'fr');
  await send('notice', { link }, 'fr-CA');
  await send('notice', { link }, 'es');
  await send('notice', { link }, 'not a locale!');
  await send('notice', { link });
  await send('note', { body: 'hi' }, 'fr');
  await send('plain', {}, 'fr');
  assert.deepEqual(transport.sent.map(envelope => [envelope.subject, envelope.locale]), [
    ['Avis', 'fr'], ['Avis', 'fr'], ['Hinweis', 'de'], ['Hinweis', 'de'], ['Hinweis', 'de'], ['A note', 'en'], ['Plain', 'en'],
  ]);
  // en copy overrides the source only when en is the chosen locale.
  await send('note', { body: 'hi' }, 'en-GB');
  assert.equal(transport.sent.at(-1)!.subject, 'Operator note');
  assert.equal(transport.sent.at(-1)!.text, 'Operator says:\nhi');
});

test('copy files are refused for unknown keys, changed slots, size, escapes and bad JSON', async t => {
  const { site, project } = await tempSite(t);
  await mkdir(join(site, 'mail', 'copy'), { recursive: true });
  const mail = createMail({ projectSha256: sha, site, contributions: [demoContribution], transport: recordingTransport() });
  t.after(() => mail.close());
  const attempt = async (content: string | object, pattern: RegExp) => {
    await writeFile(join(site, 'mail', 'copy', 'fr.json'), typeof content === 'string' ? content : JSON.stringify(content));
    await assert.rejects(async () => mail.registration.activate({ copy: { fr: 'mail/copy/fr.json' } }, activation(project)), pattern);
  };
  await attempt({ 'demo.missing': { subject: 'S', text: 'T' } }, /demo\.missing is not a contributed template/);
  await attempt({ 'demo.notice': { subject: 'S', text: 'No link here' } }, /must keep exactly the \{slots\} \{link\}/);
  await attempt({ 'demo.notice': { subject: 'S {link}', text: '{link}' } }, /subject/);
  await attempt({ 'demo.plain': { subject: 'S', text: 'x'.repeat(70000) } }, /at most 65536 bytes/);
  await attempt('{not json', /not JSON/);
  await assert.rejects(async () => mail.registration.activate({ copy: { fr: 'mail/copy/absent.json' } }, activation(project)), /does not exist/);
  await symlink('/etc/hosts', join(site, 'mail', 'copy', 'escape.json'));
  await assert.rejects(async () => mail.registration.activate({ copy: { fr: 'mail/copy/escape.json' } }, activation(project)), /inside the site/);
  assert.equal(mail.exports.active, false);
});
