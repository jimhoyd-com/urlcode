// #736: a passkey works only for the relying-party ID it was registered for. Auth records that ID on every stored
// credential and, at activation, warns the operator how many stored passkeys another ID's credentials make unusable.
import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createAuthService } from '../src/auth-core.ts';
import { createPasskeyProvider } from '../src/passkeys.ts';
import { companions, withCompanions } from './support/companions.ts';
import { activatedUi } from './support/render.ts';

const origin = 'https://app.site.example', projectSha256 = 'a'.repeat(64), password = 'correct horse battery staple';

test('the RP ID is recorded with a credential, and activation warns with the count a changed RP ID strands', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-rp-id-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const database = join(root, 'accounts.sqlite');
    const service = await createAuthService({ database, encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member', registrationMode: 'open' });
    cleanup(t, () => service.close());
    const user = await service.register({ email: 'keys@example.test', password });
    await service.addPasskey({ actorToken: user.token, credential: { id: 'canonical', publicKey: 'synthetic-a', counter: 0, rpId: 'app.site.example' } });
    await service.addPasskey({ actorToken: user.token, credential: { id: 'unrecorded', publicKey: 'synthetic-b', counter: 0 } });
    await service.addPasskey({ actorToken: user.token, credential: { id: 'shared', publicKey: 'synthetic-c', counter: 0, rpId: 'site.example' } });
    assert.deepEqual((await service.listPasskeys(user.user.id)).map(key => [key.id, key.rpId]).sort(), [['canonical', 'app.site.example'], ['shared', 'site.example'], ['unrecorded', undefined]]);
    await assert.rejects(service.addPasskey({ actorToken: user.token, credential: { id: 'bad', publicKey: 'synthetic-d', counter: 0, rpId: 'Not A Domain' } }), { code: 'invalid_passkey' });
    const ui = await activatedUi(t, root, projectSha256, origin), authExtension = withCompanions(await companions(t, root, projectSha256, origin));
    const passkeys = createPasskeyProvider({ origin, rpId: 'app.site.example', rpName: 'Site' });
    const warningsFor = async (passkeyRpId?: string) => {
        const warnings: string[] = [];
        const instance = await authExtension({ service, csrfKey: randomBytes(32), projectSha256, ui, passkeys }).activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root, ...(passkeyRpId ? { passkeyRpId } : {}), warn: message => { warnings.push(message); } });
        await instance.close?.();
        return warnings;
    };
    const unknown = '1 stored passkey has no recorded relying-party ID (registered before auth recorded it); it signs in only while the relying-party ID in effect at registration is unchanged';
    // No passkeyRpId: the canonical host is in effect. The unrecorded credential is never guessed to be foreign.
    assert.deepEqual(await warningsFor(), ['1 stored passkey was registered for another relying-party ID than app.site.example; it will not sign in until passkeyRpId matches the ID it was registered for', unknown]);
    // Setting a shared RP ID strands the canonical-host credential; the unrecorded one is still reported apart,
    // since a site that already ran with passkeyRpId registered it for that ID.
    assert.deepEqual(await warningsFor('site.example'), ['1 stored passkey was registered for another relying-party ID than site.example; it will not sign in until passkeyRpId matches the ID it was registered for', unknown]);
    // When every recorded credential matches, only the unrecorded one is mentioned, and then nothing.
    const db = new DatabaseSync(database);
    db.prepare("DELETE FROM auth_passkeys WHERE id='shared'").run();
    assert.deepEqual(await warningsFor(), [unknown]);
    db.prepare("DELETE FROM auth_passkeys WHERE id='unrecorded'").run();
    db.close();
    assert.deepEqual(await warningsFor(), []);
});
