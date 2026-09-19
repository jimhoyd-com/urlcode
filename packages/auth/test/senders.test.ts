import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readdir, readFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSesSender, createDevelopmentSender } from '../src/senders.ts';
import type { TokenMessage, DevelopmentSenderOptions } from '../src/senders.ts';
const base = { origin: 'https://accounts.example.test', authMount: '/account' };
const message = (): TokenMessage => ({ email: 'user@example.test', token: 'a'.repeat(43), purpose: 'reset-password', signal: new AbortController().signal });
test('SES uses a single recipient, plain text and fixed operator origin/mount', async () => {
    const sent: unknown[] = [];
    const deliver = createSesSender({ ...base, region: 'us-east-1', from: 'operator@example.test', transport: async (command) => { sent.push(command.input); } });
    await deliver(message());
    assert.deepEqual(sent[0], { FromEmailAddress: 'operator@example.test', Destination: { ToAddresses: ['user@example.test'] }, Content: { Simple: { Subject: { Data: 'Reset your password', Charset: 'UTF-8' }, Body: { Text: { Data: `Reset your password by opening this link:\n\nhttps://accounts.example.test/account/reset?token=${'a'.repeat(43)}\n\nIf you did not request this, ignore this email. Never share this link.`, Charset: 'UTF-8' } } } } });
    await deliver.sendEmailCode({ email: 'user@example.test', flowId: 'b'.repeat(43), code: '123456', signal: message().signal });
    assert.ok(JSON.stringify(sent[1]).includes('/account/email-code?flowId='));
    assert.ok(!JSON.stringify(sent[1]).includes('code=123456'));
    await deliver.notify({ email: 'user@example.test', event: 'password-changed', signal: message().signal });
    assert.ok(!JSON.stringify(sent[2]).includes('token='));
    deliver.close();
    await assert.rejects(deliver(message()), /closed/);
});
test('SES refuses malformed recipients, tokens, origins and mounts before transport', async () => {
    let calls = 0;
    const options = { ...base, region: 'us-east-1', from: 'operator@example.test', transport: async () => { calls++; } };
    for (const overrides of [{ origin: 'https://accounts.example.test/path' }, { origin: 'http://remote.test' }, { authMount: '//evil.test' }, { from: 'good@example.test\r\nBcc: evil@example.test' }])
        assert.throws(() => createSesSender({ ...options, ...overrides }));
    const deliver = createSesSender(options);
    await assert.rejects(deliver({ ...message(), email: 'a@example.test\nCc: b@example.test' }));
    await assert.rejects(deliver({ ...message(), token: '../x' }));
    assert.equal(calls, 0);
    deliver.close();
});
test('delivery honors pre-abort and bounds simultaneous sends', async () => {
    let count = 0;
    const controller = new AbortController();
    controller.abort();
    const deliver = createSesSender({ ...base, region: 'us-east-1', from: 'operator@example.test', transport: async (_command, { abortSignal }) => { count++; await new Promise<void>((_resolve, reject) => abortSignal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); } });
    await assert.rejects(deliver({ ...message(), signal: controller.signal }));
    assert.equal(count, 0);
    const pendingController = new AbortController(), pending = Array.from({ length: 4 }, () => deliver({ ...message(), signal: pendingController.signal }));
    await assert.rejects(deliver(message()), /busy/);
    pendingController.abort();
    const results = await Promise.allSettled(pending);
    assert.ok(results.every(result => result.status === 'rejected'));
    deliver.close();
});
test('development delivery requires explicit flags and console token opt-in', async () => {
    await assert.rejects(createDevelopmentSender({ ...base, allowConsoleTokens: true } as DevelopmentSenderOptions), /allowDevelopment/);
    await assert.rejects(createDevelopmentSender({ ...base, allowDevelopment: true } as DevelopmentSenderOptions), /allowConsoleTokens/);
    const rows: string[] = [];
    const deliver = await createDevelopmentSender({ ...base, allowDevelopment: true, allowConsoleTokens: true, maxMessages: 1, write: row => { rows.push(row); } });
    await deliver(message());
    assert.equal(rows.length, 1);
    assert.ok(rows[0]?.includes('development'));
    await assert.rejects(deliver(message()), /limit/);
    deliver.close();
});
test('development files are private, bounded and cannot be placed inside project or a symlink alias', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-mail-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const project = join(root, 'project'), directory = join(root, 'mail');
    await mkdir(project, { mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    await assert.rejects(createDevelopmentSender({ ...base, allowDevelopment: true, directory: project, projectRoot: project }), /outside/);
    await symlink(project, join(root, 'alias'));
    await assert.rejects(createDevelopmentSender({ ...base, allowDevelopment: true, directory: join(root, 'alias'), projectRoot: project }), /outside/);
    await chmod(directory, 0o755);
    await assert.rejects(createDevelopmentSender({ ...base, allowDevelopment: true, directory, projectRoot: project }), /private/);
    await chmod(directory, 0o700);
    const deliver = await createDevelopmentSender({ ...base, allowDevelopment: true, directory, projectRoot: project, maxMessages: 1 });
    await deliver(message());
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const path = join(directory, files[0]!);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).email, 'user@example.test');
    const reopened = await createDevelopmentSender({ ...base, allowDevelopment: true, directory, projectRoot: project, maxMessages: 1 });
    await assert.rejects(reopened(message()), /directory limit/);
    deliver.close();
    reopened.close();
});
test('email change notices distinguish verification cooldown from old-address cancellation', async () => {
    const rows: string[] = [];
    const deliver = createSesSender({ ...base, region: 'us-east-1', from: 'operator@example.test', transport: async (command) => { rows.push(command.input.Content!.Simple!.Body!.Text!.Data!); } });
    await deliver({ ...message(), purpose: 'verify-email-change' });
    await deliver({ ...message(), purpose: 'cancel-email-change' });
    assert.ok(rows[0]!.includes('/account/verify-email-change?token='));
    assert.ok(rows[0]!.includes('24-hour cooldown'));
    assert.ok(rows[1]!.includes('/account/cancel-email-change?token='));
    assert.ok(rows[1]!.includes('before completion'));
    deliver.close();
});

