import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign, createHash, randomBytes } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { createAuthService } from '../src/auth-core.ts';
import { companions, withCompanions } from './support/companions.ts';
import { createPasskeyProvider } from '../src/passkeys.ts';
import { activatedUi } from './support/render.ts';
test('handler passkey registration/login binds browser, consumes challenges and persists counters', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'auth-passkey-handler-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const service = await createAuthService({ database: join(root, 'auth.sqlite'), encryptionKey: randomBytes(32), roles: { member: ['site.read'], admin: ['*'] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const origin = 'https://site.example', projectSha256 = 'a'.repeat(64);
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin), authExtension = withCompanions(await companions(t, root, projectSha256, origin));
    const instance = await authExtension({ service, csrfKey: randomBytes(32), projectSha256, ui, passkeys: createPasskeyProvider({ origin, rpId: 'site.example', rpName: 'Site' }) }).activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    const cookies = new Map<string, string>();
    async function request(path: string, data?: Record<string, unknown>) {
        const headers = new Headers({ accept: 'application/json', cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; ') });
        if (data) {
            headers.set('origin', origin);
            headers.set('content-type', 'application/json');
        }
        const result = await instance.handle({ method: data ? 'POST' : 'GET', target: path, path, query: new URLSearchParams(), headers, headerCounts: Object.fromEntries([...headers].map(([key]) => [key, 1])), body: Buffer.from(data ? JSON.stringify(data) : ''), origin, route: '/account/*', mount: '/account', client: '127.0.0.1', requestId: 'test-request', env: {} });
        for (const [name, value] of result.headers)
            if (name === 'set-cookie') {
                const [key, item] = value.split(';')[0]!.split('=');
                if (value.includes('Max-Age=0'))
                    cookies.delete(key!);
                else
                    cookies.set(key!, item!);
            }
        return { status: result.status, json: JSON.parse(Buffer.from(result.body ?? '').toString()) };
    }
    let csrf = (await request('/account/csrf')).json.csrf as string;
    const registered = await request('/account/register', { csrf, email: 'passkey@example.com', password: 'correct horse battery staple' });
    assert.equal(registered.status, 201);
    csrf = registered.json.csrf;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = publicKey.export({ format: 'jwk' });
    const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
    const credential = randomBytes(32), id = credential.toString('base64url'), length = Buffer.alloc(2);
    length.writeUInt16BE(32);
    const start = await request('/account/passkeys/register/options', { csrf });
    assert.equal(start.status, 200);
    const client = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: start.json.options.challenge, origin, crossOrigin: false }));
    const auth = Buffer.concat([createHash('sha256').update('site.example').digest(), Buffer.from([0x45]), Buffer.alloc(20), length, credential, cose]);
    const attestation = isoCBOR.encode(new Map<string, string | Map<string, never> | Uint8Array<ArrayBuffer>>([['fmt', 'none'], ['attStmt', new Map<string, never>()], ['authData', new Uint8Array(auth)]]));
    const response = { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: client.toString('base64url'), attestationObject: Buffer.from(attestation).toString('base64url'), transports: ['internal'] } };
    const payload = { csrf, flowId: start.json.flowId, response };
    assert.equal((await request('/account/passkeys/register/verify', payload)).status, 200);
    assert.notEqual((await request('/account/passkeys/register/verify', payload)).status, 200);
    assert.equal((await service.listPasskeys(registered.json.user.id)).length, 1);
    // The credential records the RP ID the ceremony was verified under (#736).
    assert.equal((await service.getPasskey(id))?.credential.rpId, 'site.example');
    await request('/account/logout', { csrf });
    csrf = (await request('/account/csrf')).json.csrf;
    const foreign = await request('/account/passkeys/login/options', { csrf });
    const originalBrowser = cookies.get('__Host-urlcode-flow')!;
    cookies.set('__Host-urlcode-flow', randomBytes(32).toString('base64url'));
    const foreignCsrf = (await request('/account/csrf')).json.csrf;
    assert.equal((await request('/account/passkeys/login/verify', { csrf: foreignCsrf, flowId: foreign.json.flowId, response: { id } })).status, 403);
    cookies.set('__Host-urlcode-flow', originalBrowser);
    const login = await request('/account/passkeys/login/options', { csrf });
    assert.equal(login.status, 200);
    const loginClient = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: login.json.options.challenge, origin, crossOrigin: false })), counter = Buffer.alloc(4);
    counter.writeUInt32BE(1);
    const loginAuth = Buffer.concat([createHash('sha256').update('site.example').digest(), Buffer.from([5]), counter]);
    const signature = sign('sha256', Buffer.concat([loginAuth, createHash('sha256').update(loginClient).digest()]), privateKey);
    const assertion = { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: loginClient.toString('base64url'), authenticatorData: loginAuth.toString('base64url'), signature: signature.toString('base64url') } };
    const result = await request('/account/passkeys/login/verify', { csrf, flowId: login.json.flowId, response: assertion });
    assert.equal(result.status, 200);
    assert.equal(result.json.user.id, registered.json.user.id);
    assert.equal((await service.getPasskey(id))?.credential.counter, 1);
    assert.ok(cookies.has('__Host-urlcode-session'));
    const actor = await service.authenticate(cookies.get('__Host-urlcode-session')!);
    assert.equal(actor?.id, registered.json.user.id);
    const oldToken = cookies.get('__Host-urlcode-session')!;
    csrf = result.json.csrf;
    const step = await request('/account/passkeys/step-up/options', { csrf });
    assert.equal(step.status, 200);
    const stepClient = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: step.json.options.challenge, origin, crossOrigin: false }));
    counter.writeUInt32BE(2);
    const stepAuth = Buffer.concat([createHash('sha256').update('site.example').digest(), Buffer.from([5]), counter]);
    const stepSignature = sign('sha256', Buffer.concat([stepAuth, createHash('sha256').update(stepClient).digest()]), privateKey);
    const stepped = await request('/account/passkeys/step-up/verify', { csrf, flowId: step.json.flowId, response: { ...assertion, response: { clientDataJSON: stepClient.toString('base64url'), authenticatorData: stepAuth.toString('base64url'), signature: stepSignature.toString('base64url') } } });
    assert.equal(stepped.status, 200);
    assert.notEqual(cookies.get('__Host-urlcode-session'), oldToken);
    assert.equal(await service.authenticate(oldToken), null);
});
test('with the operator passkey RP ID, the handler registers on an alias origin, signs in on the canonical one and refuses a non-site origin', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'auth-passkey-rp-id-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const service = await createAuthService({ database: join(root, 'auth.sqlite'), encryptionKey: randomBytes(32), roles: { member: ['site.read'] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const origin = 'https://app.site.example', alias = 'https://www.site.example', projectSha256 = 'b'.repeat(64);
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin);
    const passkeys = createPasskeyProvider({ origin, rpId: 'app.site.example', rpName: 'Site' }), authExtension = withCompanions(await companions(t, root, projectSha256, origin));
    const context = { origin, origins: [origin, alias], target: 'node' as const, projectSha256, mounts: ['/account'], root: import.meta.dirname };
    // Unset: the provider is used unchanged, so options keep the canonical host.
    const plain = await authExtension({ service, csrfKey: randomBytes(32), projectSha256, ui, passkeys }).activate({ registration: 'open' }, context);
    // A provider that cannot be rebound is refused at activation rather than silently keeping the canonical host.
    const { withSite: _unused, ...fixed } = passkeys;
    await assert.rejects(Promise.resolve(authExtension({ service, csrfKey: randomBytes(32), projectSha256, ui, passkeys: fixed as typeof passkeys }).activate({ registration: 'open' }, { ...context, passkeyRpId: 'site.example' })), /no withSite/);
    const shared = await authExtension({ service, csrfKey: randomBytes(32), projectSha256, ui, passkeys }).activate({ registration: 'open' }, { ...context, passkeyRpId: 'site.example' });
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = publicKey.export({ format: 'jwk' });
    const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
    const credential = randomBytes(32), id = credential.toString('base64url'), length = Buffer.alloc(2);
    length.writeUInt16BE(32);
    for (const [instance, rpId] of [[plain, 'app.site.example'], [shared, 'site.example']] as const) {
        const cookies = new Map<string, string>();
        const request = async (path: string, data?: Record<string, unknown>, from = alias) => {
            const headers = new Headers({ accept: 'application/json', cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; ') });
            if (data) { headers.set('origin', from); headers.set('content-type', 'application/json'); }
            const result = await instance.handle({ method: data ? 'POST' : 'GET', target: path, path, query: new URLSearchParams(), headers, headerCounts: Object.fromEntries([...headers].map(([key]) => [key, 1])), body: Buffer.from(data ? JSON.stringify(data) : ''), origin, route: '/account/*', mount: '/account', client: '127.0.0.1', requestId: 'test-request', env: {} });
            for (const [name, value] of result.headers)
                if (name === 'set-cookie') { const [key, item] = value.split(';')[0]!.split('='); if (value.includes('Max-Age=0')) cookies.delete(key!); else cookies.set(key!, item!); }
            return { status: result.status, json: JSON.parse(Buffer.from(result.body ?? '').toString()) };
        };
        let csrf = (await request('/account/csrf')).json.csrf as string;
        const registered = await request('/account/register', { csrf, email: `${rpId}@example.com`, password: 'correct horse battery staple' });
        assert.equal(registered.status, 201);
        csrf = registered.json.csrf;
        const start = await request('/account/passkeys/register/options', { csrf });
        assert.equal(start.status, 200);
        assert.equal(start.json.options.rp.id, rpId);
        if (instance === plain) continue;
        const attest = (challenge: string, from: string) => {
            const client = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: from, crossOrigin: false }));
            const auth = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([0x45]), Buffer.alloc(20), length, credential, cose]);
            const attestation = isoCBOR.encode(new Map<string, string | Map<string, never> | Uint8Array<ArrayBuffer>>([['fmt', 'none'], ['attStmt', new Map<string, never>()], ['authData', new Uint8Array(auth)]]));
            return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: client.toString('base64url'), attestationObject: Buffer.from(attestation).toString('base64url'), transports: ['internal'] } };
        };
        // Client data naming a non-site origin is refused even though the request itself came from the alias.
        assert.notEqual((await request('/account/passkeys/register/verify', { csrf, flowId: start.json.flowId, response: attest(start.json.options.challenge, 'https://evil.example') })).status, 200);
        const retry = await request('/account/passkeys/register/options', { csrf });
        assert.equal((await request('/account/passkeys/register/verify', { csrf, flowId: retry.json.flowId, response: attest(retry.json.options.challenge, alias) })).status, 200);
        assert.equal((await service.listPasskeys(registered.json.user.id)).length, 1);
        await request('/account/logout', { csrf });
        csrf = (await request('/account/csrf')).json.csrf;
        const login = await request('/account/passkeys/login/options', { csrf }, origin);
        assert.equal(login.json.options.rpId, 'site.example');
        const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: login.json.options.challenge, origin, crossOrigin: false })), counter = Buffer.alloc(4);
        counter.writeUInt32BE(1);
        const auth = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([5]), counter]);
        const signature = sign('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), privateKey);
        const result = await request('/account/passkeys/login/verify', { csrf, flowId: login.json.flowId, response: { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: client.toString('base64url'), authenticatorData: auth.toString('base64url'), signature: signature.toString('base64url') } } }, origin);
        assert.equal(result.status, 200, 'the credential registered on the alias signs in on the canonical origin');
        assert.equal(result.json.user.id, registered.json.user.id);
    }
});
