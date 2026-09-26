import test from 'node:test';
import assert from 'node:assert/strict';
import { TOTP } from 'otpauth';
import { createAuthService, password, setup, verifyOwnMailbox } from './support/auth-core.ts';

test('email-code authentication is atomic single use and cannot bypass enabled TOTP', async (t) => {
    const { service, now } = await setup(t), user = await service.register({ email: 'emailcode@example.com', password });
    await verifyOwnMailbox(service, user.user.email, user.token);
    const code = await service.issueEmailCode({ email: user.user.email });
    const outcomes = await Promise.allSettled([service.consumeEmailCode({ flowId: code.flowId, code: code.code! }), service.consumeEmailCode({ flowId: code.flowId, code: code.code! })]);
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    const setupTotp = await service.beginTotp(user.token);
    const recovery = await service.confirmTotp({ token: user.token, code: new TOTP({ secret: setupTotp.secret }).generate({ timestamp: now() }) });
    const withMfa = await service.issueEmailCode({ email: user.user.email });
    await assert.rejects(service.consumeEmailCode({ flowId: withMfa.flowId, code: withMfa.code! }), { code: 'invalid_credentials' });
    assert.equal((await service.consumeEmailCode({ flowId: withMfa.flowId, code: withMfa.code!, recoveryCode: recovery.recoveryCodes[0]! })).principal.id, user.user.id);
});
test('human email codes expire, count failed attempts durably and are consumed atomically', async (t) => {
    const { service, advance, options } = await setup(t), user = await service.register({ email: 'numeric@example.com', password });
    const issued = await service.issueEmailCode({ email: user.user.email });
    assert.match(issued.flowId, /^[A-Za-z0-9_-]{43}$/);
    assert.match(issued.code!, /^\d{6}$/);
    const wrong = issued.code === '000000' ? '000001' : '000000';
    for (let n = 0; n < 5; n++)
        await assert.rejects(service.consumeEmailCode({ flowId: issued.flowId, code: wrong }), { code: 'invalid_code' });
    await service.close();
    const reopened = await createAuthService(options);
    try {
        await assert.rejects(reopened.consumeEmailCode({ flowId: issued.flowId, code: issued.code! }), { code: 'invalid_code' });
        const next = await reopened.issueEmailCode({ email: user.user.email });
        const outcomes = await Promise.allSettled([reopened.consumeEmailCode({ flowId: next.flowId, code: next.code! }), reopened.consumeEmailCode({ flowId: next.flowId, code: next.code! })]);
        assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
        const expired = await reopened.issueEmailCode({ email: user.user.email });
        advance(600001);
        await assert.rejects(reopened.consumeEmailCode({ flowId: expired.flowId, code: expired.code! }), { code: 'invalid_code' });
        const absent = await reopened.issueEmailCode({ email: 'absent@example.com' });
        assert.match(absent.flowId, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(absent.code, null);
    }
    finally {
        await reopened.close();
    }
});
test('email sign-in codes and signup codes are capped by a long-window per-account budget (#462)', async (t) => {
    const { service, advance } = await setup(t), user = await service.register({ email: 'daily-code-cap@example.com', password });
    // The short per-window budget (10/15min) alone does not bound how many codes one account can
    // accumulate over a day; issuing in batches separated by more than the short window shows the
    // long-window (24h) cap still applies once the short window has reset twice (20 issued total).
    for (let batch = 0; batch < 2; batch++) {
        for (let index = 0; index < 10; index++)
            assert.match((await service.issueEmailCode({ email: user.user.email })).flowId, /^[A-Za-z0-9_-]{43}$/);
        advance(900001);
    }
    await assert.rejects(service.issueEmailCode({ email: user.user.email }), { code: 'authentication_rate_limited' });
    // Signup codes have their own independent daily budget.
    const browserHash = 'f'.repeat(64);
    for (let batch = 0; batch < 2; batch++) {
        for (let index = 0; index < 10; index++)
            await service.beginSignup({ email: 'daily-signup-cap@example.com', browserHash });
        advance(900001);
    }
    await assert.rejects(service.beginSignup({ email: 'daily-signup-cap@example.com', browserHash }), { code: 'authentication_rate_limited' });
});
test('a single client cannot alone exhaust or repeatedly cancel another account\'s sign-in codes (#548)', async (t) => {
    const { service } = await setup(t), user = await service.register({ email: 'code-target@example.com', password });
    // The per-email daily budget (#462) is shared across every caller, so one client could
    // otherwise spend most or all of it alone against a victim's address — and since issuing a
    // fresh code invalidates whichever one was still in flight (see the store's `issueEmailCode`),
    // even a handful of calls from that one client can keep cancelling the victim's own pending
    // code. A trusted client now also gets its own, tighter per-email budget, so it alone cannot
    // reach the shared ceiling.
    for (let index = 0; index < 5; index++)
        assert.match((await service.issueEmailCode({ email: user.user.email, client: '203.0.113.9' })).flowId, /^[A-Za-z0-9_-]{43}$/);
    await assert.rejects(service.issueEmailCode({ email: user.user.email, client: '203.0.113.9' }), { code: 'authentication_rate_limited' });
    // A different client's budget for the same address is unaffected.
    assert.match((await service.issueEmailCode({ email: user.user.email, client: '198.51.100.4' })).flowId, /^[A-Za-z0-9_-]{43}$/);
    // An untrusted/absent client still falls back to the pre-existing per-email budget alone.
    assert.match((await service.issueEmailCode({ email: user.user.email })).flowId, /^[A-Za-z0-9_-]{43}$/);
});
test('email changes retain the old login during cooldown, allow cancellation and commit once with stable identity', async (t) => {
    const { service, advance } = await setup(t, { sessionTtlMs: 172800000 }), user = await service.register({ email: 'old@example.com', password });
    const cancelled = await service.requestEmailChange({ token: user.token, email: 'new@example.com', password });
    assert.equal((await service.getUser(user.user.id))?.email, 'old@example.com');
    await assert.rejects(service.requestEmailChange({ token: user.token, email: 'other@example.com', password }), { code: 'email_change_pending' });
    await assert.rejects(service.confirmEmailChange(cancelled.verificationToken), { code: 'email_change_cooldown' });
    await service.cancelEmailChange(cancelled.cancelToken);
    await assert.rejects(service.confirmEmailChange(cancelled.verificationToken), { code: 'invalid_token' });
    const pending = await service.requestEmailChange({ token: user.token, email: 'new@example.com', password });
    advance(86400001);
    const changed = await service.confirmEmailChange(pending.verificationToken);
    assert.equal(changed.id, user.user.id);
    assert.equal(changed.email, 'new@example.com');
    assert.equal(changed.emailVerified, true);
    assert.equal(await service.authenticate(user.token), null);
    await assert.rejects(service.cancelEmailChange(pending.cancelToken), { code: 'invalid_token' });
    assert.equal((await service.login({ email: 'new@example.com', password })).user.id, user.user.id);
});
test('email-change availability is not revealed before the second factor is consumed (#465)', async (t) => {
    const { service, now } = await setup(t), user = await service.register({ email: 'factor-gate@example.com', password });
    await service.createExternalAccount({ email: 'taken-target@example.com', provider: 'oidc', subject: 'holder', emailVerified: true });
    const enrolled = await service.beginTotp(user.token), otp = new TOTP({ secret: enrolled.secret });
    await service.confirmTotp({ token: user.token, code: otp.generate({ timestamp: now() }) });
    const wrong = otp.generate({ timestamp: now() }) === '000000' ? '000001' : '000000';
    // A wrong second factor is rejected before the requested email's availability is checked, so
    // it never confirms or denies that 'taken-target@example.com' already has an account.
    await assert.rejects(service.requestEmailChange({ token: user.token, email: 'taken-target@example.com', password, totp: wrong }), { code: 'invalid_credentials' });
    await assert.rejects(service.requestEmailChange({ token: user.token, email: 'unused-target@example.com', password, totp: wrong }), { code: 'invalid_credentials' });
});
test('email-change confirmation rejects concurrent ownership and intervening credential changes', async (t) => {
    const { service, advance } = await setup(t, { sessionTtlMs: 172800000 }), first = await service.register({ email: 'first@example.com', password }), second = await service.register({ email: 'second@example.com', password });
    const one = await service.requestEmailChange({ token: first.token, email: 'contested@example.com', password }), two = await service.requestEmailChange({ token: second.token, email: 'contested@example.com', password });
    advance(86400001);
    const raced = await Promise.allSettled([service.confirmEmailChange(one.verificationToken), service.confirmEmailChange(two.verificationToken)]);
    assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
    const fresh = await service.login({ email: 'contested@example.com', password });
    const pending = await service.requestEmailChange({ token: fresh.token, email: 'invalidated@example.com', password });
    await service.changePassword({ token: fresh.token, currentPassword: password, password: password + ' new' });
    advance(86400001);
    await assert.rejects(service.confirmEmailChange(pending.verificationToken), { code: 'account_changed' });
});
