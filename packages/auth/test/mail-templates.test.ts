// Auth's contributed mail: a notice (and every admin-* notice) declares only page-link slots, which mail refuses to
// carry a query or fragment in, so no credential can ride in one; every template renders with its own slot set.
import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authMail } from '../src/mail-templates.ts';
import { tokenPaths } from '../src/delivery.ts';
import { companions } from './support/companions.ts';

const origin = 'https://example.test';
const notices = ['new-device', 'password-changed', 'email-changed', 'registration-attempt', 'manual-recovery-warning'];
const credentials = ['verify-email', 'reset-password', 'cancel-deletion', 'verify-email-change', 'cancel-email-change', 'invitation', 'account-setup', 'manual-recovery', 'sign-in-code', 'factor-recovery'];

test('notices and every admin-* notice take page links only; only credential-bearing templates take a token link', () => {
    assert.equal(authMail.namespace, 'auth');
    for (const [key, template] of Object.entries(authMail.templates)) {
        const kinds = Object.values(template.slots as Record<string, string>);
        if (notices.includes(key) || key.startsWith('admin-') || key === 'impersonation-started' || key === 'signup-code')
            assert.ok(!kinds.includes('token-link'), `${key} must not carry a token link`);
        else
            assert.ok(credentials.includes(key), `${key} is neither a notice nor a known credential delivery`);
        if (key.startsWith('admin-'))
            assert.deepEqual(template.slots, { link: 'page-link' }, key);
    }
    // Every token template auth delivers has a page to land on.
    for (const key of Object.keys(tokenPaths))
        assert.equal((authMail.templates as Record<string, { slots: Record<string, string> }>)[key]!.slots.link, 'token-link', key);
});

test('every template renders through mail with its slot set, and a page link refuses a credential', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-mail-templates-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const { mail, sent } = await companions(t, root, 'a'.repeat(64), origin);
    const value = (kind: string) => kind === 'page-link' ? origin + '/account/account' : kind === 'token-link' ? origin + '/account/reset?token=' + 'a'.repeat(43) : kind === 'code' ? '123456' : 'Support investigation';
    for (const [key, template] of Object.entries(authMail.templates)) {
        const values = Object.fromEntries(Object.entries(template.slots as Record<string, string>).map(([slot, kind]) => [slot, value(kind)]));
        await mail.send({ template: 'auth.' + key, to: 'reader@example.test', values });
        const envelope = sent.at(-1)!;
        assert.equal(envelope.template, 'auth.' + key);
        assert.equal(envelope.subject, template.subject);
        for (const rendered of Object.values(values))
            assert.ok(envelope.text.includes(rendered), `${key} renders ${rendered}`);
    }
    // A notice's page link cannot carry a token.
    await assert.rejects(mail.send({ template: 'auth.new-device', to: 'reader@example.test', values: { link: origin + '/account/reset?token=' + 'a'.repeat(43) } }), { code: 'invalid-values' });
    await assert.rejects(mail.send({ template: 'auth.admin-verify-email', to: 'reader@example.test', values: { link: origin + '/account/account#token' } }), { code: 'invalid-values' });
});
