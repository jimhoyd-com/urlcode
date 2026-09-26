import test from 'node:test';
import assert from 'node:assert/strict';
import { TOTP } from 'otpauth';
import { outbox } from './support/outbox.ts';
import type { AuthServiceInternal as AuthService } from '../src/auth-core.ts';
import { sessionReference } from '../src/auth-core.ts';
import { createAuthService, key, roles, password, setup } from './support/auth-core.ts';

test('keyring rotation migrates encrypted records, rejects stale writers and permits retired-key removal', async (t) => {
    const { service, options, now } = await setup(t), user = await service.register({ email: 'rotation@example.com', password });
    const totp = await service.beginTotp(user.token);
    await service.putFlow({ id: 'rotation-flow', kind: 'oidc', data: { verifier: 'sensitive' }, expires: now() + 60000 });
    const nextKey = Buffer.alloc(32, 9), rotating = await createAuthService({ ...options, encryptionKeys: { legacy: key, next: nextKey }, activeEncryptionKey: 'next' });
    try {
        await assert.rejects(service.beginTotp(user.token), { code: 'stale_encryption_key' });
        await assert.rejects(createAuthService(options), { code: 'auth_store_unavailable' });
        assert.deepEqual(await rotating.rotateEncryptionKey(), { changed: 2, remaining: 0 });
    }
    finally {
        await rotating.close();
        await service.close();
    }
    const reopened = await createAuthService({ ...options, encryptionKeys: { next: nextKey }, activeEncryptionKey: 'next' });
    try {
        assert.deepEqual(await reopened.consumeFlow('rotation-flow', 'oidc'), { verifier: 'sensitive' });
        const recovery = await reopened.confirmTotp({ token: user.token, code: new TOTP({ secret: totp.secret }).generate({ timestamp: now() }) });
        assert.equal(recovery.recoveryCodes.length, 10);
    }
    finally {
        await reopened.close();
    }
});
test('configuration migration needs an exact pin, preserves accounts and invalidates old workers and authentication state', async (t) => {
    const { service, options, now } = await setup(t, { registrationMode: 'off' }), admin = await service.bootstrapAdmin({ email: 'migration-owner@example.com', password });
    await service.linkExternal({ sessionReference: sessionReference(admin.token),  provider: 'oidc', subject: 'migration' });
    const proof = (await service.getExternalProof('oidc', 'migration'))!.proof, reset = (await service.issueToken({ email: admin.user.email, purpose: 'reset-password' })).token!;
    await service.putFlow({ id: 'migration-flow', kind: 'oidc', data: { nonce: 'synthetic' }, expires: now() + 60000 });
    const oldRevision = await service.getConfigurationRevision();
    assert.match(oldRevision, /^[a-f0-9]{64}$/);
    await assert.rejects(createAuthService({ ...options, registrationMode: 'open' }), { code: 'auth_configuration_changed' });
    await assert.rejects(createAuthService({ ...options, registrationMode: 'open', approveConfigurationChangeFrom: '0'.repeat(64) }), { code: 'configuration_approval_mismatch' });
    await assert.rejects(createAuthService({ ...options, registrationMode: 'open', approveConfigurationChangeFrom: oldRevision, encryptionKey: Buffer.alloc(32, 99) }), { code: 'auth_configuration_changed' });
    assert.equal(await service.getConfigurationRevision(), oldRevision);
    assert.ok(await service.authenticate(admin.token));
    const migrationOptions = { ...options, registrationMode: 'open' as const, approveConfigurationChangeFrom: oldRevision };
    const migrated = await createAuthService(migrationOptions);
    let newRevision: string;
    try {
        newRevision = await migrated.getConfigurationRevision();
        assert.notEqual(newRevision, oldRevision);
        assert.equal((await migrated.getUser(admin.user.id))?.email, admin.user.email);
        assert.equal(await migrated.authenticate(admin.token), null);
        await assert.rejects(service.getUser(admin.user.id), { code: 'stale_auth_configuration' });
        await assert.rejects(service.authenticate(admin.token), { code: 'stale_auth_configuration' });
        await assert.rejects(service.revokeSessions(admin.user.id), { code: 'stale_auth_configuration' });
        await assert.rejects(migrated.issueSession(admin.user.id, { method: 'oidc', proof }), { code: 'stale_auth_proof' });
        await assert.rejects(migrated.resetPassword({ token: reset, password: password + ' new' }), { code: 'invalid_token' });
        assert.equal(await migrated.consumeFlow('migration-flow', 'oidc'), null);
        const signed = await migrated.login({ email: admin.user.email, password });
        assert.equal(signed.user.id, admin.user.id);
        const repeated = await createAuthService(migrationOptions);
        try {
            assert.equal(await repeated.getConfigurationRevision(), newRevision);
            assert.ok(await repeated.authenticate(signed.token));
        }
        finally {
            await repeated.close();
        }
        await assert.rejects(createAuthService({ ...migrationOptions, approveConfigurationChangeFrom: 'f'.repeat(64) }), { code: 'configuration_approval_mismatch' });
        await migrated.register({ email: 'now-open@example.com', password });
        assert.equal((await outbox(migrated, { action: 'configuration.changed' })).length, 1);
    }
    finally {
        await migrated.close();
    }
    const reopened = await createAuthService({ ...options, registrationMode: 'open' });
    try {
        assert.equal(await reopened.getConfigurationRevision(), newRevision!);
    }
    finally {
        await reopened.close();
    }
});
test('configuration migration refuses missing assigned roles and loss of active administration without partial changes', async (t) => {
    const { service, options } = await setup(t), admin = await service.bootstrapAdmin({ email: 'migration-roles@example.com', password }), user = await service.register({ email: 'assigned-role@example.com', password });
    await service.adminSetRoles({ actorToken: admin.token, accountId: user.user.id, roles: ['editor'] });
    const revision = await service.getConfigurationRevision();
    const withoutEditor = { user: roles.user, manager: roles.manager, admin: roles.admin };
    await assert.rejects(createAuthService({ ...options, roles: withoutEditor, approveConfigurationChangeFrom: revision }), { code: 'configuration_roles_invalid' });
    await assert.rejects(createAuthService({ ...options, roles: { ...roles, admin: ['content.read'] }, approveConfigurationChangeFrom: revision }), { code: 'configuration_admin_required' });
    assert.equal(await service.getConfigurationRevision(), revision);
    assert.ok(await service.authenticate(admin.token));
    assert.deepEqual((await service.getUser(user.user.id))?.roles, ['editor']);
    assert.equal((await outbox(service, { action: 'configuration.changed' })).length, 0);
});
test('migration clears pending waitlist approvals but retains deletion cancellation without extending its lifetime', async (t) => {
    const { service, options, advance } = await setup(t, { registrationMode: 'waitlist', deletionGraceMs: 86400000 }), admin = await service.bootstrapAdmin({ email: 'migration-pending@example.com', password });
    await service.requestRegistration({ email: 'waitlisted@example.com', password });
    const first = await service.adminCreateUser({ actorToken: admin.token, email: 'cancel-preserved@example.com', reason: 'test setup' }), second = await service.adminCreateUser({ actorToken: admin.token, email: 'cancel-expiry@example.com', reason: 'test setup' });
    await service.resetPassword({ token: first.setupToken, password });
    await service.resetPassword({ token: second.setupToken, password });
    const firstLogin = await service.login({ email: first.user.email, password }), secondLogin = await service.login({ email: second.user.email, password });
    const cancellation = await service.deleteAccount({ token: firstLogin.token, password }), expiring = await service.deleteAccount({ token: secondLogin.token, password });
    const revision = await service.getConfigurationRevision();
    advance(1000);
    const migrated = await createAuthService({ ...options, registrationMode: 'open', requireMfa: true, approveConfigurationChangeFrom: revision });
    try {
        assert.equal((await migrated.listRegistrationRequests()).requests.length, 0);
        await migrated.cancelDeletion(cancellation.cancelToken);
        assert.equal((await migrated.getUser(first.user.id))?.status, 'active');
        assert.equal(await migrated.authenticate(firstLogin.token), null);
        assert.deepEqual((await migrated.login({ email: first.user.email, password })).principal.restrictions, ['enroll-mfa']);
        const event = (await outbox(migrated, { action: 'configuration.changed' }))[0]!;
        const summary = event.metadata as { from: string; revoked: Record<string, number>; preservedCancellationTokens: number };
        assert.equal(summary.revoked.auth_waitlist, 1);
        assert.equal(summary.preservedCancellationTokens, 2);
        advance(86399001);
        await assert.rejects(migrated.cancelDeletion(expiring.cancelToken), { code: 'invalid_token' });
        assert.deepEqual(await migrated.purgeDeleted(), { purged: 1 });
    }
    finally {
        await migrated.close();
    }
});
test('configuration revision chains prevent old workers and approvals reviving when declarations return to an earlier value', async (t) => {
    const { service, options } = await setup(t), user = await service.register({ email: 'revision-cycle@example.com', password }), first = await service.getConfigurationRevision();
    const off = await createAuthService({ ...options, registrationMode: 'off', approveConfigurationChangeFrom: first });
    let returned: AuthService | undefined;
    try {
        const second = await off.getConfigurationRevision();
        returned = await createAuthService({ ...options, approveConfigurationChangeFrom: second });
        const third = await returned.getConfigurationRevision();
        assert.notEqual(third, first);
        assert.notEqual(third, second);
        await assert.rejects(service.getUser(user.user.id), { code: 'stale_auth_configuration' });
        await assert.rejects(off.getUser(user.user.id), { code: 'stale_auth_configuration' });
        await assert.rejects(createAuthService({ ...options, registrationMode: 'off', approveConfigurationChangeFrom: first }), { code: 'configuration_approval_mismatch' });
        assert.equal((await returned.login({ email: user.user.email, password })).user.id, user.user.id);
    }
    finally {
        await returned?.close();
        await off.close();
    }
});
test('competing configuration migrations cannot both spend the same prior revision approval', async (t) => {
    const { service, options } = await setup(t), user = await service.register({ email: 'migration-race@example.com', password }), revision = await service.getConfigurationRevision();
    const outcomes = await Promise.allSettled([createAuthService({ ...options, registrationMode: 'off', approveConfigurationChangeFrom: revision }), createAuthService({ ...options, registrationMode: 'waitlist', approveConfigurationChangeFrom: revision })]);
    const winners = outcomes.filter((result): result is PromiseFulfilledResult<AuthService> => result.status === 'fulfilled');
    try {
        assert.equal(winners.length, 1);
        assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
        assert.equal((await winners[0]!.value.getUser(user.user.id))?.email, user.user.email);
        assert.equal((await outbox(winners[0]!.value, { action: 'configuration.changed' })).length, 1);
    }
    finally {
        await Promise.all(winners.map(result => result.value.close()));
    }
});
test('session limits and operator deployment tags require explicit configuration migration', async (t) => {
    const { service, options } = await setup(t), user = await service.register({ email: 'limits-migration@example.com', password });
    let active = service;
    const opened: AuthService[] = [];
    let configuration = { ...options };
    try {
        for (const change of [{ sessionIdleMs: 60000 }, { sessionTtlMs: 3600000 }, { configurationTag: 'provider-policy-v2' }]) {
            configuration = { ...configuration, ...change };
            const revision = await active.getConfigurationRevision();
            await assert.rejects(createAuthService(configuration), { code: 'auth_configuration_changed' });
            const next = await createAuthService({ ...configuration, approveConfigurationChangeFrom: revision });
            opened.push(next);
            await assert.rejects(active.getUser(user.user.id), { code: 'stale_auth_configuration' });
            assert.notEqual(await next.getConfigurationRevision(), revision);
            assert.equal(await next.authenticate(user.token), null);
            assert.equal((await next.getUser(user.user.id))?.email, user.user.email);
            active = next;
        }
        for (const configurationTag of ['', 'x'.repeat(129), 'invalid\nvalue']) {
            await assert.rejects(createAuthService({ ...configuration, configurationTag }), { code: 'invalid_configuration_tag' });
        }
    }
    finally {
        await Promise.all(opened.map(instance => instance.close()));
    }
});
