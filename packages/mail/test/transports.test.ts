// Ported from auth's senders tests: SES input shape, abort, development file privacy and caps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { consoleTransport, outboxTransport, recordingTransport, sesTransport } from '../src/index.ts';
import type { MailEnvelope, SesEmailInput } from '../src/index.ts';
import { activated, origin, refusal, tempSite } from './support.ts';

const envelope: MailEnvelope = { from: 'operator@example.test', to: 'user@example.test', subject: 'Confirm', text: 'Confirm by opening:\n\nhttps://mail.example.test/x?token=abc', template: 'demo.token', locale: 'en' };
const context = (projectRoot: string, site: string) => ({ projectRoot, site, target: 'node' as const });

test('SES sends one recipient, plain text, from the configured mailbox, through mail', async t => {
  const sent: SesEmailInput[] = [];
  const transport = sesTransport({ region: 'us-east-1', send: async command => { sent.push(command.input); } });
  assert.equal(transport.development, false);
  const { exports } = await activated(t, { transport, from: 'Operator@Example.test' });
  await exports.send({ template: 'demo.token', to: 'user@example.test', values: { link: `${origin}/account/reset?token=${'a'.repeat(43)}` } });
  assert.deepEqual(sent[0], { FromEmailAddress: 'Operator@example.test', Destination: { ToAddresses: ['user@example.test'] }, Content: { Simple: { Subject: { Data: 'Confirm', Charset: 'UTF-8' }, Body: { Text: { Data: `Confirm by opening:\n\n${origin}/account/reset?token=${'a'.repeat(43)}`, Charset: 'UTF-8' } } } } });
  assert.ok(!JSON.stringify(sent[0]).includes('"Html"'));
});

test('SES validates region and credentials, and passes the abort signal to the SDK call', async () => {
  for (const region of ['', 'US-EAST-1', 'us-east', 'us-east-1\n']) assert.throws(() => sesTransport({ region }), /region/);
  assert.throws(() => sesTransport({ region: 'us-east-1', credentials: { accessKeyId: 1 } as never }), /credentials/);
  let seen: AbortSignal | undefined;
  const transport = sesTransport({ region: 'eu-west-2', send: async (_command, { abortSignal }) => { seen = abortSignal; } });
  const controller = new AbortController();
  await transport.deliver(envelope, controller.signal);
  assert.equal(seen, controller.signal);
});

test('SES without an injected send loads the optional SDK client lazily and destroys it on close', async () => {
  const transport = sesTransport({ region: 'us-east-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example' } });
  // The SDK is a dev dependency of the workspace, so it loads here; its absence is the fixed
  // 'SES delivery requires the optional @aws-sdk/client-sesv2 package' error.
  await transport.prepare!(context('/srv/site/app', '/srv/site'));
  await transport.close!();
});

test('outbox files are private, bounded and cannot be placed inside the project or a symlink alias', async t => {
  const { site, project } = await tempSite(t);
  const directory = join(site, 'outbox');
  await mkdir(directory, { mode: 0o700 });
  assert.throws(() => outboxTransport({ directory: 'relative/outbox' }), /absolute/);
  assert.throws(() => outboxTransport({ directory, maxMessages: 0 }), /limit/);
  assert.throws(() => outboxTransport({ directory, maxMessages: 1001 }), /limit/);
  await assert.rejects(outboxTransport({ directory: project }).prepare!(context(project, site)), /outside the project/);
  await mkdir(join(project, 'nested'), { mode: 0o700 });
  await assert.rejects(outboxTransport({ directory: join(project, 'nested') }).prepare!(context(project, site)), /outside the project/);
  await symlink(project, join(site, 'alias'));
  await assert.rejects(outboxTransport({ directory: join(site, 'alias') }).prepare!(context(project, site)), /outside the project/);
  // Windows privacy is controlled by ACLs, not POSIX group/other mode bits.
  if (process.platform !== 'win32') {
    await chmod(directory, 0o755);
    await assert.rejects(outboxTransport({ directory }).prepare!(context(project, site)), /private/);
    await chmod(directory, 0o700);
  }
  await assert.rejects(outboxTransport({ directory }).deliver(envelope, new AbortController().signal), /not prepared/);
  await writeFile(join(directory, '.keep'), '');
  const outbox = outboxTransport({ directory, maxMessages: 1 });
  await outbox.prepare!(context(project, site));
  await outbox.deliver(envelope, new AbortController().signal);
  const files = (await readdir(directory)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const path = join(directory, files[0]!);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { development: true, template: 'demo.token', to: 'user@example.test', from: 'operator@example.test', subject: 'Confirm', text: envelope.text, locale: 'en' });
  await assert.rejects(outbox.deliver(envelope, new AbortController().signal), /limit/);
  const reopened = outboxTransport({ directory, maxMessages: 1 });
  await reopened.prepare!(context(project, site));
  await assert.rejects(reopened.deliver(envelope, new AbortController().signal), /limit/);
  const larger = outboxTransport({ directory, maxMessages: 5 });
  await larger.prepare!(context(project, site));
  await assert.rejects(larger.deliver(envelope, AbortSignal.abort()));
  // A 16384-character body of multi-byte text is over the 32768-byte cap.
  await assert.rejects(larger.deliver({ ...envelope, text: 'é'.repeat(16384) }, new AbortController().signal), /too large/);
  await larger.deliver({ ...envelope, text: 'x'.repeat(16384) }, new AbortController().signal);
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.json')).length, 2);
});

test('console output is a JSON line with a message cap', async () => {
  const rows: string[] = [];
  const transport = consoleTransport({ maxMessages: 1, write: row => { rows.push(row); } });
  assert.equal(transport.development, true);
  await transport.deliver(envelope, new AbortController().signal);
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0]!).development, true);
  await assert.rejects(transport.deliver(envelope, new AbortController().signal), /limit/);
  await assert.rejects(consoleTransport().deliver(envelope, AbortSignal.abort()));
});

test('the recording transport is bounded, and a full one fails delivery through mail', async t => {
  assert.throws(() => recordingTransport({ max: 0 }), /limit/);
  const transport = recordingTransport({ max: 1 });
  const { exports } = await activated(t, { transport });
  const message = { template: 'demo.plain', to: 'user@example.test', values: {} };
  await exports.send(message);
  await refusal(exports.send(message), 'delivery-failed');
  assert.equal(transport.sent.length, 1);
  assert.ok(Object.isFrozen(transport.sent[0]));
});
