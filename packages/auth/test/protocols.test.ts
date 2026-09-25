import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash, randomBytes } from 'node:crypto';
import { createOidcProvider } from '../src/oidc.ts';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { createPasskeyProvider } from '../src/passkeys.ts';
const issuer = 'https://issuer.example', redirectUri = 'https://site.example/auth/oidc/example/callback';
function fixture() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let nonce = '', subject = 'synthetic-user', tokenCalls = 0, invalidSignature = false;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const transport: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url === issuer + '/.well-known/openid-configuration')
            return Response.json({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'] });
        if (url === issuer + '/jwks')
            return Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'RS256' }] });
        if (url === issuer + '/token') {
            tokenCalls++;
            assert.ok(String(init?.body).includes('code_verifier='));
            const now = Math.floor(Date.now() / 1000), head = encode({ alg: 'RS256', kid: 'fixture' }), body = encode({ iss: issuer, aud: 'client', sub: subject, nonce, iat: now, exp: now + 300, email: 'synthetic@example.com', email_verified: true });
            const content = head + '.' + body;
            return Response.json({ access_token: 'synthetic-access', token_type: 'Bearer', id_token: content + '.' + sign('RSA-SHA256', Buffer.from(invalidSignature ? content + 'corrupted' : content), privateKey).toString('base64url') });
        }
        throw new Error('Unexpected endpoint');
    };
    return { transport, corruptSignature(value = true) { invalidSignature = value; }, setNonce(value: string) { nonce = value; }, setSubject(value: string) { subject = value; }, calls: () => tokenCalls };
}
test('OIDC verifies signed identity with nonce/state/PKCE and exposes no provider tokens', async () => {
    const server = fixture(), provider = await createOidcProvider({ issuer, clientId: 'client', clientSecret: 'synthetic-secret', redirectUri, fetch: server.transport });
    const { url, flow } = await provider.start();
    const auth = new URL(url);
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.get('nonce'), flow.nonce);
    assert.equal(auth.searchParams.get('redirect_uri'), redirectUri);
    server.setNonce(flow.nonce);
    const identity = await provider.complete(new URL(redirectUri + '?code=synthetic&state=' + flow.state), flow);
    assert.deepEqual(identity, { issuer, subject: 'synthetic-user', email: 'synthetic@example.com', emailVerified: true });
    const before = server.calls();
    await assert.rejects(provider.complete(new URL(redirectUri + '?code=synthetic&state=wrong'), flow));
    assert.equal(server.calls(), before);
    await assert.rejects(provider.complete(new URL('https://other.example/callback?code=x&state=' + flow.state), flow), /callback mismatch/);
    server.corruptSignature();
    await assert.rejects(provider.complete(new URL(redirectUri + '?code=synthetic&state=' + flow.state), flow));
    server.corruptSignature(false);
    server.setNonce('wrong');
    await assert.rejects(provider.complete(new URL(redirectUri + '?code=synthetic&state=' + flow.state), flow));
});
test('OIDC refuses insecure endpoints and bounds discovery responses', async () => {
    await assert.rejects(createOidcProvider({ issuer: 'http://issuer.example', clientId: 'client', clientSecret: 'secret', redirectUri }), /HTTPS/);
    await assert.rejects(createOidcProvider({ issuer, clientId: 'client', clientSecret: 'secret', redirectUri, fetch: async () => new Response('x'.repeat(1048577)) }), error => error instanceof Error && error.cause instanceof Error && /exceeds limit/.test(error.cause.message));
});
test('passkey options require user verification, stable RP identity and fresh challenges', async () => {
    assert.throws(() => createPasskeyProvider({ origin: 'https://site.example', rpId: 'example', rpName: 'Site' }), /matching RP/);
    const provider = createPasskeyProvider({ origin: 'https://site.example', rpId: 'site.example', rpName: 'Site' });
    const registration = await provider.beginRegistration({ id: 'synthetic-account', email: 'synthetic@example.com' });
    assert.equal(registration.rp.id, 'site.example');
    assert.equal(registration.authenticatorSelection?.userVerification, 'required');
    assert.equal(registration.authenticatorSelection?.residentKey, 'required');
    const first = await provider.beginAuthentication(), second = await provider.beginAuthentication();
    assert.notEqual(first.challenge, second.challenge);
    assert.equal(first.userVerification, 'required');
    await assert.rejects(provider.verifyRegistration({ id: 'fake', rawId: 'fake', type: 'public-key', response: { clientDataJSON: 'e30', attestationObject: 'e30' }, clientExtensionResults: {} }, registration.challenge));
    await assert.rejects(provider.verifyAuthentication({ id: 'fake', rawId: 'fake', type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: 'e30', signature: 'e30' }, clientExtensionResults: {} }, first.challenge, { id: 'fake', publicKey: 'e30', counter: 0 }));
});
test('passkeys verify a real signed assertion and reject replay counters and wrong origin', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    // A fixed-shape COSE EC2/ES256 public key: kty, alg, curve, x and y.
    const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
    const id = randomBytes(32).toString('base64url'), provider = createPasskeyProvider({ origin: 'https://site.example', rpId: 'site.example', rpName: 'Site' });
    const options = await provider.beginAuthentication();
    const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: 'https://site.example', crossOrigin: false }));
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(1);
    const auth = Buffer.concat([createHash('sha256').update('site.example').digest(), Buffer.from([5]), counter]);
    const signature = sign('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), privateKey);
    const response = { id, rawId: id, type: 'public-key' as const, clientExtensionResults: {}, response: { clientDataJSON: client.toString('base64url'), authenticatorData: auth.toString('base64url'), signature: signature.toString('base64url') } };
    const stored = { id, publicKey: cose.toString('base64url'), counter: 0 };
    assert.deepEqual(await provider.verifyAuthentication(response, options.challenge, stored), { counter: 1 });
    await assert.rejects(provider.verifyAuthentication(response, options.challenge, { ...stored, counter: 1 }));
    await assert.rejects(provider.verifyAuthentication(response, 'wrong-challenge', stored));
    const wrong = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: 'https://attacker.example' }));
    await assert.rejects(provider.verifyAuthentication({ ...response, response: { ...response.response, clientDataJSON: wrong.toString('base64url') } }, options.challenge, stored));
});
test('passkeys register a valid attestation and authenticate with the returned credential', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = publicKey.export({ format: 'jwk' });
    const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
    const credential = randomBytes(32), id = credential.toString('base64url'), length = Buffer.alloc(2);
    length.writeUInt16BE(credential.length);
    const provider = createPasskeyProvider({ origin: 'https://site.example', rpId: 'site.example', rpName: 'Site' });
    const options = await provider.beginRegistration({ id: 'test-account', email: 'test@example.com' });
    const client = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: 'https://site.example', crossOrigin: false }));
    const auth = Buffer.concat([createHash('sha256').update('site.example').digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, credential, cose]);
    const attestation = isoCBOR.encode(new Map<string, string | Map<string, never> | Uint8Array<ArrayBuffer>>([['fmt', 'none'], ['attStmt', new Map<string, never>()], ['authData', new Uint8Array(auth)]]));
    const response = { id, rawId: id, type: 'public-key' as const, clientExtensionResults: {}, response: { clientDataJSON: client.toString('base64url'), attestationObject: Buffer.from(attestation).toString('base64url'), transports: ['internal' as const] } };
    const stored = await provider.verifyRegistration(response, options.challenge);
    assert.equal(stored.id, id);
    assert.equal(stored.counter, 0);
    await assert.rejects(provider.verifyRegistration(response, 'wrong-challenge'));
    const login = await provider.beginAuthentication(), counter = Buffer.alloc(4);
    counter.writeUInt32BE(1);
    const loginClient = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: login.challenge, origin: 'https://site.example', crossOrigin: false }));
    const loginAuth = Buffer.concat([createHash('sha256').update('site.example').digest(), Buffer.from([5]), counter]);
    const signature = sign('sha256', Buffer.concat([loginAuth, createHash('sha256').update(loginClient).digest()]), privateKey);
    assert.deepEqual(await provider.verifyAuthentication({ id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: loginClient.toString('base64url'), authenticatorData: loginAuth.toString('base64url'), signature: signature.toString('base64url') } }, login.challenge, stored), { counter: 1 });
});
// A synthetic ES256 authenticator: registers under `rpId` from `origin`, then signs assertions.
function authenticator() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = publicKey.export({ format: 'jwk' });
    const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
    const credential = randomBytes(32), id = credential.toString('base64url'), length = Buffer.alloc(2);
    length.writeUInt16BE(credential.length);
    let signCount = 0;
    return {
        id,
        attest(challenge: string, origin: string, rpId: string) {
            const client = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
            const auth = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, credential, cose]);
            const attestation = isoCBOR.encode(new Map<string, string | Map<string, never> | Uint8Array<ArrayBuffer>>([['fmt', 'none'], ['attStmt', new Map<string, never>()], ['authData', new Uint8Array(auth)]]));
            return { id, rawId: id, type: 'public-key' as const, clientExtensionResults: {}, response: { clientDataJSON: client.toString('base64url'), attestationObject: Buffer.from(attestation).toString('base64url'), transports: ['internal' as const] } };
        },
        assert(challenge: string, origin: string, rpId: string) {
            const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false })), counter = Buffer.alloc(4);
            counter.writeUInt32BE(++signCount);
            const auth = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([5]), counter]);
            const signature = sign('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), privateKey);
            return { id, rawId: id, type: 'public-key' as const, clientExtensionResults: {}, response: { clientDataJSON: client.toString('base64url'), authenticatorData: auth.toString('base64url'), signature: signature.toString('base64url') } };
        },
    };
}
test('by default passkeys stay on the canonical host and origin; an alias origin is refused', async () => {
    const provider = createPasskeyProvider({ origin: 'https://app.site.example', rpId: 'app.site.example', rpName: 'Site' }), key = authenticator();
    assert.equal(provider.rpId, 'app.site.example');
    assert.deepEqual(provider.origins, ['https://app.site.example']);
    const options = await provider.beginRegistration({ id: 'account', email: 'user@example.com' });
    assert.equal(options.rp.id, 'app.site.example');
    await assert.rejects(provider.verifyRegistration(key.attest(options.challenge, 'https://www.site.example', 'app.site.example'), options.challenge));
    const stored = await provider.verifyRegistration(key.attest(options.challenge, 'https://app.site.example', 'app.site.example'), options.challenge);
    const login = await provider.beginAuthentication();
    assert.equal(login.rpId, 'app.site.example');
    await assert.rejects(provider.verifyAuthentication(key.assert(login.challenge, 'https://www.site.example', 'app.site.example'), login.challenge, stored));
});
test('a provider bound to the operator RP ID accepts ceremonies from every site origin and nothing else', async () => {
    const site = { rpId: 'site.example', origins: ['https://app.site.example', 'https://www.site.example'] };
    const provider = createPasskeyProvider({ origin: 'https://app.site.example', rpId: 'app.site.example', rpName: 'Site' }).withSite(site), key = authenticator();
    assert.equal(provider.rpId, 'site.example');
    assert.deepEqual(provider.origins, site.origins);
    const options = await provider.beginRegistration({ id: 'account', email: 'user@example.com' });
    assert.equal(options.rp.id, 'site.example');
    // Registered on the alias origin under the shared RP ID.
    const stored = await provider.verifyRegistration(key.attest(options.challenge, 'https://www.site.example', 'site.example'), options.challenge);
    assert.equal(stored.id, key.id);
    // Used on the canonical origin, then on the alias origin.
    const first = await provider.beginAuthentication();
    assert.equal(first.rpId, 'site.example');
    assert.deepEqual(await provider.verifyAuthentication(key.assert(first.challenge, 'https://app.site.example', 'site.example'), first.challenge, stored), { counter: 1 });
    const second = await provider.beginAuthentication();
    assert.deepEqual(await provider.verifyAuthentication(key.assert(second.challenge, 'https://www.site.example', 'site.example'), second.challenge, { ...stored, counter: 1 }), { counter: 2 });
    // A non-site origin, a sibling subdomain the operator did not list, a look-alike host and the old per-host RP ID all fail.
    for (const [origin, rpId] of [['https://evil.example', 'site.example'], ['https://other.site.example', 'site.example'], ['https://site.example.evil.example', 'site.example'], ['https://www.site.example', 'app.site.example']] as const) {
        const attempt = await provider.beginAuthentication();
        await assert.rejects(provider.verifyAuthentication(key.assert(attempt.challenge, origin, rpId), attempt.challenge, { ...stored, counter: 2 }), `${origin} ${rpId}`);
    }
    const again = await provider.beginRegistration({ id: 'account', email: 'user@example.com' });
    await assert.rejects(provider.verifyRegistration(authenticator().attest(again.challenge, 'https://evil.example', 'site.example'), again.challenge));
});
test('binding a provider to a site refuses an RP ID that is not a parent of every origin', () => {
    const provider = createPasskeyProvider({ origin: 'https://app.site.example', rpId: 'app.site.example', rpName: 'Site' });
    const refused: [string, string[], RegExp][] = [
        ['other.example', ['https://app.site.example'], /neither the host/],
        ['site.example', ['https://app.site.example', 'https://evil.example'], /neither the host of https:\/\/evil\.example/],
        ['ite.example', ['https://app.site.example'], /neither the host/],
        ['site.example', ['https://www.site.example', 'https://app.site.example'], /canonical origin/],
        ['site.example', ['https://app.site.example', 'http://www.site.example'], /https: origin/],
        ['Site.Example', ['https://app.site.example'], /lowercase RP ID/],
        ['site.example', [], /lowercase RP ID/],
    ];
    for (const [rpId, origins, message] of refused)
        assert.throws(() => provider.withSite({ rpId, origins }), message, `${rpId} ${origins.join(',')}`);
});
