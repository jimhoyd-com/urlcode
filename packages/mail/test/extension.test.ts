import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '@jimhoyd/urlcode';
import { defineExtension, inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { Contribution, HostContext } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import mail from '../src/extension.ts';
import { mailConfigSchema, outboxTransport, recordingTransport, sesTransport } from '../src/index.ts';
import type { MailContribution, MailExports, MailHostOptions } from '../src/index.ts';
import notifier, { notifierMail } from './fixtures/notifier.ts';
import { activation, demo, refusal, sha, tempSite } from './support.ts';

const hostContext = (site: string, contributions: readonly MailContribution[] = [demo]): HostContext => ({
  projectSha256: sha, site, get: () => { throw new Error('mail requires nothing'); },
  contributions: <T>() => contributions.map(value => Object.freeze({ from: value.namespace, value })) as unknown as Contribution<T>[],
});
async function hosted(t: TestContext, options: MailHostOptions = {}) {
  const { site, project } = await tempSite(t);
  const result = await mail.definition.host(hostContext(site), options);
  t.after(() => result.close?.());
  return { ...result, exports: result.exports as MailExports, site, project };
}
function withSha(t: TestContext, value: string): void {
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = value;
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
}
const notice = { template: 'demo.notice', to: 'user@example.test' };

test('the definition shares the runtime schema, requires nothing and targets node, aws and vercel', async t => {
  assert.equal(mail.definition.name, 'mail');
  assert.equal(mail.definition.schema, mailConfigSchema);
  assert.deepEqual(mail.definition.requires, []);
  assert.equal(mail.definition.example, undefined);
  const { registration } = await hosted(t);
  assert.deepEqual(registration.targets, ['node', 'aws', 'vercel']);
});

test('the scaffold writes only a private data/outbox/.keep, with no routes', async () => {
  const scaffolded = await mail.definition.scaffold!({ site: '/srv/site', project: '/srv/site/app', installed: ['mail'], acknowledgements: [] });
  assert.deepEqual(scaffolded.config, {});
  assert.deepEqual(scaffolded.routes, {});
  assert.deepEqual(scaffolded.files, [{ path: 'data/outbox/.keep', content: '', mode: 0o600 }]);
  assert.match(scaffolded.notes![0]!, /loopback origin mail writes messages to data\/outbox/);
});

test('host() validates operator options: from is required for SES, recipients are checked', async t => {
  const { site } = await tempSite(t);
  const ses = sesTransport({ region: 'us-east-1', send: async () => undefined });
  await assert.rejects(async () => mail.definition.host(hostContext(site), { transport: ses }), /needs from/);
  await assert.rejects(async () => mail.definition.host(hostContext(site), { recipients: { ops: 'ops@example.test\nBcc: x@example.test' } }), /recipient ops/);
  await assert.rejects(async () => mail.definition.host(hostContext(site, [demo, demo]), {}), /namespace demo/);
  const ok = await mail.definition.host(hostContext(site), { transport: ses, from: 'no-reply@example.test' });
  await ok.close?.();
});

test('default transport: a loopback node origin writes to <site>/data/outbox', async t => {
  const { exports, registration, site, project } = await hosted(t, { recipients: { ops: 'ops@example.test' } });
  assert.equal(exports.available, false);
  await registration.activate({}, activation(project, { origin: 'http://localhost:4173' }));
  assert.equal(exports.active, true);
  assert.equal(exports.available, true);
  await exports.send({ ...notice, values: { link: 'http://localhost:4173/account' } });
  const directory = join(site, 'data', 'outbox');
  if (process.platform !== 'win32') assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(await readFile(join(directory, files[0]!), 'utf8')).template, 'demo.notice');
});

test('default transport: 127.0.0.0/8 and [::1] are loopback too', async t => {
  for (const origin of ['http://127.0.0.1:8080', 'http://127.1.2.3', 'http://[::1]:3000']) {
    const { exports, registration, project } = await hosted(t);
    await registration.activate({}, activation(project, { origin }));
    assert.equal(exports.available, true, origin);
  }
});

test('default transport: any other origin, or a loopback origin off node, is unavailable', async t => {
  const https = await hosted(t);
  await https.registration.activate({}, activation(https.project, { origin: 'https://example.com' }));
  assert.equal(https.exports.active, true);
  assert.equal(https.exports.available, false);
  await refusal(https.exports.send({ ...notice, values: { link: 'https://example.com/account' } }), 'unavailable');
  const aws = await hosted(t);
  await aws.registration.activate({}, activation(aws.project, { origin: 'http://localhost:4173', target: 'aws' }));
  assert.equal(aws.exports.available, false);
  const none = await hosted(t, { transport: null });
  await none.registration.activate({}, activation(none.project, { origin: 'http://localhost:4173' }));
  assert.equal(none.exports.available, false);
  await refusal(none.exports.send({ ...notice, values: { link: 'http://localhost:4173/account' } }), 'unavailable');
});

