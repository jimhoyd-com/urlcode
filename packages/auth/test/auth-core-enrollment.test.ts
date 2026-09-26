import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { TOTP } from 'otpauth';
import { outbox } from './support/outbox.ts';
import { createAuthService, password, setup } from './support/auth-core.ts';

test('invite-only registration binds single-use invites to email and enforces operator domain restrictions', async (t) => {
    const { service } = await setup(t, { registrationMode: 'invite-only', allowedEmailDomains: ['example.com'], blockedEmailDomains: ['blocked.example.com'] });
    const admin = await service.bootstrapAdmin({ email: 'owner@example.com', password });
    await assert.rejects(service.register({ email: 'invited@example.com', password }), { code: 'registration_unavailable' });
    const invite = await service.invite({ actorToken: admin.token, email: 'invited@example.com' });
    await assert.rejects(service.register({ email: 'different@example.com', password, invitationToken: invite.token }), { code: 'registration_unavailable' });
    const user = await service.register({ email: 'invited@example.com', password, invitationToken: invite.token });
    assert.deepEqual(user.user.roles, ['user']);
    await assert.rejects(service.invite({ actorToken: admin.token, email: 'x@other.example' }), { code: 'registration_unavailable' });
    await assert.rejects(service.register({ email: 'invited@example.com', password, invitationToken: invite.token }), { code: 'registration_unavailable' });
});
test('waitlist approval needs fresh administrative authority and creates an ordinary account without issuing a session', async (t) => {
    const { service } = await setup(t, { registrationMode: 'waitlist' }), admin = await service.bootstrapAdmin({ email: 'owner@example.com', password });
    await assert.rejects(service.register({ email: 'waiting@example.com', password }), { code: 'registration_unavailable' });
    const request = await service.requestRegistration({ email: 'waiting@example.com', password });
    assert.equal((await service.listRegistrationRequests()).requests[0]?.id, request.id);
    await assert.rejects(service.login({ email: 'waiting@example.com', password }), { code: 'invalid_credentials' });
    const approved = await service.approveRegistration({ actorToken: admin.token, requestId: request.id, reason: 'approved applicant' });
    assert.deepEqual(approved.roles, ['user']);
    assert.equal((await service.listSessions(approved.id)).length, 0);
    assert.equal((await service.login({ email: 'waiting@example.com', password })).user.id, approved.id);
    assert.equal((await service.listRegistrationRequests()).requests.length, 0);
});
test('profile and terms validation persist registration data without allowing private metadata or authority injection', async (t) => {
    const { createRegistrationPolicy } = await import('../src/registration.ts');
    const registrationPolicy = createRegistrationPolicy({ termsVersion: '2026-09', metadata: { nickname: { type: 'string', scope: 'public' }, internalNote: { type: 'string', scope: 'private', default: 'operator-only' } } });
    const { service } = await setup(t, { registrationPolicy });
    await assert.rejects(service.register({ email: 'terms@example.com', password }), { code: 'invalid_registration_profile' });
    const user = await service.register({ email: 'terms@example.com', password, profile: { termsAccepted: true, displayName: 'Synthetic name', metadata: { nickname: 'test' } } });
    assert.equal(user.user.profile?.terms?.version, '2026-09');
    assert.equal(user.user.profile?.metadata.internalNote, undefined);
    await assert.rejects(service.updateProfile({ token: user.token, profile: { metadata: { internalNote: 'overwritten' } } }), { code: 'invalid_registration_profile' });
    const updated = await service.updateProfile({ token: user.token, profile: { displayName: 'Changed' } });
    assert.equal(updated.displayName, 'Changed');
    assert.equal((await service.getProfile(user.token)).metadata.nickname, 'test');
    assert.deepEqual((await service.authenticate(user.token))?.roles, ['user']);
});
test('exact email allow/block policy is normalized and applied to every enrollment path', async (t) => {
    const { service } = await setup(t, { allowedEmails: ['Allowed@EXAMPLE.com', 'blocked@example.com'], blockedEmails: ['BLOCKED@example.com'] });
    await assert.rejects(service.register({ email: 'other@example.com', password }), { code: 'registration_unavailable' });
    await assert.rejects(service.createExternalAccount({ email: 'blocked@example.com', provider: 'oidc', subject: 'blocked', emailVerified: true }), { code: 'registration_unavailable' });
    assert.equal((await service.register({ email: 'allowed@example.com', password })).user.email, 'allowed@example.com');
});
test('mandatory enrollment restricts bootstrap and application authority until mailbox and TOTP requirements are met', async (t) => {
    const { service, now } = await setup(t, { requireEmailVerification: true, requireMfa: true }), admin = await service.bootstrapAdmin({ email: 'restricted-owner@example.com', password }), user = await service.register({ email: 'restricted-user@example.com', password });
    assert.deepEqual(admin.principal.restrictions, ['verify-email', 'enroll-mfa']);
    assert.deepEqual(admin.principal.roles, []);
    assert.deepEqual(admin.principal.permissions, []);
    await assert.rejects(service.adminSetStatus({ actorToken: admin.token, accountId: user.user.id, status: 'locked' }), { code: 'enrollment_required' });
    await assert.rejects(service.beginTotp(admin.token), { code: 'enrollment_required' });
    const verification = (await service.issueToken({ email: admin.user.email, purpose: 'verify-email' })).token!;
    await service.consumeVerification(verification, admin.token);
    const renewed = await service.login({ email: admin.user.email, password });
    assert.deepEqual(renewed.principal.restrictions, ['enroll-mfa']);
    const setupTotp = await service.beginTotp(renewed.token);
    await service.confirmTotp({ token: renewed.token, code: new TOTP({ secret: setupTotp.secret }).generate({ timestamp: now() }) });
    const cleared = await service.authenticate(renewed.token);
    assert.equal(cleared?.restrictions, undefined);
    assert.deepEqual(cleared?.permissions, ['*']);
    assert.equal(await service.authenticate(admin.token), null);
    await service.adminSetStatus({ actorToken: renewed.token, accountId: user.user.id, status: 'locked' });
    assert.equal((await service.getUser(user.user.id))?.status, 'locked');
});
test('OIDC, human email codes and passkey proofs cannot bypass mandatory TOTP enrollment', async (t) => {
    const { service, now, advance } = await setup(t, { requireEmailVerification: true, requireMfa: true });
    const external = await service.createExternalAccount({ email: 'enrollment-oidc@example.com', provider: 'oidc', subject: 'mandatory', emailVerified: true });
    const oidc = await service.issueSession(external.id, { method: 'oidc', proof: (await service.getExternalProof('oidc', 'mandatory'))!.proof });
    assert.deepEqual(oidc.principal.restrictions, ['enroll-mfa']);
    assert.deepEqual(oidc.principal.permissions, []);
    const code = await service.issueEmailCode({ email: external.email });
    const email = await service.consumeEmailCode({ flowId: code.flowId, code: code.code! });
    assert.deepEqual(email.principal.restrictions, ['enroll-mfa']);
    const setupTotp = await service.beginTotp(email.token), otp = new TOTP({ secret: setupTotp.secret });
    await service.confirmTotp({ token: email.token, code: otp.generate({ timestamp: now() }) });
    await service.addPasskey({ actorToken: email.token, credential: { id: 'enrolled-key', publicKey: 'public-key', counter: 0 } });
    advance(30000);
    await service.disableTotp({ token: email.token, password: '', code: otp.generate({ timestamp: now() }) });
    const passkey = await service.issueSession(external.id, { method: 'passkey', proof: { ...(await service.getPasskey('enrolled-key'))!.proof, newCounter: 1 } });
    assert.deepEqual(passkey.principal.restrictions, ['enroll-mfa']);
    assert.deepEqual(passkey.principal.roles, []);
    await assert.rejects(service.exportAccount(passkey.token), { code: 'enrollment_required' });
});
test('mandatory mailbox verification revokes every preverification session instead of promoting old sessions', async (t) => {
    const { service } = await setup(t, { requireEmailVerification: true }), user = await service.register({ email: 'mailbox-required@example.com', password }), second = await service.login({ email: user.user.email, password });
    assert.deepEqual(user.principal.restrictions, ['verify-email']);
    assert.deepEqual(second.principal.permissions, []);
    const verification = (await service.issueToken({ email: user.user.email, purpose: 'verify-email' })).token!;
    await service.consumeVerification(verification, user.token);
    assert.equal(await service.authenticate(user.token), null);
    assert.equal(await service.authenticate(second.token), null);
    const fresh = await service.login({ email: user.user.email, password });
    assert.equal(fresh.principal.restrictions, undefined);
    assert.deepEqual(fresh.principal.permissions, ['content.read']);
});
test('numeric mailbox proof creates only a new proved session under mandatory verification', async (t) => {
    const { service } = await setup(t, { requireEmailVerification: true }), user = await service.register({ email: 'code-verification@example.com', password });
    const code = await service.issueEmailCode({ email: user.user.email });
    const proved = await service.consumeEmailCode({ flowId: code.flowId, code: code.code! });
    assert.equal(proved.principal.restrictions, undefined);
    assert.equal(await service.authenticate(user.token), null);
    assert.ok(await service.authenticate(proved.token));
});
test('verified-first signup persists browser-bound steps and never hashes credentials before mailbox proof', async (t) => {
    let checked = 0;
    const { service, options, database, advance } = await setup(t, { requireEmailVerification: true, checkPassword: async () => { checked++; } });
    const browserHash = 'a'.repeat(64), begin = await service.beginSignup({ email: 'wizard@example.com', browserHash });
    const binding = { flowId: begin.flowId, browserHash };
    assert.equal(begin.step, 'verify-email');
    assert.equal(begin.delivery?.kind, 'signup-code');
    assert.equal((await service.listUsers({})).users.length, 0);
    await assert.rejects(service.setSignupPassword({ ...binding, password }), { code: 'invalid_signup_flow' });
    await assert.rejects(service.setSignupPasskeyChallenge({ ...binding, challenge: 'x'.repeat(43) }), { code: 'invalid_signup_flow' });
    assert.equal(checked, 0);
    assert.equal(await service.getSignup({ ...binding, browserHash: 'b'.repeat(64) }), null);
    await assert.rejects(service.verifySignup({ ...binding, browserHash: 'b'.repeat(64), code: begin.delivery!.kind === 'signup-code' ? begin.delivery!.code : '' }), { code: 'invalid_signup_code' });
    const code = begin.delivery!.kind === 'signup-code' ? begin.delivery!.code : '';
    assert.equal((await service.verifySignup({ ...binding, code })).step, 'credential');
    await assert.rejects(service.verifySignup({ ...binding, code }), { code: 'invalid_signup_code' });
    await service.close();
    const resumed = await createAuthService(options);
    try {
        assert.equal((await resumed.getSignup(binding))?.step, 'credential');
        assert.equal((await resumed.setSignupPassword({ ...binding, password })).step, 'profile');
        assert.equal(checked, 1);
        await assert.rejects(resumed.setSignupPassword({ ...binding, password }), { code: 'invalid_signup_flow' });
        const result = await resumed.completeSignup(binding);
        assert.ok(result);
        assert.equal(result.user.id, begin.accountId);
        assert.equal(result.user.emailVerified, true);
        assert.equal((await resumed.authenticate(result.token))?.id, begin.accountId);
        await assert.rejects(resumed.completeSignup(binding), { code: 'invalid_signup_flow' });
        const db = new DatabaseSync(database, { readOnly: true });
        try {
            assert.equal(db.prepare('SELECT count(*) AS n FROM auth_signups').get()?.n, 0);
        }
        finally {
            db.close();
        }
        const expiring = await resumed.beginSignup({ email: 'expiry-signup@example.com', browserHash });
        advance(1800001);
        assert.equal(await resumed.getSignup({ flowId: expiring.flowId, browserHash }), null);
    }
    finally {
        await resumed.close();
    }
});
test('signup code failures persist a five-attempt ceiling and identifier responses stay uniform', async (t) => {
    const { service, advance } = await setup(t, { requireEmailVerification: true, blockedEmails: ['blocked-signup@example.com'] });
    const browserHash = 'c'.repeat(64);
    const prior = await service.register({ email: 'existing-signup@example.com', password });
    const existing = await service.beginSignup({ email: prior.user.email, browserHash });
    const blocked = await service.beginSignup({ email: 'blocked-signup@example.com', browserHash });
    const start = await service.beginSignup({ email: 'new-signup@example.com', browserHash });
    assert.equal(existing.step, start.step);
    assert.equal(blocked.step, start.step);
    assert.equal(existing.delivery?.kind, 'registration-attempt');
    assert.equal(blocked.delivery, undefined);
    const binding = { flowId: start.flowId, browserHash }, code = start.delivery!.kind === 'signup-code' ? start.delivery!.code : '';
    const wrong = code === '000000' ? '111111' : '000000';
    for (let n = 0; n < 5; n++)
        await assert.rejects(service.verifySignup({ ...binding, code: wrong }), { code: 'invalid_signup_code' });
    await assert.rejects(service.verifySignup({ ...binding, code }), { code: 'invalid_signup_code' });
    for (let n = 0; n < 9; n++)
        await service.beginSignup({ email: 'new-signup@example.com', browserHash });
    await assert.rejects(service.beginSignup({ email: 'new-signup@example.com', browserHash }), { code: 'authentication_rate_limited' });
    advance(900001);
    const expired = await service.beginSignup({ email: 'code-expiry@example.com', browserHash });
    advance(600001);
    await assert.rejects(service.verifySignup({ flowId: expired.flowId, browserHash, code: expired.delivery!.kind === 'signup-code' ? expired.delivery!.code : '' }), { code: 'invalid_signup_code' });
    assert.ok(await service.authenticate(prior.token));
});
test('signup completion validates profile consent, creates passkey atomically and refuses stale challenges or duplicate races', async (t) => {
    const { createRegistrationPolicy } = await import('../src/registration.ts');
    const { service } = await setup(t, { registrationPolicy: createRegistrationPolicy({ termsVersion: 'v1' }) });
    const browserHash = 'd'.repeat(64), begin = await service.beginSignup({ email: 'passkey-signup@example.com', browserHash }), binding = { flowId: begin.flowId, browserHash };
    assert.equal(begin.step, 'credential');
    const challenge = 'a'.repeat(43), credential = { id: 'signup-credential', publicKey: 'synthetic-public-key', counter: 0 };
    await service.setSignupPasskeyChallenge({ ...binding, challenge });
    assert.equal((await service.getSignupPasskeyChallenge(binding)).state.accountId, begin.accountId);
    await assert.rejects(service.setSignupPasskey({ ...binding, challenge: 'b'.repeat(43), credential }), { code: 'invalid_signup_flow' });
    await service.setSignupPasskey({ ...binding, challenge, credential });
    await assert.rejects(service.completeSignup(binding));
    assert.equal(await service.getPasskey(credential.id), null);
    const registered = await service.completeSignup({ ...binding, profile: { termsAccepted: true } });
    assert.equal(registered?.user.id, begin.accountId);
    assert.equal((await service.getPasskey(credential.id))?.accountId, begin.accountId);
    const first = await service.beginSignup({ email: 'race-signup@example.com', browserHash }), second = await service.beginSignup({ email: 'race-signup@example.com', browserHash });
    await service.setSignupPassword({ flowId: first.flowId, browserHash, password });
    await service.setSignupPassword({ flowId: second.flowId, browserHash, password: 'different synthetic password123' });
    const outcomes = await Promise.all([first, second].map(flow => service.completeSignup({ flowId: flow.flowId, browserHash, profile: { termsAccepted: true } })));
    assert.equal(outcomes.filter(Boolean).length, 1);
    assert.equal(outcomes.filter(value => value === null).length, 1);
    const duplicate = await service.beginSignup({ email: registered!.user.email, browserHash });
    await service.setSignupPassword({ flowId: duplicate.flowId, browserHash, password });
    assert.equal(await service.completeSignup({ flowId: duplicate.flowId, browserHash, profile: { termsAccepted: true } }), null);
    assert.equal((await service.getPasskey(credential.id))?.accountId, begin.accountId);
});
test('signup invitation is email-bound and consumed only by successful atomic finalization', async (t) => {
    const { service } = await setup(t, { registrationMode: 'invite-only' });
    const admin = await service.bootstrapAdmin({ email: 'signup-invite-admin@example.com', password });
    const { token: invitationToken } = await service.invite({ actorToken: admin.token, email: 'signup-invited@example.com' });
    const browserHash = 'e'.repeat(64);
    const wrong = await service.beginSignup({ email: 'signup-wrong@example.com', browserHash, invitationToken });
    await service.setSignupPassword({ flowId: wrong.flowId, browserHash, password });
    assert.equal(await service.completeSignup({ flowId: wrong.flowId, browserHash }), null);
    const start = await service.beginSignup({ email: 'signup-invited@example.com', browserHash, invitationToken });
    await service.setSignupPassword({ flowId: start.flowId, browserHash, password });
    assert.equal((await service.completeSignup({ flowId: start.flowId, browserHash }))?.user.email, 'signup-invited@example.com');
    await assert.rejects(service.register({ email: 'signup-invited@example.com', password, invitationToken }), { code: 'registration_unavailable' });
});
test('verified signup waitlist preserves mailbox proof and pending passkey until atomic approval', async (t) => {
    const { service } = await setup(t, { registrationMode: 'waitlist', requireEmailVerification: true });
    const admin = await service.bootstrapAdmin({ email: 'waitlist-proof-admin@example.com', password });
    const verification = (await service.issueToken({ email: admin.user.email, purpose: 'verify-email' })).token!;
    await service.consumeVerification(verification, admin.token);
    const signed = await service.login({ email: admin.user.email, password });
    const browserHash = 'f'.repeat(64), start = await service.beginSignup({ email: 'verified-waitlist@example.com', browserHash }), binding = { flowId: start.flowId, browserHash };
    const code = start.delivery!.kind === 'signup-code' ? start.delivery!.code : '';
    await service.verifySignup({ ...binding, code });
    const challenge = 'q'.repeat(43), credential = { id: 'waitlist-passkey', publicKey: 'synthetic-public', counter: 0 };
    await service.setSignupPasskeyChallenge({ ...binding, challenge });
    await service.setSignupPasskey({ ...binding, challenge, credential });
    assert.equal(await service.completeSignup(binding), null);
    assert.equal(await service.getUser(start.accountId), null);
    assert.equal(await service.getPasskey(credential.id), null);
    assert.equal((await service.listRegistrationRequests()).requests[0]?.id, start.accountId);
    const approved = await service.approveRegistration({ actorToken: signed.token, requestId: start.accountId });
    assert.equal(approved.emailVerified, true);
    assert.equal((await service.getPasskey(credential.id))?.accountId, approved.id);
    assert.equal((await service.listSessions(approved.id)).length, 0);
});
test('signup flows are bounded-cleaned and revoked by explicit configuration migration', async (t) => {
    const { service, options, advance, database } = await setup(t);
    const browserHash = '1'.repeat(64), expiring = await service.beginSignup({ email: 'cleanup-signup@example.com', browserHash });
    advance(1800001);
    await service.cleanup({ limit: 100 });
    const db = new DatabaseSync(database, { readOnly: true });
    try {
        assert.equal(db.prepare('SELECT count(*) AS n FROM auth_signups').get()?.n, 0);
    }
    finally {
        db.close();
    }
    assert.equal(await service.getSignup({ flowId: expiring.flowId, browserHash }), null);
    const active = await service.beginSignup({ email: 'migration-signup@example.com', browserHash });
    const revised = await createAuthService({ ...options, requireEmailVerification: true, approveConfigurationChangeFrom: await service.getConfigurationRevision() });
    try {
        assert.equal(await revised.getSignup({ flowId: active.flowId, browserHash }), null);
        const event = (await outbox(revised, { action: 'configuration.changed' }))[0]!;
        assert.equal((event.metadata as { revoked: Record<string, number> }).revoked.auth_signups, 1);
    }
    finally {
        await revised.close();
    }
});