test('signup mail keeps proof out of links and registration notices preserve existing accounts', async () => {
    const rows: string[] = [];
    const deliver = createSesSender({ ...base, region: 'us-east-1', from: 'operator@example.test', transport: async command => { rows.push(command.input.Content!.Simple!.Body!.Text!.Data!); } });
    await deliver.sendSignupCode({ email: 'user@example.test', code: '123456', signal: message().signal });
    assert.ok(rows[0]!.includes('signup code is: 123456'));
    assert.ok(rows[0]!.includes('https://accounts.example.test/account/signup'));
    assert.ok(!rows[0]!.includes('code='));
    await deliver.notify({ email: 'user@example.test', event: 'registration-attempt', signal: message().signal });
    assert.ok(rows[1]!.includes('existing account was not changed'));
    assert.ok(!rows[1]!.includes('token='));
    await assert.rejects(deliver.sendSignupCode({ email: 'user@example.test', code: '1234567', signal: message().signal }));
    assert.equal(rows.length, 2);
    deliver.close();
});

test('factor recovery mail has separate fixed-origin confirmation and cancellation capabilities', async () => {
    const rows: string[] = [];
    const deliver = createSesSender({ ...base, region: 'us-east-1', from: 'operator@example.test', transport: async command => { rows.push(command.input.Content!.Simple!.Body!.Text!.Data!); } });
    await deliver.sendFactorRecovery({ email: 'user@example.test', verificationToken: 'a'.repeat(43), cancelToken: 'b'.repeat(43), signal: message().signal });
    assert.ok(rows[0]!.includes('/account/recover-factor/confirm?token=' + 'a'.repeat(43)));
    assert.ok(rows[0]!.includes('/account/recover-factor/cancel?token=' + 'b'.repeat(43)));
    assert.ok(rows[0]!.includes('24-hour waiting period'));
    await assert.rejects(deliver.sendFactorRecovery({ email: 'user@example.test', verificationToken: '../bad', cancelToken: 'b'.repeat(43), signal: message().signal }));
    assert.equal(rows.length, 1);
    deliver.close();
});

test('manual recovery warns the old address before sending a restoration link and stops on warning failure', async () => {
    const rows: { email: string; text: string }[] = [];
    const deliver = createSesSender({ ...base, region: 'us-east-1', from: 'operator@example.test', transport: async command => { rows.push({ email: command.input.Destination!.ToAddresses![0]!, text: command.input.Content!.Simple!.Body!.Text!.Data! }); } });
    await deliver.sendManualRecovery({ email: 'new@example.test', oldEmail: 'old@example.test', token: 'a'.repeat(43), caseId: 'case', signal: message().signal });
    assert.equal(rows[0]!.email, 'old@example.test');
    assert.ok(!rows[0]!.text.includes('token='));
    assert.equal(rows[1]!.email, 'new@example.test');
    assert.ok(rows[1]!.text.includes('/account/restore-access?token=' + 'a'.repeat(43)));
    deliver.close();
    let calls = 0;
    const failing = createSesSender({ ...base, region: 'us-east-1', from: 'operator@example.test', transport: async () => { calls++; throw new Error('Unavailable'); } });
    await assert.rejects(failing.sendManualRecovery({ email: 'new@example.test', oldEmail: 'old@example.test', token: 'a'.repeat(43), caseId: 'case', signal: message().signal }));
    assert.equal(calls, 1);
    failing.close();
});
