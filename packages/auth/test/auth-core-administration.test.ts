import test from 'node:test';
import assert from 'node:assert/strict';
import { TOTP } from 'otpauth';
import { outbox } from './support/outbox.ts';
import { roles, password, setup, verifyOwnMailbox } from './support/auth-core.ts';

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
    assert.ok((await outbox(service)).some(event => event.reason === 'security event'));
    advance(300001);
    await assert.rejects(service.adminSetStatus({ actorToken: admin.token, accountId: other.user.id, status: 'locked' }), { code: 'fresh_authentication_required' });
    const refreshed = await service.stepUp({ token: admin.token, password });
    assert.equal(await service.authenticate(admin.token), null);
    await service.adminSetStatus({ actorToken: refreshed.token, accountId: other.user.id, status: 'locked' });
    await assert.rejects(service.login({ email: other.user.email, password }), { code: 'invalid_credentials' });
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
    // A C1 control character would make the mandatory notice undeliverable, so the reason itself is refused.
    await assert.rejects(service.createImpersonation({ actorToken: admin.token, accountId: target.user.id, reason: 'next\u0085line' }), { code: 'invalid_reason' });
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
test('impersonation refuses any target granted more than the default role, whatever the permission is named', async (t) => {
    const { service } = await setup(t, { allowImpersonation: true, roles: { ...roles, auditor: ['content.read', 'audit.read', 'audit.export'], storekeeper: ['content.read', 'store.notes.write'] } });
    const admin = await service.bootstrapAdmin({ email: 'impersonator@example.com', password });
    for (const role of ['auditor', 'storekeeper', 'editor']) {
        const target = await service.register({ email: `${role}@example.com`, password });
        await service.adminSetRoles({ actorToken: admin.token, accountId: target.user.id, roles: [role] });
        await assert.rejects(service.createImpersonation({ actorToken: admin.token, accountId: target.user.id, reason: 'support' }), { code: 'impersonation_denied' }, role);
    }
    const member = await service.register({ email: 'member@example.com', password });
    const support = await service.createImpersonation({ actorToken: admin.token, accountId: member.user.id, reason: 'support' });
    assert.deepEqual(support.principal.permissions, ['content.read']);
    // Granting the target an extension permission mid-session ends the support session rather than widening it.
    await service.adminSetRoles({ actorToken: admin.token, accountId: member.user.id, roles: ['auditor'] });
    assert.equal(await service.authenticate(support.token), null);
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
    assert.ok((await outbox(service)).some(e => e.action === 'admin.account_exported'));
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
    assert.equal((await outbox(service, { action: 'admin.bulk.lock' })).length, 2);
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
    assert.equal((await outbox(service, { action: 'admin.bulk.lock' })).length, 0);
});
