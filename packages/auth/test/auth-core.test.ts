import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { outbox } from './support/outbox.ts';
import { normalizeEmail, sessionReference, hashWaitBudgetMs } from '../src/auth-core.ts';
import { createAuthService, password, setup, verifyOwnMailbox } from './support/auth-core.ts';

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
    assert.ok((await outbox(service)).some(e => e.action === 'account.deleted'));
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
    const release: (() => void)[] = [], events: Record<string, unknown>[] = [];
    const { service } = await setup(t);
    service.attachLifecycleHooks({ onAccountCreated: async (input: unknown) => { events.push(input as Record<string, unknown>); await new Promise<void>(resolve => release.push(resolve)); } });
    // Six accounts at once: four hooks run, the two past the in-flight bound are dropped, and every account exists.
    let settled = 0;
    const created = Promise.all(Array.from({ length: 6 }, (_, index) => service.createExternalAccount({ email: 'hook' + index + '@example.com', provider: 'oidc', subject: String(index), emailVerified: true }).finally(() => { settled++; })));
    // The two dropped hooks return at once; the four running ones hold their callers until released.
    while (events.length < 4 || settled < 2)
        await new Promise<void>(resolve => setImmediate(resolve));
    for (const finish of release)
        finish();
    await created;
    assert.equal((await service.listUsers()).users.length, 6);
    assert.equal(service.getHookStats().accepted, 4);
    assert.equal(service.getHookStats().dropped, 2);
    assert.equal(events.length, 4);
    assert.deepEqual(Object.keys(events[0]!).sort(), ['accountId', 'email', 'method']);
    assert.equal(events[0]!.method, 'external');
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
