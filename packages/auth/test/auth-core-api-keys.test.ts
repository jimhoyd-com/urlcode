import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanup } from './cleanup.ts';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createAuthService, roles, password, setup } from './support/auth-core.ts';

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
    assert.deepEqual(authenticated, { id: issued.id, name: 'ci-deploy-bot', scopes: ['deploys.write'], quota: null, userId: null });
    assert.equal(issued.userId, null);
    assert.equal(listed[0]!.userId, null);
    assert.equal(listed[0]!.userDisabled, false);
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
    assert.deepEqual(await migrated.authenticateApiKey(legacy.key), { id: legacy.id, name: 'legacy', scopes: ['read'], quota: null, userId: null });
    assert.equal((await migrated.listApiKeys())[0]!.quota, null);
    const issued = await migrated.issueApiKey({ name: 'after-migration', scopes: ['read'], quota: { requests: 10, window: 60 } });
    assert.deepEqual((await migrated.authenticateApiKey(issued.key))?.quota, { requests: 10, window: 60 });
});
test('user-linked API keys (urlcode#732): issued only for an active user, disabled while the user is locked or pending deletion, revoked when purged', async (t) => {
    const { service, advance } = await setup(t);
    const admin = await service.bootstrapAdmin({ email: 'owner@example.com', password }), alice = await service.register({ email: 'alice@example.com', password });
    const linked = await service.issueApiKey({ name: 'alice-agent', scopes: ['notes.read'], userId: alice.user.id });
    assert.equal(linked.userId, alice.user.id);
    const service_ = await service.issueApiKey({ name: 'service', scopes: ['notes.read'] });
    assert.deepEqual(await service.authenticateApiKey(linked.key), { id: linked.id, name: 'alice-agent', scopes: ['notes.read'], quota: null, userId: alice.user.id });
    const listed = () => service.listApiKeys().then(rows => new Map(rows.map(row => [row.id, row])));
    assert.equal((await listed()).get(linked.id)!.userId, alice.user.id);
    assert.equal((await listed()).get(linked.id)!.userDisabled, false);
    assert.equal((await listed()).get(service_.id)!.userId, null);
    // Unknown, malformed, locked and deleted users are refused with one code; nothing is stored.
    for (const userId of ['00000000-0000-4000-8000-000000000000', '', 'has space', 'x'.repeat(129), 7 as never])
        await assert.rejects(service.issueApiKey({ name: 'bad-user', scopes: ['read'], userId }), { code: 'invalid_api_key_user' });
    assert.equal((await service.listApiKeys()).length, 2);
    // Locking the user disables the key (and only that user's keys); unlocking restores it.
    await service.adminSetStatus({ actorToken: admin.token, accountId: alice.user.id, status: 'locked' });
    assert.equal(await service.authenticateApiKey(linked.key), null);
    assert.equal((await listed()).get(linked.id)!.userDisabled, true);
    assert.equal((await listed()).get(linked.id)!.revoked, false);
    assert.ok(await service.authenticateApiKey(service_.key));
    await assert.rejects(service.issueApiKey({ name: 'locked-user', scopes: ['read'], userId: alice.user.id }), { code: 'invalid_api_key_user' });
    await service.adminSetStatus({ actorToken: admin.token, accountId: alice.user.id, status: 'active' });
    assert.equal((await service.authenticateApiKey(linked.key))?.userId, alice.user.id);
    // Deleting the account disables the key through the grace period, and purging revokes it for good.
    const bob = await service.register({ email: 'bob@example.com', password });
    const bobKey = await service.issueApiKey({ name: 'bob-agent', scopes: ['read'], userId: bob.user.id });
    await service.deleteAccount({ token: bob.token, password });
    assert.equal(await service.authenticateApiKey(bobKey.key), null);
    assert.equal((await listed()).get(bobKey.id)!.userDisabled, true);
    await assert.rejects(service.issueApiKey({ name: 'deleting-user', scopes: ['read'], userId: bob.user.id }), { code: 'invalid_api_key_user' });
    advance(8 * 86400000);
    await service.purgeDeleted();
    assert.equal(await service.getUser(bob.user.id), null);
    assert.equal(await service.authenticateApiKey(bobKey.key), null);
    assert.equal((await listed()).get(bobKey.id)!.revoked, true);
    await assert.rejects(service.issueApiKey({ name: 'purged-user', scopes: ['read'], userId: bob.user.id }), { code: 'invalid_api_key_user' });
    assert.equal((await service.authenticateApiKey(linked.key))?.userId, alice.user.id);
});
test('bearer/API-key user_id column is added to a database created before it; existing keys stay service keys', async (t) => {
    const { service, options, database } = await setup(t);
    const legacy = await service.issueApiKey({ name: 'legacy', scopes: ['read'] });
    await service.close();
    const db = new DatabaseSync(database);
    try {
        db.exec('DROP INDEX auth_api_keys_user;ALTER TABLE auth_api_keys DROP COLUMN user_id;');
        assert.ok(!db.prepare('PRAGMA table_info(auth_api_keys)').all().some(row => row.name === 'user_id'));
    }
    finally { db.close(); }
    const migrated = await createAuthService(options);
    cleanup(t, () => migrated.close());
    assert.equal((await migrated.authenticateApiKey(legacy.key))?.userId, null);
    assert.deepEqual((await migrated.listApiKeys()).map(row => [row.userId, row.userDisabled]), [[null, false]]);
    const user = await migrated.register({ email: 'after@example.com', password });
    const linked = await migrated.issueApiKey({ name: 'after-migration', scopes: ['read'], userId: user.user.id });
    assert.equal((await migrated.authenticateApiKey(linked.key))?.userId, user.user.id);
});