test('an explicit outbox is honored on any node origin', async t => {
  const { site, project } = await tempSite(t);
  const directory = join(site, 'outbox');
  await mkdir(directory, { mode: 0o700 });
  const result = await mail.definition.host(hostContext(site), { transport: outboxTransport({ directory }) });
  t.after(() => result.close?.());
  await result.registration.activate({}, activation(project, { origin: 'https://example.com' }));
  await (result.exports as MailExports).send({ ...notice, values: { link: 'https://example.com/account' } });
  assert.equal((await readdir(directory)).length, 1);
});

test('activation refuses a mail route, a development transport off node, and a non-HTTPS public origin', async t => {
  const recording = await hosted(t, { transport: recordingTransport() });
  await assert.rejects(Promise.resolve(recording.registration.activate({}, activation(recording.project, { mounts: ['/mail'] }))), /serves no routes/);
  await assert.rejects(Promise.resolve(recording.registration.activate({}, activation(recording.project, { target: 'aws' }))), /development transport recording refuses target aws/);
  await assert.rejects(Promise.resolve(recording.registration.activate({}, activation(recording.project, { origin: 'http://example.com' }))), /HTTPS origin/);
  const outbox = await hosted(t, { transport: outboxTransport({ directory: '/tmp' }) });
  await assert.rejects(Promise.resolve(outbox.registration.activate({}, activation(outbox.project, { target: 'aws' }))), /development transport outbox refuses target aws/);
  assert.equal(recording.exports.active, false);
  const ses = await hosted(t, { transport: sesTransport({ region: 'us-east-1', send: async () => undefined }), from: 'no-reply@example.test' });
  await ses.registration.activate({}, activation(ses.project, { target: 'vercel' }));
  assert.equal(ses.exports.available, true);
});

test('a consumer contributes a template through contributes.mail and sends it over real HTTP', async t => {
  const { site, project } = await tempSite(t);
  const transport = recordingTransport();
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({
    version: '1',
    extensions: { mail: { version: '1', config: {} }, notifier: { version: '1', config: {} } },
    routes: { '/notify/*': { extension: 'notifier', methods: ['POST'] } },
  }));
  withSha(t, await inspectExtensionRevision(project));
  const host = await composeHost(pathToFileURL(join(site, 'host.mjs')), [notifier(), mail({ transport, recipients: { ops: 'ops@example.test' } })]);
  const origin = 'https://mail.example.test';
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: host.extensions ?? [] });
  t.after(async () => { await app.close(); await host.close?.(); });
  const response = await fetch(`http://127.0.0.1:${app.address.port}/notify`, { method: 'POST', body: 'hello there' });
  assert.equal(response.status, 202, await response.clone().text());
  assert.equal(transport.sent.length, 1);
  assert.deepEqual({ ...transport.sent[0] }, {
    from: 'no-reply@localhost', to: 'ops@example.test', subject: notifierMail.templates.ping!.subject,
    text: `Someone pinged ${origin}/notify.\n\nNote: hello there`, template: 'notifier.ping', locale: 'en',
  });
  const refused = await fetch(`http://127.0.0.1:${app.address.port}/notify`, { method: 'POST', body: 'bad\rvalue' });
  assert.equal(refused.status, 500);
  assert.equal(transport.sent.length, 1);
});

test('composeHost refuses a mail namespace that is not its contributor\'s own name, naming both', async t => {
  const { site, project } = await tempSite(t);
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: {}, routes: {} }));
  withSha(t, await inspectExtensionRevision(project));
  const copycat = defineExtension<Record<string, never>>({
    name: 'copycat', description: 'Contributes a namespace that is already taken.', contributes: { mail: notifierMail },
    schema: { type: 'object' }, host: context => ({ registration: { name: 'copycat', version: '1', projectSha256: context.projectSha256, targets: ['node'], schema: { type: 'object' }, activate: () => ({ handle: () => ({ status: 404, headers: [] }) }) } }),
  });
  // copycat reuses notifier's contribution, namespace and all: core stamps it `from: 'copycat'`, so mail refuses it
  // whether or not notifier is installed.
  for (const entries of [[notifier(), copycat()], [copycat()]])
    await assert.rejects(composeHost(pathToFileURL(join(site, 'host.mjs')), [...entries, mail({ recipients: { ops: 'ops@example.test' } })]), (error: Error & { details?: { extension?: string } }) =>
      error.constructor.name === 'ConfigError' && error.details?.extension === 'mail' && /Mail namespace "notifier" is contributed by extension "copycat"/.test(error.message));
});
