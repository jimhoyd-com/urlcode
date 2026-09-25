import { cleanup } from './cleanup.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAuthService } from '../src/auth-core.ts';
import type { AuthService } from '../src/auth-core.ts';
import { authExtension } from '../src/auth.ts';
import { createPasskeyProvider } from '../src/passkeys.ts';
import { activatedUi } from './support/render.ts';

// Issue #736: auth records each passkey's RP ID and warns the operator at activation, with counts only.
const origin = 'https://app.site.example', alias = 'https://www.site.example', projectSha256 = 'c'.repeat(64);
const encryptionKey = randomBytes(32), roles = { member: ['site.read'] };
async function database(t: TestContext): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'auth-passkey-rp-record-'));
    cleanup(t, () => rm(directory, { recursive: true, force: true }));
    return join(directory, 'auth.sqlite');
}
async function open(t: TestContext, file: string): Promise<AuthService> {
    const service = await createAuthService({ database: file, encryptionKey, roles, defaultRole: 'member' });
    cleanup(t, () => service.close());
    return service;
}
/** Adds passkeys to a fresh account and returns the ids and email, which a warning must never contain. */
async function enrol(service: AuthService, email: string, credentials: { id: string; rpId?: string }[]) {
    const user = await service.createExternalAccount({ email, provider: 'oidc', subject: email, emailVerified: true });
    const session = await service.issueSession(user.id, { method: 'oidc', proof: (await service.getExternalProof('oidc', email))!.proof });
    for (const credential of credentials)
        await service.addPasskey({ actorToken: session.token, credential: { id: credential.id, publicKey: Buffer.from('public-key-' + credential.id).toString('base64url'), counter: 0, ...(credential.rpId ? { rpId: credential.rpId } : {}) } });
    return { userId: user.id, email };
}
async function activationWarnings(t: TestContext, service: AuthService, passkeyRpId?: string): Promise<string[]> {
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin), warned: string[] = [];
    const passkeys = createPasskeyProvider({ origin, rpId: 'app.site.example', rpName: 'Site' });
    const instance = await authExtension({ service, csrfKey: randomBytes(32), projectSha256, ui, passkeys }).activate({ registration: 'open' }, { origin, origins: passkeyRpId === 'app.site.example' ? [origin] : [origin, alias], ...(passkeyRpId ? { passkeyRpId } : {}), target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname, warn: message => { warned.push(message); } });
    await instance.close?.();
    return warned;
}
test('addPasskey records the RP ID beside the credential and refuses a malformed one', async (t) => {
    const file = await database(t), service = await open(t, file);
    const { userId } = await enrol(service, 'record@example.test', [{ id: 'recorded-key', rpId: 'site.example' }, { id: 'legacy-key' }]);
    const listed = await service.listPasskeys(userId);
    assert.equal(listed.find(key => key.id === 'recorded-key')?.rpId, 'site.example');
    assert.equal(listed.find(key => key.id === 'legacy-key')?.rpId, undefined);
    assert.equal((await service.getPasskey('recorded-key'))?.credential.rpId, 'site.example');
    const user = await service.createExternalAccount({ email: 'bad-rp@example.test', provider: 'oidc', subject: 'bad-rp', emailVerified: true });
    const session = await service.issueSession(user.id, { method: 'oidc', proof: (await service.getExternalProof('oidc', 'bad-rp'))!.proof });
    for (const rpId of ['', 'Site.Example', 'site.example/path', 'x'.repeat(254)])
        await assert.rejects(service.addPasskey({ actorToken: session.token, credential: { id: 'bad-' + rpId.length, publicKey: 'key', counter: 0, rpId } }), { code: 'invalid_passkey' });
    assert.deepEqual(await service.countPasskeysByRelyingParty('site.example'), { mismatched: 0, unrecorded: 1 });
    assert.deepEqual(await service.countPasskeysByRelyingParty('app.site.example'), { mismatched: 1, unrecorded: 1 });
    await service.close();
    const db = new DatabaseSync(file, { readOnly: true });
    try { assert.deepEqual(db.prepare('SELECT id,rp_id FROM auth_passkeys ORDER BY id').all().map(row => ({ ...row })), [{ id: 'legacy-key', rp_id: null }, { id: 'recorded-key', rp_id: 'site.example' }]); }
    finally { db.close(); }
});
test('activation warns once, with counts only, when stored passkeys were registered under another RP ID', async (t) => {
    const service = await open(t, await database(t));
    const secrets = [await enrol(service, 'first@example.test', [{ id: 'canonical-key-1', rpId: 'app.site.example' }, { id: 'shared-key-1', rpId: 'site.example' }]), await enrol(service, 'second@example.test', [{ id: 'shared-key-2', rpId: 'site.example' }, { id: 'unrecorded-key' }])];
    // Default RP ID (the canonical host): two passkeys were recorded under site.example; unrecorded ones are assumed canonical.
    const byDefault = await activationWarnings(t, service);
    assert.deepEqual(byDefault, ['2 passkeys were registered under a different relying-party ID than the current one (app.site.example) and will not work until users re-register; see "Passkeys and the relying-party domain" in the @jimhoyd/urlcode-auth README']);
    // The operator RP ID: one recorded mismatch, plus the softer warning for the unrecorded passkey.
    const shared = await activationWarnings(t, service, 'site.example');
    assert.equal(shared.length, 2);
    assert.match(shared[0]!, /^1 passkey was registered under a different relying-party ID than the current one \(site\.example\) and will not work until users re-register; see /);
    assert.match(shared[1]!, /^1 passkey was stored before auth recorded relying-party IDs; if registered under the canonical host \(app\.site\.example\), as was the default, they will not work under the passkey RP ID site\.example until users re-register; see /);
    for (const message of [...byDefault, ...shared])
        for (const secret of secrets.flatMap(({ userId, email }) => [userId, email]).concat(['canonical-key-1', 'shared-key-1', 'shared-key-2', 'unrecorded-key']))
            assert.ok(!message.includes(secret), `warning leaks ${secret}`);
});
test('activation does not warn when every recorded passkey matches, nor about unrecorded ones under the default RP ID', async (t) => {
    const service = await open(t, await database(t));
    await enrol(service, 'match@example.test', [{ id: 'canonical-key', rpId: 'app.site.example' }, { id: 'unrecorded-key' }]);
    assert.deepEqual(await activationWarnings(t, service), []);
    // An operator RP ID equal to the canonical host is the default in effect: unrecorded passkeys still work.
    assert.deepEqual(await activationWarnings(t, service, 'app.site.example'), []);
    const empty = await open(t, await database(t));
    assert.deepEqual(await activationWarnings(t, empty, 'site.example'), []);
});
test('a database from before RP IDs were recorded gains the column in place and counts its passkeys as unrecorded', async (t) => {
    const file = await database(t), before = await open(t, file);
    const { userId } = await enrol(before, 'old@example.test', [{ id: 'old-key' }]);
    await before.close();
    // Recreate the earlier schema: no rp_id column.
    const db = new DatabaseSync(file);
    try { db.exec('ALTER TABLE auth_passkeys DROP COLUMN rp_id'); assert.ok(!db.prepare('PRAGMA table_info(auth_passkeys)').all().some(row => row.name === 'rp_id')); }
    finally { db.close(); }
    const service = await open(t, file);
    assert.deepEqual(await service.countPasskeysByRelyingParty('app.site.example'), { mismatched: 0, unrecorded: 1 });
    assert.deepEqual(await activationWarnings(t, service), []);
    assert.equal((await activationWarnings(t, service, 'site.example')).length, 1);
    // New passkeys on the migrated database are recorded.
    await enrol(service, 'new@example.test', [{ id: 'new-key', rpId: 'site.example' }]);
    assert.deepEqual(await service.countPasskeysByRelyingParty('site.example'), { mismatched: 0, unrecorded: 1 });
    assert.equal((await service.listPasskeys(userId))[0]?.id, 'old-key');
});
