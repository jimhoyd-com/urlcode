import { cleanup } from './cleanup.ts';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { TOTP } from 'otpauth';
import { createAuthService, normalizeEmail, sessionReference, hashWaitBudgetMs } from '../src/auth-core.ts';
import type { AuthOptions, AuthService } from '../src/auth-core.ts';
const key = Buffer.alloc(32, 7), roles = { user: ['content.read'], editor: ['content.read', 'content.write'], manager: ['content.read', 'auth.users.manage', 'auth.sessions.manage'], admin: ['*'] }, password = 'synthetic password phrase 123';
async function setup(t: TestContext, extra: Partial<AuthOptions> = {}) { const directory = await mkdtemp(join(tmpdir(), 'urlcode-auth-')), database = join(directory, 'auth.sqlite'); let timestamp = 1800000000000; const options = { database, encryptionKey: key, roles, defaultRole: 'user', now: () => timestamp, ...extra }; const service = await createAuthService(options); cleanup(t, async () => { await service.close(); await rm(directory, { recursive: true, force: true }); }); return { service, options, database, advance: (ms: number) => { timestamp += ms; }, now: () => timestamp }; }
/** The registrant verifies in its own signed-in browser, so its methods are kept. */
async function verifyOwnMailbox(service: AuthService, email: string, sessionToken: string) { await service.consumeVerification((await service.issueToken({ email, purpose: 'verify-email' })).token!, sessionToken); }
test('password accounts, unique normalization, opaque sessions and durable restart', async (t) => {
    const { service, options, database } = await setup(t), registered = await service.register({ email: ' Alice@EXAMPLE.com ', password });
    assert.equal(registered.user.email, 'alice@example.com');
    assert.deepEqual(registered.user.roles, ['user']);
    assert.equal((await service.authenticate(registered.token))?.id, registered.user.id);
    assert.equal(await service.authenticate('invalid'), null);
    // No enumeration signal (JSON-API.md): a duplicate-email registration succeeds in shape
    // (same status a caller would get for a new account) but authenticates nothing — the
    // account is untouched and no second account exists.
    const duplicate = await service.register({ email: 'alice@example.com', password });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.user.email, 'alice@example.com');
    assert.equal(await service.authenticate(duplicate.token), null);
    assert.equal((await service.login({ email: 'alice@example.com', password })).user.id, registered.user.id);
    await assert.rejects(service.login({ email: 'alice@example.com', password: 'incorrect phrase' }), { code: 'invalid_credentials' });
    await assert.rejects(service.login({ email: 'unknown@example.com', password }), { code: 'invalid_credentials' });
    const signed = await service.login({ email: 'alice@example.com', password });
    assert.notEqual(signed.token, registered.token);
    await service.logout(signed.token);
    assert.equal(await service.authenticate(signed.token), null);
    await service.close();
    const reopened = await createAuthService(options);
    try {
        assert.equal((await reopened.authenticate(registered.token))?.email, 'alice@example.com');
        await reopened.revokeSessions(registered.user.id);
        assert.equal(await reopened.authenticate(registered.token), null);
    }
    finally {
        await reopened.close();
    }
    assert.equal((await readFile(database)).includes(Buffer.from(password)), false);
});
test('verification and password-reset tokens are scoped, atomic single-use and revoke sessions without bypassing factors', async (t) => {
    const { service } = await setup(t), user = await service.register({ email: 'test@example.com', password });
    const verification = (await service.issueToken({ email: user.user.email, purpose: 'verify-email' })).token!;
    const results = await Promise.allSettled([service.consumeVerification(verification), service.consumeVerification(verification)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await service.getUser(user.user.id))?.emailVerified, true);
    const reset = (await service.issueToken({ email: user.user.email, purpose: 'reset-password' })).token!;
    await assert.rejects(service.consumeVerification(reset), { code: 'invalid_token' });
    await service.resetPassword({ token: reset, password: password + ' new' });
    assert.equal(await service.authenticate(user.token), null);
    await assert.rejects(service.resetPassword({ token: reset, password }), { code: 'invalid_token' });
    assert.equal((await service.login({ email: user.user.email, password: password + ' new' })).user.id, user.user.id);
    assert.equal((await service.issueToken({ email: 'unknown@example.com', purpose: 'reset-password' })).token, null);
});
test('TOTP secrets are encrypted, codes cannot replay and recovery codes are single-use', async (t) => {
    const { service, database, advance, now } = await setup(t), user = await service.register({ email: 'mfa@example.com', password });
    await verifyOwnMailbox(service, user.user.email, user.token);
    const setupTotp = await service.beginTotp(user.token), otp = new TOTP({ secret: setupTotp.secret });
    const codes = await service.confirmTotp({ token: user.token, code: otp.generate({ timestamp: now() }) });
    assert.equal(codes.recoveryCodes.length, 10);
    await assert.rejects(service.login({ email: user.user.email, password }), { code: 'invalid_credentials' });
    advance(30000);
    const current = otp.generate({ timestamp: now() });
    await service.login({ email: user.user.email, password, totp: current });
    await assert.rejects(service.login({ email: user.user.email, password, totp: current }), { code: 'invalid_credentials' });
    await service.login({ email: user.user.email, password, recoveryCode: codes.recoveryCodes[0]! });
    await assert.rejects(service.login({ email: user.user.email, password, recoveryCode: codes.recoveryCodes[0]! }), { code: 'invalid_credentials' });
    const reset = (await service.issueToken({ email: user.user.email, purpose: 'reset-password' })).token!;
    await service.resetPassword({ token: reset, password: password + ' changed' });
    await assert.rejects(service.login({ email: user.user.email, password: password + ' changed' }), { code: 'invalid_credentials' });
    await service.close();
    const bytes = await readFile(database);
    assert.equal(bytes.includes(Buffer.from(setupTotp.secret)), false);
    assert.equal(bytes.includes(Buffer.from(codes.recoveryCodes[0]!)), false);
});
test('administrative mutations are fresh, audited, forbid self escalation and enforce delegation ceilings', async (t) => {
    const { service, advance } = await setup(t), admin = await service.bootstrapAdmin({ email: 'admin@example.com', password }), ordinary = await service.register({ email: 'user@example.com', password });
    await assert.rejects(service.bootstrapAdmin({ email: 'other-admin@example.com', password }), { code: 'bootstrap_unavailable' });
    await assert.rejects(service.adminSetRoles({ actorToken: ordinary.token, accountId: ordinary.user.id, roles: ['admin'] }), { code: 'permission_denied' });
    await assert.rejects(service.adminSetRoles({ actorToken: admin.token, accountId: admin.user.id, roles: ['user'] }), { code: 'self_administration_denied' });
    await service.adminSetRoles({ actorToken: admin.token, accountId: ordinary.user.id, roles: ['manager'], reason: 'delegate support' });
    assert.equal(await service.authenticate(ordinary.token), null);
    const manager = await service.login({ email: ordinary.user.email, password });
    await assert.rejects(service.adminSetStatus({ actorToken: manager.token, accountId: admin.user.id, status: 'locked' }), { code: 'delegation_ceiling_exceeded' });
    const other = await service.register({ email: 'other@example.com', password });
    await assert.rejects(service.adminSetRoles({ actorToken: manager.token, accountId: other.user.id, roles: ['admin'] }), { code: 'delegation_ceiling_exceeded' });
    await service.adminRevokeSessions({ actorToken: admin.token, accountId: other.user.id, reason: 'security event' });
    assert.equal(await service.authenticate(other.token), null);
    assert.ok((await service.listAudit()).events.some(event => event.reason === 'security event'));
    advance(300001);
    await assert.rejects(service.adminSetStatus({ actorToken: admin.token, accountId: other.user.id, status: 'locked' }), { code: 'fresh_authentication_required' });
    const refreshed = await service.stepUp({ token: admin.token, password });
    assert.equal(await service.authenticate(admin.token), null);
    await service.adminSetStatus({ actorToken: refreshed.token, accountId: other.user.id, status: 'locked' });
    await assert.rejects(service.login({ email: other.user.email, password }), { code: 'invalid_credentials' });
});
test('authentication resource bounds, expiration, pagination and configuration identity fail closed', async (t) => {
    const { service, options, advance } = await setup(t);
    await assert.rejects(service.register({ email: 'x@example.com', password: 'short' }), { code: 'password_length_invalid' });
    await assert.rejects(service.listUsers({ limit: 101 }), { code: 'invalid_page' });
    const user = await service.register({ email: 'expire@example.com', password });
    advance(86400001);
    assert.equal(await service.authenticate(user.token), null);
    await service.close();
    await assert.rejects(createAuthService({ ...options, encryptionKey: Buffer.alloc(32, 8) }), { code: 'auth_configuration_changed' });
    assert.equal(normalizeEmail('A+tag@EXAMPLE.com'), 'a+tag@example.com');
});
test('a browser-binding check can peek a flow without spending it (#465)', async (t) => {
    const { service, now } = await setup(t);
    await service.putFlow({ id: 'peek-flow', kind: 'oidc', data: { verifier: 'synthetic-verifier', browserHash: 'right-browser' }, expires: now() + 60000 });
    // A caller (an HTTP handler checking browser binding before spending the flow) can read the
    // flow's data without consuming it: a request replayed from the wrong browser is rejected by
    // the caller's own binding check without burning the flow the right browser still needs.
    assert.deepEqual(await service.peekFlow('peek-flow', 'oidc'), { verifier: 'synthetic-verifier', browserHash: 'right-browser' });
    assert.deepEqual(await service.peekFlow('peek-flow', 'oidc'), { verifier: 'synthetic-verifier', browserHash: 'right-browser' });
    assert.deepEqual(await service.consumeFlow('peek-flow', 'oidc'), { verifier: 'synthetic-verifier', browserHash: 'right-browser' });
    assert.equal(await service.consumeFlow('peek-flow', 'oidc'), null);
    assert.equal(await service.peekFlow('peek-flow', 'oidc'), null);
});
test('encrypted flows are expiring and single-use, identities never auto-link and passkey counters compare atomically', async (t) => {
    const { service, now, advance } = await setup(t);
    await service.putFlow({ id: 'flow-1', kind: 'oidc', data: { verifier: 'synthetic-verifier', browserHash: 'binding' }, expires: now() + 60000 });
    const results = await Promise.all([service.consumeFlow('flow-1', 'oidc'), service.consumeFlow('flow-1', 'oidc')]);
    assert.equal(results.filter(Boolean).length, 1);
    await service.putFlow({ id: 'flow-2', kind: 'oidc', data: {}, expires: now() + 1000 });
    advance(1001);
    assert.equal(await service.consumeFlow('flow-2', 'oidc'), null);
    const user = await service.register({ email: 'link@example.com', password });
    await assert.rejects(service.createExternalAccount({ email: user.user.email, provider: 'google', subject: 'sub-1', emailVerified: true }), { code: 'explicit_identity_link_required' });
    await service.linkExternal({ sessionReference: sessionReference(user.token), provider: 'google', subject: 'sub-1' });
    assert.equal((await service.findExternal('google', 'sub-1'))?.id, user.user.id);
    const external = await service.createExternalAccount({ email: 'external@example.com', provider: 'google', subject: 'sub-2', emailVerified: true });
    await assert.rejects(service.login({ email: external.email, password }), { code: 'invalid_credentials' });
    assert.equal((await service.issueSession(external.id, { method: 'oidc', proof: (await service.getExternalProof('google', 'sub-2'))!.proof })).principal.id, external.id);
});
test('account lifecycle exports no credentials, changes passwords with revocation and protects the last admin on deletion', async (t) => {
    const { service, advance } = await setup(t), admin = await service.bootstrapAdmin({ email: 'owner@example.com', password }), user = await service.register({ email: 'lifecycle@example.com', password });
    const exported = await service.exportAccount(user.token);
    assert.equal(exported.user.id, user.user.id);
    assert.equal(JSON.stringify(exported).includes('passwordHash'), false);
    await assert.rejects(service.deleteAccount({ token: admin.token, password }), { code: 'last_administrator_required' });
    await assert.rejects(service.changePassword({ token: user.token, currentPassword: 'incorrect', password: password + ' new' }), { code: 'invalid_credentials' });
    await service.changePassword({ token: user.token, currentPassword: password, password: password + ' new' });
    assert.equal(await service.authenticate(user.token), null);
    const changed = await service.login({ email: user.user.email, password: password + ' new' });
    const scheduled = await service.deleteAccount({ token: changed.token, password: password + ' new' });
    assert.equal((await service.getUser(user.user.id))?.status, 'pending-delete');
    assert.deepEqual(await service.purgeDeleted(), { purged: 0 });
    await service.cancelDeletion(scheduled.cancelToken);
    await assert.rejects(service.cancelDeletion(scheduled.cancelToken), { code: 'invalid_token' });
    const restored = await service.login({ email: user.user.email, password: password + ' new' });
    await service.deleteAccount({ token: restored.token, password: password + ' new' });
    advance(604800001);
    assert.deepEqual(await service.purgeDeleted(), { purged: 1 });
    assert.equal(await service.getUser(user.user.id), null);
    assert.equal(await service.authenticate(changed.token), null);
    assert.ok((await service.listAudit()).events.some(e => e.action === 'account.deleted'));
});
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
test('bounded admin overview filters and global session pages agree with account state', async (t) => {
    const { service } = await setup(t), admin = await service.bootstrapAdmin({ email: 'owner@example.com', password }), user = await service.register({ email: 'searchable@example.com', password });
    assert.equal((await service.listUsers({ query: 'searchable', role: 'user', status: 'active' })).users[0]?.id, user.user.id);
    assert.equal((await service.listUsers({ query: 'missing' })).users.length, 0);
    assert.equal((await service.dashboard()).users, 2);
    assert.equal((await service.listAllSessions({ limit: 1 })).sessions.length, 1);
    await service.adminSetStatus({ actorToken: admin.token, accountId: user.user.id, status: 'locked' });
    assert.equal((await service.dashboard()).locked, 1);
    assert.equal((await service.dashboard()).sessions, 1);
});
test('generic hash import is atomic, bounded and upgrades bcrypt and PBKDF2 on successful authentication', async (t) => {
    const { service, database } = await setup(t);
    const { hash } = await import('bcryptjs');
    const { pbkdf2Sync } = await import('node:crypto');
    const legacy = 'legacy-short', bcrypt = await hash(legacy, 10), salt = Buffer.alloc(16, 4), pb = 'pbkdf2-sha256$600000$' + salt.toString('base64url') + '$' + pbkdf2Sync(password, salt, 600000, 32, 'sha256').toString('base64url');
    await assert.rejects(service.importUsers([{ email: 'same@example.com', passwordHash: bcrypt }, { email: 'SAME@example.com', passwordHash: pb }]), { code: 'import_collision' });
    assert.equal((await service.listUsers()).users.length, 0);
    assert.deepEqual(await service.importUsers([{ email: 'bcrypt@example.com', passwordHash: bcrypt }, { email: 'pbkdf@example.com', passwordHash: pb }]), { imported: 2 });
    await assert.rejects(service.importUsers([{ email: 'bad@example.com', passwordHash: '$2b$31$' + '.'.repeat(53) }]), { code: 'invalid_import' });
    await service.login({ email: 'bcrypt@example.com', password: legacy });
    await service.login({ email: 'pbkdf@example.com', password });
    await service.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(database);
    try {
        for (const row of db.prepare('SELECT data FROM auth_accounts').all())
            assert.ok(JSON.parse(String(row.data)).passwordHash.startsWith('scrypt-v1$'));
    }
    finally {
        db.close();
    }
});
test('recovery cases require distinct current administrators and pin the target version', async (t) => {
    const { service, now } = await setup(t), admin = await service.bootstrapAdmin({ email: 'maker@example.com', password }), second = await service.register({ email: 'approver@example.com', password }), target = await service.register({ email: 'case-target@example.com', password });
    await service.adminSetRoles({ actorToken: admin.token, accountId: second.user.id, roles: ['admin'] });
    const approver = await service.login({ email: second.user.email, password });
    const totp = await service.beginTotp(target.token);
    await service.confirmTotp({ token: target.token, code: new TOTP({ secret: totp.secret }).generate({ timestamp: now() }) });
    const item = await service.createCase({ actorToken: admin.token, accountId: target.user.id, action: 'reset-factors', reason: 'verified recovery evidence' });
    await assert.rejects(service.approveCase({ actorToken: admin.token, caseId: item.id, reason: 'self approval' }), { code: 'distinct_approver_required' });
    await assert.rejects(service.approveCase({ actorToken: target.token, caseId: item.id, reason: 'target approval' }), { code: 'permission_denied' });
    const applied = await service.approveCase({ actorToken: approver.token, caseId: item.id, reason: 'independently verified' });
    assert.equal(applied.status, 'applied');
    assert.equal((await service.getUser(target.user.id))?.totpEnabled, false);
    assert.equal(await service.authenticate(target.token), null);
    assert.equal((await service.login({ email: target.user.email, password })).user.id, target.user.id);
    await assert.rejects(service.approveCase({ actorToken: approver.token, caseId: item.id, reason: 'replay' }), { code: 'case_unavailable' });
    const stale = await service.createCase({ actorToken: admin.token, accountId: target.user.id, action: 'lock', reason: 'review' });
    await service.adminSetRoles({ actorToken: admin.token, accountId: target.user.id, roles: ['editor'] });
    await assert.rejects(service.approveCase({ actorToken: approver.token, caseId: stale.id, reason: 'reviewed' }), { code: 'case_target_changed' });
});
test('impersonation is opt-in, marked, expiring, denied privileged targets and incapable of credential or admin mutation', async (t) => {
    const { service, advance } = await setup(t, { allowImpersonation: true }), admin = await service.bootstrapAdmin({ email: 'impersonator@example.com', password }), target = await service.register({ email: 'subject@example.com', password });
    await assert.rejects(service.createImpersonation({ actorToken: admin.token, accountId: admin.user.id, reason: 'self' }), { code: 'impersonation_denied' });
    const issued = await service.createImpersonation({ actorToken: admin.token, accountId: target.user.id, reason: 'support request' });
    assert.equal(issued.principal.impersonatorId, admin.user.id);
    assert.equal(issued.principal.authenticatedAt, 0);
    assert.deepEqual(issued.principal.permissions, ['content.read']);
    await assert.rejects(service.stepUp({ token: issued.token, password }), { code: 'impersonation_restricted' });
    await assert.rejects(service.beginTotp(issued.token), { code: 'impersonation_restricted' });
    await assert.rejects(service.exportAccount(issued.token), { code: 'impersonation_restricted' });
    await assert.rejects(service.adminSetRoles({ actorToken: issued.token, accountId: admin.user.id, roles: ['user'] }), { code: 'impersonation_restricted' });
    advance(600001);
    assert.equal(await service.authenticate(issued.token), null);
    const fresh = await service.stepUp({ token: admin.token, password }), again = await service.createImpersonation({ actorToken: fresh.token, accountId: target.user.id, reason: 'followup' });
    await service.adminSetRoles({ actorToken: fresh.token, accountId: target.user.id, roles: ['admin'] });
    assert.equal(await service.authenticate(again.token), null);
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
test('administrative account setup, credential-free export and single-session revocation are scoped and audited', async (t) => {
    const { service } = await setup(t), admin = await service.bootstrapAdmin({ email: 'owner@example.com', password });
    const created = await service.adminCreateUser({ actorToken: admin.token, email: 'created@example.com', reason: 'requested account' });
    assert.equal(created.user.emailVerified, false);
    assert.deepEqual(created.user.roles, ['user']);
    await assert.rejects(service.login({ email: created.user.email, password }), { code: 'invalid_credentials' });
    await service.resetPassword({ token: created.setupToken, password });
    const user = await service.login({ email: created.user.email, password }), other = await service.login({ email: created.user.email, password });
    await assert.rejects(service.revokeSession({ token: user.token, sessionId: admin.principal.sessionId }), { code: 'permission_denied' });
    await service.revokeSession({ token: user.token, sessionId: other.principal.sessionId });
    assert.equal(await service.authenticate(other.token), null);
    const exported = await service.adminExport({ actorToken: admin.token, accountId: user.user.id, reason: 'user request' });
    assert.equal(JSON.stringify(exported).includes('passwordHash'), false);
    await service.adminRevokeSession({ actorToken: admin.token, sessionId: user.principal.sessionId, reason: 'security request' });
    assert.equal(await service.authenticate(user.token), null);
    assert.ok((await service.listAudit()).events.some(e => e.action === 'admin.account_exported'));
});
test('idle sessions expire despite absolute lifetime and real activity refreshes bounded last-seen metadata', async (t) => {
    const { service, advance } = await setup(t, { sessionIdleMs: 60000 }), user = await service.register({ email: 'idle@example.com', password, device: { id: Buffer.alloc(32, 1).toString('base64url'), label: 'Synthetic browser' } });
    assert.equal(user.newDevice, true);
    advance(30000);
    assert.ok(await service.authenticate(user.token));
    advance(40000);
    assert.ok(await service.authenticate(user.token));
    advance(60001);
    assert.equal(await service.authenticate(user.token), null);
    const again = await service.login({ email: user.user.email, password, device: { id: Buffer.alloc(32, 1).toString('base64url'), label: 'Synthetic browser' } });
    assert.equal(again.newDevice, undefined);
    assert.equal((await service.listSessions(user.user.id))[0]?.deviceLabel, 'Synthetic browser');
    const other = await service.login({ email: user.user.email, password, device: { id: Buffer.alloc(32, 2).toString('base64url'), label: 'Other browser' } });
    assert.equal(other.newDevice, true);
    await assert.rejects(service.login({ email: user.user.email, password, device: { id: 'bad' } }), { code: 'invalid_device' });
});
test('trusted proof step-up rotates passwordless sessions and sign-in removal preserves a usable method', async (t) => {
    const { service } = await setup(t), user = await service.createExternalAccount({ email: 'passwordless@example.com', provider: 'oidc', subject: 'subject', emailVerified: true }), session = await service.issueSession(user.id, { method: 'oidc', proof: (await service.getExternalProof('oidc', 'subject'))!.proof });
    await assert.rejects(service.unlinkExternal({ token: session.token, provider: 'oidc', subject: 'subject' }), { code: 'last_sign_in_method' });
    await service.addPasskey({ actorToken: session.token, credential: { id: 'only-passkey', publicKey: 'synthetic-key', counter: 0 } });
    const stepped = await service.completeStepUp({ token: session.token, accountId: user.id, method: 'passkey', proof: { ...(await service.getPasskey('only-passkey'))!.proof, newCounter: 0 } });
    assert.equal(await service.authenticate(session.token), null);
    await service.unlinkExternal({ token: stepped.token, provider: 'oidc', subject: 'subject' });
    await assert.rejects(service.removePasskey({ token: stepped.token, credentialId: 'only-passkey' }), { code: 'last_sign_in_method' });
    await assert.rejects(service.completeStepUp({ token: stepped.token, accountId: 'other', method: 'passkey', proof: { ...(await service.getPasskey('only-passkey'))!.proof, newCounter: 0 } }), { code: 'step_up_denied' });
});
test('audit retention is configurable and pruning is observable, not silent (#467)', async (t) => {
    const pruned: number[] = [];
    const { service } = await setup(t, { auditRetention: 5, onAuditPruned: removed => { pruned.push(removed); } });
    const admin = await service.bootstrapAdmin({ email: 'retention-owner@example.com', password });
    for (let index = 0; index < 8; index++)
        await service.register({ email: `retention-${index}@example.com`, password });
    // The worker thread posts a plain-data message for each prune (a function cannot cross
    // workerData's structured clone), so give it a turn to arrive before asserting.
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(pruned.length > 0, 'onAuditPruned fired at least once once the 5-row cap was exceeded');
    assert.ok(pruned.every(count => count > 0));
    const remaining = await service.listAudit({ limit: 50 });
    assert.ok(remaining.events.length <= 5, 'only the newest rows are retained past the configured cap');
    assert.equal(admin.user.email, 'retention-owner@example.com');
});
test('case notes and closure are fresh, bounded, audited and cleanup has a global row budget', async (t) => {
    const { service, advance, now } = await setup(t), admin = await service.bootstrapAdmin({ email: 'case-owner@example.com', password }), user = await service.register({ email: 'case-user@example.com', password });
    const item = await service.createCase({ actorToken: admin.token, accountId: user.user.id, action: 'lock', reason: 'investigation' });
    const noted = await service.addCaseNote({ actorToken: admin.token, caseId: item.id, note: 'Reviewed submitted evidence' });
    assert.equal(noted.notes?.length, 1);
    const closed = await service.closeCase({ actorToken: admin.token, caseId: item.id, reason: 'No action required' });
    assert.equal(closed.status, 'closed');
    await assert.rejects(service.addCaseNote({ actorToken: admin.token, caseId: item.id, note: 'late note' }), { code: 'case_unavailable' });
    for (let index = 0; index < 3; index++)
        await service.putFlow({ id: 'cleanup-' + index, kind: 'test', data: {}, expires: now() + 1 });
    advance(2);
    assert.equal((await service.cleanup({ limit: 2 })).removed, 2);
    assert.equal((await service.cleanup({ limit: 2 })).removed, 1);
});
test('exact email allow/block policy is normalized and applied to every enrollment path', async (t) => {
    const { service } = await setup(t, { allowedEmails: ['Allowed@EXAMPLE.com', 'blocked@example.com'], blockedEmails: ['BLOCKED@example.com'] });
    await assert.rejects(service.register({ email: 'other@example.com', password }), { code: 'registration_unavailable' });
    await assert.rejects(service.createExternalAccount({ email: 'blocked@example.com', provider: 'oidc', subject: 'blocked', emailVerified: true }), { code: 'registration_unavailable' });
    assert.equal((await service.register({ email: 'allowed@example.com', password })).user.email, 'allowed@example.com');
});
test('operator password checks run before new hashes, reject without leaking callback errors and do not block existing sign-in', async (t) => {
    let reject = true, calls = 0;
    const { service } = await setup(t, { checkPassword: async (value) => {
            calls++;
            if (reject)
                throw new Error('sensitive ' + value);
        } });
    await assert.rejects(service.register({ email: 'policy@example.com', password }), { code: 'password_not_allowed', message: 'password_not_allowed' });
    reject = false;
    const user = await service.register({ email: 'policy@example.com', password });
    reject = true;
    await service.login({ email: user.user.email, password });
    const before = calls;
    await assert.rejects(service.changePassword({ token: user.token, currentPassword: password, password: password + ' new' }), { code: 'password_not_allowed' });
    assert.equal(calls, before + 1);
    assert.ok(await service.authenticate(user.token));
});
test('password-hash queue wait budget defaults to 2s and can only be raised, within a cap (#506)', () => {
    assert.equal(hashWaitBudgetMs({}), 2000);
    assert.equal(hashWaitBudgetMs({ URLCODE_AUTH_HASH_WAIT_MS: '10000' }), 10000);
    assert.equal(hashWaitBudgetMs({ URLCODE_AUTH_HASH_WAIT_MS: '10' }), 2000);
    assert.equal(hashWaitBudgetMs({ URLCODE_AUTH_HASH_WAIT_MS: '999999' }), 30000);
    assert.equal(hashWaitBudgetMs({ URLCODE_AUTH_HASH_WAIT_MS: 'abc' }), 2000);
    assert.equal(hashWaitBudgetMs({ URLCODE_AUTH_HASH_WAIT_MS: '-5' }), 2000);
});
test('password hashing queues briefly under contention instead of refusing every caller past two (#464)', async (t) => {
    const { service } = await setup(t), altPassword = 'a different synthetic passphrase 1';
    await service.register({ email: 'busy-a@example.com', password });
    await service.register({ email: 'busy-b@example.com', password: altPassword });
    // Only two password derivations run concurrently process-wide; without a bounded wait queue,
    // every caller beyond the first two used to fail immediately with password_hash_busy instead
    // of waiting briefly for a slot.
    const attempts = Array.from({ length: 6 }, (_, index) => service.login({ email: index % 2 ? 'busy-a@example.com' : 'busy-b@example.com', password: index % 2 ? password : altPassword, client: '198.51.100.' + (index + 1) }));
    const results = await Promise.allSettled(attempts);
    assert.deepEqual(results.map(r => r.status), Array(6).fill('fulfilled'));
});
test('post-commit lifecycle hooks are bounded, credential-free and cannot roll back accounts', async (t) => {
    const release: (() => void)[] = [], events: {
        type: string;
        accountId: string;
    }[] = [];
    const { service } = await setup(t, { onLifecycle: async (event) => { events.push(event); await new Promise<void>(resolve => release.push(resolve)); } });
    try {
        for (let index = 0; index < 6; index++)
            await service.createExternalAccount({ email: 'hook' + index + '@example.com', provider: 'oidc', subject: String(index), emailVerified: true });
        assert.equal((await service.listUsers()).users.length, 6);
        assert.equal(service.getHookStats().accepted, 4);
        assert.equal(service.getHookStats().dropped, 2);
        assert.equal(events.length, 4);
        assert.deepEqual(Object.keys(events[0]!).sort(), ['accountId', 'type']);
    }
    finally {
        for (const finish of release)
            finish();
        await new Promise<void>(resolve => setImmediate(resolve));
    }
});
test('pending external proofs cannot survive factor reset, identity unlink or credential-version changes', async (t) => {
    const { service, now, advance } = await setup(t), user = await service.register({ email: 'stale-oidc@example.com', password });
    await service.linkExternal({ sessionReference: sessionReference(user.token),  provider: 'oidc', subject: 'bound' });
    const setupTotp = await service.beginTotp(user.token), otp = new TOTP({ secret: setupTotp.secret });
    await service.confirmTotp({ token: user.token, code: otp.generate({ timestamp: now() }) });
    const snapshot = (await service.getExternalProof('oidc', 'bound'))!;
    advance(30000);
    await service.disableTotp({ token: user.token, password, code: otp.generate({ timestamp: now() }) });
    await assert.rejects(service.issueSession(user.user.id, { method: 'oidc', proof: snapshot.proof }), { code: 'stale_auth_proof' });
    const linked = (await service.getExternalProof('oidc', 'bound'))!;
    await service.unlinkExternal({ token: user.token, provider: 'oidc', subject: 'bound' });
    await assert.rejects(service.issueSession(user.user.id, { method: 'oidc', proof: linked.proof }), { code: 'stale_auth_proof' });
});
test('passkey proof issuance atomically checks ownership, version and key while advancing counters once', async (t) => {
    const { service } = await setup(t), user = await service.register({ email: 'proof-key@example.com', password });
    await service.addPasskey({ actorToken: user.token, credential: { id: 'bound-key', publicKey: 'original-key', counter: 1 } });
    const proof = { ...(await service.getPasskey('bound-key'))!.proof, newCounter: 2 };
    const raced = await Promise.allSettled([service.issueSession(user.user.id, { method: 'passkey', proof }), service.issueSession(user.user.id, { method: 'passkey', proof })]);
    assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await service.getPasskey('bound-key'))?.credential.counter, 2);
    const removed = { ...(await service.getPasskey('bound-key'))!.proof, newCounter: 3 };
    await service.removePasskey({ token: user.token, credentialId: 'bound-key' });
    await service.addPasskey({ actorToken: user.token, credential: { id: 'bound-key', publicKey: 'replacement-key', counter: 2 } });
    await assert.rejects(service.issueSession(user.user.id, { method: 'passkey', proof: removed }), { code: 'stale_auth_proof' });
});
test('passkey step-up uses the durable MFA attempt budget and refuses mismatched account proofs', async (t) => {
    const { service, now } = await setup(t), user = await service.register({ email: 'step-proof@example.com', password });
    await service.addPasskey({ actorToken: user.token, credential: { id: 'step-key', publicKey: 'public-key', counter: 0 } });
    const setupTotp = await service.beginTotp(user.token), otp = new TOTP({ secret: setupTotp.secret });
    const current = otp.generate({ timestamp: now() });
    await service.confirmTotp({ token: user.token, code: current });
    const proof = { ...(await service.getPasskey('step-key'))!.proof, newCounter: 1 };
    const wrong = current === '000000' ? '000001' : '000000';
    for (let index = 0; index < 10; index++)
        await assert.rejects(service.completeStepUp({ token: user.token, accountId: user.user.id, method: 'passkey', proof, totp: wrong }), { code: 'invalid_credentials' });
    await assert.rejects(service.completeStepUp({ token: user.token, accountId: user.user.id, method: 'passkey', proof, totp: wrong }), { code: 'authentication_rate_limited' });
    assert.equal((await service.getPasskey('step-key'))?.credential.counter, 0);
});
test('failed password guesses cannot deny a different proof or a different client for the same account', async (t) => {
    const { service } = await setup(t), user = await service.register({ email: 'shared-budget@example.com', password });
    await service.addPasskey({ actorToken: user.token, credential: { id: 'budget-key', publicKey: 'public-key', counter: 0 } });
    // Exhaust the tight per-client password budget for one client (10/window): a third party who
    // knows the address, with no password, used to also deny passkey sign-in and sign-in from any
    // other client — the budgets are now namespaced per proof kind and scoped per client (#461).
    for (let index = 0; index < 10; index++)
        await assert.rejects(service.login({ email: 'shared-budget@example.com', password: 'wrong guess ' + index, client: '203.0.113.5' }), { code: 'invalid_credentials' });
    await assert.rejects(service.login({ email: 'shared-budget@example.com', password: 'wrong guess more', client: '203.0.113.5' }), { code: 'authentication_rate_limited' });
    // A different client is unaffected by the first client's exhausted budget.
    await assert.rejects(service.login({ email: 'shared-budget@example.com', password: 'still wrong', client: '198.51.100.9' }), { code: 'invalid_credentials' });
    // Passkey sign-in for the same account is on its own budget and still works.
    const proof = { ...(await service.getPasskey('budget-key'))!.proof, newCounter: 1 };
    const signed = await service.issueSession(user.user.id, { method: 'passkey', proof });
    assert.equal(signed.user.id, user.user.id);
});
test('addresses in one IPv6 /64 share a per-client password budget (#547)', async (t) => {
    const { service } = await setup(t), user = await service.register({ email: 'v6-budget@example.com', password });
    for (let index = 0; index < 10; index++)
        await assert.rejects(service.login({ email: user.user.email, password: 'wrong guess ' + index, client: '2001:db8:0:1::' + (index + 1).toString(16) }), { code: 'invalid_credentials' });
    await assert.rejects(service.login({ email: user.user.email, password: 'wrong guess more', client: '2001:db8:0:1:ffff::1' }), { code: 'authentication_rate_limited' });
    // Another /64 is a different client.
    await assert.rejects(service.login({ email: user.user.email, password: 'still wrong', client: '2001:db8:0:2::1' }), { code: 'invalid_credentials' });
});
test('abuse-policy client limits key an IPv6 /64 and an IPv4-mapped address as one client (#547)', async (t) => {
    const { service } = await setup(t, { abuse: { client: { limit: 1, windowMs: 60000 } } });
    await service.admitAuthRequest({ client: '2001:db8:0:1::1' });
    await assert.rejects(service.admitAuthRequest({ client: '2001:db8:0:1::2' }), { code: 'auth_rate_limited' });
    await service.admitAuthRequest({ client: '203.0.113.5' });
    await assert.rejects(service.admitAuthRequest({ client: '::ffff:203.0.113.5' }), { code: 'auth_rate_limited' });
});
test('a password reset clears the exhausted account-wide password budget (#546)', async (t) => {
    const { service } = await setup(t), user = await service.register({ email: 'locked-owner@example.com', password });
    await verifyOwnMailbox(service, user.user.email, user.token);
    // Many clients, each well inside its own budget, together exhaust the account-wide budget.
    for (let index = 0; index < 30; index++)
        await assert.rejects(service.login({ email: user.user.email, password: 'wrong guess ' + index, client: '198.51.100.' + (index + 1) }), { code: 'invalid_credentials' });
    await assert.rejects(service.login({ email: user.user.email, password, client: '203.0.113.7' }), { code: 'authentication_rate_limited' });
    const reset = (await service.issueToken({ email: user.user.email, purpose: 'reset-password' })).token!;
    await service.resetPassword({ token: reset, password: password + ' new' });
    // The owner signs in with the new password at once, not after the window expires.
    assert.equal((await service.login({ email: user.user.email, password: password + ' new', client: '203.0.113.7' })).user.id, user.user.id);
});
test('account-wide session revocation invalidates pending primary proof and administrator impersonation', async (t) => {
    const { service } = await setup(t, { allowImpersonation: true }), admin = await service.bootstrapAdmin({ email: 'revoke-admin@example.com', password }), target = await service.register({ email: 'revoke-target@example.com', password });
    await service.linkExternal({ sessionReference: sessionReference(target.token),  provider: 'oidc', subject: 'pending' });
    const snapshot = (await service.getExternalProof('oidc', 'pending'))!;
    await service.revokeSessions(target.user.id);
    await assert.rejects(service.issueSession(target.user.id, { method: 'oidc', proof: snapshot.proof }), { code: 'stale_auth_proof' });
    const impersonated = await service.createImpersonation({ actorToken: admin.token, accountId: target.user.id, reason: 'support' });
    await service.revokeSessions(admin.user.id);
    assert.equal(await service.authenticate(impersonated.token), null);
});
test('bounded deletion purge selects due accounts before applying its page limit', async (t) => {
    const { service, advance } = await setup(t), first = await service.register({ email: 'later-deletion@example.com', password }), second = await service.register({ email: 'earlier-deletion@example.com', password });
    await service.deleteAccount({ token: second.token, password });
    advance(86400000);
    const fresh = await service.login({ email: first.user.email, password });
    await service.deleteAccount({ token: fresh.token, password });
    advance(6 * 86400000 + 1);
    assert.deepEqual(await service.purgeDeleted({ limit: 1 }), { purged: 1 });
    assert.equal(await service.getUser(second.user.id), null);
    assert.equal((await service.getUser(first.user.id))?.status, 'pending-delete');
});
test('dashboard keeps exactly thirty UTC days of bounded method and outcome aggregates', async (t) => {
    const { service, advance } = await setup(t), user = await service.register({ email: 'metrics@example.com', password });
    await verifyOwnMailbox(service, user.user.email, user.token);
    await assert.rejects(service.login({ email: user.user.email, password: 'incorrect' }), { code: 'invalid_credentials' });
    await service.login({ email: user.user.email, password });
    const external = await service.createExternalAccount({ email: 'metrics-oidc@example.com', provider: 'oidc', subject: 'metrics', emailVerified: true });
    await service.issueSession(external.id, { method: 'oidc', proof: (await service.getExternalProof('oidc', 'metrics'))!.proof });
    const code = await service.issueEmailCode({ email: user.user.email });
    await service.consumeEmailCode({ flowId: code.flowId, code: code.code! });
    const first = await service.dashboard();
    assert.equal(first.daily.length, 30);
    const today = first.daily.at(-1)!;
    assert.equal(today.signUps, 2);
    assert.equal(today.signIns, 3);
    assert.equal(today.failedSignIns, 1);
    assert.deepEqual(today.methods.map(row => row.method), ['email-code', 'oidc', 'password']);
    assert.equal(today.methods.find(row => row.method === 'password')?.failedSignIns, 1);
    advance(86400000);
    await service.login({ email: user.user.email, password });
    const next = await service.dashboard();
    assert.equal(next.daily.at(-2)?.signIns, 3);
    assert.equal(next.daily.at(-1)?.signIns, 1);
    advance(30 * 86400000);
    await service.login({ email: user.user.email, password });
    const expired = await service.dashboard();
    assert.equal(expired.daily.reduce((sum, row) => sum + row.signIns, 0), 1);
    assert.equal(expired.daily.reduce((sum, row) => sum + row.signUps, 0), 0);
});
test('bulk administration validates every subject before mutation and audits each successful target', async (t) => {
    const { service } = await setup(t), admin = await service.bootstrapAdmin({ email: 'bulk-owner@example.com', password }), manager = await service.register({ email: 'bulk-manager@example.com', password }), one = await service.register({ email: 'bulk-one@example.com', password }), two = await service.register({ email: 'bulk-two@example.com', password });
    await service.adminSetRoles({ actorToken: admin.token, accountId: manager.user.id, roles: ['manager'] });
    const actor = await service.login({ email: manager.user.email, password });
    await assert.rejects(service.adminBulk({ actorToken: actor.token, accountIds: [one.user.id, admin.user.id], action: 'lock', reason: 'review' }), { code: 'delegation_ceiling_exceeded' });
    assert.equal((await service.getUser(one.user.id))?.status, 'active');
    assert.ok(await service.authenticate(one.token));
    assert.deepEqual(await service.adminBulk({ actorToken: actor.token, accountIds: [one.user.id, two.user.id], action: 'lock', reason: 'confirmed security action' }), { affected: 2 });
    assert.equal((await service.getUser(one.user.id))?.status, 'locked');
    assert.equal(await service.authenticate(two.token), null);
    assert.equal((await service.listAudit({ action: 'admin.bulk.lock' })).events.length, 2);
    await service.adminBulk({ actorToken: actor.token, accountIds: [one.user.id, two.user.id], action: 'unlock', reason: 'review complete' });
    const signed = await service.login({ email: one.user.email, password });
    await service.adminBulk({ actorToken: actor.token, accountIds: [one.user.id, two.user.id], action: 'revoke-sessions', reason: 'rotate access' });
    assert.equal(await service.authenticate(signed.token), null);
    await assert.rejects(service.adminBulk({ actorToken: admin.token, accountIds: [one.user.id, admin.user.id], action: 'lock', reason: 'self target' }), { code: 'self_administration_denied' });
    assert.equal((await service.getUser(one.user.id))?.status, 'active');
});
test('bulk administration rejects empty, duplicate, oversized and missing targets without partial changes', async (t) => {
    const { service } = await setup(t), admin = await service.bootstrapAdmin({ email: 'bulk-bounds@example.com', password }), user = await service.register({ email: 'bulk-bound-user@example.com', password });
    for (const accountIds of [[], [user.user.id, user.user.id], Array.from({ length: 51 }, (_, index) => 'target-' + index)])
        await assert.rejects(service.adminBulk({ actorToken: admin.token, accountIds, action: 'lock', reason: 'bounds' }), { code: 'invalid_bulk_action' });
    await assert.rejects(service.adminBulk({ actorToken: admin.token, accountIds: [user.user.id, 'missing'], action: 'lock', reason: 'missing user' }), { code: 'account_not_found' });
    assert.equal((await service.getUser(user.user.id))?.status, 'active');
    assert.equal((await service.listAudit({ action: 'admin.bulk.lock' })).events.length, 0);
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
test('deletion grace is operator bounded, stored per request and does not change ordinary default sessions', async (t) => {
    const { service, now, advance } = await setup(t, { deletionGraceMs: 86400000 }), user = await service.register({ email: 'short-grace@example.com', password });
    assert.equal(user.principal.restrictions, undefined);
    assert.deepEqual(service.getSecurityPolicy(), { requireEmailVerification: false, requireMfa: false, deletionGraceMs: 86400000 });
    const scheduled = await service.deleteAccount({ token: user.token, password });
    assert.equal(scheduled.deleteAfter, now() + 86400000);
    advance(86399999);
    assert.deepEqual(await service.purgeDeleted(), { purged: 0 });
    advance(2);
    assert.deepEqual(await service.purgeDeleted(), { purged: 1 });
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
        assert.equal((await migrated.listAudit({ action: 'configuration.changed' })).events.length, 1);
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
    assert.equal((await service.listAudit({ action: 'configuration.changed' })).events.length, 0);
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
        const event = (await migrated.listAudit({ action: 'configuration.changed' })).events[0]!;
        const summary = JSON.parse(event.reason);
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
        assert.equal((await winners[0]!.value.listAudit({ action: 'configuration.changed' })).events.length, 1);
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
        const event = (await revised.listAudit({ action: 'configuration.changed' })).events[0]!;
        assert.equal(JSON.parse(event.reason).revoked.auth_signups, 1);
    }
    finally {
        await revised.close();
    }
});
async function factorProof(service: AuthService, credentialId: string, browserHash = '2'.repeat(64)) {
    const stored = (await service.getPasskey(credentialId))!;
    const token = await service.createSecondFactorProof({ browserHash, proof: { ...stored.proof, newCounter: stored.credential.counter + 1 } });
    return { token, browserHash };
}
test('explicit passkey second factors lift enrollment only with independent ownership proof and are consumed atomically', async (t) => {
    const { service } = await setup(t, { allowPasskeySecondFactor: true, requireMfa: true });
    const user = await service.register({ email: 'factor-password@example.com', password });
    assert.deepEqual(user.principal.restrictions, ['enroll-mfa']);
    await service.addPasskey({ actorToken: user.token, credential: { id: 'factor-key', publicKey: 'synthetic-factor-public-key', counter: 0 } });
    const enrollment = await factorProof(service, 'factor-key');
    await service.setPasskeySecondFactor({ token: user.token, credentialId: 'factor-key', enabled: true, secondFactor: enrollment });
    assert.equal((await service.authenticate(user.token))?.restrictions, undefined);
    assert.equal((await service.getUser(user.user.id))?.passkeyMfaEnabled, true);
    assert.equal((await service.listPasskeys(user.user.id))[0]?.secondFactor, true);
    await assert.rejects(service.login({ email: user.user.email, password }), { code: 'second_factor_required' });
    const proof = await factorProof(service, 'factor-key');
    await assert.rejects(service.login({ email: user.user.email, password: 'incorrect password', secondFactor: proof }), { code: 'invalid_credentials' });
    await assert.rejects(service.login({ email: user.user.email, password, secondFactor: { ...proof, browserHash: '3'.repeat(64) } }), { code: 'invalid_second_factor' });
    const signed = await service.login({ email: user.user.email, password, secondFactor: proof });
    assert.ok(await service.authenticate(signed.token));
    await assert.rejects(service.login({ email: user.user.email, password, secondFactor: proof }), { code: 'invalid_second_factor' });
    await assert.rejects(service.setPasskeySecondFactor({ token: signed.token, credentialId: 'factor-key', enabled: false }), { code: 'last_required_factor' });
    const other = await service.register({ email: 'factor-other@example.com', password });
    await assert.rejects(service.login({ email: other.user.email, password, secondFactor: await factorProof(service, 'factor-key') }), { code: 'invalid_second_factor' });
});
test('the same passkey cannot be both primary and second factor, including restricted signup enrollment', async (t) => {
    const { service } = await setup(t, { allowPasskeySecondFactor: true, requireMfa: true });
    const browserHash = '4'.repeat(64), start = await service.beginSignup({ email: 'factor-passkey@example.com', browserHash }), binding = { flowId: start.flowId, browserHash }, challenge = 's'.repeat(43);
    await service.setSignupPasskeyChallenge({ ...binding, challenge });
    await service.setSignupPasskey({ ...binding, challenge, credential: { id: 'primary-key', publicKey: 'synthetic-primary-public', counter: 0 } });
    const account = (await service.completeSignup(binding))!;
    await assert.rejects(service.setPasskeySecondFactor({ token: account.token, credentialId: 'primary-key', enabled: true, secondFactor: await factorProof(service, 'primary-key') }), { code: 'independent_second_factor_required' });
    await service.addPasskey({ actorToken: account.token, credential: { id: 'independent-key', publicKey: 'synthetic-independent-public', counter: 0 } });
    await service.setPasskeySecondFactor({ token: account.token, credentialId: 'independent-key', enabled: true, secondFactor: await factorProof(service, 'independent-key') });
    const same = (await service.getPasskey('independent-key'))!, sameFactor = await factorProof(service, 'independent-key');
    await assert.rejects(service.issueSession(account.user.id, { method: 'passkey', proof: { ...same.proof, newCounter: same.credential.counter + 1 }, secondFactor: sameFactor }), { code: 'independent_second_factor_required' });
    const primary = (await service.getPasskey('primary-key'))!;
    assert.ok(await service.issueSession(account.user.id, { method: 'passkey', proof: { ...primary.proof, newCounter: 1 }, secondFactor: sameFactor }));
});
test('trusted-device exemptions are explicit, version-bound and never grant fresh administration or renew trust', async (t) => {
    const { service } = await setup(t, { allowPasskeySecondFactor: true, trustedDeviceTtlMs: 60000 });
    const admin = await service.bootstrapAdmin({ email: 'trust-admin@example.com', password }), target = await service.register({ email: 'trust-target@example.com', password });
    await assert.rejects(service.rememberDevice({ token: admin.token }), { code: 'fresh_second_factor_required' });
    await service.addPasskey({ actorToken: admin.token, credential: { id: 'trust-factor', publicKey: 'synthetic-trust-factor', counter: 0 } });
    await service.setPasskeySecondFactor({ token: admin.token, credentialId: 'trust-factor', enabled: true, secondFactor: await factorProof(service, 'trust-factor') });
    const trust = await service.rememberDevice({ token: admin.token, label: 'Synthetic browser' });
    const remembered = await service.login({ email: admin.user.email, password, trustedDevice: trust.token });
    assert.equal(remembered.principal.authenticatedAt, 0);
    assert.equal((await service.authenticate(remembered.token))?.authenticatedAt, 0);
    await assert.rejects(service.adminSetStatus({ actorToken: remembered.token, accountId: target.user.id, status: 'locked' }), { code: 'fresh_authentication_required' });
    await assert.rejects(service.rememberDevice({ token: remembered.token }), { code: 'fresh_authentication_required' });
    await assert.rejects(service.stepUp({ token: remembered.token, password }), { code: 'second_factor_required' });
    const devices = await service.listTrustedDevices(remembered.token);
    assert.equal(devices.length, 1);
    assert.equal(Object.hasOwn(devices[0]!, 'hash'), false);
    const stepped = await service.stepUp({ token: remembered.token, password, secondFactor: await factorProof(service, 'trust-factor') });
    assert.ok(stepped.principal.authenticatedAt > 0);
    await service.revokeTrustedDevice({ token: stepped.token, deviceId: devices[0]!.id });
    await assert.rejects(service.login({ email: admin.user.email, password, trustedDevice: trust.token }), { code: 'invalid_trusted_device' });
    const another = await service.rememberDevice({ token: stepped.token });
    await service.revokeSessions(admin.user.id);
    await assert.rejects(service.login({ email: admin.user.email, password, trustedDevice: another.token }), { code: 'invalid_trusted_device' });
});
test('passkey-only second-factor email recovery invalidates device trust and restricts enrollment to its recovery grant', async (t) => {
    const { service, advance } = await setup(t, { allowPasskeySecondFactor: true, allowEmailFactorRecovery: true, trustedDeviceTtlMs: 172800000 });
    const account = await service.register({ email: 'passkey-factor-recovery@example.com', password });
    await service.consumeVerification((await service.issueToken({ email: account.user.email, purpose: 'verify-email' })).token!, account.token);
    await service.addPasskey({ actorToken: account.token, credential: { id: 'lost-factor-key', publicKey: 'synthetic-lost-key', counter: 0 } });
    await service.setPasskeySecondFactor({ token: account.token, credentialId: 'lost-factor-key', enabled: true, secondFactor: await factorProof(service, 'lost-factor-key') });
    const trust = await service.rememberDevice({ token: account.token });
    const browserToken = 'r'.repeat(43), issued = await service.beginFactorRecovery({ email: account.user.email, browserToken });
    assert.ok(issued.verificationToken);
    await service.confirmFactorRecovery({ token: issued.verificationToken, browserToken });
    advance(86400001);
    const recovered = await service.completeFactorRecovery({ token: issued.verificationToken, browserToken });
    assert.deepEqual(recovered.principal.restrictions, ['enroll-mfa']);
    assert.equal((await service.getUser(account.user.id))?.passkeyMfaEnabled, undefined);
    assert.equal((await service.listTrustedDevices(recovered.token)).length, 0);
    const unproved = await service.login({ email: account.user.email, password, trustedDevice: trust.token });
    assert.deepEqual(unproved.principal.restrictions, ['enroll-mfa']);
    await assert.rejects(service.addPasskey({ actorToken: unproved.token, credential: { id: 'unproved-new-key', publicKey: 'synthetic', counter: 0 } }), { code: 'recovery_enrollment_proof_required' });
    await service.addPasskey({ actorToken: recovered.token, credential: { id: 'recovered-factor-key', publicKey: 'synthetic-recovered-key', counter: 0 } });
    await service.setPasskeySecondFactor({ token: recovered.token, credentialId: 'recovered-factor-key', enabled: true, secondFactor: await factorProof(service, 'recovered-factor-key') });
    assert.equal((await service.authenticate(recovered.token))?.restrictions, undefined);
    assert.equal(await service.authenticate(unproved.token), null);
    await assert.rejects(service.login({ email: account.user.email, password, trustedDevice: trust.token }), { code: 'invalid_trusted_device' });
});
test('factor proofs expire and trusted devices have bounded lifetimes, count and current-version MFA mint authority', async (t) => {
    const { service, options, advance } = await setup(t, { allowPasskeySecondFactor: true, trustedDeviceTtlMs: 60000 });
    const account = await service.register({ email: 'bounded-trust@example.com', password });
    await service.addPasskey({ actorToken: account.token, credential: { id: 'bounded-factor', publicKey: 'synthetic-bounded-key', counter: 0 } });
    await service.setPasskeySecondFactor({ token: account.token, credentialId: 'bounded-factor', enabled: true, secondFactor: await factorProof(service, 'bounded-factor') });
    const trusts = [];
    for (let n = 0; n < 20; n++)
        trusts.push(await service.rememberDevice({ token: account.token }));
    await assert.rejects(service.rememberDevice({ token: account.token }), { code: 'trusted_device_limit' });
    const oldProof = await factorProof(service, 'bounded-factor');
    advance(300001);
    await assert.rejects(service.login({ email: account.user.email, password, trustedDevice: trusts[0]!.token }), { code: 'invalid_trusted_device' });
    await assert.rejects(service.login({ email: account.user.email, password, secondFactor: oldProof }), { code: 'invalid_second_factor' });
    const fresh = await service.login({ email: account.user.email, password, secondFactor: await factorProof(service, 'bounded-factor') });
    await service.updateProfile({ token: fresh.token, profile: { displayName: 'Updated profile' } });
    await assert.rejects(service.rememberDevice({ token: fresh.token }), { code: 'fresh_second_factor_required' });
    await service.changePassword({ token: fresh.token, currentPassword: password, password: 'changed synthetic password 123', secondFactor: await factorProof(service, 'bounded-factor') });
    await assert.rejects(service.rememberDevice({ token: fresh.token }), { code: 'fresh_authentication_required' });
    await assert.rejects(createAuthService({ ...options, trustedDeviceTtlMs: 2592000001 }), { code: 'invalid_trusted_device_policy' });
});
test('independent passkey proof replaces a lost TOTP and works across OIDC and human-code primaries', async (t) => {
    const { service, now } = await setup(t, { allowPasskeySecondFactor: true, trustedDeviceTtlMs: 60000 });
    const account = await service.register({ email: 'multi-primary-factor@example.com', password });
    await verifyOwnMailbox(service, account.user.email, account.token);
    await service.linkExternal({ sessionReference: sessionReference(account.token),  provider: 'example-provider', subject: 'synthetic-subject' });
    await service.addPasskey({ actorToken: account.token, credential: { id: 'multi-primary-key', publicKey: 'synthetic-multi-primary-key', counter: 0 } });
    await service.setPasskeySecondFactor({ token: account.token, credentialId: 'multi-primary-key', enabled: true, secondFactor: await factorProof(service, 'multi-primary-key') });
    const setupTotp = await service.beginTotp(account.token), totp = new TOTP({ secret: setupTotp.secret });
    await service.confirmTotp({ token: account.token, code: totp.generate({ timestamp: now() }) });
    await service.disableTotp({ token: account.token, password, secondFactor: await factorProof(service, 'multi-primary-key') });
    assert.equal((await service.getUser(account.user.id))?.totpEnabled, false);
    assert.equal((await service.getUser(account.user.id))?.passkeyMfaEnabled, true);
    const primary = (await service.getExternalProof('example-provider', 'synthetic-subject'))!;
    await assert.rejects(service.issueSession(account.user.id, { method: 'oidc', proof: primary.proof, trustedDevice: 'z'.repeat(43) }), { code: 'invalid_trusted_device' });
    const signed = await service.issueSession(account.user.id, { method: 'oidc', proof: primary.proof, secondFactor: await factorProof(service, 'multi-primary-key') });
    const trust = await service.rememberDevice({ token: signed.token });
    const rememberedOidc = await service.issueSession(account.user.id, { method: 'oidc', proof: primary.proof, trustedDevice: trust.token });
    assert.equal(rememberedOidc.principal.authenticatedAt, 0);
    const code = await service.issueEmailCode({ email: account.user.email });
    const rememberedCode = await service.consumeEmailCode({ flowId: code.flowId, code: code.code!, trustedDevice: trust.token });
    assert.equal(rememberedCode.principal.authenticatedAt, 0);
    const next = await service.issueEmailCode({ email: account.user.email });
    const actual = await service.consumeEmailCode({ flowId: next.flowId, code: next.code!, secondFactor: await factorProof(service, 'multi-primary-key') });
    assert.ok(actual.principal.authenticatedAt > 0);
    assert.ok(await service.rememberDevice({ token: actual.token }));
});

test('method removal preserves an independent primary and passkey factor combination', async t => {
    const {service} = await setup(t, {allowPasskeySecondFactor:true});
    const admin = await service.bootstrapAdmin({email:'method-admin@example.test',password});
    const browserHash='4'.repeat(64), start=await service.beginSignup({email:'method-primary@example.test',browserHash}), binding={flowId:start.flowId,browserHash}, challenge='s'.repeat(43);
    await service.setSignupPasskeyChallenge({...binding,challenge});
    await service.setSignupPasskey({...binding,challenge,credential:{id:'primary-method',publicKey:'synthetic-primary-public',counter:0}});
    const account=(await service.completeSignup(binding))!;
    await service.addPasskey({actorToken:account.token,credential:{id:'factor-method',publicKey:'synthetic-factor-public',counter:0}});
    await service.setPasskeySecondFactor({token:account.token,credentialId:'factor-method',enabled:true,secondFactor:await factorProof(service,'factor-method')});
    await assert.rejects(service.removePasskey({token:account.token,credentialId:'primary-method'}),{code:'last_sign_in_method'});
    const base={actorToken:admin.token,accountIds:[account.user.id],reason:'Reviewed method removal'};
    await assert.rejects(service.stageAccountAdministration({...base,action:'remove-passkey',credentialId:'primary-method'}),{code:'last_sign_in_method'});
    await service.linkExternal({ sessionReference: sessionReference(account.token), provider:'example',subject:'synthetic-subject'});
    await service.removePasskey({token:account.token,credentialId:'primary-method'});
    await assert.rejects(service.unlinkExternal({token:account.token,provider:'example',subject:'synthetic-subject'}),{code:'last_sign_in_method'});
    const methods=await service.inspectAccountAuthentication({actorToken:admin.token,accountId:account.user.id,reason:'Review remaining methods'});
    await assert.rejects(service.stageAccountAdministration({...base,action:'remove-external',externalId:methods.external[0]!.id}),{code:'last_sign_in_method'});
    assert.ok(await service.getPasskey('factor-method'));
});
test('bearer/API-key issuance, verification, expiry, revocation and secret secrecy', async (t) => {
    const { service, advance, database } = await setup(t);
    const issued = await service.issueApiKey({ name: 'ci-deploy-bot', scopes: ['deploys.write', 'deploys.write'] });
    assert.equal(issued.name, 'ci-deploy-bot');
    assert.deepEqual(issued.scopes, ['deploys.write']);
    assert.equal(issued.expires, null);
    assert.match(issued.key, /^uak_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const listed = await service.listApiKeys();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, issued.id);
    assert.equal(listed[0]!.revoked, false);
    assert.equal(listed[0]!.lastUsed, null);
    assert.ok(!('key' in listed[0]!) && !('secretHash' in listed[0]!));
    const authenticated = await service.authenticateApiKey(issued.key);
    assert.deepEqual(authenticated, { id: issued.id, name: 'ci-deploy-bot', scopes: ['deploys.write'], quota: null });
    assert.equal(issued.quota, null);
    assert.equal(listed[0]!.quota, null);
    // Wrong secret against a real id, garbage input, and an unknown id all fail closed.
    assert.equal(await service.authenticateApiKey(`uak_${issued.id}.${'x'.repeat(43)}`), null);
    assert.equal(await service.authenticateApiKey('not-a-key'), null);
    assert.equal(await service.authenticateApiKey(''), null);
    assert.equal(await service.authenticateApiKey(`uak_${'0'.repeat(36)}.${'x'.repeat(43)}`), null);
    assert.ok((await service.listApiKeys())[0]!.lastUsed !== null);
    await service.revokeApiKey(issued.id);
    assert.equal(await service.authenticateApiKey(issued.key), null);
    assert.equal((await service.listApiKeys())[0]!.revoked, true);
    const expiring = await service.issueApiKey({ name: 'short-lived', scopes: ['read'], expiresInMs: 60000 });
    assert.ok(await service.authenticateApiKey(expiring.key));
    advance(120000);
    assert.equal(await service.authenticateApiKey(expiring.key), null);
    await assert.rejects(service.issueApiKey({ name: '', scopes: ['read'] }), { code: 'invalid_api_key_name' });
    await assert.rejects(service.issueApiKey({ name: 'bad-scope', scopes: ['Invalid Scope'] }), { code: 'invalid_api_key_scopes' });
    await assert.rejects(service.issueApiKey({ name: 'bad-expiry', scopes: ['read'], expiresInMs: 1 }), { code: 'invalid_api_key_expiry' });
    await assert.rejects(service.revokeApiKey(''), { code: 'invalid_api_key_id' });
    assert.equal((await readFile(database)).includes(Buffer.from(issued.key.split('.')[1]!)), false);
});
test('bearer/API-key quota: per-credential fixed window, durable across restart, shared by processes on one database file', async (t) => {
    const { service, options, database, advance, now } = await setup(t);
    const first = await service.issueApiKey({ name: 'quota-a', scopes: ['read'] }), second = await service.issueApiKey({ name: 'quota-b', scopes: ['read'] });
    const quota = { requests: 3, window: 60 };
    assert.deepEqual(await service.consumeApiKeyQuota(first.id, quota), { allowed: true, remaining: 2, reset: 60 });
    assert.deepEqual(await service.consumeApiKeyQuota(first.id, quota), { allowed: true, remaining: 1, reset: 60 });
    advance(10000);
    assert.deepEqual(await service.consumeApiKeyQuota(first.id, quota), { allowed: true, remaining: 0, reset: 50 });
    // Refused, and a refusal is not counted (a retry loop cannot keep its own window open).
    assert.deepEqual(await service.consumeApiKeyQuota(first.id, quota), { allowed: false, remaining: 0, reset: 50 });
    assert.deepEqual(await service.consumeApiKeyQuota(first.id, quota), { allowed: false, remaining: 0, reset: 50 });
    // A separate credential, and the same credential under a different budget, count separately.
    assert.equal((await service.consumeApiKeyQuota(second.id, quota)).allowed, true);
    assert.equal((await service.consumeApiKeyQuota(first.id, { requests: 3, window: 120 })).allowed, true);
    // Survives a restart on the same SQLite file.
    await service.close();
    const restarted = await createAuthService(options);
    cleanup(t, () => restarted.close());
    assert.equal((await restarted.consumeApiKeyQuota(first.id, quota)).allowed, false);
    // Another OS process opening the same database file sees, and adds to, the same count.
    const child = (id: string) => new Promise<string>((resolve, reject) => {
        const script = `import { createAuthService } from ${JSON.stringify(new URL('../src/auth-core.ts', import.meta.url).href)};
const service = await createAuthService({ database: process.env.DB, encryptionKey: Buffer.alloc(32, 7), roles: ${JSON.stringify(roles)}, defaultRole: 'user', now: () => Number(process.env.NOW) });
try { process.stdout.write(JSON.stringify(await service.consumeApiKeyQuota(process.env.KEY_ID, { requests: 3, window: 60 }))); } finally { await service.close(); }`;
        execFile(process.execPath, ['--conditions=development', '--input-type=module', '-e', script], { env: { ...process.env, DB: database, NOW: String(now()), KEY_ID: id } }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout));
    });
    assert.deepEqual(JSON.parse(await child(first.id)), { allowed: false, remaining: 0, reset: 50 });
    assert.deepEqual(JSON.parse(await child(second.id)), { allowed: true, remaining: 1, reset: 60 });
    assert.deepEqual(await restarted.consumeApiKeyQuota(second.id, quota), { allowed: true, remaining: 0, reset: 60 });
    assert.equal((await restarted.consumeApiKeyQuota(second.id, quota)).allowed, false);
    // The window resets once it closes.
    advance(50000);
    assert.deepEqual(await restarted.consumeApiKeyQuota(first.id, quota), { allowed: true, remaining: 2, reset: 60 });
    // Only the key id is counted, hashed: neither the id nor the raw secret appears in the counter table.
    const db = new DatabaseSync(database, { readOnly: true });
    try {
        const keys = db.prepare('SELECT key FROM auth_attempts').all().map(row => String(row.key));
        assert.ok(keys.length >= 3 && keys.every(key => /^[a-f0-9]{64}$/.test(key)));
        assert.ok(!keys.some(key => key.includes(first.id) || key.includes(first.key.split('.')[1]!)));
    }
    finally { db.close(); }
    for (const bad of [{ requests: 0, window: 60 }, { requests: 1.5, window: 60 }, { requests: 1, window: 0 }, { requests: 1, window: 2592001 }, { requests: 1000001, window: 60 }, null])
        await assert.rejects(restarted.consumeApiKeyQuota(first.id, bad as never), { code: 'invalid_api_key_quota' });
    await assert.rejects(restarted.consumeApiKeyQuota('', quota), { code: 'invalid_api_key_id' });
});
test('bearer/API-key own quota (urlcode#703): stored at issuance, returned by lookup and list, bounded like the route quota', async (t) => {
    const { service, options } = await setup(t);
    const planned = await service.issueApiKey({ name: 'plan-gold', scopes: ['read'], quota: { requests: 5000, window: 3600 } });
    assert.deepEqual(planned.quota, { requests: 5000, window: 3600 });
    const plain = await service.issueApiKey({ name: 'plain', scopes: ['read'] });
    assert.equal(plain.quota, null);
    assert.deepEqual((await service.authenticateApiKey(planned.key))?.quota, { requests: 5000, window: 3600 });
    assert.equal((await service.authenticateApiKey(plain.key))?.quota, null);
    const listed = new Map((await service.listApiKeys()).map(row => [row.id, row.quota]));
    assert.deepEqual(listed.get(planned.id), { requests: 5000, window: 3600 });
    assert.equal(listed.get(plain.id), null);
    // Same bounds as `auth.bearer.quota`; unknown fields are refused rather than dropped.
    for (const bad of [{ requests: 0, window: 60 }, { requests: 1.5, window: 60 }, { requests: 1, window: 0 }, { requests: 1, window: 2592001 }, { requests: 1000001, window: 60 }, { requests: 10 }, { requests: 10, window: 60, burst: 5 }, null, 'ten'])
        await assert.rejects(service.issueApiKey({ name: 'bad-quota', scopes: ['read'], quota: bad as never }), { code: 'invalid_api_key_quota' });
    assert.equal((await service.listApiKeys()).length, 2);
    // Durable across a restart.
    await service.close();
    const restarted = await createAuthService(options);
    cleanup(t, () => restarted.close());
    assert.deepEqual((await restarted.authenticateApiKey(planned.key))?.quota, { requests: 5000, window: 3600 });
});
test('bearer/API-key quota columns are added to a database created before them; existing keys have no quota', async (t) => {
    const { service, options, database } = await setup(t);
    const legacy = await service.issueApiKey({ name: 'legacy', scopes: ['read'] });
    await service.close();
    // Recreate the pre-#703 table shape, keeping the row.
    const db = new DatabaseSync(database);
    try {
        db.exec('ALTER TABLE auth_api_keys DROP COLUMN quota_requests;ALTER TABLE auth_api_keys DROP COLUMN quota_window;');
        assert.ok(!db.prepare('PRAGMA table_info(auth_api_keys)').all().some(row => String(row.name).startsWith('quota_')));
    }
    finally { db.close(); }
    const migrated = await createAuthService(options);
    cleanup(t, () => migrated.close());
    assert.deepEqual(await migrated.authenticateApiKey(legacy.key), { id: legacy.id, name: 'legacy', scopes: ['read'], quota: null });
    assert.equal((await migrated.listApiKeys())[0]!.quota, null);
    const issued = await migrated.issueApiKey({ name: 'after-migration', scopes: ['read'], quota: { requests: 10, window: 60 } });
    assert.deepEqual((await migrated.authenticateApiKey(issued.key))?.quota, { requests: 10, window: 60 });
});
